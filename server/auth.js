const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {promisify} = require('util');
const {readJsonFile, writeJsonFileSync, randomKey} = require('./utils');

/*
 * Comptes et sessions
 *
 * - Mots de passe hachés avec scrypt (sel aléatoire par compte)
 * - Session = cookie signé HMAC-SHA256 (identifiant, version, expiration) :
 *   aucun état serveur, survit aux redémarrages ; changer le mot de passe ou
 *   « déconnecter tous les appareils » incrémente la version et invalide les cookies
 * - Limitation des tentatives de connexion par IP et par identifiant
 */

const scrypt = promisify(crypto.scrypt);
const SCRYPT = {N: 16384, r: 8, p: 1, keylen: 64};
const USERNAME_RE = /^[a-zA-Z0-9._@-]{2,32}$/;
const MIN_PASSWORD = 8;
const COOKIE_NAME = 'smv_session';
// Empreinte factice : un identifiant inconnu coûte le même calcul qu'un vrai
const DUMMY_HASH = ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, Buffer.alloc(16).toString('base64'), Buffer.alloc(64).toString('base64')].join('$');

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, SCRYPT.keylen, {N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024});
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function checkPassword(password, stored) {
    const [algo, N, r, p, salt, hash] = String(stored || '').split('$');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, {
        N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(expected, actual);
}

function validateCredentials(username, password) {
    if (!USERNAME_RE.test(String(username || ''))) {
        throw new Error('Identifiant invalide (2 à 32 caractères : lettres, chiffres, . _ - @)');
    }
    if (String(password || '').length < MIN_PASSWORD) {
        throw new Error(`Mot de passe trop court (${MIN_PASSWORD} caractères minimum)`);
    }
}

// ── Limitation des tentatives ────────────────────────────────────────────────
class LoginLimiter {
    constructor({maxFailures = 5, baseLockMs = 60 * 1000, maxLockMs = 30 * 60 * 1000} = {}) {
        this.maxFailures = maxFailures;
        this.baseLockMs = baseLockMs;
        this.maxLockMs = maxLockMs;
        this.entries = new Map();
    }

    check(key) {
        const entry = this.entries.get(key);
        if (!entry || !entry.lockedUntil) return {allowed: true};
        const remaining = entry.lockedUntil - Date.now();
        return remaining > 0 ? {allowed: false, retryAfter: Math.ceil(remaining / 1000)} : {allowed: true};
    }

    fail(key) {
        const entry = this.entries.get(key) || {failures: 0, locks: 0, lockedUntil: 0};
        entry.failures++;
        if (entry.failures >= this.maxFailures) {
            entry.locks++;
            entry.failures = 0;
            entry.lockedUntil = Date.now() + Math.min(this.maxLockMs, this.baseLockMs * 2 ** (entry.locks - 1));
        }
        entry.updatedAt = Date.now();
        this.entries.set(key, entry);
    }

    success(key) {
        this.entries.delete(key);
    }

    prune() {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (now - entry.updatedAt > this.maxLockMs * 2) this.entries.delete(key);
        }
    }
}

// ── Comptes ──────────────────────────────────────────────────────────────────
class AuthStore {
    constructor(dataDir, {sessionDays = 30, secret} = {}) {
        this.usersPath = path.join(dataDir, 'users.json');
        this.users = [];
        this.usersMtime = 0;
        this.lastCheck = 0;
        this.reload(true);
        this.sessionMs = sessionDays * 24 * 60 * 60 * 1000;
        this.secret = secret ? Buffer.from(secret) : this.loadSecret(path.join(dataDir, 'secret.key'));
        this.setupCode = this.users.length ? null : randomKey(10);
        this.limiter = new LoginLimiter();
        setInterval(() => this.limiter.prune(), 10 * 60 * 1000).unref();
    }

    loadSecret(secretPath) {
        try {
            const existing = fs.readFileSync(secretPath);
            if (existing.length >= 32) return existing;
        } catch (_) {
        }
        const secret = crypto.randomBytes(48);
        fs.writeFileSync(secretPath, secret, {mode: 0o600});
        return secret;
    }

    // Relit users.json s'il a changé (ex. mot de passe réinitialisé par server/admin.js)
    reload(force = false) {
        const now = Date.now();
        if (!force && now - this.lastCheck < 2000) return;
        this.lastCheck = now;
        let mtime = 0;
        try {
            mtime = fs.statSync(this.usersPath).mtimeMs;
        } catch (_) {
        }
        if (!force && mtime === this.usersMtime) return;
        this.usersMtime = mtime;
        const users = readJsonFile(this.usersPath, []);
        this.users = Array.isArray(users) ? users : [];
        if (this.users.length) this.setupCode = null;
    }

    save() {
        writeJsonFileSync(this.usersPath, this.users);
        try {
            this.usersMtime = fs.statSync(this.usersPath).mtimeMs;
        } catch (_) {
        }
    }

    hasUsers() {
        return this.users.length > 0;
    }

    find(username) {
        this.reload();
        const wanted = String(username || '').toLowerCase();
        return this.users.find((u) => u.username.toLowerCase() === wanted) || null;
    }

    async createUser(username, password) {
        validateCredentials(username, password);
        if (this.find(username)) throw new Error('Ce compte existe déjà');
        const user = {
            username: String(username),
            password: await hashPassword(String(password)),
            version: 1,
            createdAt: new Date().toISOString(),
        };
        this.users.push(user);
        this.setupCode = null;
        this.save();
        return user;
    }

    // Vérifie aussi un compte inexistant (même durée de calcul : pas d'énumération)
    async verify(username, password) {
        const user = this.find(username);
        const ok = await checkPassword(password, user?.password || DUMMY_HASH).catch(() => false);
        return ok && user ? user : null;
    }

    async changePassword(username, current, next) {
        const user = await this.verify(username, current);
        if (!user) throw new Error('Mot de passe actuel incorrect');
        validateCredentials(user.username, next);
        user.password = await hashPassword(String(next));
        user.version = (user.version || 1) + 1;
        this.save();
        return user;
    }

    async resetPassword(username, password) {
        const user = this.find(username);
        if (!user) throw new Error(`Compte « ${username} » introuvable`);
        validateCredentials(user.username, password);
        user.password = await hashPassword(String(password));
        user.version = (user.version || 1) + 1;
        this.save();
        return user;
    }

    revokeSessions(username) {
        const user = this.find(username);
        if (!user) return;
        user.version = (user.version || 1) + 1;
        this.save();
    }

    sign(payload) {
        return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    }

    issueToken(user, {remember = true} = {}) {
        const maxAge = remember ? this.sessionMs : 12 * 60 * 60 * 1000;
        const payload = Buffer.from(JSON.stringify({
            u: user.username,
            v: user.version || 1,
            e: Date.now() + maxAge,
            r: remember ? 1 : 0,
        })).toString('base64url');
        return {token: `${payload}.${this.sign(payload)}`, maxAge: remember ? maxAge : null};
    }

    /**
     * Session valide → {user, expires, remember}, sinon null.
     */
    verifyToken(token) {
        const [payload, signature] = String(token || '').split('.');
        if (!payload || !signature) return null;
        const expected = Buffer.from(this.sign(payload));
        const actual = Buffer.from(signature);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
        let data;
        try {
            data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
        } catch (_) {
            return null;
        }
        if (!data || data.e < Date.now()) return null;
        const user = this.find(data.u);
        if (!user || (user.version || 1) !== data.v) return null;
        return {user, expires: data.e, remember: !!data.r};
    }

    sessionCookie(token, {maxAge, secure}) {
        const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
        if (maxAge) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
        if (secure) parts.push('Secure');
        return parts.join('; ');
    }

    clearCookie({secure}) {
        return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
    }
}

module.exports = {AuthStore, LoginLimiter, COOKIE_NAME, hashPassword, checkPassword};
