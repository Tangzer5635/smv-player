const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Alphabet sans caractères ambigus (0/O, 1/I/L) — facile à taper sur iPhone
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomKey(length = 8) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
    return out;
}

function randomId(bytes = 16) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length || !bufA.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function readJsonFile(filePath, fallback) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        console.error(`Erreur lecture ${path.basename(filePath)}:`, e.message);
    }
    return fallback;
}

// Écriture atomique : fichier temporaire puis rename (évite un JSON tronqué en cas de crash)
function writeJsonFileSync(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
}

/**
 * Adresses IPv4 du réseau local (celles que l'iPhone peut joindre).
 * Les plages privées classiques sont placées en premier.
 */
function getLanAddresses() {
    const result = [];
    const ifaces = os.networkInterfaces();
    for (const [name, list] of Object.entries(ifaces)) {
        for (const addr of list || []) {
            if (addr.family !== 'IPv4' && addr.family !== 4) continue;
            if (addr.internal) continue;
            if (addr.address.startsWith('169.254.')) continue;
            result.push({name, address: addr.address});
        }
    }
    const score = (ip) => {
        if (ip.startsWith('192.168.')) return 0;
        if (ip.startsWith('10.')) return 1;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
        return 3;
    };
    const isVirtual = (name) => /vbox|vmnet|virtual|docker|veth|br-|wsl|hyper-v|vethernet|tailscale|zerotier/i.test(name);
    return result.sort((a, b) =>
        (isVirtual(a.name) - isVirtual(b.name)) || (score(a.address) - score(b.address))
    );
}

function isLoopback(remoteAddress) {
    const addr = String(remoteAddress || '');
    return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function parseHeaderFields(value) {
    const headers = {};
    String(value || '')
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .forEach((pair) => {
            const idx = pair.indexOf(':');
            if (idx <= 0) return;
            const key = pair.slice(0, idx).trim();
            const val = pair.slice(idx + 1).trim();
            if (key) headers[key] = val;
        });
    return headers;
}

module.exports = {
    randomKey,
    randomId,
    safeEqual,
    readJsonFile,
    writeJsonFileSync,
    getLanAddresses,
    isLoopback,
    parseHeaderFields,
};
