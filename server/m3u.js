// ── Parseur M3U / M3U Plus (compatible listes Xtream get.php?type=m3u_plus) ────

function parseAttributes(line) {
    const attrs = {};
    const re = /([\w-]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(line))) attrs[m[1].toLowerCase()] = m[2];
    return attrs;
}

// Nom de la chaîne = texte après la première virgule hors guillemets
// (le titre lui-même peut contenir des virgules)
function extractTitle(line) {
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') inQuotes = !inQuotes;
        else if (c === ',' && !inQuotes) return line.slice(i + 1).trim();
    }
    return '';
}

function classify(url, group) {
    const u = url.toLowerCase();
    if (/\/movie\//.test(u)) return 'vod';
    if (/\/series\//.test(u)) return 'series';
    if (/\.(mp4|mkv|avi|m4v|mov|wmv)(\?|$)/.test(u)) return 'vod';
    const g = (group || '').toLowerCase();
    if (/^(vod|films?|movies?)\b/.test(g)) return 'vod';
    return 'live';
}

function parseM3U(content) {
    const lines = String(content || '').split(/\r?\n/);
    const channels = [];
    const vod = [];
    const series = [];

    let pending = null;
    let pendingHeaders = {};
    let index = 0;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF')) {
            const attrs = parseAttributes(line);
            pending = {
                name: extractTitle(line) || attrs['tvg-name'] || 'Sans nom',
                logo: attrs['tvg-logo'] || '',
                group: attrs['group-title'] || '',
                tvgId: attrs['tvg-id'] || '',
                number: Number.parseInt(attrs['tvg-chno'], 10) || null,
            };
            if (attrs['user-agent']) pendingHeaders['User-Agent'] = attrs['user-agent'];
            continue;
        }

        if (line.startsWith('#EXTGRP:')) {
            if (pending && !pending.group) pending.group = line.slice(8).trim();
            continue;
        }

        if (line.startsWith('#EXTVLCOPT:')) {
            const opt = line.slice(11);
            const [key, ...rest] = opt.split('=');
            const value = rest.join('=').trim();
            if (/^http-user-agent$/i.test(key)) pendingHeaders['User-Agent'] = value;
            if (/^http-referr?er$/i.test(key)) pendingHeaders['Referer'] = value;
            continue;
        }

        if (line.startsWith('#')) continue;

        // Ligne URL
        const info = pending || {name: line.split('/').pop() || 'Sans nom', logo: '', group: '', number: null};
        const type = classify(line, info.group);
        index++;
        const base = {
            id: `m3u-${index}`,
            name: info.name,
            cmd: line,
            logo: info.logo,
        };
        if (Object.keys(pendingHeaders).length) base.headers = pendingHeaders;

        if (type === 'live') {
            channels.push({...base, number: info.number || channels.length + 1, group: info.group || 'Autres'});
        } else if (type === 'vod') {
            vod.push({...base, category: info.group || 'Films'});
        } else {
            // Épisodes Xtream aplatis : lisibles directement comme des films
            vod.push({...base, category: `Séries • ${info.group || 'Séries'}`});
        }

        pending = null;
        pendingHeaders = {};
    }

    return {success: true, channels, vod, series};
}

module.exports = {parseM3U};
