const path = require('path');
const {randomKey, readJsonFile, writeJsonFileSync} = require('./utils');
const {normalizeProxyUrl} = require('./net');

const DEFAULT_CONFIG = {
    userAgent: 'Lavf/57.83.100',
    networkTimeout: 60,
    referrer: '',
    headerFields: '',
    // Proxy HTTP sortant (réseau d'entreprise) — vide : variables d'environnement / proxy système
    httpProxy: '',
    vlcPath: '',
    ffmpegPath: '',
    // Transcodage HLS pour iPhone : 'copy' (remux, quasi sans CPU) ou 'h264' (réencodage complet)
    hlsVideoMode: 'copy',
    port: 9191,
    // Autorise l'accès depuis le réseau local (iPhone, tablette…)
    remoteAccess: true,
    // Electron : fermer la fenêtre garde le serveur actif dans la zone de notification
    keepRunningInTray: false,
    accessKey: '',
};

// Champs modifiables depuis l'interface (l'accès réseau / la clé passent par des routes dédiées)
const EDITABLE_FIELDS = [
    'userAgent',
    'networkTimeout',
    'referrer',
    'headerFields',
    'httpProxy',
    'vlcPath',
    'ffmpegPath',
    'hlsVideoMode',
    'remoteAccess',
    'keepRunningInTray',
];

class ConfigStore {
    constructor(dataDir) {
        this.filePath = path.join(dataDir, 'config.json');
        this.data = {...DEFAULT_CONFIG, ...readJsonFile(this.filePath, {})};
        if (!this.data.accessKey) {
            this.data.accessKey = randomKey();
            this.save();
        }
    }

    get() {
        return this.data;
    }

    // Config exposée aux clients (sans la clé d'accès)
    getPublic() {
        const {accessKey, ...rest} = this.data;
        return rest;
    }

    update(patch = {}) {
        // Lève une erreur si l'adresse du proxy est invalide (aucun champ n'est modifié)
        if (patch.httpProxy !== undefined) patch = {...patch, httpProxy: normalizeProxyUrl(patch.httpProxy)};
        for (const field of EDITABLE_FIELDS) {
            if (patch[field] === undefined) continue;
            this.data[field] = patch[field];
        }
        this.data.networkTimeout = Math.max(5, Number.parseInt(this.data.networkTimeout, 10) || 60);
        if (!['copy', 'h264'].includes(this.data.hlsVideoMode)) this.data.hlsVideoMode = 'copy';
        this.data.remoteAccess = !!this.data.remoteAccess;
        this.data.keepRunningInTray = !!this.data.keepRunningInTray;
        this.save();
        return this.getPublic();
    }

    regenerateAccessKey() {
        this.data.accessKey = randomKey();
        this.save();
        return this.data.accessKey;
    }

    save() {
        try {
            writeJsonFileSync(this.filePath, this.data);
        } catch (e) {
            console.error('Erreur sauvegarde config:', e.message);
        }
    }
}

module.exports = {ConfigStore, DEFAULT_CONFIG};
