// The giveaway pairing rebuild: a persistent per-event room token (replacing
// the old per-tab crypto.randomUUID() session), and the routes built on it.
// The actual SSE stream isn't exercised here — no realtime channel in this
// app (scanner, monitor, display) has stream-level test coverage either, and
// the test HTTP client would simply hang reading a response that never ends
// — but everything reachable over plain request/response is.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, addTicket, uniqueEmail } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

describe('giveaway room token', () => {
    test('is lazily created, stable across repeated fetches, and needs event access', async () => {
        const ev = await createEvent(owner.client);
        const first = await owner.client.get(`/api/event/${ev.id}/giveaway/token`);
        assert.equal(first.status, 200);
        assert.ok(first.body.token && first.body.token.length >= 32);
        assert.match(first.body.controllerUrl, new RegExp(`giveaway\\.html\\?eventId=${ev.id}`));
        assert.match(first.body.displayUrl, new RegExp(`giveaway-display\\.html\\?eventId=${ev.id}&token=${first.body.token}`));

        const second = await owner.client.get(`/api/event/${ev.id}/giveaway/token`);
        assert.equal(second.body.token, first.body.token, 'the link must not change on its own — that was the whole bug');

        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/event/${ev.id}/giveaway/token`)).status, 403);
    });

    test('rotating invalidates the old token', async () => {
        const ev = await createEvent(owner.client);
        const before = (await owner.client.get(`/api/event/${ev.id}/giveaway/token`)).body;

        const rotated = await owner.client.post(`/api/giveaway/token/${ev.id}/rotate`, {});
        assert.equal(rotated.status, 200);
        assert.notEqual(rotated.body.token, before.token);

        // The old token no longer authorizes the public entrants route.
        const withOld = await createClient(server.base).get(`/api/giveaway/room/${ev.id}/entrants?token=${before.token}`);
        assert.equal(withOld.status, 403);
        const withNew = await createClient(server.base).get(`/api/giveaway/room/${ev.id}/entrants?token=${rotated.body.token}`);
        assert.equal(withNew.status, 200);

        const stranger = await newUser(server);
        assert.equal((await stranger.client.post(`/api/giveaway/token/${ev.id}/rotate`, {})).status, 403);
    });

    test('never appears on the public event endpoint', async () => {
        const ev = await createEvent(owner.client);
        await owner.client.get(`/api/event/${ev.id}/giveaway/token`); // ensure one exists
        const publicView = await createClient(server.base).get(`/api/event/${ev.id}`);
        assert.equal(publicView.body.giveawayToken, undefined);
    });
});

describe('public room entrants feed', () => {
    test('is token-gated and strips email, unlike the authenticated one', async () => {
        const ev = await createEvent(owner.client);
        const email = uniqueEmail('raffle');
        await addTicket(owner.client, ev.id, { name: 'Raffle Guest', email });
        const { token } = (await owner.client.get(`/api/event/${ev.id}/giveaway/token`)).body;

        const noToken = await createClient(server.base).get(`/api/giveaway/room/${ev.id}/entrants`);
        assert.equal(noToken.status, 403);
        const wrongToken = await createClient(server.base).get(`/api/giveaway/room/${ev.id}/entrants?token=wrong`);
        assert.equal(wrongToken.status, 403);

        const r = await createClient(server.base).get(`/api/giveaway/room/${ev.id}/entrants?token=${token}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.entrants.length, 1);
        assert.equal(r.body.entrants[0].name, 'Raffle Guest');
        assert.equal(r.body.entrants[0].email, undefined, 'the public/display feed must never carry email addresses');

        const authed = await owner.client.get(`/api/event/${ev.id}/giveaway/entrants`);
        assert.equal(authed.body.entrants[0].email, email, 'the authenticated controller feed should still carry email');
    });
});

describe('room broadcast authorization', () => {
    test('requires real event capability, not just being logged in', async () => {
        const ev = await createEvent(owner.client);
        const stranger = await newUser(server);
        const r = await stranger.client.post(`/api/giveaway/room/${ev.id}/broadcast`, { type: 'reset', payload: {} });
        assert.equal(r.status, 403, 'the old sessionId-based route had no ownership check at all here — this must');
    });

    test('rejects an unknown message type but accepts the real ones with no display connected', async () => {
        const ev = await createEvent(owner.client);
        const bad = await owner.client.post(`/api/giveaway/room/${ev.id}/broadcast`, { type: 'not-a-real-type', payload: {} });
        assert.equal(bad.status, 400);

        const ok = await owner.client.post(`/api/giveaway/room/${ev.id}/broadcast`, { type: 'potMode', payload: { active: true, style: 'pot' } });
        assert.equal(ok.status, 200, ok.text);
        assert.equal(ok.body.connected, false, 'nothing is listening yet, but the broadcast must still succeed and be cached');
    });
});
