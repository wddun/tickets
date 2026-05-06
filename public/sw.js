const CACHE = 'wts-v5';
const PRECACHE = [
    '/scanner.html',
    '/login.html',
    '/',
    '/style.css',
    '/manifest.json',
    '/html5-qrcode.min.js',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(PRECACHE))
    );
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = e.request.url;

    // Always network-first for API calls — never serve stale data
    if (url.includes('/api/') || e.request.method !== 'GET') {
        e.respondWith(fetch(e.request));
        return;
    }

    // Cache-first for everything else (HTML shells, CSS, the QR library)
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(res => {
                // Cache any new static GET response
                if (res && res.status === 200 && res.type === 'basic') {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return res;
            });
        })
    );
});
