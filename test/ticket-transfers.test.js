// Ticket transfers: an attendee handing their ticket to someone else, from the
// manage link in their confirmation email or from My Tickets.
//
// A transfer keeps the ticket row (and so its seat) but makes it the new
// holder's: new QR token, new registration id, their name and email, and the
// old holder's answers wiped. What these tests pin down is that it is off
// unless the organiser turns it on, that the old QR stops working the moment
// it happens, that both people are told, and the cases it must refuse.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { newUser, createEvent, addTicket, listTickets, uniqueEmail } from './helpers/factories.js';
import { createClient } from './helpers/client.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const anon = () => createClient(server.base);
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString();

async function enableTransfers(eventId, enabled = true) {
    const r = await owner.client.put(`/api/event/${eventId}/ticket-transfers`, { enabled });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ticketTransfersEnabled, enabled);
}

async function booking(eventId, opts = {}) {
    const made = await addTicket(owner.client, eventId, opts);
    const tickets = Array.isArray(made) ? made : (made.tickets || []);
    assert.ok(tickets.length);
    return { registrationId: tickets[0].registrationId, tickets };
}

describe('the transfer setting', () => {
    test('is off by default, and a transfer is refused until it is on', async () => {
        const ev = await createEvent(owner.client, { name: 'Transfers Off' });
        assert.equal(ev.ticketTransfersEnabled, false);
        const { registrationId } = await booking(ev.id);

        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.body.transfers.open, false);
        assert.equal(view.body.tickets[0].transferable, false);

        const r = await anon().post(`/api/registration/${registrationId}/transfer`, { name: 'Sam New', email: uniqueEmail('new') });
        assert.equal(r.status, 403);
    });

    test('only someone who can manage the event can turn it on', async () => {
        const ev = await createEvent(owner.client, { name: 'Transfers Guarded' });
        const stranger = await newUser(server);
        const r = await stranger.client.put(`/api/event/${ev.id}/ticket-transfers`, { enabled: true });
        assert.ok(r.status === 403 || r.status === 404, `got ${r.status}`);
        assert.equal((await anon().put(`/api/event/${ev.id}/ticket-transfers`, { enabled: true })).status, 401);
    });
});

describe('transferring a ticket', () => {
    test('moves the ticket to the new holder, kills the old QR, and emails both people', async () => {
        const ev = await createEvent(owner.client, { name: 'Hand It On' });
        await enableTransfers(ev.id);
        const oldEmail = uniqueEmail('old');
        const newEmail = uniqueEmail('new');
        const { registrationId, tickets: [orig] } = await booking(ev.id, { name: 'Pat Old', email: oldEmail });

        server.clearEmails();
        const r = await anon().post(`/api/registration/${registrationId}/transfer`, { name: 'Sam New', email: newEmail });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.success, true);

        const [now] = (await listTickets(owner.client, ev.id)).filter(t => t.id === orig.id);
        assert.equal(now.email, newEmail);
        assert.equal(now.name, 'Sam New');
        assert.notEqual(now.token, orig.token, 'the ticket gets a new QR code');
        assert.notEqual(now.registrationId, registrationId, 'and a new manage link');
        assert.ok(now.transferredAt);

        const oldScan = await owner.client.post('/api/validate', { token: orig.token, eventId: ev.id });
        assert.notEqual(oldScan.body.status, 'valid', `the old QR must not scan in: ${oldScan.text}`);
        assert.notEqual(oldScan.body.valid, true);
        const newScan = await owner.client.post('/api/validate', { token: now.token, eventId: ev.id });
        assert.ok(newScan.body.valid || newScan.body.status === 'valid', newScan.text);

        const toNew = await server.waitForEmail(m => m.to === newEmail);
        assert.match(toNew.html, new RegExp(now.token), 'the new holder gets the new QR');
        assert.match(toNew.html, /Pat Old/);
        const toOld = await server.waitForEmail(m => m.to === oldEmail);
        assert.match(toOld.html, /transferred/i);
        assert.doesNotMatch(toOld.html, new RegExp(now.token), 'the old holder never sees the new QR');

        // The old manage link no longer points at anything.
        const stale = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(stale.status, 404);
    });

    test('a group booking can hand on one ticket and keep the rest', async () => {
        const ev = await createEvent(owner.client, { name: 'Hand On One' });
        await enableTransfers(ev.id);
        const { registrationId, tickets } = await booking(ev.id, { ticketCount: 2 });

        const noPick = await anon().post(`/api/registration/${registrationId}/transfer`, { name: 'A B', email: uniqueEmail('x') });
        assert.equal(noPick.status, 400, 'with two tickets it must be told which one');

        const r = await anon().post(`/api/registration/${registrationId}/transfer`, { ticketId: tickets[1].id, name: 'A B', email: uniqueEmail('x') });
        assert.equal(r.status, 200, r.text);
        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.body.tickets.length, 1);
        assert.equal(view.body.tickets[0].id, tickets[0].id);
    });

    test('rejects a missing name, a bad email, or the same person', async () => {
        const ev = await createEvent(owner.client, { name: 'Bad Input' });
        await enableTransfers(ev.id);
        const email = uniqueEmail('same');
        const { registrationId } = await booking(ev.id, { email });
        const post = body => anon().post(`/api/registration/${registrationId}/transfer`, body);
        assert.equal((await post({ name: '', email: uniqueEmail('x') })).status, 400);
        assert.equal((await post({ name: 'X Y', email: 'nope' })).status, 400);
        assert.equal((await post({ name: 'X Y', email: email.toUpperCase() })).status, 400);
    });
});

describe('what cannot be transferred', () => {
    test('a ticket already used at the door', async () => {
        const ev = await createEvent(owner.client, { name: 'Used Already' });
        await enableTransfers(ev.id);
        const { registrationId, tickets: [t] } = await booking(ev.id);
        await owner.client.post('/api/validate', { token: t.token, eventId: ev.id });
        const r = await anon().post(`/api/registration/${registrationId}/transfer`, { name: 'X Y', email: uniqueEmail('x') });
        assert.equal(r.status, 409);
    });

    test('a ticket for an event that is over', async () => {
        const ev = await createEvent(owner.client, { name: 'Over', time: hoursAgo(72) });
        await enableTransfers(ev.id);
        const { registrationId } = await booking(ev.id);
        const r = await anon().post(`/api/registration/${registrationId}/transfer`, { name: 'X Y', email: uniqueEmail('x') });
        assert.equal(r.status, 409);
    });

    test('a ticket for a paid event', async () => {
        const ev = await createEvent(owner.client, { name: 'Paid', ticketPrice: 1500 });
        await enableTransfers(ev.id);
        const { registrationId } = await booking(ev.id);
        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.body.transfers.reason, 'paid');
        const r = await anon().post(`/api/registration/${registrationId}/transfer`, { name: 'X Y', email: uniqueEmail('x') });
        assert.equal(r.status, 403);
    });

    test('to someone who already holds a ticket, when one ticket per email is on', async () => {
        const ev = await createEvent(owner.client, { name: 'One Each', limits: { blockDuplicateEmails: true } });
        await enableTransfers(ev.id);
        const holder = uniqueEmail('holder');
        await booking(ev.id, { email: holder });
        const { registrationId } = await booking(ev.id);
        const r = await anon().post(`/api/registration/${registrationId}/transfer`, { name: 'X Y', email: holder });
        assert.equal(r.status, 409);
    });
});

describe('My Tickets', () => {
    async function signedIn(email) {
        await anon().post('/api/my-tickets/request-link', { email });
        const mail = await server.waitForEmail(m => m.to === email && /sign-in link/i.test(m.subject));
        const token = mail.html.match(/my-tickets\.html\?token=([0-9a-f]+)/)[1];
        const client = anon();
        assert.equal((await client.post('/api/my-tickets/verify', { token })).status, 200);
        return client;
    }

    test('reports whether returns and transfers are open right now', async () => {
        const ev = await createEvent(owner.client, { name: 'Flags' });
        const email = uniqueEmail('flags');
        await booking(ev.id, { email });
        const client = await signedIn(email);

        let reg = (await client.get('/api/my-tickets')).body.registrations.find(x => x.event.id === ev.id);
        assert.equal(reg.returnsOpen, false);
        assert.equal(reg.transfersOpen, false);

        await enableTransfers(ev.id);
        const ret = await owner.client.put(`/api/event/${ev.id}/ticket-returns`, { enabled: true, refund: 'none', cutoffValue: 0, cutoffUnit: 'hours' });
        assert.equal(ret.status, 200, ret.text);
        reg = (await client.get('/api/my-tickets')).body.registrations.find(x => x.event.id === ev.id);
        assert.equal(reg.returnsOpen, true);
        assert.equal(reg.transfersOpen, true);

        // A cutoff that has already passed closes returns, and My Tickets stops offering them.
        const closed = await owner.client.put(`/api/event/${ev.id}/ticket-returns`, { enabled: true, refund: 'none', cutoffValue: 4, cutoffUnit: 'weeks' });
        assert.equal(closed.status, 200, closed.text);
        reg = (await client.get('/api/my-tickets')).body.registrations.find(x => x.event.id === ev.id);
        assert.equal(reg.returnsEnabled, true);
        assert.equal(reg.returnsOpen, false);
    });
});
