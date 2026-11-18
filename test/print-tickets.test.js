// Printable tickets: the dashboard's Print / Print Selected and the
// attendee's My Tickets print all render the same page, and everything on a
// printed ticket comes from the event's ticket email template.
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
const ticketsOf = made => (Array.isArray(made) ? made : (made.tickets || []));
const cardCount = html => (html.match(/<article class="tkt"/g) || []).length;

async function signedIn(email) {
    const r = await anon().post('/api/my-tickets/request-link', { email });
    assert.equal(r.status, 200, r.text);
    const mail = await server.waitForEmail(m => m.to === email.toLowerCase() && /sign-in link/i.test(m.subject));
    const token = mail.html.match(/my-tickets\.html\?token=([0-9a-f]+)/)[1];
    const client = anon();
    assert.equal((await client.post('/api/my-tickets/verify', { token })).status, 200);
    return client;
}

describe('the dashboard print pages', () => {
    test('one registration prints one ticket card per ticket, with QR, code and the default small print', async () => {
        const ev = await createEvent(owner.client, { name: 'Print Night' });
        const made = ticketsOf(await addTicket(owner.client, ev.id, { name: 'Pat Printer', ticketCount: 2 }));
        const r = await owner.client.get(`/api/ticket/${made[0].id}/preview`);
        assert.equal(r.status, 200, r.text);
        assert.equal(cardCount(r.text), 2);
        assert.match(r.text, /Ticket 1 of 2/);
        assert.match(r.text, /Print Night/);
        assert.match(r.text, /Pat Printer/);
        assert.match(r.text, /<svg[^>]*viewBox/, 'QR is inline SVG');
        assert.ok(r.text.includes(made[0].token), 'the ticket code is printed by default');
        assert.match(r.text, /Do not share your QR code with others/);
    });

    test('follows the email template: no code, no details, custom small print', async () => {
        const ev = await createEvent(owner.client, { name: 'Lean Ticket' });
        const put = await owner.client.put(`/api/event/${ev.id}/email-template`, {
            variant: 'ticket',
            template: {
                version: 1,
                settings: { accent: '#123456', pageBackground: '#f3f4f6', cardBackground: '#ffffff', subject: '' },
                blocks: [
                    { id: 'h', type: 'header', props: { eyebrow: '', title: 'Gala: {{eventName}}' } },
                    { id: 't', type: 'tickets', props: { showWallet: false, showToken: false } },
                    { id: 'f', type: 'footerNote', props: { lines: ['No re-entry after 10pm.'] } },
                ],
            },
        });
        assert.equal(put.status, 200, put.text);
        const [t] = ticketsOf(await addTicket(owner.client, ev.id, { name: 'Lee Lean' }));
        const r = await owner.client.get(`/api/ticket/${t.id}/preview`);
        assert.equal(r.status, 200);
        assert.match(r.text, /Gala: Lean Ticket/);
        assert.match(r.text, /No re-entry after 10pm\./);
        assert.match(r.text, /--accent:#123456/);
        assert.ok(!r.text.includes(t.token), 'the code is hidden when the email hides it');
        assert.ok(!/Date &amp; time|>Venue</.test(r.text), 'no event details without the eventDetails block');
        assert.ok(!/Do not share your QR code/.test(r.text));
    });

    test('a voided ticket is left off, and Print Selected skips events the user cannot reach', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Print' });
        const a = ticketsOf(await addTicket(owner.client, ev.id, { name: 'Alpha', ticketCount: 2 }));
        const b = ticketsOf(await addTicket(owner.client, ev.id, { name: 'Bravo' }));
        assert.equal((await owner.client.post(`/api/ticket/${a[1].id}/expire`, {})).status, 200);

        const ids = [a[0].registrationId, b[0].registrationId].join(',');
        const r = await owner.client.get(`/api/tickets/bulk-preview?regIds=${encodeURIComponent(ids)}`);
        assert.equal(r.status, 200, r.text);
        assert.equal(cardCount(r.text), 2);
        assert.ok(!r.text.includes(a[1].token));

        const stranger = await newUser(server);
        const s = await stranger.client.get(`/api/tickets/bulk-preview?regIds=${encodeURIComponent(ids)}`);
        assert.equal(s.status, 404);
        assert.ok(!s.text.includes(a[0].token));
    });
});

describe('My Tickets print', () => {
    test('prints the same ticket design, only this address\'s live tickets', async () => {
        const ev = await createEvent(owner.client, { name: 'Attendee Print' });
        const email = uniqueEmail('printer');
        const mine = ticketsOf(await addTicket(owner.client, ev.id, { name: 'Mo Mine', email, ticketCount: 2 }));
        const theirs = ticketsOf(await addTicket(owner.client, ev.id, { name: 'Not Mine' }));
        assert.equal((await owner.client.post(`/api/ticket/${mine[1].id}/expire`, {})).status, 200);

        const client = await signedIn(email);
        const all = await client.get('/api/my-tickets/print');
        assert.equal(all.status, 200, all.text);
        assert.equal(cardCount(all.text), 1);
        assert.ok(all.text.includes(mine[0].token));
        assert.ok(!all.text.includes(mine[1].token), 'a voided ticket is not printed');
        assert.ok(!all.text.includes(theirs[0].token));

        const one = await client.get(`/api/my-tickets/print?reg=${encodeURIComponent(mine[0].registrationId)}`);
        assert.equal(cardCount(one.text), 1);
        const other = await client.get(`/api/my-tickets/print?reg=${encodeURIComponent(theirs[0].registrationId)}`);
        assert.equal(other.status, 404, 'someone else\'s booking prints nothing');
    });

    test('without a sign-in it goes back to the sign-in page', async () => {
        const r = await anon().get('/api/my-tickets/print');
        assert.equal(r.status, 302);
        assert.match(r.headers.get('location'), /my-tickets\.html$/);
    });
});
