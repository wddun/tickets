// Caching strategy, and why it looks like this.
//
// This used to serve the scanner/check-in shell cache-first: if a copy was in
// the cache it was returned and the network was never consulted. That made the
// door work offline, but it also meant an installed scanner kept running
// whatever HTML it first saw — forever — and the only way to move it on was to
// change the cache name below on every deploy. Anyone who missed a bump (or
// who had the page embedded in another app's webview) just stayed old, with no
// way to refresh out of it.
//
// Now documents are network-first with a short timeout, and everything else is
// stale-while-revalidate. A device with any working connection always renders
// current HTML; a device with none still falls back to the cached copy, so the
// door keeps working. Nothing here needs a version bump to ship a change — the
// name below only exists to discard an old cache's *shape*, so bump it only if
// the cache layout itself changes, not for content.
const CACHE = 'wts-v20';

// Kept so the door still works with no connectivity — these are the fallback,
// not the primary source.
const PRECACHE = [
    '/scanner.html',
    '/checkin.html',
    '/style.css',
    '/manifest.json',
    '/jsQR.js',
];

// How long a document waits for the network before falling back to cache. Long
// enough to beat a slow venue connection, short enough that a dead one doesn't
// leave a scanner staring at a blank screen.
const DOC_NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', e => {
    // Don't let one failed asset abort the whole install — a broken precache
    // entry used to leave the SW permanently uninstalled.
    e.waitUntil(
        caches.open(CACHE).then(c => Promise.all(
            PRECACHE.map(u => c.add(u).catch(() => {}))
        ))
    );
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
        // Tell any page already on screen that it's now running under a new
        // worker, so it can pull fresh HTML instead of sitting there stale
        // until someone happens to reload it.
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of windows) c.postMessage({ type: 'sw-updated', cache: CACHE });
    })());
});

self.addEventListener('message', e => {
    if (!e.data) return;
    // Lets a page force a waiting worker to take over immediately.
    if (e.data.type === 'skip-waiting') self.skipWaiting();
    // Answers ?fresh=1's "are you a modern worker?" ping. The pre-network-first
    // worker had no message handler at all and so can never reply — that
    // silence is exactly how the page tells the two apart and decides whether
    // a cache purge is actually warranted.
    if (e.data.type === 'get-version' && e.ports && e.ports[0]) {
        e.ports[0].postMessage({ type: 'version', cache: CACHE });
    }
});

function isDocumentRequest(request, url) {
    return request.mode === 'navigate'
        || request.destination === 'document'
        || url.pathname.endsWith('.html');
}

async function networkFirst(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOC_NETWORK_TIMEOUT_MS);
    try {
        const res = await fetch(request, { signal: controller.signal });
        clearTimeout(timer);
        if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone)).catch(() => {});
        }
        return res;
    } catch (_) {
        clearTimeout(timer);
        const cached = await caches.match(request);
        if (cached) return cached;
        // A navigation that has never been cached and can't reach the network:
        // fall back to the scanner shell so the door isn't a browser error.
        if (request.mode === 'navigate') {
            const shell = await caches.match('/scanner.html');
            if (shell) return shell;
        }
        throw _;
    }
}

// Serve what we have immediately, then refresh it in the background so the
// next load is current. Keeps assets fast and offline-capable without ever
// pinning them to a stale copy.
async function staleWhileRevalidate(request) {
    const cached = await caches.match(request);
    const network = fetch(request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone)).catch(() => {});
        }
        return res;
    }).catch(() => null);

    if (cached) return cached;
    const res = await network;
    if (res) return res;
    throw new Error('offline and uncached: ' + request.url);
}

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // Never cache API calls or anything that isn't a plain GET, and don't get
    // between the page and cross-origin requests.
    if (e.request.method !== 'GET' || url.pathname.includes('/api/') || url.origin !== self.location.origin) {
        return;
    }

    if (isDocumentRequest(e.request, url)) {
        e.respondWith(networkFirst(e.request));
        return;
    }

    e.respondWith(staleWhileRevalidate(e.request));
});
