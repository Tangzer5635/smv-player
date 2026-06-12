/**
 * SMV Player — renderer/index.js
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ÉTAT GLOBAL
// ═══════════════════════════════════════════════════════════════════════════════

const state = {
    channels: [],
    filtered: [],
    currentChannel: null,
    currentGroup: 'all',
    currentMode: 'live',
    seriesEpisodes: [],
    seriesStack: [],
    favoriteChannelIds: [],
    history: [],              // historique des 10 dernières chaînes
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
};

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITAIRES
// ═══════════════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function toast(msg, dur = 3000) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), dur);
}

function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function toIntOrNull(v) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
}

function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function lightenColor(hex, pct) {
    const n   = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * pct);
    const c   = (v) => Math.min(255, Math.max(0, v));
    return '#' + (
        0x1000000 +
        c((n >> 16) + amt) * 0x10000 +
        c(((n >> 8) & 0xff) + amt) * 0x100 +
        c((n & 0xff) + amt)
    ).toString(16).slice(1);
}

function applyAccentColor(color) {
    document.documentElement.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--accent2', lightenColor(color, 30));
    document.documentElement.style.setProperty('--accent-rgb', hexToRgb(color));
}

// Debounce générique
function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORIQUE
// ═══════════════════════════════════════════════════════════════════════════════

const HISTORY_MAX = 10;
const HISTORY_KEY = 'smv_history';

function loadHistory() {
    try {
        state.history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch (_) {
        state.history = [];
    }
}

function addToHistory(ch) {
    // Dédupliquer — retirer si déjà présent
    state.history = state.history.filter((h) => getChannelKey(h) !== getChannelKey(ch));
    // Ajouter en tête
    state.history.unshift({
        id:          ch.id,
        name:        ch.name,
        logo:        ch.logo || '',
        group:       ch.group,
        contentType: ch.contentType || 'live',
        cmd:         ch.cmd,
        number:      ch.number || '',
    });
    // Limiter à HISTORY_MAX
    if (state.history.length > HISTORY_MAX) state.history = state.history.slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
    updateHistoryChip();
}

function updateHistoryChip() {
    const node = document.querySelector('.g-chip[data-group="history"] .g-count');
    if (node) node.textContent = String(state.history.length);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAÎNES — clés, construction, épisodes
// ═══════════════════════════════════════════════════════════════════════════════

function getChannelKey(ch) {
    return `${ch?.contentType || 'live'}:${ch?.id ?? ''}`;
}

function getChannelLegacyKey(ch) {
    return String(ch?.id ?? '');
}

function buildLibraryItems(live = [], vod = [], series = []) {
    return [
        ...live.map((item, i) => ({ ...item, contentType: 'live',   number: item.number || i + 1, group: item.group || 'Live' })),
        ...vod.map((item)     => ({ ...item, contentType: 'vod',    number: '', group: `VOD • ${item.category || 'Films'}` })),
        ...series.map((item)  => ({ ...item, contentType: 'series', number: '', group: `SERIES • ${item.category || 'Series'}`, isSeries: item.isSeries ?? true, seriesId: item.seriesId || item.id })),
    ];
}

function getEpisodeLabel(item, fallbackIndex = 0) {
    const season  = toIntOrNull(item.season_num ?? item.season_number ?? item.season ?? item.season_id);
    const episode = toIntOrNull(item.episode_num ?? item.episode_number ?? item.series_number ?? item.series ?? item.number ?? item.sort_num) ?? fallbackIndex + 1;
    const title   = item.name || item.title || item.episode_name || `Episode ${episode}`;
    const p       = (n) => String(n).padStart(2, '0');
    return season ? `S${p(season)}E${p(episode)} - ${title}` : `E${p(episode)} - ${title}`;
}

function getEpisodeMeta(item, seriesItem) {
    const season  = toIntOrNull(item.season_num ?? item.season_number ?? item.season ?? item.season_id);
    const episode = toIntOrNull(item.episode_num ?? item.episode_number ?? item.series_number ?? item.series ?? item.number ?? item.sort_num);
    const parts   = [];
    if (season)  parts.push(`Saison ${season}`);
    if (episode) parts.push(`Episode ${episode}`);
    parts.push(seriesItem.name || 'Series');
    return parts.join(' • ');
}

function normalizeEpisodes(items, seriesItem) {
    return items.map((item, i) => ({
        id: item.id || `${seriesItem.id}-${i}`,
        name: getEpisodeLabel(item, i),
        number: '',
        cmd: item.cmd || seriesItem.cmd || '',
        logo: item.screenshot_uri || item.logo || seriesItem.logo || '',
        group: seriesItem.name || 'Séries',
        contentType: 'series',
        isSeries: false,
        metaLabel: getEpisodeMeta(item, seriesItem),
        seriesIndex: toIntOrNull(item.series_number ?? item.series ?? item.episode_number ?? item.number) ?? i + 1,
        seasonNumber: toIntOrNull(item.season_num ?? item.season_number ?? item.season ?? item.season_id),
        episodeNumber: toIntOrNull(item.episode_num ?? item.episode_number ?? item.series_number ?? item.series ?? item.number) ?? i + 1,
        episodeId: item.episode_id || item.id || null,
        containerExtension: item.container_extension || item.extension || 'mkv',
    }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAVORIS
// ═══════════════════════════════════════════════════════════════════════════════

function isFavorite(ch) {
    return state.favoriteChannelIds.includes(getChannelKey(ch))
        || state.favoriteChannelIds.includes(getChannelLegacyKey(ch));
}

function syncFavoritesToChannels(channels) {
    const available = new Set(channels.flatMap((c) => [getChannelKey(c), getChannelLegacyKey(c)]));
    state.favoriteChannelIds = state.favoriteChannelIds.filter((id) => available.has(id));
}

function updateFavoritesChip() {
    const node = document.querySelector('.g-chip[data-group="favorites"] .g-count');
    if (node) node.textContent = String(state.channels.filter(isFavorite).length);
}

async function toggleFavorite(ch) {
    const key       = getChannelKey(ch);
    const legacyKey = getChannelLegacyKey(ch);
    if (!key) return;

    if (isFavorite(ch)) {
        state.favoriteChannelIds = state.favoriteChannelIds.filter((id) => id !== key && id !== legacyKey);
    } else {
        state.favoriteChannelIds = [...state.favoriteChannelIds, key];
    }

    updateFavoritesChip();
    filterAndRender();

    if (!state.currentProfileId) {
        toast('⭐ Favori local. Sauvegardez le profil pour le conserver.');
        return;
    }

    const res = await window.electronAPI.profileUpdate({
        id: state.currentProfileId,
        favoriteChannelIds: state.favoriteChannelIds,
    });
    if (!res?.success) toast('❌ Impossible de sauvegarder les favoris');
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATEUR QUALITÉ / BITRATE
// ═══════════════════════════════════════════════════════════════════════════════

function updateQualityIndicator(info) {
    const el = $('quality-indicator');
    if (!el) return;

    if (!info) {
        el.textContent = '';
        el.className = 'quality-indicator';
        return;
    }

    // Bitrate en kbps / Mbps
    const kbps = info.speed ? Math.round(info.speed / 1000) : 0;
    let label, cls;

    if (kbps >= 4000)      { label = `${(kbps / 1000).toFixed(1)} Mbps · HD`;  cls = 'quality-hd';  }
    else if (kbps >= 1500) { label = `${(kbps / 1000).toFixed(1)} Mbps`;       cls = 'quality-sd';  }
    else if (kbps > 0)     { label = `${kbps} kbps · Faible`;                   cls = 'quality-low'; }
    else                   { label = '';                                          cls = ''; }

    el.textContent = label;
    el.className   = `quality-indicator ${cls}`;
}

function resetQualityIndicator() {
    updateQualityIndicator(null);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LECTEUR VIDÉO
// ═══════════════════════════════════════════════════════════════════════════════

function showLoading() {
    $('loading-overlay')?.classList.remove('hidden');
    $('error-overlay')?.classList.add('hidden');
    $('placeholder')?.classList.add('hidden');
}

function hideLoading() {
    $('loading-overlay')?.classList.add('hidden');
}

function showError(msg) {
    hideLoading();
    $('placeholder')?.classList.add('hidden');
    const el = $('error-msg');
    if (el) el.textContent = msg;
    $('error-overlay')?.classList.remove('hidden');
}

function revealVideo() {
    const video = $('video');
    if (video) video.style.opacity = '1';
    hideLoading();
    $('placeholder')?.classList.add('hidden');
    $('error-overlay')?.classList.add('hidden');
}

function updateProgressVisibility(visible) {
    $('vc-progress-wrap')?.classList.toggle('hidden', !visible);
}

function isSeekableContent() {
    return state.currentChannel?.contentType === 'vod' || state.currentChannel?.contentType === 'series';
}

function refreshSeekBar() {
    const video   = $('video');
    const seekBar = $('vc-seek');
    if (!video) return;
    const duration = Number.isFinite(video.duration)    ? video.duration    : 0;
    const current  = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const durEl    = $('vc-duration');
    if (durEl) durEl.textContent = formatTime(duration);
    if (!state.isSeekDragging) {
        const curEl = $('vc-current-time');
        if (curEl)    curEl.textContent = formatTime(current);
        if (seekBar)  seekBar.value     = duration ? String(Math.min(1000, Math.round((current / duration) * 1000))) : '0';
    }
}

function getVideoError(err) {
    if (!err) return 'Erreur inconnue';
    return { 1: 'Lecture interrompue', 2: 'Erreur réseau', 3: 'Erreur de décodage', 4: 'Format non supporté' }[err.code] || err.message || 'Erreur inconnue';
}

function destroyPlayer() {
    resetQualityIndicator();
    updateProgressVisibility(false);
    const seekBar     = $('vc-seek');
    const currentTime = $('vc-current-time');
    const duration    = $('vc-duration');
    if (seekBar)     seekBar.value     = '0';
    if (currentTime) currentTime.textContent = '00:00';
    if (duration)    duration.textContent    = '00:00';

    if (state.player) {
        try { state.player.pause(); state.player.unload(); state.player.detachMediaElement(); state.player.destroy(); } catch (_) {}
        state.player = null;
    }
    if (state.hls) {
        try { state.hls.destroy(); } catch (_) {}
        state.hls = null;
    }

    const video = $('video');
    if (video) { video.removeAttribute('src'); video.load(); }
}

function startPlayer(url, { isLive = true, preferHls = false } = {}) {
    const video = $('video');
    if (!video) return;

    video.style.opacity = '0';
    showLoading();
    updateProgressVisibility(!isLive);
    resetQualityIndicator();

    let bufferReady = false;
    let bufferTimer = null;

    function onBufferReady() {
        if (bufferReady) return;
        bufferReady = true;
        clearTimeout(bufferTimer);
        bufferTimer = setTimeout(() => {
            hideLoading();
            video.style.opacity = '1';
            $('live-dot')?.classList.toggle('visible', isLive);
            $('error-overlay')?.classList.add('hidden');
        }, isLive ? 5000 : 400);
    }

    // mpegts (live) — on écoute aussi STATISTICS_INFO pour le bitrate
    if (isLive && typeof mpegts !== 'undefined' && mpegts.isSupported()) {
        state.player = mpegts.createPlayer(
            { type: 'mpegts', url, isLive: true },
            { enableWorker: true, liveBufferLatencyChasing: false, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 5, autoCleanupSourceBuffer: true }
        );
        state.player.attachMediaElement(video);
        state.player.load();
        state.player.on(mpegts.Events.STATISTICS_INFO, (info) => {
            if (info.decodedFrames > 0) onBufferReady();
            updateQualityIndicator(info);
        });
        state.player.on(mpegts.Events.ERROR, () => { clearTimeout(bufferTimer); retryPlay(); });
        state.player.play();
        return;
    }

    // HLS
    if (preferHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
        state.hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        state.hls.loadSource(url);
        state.hls.attachMedia(video);
        state.hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(retryPlay));
        state.hls.on(Hls.Events.ERROR, (_, data) => { if (data?.fatal) { clearTimeout(bufferTimer); retryPlay(); } });
        // Bitrate HLS via FRAG_CHANGED
        state.hls.on(Hls.Events.FRAG_CHANGED, (_, data) => {
            const bw = state.hls?.bandwidthEstimate;
            if (bw) updateQualityIndicator({ speed: bw });
        });
    } else {
        video.src = url;
        video.play().catch(retryPlay);
    }

    video.addEventListener('canplaythrough', function onReady() {
        video.removeEventListener('canplaythrough', onReady);
        onBufferReady();
    }, { once: true });
}

function retryPlay() {
    state.retryCount++;
    if (state.retryCount <= 3) {
        setTimeout(() => { if (state.currentChannel) playChannel(state.currentChannel); }, 2000);
    } else {
        const video = $('video');
        if (video) video.style.opacity = '1';
        showError('Impossible de lire le flux après 3 tentatives');
    }
}

async function playChannel(ch) {
    destroyPlayer();
    state.currentChannel = ch;
    state.retryCount     = 0;
    localStorage.setItem('lastChannelId', getChannelKey(ch));

    // Ajouter à l'historique
    addToHistory(ch);

    const nowName  = $('now-name');
    const nowGroup = $('now-group');
    if (nowName)  nowName.textContent  = ch.name;
    if (nowGroup) nowGroup.textContent = ch.group;
    $('live-dot')?.classList.remove('visible');

    const video = $('video');
    if (video) video.style.opacity = '0';
    showLoading();
    $('video-controls')?.classList.remove('hidden');
    renderChannels();

    $('channel-list')?.querySelector('.ch-item.playing')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    let streamUrl = ch.cmd;

    if (state.stalkerSession && ch.cmd && !ch.cmd.startsWith('http')) {
        try {
            const res = await window.electronAPI.stalkerGetStream({
                serverBase: state.stalkerSession.serverBase, mac: state.stalkerSession.mac,
                token: state.stalkerSession.token, cmd: ch.cmd,
                stalkerHeadersJson: state.stalkerSession.stalkerHeaders,
                contentType: ch.contentType, seriesIndex: ch.seriesIndex,
                episodeId: ch.episodeId, containerExtension: ch.containerExtension,
            });
            if (!res.success) { if (video) video.style.opacity = '1'; showError(res.error || 'Impossible de lire le flux'); return; }
            streamUrl = res.url;
            if (res.token && res.token !== state.stalkerSession.token) {
                state.stalkerSession.token = res.token;
                if (state.currentProfileId) {
                    window.electronAPI.profileUpdate({
                        id: state.currentProfileId,
                        stalkerSession: { ...state.stalkerSession, token: res.token },
                    }).catch(() => {});
                }
            }
        } catch (err) { if (video) video.style.opacity = '1'; showError(err.message); return; }
    }

    if (!streamUrl) { if (video) video.style.opacity = '1'; showError('URL du flux vide'); return; }

    const siUrl = $('si-url');
    if (siUrl) siUrl.textContent = streamUrl.length > 60 ? streamUrl.slice(0, 60) + '…' : streamUrl;
    $('stream-info')?.classList.remove('hidden');

    try {
        const headers     = state.stalkerSession?.stalkerHeaders ? JSON.parse(state.stalkerSession.stalkerHeaders) : {};
        const proxyResult = await window.electronAPI.proxySetTarget({ url: streamUrl, headers });
        const isVodLike   = ch.contentType === 'vod' || ch.contentType === 'series';
        startPlayer(proxyResult.proxyUrl, { isLive: !isVodLike, preferHls: /\.m3u8($|\?)/i.test(streamUrl) });
    } catch (err) { if (video) video.style.opacity = '1'; showError(err.message); }
}

// Ouvrir dans VLC
async function playInVlc() {
    if (!state.currentChannel) return toast('⚠️ Aucune chaîne en cours de lecture');
    const siUrlEl = $('si-url');
    const url     = siUrlEl?.textContent?.replace('…', '') || '';
    if (!url || !url.startsWith('http')) return toast('⚠️ URL du flux introuvable');

    const res = await window.electronAPI.vlcPlay({ url });
    if (res?.success) {
        toast('▶ Ouvert dans VLC');
    } else {
        toast(`❌ ${res?.error || 'VLC introuvable — configurez le chemin dans les paramètres'}`);
    }
}

function navigateChannel(dir) {
    if (!state.filtered.length) return;
    const idx  = state.filtered.findIndex((c) => getChannelKey(c) === getChannelKey(state.currentChannel));
    const next = (idx + dir + state.filtered.length) % state.filtered.length;
    playChannel(state.filtered[next]);
}

function toggleFullscreen() {
    const wrap = $('video-wrap');
    if (!document.fullscreenElement) {
        wrap?.requestFullscreen().catch(() => toast('❌ Plein écran non disponible'));
    } else {
        document.exitFullscreen();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI — RENDU CHAÎNES, GROUPES, MODES
// ═══════════════════════════════════════════════════════════════════════════════

function renderChannels() {
    const channelList = $('channel-list');
    if (!channelList) return;

    const list = state.filtered;

    if (!list.length) {
        channelList.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><p>Aucune chaîne trouvée</p></div>`;
        return;
    }

    const frag       = document.createDocumentFragment();
    const currentKey = getChannelKey(state.currentChannel);

    for (const ch of list) {
        const isPlaying = currentKey === getChannelKey(ch);
        const isFav     = isFavorite(ch);

        const div = document.createElement('div');
        div.className = ['ch-item', isPlaying && 'playing', isFav && 'favorite'].filter(Boolean).join(' ');

        const logoHtml = ch.logo
            ? `<img class="ch-logo" src="${escHtml(ch.logo)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'ch-logo-placeholder\\'>📺</div>'">`
            : '<div class="ch-logo-placeholder">📺</div>';

        div.innerHTML = `
      <span class="ch-num">${ch.number || ''}</span>
      ${logoHtml}
      <div class="ch-info">
        <div class="ch-name">${escHtml(ch.name)}</div>
        <div class="ch-group">${escHtml(ch.group)}</div>
      </div>
      ${isPlaying ? '<span class="ch-play-icon">▶</span>' : ''}`;

        div.addEventListener('click', () => {
            if (state.currentMode === 'series' && ch.isSeries) { openSeriesEpisodes(ch); return; }
            playChannel(ch);
        });

        const favBtn       = document.createElement('button');
        favBtn.className   = `ch-fav-btn${isFav ? ' active' : ''}`;
        favBtn.type        = 'button';
        favBtn.title       = 'Favori';
        favBtn.textContent = isFav ? '★' : '☆';
        favBtn.addEventListener('click', async (e) => { e.stopPropagation(); await toggleFavorite(ch); });
        div.appendChild(favBtn);
        frag.appendChild(div);
    }

    channelList.innerHTML = '';
    channelList.appendChild(frag);
}

function filterAndRender() {
    const query = ($('search')?.value || '').toLowerCase().trim();
    let list    = state.channels;

    switch (state.currentMode) {
        case 'favorites':       list = list.filter(isFavorite); break;
        case 'history':         list = state.history; break;
        case 'live':            list = list.filter((c) => c.contentType !== 'vod' && c.contentType !== 'series');
            if (state.currentGroup !== 'all') list = list.filter((c) => c.group === state.currentGroup);
            break;
        case 'vod':             list = list.filter((c) => c.contentType === 'vod'); break;
        case 'series':          list = list.filter((c) => c.contentType === 'series' && c.isSeries); break;
        case 'series-episodes': list = state.seriesEpisodes; break;
    }

    if (query) {
        list = list.filter((c) =>
            c.name.toLowerCase().includes(query) ||
            c.group.toLowerCase().includes(query) ||
            String(c.metaLabel || '').toLowerCase().includes(query) ||
            String(c.number).includes(query)
        );
    }

    state.filtered = list;
    renderChannels();
}

// Version debounced pour la recherche (150ms)
const filterAndRenderDebounced = debounce(filterAndRender, 150);

function selectGroup(group) {
    state.currentGroup = group;
    if (group === 'favorites') state.currentMode = 'favorites';
    else if (group === 'history') state.currentMode = 'history';
    else state.currentMode = 'live';

    document.querySelectorAll('.g-chip').forEach((c) => {
        c.classList.toggle('active', group === 'all' ? !c.dataset.group : c.dataset.group === group);
    });

    $('btn-mode-live')?.classList.toggle('active', state.currentMode === 'live');
    $('btn-mode-vod')?.classList.remove('active');
    $('btn-mode-series')?.classList.remove('active');
    filterAndRender();
}

function buildGroupBar(channels) {
    const groupBar = $('group-bar');
    if (!groupBar) return;
    groupBar.innerHTML = '';
    groupBar.classList.remove('collapsed');
    state.categoriesCollapsed = false;
    const toggleBtn = $('btn-toggle-cats');
    if (toggleBtn) toggleBtn.textContent = '▼';

    const liveItems      = channels.filter((c) => c.contentType !== 'vod' && c.contentType !== 'series');
    const groups         = [...new Set(liveItems.map((c) => c.group))].sort();
    const favoritesCount = channels.filter(isFavorite).length;

    const makeChip = (label, count, group, active = false) => {
        const btn = document.createElement('button');
        btn.className = `g-chip${active ? ' active' : ''}`;
        if (group) btn.dataset.group = group;
        btn.innerHTML = `<span>${label}</span><span class="g-count">${count}</span>`;
        btn.addEventListener('click', () => selectGroup(group || 'all'));
        return btn;
    };

    groupBar.appendChild(makeChip('📺 Tous',      channels.length,   '',         true));
    groupBar.appendChild(makeChip('⭐ Favoris',    favoritesCount,    'favorites'));
    groupBar.appendChild(makeChip('🕐 Récents',    state.history.length, 'history'));
    groups.forEach((g) => {
        groupBar.appendChild(makeChip(escHtml(g), liveItems.filter((c) => c.group === g).length, g));
    });
}

function setMode(mode) {
    state.currentMode = mode;
    $('btn-mode-live')?.classList.toggle('active', mode === 'live');
    $('btn-mode-vod')?.classList.toggle('active', mode === 'vod');
    $('btn-mode-series')?.classList.toggle('active', mode === 'series');
    $('btn-series-back')?.classList.toggle('hidden', mode !== 'series-episodes');
    filterAndRender();
}

function loadChannels(channels, { autoPlay = true } = {}) {
    state.channels       = channels;
    state.currentGroup   = 'all';
    state.currentMode    = 'live';
    state.seriesEpisodes = [];
    state.seriesStack    = [];

    syncFavoritesToChannels(channels);
    buildGroupBar(channels);

    const searchInp = $('search');
    if (searchInp) searchInp.value = '';
    $('btn-clear-search')?.classList.remove('visible');
    $('btn-mode-live')?.classList.add('active');
    $('btn-mode-vod')?.classList.remove('active');
    $('btn-mode-series')?.classList.remove('active');
    $('btn-series-back')?.classList.add('hidden');

    filterAndRender();

    if (autoPlay) {
        const lastId = localStorage.getItem('lastChannelId');
        if (lastId) {
            const found = channels.find((c) => getChannelKey(c) === lastId);
            if (found) setTimeout(() => playChannel(found), 500);
        }
    }
}

async function openSeriesEpisodes(seriesItem) {
    if (!state.stalkerSession) { toast('⚠️ Connexion Stalker requise'); return; }
    try {
        const res = await window.electronAPI.stalkerSeriesEpisodes({
            serverBase: state.stalkerSession.serverBase, mac: state.stalkerSession.mac,
            token: state.stalkerSession.token, seriesId: seriesItem.seriesId || seriesItem.id,
            stalkerHeadersJson: state.stalkerSession.stalkerHeaders,
        });
        if (!res.success) { toast(`❌ ${res.error || 'Impossible de charger la série'}`); return; }
        state.seriesStack.push(state.seriesEpisodes);
        state.seriesEpisodes = normalizeEpisodes(res.items || [], seriesItem);
        setMode('series-episodes');
    } catch (err) { toast(`❌ ${err.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILS
// ═══════════════════════════════════════════════════════════════════════════════

function setConnInfo(label, count) {
    $('conn-info')?.classList.remove('hidden');
    const lbl = $('conn-label');
    const cnt = $('conn-count');
    if (lbl) lbl.textContent = label;
    if (cnt) cnt.textContent = count;
}

async function refreshProfilesList() {
    const profiles  = await window.electronAPI.profilesList();
    const container = $('profiles-list');
    if (!container) return;

    if (!profiles.length) {
        container.innerHTML = `<div class="empty"><div class="empty-icon">📁</div><p>Aucun profil sauvegardé</p><p style="font-size:11px;margin-top:4px;color:#666">Connectez-vous puis cliquez sur 💾 Sauver</p></div>`;
        return;
    }

    const frag = document.createDocumentFragment();

    for (const p of profiles) {
        const item = document.createElement('div');
        item.className = `profile-item${state.currentProfileId === p.id ? ' playing' : ''}`;
        const meta    = p.type === 'stalker' ? `${p.portalUrl} · ${p.mac}` : 'Fichier M3U';
        const dateStr = new Date(p.updatedAt || p.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });

        item.innerHTML = `
      <div class="profile-icon">${p.type === 'stalker' ? '🔗' : '📄'}</div>
      <div class="profile-info">
        <div class="profile-name">${escHtml(p.name)}</div>
        <div class="profile-meta">${p.channelCount} chaînes · ${dateStr}</div>
        <div class="profile-meta">${escHtml(meta)}</div>
      </div>
      <div class="profile-actions">
        <button class="btn-tiny" data-action="edit"    data-id="${p.id}" title="Modifier">✏️</button>
        <button class="btn-tiny" data-action="refresh" data-id="${p.id}" data-type="${p.type}" title="Rafraîchir">🔄</button>
        <button class="btn-tiny danger" data-action="delete" data-id="${p.id}" title="Supprimer">🗑️</button>
      </div>`;

        item.addEventListener('click', (e) => { if (!e.target.closest('.profile-actions')) loadProfile(p.id); });
        frag.appendChild(item);
    }

    container.innerHTML = '';
    container.appendChild(frag);

    container.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const { action, id, type } = btn.dataset;
            if (action === 'delete') {
                if (!confirm('Supprimer ce profil ?')) return;
                await window.electronAPI.profileDelete(id);
                if (state.currentProfileId === id) {
                    state.currentProfileId = null; state.channels = [];
                    const cl = $('channel-list');
                    if (cl) cl.innerHTML = '<div class="empty">Chargez un profil</div>';
                }
                await refreshProfilesList();
                return toast('🗑️ Profil supprimé');
            }
            const result = await window.electronAPI.profileLoad(id);
            if (!result?.success) return;
            if (action === 'edit')    openEditProfileModal(result.profile);
            if (action === 'refresh') refreshProfile(id, type);
        });
    });
}

async function loadProfile(profileId) {
    const result = await window.electronAPI.profileLoad(profileId);
    if (!result?.success) throw new Error('Profil introuvable');

    const profile = result.profile;
    state.currentProfileId   = profile.id;
    state.stalkerSession     = profile.stalkerSession || null;
    state.favoriteChannelIds = (profile.favoriteChannelIds || []).map(String);
    localStorage.setItem('lastProfileId', profile.id);
    document.body.classList.remove('on-welcome');

    const puInput = $('portal-url');
    const pmInput = $('portal-mac');
    if (puInput) puInput.value = profile.portalUrl || '';
    if (pmInput) pmInput.value = profile.mac || '';

    const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
    const cacheAge      = Date.now() - new Date(profile.updatedAt || 0).getTime();
    const cacheValid    = profile.channels?.length && cacheAge < CACHE_MAX_AGE;
    const cacheExpired  = profile.channels?.length && cacheAge >= CACHE_MAX_AGE;

    if (cacheValid) {
        loadChannels(profile.channels, { autoPlay: false });
        setConnInfo(`📁 ${profile.name} (cache)`, profile.channels.length);
        toast('⚡ Chargement instantané');
        await refreshProfilesList();
        return;
    }

    if (cacheExpired) toast('⚠️ Cache expiré, reconnexion…');

    if (profile.type === 'stalker' && profile.portalUrl && profile.mac) {
        toast('⏳ Connexion au portail…');
        const res = await window.electronAPI.stalkerConnect({ portalUrl: profile.portalUrl, mac: profile.mac });
        if (!res.success) throw new Error(res.error || 'Connexion impossible');

        state.stalkerSession = { token: res.token, serverBase: res.serverBase, mac: res.mac, stalkerHeaders: res.stalkerHeaders };
        const items = buildLibraryItems(res.channels, res.vod, res.series);
        loadChannels(items);
        setConnInfo(`📁 ${profile.name}`, items.length);
        toast(`✅ Profil chargé (${items.length} éléments)`);
    }

    await refreshProfilesList();
}

async function reloadProfileLibrary(profile) {
    const res = await window.electronAPI.stalkerConnect({ portalUrl: profile.portalUrl, mac: profile.mac });
    if (!res.success) throw new Error(res.error || 'Recharge impossible');
    const session = { token: res.token, serverBase: res.serverBase, mac: res.mac, stalkerHeaders: res.stalkerHeaders };
    const items   = buildLibraryItems(res.channels, res.vod, res.series);
    await window.electronAPI.profileUpdate({ id: profile.id, channels: items, stalkerSession: session, favoriteChannelIds: state.favoriteChannelIds });
    return { session, items };
}

async function refreshProfile(profileId, type) {
    const result = await window.electronAPI.profileLoad(profileId);
    if (!result.success) return toast('❌ Profil introuvable');

    const profile     = result.profile;
    const savedFavIds = (profile.favoriteChannelIds || []).map(String);

    if (type !== 'stalker' || !profile.portalUrl || !profile.mac)
        return toast('ℹ️ Rechargez le fichier M3U manuellement');

    toast('🔄 Rafraîchissement en cours…');
    state.favoriteChannelIds = savedFavIds;

    const refreshed = await reloadProfileLibrary(profile).catch((err) => ({ error: err }));
    if (refreshed?.error) return toast(`❌ ${refreshed.error.message}`);

    state.stalkerSession     = refreshed.session;
    state.currentProfileId   = profileId;
    state.favoriteChannelIds = savedFavIds;
    loadChannels(refreshed.items);
    setConnInfo(`📁 ${profile.name}`, refreshed.items.length);
    toast(`✅ Cache mis à jour (${refreshed.items.length} éléments)`);
    await refreshProfilesList();
}

async function renderWelcomeProfiles() {
    const grid  = $('welcome-profiles-grid');
    const count = $('welcome-profiles-count');
    if (!grid || !count) return;

    const profiles = await window.electronAPI.profilesList();
    count.textContent = String(profiles.length);

    if (!profiles.length) {
        grid.innerHTML = '<div class="welcome-empty">Aucun profil enregistré</div>';
        return;
    }

    const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
    const now           = Date.now();

    grid.innerHTML = profiles.map((p, i) => {
        const cacheAge     = now - new Date(p.updatedAt || 0).getTime();
        const hasCache     = p.channelCount > 0;
        const cacheExpired = hasCache && cacheAge >= CACHE_MAX_AGE;
        const badge        = cacheExpired
            ? `<div class="welcome-profile-badge badge-expired">Cache expiré</div>`
            : `<div class="welcome-profile-badge">Profil</div>`;
        return `
    <button class="welcome-profile-card" data-profile-id="${p.id}" type="button">
      <div class="welcome-profile-top">
        <div class="welcome-profile-icon">📁</div>
        ${badge}
      </div>
      <div class="welcome-profile-name">${escHtml(p.name || `Profil ${i + 1}`)}</div>
      <div class="welcome-profile-meta">${escHtml(p.portalUrl || 'Portail non défini')}</div>
      <div class="welcome-profile-submeta">${escHtml(p.mac || 'MAC non définie')}</div>
      <div class="welcome-profile-open">Ouvrir ce profil →</div>
    </button>`;
    }).join('');

    grid.querySelectorAll('.welcome-profile-card').forEach((card) => {
        card.addEventListener('click', async () => {
            setWelcomeCardLoading(card, true);
            try {
                await loadProfile(card.dataset.profileId);
                $('welcome-screen')?.classList.add('hidden');
            } catch (err) {
                setWelcomeCardLoading(card, false);
                toast(`❌ ${err.message || 'Impossible de charger le profil'}`);
            }
        });
    });
}

function setWelcomeCardLoading(card, loading) {
    const openEl = card.querySelector('.welcome-profile-open');
    const iconEl = card.querySelector('.welcome-profile-icon');
    if (loading) {
        card.disabled = true; card.classList.add('loading');
        if (openEl) openEl.textContent = 'Connexion…';
        if (iconEl) iconEl.textContent = '⏳';
    } else {
        card.disabled = false; card.classList.remove('loading');
        if (openEl) openEl.textContent = 'Ouvrir ce profil →';
        if (iconEl) iconEl.textContent = '📁';
    }
}

function goToWelcome() {
    if (state.currentChannel && !confirm('Quitter la lecture en cours ?')) return;
    destroyPlayer();
    state.currentChannel = null;
    state.channels = []; state.filtered = [];
    const cl = $('channel-list');
    if (cl) cl.innerHTML = '';
    const nowName = $('now-name'); const nowGroup = $('now-group');
    if (nowName)  nowName.textContent  = '—';
    if (nowGroup) nowGroup.textContent = '';
    $('conn-info')?.classList.add('hidden');
    $('welcome-screen')?.classList.remove('hidden');
    document.body.classList.add('on-welcome');
    renderWelcomeProfiles();
}

function openEditProfileModal(profile) {
    state.renameProfileId = profile.id;
    const nameEl = $('edit-name'); const urlEl = $('edit-url'); const macEl = $('edit-mac');
    if (nameEl) nameEl.value = profile.name || '';
    if (urlEl)  urlEl.value  = profile.portalUrl || '';
    if (macEl)  macEl.value  = profile.mac || '';
    $('edit-profile-modal')?.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMÈTRES
// ═══════════════════════════════════════════════════════════════════════════════

function openSettings()  { $('settings-modal')?.classList.remove('hidden'); document.body.classList.add('settings-open'); }
function closeSettings() { $('settings-modal')?.classList.add('hidden');    document.body.classList.remove('settings-open'); }

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALISATION & ÉVÉNEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {

    // ── Historique ────────────────────────────────────────────────────────────────
    loadHistory();

    // ── Config ────────────────────────────────────────────────────────────────────
    state.config = await window.electronAPI.getConfig();
    const set = (id, val) => { const el = $(id); if (el) el.value = val ?? ''; };
    set('cfg-ua',       state.config.userAgent);
    set('cfg-timeout',  state.config.networkTimeout ?? 60);
    set('cfg-referrer', state.config.referrer);
    set('cfg-headers',  state.config.headerFields);
    set('cfg-vlc',      state.config.vlcPath);
    const siUa = $('si-ua');
    if (siUa) siUa.textContent = state.config.userAgent || '';

    const savedColor = localStorage.getItem('accentColor');
    if (savedColor) {
        applyAccentColor(savedColor);
        const accentInp = $('cfg-accent');
        if (accentInp) accentInp.value = savedColor;
    }

    // ── Fenêtre Electron ──────────────────────────────────────────────────────────
    $('btn-minimize')?.addEventListener('click', () => window.electronAPI.windowMinimize());
    $('btn-maximize')?.addEventListener('click', () => window.electronAPI.windowMaximize());
    $('btn-close')?.addEventListener('click',    () => window.electronAPI.windowClose());
    window.electronAPI.onWindowStateChanged(({ isMaximized }) => {
        const btn = $('btn-maximize');
        if (btn) { btn.textContent = isMaximized ? '❐' : '☐'; btn.title = isMaximized ? 'Restaurer' : 'Agrandir'; }
    });
    document.querySelector('.titlebar')?.addEventListener('dblclick', (e) => {
        if (!e.target.closest('.titlebar-right')) window.electronAPI.windowMaximize();
    });

    // ── Sidebar ───────────────────────────────────────────────────────────────────
    const backdrop = $('sidebar-backdrop');
    $('btn-sidebar-toggle')?.addEventListener('click', () => {
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        document.body.classList.toggle('sidebar-collapsed', !collapsed);
        document.body.classList.toggle('tv-mode', false);
        backdrop?.classList.toggle('hidden', !collapsed);
    });
    backdrop?.addEventListener('click', () => {
        document.body.classList.add('sidebar-collapsed');
        backdrop.classList.add('hidden');
    });

    // ── Tabs ──────────────────────────────────────────────────────────────────────
    document.querySelectorAll('.tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('hidden'));
            btn.classList.add('active');
            $(`tab-${btn.dataset.tab}`)?.classList.remove('hidden');
        });
    });

    // ── MAC format ────────────────────────────────────────────────────────────────
    $('portal-mac')?.addEventListener('input', function () {
        let v = this.value.toUpperCase().replace(/[^0-9A-F]/g, '');
        v = v.match(/.{1,2}/g)?.join(':') || v;
        this.value = v.slice(0, 17);
    });

    // ── Catégories toggle ─────────────────────────────────────────────────────────
    $('btn-toggle-cats')?.addEventListener('click', () => {
        state.categoriesCollapsed = !state.categoriesCollapsed;
        $('group-bar')?.classList.toggle('collapsed', state.categoriesCollapsed);
        const btn = $('btn-toggle-cats');
        if (btn) btn.textContent = state.categoriesCollapsed ? '▶' : '▼';
    });

    // ── Modes ─────────────────────────────────────────────────────────────────────
    const resetSeries = () => { state.seriesEpisodes = []; state.seriesStack = []; };
    $('btn-mode-live')?.addEventListener('click',   () => { resetSeries(); setMode('live');   });
    $('btn-mode-vod')?.addEventListener('click',    () => { resetSeries(); setMode('vod');    });
    $('btn-mode-series')?.addEventListener('click', () => { resetSeries(); setMode('series'); });
    $('btn-series-back')?.addEventListener('click', () => {
        state.seriesEpisodes = state.seriesStack.pop() || [];
        setMode('series');
    });

    // ── Recherche avec debounce ───────────────────────────────────────────────────
    $('search')?.addEventListener('input', () => {
        $('btn-clear-search')?.classList.toggle('visible', !!$('search').value);
        filterAndRenderDebounced(); // 150ms debounce
    });
    $('btn-clear-search')?.addEventListener('click', () => {
        const s = $('search');
        if (s) s.value = '';
        $('btn-clear-search')?.classList.remove('visible');
        filterAndRender();
        $('search')?.focus();
    });

    // ── Paramètres ────────────────────────────────────────────────────────────────
    $('btn-settings')?.addEventListener('click', () =>
        $('settings-modal')?.classList.contains('hidden') ? openSettings() : closeSettings()
    );
    $('close-settings')?.addEventListener('click', closeSettings);
    $('settings-modal')?.addEventListener('click', (e) => { if (e.target === $('settings-modal')) closeSettings(); });

    $('save-settings')?.addEventListener('click', async () => {
        const color = $('cfg-accent')?.value || '#6c5ce7';
        applyAccentColor(color);
        localStorage.setItem('accentColor', color);
        const cfg = {
            userAgent:      $('cfg-ua')?.value.trim()       || '',
            networkTimeout: parseInt($('cfg-timeout')?.value) || 60,
            referrer:       $('cfg-referrer')?.value.trim() || '',
            headerFields:   $('cfg-headers')?.value.trim()  || '',
            vlcPath:        $('cfg-vlc')?.value.trim()      || '',
        };
        state.config = await window.electronAPI.updateConfig(cfg);
        const siUaEl = $('si-ua');
        if (siUaEl) siUaEl.textContent = cfg.userAgent;
        closeSettings();
        toast('✅ Paramètres sauvegardés');
    });

    $('btn-browse-vlc')?.addEventListener('click', async () => {
        const res = await window.electronAPI.browseVlcPath();
        if (!res?.success) return;
        const vlcInp = $('cfg-vlc');
        if (vlcInp) vlcInp.value = res.path;
        state.config = await window.electronAPI.updateConfig({
            userAgent: $('cfg-ua')?.value.trim() || '', networkTimeout: parseInt($('cfg-timeout')?.value) || 60,
            referrer: $('cfg-referrer')?.value.trim() || '', headerFields: $('cfg-headers')?.value.trim() || '', vlcPath: res.path,
        });
        toast('✅ Chemin VLC sauvegardé');
    });

    $('cfg-accent')?.addEventListener('input', (e) => applyAccentColor(e.target.value));

    // ── Stalker connect ───────────────────────────────────────────────────────────
    $('btn-connect')?.addEventListener('click', async () => {
        const portalUrl = $('portal-url')?.value.trim();
        const mac       = $('portal-mac')?.value.trim();
        if (!portalUrl || !mac)                                       return toast('⚠️ URL et MAC requis');
        if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac))     return toast('⚠️ Format MAC invalide');

        const btn = $('btn-connect');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Connexion…'; }

        try {
            const res = await window.electronAPI.stalkerConnect({ portalUrl, mac });
            if (!res.success) { toast(`❌ ${res.error}`); return; }

            state.stalkerSession     = { token: res.token, serverBase: res.serverBase, mac: res.mac, stalkerHeaders: res.stalkerHeaders };
            state.currentProfileId   = null;
            state.favoriteChannelIds = [];
            state.saveContext        = 'stalker';

            const items = buildLibraryItems(res.channels, res.vod, res.series);
            loadChannels(items);
            setConnInfo('✅ Connecté', items.length);
            $('btn-save-profile')?.classList.remove('hidden');
            toast(`✅ ${res.channels.length} chaînes chargées`);
        } catch (err) { toast(`❌ ${err.message}`); }
        finally { if (btn) { btn.disabled = false; btn.textContent = '🔗 Connexion'; } }
    });

    // ── Save profile ──────────────────────────────────────────────────────────────
    $('btn-save-profile')?.addEventListener('click', () => {
        const inp = $('profile-name-input');
        if (inp) inp.value = '';
        $('save-profile-modal')?.classList.remove('hidden');
        inp?.focus();
    });
    $('close-save-profile')?.addEventListener('click', () => $('save-profile-modal')?.classList.add('hidden'));
    $('confirm-save-profile')?.addEventListener('click', async () => {
        const name = $('profile-name-input')?.value.trim();
        if (!name) return toast('⚠️ Nom requis');
        const result = await window.electronAPI.profileSave({
            name, channels: state.channels, favoriteChannelIds: state.favoriteChannelIds,
            type: 'stalker',
            portalUrl: state.saveContext === 'stalker' ? ($('portal-url')?.value.trim() || '') : '',
            mac:       state.saveContext === 'stalker' ? ($('portal-mac')?.value.trim() || '') : '',
            stalkerSession: state.saveContext === 'stalker' ? state.stalkerSession : null,
        });
        state.currentProfileId = result.id;
        $('save-profile-modal')?.classList.add('hidden');
        await refreshProfilesList();
        toast(`💾 Profil "${name}" sauvegardé (${state.channels.length} chaînes)`);
    });

    // ── Rename profile ────────────────────────────────────────────────────────────
    $('close-rename-profile')?.addEventListener('click', () => {
        state.renameProfileId = null;
        const inp = $('rename-profile-input');
        if (inp) inp.value = '';
        $('rename-profile-modal')?.classList.add('hidden');
    });
    $('rename-profile-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); $('confirm-rename-profile')?.click(); }
    });
    $('confirm-rename-profile')?.addEventListener('click', async () => {
        const name = $('rename-profile-input')?.value.trim();
        if (!state.renameProfileId || !name) return toast('⚠️ Nom requis');
        await window.electronAPI.profileRename({ id: state.renameProfileId, name });
        state.renameProfileId = null;
        const inp = $('rename-profile-input');
        if (inp) inp.value = '';
        $('rename-profile-modal')?.classList.add('hidden');
        await refreshProfilesList();
        toast(`✏️ Profil renommé en "${name}"`);
    });

    // ── Edit profile modal ────────────────────────────────────────────────────────
    $('edit-profile-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'edit-profile-modal') $('edit-profile-modal')?.classList.add('hidden');
    });
    $('copy-url')?.addEventListener('click', () => { navigator.clipboard.writeText($('edit-url')?.value || ''); toast('📋 URL copiée'); });
    $('copy-mac')?.addEventListener('click', () => { navigator.clipboard.writeText($('edit-mac')?.value || ''); toast('📋 MAC copiée'); });
    ['edit-url', 'edit-mac'].forEach((id) => {
        $(id)?.addEventListener('click', function () { this.select(); navigator.clipboard.writeText(this.value); toast('📋 Copié'); });
    });
    $('confirm-edit-profile')?.addEventListener('click', async () => {
        const name = $('edit-name')?.value.trim();
        if (!name) return toast('⚠️ Nom requis');
        await window.electronAPI.profileUpdate({ id: state.renameProfileId, name });
        $('edit-profile-modal')?.classList.add('hidden');
        await refreshProfilesList();
        await renderWelcomeProfiles();
        toast('✏️ Profil renommé');
    });

    // ── Welcome / Home ────────────────────────────────────────────────────────────
    $('btn-enter-app')?.addEventListener('click', () => {
        $('welcome-screen')?.classList.add('hidden');
        document.body.classList.remove('on-welcome');
    });
    document.querySelectorAll('#btn-home').forEach((btn) => btn.addEventListener('click', goToWelcome));

    // ── Contrôles vidéo ───────────────────────────────────────────────────────────
    const video = $('video');
    if (video) video.volume = 0.8;
    const volSlider = $('vc-volume');
    const volLabel  = $('vc-vol-label');
    if (volSlider) volSlider.value = 80;
    if (volLabel)  volLabel.textContent = '80%';

    $('vc-play')?.addEventListener('click', () => { const v = $('video'); v?.paused ? v.play() : v?.pause(); });
    $('vc-stop')?.addEventListener('click', () => {
        destroyPlayer();
        state.currentChannel = null;
        const v = $('video');
        if (v) v.style.opacity = '1';
        $('placeholder')?.classList.remove('hidden');
        $('error-overlay')?.classList.add('hidden');
        $('loading-overlay')?.classList.add('hidden');
        $('video-controls')?.classList.add('hidden');
        $('live-dot')?.classList.remove('visible');
        const nn = $('now-name');  if (nn) nn.textContent = '—';
        const ng = $('now-group'); if (ng) ng.textContent = '';
        renderChannels();
    });
    $('vc-prev')?.addEventListener('click', () => navigateChannel(-1));
    $('vc-next')?.addEventListener('click', () => navigateChannel(1));
    $('vc-mute')?.addEventListener('click', () => {
        const v = $('video'); if (!v) return;
        v.muted = !v.muted;
        const btn = $('vc-mute');
        if (btn) btn.textContent = v.muted ? '🔇' : '🔊';
    });
    volSlider?.addEventListener('input', function () {
        const v = $('video'); if (!v) return;
        const val = this.value / 100;
        v.volume = val; v.muted = val === 0;
        const mute = $('vc-mute');
        if (mute) mute.textContent = val === 0 ? '🔇' : val < 0.5 ? '🔉' : '🔊';
        if (volLabel) volLabel.textContent = `${this.value}%`;
    });
    $('vc-reload')?.addEventListener('click', () => { if (state.currentChannel) { state.retryCount = 0; playChannel(state.currentChannel); } });
    $('vc-vlc')?.addEventListener('click', playInVlc);
    $('vc-seek')?.addEventListener('input', () => {
        if (!isSeekableContent()) return;
        state.isSeekDragging = true;
        const v = $('video');
        const dur = v && Number.isFinite(v.duration) ? v.duration : 0;
        if (!dur) return;
        const curEl = $('vc-current-time');
        if (curEl) curEl.textContent = formatTime((Number($('vc-seek').value) / 1000) * dur);
    });
    $('vc-seek')?.addEventListener('change', () => {
        const v = $('video');
        const dur = v && Number.isFinite(v.duration) ? v.duration : 0;
        if (isSeekableContent() && dur) v.currentTime = (Number($('vc-seek').value) / 1000) * dur;
        state.isSeekDragging = false;
    });
    $('vc-pip')?.addEventListener('click', async () => {
        try { document.pictureInPictureElement ? await document.exitPictureInPicture() : await $('video')?.requestPictureInPicture(); }
        catch (_) { toast('❌ PiP non disponible'); }
    });
    $('vc-fs')?.addEventListener('click', toggleFullscreen);
    $('btn-retry')?.addEventListener('click', () => { if (state.currentChannel) { state.retryCount = 0; playChannel(state.currentChannel); } });

    // Visibility on hover
    let controlsTimer;

    function showControls() {
        const vc = $('video-controls');
        const vw = $('video-wrap');
        vc?.classList.add('visible');
        if (document.fullscreenElement) vw?.style.setProperty('cursor', 'default');
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(() => {
            vc?.classList.remove('visible');
            if (document.fullscreenElement) vw?.style.setProperty('cursor', 'none');
        }, 3000);
    }

    function hideControlsSoon(delay = 1000) {
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(() => {
            $('video-controls')?.classList.remove('visible');
            if (document.fullscreenElement) $('video-wrap')?.style.setProperty('cursor', 'none');
        }, delay);
    }

    $('video-wrap')?.addEventListener('mousemove', showControls);
    $('video-wrap')?.addEventListener('mouseleave', () => { if (!document.fullscreenElement) hideControlsSoon(1000); });
    $('video-controls')?.addEventListener('mouseenter', () => { clearTimeout(controlsTimer); $('video-controls')?.classList.add('visible'); });
    $('video-controls')?.addEventListener('mouseleave', () => hideControlsSoon(2000));

    document.addEventListener('fullscreenchange', () => {
        const vw = $('video-wrap');
        if (document.fullscreenElement) {
            showControls();
        } else {
            vw?.style.removeProperty('cursor');
            clearTimeout(controlsTimer);
            $('video-controls')?.classList.remove('visible');
        }
    });

    // ── Événements vidéo ──────────────────────────────────────────────────────────
    if (video) {
        let bufferCheckTimer = null;
        video.addEventListener('canplaythrough', () => revealVideo());
        video.addEventListener('canplay', () => { clearTimeout(bufferCheckTimer); bufferCheckTimer = setTimeout(revealVideo, 1500); });
        video.addEventListener('timeupdate',     refreshSeekBar);
        video.addEventListener('loadedmetadata', refreshSeekBar);
        video.addEventListener('durationchange', refreshSeekBar);
        video.addEventListener('ended', () => { if (isSeekableContent()) { const s = $('vc-seek'); if (s) s.value = '1000'; refreshSeekBar(); } });
        video.addEventListener('waiting', () => { if (video.style.opacity === '1') showLoading(); });
        video.addEventListener('stalled', () => { if (video.style.opacity === '1') showLoading(); });
        video.addEventListener('canplay',  () => { if (video.style.opacity === '1') hideLoading(); });
        video.addEventListener('error',    () => { if (!state.player) { showError(getVideoError(video.error)); $('live-dot')?.classList.remove('visible'); } });
        video.addEventListener('play',     () => { const b = $('vc-play'); if (b) b.textContent = '⏸'; });
        video.addEventListener('pause',    () => { const b = $('vc-play'); if (b) b.textContent = '▶'; });
        video.addEventListener('dblclick', toggleFullscreen);
    }

    // ── Raccourcis clavier ────────────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        if (e.key === '/') { e.preventDefault(); $('search')?.focus(); return; }
        const v = $('video');
        switch (e.key) {
            case ' ':           e.preventDefault(); v?.paused ? v.play() : v?.pause(); break;
            case 'f': case 'F': toggleFullscreen(); break;
            case 'm': case 'M': $('vc-mute')?.click(); break;
            case 's': case 'S': $('btn-sidebar-toggle')?.click(); break;
            case 'v': case 'V': playInVlc(); break;
            case 'ArrowUp':     e.preventDefault(); navigateChannel(-1); break;
            case 'ArrowDown':   e.preventDefault(); navigateChannel(1); break;
            case 'ArrowLeft':   if (isSeekableContent() && v) { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); } break;
            case 'ArrowRight':  if (isSeekableContent() && v) { e.preventDefault(); v.currentTime = Math.min(v.duration || v.currentTime + 10, v.currentTime + 10); } break;
            case 'Escape':      if (document.fullscreenElement) document.exitFullscreen(); break;
            case 't': case 'T':
                const isTv = document.body.classList.toggle('tv-mode');
                document.body.classList.toggle('sidebar-collapsed', isTv);
                if (!isTv) $('sidebar-backdrop')?.classList.remove('hidden');
                else $('sidebar-backdrop')?.classList.add('hidden');
                break;
            case 'h': case 'H': goToWelcome(); break;
        }
    });

    // ── Chargement initial ────────────────────────────────────────────────────────
    await refreshProfilesList();
    await renderWelcomeProfiles();

    document.body.classList.add('on-welcome');
    const lastProfileId = localStorage.getItem('lastProfileId');
    if (lastProfileId) {
        try {
            await loadProfile(lastProfileId);
            $('welcome-screen')?.classList.add('hidden');
            document.body.classList.remove('on-welcome');
        } catch (_) {}
    }
});