const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const {startSmv, client, waitForJob} = require('./helpers');
const {startFakeIptv} = require('./fixtures/fake-iptv');
const {generateMedia} = require('./fixtures/media');

const media = generateMedia(path.join(os.tmpdir(), 'smv-test-media'));

test('SMV Player : parcours complet de l\'API', {skip: !media && 'ffmpeg absent'}, async (t) => {
    const iptv = await startFakeIptv({mediaDir: media.dir});
    const smv = await startSmv();
    t.after(async () => {
        await smv.close();
        await iptv.close();
    });
    const api = client(smv.url);
    let sourceId;

    await t.test('installation protégée par le code affiché dans les logs', async () => {
        let res = await api.get('/api/session');
        assert.equal(res.data.setupRequired, true);
        res = await api.get('/api/sources');
        assert.equal(res.status, 401);
        res = await api.post('/api/setup', {code: 'FAUX', username: 'admin', password: 'motdepasse'});
        assert.equal(res.status, 403);
        res = await api.post('/api/setup', {code: smv.app.auth.setupCode, username: 'admin', password: 'motdepasse'});
        assert.equal(res.status, 200);
        assert.match(api.cookie, /^smv_session=/);
        res = await api.post('/api/setup', {code: 'X', username: 'autre', password: 'motdepasse'});
        assert.equal(res.status, 409, 'une seule installation');
    });

    await t.test('connexion : erreur générique puis blocage après 5 échecs', async () => {
        const other = client(smv.url);
        for (let i = 0; i < 5; i++) {
            const res = await other.post('/api/login', {username: 'admin', password: 'mauvais'});
            assert.equal(res.status, 401);
        }
        const blocked = await other.post('/api/login', {username: 'admin', password: 'motdepasse'});
        assert.equal(blocked.status, 429);
        assert.ok(blocked.headers.get('retry-after'));
        smv.app.auth.limiter.entries.clear();
        const ok = await other.post('/api/login', {username: 'ADMIN', password: 'motdepasse'});
        assert.equal(ok.status, 200);
    });

    await t.test('protection CSRF : JSON et même origine exigés', async () => {
        const form = await fetch(`${smv.url}/api/logout`, {
            method: 'POST', headers: {Cookie: api.cookie, 'Content-Type': 'application/x-www-form-urlencoded'}, body: 'a=1',
        });
        assert.equal(form.status, 415);
        const cross = await api.post('/api/logout', {}, {Origin: 'https://ailleurs.example'});
        assert.equal(cross.status, 403);
    });

    await t.test('source Stalker : chargement en tâche de fond et bibliothèque sans secrets', async () => {
        const created = await api.post('/api/sources', {
            type: 'stalker', name: 'Portail', portalUrl: `${iptv.url}/c/`, mac: '00:1a:79:00:00:01',
        });
        assert.equal(created.status, 200);
        sourceId = created.data.source.id;
        const job = await waitForJob(api, created.data.jobId);
        assert.equal(job.status, 'done', job.error);
        assert.deepEqual(job.result.counts, {live: 450, vod: 2, series: 1}, 'catégories FR uniquement');

        const lib = await api.get(`/api/sources/${sourceId}/library`);
        assert.equal(lib.data.live.length, 450);
        const raw = JSON.stringify(lib.data);
        assert.ok(!raw.includes('00:1A:79'), 'pas de MAC');
        assert.ok(!raw.includes('ffmpeg http'), 'pas de commande de lecture');
        assert.equal(lib.data.live[0].logo, `${iptv.url}/logos/1.png`, 'logo relatif résolu');
    });

    await t.test('lecture d\'une chaîne : lien créé par le serveur, flux relayé', async () => {
        const res = await api.post(`/api/sources/${sourceId}/play`, {key: 'live:100'});
        assert.equal(res.status, 200, JSON.stringify(res.data));
        assert.equal(res.data.kind, 'mpegts');
        const ctrl = new AbortController();
        const stream = await fetch(smv.url + res.data.streamUrl, {signal: ctrl.signal});
        assert.equal(stream.status, 200);
        const reader = stream.body.getReader();
        const {value} = await reader.read();
        assert.equal(value[0], 0x47, 'paquets MPEG-TS');
        ctrl.abort();
        const portal = iptv.log.filter((l) => l.path === '/play/live.php').pop();
        assert.match(portal.headers.cookie, /mac=00%3A1A%3A79/, 'en-têtes STB transmis');

        const lib = await api.get(`/api/sources/${sourceId}/library`);
        assert.equal(lib.data.history[0].key, 'live:100');
    });

    await t.test('portail renvoyant un lien sans identifiant (stream= vide)', async () => {
        const readTs = async (streamUrl) => {
            const ctrl = new AbortController();
            const stream = await fetch(smv.url + streamUrl, {signal: ctrl.signal});
            assert.equal(stream.status, 200);
            const {value} = await stream.body.getReader().read();
            ctrl.abort();
            return value;
        };
        // 1. Nouvelle demande au format « localhost/ch/<id>_ » : lien valide
        let res = await api.post(`/api/sources/${sourceId}/play`, {key: 'live:103'});
        assert.equal(res.status, 200, JSON.stringify(res.data));
        assert.equal((await readTs(res.data.streamUrl))[0], 0x47);
        let played = iptv.log.filter((l) => l.path === '/play/live.php').pop();
        assert.match(played.query, /stream=103&.*play_token=GOOD103/);

        // 2. Le portail ne sait pas faire mieux : URL de la liste (son propre jeton)
        res = await api.post(`/api/sources/${sourceId}/play`, {key: 'live:104', previous: res.data.id});
        assert.equal(res.status, 200, JSON.stringify(res.data));
        assert.equal((await readTs(res.data.streamUrl))[0], 0x47);
        played = iptv.log.filter((l) => l.path === '/play/live.php').pop();
        assert.match(played.query, /stream=104&.*play_token=LIST104/);
        assert.ok(!iptv.log.some((l) => /play_token=EMPTY/.test(l.query || '')), 'jeton du lien vide jamais utilisé');

        // 3. URL de la liste périmée (refusée) : le proxy passe au lien du portail complété
        res = await api.post(`/api/sources/${sourceId}/play`, {key: 'live:105', previous: res.data.id});
        assert.equal(res.status, 200, JSON.stringify(res.data));
        assert.equal((await readTs(res.data.streamUrl))[0], 0x47);
        const tries = iptv.log.filter((l) => l.path === '/play/live.php' && /stream=105/.test(l.query)).map((l) => l.query);
        assert.match(tries[0], /play_token=STALE105/);
        assert.match(tries.at(-1), /stream=105&.*play_token=PORTAL105/);
    });

    await t.test('flux refusé par le fournisseur : code HTTP conservé', async () => {
        const res = await api.post(`/api/sources/${sourceId}/play`, {key: 'live:102'});
        const stream = await fetch(smv.url + res.data.streamUrl);
        assert.equal(stream.status, 456);
        assert.match(await stream.text(), /Flux refusé/);

        // Le HLS (iPhone, mode compatibilité) renvoie le même refus sans relancer ffmpeg
        const before = iptv.log.filter((l) => l.path === '/blocked').length;
        for (let i = 0; i < 2; i++) {
            const hls = await fetch(smv.url + res.data.hlsUrl);
            assert.equal(hls.status, 456);
            assert.match(await hls.text(), /Flux refusé/);
        }
        const again = await fetch(smv.url + res.data.streamUrl);
        assert.equal(again.status, 456);
        await again.text();
        assert.equal(iptv.log.filter((l) => l.path === '/blocked').length, before, 'fournisseur non resollicité');
    });

    await t.test('VOD MP4 : requêtes partielles (avance rapide)', async () => {
        const res = await api.post(`/api/sources/${sourceId}/play`, {key: 'vod:901'});
        assert.equal(res.data.kind, 'mp4');
        const part = await fetch(smv.url + res.data.streamUrl, {headers: {Range: 'bytes=100-199'}});
        assert.equal(part.status, 206);
        assert.equal((await part.arrayBuffer()).byteLength, 100);
    });

    await t.test('séries : saisons dépliées et lecture d\'un épisode', async () => {
        const res = await api.get(`/api/sources/${sourceId}/episodes?series=series:700`);
        assert.equal(res.data.episodes.length, 5);
        const last = res.data.episodes.at(-1);
        assert.deepEqual([last.season, last.episode], [2, 2]);
        const play = await api.post(`/api/sources/${sourceId}/play`, {key: last.key});
        assert.equal(play.status, 200);
        assert.match(play.data.title, /S2 E2/);
        await fetch(smv.url + play.data.streamUrl, {headers: {Range: 'bytes=0-0'}});
        assert.ok(iptv.log.some((l) => l.path === '/movie/2.mp4' && l.query.includes('series=2')));
    });

    await t.test('guide des programmes', async () => {
        const res = await api.get(`/api/sources/${sourceId}/epg?key=live:100`);
        assert.equal(res.data.programmes[0].title, 'Journal');
    });

    await t.test('transcodage HLS : MPEG-2 réencodé en H.264 pour l\'iPhone', async () => {
        const res = await api.post(`/api/sources/${sourceId}/play`, {key: 'live:101', quality: '480p'});
        assert.equal(res.data.transcodeRequired, true);
        const playlist = await fetch(smv.url + res.data.hlsUrl);
        assert.equal(playlist.status, 200, await playlist.clone().text());
        const text = await playlist.text();
        assert.match(text, /#EXTINF/);
        const segment = text.split('\n').find((l) => l && !l.startsWith('#'));
        const base = res.data.hlsUrl.replace(/index\.m3u8$/, '');
        const seg = await fetch(smv.url + base + segment);
        assert.equal(seg.status, 200);
        assert.ok((await seg.arrayBuffer()).byteLength > 1000);
        const sys = await api.get('/api/system');
        assert.ok(sys.data.streams.some((s) => s.transcoding && s.quality === '480p'));
        await api.del(`/api/play/${res.data.id}`);
    });

    await t.test('favoris et PIN parental', async () => {
        const fav = await api.put(`/api/sources/${sourceId}/favorites`, {keys: ['live:100', 'inconnu']});
        assert.deepEqual(fav.data.favorites, ['live:100']);
        await api.patch(`/api/sources/${sourceId}`, {pin: '1234'});
        let res = await api.get(`/api/sources/${sourceId}/library`);
        assert.equal(res.status, 403);
        assert.equal(res.data.pinRequired, true);
        res = await api.get(`/api/sources/${sourceId}/library`, {'X-Source-Pin': '0000'});
        assert.equal(res.status, 403);
        res = await api.get(`/api/sources/${sourceId}/library`, {'X-Source-Pin': '1234'});
        assert.equal(res.status, 200);
        assert.deepEqual(res.data.favorites, ['live:100']);
        const list = await api.get('/api/sources');
        assert.equal(list.data[0].locked, true);
        assert.ok(!JSON.stringify(list.data).includes('1234'), 'PIN jamais renvoyé');
    });

    await t.test('liste M3U par URL : identifiants masqués', async () => {
        const created = await api.post('/api/sources', {type: 'm3u', name: 'Liste', m3uUrl: `${iptv.url}/list.m3u?username=u&password=secret`});
        const job = await waitForJob(api, created.data.jobId);
        assert.equal(job.status, 'done', job.error);
        const list = await api.get('/api/sources');
        const m3u = list.data.find((s) => s.type === 'm3u');
        assert.match(m3u.m3uUrl, /password=\*\*\*/);
        const lib = await api.get(`/api/sources/${m3u.id}/library`);
        assert.equal(lib.data.live[0].name, 'Chaîne M3U, info');
        const play = await api.post(`/api/sources/${m3u.id}/play`, {key: lib.data.vod[0].key});
        assert.equal(play.data.kind, 'mp4');
    });

    await t.test('images distantes relayées (contenu mixte HTTPS)', async () => {
        const res = await fetch(`${smv.url}/api/img?u=${encodeURIComponent(`${iptv.url}/logo.png`)}`, {headers: {Cookie: api.cookie}});
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/png');
        const anon = await fetch(`${smv.url}/api/img?u=${encodeURIComponent(`${iptv.url}/logo.png`)}`);
        assert.equal(anon.status, 401);
    });

    await t.test('interface servie avec CSP, routes client renvoyées vers index.html', async () => {
        const home = await fetch(`${smv.url}/`);
        assert.equal(home.status, 200);
        assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
        const deep = await fetch(`${smv.url}/films`);
        assert.equal(deep.status, 200);
        const traversal = await fetch(`${smv.url}/%2e%2e/package.json`);
        assert.notEqual(traversal.status, 200);
        const vendor = await fetch(`${smv.url}/vendor/hls.min.js`);
        assert.equal(vendor.status, 200);
    });

    await t.test('déconnexion de tous les appareils', async () => {
        await api.post('/api/account/logout-all');
        const res = await api.get('/api/sources');
        assert.equal(res.status, 401);
    });
});
