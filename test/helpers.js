const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {createApp} = require('../server/app');

// Serveur SMV complet sur un port libre, avec un dossier de données temporaire
async function startSmv({trustProxy = false} = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smv-test-'));
    let port = 0;
    const app = createApp({dataDir, version: 'test', trustProxy, getPort: () => port});
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    return {
        app,
        dataDir,
        url: `http://127.0.0.1:${port}`,
        async close() {
            app.shutdown();
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
            fs.rmSync(dataDir, {recursive: true, force: true});
        },
    };
}

// Client minimal qui garde le cookie de session
function client(baseUrl) {
    let cookie = '';
    const call = async (method, pathname, body, headers = {}) => {
        const res = await fetch(baseUrl + pathname, {
            method,
            headers: {
                ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
                ...(cookie ? {Cookie: cookie} : {}),
                ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        let data = null;
        const text = await res.text();
        try {
            data = JSON.parse(text);
        } catch (_) {
            data = text;
        }
        return {status: res.status, data, headers: res.headers};
    };
    return {
        get: (p, h) => call('GET', p, undefined, h),
        post: (p, b = {}, h) => call('POST', p, b, h),
        put: (p, b = {}, h) => call('PUT', p, b, h),
        patch: (p, b = {}, h) => call('PATCH', p, b, h),
        del: (p, h) => call('DELETE', p, undefined, h),
        get cookie() {
            return cookie;
        },
    };
}

async function waitForJob(api, jobId, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const {data} = await api.get(`/api/jobs/${jobId}`);
        if (data.status !== 'running') return data;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Tâche trop longue');
}

module.exports = {startSmv, client, waitForJob};
