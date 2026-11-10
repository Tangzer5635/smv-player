const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {AuthStore, LoginLimiter} = require('../server/auth');
const {parseM3U} = require('../server/m3u');
const {guessKind} = require('../server/playback');
const {maskUrl, migrateLegacyProfile, stripPlayerPrefix} = require('../server/sources');
const {normalizeEpisodes} = require('../server/stalker');
const net = require('../server/net');

test('comptes : création, vérification, jeton, changement de mot de passe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smv-auth-'));
    const auth = new AuthStore(dir);
    assert.ok(auth.setupCode, 'code d\'installation tant qu\'aucun compte');
    await assert.rejects(auth.createUser('a', 'court'), /Identifiant invalide|trop court/);
    await auth.createUser('Tanguy', 'motdepasse');
    assert.equal(auth.setupCode, null);
    assert.ok(await auth.verify('tanguy', 'motdepasse'), 'identifiant insensible à la casse');
    assert.equal(await auth.verify('tanguy', 'mauvais'), null);
    assert.equal(await auth.verify('inconnu', 'motdepasse'), null);

    const {token} = auth.issueToken(auth.find('tanguy'));
    assert.equal(auth.verifyToken(token).user.username, 'Tanguy');
    assert.equal(auth.verifyToken(token.slice(0, -3) + 'abc'), null, 'signature altérée');

    await auth.changePassword('tanguy', 'motdepasse', 'nouveau-mdp');
    assert.equal(auth.verifyToken(token), null, 'anciens cookies invalidés');

    const reloaded = new AuthStore(dir);
    assert.ok(await reloaded.verify('tanguy', 'nouveau-mdp'));
    assert.ok(reloaded.secret.equals(auth.secret), 'secret de signature conservé');
    fs.rmSync(dir, {recursive: true, force: true});
});

test('limitation des tentatives : blocage progressif', () => {
    const limiter = new LoginLimiter({maxFailures: 3, baseLockMs: 1000});
    for (let i = 0; i < 2; i++) limiter.fail('ip');
    assert.equal(limiter.check('ip').allowed, true);
    limiter.fail('ip');
    const blocked = limiter.check('ip');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfter >= 1);
    limiter.success('ip');
    assert.equal(limiter.check('ip').allowed, true);
});

test('M3U : titres avec virgules, groupes, VOD, en-têtes VLC', () => {
    const list = parseM3U([
        '#EXTM3U',
        '#EXTINF:-1 tvg-id="a,b" tvg-logo="http://l/1.png" group-title="FR | Info",TF1, HD',
        '#EXTVLCOPT:http-user-agent=Agent/1.0',
        'http://srv/live/u/p/1.ts',
        '#EXTINF:-1 group-title="Action",Film',
        'http://srv/movie/u/p/2.mkv',
        '#EXTINF:-1 group-title="Drame",S01E01',
        'http://srv/series/u/p/3.mp4',
    ].join('\r\n'));
    assert.equal(list.channels.length, 1);
    assert.equal(list.channels[0].name, 'TF1, HD');
    assert.equal(list.channels[0].group, 'FR | Info');
    assert.deepEqual(list.channels[0].headers, {'User-Agent': 'Agent/1.0'});
    assert.equal(list.vod.length, 2);
    assert.equal(list.vod[1].category, 'Séries • Drame');
});

test('nature des flux devinée depuis l\'URL', () => {
    assert.equal(guessKind('http://h/play/live.php?stream=1&extension=ts', 'live'), 'mpegts');
    assert.equal(guessKind('http://h/a/b.m3u8', 'live'), 'hls');
    assert.equal(guessKind('http://h/movie/1.mp4', 'vod'), 'mp4');
    assert.equal(guessKind('http://h/movie/1.mkv', 'vod'), 'file');
});

test('épisodes : saisons Ministra dépliées, épisodes simples conservés', () => {
    const seasons = normalizeEpisodes([
        {id: '7:1', name: 'Saison 1', series: [1, 2], cmd: 's1'},
        {id: '7:2', name: 'Season 2', series: [1], cmd: 's2'},
    ], {seriesId: '7', serverBase: 'http://p/c'});
    assert.deepEqual(seasons.map((e) => [e.season, e.episode, e.seriesIndex, e.cmd]), [[1, 1, 1, 's1'], [1, 2, 2, 's1'], [2, 1, 1, 's2']]);

    const flat = normalizeEpisodes([
        {id: '55', name: 'Pilote', season_number: '1', episode_number: '1', cmd: 'x'},
        {id: '56', name: 'Suite', season_number: '1', episode_number: '2'},
    ], {seriesId: '7', serverBase: 'http://p/c'});
    assert.deepEqual(flat.map((e) => [e.title, e.season, e.episode, e.episodeId]), [['Pilote', 1, 1, '55'], ['Suite', 1, 2, '56']]);
});

test('sources : identifiants masqués, préfixes Stalker, reprise des profils v3', () => {
    assert.match(maskUrl('http://srv/get.php?username=u&password=secret&type=m3u'), /password=\*\*\*/);
    assert.equal(stripPlayerPrefix('ffmpeg http://h/1.ts'), 'http://h/1.ts');

    const migrated = migrateLegacyProfile({
        id: 'p1', name: 'Ancien', type: 'stalker', portalUrl: 'http://p/c/', mac: '00:1A:79:00:00:01',
        channels: [
            {id: '1', name: 'Chaîne', contentType: 'live', cmd: 'ffmpeg x', group: 'G'},
            {id: '9', name: 'Film', contentType: 'vod', cmd: '/m', category: 'C'},
        ],
        favoriteChannelIds: ['1', 'vod:9'],
        history: [{id: '1', contentType: 'live'}],
        settings: {accentColor: '#112233', pin: '1234'},
    });
    assert.equal(migrated.items.length, 2);
    assert.deepEqual(migrated.favorites, ['live:1', 'vod:9']);
    assert.equal(migrated.history[0].key, 'live:1');
    assert.equal(migrated.color, '#112233');
    assert.equal(migrated.legacyPin, '1234');
});

test('proxy : priorité paramètres > environnement, contournement local', async () => {
    net.setConfiguredProxy('proxy.local:3128');
    assert.deepEqual(await net.describeProxy('http://iptv.example/'), {proxy: 'http://proxy.local:3128', source: 'config'});
    assert.deepEqual(await net.describeProxy('http://127.0.0.1:9000/'), {proxy: null, source: 'direct'});
    net.setConfiguredProxy('');
    assert.throws(() => net.normalizeProxyUrl('ftp://x'), /HTTP/);
});
