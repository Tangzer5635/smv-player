const path = require('path');
const {readJsonFile, writeJsonFileSync} = require('./utils');

const DEFAULT_ACCENT = '#6c5ce7';

function normalizeProfile(profile) {
    return {
        ...profile,
        channels: Array.isArray(profile.channels) ? profile.channels : [],
        favoriteChannelIds: Array.isArray(profile.favoriteChannelIds) ? profile.favoriteChannelIds : [],
        history: Array.isArray(profile.history) ? profile.history : [],
        settings: {
            accentColor: profile.settings?.accentColor || DEFAULT_ACCENT,
            pin: profile.settings?.pin || '',
            ...profile.settings,
        },
    };
}

function getProfileItemKeys(item) {
    const id = String(item?.id ?? '');
    const type = String(item?.contentType || item?.type || 'live');
    return [id, `${type}:${id}`];
}

// Le PIN ne quitte jamais le serveur : les clients reçoivent seulement hasPin
function publicSettings(settings = {}) {
    const {pin, ...rest} = settings;
    return {...rest, hasPin: !!pin};
}

function summarize(p) {
    return {
        id: p.id,
        name: p.name,
        type: p.type,
        portalUrl: p.portalUrl || '',
        mac: p.mac || '',
        m3uUrl: p.m3uUrl || '',
        channelCount: (p.channels || []).length,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        settings: publicSettings(p.settings),
    };
}

class ProfileStore {
    constructor(dataDir) {
        this.filePath = path.join(dataDir, 'profiles.json');
        const raw = readJsonFile(this.filePath, []);
        this.profiles = Array.isArray(raw) ? raw.map(normalizeProfile) : [];
        this.saveTimer = null;
    }

    // Écriture différée : l'historique est mis à jour à chaque zapping
    scheduleSave() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.flush(), 300);
    }

    flush() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        try {
            writeJsonFileSync(this.filePath, this.profiles);
            return true;
        } catch (e) {
            console.error('Erreur sauvegarde profils:', e.message);
            return false;
        }
    }

    find(id) {
        return this.profiles.find((p) => p.id === id) || null;
    }

    list() {
        return this.profiles.map(summarize);
    }

    create({name, type, portalUrl, mac, m3uUrl, channels, stalkerSession, favoriteChannelIds}) {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const now = new Date().toISOString();
        const profile = normalizeProfile({
            id,
            name: String(name || 'Profil').trim() || 'Profil',
            type: type === 'm3u' ? 'm3u' : 'stalker',
            portalUrl: portalUrl || '',
            mac: mac || '',
            m3uUrl: m3uUrl || '',
            channels: Array.isArray(channels) ? channels : [],
            favoriteChannelIds: Array.isArray(favoriteChannelIds) ? favoriteChannelIds : [],
            stalkerSession: stalkerSession || null,
            createdAt: now,
            updatedAt: now,
            history: [],
            settings: {accentColor: DEFAULT_ACCENT, pin: ''},
        });
        this.profiles.push(profile);
        this.scheduleSave();
        console.log(`Profil sauvegardé: ${profile.name} (${profile.channels.length} chaînes)`);
        return summarize(profile);
    }

    /**
     * Retourne le profil complet si le PIN est correct.
     * {success:false, pinRequired:true} si un PIN est défini et absent/faux.
     */
    load(id, pin) {
        const profile = this.find(id);
        if (!profile) return {success: false, error: 'Profil introuvable'};
        const expected = profile.settings?.pin || '';
        if (expected && String(pin ?? '') !== expected) {
            return {success: false, pinRequired: true, name: profile.name, error: pin ? 'PIN incorrect' : 'PIN requis'};
        }
        console.log(`Profil chargé: ${profile.name} (${profile.channels.length} chaînes)`);
        return {success: true, profile: {...profile, settings: publicSettings(profile.settings)}};
    }

    update(id, {name, channels, stalkerSession, favoriteChannelIds, history, settings, m3uUrl}) {
        const profile = this.find(id);
        if (!profile) return {success: false, error: 'Profil introuvable'};

        if (typeof name === 'string' && name.trim()) profile.name = name.trim();
        if (typeof m3uUrl === 'string') profile.m3uUrl = m3uUrl;

        if (Array.isArray(channels)) {
            profile.channels = channels;
            if (profile.favoriteChannelIds.length) {
                const availableIds = new Set(channels.flatMap((channel) => getProfileItemKeys(channel)));
                profile.favoriteChannelIds = profile.favoriteChannelIds.filter((favId) => availableIds.has(String(favId)));
            }
        }
        if (stalkerSession) profile.stalkerSession = stalkerSession;
        if (Array.isArray(favoriteChannelIds)) profile.favoriteChannelIds = favoriteChannelIds;
        if (Array.isArray(history)) profile.history = history.slice(0, 50);

        if (settings && typeof settings === 'object') {
            const next = {...profile.settings};
            // Couleur injectée dans un attribut style côté client : format strict
            if (/^#[0-9a-f]{6}$/i.test(settings.accentColor || '')) next.accentColor = settings.accentColor;
            // pin: undefined = inchangé, '' = suppression, sinon nouveau PIN
            if (typeof settings.pin === 'string') next.pin = settings.pin.trim();
            profile.settings = next;
        }

        profile.updatedAt = new Date().toISOString();
        this.scheduleSave();
        return {success: true, profile: summarize(profile)};
    }

    rename(id, name) {
        return this.update(id, {name});
    }

    remove(id) {
        const idx = this.profiles.findIndex((p) => p.id === id);
        if (idx === -1) return {success: false, error: 'Profil introuvable'};
        const [removed] = this.profiles.splice(idx, 1);
        this.scheduleSave();
        console.log(`Profil supprimé: ${removed.name}`);
        return {success: true};
    }
}

module.exports = {ProfileStore};
