import {api} from '../api.js';
import {html, modal, toast} from '../dom.js';
import {icon} from '../icons.js';
import {loadSources, selectSource} from '../store.js';

const COLORS = ['#7c5cff', '#00b894', '#e17055', '#0984e3', '#e84393', '#fdcb6e', '#00cec9', '#d63031'];

function formatMac(value) {
    const hex = value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 12);
    return hex.match(/.{1,2}/g)?.join(':') || '';
}

// Suit le chargement de la bibliothèque dans la fenêtre ouverte
async function followJob(el, jobId) {
    const status = el.querySelector('[data-status]');
    status.innerHTML = '<div class="row"><div class="spinner spinner-sm"></div><span data-progress>Chargement…</span></div>';
    const progress = status.querySelector('[data-progress]');
    const result = await api.waitJob(jobId, (p) => {
        progress.textContent = p?.message || 'Chargement…';
    });
    return result;
}

function stalkerFields(source = {}) {
    return html`
        <label class="field"><span>Adresse du portail</span>
            <input class="input" name="portalUrl" placeholder="http://exemple.com/c/" value="${source.portalUrl || ''}" required autocomplete="off" autocapitalize="off">
        </label>
        <label class="field"><span>Adresse MAC</span>
            <input class="input" name="mac" placeholder="00:1A:79:XX:XX:XX" value="${source.mac || ''}" required maxlength="17" autocomplete="off" autocapitalize="characters">
        </label>
        <label class="check"><input type="checkbox" name="frenchOnly" ${source.frenchOnly === false ? '' : 'checked'}> Uniquement les catégories françaises</label>`;
}

/**
 * Ajout (source absente) ou modification d'une source.
 */
export function openSourceForm(source = null) {
    const editing = !!source;
    let type = source?.type === 'm3u' ? (source.hasM3uUrl ? 'm3u' : 'file') : 'stalker';

    const body = () => html`
        <form data-form autocomplete="off">
            ${editing ? '' : html`<div class="segmented" data-types style="margin-bottom:16px">
                <button type="button" data-type="stalker" class="${type === 'stalker' ? 'active' : ''}">Portail Stalker</button>
                <button type="button" data-type="m3u" class="${type === 'm3u' ? 'active' : ''}">Liste M3U / Xtream</button>
                <button type="button" data-type="file" class="${type === 'file' ? 'active' : ''}">Fichier M3U</button>
            </div>`}
            <label class="field"><span>Nom</span>
                <input class="input" name="name" value="${source?.name || ''}" placeholder="Ma TV" required maxlength="80">
            </label>
            ${type === 'stalker' ? stalkerFields(source || {}) : ''}
            ${type === 'm3u' ? html`<label class="field"><span>Adresse de la liste</span>
                <input class="input" name="m3uUrl" type="url" value="${source?.m3uUrl || ''}" placeholder="http://serveur/get.php?username=…&password=…&type=m3u_plus" ${editing ? '' : 'required'} autocapitalize="off">
                ${editing ? html`<small>Laissez l'adresse masquée (***) pour la conserver.</small>` : ''}
            </label>` : ''}
            ${type === 'file' && !editing ? html`<label class="field"><span>Fichier .m3u</span>
                <input class="input" name="file" type="file" required>
                <small>La liste est copiée sur le serveur ; pour l'actualiser, réimportez le fichier.</small>
            </label>` : ''}
            ${editing ? html`
                <div class="field"><span>Couleur</span>
                    <div class="row" data-colors>${COLORS.map((c) => html`<button type="button" class="icon-btn" data-color="${c}" aria-label="${c}"
                        style="background:${c};width:30px;height:30px;outline:${c === source.color ? '3px solid #fff' : 'none'};outline-offset:2px"></button>`)}</div>
                    <input type="hidden" name="color" value="${source.color}">
                </div>
                <label class="field"><span>Code PIN parental ${source.locked ? '(défini)' : ''}</span>
                    <input class="input" name="pin" type="password" inputmode="numeric" maxlength="8" placeholder="${source.locked ? 'Laisser vide pour conserver' : '4 à 8 chiffres (facultatif)'}" autocomplete="new-password">
                </label>
                ${source.locked ? html`<label class="check"><input type="checkbox" name="removePin"> Supprimer le code PIN</label>` : ''}` : ''}
            <div class="error-text" data-error></div>
            <div data-status></div>
            <div class="modal-actions">
                <button type="button" class="btn" data-close>Annuler</button>
                <button class="btn btn-primary" data-submit>${editing ? 'Enregistrer' : html`${icon('plus')} Ajouter`}</button>
            </div>
        </form>`;

    const m = modal({
        title: editing ? 'Modifier la source' : 'Ajouter une source',
        body: body(),
        onMount: (el, ctrl) => bind(el, ctrl),
    });

    function rerender() {
        const values = Object.fromEntries(new FormData(m.el.querySelector('form')));
        m.el.querySelector('.modal-body').innerHTML = body().value;
        const name = m.el.querySelector('[name=name]');
        if (values.name) name.value = values.name;
        bind(m.el, m);
    }

    function bind(el, ctrl) {
        const form = el.querySelector('form');
        el.querySelectorAll('[data-type]').forEach((btn) => btn.addEventListener('click', () => {
            type = btn.dataset.type;
            rerender();
        }));
        el.querySelector('[name=mac]')?.addEventListener('input', (e) => {
            e.target.value = formatMac(e.target.value);
        });
        el.querySelectorAll('[data-color]').forEach((btn) => btn.addEventListener('click', () => {
            form.color.value = btn.dataset.color;
            el.querySelectorAll('[data-color]').forEach((b) => {
                b.style.outline = b === btn ? '3px solid #fff' : 'none';
            });
        }));
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            submit(form, el, ctrl);
        });
    }

    async function submit(form, el, ctrl) {
        const error = el.querySelector('[data-error]');
        const button = el.querySelector('[data-submit]');
        error.textContent = '';
        button.disabled = true;
        try {
            const data = {name: form.name.value.trim()};
            let res;
            if (editing) {
                if (form.color) data.color = form.color.value;
                if (form.removePin?.checked) data.pin = '';
                else if (form.pin?.value) data.pin = form.pin.value.trim();
                if (source.type === 'stalker') {
                    data.portalUrl = form.portalUrl.value.trim();
                    data.mac = form.mac.value.trim();
                    data.frenchOnly = form.frenchOnly.checked;
                }
                if (form.m3uUrl) data.m3uUrl = form.m3uUrl.value.trim();
                res = await api.updateSource(source.id, data);
            } else if (type === 'stalker') {
                res = await api.createSource({
                    ...data, type: 'stalker', portalUrl: form.portalUrl.value.trim(), mac: form.mac.value.trim(),
                    frenchOnly: form.frenchOnly.checked,
                });
            } else if (type === 'm3u') {
                res = await api.createSource({...data, type: 'm3u', m3uUrl: form.m3uUrl.value.trim()});
            } else {
                const file = form.file.files[0];
                if (!file) throw new Error('Choisissez un fichier');
                res = await api.createSource({...data, type: 'm3u', m3uContent: await file.text()});
            }
            if (res.jobId) {
                const result = await followJob(el, res.jobId);
                const c = result?.counts;
                if (c) toast(`${c.live} chaînes, ${c.vod} films, ${c.series} séries`, {type: 'ok'});
            }
            await loadSources();
            if (!editing || res.jobId) await selectSource(res.source.id).catch(() => null);
            ctrl.close(res.source);
            if (editing && !res.jobId) toast('Source enregistrée', {type: 'ok'});
        } catch (err) {
            error.textContent = err.message;
            el.querySelector('[data-status]').innerHTML = '';
            await loadSources().catch(() => null);
        } finally {
            button.disabled = false;
        }
    }

    return m.closed;
}

// Actualisation d'une source avec progression dans une fenêtre
export async function refreshSource(source) {
    const m = modal({
        title: `Actualiser « ${source.name} »`,
        body: html`<div data-status></div><div class="error-text" data-error></div>
            <div class="modal-actions"><button class="btn" data-close>Fermer</button></div>`,
    });
    try {
        const {jobId} = await api.refreshSource(source.id);
        const result = await followJob(m.el, jobId);
        await loadSources();
        await selectSource(source.id).catch(() => null);
        const c = result?.counts;
        toast(c ? `À jour : ${c.live} chaînes, ${c.vod} films, ${c.series} séries` : 'Source actualisée', {type: 'ok'});
        m.close(true);
    } catch (err) {
        m.el.querySelector('[data-status]').innerHTML = '';
        m.el.querySelector('[data-error]').textContent = err.message;
        await loadSources().catch(() => null);
    }
}
