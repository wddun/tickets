// v12: dashboard.html (and other admin/public pages that get updated
// regularly) used to be cache-first with no network re-check at all — once a
// browser cached it, it would keep serving that exact copy forever, through
// any number of hard refreshes, until this cache version changed. That's
// fine for the scanner/check-in pages (they need to work at the door with no
// connectivity), but wrong for pages where staleness causes real confusion
// (the admin dashboard) or real bugs (a stale ticket price/capacity on the
// public registration page). Bumping the cache name here forces every
// existing installation to drop its old cache on next activate (skipWaiting
// + clients.claim already make that happen without the user needing to do
// anything) — this __only__ needs bumping again if the caching *strategy*
// changes, not for every deploy.
const CACHE = 'wts-v13';

// Only pages that genuinely need to work with no/spotty connectivity.
const PRECACHE = [
    '/scanner.html',
    '/checkin.html',
    '/style.css',
    '/manifest.json',
    '/jsQR.js',
];

// Always fetch the network first for these — falling back to cache only if
// actually offline. Everything else stays cache-first.
const NETWORK_FIRST_PATHS = new Set([
    '/', '/dashboard.html', '/login.html', '/settings.html', '/register.html',
]);

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
    const url = new URL(e.request.url);

    // Always network-first for API calls — never serve stale data
    if (url.pathname.includes('/api/') || e.request.method !== 'GET') {
        e.respondWith(fetch(e.request));
        return;
    }

    if (NETWORK_FIRST_PATHS.has(url.pathname)) {
        e.respondWith(
            fetch(e.request)
                .then(res => {
                    if (res && res.status === 200 && res.type === 'basic') {
                        const clone = res.clone();
                        caches.open(CACHE).then(c => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Cache-first for the scanner/check-in PWA shell and its assets.
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(res => {
                if (res && res.status === 200 && res.type === 'basic') {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return res;
            });
        })
    );
});
