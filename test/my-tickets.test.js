// My Tickets: an attendee signing in with an emailed one-time link to see,
// re-send and print every ticket issued to their address, across events.
//
// The sign-in grants exactly that and nothing more, so what these tests pin
// down is the boundary: which tickets come back (only this address's, from
// every event), that the link is single-use, that nobody learns whether an
// address holds tickets by asking, and that the attendee session never
// reaches anything an organiser's would.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { newUser, createEvent, addTicket, uniqueEmail } from './helpers/factories.js';
import { createClient } from './helpers/client.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const anon = () => createClient(server.base);

/** Asks for a link for `email` and returns the raw token from the captured email. */
async function requestToken(email) {
    const r = await anon().post('/api/my-tickets/request-link', { email });
    assert.equal(r.status, 200, r.text);
    const mail = await server.waitForEmail(m => m.to === email.toLowerCase() && /sign-in link/i.test(m.subject));
    const m = mail.html.match(/my-tickets\.html\?token=([0-9a-f]+)/);
    assert.ok(m, 'the email must carry a sign-in link');
    return m[1];
}

/** A browser signed in to My Tickets as `email`. */
async function signedIn(email) {
    const token = await requestToken(email);
    const client = anon();
    const v = await client.post('/api/my-tickets/verify', { token });
    assert.equal(v.status, 200, v.text);
    return client;
}

function ticketsOf(made) {
    return Array.isArray(made) ? made : (made.tickets || []);
}

describe('requesting a link', () => {
    test('says the same thing whether or not the address has tickets, and only mails when it does', async () => {
        server.clearEmails();
        const nobody = uniqueEmail('nobody');
        const r = await anon().post('/api/my-tickets/request-link', { email: nobody });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { success: true });
        await new Promise(res => setTimeout(res, 200));
        assert.equal(server.emails().filter(m => m.to === nobody).length, 0, 'no mail for an address with no tickets');
    });

    test('rejects something that is not an email address', async () => {
        const r = await anon().post('/api/my-tickets/request-link', { email: 'not an email' });
        assert.equal(r.status, 400);
    });

    test('a second request within a minute does not send a second email', async () => {
        const ev = await createEvent(owner.client, { name: 'Spam Guard' });
        const email = uniqueEmail('spam');
        await addTicket(owner.client, ev.id, { email });
        server.clearEmails();
        await requestToken(email);
        const again = await anon().post('/api/my-tickets/request-link', { email });
        assert.equal(again.status, 200);
        await new Promise(res => setTimeout(res, 200));
        assert.equal(server.emails().filter(m => m.to === email).length, 1);
    });
});

describe('signing in', () => {
    test('a link works once', async () => {
        const ev = await createEvent(owner.client, { name: 'Single Use' });
        const email = uniqueEmail('once');
        await addTicket(owner.client, ev.id, { email });
        const token = await requestToken(email);

        assert.equal((await anon().post('/api/my-tickets/verify', { token })).status, 200);
        assert.equal((await anon().post('/api/my-tickets/verify', { token })).status, 400, 'a used link must not sign anyone else in');
        assert.equal((await anon().post('/api/my-tickets/verify', { token: 'f'.repeat(64) })).status, 400);
        assert.equal((await anon().post('/api/my-tickets/verify', {})).status, 400);
    });

    test('without signing in, nothing is listed or sent', async () => {
        assert.equal((await anon().get('/api/my-tickets')).status, 401);
        assert.equal((await anon().post('/api/my-tickets/anything/resend')).status, 401);
    });

    test('the attendee session is not an organiser session', async () => {
        const ev = await createEvent(owner.client, { name: 'Not An Organiser' });
        const email = uniqueEmail('notorg');
        await addTicket(owner.client, ev.id, { email });
        const client = await signedIn(email);
        assert.equal((await client.get('/api/events')).status, 401);
        assert.equal((await client.get(`/api/event/${ev.id}/tickets`)).status, 401);
        assert.equal((await client.get('/api/auth/me')).status, 401);
    });

    test('signing out ends access', async () => {
        const ev = await createEvent(owner.client, { name: 'Sign Out' });
        const email = uniqueEmail('signout');
        await addTicket(owner.client, ev.id, { email });
        const client = await signedIn(email);
        assert.equal((await client.get('/api/my-tickets')).status, 200);
        await client.post('/api/my-tickets/logout');
        assert.equal((await client.get('/api/my-tickets')).status, 401);
    });
});

describe('the ticket list', () => {
    test('shows every event for the address, case-insensitively, and nobody else\'s tickets', async () => {
        const evA = await createEvent(owner.client, { name: 'Event A' });
        const evB = await createEvent(owner.client, { name: 'Event B' });
        const email = uniqueEmail('multi');
        const other = uniqueEmail('other');
        await addTicket(owner.client, evA.id, { name: 'Pat One', email });
        await addTicket(owner.client, evB.id, { name: 'Pat Two', email: email.toUpperCase(), ticketCount: 2 });
        await addTicket(owner.client, evA.id, { name: 'Someone Else', email: other });

        const client = await signedIn(email);
        const r = await client.get('/api/my-tickets');
        assert.equal(r.status, 200);
        assert.equal(r.body.email, email);
        const names = r.body.registrations.map(x => x.event.name).sort();
        assert.deepEqual(names, ['Event A', 'Event B']);
        const all = r.body.registrations.flatMap(x => x.tickets);
        assert.equal(all.length, 3);
        assert.ok(all.every(t => t.token), 'live tickets carry their QR token');
        assert.ok(!all.some(t => t.name === 'Someone Else'));
    });

    test('a returned ticket is listed without its token, and cannot be re-sent', async () => {
        const ev = await createEvent(owner.client, { name: 'Expired One' });
        const email = uniqueEmail('expired');
        const [ticket] = ticketsOf(await addTicket(owner.client, ev.id, { email }));
        const ex = await owner.client.post(`/api/ticket/${ticket.id}/expire`, {});
        assert.equal(ex.status, 200, ex.text);

        const client = await signedIn(email);
        const reg = (await client.get('/api/my-tickets')).body.registrations.find(x => x.event.id === ev.id);
        assert.equal(reg.tickets[0].expired, true);
        assert.equal(reg.tickets[0].token, null);
        assert.equal((await client.post(`/api/my-tickets/${reg.registrationId}/resend`)).status, 409);
    });
});

describe('re-sending', () => {
    test('emails the tickets to the signed-in address only', async () => {
        const ev = await createEvent(owner.client, { name: 'Resend Me' });
        const email = uniqueEmail('resend');
        const [mine] = ticketsOf(await addTicket(owner.client, ev.id, { email }));
        const [theirs] = ticketsOf(await addTicket(owner.client, ev.id, { email: uniqueEmail('theirs') }));

        const client = await signedIn(email);
        server.clearEmails();
        const r = await client.post(`/api/my-tickets/${mine.registrationId}/resend`);
        assert.equal(r.status, 200, r.text);
        const mail = await server.waitForEmail(m => m.to === email && /Resend Me/.test(m.subject));
        assert.match(mail.html, new RegExp(mine.token));
        assert.match(mail.html, /my-tickets\.html/, 'ticket emails link back to My Tickets');

        assert.equal((await client.post(`/api/my-tickets/${theirs.registrationId}/resend`)).status, 404,
            'someone else\'s registration must be invisible');
    });
});
