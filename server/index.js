/*
 * SMV Player — point d'entrée du serveur
 *
 *   node server/index.js
 *
 * Variables d'environnement (voir .env.example) :
 *   SMV_PORT            port HTTP (défaut 9191)
 *   SMV_HOST            interface d'écoute (défaut 0.0.0.0)
 *   SMV_DATA_DIR        dossier des données (défaut ./data)
 *   SMV_TRUST_PROXY     1 derrière un reverse proxy (Caddy) : IP et HTTPS d'origine
 *   SMV_PUBLIC_URL      adresse publique (ex. https://tv.exemple.fr), pour l'affichage
 *   SMV_ADMIN_USER / SMV_ADMIN_PASSWORD   crée le compte au premier démarrage
 */
const http = require('http');
const path = require('path');
const {createApp} = require('./app');
const {getLanAddresses} = require('./utils');
const {version} = require('../package.json');

const env = process.env;
const port = Number.parseInt(env.SMV_PORT, 10) || 9191;
const host = env.SMV_HOST || '0.0.0.0';
const dataDir = path.resolve(env.SMV_DATA_DIR || path.join(__dirname, '..', 'data'));
const trustProxy = /^(1|true|yes)$/i.test(env.SMV_TRUST_PROXY || '');
// Plusieurs adresses possibles (DOMAIN=a.fr, 192.168.1.20) : la première sert à l'affichage
const publicUrl = String(env.SMV_PUBLIC_URL || '').split(',')[0].trim().replace(/\/+$/, '');

async function main() {
    const app = createApp({dataDir, version, trustProxy, publicUrl, getPort: () => port});

    // Compte administrateur fourni par l'environnement (premier démarrage)
    if (!app.auth.hasUsers() && env.SMV_ADMIN_PASSWORD) {
        try {
            await app.auth.createUser(env.SMV_ADMIN_USER || 'admin', env.SMV_ADMIN_PASSWORD);
            console.log(`Compte administrateur « ${env.SMV_ADMIN_USER || 'admin'} » créé depuis SMV_ADMIN_PASSWORD`);
        } catch (err) {
            console.error(`⚠️ SMV_ADMIN_PASSWORD ignoré : ${err.message}`);
        }
    }

    const server = http.createServer((req, res) => {
        app.handle(req, res).catch((err) => {
            console.error('❌ Serveur:', err.message);
            if (!res.headersSent) {
                res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
                res.end('Erreur serveur');
            } else {
                res.destroy();
            }
        });
    });
    // Flux longs : pas de délai d'inactivité côté serveur
    server.requestTimeout = 0;
    server.keepAliveTimeout = 65 * 1000;

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });

    console.log('');
    console.log('══════════════════════════════════════════════════════');
    console.log(` SMV Player ${version}`);
    console.log(` Données   : ${dataDir}`);
    console.log(` Local     : http://127.0.0.1:${port}`);
    if (publicUrl) console.log(` Public    : ${publicUrl}`);
    else getLanAddresses().slice(0, 3).forEach((a) => console.log(` Réseau    : http://${a.address}:${port}`));
    if (!app.auth.hasUsers()) {
        console.log('');
        console.log(` Première connexion : ouvrez l'adresse ci-dessus et saisissez`);
        console.log(` le code d'installation : ${app.auth.setupCode}`);
    }
    console.log('══════════════════════════════════════════════════════');

    let stopping = false;
    const shutdown = (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`${signal} reçu, arrêt…`);
        app.shutdown();
        server.close(() => process.exit(0));
        server.closeAllConnections?.();
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
    console.error('Impossible de démarrer SMV Player :', err.message);
    process.exit(1);
});
