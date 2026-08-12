// Service worker registration + update handling.
//
// Registering alone isn't enough: the browser only notices a new worker on a
// navigation, and even once it installs, the page already on screen keeps the
// HTML the *old* worker gave it until something reloads it. That's how an
// installed scanner ends up months stale with no way for the person holding it
// to refresh out of the problem. This checks for updates on a timer and when
// the page comes back to the foreground, and reloads once the new worker takes
// over.
//
// ?fresh=1 is the escape hatch, and it is safe to leave on every generated
// link because it is conditional: it only wipes anything when this client is
// actually running a pre-network-first worker.
//
// Telling the two apart is easy — the old worker has no message handler at
// all, so it can never answer a version ping. A modern worker replies, and we
// strip the parameter and carry on without touching the cache. That matters:
// unconditionally purging on every open would throw away the offline copy the
// door depends on, right at the moment someone is opening the scanner, and on
// a bad venue connection they'd have neither cache nor network.
(function () {
    if (!('serviceWorker' in navigator)) return;

    var url = new URL(window.location.href);

    function stripFreshFromHistory() {
        url.searchParams.delete('fresh');
        try { window.history.replaceState({}, '', url.toString()); } catch (e) {}
    }

    // Resolves true when a modern worker (one that answers) is in control.
    function hasModernWorker() {
        return new Promise(function (resolve) {
            var sw = navigator.serviceWorker.controller;
            if (!sw) return resolve(false);
            var done = false;
            var ch = new MessageChannel();
            ch.port1.onmessage = function (e) {
                if (done) return;
                done = true;
                resolve(!!(e.data && e.data.type === 'version'));
            };
            try { sw.postMessage({ type: 'get-version' }, [ch.port2]); } catch (e) { return resolve(false); }
            setTimeout(function () { if (!done) { done = true; resolve(false); } }, 600);
        });
    }

    function purgeAndReload() {
        url.searchParams.delete('fresh');
        Promise.all([
            navigator.serviceWorker.getRegistrations().then(function (rs) {
                return Promise.all(rs.map(function (r) { return r.unregister(); }));
            }).catch(function () {}),
            (window.caches ? caches.keys().then(function (ks) {
                return Promise.all(ks.map(function (k) { return caches.delete(k); }));
            }) : Promise.resolve()).catch(function () {}),
        ]).then(function () {
            // replace() so the cleanup URL doesn't sit in history and re-run.
            window.location.replace(url.toString());
        });
    }

    if (url.searchParams.has('fresh')) {
        hasModernWorker().then(function (modern) {
            if (modern) {
                // Already self-updating: nothing to clear, no reload, no flash.
                stripFreshFromHistory();
                start();
            } else {
                purgeAndReload();
            }
        });
        return;
    }
    start();

    function start() {
    // Has a worker ever controlled this page? Reloading for the *first* claim
    // would be a pointless flash on a first visit (or right after ?fresh=1,
    // which leaves the page briefly uncontrolled), but every claim after that
    // means the HTML on screen came from a worker that has now been replaced.
    // This has to be a live flag, not a snapshot taken at load: a page that
    // starts uncontrolled and is claimed a moment later still needs to reload
    // on the *next* update.
    var everControlled = !!navigator.serviceWorker.controller;
    var reloading = false;

    function reloadOnce() {
        if (reloading) return;
        reloading = true;
        window.location.reload();
    }

    // Pages that are mid-task (a scan being processed, a confirm on screen)
    // can set window.__swHoldReload = true to defer the reload a moment.
    function reloadWhenIdle() {
        if (!window.__swHoldReload) return reloadOnce();
        var waited = 0;
        var t = setInterval(function () {
            waited += 500;
            if (!window.__swHoldReload || waited > 15000) {
                clearInterval(t);
                reloadOnce();
            }
        }, 500);
    }

    navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (everControlled) { reloadWhenIdle(); return; }
        everControlled = true;
    });

    navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'sw-updated' && everControlled) reloadWhenIdle();
    });

    navigator.serviceWorker.register('/sw.js').then(function (reg) {
        function check() { reg.update().catch(function () {}); }

        // A worker that installed but is waiting behind this page will never
        // take over on its own — tell it to.
        function promote(worker) {
            if (!worker) return;
            worker.addEventListener('statechange', function () {
                if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                    worker.postMessage({ type: 'skip-waiting' });
                }
            });
        }

        if (reg.waiting && navigator.serviceWorker.controller) {
            reg.waiting.postMessage({ type: 'skip-waiting' });
        }
        reg.addEventListener('updatefound', function () { promote(reg.installing); });

        check();
        setInterval(check, 15 * 60 * 1000);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') check();
        });
    }).catch(function () {});
    }
})();
