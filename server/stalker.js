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
async function connect({portalUrl, mac, userAgent, timeoutMs}, onProgress = () => {}) {
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

        itvGenres = filterFRGenres(allGenres);
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
            logo: item.logo || '',
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

        const vodCategories = filterFrenchCategories(allVodGenres);
        console.log(`Catégories VOD FR: ${vodCategories.length} / ${allVodGenres.length}`);

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

        const srsCategories = filterFrenchCategories(allSrsGenres);
        console.log(`Catégories Séries FR: ${srsCategories.length} / ${allSrsGenres.length}`);

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

    return {success: true, items: normalizedItems, token: freshToken};
}

module.exports = {connect, getStream, seriesEpisodes};
