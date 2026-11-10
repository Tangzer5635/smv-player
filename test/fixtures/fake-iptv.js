/*
 * Faux fournisseur IPTV pour les tests : portail Stalker, liste M3U, flux TS
 * en direct (débit régulé), fichiers VOD (Range), HLS, images et refus.
 *
 *   const iptv = await startFakeIptv({mediaDir});   // iptv.url, iptv.log, iptv.close()
 *   node test/fixtures/fake-iptv.js <mediaDir> [port]  (serveur autonome)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// PNG 1×1 rouge
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

function startFakeIptv({mediaDir, port = 0, channels = 450} = {}) {
    const log = [];
    const file = (name) => path.join(mediaDir, name);

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        log.push({path: u.pathname, query: u.search, headers: req.headers});
        const host = req.headers.host;
        const json = (js) => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({js}));
        };

        if (u.pathname === '/logo.png') {
            res.writeHead(200, {'Content-Type': 'image/png'});
            res.end(PNG);
            return;
        }
        if (u.pathname === '/list.m3u') {
            res.writeHead(200, {'Content-Type': 'audio/x-mpegurl'});
            res.end([
                '#EXTM3U',
                `#EXTINF:-1 tvg-logo="http://${host}/logo.png" group-title="FR | Info",Chaîne M3U, info`,
                `http://${host}/play/live.php?stream=1&extension=ts`,
                '#EXTINF:-1 group-title="Films",Film M3U',
                `http://${host}/movie/user/pass/2.mp4`,
            ].join('\n'));
            return;
        }

        // Tout le reste exige la MAC comme un vrai portail
        if (!/mac=/.test(req.headers.cookie || '') && !/mac=/.test(u.search)) {
            res.writeHead(403);
            res.end('no mac');
            return;
        }

        if (u.pathname === '/c/portal.php') {
            const q = u.searchParams;
            const action = q.get('action');
            const type = q.get('type');
            if (action === 'handshake') return json({token: `TOK${Date.now()}`});
            if (!/Bearer TOK/.test(req.headers.authorization || '')) {
                res.writeHead(401);
                res.end('auth');
                return;
            }
            if (action === 'get_profile') return json({id: 1});
            if (action === 'get_genres') return json([{id: '1', title: 'FR | GENERAL'}, {id: '2', title: 'UK | SPORT'}]);
            if (action === 'get_categories' && type === 'vod') return json([{id: '10', title: 'FR | FILMS'}, {id: '11', title: 'DE | FILME'}]);
            if (action === 'get_categories' && type === 'series') return json([{id: '20', title: 'FR | SERIES'}]);
            if (action === 'get_short_epg') {
                const now = Math.floor(Date.now() / 1000);
                return json([
                    {name: 'Journal', descr: 'Les infos', start_timestamp: now - 600, stop_timestamp: now + 1200},
                    {name: 'Météo', descr: '', start_timestamp: now + 1200, stop_timestamp: now + 1500},
                ]);
            }
            if (action === 'get_ordered_list') {
                const page = Number(q.get('p')) || 1;
                if (type === 'itv' && q.get('genre') === '1') {
                    const all = Array.from({length: channels}, (_, i) => ({
                        id: String(100 + i), name: `FR: Chaîne ${i + 1}`, number: String(i + 1),
                        cmd: `ffmpeg http://localhost/ch/${100 + i}`, logo: i === 0 ? '/logos/1.png' : '', tv_genre_id: '1',
                    }));
                    all[1].cmd = 'ffmpeg http://localhost/ch/mpeg2';
                    all[2].cmd = 'ffmpeg http://localhost/ch/blocked';
                    return json({total_items: all.length, data: all.slice((page - 1) * 200, page * 200)});
                }
                if (type === 'itv' && q.get('genre') === '2') {
                    return json({total_items: 1, data: page > 1 ? [] : [{id: '900', name: 'UK Sport', cmd: 'ffmpeg http://localhost/ch/900', tv_genre_id: '2'}]});
                }
                if (type === 'vod') {
                    return json({total_items: 2, data: page > 1 ? [] : [
                        {id: '900', name: 'Film HEVC', cmd: '/media/file_900.mkv', screenshot_uri: `http://${host}/logo.png`, year: '2020', description: 'Un film'},
                        {id: '901', name: 'Film MP4', cmd: '/media/file_901.mp4'},
                    ]});
                }
                if (type === 'series' && q.get('series_id')) {
                    // Format « Ministra » : une entrée par saison, épisodes dans « series »
                    return json({total_items: 2, data: page > 1 ? [] : [
                        {id: '700:1', name: 'Saison 1', series: [1, 2, 3], cmd: '/media/series_700_s1'},
                        {id: '700:2', name: 'Saison 2', series: [1, 2], cmd: '/media/series_700_s2'},
                    ]});
                }
                if (type === 'series') return json({total_items: 1, data: page > 1 ? [] : [{id: '700', name: 'Série Test', cmd: '/media/series_700'}]});
                return json({total_items: 0, data: []});
            }
            if (action === 'create_link') {
                const cmd = q.get('cmd') || '';
                if (/mpeg2/.test(cmd)) return json({cmd: `ffmpeg http://${host}/live/mpeg2`});
                if (/blocked/.test(cmd)) return json({cmd: `ffmpeg http://${host}/blocked`});
                if (/\/ch\//.test(cmd)) return json({cmd: `ffmpeg http://${host}/play/live.php?stream=1&extension=ts&play_token=abc`});
                if (/901/.test(cmd)) return json({cmd: `http://${host}/movie/2.mp4`});
                if (/series_700/.test(cmd)) return json({cmd: `http://${host}/movie/2.mp4?series=${q.get('series')}`});
                return json({cmd: `http://${host}/movie/1.mkv`});
            }
            return json(null);
        }

        if (u.pathname === '/blocked') {
            res.writeHead(456, {'Content-Type': 'text/html; charset=UTF-8', Server: 'nginx/1.28.0'});
            res.end('');
            return;
        }

        if (u.pathname === '/play/live.php' || u.pathname === '/live/mpeg2') {
            const data = fs.readFileSync(file(u.pathname === '/live/mpeg2' ? 'mpeg2.ts' : 'live.ts'));
            res.writeHead(200, {'Content-Type': 'application/octet-stream'});
            const rate = data.length / 12;
            const chunk = Math.max(188, Math.round(rate / 10));
            let off = 0;
            // 3 s d'avance puis temps réel
            const send = (n) => {
                const start = off % data.length;
                res.write(data.subarray(start, Math.min(data.length, start + n)));
                off += n;
            };
            send(chunk * 30);
            const timer = setInterval(() => {
                if (res.destroyed) return clearInterval(timer);
                send(chunk);
            }, 100);
            req.on('close', () => {
                clearInterval(timer);
                log.push({path: 'CLOSED ' + u.pathname});
            });
            return;
        }

        const files = {'/movie/1.mkv': 'movie_hevc.mkv', '/movie/2.mp4': 'movie.mp4', '/movie/user/pass/2.mp4': 'movie.mp4'};
        const name = files[u.pathname];
        if (!name) {
            res.writeHead(404);
            res.end();
            return;
        }
        const p = file(name);
        const size = fs.statSync(p).size;
        const type = name.endsWith('.mp4') ? 'video/mp4' : 'video/x-matroska';
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        if (m) {
            const start = Number(m[1]);
            const end = m[2] ? Number(m[2]) : size - 1;
            res.writeHead(206, {'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes'});
            fs.createReadStream(p, {start, end}).pipe(res);
            return;
        }
        res.writeHead(200, {'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes'});
        fs.createReadStream(p).pipe(res);
    });

    return new Promise((resolve) => {
        server.listen(port, process.env.FAKE_IPTV_HOST || '127.0.0.1', () => {
            const url = `http://${process.env.FAKE_IPTV_HOST || '127.0.0.1'}:${server.address().port}`;
            resolve({url, log, server, close: () => new Promise((r) => server.close(() => r()))});
        });
    });
}

module.exports = {startFakeIptv};

if (require.main === module) {
    const [mediaDir, port] = process.argv.slice(2);
    startFakeIptv({mediaDir: path.resolve(mediaDir), port: Number(port) || 9400}).then(({url}) => console.log(`Faux IPTV : ${url}`));
}
