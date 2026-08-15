// The capability model: who may do what to which event.
//
// Every route that guards itself with a capability is exercised twice — once
// by someone holding exactly that capability, once by a collaborator who
// holds everything except it. A capability that stops gating a route shows up
// here as a failure rather than as an unnoticed privilege escalation.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ADMIN_EMAIL } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, newAdmin, createEvent, addTicket, listTickets, share } from './helpers/factories.js';

const ALL_CAPS = [
    'checkin', 'undo_checkin', 'manage_tickets', 'email_attendees', 'manage_event',
    'manage_waitlist', 'manage_discounts', 'manage_payments', 'export_data',
    'manage_access', 'delete_event',
];

let server, owner, admin;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
    admin = await newAdmin(server);
});
after(async () => { await server?.stop(); });

/** An event owned by `owner`, shared with a brand-new user at `caps`. */
async function sharedEvent(caps, fields = {}) {
    const event = await createEvent(owner.client, fields);
    const collaborator = await newUser(server);
    const r = await share(owner.client, event.id, collaborator.email, caps);
    assert.equal(r.status, 200, `share failed: ${r.text}`);
    return { event, collaborator };
}

/** Everything except the named capability — for proving a route really gates on it. */
const allBut = (cap) => ALL_CAPS.filter(c => c !== cap && c !== 'manage_access');

describe('granting access', () => {
    test('a collaborator sees the event with exactly the capabilities granted', async () => {
        const { event, collaborator } = await sharedEvent(['checkin', 'manage_tickets']);
        const list = await collaborator.client.get('/api/events');
        const seen = list.body.find(e => e.id === event.id);
        assert.ok(seen, 'shared event missing from the collaborator\'s list');
        assert.deepEqual([...seen.capabilities].sort(), ['checkin', 'manage_tickets']);
        assert.equal(seen.isOwner, false);
        assert.equal(seen.fullAccess, false);
    });

    test('granting undo implies being able to check in at all', async () => {
        const { event, collaborator } = await sharedEvent(['undo_checkin']);
        const seen = (await collaborator.client.get('/api/events')).body.find(e => e.id === event.id);
        assert.ok(seen.capabilities.includes('checkin'), 'undo_checkin should imply checkin');
    });

    test('the legacy "full" role still means every capability', async () => {
        const event = await createEvent(owner.client);
        const collaborator = await newUser(server);
        const r = await owner.client.post('/api/sheet/share', { eventId: event.id, email: collaborator.email, permission: 'full' });
        assert.equal(r.status, 200);
        const seen = (await collaborator.client.get('/api/events')).body.find(e => e.id === event.id);
        assert.deepEqual([...seen.capabilities].sort(), [...ALL_CAPS].sort());
    });

    test('the legacy "view" role still means check-in only', async () => {
        const event = await createEvent(owner.client);
        const collaborator = await newUser(server);
        await owner.client.post('/api/sheet/share', { eventId: event.id, email: collaborator.email, permission: 'view' });
        const seen = (await collaborator.client.get('/api/events')).body.find(e => e.id === event.id);
        assert.deepEqual(seen.capabilities, ['checkin']);
    });

    test('a share naming no real capability is refused', async () => {
        const event = await createEvent(owner.client);
        const collaborator = await newUser(server);
        assert.equal((await share(owner.client, event.id, collaborator.email, [])).status, 400);
        assert.equal((await share(owner.client, event.id, collaborator.email, ['make_coffee'])).status, 400);
    });

    test('sharing with an address that has no account says so', async () => {
        const event = await createEvent(owner.client);
        const r = await share(owner.client, event.id, 'nobody-here@test.local', ['checkin']);
        assert.equal(r.status, 404);
        assert.match(r.body.error, /does not have an account/i);
    });

    test('an owner cannot share with themselves', async () => {
        const event = await createEvent(owner.client);
        const r = await share(owner.client, event.id, owner.email, ['checkin']);
        assert.equal(r.status, 400);
    });

    test('re-sharing with the same person replaces their grant instead of adding a second', async () => {
        const { event, collaborator } = await sharedEvent(['checkin']);
        await share(owner.client, event.id, collaborator.email, ['manage_tickets', 'export_data']);

        const access = (await owner.client.get(`/api/event/${event.id}/access`)).body;
        const rows = access.access.filter(a => a.email === collaborator.email);
        assert.equal(rows.length, 1, 'expected exactly one grant row per person');

        // Replaced outright, not merged — the second grant is the whole
        // truth, so the earlier `checkin` is gone.
        const seen = (await collaborator.client.get('/api/events')).body.find(e => e.id === event.id);
        assert.deepEqual([...seen.capabilities].sort(), ['export_data', 'manage_tickets']);
    });

    test('a stranger cannot share someone else\'s event', async () => {
        const event = await createEvent(owner.client);
        const stranger = await newUser(server);
        const victim = await newUser(server);
        assert.equal((await share(stranger.client, event.id, victim.email, ['checkin'])).status, 403);
    });
});

describe('manage_access is owner-only to hand out', () => {
    test('a collaborator holding manage_access cannot mint another one', async () => {
        const event = await createEvent(owner.client);
        const deputy = await newUser(server);
        // Only the owner can grant manage_access in the first place.
        assert.equal((await share(owner.client, event.id, deputy.email, ['manage_access', 'checkin'])).status, 200);

        const outsider = await newUser(server);
        const escalate = await share(deputy.client, event.id, outsider.email, ['manage_access']);
        assert.equal(escalate.status, 403);
        assert.match(escalate.body.error, /only the event owner/i);
    });

    test('a collaborator holding manage_access can still share lesser capabilities', async () => {
        const event = await createEvent(owner.client);
        const deputy = await newUser(server);
        await share(owner.client, event.id, deputy.email, ['manage_access', 'checkin']);

        const outsider = await newUser(server);
        assert.equal((await share(deputy.client, event.id, outsider.email, ['checkin'])).status, 200);
    });

    test('nobody edits their own grant', async () => {
        const event = await createEvent(owner.client);
        const deputy = await newUser(server);
        await share(owner.client, event.id, deputy.email, ['manage_access', 'checkin']);

        const access = (await owner.client.get(`/api/event/${event.id}/access`)).body;
        const own = access.access.find(a => a.email === deputy.email);
        assert.ok(own, 'grant row not found');

        const selfPromote = await deputy.client.patch(`/api/sheet/access/${own.id}`, { capabilities: ALL_CAPS });
        assert.equal(selfPromote.status, 403);
    });
});

describe('editing and revoking a grant', () => {
    test('an owner can change a collaborator\'s capabilities in place', async () => {
        const { event, collaborator } = await sharedEvent(['checkin']);
        const access = (await owner.client.get(`/api/event/${event.id}/access`)).body;
        const row = access.access.find(a => a.email === collaborator.email);

        const r = await owner.client.patch(`/api/sheet/access/${row.id}`, { capabilities: ['checkin', 'undo_checkin', 'export_data'] });
        assert.equal(r.status, 200);

        const seen = (await collaborator.client.get('/api/events')).body.find(e => e.id === event.id);
        assert.deepEqual([...seen.capabilities].sort(), ['checkin', 'export_data', 'undo_checkin']);
    });

    test('revoking access removes the event from their list entirely', async () => {
        const { event, collaborator } = await sharedEvent(['checkin', 'manage_tickets']);
        const access = (await owner.client.get(`/api/event/${event.id}/access`)).body;
        const row = access.access.find(a => a.email === collaborator.email);

        assert.equal((await owner.client.del(`/api/sheet/access/${row.id}`)).status, 200);

        const list = await collaborator.client.get('/api/events');
        assert.ok(!list.body.some(e => e.id === event.id), 'revoked event still listed');
        assert.equal((await collaborator.client.get(`/api/event/${event.id}/tickets`)).status, 401);
    });

    test('the access list names the owner as well as the collaborators', async () => {
        const { event, collaborator } = await sharedEvent(['checkin']);
        const rows = (await owner.client.get(`/api/event/${event.id}/access`)).body.access;

        const ownerRow = rows.find(a => a.isOwner);
        assert.ok(ownerRow, 'owner is not shown on the access list');
        assert.equal(ownerRow.email, owner.email);
        assert.equal(ownerRow.role, 'owner');
        assert.equal(ownerRow.id, null, 'the owner row has no grant to edit or revoke');

        const mate = rows.find(a => a.email === collaborator.email);
        assert.ok(mate);
        assert.equal(mate.isOwner, false);
        assert.equal(mate.grantedByEmail, owner.email, 'should record who granted the access');
    });

    test('the access list is closed to someone without manage_access', async () => {
        const { event, collaborator } = await sharedEvent(['checkin', 'manage_tickets']);
        assert.equal((await collaborator.client.get(`/api/event/${event.id}/access`)).status, 403);
    });
});

describe('each capability actually gates its routes', () => {
    test('checkin: check someone in', async () => {
        const { event, collaborator } = await sharedEvent(['checkin']);
        await addTicket(owner.client, event.id, { name: 'Door Guest' });
        const [ticket] = await listTickets(owner.client, event.id);

        assert.equal((await collaborator.client.post(`/api/checkin/${ticket.registrationId}`, {})).status, 200);

        const outsider = await newUser(server);
        assert.equal((await outsider.client.post(`/api/checkin/${ticket.registrationId}`, {})).status, 403);
    });

    test('undo_checkin: reverse a check-in', async () => {
        const { event, collaborator } = await sharedEvent(['checkin']);
        await addTicket(owner.client, event.id, { name: 'Undo Guest' });
        const [ticket] = await listTickets(owner.client, event.id);
        await owner.client.post(`/api/checkin/${ticket.registrationId}`, {});

        // Holds checkin but not undo_checkin.
        assert.equal((await collaborator.client.del(`/api/checkin/${ticket.registrationId}`)).status, 403);

        const { event: ev2, collaborator: undoer } = await sharedEvent(['undo_checkin']);
        await addTicket(owner.client, ev2.id, { name: 'Undo Me' });
        const [t2] = await listTickets(owner.client, ev2.id);
        await owner.client.post(`/api/checkin/${t2.registrationId}`, {});
        assert.equal((await undoer.client.del(`/api/checkin/${t2.registrationId}`)).status, 200);
    });

    test('manage_tickets: add an attendee', async () => {
        const { event, collaborator } = await sharedEvent(['manage_tickets']);
        assert.equal((await collaborator.client.post(`/api/event/${event.id}/ticket`, { name: 'Added By Deputy', email: 'deputy-add@test.local', noEmail: true })).status, 200);

        const { event: ev2, collaborator: weak } = await sharedEvent(allBut('manage_tickets'));
        assert.equal((await weak.client.post(`/api/event/${ev2.id}/ticket`, { name: 'Nope', email: 'nope@test.local', noEmail: true })).status, 403);
    });

    test('manage_event: change event settings', async () => {
        const { event, collaborator } = await sharedEvent(['manage_event']);
        assert.equal((await collaborator.client.put(`/api/event/${event.id}/public-registration`, { enabled: true })).status, 200);

        const { event: ev2, collaborator: weak } = await sharedEvent(allBut('manage_event'));
        assert.equal((await weak.client.put(`/api/event/${ev2.id}/public-registration`, { enabled: true })).status, 403);
    });

    test('email_attendees: send a bulk email', async () => {
        const { event, collaborator } = await sharedEvent(['email_attendees']);
        await addTicket(owner.client, event.id, { name: 'Mail Me' });
        const sent = await collaborator.client.post(`/api/event/${event.id}/bulk-email`, { subject: 'Hello', message: 'Doors at 7.' });
        assert.equal(sent.status, 200);

        const { event: ev2, collaborator: weak } = await sharedEvent(allBut('email_attendees'));
        assert.equal((await weak.client.post(`/api/event/${ev2.id}/bulk-email`, { subject: 'Hi', message: 'x' })).status, 403);
    });

    test('manage_waitlist: promote someone waiting', async () => {
        const { event, collaborator } = await sharedEvent(['manage_waitlist'], { waitlist: true });
        const anon = createClient(server.base);
        const joined = await anon.post(`/api/event/${event.id}/waitlist`, { name: 'Hopeful One', email: 'hopeful@test.local' });
        assert.equal(joined.status, 200);
        const entry = (await owner.client.get(`/api/event/${event.id}/waitlist`)).body[0];

        const { event: ev2, collaborator: weak } = await sharedEvent(allBut('manage_waitlist'), { waitlist: true });
        const anon2 = createClient(server.base);
        await anon2.post(`/api/event/${ev2.id}/waitlist`, { name: 'Hopeful Two', email: 'hopeful2@test.local' });
        const entry2 = (await owner.client.get(`/api/event/${ev2.id}/waitlist`)).body[0];
        assert.equal((await weak.client.post(`/api/waitlist/${entry2.id}/promote`, {})).status, 403);

        assert.equal((await collaborator.client.post(`/api/waitlist/${entry.id}/promote`, {})).status, 200);
    });

    test('manage_discounts: create a code', async () => {
        const { event, collaborator } = await sharedEvent(['manage_discounts']);
        assert.equal((await collaborator.client.post(`/api/event/${event.id}/discount-codes`, { code: 'DEPUTY10', type: 'percent', value: 10 })).status, 200);

        const { event: ev2, collaborator: weak } = await sharedEvent(allBut('manage_discounts'));
        assert.equal((await weak.client.post(`/api/event/${ev2.id}/discount-codes`, { code: 'NOPE', type: 'percent', value: 10 })).status, 403);
    });

    test('manage_payments: view orders', async () => {
        const { event, collaborator } = await sharedEvent(['manage_payments']);
        assert.equal((await collaborator.client.get(`/api/event/${event.id}/orders`)).status, 200);

        const { event: ev2, collaborator: weak } = await sharedEvent(allBut('manage_payments'));
        assert.equal((await weak.client.get(`/api/event/${ev2.id}/orders`)).status, 403);
    });

    test('export_data: download the CSV', async () => {
        const { event, collaborator } = await sharedEvent(['export_data']);
        await addTicket(owner.client, event.id, { name: 'Exported Person' });
        const [ticket] = await listTickets(owner.client, event.id);

        const csv = await collaborator.client.get(`/api/tickets/export-csv?regIds=${ticket.registrationId}`);
        assert.equal(csv.status, 200);
        assert.match(csv.text, /Exported Person/);

        const { event: ev2, collaborator: weak } = await sharedEvent(allBut('export_data'));
        await addTicket(owner.client, ev2.id, { name: 'Secret Person' });
        const [t2] = await listTickets(owner.client, ev2.id);
        const denied = await weak.client.get(`/api/tickets/export-csv?regIds=${t2.registrationId}`);
        assert.equal(denied.status, 404, 'rows without export_data are skipped, leaving nothing to return');
        assert.ok(!/Secret Person/.test(denied.text || ''), 'export leaked rows to someone without export_data');
    });

    test('delete_event: delete it', async () => {
        const { event: ev2, collaborator: weak } = await sharedEvent(allBut('delete_event'));
        assert.equal((await weak.client.del(`/api/event/${ev2.id}`)).status, 404);
        assert.equal((await owner.client.get(`/api/event/${ev2.id}`)).status, 200);

        const { event, collaborator } = await sharedEvent(['delete_event', 'checkin']);
        assert.equal((await collaborator.client.del(`/api/event/${event.id}`)).status, 200);
    });
});

describe('transferring ownership', () => {
    test('moves the event and leaves the outgoing owner able to work', async () => {
        const { event, collaborator } = await sharedEvent(['checkin']);

        const r = await owner.client.post(`/api/event/${event.id}/transfer-ownership`, { email: collaborator.email });
        assert.equal(r.status, 200, r.text);

        const theirs = (await collaborator.client.get('/api/events')).body.find(e => e.id === event.id);
        assert.equal(theirs.isOwner, true, 'new owner should own it');
        assert.deepEqual([...theirs.capabilities].sort(), [...ALL_CAPS].sort());

        // The outgoing owner keeps a full grant rather than being locked out
        // of the event they just handed over.
        const mine = (await owner.client.get('/api/events')).body.find(e => e.id === event.id);
        assert.ok(mine, 'previous owner lost the event entirely');
        assert.equal(mine.isOwner, false);
        assert.ok(mine.capabilities.includes('manage_tickets'));
    });

    test('only the owner can transfer', async () => {
        const { event, collaborator } = await sharedEvent(['manage_event', 'manage_access']);
        const outsider = await newUser(server);
        assert.equal((await collaborator.client.post(`/api/event/${event.id}/transfer-ownership`, { email: outsider.email })).status, 403);
    });

    test('the new owner must have an account', async () => {
        const event = await createEvent(owner.client);
        const r = await owner.client.post(`/api/event/${event.id}/transfer-ownership`, { email: 'ghost@test.local' });
        assert.equal(r.status, 404);
    });
});

describe('the admin', () => {
    test('has authority over an event they do not own', async () => {
        const event = await createEvent(owner.client, { name: 'Someone Else\'s' });
        await addTicket(owner.client, event.id, { name: 'Their Guest' });

        const tickets = await listTickets(admin.client, event.id);
        assert.equal(tickets.length, 1);
        assert.equal((await admin.client.put(`/api/event/${event.id}/public-registration`, { enabled: true })).status, 200);
    });

    test('does not have other people\'s rooms listed as their own', async () => {
        const event = await createEvent(owner.client, { name: 'Not The Admin\'s Room' });
        const mine = (await admin.client.get('/api/events')).body;
        assert.ok(!mine.some(e => e.id === event.id), 'another user\'s event showed up in the admin\'s own list');

        const counts = (await admin.client.get('/api/events/counts')).body;
        assert.ok(!(event.id in counts), 'another user\'s event showed up in the admin\'s counts');
    });

    test('reaches every room through the admin overview instead', async () => {
        const event = await createEvent(owner.client, { name: 'Findable By Admin' });
        const all = await admin.client.get('/api/admin/all-rooms');
        assert.equal(all.status, 200);

        const room = all.body.rooms.find(r => r.event.id === event.id);
        assert.ok(room, 'admin overview missing an event');
        assert.equal(room.owner.email, owner.email);
        assert.equal(room.isMine, false);

        assert.ok(all.body.users.some(u => u.email === owner.email));
        assert.ok(all.body.users.some(u => u.email === ADMIN_EMAIL));
    });

    test('the admin overview is closed to everyone else', async () => {
        assert.equal((await owner.client.get('/api/admin/all-rooms')).status, 403);
        const anon = createClient(server.base);
        assert.equal((await anon.get('/api/admin/all-rooms')).status, 401);
    });

    test('can open a room they do not own through the context route', async () => {
        const event = await createEvent(owner.client, { name: 'Opened By Admin' });
        const ctx = await admin.client.get(`/api/event/${event.id}/context`);
        assert.equal(ctx.status, 200);
        assert.equal(ctx.body.owner.email, owner.email);
        assert.ok(ctx.body.capabilities.includes('manage_event'));
    });

    test('the context route refuses someone with no access to that event', async () => {
        const event = await createEvent(owner.client);
        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/event/${event.id}/context`)).status, 403);
    });
});
