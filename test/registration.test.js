// Public self-registration: the form at register.html, the live availability
// counter it polls, and the three signup limits an organiser can turn on.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, publicRegister, addTicket, listTickets, uniqueEmail } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const visitor = () => createClient(server.base);

describe('the registration door', () => {
    test('is shut until the organiser opens it', async () => {
        const ev = await createEvent(owner.client, { name: 'Closed Door' });
        const r = await publicRegister(visitor(), ev.id);
        assert.equal(r.status, 403);
        assert.match(r.body.error, /not open/i);
    });

    test('issues a ticket once open, and emails it', async () => {
        const ev = await createEvent(owner.client, { name: 'Open Door', publicRegistration: true });
        const email = uniqueEmail('attendee');

        const r = await publicRegister(visitor(), ev.id, { name: 'Ada Lovelace', email });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.success, true);
        assert.ok(r.body.ticket.token, 'no ticket token returned');
        assert.ok(r.body.qr?.startsWith('data:image/png'), 'no QR image returned');

        // The response carries only what the page needs; the stored ticket is
        // where the name is split for the pass and the door display.
        const [stored] = (await listTickets(owner.client, ev.id)).filter(t => t.email === email);
        assert.equal(stored.firstName, 'Ada');
        assert.equal(stored.lastName, 'Lovelace');

        const mail = await server.waitForEmail(m => m.to === email);
        assert.match(mail.subject, /Open Door/);
    });

    test('requires a name, an email and a real event', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true });
        assert.equal((await visitor().post('/api/register', { email: 'a@test.local', eventId: ev.id })).status, 400);
        assert.equal((await visitor().post('/api/register', { name: 'A', eventId: ev.id })).status, 400);
        assert.equal((await visitor().post('/api/register', { name: 'A', email: 'a@test.local', eventId: 'nope' })).status, 404);
    });

    test('stores the email lowercased so duplicate checks can rely on it', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true });
        await publicRegister(visitor(), ev.id, { name: 'Case Test', email: 'MiXeD@Test.Local' });
        const tickets = await listTickets(owner.client, ev.id);
        assert.equal(tickets[0].email, 'mixed@test.local');
    });
});

describe('the live availability counter', () => {
    test('reports capacity, registered and remaining', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 3 });
        const a = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(a.capacity, 3);
        assert.equal(a.registered, 0);
        assert.equal(a.remaining, 3);
        assert.equal(a.soldOut, false);
        assert.equal(a.registrationOpen, true);

        await publicRegister(visitor(), ev.id);
        const b = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(b.registered, 1);
        assert.equal(b.remaining, 2);
    });

    test('says unlimited when there is no capacity', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true });
        const a = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(a.unlimited, true);
        assert.equal(a.remaining, null);
        assert.equal(a.soldOut, false);
    });

    test('goes sold out when the seats are gone, and comes back when capacity is raised', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1 });
        await publicRegister(visitor(), ev.id);

        const full = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(full.soldOut, true);
        assert.equal(full.remaining, 0);

        // The bug this covers: the page kept saying "sold out" after the
        // organiser raised the capacity, because the state was decided once
        // at page load instead of on every poll.
        const fresh = (await owner.client.get(`/api/event/${ev.id}`)).body;
        const fd = new FormData();
        fd.append('name', fresh.name); fd.append('capacity', '5');
        await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });

        const raised = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(raised.capacity, 5);
        assert.equal(raised.soldOut, false);
        assert.equal(raised.remaining, 4);
    });

    test('a sold-out event refuses a registration with a reason the page can show', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1 });
        await publicRegister(visitor(), ev.id);

        const r = await publicRegister(visitor(), ev.id);
        assert.equal(r.status, 400);
        assert.equal(r.body.reason, 'sold_out');
        assert.match(r.body.error, /sold out/i);
    });

    test('never reports more remaining than the capacity, however many tickets exist', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 2 });
        await addTicket(owner.client, ev.id, { name: 'One' });
        await addTicket(owner.client, ev.id, { name: 'Two' });
        const a = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(a.remaining, 0);
        assert.equal(a.soldOut, true);
    });
});

describe('blocking duplicate emails', () => {
    test('is off by default', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true });
        const email = uniqueEmail('twice');
        assert.equal((await publicRegister(visitor(), ev.id, { email })).status, 200);
        assert.equal((await publicRegister(visitor(), ev.id, { email })).status, 200);
    });

    test('refuses a second ticket on the same address once enabled', async () => {
        const ev = await createEvent(owner.client, {
            publicRegistration: true,
            limits: { allowMultipleRegistrations: true, blockDuplicateEmails: true },
        });
        const email = uniqueEmail('once');

        assert.equal((await publicRegister(visitor(), ev.id, { email })).status, 200);

        const again = await publicRegister(visitor(), ev.id, { email });
        assert.equal(again.status, 409);
        assert.equal(again.body.reason, 'email_already_registered');
    });

    test('is case-insensitive', async () => {
        const ev = await createEvent(owner.client, {
            publicRegistration: true,
            limits: { allowMultipleRegistrations: true, blockDuplicateEmails: true },
        });
        await publicRegister(visitor(), ev.id, { email: 'Repeat.Person@Test.Local' });
        const again = await publicRegister(visitor(), ev.id, { email: 'repeat.person@test.local' });
        assert.equal(again.status, 409);
    });

    test('only applies within the one event', async () => {
        const email = uniqueEmail('shared-address');
        const limits = { allowMultipleRegistrations: true, blockDuplicateEmails: true };
        const a = await createEvent(owner.client, { publicRegistration: true, limits });
        const b = await createEvent(owner.client, { publicRegistration: true, limits });

        assert.equal((await publicRegister(visitor(), a.id, { email })).status, 200);
        assert.equal((await publicRegister(visitor(), b.id, { email })).status, 200);
    });
});

describe('one registration per device', () => {
    test('turns the same browser away the second time', async () => {
        const ev = await createEvent(owner.client, {
            publicRegistration: true,
            limits: { allowMultipleRegistrations: true, oneRegistrationPerDevice: true },
        });

        const device = visitor();
        assert.equal((await publicRegister(device, ev.id)).status, 200);

        const again = await publicRegister(device, ev.id);
        assert.equal(again.status, 409);
        assert.equal(again.body.reason, 'device_already_registered');
    });

    test('does not affect a different browser', async () => {
        const ev = await createEvent(owner.client, {
            publicRegistration: true,
            limits: { allowMultipleRegistrations: true, oneRegistrationPerDevice: true },
        });
        const first = visitor();
        await publicRegister(first, ev.id);
        assert.equal((await publicRegister(visitor(), ev.id)).status, 200);
    });

    test('tells the page up front so the form can warn before anything is typed', async () => {
        const ev = await createEvent(owner.client, {
            publicRegistration: true,
            limits: { allowMultipleRegistrations: true, oneRegistrationPerDevice: true },
        });
        const device = visitor();
        await publicRegister(device, ev.id);

        const seen = (await device.get(`/api/event/${ev.id}`)).body;
        assert.equal(seen.deviceAlreadyRegistered, true);
        // A different browser is not marked.
        assert.ok(!(await visitor().get(`/api/event/${ev.id}`)).body.deviceAlreadyRegistered);
    });

    test('is refused at the hold stage too, before the form is filled in', async () => {
        const ev = await createEvent(owner.client, {
            publicRegistration: true, capacity: 10,
            limits: { allowMultipleRegistrations: true, oneRegistrationPerDevice: true },
        });
        const device = visitor();
        await publicRegister(device, ev.id);

        const hold = await device.post(`/api/event/${ev.id}/hold`, {});
        assert.equal(hold.status, 409);
        assert.equal(hold.body.reason, 'device_already_registered');
        assert.equal(hold.body.granted, false);
    });

    test('a failed registration does not mark the device', async () => {
        const ev = await createEvent(owner.client, {
            publicRegistration: true, capacity: 1,
            limits: { allowMultipleRegistrations: true, oneRegistrationPerDevice: true },
        });
        await addTicket(owner.client, ev.id, { name: 'Fills It' });

        const device = visitor();
        const soldOut = await publicRegister(device, ev.id);
        assert.equal(soldOut.status, 400);
        assert.ok(!(await device.get(`/api/event/${ev.id}`)).body.deviceAlreadyRegistered,
            'a refused signup should not burn the device\'s one registration');
    });
});

describe('allowing multiple registrations', () => {
    test('is on by default and reported to the page', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true });
        const seen = (await visitor().get(`/api/event/${ev.id}`)).body;
        assert.notEqual(seen.allowMultipleRegistrations, false);
    });

    test('can be turned off, and the page is told', async () => {
        const ev = await createEvent(owner.client, {
            publicRegistration: true,
            limits: { allowMultipleRegistrations: false },
        });
        const seen = (await visitor().get(`/api/event/${ev.id}`)).body;
        assert.equal(seen.allowMultipleRegistrations, false);
    });
});
