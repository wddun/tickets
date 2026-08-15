// Admin-only surfaces and the audit trail: who can read them, and whether
// consequential actions actually get recorded.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, newAdmin, createEvent, addTicket, listTickets, share, uniqueEmail } from './helpers/factories.js';

let server, admin, owner;
before(async () => {
    server = await startServer();
    admin = await newAdmin(server);
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const anon = () => createClient(server.base);

/** Waits for an audit entry matching `pred` — the write happens after the response. */
async function auditEntry(client, eventId, pred, timeoutMs = 3000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const r = await client.get(`/api/event/${eventId}/audit-log?limit=200`);
        const hit = (r.body?.entries || []).find(pred);
        if (hit) return hit;
        if (Date.now() > until) {
            throw new Error('no matching audit entry; saw: ' +
                JSON.stringify((r.body?.entries || []).map(e => e.action)));
        }
        await new Promise(r2 => setTimeout(r2, 50));
    }
}

describe('admin-only routes', () => {
    const adminRoutes = ['/api/admin/logs', '/api/admin/audit-log', '/api/admin/metrics', '/api/admin/all-rooms'];

    for (const route of adminRoutes) {
        test(`${route} is 401 signed out, 403 for a normal user, 200 for the admin`, async () => {
            assert.equal((await anon().get(route)).status, 401);
            assert.equal((await owner.client.get(route)).status, 403);
            assert.equal((await admin.client.get(route)).status, 200);
        });
    }

    test('the server log buffer comes back as a list of entries', async () => {
        const r = await admin.client.get('/api/admin/logs');
        assert.ok(Array.isArray(r.body));
        if (r.body.length) {
            assert.ok(r.body[0].time && r.body[0].tag, 'log entries carry a time and a tag');
        }
    });

    test('admin metrics cover every event on the instance', async () => {
        const ev = await createEvent(owner.client, { name: 'Counted By Admin' });
        await addTicket(owner.client, ev.id, { name: 'Counted Guest' });

        const r = await admin.client.get('/api/admin/metrics');
        assert.equal(r.status, 200);
        const seen = r.body.events.find(e => e.id === ev.id || e.eventId === ev.id);
        assert.ok(seen, 'admin metrics missed an event owned by someone else');
        assert.ok(r.body.totalTickets >= 1);
    });
});

describe('per-event metrics', () => {
    test('count tickets, check-ins and the percentage', async () => {
        const ev = await createEvent(owner.client, { name: 'Metrics Event' });
        await addTicket(owner.client, ev.id, { name: 'Scanned Guest' });
        await addTicket(owner.client, ev.id, { name: 'No Show' });
        const tickets = await listTickets(owner.client, ev.id);
        await owner.client.post('/api/validate', { token: tickets[0].token, eventId: ev.id });

        const r = await owner.client.get(`/api/event/${ev.id}/metrics`);
        assert.equal(r.status, 200);
        assert.equal(r.body.total, 2);
        assert.equal(r.body.scanned, 1);
        assert.equal(r.body.pct, 50);
        assert.equal(r.body.uniqueRegistrations, 2);
    });

    test('are readable by anyone with access to the event and nobody else', async () => {
        const ev = await createEvent(owner.client, { name: 'Metrics Access' });
        const staff = await newUser(server);
        await share(owner.client, ev.id, staff.email, ['checkin']);

        assert.equal((await staff.client.get(`/api/event/${ev.id}/metrics`)).status, 200);
        assert.equal((await admin.client.get(`/api/event/${ev.id}/metrics`)).status, 200);

        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/event/${ev.id}/metrics`)).status, 403);
        assert.equal((await anon().get(`/api/event/${ev.id}/metrics`)).status, 401);
    });
});

describe('the audit trail', () => {
    test('records who created the event', async () => {
        const ev = await createEvent(owner.client, { name: 'Audited Creation' });
        const entry = await auditEntry(owner.client, ev.id, e => e.action === 'event.created');
        assert.equal(entry.userEmail, owner.email);
        assert.equal(entry.details.name, 'Audited Creation');
        assert.ok(entry.createdAt || entry.timestamp || entry.at, 'an audit entry needs a timestamp');
    });

    test('records a check-in and its undo', async () => {
        const ev = await createEvent(owner.client, { name: 'Audited Door' });
        await addTicket(owner.client, ev.id, { name: 'Audited Guest' });
        const [ticket] = await listTickets(owner.client, ev.id);

        await owner.client.post(`/api/checkin/${ticket.registrationId}`, {});
        const inn = await auditEntry(owner.client, ev.id, e => e.action === 'checkin.manual');
        assert.equal(inn.details.name, 'Audited Guest');

        await owner.client.del(`/api/checkin/${ticket.registrationId}`);
        await auditEntry(owner.client, ev.id, e => e.action.startsWith('checkin.undo') || e.action.includes('undo'));
    });

    test('records access being granted and changed', async () => {
        const ev = await createEvent(owner.client, { name: 'Audited Sharing' });
        const mate = await newUser(server);
        await share(owner.client, ev.id, mate.email, ['checkin']);

        const granted = await auditEntry(owner.client, ev.id, e => e.action === 'access.granted');
        assert.equal(granted.details.email, mate.email);
        assert.deepEqual(granted.details.capabilities, ['checkin']);

        const row = (await owner.client.get(`/api/event/${ev.id}/access`)).body.access.find(a => a.email === mate.email);
        await owner.client.patch(`/api/sheet/access/${row.id}`, { capabilities: ['checkin', 'export_data'] });
        await auditEntry(owner.client, ev.id, e => e.action === 'access.updated');
    });

    test('records lowering capacity out from under people who are mid-signup', async () => {
        const ev = await createEvent(owner.client, { name: 'Audited Capacity', publicRegistration: true, capacity: 3 });
        await addTicket(owner.client, ev.id, { name: 'Seated' });
        await anon().post(`/api/event/${ev.id}/hold`, {});

        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('capacity', '1');
        await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });

        const entry = await auditEntry(owner.client, ev.id, e => e.action === 'capacity.lowered_over_holds');
        assert.equal(entry.details.from, 3);
        assert.equal(entry.details.to, 1);
        assert.equal(entry.details.affected, 1);
    });

    test('is paginated and reports a total', async () => {
        const ev = await createEvent(owner.client, { name: 'Audited Paging' });
        for (let i = 0; i < 4; i++) {
            await owner.client.put(`/api/event/${ev.id}/waitlist-enabled`, { enabled: i % 2 === 0 });
        }

        const page = await owner.client.get(`/api/event/${ev.id}/audit-log?limit=2&offset=0`);
        assert.equal(page.status, 200);
        assert.equal(page.body.entries.length, 2);
        assert.ok(page.body.total >= 4);

        const next = await owner.client.get(`/api/event/${ev.id}/audit-log?limit=2&offset=2`);
        assert.notEqual(next.body.entries[0].id, page.body.entries[0].id, 'offset should move the window');
    });

    test('is readable by anyone with access to the event, and no one else', async () => {
        const ev = await createEvent(owner.client, { name: 'Audit Access' });
        const staff = await newUser(server);
        await share(owner.client, ev.id, staff.email, ['checkin']);

        assert.equal((await staff.client.get(`/api/event/${ev.id}/audit-log`)).status, 200);

        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/event/${ev.id}/audit-log`)).status, 403);
        assert.equal((await anon().get(`/api/event/${ev.id}/audit-log`)).status, 401);
    });

    test('the system-wide log spans every event', async () => {
        const ev = await createEvent(owner.client, { name: 'System Wide Audit' });
        const r = await admin.client.get('/api/admin/audit-log?limit=200');
        assert.equal(r.status, 200);
        assert.ok(r.body.entries.some(e => e.eventId === ev.id), 'the admin log should see other people\'s events');
        assert.ok(r.body.total >= r.body.entries.length);
    });
});

describe('the admin room overview', () => {
    test('groups every room by owner and lists the collaborators on it', async () => {
        const ev = await createEvent(owner.client, { name: 'Overview Room' });
        const mate = await newUser(server);
        await share(owner.client, ev.id, mate.email, ['checkin', 'export_data']);
        await addTicket(owner.client, ev.id, { name: 'Counted' });

        const r = await admin.client.get('/api/admin/all-rooms');
        const room = r.body.rooms.find(x => x.event.id === ev.id);

        assert.equal(room.owner.email, owner.email);
        assert.equal(room.ticketCount, 1);
        assert.equal(room.isMine, false, 'someone else\'s room is not the admin\'s own');

        const collab = room.collaborators.find(c => c.email === mate.email);
        assert.ok(collab, 'collaborator missing from the overview');
        assert.deepEqual([...collab.capabilities].sort(), ['checkin', 'export_data']);
    });

    test('lists every account, including one holding no rooms at all', async () => {
        const roomless = await newUser(server, uniqueEmail('roomless'));
        const r = await admin.client.get('/api/admin/all-rooms');

        const seen = r.body.users.find(u => u.email === roomless.email);
        assert.ok(seen, 'an account with no rooms should still be listed');
        assert.equal(seen.ownedRooms, 0);
        assert.equal(seen.sharedRooms, 0);
        assert.equal(seen.emailVerified, true);
    });

    test('counts owned and shared rooms per account', async () => {
        const solo = await newUser(server);
        const ev = await createEvent(solo.client, { name: 'Their Own Room' });
        const guest = await newUser(server);
        await share(solo.client, ev.id, guest.email, ['checkin']);

        const users = (await admin.client.get('/api/admin/all-rooms')).body.users;
        assert.equal(users.find(u => u.email === solo.email).ownedRooms, 1);
        assert.equal(users.find(u => u.email === guest.email).sharedRooms, 1);
        assert.equal(users.find(u => u.email === guest.email).ownedRooms, 0);
    });
});
