import {api} from '../api.js';
import {$, html, imgUrl, initials, modal, normalize, render, renderIncremental} from '../dom.js';
import {icon} from '../icons.js';
import {isFavorite, state, subscribe, toggleFavorite} from '../store.js';

export function posterCard(entry) {
    return html`<button class="card" data-open="${entry.key}">
        <div class="poster">
            ${entry.logo ? html`<img src="${imgUrl(entry.logo)}" alt="" loading="lazy" data-fallback="${initials(entry.name)}" class="poster-img">` : ''}
            <div class="initials">${entry.logo ? '' : entry.name}</div>
            ${isFavorite(entry.key) ? html`<span class="star">${icon('starFill')}</span>` : ''}
        </div>
        <span class="t">${entry.name}</span>
        <span class="s">${[entry.year, entry.category].filter(Boolean).join(' · ')}</span>
    </button>`;
}

/**
 * Fiche d'un film ou d'une série ; ctx.openTheater lance la lecture plein écran.
 */
export function openDetail(entry, ctx) {
    const isSeries = entry.key.startsWith('series:');
    let episodes = null;
    let season = null;

    const m = modal({
        title: isSeries ? 'Série' : 'Film',
        wide: true,
        body: html`<div class="detail">
            <div class="poster">
                ${entry.logo ? html`<img src="${imgUrl(entry.logo)}" alt="" data-fallback="${initials(entry.name)}">` : html`<div class="initials">${entry.name}</div>`}
            </div>
            <div style="min-width:0">
                <h2>${entry.name}</h2>
                <div class="meta">
                    ${entry.year ? html`<span class="badge">${entry.year}</span>` : ''}
                    ${entry.rating ? html`<span class="badge badge-warn">★ ${entry.rating}</span>` : ''}
                    ${entry.category ? html`<span class="badge">${entry.category}</span>` : ''}
                </div>
                ${entry.description ? html`<p>${entry.description}</p>` : ''}
                <div class="row">
                    ${isSeries ? '' : html`<button class="btn btn-primary" data-play>${icon('play')} Lire</button>`}
                    <button class="btn" data-fav>${icon(isFavorite(entry.key) ? 'starFill' : 'star')} ${isFavorite(entry.key) ? 'Retirer des favoris' : 'Ajouter aux favoris'}</button>
                </div>
                ${isSeries ? html`<div data-episodes><div class="row" style="margin-top:18px"><div class="spinner spinner-sm"></div> Chargement des épisodes…</div></div>` : ''}
            </div>
        </div>`,
        onMount: (el) => {
            el.querySelector('[data-play]')?.addEventListener('click', () => {
                m.close();
                ctx.openTheater({key: entry.key, title: entry.name, subtitle: entry.year || entry.category, logo: entry.logo});
            });
            const favBtn = el.querySelector('[data-fav]');
            favBtn.addEventListener('click', async () => {
                await toggleFavorite(entry.key);
                const on = isFavorite(entry.key);
                favBtn.innerHTML = `${icon(on ? 'starFill' : 'star')} ${on ? 'Retirer des favoris' : 'Ajouter aux favoris'}`;
            });
            el.addEventListener('click', (e) => {
                const s = e.target.closest('[data-season]');
                if (s) {
                    season = s.dataset.season;
                    renderEpisodes(el);
                    return;
                }
                const ep = e.target.closest('[data-episode]');
                if (ep) {
                    const found = episodes.find((x) => x.key === ep.dataset.episode);
                    m.close();
                    ctx.openTheater({
                        key: found.key,
                        title: entry.name,
                        subtitle: `${found.season ? `Saison ${found.season} · ` : ''}Épisode ${found.episode}${found.title && !/^Épisode \d+$/.test(found.title) ? ` · ${found.title}` : ''}`,
                        logo: entry.logo,
                    });
                }
            });
        },
    });

    function renderEpisodes(el) {
        const box = el.querySelector('[data-episodes]');
        if (!episodes.length) {
            render(box, html`<p style="margin-top:18px">Aucun épisode disponible.</p>`);
            return;
        }
        const seasons = [...new Set(episodes.map((e) => String(e.season ?? '')))];
        if (season === null || !seasons.includes(season)) season = seasons[0];
        const list = episodes.filter((e) => String(e.season ?? '') === season);
        render(box, html`
            ${seasons.length > 1 || seasons[0] ? html`<div class="seasons segmented">${seasons.map((s) => html`
                <button data-season="${s}" class="${s === season ? 'active' : ''}">${s ? `Saison ${s}` : 'Épisodes'}</button>`)}</div>` : ''}
            <div class="episodes" style="margin-top:12px">${list.map((e) => html`
                <button class="episode" data-episode="${e.key}">
                    <span class="n">E${e.episode}</span>
                    <span class="t">${e.title}</span>
                    ${icon('play')}
                </button>`)}</div>`);
    }

    if (isSeries) {
        api.episodes(state.source.id, entry.key)
            .then((res) => {
                episodes = res.episodes;
                if (m.el.isConnected) renderEpisodes(m.el);
            })
            .catch((err) => {
                const box = m.el.querySelector('[data-episodes]');
                if (box) render(box, html`<p class="error-text" style="margin-top:18px">${err.message}</p>`);
            });
    }
    return m.closed;
}

/**
 * Vue « Films » (kind = 'vod') ou « Séries » (kind = 'series').
 */
export function renderCatalog(root, ctx, kind) {
    const all = (kind === 'vod' ? state.library?.vod : state.library?.series) || [];
    const categories = [...new Set(all.map((e) => e.category))];
    let category = '';
    let query = '';
    let list = null;

    render(root, html`
        <div class="toolbar">
            <label class="search">${icon('search')}<input class="input" type="search" placeholder="${kind === 'vod' ? 'Rechercher un film' : 'Rechercher une série'}" data-search autocomplete="off"></label>
            <select class="input" data-category aria-label="Catégorie">
                <option value="">Toutes les catégories</option>
                ${categories.map((c) => html`<option value="${c}">${c}</option>`)}
            </select>
            <span class="count" data-count></span>
        </div>
        <div class="grid" data-grid></div>`);

    const grid = $('[data-grid]', root);

    function refresh() {
        list?.disconnect();
        const q = normalize(query);
        const items = all.filter((e) => (!category || e.category === category) && (!q || normalize(e.name).includes(q)));
        $('[data-count]', root).textContent = `${items.length} ${kind === 'vod' ? 'film' : 'série'}${items.length > 1 ? 's' : ''}`;
        grid.innerHTML = '';
        if (!items.length) {
            render(grid, html`<div class="empty-state" style="grid-column:1/-1">${icon(kind === 'vod' ? 'film' : 'layers')}
                <p>${all.length ? 'Aucun résultat.' : `Aucun${kind === 'vod' ? ' film' : 'e série'} dans cette source.`}</p></div>`);
            return;
        }
        list = renderIncremental(grid, items, posterCard, {chunk: 60, root: ctx.scroller});
    }

    $('[data-search]', root).addEventListener('input', (e) => {
        query = e.target.value.trim();
        refresh();
    });
    $('[data-category]', root).addEventListener('change', (e) => {
        category = e.target.value;
        refresh();
    });
    grid.addEventListener('click', (e) => {
        const card = e.target.closest('[data-open]');
        if (!card) return;
        const entry = all.find((x) => x.key === card.dataset.open);
        if (entry) openDetail(entry, ctx);
    });

    const unsubscribe = subscribe((type) => {
        if (type === 'favorites') {
            grid.querySelectorAll('[data-open]').forEach((card) => {
                const star = card.querySelector('.star');
                const on = isFavorite(card.dataset.open);
                if (on && !star) card.querySelector('.poster').insertAdjacentHTML('beforeend', `<span class="star">${icon('starFill')}</span>`);
                if (!on && star) star.remove();
            });
        }
    });

    refresh();
    ctx.setKeys((e) => {
        if (e.key === '/') {
            e.preventDefault();
            $('[data-search]', root).focus();
            return true;
        }
        return false;
    });
    return () => {
        list?.disconnect();
        unsubscribe();
    };
}
