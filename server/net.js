const http = require('http');
const https = require('https');
const {getProxyForUrl} = require('proxy-from-env');
const {HttpProxyAgent} = require('http-proxy-agent');
const {HttpsProxyAgent} = require('https-proxy-agent');

/*
 * Accès réseau sortant (portail, listes M3U, flux)
 *
 * Toutes les requêtes vers les serveurs IPTV passent par ici pour suivre le même
 * chemin : sur un réseau d'entreprise, le portail et les flux doivent tous deux
 * passer par le proxy, sinon le portail répond mais la lecture échoue (ETIMEDOUT).
 *
 * Proxy retenu, par ordre de priorité :
 *   1. celui saisi dans Paramètres › Réseau IPTV
 *   2. variables d'environnement HTTP_PROXY / HTTPS_PROXY / ALL_PROXY (+ NO_PROXY)
 *   3. proxy système de Windows / macOS (résolu par Electron, fichiers PAC compris)
 */

const directHttpAgent = new http.Agent({keepAlive: true, maxSockets: 64});
const directHttpsAgent = new https.Agent({keepAlive: true, maxSockets: 64, rejectUnauthorized: false});
const proxyAgents = new Map();
const systemProxyCache = new Map();
const SYSTEM_PROXY_TTL_MS = 5 * 60 * 1000;

let configuredProxy = '';
let systemProxyResolver = null;

function normalizeProxyUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(withScheme);
    if (!/^https?:$/.test(url.protocol)) throw new Error('Proxy HTTP(S) uniquement');
    return url.toString().replace(/\/$/, '');
}

function setConfiguredProxy(value) {
    try {
        configuredProxy = normalizeProxyUrl(value);
    } catch (_) {
        configuredProxy = '';
    }
}

// Electron : (url) => Promise<'PROXY host:port; DIRECT' | 'DIRECT'>
function setSystemProxyResolver(resolver) {
    systemProxyResolver = resolver;
    systemProxyCache.clear();
}

function isLoopbackHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function isNoProxyHost(hostname) {
    const list = (process.env.NO_PROXY || process.env.no_proxy || '').toLowerCase();
    if (!list) return false;
    if (list === '*') return true;
    const host = hostname.toLowerCase();
    return list.split(/[\s,]+/).filter(Boolean).some((entry) => {
        const suffix = entry.replace(/:\d+$/, '').replace(/^\*?\./, '');
        return host === suffix || host.endsWith(`.${suffix}`);
    });
}

// Première entrée utilisable d'une réponse PAC : "PROXY a:8080; DIRECT"
function parsePacResult(result) {
    for (const entry of String(result || '').split(';')) {
        const [type, hostPort] = entry.trim().split(/\s+/);
        if (!type || type.toUpperCase() === 'DIRECT') return null;
        if (/^(PROXY|HTTP)$/i.test(type) && hostPort) return `http://${hostPort}`;
        if (/^HTTPS$/i.test(type) && hostPort) return `https://${hostPort}`;
        // SOCKS non pris en charge : entrée suivante
    }
    return null;
}

async function resolveSystemProxy(targetUrl) {
    if (!systemProxyResolver) return null;
    const {origin} = new URL(targetUrl);
    const cached = systemProxyCache.get(origin);
    if (cached && Date.now() - cached.at < SYSTEM_PROXY_TTL_MS) return cached.proxy;
    let proxy = null;
    try {
        proxy = parsePacResult(await systemProxyResolver(targetUrl));
    } catch (_) {
        proxy = null;
    }
    systemProxyCache.set(origin, {proxy, at: Date.now()});
    return proxy;
}

async function describeProxy(targetUrl) {
    const {hostname} = new URL(targetUrl);
    if (isLoopbackHost(hostname)) return {proxy: null, source: 'direct'};
    if (configuredProxy) {
        return isNoProxyHost(hostname) ? {proxy: null, source: 'direct'} : {proxy: configuredProxy, source: 'config'};
    }
    const envProxy = getProxyForUrl(targetUrl);
    if (envProxy) return {proxy: envProxy, source: 'env'};
    const systemProxy = await resolveSystemProxy(targetUrl);
    return systemProxy ? {proxy: systemProxy, source: 'system'} : {proxy: null, source: 'direct'};
}

async function resolveProxy(targetUrl) {
    return (await describeProxy(targetUrl)).proxy;
}

// Adresse du proxy sans identifiants (affichage)
function maskProxy(proxy) {
    return proxy ? proxy.replace(/\/\/[^@/]*@/, '//') : proxy;
}

function proxyAgent(proxy, forHttps) {
    const key = `${forHttps ? 'https' : 'http'}|${proxy}`;
    if (!proxyAgents.has(key)) {
        proxyAgents.set(key, forHttps
            ? new HttpsProxyAgent(proxy, {keepAlive: true, rejectUnauthorized: false})
            : new HttpProxyAgent(proxy, {keepAlive: true}));
    }
    return proxyAgents.get(key);
}

// Agent Node pour une requête http(s).request vers targetUrl
async function agentFor(targetUrl) {
    const forHttps = targetUrl.startsWith('https:');
    const proxy = await resolveProxy(targetUrl);
    if (!proxy) return {agent: forHttps ? directHttpsAgent : directHttpAgent, proxy: null};
    return {agent: proxyAgent(proxy, forHttps), proxy};
}

// Options axios équivalentes (le proxy intégré d'axios est désactivé au profit des agents)
async function axiosNetOptions(targetUrl) {
    const proxy = await resolveProxy(targetUrl);
    return {
        proxy: false,
        httpAgent: proxy ? proxyAgent(proxy, false) : directHttpAgent,
        httpsAgent: proxy ? proxyAgent(proxy, true) : directHttpsAgent,
    };
}

// Message d'aide pour les erreurs typiques d'un réseau filtré
function describeNetworkError(err, proxy) {
    const code = err?.code || err?.cause?.code || '';
    if (!proxy && ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) {
        return `${err.message} — réseau filtré ? Renseignez le proxy dans Paramètres › Réseau IPTV`;
    }
    if (proxy && code) return `${err.message} (via le proxy ${maskProxy(proxy)})`;
    return err?.message || String(err);
}

module.exports = {
    normalizeProxyUrl,
    setConfiguredProxy,
    setSystemProxyResolver,
    describeProxy,
    resolveProxy,
    maskProxy,
    agentFor,
    axiosNetOptions,
    describeNetworkError,
};
