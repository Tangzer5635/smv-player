const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/*
 * Utilitaires HTTP communs : erreurs, JSON, fichiers statiques, en-têtes de sécurité.
 */

const JSON_LIMIT = 200 * 1024 * 1024;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

// Interface : tout vient du serveur lui-même (images distantes via /api/img)
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

function setSecurityHeaders(res, {html = false} = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (html) res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}

function acceptsGzip(req) {
    return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

function sendJson(req, res, status, payload, headers = {}) {
    const body = Buffer.from(JSON.stringify(payload ?? null), 'utf-8');
    const base = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
    };
    if (acceptsGzip(req) && body.length > 2048) {
        zlib.gzip(body, (err, gz) => {
            if (res.writableEnded) return;
            if (err) {
                res.writeHead(status, {...base, 'Content-Length': body.length});
                res.end(body);
                return;
            }
            res.writeHead(status, {...base, 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Vary: 'Accept-Encoding'});
            res.end(gz);
        });
        return;
    }
    res.writeHead(status, {...base, 'Content-Length': body.length});
    res.end(body);
}

function sendText(res, status, text, headers = {}) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', ...headers});
    res.end(text);
}

function readJson(req, limit = JSON_LIMIT) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new HttpError(413, 'Requête trop volumineuse'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                const value = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                resolve(value && typeof value === 'object' ? value : {});
            } catch (_) {
                reject(new HttpError(400, 'JSON invalide'));
            }
        });
        req.on('error', reject);
    });
}

// Chemin demandé résolu dans un dossier autorisé (refuse "../")
function resolveInside(baseDir, relPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(relPath);
    } catch (_) {
        return null;
    }
    const target = path.normalize(path.join(baseDir, decoded));
    if (target !== baseDir && !target.startsWith(baseDir + path.sep)) return null;
    return target;
}

function serveFile(req, res, filePath, {cache = 'no-cache', html = false} = {}) {
    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            sendText(res, 404, 'Introuvable');
            return;
        }
        const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        setSecurityHeaders(res, {html});
        const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000);
        const headers = {'Content-Type': type, 'Cache-Control': cache, 'Last-Modified': lastModified.toUTCString()};
        const since = Date.parse(req.headers['if-modified-since'] || '');
        if (since && since >= lastModified.getTime()) {
            res.writeHead(304, headers);
            res.end();
            return;
        }
        if (req.method === 'HEAD') {
            res.writeHead(200, {...headers, 'Content-Length': stat.size});
            res.end();
            return;
        }
        const compressible = /text|javascript|json|svg|manifest/.test(type);
        if (compressible && stat.size > 1024 && acceptsGzip(req)) {
            res.writeHead(200, {...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding'});
            fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
            return;
        }
        res.writeHead(200, {...headers, 'Content-Length': stat.size});
        fs.createReadStream(filePath).pipe(res);
    });
}

function parseCookies(header) {
    const cookies = {};
    String(header || '').split(';').forEach((part) => {
        const idx = part.indexOf('=');
        if (idx <= 0) return;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        try {
            cookies[name] = decodeURIComponent(value);
        } catch (_) {
            cookies[name] = value;
        }
    });
    return cookies;
}

/**
 * Informations sur le client, en tenant compte du reverse proxy (Caddy) quand
 * SMV_TRUST_PROXY est actif : IP réelle et protocole HTTPS d'origine.
 */
function requestContext(req, trustProxy) {
    const forwardedFor = trustProxy ? String(req.headers['x-forwarded-for'] || '') : '';
    const forwardedIp = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean).pop();
    const ip = (forwardedIp || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const proto = trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    const secure = !!req.socket.encrypted || proto === 'https';
    const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '';
    return {ip, secure, host: String(host).split(',')[0].trim()};
}

module.exports = {
    HttpError,
    MIME_TYPES,
    setSecurityHeaders,
    sendJson,
    sendText,
    readJson,
    resolveInside,
    serveFile,
    parseCookies,
    requestContext,
};
