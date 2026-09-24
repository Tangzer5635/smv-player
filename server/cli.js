/*
 * SMV Player — mode serveur sans interface (NAS, Raspberry Pi, PC toujours allumé…)
 *
 *   node server/cli.js [--port 9191] [--data-dir ~/.smv-player] [--host 0.0.0.0]
 */
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const {createSmvServer} = require('./index');
const {version} = require('../package.json');

function readArg(name, fallback) {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    return process.env[`SMV_${name.toUpperCase().replace(/-/g, '_')}`] || fallback;
}

async function main() {
    const dataDir = path.resolve(readArg('data-dir', path.join(os.homedir(), '.smv-player')));
    const host = readArg('host', '0.0.0.0');
    const port = readArg('port', undefined);

    const smv = createSmvServer({dataDir, host, port, appVersion: version});
    await smv.listen();

    const info = await smv.getServerInfo();
    console.log('');
    console.log('══════════════════════════════════════════════════════');
    console.log(` SMV Player ${version} — serveur démarré`);
    console.log(` Données : ${dataDir}`);
    console.log(` Local   : ${smv.getLocalUrl()}`);
    info.urls.forEach((u) => console.log(` Réseau  : ${u.url}  (${u.name})`));
    console.log(` Code d'accès : ${info.accessKey}`);
    console.log('══════════════════════════════════════════════════════');
    if (info.urls[0]) {
        console.log(' Scannez ce QR code avec l\'appareil photo de l\'iPhone :');
        console.log(await QRCode.toString(info.urls[0].url, {type: 'terminal', small: true}));
    }

    const shutdown = async () => {
        console.log('Arrêt du serveur…');
        await smv.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('Impossible de démarrer le serveur:', err.message);
    process.exit(1);
});
