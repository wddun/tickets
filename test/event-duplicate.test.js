// Duplicating an event.
//
// The whole risk of this feature is in what it copies. A `SELECT *` clone is
// the obvious implementation and the wrong one — it would carry the source's
// `displayToken` and `giveawayToken` into a second event, so one token would
// address two events, and copy a scanner PIN so one leaked door code opens
// both. So the tests that matter here are the negative ones: what must NOT
// come across, and what must be reset rather than inherited.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import {
    newUser, createEvent, addTicket, listTickets, share, uniqueEmail,
    setTicketExpiresAt,
} from './helpers/factories.js';
import { createClient } from './helpers/client.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const anon = () => createClient(server.base);

async function duplicate(client, eventId, body = {}) {
    return client.post(`/api/event/${eventId}/duplicate`, body);
}

/** An event with as much of its setup filled in as the API allows. */
async function fullyConfiguredEvent(client, name = 'Season Opener') {
    const ev = await createEvent(client, {
        name,
        capacity: 120,
        locationName: 'The Deck',
        locationAddress: '12 High St',
        color: '#7c3aed',
        publicRegistration: true,
        waitlist: true,
        limits: { allowMultipleRegistrations: false, oneRegistrationPerDevice: true, blockDuplicateEmails: true },
    });
    await client.put(`/api/event/${ev.id}/theme`, { theme: 'professional' });
    await client.put(`/api/event/${ev.id}/waitlist-claim-hours`, { hours: 12 });
    await client.put(`/api/event/${ev.id}/ticket-returns`, { enabled: true, refund: 'none', cutoffValue: 2, cutoffUnit: 'days' });
    await client.put(`/api/event/${ev.id}/email-policy`, { policy: { public: false, door: true, import: true, manual: true } });
    await client.put(`/api/event/${ev.id}/scan-result-duration`, { ms: 2500 });
    return (await client.get(`/api/event/${ev.id}`)).body;
}

describe('authorization', () => {
    test('needs manage_event on the source', async () => {
        const ev = await createEvent(owner.client, { name: 'Guarded' });
        const stranger = await newUser(server);
        const checkinOnly = await newUser(server);
        await share(owner.client, ev.id, checkinOnly.email, ['checkin']);

        assert.equal((await duplicate(anon(), ev.id)).status, 401);
        assert.equal((await duplicate(stranger.client, ev.id)).status, 403);
        assert.equal((await duplicate(checkinOnly.client, ev.id)).status, 403,
            'being able to check people in is not being able to read every setting');
        assert.equal((await duplicate(owner.client, ev.id)).status, 200);
    });

    test('a collaborator who may duplicate owns the copy, not the original owner', async () => {
        const ev = await createEvent(owner.client, { name: 'Shared Source' });
        const helper = await newUser(server);
        await share(owner.client, ev.id, helper.email, ['manage_event']);

        const made = await duplicate(helper.client, ev.id, { name: 'My Copy' });
        assert.equal(made.status, 200, made.text);

        // The copy is theirs: it shows up in their own event list, and the
        // original's owner has nothing to do with it.
        const theirs = await helper.client.get('/api/events');
        assert.ok(theirs.body.some(e => e.id === made.body.eventId && e.isOwner),
            'the person who asked for the copy must own it');
    });

    test('is a 404 for an event that does not exist', async () => {
        assert.equal((await duplicate(owner.client, 'nope')).status, 404);
    });
});

describe('what comes across', () => {
    test('every setting that makes the event what it is', async () => {
        const source = await fullyConfiguredEvent(owner.client);
        const made = await duplicate(owner.client, source.id, { name: 'Season Two' });
        assert.equal(made.status, 200, made.text);
        const copy = (await owner.client.get(`/api/event/${made.body.eventId}`)).body;

        assert.equal(copy.name, 'Season Two');
        for (const field of [
            'capacity', 'color', 'theme', 'allowPublicRegistration', 'waitlistEnabled',
            'allowMultipleRegistrations', 'oneRegistrationPerDevice', 'blockDuplicateEmails',
            'waitlistClaimHours', 'ticketReturnsEnabled', 'ticketReturnRefund',
            'ticketReturnCutoffMinutes', 'ticketReturnCutoffUnit', 'scanResultDurationMs',
            'walletLockScreenEnabled', 'ticketPrice', 'atDoorEnabled',
        ]) {
            assert.deepEqual(copy[field], source[field], `${field} should have been copied`);
        }
        assert.deepEqual(copy.location, source.location, 'venue should have been copied');
        assert.deepEqual(copy.emailPolicy, source.emailPolicy, 'email policy should have been copied');
    });

    test('custom fields', async () => {
        const ev = await createEvent(owner.client, { name: 'With Fields' });
        // Saved the way the dashboard's Custom Fields tab saves them.
        const fields = [
            { label: 'T-Shirt Size', type: 'multiple_choice', options: ['S', 'M', 'L'], required: true, showOnPublicForm: true },
            { label: 'Dietary', type: 'short_answer' },
        ];
        assert.equal((await owner.client.patch(`/api/event/${ev.id}`, { customFields: fields })).status, 200);

        const made = await duplicate(owner.client, ev.id);
        // /api/event/:id is the public, register.html-facing route — it only
        // ever shows fields opted into the public form, so the full
        // definitions (including the internal-only "Dietary" one) are read
        // back from the authenticated event list instead.
        const list = (await owner.client.get('/api/events')).body;
        const copy = list.find(e => e.id === made.body.eventId);
        assert.deepEqual(copy.customFields, [
            { label: 'T-Shirt Size', type: 'multiple_choice', options: ['S', 'M', 'L'], required: true, showOnPublicForm: true },
            { label: 'Dietary', type: 'short_answer', options: [], required: false, showOnPublicForm: false },
        ], 'custom fields are most of the setup worth copying');
    });

    test('collaborators, but only when asked for', async () => {
        const source = await createEvent(owner.client, { name: 'Team Event' });
        const helper = await newUser(server);
        await share(owner.client, source.id, helper.email, ['checkin', 'manage_tickets']);

        const without = await duplicate(owner.client, source.id, { name: 'No Team' });
        assert.equal(without.body.copiedAccess, 0);
        assert.equal(
            (await helper.client.get(`/api/event/${without.body.eventId}/tickets`)).status, 401,
            'access must not be granted silently',
        );

        const with_ = await duplicate(owner.client, source.id, { name: 'With Team', includeAccess: true });
        assert.equal(with_.body.copiedAccess, 1);
        assert.equal((await helper.client.get(`/api/event/${with_.body.eventId}/tickets`)).status, 200);

        // And at the same capabilities, not upgraded to full access.
        const caps = (await helper.client.get('/api/events')).body.find(e => e.id === with_.body.eventId)?.capabilities || [];
        assert.deepEqual([...caps].sort(), ['checkin', 'manage_tickets']);
    });
});

describe('what must not come across', () => {
    test('no tickets, and no waitlist entries', async () => {
        const source = await createEvent(owner.client, { name: 'Busy Event', capacity: 1, publicRegistration: true, waitlist: true });
        await addTicket(owner.client, source.id, { name: 'Seated' });
        assert.equal(
            (await anon().post('/api/register', { name: 'Waiting', email: uniqueEmail('w'), eventId: source.id })).body.waitlisted,
            true,
        );

        const made = await duplicate(owner.client, source.id);
        assert.equal((await listTickets(owner.client, made.body.eventId)).length, 0, 'a copy starts empty');
        assert.equal((await owner.client.get(`/api/event/${made.body.eventId}/waitlist`)).body.length, 0);
    });

    test('a fresh scanner PIN, not the original door code', async () => {
        const source = await createEvent(owner.client, { name: 'PIN Event' });
        const sourcePin = (await owner.client.get('/api/events')).body.find(e => e.id === source.id)?.scannerPin;
        assert.ok(sourcePin, 'the source should have a PIN to begin with');

        const made = await duplicate(owner.client, source.id);
        const copyPin = (await owner.client.get('/api/events')).body.find(e => e.id === made.body.eventId)?.scannerPin;
        assert.ok(copyPin, 'the copy needs its own PIN');
        assert.notEqual(copyPin, sourcePin, 'one leaked door PIN must not open two events');
    });

    test('a fresh display token — one token must never address two events', async () => {
        const source = await createEvent(owner.client, { name: 'Display Event' });
        const sourceToken = (await owner.client.get(`/api/display/token/${source.id}`)).body?.token;
        assert.ok(sourceToken);

        const made = await duplicate(owner.client, source.id);
        const copyToken = (await owner.client.get(`/api/display/token/${made.body.eventId}`)).body?.token;
        assert.ok(copyToken);
        assert.notEqual(copyToken, sourceToken);

        // And the source's token still resolves to the source, not the copy.
        const info = await anon().get(`/api/display/info/${sourceToken}`);
        assert.equal(info.status, 200, info.text);
        assert.equal(info.body.event.name, 'Display Event');
        assert.equal(info.body.event.id, source.id, 'the original token must still point at the original event');
    });

    test('the ticket-expiry cutoff, which was pinned to the original date', async () => {
        const source = await createEvent(owner.client, { name: 'Expiring Event' });
        await setTicketExpiresAt(owner.client, source.id, new Date(Date.now() + 3600000).toISOString());
        assert.ok((await owner.client.get(`/api/event/${source.id}`)).body.ticketExpiresAt);

        const made = await duplicate(owner.client, source.id);
        const copy = (await owner.client.get(`/api/event/${made.body.eventId}`)).body;
        assert.equal(copy.ticketExpiresAt ?? null, null, 'an absolute cutoff from the old date is meaningless on the copy');
    });

    test('the date, unless one is given', async () => {
        const source = await createEvent(owner.client, {
            name: 'Past Event',
            time: new Date(Date.now() - 86400000).toISOString(),
        });

        const blank = await duplicate(owner.client, source.id);
        assert.equal((await owner.client.get(`/api/event/${blank.body.eventId}`)).body.time ?? null, null,
            'a copy of a past event must not be created already over');

        const when = new Date(Date.now() + 7 * 86400000).toISOString();
        const dated = await duplicate(owner.client, source.id, { time: when });
        assert.equal((await owner.client.get(`/api/event/${dated.body.eventId}`)).body.time, when);
    });

    test('the audit log — the copy has only its own creation in it', async () => {
        const source = await createEvent(owner.client, { name: 'Logged Event' });
        await addTicket(owner.client, source.id, { name: 'Someone' });

        const made = await duplicate(owner.client, source.id);
        const log = await owner.client.get(`/api/event/${made.body.eventId}/audit-log`);
        assert.equal(log.status, 200, log.text);
        const actions = (log.body.entries || log.body).map(e => e.action);
        assert.ok(actions.includes('event.duplicated'), `expected the duplication to be logged: ${JSON.stringify(actions)}`);
        assert.ok(!actions.includes('ticket.created'), 'the source event\'s history is not the copy\'s history');
    });
});

describe('naming', () => {
    test('falls back to "(Copy)" when no name is given', async () => {
        const source = await createEvent(owner.client, { name: 'Unnamed Copy Source' });
        const made = await duplicate(owner.client, source.id);
        assert.equal((await owner.client.get(`/api/event/${made.body.eventId}`)).body.name, 'Unnamed Copy Source (Copy)');
    });

    test('duplicating a duplicate works and does not collide', async () => {
        const source = await createEvent(owner.client, { name: 'Original' });
        const first = await duplicate(owner.client, source.id);
        const second = await duplicate(owner.client, first.body.eventId);
        assert.notEqual(first.body.eventId, second.body.eventId);
        assert.equal((await owner.client.get(`/api/event/${second.body.eventId}`)).body.name, 'Original (Copy) (Copy)');
    });
});

describe('metrics', () => {
    test('report capacity, waitlist and given-up tickets alongside the check-in numbers', async () => {
        const ev = await createEvent(owner.client, { name: 'Metric Event', capacity: 10, publicRegistration: true, waitlist: true });
        const made = await addTicket(owner.client, ev.id, { name: 'Attendee', ticketCount: 3 });
        const tickets = Array.isArray(made) ? made : made.tickets;
        await owner.client.post(`/api/checkin/${tickets[0].id}`, {});

        // One returned by the attendee, so the two counts can be told apart.
        await owner.client.put(`/api/event/${ev.id}/ticket-returns`, { enabled: true });
        await anon().post(`/api/registration/${tickets[0].registrationId}/return`, { ticketIds: [tickets[1].id] });
        // ...and one expired by the organiser.
        await owner.client.post(`/api/ticket/${tickets[2].id}/expire`, {});

        const m = await owner.client.get(`/api/event/${ev.id}/metrics`);
        assert.equal(m.status, 200, m.text);
        assert.equal(m.body.eventName, 'Metric Event');
        assert.equal(m.body.capacity, 10);
        assert.equal(m.body.returned, 1);
        assert.equal(m.body.expired, 1);
        assert.equal(m.body.waitlistEnabled, true);
        assert.equal(m.body.waiting, 0);
        // Given-up tickets are out of the total the percentage is measured
        // against, so a wave of returns can't make the door look half-empty.
        assert.equal(m.body.total, 1);
        assert.equal(m.body.scanned, 1);
        assert.equal(m.body.pct, 100);
    });

    test('stay behind the same access check as the rest of the event', async () => {
        const ev = await createEvent(owner.client, { name: 'Private Metrics' });
        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/event/${ev.id}/metrics`)).status, 403);
        assert.equal((await anon().get(`/api/event/${ev.id}/metrics`)).status, 401);
    });
});
