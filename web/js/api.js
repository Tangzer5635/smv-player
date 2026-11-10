/*
 * Client de l'API SMV Player. La session est un cookie HttpOnly posé par le
 * serveur : rien de secret n'est stocké dans le navigateur, hormis les codes PIN
 * saisis (le temps de l'onglet, sessionStorage).
 */

export class ApiError extends Error {
    constructor(message, status, data) {
        super(message);
        this.status = status;
        this.data = data || {};
    }
}

const PIN_STORAGE = 'smv_pins';

function readPins() {
    try {
        return JSON.parse(sessionStorage.getItem(PIN_STORAGE) || '{}');
    } catch (_) {
        return {};
    }
}

export const pins = {
    get: (sourceId) => readPins()[sourceId] || '',
    set(sourceId, pin) {
        const all = readPins();
        all[sourceId] = pin;
        try {
            sessionStorage.setItem(PIN_STORAGE, JSON.stringify(all));
        } catch (_) {
        }
    },
    clear(sourceId) {
        const all = readPins();
        delete all[sourceId];
        try {
            sessionStorage.setItem(PIN_STORAGE, JSON.stringify(all));
        } catch (_) {
        }
    },
};

async function request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const sourceId = /^\/api\/sources\/([^/]+)/.exec(path)?.[1];
    if (sourceId && pins.get(decodeURIComponent(sourceId))) headers['X-Source-Pin'] = pins.get(decodeURIComponent(sourceId));

    let res;
    try {
        res = await fetch(path, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            credentials: 'same-origin',
            cache: 'no-store',
        });
    } catch (_) {
        throw new ApiError('Serveur injoignable — vérifiez la connexion', 0);
    }
    let data = null;
    try {
        data = await res.json();
    } catch (_) {
    }
    if (!res.ok) {
        if (res.status === 401 && data?.unauthorized) window.dispatchEvent(new CustomEvent('smv:unauthorized'));
        throw new ApiError(data?.error || `Erreur ${res.status}`, res.status, data);
    }
    return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const enc = encodeURIComponent;

export const api = {
    // Session
    session: () => request('GET', '/api/session'),
    login: (username, password, remember) => request('POST', '/api/login', {username, password, remember}),
    setup: (code, username, password) => request('POST', '/api/setup', {code, username, password}),
    logout: () => request('POST', '/api/logout', {}),
    logoutAll: () => request('POST', '/api/account/logout-all', {}),
    changePassword: (current, next) => request('POST', '/api/account/password', {current, next}),

    // Réglages / système
    settings: () => request('GET', '/api/settings'),
    saveSettings: (patch) => request('PUT', '/api/settings', patch),
    system: () => request('GET', '/api/system'),
    stopStream: (id) => request('DELETE', `/api/streams/${enc(id)}`),
    qr: (text) => request('GET', `/api/qr?text=${enc(text)}`),

    // Sources
    sources: () => request('GET', '/api/sources'),
    createSource: (data) => request('POST', '/api/sources', data),
    updateSource: (id, patch) => request('PATCH', `/api/sources/${enc(id)}`, patch),
    deleteSource: (id) => request('DELETE', `/api/sources/${enc(id)}`),
    refreshSource: (id) => request('POST', `/api/sources/${enc(id)}/refresh`, {}),
    unlock: (id) => request('POST', `/api/sources/${enc(id)}/unlock`, {}),
    library: (id) => request('GET', `/api/sources/${enc(id)}/library`),
    setFavorites: (id, keys) => request('PUT', `/api/sources/${enc(id)}/favorites`, {keys}),
    episodes: (id, seriesKey) => request('GET', `/api/sources/${enc(id)}/episodes?series=${enc(seriesKey)}`),
    epg: (id, key) => request('GET', `/api/sources/${enc(id)}/epg?key=${enc(key)}`),
    play: (id, body) => request('POST', `/api/sources/${enc(id)}/play`, body),
    stopPlay: (id) => request('DELETE', `/api/play/${enc(id)}`).catch(() => null),

    // Suivi d'une tâche serveur (chargement d'une source)
    async waitJob(jobId, onProgress) {
        let failures = 0;
        while (true) {
            await sleep(700);
            let job;
            try {
                job = await request('GET', `/api/jobs/${enc(jobId)}`);
                failures = 0;
            } catch (err) {
                if (err.status === 401 || err.status === 404 || ++failures > 8) throw err;
                continue;
            }
            if (job.status === 'done') return job.result;
            if (job.status === 'error') throw new ApiError(job.error || 'Échec', 500);
            onProgress?.(job.progress);
        }
    },
};
