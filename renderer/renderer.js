// ── État global ───────────────────────────────────────────────────────────────
const state = {
    channels: [],
    filtered: [],
    currentChannel: null,
    currentGroup: 'all',
    currentMode: 'live',
    seriesEpisodes: [],
    seriesStack: [],
    favoriteChannelIds: [],
    stalkerSession: null,
    config: {},
    retryCount: 0,
    player: null,
    hls: null,
    currentProfileId: null,
    renameProfileId: null,
    saveContext: null,
    categoriesCollapsed: false,
    isSeekDragging: false,
    epg: {},
};

const $ = (id) => document.getElementById(id);
const video = $('video');
const placeholder = $('placeholder');
const loadingOverlay = $('loading-overlay');
const errorOverlay = $('error-overlay');
const channelList = $('channel-list');
const groupBar = $('group-bar');
const modeLiveBtn = $('btn-mode-live');
const modeVodBtn = $('btn-mode-vod');
const modeSeriesBtn = $('btn-mode-series');
const seriesBackBtn = $('btn-series-back');
const searchInp = $('search');
const connInfo = $('conn-info');
const connLabel = $('conn-label');
const connCount = $('conn-count');
const nowName = $('now-name');
const nowGroup = $('now-group');
const liveDot = $('live-dot');
const streamInfo = $('stream-info');
const siUrl = $('si-url');
const siUa = $('si-ua');
const videoControls = $('video-controls');
const renameProfileModal = $('rename-profile-modal');
const progressWrap = $('vc-progress-wrap');
const seekBar = $('vc-seek');
const currentTimeEl = $('vc-current-time');
const durationEl = $('vc-duration');
const accentInput = document.getElementById("cfg-accent");
const welcomeProfilesGrid = document.getElementById("welcome-profiles-grid");
const welcomeProfilesCount = document.getElementById("welcome-profiles-count");
const btnEnterApp = document.getElementById("btn-enter-app");
const welcomeScreen = document.getElementById("welcome-screen");
const btnSettings = document.getElementById("btn-settings");
const settingsModal = document.getElementById("settings-modal");
const closeSettingsBtn = document.getElementById("close-settings");

function openSettings() {
    settingsModal?.classList.remove("hidden");
    document.body.classList.add("settings-open");
}

function closeSettings() {
    settingsModal?.classList.add("hidden");
    document.body.classList.remove("settings-open");
}

function toggleSettings() {
    if (!settingsModal) return;

    const isHidden = settingsModal.classList.contains("hidden");
    if (isHidden) {
        openSettings();
    } else {
        closeSettings();
    }
}

btnSettings?.addEventListener("click", toggleSettings);
closeSettingsBtn?.addEventListener("click", closeSettings);

settingsModal?.addEventListener("click", (e) => {
    if (e.target === settingsModal) {
        closeSettings();
    }
});

btnEnterApp?.addEventListener("click", () => {
    welcomeScreen?.classList.add("hidden");
});

function getSavedProfiles() {
    return JSON.parse(localStorage.getItem('smv_profiles') || '[]');
}

function renderWelcomeProfiles() {
    if (!welcomeProfilesGrid || !welcomeProfilesCount) return;

    const profiles = getSavedProfiles();
    welcomeProfilesCount.textContent = String(profiles.length);

    if (!profiles.length) {
        welcomeProfilesGrid.innerHTML = `
            <div class="welcome-empty">
                Aucun profil enregistré
            </div>
        `;
        return;
    }

    welcomeProfilesGrid.innerHTML = profiles.map((profile, index) => {
        const name = escHtml(profile.name || `Profil ${index + 1}`);
        const url = escHtml(profile.portalUrl || profile.portal || profile.url || 'Portail non défini');
        const mac = escHtml(profile.mac || 'MAC non définie');

        return `
            <button class="welcome-profile-card" data-profile-id="${profile.id}" type="button">
                <div class="welcome-profile-top">
                    <div class="welcome-profile-icon">📁</div>
                    <div class="welcome-profile-badge">Profil</div>
                </div>

                <div class="welcome-profile-name">${name}</div>
                <div class="welcome-profile-meta">${url}</div>
                <div class="welcome-profile-submeta">${mac}</div>
                <div class="welcome-profile-open">Ouvrir ce profil →</div>
            </button>
        `;
    }).join('');

    welcomeProfilesGrid.querySelectorAll('.welcome-profile-card').forEach((card) => {
        card.addEventListener('click', async () => {
            const profileId = card.dataset.profileId;
            const profile = getSavedProfiles().find((p) => String(p.id) === String(profileId));
            if (!profile) return;

            welcomeScreen?.classList.add('hidden');

            try {
                await loadProfile(profile.id);
            } catch (err) {
                console.error(err);
                toast("Impossible de charger le profil");
            }
        });
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    renderWelcomeProfiles();

    const lastProfileId = localStorage.getItem("lastProfileId");

    if (lastProfileId) {
        try {
            await loadProfile(lastProfileId);
            welcomeScreen?.classList.add("hidden");
        } catch (e) {
            console.log("Auto load profil failed");
        }
    }
});

async function loadEPG() {
    if (!state.stalkerSession) return;

    try {
        const res = await window.electronAPI.stalkerGetEPG({
            serverBase: state.stalkerSession.serverBase,
            mac: state.stalkerSession.mac,
            token: state.stalkerSession.token,
        });

        if (!res.success) return;

        state.epg = res.epg || {};
    } catch (e) {
        console.error("EPG error", e);
    }
}

function hexToRgb(hex) {
    const clean = hex.replace("#", "");
    const bigint = parseInt(clean, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `${r}, ${g}, ${b}`;
}

function lightenColor(hex, percent) {
    const num = parseInt(hex.replace("#", ""), 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const G = ((num >> 8) & 0x00ff) + amt;
    const B = (num & 0x0000ff) + amt;

    return (
        "#" +
        (
            0x1000000 +
            (R < 255 ? (R < 1 ? 0 : R) : 255) * 0x10000 +
            (G < 255 ? (G < 1 ? 0 : G) : 255) * 0x100 +
            (B < 255 ? (B < 1 ? 0 : B) : 255)
        )
            .toString(16)
            .slice(1)
    );
}

function applyAccentColor(color) {
    document.documentElement.style.setProperty("--accent", color);
    document.documentElement.style.setProperty("--accent2", lightenColor(color, 30));
    document.documentElement.style.setProperty("--accent-rgb", hexToRgb(color));
}

const savedColor = localStorage.getItem("accentColor");
if (savedColor) {
    applyAccentColor(savedColor);
    if (accentInput) accentInput.value = savedColor;
}

accentInput?.addEventListener("input", (e) => {
    applyAccentColor(e.target.value);
});

document.getElementById("save-settings")?.addEventListener("click", () => {
    const color = accentInput?.value || "#6c5ce7";
    applyAccentColor(color);
    localStorage.setItem("accentColor", color);
});

// Changement en direct
accentInput.addEventListener("input", (e) => {
    const color = e.target.value;
    document.documentElement.style.setProperty("--accent", color);
    document.documentElement.style.setProperty("--accent2", lightenColor(color, 30));
});

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function toast(msg, dur = 3000) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), dur);
}

function getChannelKey(channel) {
    const id = String(channel?.id ?? '');
    const type = String(channel?.contentType || 'live');
    return `${type}:${id}`;
}

function getChannelLegacyKey(channel) {
    return String(channel?.id ?? '');
}

function isFavorite(channel) {
    const key = getChannelKey(channel);
    const legacyKey = getChannelLegacyKey(channel);
    return state.favoriteChannelIds.includes(key) || state.favoriteChannelIds.includes(legacyKey);
}

function buildLibraryItems(live = [], vod = [], series = []) {
    const liveItems = live.map((item, index) => ({
        ...item,
        contentType: 'live',
        number: item.number || index + 1,
        group: item.group || 'Live',
    }));

    const vodItems = vod.map((item) => ({
        ...item,
        contentType: 'vod',
        number: '',
        group: `VOD • ${item.category || 'Films'}`,
    }));

    const seriesItems = series.map((item) => ({
        ...item,
        contentType: 'series',
        number: '',
        group: `SERIES • ${item.category || 'Series'}`,
        isSeries: item.isSeries ?? true,
        seriesId: item.seriesId || item.id,
    }));

    return [...liveItems, ...vodItems, ...seriesItems];
}

function toIntOrNull(value) {
    const num = Number.parseInt(value, 10);
    return Number.isFinite(num) ? num : null;
}

function getEpisodeLabel(item, fallbackIndex = 0) {
    const season = toIntOrNull(item.season_num ?? item.season_number ?? item.season ?? item.season_id);
    const episode = toIntOrNull(
        item.episode_num ?? item.episode_number ?? item.series_number ?? item.series ?? item.number ?? item.sort_num
    ) ?? fallbackIndex + 1;
    const title = item.name || item.title || item.episode_name || `Episode ${episode}`;

    if (season) {
        return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} - ${title}`;
    }
    return `E${String(episode).padStart(2, '0')} - ${title}`;
}

function getEpisodeMeta(item, seriesItem) {
    const season = toIntOrNull(item.season_num ?? item.season_number ?? item.season ?? item.season_id);
    const episode = toIntOrNull(
        item.episode_num ?? item.episode_number ?? item.series_number ?? item.series ?? item.number ?? item.sort_num
    );
    const parts = [];
    if (season) parts.push(`Saison ${season}`);
    if (episode) parts.push(`Episode ${episode}`);
    parts.push(seriesItem.name || 'Series');
    return parts.join(' • ');
}

function getProfileDisplayCount(items) {
    return `${items.length} elements`;
}

async function reloadProfileLibrary(profile) {
    if (profile.type !== 'stalker' || !profile.portalUrl || !profile.mac) return null;

    const res = await window.electronAPI.stalkerConnect({
        portalUrl: profile.portalUrl,
        mac: profile.mac,
    });

    if (!res.success) {
        throw new Error(res.error || 'Recharge du profil impossible');
    }

    const session = {
        token: res.token,
        serverBase: res.serverBase,
        mac: res.mac,
        stalkerHeaders: res.stalkerHeaders,
    };

    const libraryItems = buildLibraryItems(res.channels, res.vod, res.series);

    await window.electronAPI.profileUpdate({
        id: profile.id,
        channels: libraryItems,
        stalkerSession: session,
        favoriteChannelIds: state.favoriteChannelIds,
    });

    return {session, items: libraryItems};
}

function updateFavoritesChip() {
    const countNode = document.querySelector('.g-chip[data-group="favorites"] .g-count');
    if (countNode) {
        countNode.textContent = String(state.channels.filter((channel) => isFavorite(channel)).length);
    }
}

function openRenameProfileModal(profileId, currentName) {
    state.renameProfileId = profileId;
    $('rename-profile-input').value = currentName || '';
    renameProfileModal.classList.remove('hidden');
    $('rename-profile-input').focus();
    $('rename-profile-input').select();
}

function closeRenameProfileModal() {
    state.renameProfileId = null;
    $('rename-profile-input').value = '';
    renameProfileModal.classList.add('hidden');
}

async function persistFavorites() {
    if (!state.currentProfileId) return false;
    const result = await window.electronAPI.profileUpdate({
        id: state.currentProfileId,
        favoriteChannelIds: state.favoriteChannelIds,
    });
    return result?.success === true;
}

async function toggleFavorite(channel) {
    const channelId = getChannelKey(channel);
    const legacyChannelId = getChannelLegacyKey(channel);
    if (!channelId) return;

    if (isFavorite(channel)) {
        state.favoriteChannelIds = state.favoriteChannelIds.filter((id) => id !== channelId && id !== legacyChannelId);
    } else {
        state.favoriteChannelIds = [...state.favoriteChannelIds, channelId];
    }

    updateFavoritesChip();
    filterAndRender();

    if (!state.currentProfileId) {
        toast('⭐ Favori local. Sauvegardez le profil pour le conserver.');
        return;
    }

    const saved = await persistFavorites();
    if (!saved) toast('❌ Impossible de sauvegarder les favoris');
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
    state.config = await window.electronAPI.getConfig();
    $('cfg-ua').value = state.config.userAgent || '';
    $('cfg-timeout').value = state.config.networkTimeout || 60;
    $('cfg-referrer').value = state.config.referrer || '';
    $('cfg-headers').value = state.config.headerFields || '';
    $('cfg-vlc').value = state.config.vlcPath || '';
    siUa.textContent = state.config.userAgent || '';
    await refreshProfilesList();
})();

// ── Window controls ───────────────────────────────────────────────────────────
$('btn-minimize').onclick = () => window.electronAPI.windowMinimize();
$('btn-maximize').onclick = () => window.electronAPI.windowMaximize();
$('btn-close').onclick = () => window.electronAPI.windowClose();

function updateMaximizeButton(isMaximized) {
    const btn = $('btn-maximize');
    btn.textContent = isMaximized ? '❐' : '☐';
    btn.title = isMaximized ? 'Restaurer' : 'Agrandir';
}

window.electronAPI.onWindowStateChanged(({isMaximized}) => {
    updateMaximizeButton(Boolean(isMaximized));
});

$('btn-minimize').onclick = () => window.electronAPI.windowMinimize();
$('btn-maximize').onclick = () => window.electronAPI.windowMaximize();
$('btn-close').onclick = () => window.electronAPI.windowClose();

const titlebar = document.querySelector('.titlebar');
if (titlebar) {
    titlebar.addEventListener('dblclick', (event) => {
        if (event.target.closest('.titlebar-right')) return;
        window.electronAPI.windowMaximize();
    });
}

// ── Settings ──────────────────────────────────────────────────────────────────
$('save-settings').onclick = async () => {
    const color = accentInput.value;
    localStorage.setItem("accentColor", color);
    const cfg = {
        userAgent: $('cfg-ua').value.trim(),
        networkTimeout: parseInt($('cfg-timeout').value) || 60,
        referrer: $('cfg-referrer').value.trim(),
        headerFields: $('cfg-headers').value.trim(),
        vlcPath: $('cfg-vlc').value.trim(),
    };
    state.config = await window.electronAPI.updateConfig(cfg);
    siUa.textContent = cfg.userAgent;
    closeSettings();
    toast('✅ Paramètres sauvegardés');
};

$('btn-browse-vlc').onclick = async () => {
    const res = await window.electronAPI.browseVlcPath();
    if (!res?.success) return;
    $('cfg-vlc').value = res.path;
    const cfg = {
        userAgent: $('cfg-ua').value.trim(),
        networkTimeout: parseInt($('cfg-timeout').value) || 60,
        referrer: $('cfg-referrer').value.trim(),
        headerFields: $('cfg-headers').value.trim(),
        vlcPath: res.path,
    };
    state.config = await window.electronAPI.updateConfig(cfg);
    toast('✅ Chemin VLC sauvegardé');
};

// ── Tabs source ───────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((btn) => {
    btn.onclick = () => {
        document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('hidden'));
        btn.classList.add('active');
        $(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    };
});

// ── MAC auto-format ───────────────────────────────────────────────────────────
$('portal-mac').addEventListener('input', function () {
    let v = this.value.toUpperCase().replace(/[^0-9A-F]/g, '');
    v = v.match(/.{1,2}/g)?.join(':') || v;
    this.value = v.slice(0, 17);
});

// ── Catégories toggle ─────────────────────────────────────────────────────────
$('btn-toggle-cats').onclick = () => {
    state.categoriesCollapsed = !state.categoriesCollapsed;
    groupBar.classList.toggle('collapsed', state.categoriesCollapsed);
    $('btn-toggle-cats').textContent = state.categoriesCollapsed ? '▶' : '▼';
};

function setMode(mode) {
    state.currentMode = mode;
    modeLiveBtn.classList.toggle('active', mode === 'live');
    modeVodBtn.classList.toggle('active', mode === 'vod');
    modeSeriesBtn.classList.toggle('active', mode === 'series');
    seriesBackBtn.classList.toggle('hidden', mode !== 'series-episodes');
    filterAndRender();
}

modeLiveBtn.onclick = () => {
    state.seriesEpisodes = [];
    state.seriesStack = [];
    setMode('live');
};

modeVodBtn.onclick = () => {
    state.seriesEpisodes = [];
    state.seriesStack = [];
    setMode('vod');
};

modeSeriesBtn.onclick = () => {
    state.seriesEpisodes = [];
    state.seriesStack = [];
    setMode('series');
};

seriesBackBtn.onclick = () => {
    const prev = state.seriesStack.pop();
    if (prev) {
        state.seriesEpisodes = prev;
    } else {
        state.seriesEpisodes = [];
    }
    setMode('series');
};

// ══════════════════════════════════════════════════════════════════════════════
//  PROFILS
// ══════════════════════════════════════════════════════════════════════════════

async function refreshProfilesList() {
    const profiles = await window.electronAPI.profilesList();
    const container = $('profiles-list');

    if (!profiles.length) {
        container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📁</div>
        <p>Aucun profil sauvegardé</p>
        <p style="font-size:11px;margin-top:4px;color:#666">Connectez-vous puis cliquez sur 💾 Sauver</p>
      </div>`;
        return;
    }

    const frag = document.createDocumentFragment();

    profiles.forEach((p) => {
        const item = document.createElement('div');
        item.className = `profile-item${state.currentProfileId === p.id ? ' playing' : ''}`;

        const icon = p.type === 'stalker' ? '🔗' : '📄';
        const meta = p.type === 'stalker' ? `${p.portalUrl} · ${p.mac}` : 'Fichier M3U';
        const date = new Date(p.updatedAt || p.createdAt);
        const dateStr = date.toLocaleDateString('fr-FR', {day: '2-digit', month: '2-digit', year: '2-digit'});

        item.innerHTML = `
      <div class="profile-icon">${icon}</div>
      <div class="profile-info">
        <div class="profile-name">${escHtml(p.name)}</div>
        <div class="profile-meta">${p.channelCount} chaînes · ${dateStr}</div>
        <div class="profile-meta">${escHtml(meta)}</div>
      </div>
      <div class="profile-actions">
        <button class="btn-tiny" title="Renommer" data-action="edit" data-id="${p.id}">✏️</button>
        <button class="btn-tiny" title="Rafraîchir" data-action="refresh" data-id="${p.id}" data-type="${p.type}">🔄</button>
        <button class="btn-tiny danger" title="Supprimer" data-action="delete" data-id="${p.id}">🗑️</button>
      </div>`;

        item.addEventListener('click', (e) => {
            if (e.target.closest('.profile-actions')) return;
            loadProfile(p.id);
        });

        frag.appendChild(item);
    });

    container.innerHTML = '';
    container.appendChild(frag);

    container.querySelectorAll('[data-action]').forEach((btn) => {
        btn.onclick = async (e) => {
            e.stopPropagation();

            const action = btn.dataset.action;
            const id = btn.dataset.id;

            const result = await window.electronAPI.profileLoad(id);
            if (!result?.success) return;

            const profile = result.profile;

            if (action === 'edit') {
                openEditProfileModal(profile);
                return;
            }

            if (action === 'delete') {
                if (!confirm('Supprimer ce profil ?')) return;

                await window.electronAPI.profileDelete(id);

                if (state.currentProfileId === id) {
                    state.currentProfileId = null;
                    state.channels = [];
                    channelList.innerHTML = '<div class="empty">Chargez un profil</div>';
                }

                await refreshProfilesList();
                toast('🗑️ Profil supprimé');
            }

            if (action === 'refresh') {
                await refreshProfile(id, profile.type);
            }
        };
    });
}

async function loadProfile(profileId) {
    const result = await window.electronAPI.profileLoad(profileId);

    if (!result?.success) {
        throw new Error("Profil introuvable");
    }

    const profile = result.profile;

    state.currentProfileId = profile.id;
    localStorage.setItem("lastProfileId", profile.id);
    state.favoriteChannelIds = (profile.favoriteChannelIds || []).map(String);

    $('portal-url').value = profile.portalUrl || '';
    $('portal-mac').value = profile.mac || '';

    const CACHE_DURATION = 1000 * 60 * 60; // 1h

    const isCacheValid =
        profile.channels &&
        profile.channels.length > 0 &&
        (Date.now() - new Date(profile.updatedAt).getTime() < CACHE_DURATION);

    if (isCacheValid) {
        state.stalkerSession = profile.stalkerSession || null;

        loadChannels(profile.channels);
        connInfo.classList.remove('hidden');
        connLabel.textContent = `📁 ${profile.name} (cache)`;
        connCount.textContent = profile.channels.length;

        toast(`⚡ Chargement instantané`);
        return;
    }

    // 🔥 2. SINON → vraie connexion
    else if (profile.type === 'stalker' && profile.portalUrl && profile.mac) {
        toast("⏳ Connexion au portail...");

        const res = await window.electronAPI.stalkerConnect({
            portalUrl: profile.portalUrl,
            mac: profile.mac,
        });

        if (!res.success) {
            throw new Error(res.error || "Connexion impossible");
        }

        state.stalkerSession = {
            token: res.token,
            serverBase: res.serverBase,
            mac: res.mac,
            stalkerHeaders: res.stalkerHeaders,
        };

        const items = buildLibraryItems(res.channels, res.vod, res.series);

        loadChannels(items);
        await loadEPG();

        connInfo.classList.remove('hidden');
        connLabel.textContent = `📁 ${profile.name}`;
        connCount.textContent = items.length;

        toast(`✅ Profil chargé (${items.length} éléments)`);
    }

    await refreshProfilesList();
}

function renderProfiles() {
    const list = document.getElementById("profiles-list");
    if (!list) return;

    const profiles = getSavedProfiles();

    list.innerHTML = profiles.map(p => `
        <div class="profile-item ${p.id === state.currentProfileId ? 'playing' : ''}"
             onclick="loadProfile('${p.id}')">
            <div class="profile-name">${p.name || 'Profil'}</div>
            <div class="profile-meta">${p.portalUrl || p.portal}</div>
        </div>
    `).join('');
}

async function refreshProfile(profileId, type) {
    const result = await window.electronAPI.profileLoad(profileId);
    if (!result.success) return toast('❌ Profil introuvable');

    const profile = result.profile;
    const profileFavoriteIds = (profile.favoriteChannelIds || []).map(String);

    if (type === 'stalker' && profile.portalUrl && profile.mac) {
        toast('🔄 Rafraîchissement du profil en cours...');
        state.favoriteChannelIds = profileFavoriteIds;

        const refreshed = await reloadProfileLibrary(profile).catch((error) => ({error}));
        if (refreshed?.error) return toast(`âŒ ${refreshed.error.message}`);

        state.stalkerSession = refreshed.session;
        state.currentProfileId = profileId;
        state.favoriteChannelIds = profileFavoriteIds;
        loadChannels(refreshed.items);
        connInfo.classList.remove('hidden');
        connLabel.textContent = `📁 ${profile.name}`;
        connCount.textContent = refreshed.items.length;
        toast(`✅ Cache mis à jour: ${getProfileDisplayCount(refreshed.items)}`);
    } else {
        toast('ℹ️ Rechargez le fichier M3U manuellement');
    }

    await refreshProfilesList();
}

// ══════════════════════════════════════════════════════════════════════════════
//  CONNEXION STALKER
// ══════════════════════════════════════════════════════════════════════════════

$('btn-connect').onclick = async () => {
    const portalUrl = $('portal-url').value.trim();
    const mac = $('portal-mac').value.trim();

    if (!portalUrl || !mac) return toast('⚠️ URL et MAC requis');
    if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)) return toast('⚠️ Format MAC invalide');

    const btn = $('btn-connect');
    btn.disabled = true;
    btn.textContent = '⏳ Connexion...';

    try {
        const res = await window.electronAPI.stalkerConnect({portalUrl, mac});

        if (!res.success) {
            toast(`❌ ${res.error}`);
            return;
        }

        state.stalkerSession = {
            token: res.token,
            serverBase: res.serverBase,
            mac: res.mac,
            stalkerHeaders: res.stalkerHeaders,
        };
        state.currentProfileId = null;
        state.favoriteChannelIds = [];

        const libraryItems = buildLibraryItems(res.channels, res.vod, res.series);
        loadChannels(libraryItems);

        connInfo.classList.remove('hidden');
        connLabel.textContent = '✅ Connecté';
        connCount.textContent = libraryItems.length;
        $('btn-save-profile').classList.remove('hidden');
        state.saveContext = 'stalker';
        toast(`✅ ${res.channels.length} chaînes chargées`);
    } catch (err) {
        toast(`❌ ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = '🔗 Connexion';
    }
};

// ── Sauver profil ─────────────────────────────────────────────────────────────
$('btn-save-profile').onclick = () => {
    state.saveContext = 'stalker';
    $('profile-name-input').value = '';
    $('save-profile-modal').classList.remove('hidden');
    $('profile-name-input').focus();
};

$('close-save-profile').onclick = () => $('save-profile-modal').classList.add('hidden');
$('close-rename-profile').onclick = () => closeRenameProfileModal();

$('confirm-save-profile').onclick = async () => {
    const name = $('profile-name-input').value.trim();
    if (!name) return toast('⚠️ Nom requis');

    const data = {
        name,
        channels: state.channels,
        favoriteChannelIds: state.favoriteChannelIds,
    };

    if (state.saveContext === 'stalker') {
        data.type = 'stalker';
        data.portalUrl = $('portal-url').value.trim();
        data.mac = $('portal-mac').value.trim();
        data.stalkerSession = state.stalkerSession;
    } else {
        data.type = 'stalker';
        data.portalUrl = '';
        data.mac = '';
    }

    const result = await window.electronAPI.profileSave(data);
    state.currentProfileId = result.id;
    $('save-profile-modal').classList.add('hidden');
    await refreshProfilesList();
    toast(`💾 Profil "${name}" sauvegardé (${state.channels.length} chaînes)`);
};

$('confirm-edit-profile').onclick = async () => {
    const id = state.renameProfileId;

    const name = $('edit-name').value.trim();
    const portalUrl = $('edit-url').value.trim();
    const mac = $('edit-mac').value.trim();

    if (!name) return toast("Nom requis");

    await window.electronAPI.profileUpdate({
        id,
        name,
        portalUrl,
        mac
    });

    $('edit-profile-modal').classList.add('hidden');

    await refreshProfilesList();

    toast("✅ Profil modifié");
};
// ══════════════════════════════════════════════════════════════════════════════
//  CHANNELS
// ══════════════════════════════════════════════════════════════════════════════

function loadChannels(channels) {
    state.channels = channels;
    state.currentGroup = 'all';
    state.currentMode = 'live';
    state.seriesEpisodes = [];
    state.seriesStack = [];
    const availableIds = new Set(
        channels.flatMap((channel) => [getChannelKey(channel), getChannelLegacyKey(channel)])
    );
    state.favoriteChannelIds = state.favoriteChannelIds.filter((id) => availableIds.has(id));

    const liveItems = channels.filter((c) => c.contentType !== 'vod' && c.contentType !== 'series');
    const groups = [...new Set(liveItems.map((c) => c.group))].sort();
    const favoritesCount = channels.filter((channel) => isFavorite(channel)).length;

    groupBar.innerHTML = '';
    groupBar.classList.remove('collapsed');
    state.categoriesCollapsed = false;
    $('btn-toggle-cats').textContent = '▼';

    const allChip = document.createElement('button');
    allChip.className = 'g-chip active';
    allChip.innerHTML = `<span>📺 Tous</span><span class="g-count">${channels.length}</span>`;
    allChip.onclick = () => selectGroup('all');
    groupBar.appendChild(allChip);

    const favoritesChip = document.createElement('button');
    favoritesChip.className = 'g-chip';
    favoritesChip.dataset.group = 'favorites';
    favoritesChip.innerHTML = `<span>⭐ Favoris</span><span class="g-count">${favoritesCount}</span>`;
    favoritesChip.onclick = () => selectGroup('favorites');
    groupBar.appendChild(favoritesChip);

    groups.forEach((g) => {
        const count = liveItems.filter((c) => c.group === g).length;
        const chip = document.createElement('button');
        chip.className = 'g-chip';
        chip.dataset.group = g;
        chip.innerHTML = `<span>${escHtml(g)}</span><span class="g-count">${count}</span>`;
        chip.onclick = () => selectGroup(g);
        groupBar.appendChild(chip);
    });

    searchInp.value = '';
    $('btn-clear-search').classList.remove('visible');
    modeLiveBtn.classList.add('active');
    modeVodBtn.classList.remove('active');
    modeSeriesBtn.classList.remove('active');
    seriesBackBtn.classList.add('hidden');
    filterAndRender();
    const lastChannelId = localStorage.getItem("lastChannelId");

    if (lastChannelId) {
        const found = channels.find(c => getChannelKey(c) === lastChannelId);
        if (found) {
            setTimeout(() => playChannel(found), 500);
        }
    }
}

function selectGroup(group) {
    state.currentGroup = group;
    state.currentMode = group === 'favorites' ? 'favorites' : 'live';
    document.querySelectorAll('.g-chip').forEach((c) => {
        const isAll = !c.dataset.group;
        if (group === 'all') {
            c.classList.toggle('active', isAll);
        } else {
            c.classList.toggle('active', c.dataset.group === group);
        }
    });
    modeLiveBtn.classList.toggle('active', state.currentMode === 'live');
    modeVodBtn.classList.remove('active');
    modeSeriesBtn.classList.remove('active');
    filterAndRender();
}

// ── Recherche ─────────────────────────────────────────────────────────────────
searchInp.addEventListener('input', () => {
    $('btn-clear-search').classList.toggle('visible', searchInp.value.length > 0);
    filterAndRender();
});

$('btn-clear-search').onclick = () => {
    searchInp.value = '';
    $('btn-clear-search').classList.remove('visible');
    filterAndRender();
    searchInp.focus();
};

function filterAndRender() {
    const query = searchInp.value.toLowerCase().trim();
    let list = state.channels;

    if (state.currentMode === 'favorites') {
        list = list.filter((channel) => isFavorite(channel));
    } else if (state.currentMode === 'live') {
        list = list.filter((c) => c.contentType !== 'vod' && c.contentType !== 'series');
        if (state.currentGroup !== 'all') {
            list = list.filter((c) => c.group === state.currentGroup);
        }
    } else if (state.currentMode === 'vod') {
        list = list.filter((c) => c.contentType === 'vod');
    } else if (state.currentMode === 'series') {
        list = list.filter((c) => c.contentType === 'series' && c.isSeries);
    } else if (state.currentMode === 'series-episodes') {
        list = state.seriesEpisodes;
    }

    if (query) {
        list = list.filter(
            (c) =>
                c.name.toLowerCase().includes(query) ||
                c.group.toLowerCase().includes(query) ||
                String(c.metaLabel || '').toLowerCase().includes(query) ||
                String(c.number).includes(query)
        );
    }

    state.filtered = list;
    renderChannels();
}

function renderChannels() {
    const list = state.filtered;
    channelList.innerHTML = '';

    if (!list.length) {
        channelList.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🔍</div>
        <p>Aucune chaîne trouvée</p>
      </div>`;
        return;
    }

    const frag = document.createDocumentFragment();

    list.forEach((ch) => {
        const div = document.createElement('div');
        div.className = `ch-item${getChannelKey(state.currentChannel) === getChannelKey(ch) ? ' playing' : ''}`;
        if (isFavorite(ch)) div.classList.add('favorite');

        const logoHtml = ch.logo
            ? `<img class="ch-logo" src="${escHtml(ch.logo)}" alt="" onerror="this.outerHTML='<div class=\\'ch-logo-placeholder\\'>📺</div>'">`
            : '<div class="ch-logo-placeholder">📺</div>';

        div.innerHTML = `
      <span class="ch-num">${ch.number || ''}</span>
      ${logoHtml}
      <div class="ch-info">
        <div class="ch-name">${escHtml(ch.name)}</div>
        <div class="ch-group">${getEPGText(ch)}</div>
      </div>
      ${getChannelKey(state.currentChannel) === getChannelKey(ch) ? '<span class="ch-play-icon">▶</span>' : ''}`;

        div.onclick = () => {
            if (state.currentMode === 'series' && ch.isSeries) {
                openSeries(ch);
                return;
            }
            playChannel(ch);
        };

        const favBtn = document.createElement('button');
        favBtn.className = `ch-fav-btn${isFavorite(ch) ? ' active' : ''}`;
        favBtn.type = 'button';
        favBtn.title = 'Favori';
        favBtn.setAttribute('aria-label', 'Favori');
        favBtn.textContent = isFavorite(ch) ? '★' : '☆';
        favBtn.onclick = async (event) => {
            event.stopPropagation();
            await toggleFavorite(ch);
        };
        div.appendChild(favBtn);

        frag.appendChild(div);
    });

    channelList.appendChild(frag);
}

function getEPGText(channel) {
    if (!state.epg) return channel.group;

    const epg = state.epg[channel.id]
        || state.epg[channel.name]
        || state.epg[channel.number];

    if (!epg) return channel.group;

    const now = epg.now ? `▶ ${epg.now}` : '';
    const next = epg.next ? `→ ${epg.next}` : '';

    return `${now} ${next}`.trim() || channel.group;
}

function openEditProfileModal(profile) {
    state.renameProfileId = profile.id;

    $('edit-name').value = profile.name || '';
    $('edit-url').value = profile.portalUrl || '';
    $('edit-mac').value = profile.mac || '';

    $('edit-profile-modal').classList.remove('hidden');
}

async function openSeries(seriesItem) {
    if (!state.stalkerSession) {
        toast('âš ï¸ Connexion Stalker requise');
        return;
    }

    try {
        const res = await window.electronAPI.stalkerSeriesEpisodes({
            serverBase: state.stalkerSession.serverBase,
            mac: state.stalkerSession.mac,
            token: state.stalkerSession.token,
            seriesId: seriesItem.seriesId || seriesItem.id,
            stalkerHeadersJson: state.stalkerSession.stalkerHeaders,
        });

        if (!res.success) {
            toast(`âŒ ${res.error || 'Impossible de charger la sÃ©rie'}`);
            return;
        }

        const episodes = (res.items || []).map((item, index) => ({
            id: item.id || `${seriesItem.id}-${index}`,
            name: getEpisodeLabel(item, index),
            number: '',
            cmd: item.cmd || seriesItem.cmd || '',
            logo: item.screenshot_uri || item.logo || seriesItem.logo || '',
            group: seriesItem.name || 'SÃ©ries',
            contentType: 'series',
            isSeries: false,
            metaLabel: getEpisodeMeta(item, seriesItem),
            seriesIndex: toIntOrNull(item.series_number ?? item.series ?? item.episode_number ?? item.number) ?? index + 1,
            seasonNumber: toIntOrNull(item.season_num ?? item.season_number ?? item.season ?? item.season_id),
            episodeNumber: toIntOrNull(item.episode_num ?? item.episode_number ?? item.series_number ?? item.series ?? item.number) ?? index + 1,
            episodeId: item.episode_id || item.id || null,
            containerExtension: item.container_extension || item.extension || 'mkv',
        }));

        state.seriesStack.push(state.seriesEpisodes);
        state.seriesEpisodes = episodes;
        setMode('series-episodes');
    } catch (err) {
        toast(`âŒ ${err.message}`);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  LECTURE — avec buffering masqué
// ══════════════════════════════════════════════════════════════════════════════

async function playChannel(channel) {
    destroyPlayer();

    state.currentChannel = channel;
    localStorage.setItem("lastChannelId", getChannelKey(channel));
    state.retryCount = 0;

    nowName.textContent = channel.name;
    nowGroup.textContent = channel.group;
    liveDot.classList.remove('visible');

    // ── Masquer vidéo + afficher chargement ──
    video.style.opacity = '0';
    showLoading();
    videoControls.classList.remove('hidden');
    renderChannels();

    const playing = channelList.querySelector('.ch-item.playing');
    if (playing) playing.scrollIntoView({block: 'nearest', behavior: 'smooth'});

    let streamUrl = channel.cmd;

    // Stalker → résoudre
    if (state.stalkerSession && channel.cmd && !channel.cmd.startsWith('http')) {
        try {
            const res = await window.electronAPI.stalkerGetStream({
                serverBase: state.stalkerSession.serverBase,
                mac: state.stalkerSession.mac,
                token: state.stalkerSession.token,
                cmd: channel.cmd,
                stalkerHeadersJson: state.stalkerSession.stalkerHeaders,
                contentType: channel.contentType,
                seriesIndex: channel.seriesIndex,
                episodeId: channel.episodeId,
                containerExtension: channel.containerExtension,
            });

            if (!res.success) {
                video.style.opacity = '1';
                showError(res.error || 'Impossible de lire le flux');
                return;
            }

            streamUrl = res.url;
            if (res.token) state.stalkerSession.token = res.token;
        } catch (err) {
            video.style.opacity = '1';
            showError(err.message);
            return;
        }
    }

    if (!streamUrl) {
        video.style.opacity = '1';
        showError('URL du flux vide');
        return;
    }

    siUrl.textContent = streamUrl.length > 60 ? streamUrl.slice(0, 60) + '...' : streamUrl;
    streamInfo.classList.remove('hidden');

    try {
        const headers = state.stalkerSession?.stalkerHeaders
            ? JSON.parse(state.stalkerSession.stalkerHeaders)
            : {};

        const proxyResult = await window.electronAPI.proxySetTarget({
            url: streamUrl,
            headers,
        });

        const isVodLike = channel.contentType === 'vod' || channel.contentType === 'series';
        startPlayer(proxyResult.proxyUrl, {
            isLive: !isVodLike,
            preferHls: /\.m3u8($|\?)/i.test(streamUrl),
        });
    } catch (err) {
        video.style.opacity = '1';
        showError(err.message);
    }
}

function startPlayer(url, options = {}) {
    const {isLive = true, preferHls = false} = options;
    console.log('▶ Lecture:', url);

    // ── Masquer vidéo pendant le buffering ──
    video.style.opacity = '0';
    showLoading();
    updateProgressVisibility(!isLive);

    let bufferReady = false;
    let bufferTimer = null;

    function onBufferReady() {
        if (bufferReady) return;
        bufferReady = true;
        clearTimeout(bufferTimer);

        // Attendre 5s de buffer accumulé avant d'afficher
        bufferTimer = setTimeout(() => {
            hideLoading();
            video.style.opacity = '1';
            liveDot.classList.toggle('visible', isLive);
            errorOverlay.classList.add('hidden');
        }, isLive ? 5000 : 400);
    }

    if (isLive && typeof mpegts !== 'undefined' && mpegts.isSupported()) {
        state.player = mpegts.createPlayer(
            {type: 'mpegts', url: url, isLive: true},
            {
                enableWorker: true,
                liveBufferLatencyChasing: false,   // désactivé pendant le buffering initial
                liveBufferLatencyMaxLatency: 8,
                liveBufferLatencyMinRemain: 5,     // garder 5s de buffer
                autoCleanupSourceBuffer: true,
            }
        );

        state.player.attachMediaElement(video);
        state.player.load();

        // Dès que le player a assez de données
        state.player.on(mpegts.Events.STATISTICS_INFO, (info) => {
            if (info.decodedFrames > 0 && !bufferReady) {
                onBufferReady();
            }
        });

        state.player.on(mpegts.Events.ERROR, (type, detail, info) => {
            console.error('mpegts error:', type, detail, info);
            clearTimeout(bufferTimer);
            retryPlay();
        });

        state.player.play();
    } else {
        if (preferHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
            state.hls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
            });
            state.hls.loadSource(url);
            state.hls.attachMedia(video);
            state.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(() => retryPlay());
            });
            state.hls.on(Hls.Events.ERROR, (event, data) => {
                console.error('hls error:', data);
                if (data?.fatal) {
                    clearTimeout(bufferTimer);
                    retryPlay();
                }
            });
        } else {
            video.src = url;
        }

        video.addEventListener('canplaythrough', function onReady() {
            video.removeEventListener('canplaythrough', onReady);
            onBufferReady();
        }, {once: true});

        if (!preferHls || typeof Hls === 'undefined' || !Hls.isSupported()) {
            video.play().catch(() => retryPlay());
        }
    }
}

function retryPlay() {
    state.retryCount++;
    if (state.retryCount <= 3) {
        console.log(`🔄 Retry ${state.retryCount}/3...`);
        setTimeout(() => {
            if (state.currentChannel) playChannel(state.currentChannel);
        }, 2000);
    } else {
        video.style.opacity = '1';
        showError('Impossible de lire le flux après 3 tentatives');
    }
}

function destroyPlayer() {
    updateProgressVisibility(false);
    seekBar.value = '0';
    currentTimeEl.textContent = '00:00';
    durationEl.textContent = '00:00';

    if (state.player) {
        try {
            state.player.pause();
            state.player.unload();
            state.player.detachMediaElement();
            state.player.destroy();
        } catch (e) {
        }
        state.player = null;
    }
    if (state.hls) {
        try {
            state.hls.destroy();
        } catch (e) {
        }
        state.hls = null;
    }
    video.removeAttribute('src');
    video.load();
}

// ══════════════════════════════════════════════════════════════════════════════
//  CONTRÔLES VIDÉO
// ══════════════════════════════════════════════════════════════════════════════

video.volume = 0.8;
$('vc-volume').value = 80;
$('vc-vol-label').textContent = '80%';

$('vc-play').onclick = () => {
    if (video.paused) video.play();
    else video.pause();
};

video.addEventListener('play', () => {
    $('vc-play').textContent = '⏸';
});
video.addEventListener('pause', () => {
    $('vc-play').textContent = '▶';
});

$('vc-stop').onclick = () => {
    destroyPlayer();
    state.currentChannel = null;
    video.style.opacity = '1';
    placeholder.classList.remove('hidden');
    errorOverlay.classList.add('hidden');
    loadingOverlay.classList.add('hidden');
    videoControls.classList.add('hidden');
    liveDot.classList.remove('visible');
    nowName.textContent = '—';
    nowGroup.textContent = '';
    renderChannels();
};

$('vc-prev').onclick = () => navigateChannel(-1);
$('vc-next').onclick = () => navigateChannel(1);

$('vc-mute').onclick = () => {
    video.muted = !video.muted;
    $('vc-mute').textContent = video.muted ? '🔇' : '🔊';
};

$('vc-volume').oninput = function () {
    const val = this.value / 100;
    video.volume = val;
    video.muted = val === 0;
    $('vc-mute').textContent = val === 0 ? '🔇' : val < 0.5 ? '🔉' : '🔊';
    $('vc-vol-label').textContent = `${this.value}%`;
};

$('vc-reload').onclick = () => {
    if (state.currentChannel) {
        state.retryCount = 0;
        playChannel(state.currentChannel);
    }
};

seekBar.addEventListener('input', () => {
    if (!isSeekableContent()) return;
    state.isSeekDragging = true;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration) return;
    const targetTime = (Number(seekBar.value) / 1000) * duration;
    currentTimeEl.textContent = formatTime(targetTime);
});

seekBar.addEventListener('change', () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (isSeekableContent() && duration) {
        video.currentTime = (Number(seekBar.value) / 1000) * duration;
    }
    state.isSeekDragging = false;
});

$('vc-pip').onclick = async () => {
    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else {
            await video.requestPictureInPicture();
        }
    } catch (e) {
        toast('❌ PiP non disponible');
    }
};

$('vc-fs').onclick = toggleFullscreen;

function toggleFullscreen() {
    const wrap = $('video-wrap');
    if (!document.fullscreenElement) {
        wrap.requestFullscreen().catch(() => toast('❌ Plein écran non disponible'));
    } else {
        document.exitFullscreen();
    }
}

// ── Afficher/masquer contrôles au survol ──────────────────────────────────────
let controlsTimer;

$('video-wrap').addEventListener('mousemove', () => {
    videoControls.classList.add('visible');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => videoControls.classList.remove('visible'), 3000);
});

$('video-wrap').addEventListener('mouseleave', () => {
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => videoControls.classList.remove('visible'), 1000);
});

videoControls.addEventListener('mouseenter', () => {
    clearTimeout(controlsTimer);
    videoControls.classList.add('visible');
});

videoControls.addEventListener('mouseleave', () => {
    controlsTimer = setTimeout(() => videoControls.classList.remove('visible'), 2000);
});

// ══════════════════════════════════════════════════════════════════════════════
//  EVENTS VIDÉO — buffering fluide
// ══════════════════════════════════════════════════════════════════════════════

let bufferCheckTimer = null;

// Quand suffisamment bufferisé → révéler la vidéo
video.addEventListener('canplaythrough', () => {
    console.log('✅ canplaythrough — révélation vidéo');
    revealVideo();
});

// Fallback : si canplaythrough tarde, on révèle après 2s de canplay
video.addEventListener('canplay', () => {
    clearTimeout(bufferCheckTimer);
    bufferCheckTimer = setTimeout(() => {
        revealVideo();
    }, 1500);
});

video.addEventListener('playing', () => {
    // Ne rien faire ici — c'est startPlayer qui gère l'affichage après buffer
});

video.addEventListener('timeupdate', refreshSeekBar);
video.addEventListener('loadedmetadata', refreshSeekBar);
video.addEventListener('durationchange', refreshSeekBar);
video.addEventListener('ended', () => {
    if (!isSeekableContent()) return;
    seekBar.value = '1000';
    refreshSeekBar();
});

function revealVideo() {
    clearTimeout(bufferCheckTimer);
    video.style.opacity = '1';
    hideLoading();
    placeholder.classList.add('hidden');
    errorOverlay.classList.add('hidden');
}

function updateProgressVisibility(visible) {
    progressWrap.classList.toggle('hidden', !visible);
}

function isSeekableContent() {
    return state.currentChannel?.contentType === 'vod' || state.currentChannel?.contentType === 'series';
}

function formatTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function refreshSeekBar() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    durationEl.textContent = formatTime(duration);
    if (!state.isSeekDragging) {
        currentTimeEl.textContent = formatTime(current);
        seekBar.value = duration ? String(Math.min(1000, Math.round((current / duration) * 1000))) : '0';
    }
}

video.addEventListener('waiting', () => {
    // Seulement montrer le loading si la vidéo était déjà visible
    if (video.style.opacity === '1') {
        loadingOverlay.classList.remove('hidden');
    }
});

video.addEventListener('stalled', () => {
    if (video.style.opacity === '1') {
        loadingOverlay.classList.remove('hidden');
    }
});

video.addEventListener('canplay', () => {
    // Masquer le loading si la vidéo est déjà visible (reprise après rebuffering)
    if (video.style.opacity === '1') {
        hideLoading();
    }
});

video.addEventListener('error', () => {
    if (!state.player) {
        const errMsg = getVideoError(video.error);
        video.style.opacity = '1';
        showError(errMsg);
        liveDot.classList.remove('visible');
    }
});

function getVideoError(err) {
    if (!err) return 'Erreur inconnue';
    switch (err.code) {
        case 1:
            return 'Lecture interrompue';
        case 2:
            return 'Erreur réseau — flux inaccessible';
        case 3:
            return 'Erreur de décodage — format non supporté';
        case 4:
            return 'Format non supporté';
        default:
            return err.message || 'Erreur inconnue';
    }
}

// ── Retry overlay ─────────────────────────────────────────────────────────────
$('btn-retry').onclick = () => {
    if (state.currentChannel) {
        state.retryCount = 0;
        playChannel(state.currentChannel);
    }
};

// ── Helpers UI ────────────────────────────────────────────────────────────────
function showLoading() {
    loadingOverlay.classList.remove('hidden');
    errorOverlay.classList.add('hidden');
    placeholder.classList.add('hidden');
}

function hideLoading() {
    loadingOverlay.classList.add('hidden');
}

function showError(msg) {
    loadingOverlay.classList.add('hidden');
    placeholder.classList.add('hidden');
    $('error-msg').textContent = msg;
    errorOverlay.classList.remove('hidden');
}

// ── Raccourcis clavier ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === "/") {
        e.preventDefault();
        searchInp.focus();
    }

    switch (e.key) {
        case ' ':
            e.preventDefault();
            if (video.paused) video.play();
            else video.pause();
            break;
        case 'f':
        case 'F':
            toggleFullscreen();
            break;
        case 'm':
        case 'M':
            $('vc-mute').click();
            break;
        case 'ArrowUp':
            e.preventDefault();
            navigateChannel(-1);
            break;
        case 'ArrowDown':
            e.preventDefault();
            navigateChannel(1);
            break;
        case 'ArrowLeft':
            if (isSeekableContent()) {
                e.preventDefault();
                video.currentTime = Math.max(0, video.currentTime - 10);
            }
            break;
        case 'ArrowRight':
            if (isSeekableContent()) {
                e.preventDefault();
                video.currentTime = Math.min(video.duration || video.currentTime + 10, video.currentTime + 10);
            }
            break;
        case 'Escape':
            if (document.fullscreenElement) document.exitFullscreen();
            break;
        case 't':
        case 'T':
            toggleTvMode();
            break;
    }
});

function navigateChannel(direction) {
    if (!state.filtered.length) return;
    const currentIdx = state.filtered.findIndex((c) => getChannelKey(c) === getChannelKey(state.currentChannel));
    let nextIdx = currentIdx + direction;
    if (nextIdx < 0) nextIdx = state.filtered.length - 1;
    if (nextIdx >= state.filtered.length) nextIdx = 0;
    playChannel(state.filtered[nextIdx]);
}

video.addEventListener('dblclick', () => toggleFullscreen());

$('confirm-rename-profile').onclick = async () => {
    const name = $('rename-profile-input').value.trim();
    if (!state.renameProfileId) return;
    if (!name) return toast('⚠️ Nom requis');

    await window.electronAPI.profileRename({id: state.renameProfileId, name});
    closeRenameProfileModal();
    await refreshProfilesList();
    toast(`✏️ Profil renommé en "${name}"`);
};

$('rename-profile-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        $('confirm-rename-profile').click();
    }
});

const btnSidebarToggle = document.getElementById("btn-sidebar-toggle");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");

document.body.classList.remove("sidebar-collapsed");

function openSidebar() {
    document.body.classList.remove("sidebar-collapsed");
    sidebarBackdrop.classList.remove("hidden");
}

function closeSidebar() {
    document.body.classList.add("sidebar-collapsed");
    sidebarBackdrop.classList.add("hidden");
}

function toggleSidebar() {
    const isCollapsed = document.body.classList.contains("sidebar-collapsed");
    if (isCollapsed) {
        openSidebar();
    } else {
        closeSidebar();
    }
}

btnSidebarToggle?.addEventListener("click", toggleSidebar);
sidebarBackdrop?.addEventListener("click", closeSidebar);

function toggleTvMode() {
    document.body.classList.toggle("tv-mode");
}