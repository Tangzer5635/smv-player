const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn} = require('child_process');
const {pipeline, Transform} = require('stream');
const {randomId, parseHeaderFields} = require('./utils');

/*
 * Lecture : sessions de proxy + transcodage HLS
 *
 *   /s/<id>/stream           flux amont proxifié (en-têtes Stalker, redirections, Range)
 *   /s/<id>/r?u=…&s=…         ressource référencée par une playlist HLS (URL signée HMAC)
 *   /s/<id>/hls/index.m3u8    remux/transcodage ffmpeg → HLS natif iPhone/Safari
 *
 * L'identifiant de session (128 bits aléatoires) sert de jeton : ces URL peuvent
 * être ouvertes par le lecteur natif iOS, VLC ou ffmpeg sans clé d'accès.
 */

const httpAgent = new http.Agent({keepAlive: true, maxSockets: 64});
const httpsAgent = new https.Agent({keepAlive: true, maxSockets: 64, rejectUnauthorized: false});

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LIVE_JOB_IDLE_MS = 45 * 1000;
const VOD_JOB_IDLE_MS = 30 * 60 * 1000;
const MAX_HLS_JOBS = 4;
const HLS_READY_TIMEOUT_MS = 45 * 1000;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
const TS_PACKET = 188;

const EXT_CONTENT_TYPES = {
    ts: 'video/mp2t',
    m2ts: 'video/mp2t',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    m4s: 'video/iso.segment',
    aac: 'audio/aac',
    mp3: 'audio/mpeg',
};

function urlExtension(url) {
    try {
        const u = new URL(url);
        const ext = path.extname(u.pathname).slice(1).toLowerCase();
        if (ext) return ext;
        const qsExt = u.searchParams.get('extension') || u.searchParams.get('output');
        return (qsExt || '').toLowerCase();
    } catch (_) {
        return '';
    }
}

/**
 * Devine la nature du flux pour que le client choisisse le bon moteur :
 *   hls    → playlist .m3u8 (hls.js ou lecteur natif)
 *   mpegts → flux TS continu (mpegts.js sur PC, transcodage HLS sur iPhone)
 *   mp4    → fichier lisible nativement partout (Range)
 *   file   → autre conteneur (mkv, avi…) : direct sur PC, HLS sur iPhone
 */
function guessKind(url, contentType) {
    const ext = urlExtension(url);
    if (ext === 'm3u8' || ext === 'm3u') return 'hls';
    if (ext === 'ts' || ext === 'm2ts') return 'mpegts';
    if (['mp4', 'm4v', 'mov'].includes(ext)) return 'mp4';
    if (ext) return contentType === 'live' ? 'mpegts' : 'file';
    if (/\/live\.php|\/live\//i.test(url)) return 'mpegts';
    return contentType === 'live' ? 'mpegts' : 'file';
}

function isPlaylistResponse(contentType, finalUrl) {
    if (/mpegurl/i.test(contentType || '')) return true;
    const ext = urlExtension(finalUrl);
    return (ext === 'm3u8' || ext === 'm3u') && !/video|audio|octet/i.test(contentType || '');
}

function sanitizeHeaders(headers) {
    const clean = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null || value === '') continue;
        try {
            http.validateHeaderName(key);
            http.validateHeaderValue(key, String(value));
            clean[key] = String(value);
        } catch (_) {
            // en-tête invalide (caractères non ASCII…) : ignoré plutôt que de faire échouer la requête
        }
    }
    return clean;
}

function fetchUpstream(targetUrl, headers, {method = 'GET', redirects = 0, timeoutMs = 30000} = {}) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch (_) {
            reject(new Error('URL invalide'));
            return;
        }
        if (!/^https?:$/.test(parsed.protocol)) {
            reject(new Error(`Protocole non supporté: ${parsed.protocol}`));
            return;
        }
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;

        let remoteReq;
        try {
            remoteReq = transport.request(parsed, {
                method,
                headers,
                agent: isHttps ? httpsAgent : httpAgent,
                timeout: timeoutMs,
            }, (remoteRes) => {
                if ([301, 302, 303, 307, 308].includes(remoteRes.statusCode) && remoteRes.headers.location) {
                    remoteRes.resume();
                    if (redirects >= 5) {
                        reject(new Error('Trop de redirections'));
                        return;
                    }
                    const redirectUrl = new URL(remoteRes.headers.location, targetUrl).toString();
                    resolve(fetchUpstream(redirectUrl, headers, {method, redirects: redirects + 1, timeoutMs}));
                    return;
                }
                resolve({remoteRes, remoteReq, finalUrl: targetUrl});
            });
        } catch (err) {
            reject(err);
            return;
        }

        remoteReq.on('error', reject);
        remoteReq.on('timeout', () => remoteReq.destroy(new Error('Délai dépassé')));
        remoteReq.end();
    });
}

function readBody(stream, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        stream.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                stream.destroy();
                reject(new Error('Playlist trop volumineuse'));
                return;
            }
            chunks.push(chunk);
        });
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        stream.on('error', reject);
    });
}

// Type réel d'un flux servi en application/octet-stream (Safari en a besoin pour le MP4)
function sniffContentType(chunk) {
    if (!chunk || chunk.length < 12) return null;
    if (chunk[0] === 0x47 && (chunk.length <= TS_PACKET || chunk[TS_PACKET] === 0x47)) return 'video/mp2t';
    if (chunk.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
    if (chunk[0] === 0x1a && chunk[1] === 0x45 && chunk[2] === 0xdf && chunk[3] === 0xa3) return 'video/x-matroska';
    return null;
}

function readFirstChunk(stream, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const finish = (chunk) => {
            clearTimeout(timer);
            stream.off('readable', onReadable);
            stream.off('end', onEnd);
            stream.off('error', onEnd);
            resolve(chunk || null);
        };
        const onReadable = () => {
            const chunk = stream.read();
            if (chunk !== null) finish(chunk);
        };
        const onEnd = () => finish(null);
        const timer = setTimeout(onEnd, timeoutMs);
        stream.on('readable', onReadable);
        stream.once('end', onEnd);
        stream.once('error', onEnd);
    });
}

function sendText(res, status, text) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*'});
    res.end(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retire les tables SDT/BAT (PID 0x11) et EIT (PID 0x12) d'un flux MPEG-TS.
 * Inutiles à la lecture, elles font planter les ffmpeg statiques Linux
 * (décodage des noms de service via iconv). Tout flux non TS passe tel quel.
 */
class TsTableFilter extends Transform {
    constructor() {
        super();
        this.pending = Buffer.alloc(0);
        this.checked = false;
        this.passthrough = false;
    }

    _transform(chunk, encoding, callback) {
        if (this.passthrough) {
            callback(null, chunk);
            return;
        }
        const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        if (!this.checked) {
            if (data.length < TS_PACKET * 2) {
                this.pending = data;
                callback();
                return;
            }
            this.checked = true;
            if (data[0] !== 0x47 || data[TS_PACKET] !== 0x47) {
                this.passthrough = true;
                this.pending = Buffer.alloc(0);
                callback(null, data);
                return;
            }
        }

        const kept = [];
        let i = 0;
        while (i + TS_PACKET <= data.length) {
            if (data[i] !== 0x47) {
                const next = data.indexOf(0x47, i + 1);
                if (next === -1) {
                    i = data.length;
                    break;
                }
                i = next;
                continue;
            }
            const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2];
            if (pid !== 0x11 && pid !== 0x12) kept.push(data.subarray(i, i + TS_PACKET));
            i += TS_PACKET;
        }
        this.pending = Buffer.from(data.subarray(i));
        callback(null, kept.length ? Buffer.concat(kept) : undefined);
    }

    _flush(callback) {
        callback(null, this.pending.length ? this.pending : undefined);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSCODAGE HLS (ffmpeg)
// ═══════════════════════════════════════════════════════════════════════════════

class HlsJob {
    constructor({session, ffmpegPath, dir, input, videoMode, isLive}) {
        this.session = session;
        this.ffmpegPath = ffmpegPath;
        this.dir = dir;
        this.input = input;
        this.isLive = isLive;
        this.videoMode = videoMode === 'h264' ? 'h264' : 'copy';
        this.segmentType = 'mpegts';
        this.hevcTag = false;
        this.restarts = 0;
        this.proc = null;
        this.stderr = '';
        this.inputInfo = null;
        this.exited = false;
        this.exitCode = null;
        this.killed = false;
        this.lastAccess = Date.now();
    }

    touch() {
        this.lastAccess = Date.now();
    }

    get playlistPath() {
        return path.join(this.dir, 'index.m3u8');
    }

    buildArgs() {
        const segExt = this.segmentType === 'fmp4' ? 'm4s' : 'ts';
        const args = [
            '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
            '-fflags', '+genpts+discardcorrupt',
            '-probesize', this.isLive ? '3000000' : '10000000',
            '-analyzeduration', this.isLive ? '3000000' : '10000000',
            '-rw_timeout', '20000000',
            '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4',
            '-i', this.input,
            '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
        ];

        if (this.videoMode === 'h264') {
            args.push(
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                '-maxrate', '8M', '-bufsize', '16M',
                '-vf', 'scale=\'min(1920,iw)\':-2',
                '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
                '-force_key_frames', 'expr:gte(t,n_forced*2)',
            );
        } else {
            args.push('-c:v', 'copy');
            if (this.hevcTag) args.push('-tag:v', 'hvc1');
        }

        args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');

        args.push('-f', 'hls', '-hls_time', this.isLive ? '2' : '4');
        if (this.isLive) {
            args.push(
                '-hls_list_size', '10',
                '-hls_delete_threshold', '4',
                '-hls_flags', 'delete_segments+temp_file+independent_segments',
            );
        } else {
            args.push('-hls_playlist_type', 'event', '-hls_flags', 'temp_file+independent_segments');
        }
        if (this.segmentType === 'fmp4') {
            args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4');
        }
        args.push('-hls_segment_filename', path.join(this.dir, `seg_%05d.${segExt}`));
        args.push(this.playlistPath);
        return args;
    }

    start() {
        if (this.killed) return;
        fs.rmSync(this.dir, {recursive: true, force: true});
        fs.mkdirSync(this.dir, {recursive: true});
        this.exited = false;
        this.exitCode = null;
        this.stderr = '';
        this.inputInfo = null;

        const args = this.buildArgs();
        console.log(`🎞️ ffmpeg HLS [${this.session.id.slice(0, 6)}] ${this.videoMode}/${this.segmentType}${this.isLive ? ' live' : ' vod'}`);
        const proc = spawn(this.ffmpegPath, args, {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
        this.proc = proc;

        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (chunk) => {
            this.stderr = (this.stderr + chunk).slice(-16000);
            if (!this.inputInfo) this.detectInput();
        });
        proc.on('error', (err) => {
            this.stderr += `\n${err.message}`;
        });
        proc.on('exit', (code) => {
            if (this.proc !== proc) return;
            this.exited = true;
            this.exitCode = code;
            if (code && !this.killed) {
                console.warn(`⚠️ ffmpeg terminé (code ${code}): ${this.lastError()}`);
            }
        });
    }

    // Analyse "Input #0 … Stream #0:0: Video: hevc" pour adapter le conteneur ou transcoder
    detectInput() {
        const mappingIdx = this.stderr.indexOf('Stream mapping:');
        const outputIdx = this.stderr.indexOf('Output #0');
        const end = [mappingIdx, outputIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0];
        if (end === undefined) return;
        const inputPart = this.stderr.slice(0, end);
        const video = inputPart.match(/Stream #0:\d+[^:]*: Video: (\w+)/);
        const audio = inputPart.match(/Stream #0:\d+[^:]*: Audio: (\w+)/);
        this.inputInfo = {video: video?.[1] || null, audio: audio?.[1] || null};

        if (this.videoMode !== 'copy' || !this.inputInfo.video || this.restarts >= 2) return;
        const codec = this.inputInfo.video;
        if (codec === 'h264') return;
        if (codec === 'hevc') {
            if (this.segmentType === 'fmp4') return;
            // HEVC : Apple exige du fMP4 avec le tag hvc1
            this.segmentType = 'fmp4';
            this.hevcTag = true;
        } else {
            // MPEG-2, MPEG-4 Part 2, VC-1… non lisibles sur iPhone → réencodage H.264
            this.videoMode = 'h264';
        }
        this.restart(`codec vidéo ${codec}`);
    }

    restart(reason) {
        console.log(`🔁 ffmpeg relancé (${reason})`);
        this.restarts++;
        const old = this.proc;
        this.proc = null;
        if (old) {
            old.once('exit', () => this.start());
            old.kill('SIGKILL');
        } else {
            this.start();
        }
    }

    lastError() {
        const lines = this.stderr
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !/^(Opening|\[hls @|Stream #|Input #|Output #|Metadata|Duration|Stream mapping|Press \[q\]|  )/.test(l));
        return lines.slice(-2).join(' | ') || `code ${this.exitCode}`;
    }

    countSegments() {
        try {
            const content = fs.readFileSync(this.playlistPath, 'utf-8');
            return {
                segments: (content.match(/#EXTINF/g) || []).length,
                ended: content.includes('#EXT-X-ENDLIST'),
            };
        } catch (_) {
            return {segments: 0, ended: false};
        }
    }

    async waitReady(timeoutMs = HLS_READY_TIMEOUT_MS) {
        const minSegments = this.isLive ? 2 : 1;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.killed) throw new Error('Transcodage arrêté');
            const {segments, ended} = this.countSegments();
            if (segments >= minSegments || (ended && segments > 0)) return;
            if (this.exited && this.proc) {
                throw new Error(`ffmpeg: ${this.lastError()}`);
            }
            await sleep(250);
        }
        throw new Error('Délai dépassé en attendant le flux');
    }

    async waitForFile(filePath, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (fs.existsSync(filePath)) return true;
            if (this.exited || this.killed) return fs.existsSync(filePath);
            await sleep(200);
        }
        return false;
    }

    kill() {
        this.killed = true;
        const proc = this.proc;
        const cleanup = () => fs.rm(this.dir, {recursive: true, force: true}, () => {});
        if (proc && !this.exited) {
            proc.once('exit', cleanup);
            proc.kill('SIGTERM');
            setTimeout(() => {
                if (!this.exited) proc.kill('SIGKILL');
            }, 3000).unref();
        } else {
            cleanup();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GESTIONNAIRE DE SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

class PlaybackManager {
    constructor({getConfig, getFfmpegPath, getInternalBase, tmpRoot}) {
        this.getConfig = getConfig;
        this.getFfmpegPath = getFfmpegPath;
        this.getInternalBase = getInternalBase;
        this.tmpRoot = tmpRoot;
        this.sessions = new Map();

        fs.rmSync(this.tmpRoot, {recursive: true, force: true});
        fs.mkdirSync(this.tmpRoot, {recursive: true});
        this.cleanupStaleDirs();

        this.reaper = setInterval(() => this.reap(), 10000);
        this.reaper.unref();
    }

    // Dossiers laissés par une instance précédente arrêtée brutalement (nommés par PID)
    cleanupStaleDirs() {
        const parent = path.dirname(this.tmpRoot);
        for (const name of fs.readdirSync(parent)) {
            const pid = Number(name);
            if (!pid || pid === process.pid) continue;
            try {
                process.kill(pid, 0);
            } catch (err) {
                if (err.code === 'ESRCH') fs.rmSync(path.join(parent, name), {recursive: true, force: true});
            }
        }
    }

    create({url, headers, contentType}) {
        if (!/^https?:\/\//i.test(String(url || ''))) {
            throw new Error('URL de flux invalide');
        }
        const session = {
            id: randomId(16),
            secret: crypto.randomBytes(16),
            url,
            headers: headers && typeof headers === 'object' ? headers : {},
            contentType: contentType || 'live',
            kind: guessKind(url, contentType),
            createdAt: Date.now(),
            lastAccess: Date.now(),
            hls: null,
        };
        this.sessions.set(session.id, session);
        return this.describe(session);
    }

    describe(session) {
        const ffmpeg = !!this.getFfmpegPath();
        return {
            id: session.id,
            kind: session.kind,
            streamUrl: `/s/${session.id}/stream`,
            hlsUrl: ffmpeg ? `/s/${session.id}/hls/index.m3u8` : null,
            ffmpeg,
        };
    }

    stop(id) {
        const session = this.sessions.get(id);
        if (!session) return false;
        session.hls?.kill();
        this.sessions.delete(id);
        return true;
    }

    stopAll() {
        for (const id of [...this.sessions.keys()]) this.stop(id);
        clearInterval(this.reaper);
    }

    reap() {
        const now = Date.now();
        for (const session of this.sessions.values()) {
            const job = session.hls;
            if (job) {
                const idleLimit = job.isLive ? LIVE_JOB_IDLE_MS : VOD_JOB_IDLE_MS;
                if (now - job.lastAccess > idleLimit) {
                    console.log(`🧹 Transcodage inactif arrêté [${session.id.slice(0, 6)}]`);
                    job.kill();
                    session.hls = null;
                }
            }
            if (now - session.lastAccess > SESSION_TTL_MS) this.stop(session.id);
        }
    }

    sign(session, target) {
        return crypto.createHmac('sha256', session.secret).update(target).digest('base64url').slice(0, 22);
    }

    signedUrl(session, target, forFfmpeg = false) {
        const url = `/s/${session.id}/r?u=${encodeURIComponent(target)}&s=${this.sign(session, target)}`;
        return forFfmpeg ? `${url}&ffmpeg=1` : url;
    }

    rewritePlaylist(session, content, baseUrl, forFfmpeg) {
        const proxify = (uri) => {
            try {
                const absolute = new URL(uri, baseUrl);
                if (!/^https?:$/.test(absolute.protocol)) return uri;
                return this.signedUrl(session, absolute.toString(), forFfmpeg);
            } catch (_) {
                return uri;
            }
        };
        return content
            .split(/\r?\n/)
            .map((line) => {
                const trimmed = line.trim();
                if (!trimmed) return line;
                if (!trimmed.startsWith('#')) return proxify(trimmed);
                return line.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${proxify(uri)}"`);
            })
            .join('\n');
    }

    buildUpstreamHeaders(session, req, forFfmpeg) {
        const cfg = this.getConfig();
        const headers = {'User-Agent': cfg.userAgent || 'Lavf/57.83.100'};
        if (cfg.referrer) headers.Referer = cfg.referrer;
        Object.assign(headers, parseHeaderFields(cfg.headerFields), session.headers);
        // Nettoyage des en-têtes propres au client
        delete headers.Host;
        delete headers.host;
        delete headers.Range;
        delete headers.range;
        if (req.headers.range && !forFfmpeg) headers.Range = req.headers.range;
        if (req.headers['if-range'] && !forFfmpeg) headers['If-Range'] = req.headers['if-range'];
        return sanitizeHeaders(headers);
    }

    /**
     * forFfmpeg : requête interne de ffmpeg → tables TS filtrées, pas de Range
     * (le flux est lu séquentiellement).
     */
    async proxy(session, req, res, targetUrl, {forFfmpeg = false} = {}) {
        let upstream;
        try {
            upstream = await fetchUpstream(targetUrl, this.buildUpstreamHeaders(session, req, forFfmpeg));
        } catch (err) {
            console.error('❌ Proxy error:', err.message);
            sendText(res, 502, `Proxy error: ${err.message}`);
            return;
        }

        const {remoteRes, finalUrl} = upstream;
        if (res.destroyed) {
            remoteRes.destroy();
            return;
        }

        const status = remoteRes.statusCode || 200;
        const contentType = remoteRes.headers['content-type'] || '';

        if (status < 400 && isPlaylistResponse(contentType, finalUrl)) {
            try {
                const body = await readBody(remoteRes, MAX_PLAYLIST_BYTES);
                const rewritten = this.rewritePlaylist(session, body, finalUrl, forFfmpeg);
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache',
                });
                res.end(rewritten);
            } catch (err) {
                console.error('❌ Proxy playlist error:', err.message);
                sendText(res, 502, 'Proxy playlist error');
            }
            return;
        }

        let outType = contentType;
        if (!outType || /octet-stream|text\/plain|binary/i.test(outType)) {
            const ext = urlExtension(finalUrl) || urlExtension(targetUrl);
            outType = EXT_CONTENT_TYPES[ext] || (session.kind === 'mpegts' ? 'video/mp2t' : outType || 'application/octet-stream');
        }

        if (!forFfmpeg && status < 400 && outType === 'application/octet-stream' && req.method !== 'HEAD') {
            const first = await readFirstChunk(remoteRes);
            if (first) {
                outType = sniffContentType(first) || outType;
                remoteRes.unshift(first);
            }
        }

        const responseHeaders = {
            'Content-Type': outType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': remoteRes.headers['cache-control'] || 'no-cache',
        };
        if (!forFfmpeg) {
            for (const name of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
                if (remoteRes.headers[name]) responseHeaders[name] = remoteRes.headers[name];
            }
        }

        res.writeHead(forFfmpeg && status === 206 ? 200 : status, responseHeaders);
        if (req.method === 'HEAD') {
            remoteRes.destroy();
            res.end();
            return;
        }
        // pipeline détruit la connexion amont si le lecteur se déconnecte
        // (évite de garder une connexion IPTV ouverte pour rien)
        if (forFfmpeg && status < 400) {
            pipeline(remoteRes, new TsTableFilter(), res, () => {});
        } else {
            pipeline(remoteRes, res, () => {});
        }
    }

    async ensureHlsJob(session) {
        if (session.hls && !session.hls.killed) return session.hls;

        const ffmpegPath = this.getFfmpegPath();
        if (!ffmpegPath) throw new Error('ffmpeg indisponible');

        const running = [...this.sessions.values()].filter((s) => s.hls && !s.hls.killed);
        if (running.length >= MAX_HLS_JOBS) {
            const oldest = running.sort((a, b) => a.hls.lastAccess - b.hls.lastAccess)[0];
            oldest.hls.kill();
            oldest.hls = null;
        }

        const job = new HlsJob({
            session,
            ffmpegPath,
            dir: path.join(this.tmpRoot, session.id),
            input: `${this.getInternalBase()}/s/${session.id}/stream?ffmpeg=1`,
            videoMode: this.getConfig().hlsVideoMode,
            isLive: session.contentType === 'live',
        });
        session.hls = job;
        job.start();
        return job;
    }

    async serveHls(session, req, res, file) {
        if (!/^[\w.-]+\.(m3u8|ts|m4s|mp4)$/.test(file)) {
            sendText(res, 400, 'Fichier invalide');
            return;
        }

        let job;
        try {
            job = await this.ensureHlsJob(session);
        } catch (err) {
            sendText(res, 501, err.message);
            return;
        }
        job.touch();

        if (file === 'index.m3u8') {
            try {
                await job.waitReady();
            } catch (err) {
                console.error('❌ HLS:', err.message);
                job.kill();
                if (session.hls === job) session.hls = null;
                sendText(res, 502, err.message);
                return;
            }
            fs.readFile(job.playlistPath, 'utf-8', (err, content) => {
                if (err) {
                    sendText(res, 404, 'Playlist indisponible');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Cache-Control': 'no-cache',
                    'Access-Control-Allow-Origin': '*',
                });
                res.end(content);
            });
            return;
        }

        const filePath = path.join(job.dir, file);
        if (!(await job.waitForFile(filePath))) {
            sendText(res, 404, 'Segment introuvable');
            return;
        }
        const ext = path.extname(file).slice(1);
        const type = ext === 'ts' ? 'video/mp2t' : ext === 'm4s' ? 'video/iso.segment' : 'video/mp4';
        fs.stat(filePath, (err, stat) => {
            if (err) {
                sendText(res, 404, 'Segment introuvable');
                return;
            }
            res.writeHead(200, {
                'Content-Type': type,
                'Content-Length': stat.size,
                'Cache-Control': 'max-age=3600',
                'Access-Control-Allow-Origin': '*',
            });
            pipeline(fs.createReadStream(filePath), res, () => {});
        });
    }

    async handle(req, res, id, rest, query) {
        const session = this.sessions.get(id);
        if (!session) {
            sendText(res, 404, 'Session de lecture expirée');
            return;
        }
        session.lastAccess = Date.now();

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Range',
            });
            res.end();
            return;
        }

        const forFfmpeg = query.get('ffmpeg') === '1';

        if (rest === 'stream') {
            await this.proxy(session, req, res, session.url, {forFfmpeg});
            return;
        }

        if (rest === 'r') {
            const target = query.get('u') || '';
            const sig = query.get('s') || '';
            if (!target || sig !== this.sign(session, target)) {
                sendText(res, 403, 'Signature invalide');
                return;
            }
            await this.proxy(session, req, res, target, {forFfmpeg});
            return;
        }

        if (rest.startsWith('hls/')) {
            await this.serveHls(session, req, res, rest.slice(4));
            return;
        }

        sendText(res, 404, 'Not found');
    }
}

module.exports = {PlaybackManager, guessKind};
