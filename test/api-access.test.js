// External API access: the apiKey-authenticated integration routes that the
// Google Sheets script and any other outside system use.
//
// These routes carry no session — the key is the whole credential — so the
// tests lean hard on the negative cases: no key, wrong key, another event's
// key, and a key that must not let the caller past the event it belongs to.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, addTicket, listTickets, eventApiKey, share, uniqueEmail } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

/** An outside system: no cookies, no session, just the key. */
const external = () => createClient(server.base);

describe('the event API key', () => {
    test('is handed out to the owner and is stable', async () => {
        const ev = await createEvent(owner.client, { name: 'Keyed Event' });
        const first = await owner.client.get(`/api/event/${ev.id}/api-key`);
        assert.equal(first.status, 200);
        assert.equal(first.body.eventId, ev.id);
        assert.ok(first.body.apiKey?.length >= 20);

        const second = await owner.client.get(`/api/event/${ev.id}/api-key`);
        assert.equal(second.body.apiKey, first.body.apiKey, 'asking twice must not rotate the key');
    });

    test('is not handed out to a collaborator who only works the door', async () => {
        const ev = await createEvent(owner.client, { name: 'Key Guard' });
        const staff = await newUser(server);
        await share(owner.client, ev.id, staff.email, ['checkin', 'manage_tickets']);

        assert.equal((await staff.client.get(`/api/event/${ev.id}/api-key`)).status, 403);
        assert.equal((await external().get(`/api/event/${ev.id}/api-key`)).status, 401);
    });

    test('each event has its own key', async () => {
        const a = await createEvent(owner.client, { name: 'Key A' });
        const b = await createEvent(owner.client, { name: 'Key B' });
        assert.notEqual(await eventApiKey(owner.client, a.id), await eventApiKey(owner.client, b.id));
    });
});

describe('POST /api/register-bulk', () => {
    test('issues tickets for a sheet row', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Event' });
        const apiKey = await eventApiKey(owner.client, ev.id);

        const r = await external().post('/api/register-bulk', {
            firstName: 'Row', lastName: 'One', email: uniqueEmail('row'),
            eventId: ev.id, ticketCount: 2, apiKey, sendEmail: false,
        });
        assert.equal(r.status, 200, r.text);

        const tickets = await listTickets(owner.client, ev.id);
        assert.equal(tickets.length, 2);
        assert.equal(tickets[0].name, 'Row One');
        assert.equal(tickets[0].registrationId, tickets[1].registrationId, 'one row is one registration');
    });

    test('carries the sheet\'s extra columns through as custom fields', async () => {
        const ev = await createEvent(owner.client, { name: 'Custom Bulk' });
        const apiKey = await eventApiKey(owner.client, ev.id);

        await external().post('/api/register-bulk', {
            firstName: 'Extra', lastName: 'Columns', email: uniqueEmail('extra'),
            eventId: ev.id, ticketCount: 1, apiKey, sendEmail: false,
            customFields: { 'T-Shirt Size': 'M', Meal: 'Veg' },
        });

        const [ticket] = await listTickets(owner.client, ev.id);
        assert.equal(ticket.customFields['T-Shirt Size'], 'M');
        assert.equal(ticket.customFields.Meal, 'Veg');
    });

    test('refuses a missing, wrong, or other event\'s key', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Guard' });
        const other = await createEvent(owner.client, { name: 'Someone Else\'s Room' });
        const otherKey = await eventApiKey(owner.client, other.id);
        const row = { firstName: 'No', lastName: 'Entry', email: 'no@test.local', eventId: ev.id, ticketCount: 1 };

        assert.equal((await external().post('/api/register-bulk', row)).status, 401);
        assert.equal((await external().post('/api/register-bulk', { ...row, apiKey: 'made-up' })).status, 401);
        assert.equal((await external().post('/api/register-bulk', { ...row, apiKey: otherKey })).status, 401,
            'a key must only work for the event it belongs to');

        assert.equal((await listTickets(owner.client, ev.id)).length, 0);
    });

    test('validates the row before writing anything', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Validation' });
        const apiKey = await eventApiKey(owner.client, ev.id);
        const base = { firstName: 'A', lastName: 'B', email: 'a@test.local', eventId: ev.id, ticketCount: 1, apiKey };

        assert.equal((await external().post('/api/register-bulk', { ...base, firstName: undefined })).status, 400);
        assert.equal((await external().post('/api/register-bulk', { ...base, email: undefined })).status, 400);
        assert.equal((await external().post('/api/register-bulk', { ...base, ticketCount: 0 })).status, 400);
        assert.equal((await external().post('/api/register-bulk', { ...base, ticketCount: 501 })).status, 400);
        assert.equal((await external().post('/api/register-bulk', { ...base, ticketCount: 'many' })).status, 400);

        assert.equal((await listTickets(owner.client, ev.id)).length, 0);
    });

    test('404s an event that does not exist, even with a real key', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Missing' });
        const apiKey = await eventApiKey(owner.client, ev.id);
        const r = await external().post('/api/register-bulk', {
            firstName: 'Ghost', lastName: 'Row', email: 'ghost@test.local',
            eventId: 'no-such-event', ticketCount: 1, apiKey,
        });
        assert.ok([401, 404].includes(r.status), `expected a refusal, got ${r.status}`);
    });

    test('waitlists an overflow row instead of refusing it when the waitlist is on', async () => {
        const ev = await createEvent(owner.client, { name: 'Bulk Waitlist', capacity: 1, waitlist: true });
        await addTicket(owner.client, ev.id, { name: 'Only Seat' });
        const apiKey = await eventApiKey(owner.client, ev.id);

        const r = await external().post('/api/register-bulk', {
            firstName: 'Overflow', lastName: 'Row', email: uniqueEmail('overflow'),
            eventId: ev.id, ticketCount: 1, apiKey, sendEmail: false,
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.waitlisted, true);
        assert.equal((await owner.client.get(`/api/event/${ev.id}/waitlist`)).body.length, 1);
    });
});

describe('POST /api/ticket-status', () => {
    test('reports scanned state for a batch of tokens', async () => {
        const ev = await createEvent(owner.client, { name: 'Status Event' });
        await addTicket(owner.client, ev.id, { name: 'Scanned One' });
        await addTicket(owner.client, ev.id, { name: 'Unscanned Two' });
        const tickets = await listTickets(owner.client, ev.id);
        await owner.client.post('/api/validate', { token: tickets[0].token, eventId: ev.id });

        const link = await owner.client.post('/api/sheet/generate-link', { spreadsheetId: 'sheet-status-1', eventId: ev.id });
        const { apiKey } = link.body;

        const r = await external().post('/api/ticket-status', {
            tokens: [tickets[0].token, tickets[1].token, 'not-a-token'],
            spreadsheetId: 'sheet-status-1',
            apiKey,
        });
        assert.equal(r.status, 200);

        const byToken = Object.fromEntries(r.body.map(x => [x.token, x]));
        assert.equal(byToken[tickets[0].token].status, 'scanned');
        assert.ok(byToken[tickets[0].token].used_at);
        assert.equal(byToken[tickets[1].token].status, 'not scanned');
        assert.equal(byToken['not-a-token'].status, 'not found');
    });

    test('needs the right key', async () => {
        const ev = await createEvent(owner.client, { name: 'Status Guard' });
        await owner.client.post('/api/sheet/generate-link', { spreadsheetId: 'sheet-status-2', eventId: ev.id });

        const r = await external().post('/api/ticket-status', {
            tokens: ['x'], spreadsheetId: 'sheet-status-2', apiKey: 'wrong',
        });
        assert.equal(r.status, 401);
    });
});

describe('sheet link management', () => {
    test('generating a link returns a token, a URL and a key', async () => {
        const ev = await createEvent(owner.client, { name: 'Sheet Linked' });
        const r = await owner.client.post('/api/sheet/generate-link', {
            spreadsheetId: 'sheet-gen-1', sheetName: 'Responses', eventId: ev.id,
        });
        assert.equal(r.status, 200);
        assert.ok(r.body.token);
        assert.ok(r.body.apiKey);
        assert.match(r.body.linkUrl, /\/link\//);
    });

    test('asking again for the same spreadsheet needs the key it already issued', async () => {
        const ev = await createEvent(owner.client, { name: 'Sheet Rekey' });
        const first = await owner.client.post('/api/sheet/generate-link', { spreadsheetId: 'sheet-gen-2', eventId: ev.id });

        const wrong = await external().post('/api/sheet/generate-link', { spreadsheetId: 'sheet-gen-2', apiKey: 'not-it' });
        assert.equal(wrong.status, 401, 'anyone guessing a spreadsheet id could otherwise re-point the link');

        const right = await external().post('/api/sheet/generate-link', { spreadsheetId: 'sheet-gen-2', apiKey: first.body.apiKey });
        assert.equal(right.status, 200);
        assert.equal(right.body.apiKey, first.body.apiKey);
    });

    test('/link/:token redirects to the claim page', async () => {
        const ev = await createEvent(owner.client, { name: 'Sheet Redirect' });
        const made = await owner.client.post('/api/sheet/generate-link', { spreadsheetId: 'sheet-gen-3', eventId: ev.id });

        const hop = await external().get(`/link/${made.body.token}`);
        assert.equal(hop.status, 302);
        assert.match(hop.headers.get('location'), /link\.html\?token=/);
    });

    test('link-info is readable by token and names the event', async () => {
        const ev = await createEvent(owner.client, { name: 'Sheet Info' });
        const made = await owner.client.post('/api/sheet/generate-link', { spreadsheetId: 'sheet-gen-4', eventId: ev.id });

        const info = await external().get(`/api/sheet/link-info/${made.body.token}`);
        assert.equal(info.status, 200);
        assert.equal(info.body.eventId ?? info.body.event?.id, ev.id);
    });
});

describe('POST /api/sheet/update-event', () => {
    test('edits the event it is keyed to', async () => {
        const ev = await createEvent(owner.client, { name: 'Sheet Editable' });
        const apiKey = await eventApiKey(owner.client, ev.id);

        const r = await external().post('/api/sheet/update-event', {
            eventId: ev.id, apiKey, name: 'Renamed From The Sheet', locationName: 'New Hall',
        });
        assert.equal(r.status, 200, r.text);

        const fresh = (await owner.client.get(`/api/event/${ev.id}`)).body;
        assert.equal(fresh.name, 'Renamed From The Sheet');
        assert.equal(fresh.location.name, 'New Hall');
    });

    test('cannot be used to edit a different event', async () => {
        const mine = await createEvent(owner.client, { name: 'Sheet Mine' });
        const theirs = await createEvent(owner.client, { name: 'Sheet Theirs' });
        const myKey = await eventApiKey(owner.client, mine.id);

        const r = await external().post('/api/sheet/update-event', { eventId: theirs.id, apiKey: myKey, name: 'Hijacked' });
        assert.equal(r.status, 401);
        assert.equal((await owner.client.get(`/api/event/${theirs.id}`)).body.name, 'Sheet Theirs');
    });
});

describe('POST /api/sheet/create-event', () => {
    test('creates an event and returns its key', async () => {
        const r = await external().post('/api/sheet/create-event', {
            spreadsheetId: 'sheet-create-1', name: 'Made By The Sheet',
            time: new Date(Date.now() + 86400000).toISOString(),
        });
        assert.equal(r.status, 200, r.text);
        assert.ok(r.body.eventId);
        assert.ok(r.body.apiKey);

        const made = await external().get(`/api/event/${r.body.eventId}`);
        assert.equal(made.body.name, 'Made By The Sheet');
    });

    test('leaves the venue empty rather than inventing one', async () => {
        // An event created with no address used to end up with a venue
        // literally called "Venue" printed on every ticket.
        const r = await external().post('/api/sheet/create-event', {
            spreadsheetId: 'sheet-create-2', name: 'No Venue Given',
            time: new Date(Date.now() + 86400000).toISOString(),
        });
        const made = (await external().get(`/api/event/${r.body.eventId}`)).body;
        assert.notEqual(made.location?.name, 'Venue');
        assert.ok(!made.location?.name, 'an event with no address should have no venue name');
    });

    test('needs a spreadsheet id', async () => {
        assert.equal((await external().post('/api/sheet/create-event', { name: 'Nameless Sheet' })).status, 400);
    });
});
