import {api} from './api.js';
import {icon} from './icons.js';
import {esc, formatDuration, imgUrl, toast} from './dom.js';
import {prefs, savePrefs} from './store.js';

/*
 * Lecteur vidéo
 *
 * Moteur choisi selon le flux et l'appareil :
 *   - ordinateur : mpegts.js (flux TS), hls.js (HLS), <video> (MP4…)
 *   - iPhone / iPad : lecteur HLS natif de Safari, le serveur transcodant au besoin
 *   - qualité réduite demandée : HLS transcodé par le serveur partout
 * En cas d'échec : bascule une fois vers le transcodage serveur, puis nouvelles
 * tentatives (nouveau lien du portail) avant d'afficher l'erreur.
 */

export const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const IS_TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const MAX_RETRIES = 2;

const QUALITY_LABELS = {source: 'Original', '1080p': '1080p', '720p': '720p', '480p': '480p', '360p': '360p'};

export class Player {
    constructor() {
        this.el = document.createElement('div');
        this.el.className = 'player is-live';
        this.el.dataset.state = 'idle';
        this.el.innerHTML = `
            <video playsinline webkit-playsinline x-webkit-airplay="allow" preload="none"></video>
            <div class="player-msg" data-msg></div>
            <button class="player-tap" data-act="tap" hidden aria-label="Lecture">${icon('play')}</button>
            <div class="player-ui">
                <div class="player-top">
                    <button class="icon-btn back-btn" data-act="close" aria-label="Fermer">${icon('back')}</button>
                    <div class="player-title"><div class="t" data-title></div><div class="s" data-subtitle></div></div>
                    <span class="badge badge-live" data-live>● DIRECT</span>
                    <span class="badge badge-accent" data-quality hidden></span>
                </div>
                <div class="player-bottom">
                    <div class="player-seek">
                        <span data-cur>0:00</span>
                        <input type="range" min="0" max="1000" step="1" value="0" data-seek aria-label="Position">
                        <span data-dur>0:00</span>
                    </div>
                    <div class="player-controls">
                        <button class="icon-btn" data-act="prev" title="Chaîne précédente">${icon('prev')}</button>
                        <button class="icon-btn" data-act="rewind" title="Reculer de 10 s">${icon('rewind')}</button>
                        <button class="icon-btn play" data-act="toggle" title="Lecture / pause">${icon('play')}</button>
                        <button class="icon-btn" data-act="forward" title="Avancer de 30 s">${icon('forward')}</button>
                        <button class="icon-btn" data-act="next" title="Chaîne suivante">${icon('next')}</button>
                        <button class="icon-btn" data-act="mute" title="Son">${icon('volume')}</button>
                        <input class="player-volume" type="range" min="0" max="100" data-volume aria-label="Volume">
                        <span class="spacer"></span>
                        <button class="icon-btn" data-act="airplay" title="AirPlay" hidden>${icon('airplay')}</button>
                        <button class="icon-btn" data-act="vlc" title="Ouvrir dans VLC">${icon('external')}</button>
                        <button class="icon-btn" data-act="pip" title="Image dans l'image">${icon('pip')}</button>
                        <button class="icon-btn" data-act="fullscreen" title="Plein écran">${icon('fullscreen')}</button>
                    </div>
                </div>
            </div>`;
        this.video = this.el.querySelector('video');
        this.video.volume = prefs.volume ?? 1;
        this.video.muted = !!prefs.muted;
        this.el.querySelector('[data-volume]').value = String(Math.round((prefs.volume ?? 1) * 100));

        this.current = null;      // {sourceId, key, title, subtitle, live, logo}
        this.playback = null;     // session serveur
        this.engine = null;
        this.mpegts = null;
        this.hls = null;
        this.attempt = 0;
        this.retries = 0;
        this.playSource = 'direct';
        this.preferHls = false;
        this.lastError = '';
        this.token = 0;
        this.uiTimer = null;
        this.seeking = false;
        this.handlers = {};

        this.bindEvents();
        this.setMessage('idle');
        this.updateMuteIcon();
    }

    on(name, fn) {
        this.handlers[name] = fn;
    }

    mount(container) {
        if (this.el.parentElement !== container) container.appendChild(this.el);
    }

    get active() {
        return !!this.current;
    }

    // ── Interface ──────────────────────────────────────────────────────────
    setState(state) {
        this.el.dataset.state = state;
        const toggle = this.el.querySelector('[data-act="toggle"]');
        toggle.innerHTML = icon(state === 'playing' ? 'pause' : 'play');
        if (state !== 'paused') this.el.querySelector('[data-act="tap"]').hidden = true;
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = state === 'playing' ? 'playing' : state === 'paused' ? 'paused' : 'none';
        }
    }

    setMessage(kind, text = '') {
        const box = this.el.querySelector('[data-msg]');
        if (kind === 'idle') {
            box.innerHTML = `${icon('tv')}<div>${esc(text || 'Choisissez une chaîne')}</div>`;
        } else if (kind === 'loading') {
            box.innerHTML = `<div class="spinner"></div><div>${esc(text || 'Chargement du flux…')}</div>`;
        } else if (kind === 'error') {
            box.innerHTML = `${icon('alert')}<div class="msg-error">${esc(text)}</div>
                <button class="btn btn-sm" data-act="retry">${icon('refresh')} Réessayer</button>`;
        }
    }

    showUi() {
        this.el.classList.add('show-ui');
        clearTimeout(this.uiTimer);
        this.uiTimer = setTimeout(() => {
            if (this.el.dataset.state === 'playing' && !this.seeking) this.el.classList.remove('show-ui');
        }, IS_TOUCH ? 4000 : 3000);
    }

    updateMuteIcon() {
        this.el.querySelector('[data-act="mute"]').innerHTML = icon(this.video.muted || this.video.volume === 0 ? 'mute' : 'volume');
    }

    updateSeek() {
        const v = this.video;
        const duration = Number.isFinite(v.duration) ? v.duration : 0;
        this.el.querySelector('[data-dur]').textContent = formatDuration(duration);
        if (!this.seeking) {
            this.el.querySelector('[data-cur]').textContent = formatDuration(v.currentTime);
            this.el.querySelector('[data-seek]').value = duration ? String(Math.round((v.currentTime / duration) * 1000)) : '0';
        }
    }

    bindEvents() {
        const v = this.video;
        this.el.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (btn) {
                e.stopPropagation();
                this.action(btn.dataset.act);
                this.showUi();
                return;
            }
            if (e.target.closest('.player-bottom, .player-top, .player-msg')) return;
            // Toucher la vidéo : affiche/masque les commandes ; souris : lecture/pause
            if (IS_TOUCH) {
                this.el.classList.contains('show-ui') ? this.el.classList.remove('show-ui') : this.showUi();
            } else if (this.current) {
                this.togglePlay();
            }
        });
        this.el.addEventListener('dblclick', (e) => {
            if (!e.target.closest('.player-ui button, input')) this.toggleFullscreen();
        });
        this.el.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'mouse') this.showUi();
        });

        const seek = this.el.querySelector('[data-seek]');
        seek.addEventListener('input', () => {
            this.seeking = true;
            const duration = Number.isFinite(v.duration) ? v.duration : 0;
            this.el.querySelector('[data-cur]').textContent = formatDuration((Number(seek.value) / 1000) * duration);
        });
        seek.addEventListener('change', () => {
            const duration = Number.isFinite(v.duration) ? v.duration : 0;
            if (duration) v.currentTime = (Number(seek.value) / 1000) * duration;
            this.seeking = false;
        });

        this.el.querySelector('[data-volume]').addEventListener('input', (e) => {
            v.volume = Number(e.target.value) / 100;
            v.muted = v.volume === 0;
            savePrefs({volume: v.volume, muted: v.muted});
            this.updateMuteIcon();
        });

        v.addEventListener('playing', () => {
            this.setState('playing');
            this.retries = 0;
            this.showUi();
        });
        v.addEventListener('pause', () => {
            if (this.current && this.el.dataset.state === 'playing') this.setState('paused');
        });
        v.addEventListener('waiting', () => {
            if (this.el.dataset.state === 'playing') {
                this.setState('loading');
                this.setMessage('loading', 'Mise en mémoire tampon…');
            }
        });
        v.addEventListener('timeupdate', () => this.updateSeek());
        v.addEventListener('durationchange', () => this.updateSeek());
        v.addEventListener('ended', () => this.setState('paused'));
        v.addEventListener('error', () => {
            if (this.engine !== 'native' || !v.getAttribute('src')) return;
            this.failCurrent?.(this.mediaErrorText());
        });

        if (window.WebKitPlaybackTargetAvailabilityEvent) {
            v.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
                this.el.querySelector('[data-act="airplay"]').hidden = e.availability !== 'available';
            });
        }
        if (!document.pictureInPictureEnabled && !v.webkitSupportsPresentationMode) {
            this.el.querySelector('[data-act="pip"]').hidden = true;
        }
    }

    mediaErrorText() {
        const code = this.video.error?.code;
        return {1: 'lecture interrompue', 2: 'erreur réseau', 3: 'erreur de décodage', 4: 'format non supporté'}[code] || 'erreur de lecture';
    }

    action(name) {
        const v = this.video;
        switch (name) {
            case 'toggle':
            case 'tap':
                this.togglePlay();
                break;
            case 'retry':
                this.retry();
                break;
            case 'close':
                this.handlers.close?.();
                break;
            case 'prev':
                this.handlers.prev?.();
                break;
            case 'next':
                this.handlers.next?.();
                break;
            case 'rewind':
                this.seekBy(-10);
                break;
            case 'forward':
                this.seekBy(30);
                break;
            case 'mute':
                this.toggleMute();
                break;
            case 'fullscreen':
                this.toggleFullscreen();
                break;
            case 'pip':
                this.togglePip();
                break;
            case 'airplay':
                v.webkitShowPlaybackTargetPicker?.();
                break;
            case 'vlc':
                this.openExternal();
                break;
            default:
        }
    }

    // ── Commandes ──────────────────────────────────────────────────────────
    togglePlay() {
        if (!this.current) return;
        const v = this.video;
        if (v.paused) {
            const played = this.mpegts ? this.mpegts.play() : v.play();
            played?.catch?.(() => {
            });
            this.el.querySelector('[data-act="tap"]').hidden = true;
        } else {
            v.pause();
        }
    }

    toggleMute() {
        const v = this.video;
        v.muted = !v.muted;
        if (!v.muted && v.volume === 0) v.volume = 1;
        savePrefs({muted: v.muted, volume: v.volume});
        this.updateMuteIcon();
    }

    seekBy(seconds) {
        const v = this.video;
        if (this.current?.live || !Number.isFinite(v.duration)) return;
        v.currentTime = Math.max(0, Math.min(v.duration - 1, v.currentTime + seconds));
    }

    isFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    toggleFullscreen() {
        if (this.isFullscreen()) {
            (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
            return;
        }
        const request = this.el.requestFullscreen || this.el.webkitRequestFullscreen;
        if (request) {
            Promise.resolve(request.call(this.el)).catch(() => this.video.webkitEnterFullscreen?.());
        } else if (this.video.webkitEnterFullscreen) {
            // iPhone : seul l'élément vidéo passe en plein écran (lecteur natif)
            this.video.webkitEnterFullscreen();
        }
    }

    async togglePip() {
        const v = this.video;
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
                await v.requestPictureInPicture();
            } else if (v.webkitSupportsPresentationMode?.('picture-in-picture')) {
                v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
            }
        } catch (_) {
            toast('Image dans l\'image indisponible', {type: 'error'});
        }
    }

    // Ouvre le flux dans VLC : lien direct (jeton dans l'URL, sans cookie)
    openExternal() {
        if (!this.playback) return;
        const path = this.playback.transcodeRequired ? this.playback.hlsUrl : this.playback.streamUrl;
        const url = new URL(path, location.href).href;
        this.video.pause();
        if (IS_IOS) {
            location.href = `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`;
            return;
        }
        if (/Android/i.test(navigator.userAgent)) {
            location.href = `vlc://${url}`;
            return;
        }
        const title = this.current?.title || 'SMV Player';
        const blob = new Blob([`#EXTM3U\n#EXTINF:-1,${title}\n${url}\n`], {type: 'audio/x-mpegurl'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'flux'}.m3u`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        navigator.clipboard?.writeText(url).catch(() => {
        });
        toast('Playlist téléchargée pour VLC (lien aussi copié)');
    }

    // ── Lecture ────────────────────────────────────────────────────────────
    // Safari iOS n'autorise la lecture qu'après un geste : on « débloque » la vidéo
    // pendant le clic, avant les appels réseau
    unlock() {
        if (!IS_TOUCH || this.video.dataset.unlocked) return;
        if (navigator.userActivation && !navigator.userActivation.isActive) return;
        this.video.dataset.unlocked = '1';
        try {
            this.video.play()?.catch?.(() => {
            });
        } catch (_) {
        }
    }

    async play(target, {isRetry = false} = {}) {
        this.unlock();
        const previous = this.playback?.id;
        this.teardownEngine();
        this.playback = null;
        const token = ++this.token;
        this.current = target;
        if (!isRetry) {
            this.retries = 0;
            this.preferHls = false;
            this.lastError = '';
        }

        this.el.classList.toggle('is-live', !!target.live);
        this.el.querySelector('[data-title]').textContent = target.title || '';
        this.el.querySelector('[data-subtitle]').textContent = target.subtitle || '';
        this.el.querySelector('[data-live]').hidden = !target.live;
        this.el.querySelector('[data-quality]').hidden = true;
        this.setState('loading');
        this.setMessage('loading', isRetry ? 'Nouvelle tentative…' : 'Connexion au flux…');
        this.updateMediaSession();

        let pb;
        try {
            pb = await api.play(target.sourceId, {key: target.key, quality: prefs.quality, previous});
        } catch (err) {
            if (token !== this.token) return;
            this.fail(err.message);
            return;
        }
        if (token !== this.token) {
            api.stopPlay(pb.id);
            return;
        }
        this.playback = pb;
        const plan = this.choosePlan(pb);
        this.playSource = plan.source;
        this.startEngine(plan.url, plan.engine);
    }

    retry() {
        if (!this.current) return;
        this.retries = 0;
        this.preferHls = false;
        this.play(this.current, {isRetry: true});
    }

    stop() {
        this.token++;
        this.teardownEngine();
        if (this.playback) api.stopPlay(this.playback.id);
        this.playback = null;
        this.current = null;
        this.setState('idle');
        this.setMessage('idle');
        this.el.classList.remove('show-ui');
        if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    }

    nativeHls() {
        return !!this.video.canPlayType('application/vnd.apple.mpegurl');
    }

    hlsEngine() {
        if (IS_IOS && this.nativeHls()) return 'native';
        return window.Hls?.isSupported() ? 'hlsjs' : 'native';
    }

    choosePlan(pb) {
        const mode = prefs.mode;
        const serverHls = pb.hlsUrl ? {url: pb.hlsUrl, engine: this.hlsEngine(), source: 'hls'} : null;
        const direct = (engine) => ({url: pb.streamUrl, engine, source: 'direct'});
        const canMpegts = !!window.mpegts?.isSupported();

        if (pb.transcodeRequired && serverHls) return serverHls;
        if ((mode === 'hls' || this.preferHls) && mode !== 'direct' && serverHls) return serverHls;
        switch (pb.kind) {
            case 'hls':
                return direct(this.hlsEngine());
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

    teardownEngine() {
        this.failCurrent = null;
        if (this.mpegts) {
            try {
                this.mpegts.pause();
                this.mpegts.unload();
                this.mpegts.detachMediaElement();
                this.mpegts.destroy();
            } catch (_) {
            }
            this.mpegts = null;
        }
        if (this.hls) {
            try {
                this.hls.destroy();
            } catch (_) {
            }
            this.hls = null;
        }
        this.video.removeAttribute('src');
        try {
            this.video.load();
        } catch (_) {
        }
        this.engine = null;
    }

    startEngine(path, engine) {
        const url = new URL(path, location.href).href; // les Workers exigent une URL absolue
        const v = this.video;
        const live = !!this.current?.live;
        const attempt = ++this.attempt;
        this.engine = engine;

        const quality = this.el.querySelector('[data-quality]');
        const transcoded = this.playSource === 'hls';
        quality.hidden = !transcoded;
        quality.textContent = transcoded ? (this.playback.quality === 'source' ? 'Compatibilité' : QUALITY_LABELS[this.playback.quality]) : '';

        const fail = (reason) => {
            if (attempt !== this.attempt) return;
            this.attempt++;
            if (reason) this.lastError = reason;
            this.handleFailure();
        };
        this.failCurrent = fail;
        const onPlayRejected = (err) => {
            if (attempt !== this.attempt) return;
            if (err?.name === 'NotAllowedError') {
                this.setState('paused');
                this.el.querySelector('[data-act="tap"]').hidden = false;
                return;
            }
            if (err?.name === 'AbortError') return;
            fail(err?.message || err?.name);
        };

        if (engine === 'mpegts') {
            this.mpegts = window.mpegts.createPlayer({type: 'mpegts', url, isLive: live}, {
                enableWorker: true,
                liveBufferLatencyChasing: false,
                autoCleanupSourceBuffer: true,
            });
            this.mpegts.attachMediaElement(v);
            this.mpegts.load();
            this.mpegts.on(window.mpegts.Events.ERROR, (type, details, info) => {
                console.warn('[mpegts.js]', type, details, info);
                fail(info?.code > 0 ? `HTTP ${info.code}` : info?.msg || details || type);
            });
            this.mpegts.play()?.catch?.(onPlayRejected);
            return;
        }

        if (engine === 'hlsjs') {
            this.hls = new window.Hls({enableWorker: true, lowLatencyMode: false, backBufferLength: live ? 30 : 90});
            this.hls.loadSource(url);
            this.hls.attachMedia(v);
            this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => v.play().catch(onPlayRejected));
            this.hls.on(window.Hls.Events.ERROR, (_, data) => {
                if (!data?.fatal) return;
                console.warn('[hls.js]', data.type, data.details);
                fail(data.response?.code ? `HTTP ${data.response.code}` : data.details);
            });
            return;
        }

        v.src = url;
        v.play().catch(onPlayRejected);
    }

    // Échec : transcodage serveur une fois, puis nouveau lien, puis message d'erreur
    handleFailure() {
        const pb = this.playback;
        const refused = /^HTTP [45]\d\d$/.test(this.lastError);
        if (pb?.hlsUrl && !refused && this.playSource !== 'hls' && prefs.mode !== 'direct') {
            this.preferHls = true;
            this.playSource = 'hls';
            toast('Mode compatibilité : transcodage du flux…');
            this.teardownEngine();
            this.startEngine(pb.hlsUrl, this.hlsEngine());
            return;
        }
        if (/^HTTP 4\d\d$/.test(this.lastError)) {
            this.fail(`Flux refusé par le fournisseur (${this.lastError})`);
            return;
        }
        if (this.retries < MAX_RETRIES) {
            this.retries++;
            const token = this.token;
            setTimeout(() => {
                if (token === this.token && this.current) this.play(this.current, {isRetry: true});
            }, 1500);
            return;
        }
        const hint = !pb?.ffmpeg ? ' — ffmpeg absent sur le serveur' : '';
        this.fail(`Lecture impossible${this.lastError ? ` (${this.lastError})` : ''}${hint}`);
    }

    fail(message) {
        this.teardownEngine();
        this.setState('error');
        this.setMessage('error', message);
        this.handlers.error?.(message);
    }

    updateMediaSession() {
        if (!('mediaSession' in navigator) || !this.current) return;
        const c = this.current;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: c.title || '',
                artist: c.subtitle || 'SMV Player',
                artwork: c.logo ? [{src: imgUrl(c.logo), sizes: '512x512'}] : [{src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png'}],
            });
            const set = (action, fn) => {
                try {
                    navigator.mediaSession.setActionHandler(action, fn);
                } catch (_) {
                }
            };
            set('play', () => this.togglePlay());
            set('pause', () => this.video.pause());
            set('previoustrack', c.live ? () => this.handlers.prev?.() : null);
            set('nexttrack', c.live ? () => this.handlers.next?.() : null);
            set('seekbackward', c.live ? null : () => this.seekBy(-10));
            set('seekforward', c.live ? null : () => this.seekBy(30));
        } catch (_) {
        }
    }
}

export const QUALITIES = Object.entries(QUALITY_LABELS).map(([value, label]) => ({value, label}));
