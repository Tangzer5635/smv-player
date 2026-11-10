import {api} from './api.js';
import {$, closeTopModal, html, popupMenu, render, toast} from './dom.js';
import {icon} from './icons.js';
import {Player} from './player.js';
import {applyAccent, loadSources, selectInitialSource, selectSource, state, subscribe} from './store.js';
import {renderAuth} from './views/auth.js';
import {emptyLibrary, renderLive} from './views/live.js';
import {renderCatalog} from './views/catalog.js';
import {renderFavorites} from './views/favorites.js';
import {renderSettings} from './views/settings.js';
import {openSourceForm} from './views/source-form.js';

const app = document.getElementById('app');
const player = new Player();

const ROUTES = {
    direct: {title: 'Direct', icon: 'tv'},
    films: {title: 'Films', icon: 'film'},
    series: {title: 'Séries', icon: 'layers'},
    favoris: {title: 'Favoris', icon: 'star'},
    reglages: {title: 'Réglages', icon: 'sliders'},
};

let cleanup = null;
let theater = null;
const ctx = {
    player,
    keys: null,
    setKeys: (fn) => {
        ctx.keys = fn;
    },
    scroller: null,
    pending: null,
    navigate,
    openTheater,
};

// ── Navigation ──────────────────────────────────────────────────────────────
function currentRoute() {
    const name = location.hash.replace(/^#\/?/, '').split('?')[0];
    return ROUTES[name] ? name : 'direct';
}

function navigate(name, {play} = {}) {
    ctx.pending = play || null;
    if (currentRoute() === name) renderView();
    else location.hash = `#/${name}`;
}

function renderShell() {
    render(app, html`<div class="shell">
        <nav class="nav" aria-label="Navigation">
            <img class="nav-brand" src="/icons/icon-192.png" alt="SMV Player">
            ${Object.entries(ROUTES).map(([name, r]) => html`
                <a class="nav-link" href="#/${name}" data-route="${name}">${icon(r.icon)}<span>${r.title}</span></a>`)}
            <span class="nav-spacer"></span>
        </nav>
        <div class="main">
            <header class="topbar">
                <h1 data-title></h1>
                <span class="grow"></span>
                <button class="source-switch" data-switch hidden></button>
            </header>
            <main class="view" data-view></main>
        </div>
    </div>`);
    ctx.scroller = $('[data-view]');
    $('[data-switch]').addEventListener('click', (e) => openSourceMenu(e.currentTarget));
    updateSourceSwitch();
}

function updateSourceSwitch() {
    const btn = $('[data-switch]');
    if (!btn) return;
    btn.hidden = !state.sources.length;
    const s = state.source;
    btn.innerHTML = `<span class="dot" style="background:${s?.color || 'var(--faint)'}"></span>
        <span class="name"></span>${icon('chevronDown')}`;
    btn.querySelector('.name').textContent = s ? s.name : 'Choisir une source';
}

function openSourceMenu(anchor) {
    popupMenu(anchor, [
        ...state.sources.map((s) => ({
            label: s.name,
            color: s.color,
            active: s.id === state.source?.id,
            badge: s.locked ? '🔒' : s.status === 'loading' ? '…' : '',
            onSelect: async () => {
                if (s.id === state.source?.id) return;
                try {
                    if (player.current) player.stop();
                    await selectSource(s.id);
                    toast(`Source : ${s.name}`);
                } catch (err) {
                    if (!err.cancelled) toast(err.message, {type: 'error'});
                }
            },
        })),
        '-',
        {label: 'Ajouter une source', icon: 'plus', onSelect: () => openSourceForm()},
        {label: 'Gérer les sources', icon: 'sliders', onSelect: () => navigate('reglages')},
    ]);
}

function renderView() {
    cleanup?.();
    cleanup = null;
    ctx.keys = null;
    const name = currentRoute();
    const view = $('[data-view]');
    if (!view) return;
    document.querySelectorAll('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
    $('[data-title]').textContent = ROUTES[name].title;
    document.title = `${ROUTES[name].title} · SMV Player`;
    view.scrollTop = 0;
    view.innerHTML = '';
    view.onclick = null;

    // Quitter le direct libère la connexion IPTV (sauf lecture plein écran en cours)
    if (name !== 'direct' && player.current?.live && !theater) player.stop();

    const pending = ctx.pending;
    ctx.pending = null;
    const container = document.createElement('div');
    container.style.height = '100%';
    view.appendChild(container);

    if (name === 'reglages') {
        cleanup = renderSettings(container, ctx);
        return;
    }
    if (!state.library) {
        cleanup = emptyLibrary(container, {onAdd: () => openSourceForm()});
        return;
    }
    if (name === 'direct') cleanup = renderLive(container, {...ctx, pending});
    else if (name === 'films') cleanup = renderCatalog(container, ctx, 'vod');
    else if (name === 'series') cleanup = renderCatalog(container, ctx, 'series');
    else if (name === 'favoris') cleanup = renderFavorites(container, ctx);
}

// ── Lecture plein écran (films, épisodes) ───────────────────────────────────
function openTheater(target) {
    if (!state.source) return;
    closeTheater();
    theater = document.createElement('div');
    theater.className = 'theater';
    document.body.appendChild(theater);
    player.mount(theater);
    player.on('close', closeTheater);
    player.on('prev', null);
    player.on('next', null);
    player.play({...target, sourceId: state.source.id, live: false});
}

function closeTheater() {
    if (!theater) return;
    player.stop();
    theater.remove();
    theater = null;
    player.on('close', null);
    if (currentRoute() === 'direct') renderView();
}

// ── Démarrage ───────────────────────────────────────────────────────────────
async function boot() {
    let session;
    try {
        session = await api.session();
    } catch (err) {
        render(app, html`<div class="auth"><div class="auth-card"><h1>SMV Player</h1>
            <p class="error-text">${err.message}</p><button class="btn btn-primary" data-reload>Réessayer</button></div></div>`);
        app.querySelector('[data-reload]').addEventListener('click', () => location.reload());
        return;
    }
    if (!session.authenticated) {
        player.stop();
        renderAuth(app, {setupRequired: session.setupRequired, onDone: () => boot()});
        return;
    }
    state.user = session.user;
    state.version = session.version;
    renderShell();
    render($('[data-view]'), html`<div class="empty-state"><div class="spinner"></div></div>`);
    try {
        await loadSources();
        await selectInitialSource();
    } catch (err) {
        toast(err.message, {type: 'error'});
    }
    renderView();
}

subscribe((type) => {
    if (type === 'sources' || type === 'library') updateSourceSwitch();
    if (type === 'library') {
        applyAccent(state.source?.color);
        if (currentRoute() !== 'reglages') renderView();
    }
});

window.addEventListener('hashchange', () => {
    closeTopModal();
    renderView();
});

window.addEventListener('smv:unauthorized', () => {
    player.stop();
    closeTheater();
    renderAuth(app, {setupRequired: false, onDone: () => boot()});
});

document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select')) {
        if (e.key === 'Escape') e.target.blur();
        return;
    }
    if (e.key === 'Escape') {
        if (closeTopModal()) return;
        if (theater) closeTheater();
        return;
    }
    if (document.querySelector('.modal-backdrop')) return;
    if (!theater && ctx.keys?.(e)) return;
    if (!player.current) return;
    switch (e.key) {
        case ' ':
        case 'k':
            e.preventDefault();
            player.togglePlay();
            break;
        case 'f':
            player.toggleFullscreen();
            break;
        case 'm':
            player.toggleMute();
            break;
        case 'ArrowLeft':
            player.seekBy(-10);
            break;
        case 'ArrowRight':
            player.seekBy(30);
            break;
        default:
            return;
    }
    player.showUi();
});

// L'app installée sur l'écran d'accueil fonctionne aussi hors ligne (coquille)
if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => null);
}

applyAccent();
boot();
