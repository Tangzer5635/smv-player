import {icon} from './icons.js';

// ── Gabarits HTML échappés ──────────────────────────────────────────────────
class Raw {
    constructor(value) {
        this.value = String(value);
    }

    // Utilisable aussi dans une chaîne ordinaire (innerHTML, gabarit `...`)
    toString() {
        return this.value;
    }
}

export const raw = (value) => new Raw(value);

export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

function renderValue(value) {
    if (value instanceof Raw) return value.value;
    if (Array.isArray(value)) return value.map(renderValue).join('');
    if (value === null || value === undefined || value === false) return '';
    return esc(value);
}

// html`<p>${texte}</p>` : les valeurs sont échappées, sauf raw(...)
export function html(strings, ...values) {
    let out = '';
    strings.forEach((part, i) => {
        out += part;
        if (i < values.length) out += renderValue(values[i]);
    });
    return raw(out);
}

export function render(target, template) {
    target.innerHTML = template instanceof Raw ? template.value : esc(template);
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ── Images distantes (relayées par le serveur) ──────────────────────────────
export function imgUrl(url) {
    return url ? `/api/img?u=${encodeURIComponent(url)}` : '';
}

export function initials(name) {
    return String(name || '?')
        .replace(/^[A-Z]{2,3}\s*[:|-]\s*/, '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0])
        .join('')
        .toUpperCase() || '?';
}

// Image avec repli sur les initiales si le chargement échoue
export function logoImg(url, name, cls = 'logo') {
    if (!url) return html`<div class="${cls} logo-fallback">${initials(name)}</div>`;
    return html`<img class="${cls}" src="${imgUrl(url)}" alt="" loading="lazy" data-fallback="${initials(name)}">`;
}

document.addEventListener('error', (event) => {
    const img = event.target;
    if (img.tagName !== 'IMG' || !img.dataset.fallback) return;
    const div = document.createElement('div');
    div.className = `${img.className} logo-fallback`;
    div.textContent = img.dataset.fallback;
    img.replaceWith(div);
}, true);

// ── Formatage ───────────────────────────────────────────────────────────────
export function formatClock(ms) {
    return new Date(ms).toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'});
}

export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes) {
    if (!bytes) return '0 o';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function timeAgo(date) {
    const diff = (Date.now() - new Date(date).getTime()) / 1000;
    if (!Number.isFinite(diff)) return '';
    if (diff < 60) return 'à l\'instant';
    if (diff < 3600) return `il y a ${Math.round(diff / 60)} min`;
    if (diff < 86400) return `il y a ${Math.round(diff / 3600)} h`;
    return `il y a ${Math.round(diff / 86400)} j`;
}

export function normalize(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ── Notifications ───────────────────────────────────────────────────────────
let toastHost = null;

export function toast(message, {type = '', duration = 3500} = {}) {
    if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.className = 'toasts';
        toastHost.setAttribute('role', 'status');
        document.body.appendChild(toastHost);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    toastHost.appendChild(el);
    setTimeout(() => el.remove(), duration);
    return el;
}

// ── Fenêtres ────────────────────────────────────────────────────────────────
const openModals = [];

export function modal({title, body, wide = false, onMount, dismissible = true}) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const content = body instanceof Raw ? body.value : esc(body || '');
    backdrop.innerHTML = `
        <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
            <div class="modal-head"><h2>${esc(title)}</h2>
                ${dismissible ? `<button class="icon-btn" data-close aria-label="Fermer">${icon('x')}</button>` : ''}
            </div>
            <div class="modal-body">${content}</div>
        </div>`;
    document.body.appendChild(backdrop);
    let resolveClosed;
    const closed = new Promise((resolve) => {
        resolveClosed = resolve;
    });
    const api = {
        el: backdrop.querySelector('.modal'),
        closed,
        close(value) {
            if (!backdrop.isConnected) return;
            backdrop.remove();
            openModals.splice(openModals.indexOf(api), 1);
            resolveClosed(value);
        },
    };
    openModals.push(api);
    if (dismissible) {
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop || e.target.closest('[data-close]')) api.close(null);
        });
    }
    onMount?.(api.el, api);
    const focusable = api.el.querySelector('input:not([type=hidden]), select, textarea');
    if (focusable && window.matchMedia('(pointer: fine)').matches) setTimeout(() => focusable.focus(), 30);
    return api;
}

export function closeTopModal() {
    const top = openModals[openModals.length - 1];
    if (top) {
        top.close(null);
        return true;
    }
    return false;
}

export function confirmDialog(message, {confirmLabel = 'Confirmer', danger = false, title = 'Confirmation'} = {}) {
    const m = modal({
        title,
        body: html`<p>${message}</p>
            <div class="modal-actions">
                <button class="btn" data-close>Annuler</button>
                <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmLabel}</button>
            </div>`,
        onMount: (el, api) => el.querySelector('[data-ok]').addEventListener('click', () => api.close(true)),
    });
    return m.closed.then((v) => v === true);
}

export function askPin(sourceName) {
    const m = modal({
        title: 'Code parental',
        body: html`<form data-form>
                <p class="note">${sourceName ? `« ${sourceName} » est protégé.` : 'Cette source est protégée.'}</p>
                <label class="field"><span>Code PIN</span>
                    <input class="input code-input" name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" required>
                </label>
                <div class="modal-actions">
                    <button type="button" class="btn" data-close>Annuler</button>
                    <button class="btn btn-primary">Déverrouiller</button>
                </div>
            </form>`,
        onMount: (el, api) => el.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            api.close(e.target.pin.value.trim());
        }),
    });
    return m.closed;
}

// Menu contextuel ancré sous un élément
export function popupMenu(anchor, items) {
    document.querySelector('.menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = items.map((item, i) => (item === '-' ? '<hr>' : `
        <button data-i="${i}" class="${item.active ? 'active' : ''}">
            ${item.color ? `<span class="dot" style="background:${esc(item.color)}"></span>` : ''}
            ${item.icon ? icon(item.icon) : ''}
            <span class="grow">${esc(item.label)}</span>
            ${item.badge ? `<span class="badge">${esc(item.badge)}</span>` : ''}
        </button>`)).join('');
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(menu.offsetWidth, 240);
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 6)}px`;
    const close = () => {
        menu.remove();
        document.removeEventListener('pointerdown', outside, true);
    };
    const outside = (e) => {
        if (!menu.contains(e.target)) close();
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    menu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-i]');
        if (!btn) return;
        close();
        items[Number(btn.dataset.i)].onSelect?.();
    });
}

// ── Rendu progressif des longues listes ─────────────────────────────────────
export function renderIncremental(container, items, renderItem, {chunk = 120, root = null} = {}) {
    let rendered = 0;
    let observer = null;
    const sentinel = document.createElement('div');
    sentinel.className = 'list-more';

    const more = () => {
        const end = Math.min(items.length, rendered + chunk);
        const tmp = document.createElement('div');
        tmp.innerHTML = items.slice(rendered, end).map((item, i) => {
            const out = renderItem(item, rendered + i);
            return out instanceof Raw ? out.value : out;
        }).join('');
        const frag = document.createDocumentFragment();
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        sentinel.before(frag);
        rendered = end;
        if (rendered >= items.length) {
            observer?.disconnect();
            sentinel.remove();
        } else {
            sentinel.textContent = `${rendered} / ${items.length}`;
        }
    };

    container.appendChild(sentinel);
    more();
    if (rendered < items.length) {
        observer = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) more();
        }, {root, rootMargin: '900px 0px'});
        observer.observe(sentinel);
    }
    return {
        // Rend jusqu'à l'index donné (pour faire défiler vers l'élément en cours)
        ensure(index) {
            while (rendered <= index && rendered < items.length) more();
        },
        disconnect() {
            observer?.disconnect();
        },
    };
}
