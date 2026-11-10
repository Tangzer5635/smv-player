const axios = require('axios');
const {axiosNetOptions} = require('./net');

// ── Helpers partagés ─────────────────────────────────────────────────────────

// Proxy éventuel choisi pour le portail : les flux suivront le même chemin (server/net.js)
async function createClient(headers, timeoutMs, serverBase) {
    return axios.create({
        headers,
        timeout: timeoutMs,
        ...(await axiosNetOptions(serverBase)),
    });
}

function normalizeServerBase(portalUrl) {
    let serverBase = String(portalUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(serverBase)) serverBase = `http://${serverBase}`;
    if (!/\/c(\/)?$/.test(serverBase)) serverBase += '/c';
    return serverBase;
}

function buildCookie(mac) {
    return `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe%2FParis`;
}

// En-têtes STB par défaut (session reconstituée quand aucune n'a été mémorisée)
function defaultSession({portalUrl, mac, userAgent}) {
    const serverBase = normalizeServerBase(portalUrl);
    return {
        serverBase,
        mac,
        token: '',
        stalkerHeaders: JSON.stringify({
            'User-Agent': userAgent,
            'Cookie': buildCookie(mac),
            'X-User-Agent': 'Model: MAG250; Link: WiFi',
            'Referrer': `${serverBase}/`,
        }),
    };
}

// Logos / affiches parfois relatifs au portail
function absoluteImage(value, serverBase) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    try {
        return new URL(raw, new URL(serverBase).origin + '/').toString();
    } catch (_) {
        return '';
    }
}

/**
 * Charge toutes les pages d'une liste Stalker (itv, vod, series).
 * Retourne un tableau d'items bruts.
 */
async function fetchAllPages(axiosInst, serverBase, type, genreId, stalkerHeaders, token, labelForLog, onPage) {
    const items = [];
    let page = 1;
    while (true) {
        try {
            const url = `${serverBase}/portal.php?action=get_ordered_list&type=${type}&genre=${genreId}&fav=0&sortby=number&p=${page}&JsHttpRequest=1-xml`;
            const res = await axiosInst.get(url, {
                headers: {...stalkerHeaders, Authorization: `Bearer ${token}`},
            });
            const data = res.data?.js?.data;
            const total = res.data?.js?.total_items || 0;
            if (!data || !data.length) break;
            items.push(...data);
            console.log(`  ${labelForLog} p${page}: ${data.length} | total: ${total}`);
            onPage?.(data.length);
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
        .replace(/[̀-ͯ]/g, '')
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

// ── Session : handshake + profil STB ─────────────────────────────────────────
async function openSession({serverBase, mac, stalkerHeaders, token, userAgent, timeoutMs}) {
    const baseHeaders = {
        'User-Agent': userAgent,
        ...stalkerHeaders,
        'Cookie': buildCookie(mac),
    };
    const axiosInst = await createClient(baseHeaders, timeoutMs, serverBase);

    const hsRes = await axiosInst.get(
        `${serverBase}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`
    );
    const freshToken = hsRes.data?.js?.token || token;
    baseHeaders['Authorization'] = `Bearer ${freshToken}`;

    try {
        await axiosInst.get(
            `${serverBase}/portal.php?action=get_profile&type=stb&JsHttpRequest=1-xml`,
            {headers: baseHeaders}
        );
    } catch (e) {
    }

    return {axiosInst, baseHeaders, token: freshToken};
}

// ── Stalker Connect ───────────────────────────────────────────────────────────
async function connect({portalUrl, mac, userAgent, timeoutMs, frenchOnly = true}, onProgress = () => {}) {
    const serverBase = normalizeServerBase(portalUrl);
    const stalkerHeaders = {
        'User-Agent': userAgent,
        'Cookie': buildCookie(mac),
        'X-User-Agent': 'Model: MAG250; Link: WiFi',
        'Authorization': '',
        'Referrer': `${serverBase}/`,
    };

    console.log(`Portail: ${serverBase}`);
    console.log(`MAC: ${mac}`);

    // ── ÉTAPE 1 : Handshake ──
    onProgress({step: 'handshake', message: 'Connexion au portail…'});
    const hsUrl = `${serverBase}/portal.php?action=handshake&type=stb&token=&JsHttpRequest=1-xml`;
    console.log(`Handshake: ${hsUrl}`);

    const axiosInst = await createClient(stalkerHeaders, timeoutMs, serverBase);

    const hsRes = await axiosInst.get(hsUrl);
    const token = hsRes.data?.js?.token;
    if (!token) throw new Error('Token non reçu');

    console.log(`Token: ${token}`);
    stalkerHeaders['Authorization'] = `Bearer ${token}`;
    const authHeaders = () => ({headers: {...stalkerHeaders, Authorization: `Bearer ${token}`}});

    // ── ÉTAPE 2 : Profil ──
    try {
        await axiosInst.get(`${serverBase}/portal.php?action=get_profile&type=stb&JsHttpRequest=1-xml`, authHeaders());
        console.log('Profil STB récupéré');
    } catch (e) {
    }

    // ── ÉTAPE 3 : Genres ITV (FILTRE FR) ──
    onProgress({step: 'genres', message: 'Lecture des catégories…'});
    let itvGenres = [];
    const itvGenreMap = {};
    try {
        const genRes = await axiosInst.get(`${serverBase}/portal.php?action=get_genres&type=itv&JsHttpRequest=1-xml`, authHeaders());
        const allGenres = Array.isArray(genRes.data?.js) ? genRes.data.js : [];
        console.log(`Total genres ITV: ${allGenres.length}`);

        itvGenres = frenchOnly ? filterFRGenres(allGenres) : allGenres;
        console.log(`Genres ITV FR filtrés: ${itvGenres.length} / ${allGenres.length}`);
        allGenres.forEach((g) => {
            itvGenreMap[g.id] = g.title;
        });
    } catch (e) {
        console.warn('Genres ITV:', e.message);
    }

    // ── ÉTAPE 4 : Chaînes ITV par genre FR ──
    const channels = [];
    const reportLive = () => onProgress({step: 'live', message: `Chaînes : ${channels.length}`, count: channels.length});
    const pushChannel = (item, fallbackGroup) => {
        channels.push({
            id: item.id || Math.random().toString(36).slice(2),
            name: item.name || 'Sans nom',
            number: parseInt(item.number) || channels.length + 1,
            cmd: item.cmd || '',
            logo: absoluteImage(item.logo, serverBase),
            group: itvGenreMap[item.tv_genre_id] || fallbackGroup || 'Autres',
        });
    };

    if (itvGenres.length > 0) {
        for (const genre of itvGenres) {
            const items = await fetchAllPages(axiosInst, serverBase, 'itv', genre.id, stalkerHeaders, token, `📺 ${genre.title}`);
            items.forEach((item) => pushChannel(item, genre.title));
            reportLive();
        }
    } else {
        // Fallback: charger toutes les chaînes sans filtre genre
        const items = await fetchAllPages(axiosInst, serverBase, 'itv', '', stalkerHeaders, token, '📺 all');
        items.forEach((item) => pushChannel(item));
        reportLive();
    }

    console.log(`Total ITV: ${channels.length} chaînes FR`);

    // ── ÉTAPE 5 : VOD – catégories FR ──
    const vod = [];
    try {
        onProgress({step: 'vod', message: 'Lecture des films…', count: 0});
        const vodGenRes = await axiosInst.get(`${serverBase}/portal.php?action=get_categories&type=vod&JsHttpRequest=1-xml`, authHeaders());
        const allVodGenres = Array.isArray(vodGenRes.data?.js) ? vodGenRes.data.js : [];
        console.log(`Total catégories VOD: ${allVodGenres.length}`);

        const vodCategories = frenchOnly ? filterFrenchCategories(allVodGenres) : allVodGenres;
        console.log(`Catégories VOD FR: ${vodCategories.length} / ${allVodGenres.length}`);

        for (const cat of vodCategories) {
            const catName = cat.title || cat.name || 'VOD';
            const items = await fetchAllPages(axiosInst, serverBase, 'vod', cat.id, stalkerHeaders, token, `🎬 ${catName}`);
            items.forEach((item) => {
                vod.push({
                    id: item.id || Math.random().toString(36).slice(2),
                    name: item.name || item.title || 'Sans titre',
                    cmd: item.cmd || '',
                    logo: absoluteImage(item.screenshot_uri || item.logo, serverBase),
                    category: catName,
                    description: item.description || '',
                    year: item.year || '',
                    rating: item.rating_imdb || item.rating || '',
                });
            });
            onProgress({step: 'vod', message: `Films : ${vod.length}`, count: vod.length});
        }
        console.log(`Total VOD: ${vod.length} films`);
    } catch (e) {
        console.warn('⚠️ VOD non disponible:', e.message);
    }

    // ── ÉTAPE 6 : Séries – catégories FR ──
    const series = [];
    try {
        onProgress({step: 'series', message: 'Lecture des séries…', count: 0});
        const srsGenRes = await axiosInst.get(`${serverBase}/portal.php?action=get_categories&type=series&JsHttpRequest=1-xml`, authHeaders());
        const allSrsGenres = Array.isArray(srsGenRes.data?.js) ? srsGenRes.data.js : [];
        console.log(`Total catégories Séries: ${allSrsGenres.length}`);

        const srsCategories = frenchOnly ? filterFrenchCategories(allSrsGenres) : allSrsGenres;
        console.log(`Catégories Séries FR: ${srsCategories.length} / ${allSrsGenres.length}`);

        for (const cat of srsCategories) {
            const catName = cat.title || cat.name || 'Séries';
            const items = await fetchAllPages(axiosInst, serverBase, 'series', cat.id, stalkerHeaders, token, `🎞️ ${catName}`);
            items.forEach((item) => {
                series.push({
                    id: item.id || Math.random().toString(36).slice(2),
                    name: item.name || item.title || 'Sans titre',
                    cmd: item.cmd || '',
                    logo: absoluteImage(item.screenshot_uri || item.logo, serverBase),
                    category: catName,
                    description: item.description || '',
                    year: item.year || '',
                    rating: item.rating_imdb || item.rating || '',
                    seasons: item.seasons || item.season_count || '',
                    isSeries: true,
                    seriesId: item.id,
                });
            });
            onProgress({step: 'series', message: `Séries : ${series.length}`, count: series.length});
        }
        console.log(`Total Séries: ${series.length} séries`);
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
}

// ── Stalker Get Stream ────────────────────────────────────────────────────────
async function getStream({
    serverBase,
    mac,
    token,
    cmd,
    stalkerHeadersJson,
    contentType,
    seriesIndex,
    episodeId,
    containerExtension,
    userAgent,
}) {
    const {axiosInst, baseHeaders, token: freshToken} = await openSession({
        serverBase,
        mac,
        token,
        userAgent,
        stalkerHeaders: JSON.parse(stalkerHeadersJson || '{}'),
        timeoutMs: 30000,
    });
    console.log('Nouveau token:', freshToken);

    const resolvedType = contentType === 'vod' || contentType === 'series' ? contentType : 'itv';
    const requestedSeriesIndex = resolvedType === 'series'
        ? Math.max(0, Number.parseInt(seriesIndex, 10) || 0)
        : 0;
    const cmdEncoded = encodeURIComponent(cmd);
    const createUrl = `${serverBase}/portal.php?action=create_link&type=${resolvedType}&cmd=${cmdEncoded}&series=${requestedSeriesIndex}&forced_storage=undefined&disable_ad=0&download=0&force_ch_link_check=0&JsHttpRequest=1-xml`;
    console.log('Create link:', createUrl);

    const linkRes = await axiosInst.get(createUrl, {headers: baseHeaders});
    console.log('Réponse create_link:', JSON.stringify(linkRes.data?.js));

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
            console.log('Create link fallback:', fallbackUrl);
            try {
                const fallbackRes = await axiosInst.get(fallbackUrl, {headers: baseHeaders});
                console.log('Réponse fallback create_link:', JSON.stringify(fallbackRes.data?.js));
                if (fallbackRes.data?.js?.cmd) {
                    jsData = fallbackRes.data.js;
                    break;
                }
            } catch (fallbackErr) {
                console.warn('Fallback create_link erreur:', fallbackErr.message);
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
            console.log('URL corrigée:', streamUrl);
        }
    }

    if (resolvedType === 'series' && /^https?:\/\/.+\/series\/[^/]+\/[^/]+\/\.\?/i.test(streamUrl) && episodeId) {
        const safeEpisodeId = String(episodeId).trim();
        const safeExtension = String(containerExtension || 'mkv').trim().replace(/^\./, '') || 'mkv';
        streamUrl = streamUrl.replace(/\/\.\?/, `/${safeEpisodeId}.${safeExtension}?`);
        console.log('URL série reconstruite:', streamUrl);
    }

    if (!streamUrl || !streamUrl.startsWith('http')) {
        let fallbackUrl = cmd;
        if (fallbackUrl.startsWith('ffmpeg ') || fallbackUrl.startsWith('auto ')) {
            fallbackUrl = fallbackUrl.split(' ').slice(1).join(' ');
        }
        if (fallbackUrl.startsWith('http')) {
            streamUrl = fallbackUrl;
        } else {
            return {success: false, error: 'Impossible de créer le lien'};
        }
    }

    console.log('Stream URL finale:', streamUrl);
    return {success: true, url: streamUrl, headers: baseHeaders, token: freshToken};
}

// ── Stalker épisodes de série ────────────────────────────────────────────────
async function seriesEpisodes({serverBase, mac, token, seriesId, stalkerHeadersJson, userAgent}) {
    const {axiosInst, baseHeaders, token: freshToken} = await openSession({
        serverBase,
        mac,
        token,
        userAgent,
        stalkerHeaders: JSON.parse(stalkerHeadersJson || '{}'),
        timeoutMs: 30000,
    });

    const items = [];
    let page = 1;
    while (true) {
        const url = `${serverBase}/portal.php?action=get_ordered_list&type=series&series_id=${encodeURIComponent(seriesId)}&p=${page}&JsHttpRequest=1-xml`;
        const res = await axiosInst.get(url, {headers: baseHeaders});
        const data = res.data?.js?.data;
        const total = res.data?.js?.total_items || 0;
        if (!data || !data.length) break;
        items.push(...data);
        if (items.length >= total) break;
        page++;
    }

    return {success: true, episodes: normalizeEpisodes(items, {seriesId, serverBase}), token: freshToken};
}

// ── Normalisation des épisodes ───────────────────────────────────────────────
function toIntOrNull(value) {
    if (Array.isArray(value)) return null;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
}

function firstInt(item, fields) {
    for (const field of fields) {
        const n = toIntOrNull(item[field]);
        if (n !== null) return n;
    }
    return null;
}

const SEASON_FIELDS = ['season_num', 'season_number', 'season', 'season_id'];
const EPISODE_FIELDS = ['episode_num', 'episode_number', 'series_number', 'series', 'number', 'sort_num'];
const INDEX_FIELDS = ['series_number', 'series', 'episode_number', 'number'];

/**
 * Les portails renvoient soit un élément par épisode, soit (Ministra) un élément
 * par saison avec la liste des numéros d'épisodes dans « series » : ce dernier
 * cas est déplié en épisodes (create_link avec series=<numéro>).
 */
function normalizeEpisodes(items, {seriesId, serverBase}) {
    const episodes = [];
    items.forEach((item, index) => {
        const cmd = item.cmd || item.play_cmd || item.movie_cmd || item.path || '';
        const logo = absoluteImage(item.screenshot_uri || item.logo, serverBase);
        const containerExtension = item.container_extension || item.extension || item.ext || 'mkv';
        const title = item.name || item.title || item.episode_name || '';

        if (Array.isArray(item.series) && item.series.length) {
            const seasonFromName = /(?:season|saison|s)\s*(\d+)/i.exec(title)?.[1];
            const season = firstInt(item, SEASON_FIELDS) ?? toIntOrNull(seasonFromName) ?? index + 1;
            item.series.forEach((num) => {
                const episode = toIntOrNull(num);
                if (episode === null) return;
                episodes.push({
                    id: `${item.id || seriesId}-${episode}`,
                    title: `Épisode ${episode}`,
                    season,
                    episode,
                    seriesIndex: episode,
                    episodeId: null,
                    containerExtension,
                    logo,
                    cmd,
                });
            });
            return;
        }

        const episode = firstInt(item, EPISODE_FIELDS) ?? index + 1;
        episodes.push({
            id: String(item.id || `${seriesId}-${index}`),
            title: title || `Épisode ${episode}`,
            season: firstInt(item, SEASON_FIELDS),
            episode,
            seriesIndex: firstInt(item, INDEX_FIELDS) ?? index + 1,
            episodeId: item.episode_id || item.id || item.video_id || item.movie_id || null,
            containerExtension,
            logo,
            cmd,
        });
    });
    return episodes;
}

// ── Guide des programmes (maintenant / ensuite) ─────────────────────────────
async function shortEpg({serverBase, mac, token, stalkerHeadersJson, userAgent, channelId, size = 4}) {
    const {axiosInst, baseHeaders} = await openSession({
        serverBase,
        mac,
        token,
        userAgent,
        stalkerHeaders: JSON.parse(stalkerHeadersJson || '{}'),
        timeoutMs: 15000,
    });
    const res = await axiosInst.get(
        `${serverBase}/portal.php?type=itv&action=get_short_epg&ch_id=${encodeURIComponent(channelId)}&size=${size}&JsHttpRequest=1-xml`,
        {headers: baseHeaders}
    );
    const list = Array.isArray(res.data?.js) ? res.data.js : [];
    return list
        .map((p) => ({
            title: String(p.name || p.title || '').trim(),
            description: String(p.descr || p.description || '').trim(),
            start: Number(p.start_timestamp) * 1000 || Date.parse(p.time) || 0,
            stop: Number(p.stop_timestamp) * 1000 || Date.parse(p.time_to) || 0,
        }))
        .filter((p) => p.title && p.start && p.stop > p.start);
}

module.exports = {connect, getStream, seriesEpisodes, shortEpg, defaultSession, normalizeServerBase, normalizeEpisodes};
