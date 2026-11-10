const http = require('http');
const https = require('https');
const {agentFor} = require('./net');

/*
 * Proxy des logos / affiches.
 *
 * Servie en HTTPS, l'interface ne peut pas afficher les images HTTP du fournisseur
 * (contenu mixte bloqué par les navigateurs) : le serveur les relaie et garde les
 * plus récentes en mémoire (un Raspberry Pi n'a pas à les retélécharger sans cesse).
 */

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;

class ImageCache {
    constructor() {
        this.entries = new Map();
        this.size = 0;
    }

    get(url) {
        const entry = this.entries.get(url);
        if (!entry) return null;
        if (Date.now() - entry.at > (entry.failed ? FAILURE_TTL_MS : CACHE_TTL_MS)) {
            this.delete(url);
            return null;
        }
        // LRU : réinsertion en fin de Map
        this.entries.delete(url);
        this.entries.set(url, entry);
        return entry;
    }

    set(url, entry) {
        this.delete(url);
        this.entries.set(url, entry);
        this.size += entry.body?.length || 0;
        while (this.size > CACHE_MAX_BYTES && this.entries.size) {
            this.delete(this.entries.keys().next().value);
        }
    }

    delete(url) {
        const entry = this.entries.get(url);
        if (!entry) return;
        this.size -= entry.body?.length || 0;
        this.entries.delete(url);
    }
}

const cache = new ImageCache();
const pending = new Map();

async function download(url, userAgent, redirects = 0) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Protocole non supporté');
    const isHttps = parsed.protocol === 'https:';
    const {agent} = await agentFor(url);
    return new Promise((resolve, reject) => {
        const req = (isHttps ? https : http).request(parsed, {
            method: 'GET',
            agent,
            timeout: 10000,
            headers: {'User-Agent': userAgent, Accept: 'image/*'},
            ...(isHttps ? {rejectUnauthorized: false} : {}),
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
                res.resume();
                resolve(download(new URL(res.headers.location, url).toString(), userAgent, redirects + 1));
                return;
            }
            const type = String(res.headers['content-type'] || '');
            if (res.statusCode !== 200 || !/^image\//i.test(type) || /svg/i.test(type)) {
                res.resume();
                reject(new Error(`Image refusée (${res.statusCode} ${type})`));
                return;
            }
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_IMAGE_BYTES) {
                    req.destroy(new Error('Image trop volumineuse'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve({type, body: Buffer.concat(chunks)}));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('Délai dépassé')));
        req.on('error', reject);
        req.end();
    });
}

/**
 * Sert l'image distante `url`. Les SVG sont refusés (ils peuvent contenir du script).
 */
async function serveImage(req, res, url, {userAgent}) {
    if (!/^https?:\/\//i.test(url)) {
        res.writeHead(400);
        res.end();
        return;
    }
    let entry = cache.get(url);
    if (!entry) {
        if (!pending.has(url)) {
            pending.set(url, download(url, userAgent)
                .then((img) => ({...img, at: Date.now()}))
                .catch(() => ({failed: true, at: Date.now()}))
                .then((result) => {
                    cache.set(url, result);
                    pending.delete(url);
                    return result;
                }));
        }
        entry = await pending.get(url);
    }
    if (entry.failed) {
        res.writeHead(404, {'Cache-Control': 'private, max-age=600'});
        res.end();
        return;
    }
    res.writeHead(200, {
        'Content-Type': entry.type,
        'Content-Length': entry.body.length,
        'Cache-Control': 'private, max-age=604800',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
    });
    res.end(entry.body);
}

module.exports = {serveImage};
