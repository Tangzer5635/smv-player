import {api, pins} from '../api.js';
import {$, askPin, confirmDialog, formatBytes, html, render, timeAgo, toast} from '../dom.js';
import {icon} from '../icons.js';
import {QUALITIES} from '../player.js';
import {loadSources, prefs, savePrefs, selectInitialSource, selectSource, state, subscribe} from '../store.js';
import {openSourceForm, refreshSource} from './source-form.js';

const PROXY_SOURCES = {config: 'paramètres', env: 'variables d\'environnement', system: 'proxy système'};

// Une source protégée doit être déverrouillée avant toute action
async function ensureUnlocked(source) {
    if (!source.locked || pins.get(source.id)) return true;
    const pin = await askPin(source.name);
    if (!pin) return false;
    pins.set(source.id, pin);
    try {
        await api.unlock(source.id);
        return true;
    } catch (err) {
        pins.clear(source.id);
        toast(err.message, {type: 'error'});
        return false;
    }
}

function sourceStatus(s) {
    if (s.status === 'loading') return html`<span class="badge badge-accent"><span class="spinner spinner-sm"></span> chargement</span>`;
    if (s.status === 'error') return html`<span class="badge badge-danger">erreur</span>`;
    return '';
}

export function renderSettings(root, ctx) {
    let systemTimer = null;

    render(root, html`<div class="view-pad"><div class="settings">
        <section class="panel">
            <h2>${icon('database')} Sources</h2>
            <p class="hint">Portails Stalker et listes M3U. La lecture et les identifiants restent sur le serveur.</p>
            <div data-sources></div>
            <div class="row" style="margin-top:14px">
                <button class="btn btn-primary" data-add>${icon('plus')} Ajouter une source</button>
            </div>
        </section>

        <section class="panel">
            <h2>${icon('signal')} Lecture sur cet appareil</h2>
            <p class="hint">Réduisez la qualité pour regarder hors de chez vous (4G, Wi-Fi lent) : le serveur réencode la vidéo.</p>
            <div class="field"><span>Qualité</span>
                <div class="segmented" data-quality>${QUALITIES.map((q) => html`
                    <button data-value="${q.value}" class="${prefs.quality === q.value ? 'active' : ''}">${q.label}</button>`)}</div>
            </div>
            <div class="field"><span>Moteur</span>
                <div class="segmented" data-mode>
                    <button data-value="auto" class="${prefs.mode === 'auto' ? 'active' : ''}">Automatique</button>
                    <button data-value="hls" class="${prefs.mode === 'hls' ? 'active' : ''}">Toujours transcodé (compatibilité)</button>
                    <button data-value="direct" class="${prefs.mode === 'direct' ? 'active' : ''}">Toujours direct</button>
                </div>
            </div>
        </section>

        <section class="panel">
            <h2>${icon('globe')} Réseau IPTV</h2>
            <p class="hint">Réglages du serveur, communs à tous les appareils.</p>
            <form data-network>
                <div class="grid-2">
                    <label class="field"><span>User-Agent</span><input class="input" name="userAgent"></label>
                    <label class="field"><span>Délai réseau (s)</span><input class="input" name="networkTimeout" type="number" min="5" max="300"></label>
                    <label class="field"><span>Referer</span><input class="input" name="referrer" autocapitalize="off"></label>
                    <label class="field"><span>En-têtes (clé:valeur,clé2:valeur2)</span><input class="input" name="headerFields" autocapitalize="off"></label>
                </div>
                <label class="field"><span>Proxy HTTP sortant</span>
                    <input class="input" name="httpProxy" placeholder="http://proxy:8080 — vide : variables d'environnement" autocapitalize="off">
                    <small data-proxy-status></small>
                </label>
                <label class="field"><span>Vidéo transcodée</span>
                    <select class="input" name="hlsVideoMode">
                        <option value="copy">Copie sans réencodage si possible (recommandé)</option>
                        <option value="h264">Toujours réencoder en H.264 (compatibilité maximale)</option>
                    </select>
                </label>
                <div class="error-text" data-error></div>
                <button class="btn btn-primary">Enregistrer</button>
            </form>
        </section>

        <section class="panel">
            <h2>${icon('phone')} Installer sur iPhone</h2>
            <div class="install">
                <img class="qr" data-qr alt="QR code de l'adresse" hidden>
                <ol>
                    <li>Ouvrez <strong data-url>${location.origin}</strong> dans Safari (ou scannez le QR code).</li>
                    <li>Touchez <strong>Partager</strong> puis <strong>Sur l'écran d'accueil</strong>.</li>
                    <li>Lancez SMV Player depuis son icône et connectez-vous.</li>
                </ol>
            </div>
        </section>

        <section class="panel">
            <h2>${icon('user')} Compte</h2>
            <p class="hint">Connecté en tant que <strong>${state.user?.username || ''}</strong>.</p>
            <form data-password>
                <div class="grid-2">
                    <label class="field"><span>Mot de passe actuel</span><input class="input" name="current" type="password" autocomplete="current-password" required></label>
                    <label class="field"><span>Nouveau mot de passe</span><input class="input" name="next" type="password" autocomplete="new-password" minlength="8" required></label>
                </div>
                <div class="error-text" data-error></div>
                <div class="row">
                    <button class="btn">Changer le mot de passe</button>
                    <span class="grow"></span>
                    <button type="button" class="btn btn-ghost" data-logout-all>Déconnecter tous les appareils</button>
                    <button type="button" class="btn btn-danger" data-logout>${icon('logout')} Se déconnecter</button>
                </div>
            </form>
        </section>

        <section class="panel">
            <h2>${icon('activity')} Système</h2>
            <div data-system><div class="spinner spinner-sm"></div></div>
        </section>
    </div></div>`);

    function drawSources() {
        const box = $('[data-sources]', root);
        if (!state.sources.length) {
            render(box, html`<p class="hint">Aucune source pour l'instant.</p>`);
            return;
        }
        render(box, html`${state.sources.map((s) => html`
            <div class="source-row" data-id="${s.id}">
                <span class="dot" style="background:${s.color}"></span>
                <div class="info">
                    <div class="name">${s.name} ${s.locked ? html`<span title="Protégée par PIN">${icon('lock')}</span>` : ''}
                        ${state.source?.id === s.id ? html`<span class="badge badge-ok">active</span>` : ''} ${sourceStatus(s)}</div>
                    <div class="meta">${s.type === 'stalker' ? `Portail · ${s.portalUrl}` : s.hasM3uUrl ? `M3U · ${s.m3uUrl}` : 'M3U importé'}</div>
                    <div class="meta">${s.counts.live} chaînes · ${s.counts.vod} films · ${s.counts.series} séries${s.libraryUpdatedAt ? ` · mis à jour ${timeAgo(s.libraryUpdatedAt)}` : ''}</div>
                    ${s.error ? html`<div class="meta" style="color:var(--danger)">${s.error}</div>` : ''}
                </div>
                <div class="actions">
                    ${state.source?.id !== s.id ? html`<button class="icon-btn" data-act="open" title="Ouvrir">${icon('play')}</button>` : ''}
                    ${s.type === 'stalker' || s.hasM3uUrl ? html`<button class="icon-btn" data-act="refresh" title="Actualiser">${icon('refresh')}</button>` : ''}
                    <button class="icon-btn" data-act="edit" title="Modifier">${icon('edit')}</button>
                    <button class="icon-btn btn-danger" data-act="delete" title="Supprimer">${icon('trash')}</button>
                </div>
            </div>`)}`);
    }

    async function drawSystem() {
        try {
            const sys = await api.system();
            const proxy = sys.proxy?.address ? `${sys.proxy.address} (${PROXY_SOURCES[sys.proxy.source] || sys.proxy.source})` : 'connexion directe';
            const status = $('[data-proxy-status]', root);
            if (status) status.textContent = `Proxy utilisé : ${proxy}`;
            render($('[data-system]', root), html`
                <dl class="kv">
                    <dt>Version</dt><dd>${sys.version}</dd>
                    <dt>Transcodage</dt><dd>${sys.ffmpeg ? html`<span class="badge badge-ok">ffmpeg disponible</span>` : html`<span class="badge badge-danger">ffmpeg absent</span>`}</dd>
                    <dt>Serveur</dt><dd>Node ${sys.node} · ${sys.platform}/${sys.arch} · en ligne depuis ${Math.round(sys.uptime / 60)} min</dd>
                    <dt>Réseau</dt><dd>${proxy}</dd>
                </dl>
                <h3 style="margin:18px 0 6px;font-size:15px">Lectures en cours</h3>
                ${sys.streams.length ? sys.streams.map((s) => html`
                    <div class="stream-row">
                        <div class="info">
                            <div><strong>${s.title}</strong> ${s.transcoding ? html`<span class="badge badge-accent">${s.quality === 'source' ? 'transcodé' : s.quality}</span>` : ''}</div>
                            <div class="meta">${s.device} · ${s.client} · ${s.source} · ${formatBytes(s.bytes)} · ${timeAgo(s.startedAt)}</div>
                        </div>
                        <button class="btn btn-sm" data-stop="${s.id}">Arrêter</button>
                    </div>`) : html`<p class="hint" style="margin:0">Aucune lecture en cours.</p>`}`);
        } catch (err) {
            render($('[data-system]', root), html`<p class="error-text">${err.message}</p>`);
        }
    }

    async function loadNetwork() {
        try {
            const settings = await api.settings();
            const form = $('[data-network]', root);
            for (const [k, v] of Object.entries(settings)) if (form[k]) form[k].value = v ?? '';
        } catch (_) {
        }
    }

    root.addEventListener('click', async (e) => {
        if (e.target.closest('[data-add]')) {
            openSourceForm();
            return;
        }
        const q = e.target.closest('[data-quality] [data-value]');
        if (q) {
            savePrefs({quality: q.dataset.value});
            root.querySelectorAll('[data-quality] button').forEach((b) => b.classList.toggle('active', b === q));
            toast(q.dataset.value === 'source' ? 'Qualité d\'origine' : `Qualité ${q.dataset.value} : appliquée à la prochaine lecture`);
            return;
        }
        const mode = e.target.closest('[data-mode] [data-value]');
        if (mode) {
            savePrefs({mode: mode.dataset.value});
            root.querySelectorAll('[data-mode] button').forEach((b) => b.classList.toggle('active', b === mode));
            return;
        }
        const stop = e.target.closest('[data-stop]');
        if (stop) {
            await api.stopStream(stop.dataset.stop).catch(() => null);
            if (ctx.player.playback?.id === stop.dataset.stop) ctx.player.stop();
            drawSystem();
            return;
        }
        if (e.target.closest('[data-logout]')) {
            ctx.player.stop();
            await api.logout().catch(() => null);
            location.reload();
            return;
        }
        if (e.target.closest('[data-logout-all]')) {
            if (!(await confirmDialog('Tous les appareils connectés (y compris celui-ci) devront se reconnecter.', {confirmLabel: 'Déconnecter partout'}))) return;
            ctx.player.stop();
            await api.logoutAll().catch(() => null);
            location.reload();
            return;
        }
        const act = e.target.closest('[data-act]');
        const row = e.target.closest('.source-row');
        if (!act || !row) return;
        const source = state.sources.find((s) => s.id === row.dataset.id);
        if (!source || !(await ensureUnlocked(source))) return;
        if (act.dataset.act === 'open') {
            await selectSource(source.id).catch((err) => toast(err.message, {type: 'error'}));
            ctx.navigate('direct');
        } else if (act.dataset.act === 'refresh') {
            await refreshSource(source);
        } else if (act.dataset.act === 'edit') {
            await openSourceForm(source);
        } else if (act.dataset.act === 'delete') {
            if (!(await confirmDialog(`Supprimer « ${source.name} », ses favoris et son historique ?`, {confirmLabel: 'Supprimer', danger: true}))) return;
            try {
                await api.deleteSource(source.id);
                pins.clear(source.id);
                if (state.source?.id === source.id) ctx.player.stop();
                await loadSources();
                if (state.source?.id === source.id || !state.source) await selectInitialSource();
                toast('Source supprimée');
            } catch (err) {
                toast(err.message, {type: 'error'});
            }
        }
    });

    $('[data-network]', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const error = $('[data-error]', form);
        error.textContent = '';
        try {
            await api.saveSettings({
                userAgent: form.userAgent.value.trim(),
                networkTimeout: Number(form.networkTimeout.value) || 60,
                referrer: form.referrer.value.trim(),
                headerFields: form.headerFields.value.trim(),
                httpProxy: form.httpProxy.value.trim(),
                hlsVideoMode: form.hlsVideoMode.value,
            });
            toast('Réglages réseau enregistrés', {type: 'ok'});
            drawSystem();
        } catch (err) {
            error.textContent = err.message;
        }
    });

    $('[data-password]', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const error = $('[data-error]', form);
        error.textContent = '';
        try {
            await api.changePassword(form.current.value, form.next.value);
            form.reset();
            toast('Mot de passe changé : les autres appareils devront se reconnecter', {type: 'ok'});
        } catch (err) {
            error.textContent = err.message;
        }
    });

    api.qr(location.origin).then(({dataUrl}) => {
        const img = $('[data-qr]', root);
        if (img) {
            img.src = dataUrl;
            img.hidden = false;
        }
    }).catch(() => null);

    const unsubscribe = subscribe((type) => {
        if (type === 'sources' || type === 'library') drawSources();
    });
    drawSources();
    loadNetwork();
    drawSystem();
    systemTimer = setInterval(drawSystem, 5000);
    // Rafraîchit l'état des sources en cours de chargement
    const sourcesTimer = setInterval(() => {
        if (state.sources.some((s) => s.status === 'loading')) loadSources().catch(() => null);
    }, 3000);

    return () => {
        clearInterval(systemTimer);
        clearInterval(sourcesTimer);
        unsubscribe();
    };
}
