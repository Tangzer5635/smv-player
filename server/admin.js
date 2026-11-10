/*
 * Administration en ligne de commande
 *
 *   node server/admin.js reset-password <identifiant> <nouveau-mot-de-passe>
 *   node server/admin.js list-users
 *
 * Avec Docker :
 *   docker compose exec smv node server/admin.js reset-password admin 'nouveau mot de passe'
 */
const fs = require('fs');
const path = require('path');
const {AuthStore} = require('./auth');

const dataDir = path.resolve(process.env.SMV_DATA_DIR || path.join(__dirname, '..', 'data'));
const [command, username, password] = process.argv.slice(2);

// Lancé en root (docker compose exec) : on prend l'identité du propriétaire des données
// pour que le serveur puisse toujours relire les fichiers écrits ici.
if (process.getuid?.() === 0) {
    try {
        const {uid, gid} = fs.statSync(dataDir);
        if (uid !== 0) {
            process.setgid(gid);
            process.setuid(uid);
        }
    } catch { /* dossier absent : créé plus bas */ }
}

async function main() {
    const auth = new AuthStore(dataDir);
    if (command === 'list-users') {
        auth.users.forEach((u) => console.log(`${u.username} (créé le ${u.createdAt})`));
        if (!auth.users.length) console.log('Aucun compte : le code d\'installation s\'affiche au démarrage du serveur.');
        return;
    }
    if (command === 'reset-password' && username && password) {
        if (auth.find(username)) {
            await auth.resetPassword(username, password);
            console.log(`Mot de passe de « ${username} » changé. Les appareils connectés devront se reconnecter.`);
        } else {
            await auth.createUser(username, password);
            console.log(`Compte « ${username} » créé.`);
        }
        return;
    }
    console.log('Usage :');
    console.log('  node server/admin.js reset-password <identifiant> <nouveau-mot-de-passe>');
    console.log('  node server/admin.js list-users');
    process.exitCode = 1;
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
