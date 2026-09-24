const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');
const QRCode = require('qrcode');
const {spawnSync} = require('child_process');

const {ConfigStore} = require('./config');
const {ProfileStore} = require('./profiles');
const {PlaybackManager} = require('./playback');
const stalker = require('./stalker');
const {parseM3U} = require('./m3u');
const {randomId, safeEqual, getLanAddresses, isLoopback} = require('./utils');
const net = require('./net');

/*
 * Serveur SMV Player
 *
 * Un seul serveur HTTP sert :
 *   - l'interface (renderer/) — chargée par la fenêtre Electron ET par Safari sur iPhone
 *   - l'API JSON (/api/*) — protégée par la clé d'accès
 *   - le proxy / transcodage des flux (/s/*) — protégé par l'identifiant de session
 */

const ROOT_DIR = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT_DIR, 'renderer');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const JSON_BODY_LIMIT = 200 * 1024 * 1024;
const JOB_RETENTION_MS = 10 * 60 * 1000;

const VENDOR_FILES = {
    'hls.min.js': 'hls.js/dist/hls.min.js',
    'mpegts.js': 'mpegts.js/dist/mpegts.js',
};

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
};

class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

// ── Helpers HTTP ─────────────────────────────────────────────────────────────

function sendJson(req, res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload ?? null), 'utf-8');
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    };
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip && body.length > 2048) {
        zlib.gzip(body, (err, gz) => {
            if (err) {
                res.writeHead(status, headers);
                res.end(body);
                return;
            }
            res.writeHead(status, {...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length});
            res.end(gz);
        });
        return;
    }
    res.writeHead(status, {...headers, 'Content-Length': body.length});
    res.end(body);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > JSON_BODY_LIMIT) {
                reject(new HttpError(413, 'Requête trop volumineuse'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch (_) {
                reject(new HttpError(400, 'JSON invalide'));
            }
        });
        req.on('error', reject);
    });
}

function serveFile(req, res, filePath, {cache = 'no-cache'} = {}) {
    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
            res.end('Not found');
            return;
        }
        const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        const headers = {
            'Content-Type': type,
            'Cache-Control': cache,
            'X-Content-Type-Options': 'nosniff',
        };
        const compressible = /text|javascript|json|svg|manifest/.test(type);
        if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
            res.writeHead(200, {...headers, 'Content-Encoding': 'gzip'});
            fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
            return;
        }
        res.writeHead(200, {...headers, 'Content-Length': stat.size});
        fs.createReadStream(filePath).pipe(res);
    });
}

// Résout un chemin demandé dans un dossier autorisé (anti "../")
function resolveInside(baseDir, relPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(relPath);
    } catch (_) {
        return null;
    }
    const target = path.normalize(path.join(baseDir, decoded));
    if (!target.startsWith(baseDir + path.sep)) return null;
    return target;
}

function resolveVendor(name) {
    const modulePath = VENDOR_FILES[name];
    if (!modulePath) return null;
    try {
        return require.resolve(modulePath);
    } catch (_) {
        return path.join(ROOT_DIR, 'node_modules', modulePath);
    }
}

// ── ffmpeg ───────────────────────────────────────────────────────────────────

function ffmpegWorks(candidate) {
    if (!candidate) return false;
    if (candidate !== 'ffmpeg' && !fs.existsSync(candidate)) return false;
    try {
        const out = spawnSync(candidate, ['-hide_banner', '-version'], {timeout: 8000, windowsHide: true});
        return out.status === 0;
    } catch (_) {
        return false;
    }
}

function bundledFfmpegPath() {
    try {
        const p = require('ffmpeg-static');
        // Dans l'application packagée, le binaire est extrait hors de l'archive asar
        return p ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : null;
    } catch (_) {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVEUR
// ═══════════════════════════════════════════════════════════════════════════════

function createSmvServer({dataDir, host = '0.0.0.0', port, ffmpegPath, appVersion = '0.0.0', systemProxyResolver} = {}) {
    fs.mkdirSync(dataDir, {recursive: true});

    const config = new ConfigStore(dataDir);
    net.setConfiguredProxy(config.get().httpProxy);
    if (systemProxyResolver) net.setSystemProxyResolver(systemProxyResolver);
    const profiles = new ProfileStore(dataDir);
    const jobs = new Map();

    let listeningPort = null;
    let resolvedFfmpeg = null;

    function detectFfmpeg() {
        const candidates = [config.get().ffmpegPath, ffmpegPath, bundledFfmpegPath(), 'ffmpeg'];
        resolvedFfmpeg = candidates.find((c) => ffmpegWorks(c)) || null;
        console.log(resolvedFfmpeg ? `ffmpeg: ${resolvedFfmpeg}` : '⚠️ ffmpeg introuvable : transcodage iPhone désactivé');
        return resolvedFfmpeg;
    }

    detectFfmpeg();

    const playback = new PlaybackManager({
        getConfig: () => config.get(),
        getFfmpegPath: () => resolvedFfmpeg,
        getInternalBase: () => `http://127.0.0.1:${listeningPort}`,
        tmpRoot: path.join(os.tmpdir(), 'smv-player-hls', String(process.pid)),
    });

    // ── Tâches longues (connexion portail…) suivies par polling ──────────────
    function startJob(label, fn) {
        const job = {
            id: randomId(9),
            label,
            status: 'running',
            progress: {message: 'Démarrage…'},
            result: null,
            error: null,
            finishedAt: null,
        };
        jobs.set(job.id, job);
        Promise.resolve()
            .then(() => fn((progress) => {
                job.progress = progress;
            }))
            .then((result) => {
                job.status = 'done';
                job.result = result;
            })
            .catch((err) => {
                console.error(`❌ ${label}:`, err.message);
                job.status = 'error';
                job.error = err.message;
            })
            .finally(() => {
                job.finishedAt = Date.now();
            });
        return job.id;
    }

    const jobReaper = setInterval(() => {
        const now = Date.now();
        for (const [id, job] of jobs) {
            if (job.finishedAt && now - job.finishedAt > JOB_RETENTION_MS) jobs.delete(id);
        }
    }, 60000);
    jobReaper.unref();

    const netTimeout = () => (config.get().networkTimeout || 60) * 1000;

    // ── Infos réseau / appairage iPhone ─────────────────────────────────────
    async function getServerInfo() {
        const cfg = config.get();
        const addresses = cfg.remoteAccess ? getLanAddresses() : [];
        const proxyInfo = await net.describeProxy('http://example.com/');
        const urls = await Promise.all(addresses.slice(0, 4).map(async (a, index) => {
            const url = `http://${a.address}:${listeningPort}/?key=${cfg.accessKey}`;
            const qr = index < 3
                ? await QRCode.toDataURL(url, {margin: 1, width: 300, color: {dark: '#000000', light: '#ffffff'}})
                : null;
            return {name: a.name, address: a.address, url, qr};
        }));
        return {
            name: 'SMV Player',
            version: appVersion,
            hostname: os.hostname(),
            port: listeningPort,
            remoteAccess: cfg.remoteAccess,
            accessKey: cfg.accessKey,
            ffmpeg: !!resolvedFfmpeg,
            proxy: {address: net.maskProxy(proxyInfo.proxy), source: proxyInfo.source},
            urls,
        };
    }

    function buildManifest(validKey) {
        return {
            name: 'SMV Player',
            short_name: 'SMV Player',
            description: 'Lecteur IPTV — Stalker / M3U',
            start_url: validKey ? `/?key=${encodeURIComponent(validKey)}` : '/',
            scope: '/',
            display: 'standalone',
            orientation: 'any',
            background_color: '#0b0b10',
            theme_color: '#0b0b10',
            icons: [
                {src: '/assets/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any'},
            ],
        };
    }

    // ── API ─────────────────────────────────────────────────────────────────
    async function handleApi(req, res, url) {
        const segments = url.pathname.split('/').filter(Boolean).slice(1); // sans "api"
        const [resource, id, action] = segments;
        const method = req.method;

        if (resource === 'ping' && method === 'GET') {
            return {success: true, name: 'SMV Player', version: appVersion};
        }

        if (resource === 'config') {
            if (method === 'GET') return config.getPublic();
            if (method === 'PUT') {
                const before = config.get().ffmpegPath;
                let updated;
                try {
                    updated = config.update(await readJsonBody(req));
                } catch (err) {
                    throw new HttpError(400, `Proxy invalide : ${err.message}`);
                }
                net.setConfiguredProxy(updated.httpProxy);
                if (updated.ffmpegPath !== before) detectFfmpeg();
                return updated;
            }
        }

        if (resource === 'server-info' && method === 'GET') {
            return getServerInfo();
        }

        if (resource === 'access-key' && id === 'regenerate' && method === 'POST') {
            const accessKey = config.regenerateAccessKey();
            return {success: true, accessKey};
        }

        if (resource === 'profiles') {
            if (!id && method === 'GET') return profiles.list();
            if (!id && method === 'POST') return profiles.create(await readJsonBody(req));
            if (id && action === 'load' && method === 'POST') {
                const {pin} = await readJsonBody(req);
                const result = profiles.load(id, pin);
                if (!result.success && !result.pinRequired) throw new HttpError(404, result.error);
                return result;
            }
            if (id && !action && method === 'PATCH') {
                const result = profiles.update(id, await readJsonBody(req));
                if (!result.success) throw new HttpError(404, result.error);
                return result;
            }
            if (id && !action && method === 'DELETE') {
                const result = profiles.remove(id);
                if (!result.success) throw new HttpError(404, result.error);
                return result;
            }
        }

        if (resource === 'jobs' && id && method === 'GET') {
            const job = jobs.get(id);
            if (!job) throw new HttpError(404, 'Tâche introuvable');
            return {
                id: job.id,
                status: job.status,
                progress: job.progress,
                error: job.error,
                result: job.status === 'done' ? job.result : null,
            };
        }

        if (resource === 'stalker') {
            const body = method === 'POST' ? await readJsonBody(req) : {};
            const userAgent = config.get().userAgent;

            if (id === 'connect' && method === 'POST') {
                const {portalUrl, mac} = body;
                if (!portalUrl || !mac) throw new HttpError(400, 'URL et MAC requis');
                const jobId = startJob('Connexion Stalker', (onProgress) =>
                    stalker.connect({portalUrl, mac, userAgent, timeoutMs: netTimeout()}, onProgress)
                );
                return {success: true, jobId};
            }
            if (id === 'stream' && method === 'POST') {
                try {
                    return await stalker.getStream({...body, userAgent});
                } catch (err) {
                    console.error('Erreur stream:', err.message);
                    return {success: false, error: err.message};
                }
            }
            if (id === 'episodes' && method === 'POST') {
                try {
                    return await stalker.seriesEpisodes({...body, userAgent});
                } catch (err) {
                    console.error('❌ Erreur épisodes série:', err.message);
                    return {success: false, error: err.message};
                }
            }
        }

        if (resource === 'm3u' && method === 'POST') {
            const body = await readJsonBody(req);
            if (id === 'parse') {
                return parseM3U(body.content || '');
            }
            if (id === 'fetch') {
                const m3uUrl = String(body.url || '').trim();
                if (!/^https?:\/\//i.test(m3uUrl)) throw new HttpError(400, 'URL M3U invalide');
                const jobId = startJob('Téléchargement M3U', async (onProgress) => {
                    onProgress({message: 'Téléchargement de la liste…'});
                    const response = await axios.get(m3uUrl, {
                        responseType: 'text',
                        timeout: netTimeout() * 2,
                        maxContentLength: JSON_BODY_LIMIT,
                        headers: {'User-Agent': config.get().userAgent},
                        ...(await net.axiosNetOptions(m3uUrl)),
                        transformResponse: (data) => data,
                    });
                    onProgress({message: 'Analyse de la liste…'});
                    const parsed = parseM3U(response.data);
                    if (!parsed.channels.length && !parsed.vod.length) {
                        throw new Error('Aucune chaîne trouvée dans la liste');
                    }
                    return parsed;
                });
                return {success: true, jobId};
            }
        }

        if (resource === 'play') {
            if (!id && method === 'POST') {
                const body = await readJsonBody(req);
                try {
                    return {success: true, ...playback.create(body)};
                } catch (err) {
                    throw new HttpError(400, err.message);
                }
            }
            if (id && method === 'DELETE') {
                return {success: playback.stop(id)};
            }
        }

        throw new HttpError(404, 'Route inconnue');
    }

    // ── Routeur principal ───────────────────────────────────────────────────
    async function handleRequest(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const cfg = config.get();

        if (!cfg.remoteAccess && !isLoopback(req.socket.remoteAddress)) {
            res.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8'});
            res.end('Accès réseau désactivé dans SMV Player');
            return;
        }

        // Flux (capacité = identifiant de session)
        if (url.pathname.startsWith('/s/')) {
            const [, , sessionId, ...rest] = url.pathname.split('/');
            await playback.handle(req, res, sessionId, rest.join('/'), url.searchParams);
            return;
        }

        // API (clé d'accès obligatoire)
        if (url.pathname.startsWith('/api/')) {
            const key = req.headers['x-smv-key'] || url.searchParams.get('key') || '';
            if (!safeEqual(key, cfg.accessKey)) {
                sendJson(req, res, 401, {success: false, error: 'Clé d\'accès invalide', unauthorized: true});
                return;
            }
            try {
                const result = await handleApi(req, res, url);
                if (!res.headersSent) sendJson(req, res, 200, result);
            } catch (err) {
                const status = err.status || 500;
                if (status >= 500) console.error('❌ API:', err.message);
                if (!res.headersSent) sendJson(req, res, status, {success: false, error: err.message, ...(err.extra || {})});
            }
            return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405);
            res.end();
            return;
        }

        // Manifest PWA dynamique : start_url embarque la clé pour l'app "écran d'accueil" iOS
        if (url.pathname === '/manifest.webmanifest') {
            const key = url.searchParams.get('key') || '';
            const manifest = buildManifest(safeEqual(key, cfg.accessKey) ? key : '');
            res.writeHead(200, {'Content-Type': MIME_TYPES['.webmanifest'], 'Cache-Control': 'no-cache'});
            res.end(JSON.stringify(manifest, null, 2));
            return;
        }

        if (url.pathname.startsWith('/vendor/')) {
            const file = resolveVendor(url.pathname.slice('/vendor/'.length));
            if (!file) {
                res.writeHead(404);
                res.end();
                return;
            }
            serveFile(req, res, file, {cache: 'public, max-age=86400'});
            return;
        }

        if (url.pathname.startsWith('/assets/')) {
            const file = resolveInside(ASSETS_DIR, url.pathname.slice('/assets/'.length));
            if (!file) {
                res.writeHead(404);
                res.end();
                return;
            }
            serveFile(req, res, file, {cache: 'public, max-age=86400'});
            return;
        }

        const relPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = resolveInside(RENDERER_DIR, relPath);
        if (!file) {
            res.writeHead(404);
            res.end();
            return;
        }
        serveFile(req, res, file);
    }

    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
            console.error('❌ Serveur:', err.message);
            if (!res.headersSent) {
                res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
                res.end('Erreur serveur');
            } else {
                res.destroy();
            }
        });
    });

    function listen() {
        const startPort = Number.parseInt(port ?? config.get().port, 10) || 9191;
        return new Promise((resolve, reject) => {
            let attempt = 0;
            const tryListen = (p) => {
                const onError = (err) => {
                    if (err.code === 'EADDRINUSE' && attempt < 10) {
                        console.warn(`⚠️ Port ${p} occupé, essai ${p + 1}`);
                        attempt++;
                        tryListen(p + 1);
                    } else {
                        reject(err);
                    }
                };
                server.once('error', onError);
                server.listen(p, host, () => {
                    server.off('error', onError);
                    listeningPort = p;
                    console.log(`Serveur SMV: http://127.0.0.1:${p} (${host})`);
                    resolve(p);
                });
            };
            tryListen(startPort);
        });
    }

    function close() {
        playback.stopAll();
        profiles.flush();
        clearInterval(jobReaper);
        return new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
        });
    }

    return {
        config,
        profiles,
        playback,
        listen,
        close,
        getServerInfo,
        getPort: () => listeningPort,
        getFfmpegPath: () => resolvedFfmpeg,
        getLocalUrl: () => `http://127.0.0.1:${listeningPort}/?key=${config.get().accessKey}`,
    };
}

module.exports = {createSmvServer};
