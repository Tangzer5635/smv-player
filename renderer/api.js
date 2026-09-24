/**
 * SMV Player — renderer/api.js
 *
 * Client de l'API HTTP du serveur SMV. Utilisé à l'identique par la fenêtre
 * Electron et par Safari / l'app écran d'accueil sur iPhone.
 *
 * La clé d'accès arrive par l'URL (?key=…, QR code ou fenêtre Electron),
 * puis est mémorisée localement.
 */

'use strict';

(() => {
    const KEY_STORAGE = 'smv_access_key';

    function readStoredKey() {
        try {
            return localStorage.getItem(KEY_STORAGE) || '';
        } catch (_) {
            return '';
        }
    }

    function storeKey(key) {
        try {
            localStorage.setItem(KEY_STORAGE, key);
        } catch (_) {
        }
    }

    const urlKey = new URLSearchParams(location.search).get('key');
    let accessKey = (urlKey || readStoredKey()).trim().toUpperCase();
    if (urlKey) storeKey(accessKey);

    // Le manifest embarque la clé : l'app ajoutée à l'écran d'accueil iOS
    // (stockage séparé de Safari) démarre directement authentifiée.
    function updateManifestLink() {
        const link = document.querySelector('link[rel="manifest"]');
        if (link) link.href = accessKey ? `/manifest.webmanifest?key=${encodeURIComponent(accessKey)}` : '/manifest.webmanifest';
    }

    document.addEventListener('DOMContentLoaded', updateManifestLink);

    class ApiError extends Error {
        constructor(message, status, data) {
            super(message);
            this.status = status;
            this.data = data;
        }
    }

    async function request(method, path, body) {
        const options = {
            method,
            headers: {'X-SMV-Key': accessKey},
            cache: 'no-store',
        };
        if (body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }

        let res;
        try {
            res = await fetch(path, options);
        } catch (_) {
            throw new ApiError('Serveur SMV injoignable', 0);
        }

        let data = null;
        try {
            data = await res.json();
        } catch (_) {
        }

        if (res.status === 401) {
            window.dispatchEvent(new CustomEvent('smv:unauthorized'));
            throw new ApiError('Clé d\'accès invalide', 401, data);
        }
        if (!res.ok && !(data && typeof data === 'object' && 'success' in data)) {
            throw new ApiError(data?.error || `Erreur ${res.status}`, res.status, data);
        }
        return data;
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Tâches longues côté serveur (connexion portail, téléchargement M3U)
    async function runJob(startPath, body, onProgress) {
        const started = await request('POST', startPath, body);
        if (!started?.success) return started;
        let failures = 0;
        while (true) {
            await sleep(700);
            let job;
            try {
                job = await request('GET', `/api/jobs/${started.jobId}`);
                failures = 0;
            } catch (err) {
                // Réseau Wi-Fi instable : quelques échecs tolérés avant d'abandonner
                if (err.status === 401 || ++failures > 5) throw err;
                continue;
            }
            if (job.status === 'done') return job.result;
            if (job.status === 'error') return {success: false, error: job.error};
            if (job.progress) onProgress?.(job.progress);
        }
    }

    window.smvApi = {
        get accessKey() {
            return accessKey;
        },

        setAccessKey(key) {
            accessKey = String(key || '').trim().toUpperCase();
            storeKey(accessKey);
            updateManifestLink();
        },

        async checkAuth() {
            if (!accessKey) return false;
            try {
                const res = await request('GET', '/api/ping');
                return !!res?.success;
            } catch (_) {
                return false;
            }
        },

        // ── Config & serveur ──
        getConfig: () => request('GET', '/api/config'),
        updateConfig: (cfg) => request('PUT', '/api/config', cfg),
        serverInfo: () => request('GET', '/api/server-info'),
        regenerateAccessKey: () => request('POST', '/api/access-key/regenerate'),

        // ── Profils ──
        profilesList: () => request('GET', '/api/profiles'),
        profileSave: (p) => request('POST', '/api/profiles', p),
        profileLoad: (id, pin) => request('POST', `/api/profiles/${encodeURIComponent(id)}/load`, {pin}),
        profileDelete: (id) => request('DELETE', `/api/profiles/${encodeURIComponent(id)}`),
        profileUpdate: ({id, ...patch}) => request('PATCH', `/api/profiles/${encodeURIComponent(id)}`, patch),
        profileRename: ({id, name}) => request('PATCH', `/api/profiles/${encodeURIComponent(id)}`, {name}),

        // ── Sources ──
        stalkerConnect: (p, onProgress) => runJob('/api/stalker/connect', p, onProgress),
        stalkerGetStream: (p) => request('POST', '/api/stalker/stream', p),
        stalkerSeriesEpisodes: (p) => request('POST', '/api/stalker/episodes', p),
        m3uParse: (content) => request('POST', '/api/m3u/parse', {content}),
        m3uFetch: (url, onProgress) => runJob('/api/m3u/fetch', {url}, onProgress),

        // ── Lecture ──
        createPlayback: (p) => request('POST', '/api/play', p),
        stopPlayback: (id) => request('DELETE', `/api/play/${encodeURIComponent(id)}`).catch(() => null),
    };
})();
