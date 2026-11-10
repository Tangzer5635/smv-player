const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const {spawnSync} = require('child_process');

const {
    HttpError, sendJson, sendText, readJson, resolveInside, serveFile, parseCookies, requestContext, setSecurityHeaders,
} = require('./http');
const {AuthStore, COOKIE_NAME, LoginLimiter} = require('./auth');
const {SettingsStore} = require('./settings');
const {SourceStore} = require('./sources');
const {JobManager} = require('./jobs');
const {PlaybackManager} = require('./playback');
const {serveImage} = require('./images');
const net = require('./net');
const {parseM3U} = require('./m3u');

/*
 * Application SMV Player : un seul serveur HTTP pour
 *   /            l'interface web (web/) — PWA installable sur iPhone
 *   /api/*       l'API JSON, protégée par la session (cookie signé)
 *   /s/*         le proxy / transcodage des flux (URL à jeton, lisibles par VLC)
 *
 * En production il tourne derrière Caddy (HTTPS automatique), voir docker-compose.yml.
 */

const ROOT_DIR = path.join(__dirname, '..');
const WEB_DIR = path.join(ROOT_DIR, 'web');
const VENDOR_FILES = {
    'hls.min.js': 'hls.js/dist/hls.min.js',
    'mpegts.js': 'mpegts.js/dist/mpegts.js',
};

function resolveVendor(name) {
    const modulePath = VENDOR_FILES[name];
    if (!modulePath) return null;
    try {
        return require.resolve(modulePath);
    } catch (_) {
        return null;
    }
}

// ── ffmpeg ───────────────────────────────────────────────────────────────────
function ffmpegWorks(candidate) {
    if (!candidate) return false;
    if (candidate !== 'ffmpeg' && !fs.existsSync(candidate)) return false;
    try {
        return spawnSync(candidate, ['-hide_banner', '-version'], {timeout: 8000, windowsHide: true}).status === 0;
    } catch (_) {
        return false;
    }
}

function detectFfmpeg() {
    let bundled = null;
    try {
        bundled = require('ffmpeg-static');
    } catch (_) {
    }
    const found = [process.env.SMV_FFMPEG_PATH, 'ffmpeg', bundled].find((c) => ffmpegWorks(c)) || null;
    console.log(found ? `ffmpeg : ${found}` : '⚠️ ffmpeg introuvable : transcodage désactivé (iPhone, qualités réduites)');
    return found;
}

function deviceLabel(userAgent) {
    const ua = String(userAgent || '');
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Appareil';
}

// ═══════════════════════════════════════════════════════════════════════════════

function createApp({dataDir, version = '0.0.0', trustProxy = false, publicUrl = '', getPort}) {
    fs.mkdirSync(dataDir, {recursive: true});

    const auth = new AuthStore(dataDir);
    const settings = new SettingsStore(dataDir);
    const jobs = new JobManager();
    const sources = new SourceStore(dataDir, {settings, jobs});
    const pinLimiter = new LoginLimiter({maxFailures: 5});
    net.setConfiguredProxy(settings.get().httpProxy);

    const ffmpegPath = detectFfmpeg();
    const playback = new PlaybackManager({
        getConfig: () => settings.get(),
        getFfmpegPath: () => ffmpegPath,
        getInternalBase: () => `http://127.0.0.1:${getPort()}`,
        tmpRoot: path.join(os.tmpdir(), 'smv-player-hls', String(process.pid)),
    });
    const startedAt = Date.now();

    // ── Routes ───────────────────────────────────────────────────────────────
    const routes = [];
    const route = (method, pattern, handler, options = {}) => {
        const keys = [];
        const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, key) => {
            keys.push(key);
            return '([^/]+)';
        }) + '$');
        routes.push({method, regex, keys, handler, auth: options.auth !== false, source: !!options.source});
    };

    const setCookie = (c, user, remember) => {
        const {token, maxAge} = auth.issueToken(user, {remember});
        c.res.setHeader('Set-Cookie', auth.sessionCookie(token, {maxAge, secure: c.ctx.secure}));
    };

    // Public
    route('GET', '/api/health', () => ({ok: true}), {auth: false});

    route('GET', '/api/session', (c) => ({
        authenticated: !!c.user,
        user: c.user ? {username: c.user.username} : null,
        setupRequired: !auth.hasUsers(),
        version,
    }), {auth: false});

    route('POST', '/api/setup', async (c) => {
        if (auth.hasUsers()) throw new HttpError(409, 'Le compte administrateur existe déjà');
        const {code, username, password} = await c.body();
        const limit = auth.limiter.check(`setup:${c.ctx.ip}`);
        if (!limit.allowed) throw new HttpError(429, `Trop de tentatives, réessayez dans ${limit.retryAfter} s`);
        if (String(code || '').trim().toUpperCase() !== auth.setupCode) {
            auth.limiter.fail(`setup:${c.ctx.ip}`);
            throw new HttpError(403, 'Code d\'installation incorrect (affiché dans les logs du serveur)');
        }
        let user;
        try {
            user = await auth.createUser(String(username || '').trim(), password);
        } catch (err) {
            throw new HttpError(400, err.message);
        }
        setCookie(c, user, true);
        console.log(`Compte administrateur créé : ${user.username}`);
        return {success: true, user: {username: user.username}};
    }, {auth: false});

    route('POST', '/api/login', async (c) => {
        const {username, password, remember = true} = await c.body();
        const keys = [`ip:${c.ctx.ip}`, `user:${String(username || '').toLowerCase()}`];
        for (const key of keys) {
            const limit = auth.limiter.check(key);
            if (!limit.allowed) {
                throw new HttpError(429, `Trop de tentatives, réessayez dans ${limit.retryAfter} s`, {retryAfter: limit.retryAfter});
            }
        }
        const user = await auth.verify(String(username || '').trim(), String(password || ''));
        if (!user) {
            keys.forEach((key) => auth.limiter.fail(key));
            console.warn(`⚠️ Connexion refusée pour « ${String(username || '').slice(0, 32)} » depuis ${c.ctx.ip}`);
            throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
        }
        keys.forEach((key) => auth.limiter.success(key));
        setCookie(c, user, !!remember);
        return {success: true, user: {username: user.username}};
    }, {auth: false});

    // Compte
    route('POST', '/api/logout', (c) => {
        c.res.setHeader('Set-Cookie', auth.clearCookie({secure: c.ctx.secure}));
        return {success: true};
    });

    route('POST', '/api/account/password', async (c) => {
        const {current, next} = await c.body();
        let user;
        try {
            user = await auth.changePassword(c.user.username, current, next);
        } catch (err) {
            throw new HttpError(400, err.message);
        }
        setCookie(c, user, true);
        return {success: true};
    });

    route('POST', '/api/account/logout-all', (c) => {
        auth.revokeSessions(c.user.username);
        c.res.setHeader('Set-Cookie', auth.clearCookie({secure: c.ctx.secure}));
        return {success: true};
    });

    // Réglages et système
    route('GET', '/api/settings', () => settings.get());

    route('PUT', '/api/settings', async (c) => {
        let updated;
        try {
            updated = settings.update(await c.body());
        } catch (err) {
            throw new HttpError(400, `Proxy invalide : ${err.message}`);
        }
        net.setConfiguredProxy(updated.httpProxy);
        return updated;
    });

    route('GET', '/api/system', async () => {
        const proxyInfo = await net.describeProxy('http://example.com/');
        return {
            version,
            ffmpeg: !!ffmpegPath,
            node: process.version,
            arch: process.arch,
            platform: process.platform,
            uptime: Math.round((Date.now() - startedAt) / 1000),
            publicUrl,
            proxy: {address: net.maskProxy(proxyInfo.proxy), source: proxyInfo.source},
            streams: playback.list(),
        };
    });

    route('DELETE', '/api/streams/:id', (c) => ({success: playback.stop(c.params.id)}));

    route('GET', '/api/qr', async (c) => {
        const text = String(c.url.searchParams.get('text') || '').slice(0, 500);
        if (!/^https?:\/\//i.test(text)) throw new HttpError(400, 'Adresse invalide');
        return {dataUrl: await QRCode.toDataURL(text, {margin: 1, width: 280})};
    });

    route('GET', '/api/jobs/:id', (c) => {
        const job = jobs.get(c.params.id);
        if (!job) throw new HttpError(404, 'Tâche introuvable');
        return jobs.describe(job);
    });

    // Sources
    route('GET', '/api/sources', () => sources.list());

    route('POST', '/api/sources', async (c) => {
        try {
            const {source, job} = sources.create(await c.body());
            return {success: true, source, jobId: job?.id || null};
        } catch (err) {
            throw new HttpError(400, err.message);
        }
    });

    route('POST', '/api/m3u/preview', async (c) => {
        const {content} = await c.body();
        const parsed = parseM3U(content || '');
        return {live: parsed.channels.length, vod: parsed.vod.length};
    });

    route('POST', '/api/sources/:id/unlock', () => ({success: true}), {source: true});

    route('GET', '/api/sources/:id/library', (c) => sources.library(c.source), {source: true});

    route('PATCH', '/api/sources/:id', async (c) => {
        try {
            const {source, job} = await sources.update(c.source.id, await c.body());
            return {success: true, source, jobId: job?.id || null};
        } catch (err) {
            throw new HttpError(400, err.message);
        }
    }, {source: true});

    route('DELETE', '/api/sources/:id', (c) => ({success: sources.remove(c.source.id)}), {source: true});

    route('POST', '/api/sources/:id/refresh', (c) => {
        try {
            const job = sources.refresh(c.source.id);
            return {success: true, jobId: job.id};
        } catch (err) {
            throw new HttpError(400, err.message);
        }
    }, {source: true});

    route('PUT', '/api/sources/:id/favorites', async (c) => {
        const {keys} = await c.body();
        return {favorites: sources.setFavorites(c.source, Array.isArray(keys) ? keys : [])};
    }, {source: true});

    route('GET', '/api/sources/:id/episodes', async (c) => {
        try {
            const episodes = await sources.episodes(c.source, String(c.url.searchParams.get('series') || ''));
            return {episodes: sources.publicEpisodes(episodes)};
        } catch (err) {
            throw new HttpError(502, err.message);
        }
    }, {source: true});

    route('GET', '/api/sources/:id/epg', async (c) => ({
        programmes: await sources.epg(c.source, String(c.url.searchParams.get('key') || '')),
    }), {source: true});

    route('POST', '/api/sources/:id/play', async (c) => {
        const {key, quality, previous} = await c.body();
        // Libère tout de suite la lecture précédente de cet appareil (limite de connexions IPTV)
        if (previous) playback.stop(String(previous));
        let resolved;
        try {
            resolved = await sources.resolveStream(c.source, String(key || ''));
        } catch (err) {
            console.error('Erreur de lecture:', err.message);
            throw new HttpError(502, err.message);
        }
        const {item, url, headers} = resolved;
        const description = playback.create({
            url,
            headers,
            contentType: item.contentType === 'live' ? 'live' : 'vod',
            quality,
            meta: {
                title: item.name,
                source: c.source.name,
                client: c.ctx.ip,
                device: deviceLabel(c.req.headers['user-agent']),
            },
        });
        if (!String(key).startsWith('ep:')) sources.addHistory(c.source, String(key));
        return {success: true, title: item.name, ...description};
    }, {source: true});

    route('DELETE', '/api/play/:id', (c) => ({success: playback.stop(c.params.id)}));

    // ── Traitement d'une requête API ────────────────────────────────────────
    async function handleApi(req, res, url, ctx) {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
        const session = token ? auth.verifyToken(token) : null;

        // Images : <img> ne peut pas envoyer d'en-têtes, le cookie suffit
        if (url.pathname === '/api/img' && req.method === 'GET') {
            if (!session) throw new HttpError(401, 'Non connecté');
            await serveImage(req, res, String(url.searchParams.get('u') || ''), {userAgent: settings.get().userAgent});
            return;
        }

        const match = routes
            .map((r) => ({r, m: r.method === req.method ? r.regex.exec(url.pathname) : null}))
            .find(({m}) => m);
        if (!match) {
            const exists = routes.some((r) => r.regex.test(url.pathname));
            throw new HttpError(exists ? 405 : 404, exists ? 'Méthode non autorisée' : 'Route inconnue');
        }
        const {r, m} = match;

        // Requêtes modifiantes : JSON uniquement et même origine (protection CSRF)
        if (!['GET', 'HEAD'].includes(req.method)) {
            const type = req.headers['content-type'];
            const origin = req.headers.origin;
            if (type && !type.includes('application/json')) throw new HttpError(415, 'JSON attendu');
            if (origin && origin !== 'null') {
                let originHost = '';
                try {
                    originHost = new URL(origin).host;
                } catch (_) {
                }
                if (originHost !== ctx.host) throw new HttpError(403, 'Origine refusée');
            } else if (origin === 'null') {
                throw new HttpError(403, 'Origine refusée');
            }
        }

        if (r.auth && !session) throw new HttpError(401, 'Non connecté', {unauthorized: true});

        // Session prolongée tant que l'appareil est utilisé
        if (session?.remember && session.expires - Date.now() < auth.sessionMs / 2) {
            const {token: fresh, maxAge} = auth.issueToken(session.user, {remember: true});
            res.setHeader('Set-Cookie', auth.sessionCookie(fresh, {maxAge, secure: ctx.secure}));
        }

        const params = {};
        r.keys.forEach((key, i) => {
            params[key] = decodeURIComponent(m[i + 1]);
        });

        let bodyPromise = null;
        const c = {
            req, res, url, ctx, params,
            user: session?.user || null,
            body: () => {
                bodyPromise = bodyPromise || readJson(req);
                return bodyPromise;
            },
        };

        if (r.source) {
            c.source = sources.get(params.id);
            if (!c.source) throw new HttpError(404, 'Source introuvable');
            if (c.source.pinHash || c.source.legacyPin) {
                const limitKey = `${ctx.ip}|${c.source.id}`;
                const limit = pinLimiter.check(limitKey);
                if (!limit.allowed) throw new HttpError(429, `Trop d'essais de PIN, réessayez dans ${limit.retryAfter} s`);
                if (!(await sources.checkPin(c.source, req.headers['x-source-pin']))) {
                    if (req.headers['x-source-pin']) pinLimiter.fail(limitKey);
                    throw new HttpError(403, req.headers['x-source-pin'] ? 'PIN incorrect' : 'PIN requis', {pinRequired: true});
                }
                pinLimiter.success(limitKey);
            }
        }

        const result = await r.handler(c);
        if (!res.headersSent) sendJson(req, res, 200, result);
    }

    // ── Routeur principal ───────────────────────────────────────────────────
    async function handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const ctx = requestContext(req, trustProxy);

        if (url.pathname.startsWith('/s/')) {
            const [, , sessionId, ...rest] = url.pathname.split('/');
            await playback.handle(req, res, sessionId, rest.join('/'), url.searchParams);
            return;
        }

        if (url.pathname.startsWith('/api/')) {
            try {
                await handleApi(req, res, url, ctx);
            } catch (err) {
                const status = err.status || 500;
                if (status >= 500) console.error('❌ API:', err.message);
                if (!res.headersSent) {
                    const headers = err.extra?.retryAfter ? {'Retry-After': String(err.extra.retryAfter)} : {};
                    sendJson(req, res, status, {success: false, error: err.message, ...(err.extra || {})}, headers);
                }
            }
            return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendText(res, 405, 'Méthode non autorisée');
            return;
        }

        if (url.pathname.startsWith('/vendor/')) {
            const file = resolveVendor(url.pathname.slice('/vendor/'.length));
            if (!file) {
                sendText(res, 404, 'Introuvable');
                return;
            }
            serveFile(req, res, file, {cache: 'public, max-age=86400'});
            return;
        }

        // Fichiers de l'interface ; toute autre adresse renvoie l'application (routes côté client)
        const relPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = resolveInside(WEB_DIR, relPath);
        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
            const isHtml = file.endsWith('.html');
            serveFile(req, res, file, {html: isHtml, cache: 'no-cache'});
            return;
        }
        if (path.extname(url.pathname)) {
            setSecurityHeaders(res);
            sendText(res, 404, 'Introuvable');
            return;
        }
        serveFile(req, res, path.join(WEB_DIR, 'index.html'), {html: true});
    }

    function shutdown() {
        playback.stopAll();
        sources.flush();
        jobs.stop();
    }

    return {handle, shutdown, auth, settings, sources, playback, ffmpegPath};
}

module.exports = {createApp, deviceLabel};
