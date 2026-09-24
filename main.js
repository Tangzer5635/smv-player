const {app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, clipboard, session} = require('electron');
const path = require('path');
const fs = require('fs');
const {spawn} = require('child_process');
const {createSmvServer} = require('./server');

/*
 * Processus principal Electron
 *
 * L'application embarque son propre serveur (server/) : API, proxy des flux IPTV
 * et transcodage HLS. La fenêtre charge l'interface depuis ce serveur, exactement
 * comme Safari sur iPhone — une seule base de code pour les deux.
 */

let mainWindow = null;
let tray = null;
let smv = null;
let vlcProcess = null;
let isQuitting = false;

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());
}

// ── Fenêtre ───────────────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1920,
        height: 1080,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#1a1a1a',
        frame: false,
        icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            autoplayPolicy: 'no-user-gesture-required',
        },
    });

    mainWindow.loadURL(smv.getLocalUrl());

    const sendWindowState = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('window-state-changed', {
            isMaximized: mainWindow.isMaximized(),
        });
    };

    mainWindow.on('maximize', sendWindowState);
    mainWindow.on('unmaximize', sendWindowState);
    mainWindow.on('enter-full-screen', sendWindowState);
    mainWindow.on('leave-full-screen', sendWindowState);
    mainWindow.webContents.once('did-finish-load', sendWindowState);

    // Fermer la fenêtre peut laisser le serveur tourner pour l'iPhone
    mainWindow.on('close', (event) => {
        if (!isQuitting && smv.config.get().keepRunningInTray) {
            event.preventDefault();
            mainWindow.hide();
            ensureTray();
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Les liens externes s'ouvrent dans le navigateur, jamais dans l'application
    const localOrigin = `http://127.0.0.1:${smv.getPort()}`;
    mainWindow.webContents.setWindowOpenHandler(({url}) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return {action: 'deny'};
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(localOrigin)) {
            event.preventDefault();
            if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        }
    });
}

function showWindow() {
    if (!smv) return;
    if (!mainWindow) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

// ── Zone de notification (serveur actif fenêtre fermée) ──────────────────────
async function buildTrayMenu() {
    const info = await smv.getServerInfo();
    const iphoneUrl = info.urls[0]?.url;
    return Menu.buildFromTemplate([
        {label: 'Ouvrir SMV Player', click: showWindow},
        {type: 'separator'},
        {
            label: iphoneUrl ? `iPhone : ${info.urls[0].address}:${info.port}` : 'Accès réseau désactivé',
            enabled: !!iphoneUrl,
            click: () => clipboard.writeText(iphoneUrl),
        },
        {label: `Code d'accès : ${info.accessKey}`, enabled: false},
        {type: 'separator'},
        {
            label: 'Quitter',
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);
}

async function ensureTray() {
    if (!tray) {
        const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({width: 16, height: 16});
        tray = new Tray(icon);
        tray.setToolTip('SMV Player — serveur actif');
        tray.on('click', showWindow);
    }
    tray.setContextMenu(await buildTrayMenu());
}

function destroyTray() {
    tray?.destroy();
    tray = null;
}

// ── VLC ──────────────────────────────────────────────────────────────────────
function getVlcPath() {
    const configured = (smv.config.get().vlcPath || '').trim();
    if (configured) return configured;
    if (process.platform === 'darwin') return '/Applications/VLC.app/Contents/MacOS/VLC';
    return 'vlc';
}

function stopVlc() {
    if (vlcProcess) {
        vlcProcess.kill('SIGTERM');
        vlcProcess = null;
    }
}

function startVlc(url) {
    stopVlc();
    const args = ['--play-and-exit', url];
    vlcProcess = spawn(getVlcPath(), args, {stdio: 'ignore'});
    vlcProcess.on('exit', () => {
        vlcProcess = null;
    });
    return vlcProcess;
}

// ── Cycle de vie ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    if (process.platform === 'win32') {
        app.setAppUserModelId('com.smv.player');
    }

    try {
        smv = createSmvServer({
            dataDir: app.getPath('userData'),
            appVersion: app.getVersion(),
            // Proxy système Windows / macOS (y compris PAC) pour le portail et les flux
            systemProxyResolver: (url) => session.defaultSession.resolveProxy(url),
        });
        await smv.listen();
    } catch (err) {
        dialog.showErrorBox('SMV Player', `Impossible de démarrer le serveur intégré :\n${err.message}`);
        app.exit(1);
        return;
    }

    createWindow();
    if (smv.config.get().keepRunningInTray) ensureTray();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else showWindow();
    });
});

app.on('before-quit', () => {
    isQuitting = true;
});

app.on('window-all-closed', () => {
    if (smv?.config.get().keepRunningInTray) return;
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    stopVlc();
    smv?.close();
});

// ── IPC (fonctions propres au bureau) ────────────────────────────────────────
ipcMain.handle('browse-file', async (event, {title, extensions} = {}) => {
    const {canceled, filePaths} = await dialog.showOpenDialog(mainWindow, {
        title: title || 'Choisir un fichier',
        filters: extensions?.length
            ? [{name: title || 'Fichier', extensions}, {name: 'Tous les fichiers', extensions: ['*']}]
            : [{name: 'Tous les fichiers', extensions: ['*']}],
        properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return {success: false};
    return {success: true, path: filePaths[0]};
});

ipcMain.handle('vlc-play', async (event, {url}) => {
    try {
        if (!/^https?:\/\//i.test(String(url || ''))) {
            return {success: false, error: 'URL invalide'};
        }
        const configured = (smv.config.get().vlcPath || '').trim();
        if (configured && !fs.existsSync(configured)) {
            return {success: false, error: 'VLC introuvable. Vérifiez le chemin.'};
        }

        const proc = startVlc(url);
        const outcome = await new Promise((resolve) => {
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            proc.once('error', (err) => done({success: false, error: err.message}));
            setTimeout(() => done({success: true}), 300);
        });
        if (!outcome.success) {
            stopVlc();
        }
        return outcome;
    } catch (err) {
        return {success: false, error: err.message};
    }
});

ipcMain.handle('open-external', async (event, url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return {success: false};
    await shell.openExternal(url);
    return {success: true};
});

ipcMain.handle('tray-setting', async (event, enabled) => {
    if (enabled) await ensureTray();
    else destroyTray();
    return {success: true};
});

// ── Contrôles fenêtre ─────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
