import {api} from '../api.js';
import {$, formatClock, html, logoImg, normalize, render, renderIncremental} from '../dom.js';
import {icon} from '../icons.js';
import {isFavorite, item, noteHistory, prefs, savePrefs, state, subscribe, toggleFavorite} from '../store.js';

const ALL = '__all';
const FAV = '__fav';
const RECENT = '__recent';

function groupsOf(live) {
    const counts = new Map();
    for (const ch of live) counts.set(ch.group, (counts.get(ch.group) || 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({id: name, name, count}));
}

function channelRow(ch, playingKey) {
    const fav = isFavorite(ch.key);
    return html`<div class="channel${ch.key === playingKey ? ' playing' : ''}" data-key="${ch.key}" role="button" tabindex="0">
        <span class="num">${ch.number || ''}</span>
        ${logoImg(ch.logo, ch.name)}
        <span class="info"><span class="name">${ch.name}</span><span class="sub">${ch.group}</span></span>
        <button class="icon-btn fav${fav ? ' active' : ''}" data-fav="${ch.key}" aria-label="Favori">${icon(fav ? 'starFill' : 'star')}</button>
    </div>`;
}

/**
 * Vue « Direct ». ctx.player : lecteur partagé ; ctx.pending : chaîne à lancer.
 */
export function renderLive(root, ctx) {
    const {player} = ctx;
    const live = state.library?.live || [];
    const groups = groupsOf(live);
    let group = [ALL, FAV, RECENT].includes(prefs.liveGroup) || groups.some((g) => g.id === prefs.liveGroup) ? prefs.liveGroup : ALL;
    let query = '';
    let filtered = [];
    let list = null;
    let epgTimer = null;

    render(root, html`
        <div class="live idle">
            <aside class="live-cats" data-cats></aside>
            <section class="live-list" data-list>
                <div class="live-list-head">
                    <div class="chips" data-chips></div>
                    <label class="search">${icon('search')}<input class="input" type="search" placeholder="Rechercher une chaîne" data-search autocomplete="off"></label>
                </div>
                <div data-rows></div>
            </section>
            <section class="live-stage">
                <div data-slot></div>
                <div class="stage-info" data-info></div>
            </section>
        </div>`);

    const layout = $('.live', root);
    const rows = $('[data-rows]', root);
    const listEl = $('[data-list]', root);
    player.mount($('[data-slot]', root));
    player.el.classList.remove('show-ui');

    const special = () => [
        {id: ALL, name: 'Toutes les chaînes', count: live.length},
        {id: FAV, name: 'Favoris', count: live.filter((c) => isFavorite(c.key)).length},
        {id: RECENT, name: 'Récentes', count: state.history.filter((h) => h.key.startsWith('live:')).length},
    ];

    function renderGroups() {
        const all = special();
        render($('[data-cats]', root), html`
            ${all.map((g) => html`<button class="cat${g.id === group ? ' active' : ''}" data-group="${g.id}"><span>${g.name}</span><span class="count">${g.count}</span></button>`)}
            <div class="cat-title">Catégories</div>
            ${groups.map((g) => html`<button class="cat${g.id === group ? ' active' : ''}" data-group="${g.id}"><span>${g.name}</span><span class="count">${g.count}</span></button>`)}`);
        render($('[data-chips]', root), html`${[...all, ...groups].map((g) => html`
            <button class="chip${g.id === group ? ' active' : ''}" data-group="${g.id}">${g.id === ALL ? 'Toutes' : g.name}</button>`)}`);
    }

    function computeList() {
        let base;
        if (group === FAV) base = live.filter((c) => isFavorite(c.key));
        else if (group === RECENT) base = state.history.map((h) => item(h.key)).filter((c) => c?.key.startsWith('live:'));
        else if (group === ALL) base = live;
        else base = live.filter((c) => c.group === group);
        if (query) {
            const q = normalize(query);
            base = base.filter((c) => normalize(c.name).includes(q) || String(c.number) === query);
        }
        return base;
    }

    function renderRows({keepScroll = false} = {}) {
        const scroll = listEl.scrollTop;
        list?.disconnect();
        filtered = computeList();
        rows.innerHTML = '';
        if (!filtered.length) {
            render(rows, html`<div class="empty-state">${icon(group === FAV ? 'star' : 'search')}
                <p>${group === FAV ? 'Aucune chaîne favorite : touchez l\'étoile d\'une chaîne.' : 'Aucune chaîne trouvée.'}</p></div>`);
            return;
        }
        const playingKey = player.current?.live ? player.current.key : null;
        list = renderIncremental(rows, filtered, (ch) => channelRow(ch, playingKey), {root: window.matchMedia('(max-width: 900px)').matches ? null : listEl});
        const idx = filtered.findIndex((c) => c.key === playingKey);
        if (idx >= 0) list.ensure(idx);
        if (keepScroll) listEl.scrollTop = scroll;
    }

    function markPlaying() {
        const key = player.current?.live ? player.current.key : null;
        rows.querySelectorAll('.channel.playing').forEach((el) => el.classList.remove('playing'));
        if (key) rows.querySelector(`[data-key="${CSS.escape(key)}"]`)?.classList.add('playing');
    }

    async function loadEpg(ch) {
        clearInterval(epgTimer);
        const box = $('[data-epg]', root);
        if (!box || state.source?.type !== 'stalker') return;
        const show = (programmes) => {
            const now = Date.now();
            const current = programmes.find((p) => p.start <= now && p.stop > now);
            const next = programmes.find((p) => p.start >= (current?.stop || now));
            if (!current && !next) {
                box.hidden = true;
                return;
            }
            box.hidden = false;
            const pct = current ? Math.min(100, ((now - current.start) / (current.stop - current.start)) * 100) : 0;
            render(box, html`
                ${current ? html`<div class="epg-now"><div class="label">En ce moment</div>
                    <div class="title">${current.title}</div>
                    <div class="time">${formatClock(current.start)} – ${formatClock(current.stop)}</div>
                    <div class="progress"><div style="width:${pct.toFixed(1)}%"></div></div>
                    ${current.description ? html`<div class="desc">${current.description}</div>` : ''}</div>` : ''}
                ${next ? html`<div class="epg-next"><div class="label">Ensuite · ${formatClock(next.start)}</div><div class="title">${next.title}</div></div>` : ''}`);
        };
        try {
            const {programmes} = await api.epg(state.source.id, ch.key);
            if (player.current?.key !== ch.key) return;
            show(programmes);
            epgTimer = setInterval(() => show(programmes), 30000);
        } catch (_) {
            box.hidden = true;
        }
    }

    function renderInfo() {
        const ch = player.current?.live ? item(player.current.key) : null;
        layout.classList.toggle('idle', !ch);
        const info = $('[data-info]', root);
        if (!ch) {
            info.innerHTML = '';
            return;
        }
        const fav = isFavorite(ch.key);
        render(info, html`
            <div class="stage-head">
                ${logoImg(ch.logo, ch.name)}
                <div class="grow" style="min-width:0">
                    <h2>${ch.name}</h2>
                    <div class="sub">${ch.number ? `N° ${ch.number} · ` : ''}${ch.group}</div>
                </div>
                <button class="icon-btn${fav ? ' active' : ''}" data-fav="${ch.key}" aria-label="Favori">${icon(fav ? 'starFill' : 'star')}</button>
            </div>
            <div class="epg" data-epg hidden></div>`);
        loadEpg(ch);
    }

    function play(ch) {
        if (!ch || !state.source) return;
        player.play({
            sourceId: state.source.id,
            key: ch.key,
            title: ch.name,
            subtitle: ch.group,
            logo: ch.logo,
            live: true,
        });
        noteHistory(ch.key);
        markPlaying();
        renderInfo();
    }

    function zap(direction) {
        if (!filtered.length) return;
        const idx = filtered.findIndex((c) => c.key === player.current?.key);
        const next = filtered[(idx + direction + filtered.length) % filtered.length];
        play(next);
        list?.ensure(filtered.indexOf(next));
        rows.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({block: 'nearest'});
    }

    player.on('prev', () => zap(-1));
    player.on('next', () => zap(1));
    player.on('close', null);

    root.addEventListener('click', (e) => {
        const favBtn = e.target.closest('[data-fav]');
        if (favBtn) {
            e.stopPropagation();
            toggleFavorite(favBtn.dataset.fav);
            return;
        }
        const groupBtn = e.target.closest('[data-group]');
        if (groupBtn) {
            group = groupBtn.dataset.group;
            savePrefs({liveGroup: group});
            renderGroups();
            renderRows();
            listEl.scrollTop = 0;
            groupBtn.scrollIntoView({block: 'nearest', inline: 'center'});
            return;
        }
        const row = e.target.closest('.channel[data-key]');
        if (row) play(item(row.dataset.key));
    });
    root.addEventListener('keydown', (e) => {
        const row = e.target.closest?.('.channel[data-key]');
        if (row && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            play(item(row.dataset.key));
        }
    });
    $('[data-search]', root).addEventListener('input', (e) => {
        query = e.target.value.trim();
        renderRows();
    });

    const unsubscribe = subscribe((type) => {
        if (type === 'favorites') {
            const favs = special()[1].count;
            root.querySelectorAll(`[data-group="${FAV}"] .count`).forEach((el) => {
                el.textContent = favs;
            });
            rows.querySelectorAll('[data-fav]').forEach((btn) => {
                const on = isFavorite(btn.dataset.fav);
                btn.classList.toggle('active', on);
                btn.innerHTML = icon(on ? 'starFill' : 'star');
            });
            const stageFav = $('[data-info] [data-fav]', root);
            if (stageFav) {
                const on = isFavorite(stageFav.dataset.fav);
                stageFav.classList.toggle('active', on);
                stageFav.innerHTML = icon(on ? 'starFill' : 'star');
            }
            if (group === FAV) renderRows({keepScroll: true});
        }
    });

    renderGroups();
    renderRows();
    if (ctx.pending) {
        play(item(ctx.pending));
    } else if (player.current?.live && item(player.current.key)) {
        markPlaying();
        renderInfo();
    }

    // Raccourcis clavier propres au direct
    ctx.setKeys((e) => {
        if (e.key === 'ArrowUp' && player.current) {
            e.preventDefault();
            zap(-1);
            return true;
        }
        if (e.key === 'ArrowDown' && player.current) {
            e.preventDefault();
            zap(1);
            return true;
        }
        if (e.key === '/') {
            e.preventDefault();
            $('[data-search]', root).focus();
            return true;
        }
        return false;
    });

    return () => {
        clearInterval(epgTimer);
        list?.disconnect();
        unsubscribe();
    };
}

export function emptyLibrary(root, {onAdd}) {
    const hasSources = state.sources.length > 0;
    render(root, html`<div class="empty-state" style="min-height:70%">
        ${icon('tv')}
        <h2>${hasSources ? 'Aucune source ouverte' : 'Bienvenue sur SMV Player'}</h2>
        <p>${hasSources
            ? 'Choisissez une source en haut à droite, ou ajoutez-en une nouvelle.'
            : 'Ajoutez votre portail Stalker (URL + MAC) ou votre liste M3U pour commencer.'}</p>
        <button class="btn btn-primary" data-add>${icon('plus')} Ajouter une source</button>
    </div>`);
    root.querySelector('[data-add]').addEventListener('click', onAdd);
    return () => {};
}
