const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

let mainWindow;
let proxyServer = null;
let currentProxyTarget = null;
let currentProxyHeaders = {};
let vlcProcess = null;

const DEFAULT_CONFIG = {
  userAgent: 'Lavf/57.83.100',
  networkTimeout: 60,
  referrer: '',
  headerFields: '',
  vlcPath: '',
};

let appConfig = { ...DEFAULT_CONFIG };

// ── Chemin fichier profils ────────────────────────────────────────────────────
const profilesPath = path.join(app.getPath('userData'), 'profiles.json');

function normalizeProfile(profile) {
  return {
    ...profile,
    channels: Array.isArray(profile.channels) ? profile.channels : [],
    favoriteChannelIds: Array.isArray(profile.favoriteChannelIds) ? profile.favoriteChannelIds : [],
  };
}

function getProfileItemKeys(item) {
  const id = String(item?.id ?? '');
  const type = String(item?.contentType || item?.type || 'live');
  return [id, `${type}:${id}`];
}

function loadProfiles() {
  try {
    if (fs.existsSync(profilesPath)) {
      const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf-8'));
      return Array.isArray(profiles) ? profiles.map(normalizeProfile) : [];
    }
  } catch (e) {
    console.error('Erreur lecture profils:', e.message);
  }
  return [];
}

function saveProfiles(profiles) {
  try {
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Erreur sauvegarde profils:', e.message);
    return false;
  }
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
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  if (process.platform === "win32") {
    app.setAppUserModelId("com.smv.player");
  }

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

  mainWindow.loadFile('renderer/index.html');
  mainWindow.webContents.once('did-finish-load', sendWindowState);
}

function getVlcPath() {
  const configured = (appConfig.vlcPath || '').trim();
  if (configured) return configured;
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
  const vlcPath = getVlcPath();
  const args = ['--play-and-exit', url];
  vlcProcess = spawn(vlcPath, args, { stdio: 'ignore' });
  vlcProcess.on('exit', () => {
    vlcProcess = null;
  });
  return vlcProcess;
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.smv.player');
  }

  createWindow();
  startProxyServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (proxyServer) proxyServer.close();
  stopVlc();
  if (process.platform !== 'darwin') app.quit();
});

// ── Config ────────────────────────────────────────────────────────────────────
ipcMain.handle('update-config', (event, config) => {
  appConfig = { ...appConfig, ...config };
  return appConfig;
});

ipcMain.handle('get-config', () => appConfig);

// ── Profils IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('profiles-list', () => {
  const profiles = loadProfiles();
  return profiles.map(p => ({
    id: p.id,
    name: p.name,
    type: p.type,
    portalUrl: p.portalUrl || '',
    mac: p.mac || '',
    channelCount: (p.channels || []).length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
});

ipcMain.handle('profile-save', (event, { name, type, portalUrl, mac, channels, stalkerSession, favoriteChannelIds }) => {
  const profiles = loadProfiles();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = new Date().toISOString();

  const profile = {
    id,
    name,
    type,
    portalUrl: portalUrl || '',
    mac: mac || '',
    channels: channels || [],
    favoriteChannelIds: Array.isArray(favoriteChannelIds) ? favoriteChannelIds : [],
    stalkerSession: stalkerSession || null,
    createdAt: now,
    updatedAt: now,
  };

  profiles.push(profile);
  saveProfiles(profiles);
  console.log(`💾 Profil sauvegardé: ${name} (${channels.length} chaînes)`);

  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    portalUrl: profile.portalUrl,
    mac: profile.mac,
    channelCount: profile.channels.length,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
});

ipcMain.handle('profile-load', (event, profileId) => {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return { success: false, error: 'Profil introuvable' };

  console.log(`📂 Profil chargé: ${profile.name} (${profile.channels.length} chaînes)`);
  return { success: true, profile: normalizeProfile(profile) };
});

ipcMain.handle('profile-delete', (event, profileId) => {
  let profiles = loadProfiles();
  const idx = profiles.findIndex(p => p.id === profileId);
  if (idx === -1) return { success: false, error: 'Profil introuvable' };

  const name = profiles[idx].name;
  profiles.splice(idx, 1);
  saveProfiles(profiles);
  console.log(`🗑️ Profil supprimé: ${name}`);
  return { success: true };
});

ipcMain.handle('profile-update', (event, { id, channels, stalkerSession, favoriteChannelIds }) => {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === id);
  if (!profile) return { success: false, error: 'Profil introuvable' };

  if (Array.isArray(channels)) {
    profile.channels = channels;

    if (Array.isArray(profile.favoriteChannelIds) && profile.favoriteChannelIds.length) {
      const availableIds = new Set(
        channels.flatMap((channel) => getProfileItemKeys(channel))
      );
      profile.favoriteChannelIds = profile.favoriteChannelIds.filter((favId) => availableIds.has(String(favId)));
    }
  }
  if (stalkerSession) profile.stalkerSession = stalkerSession;
  if (Array.isArray(favoriteChannelIds)) profile.favoriteChannelIds = favoriteChannelIds;
  profile.updatedAt = new Date().toISOString();
  saveProfiles(profiles);
  console.log(`🔄 Profil mis à jour: ${profile.name}`);
  return { success: true };
});

ipcMain.handle('profile-rename', (event, { id, name }) => {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === id);
  if (!profile) return { success: false, error: 'Profil introuvable' };

  profile.name = name;
  profile.updatedAt = new Date().toISOString();
  saveProfiles(profiles);
  return { success: true };
});

// ── Fichier M3U ───────────────────────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Ouvrir un fichier M3U',
    filters: [
      { name: 'Playlist M3U', extensions: ['m3u', 'm3u8'] },
      { name: 'Tous les fichiers', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  const content = fs.readFileSync(filePaths[0], 'utf-8');
  return { path: filePaths[0], content };
});

function encodeProxyPayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');
}

function decodeProxyPayload(value, fallback) {
  try {
    if (!value) return fallback;
    return JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
  } catch (err) {
    return fallback;
  }
}

function buildProxyMediaUrl(targetUrl, headers = {}) {
  const params = new URLSearchParams({
    target: targetUrl,
    headers: encodeProxyPayload(headers),
    t: String(Date.now()),
  });
  return `http://127.0.0.1:9191/media?${params.toString()}`;
}

function fetchRemoteStream(targetUrl, headers = {}, redirectCount = 0, extraRequestHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const requestHeaders = {
      'User-Agent': appConfig.userAgent,
      ...headers,
      ...extraRequestHeaders,
    };

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: requestHeaders,
      timeout: 30000,
    };

    const remoteReq = transport.request(options, (remoteRes) => {
      if ([301, 302, 307, 308].includes(remoteRes.statusCode) && remoteRes.headers.location) {
        if (redirectCount >= 5) {
          remoteRes.resume();
          reject(new Error('Trop de redirections'));
          return;
        }
        const redirectUrl = new URL(remoteRes.headers.location, targetUrl).toString();
        remoteRes.resume();
        resolve(fetchRemoteStream(redirectUrl, headers, redirectCount + 1, extraRequestHeaders));
        return;
      }

      resolve({ response: remoteRes, finalUrl: targetUrl });
    });

    remoteReq.on('error', reject);
    remoteReq.on('timeout', () => {
      remoteReq.destroy(new Error('Proxy timeout'));
    });
    remoteReq.end();
  });
}

function rewriteM3u8Content(content, baseUrl, headers) {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (!trimmed.startsWith('#')) {
        return buildProxyMediaUrl(new URL(trimmed, baseUrl).toString(), headers);
      }

      return line.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${buildProxyMediaUrl(new URL(uri, baseUrl).toString(), headers)}"`);
    })
    .join('\n');
}

// ── Proxy local ───────────────────────────────────────────────────────────────
function startProxyServer() {
  proxyServer = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1:9191');

    if (reqUrl.pathname === '/media') {
      const targetUrl = reqUrl.searchParams.get('target');
      const headers = decodeProxyPayload(reqUrl.searchParams.get('headers'), {});
      const passthroughHeaders = {};

      if (req.headers.range) passthroughHeaders.Range = req.headers.range;
      if (req.headers['if-range']) passthroughHeaders['If-Range'] = req.headers['if-range'];

      if (!targetUrl) {
        res.writeHead(400);
        res.end('Missing target');
        return;
      }

      fetchRemoteStream(targetUrl, headers, 0, passthroughHeaders)
        .then(({ response: remoteRes, finalUrl }) => {
          const contentType = remoteRes.headers['content-type'] || '';
          const isPlaylist = /mpegurl|application\/vnd\.apple\.mpegurl|audio\/mpegurl/i.test(contentType) || /\.m3u8($|\?)/i.test(finalUrl);

          if (isPlaylist) {
            let body = '';
            remoteRes.setEncoding('utf8');
            remoteRes.on('data', (chunk) => {
              body += chunk;
            });
            remoteRes.on('end', () => {
              const rewritten = rewriteM3u8Content(body, finalUrl, headers);
              res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
              });
              res.end(rewritten);
            });
            remoteRes.on('error', (err) => {
              console.error('âŒ Proxy playlist error:', err.message);
              if (!res.headersSent) res.writeHead(502);
              res.end('Proxy playlist error');
            });
            return;
          }

          const responseHeaders = {
            'Content-Type': contentType || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': remoteRes.headers['cache-control'] || 'no-cache',
            'Connection': 'keep-alive',
          };
          if (remoteRes.headers['content-length']) responseHeaders['Content-Length'] = remoteRes.headers['content-length'];
          if (remoteRes.headers['content-range']) responseHeaders['Content-Range'] = remoteRes.headers['content-range'];
          if (remoteRes.headers['accept-ranges']) responseHeaders['Accept-Ranges'] = remoteRes.headers['accept-ranges'];

          res.writeHead(remoteRes.statusCode || 200, responseHeaders);
          remoteRes.pipe(res);
        })
        .catch((err) => {
          console.error('âŒ Proxy error:', err.message);
          res.writeHead(502);
          res.end('Proxy error');
        });
      return;
    }

    if (!currentProxyTarget) {
      res.writeHead(404);
      res.end('No target');
      return;
    }

    console.log(`📡 Proxy → ${currentProxyTarget.slice(0, 80)}...`);

    const targetUrl = new URL(currentProxyTarget);
    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const proxyHeaders = {
      'User-Agent': appConfig.userAgent,
      ...currentProxyHeaders,
    };

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      headers: proxyHeaders,
      timeout: 30000,
    };

    const proxyReq = transport.request(options, (proxyRes) => {
      console.log(`📡 Proxy response: ${proxyRes.statusCode} | Content-Type: ${proxyRes.headers['content-type']}`);

      if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        console.log(`↬ Redirect: ${proxyRes.headers.location}`);
        currentProxyTarget = proxyRes.headers.location;

        const newUrl = new URL(currentProxyTarget);
        const newTransport = newUrl.protocol === 'https:' ? https : http;

        const newOptions = {
          hostname: newUrl.hostname,
          port: newUrl.port || (newUrl.protocol === 'https:' ? 443 : 80),
          path: newUrl.pathname + newUrl.search,
          method: 'GET',
          headers: proxyHeaders,
          timeout: 30000,
        };

        const redirectReq = newTransport.request(newOptions, (redirectRes) => {
          console.log(`📡 Proxy response: ${redirectRes.statusCode} | Content-Type: ${redirectRes.headers['content-type']}`);
          res.writeHead(200, {
            'Content-Type': redirectRes.headers['content-type'] || 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          redirectRes.pipe(res);
        });

        redirectReq.on('error', (e) => {
          console.error('❌ Proxy redirect error:', e.message);
          res.writeHead(502);
          res.end('Proxy redirect error');
        });

        redirectReq.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': proxyRes.headers['content-type'] || 'video/mp2t',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      console.error('❌ Proxy error:', e.message);
      res.writeHead(502);
      res.end('Proxy error');
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.writeHead(504);
      res.end('Proxy timeout');
    });

    proxyReq.end();
  });

  proxyServer.listen(9191, '127.0.0.1', () => {
    console.log('🔄 Proxy local: http://127.0.0.1:9191');
  });
}

ipcMain.handle('proxy-set-target', (event, { url, headers }) => {
  currentProxyTarget = url;
  currentProxyHeaders = headers || {};
  console.log('🎯 Proxy target:', url);
  return { proxyUrl: buildProxyMediaUrl(url, headers || {}) };
});

ipcMain.handle('browse-vlc-path', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir VLC',
    filters: [{ name: 'VLC', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { success: false };
  return { success: true, path: filePaths[0] };
});

ipcMain.handle('vlc-play', async (event, { url }) => {
  try {
    const configured = (appConfig.vlcPath || '').trim();
    if (configured && !fs.existsSync(configured)) {
      return { success: false, error: 'VLC introuvable. VÃ©rifiez le chemin.' };
    }

    const proc = startVlc(url);
    const outcome = await new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      proc.once('error', (err) => done({ success: false, error: err.message }));
      setTimeout(() => done({ success: true }), 300);
    });
    if (!outcome.success) {
      stopVlc();
    }
    return outcome;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── Helpers partagés ─────────────────────────────────────────────────────────

/**
 * Charge toutes les pages d'une liste Stalker (itv, vod, series).
 * Retourne un tableau d'items bruts.
 */
async function fetchAllPages(axiosInst, serverBase, type, genreId, stalkerHeaders, token, labelForLog) {
  const items = [];
  let page = 1;
  while (true) {
    try {
      const url = `${serverBase}/portal.php?action=get_ordered_list&type=${type}&genre=${genreId}&fav=0&sortby=number&p=${page}&JsHttpRequest=1-xml`;
      const res = await axiosInst.get(url, {
        headers: { ...stalkerHeaders, Authorization: `Bearer ${token}` },
      });
      const data = res.data?.js?.data;
      const total = res.data?.js?.total_items || 0;
      if (!data || !data.length) break;
      items.push(...data);
      console.log(`  ${labelForLog} p${page}: ${data.length} | total: ${total}`);
      if (items.length >= total) break;
      page++;
    } catch (e) {
      console.warn(`⚠️ Erreur ${labelForLog} page ${page}:`, e.message);
      break;
    }
  }
  return items;
}

/**
 * Filtre les genres FR selon des mots-clés et un préfixe de catégorie optionnel.
 * Si aucun genre ne correspond, retourne tous les genres.
 */
function filterFRGenres(allGenres, extraKeywords = []) {
  const FR_KEYWORDS = [
    'fr', 'fr:', 'fr |', 'fra', 'france', 'français', 'francais',
    'french', '| fr', '🇫🇷', 'tf1', 'tmc', 'tpf', '|fr|', '{fr}', '[fr]',
    '|eu|', 'eu|', '| eu |', 'eu fr', 'europe',
    ...extraKeywords.map(k => k.toLowerCase()),
  ];

  const filtered = allGenres.filter((g) => {
    const name = (g.title || g.name || '').toLowerCase().trim();
    return FR_KEYWORDS.some((kw) => name.startsWith(kw) || name.includes(kw));
  });

  return filtered.length > 0 ? filtered : allGenres;
}

function normalizeFrenchLabel(value) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function isFrenchCategoryLabel(label) {
  const raw = label || '';
  if (/\[fr\]/i.test(raw)) return true;
  const name = normalizeFrenchLabel(raw);
  if (!name) return false;
  if (/\bfr\b/.test(name)) return true;
  const keywords = [
    'france',
    'francais',
    'french',
    'vostfr',
    'vost fr',
    'vf',
    'vof',
  ];
  return keywords.some((kw) => name.includes(kw));
}

function filterFrenchCategories(allCategories) {
  return allCategories.filter((g) => isFrenchCategoryLabel(g.title || g.name || ''));
}

// ── Stalker Connect ───────────────────────────────────────────────────────────
ipcMain.handle('stalker-connect', async (event, { portalUrl, mac }) => {
  try {
    let serverBase = portalUrl.replace(/\/+$/, '');
    if (!/\/c(\/)?$/.test(serverBase)) serverBase += '/c';

    const macEncoded = encodeURIComponent(mac);
    const stalkerHeaders = {
      'User-Agent': appConfig.userAgent,
      'Cookie': `mac=${macEncoded}; stb_lang=en; timezone=Europe%2FParis`,
      'X-User-Agent': 'Model: MAG250; Link: WiFi',
      'Authorization': '',
      'Referrer': `${serverBase}/`,
    };

    console.log(`📡 Portail: ${serverBase}`);
    console.log(`📡 MAC: ${mac}`);

    // ── ÉTAPE 1 : Handshake ──
    const hsUrl = `${serverBase}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`;
    console.log(`🤝 Handshake: ${hsUrl}`);

    const axiosInst = axios.create({
      headers: stalkerHeaders,
      timeout: (appConfig.networkTimeout || 60) * 1000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    const hsRes = await axiosInst.get(hsUrl);
    const token = hsRes.data?.js?.token;
    if (!token) throw new Error('Token non reçu');

    console.log(`✅ Token: ${token}`);
    stalkerHeaders['Authorization'] = `Bearer ${token}`;

    // ── ÉTAPE 2 : Profil ──
    try {
      await axiosInst.get(
        `${serverBase}/portal.php?action=get_profile&type=stb&JsHttpRequest=1-xml`,
        { headers: { ...stalkerHeaders, Authorization: `Bearer ${token}` } }
      );
      console.log('✅ Profil STB récupéré');
    } catch (e) {}

    // ── ÉTAPE 3 : Genres ITV (FILTRE FR) ──
    let itvGenres = [];
    const itvGenreMap = {};
    try {
      const genRes = await axiosInst.get(
        `${serverBase}/portal.php?action=get_genres&type=itv&JsHttpRequest=1-xml`,
        { headers: { ...stalkerHeaders, Authorization: `Bearer ${token}` } }
      );
      const allGenres = genRes.data?.js || [];
      console.log(`📂 Total genres ITV: ${allGenres.length}`);

      itvGenres = filterFRGenres(allGenres);
      if (itvGenres.length === 0) {
        console.warn('⚠️ Aucun genre ITV FR trouvé, chargement complet...');
        itvGenres = allGenres;
      }
      console.log(`🇫🇷 Genres ITV FR filtrés: ${itvGenres.length} / ${allGenres.length}`);
      allGenres.forEach((g) => { itvGenreMap[g.id] = g.title; });
    } catch (e) {
      console.warn('Genres ITV:', e.message);
    }

    // ── ÉTAPE 4 : Chaînes ITV par genre FR ──
    const channels = [];

    if (itvGenres.length > 0) {
      for (const genre of itvGenres) {
        const items = await fetchAllPages(axiosInst, serverBase, 'itv', genre.id, stalkerHeaders, token, `📺 ${genre.title}`);
        items.forEach((item) => {
          channels.push({
            id: item.id || Math.random().toString(36).slice(2),
            name: item.name || 'Sans nom',
            number: parseInt(item.number) || channels.length + 1,
            cmd: item.cmd || '',
            logo: item.logo || '',
            group: itvGenreMap[item.tv_genre_id] || genre.title || 'Autres',
          });
        });
      }
    } else {
      // Fallback: charger toutes les chaînes sans filtre genre
      const items = await fetchAllPages(axiosInst, serverBase, 'itv', '', stalkerHeaders, token, '📺 all');
      items.forEach((item) => {
        channels.push({
          id: item.id || Math.random().toString(36).slice(2),
          name: item.name || 'Sans nom',
          number: parseInt(item.number) || channels.length + 1,
          cmd: item.cmd || '',
          logo: item.logo || '',
          group: itvGenreMap[item.tv_genre_id] || 'Autres',
        });
      });
    }

    console.log(`📋 Total ITV: ${channels.length} chaînes FR`);

    // ── ÉTAPE 5 : VOD – catégories FR (préfixe "VOD") ──
    const vod = [];
    try {
      const vodGenRes = await axiosInst.get(
        `${serverBase}/portal.php?action=get_categories&type=vod&JsHttpRequest=1-xml`,
        { headers: { ...stalkerHeaders, Authorization: `Bearer ${token}` } }
      );
      const allVodGenres = vodGenRes.data?.js || [];
      console.log(`🎬 Total catégories VOD: ${allVodGenres.length}`);

      const vodCategories = filterFrenchCategories(allVodGenres);
      console.log(`🇫🇷 Catégories VOD FR: ${vodCategories.length} / ${allVodGenres.length}`);

      const vodGenreMap = {};
      allVodGenres.forEach((g) => { vodGenreMap[g.id] = g.title || g.name; });

      for (const cat of vodCategories) {
        const catName = cat.title || cat.name || 'VOD';
        const items = await fetchAllPages(axiosInst, serverBase, 'vod', cat.id, stalkerHeaders, token, `🎬 ${catName}`);
        items.forEach((item) => {
          vod.push({
            id: item.id || Math.random().toString(36).slice(2),
            name: item.name || item.title || 'Sans titre',
            cmd: item.cmd || '',
            logo: item.screenshot_uri || item.logo || '',
            category: catName,
            description: item.description || '',
            year: item.year || '',
            rating: item.rating_imdb || item.rating || '',
          });
        });
      }
      console.log(`🎬 Total VOD: ${vod.length} films`);
    } catch (e) {
      console.warn('⚠️ VOD non disponible:', e.message);
    }

    // ── ÉTAPE 6 : Séries – catégories FR (préfixe "SRS") ──
    const series = [];
    try {
      const srsGenRes = await axiosInst.get(
        `${serverBase}/portal.php?action=get_categories&type=series&JsHttpRequest=1-xml`,
        { headers: { ...stalkerHeaders, Authorization: `Bearer ${token}` } }
      );
      const allSrsGenres = srsGenRes.data?.js || [];
      console.log(`📺 Total catégories Séries: ${allSrsGenres.length}`);

      const srsCategories = filterFrenchCategories(allSrsGenres);
      console.log(`🇫🇷 Catégories Séries FR: ${srsCategories.length} / ${allSrsGenres.length}`);

      for (const cat of srsCategories) {
        const catName = cat.title || cat.name || 'Séries';
        const items = await fetchAllPages(axiosInst, serverBase, 'series', cat.id, stalkerHeaders, token, `🎞️ ${catName}`);
        items.forEach((item) => {
          series.push({
            id: item.id || Math.random().toString(36).slice(2),
            name: item.name || item.title || 'Sans titre',
            cmd: item.cmd || '',
            logo: item.screenshot_uri || item.logo || '',
            category: catName,
            description: item.description || '',
            year: item.year || '',
            rating: item.rating_imdb || item.rating || '',
            seasons: item.seasons || item.season_count || '',
            isSeries: true,
            seriesId: item.id,
          });
        });
      }
      console.log(`📺 Total Séries: ${series.length} séries`);
    } catch (e) {
      console.warn('⚠️ Séries non disponibles:', e.message);
    }

    return {
      success: true,
      channels,
      vod,
      series,
      token,
      serverBase,
      mac,
      stalkerHeaders: JSON.stringify(stalkerHeaders),
    };
  } catch (err) {
    console.error('❌ Stalker connect error:', err.message);
    return { success: false, error: err.message };
  }
});

// ── Stalker Get Stream ────────────────────────────────────────────────────────
ipcMain.handle('stalker-get-stream', async (event, { serverBase, mac, token, cmd, stalkerHeadersJson, contentType, seriesIndex, episodeId, containerExtension }) => {
  try {
    const stalkerHeaders = JSON.parse(stalkerHeadersJson);
    const macEncoded = encodeURIComponent(mac);

    const baseHeaders = {
      ...stalkerHeaders,
      'Cookie': `mac=${macEncoded}; stb_lang=en; timezone=Europe%2FParis`,
    };

    const axiosInst = axios.create({
      headers: baseHeaders,
      timeout: 30000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    const hsRes = await axiosInst.get(
      `${serverBase}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`
    );
    const freshToken = hsRes.data?.js?.token || token;
    console.log('🔑 Nouveau token:', freshToken);
    baseHeaders['Authorization'] = `Bearer ${freshToken}`;

    try {
      await axiosInst.get(
        `${serverBase}/portal.php?action=get_profile&type=stb&JsHttpRequest=1-xml`,
        { headers: baseHeaders }
      );
    } catch (e) {}

    const resolvedType = contentType === 'vod' || contentType === 'series' ? contentType : 'itv';
    const requestedSeriesIndex = resolvedType === 'series'
      ? Math.max(0, Number.parseInt(seriesIndex, 10) || 0)
      : 0;
    const cmdEncoded = encodeURIComponent(cmd);
    const createUrl = `${serverBase}/portal.php?action=create_link&type=${resolvedType}&cmd=${cmdEncoded}&series=${requestedSeriesIndex}&forced_storage=undefined&disable_ad=0&download=0&force_ch_link_check=0&JsHttpRequest=1-xml`;
    console.log('🔗 Create link:', createUrl);

    const linkRes = await axiosInst.get(createUrl, { headers: baseHeaders });
    console.log('📦 Réponse create_link:', JSON.stringify(linkRes.data?.js));

    let streamUrl = '';
    let jsData = linkRes.data?.js;

    if (!jsData?.cmd && resolvedType === 'series') {
      const fallbackCandidates = [
        ['series', Math.max(0, requestedSeriesIndex - 1)],
        ['series', 0],
        ['vod', requestedSeriesIndex],
        ['vod', Math.max(0, requestedSeriesIndex - 1)],
        ['vod', 0],
      ];

      for (const [fallbackType, fallbackSeries] of fallbackCandidates) {
        const fallbackUrl = `${serverBase}/portal.php?action=create_link&type=${fallbackType}&cmd=${cmdEncoded}&series=${fallbackSeries}&forced_storage=undefined&disable_ad=0&download=0&force_ch_link_check=0&JsHttpRequest=1-xml`;
        console.log('ðŸ” Create link fallback:', fallbackUrl);
        try {
          const fallbackRes = await axiosInst.get(fallbackUrl, { headers: baseHeaders });
          console.log('ðŸ“¦ RÃ©ponse fallback create_link:', JSON.stringify(fallbackRes.data?.js));
          if (fallbackRes.data?.js?.cmd) {
            jsData = fallbackRes.data.js;
            break;
          }
        } catch (fallbackErr) {
          console.warn('âš ï¸ Fallback create_link erreur:', fallbackErr.message);
        }
      }
    }

    if (jsData?.cmd) {
      streamUrl = jsData.cmd;
      if (streamUrl.startsWith('ffmpeg ') || streamUrl.startsWith('auto ')) {
        streamUrl = streamUrl.split(' ').slice(1).join(' ');
      }
    }

    if (streamUrl.includes('stream=&') || streamUrl.includes('stream=&extension')) {
      console.warn('⚠️ stream= vide, correction...');
      const streamIdMatch = cmd.match(/stream[=/](\d+)/);
      if (streamIdMatch) {
        streamUrl = streamUrl.replace('stream=&', `stream=${streamIdMatch[1]}&`);
        console.log('🔧 URL corrigée:', streamUrl);
      }
    }

    if (resolvedType === 'series' && /^https?:\/\/.+\/series\/[^/]+\/[^/]+\/\.\?/i.test(streamUrl) && episodeId) {
      const safeEpisodeId = String(episodeId).trim();
      const safeExtension = String(containerExtension || 'mkv').trim().replace(/^\./, '') || 'mkv';
      streamUrl = streamUrl.replace(/\/\.\?/, `/${safeEpisodeId}.${safeExtension}?`);
      console.log('ðŸ”§ URL sÃ©rie reconstruite:', streamUrl);
    }

    if (!streamUrl || !streamUrl.startsWith('http')) {
      let fallbackUrl = cmd;
      if (fallbackUrl.startsWith('ffmpeg ') || fallbackUrl.startsWith('auto ')) {
        fallbackUrl = fallbackUrl.split(' ').slice(1).join(' ');
      }
      if (fallbackUrl.startsWith('http')) {
        streamUrl = fallbackUrl;
      } else {
        return { success: false, error: 'Impossible de créer le lien' };
      }
    }

    console.log('✅ Stream URL finale:', streamUrl);
    return { success: true, url: streamUrl, headers: baseHeaders, token: freshToken };
  } catch (err) {
    console.error('❌ Erreur stream:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stalker-series-episodes', async (event, { serverBase, mac, token, seriesId, stalkerHeadersJson }) => {
  try {
    const stalkerHeaders = JSON.parse(stalkerHeadersJson);
    const macEncoded = encodeURIComponent(mac);

    const baseHeaders = {
      ...stalkerHeaders,
      'Cookie': `mac=${macEncoded}; stb_lang=en; timezone=Europe%2FParis`,
    };

    const axiosInst = axios.create({
      headers: baseHeaders,
      timeout: 30000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    const hsRes = await axiosInst.get(
      `${serverBase}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`
    );
    const freshToken = hsRes.data?.js?.token || token;
    baseHeaders['Authorization'] = `Bearer ${freshToken}`;

    try {
      await axiosInst.get(
        `${serverBase}/portal.php?action=get_profile&type=stb&JsHttpRequest=1-xml`,
        { headers: baseHeaders }
      );
    } catch (e) {}

    const items = [];
    let page = 1;
    while (true) {
      const url = `${serverBase}/portal.php?action=get_ordered_list&type=series&series_id=${encodeURIComponent(seriesId)}&p=${page}&JsHttpRequest=1-xml`;
      const res = await axiosInst.get(url, { headers: baseHeaders });
      const data = res.data?.js?.data;
      const total = res.data?.js?.total_items || 0;
      if (!data || !data.length) break;
      items.push(...data);
      if (items.length >= total) break;
      page++;
    }

    const normalizedItems = items.map((item, index) => ({
      ...item,
      cmd: item.cmd || item.play_cmd || item.movie_cmd || item.path || '',
      episode_id: item.episode_id || item.id || item.video_id || item.movie_id || null,
      container_extension: item.container_extension || item.extension || item.ext || 'mkv',
      season_number: item.season_number || item.season_num || item.season || item.season_id || null,
      episode_number: item.episode_number || item.episode_num || item.series_number || item.series || item.number || index + 1,
      series_number: item.series_number || item.series || item.episode_number || item.number || index + 1,
      title: item.title || item.name || item.episode_name || `Episode ${index + 1}`,
    }));

    return { success: true, items: normalizedItems, token: freshToken };
  } catch (err) {
    console.error('❌ Erreur épisodes série:', err.message);
    return { success: false, error: err.message };
  }
});

// ── Contrôles fenêtre ─────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow.close());


