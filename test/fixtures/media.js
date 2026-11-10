/*
 * Génère les médias de test avec ffmpeg (mire + son) : TS H.264/MP2, TS MPEG-2,
 * MKV HEVC, MP4 H.264/AAC. Résultat mis en cache dans le dossier donné.
 */
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

function findFfmpeg() {
    const candidates = [process.env.SMV_FFMPEG_PATH, 'ffmpeg'];
    try {
        candidates.push(require('ffmpeg-static'));
    } catch (_) {
    }
    return candidates.find((c) => c && spawnSync(c, ['-version']).status === 0) || null;
}

function generateMedia(dir) {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return null;
    fs.mkdirSync(dir, {recursive: true});
    const source = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440'];
    const outputs = {
        'live.ts': ['-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'mp2', '-f', 'mpegts'],
        'mpeg2.ts': ['-t', '12', '-c:v', 'mpeg2video', '-c:a', 'mp2', '-f', 'mpegts'],
        'movie_hevc.mkv': ['-t', '10', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-c:a', 'ac3'],
        'movie.mp4': ['-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart'],
    };
    for (const [name, args] of Object.entries(outputs)) {
        const target = path.join(dir, name);
        if (fs.existsSync(target) && fs.statSync(target).size > 0) continue;
        const out = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...source, ...args, target]);
        if (out.status !== 0) throw new Error(`ffmpeg (${name}) : ${out.stderr}`);
    }
    return {dir, ffmpeg};
}

module.exports = {generateMedia, findFfmpeg};

if (require.main === module) {
    const result = generateMedia(path.resolve(process.argv[2] || 'test-media'));
    console.log(result ? `Médias générés dans ${result.dir}` : 'ffmpeg introuvable');
}
