// Event lifecycle: create, read, edit, theme, signup limits, delete — plus
// the scoping rules that decide whose rooms show up in whose list.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, updateEvent, addTicket, listTickets } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

describe('creating events', () => {
    test('requires a name', async () => {
        const r = await owner.client.post('/api/events', { name: '   ' });
        assert.equal(r.status, 400);
    });

    test('requires a session', async () => {
        const anon = createClient(server.base);
        assert.equal((await anon.post('/api/events', { name: 'Nope' })).status, 401);
    });

    test('returns the new event and lists it as owned', async () => {
        const ev = await createEvent(owner.client, { name: 'Season Opener' });
        assert.ok(ev.id);
        assert.equal(ev.name, 'Season Opener');

        const list = await owner.client.get('/api/events');
        const mine = list.body.find(e => e.id === ev.id);
        assert.ok(mine, 'new event missing from /api/events');
        assert.equal(mine.isOwner, true);
        assert.ok(mine.capabilities.includes('delete_event'), 'owner should hold every capability');
    });

    test('gives every event a scanner PIN', async () => {
        const ev = await createEvent(owner.client);
        const list = await owner.client.get('/api/events');
        const mine = list.body.find(e => e.id === ev.id);
        assert.match(String(mine.scannerPin), /^\d{6}$/);
    });
});

describe('reading events', () => {
    test('GET /api/event/:id is public but does not leak the scanner PIN', async () => {
        const ev = await createEvent(owner.client, { name: 'Public Read' });
        const anon = createClient(server.base);
        const r = await anon.get(`/api/event/${ev.id}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.name, 'Public Read');
        assert.equal(r.body.scannerPin, undefined, 'scanner PIN must not be public');
    });

    test('404s an unknown id', async () => {
        assert.equal((await owner.client.get('/api/event/does-not-exist')).status, 404);
    });

    test('counts tickets and check-ins per event', async () => {
        const ev = await createEvent(owner.client, { name: 'Counted' });
        await addTicket(owner.client, ev.id, { name: 'A One' });
        await addTicket(owner.client, ev.id, { name: 'B Two' });

        const counts = (await owner.client.get('/api/events/counts')).body;
        assert.equal(counts[ev.id].total, 2);
        assert.equal(counts[ev.id].scanned, 0);

        const tickets = await listTickets(owner.client, ev.id);
        await owner.client.post(`/api/checkin/${tickets[0].registrationId}`, {});

        const after2 = (await owner.client.get('/api/events/counts')).body;
        assert.equal(after2[ev.id].scanned, 1);
    });

    test('serves a calendar file for the event', async () => {
        const ev = await createEvent(owner.client, { name: 'Calendared' });
        const r = await owner.client.get(`/api/event/${ev.id}/calendar.ics`);
        assert.equal(r.status, 200);
        assert.match(r.text, /BEGIN:VCALENDAR/);
        assert.match(r.text, /Calendared/);
    });
});

describe('editing events', () => {
    test('saves name, capacity and location', async () => {
        const ev = await createEvent(owner.client, { name: 'Before' });
        const r = await updateEvent(owner.client, ev, {
            name: 'After', capacity: 50, locationName: 'The Hall', locationAddress: '1 Main St',
        });
        assert.equal(r.status, 200);

        const fresh = (await owner.client.get(`/api/event/${ev.id}`)).body;
        assert.equal(fresh.name, 'After');
        assert.equal(fresh.capacity, 50);
        assert.equal(fresh.location.name, 'The Hall');
        assert.equal(fresh.location.address, '1 Main St');
    });

    test('drops the literal "Venue" placeholder rather than storing it as a real venue', async () => {
        const ev = await createEvent(owner.client, { name: 'Placeholder Venue' });
        await updateEvent(owner.client, ev, { locationName: 'Venue', locationAddress: '' });
        const fresh = (await owner.client.get(`/api/event/${ev.id}`)).body;
        assert.notEqual(fresh.location?.name, 'Venue');
    });

    test('a stranger cannot edit someone else\'s event', async () => {
        const ev = await createEvent(owner.client, { name: 'Not Yours' });
        const other = await newUser(server);
        const r = await updateEvent(other.client, ev, { name: 'Hijacked' });
        assert.equal(r.status, 403);
        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).body.name, 'Not Yours');
    });

    test('PATCH sets the custom fields collected at registration', async () => {
        const ev = await createEvent(owner.client, { name: 'Custom Fields' });
        const r = await owner.client.patch(`/api/event/${ev.id}`, { customFields: ['Dietary needs', 'T-shirt size', 'Dietary needs'] });
        assert.equal(r.status, 200);
        // Duplicates are collapsed rather than stored twice.
        assert.deepEqual(r.body.customFields, ['Dietary needs', 'T-shirt size']);
        assert.deepEqual((await owner.client.get(`/api/event/${ev.id}`)).body.customFields, ['Dietary needs', 'T-shirt size']);
    });

    test('PATCH rejects anything that is not a list of field names', async () => {
        const ev = await createEvent(owner.client, { name: 'Bad Custom Fields' });
        assert.equal((await owner.client.patch(`/api/event/${ev.id}`, { customFields: 'nope' })).status, 400);
    });
});

describe('registration themes', () => {
    test('the theme list is public and every theme has an id and label', async () => {
        const anon = createClient(server.base);
        const r = await anon.get('/api/registration-themes');
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.body), 'expected a list of themes');
        assert.ok(r.body.length >= 3, 'expected several themes to choose from');
        for (const t of r.body) {
            assert.ok(t.key, 'theme without a key');
            assert.ok(t.label, 'theme without a label');
            assert.ok(t.vars && typeof t.vars === 'object', 'theme without CSS variables');
        }
    });

    test('an owner can set a theme and it sticks', async () => {
        const anon = createClient(server.base);
        const list = (await anon.get('/api/registration-themes')).body;
        const pick = list[list.length - 1].key;

        const ev = await createEvent(owner.client, { name: 'Themed' });
        const r = await owner.client.put(`/api/event/${ev.id}/theme`, { theme: pick });
        assert.equal(r.status, 200);
        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).body.theme, pick);
    });

    test('an unknown theme is rejected', async () => {
        const ev = await createEvent(owner.client, { name: 'Bad Theme' });
        const r = await owner.client.put(`/api/event/${ev.id}/theme`, { theme: 'not-a-theme' });
        assert.equal(r.status, 400);
    });

    test('a stranger cannot re-theme an event', async () => {
        const ev = await createEvent(owner.client, { name: 'Theme Guard' });
        const other = await newUser(server);
        assert.equal((await other.client.put(`/api/event/${ev.id}/theme`, { theme: 'classic' })).status, 403);
    });
});

describe('event toggles', () => {
    const toggles = [
        ['public-registration', 'allowPublicRegistration'],
        ['waitlist-enabled', 'waitlistEnabled'],
        ['skip-confirmation-emails', 'skipConfirmationEmails'],
        ['shuttle-link-enabled', 'shuttleLinkEnabled'],
        ['at-door', 'atDoorEnabled'],
    ];

    for (const [route, field] of toggles) {
        test(`${route} turns ${field} on and off`, async () => {
            const ev = await createEvent(owner.client, { name: `Toggle ${route}` });

            assert.equal((await owner.client.put(`/api/event/${ev.id}/${route}`, { enabled: true })).status, 200);
            assert.equal((await owner.client.get(`/api/event/${ev.id}`)).body[field], true);

            assert.equal((await owner.client.put(`/api/event/${ev.id}/${route}`, { enabled: false })).status, 200);
            assert.ok(!(await owner.client.get(`/api/event/${ev.id}`)).body[field]);
        });

        test(`${route} is refused to a stranger`, async () => {
            const ev = await createEvent(owner.client, { name: `Guard ${route}` });
            const other = await newUser(server);
            assert.equal((await other.client.put(`/api/event/${ev.id}/${route}`, { enabled: true })).status, 403);
        });
    }

    test('signup limits round-trip', async () => {
        const ev = await createEvent(owner.client, { name: 'Limits' });
        const r = await owner.client.put(`/api/event/${ev.id}/registration-limits`, {
            allowMultipleRegistrations: false,
            oneRegistrationPerDevice: true,
            blockDuplicateEmails: true,
        });
        assert.equal(r.status, 200);

        const fresh = (await owner.client.get(`/api/event/${ev.id}`)).body;
        assert.equal(fresh.allowMultipleRegistrations, false);
        assert.equal(fresh.oneRegistrationPerDevice, true);
        assert.equal(fresh.blockDuplicateEmails, true);
    });

    test('a new event allows multiple registrations by default', async () => {
        const ev = await createEvent(owner.client, { name: 'Defaults' });
        const fresh = (await owner.client.get(`/api/event/${ev.id}`)).body;
        assert.notEqual(fresh.allowMultipleRegistrations, false);
        assert.ok(!fresh.oneRegistrationPerDevice);
        assert.ok(!fresh.blockDuplicateEmails);
    });
});

describe('deleting events', () => {
    test('removes the event and its tickets', async () => {
        const ev = await createEvent(owner.client, { name: 'Doomed' });
        await addTicket(owner.client, ev.id, { name: 'Goes Away' });

        assert.equal((await owner.client.del(`/api/event/${ev.id}`)).status, 200);
        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).status, 404);

        const list = await owner.client.get('/api/events');
        assert.ok(!list.body.some(e => e.id === ev.id));
    });

    test('a stranger cannot delete an event, and is not told it exists', async () => {
        const ev = await createEvent(owner.client, { name: 'Guarded' });
        const other = await newUser(server);
        // 404 rather than 403 on purpose: someone with no access shouldn't
        // learn whether the id is real.
        assert.equal((await other.client.del(`/api/event/${ev.id}`)).status, 404);
        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).status, 200);
    });

    test('bulk delete only removes the caller\'s own events', async () => {
        const mine = await createEvent(owner.client, { name: 'Mine To Delete' });
        const other = await newUser(server);
        const theirs = await createEvent(other.client, { name: 'Theirs To Keep' });

        const r = await owner.client.del('/api/events/bulk', { eventIds: [mine.id, theirs.id] });
        assert.equal(r.status, 200);

        assert.equal((await owner.client.get(`/api/event/${mine.id}`)).status, 404);
        assert.equal((await other.client.get(`/api/event/${theirs.id}`)).status, 200);
    });

    // discountCodes and waitlist rows have no route that can surface them
    // once their event is gone, so a leak here is invisible from the API —
    // only a direct read of the database file catches it.
    test('also removes discount codes and waitlist entries, not just tickets', async () => {
        const db = new Database(path.join(server.dir, 'tickets.db'));
        try {
            const ev = await createEvent(owner.client, { name: 'Doomed With Extras', waitlist: true });
            const code = await owner.client.post(`/api/event/${ev.id}/discount-codes`, { code: 'GONE10', type: 'percent', value: 10 });
            assert.equal(code.status, 200, `discount code creation failed: ${code.text}`);
            const wl = await owner.client.post(`/api/event/${ev.id}/waitlist`, { name: 'Waiting Person', email: 'waiting@test.local' });
            assert.equal(wl.status, 200, `waitlist join failed: ${wl.text}`);

            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM discountCodes WHERE eventId=?').get(ev.id).n, 1);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE eventId=?').get(ev.id).n, 1);

            assert.equal((await owner.client.del(`/api/event/${ev.id}`)).status, 200);

            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM discountCodes WHERE eventId=?').get(ev.id).n, 0);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE eventId=?').get(ev.id).n, 0);
        } finally {
            db.close();
        }
    });
});
