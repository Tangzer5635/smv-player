/*
 * Service worker : garde une copie de l'interface pour démarrer hors connexion
 * ou sur un réseau lent. Toujours « réseau d'abord » : une mise à jour du serveur
 * est prise en compte immédiatement. L'API et les flux ne sont jamais mis en cache.
 */
const CACHE = 'smv-shell-v4';
const SHELL = [
    '/',
    '/css/app.css',
    '/js/main.js',
    '/js/api.js',
    '/js/dom.js',
    '/js/icons.js',
    '/js/player.js',
    '/js/store.js',
    '/js/views/auth.js',
    '/js/views/catalog.js',
    '/js/views/favorites.js',
    '/js/views/live.js',
    '/js/views/settings.js',
    '/js/views/source-form.js',
    '/vendor/hls.min.js',
    '/vendor/mpegts.js',
    '/icons/icon-192.png',
    '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => null));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== location.origin) return;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/')) return;

    const isPage = event.request.mode === 'navigate';
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response.ok && (isPage || SHELL.includes(url.pathname))) {
                    const copy = response.clone();
                    caches.open(CACHE).then((cache) => cache.put(isPage ? '/' : event.request, copy));
                }
                return response;
            })
            .catch(() => caches.match(isPage ? '/' : event.request).then((r) => r || Response.error()))
    );
});
