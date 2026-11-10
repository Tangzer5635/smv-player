const path = require('path');
const axios = require('axios');
const stalker = require('./stalker');
const {parseM3U} = require('./m3u');
const {axiosNetOptions} = require('./net');
const {hashPassword, checkPassword} = require('./auth');
const {readJsonFile, writeJsonFileSync} = require('./utils');

/*
 * Sources IPTV (portail Stalker ou liste M3U) et leur bibliothèque.
 *
 * Toute la résolution des flux se fait ici, côté serveur : le navigateur ne reçoit
 * jamais la MAC, les jetons du portail ni les URL du fournisseur (identifiants
 * Xtream compris) — seulement des clés d'éléments (« live:123 », « vod:45 »…).
 */

const COLORS = ['#7c5cff', '#00b894', '#e17055', '#0984e3', '#e84393', '#fdcb6e'];
const HISTORY_MAX = 30;
const EPISODE_CACHE_MS = 60 * 60 * 1000;
const EPG_CACHE_MS = 3 * 60 * 1000;
const M3U_LIMIT = 200 * 1024 * 1024;

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function stripPlayerPrefix(cmd) {
    const value = String(cmd || '').trim();
    return /^(ffmpeg|auto|ffrt\d?)\s+/i.test(value) ? value.split(/\s+/).slice(1).join(' ') : value;
}

// Masque les identifiants d'une URL de liste (Xtream : username/password)
function maskUrl(url) {
    try {
        const u = new URL(url);
        if (u.password) u.password = '***';
        for (const key of ['password', 'pass', 'pwd', 'token']) {
            if (u.searchParams.has(key)) u.searchParams.set(key, '***');
        }
        return u.toString().replace(/%2A%2A%2A/g, '***');
    } catch (_) {
        return '';
    }
}

// ── Construction de la bibliothèque ──────────────────────────────────────────
function buildItems({channels = [], vod = [], series = []}) {
    const items = [];
    const seen = new Set();
    const push = (item) => {
        if (seen.has(item.key)) return;
        seen.add(item.key);
        items.push(item);
    };
    channels.forEach((c, i) => push({
        key: `live:${c.id}`,
        id: String(c.id),
        contentType: 'live',
        name: String(c.name || 'Sans nom'),
        number: Number(c.number) || i + 1,
        group: String(c.group || 'Autres'),
        logo: c.logo || '',
        cmd: c.cmd || '',
        ...(c.headers ? {headers: c.headers} : {}),
    }));
    vod.forEach((c) => push({
        key: `vod:${c.id}`,
        id: String(c.id),
        contentType: 'vod',
        name: String(c.name || 'Sans titre'),
        category: String(c.category || 'Films'),
        logo: c.logo || '',
        description: c.description || '',
        year: c.year ? String(c.year) : '',
        rating: c.rating ? String(c.rating) : '',
        cmd: c.cmd || '',
        ...(c.headers ? {headers: c.headers} : {}),
    }));
    series.forEach((c) => push({
        key: `series:${c.id}`,
        id: String(c.id),
        contentType: 'series',
        name: String(c.name || 'Sans titre'),
        category: String(c.category || 'Séries'),
        logo: c.logo || '',
        description: c.description || '',
        year: c.year ? String(c.year) : '',
        rating: c.rating ? String(c.rating) : '',
        seriesId: String(c.seriesId || c.id),
        cmd: c.cmd || '',
    }));
    return items;
}

// Profils de SMV Player 3 (Electron) : « channels » mélangeant live / vod / séries
function migrateLegacyProfile(p) {
    const channels = [];
    const vod = [];
    const series = [];
    for (const item of Array.isArray(p.channels) ? p.channels : []) {
        const type = item.contentType || 'live';
        if (type === 'vod') vod.push(item);
        else if (type === 'series') series.push(item);
        else channels.push(item);
    }
    const items = buildItems({channels, vod, series});
    const keys = new Set(items.map((i) => i.key));
    const toKey = (value) => {
        const raw = String(value);
        if (keys.has(raw)) return raw;
        const found = items.find((i) => i.id === raw);
        return found ? found.key : null;
    };
    return {
        id: p.id || newId(),
        name: p.name || 'Profil',
        type: p.type === 'm3u' ? 'm3u' : 'stalker',
        color: /^#[0-9a-f]{6}$/i.test(p.settings?.accentColor || '') ? p.settings.accentColor : COLORS[0],
        pinHash: null,
        legacyPin: p.settings?.pin || '',
        portalUrl: p.portalUrl || '',
        mac: p.mac || '',
        frenchOnly: true,
        m3uUrl: p.m3uUrl || '',
        stalkerSession: p.stalkerSession || null,
        items,
        favorites: (p.favoriteChannelIds || []).map(toKey).filter(Boolean),
        history: (p.history || [])
            .map((h) => toKey(h.contentType ? `${h.contentType}:${h.id}` : h.id))
            .filter(Boolean)
            .map((key) => ({key, at: Date.now()})),
        status: 'ready',
        error: null,
        createdAt: p.createdAt || new Date().toISOString(),
        updatedAt: p.updatedAt || new Date().toISOString(),
        libraryUpdatedAt: p.updatedAt || null,
    };
}

function publicItem(item) {
    if (item.contentType === 'live') {
        return {key: item.key, name: item.name, number: item.number, group: item.group, logo: item.logo};
    }
    return {
        key: item.key,
        name: item.name,
        category: item.category,
        logo: item.logo,
        year: item.year,
        rating: item.rating,
        description: item.description,
    };
}

// ── Magasin ──────────────────────────────────────────────────────────────────
class SourceStore {
    constructor(dataDir, {settings, jobs}) {
        this.filePath = path.join(dataDir, 'sources.json');
        this.settings = settings;
        this.jobs = jobs;
        this.sources = this.load(dataDir);
        this.saveTimer = null;
        this.episodeCache = new Map();
        this.epgCache = new Map();
        this.runningJobs = new Map();
    }

    load(dataDir) {
        let sources = readJsonFile(this.filePath, null);
        if (!Array.isArray(sources)) {
            const legacy = readJsonFile(path.join(dataDir, 'profiles.json'), []);
            sources = Array.isArray(legacy) ? legacy.map(migrateLegacyProfile) : [];
            if (sources.length) console.log(`Profils SMV Player 3 repris : ${sources.length}`);
        }
        for (const source of sources) {
            if (source.status === 'loading') {
                source.status = source.items?.length ? 'ready' : 'error';
                source.error = source.items?.length ? null : 'Chargement interrompu, relancez l\'actualisation';
            }
        }
        // Anciens PIN en clair : convertis en empreinte au démarrage
        Promise.all(sources.filter((s) => s.legacyPin).map(async (s) => {
            s.pinHash = await hashPassword(s.legacyPin);
            delete s.legacyPin;
        })).then(() => {
            if (sources.length) this.flush();
        });
        return sources;
    }

    scheduleSave() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), 500);
    }

    flush() {
        clearTimeout(this.saveTimer);
        try {
            writeJsonFileSync(this.filePath, this.sources);
        } catch (e) {
            console.error('Erreur sauvegarde des sources:', e.message);
        }
    }

    get(id) {
        return this.sources.find((s) => s.id === id) || null;
    }

    summary(source) {
        const counts = {live: 0, vod: 0, series: 0};
        for (const item of source.items || []) counts[item.contentType] = (counts[item.contentType] || 0) + 1;
        return {
            id: source.id,
            name: source.name,
            type: source.type,
            color: source.color,
            locked: !!source.pinHash || !!source.legacyPin,
            portalUrl: source.type === 'stalker' ? source.portalUrl : '',
            mac: source.type === 'stalker' ? source.mac : '',
            frenchOnly: source.frenchOnly !== false,
            m3uUrl: source.type === 'm3u' ? maskUrl(source.m3uUrl) : '',
            hasM3uUrl: !!source.m3uUrl,
            counts,
            status: source.status || 'ready',
            error: source.error || null,
            jobId: this.runningJobs.get(source.id) || null,
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
            libraryUpdatedAt: source.libraryUpdatedAt || null,
        };
    }

    list() {
        return this.sources.map((s) => this.summary(s));
    }

    async checkPin(source, pin) {
        if (source.legacyPin) return String(pin ?? '') === source.legacyPin;
        if (!source.pinHash) return true;
        return checkPassword(String(pin ?? ''), source.pinHash).catch(() => false);
    }

    validateInput({type, name, portalUrl, mac, m3uUrl}) {
        if (!String(name || '').trim()) throw new Error('Nom requis');
        if (type === 'stalker') {
            if (!String(portalUrl || '').trim()) throw new Error('URL du portail requise');
            if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(String(mac || ''))) throw new Error('Adresse MAC invalide (format 00:1A:79:XX:XX:XX)');
        }
        if (type === 'm3u' && m3uUrl !== undefined && m3uUrl !== '' && !/^https?:\/\//i.test(String(m3uUrl))) {
            throw new Error('URL M3U invalide');
        }
    }

    create(input) {
        const type = input.type === 'm3u' ? 'm3u' : 'stalker';
        const data = {...input, type, name: String(input.name || '').trim()};
        this.validateInput(data);
        if (type === 'm3u' && !data.m3uUrl && !data.m3uContent) throw new Error('URL ou fichier M3U requis');

        const now = new Date().toISOString();
        const source = {
            id: newId(),
            name: data.name.slice(0, 80),
            type,
            color: COLORS[this.sources.length % COLORS.length],
            pinHash: null,
            portalUrl: type === 'stalker' ? String(data.portalUrl).trim() : '',
            mac: type === 'stalker' ? String(data.mac).toUpperCase() : '',
            frenchOnly: data.frenchOnly !== false,
            m3uUrl: type === 'm3u' ? String(data.m3uUrl || '').trim() : '',
            stalkerSession: null,
            items: [],
            favorites: [],
            history: [],
            status: 'loading',
            error: null,
            createdAt: now,
            updatedAt: now,
            libraryUpdatedAt: null,
        };
        this.sources.push(source);

        let job = null;
        if (type === 'm3u' && !source.m3uUrl) {
            this.applyLibrary(source, parseM3U(data.m3uContent), null);
        } else {
            job = this.startLoad(source);
        }
        this.scheduleSave();
        return {source: this.summary(source), job};
    }

    async update(id, patch) {
        const source = this.get(id);
        if (!source) return null;
        if (typeof patch.name === 'string' && patch.name.trim()) source.name = patch.name.trim().slice(0, 80);
        if (/^#[0-9a-f]{6}$/i.test(patch.color || '')) source.color = patch.color;
        if (typeof patch.pin === 'string') {
            const pin = patch.pin.trim();
            if (pin && !/^\d{4,8}$/.test(pin)) throw new Error('Le PIN doit contenir 4 à 8 chiffres');
            source.pinHash = pin ? await hashPassword(pin) : null;
            delete source.legacyPin;
        }
        let reload = false;
        if (source.type === 'stalker') {
            if (typeof patch.portalUrl === 'string' && patch.portalUrl.trim() && patch.portalUrl.trim() !== source.portalUrl) {
                source.portalUrl = patch.portalUrl.trim();
                reload = true;
            }
            if (typeof patch.mac === 'string' && patch.mac.trim() && patch.mac.trim().toUpperCase() !== source.mac) {
                this.validateInput({type: 'stalker', name: source.name, portalUrl: source.portalUrl, mac: patch.mac.trim()});
                source.mac = patch.mac.trim().toUpperCase();
                reload = true;
            }
            if (typeof patch.frenchOnly === 'boolean' && patch.frenchOnly !== (source.frenchOnly !== false)) {
                source.frenchOnly = patch.frenchOnly;
                reload = true;
            }
            if (reload) source.stalkerSession = null;
        }
        if (source.type === 'm3u' && typeof patch.m3uUrl === 'string' && patch.m3uUrl.trim() && !patch.m3uUrl.includes('***')) {
            this.validateInput({type: 'm3u', name: source.name, m3uUrl: patch.m3uUrl.trim()});
            if (patch.m3uUrl.trim() !== source.m3uUrl) {
                source.m3uUrl = patch.m3uUrl.trim();
                reload = true;
            }
        }
        source.updatedAt = new Date().toISOString();
        const job = reload ? this.startLoad(source) : null;
        this.scheduleSave();
        return {source: this.summary(source), job};
    }

    remove(id) {
        const idx = this.sources.findIndex((s) => s.id === id);
        if (idx === -1) return false;
        this.sources.splice(idx, 1);
        this.scheduleSave();
        return true;
    }

    // ── Chargement de la bibliothèque ───────────────────────────────────────
    refresh(id) {
        const source = this.get(id);
        if (!source) return null;
        if (source.type === 'm3u' && !source.m3uUrl) throw new Error('Liste importée depuis un fichier : réimportez-la pour l\'actualiser');
        return this.startLoad(source);
    }

    startLoad(source) {
        const runningId = this.runningJobs.get(source.id);
        const running = runningId && this.jobs.get(runningId);
        if (running && running.status === 'running') return running;

        source.status = 'loading';
        source.error = null;
        const job = this.jobs.start(`Chargement « ${source.name} »`, async (onProgress) => {
            try {
                const {library, session} = await this.fetchLibrary(source, onProgress);
                this.applyLibrary(source, library, session);
                return {sourceId: source.id, counts: this.summary(source).counts};
            } catch (err) {
                source.status = source.items.length ? 'ready' : 'error';
                source.error = err.message;
                this.scheduleSave();
                throw err;
            } finally {
                this.runningJobs.delete(source.id);
            }
        });
        this.runningJobs.set(source.id, job.id);
        return job;
    }

    async fetchLibrary(source, onProgress) {
        const cfg = this.settings.get();
        const timeoutMs = cfg.networkTimeout * 1000;
        if (source.type === 'stalker') {
            const res = await stalker.connect({
                portalUrl: source.portalUrl,
                mac: source.mac,
                userAgent: cfg.userAgent,
                timeoutMs,
                frenchOnly: source.frenchOnly !== false,
            }, onProgress);
            return {
                library: res,
                session: {token: res.token, serverBase: res.serverBase, mac: res.mac, stalkerHeaders: res.stalkerHeaders},
            };
        }
        onProgress({message: 'Téléchargement de la liste…'});
        const response = await axios.get(source.m3uUrl, {
            responseType: 'text',
            timeout: timeoutMs * 2,
            maxContentLength: M3U_LIMIT,
            headers: {'User-Agent': cfg.userAgent},
            transformResponse: (data) => data,
            ...(await axiosNetOptions(source.m3uUrl)),
        });
        onProgress({message: 'Analyse de la liste…'});
        const library = parseM3U(response.data);
        if (!library.channels.length && !library.vod.length) throw new Error('Aucune chaîne trouvée dans la liste');
        return {library, session: null};
    }

    applyLibrary(source, library, session) {
        source.items = buildItems(library);
        if (session) source.stalkerSession = session;
        const keys = new Set(source.items.map((i) => i.key));
        source.favorites = source.favorites.filter((k) => keys.has(k));
        source.history = source.history.filter((h) => keys.has(h.key));
        source.status = 'ready';
        source.error = null;
        source.libraryUpdatedAt = new Date().toISOString();
        source.updatedAt = source.libraryUpdatedAt;
        this.episodeCache.clear();
        this.scheduleSave();
    }

    library(source) {
        const live = [];
        const vod = [];
        const series = [];
        for (const item of source.items) {
            const target = item.contentType === 'live' ? live : item.contentType === 'vod' ? vod : series;
            target.push(publicItem(item));
        }
        return {
            sourceId: source.id,
            live,
            vod,
            series,
            favorites: source.favorites,
            history: source.history,
        };
    }

    setFavorites(source, keys) {
        const valid = new Set(source.items.map((i) => i.key));
        source.favorites = [...new Set((keys || []).map(String))].filter((k) => valid.has(k)).slice(0, 5000);
        this.scheduleSave();
        return source.favorites;
    }

    addHistory(source, key) {
        if (!source.items.some((i) => i.key === key)) return source.history;
        source.history = [{key, at: Date.now()}, ...source.history.filter((h) => h.key !== key)].slice(0, HISTORY_MAX);
        this.scheduleSave();
        return source.history;
    }

    // ── Stalker : session mémorisée ou reconstituée ─────────────────────────
    stalkerSessionFor(source) {
        return source.stalkerSession
            || stalker.defaultSession({portalUrl: source.portalUrl, mac: source.mac, userAgent: this.settings.get().userAgent});
    }

    rememberToken(source, token) {
        if (token && source.stalkerSession && token !== source.stalkerSession.token) {
            source.stalkerSession.token = token;
            this.scheduleSave();
        }
    }

    // ── Séries ──────────────────────────────────────────────────────────────
    async episodes(source, seriesKey) {
        const series = source.items.find((i) => i.key === seriesKey && i.contentType === 'series');
        if (!series) throw new Error('Série introuvable');
        const cacheKey = `${source.id}|${seriesKey}`;
        const cached = this.episodeCache.get(cacheKey);
        if (cached && Date.now() - cached.at < EPISODE_CACHE_MS) return cached.episodes;

        const session = this.stalkerSessionFor(source);
        const res = await stalker.seriesEpisodes({
            serverBase: session.serverBase,
            mac: session.mac,
            token: session.token,
            seriesId: series.seriesId,
            stalkerHeadersJson: session.stalkerHeaders,
            userAgent: this.settings.get().userAgent,
        });
        this.rememberToken(source, res.token);
        const episodes = res.episodes.map((e) => ({
            ...e,
            key: `ep:${encodeURIComponent(series.id)}:${encodeURIComponent(e.id)}`,
            cmd: e.cmd || series.cmd,
            logo: e.logo || series.logo,
        }));
        this.episodeCache.set(cacheKey, {episodes, at: Date.now()});
        return episodes;
    }

    publicEpisodes(episodes) {
        return episodes.map(({key, title, season, episode, logo}) => ({key, title, season, episode, logo}));
    }

    // ── Lecture : élément → URL amont + en-têtes ────────────────────────────
    async findPlayable(source, key) {
        if (key.startsWith('ep:')) {
            const seriesId = decodeURIComponent(key.split(':')[1] || '');
            const seriesKey = `series:${seriesId}`;
            const episodes = await this.episodes(source, seriesKey);
            const episode = episodes.find((e) => e.key === key);
            if (!episode) throw new Error('Épisode introuvable');
            const series = source.items.find((i) => i.key === seriesKey);
            return {
                ...episode,
                contentType: 'series',
                name: `${series?.name || 'Série'} — ${episode.season ? `S${episode.season} ` : ''}E${episode.episode}`,
            };
        }
        const item = source.items.find((i) => i.key === key);
        if (!item) throw new Error('Élément introuvable dans la bibliothèque');
        if (item.contentType === 'series') throw new Error('Choisissez un épisode');
        return item;
    }

    async resolveStream(source, key) {
        const item = await this.findPlayable(source, key);
        const cfg = this.settings.get();
        const isStalker = source.type === 'stalker';
        const cmd = String(item.cmd || '');

        if (isStalker && cmd && !cmd.startsWith('http')) {
            const session = this.stalkerSessionFor(source);
            const res = await stalker.getStream({
                serverBase: session.serverBase,
                mac: session.mac,
                token: session.token,
                cmd,
                stalkerHeadersJson: session.stalkerHeaders,
                contentType: item.contentType,
                seriesIndex: item.seriesIndex,
                episodeId: item.episodeId,
                containerExtension: item.containerExtension,
                userAgent: cfg.userAgent,
            });
            if (!res.success) throw new Error(res.error || 'Impossible de créer le lien');
            this.rememberToken(source, res.token);
            return {item, url: res.url, fallbackUrls: res.fallbackUrls || [], headers: res.headers || {}};
        }

        const url = stripPlayerPrefix(cmd);
        if (!/^https?:\/\//i.test(url)) throw new Error('URL du flux invalide');
        let headers = item.headers || {};
        if (isStalker && !item.headers) {
            try {
                headers = JSON.parse(this.stalkerSessionFor(source).stalkerHeaders || '{}');
            } catch (_) {
                headers = {};
            }
        }
        return {item, url, headers};
    }

    // ── Guide des programmes (Stalker) ──────────────────────────────────────
    async epg(source, key) {
        const item = source.items.find((i) => i.key === key && i.contentType === 'live');
        if (!item || source.type !== 'stalker') return [];
        const cacheKey = `${source.id}|${key}`;
        const cached = this.epgCache.get(cacheKey);
        if (cached && Date.now() - cached.at < EPG_CACHE_MS) return cached.programmes;
        const session = this.stalkerSessionFor(source);
        let programmes = [];
        try {
            programmes = await stalker.shortEpg({
                serverBase: session.serverBase,
                mac: session.mac,
                token: session.token,
                stalkerHeadersJson: session.stalkerHeaders,
                userAgent: this.settings.get().userAgent,
                channelId: item.id,
            });
        } catch (err) {
            console.warn(`EPG indisponible (${item.name}):`, err.message);
        }
        this.epgCache.set(cacheKey, {programmes, at: Date.now()});
        if (this.epgCache.size > 500) this.epgCache.delete(this.epgCache.keys().next().value);
        return programmes;
    }
}

module.exports = {SourceStore, buildItems, migrateLegacyProfile, maskUrl, stripPlayerPrefix};
