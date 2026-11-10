import {api} from '../api.js';
import {html, render} from '../dom.js';

/**
 * Connexion, ou création du compte au premier lancement (code affiché dans
 * les logs du serveur : `docker compose logs smv`).
 */
export function renderAuth(root, {setupRequired, onDone}) {
    render(root, html`<div class="auth">
        <form class="auth-card" data-form autocomplete="on">
            <div class="brand">
                <img src="/icons/icon-192.png" alt="">
                <div><h1>SMV Player</h1><p>${setupRequired ? 'Première installation' : 'Connexion'}</p></div>
            </div>
            ${setupRequired ? html`
                <p class="note">Créez le compte qui protégera votre serveur. Le code d'installation est affiché
                    dans les logs : <code>docker compose logs smv</code>.</p>
                <label class="field"><span>Code d'installation</span>
                    <input class="input code-input" name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false">
                </label>` : ''}
            <label class="field"><span>Identifiant</span>
                <input class="input" name="username" required autocomplete="username" autocapitalize="off" spellcheck="false">
            </label>
            <label class="field"><span>Mot de passe</span>
                <input class="input" name="password" type="password" required autocomplete="${setupRequired ? 'new-password' : 'current-password'}" ${setupRequired ? 'minlength="8"' : ''}>
            </label>
            ${setupRequired ? html`<label class="field"><span>Confirmation</span>
                <input class="input" name="confirm" type="password" required autocomplete="new-password">
            </label>` : html`<label class="check"><input type="checkbox" name="remember" checked> Rester connecté (30 jours)</label>`}
            <div class="error-text" data-error role="alert"></div>
            <button class="btn btn-primary btn-block">${setupRequired ? 'Créer le compte' : 'Se connecter'}</button>
        </form>
    </div>`);

    const form = root.querySelector('form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const error = root.querySelector('[data-error]');
        const button = form.querySelector('button');
        error.textContent = '';
        if (setupRequired && form.password.value !== form.confirm.value) {
            error.textContent = 'Les mots de passe ne correspondent pas';
            return;
        }
        button.disabled = true;
        try {
            if (setupRequired) {
                await api.setup(form.code.value.trim(), form.username.value.trim(), form.password.value);
            } else {
                await api.login(form.username.value.trim(), form.password.value, form.remember.checked);
            }
            onDone();
        } catch (err) {
            error.textContent = err.message;
            button.disabled = false;
        }
    });
}
