import {api, pins} from './api.js';
import {askPin, toast} from './dom.js';

/*
 * État de l'application : utilisateur, sources, bibliothèque de la source active,
 * favoris et préférences propres à cet appareil (localStorage).
 */

const PREFS_KEY = 'smv_prefs';
const DEFAULT_PREFS = {quality: 'source', mode: 'auto', sourceId: null, volume: 1, muted: false, liveGroup: '__all'};

function loadPrefs() {
    try {
        return {...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')};
    } catch (_) {
        return {...DEFAULT_PREFS};
    }
}

export const prefs = loadPrefs();

export function savePrefs(patch) {
    Object.assign(prefs, patch);
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (_) {
    }
}

export const state = {
    user: null,
    version: '',
    sources: [],
    source: null,
    library: null,
    index: new Map(),
    favorites: new Set(),
    history: [],
};

const listeners = new Set();

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function emit(type) {
    listeners.forEach((fn) => fn(type));
}

export function applyAccent(color) {
    const hex = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#7c5cff';
    const n = Number.parseInt(hex.slice(1), 16);
    document.documentElement.style.setProperty('--accent', hex);
    document.documentElement.style.setProperty('--accent-rgb', `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0a0b10');
}

export async function loadSources() {
    state.sources = await api.sources();
    if (state.source) state.source = state.sources.find((s) => s.id === state.source.id) || null;
    emit('sources');
    return state.sources;
}

// Bibliothèque protégée par PIN : demande le code tant qu'il est faux (3 essais)
async function fetchLibrary(source) {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return await api.library(source.id);
        } catch (err) {
            if (err.status !== 403 || !err.data.pinRequired) throw err;
            if (pins.get(source.id)) {
                pins.clear(source.id);
                toast('PIN incorrect', {type: 'error'});
            }
            if (attempt === 3) throw err;
            const pin = await askPin(source.name);
            if (!pin) throw Object.assign(new Error('PIN requis'), {cancelled: true});
            pins.set(source.id, pin);
        }
    }
    return null;
}

function indexLibrary(library) {
    const index = new Map();
    for (const list of [library.live, library.vod, library.series]) {
        for (const item of list) index.set(item.key, item);
    }
    return index;
}

export async function selectSource(id) {
    const source = state.sources.find((s) => s.id === id);
    if (!source) return false;
    const library = await fetchLibrary(source);
    state.source = source;
    state.library = library;
    state.index = indexLibrary(library);
    state.favorites = new Set(library.favorites || []);
    state.history = library.history || [];
    savePrefs({sourceId: source.id});
    applyAccent(source.color);
    emit('library');
    return true;
}

// Source à ouvrir au démarrage : la dernière utilisée, sinon une source libre,
// sinon une source protégée (le PIN est alors demandé)
export async function selectInitialSource() {
    const others = state.sources.filter((s) => s.id !== prefs.sourceId);
    const candidates = [
        state.sources.find((s) => s.id === prefs.sourceId),
        ...others.filter((s) => !s.locked),
        ...others.filter((s) => s.locked).slice(0, 1),
    ].filter(Boolean);
    for (const source of candidates) {
        try {
            if (await selectSource(source.id)) return true;
        } catch (err) {
            if (!err.cancelled) console.warn(err);
        }
    }
    state.source = null;
    state.library = null;
    emit('library');
    return false;
}

export function isFavorite(key) {
    return state.favorites.has(key);
}

export async function toggleFavorite(key) {
    if (!state.source) return;
    const had = state.favorites.has(key);
    had ? state.favorites.delete(key) : state.favorites.add(key);
    emit('favorites');
    try {
        const res = await api.setFavorites(state.source.id, [...state.favorites]);
        state.favorites = new Set(res.favorites);
    } catch (err) {
        had ? state.favorites.add(key) : state.favorites.delete(key);
        toast(`Favoris non enregistrés : ${err.message}`, {type: 'error'});
    }
    emit('favorites');
}

export function noteHistory(key) {
    state.history = [{key, at: Date.now()}, ...state.history.filter((h) => h.key !== key)].slice(0, 30);
    emit('history');
}

export function item(key) {
    return state.index.get(key) || null;
}
