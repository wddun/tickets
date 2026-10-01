// Shared server clock, so several screens can agree on *when* something
// happens rather than each acting the moment its own message arrives.
//
// The giveaway room only ever sends small commands ("spin, landing on X"),
// never video, and each screen animates locally. That keeps it cheap, but on
// venue wifi one TV can get the message a few hundred ms after another and
// run visibly behind it. So the controller stamps each spin with a start time
// on the server's clock, and every display seeks its animation to that same
// moment — a late arrival just joins mid-spin, in step with everyone else.
//
// The offset is estimated NTP-style: a few round trips to /api/time, keeping
// the one with the shortest round trip (the least room for asymmetric delay).
// Until the first sample lands, now() falls back to the local clock.
(function () {
    let offsetMs = 0;
    let bestRtt = Infinity;
    let synced = false;

    async function sample() {
        const t0 = Date.now();
        const r = await fetch('/api/time', { cache: 'no-store' });
        const t1 = Date.now();
        if (!r.ok) return;
        const { now } = await r.json();
        const rtt = t1 - t0;
        if (typeof now !== 'number' || rtt > bestRtt) return;
        bestRtt = rtt;
        offsetMs = now - (t0 + t1) / 2;
        synced = true;
    }

    async function sync(rounds = 5) {
        for (let i = 0; i < rounds; i++) {
            try { await sample(); } catch (_) {}
        }
    }

    sync();
    // Clocks drift and the network changes under a long event; start the
    // round-trip floor over so a better (or merely current) path can win.
    setInterval(() => { bestRtt = Infinity; sync(3); }, 5 * 60 * 1000);

    window.ServerClock = {
        // False until one round trip has succeeded. Callers fall back to
        // acting immediately rather than trusting a local clock that may be
        // minutes out — a display that thought a spin started long ago would
        // skip straight to the winner.
        get synced() { return synced; },
        now: () => Date.now() + offsetMs,
        // How long ago (ms) a server-clock instant was, from this screen.
        elapsedSince: (serverMs) => Date.now() + offsetMs - serverMs,
    };
})();
