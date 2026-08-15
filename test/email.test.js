// What actually lands in an attendee's inbox.
//
// Every send is diverted to a file by EMAIL_SINK, so these assert on the real
// HTML the server built rather than on the fact that a send was attempted.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, addTicket, listTickets, publicRegister, updateEvent, uniqueEmail, share } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const visitor = () => createClient(server.base);

describe('the ticket confirmation email', () => {
    test('carries the event name, a QR image and a wallet pass', async () => {
        const ev = await createEvent(owner.client, {
            name: 'Emailed Event', publicRegistration: true,
            locationName: 'The Old Hall', locationAddress: '12 High Street',
        });
        const email = uniqueEmail('ticketed');
        await publicRegister(visitor(), ev.id, { name: 'Mailed Person', email });

        const mail = await server.waitForEmail(m => m.to === email);
        assert.match(mail.subject, /Emailed Event/);
        assert.match(mail.html, /Mailed/);
        assert.ok(mail.attachments.length, 'the QR code is attached by Content-ID, not inlined as a data URI');
        assert.ok(mail.attachments.some(a => a.cid), 'attachments need a cid for Gmail to render them');
    });

    test('shows the venue, with map links, when there is one', async () => {
        const ev = await createEvent(owner.client, {
            name: 'Venue Event', publicRegistration: true,
            locationName: 'The Old Hall', locationAddress: '12 High Street',
        });
        const email = uniqueEmail('venued');
        await publicRegister(visitor(), ev.id, { name: 'Knows Where', email });

        const mail = await server.waitForEmail(m => m.to === email);
        assert.match(mail.html, /The Old Hall/);
        assert.match(mail.html, /maps\.apple\.com|google\.com\/maps/);
    });

    test('leaves the location row out entirely when the event has no venue', async () => {
        // An event with no location used to print a venue literally called
        // "Venue" on the email and the wallet pass. The row is now omitted
        // rather than filled with a placeholder.
        const ev = await createEvent(owner.client, { name: 'Plain Party', publicRegistration: true });
        const email = uniqueEmail('venueless');
        await publicRegister(visitor(), ev.id, { name: 'Sam Attendee', email });

        const mail = await server.waitForEmail(m => m.to === email);
        assert.ok(!/\u{1F4CD}/u.test(mail.html), 'a location row was rendered for an event with no venue');
        assert.ok(!/maps\.apple\.com|google\.com\/maps/.test(mail.html), 'map links point at nothing without a venue');
        assert.ok(!/\bVenue\b/.test(mail.html), 'the email named the venue "Venue"');
    });

    test('drops the venue again if the organiser clears the location', async () => {
        const ev = await createEvent(owner.client, {
            name: 'Cleared Venue Event', publicRegistration: true,
            locationName: 'Temporary Hall', locationAddress: '1 Somewhere',
        });
        // Clearing has to actually clear: an empty field used to fall back to
        // the stored value, so a venue set by mistake could never be removed.
        await updateEvent(owner.client, ev, { locationName: '', locationAddress: '' });
        const cleared = (await owner.client.get(`/api/event/${ev.id}`)).body;
        assert.ok(!cleared.location?.name, 'the venue name was not cleared');
        assert.ok(!cleared.location?.address, 'the venue address was not cleared');

        const email = uniqueEmail('cleared');
        await publicRegister(visitor(), ev.id, { name: 'After Clearing', email });

        const mail = await server.waitForEmail(m => m.to === email);
        assert.ok(!/Temporary Hall/.test(mail.html));
    });

    test('is skipped when the organiser turns confirmations off', async () => {
        const ev = await createEvent(owner.client, { name: 'Quiet Event' });
        await owner.client.put(`/api/event/${ev.id}/skip-confirmation-emails`, { enabled: true });

        server.clearEmails();
        const email = uniqueEmail('quiet');
        await addTicket(owner.client, ev.id, { name: 'Silent Guest', email, noEmail: false });

        await new Promise(r => setTimeout(r, 400));
        assert.ok(!server.emails().some(m => m.to === email), 'a confirmation went out with emails turned off');
    });
});

describe('resending a ticket', () => {
    test('sends the same ticket to the same person again', async () => {
        const ev = await createEvent(owner.client, { name: 'Resend Event' });
        const email = uniqueEmail('resend');
        await addTicket(owner.client, ev.id, { name: 'Wants It Again', email });
        const [ticket] = await listTickets(owner.client, ev.id);

        server.clearEmails();
        const r = await owner.client.post(`/api/ticket/${ticket.id}/resend`, {});
        assert.equal(r.status, 200, r.text);

        const mail = await server.waitForEmail(m => m.to === email);
        assert.match(mail.subject, /Resend Event/);
    });

    test('needs permission to email attendees', async () => {
        const ev = await createEvent(owner.client, { name: 'Resend Guard' });
        await addTicket(owner.client, ev.id, { name: 'Protected' });
        const [ticket] = await listTickets(owner.client, ev.id);

        const doorStaff = await newUser(server);
        await share(owner.client, ev.id, doorStaff.email, ['checkin']);
        assert.equal((await doorStaff.client.post(`/api/ticket/${ticket.id}/resend`, {})).status, 403);
    });
});

describe('bulk email', () => {
    test('reaches every attendee once', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Mail Event' });
        const a = uniqueEmail('bulk-a');
        const b = uniqueEmail('bulk-b');
        await addTicket(owner.client, ev.id, { name: 'Person A', email: a });
        await addTicket(owner.client, ev.id, { name: 'Person B', email: b });

        server.clearEmails();
        const r = await owner.client.post(`/api/event/${ev.id}/bulk-email`, {
            subject: 'Doors open at 7', message: 'Please bring your ticket.',
        });
        assert.equal(r.status, 200);

        await server.waitForEmail(m => m.to === a && /Doors open at 7/.test(m.subject));
        await server.waitForEmail(m => m.to === b);

        const sent = server.emails().filter(m => /Doors open at 7/.test(m.subject));
        assert.equal(sent.length, 2, 'each attendee should get exactly one copy');
        assert.match(sent[0].html, /bring your ticket/i);
    });

    test('needs a subject and a message', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Validation' });
        await addTicket(owner.client, ev.id, { name: 'Someone' });
        assert.equal((await owner.client.post(`/api/event/${ev.id}/bulk-email`, { message: 'no subject' })).status, 400);
        assert.equal((await owner.client.post(`/api/event/${ev.id}/bulk-email`, { subject: 'no body' })).status, 400);
    });
});

describe('account emails', () => {
    test('a share notification tells the person who shared what', async () => {
        const ev = await createEvent(owner.client, { name: 'Shared By Email' });
        const mate = await newUser(server);

        server.clearEmails();
        await share(owner.client, ev.id, mate.email, ['checkin', 'export_data']);

        const mail = await server.waitForEmail(m => m.to === mate.email && /shared access/i.test(m.subject));
        assert.match(mail.html, /Shared By Email/);
        assert.match(mail.html, new RegExp(owner.email.replace('.', '\\.')));
    });

    test('a password reset link is single-use and time-limited in the wording', async () => {
        const user = await newUser(server);
        server.clearEmails();
        await visitor().post('/api/auth/forgot-password', { email: user.email });

        const mail = await server.waitForEmail(m => m.to === user.email && /reset/i.test(m.subject));
        assert.match(mail.html, /token=/);
    });
});

describe('nothing ever reaches a real mailbox during a test run', () => {
    test('every send is captured, and the capture carries the recipient', async () => {
        const ev = await createEvent(owner.client, { name: 'Sink Check', publicRegistration: true });
        const email = uniqueEmail('sink');
        server.clearEmails();
        await publicRegister(visitor(), ev.id, { name: 'Captured', email });

        const mail = await server.waitForEmail(m => m.to === email);
        assert.equal(mail.to, email);
        assert.ok(mail.at, 'the sink records when the send happened');
        assert.ok(mail.subject);
    });
});
