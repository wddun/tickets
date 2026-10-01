// Offline backup: a scanner keeps a hashed copy of the guest list, answers
// from it when /api/validate is too slow, and replays what it did once the
// connection is back. The device side lives in scanner.html and the iOS app;
// these tests pin the server contract both of them depend on.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, updateEvent, addTicket, listTickets, scanLinkClient } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function offlineEvent(fields = {}) {
    const ev = await createEvent(owner.client, fields);
    const r = await owner.client.put(`/api/event/${ev.id}/offline-backup`, { enabled: true, fallbackMs: 3000 });
    assert.equal(r.status, 200, r.text);
    await addTicket(owner.client, ev.id, { name: 'Grace Hopper' });
    const [ticket] = await listTickets(owner.client, ev.id);
    return { ev, ticket };
}

describe('the offline-backup setting', () => {
    test('is off by default and the snapshot refuses until it is turned on', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.post(`/api/event/${ev.id}/offline-snapshot`, {});
        assert.equal(r.status, 403);
        assert.equal(r.body.offlineBackupEnabled, false);
    });

    test('clamps the fallback delay and reports it to scan links', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.put(`/api/event/${ev.id}/offline-backup`, { enabled: true, fallbackMs: 50 });
        assert.equal(r.body.offlineFallbackMs, 1000);
        const { info } = await scanLinkClient(server, owner.client, ev.id);
        assert.equal(info.offlineBackupEnabled, true);
        assert.equal(info.offlineFallbackMs, 1000);
    });

    test('only someone who can manage the event can change it', async () => {
        const ev = await createEvent(owner.client);
        const stranger = await newUser(server);
        const r = await stranger.client.put(`/api/event/${ev.id}/offline-backup`, { enabled: true });
        assert.equal(r.status, 403);
    });
});

describe('the snapshot', () => {
    test('carries hashed tokens, never raw ones or emails', async () => {
        const { ev, ticket } = await offlineEvent();
        const r = await owner.client.post(`/api/event/${ev.id}/offline-snapshot`, {});
        assert.equal(r.status, 200);
        assert.equal(r.body.tickets.length, 1);
        const row = r.body.tickets[0];
        assert.equal(row.h, sha(ticket.token));
        assert.equal(row.name, 'Grace Hopper');
        assert.ok(!JSON.stringify(r.body).includes(ticket.token), 'raw token leaked into the snapshot');
        assert.ok(!('email' in row));
        assert.equal(row.usedAt, null);
    });

    test('reflects check-ins made online on other devices', async () => {
        const { ev, ticket } = await offlineEvent();
        await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        const r = await owner.client.post(`/api/event/${ev.id}/offline-snapshot`, {});
        assert.ok(r.body.tickets[0].usedAt);
    });

    test('a scan link can download it; a stranger cannot', async () => {
        const { ev } = await offlineEvent();
        const { client: staff, link } = await scanLinkClient(server, owner.client, ev.id);
        assert.equal((await staff.post(`/api/event/${ev.id}/offline-snapshot`, {})).status, 200);
        // Token in the body, no session — how the iOS app proves it.
        const bare = createClient(server.base);
        assert.equal((await bare.post(`/api/event/${ev.id}/offline-snapshot`, { scanLinkToken: link.token })).status, 200);
        assert.equal((await createClient(server.base).post(`/api/event/${ev.id}/offline-snapshot`, {})).status, 401);
        const stranger = await newUser(server);
        assert.equal((await stranger.client.post(`/api/event/${ev.id}/offline-snapshot`, {})).status, 401);
    });

    test('a display token is not enough', async () => {
        const { ev } = await offlineEvent();
        const { token } = (await owner.client.get(`/api/display/token/${ev.id}`)).body;
        assert.ok(token);
        const r = await createClient(server.base).post(`/api/event/${ev.id}/offline-snapshot`, { displayToken: token });
        assert.equal(r.status, 401);
    });
});

describe('syncing offline check-ins', () => {
    test('applies a queued check-in with the time it actually happened', async () => {
        const { ev, ticket } = await offlineEvent();
        const scannedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const r = await owner.client.post(`/api/event/${ev.id}/offline-sync`, {
            scans: [{ id: 'a', token: `ticket:${ticket.token}`, scannedAt, kind: 'checkin' }],
        });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.results.map(x => x.result), ['applied']);
        const [after2] = await listTickets(owner.client, ev.id);
        assert.equal(after2.used_at, scannedAt);
    });

    test('a retry of the same scan is not reported as a double entry', async () => {
        const { ev, ticket } = await offlineEvent();
        const scan = { id: 'a', token: ticket.token, scannedAt: new Date(Date.now() - 1000).toISOString(), kind: 'checkin' };
        await owner.client.post(`/api/event/${ev.id}/offline-sync`, { scans: [scan] });
        const again = await owner.client.post(`/api/event/${ev.id}/offline-sync`, { scans: [scan] });
        assert.equal(again.body.results[0].result, 'applied');
    });

    test('a ticket already used elsewhere comes back as already_used and keeps its first time', async () => {
        const { ev, ticket } = await offlineEvent();
        await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        const [first] = await listTickets(owner.client, ev.id);
        const r = await owner.client.post(`/api/event/${ev.id}/offline-sync`, {
            scans: [{ id: 'b', token: ticket.token, scannedAt: new Date().toISOString(), kind: 'checkin' }],
        });
        assert.equal(r.body.results[0].result, 'already_used');
        const [after2] = await listTickets(owner.client, ev.id);
        assert.equal(after2.used_at, first.used_at);
    });

    test('a ticket from another event is invalid and untouched', async () => {
        const { ticket } = await offlineEvent();
        const { ev: other } = await offlineEvent();
        const r = await owner.client.post(`/api/event/${other.id}/offline-sync`, {
            scans: [{ id: 'c', token: ticket.token, scannedAt: new Date().toISOString(), kind: 'checkin' }],
        });
        assert.equal(r.body.results[0].result, 'invalid');
    });

    test('a future timestamp from a wrong device clock is clamped to now', async () => {
        const { ev, ticket } = await offlineEvent();
        const before2 = Date.now();
        await owner.client.post(`/api/event/${ev.id}/offline-sync`, {
            scans: [{ id: 'd', token: ticket.token, scannedAt: new Date(Date.now() + 86400000).toISOString(), kind: 'checkin' }],
        });
        const [after2] = await listTickets(owner.client, ev.id);
        assert.ok(Date.parse(after2.used_at) <= Date.now() && Date.parse(after2.used_at) >= before2 - 1000);
    });

    test('a scan link can sync; a stranger cannot', async () => {
        const { ev, ticket } = await offlineEvent();
        const { link } = await scanLinkClient(server, owner.client, ev.id);
        const scans = [{ id: 'e', token: ticket.token, scannedAt: new Date().toISOString(), kind: 'checkin' }];
        const stranger = await newUser(server);
        assert.equal((await stranger.client.post(`/api/event/${ev.id}/offline-sync`, { scans })).status, 401);
        const r = await createClient(server.base).post(`/api/event/${ev.id}/offline-sync`, { scans, scanLinkToken: link.token });
        assert.equal(r.status, 200);
        assert.equal(r.body.results[0].result, 'applied');
    });

    test('an offline re-entry brings a checked-out guest back inside', async () => {
        const { ev, ticket } = await offlineEvent();
        await updateEvent(owner.client, ev, { allowReentry: true });
        await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        await owner.client.post('/api/checkout', { token: ticket.token });
        const r = await owner.client.post(`/api/event/${ev.id}/offline-sync`, {
            scans: [{ id: 'f', token: ticket.token, scannedAt: new Date().toISOString(), kind: 'reentry_enter' }],
        });
        assert.equal(r.body.results[0].result, 'applied');
        const snap = await owner.client.post(`/api/event/${ev.id}/offline-snapshot`, {});
        assert.equal(snap.body.tickets[0].reentryStatus, 'inside');
    });
});
