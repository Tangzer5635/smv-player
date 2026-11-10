const fs = require('fs');
const path = require('path');
const {readJsonFile, writeJsonFileSync} = require('./utils');
const {normalizeProxyUrl} = require('./net');

/*
 * Réglages du serveur (communs à tous les appareils).
 * Les préférences propres à un appareil (qualité, mode de lecture) restent côté navigateur.
 */

const DEFAULT_SETTINGS = {
    // Réseau IPTV
    userAgent: 'Lavf/57.83.100',
    networkTimeout: 60,
    referrer: '',
    headerFields: '',
    httpProxy: '',
    // Vidéo copiée telle quelle (rapide) ou toujours réencodée en H.264 (compatibilité)
    hlsVideoMode: 'copy',
};

const FIELDS = Object.keys(DEFAULT_SETTINGS);

class SettingsStore {
    constructor(dataDir) {
        this.filePath = path.join(dataDir, 'settings.json');
        let stored = readJsonFile(this.filePath, null);
        if (!stored) {
            // Reprise de la configuration de SMV Player 3 (version Electron)
            const legacy = readJsonFile(path.join(dataDir, 'config.json'), {});
            stored = Object.fromEntries(FIELDS.filter((f) => legacy[f] !== undefined).map((f) => [f, legacy[f]]));
        }
        this.data = this.sanitize({...DEFAULT_SETTINGS, ...stored});
        if (!fs.existsSync(this.filePath)) this.save();
    }

    sanitize(data) {
        const clean = {};
        for (const field of FIELDS) clean[field] = data[field] ?? DEFAULT_SETTINGS[field];
        clean.userAgent = String(clean.userAgent || DEFAULT_SETTINGS.userAgent).slice(0, 300);
        clean.networkTimeout = Math.min(300, Math.max(5, Number.parseInt(clean.networkTimeout, 10) || 60));
        clean.referrer = String(clean.referrer || '').slice(0, 500);
        clean.headerFields = String(clean.headerFields || '').slice(0, 2000);
        clean.hlsVideoMode = clean.hlsVideoMode === 'h264' ? 'h264' : 'copy';
        clean.httpProxy = String(clean.httpProxy || '');
        return clean;
    }

    get() {
        return this.data;
    }

    // Lève une erreur (rien n'est modifié) si l'adresse du proxy est invalide
    update(patch = {}) {
        const next = {...this.data};
        for (const field of FIELDS) {
            if (patch[field] !== undefined) next[field] = patch[field];
        }
        if (patch.httpProxy !== undefined) next.httpProxy = normalizeProxyUrl(patch.httpProxy);
        this.data = this.sanitize(next);
        this.save();
        return this.data;
    }

    save() {
        writeJsonFileSync(this.filePath, this.data);
    }
}

module.exports = {SettingsStore, DEFAULT_SETTINGS};
