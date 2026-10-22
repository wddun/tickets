// Ticket by text message: an event's "Text Tickets to Attendees" switch adds
// an optional phone field to the public form, and a number entered there gets
// one text linking to /t/<token>, a page that shows the ticket's QR.
//
// Every text lands in the SMS_SINK file (see helpers/server.js); the Twilio
// credentials handed to the child are blank, so nothing here can text a phone.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { newUser, createEvent, uniqueEmail } from './helpers/factories.js';
import { createClient } from './helpers/client.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const visitor = () => createClient(server.base);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForText(pred, timeoutMs = 5000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const hit = server.texts().find(pred);
        if (hit) return hit;
        if (Date.now() > until) throw new Error('No matching text. Captured: ' + JSON.stringify(server.texts()));
        await sleep(50);
    }
}

async function smsEvent(extra = {}) {
    const ev = await createEvent(owner.client, { publicRegistration: true, ...extra });
    const r = await owner.client.put(`/api/event/${ev.id}/sms`, { enabled: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.smsEnabled, true);
    return ev;
}

describe('the setting', () => {
    test('is off by default, and the public event says when the form should offer the field', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true });
        assert.equal((await visitor().get(`/api/event/${ev.id}`)).body.smsAvailable, false);
        await owner.client.put(`/api/event/${ev.id}/sms`, { enabled: true });
        assert.equal((await visitor().get(`/api/event/${ev.id}`)).body.smsAvailable, true);
    });

    test('needs manage_event', async () => {
        const ev = await createEvent(owner.client);
        const stranger = await newUser(server);
        assert.equal((await stranger.client.put(`/api/event/${ev.id}/sms`, { enabled: true })).status, 403);
        assert.equal((await visitor().put(`/api/event/${ev.id}/sms`, { enabled: true })).status, 401);
    });
});

describe('registering with a phone number', () => {
    test('texts a link that opens the ticket', async () => {
        const ev = await smsEvent();
        const email = uniqueEmail('sms');
        const r = await visitor().post('/api/register', { name: 'Pat Doe', email, eventId: ev.id, phone: '(919) 555-0123' });
        assert.equal(r.status, 200, r.text);

        const text = await waitForText(t => t.to === '+19195550123');
        assert.match(text.body, /Hi Pat, you're registered for/);
        assert.match(text.body, /Reply STOP/);
        const m = text.body.match(/\/t\/([A-Za-z0-9_-]+)/);
        assert.ok(m, 'the text carries a ticket link');
        assert.equal(m[1], r.body.ticket.token);

        const short = await fetch(`${server.base}/t/${m[1]}`, { redirect: 'manual' });
        assert.equal(short.status, 302);
        assert.match(short.headers.get('location'), /^\/ticket\.html\?t=/);

        const view = await visitor().get(`/api/ticket/${m[1]}`);
        assert.equal(view.status, 200);
        assert.equal(view.body.event.name, ev.name);
        assert.equal(view.body.tickets.length, 1);
        assert.equal(view.body.tickets[0].token, m[1]);
        assert.equal(view.body.tickets[0].name, 'Pat Doe');
        assert.equal(view.body.tickets[0].email, undefined, 'the page needs no email address');
    });

    test('a blank phone field registers normally and sends no text', async () => {
        const ev = await smsEvent();
        const before = server.texts().length;
        const r = await visitor().post('/api/register', { name: 'No Phone', email: uniqueEmail('np'), eventId: ev.id, phone: '' });
        assert.equal(r.status, 200, r.text);
        await sleep(200);
        assert.equal(server.texts().length, before);
    });

    test('an unusable number is refused before any ticket is issued', async () => {
        const ev = await smsEvent();
        const email = uniqueEmail('bad');
        for (const phone of ['555-0123', '+44 20 7946 0958', 'call me', '(119) 555-0123']) {
            const r = await visitor().post('/api/register', { name: 'Bad Phone', email, eventId: ev.id, phone });
            assert.equal(r.status, 400, `${phone}: ${r.text}`);
            assert.equal(r.body.reason, 'invalid_phone');
        }
        const list = await owner.client.get(`/api/event/${ev.id}/tickets`);
        const tickets = Array.isArray(list.body) ? list.body : list.body.tickets;
        assert.equal(tickets.filter(t => t.email === email).length, 0);
    });

    test('is ignored when the event has texting off', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true });
        const before = server.texts().length;
        const r = await visitor().post('/api/register', { name: 'Off', email: uniqueEmail('off'), eventId: ev.id, phone: 'not a number' });
        assert.equal(r.status, 200, 'a phone sent to an event without the field is not validated or used');
        await sleep(200);
        assert.equal(server.texts().length, before);
    });
});

describe('the ticket page', () => {
    test('an unknown token is a 404', async () => {
        assert.equal((await visitor().get('/api/ticket/doesnotexist')).status, 404);
    });

    test('is served', async () => {
        const r = await fetch(`${server.base}/ticket.html`);
        assert.equal(r.status, 200);
        assert.match(await r.text(), /api\/ticket\//);
    });
});
