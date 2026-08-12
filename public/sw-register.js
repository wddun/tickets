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
// ?fresh=1 is the escape hatch: it unregisters every worker and deletes every
// cache, then reloads clean. Hand that link to anyone stuck on an old build.
(function () {
    if (!('serviceWorker' in navigator)) return;

    var url = new URL(window.location.href);

    if (url.searchParams.has('fresh')) {
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
        return;
    }

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
})();
