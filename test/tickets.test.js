// Managing the attendee list: adding, editing and deleting registrations,
// bulk check-in and undo, the CSV export, and the QR/wallet artefacts an
// attendee actually receives.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, addTicket, listTickets, share, uniqueEmail } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const anon = () => createClient(server.base);

describe('adding attendees by hand', () => {
    test('needs a name and an email', async () => {
        const ev = await createEvent(owner.client, { name: 'Manual Validation' });
        assert.equal((await owner.client.post(`/api/event/${ev.id}/ticket`, { name: 'No Email' })).status, 400);
        assert.equal((await owner.client.post(`/api/event/${ev.id}/ticket`, { email: 'a@test.local' })).status, 400);
    });

    test('issues a group of tickets under one registration', async () => {
        const ev = await createEvent(owner.client, { name: 'Manual Group' });
        const r = await addTicket(owner.client, ev.id, { name: 'Ada Lovelace', ticketCount: 3 });
        assert.equal(r.tickets.length, 3);

        const tickets = await listTickets(owner.client, ev.id);
        assert.equal(tickets.length, 3);
        assert.equal(new Set(tickets.map(t => t.registrationId)).size, 1);
        assert.equal(new Set(tickets.map(t => t.token)).size, 3, 'each ticket needs its own QR token');
        assert.equal(tickets[0].firstName, 'Ada');
        assert.equal(tickets[0].lastName, 'Lovelace');
    });

    test('keeps the custom fields the organiser collects', async () => {
        const ev = await createEvent(owner.client, { name: 'Custom Manual' });
        await owner.client.patch(`/api/event/${ev.id}`, { customFields: ['Meal'] });
        await owner.client.post(`/api/event/${ev.id}/ticket`, {
            name: 'Fussy Eater', email: uniqueEmail('fussy'), noEmail: true, customFields: { Meal: 'Vegan' },
        });

        const [ticket] = await listTickets(owner.client, ev.id);
        assert.equal(ticket.customFields.Meal, 'Vegan');
    });

    test('404s an event that does not exist', async () => {
        const r = await owner.client.post('/api/event/nope/ticket', { name: 'A', email: 'a@test.local' });
        assert.equal(r.status, 404);
    });
});

describe('editing an attendee', () => {
    test('renames the whole group, not just the one ticket', async () => {
        const ev = await createEvent(owner.client, { name: 'Edit Group' });
        await addTicket(owner.client, ev.id, { name: 'Old Name', ticketCount: 2 });
        const [first] = await listTickets(owner.client, ev.id);

        const r = await owner.client.put(`/api/ticket/${first.id}`, {
            name: 'New Name', email: 'renamed@test.local', noEmail: true,
        });
        assert.equal(r.status, 200);

        const after2 = await listTickets(owner.client, ev.id);
        assert.ok(after2.every(t => t.name === 'New Name'), 'the whole registration should be renamed together');
        assert.ok(after2.every(t => t.email === 'renamed@test.local'));
        assert.equal(after2[0].firstName, 'New');
        assert.equal(after2[0].lastName, 'Name');
    });

    test('needs manage_tickets', async () => {
        const ev = await createEvent(owner.client, { name: 'Edit Guard' });
        await addTicket(owner.client, ev.id, { name: 'Protected Person' });
        const [ticket] = await listTickets(owner.client, ev.id);

        const doorStaff = await newUser(server);
        await share(owner.client, ev.id, doorStaff.email, ['checkin']);
        assert.equal((await doorStaff.client.put(`/api/ticket/${ticket.id}`, { name: 'X', email: 'x@test.local' })).status, 403);
    });
});

describe('bulk check-in', () => {
    test('checks several registrations in at once and undoes them', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Door' });
        await addTicket(owner.client, ev.id, { name: 'Group One', ticketCount: 2 });
        await addTicket(owner.client, ev.id, { name: 'Group Two' });
        const regIds = [...new Set((await listTickets(owner.client, ev.id)).map(t => t.registrationId))];

        const inn = await owner.client.post('/api/checkin/bulk', { registrationIds: regIds });
        assert.equal(inn.status, 200);
        assert.equal(inn.body.checkedIn, 3);
        assert.ok((await listTickets(owner.client, ev.id)).every(t => t.used_at));

        const out = await owner.client.del('/api/checkin/bulk', { registrationIds: regIds });
        assert.equal(out.status, 200);
        assert.ok((await listTickets(owner.client, ev.id)).every(t => !t.used_at));
    });

    test('needs a list', async () => {
        assert.equal((await owner.client.post('/api/checkin/bulk', {})).status, 400);
        assert.equal((await owner.client.post('/api/checkin/bulk', { registrationIds: [] })).status, 400);
    });

    test('silently skips registrations the caller has no rights to', async () => {
        const mine = await createEvent(owner.client, { name: 'Bulk Mine' });
        await addTicket(owner.client, mine.id, { name: 'Mine' });

        const stranger = await newUser(server);
        const theirs = await createEvent(stranger.client, { name: 'Bulk Theirs' });
        await addTicket(stranger.client, theirs.id, { name: 'Theirs' });

        const [mineTicket] = await listTickets(owner.client, mine.id);
        const [theirTicket] = await listTickets(stranger.client, theirs.id);

        const r = await owner.client.post('/api/checkin/bulk', {
            registrationIds: [mineTicket.registrationId, theirTicket.registrationId],
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.checkedIn, 1, 'only the caller\'s own registration should be checked in');
        assert.equal((await listTickets(stranger.client, theirs.id))[0].used_at, null);
    });

    test('undo needs undo_checkin, not just checkin', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Undo Guard' });
        await addTicket(owner.client, ev.id, { name: 'Checked In' });
        const [ticket] = await listTickets(owner.client, ev.id);
        await owner.client.post(`/api/checkin/${ticket.registrationId}`, {});

        const doorStaff = await newUser(server);
        await share(owner.client, ev.id, doorStaff.email, ['checkin']);

        const r = await doorStaff.client.del('/api/checkin/bulk', { registrationIds: [ticket.registrationId] });
        assert.ok((await listTickets(owner.client, ev.id))[0].used_at,
            `someone with check-in but not undo reversed a check-in (${r.status})`);
    });
});

describe('deleting registrations', () => {
    test('removes every ticket in the group', async () => {
        const ev = await createEvent(owner.client, { name: 'Delete Group' });
        await addTicket(owner.client, ev.id, { name: 'Going Away', ticketCount: 2 });
        const [ticket] = await listTickets(owner.client, ev.id);

        const r = await owner.client.del('/api/registrations/bulk', { registrationIds: [ticket.registrationId] });
        assert.equal(r.status, 200);
        assert.equal(r.body.deleted, 2);
        assert.equal((await listTickets(owner.client, ev.id)).length, 0);
    });

    test('will not touch another owner\'s registrations', async () => {
        const stranger = await newUser(server);
        const theirs = await createEvent(stranger.client, { name: 'Not To Delete' });
        await addTicket(stranger.client, theirs.id, { name: 'Safe Person' });
        const [ticket] = await listTickets(stranger.client, theirs.id);

        const r = await owner.client.del('/api/registrations/bulk', { registrationIds: [ticket.registrationId] });
        assert.equal(r.body.deleted, 0);
        assert.equal((await listTickets(stranger.client, theirs.id)).length, 1);
    });
});

describe('the CSV export', () => {
    test('includes the attendee, their email and their check-in state', async () => {
        const ev = await createEvent(owner.client, { name: 'Export Event' });
        const email = uniqueEmail('exported');
        await addTicket(owner.client, ev.id, { name: 'Exported Person', email });
        const [ticket] = await listTickets(owner.client, ev.id);
        await owner.client.post(`/api/checkin/${ticket.registrationId}`, {});

        const r = await owner.client.get(`/api/tickets/export-csv?regIds=${ticket.registrationId}`);
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type') || '', /csv/);
        assert.match(r.text, /Exported Person/);
        assert.match(r.text, new RegExp(email.replace(/[.+]/g, '\\$&')));
    });

    test('404s when the caller can export none of the rows asked for', async () => {
        const r = await owner.client.get('/api/tickets/export-csv?regIds=no-such-registration');
        assert.equal(r.status, 404);
    });

    test('400s with no ids at all', async () => {
        assert.equal((await owner.client.get('/api/tickets/export-csv')).status, 400);
    });
});

describe('what the attendee receives', () => {
    test('the QR image opens without a login', async () => {
        const ev = await createEvent(owner.client, { name: 'QR Event' });
        await addTicket(owner.client, ev.id, { name: 'Has A QR' });
        const [ticket] = await listTickets(owner.client, ev.id);

        const r = await anon().get(`/qr/${ticket.token}`, { raw: true });
        assert.equal(r.status, 200, 'the ticket link in the email must open without a login');
        assert.equal(r.headers.get('content-type'), 'image/png');

        // This route is a pure QR renderer — it encodes whatever token it is
        // given without looking it up, so an unknown token still draws an
        // image. Nothing is revealed either way; /api/validate is what
        // decides whether a code means anything.
        assert.equal((await anon().get('/qr/not-a-real-token', { raw: true })).status, 200);
    });

    test('the email open pixel is served and does not need a session', async () => {
        const ev = await createEvent(owner.client, { name: 'Tracked Event' });
        await addTicket(owner.client, ev.id, { name: 'Tracked Person' });
        const [ticket] = await listTickets(owner.client, ev.id);

        const r = await anon().get(`/api/track/open/${ticket.registrationId}`, { raw: true });
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type') || '', /image/);
    });

    test('a ticket preview is owner-only', async () => {
        const ev = await createEvent(owner.client, { name: 'Preview Event' });
        await addTicket(owner.client, ev.id, { name: 'Previewed Person' });
        const [ticket] = await listTickets(owner.client, ev.id);

        assert.equal((await anon().get(`/api/ticket/${ticket.id}/preview`)).status, 401);
        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/ticket/${ticket.id}/preview`)).status, 403);
    });
});
