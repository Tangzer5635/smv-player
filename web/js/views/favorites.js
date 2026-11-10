import {html, logoImg, render, timeAgo} from '../dom.js';
import {icon} from '../icons.js';
import {isFavorite, item, state, subscribe} from '../store.js';
import {openDetail, posterCard} from './catalog.js';

function channelRow(ch, extra = '') {
    return html`<div class="channel" data-live="${ch.key}" role="button" tabindex="0">
        ${logoImg(ch.logo, ch.name)}
        <span class="info"><span class="name">${ch.name}</span><span class="sub">${extra || ch.group}</span></span>
        ${icon('play')}
    </div>`;
}

/**
 * Favoris et historique de la source active.
 */
export function renderFavorites(root, ctx) {
    function draw() {
        const lib = state.library;
        const favs = [...state.favorites].map(item).filter(Boolean);
        const channels = favs.filter((e) => e.key.startsWith('live:'));
        const movies = favs.filter((e) => e.key.startsWith('vod:'));
        const series = favs.filter((e) => e.key.startsWith('series:'));
        const recent = state.history.map((h) => ({entry: item(h.key), at: h.at})).filter((r) => r.entry).slice(0, 15);

        if (!lib) return;
        if (!favs.length && !recent.length) {
            render(root, html`<div class="empty-state" style="min-height:60%">${icon('star')}
                <h2>Pas encore de favoris</h2>
                <p>Touchez l'étoile d'une chaîne, d'un film ou d'une série pour la retrouver ici.</p></div>`);
            return;
        }
        render(root, html`<div class="view-pad">
            ${channels.length ? html`<h2 class="section-title">${icon('tv')} Chaînes <span class="badge">${channels.length}</span></h2>
                <div class="rows">${channels.map((ch) => channelRow(ch))}</div>` : ''}
            ${movies.length ? html`<h2 class="section-title">${icon('film')} Films <span class="badge">${movies.length}</span></h2>
                <div class="grid compact">${movies.map(posterCard)}</div>` : ''}
            ${series.length ? html`<h2 class="section-title">${icon('layers')} Séries <span class="badge">${series.length}</span></h2>
                <div class="grid compact">${series.map(posterCard)}</div>` : ''}
            ${recent.length ? html`<h2 class="section-title">${icon('clock')} Récemment regardé</h2>
                <div class="rows">${recent.map(({entry, at}) => (entry.key.startsWith('live:')
                    ? channelRow(entry, `${entry.group} · ${timeAgo(at)}`)
                    : html`<div class="channel" data-open="${entry.key}" role="button" tabindex="0">
                        ${logoImg(entry.logo, entry.name)}
                        <span class="info"><span class="name">${entry.name}</span><span class="sub">Film · ${timeAgo(at)}</span></span>
                        ${icon(isFavorite(entry.key) ? 'starFill' : 'play')}
                    </div>`))}</div>` : ''}
        </div>`);
    }

    root.addEventListener('click', (e) => {
        const liveRow = e.target.closest('[data-live]');
        if (liveRow) {
            ctx.navigate('direct', {play: liveRow.dataset.live});
            return;
        }
        const open = e.target.closest('[data-open]');
        if (open) {
            const entry = item(open.dataset.open);
            if (entry) openDetail(entry, ctx);
        }
    });

    const unsubscribe = subscribe((type) => {
        if (type === 'favorites' || type === 'history') draw();
    });
    draw();
    return unsubscribe;
}
