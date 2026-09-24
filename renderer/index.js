/**
 * SMV Player — renderer/index.js
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// PLATEFORME
// ═══════════════════════════════════════════════════════════════════════════════

// Toutes les données passent par le serveur SMV (renderer/api.js) :
// la même interface tourne dans Electron et dans Safari sur iPhone.
const api = window.smvApi;
const IS_ELECTRON = !!window.electronAPI?.isElectron;
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const IS_STANDALONE = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const mobileLayout = window.matchMedia('(max-width: 820px), (pointer: coarse) and (max-height: 500px) and (orientation: landscape)');

const PLAYBACK_MODE_KEY = 'smv_playback_mode';
const RENDER_CHUNK = 150;

function getPlaybackMode() {
    return localStorage.getItem(PLAYBACK_MODE_KEY) || 'auto';
}

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
    playback: null,           // session de lecture côté serveur (proxy / HLS)
    playEngine: null,         // moteur en cours : mpegts | hlsjs | native
    playSource: null,         // direct (flux proxifié) | hls (transcodage serveur)
    preferServerHls: false,   // le direct a échoué pour cette chaîne
    attemptId: 0,
    failCurrent: null,
    lastError: '',            // dernière erreur du lecteur (affichée après les tentatives)
    streamUrl: '',            // URL amont complète du flux en cours
    playToken: 0,             // annule les lectures devenues obsolètes (zapping rapide)
    renderLimit: RENDER_CHUNK,
    profileHasPin: false,
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
    const n = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * pct);
    const c = (v) => Math.min(255, Math.max(0, v));
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
    document.body.style.setProperty('--profile-color', color);
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

async function addToHistory(ch) {
    // Dédupliquer — retirer si déjà présent
    state.history = state.history.filter((h) => getChannelKey(h) !== getChannelKey(ch));
    // Ajouter en tête
    state.history.unshift({
        id: ch.id,
        name: ch.name,
        logo: ch.logo || '',
        group: ch.group,
        contentType: ch.contentType || 'live',
        cmd: ch.cmd,
        number: ch.number || '',
    });
    // Limiter à HISTORY_MAX
    if (state.history.length > HISTORY_MAX) state.history = state.history.slice(0, HISTORY_MAX);
    if (state.currentProfileId) {
        api.profileUpdate({
            id: state.currentProfileId,
            history: state.history
        }).catch(() => {
        });
    }

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
        ...live.map((item, i) => ({
            ...item,
            contentType: 'live',
            number: item.number || i + 1,
            group: item.group || 'Live'
        })),
        ...vod.map((item) => ({...item, contentType: 'vod', number: '', group: `VOD • ${item.category || 'Films'}`})),
        ...series.map((item) => ({
            ...item,
            contentType: 'series',
            number: '',
            group: `SERIES • ${item.category || 'Series'}`,
            isSeries: item.isSeries ?? true,
            seriesId: item.seriesId || item.id
        })),
    ];
}

function getEpisodeLabel(item, fallbackIndex = 0) {
    const season = toIntOrNull(item.season_num ?? item.season_number ?? item.season ?? item.season_id);
    const episode = toIntOrNull(item.episode_num ?? item.episode_number ?? item.series_number ?? item.series ?? item.number ?? item.sort_num) ?? fallbackIndex + 1;
    const title = item.name || item.title || item.episode_name || `Episode ${episode}`;
    const p = (n) => String(n).padStart(2, '0');
    return season ? `S${p(season)}E${p(episode)} - ${title}` : `E${p(episode)} - ${title}`;
}

function getEpisodeMeta(item, seriesItem) {
    const season = toIntOrNull(item.season_num ?? item.season_number ?? item.season ?? item.season_id);
    const episode = toIntOrNull(item.episode_num ?? item.episode_number ?? item.series_number ?? item.series ?? item.number ?? item.sort_num);
    const parts = [];
    if (season) parts.push(`Saison ${season}`);
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
    const key = getChannelKey(ch);
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

    const res = await api.profileUpdate({
        id: state.currentProfileId,
        favoriteChannelIds: state.favoriteChannelIds,
    }).catch(() => null);
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

    if (kbps >= 4000) {
        label = `${(kbps / 1000).toFixed(1)} Mbps · HD`;
        cls = 'quality-hd';
    } else if (kbps >= 1500) {
        label = `${(kbps / 1000).toFixed(1)} Mbps`;
        cls = 'quality-sd';
    } else if (kbps > 0) {
        label = `${kbps} kbps · Faible`;
        cls = 'quality-low';
    } else {
        label = '';
        cls = '';
    }

    el.textContent = label;
    el.className = `quality-indicator ${cls}`;
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
    const video = $('video');
    const seekBar = $('vc-seek');
    if (!video) return;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const durEl = $('vc-duration');
    if (durEl) durEl.textContent = formatTime(duration);
    if (!state.isSeekDragging) {
        const curEl = $('vc-current-time');
        if (curEl) curEl.textContent = formatTime(current);
        if (seekBar) seekBar.value = duration ? String(Math.min(1000, Math.round((current / duration) * 1000))) : '0';
    }
}

function getVideoError(err) {
    if (!err) return 'Erreur inconnue';
    return {
        1: 'Lecture interrompue',
        2: 'Erreur réseau',
        3: 'Erreur de décodage',
        4: 'Format non supporté'
    }[err.code] || err.message || 'Erreur inconnue';
}

function hideTapToPlay() {
    $('tap-to-play')?.classList.add('hidden');
}

// Safari iOS refuse la lecture non déclenchée par un geste : bouton ▶ à toucher
function showTapToPlay() {
    hideLoading();
    const video = $('video');
    if (video) video.style.opacity = '1';
    $('tap-to-play')?.classList.remove('hidden');
}

// Débloque l'élément vidéo pendant le geste utilisateur (les lectures suivantes,
// lancées après des appels réseau, sont alors autorisées par Safari)
function unlockVideo() {
    const video = $('video');
    if (!IS_TOUCH || !video || video.dataset.unlocked) return;
    // Hors geste (lecture automatique) le déblocage ne compterait pas
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    video.dataset.unlocked = '1';
    try {
        video.play()?.catch?.(() => {
        });
    } catch (_) {
    }
}

function teardownEngine() {
    resetQualityIndicator();
    updateProgressVisibility(false);
    hideTapToPlay();
    state.failCurrent = null;
    const seekBar = $('vc-seek');
    const currentTime = $('vc-current-time');
    const duration = $('vc-duration');
    if (seekBar) seekBar.value = '0';
    if (currentTime) currentTime.textContent = '00:00';
    if (duration) duration.textContent = '00:00';

    if (state.player) {
        try {
            state.player.pause();
            state.player.unload();
            state.player.detachMediaElement();
            state.player.destroy();
        } catch (_) {
        }
        state.player = null;
    }
    if (state.hls) {
        try {
            state.hls.destroy();
        } catch (_) {
        }
        state.hls = null;
    }

    const video = $('video');
    if (video) {
        video.removeAttribute('src');
        video.load();
    }
    state.playEngine = null;
}

function destroyPlayer() {
    teardownEngine();
    // Libère la connexion IPTV / le transcodage côté serveur
    if (state.playback) {
        api.stopPlayback(state.playback.id);
        state.playback = null;
    }
}

function nativeHlsSupported() {
    return !!$('video')?.canPlayType('application/vnd.apple.mpegurl');
}

// iPhone : lecteur HLS natif (AirPlay, PiP, arrière-plan) ; ailleurs hls.js
function hlsEngine() {
    const canHlsJs = typeof Hls !== 'undefined' && Hls.isSupported();
    if (IS_IOS && nativeHlsSupported()) return 'native';
    return canHlsJs ? 'hlsjs' : 'native';
}

/**
 * Choisit l'URL et le moteur selon le type de flux et l'appareil :
 *   PC      → mpegts.js / hls.js / <video> sur le flux proxifié
 *   iPhone  → HLS natif, transcodé par le serveur quand le format l'exige (TS, MKV…)
 */
function choosePlaybackPlan(pb) {
    const mode = getPlaybackMode();
    const canMpegts = typeof mpegts !== 'undefined' && mpegts.isSupported();
    const serverHls = pb.hlsUrl ? {url: pb.hlsUrl, engine: hlsEngine(), source: 'hls'} : null;
    const direct = (engine) => ({url: pb.streamUrl, engine, source: 'direct'});

    if ((mode === 'hls' || state.preferServerHls) && mode !== 'direct' && serverHls) return serverHls;

    switch (pb.kind) {
        case 'hls':
            return direct(hlsEngine());
        case 'mp4':
            return direct('native');
        case 'mpegts':
            if (mode !== 'direct' && IS_IOS && serverHls) return serverHls;
            if (canMpegts) return direct('mpegts');
            return serverHls || direct('native');
        default:
            if (mode !== 'direct' && IS_IOS && serverHls) return serverHls;
            return direct('native');
    }
}

function startPlayer(url, {isLive = true, engine = 'native'} = {}) {
    const video = $('video');
    if (!video) return;
    // URL absolue : mpegts.js et hls.js chargent depuis un Worker (pas de base relative)
    url = new URL(url, location.href).href;

    const attempt = ++state.attemptId;
    state.playEngine = engine;
    video.style.opacity = '0';
    showLoading();
    updateProgressVisibility(!isLive);
    resetQualityIndicator();
    hideTapToPlay();

    let bufferReady = false;
    let bufferTimer = null;

    // Une seule prise en charge d'échec par tentative (plusieurs événements d'erreur possibles)
    const fail = (reason) => {
        if (attempt !== state.attemptId) return;
        if (reason) state.lastError = reason;
        state.attemptId++;
        clearTimeout(bufferTimer);
        handlePlaybackFailure();
    };
    state.failCurrent = fail;

    const onPlayRejected = (err) => {
        if (attempt !== state.attemptId) return;
        if (err?.name === 'NotAllowedError') {
            showTapToPlay();
            return;
        }
        if (err?.name === 'AbortError') return;
        fail(err?.message || err?.name);
    };

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

    // mpegts (flux TS) — on écoute aussi STATISTICS_INFO pour le bitrate
    if (engine === 'mpegts') {
        state.player = mpegts.createPlayer(
            {type: 'mpegts', url, isLive},
            {
                enableWorker: true,
                liveBufferLatencyChasing: false,
                liveBufferLatencyMaxLatency: 8,
                liveBufferLatencyMinRemain: 5,
                autoCleanupSourceBuffer: true
            }
        );
        state.player.attachMediaElement(video);
        state.player.load();
        state.player.on(mpegts.Events.STATISTICS_INFO, (info) => {
            if (info.decodedFrames > 0) onBufferReady();
            updateQualityIndicator(info);
        });
        state.player.on(mpegts.Events.ERROR, (type, details, info) => {
            console.warn('[mpegts.js]', type, details, info);
            fail(info?.code > 0 ? `HTTP ${info.code}` : info?.msg || details || type);
        });
        const played = state.player.play();
        played?.catch?.(onPlayRejected);
        return;
    }

    // HLS
    if (engine === 'hlsjs') {
        state.hls = new Hls({enableWorker: true, lowLatencyMode: false});
        state.hls.loadSource(url);
        state.hls.attachMedia(video);
        state.hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(onPlayRejected));
        state.hls.on(Hls.Events.ERROR, (_, data) => {
            if (!data?.fatal) return;
            console.warn('[hls.js]', data.type, data.details, data.response?.code || '');
            fail(data.response?.code ? `HTTP ${data.response.code}` : data.details);
        });
        // Bitrate HLS via FRAG_CHANGED
        state.hls.on(Hls.Events.FRAG_CHANGED, () => {
            const bw = state.hls?.bandwidthEstimate;
            if (bw) updateQualityIndicator({speed: bw});
        });
    } else {
        video.src = url;
        video.play().catch(onPlayRejected);
    }

    video.addEventListener('canplaythrough', function onReady() {
        video.removeEventListener('canplaythrough', onReady);
        onBufferReady();
    }, {once: true});
}

// Échec du moteur : on tente d'abord le transcodage HLS du serveur, puis on relance
function handlePlaybackFailure() {
    const pb = state.playback;
    // Flux refusé par le serveur (HTTP 4xx/5xx) : le transcodage échouerait de la même façon
    const refused = /^HTTP [45]\d\d$/.test(state.lastError);
    if (pb?.hlsUrl && !refused && state.playSource !== 'hls' && getPlaybackMode() !== 'direct') {
        state.preferServerHls = true;
        state.playSource = 'hls';
        toast('🔁 Mode compatibilité : transcodage du flux…');
        const isLive = !isSeekableContent();
        teardownEngine();
        startPlayer(pb.hlsUrl, {isLive, engine: hlsEngine()});
        return;
    }
    retryPlay();
}

function retryPlay() {
    state.retryCount++;
    if (state.retryCount <= 3) {
        const token = state.playToken;
        setTimeout(() => {
            if (state.currentChannel && token === state.playToken) playChannel(state.currentChannel, {isRetry: true});
        }, 2000);
    } else {
        const video = $('video');
        if (video) video.style.opacity = '1';
        const reason = state.lastError ? ` (${state.lastError})` : '';
        const isHttpError = /^HTTP \d+/.test(state.lastError);
        const hint = !isHttpError && state.playback?.hlsUrl && state.config?.hlsVideoMode !== 'h264'
            ? ' — essayez « Réencodage H.264 » dans Paramètres › Lecture'
            : '';
        showError(`Impossible de lire le flux après 3 tentatives${reason}${hint}`);
    }
}

async function playChannel(ch, {isRetry = false} = {}) {
    unlockVideo();
    destroyPlayer();
    const token = ++state.playToken;
    state.currentChannel = ch;
    if (!isRetry) {
        state.retryCount = 0;
        state.preferServerHls = false;
        state.lastError = '';
    }
    localStorage.setItem('lastChannelId', getChannelKey(ch));

    // Ajouter à l'historique (sans bloquer le démarrage du flux)
    if (!isRetry) addToHistory(ch).catch(() => {
    });

    const nowName = $('now-name');
    const nowGroup = $('now-group');
    if (nowName) nowName.textContent = ch.name;
    if (nowGroup) nowGroup.textContent = ch.group;
    $('live-dot')?.classList.remove('visible');

    const video = $('video');
    if (video) video.style.opacity = '0';
    showLoading();
    $('video-controls')?.classList.remove('hidden');
    renderChannels();

    $('channel-list')?.querySelector('.ch-item.playing')?.scrollIntoView({block: 'nearest', behavior: 'smooth'});

    let streamUrl = ch.cmd;
    let headers = ch.headers || (state.stalkerSession?.stalkerHeaders ? JSON.parse(state.stalkerSession.stalkerHeaders) : {});

    if (state.stalkerSession && ch.cmd && !ch.cmd.startsWith('http')) {
        try {
            const res = await api.stalkerGetStream({
                serverBase: state.stalkerSession.serverBase, mac: state.stalkerSession.mac,
                token: state.stalkerSession.token, cmd: ch.cmd,
                stalkerHeadersJson: state.stalkerSession.stalkerHeaders,
                contentType: ch.contentType, seriesIndex: ch.seriesIndex,
                episodeId: ch.episodeId, containerExtension: ch.containerExtension,
            });
            if (token !== state.playToken) return;
            if (!res.success) {
                if (video) video.style.opacity = '1';
                showError(res.error || 'Impossible de lire le flux');
                return;
            }
            streamUrl = res.url;
            if (res.headers) headers = res.headers;
            if (res.token && res.token !== state.stalkerSession.token) {
                state.stalkerSession.token = res.token;
                if (state.currentProfileId) {
                    api.profileUpdate({
                        id: state.currentProfileId,
                        stalkerSession: {...state.stalkerSession, token: res.token},
                    }).catch(() => {
                    });
                }
            }
        } catch (err) {
            if (token !== state.playToken) return;
            if (video) video.style.opacity = '1';
            showError(err.message);
            return;
        }
    }

    if (!streamUrl) {
        if (video) video.style.opacity = '1';
        showError('URL du flux vide');
        return;
    }

    state.streamUrl = streamUrl;
    const siUrl = $('si-url');
    if (siUrl) siUrl.textContent = streamUrl.length > 60 ? streamUrl.slice(0, 60) + '…' : streamUrl;
    $('stream-info')?.classList.remove('hidden');

    const isVodLike = ch.contentType === 'vod' || ch.contentType === 'series';
    try {
        const pb = await api.createPlayback({url: streamUrl, headers, contentType: isVodLike ? ch.contentType : 'live'});
        if (!pb?.success) throw new Error(pb?.error || 'Lecture impossible');
        if (token !== state.playToken) {
            api.stopPlayback(pb.id);
            return;
        }
        state.playback = pb;
        const plan = choosePlaybackPlan(pb);
        state.playSource = plan.source;
        startPlayer(plan.url, {isLive: !isVodLike, engine: plan.engine});
    } catch (err) {
        if (token !== state.playToken) return;
        if (video) video.style.opacity = '1';
        showError(err.message);
    }
}

// Ouvrir dans VLC (PC : lance VLC ; iPhone : app VLC via x-callback)
async function playInVlc() {
    if (!state.currentChannel || !state.playback) return toast('⚠️ Aucune chaîne en cours de lecture');
    const url = new URL(state.playback.streamUrl, location.origin).href;

    if (IS_ELECTRON) {
        const res = await window.electronAPI.vlcPlay({url});
        if (res?.success) {
            toast('▶ Ouvert dans VLC');
        } else {
            toast(`${res?.error || 'VLC introuvable — configurez le chemin dans les paramètres'}`);
        }
        return;
    }

    $('video')?.pause();
    if (IS_IOS) {
        window.location.href = `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`;
        return;
    }
    if (/Android/i.test(navigator.userAgent)) {
        window.location.href = `vlc://${url}`;
        return;
    }
    try {
        await navigator.clipboard.writeText(url);
        toast('📋 Lien copié — VLC : Média → Ouvrir un flux réseau');
    } catch (_) {
        prompt('Lien du flux pour VLC', url);
    }
}

function navigateChannel(dir) {
    if (!state.filtered.length) return;
    const idx = state.filtered.findIndex((c) => getChannelKey(c) === getChannelKey(state.currentChannel));
    const next = (idx + dir + state.filtered.length) % state.filtered.length;
    playChannel(state.filtered[next]);
}

function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
    const wrap = $('video-wrap');
    const video = $('video');
    if (isFullscreen()) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
        return;
    }
    const request = wrap?.requestFullscreen || wrap?.webkitRequestFullscreen;
    if (request) {
        try {
            const res = request.call(wrap);
            res?.catch?.(() => toast('❌ Plein écran non disponible'));
        } catch (_) {
            toast('❌ Plein écran non disponible');
        }
        return;
    }
    // iPhone : seul l'élément vidéo peut passer en plein écran (lecteur natif)
    if (video?.webkitEnterFullscreen) {
        try {
            video.webkitEnterFullscreen();
        } catch (_) {
            toast('❌ Plein écran non disponible');
        }
        return;
    }
    toast('❌ Plein écran non disponible');
}

async function togglePip() {
    const video = $('video');
    if (!video) return;
    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
            return;
        }
        if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
            await video.requestPictureInPicture();
            return;
        }
        if (video.webkitSupportsPresentationMode?.('picture-in-picture')) {
            const inPip = video.webkitPresentationMode === 'picture-in-picture';
            video.webkitSetPresentationMode(inPip ? 'inline' : 'picture-in-picture');
            return;
        }
        throw new Error('PiP');
    } catch (_) {
        toast('❌ PiP non disponible');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI — RENDU CHAÎNES, GROUPES, MODES
// ═══════════════════════════════════════════════════════════════════════════════

function buildChannelItem(ch, currentKey) {
    const isPlaying = currentKey === getChannelKey(ch);
    const isFav = isFavorite(ch);

    const div = document.createElement('div');
    div.className = ['ch-item', isPlaying && 'playing', isFav && 'favorite'].filter(Boolean).join(' ');

    const logoHtml = ch.logo
        ? `<img class="ch-logo" src="${escHtml(ch.logo)}" alt="" loading="lazy">`
        : '<div class="ch-logo-placeholder">📺</div>';

    div.innerHTML = `
      <span class="ch-num">${ch.number || ''}</span>
      ${logoHtml}
      <div class="ch-info">
        <div class="ch-name">${escHtml(ch.name)}</div>
        <div class="ch-group">${escHtml(ch.group)}</div>
      </div>
      ${isPlaying ? '<span class="ch-play-icon">▶</span>' : ''}`;

    // Logo introuvable → pictogramme (pas de gestionnaire inline : CSP)
    div.querySelector('.ch-logo')?.addEventListener('error', function () {
        this.outerHTML = '<div class="ch-logo-placeholder">📺</div>';
    }, {once: true});

    div.addEventListener('click', () => {
        if (state.currentMode === 'series' && ch.isSeries) {
            openSeriesEpisodes(ch);
            return;
        }
        playChannel(ch);
    });

    const favBtn = document.createElement('button');
    favBtn.className = `ch-fav-btn${isFav ? ' active' : ''}`;
    favBtn.type = 'button';
    favBtn.title = 'Favori';
    favBtn.textContent = isFav ? '★' : '☆';
    favBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await toggleFavorite(ch);
    });
    div.appendChild(favBtn);
    return div;
}

// Rendu progressif : des milliers d'éléments d'un coup figeraient l'iPhone
let sentinelObserver = null;

function appendChannelItems(channelList, from) {
    const list = state.filtered;
    const currentKey = getChannelKey(state.currentChannel);
    const frag = document.createDocumentFragment();
    const to = Math.min(list.length, state.renderLimit);
    for (let i = from; i < to; i++) frag.appendChild(buildChannelItem(list[i], currentKey));

    channelList.querySelector('.virtual-sentinel')?.remove();
    channelList.appendChild(frag);

    sentinelObserver?.disconnect();
    if (to < list.length) {
        const sentinel = document.createElement('div');
        sentinel.className = 'virtual-sentinel';
        sentinel.textContent = `${to} / ${list.length} — faites défiler pour la suite`;
        channelList.appendChild(sentinel);
        sentinelObserver = new IntersectionObserver((entries) => {
            if (!entries.some((e) => e.isIntersecting)) return;
            const rendered = state.renderLimit;
            state.renderLimit += RENDER_CHUNK * 2;
            appendChannelItems(channelList, rendered);
        }, {root: channelList, rootMargin: '800px 0px'});
        sentinelObserver.observe(sentinel);
    }
}

function renderChannels() {
    const channelList = $('channel-list');
    if (!channelList) return;

    const list = state.filtered;
    sentinelObserver?.disconnect();

    if (!list.length) {
        channelList.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><p>Aucune chaîne trouvée</p></div>`;
        return;
    }

    // L'élément en lecture doit être rendu pour pouvoir y défiler
    const currentKey = getChannelKey(state.currentChannel);
    const playingIdx = state.currentChannel ? list.findIndex((c) => getChannelKey(c) === currentKey) : -1;
    if (playingIdx >= state.renderLimit) {
        state.renderLimit = Math.ceil((playingIdx + 1) / RENDER_CHUNK) * RENDER_CHUNK;
    }

    const scrollTop = channelList.scrollTop;
    channelList.innerHTML = '';
    appendChannelItems(channelList, 0);
    channelList.scrollTop = scrollTop;
}

function filterAndRender() {
    const query = ($('search')?.value || '').toLowerCase().trim();
    let list = state.channels;

    switch (state.currentMode) {
        case 'favorites':
            list = list.filter(isFavorite);
            break;
        case 'history':
            list = state.history;
            break;
        case 'live':
            list = list.filter((c) => c.contentType !== 'vod' && c.contentType !== 'series');
            if (state.currentGroup !== 'all') list = list.filter((c) => c.group === state.currentGroup);
            break;
        case 'vod':
            list = list.filter((c) => c.contentType === 'vod');
            break;
        case 'series':
            list = list.filter((c) => c.contentType === 'series' && c.isSeries);
            break;
        case 'series-episodes':
            list = state.seriesEpisodes;
            break;
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
    state.renderLimit = RENDER_CHUNK;
    const channelList = $('channel-list');
    if (channelList) channelList.scrollTop = 0;
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

    const liveItems = channels.filter((c) => c.contentType !== 'vod' && c.contentType !== 'series');
    const groups = [...new Set(liveItems.map((c) => c.group))].sort();
    const favoritesCount = channels.filter(isFavorite).length;

    const makeChip = (label, count, group, active = false) => {
        const btn = document.createElement('button');
        btn.className = `g-chip${active ? ' active' : ''}`;
        if (group) btn.dataset.group = group;
        btn.innerHTML = `<span>${label}</span><span class="g-count">${count}</span>`;
        btn.addEventListener('click', () => selectGroup(group || 'all'));
        return btn;
    };

    groupBar.appendChild(makeChip('📺 Tous', channels.length, '', true));
    groupBar.appendChild(makeChip('⭐ Favoris', favoritesCount, 'favorites'));
    groupBar.appendChild(makeChip('🕐 Récents', state.history.length, 'history'));
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

function loadChannels(channels, {autoPlay = true} = {}) {
    state.channels = channels;
    state.currentGroup = 'all';
    state.currentMode = 'live';
    state.seriesEpisodes = [];
    state.seriesStack = [];

    syncFavoritesToChannels(channels);
    buildGroupBar(channels);
    document.body.classList.remove('sources-open');

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
    if (!state.stalkerSession) {
        toast('⚠️ Connexion Stalker requise');
        return;
    }
    try {
        const res = await api.stalkerSeriesEpisodes({
            serverBase: state.stalkerSession.serverBase, mac: state.stalkerSession.mac,
            token: state.stalkerSession.token, seriesId: seriesItem.seriesId || seriesItem.id,
            stalkerHeadersJson: state.stalkerSession.stalkerHeaders,
        });
        if (!res.success) {
            toast(`❌ ${res.error || 'Impossible de charger la série'}`);
            return;
        }
        state.seriesStack.push(state.seriesEpisodes);
        state.seriesEpisodes = normalizeEpisodes(res.items || [], seriesItem);
        setMode('series-episodes');
    } catch (err) {
        toast(`❌ ${err.message}`);
    }
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
    const profiles = await api.profilesList();
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
        const meta = p.type === 'stalker' ? `${p.portalUrl} · ${p.mac}` : (p.m3uUrl ? 'Liste M3U (URL)' : 'Fichier M3U');
        const accent =
            p.settings?.accentColor || '#6c5ce7';

        const hasPin =
            !!p.settings?.hasPin;
        const dateStr = new Date(p.updatedAt || p.createdAt).toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: '2-digit',
            year: '2-digit'
        });

        item.innerHTML = `
      <div
         class="profile-avatar"
         style="background:${accent}"
        >
         ${escHtml(p.name.charAt(0).toUpperCase())}
        </div>
        ${hasPin
            ? '<span class="profile-pin">🔒 Protégé</span>'
            : ''
        }
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

        item.addEventListener('click', (e) => {
            if (!e.target.closest('.profile-actions')) loadProfile(p.id);
        });
        frag.appendChild(item);
    }

    container.innerHTML = '';
    container.appendChild(frag);

    container.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const {action, id, type} = btn.dataset;
            if (action === 'delete') {
                if (!confirm('Supprimer ce profil ?')) return;
                await api.profileDelete(id);
                if (state.currentProfileId === id) {
                    state.currentProfileId = null;
                    state.channels = [];
                    const cl = $('channel-list');
                    if (cl) cl.innerHTML = '<div class="empty">Chargez un profil</div>';
                }
                await refreshProfilesList();
                return toast('🗑️ Profil supprimé');
            }
            const result = await openProfileWithPin(id).catch((err) => {
                toast(`❌ ${err.message}`);
                return null;
            });
            if (!result?.success) return;
            if (action === 'edit') openEditProfileModal(result.profile);
            if (action === 'refresh') refreshProfile(result.profile, type);
        });
    });
}

// Saisie du PIN (window.prompt n'existe pas dans Electron)
function askPin(profileName) {
    return new Promise((resolve) => {
        const modal = $('pin-modal');
        const form = $('pin-form');
        const input = $('pin-input');
        const closeBtn = $('close-pin');
        if (!modal || !form || !input) {
            resolve(null);
            return;
        }
        const label = $('pin-label');
        if (label) label.textContent = profileName ? `PIN requis pour « ${profileName} »` : 'PIN requis pour ce profil';
        input.value = '';
        modal.classList.remove('hidden');
        setTimeout(() => input.focus(), 50);

        const close = (value) => {
            modal.classList.add('hidden');
            form.removeEventListener('submit', onSubmit);
            closeBtn?.removeEventListener('click', onCancel);
            resolve(value);
        };
        const onSubmit = (e) => {
            e.preventDefault();
            close(input.value);
        };
        const onCancel = () => close(null);
        form.addEventListener('submit', onSubmit);
        closeBtn?.addEventListener('click', onCancel);
    });
}

// Demande le PIN parental si besoin — la vérification est faite par le serveur
async function openProfileWithPin(profileId) {
    let result = await api.profileLoad(profileId);
    if (result?.pinRequired) {
        const entered = await askPin(result.name);
        if (entered === null) throw new Error('PIN requis');
        result = await api.profileLoad(profileId, entered);
        if (result?.pinRequired) throw new Error('PIN incorrect');
    }
    if (!result?.success) throw new Error(result?.error || 'Profil introuvable');
    return result;
}

function applyProfileSettings(profile) {
    const color = profile.settings?.accentColor;
    if (color) {
        applyAccentColor(color);
        const picker = $('cfg-accent');
        if (picker) picker.value = color;
    }
    state.profileHasPin = !!profile.settings?.hasPin;
    const pinInput = $('cfg-pin');
    if (pinInput) {
        pinInput.value = '';
        pinInput.placeholder = state.profileHasPin ? 'PIN défini — laisser vide pour le conserver' : 'PIN parental';
    }
    $('btn-remove-pin')?.classList.toggle('hidden', !state.profileHasPin);
}

async function fetchLibrary(profile, onProgress) {
    if (profile.type === 'm3u') {
        if (!profile.m3uUrl) throw new Error('Rechargez le fichier M3U manuellement');
        const res = await api.m3uFetch(profile.m3uUrl, onProgress);
        if (!res?.success) throw new Error(res?.error || 'Liste M3U inaccessible');
        return {session: null, items: buildLibraryItems(res.channels, res.vod, res.series)};
    }
    const res = await api.stalkerConnect({portalUrl: profile.portalUrl, mac: profile.mac}, onProgress);
    if (!res?.success) throw new Error(res?.error || 'Connexion impossible');
    const session = {token: res.token, serverBase: res.serverBase, mac: res.mac, stalkerHeaders: res.stalkerHeaders};
    return {session, items: buildLibraryItems(res.channels, res.vod, res.series)};
}

const progressToast = (p) => toast(`⏳ ${p?.message || 'Chargement…'}`, 60000);

async function loadProfile(profileId) {
    const result = await openProfileWithPin(profileId);
    const profile = result.profile;

    state.currentProfileId = profile.id;
    state.stalkerSession = profile.stalkerSession || null;
    state.favoriteChannelIds = (profile.favoriteChannelIds || []).map(String);
    state.history = Array.isArray(profile.history) ? profile.history : [];
    localStorage.setItem('lastProfileId', profile.id);
    document.body.classList.remove('on-welcome');
    applyProfileSettings(profile);

    const puInput = $('portal-url');
    const pmInput = $('portal-mac');
    const m3uInput = $('m3u-url');
    if (puInput) puInput.value = profile.portalUrl || '';
    if (pmInput) pmInput.value = profile.mac || '';
    if (m3uInput) m3uInput.value = profile.m3uUrl || '';
    if (profile.m3uUrl) $('m3u-details')?.setAttribute('open', '');

    const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
    const cacheAge = Date.now() - new Date(profile.updatedAt || 0).getTime();
    const cacheValid = profile.channels?.length && cacheAge < CACHE_MAX_AGE;
    const cacheExpired = profile.channels?.length && cacheAge >= CACHE_MAX_AGE;
    const canReload = (profile.type === 'stalker' && profile.portalUrl && profile.mac)
        || (profile.type === 'm3u' && profile.m3uUrl);

    if (cacheValid || (profile.channels?.length && !canReload)) {
        loadChannels(profile.channels, {autoPlay: false});
        setConnInfo(`📁 ${profile.name} (cache)`, profile.channels.length);
        toast('⚡ Chargement instantané');
        await refreshProfilesList();
        return;
    }

    if (cacheExpired) toast('⚠️ Cache expiré, reconnexion…');

    if (canReload) {
        toast(profile.type === 'm3u' ? '⏳ Téléchargement de la liste…' : '⏳ Connexion au portail…', 60000);
        const {session, items} = await fetchLibrary(profile, progressToast);
        state.stalkerSession = session;
        loadChannels(items);
        setConnInfo(`📁 ${profile.name}`, items.length);
        toast(`✅ Profil chargé (${items.length} éléments)`);
        api.profileUpdate({
            id: profile.id,
            channels: items,
            ...(session ? {stalkerSession: session} : {}),
            favoriteChannelIds: state.favoriteChannelIds,
        }).catch(() => {
        });
    }

    await refreshProfilesList();
}

async function refreshProfile(profile, type) {
    const savedFavIds = (profile.favoriteChannelIds || []).map(String);

    if (type === 'stalker' ? !profile.portalUrl || !profile.mac : !profile.m3uUrl)
        return toast('ℹ️ Rechargez le fichier M3U manuellement');

    toast('🔄 Rafraîchissement en cours…', 60000);
    state.favoriteChannelIds = savedFavIds;

    let refreshed;
    try {
        refreshed = await fetchLibrary(profile, progressToast);
        await api.profileUpdate({
            id: profile.id,
            channels: refreshed.items,
            ...(refreshed.session ? {stalkerSession: refreshed.session} : {}),
            favoriteChannelIds: state.favoriteChannelIds,
        });
    } catch (err) {
        return toast(`❌ ${err.message}`);
    }

    state.stalkerSession = refreshed.session;
    state.currentProfileId = profile.id;
    state.favoriteChannelIds = savedFavIds;
    state.history = Array.isArray(profile.history) ? profile.history : state.history;
    applyProfileSettings(profile);
    loadChannels(refreshed.items);
    setConnInfo(`📁 ${profile.name}`, refreshed.items.length);
    toast(`✅ Cache mis à jour (${refreshed.items.length} éléments)`);
    await refreshProfilesList();
}

async function renderWelcomeProfiles() {
    const grid = $('welcome-profiles-grid');
    const count = $('welcome-profiles-count');
    if (!grid || !count) return;

    const profiles = await api.profilesList();
    count.textContent = String(profiles.length);

    if (!profiles.length) {
        grid.innerHTML = '<div class="welcome-empty">Aucun profil enregistré</div>';
        return;
    }

    const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    grid.innerHTML = profiles.map((p, i) => {
        const cacheAge = now - new Date(p.updatedAt || 0).getTime();
        const hasCache = p.channelCount > 0;
        const cacheExpired = hasCache && cacheAge >= CACHE_MAX_AGE;
        const badge = cacheExpired
            ? `<div class="welcome-profile-badge badge-expired">Cache expiré</div>`
            : `<div class="welcome-profile-badge">Profil</div>`;
        return `
                <button class="welcome-profile-card" data-profile-id="${p.id}" type="button">
                  <div class="welcome-profile-top">
                    <div
              class="welcome-profile-avatar"
              style="background:${p.settings?.accentColor || '#6c5ce7'}"
            >
              ${escHtml((p.name || '?').charAt(0).toUpperCase())}
            </div>
            ${p.settings?.hasPin
                        ? '<div class="welcome-profile-lock">🔒</div>'
                        : ''
                    }
        ${badge}
      </div>
      <div class="welcome-profile-name">${escHtml(p.name || `Profil ${i + 1}`)}</div>
      <div class="welcome-profile-meta">${escHtml(p.type === 'm3u' ? 'Liste M3U' : (p.portalUrl || 'Portail non défini'))}</div>
      <div class="welcome-profile-submeta">${escHtml(p.type === 'm3u' ? (p.m3uUrl || 'Fichier importé') : (p.mac || 'MAC non définie'))}</div>
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
        card.disabled = true;
        card.classList.add('loading');
        if (openEl) openEl.textContent = 'Connexion…';
        if (iconEl) iconEl.textContent = '⏳';
    } else {
        card.disabled = false;
        card.classList.remove('loading');
        if (openEl) openEl.textContent = 'Ouvrir ce profil →';
        if (iconEl) iconEl.textContent = '📁';
    }
}

function goToWelcome() {
    if (state.currentChannel && !confirm('Quitter la lecture en cours ?')) return;
    destroyPlayer();
    state.currentChannel = null;
    state.channels = [];
    state.filtered = [];
    const cl = $('channel-list');
    if (cl) cl.innerHTML = '';
    const nowName = $('now-name');
    const nowGroup = $('now-group');
    if (nowName) nowName.textContent = '—';
    if (nowGroup) nowGroup.textContent = '';
    $('conn-info')?.classList.add('hidden');
    $('welcome-screen')?.classList.remove('hidden');
    document.body.classList.add('on-welcome');
    renderWelcomeProfiles();
}

function openEditProfileModal(profile) {
    state.renameProfileId = profile.id;
    const nameEl = $('edit-name');
    const urlEl = $('edit-url');
    const macEl = $('edit-mac');
    if (nameEl) nameEl.value = profile.name || '';
    if (urlEl) urlEl.value = profile.portalUrl || '';
    if (macEl) macEl.value = profile.mac || '';
    $('edit-profile-modal')?.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMÈTRES
// ═══════════════════════════════════════════════════════════════════════════════

function setFieldValue(id, val) {
    const el = $(id);
    if (el) el.value = val ?? '';
}

function fillConfigForm(cfg = {}) {
    setFieldValue('cfg-ua', cfg.userAgent);
    setFieldValue('cfg-timeout', cfg.networkTimeout ?? 60);
    setFieldValue('cfg-referrer', cfg.referrer);
    setFieldValue('cfg-headers', cfg.headerFields);
    setFieldValue('cfg-proxy', cfg.httpProxy);
    setFieldValue('cfg-vlc', cfg.vlcPath);
    setFieldValue('cfg-ffmpeg', cfg.ffmpegPath);
    setFieldValue('cfg-hls-video', cfg.hlsVideoMode || 'copy');
    setFieldValue('cfg-playback-mode', getPlaybackMode());
    const remote = $('cfg-remote');
    if (remote) remote.checked = !!cfg.remoteAccess;
    const tray = $('cfg-tray');
    if (tray) tray.checked = !!cfg.keepRunningInTray;
}

// QR code + adresse à ouvrir sur l'iPhone
async function refreshPairingInfo() {
    const qr = $('pair-qr');
    const urlInput = $('pair-url');
    const keyEl = $('pair-key');
    const ffmpegEl = $('pair-ffmpeg');
    try {
        const info = await api.serverInfo();
        const first = info.urls?.[0];
        if (qr) {
            qr.classList.toggle('hidden', !first?.qr);
            if (first?.qr) qr.src = first.qr;
        }
        if (urlInput) {
            urlInput.value = first?.url
                || (info.remoteAccess ? 'Aucun réseau local détecté' : 'Accès réseau désactivé');
            urlInput.title = (info.urls || []).map((u) => `${u.name} : ${u.url}`).join('\n');
        }
        if (keyEl) keyEl.textContent = info.accessKey || '—';
        if (ffmpegEl) {
            ffmpegEl.textContent = info.ffmpeg
                ? '✅ Transcodage iPhone disponible (ffmpeg)'
                : '⚠️ ffmpeg introuvable : les flux TS/MKV ne seront pas lisibles sur iPhone';
        }
        $('pair-block')?.classList.toggle('disabled', !info.remoteAccess);
        const proxyStatus = $('proxy-status');
        if (proxyStatus) {
            const sources = {config: 'paramètres', env: 'variables d\'environnement', system: 'proxy système'};
            proxyStatus.textContent = info.proxy?.address
                ? `Proxy utilisé : ${info.proxy.address} (${sources[info.proxy.source] || info.proxy.source})`
                : 'Connexion directe (aucun proxy détecté)';
        }
    } catch (err) {
        if (urlInput) urlInput.value = err.message;
    }
}

function openSettings() {
    fillConfigForm(state.config);
    $('settings-modal')?.classList.remove('hidden');
    document.body.classList.add('settings-open');
    refreshPairingInfo();
}

function closeSettings() {
    $('settings-modal')?.classList.add('hidden');
    document.body.classList.remove('settings-open');
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPAIRAGE (iPhone sans clé d'accès)
// ═══════════════════════════════════════════════════════════════════════════════

function showPairScreen() {
    destroyPlayer();
    $('welcome-screen')?.classList.add('hidden');
    $('pair-screen')?.classList.remove('hidden');
    setTimeout(() => $('pair-code')?.focus(), 100);
}

function setupPairScreen() {
    $('pair-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = ($('pair-code')?.value || '').trim().toUpperCase();
        if (!code) return;
        api.setAccessKey(code);
        if (await api.checkAuth()) {
            // Recharge avec ?key= : l'app ajoutée à l'écran d'accueil démarrera authentifiée
            location.replace(`/?key=${encodeURIComponent(code)}`);
            return;
        }
        $('pair-error')?.classList.remove('hidden');
    });
    window.addEventListener('smv:unauthorized', showPairScreen);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCES M3U
// ═══════════════════════════════════════════════════════════════════════════════

function loadM3uResult(res, {m3uUrl = ''} = {}) {
    if (!res?.success) {
        toast(`❌ ${res?.error || 'Liste M3U invalide'}`);
        return;
    }
    const items = buildLibraryItems(res.channels, res.vod, res.series);
    if (!items.length) {
        toast('⚠️ Aucune chaîne trouvée dans la liste');
        return;
    }
    state.stalkerSession = null;
    state.currentProfileId = null;
    state.favoriteChannelIds = [];
    state.history = [];
    state.saveContext = 'm3u';
    state.saveM3uUrl = m3uUrl;
    loadChannels(items);
    setConnInfo('✅ Liste M3U', items.length);
    $('btn-save-profile')?.classList.remove('hidden');
    toast(`✅ ${items.length} éléments chargés`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALISATION & ÉVÉNEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {

    // ── Plateforme ───────────────────────────────────────────────────────────────
    const bodyCls = document.body.classList;
    bodyCls.toggle('is-electron', IS_ELECTRON);
    bodyCls.toggle('is-web', !IS_ELECTRON);
    bodyCls.toggle('is-ios', IS_IOS);
    bodyCls.toggle('is-touch', IS_TOUCH);
    bodyCls.toggle('is-standalone', IS_STANDALONE);

    // ── Accès au serveur ─────────────────────────────────────────────────────────
    setupPairScreen();
    if (!(await api.checkAuth())) {
        showPairScreen();
        return;
    }

    // ── Config ────────────────────────────────────────────────────────────────────
    state.config = await api.getConfig();
    fillConfigForm(state.config);
    const siUa = $('si-ua');
    if (siUa) siUa.textContent = state.config.userAgent || '';

    const savedColor = localStorage.getItem('accentColor');
    if (savedColor) {
        applyAccentColor(savedColor);
        const accentInp = $('cfg-accent');
        if (accentInp) accentInp.value = savedColor;
    }

    // ── Fenêtre Electron ──────────────────────────────────────────────────────────
    if (IS_ELECTRON) {
        $('btn-minimize')?.addEventListener('click', () => window.electronAPI.windowMinimize());
        $('btn-maximize')?.addEventListener('click', () => window.electronAPI.windowMaximize());
        $('btn-close')?.addEventListener('click', () => window.electronAPI.windowClose());
        window.electronAPI.onWindowStateChanged(({isMaximized}) => {
            const btn = $('btn-maximize');
            if (btn) {
                btn.textContent = isMaximized ? '❐' : '☐';
                btn.title = isMaximized ? 'Restaurer' : 'Agrandir';
            }
        });
        document.querySelector('.titlebar')?.addEventListener('dblclick', (e) => {
            if (!e.target.closest('.titlebar-right')) window.electronAPI.windowMaximize();
        });
    }

    // ── Sidebar ───────────────────────────────────────────────────────────────────
    const backdrop = $('sidebar-backdrop');
    $('btn-sidebar-toggle')?.addEventListener('click', () => {
        // Mobile : la liste reste sous le lecteur, ☰ affiche/masque les sources
        if (mobileLayout.matches) {
            bodyCls.toggle('sources-open');
            return;
        }
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
    const resetSeries = () => {
        state.seriesEpisodes = [];
        state.seriesStack = [];
    };
    $('btn-mode-live')?.addEventListener('click', () => {
        resetSeries();
        setMode('live');
    });
    $('btn-mode-vod')?.addEventListener('click', () => {
        resetSeries();
        setMode('vod');
    });
    $('btn-mode-series')?.addEventListener('click', () => {
        resetSeries();
        setMode('series');
    });
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
    $('settings-modal')?.addEventListener('click', (e) => {
        if (e.target === $('settings-modal')) closeSettings();
    });

    $('save-settings')?.addEventListener('click', async () => {
        const color = $('cfg-accent')?.value || '#6c5ce7';
        applyAccentColor(color);
        localStorage.setItem('accentColor', color);
        localStorage.setItem(PLAYBACK_MODE_KEY, $('cfg-playback-mode')?.value || 'auto');

        const cfg = {
            userAgent: $('cfg-ua')?.value.trim() || '',
            networkTimeout: parseInt($('cfg-timeout')?.value) || 60,
            referrer: $('cfg-referrer')?.value.trim() || '',
            headerFields: $('cfg-headers')?.value.trim() || '',
            httpProxy: $('cfg-proxy')?.value.trim() || '',
            hlsVideoMode: $('cfg-hls-video')?.value || 'copy',
            remoteAccess: !!$('cfg-remote')?.checked,
        };
        if (IS_ELECTRON) {
            cfg.vlcPath = $('cfg-vlc')?.value.trim() || '';
            cfg.ffmpegPath = $('cfg-ffmpeg')?.value.trim() || '';
            cfg.keepRunningInTray = !!$('cfg-tray')?.checked;
        }
        if (!IS_ELECTRON && state.config.remoteAccess && !cfg.remoteAccess
            && !confirm('Cet appareil perdra l\'accès à SMV Player. Continuer ?')) return;

        const wasTray = !!state.config.keepRunningInTray;
        try {
            const updated = await api.updateConfig(cfg);
            if (updated?.success === false) return toast(`❌ ${updated.error}`);
            state.config = updated;
        } catch (err) {
            return toast(`❌ ${err.message}`);
        }
        if (IS_ELECTRON && wasTray !== !!state.config.keepRunningInTray) {
            window.electronAPI.setTrayEnabled(!!state.config.keepRunningInTray);
        }
        const siUaEl = $('si-ua');
        if (siUaEl) siUaEl.textContent = cfg.userAgent;

        const pin = $('cfg-pin')?.value.trim();

        if (state.currentProfileId) {
            // PIN vide = inchangé (le serveur ne renvoie jamais le PIN existant)
            const settings = {accentColor: color};
            if (pin) settings.pin = pin;
            await api.profileUpdate({id: state.currentProfileId, settings}).catch(() => null);
            applyProfileSettings({settings: {accentColor: color, hasPin: state.profileHasPin || !!pin}});
        }
        closeSettings();
        toast('✅ Paramètres sauvegardés');
    });

    $('btn-remove-pin')?.addEventListener('click', async () => {
        if (!state.currentProfileId || !confirm('Supprimer le PIN parental de ce profil ?')) return;
        await api.profileUpdate({id: state.currentProfileId, settings: {pin: ''}}).catch(() => null);
        applyProfileSettings({settings: {accentColor: $('cfg-accent')?.value, hasPin: false}});
        toast('🔓 PIN supprimé');
    });

    const browseInto = async (inputId, title, winExt) => {
        const res = await window.electronAPI?.browseFile({
            title,
            extensions: window.electronAPI.platform === 'win32' ? [winExt] : [],
        });
        if (!res?.success) return;
        setFieldValue(inputId, res.path);
    };
    $('btn-browse-vlc')?.addEventListener('click', () => browseInto('cfg-vlc', 'Choisir VLC', 'exe'));
    $('btn-browse-ffmpeg')?.addEventListener('click', () => browseInto('cfg-ffmpeg', 'Choisir ffmpeg', 'exe'));

    $('cfg-accent')?.addEventListener('input', (e) => applyAccentColor(e.target.value));

    // ── Accès iPhone ─────────────────────────────────────────────────────────────
    $('btn-copy-pair-url')?.addEventListener('click', () => {
        navigator.clipboard?.writeText($('pair-url')?.value || '');
        toast('📋 Adresse copiée');
    });
    $('btn-regen-key')?.addEventListener('click', async () => {
        if (!confirm('Générer un nouveau code ? Les appareils déjà connectés devront scanner le nouveau QR code.')) return;
        const res = await api.regenerateAccessKey().catch(() => null);
        if (!res?.success) return toast('❌ Impossible de générer un code');
        api.setAccessKey(res.accessKey);
        history.replaceState(null, '', `/?key=${encodeURIComponent(res.accessKey)}`);
        await refreshPairingInfo();
        toast('🔑 Nouveau code généré');
    });

    // ── Stalker connect ───────────────────────────────────────────────────────────
    $('btn-connect')?.addEventListener('click', async () => {
        const portalUrl = $('portal-url')?.value.trim();
        const mac = $('portal-mac')?.value.trim();
        if (!portalUrl || !mac) return toast('⚠️ URL et MAC requis');
        if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)) return toast('⚠️ Format MAC invalide');

        const btn = $('btn-connect');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ Connexion…';
        }

        try {
            const res = await api.stalkerConnect({portalUrl, mac}, (p) => {
                if (btn && p?.message) btn.textContent = `⏳ ${p.message}`;
            });
            if (!res.success) {
                toast(`❌ ${res.error}`);
                return;
            }

            state.stalkerSession = {
                token: res.token,
                serverBase: res.serverBase,
                mac: res.mac,
                stalkerHeaders: res.stalkerHeaders
            };
            state.currentProfileId = null;
            state.favoriteChannelIds = [];
            state.saveContext = 'stalker';

            const items = buildLibraryItems(res.channels, res.vod, res.series);
            loadChannels(items);
            setConnInfo('✅ Connecté', items.length);
            $('btn-save-profile')?.classList.remove('hidden');
            toast(`✅ ${res.channels.length} chaînes chargées`);
        } catch (err) {
            toast(`❌ ${err.message}`);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🔗 Connexion';
            }
        }
    });

    // ── M3U (fichier ou URL, dont listes Xtream get.php) ─────────────────────────
    $('btn-import-m3u')?.addEventListener('click', () => $('m3u-file')?.click());
    $('m3u-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            toast('⏳ Analyse de la liste…', 60000);
            loadM3uResult(await api.m3uParse(await file.text()));
        } catch (err) {
            toast(`❌ ${err.message}`);
        }
    });
    $('btn-load-m3u-url')?.addEventListener('click', async () => {
        const m3uUrl = $('m3u-url')?.value.trim();
        if (!/^https?:\/\//i.test(m3uUrl || '')) return toast('⚠️ URL M3U invalide');
        const btn = $('btn-load-m3u-url');
        if (btn) btn.disabled = true;
        try {
            const res = await api.m3uFetch(m3uUrl, (p) => toast(`⏳ ${p?.message || 'Chargement…'}`, 60000));
            loadM3uResult(res, {m3uUrl});
        } catch (err) {
            toast(`❌ ${err.message}`);
        } finally {
            if (btn) btn.disabled = false;
        }
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
        const isM3u = state.saveContext === 'm3u';
        let result;
        try {
            result = await api.profileSave({
                name, channels: state.channels, favoriteChannelIds: state.favoriteChannelIds,
                type: isM3u ? 'm3u' : 'stalker',
                portalUrl: state.saveContext === 'stalker' ? ($('portal-url')?.value.trim() || '') : '',
                mac: state.saveContext === 'stalker' ? ($('portal-mac')?.value.trim() || '') : '',
                m3uUrl: isM3u ? (state.saveM3uUrl || '') : '',
                stalkerSession: state.saveContext === 'stalker' ? state.stalkerSession : null,
            });
        } catch (err) {
            return toast(`❌ ${err.message}`);
        }
        state.currentProfileId = result.id;
        state.profileHasPin = false;
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
        if (e.key === 'Enter') {
            e.preventDefault();
            $('confirm-rename-profile')?.click();
        }
    });
    $('confirm-rename-profile')?.addEventListener('click', async () => {
        const name = $('rename-profile-input')?.value.trim();
        if (!state.renameProfileId || !name) return toast('⚠️ Nom requis');
        await api.profileRename({id: state.renameProfileId, name});
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
    $('copy-url')?.addEventListener('click', () => {
        navigator.clipboard.writeText($('edit-url')?.value || '');
        toast('📋 URL copiée');
    });
    $('copy-mac')?.addEventListener('click', () => {
        navigator.clipboard.writeText($('edit-mac')?.value || '');
        toast('📋 MAC copiée');
    });
    ['edit-url', 'edit-mac'].forEach((id) => {
        $(id)?.addEventListener('click', function () {
            this.select();
            navigator.clipboard.writeText(this.value);
            toast('📋 Copié');
        });
    });
    $('confirm-edit-profile')?.addEventListener('click', async () => {
        const name = $('edit-name')?.value.trim();
        if (!name) return toast('⚠️ Nom requis');
        await api.profileUpdate({id: state.renameProfileId, name});
        $('edit-profile-modal')?.classList.add('hidden');
        await refreshProfilesList();
        await renderWelcomeProfiles();
        toast('✏️ Profil renommé');
    });

    // ── Welcome / Home ────────────────────────────────────────────────────────────
    $('btn-enter-app')?.addEventListener('click', () => {
        $('welcome-screen')?.classList.add('hidden');
        document.body.classList.remove('on-welcome');
        // Mobile sans chaîne chargée : afficher directement les sources
        if (!state.channels.length) bodyCls.add('sources-open');
    });
    document.querySelectorAll('#btn-home').forEach((btn) => btn.addEventListener('click', goToWelcome));

    // ── Contrôles vidéo ───────────────────────────────────────────────────────────
    const video = $('video');
    if (video) video.volume = 0.8;
    const volSlider = $('vc-volume');
    const volLabel = $('vc-vol-label');
    if (volSlider) volSlider.value = 80;
    if (volLabel) volLabel.textContent = '80%';

    const resumePlayback = () => {
        const v = $('video');
        if (!v) return;
        const played = state.player ? state.player.play() : v.play();
        played?.then?.(hideTapToPlay).catch?.(() => {
        });
    };
    $('vc-play')?.addEventListener('click', () => {
        const v = $('video');
        v?.paused ? resumePlayback() : v?.pause();
    });
    $('tap-to-play')?.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTapToPlay();
        resumePlayback();
    });
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
        const nn = $('now-name');
        if (nn) nn.textContent = '—';
        const ng = $('now-group');
        if (ng) ng.textContent = '';
        renderChannels();
    });
    $('vc-prev')?.addEventListener('click', () => navigateChannel(-1));
    $('vc-next')?.addEventListener('click', () => navigateChannel(1));
    $('vc-mute')?.addEventListener('click', () => {
        const v = $('video');
        if (!v) return;
        v.muted = !v.muted;
        const btn = $('vc-mute');
        if (btn) btn.textContent = v.muted ? '🔇' : '🔊';
    });
    volSlider?.addEventListener('input', function () {
        const v = $('video');
        if (!v) return;
        const val = this.value / 100;
        v.volume = val;
        v.muted = val === 0;
        const mute = $('vc-mute');
        if (mute) mute.textContent = val === 0 ? '🔇' : val < 0.5 ? '🔉' : '🔊';
        if (volLabel) volLabel.textContent = `${this.value}%`;
    });
    $('vc-reload')?.addEventListener('click', () => {
        if (state.currentChannel) {
            state.retryCount = 0;
            playChannel(state.currentChannel);
        }
    });
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
    $('vc-pip')?.addEventListener('click', togglePip);

    // AirPlay (Safari) : bouton visible quand un récepteur est disponible
    if (video && window.WebKitPlaybackTargetAvailabilityEvent) {
        video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
            $('vc-airplay')?.classList.toggle('hidden', e.availability !== 'available');
        });
        $('vc-airplay')?.addEventListener('click', () => video.webkitShowPlaybackTargetPicker());
    }
    $('vc-fs')?.addEventListener('click', toggleFullscreen);
    $('btn-retry')?.addEventListener('click', () => {
        if (state.currentChannel) {
            state.retryCount = 0;
            playChannel(state.currentChannel);
        }
    });

    // Visibility on hover
    let controlsTimer;

    function showControls() {
        const vc = $('video-controls');
        const vw = $('video-wrap');
        vc?.classList.add('visible');
        if (isFullscreen()) vw?.style.setProperty('cursor', 'default');
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(() => {
            vc?.classList.remove('visible');
            if (isFullscreen()) vw?.style.setProperty('cursor', 'none');
        }, IS_TOUCH ? 4000 : 3000);
    }

    function hideControlsSoon(delay = 1000) {
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(() => {
            $('video-controls')?.classList.remove('visible');
            if (isFullscreen()) $('video-wrap')?.style.setProperty('cursor', 'none');
        }, delay);
    }

    // Souris : survol ; tactile : un toucher affiche/masque les contrôles
    $('video-wrap')?.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'mouse') showControls();
    });
    $('video-wrap')?.addEventListener('mouseleave', () => {
        if (!isFullscreen()) hideControlsSoon(1000);
    });
    $('video-wrap')?.addEventListener('click', (e) => {
        if (!IS_TOUCH || e.target.closest('.video-controls, .tap-to-play, button')) return;
        const vc = $('video-controls');
        if (vc?.classList.contains('visible')) {
            clearTimeout(controlsTimer);
            vc.classList.remove('visible');
        } else {
            showControls();
        }
    });
    $('video-controls')?.addEventListener('mouseenter', () => {
        clearTimeout(controlsTimer);
        $('video-controls')?.classList.add('visible');
    });
    $('video-controls')?.addEventListener('mouseleave', () => hideControlsSoon(2000));

    const onFullscreenChange = () => {
        const vw = $('video-wrap');
        if (isFullscreen()) {
            showControls();
        } else {
            vw?.style.removeProperty('cursor');
            clearTimeout(controlsTimer);
            $('video-controls')?.classList.remove('visible');
        }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    // ── Événements vidéo ──────────────────────────────────────────────────────────
    if (video) {
        let bufferCheckTimer = null;
        video.addEventListener('canplaythrough', () => revealVideo());
        video.addEventListener('canplay', () => {
            clearTimeout(bufferCheckTimer);
            bufferCheckTimer = setTimeout(revealVideo, 1500);
        });
        video.addEventListener('timeupdate', refreshSeekBar);
        video.addEventListener('loadedmetadata', refreshSeekBar);
        video.addEventListener('durationchange', refreshSeekBar);
        video.addEventListener('ended', () => {
            if (isSeekableContent()) {
                const s = $('vc-seek');
                if (s) s.value = '1000';
                refreshSeekBar();
            }
        });
        video.addEventListener('waiting', () => {
            if (video.style.opacity === '1') showLoading();
        });
        video.addEventListener('stalled', () => {
            if (video.style.opacity === '1') showLoading();
        });
        video.addEventListener('canplay', () => {
            if (video.style.opacity === '1') hideLoading();
        });
        video.addEventListener('error', () => {
            if (state.playEngine !== 'native' || !video.getAttribute('src')) return;
            if (state.failCurrent) {
                // Format non lisible en direct : bascule transcodage / nouvelle tentative
                state.failCurrent(getVideoError(video.error));
                return;
            }
            showError(getVideoError(video.error));
            $('live-dot')?.classList.remove('visible');
        });
        video.addEventListener('playing', () => {
            hideTapToPlay();
            revealVideo();
        });
        video.addEventListener('play', () => {
            const b = $('vc-play');
            if (b) b.textContent = '⏸';
        });
        video.addEventListener('pause', () => {
            const b = $('vc-play');
            if (b) b.textContent = '▶';
        });
        video.addEventListener('dblclick', toggleFullscreen);
    }

    // ── Raccourcis clavier ────────────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        if (e.key === '/') {
            e.preventDefault();
            $('search')?.focus();
            return;
        }
        const v = $('video');
        switch (e.key) {
            case ' ':
                e.preventDefault();
                v?.paused ? v.play() : v?.pause();
                break;
            case 'f':
            case 'F':
                toggleFullscreen();
                break;
            case 'm':
            case 'M':
                $('vc-mute')?.click();
                break;
            case 's':
            case 'S':
                $('btn-sidebar-toggle')?.click();
                break;
            case 'v':
            case 'V':
                playInVlc();
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
                if (isSeekableContent() && v) {
                    e.preventDefault();
                    v.currentTime = Math.max(0, v.currentTime - 10);
                }
                break;
            case 'ArrowRight':
                if (isSeekableContent() && v) {
                    e.preventDefault();
                    v.currentTime = Math.min(v.duration || v.currentTime + 10, v.currentTime + 10);
                }
                break;
            case 'Escape':
                if (document.fullscreenElement) document.exitFullscreen();
                break;
            case 't':
            case 'T':
                const isTv = document.body.classList.toggle('tv-mode');
                document.body.classList.toggle('sidebar-collapsed', isTv);
                if (!isTv) $('sidebar-backdrop')?.classList.remove('hidden');
                else $('sidebar-backdrop')?.classList.add('hidden');
                break;
            case 'h':
            case 'H':
                goToWelcome();
                break;
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
        } catch (_) {
        }
    }
});