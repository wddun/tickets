// Regression tests for specific holes that were found and closed.
//
// Each of these was reachable against a running server. They are grouped here
// rather than spread through the feature suites because what they protect is
// the boundary, not the feature — and because a failure in this file means
// something is exploitable, not merely wrong.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, TEST_PASSWORD } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, listTickets, uniqueEmail, eventApiKey } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const anon = () => createClient(server.base);

describe('an event cannot be taken over through the sheet integration', () => {
    // POST /api/sheet/generate-link had no authorization and accepted an
    // eventId, so it minted a working apiKey for any event named. Event ids
    // are public — they are in every registration URL and QR code — so anyone
    // holding a registration link could issue themselves tickets and rewrite
    // the event.
    test('a stranger cannot mint a key for someone else\'s event', async () => {
        const ev = await createEvent(owner.client, { name: 'Not Yours To Link' });

        const minted = await anon().post('/api/sheet/generate-link', {
            spreadsheetId: 'attacker-sheet-' + Date.now(),
            eventId: ev.id,
        });
        assert.equal(minted.status, 403, 'an unauthenticated caller minted a key for an event');
        assert.equal(minted.body.apiKey, undefined);
    });

    test('a signed-in stranger cannot either', async () => {
        const ev = await createEvent(owner.client, { name: 'Still Not Yours' });
        const stranger = await newUser(server);

        const minted = await stranger.client.post('/api/sheet/generate-link', {
            spreadsheetId: 'stranger-sheet-' + Date.now(),
            eventId: ev.id,
        });
        assert.equal(minted.status, 403);
    });

    test('the owner still can', async () => {
        const ev = await createEvent(owner.client, { name: 'Mine To Link' });
        const minted = await owner.client.post('/api/sheet/generate-link', {
            spreadsheetId: 'owner-sheet-' + Date.now(),
            eventId: ev.id,
        });
        assert.equal(minted.status, 200);
        assert.ok(minted.body.apiKey);
    });

    test('a key only authorizes the event it was actually issued for', async () => {
        // The check used to find the first link naming an event and compare
        // keys, so a second link pointing at the same event could be treated
        // as authoritative. Now the key itself decides which event it is for.
        const mine = await createEvent(owner.client, { name: 'Key Owner' });
        const theirs = await createEvent(owner.client, { name: 'Key Target' });
        const myKey = await eventApiKey(owner.client, mine.id);

        const misuse = await anon().post('/api/register-bulk', {
            firstName: 'Wrong', lastName: 'Event', email: uniqueEmail('wrong'),
            eventId: theirs.id, ticketCount: 1, apiKey: myKey,
        });
        assert.equal(misuse.status, 401);
        assert.equal((await listTickets(owner.client, theirs.id)).length, 0);
    });
});

describe('the sheet watcher cannot be pointed at the server\'s own network', () => {
    // The watcher fetches a URL server-side and hands the body back, so an
    // unrestricted URL is a server-side request forgery with full response
    // disclosure — and any signed-up account could reach it by creating an
    // event of their own.
    let internal, internalUrl;

    before(async () => {
        internal = http.createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/csv' });
            res.end('secret,value\nINTERNAL-ONLY,hunter2\n');
        });
        await new Promise(r => internal.listen(0, '127.0.0.1', r));
        internalUrl = `http://127.0.0.1:${internal.address().port}/private`;
    });
    after(() => internal?.close());

    test('a localhost URL is refused, not fetched', async () => {
        const ev = await createEvent(owner.client, { name: 'SSRF Probe' });
        const r = await owner.client.post(`/api/event/${ev.id}/sheet-watch/preview`, { url: internalUrl });

        assert.equal(r.status, 400);
        assert.ok(!JSON.stringify(r.body).includes('INTERNAL-ONLY'),
            'the server fetched a private address and handed back the body');
    });

    for (const url of [
        'http://169.254.169.254/latest/meta-data/',   // cloud instance metadata
        'http://localhost:3002/api/events',
        'http://[::1]:8080/',
        'http://192.168.1.1/',
        'file:///etc/passwd',
        'https://example.com/anything.csv',
    ]) {
        test(`refuses ${url}`, async () => {
            const ev = await createEvent(owner.client, { name: 'SSRF Probe' });
            const r = await owner.client.post(`/api/event/${ev.id}/sheet-watch/preview`, { url });
            assert.equal(r.status, 400, `${url} was accepted`);
        });
    }

    test('a Google Sheets link is still accepted as a link', async () => {
        // It will fail to fetch in a test environment, but it must fail at the
        // fetch, not at the "that isn't a sheet" gate.
        const ev = await createEvent(owner.client, { name: 'Real Sheet Shape' });
        const r = await owner.client.post(`/api/event/${ev.id}/sheet-watch/preview`, {
            url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#gid=0',
        });
        assert.ok(!/does not appear to be a Google Sheets link/.test(r.body?.error || ''),
            'a genuine sheet URL was rejected as not being one');
    });

    test('the preview needs manage_event on the event', async () => {
        const ev = await createEvent(owner.client, { name: 'Preview Guard' });
        const stranger = await newUser(server);
        const r = await stranger.client.post(`/api/event/${ev.id}/sheet-watch/preview`, {
            url: 'https://docs.google.com/spreadsheets/d/abc/edit',
        });
        assert.equal(r.status, 403);
    });
});

describe('password rules are the same everywhere', () => {
    test('signup requires a real password', async () => {
        const r = await anon().post('/api/auth/signup', { email: uniqueEmail('weak'), password: 'x' });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /at least 8/);
    });

    test('so does claiming a room through a share link', async () => {
        const ev = await createEvent(owner.client, { name: 'Link Claim' });
        const link = await owner.client.post('/api/sheet/generate-link', {
            spreadsheetId: 'claim-sheet-' + Date.now(), eventId: ev.id,
        });

        const r = await anon().post('/api/auth/signup-for-link', {
            email: uniqueEmail('linkweak'), password: 'x', token: link.body.token,
        });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /at least 8/);
    });

    test('an account made through a share link still has to verify its email', async () => {
        // This path used to create an account with no verification token at
        // all, which permanently exempted it from the check login makes.
        const ev = await createEvent(owner.client, { name: 'Link Verify' });
        const link = await owner.client.post('/api/sheet/generate-link', {
            spreadsheetId: 'verify-sheet-' + Date.now(), eventId: ev.id,
        });

        const email = uniqueEmail('linkclaim');
        const made = await anon().post('/api/auth/signup-for-link', {
            email, password: TEST_PASSWORD, token: link.body.token,
        });
        assert.equal(made.status, 200);
        assert.equal(made.body.needsVerification, true);

        // They get the same verification email as any other signup...
        const mail = await server.waitForEmail(m => m.to === email && /verify/i.test(m.subject));
        assert.match(mail.html, /verify-email\.html\?token=/);

        // ...and cannot log in fresh until they use it.
        const fresh = createClient(server.base);
        const before = await fresh.post('/api/auth/login', { email, password: TEST_PASSWORD });
        assert.equal(before.status, 403);
        assert.equal(before.body.needsVerification, true);

        const token = mail.html.match(/verify-email\.html\?token=([a-f0-9]+)/)[1];
        await fresh.get(`/api/auth/verify/${token}`);
        assert.equal((await fresh.post('/api/auth/login', { email, password: TEST_PASSWORD })).status, 200);
    });
});

describe('secrets are not handed out', () => {
    test('the public event read strips the scanner PIN', async () => {
        const ev = await createEvent(owner.client, { name: 'PIN Guard' });
        assert.equal((await anon().get(`/api/event/${ev.id}`)).body.scannerPin, undefined);

        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/event/${ev.id}`)).body.scannerPin, undefined);

        // Someone who actually has the event still gets it.
        const list = await owner.client.get('/api/events');
        assert.ok(list.body.find(e => e.id === ev.id).scannerPin);
    });

    test('an API key is never readable after it is created', async () => {
        const ev = await createEvent(owner.client, { name: 'Write Only Key' });
        const made = await owner.client.post(`/api/event/${ev.id}/api-keys`, { name: 'Once', scopes: ['checkin'] });
        assert.ok(made.body.key);

        const listed = (await owner.client.get(`/api/event/${ev.id}/api-keys`)).body;
        assert.ok(listed.every(k => k.key === undefined && k.keyHash === undefined),
            'the key list must not expose the secret or its hash');
    });
});

describe('public write endpoints are rate limited', () => {
    // The limiters are disabled for the rest of the suite, so this only checks
    // that each route is wired to one — rate-limits.test.js boots a server
    // with them on and exercises the behaviour.
    test('registration, holds, waitlist and the sheet bootstrap all sit behind a limiter', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
        for (const route of [
            "app.post('/api/register'",
            "app.post('/api/event/:id/hold'",
            "app.post('/api/event/:id/waitlist'",
            "app.post('/api/checkout/:eventId'",
            "app.post('/api/sheet/create-event'",
            "app.post('/api/sheet/generate-link'",
            "app.post('/api/auth/signup-for-link'",
        ]) {
            const at = src.indexOf(route);
            assert.notEqual(at, -1, `${route} not found`);
            const decl = src.slice(at, src.indexOf('\n', at));
            assert.match(decl, /publicWriteLimiter/, `${route} has no rate limit`);
        }
    });
});
