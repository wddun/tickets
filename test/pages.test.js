// The pages themselves: what gets served to whom, and the service-worker
// contract that decides whether a door device can be pulled onto a new
// version at all.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, newAdmin, createEvent, share } from './helpers/factories.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readPublic = (f) => fs.readFileSync(path.join(REPO_ROOT, 'public', f), 'utf8');

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const anon = () => createClient(server.base);

describe('public pages', () => {
    const publicPages = [
        '/', '/index.html', '/login.html', '/register.html', '/support.html',
        '/privacy.html', '/forgot-password.html', '/reset-password.html',
        '/verify-email.html', '/waitlist-status.html', '/display.html', '/scanner.html',
    ];

    for (const page of publicPages) {
        test(`${page} is served`, async () => {
            const r = await anon().get(page);
            assert.equal(r.status, 200, `${page} did not load`);
            assert.match(r.headers.get('content-type') || '', /text\/html/);
        });
    }

    test('/support serves the support page', async () => {
        // express.static runs with { extensions: ['html'] } and is mounted
        // before the redirect route, so the extensionless path is served
        // directly rather than bouncing.
        const r = await anon().get('/support');
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type') || '', /text\/html/);
    });

    test('/admin.html is not a separate admin page any more', async () => {
        const r = await anon().get('/admin.html');
        assert.equal(r.status, 302);
        assert.match(r.headers.get('location'), /dashboard\.html/);
    });

    test('the Android app-links file is served as JSON', async () => {
        const r = await anon().get('/.well-known/assetlinks.json');
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.body));
        assert.equal(r.body[0].relation[0], 'delegate_permission/common.handle_all_urls');
    });
});

describe('the API documentation', () => {
    test('is public — an integrator should not need an account to read it', async () => {
        const r = await anon().get('/api.html');
        assert.equal(r.status, 200);
        assert.match(r.text, /WTS Tickets API/);
    });

    test('documents every v1 endpoint the server actually serves', async () => {
        const docs = readPublic('api.html');
        const server = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
        const served = [...server.matchAll(/app\.(get|post|patch|delete)\('(\/api\/v1\/[^']*)'/g)]
            .map(m => m[2].replace(/:\w+/g, ':id'));

        for (const route of new Set(served)) {
            assert.ok(docs.includes(route), `${route} is served but not documented`);
        }
    });

    test('tells people the key is shown once and must be kept server-side', async () => {
        const docs = readPublic('api.html');
        assert.match(docs, /shown once/i);
        assert.match(docs, /never put it in a web page|keep it server-side/i);
    });
});

describe('who may open the dashboard', () => {
    test('a signed-out visitor is sent to the login page', async () => {
        const r = await anon().get('/dashboard.html');
        assert.equal(r.status, 302);
        assert.match(r.headers.get('location'), /login\.html/);
    });

    test('an account with no rooms is sent to the public site', async () => {
        const roomless = await newUser(server);
        const r = await roomless.client.get('/dashboard.html');
        assert.equal(r.status, 302);
        assert.equal(r.headers.get('location'), '/');
    });

    test('an owner gets the page', async () => {
        await createEvent(owner.client, { name: 'Dashboard Room' });
        const r = await owner.client.get('/dashboard.html');
        assert.equal(r.status, 200);
    });

    test('a collaborator gets the page too', async () => {
        const ev = await createEvent(owner.client, { name: 'Shared Dashboard Room' });
        const mate = await newUser(server);
        assert.equal((await mate.client.get('/dashboard.html')).status, 302);

        await share(owner.client, ev.id, mate.email, ['checkin']);
        assert.equal((await mate.client.get('/dashboard.html')).status, 200,
            'someone a room was shared with has something to manage');
    });

    test('hasRooms on /api/auth/me matches who the page lets in', async () => {
        const user = await newUser(server);
        assert.equal((await user.client.get('/api/auth/me')).body.user.hasRooms, false);
        assert.equal((await user.client.get('/dashboard.html')).status, 302);

        await createEvent(user.client, { name: 'Now They Have One' });
        assert.equal((await user.client.get('/api/auth/me')).body.user.hasRooms, true);
        assert.equal((await user.client.get('/dashboard.html')).status, 200);
    });
});

describe('who may open the seed-test-data tool', () => {
    // Bulk-creates and bulk-deletes real registrations and mints a real API
    // key — admin only, not just "has a room" like the dashboard.
    test('a signed-out visitor is sent to the login page', async () => {
        const r = await anon().get('/seed-test-data.html');
        assert.equal(r.status, 302);
        assert.match(r.headers.get('location'), /login\.html/);
    });

    test('an event owner who is not the admin is sent to the public site', async () => {
        await createEvent(owner.client, { name: 'Not An Admin Room' });
        const r = await owner.client.get('/seed-test-data.html');
        assert.equal(r.status, 302);
        assert.equal(r.headers.get('location'), '/');
    });

    test('the admin gets the page', async () => {
        const admin = await newAdmin(server);
        const r = await admin.client.get('/seed-test-data.html');
        assert.equal(r.status, 200);
    });
});

describe('the service worker', () => {
    test('is served with no-store, so a stale one can always be replaced', async () => {
        const r = await anon().get('/sw.js');
        assert.equal(r.status, 200);
        // If the worker script itself were cacheable, a device stuck on an old
        // version could never be told about a new one.
        assert.match(r.headers.get('cache-control') || '', /no-store/);
    });

    const sw = readPublic('sw.js');

    test('serves documents network-first with a cache fallback', async () => {
        // Cache-first documents are what left installed scanners pinned to
        // whatever HTML they first saw.
        assert.match(sw, /DOC_NETWORK_TIMEOUT_MS/, 'documents should race the network against a timeout');
        assert.match(sw, /caches\.match/, 'and still fall back to the cache when offline');
    });

    test('answers a version handshake and can be told to activate', async () => {
        // ?fresh=1 only purges when nothing answers this handshake — that is
        // how a legacy cache-first worker is told apart from a current one.
        assert.match(sw, /addEventListener\('message'/);
        assert.match(sw, /get-version/);
        assert.match(sw, /skip-waiting|skipWaiting/);
    });

    test('keeps the door working offline by precaching the scanner shell', async () => {
        assert.match(sw, /PRECACHE/);
        assert.match(sw, /'\/scanner\.html'/);
        assert.match(sw, /'\/checkin\.html'/);
    });

    const reg = readPublic('sw-register.js');

    test('the registration script purges conditionally, not on every ?fresh=1', async () => {
        // Purging unconditionally would throw away the offline copy the door
        // depends on, at the worst possible moment.
        assert.match(reg, /fresh/);
        assert.match(reg, /get-version|MessageChannel/);
    });

    test('the registration script defers its reload while something is on screen', async () => {
        assert.match(reg, /__swHoldReload/, 'a reload mid-scan would wipe the result off the screen');
    });

    test('the pages that need it register the worker', async () => {
        for (const page of ['scanner.html', 'checkin.html', 'index.html']) {
            assert.match(readPublic(page), /sw-register\.js/, `${page} should register the service worker`);
        }
    });
});

describe('generated links carry ?fresh=1', () => {
    test('the scan-link redirect does', async () => {
        const ev = await createEvent(owner.client, { name: 'Fresh Scan Link' });
        const link = (await owner.client.post(`/api/event/${ev.id}/scanner-links`, {})).body.link;
        const hop = await anon().get(`/scan/${link.token}`);
        assert.match(hop.headers.get('location'), /fresh=1/);
    });

    test('the display URL does', async () => {
        const ev = await createEvent(owner.client, { name: 'Fresh Display' });
        const r = await owner.client.get(`/api/display/token/${ev.id}`);
        assert.match(r.body.url, /fresh=1/);

        const rotated = await owner.client.post(`/api/display/token/${ev.id}/rotate`, {});
        assert.match(rotated.body.url, /fresh=1/);
    });
});

describe('the registration page', () => {
    const register = readPublic('register.html');

    test('only retires a seat hold on an answer that asked about that hold', async () => {
        // Availability polls and the hold request race on page load, and the
        // hold can be replaced while a poll is in flight. Acting on a stale
        // answer told visitors that an empty event had filled up while they
        // were signing up.
        assert.match(register, /askedForHoldToken/,
            'availability answers must record which hold token they were asked about');
        assert.match(register, /a\.askedForHoldToken === holdToken/,
            'the hold-lost check must ignore answers about a different (or no) token');
    });

    test('claims the seat before the counter starts polling', async () => {
        const init = register.slice(register.indexOf('if (applyDeviceLock(loadedEvent)) return;'));
        const holdAt = init.indexOf('acquireHold()');
        const pollAt = init.indexOf('startAvailabilityPolling()');
        assert.ok(holdAt !== -1 && pollAt !== -1, 'expected both calls during page init');
        assert.ok(holdAt < pollAt, 'polling before the hold exists makes the first reading wrong');
    });
});

describe('choosing an event by QR', () => {
    const scanner = readPublic('scanner.html');

    test('only a scan link is acted on while choosing an event', async () => {
        // "Scan QR Instead" opens the camera to pick an event, but the scan
        // handler had no idea that was why. A plain attendee ticket fell
        // through to /api/validate and the person was checked in — for an
        // event that had not even been selected — while the picker sat
        // dismissed and the screen showed nothing.
        assert.match(scanner, /function isChoosingEventByQR/,
            'the scan handler must be able to tell "pick an event" from "work the door"');
        assert.match(scanner, /const choosingEvent = isChoosingEventByQR\(\);/,
            'onScanSuccess must check which mode it is in');

        const handler = scanner.slice(scanner.indexOf('function onScanSuccess'));
        const body = handler.slice(0, handler.indexOf('let videoEl'));
        const refusal = body.indexOf('if (choosingEvent) {');
        const validate = body.indexOf("fetch('/api/validate'");
        assert.ok(refusal !== -1 && validate !== -1, 'expected both branches in the scan handler');
        assert.ok(refusal < validate, 'a ticket must be refused before it can reach /api/validate');
    });

    test('a scan link is only entered when it actually confers check-in', async () => {
        const init = scanner.slice(scanner.indexOf('async function initScanLinkMode'));
        assert.match(init.slice(0, 2000), /capabilities \|\| \[\]\)\.includes\('checkin'\)/,
            'resolving a link is not enough — it has to grant check-in on that event');
    });

    test('a door-display QR does not navigate away while choosing an event', async () => {
        const handler = scanner.slice(scanner.indexOf('function onScanSuccess'));
        const displayBranch = handler.slice(0, handler.indexOf('const scanLinkToken'));
        assert.match(displayBranch, /if \(choosingEvent\)/,
            'scanning a display QR while picking an event should explain, not navigate');
    });
});

describe('the scanner page', () => {
    const scanner = readPublic('scanner.html');

    test('shows the tab bar on a scan link, not only after exiting it', async () => {
        assert.match(scanner, /showTabBar/);
        assert.match(scanner, /scanLink/);
    });

    test('has no exit control on the scan-link banner — the device is locked to that event', async () => {
        assert.ok(!/slb-exit/.test(scanner), 'the scan-link banner should have no X to escape the locked event');
        assert.ok(!/function exitScanLinkMode/.test(scanner), 'exiting a locked scan link should not be reachable from the banner');
    });

    test('plays the entering animation once, not on every trip through the menus', async () => {
        assert.match(scanner, /sessionStorage/, 'the animation should be gated by something that survives navigation');
        assert.match(scanner, /playEnteringAnimation|__playedEntering|enteringPlayed/i);
    });

    test('holds off a service-worker reload while a scan result is on screen', async () => {
        assert.match(scanner, /__swHoldReload/);
    });
});
