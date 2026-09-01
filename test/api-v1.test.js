// The public HTTP API: key issuance, authentication, and the scope model.
//
// The property worth defending here is that a key is never more powerful than
// the person who made it, and never stays more powerful than they are. Most
// of this file is that claim, attacked from several directions.
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

/** A caller holding only a key — no cookies, no session. */
function apiClient(key) {
    const c = createClient(server.base);
    const withKey = (opts = {}) => ({ ...opts, headers: { ...(opts.headers || {}), authorization: `Bearer ${key}` } });
    return {
        get: (p, o) => c.get(p, withKey(o)),
        post: (p, b, o) => c.post(p, b, withKey(o)),
        patch: (p, b, o) => c.patch(p, b, withKey(o)),
        del: (p, b, o) => c.del(p, b, withKey(o)),
        raw: c,
    };
}

async function keyFor(client, eventId, scopes, name = 'Test key') {
    const r = await client.post(`/api/event/${eventId}/api-keys`, { name, scopes });
    assert.equal(r.status, 201, `key creation failed: ${r.text}`);
    return r.body;
}

/** An event with a full-scope key on it. */
async function eventWithKey(scopes = ['checkin', 'manage_tickets'], fields = {}) {
    const event = await createEvent(owner.client, fields);
    const key = await keyFor(owner.client, event.id, scopes);
    return { event, key, api: apiClient(key.key) };
}

describe('issuing keys', () => {
    test('returns the secret exactly once, and never again', async () => {
        const event = await createEvent(owner.client, { name: 'Key Issue' });
        const made = await keyFor(owner.client, event.id, ['checkin']);

        assert.ok(made.key.startsWith('wts_'), 'keys should be recognisable on sight');
        assert.ok(made.key.length >= 30, 'a key needs real entropy');
        assert.equal(made.prefix, made.key.slice(0, 10));

        // Listing keys shows the prefix and never the secret.
        const list = await owner.client.get(`/api/event/${event.id}/api-keys`);
        const seen = list.body.find(k => k.id === made.id);
        assert.equal(seen.key, undefined, 'the secret must not be retrievable after creation');
        assert.equal(seen.prefix, made.prefix);
    });

    test('needs at least one real scope', async () => {
        const event = await createEvent(owner.client, { name: 'Scopeless' });
        assert.equal((await owner.client.post(`/api/event/${event.id}/api-keys`, { scopes: [] })).status, 400);
        assert.equal((await owner.client.post(`/api/event/${event.id}/api-keys`, { scopes: ['nonsense'] })).status, 400);
    });

    test('refuses to grant access-sharing to a key', async () => {
        const event = await createEvent(owner.client, { name: 'No Sharing By Key' });
        const r = await owner.client.post(`/api/event/${event.id}/api-keys`, { scopes: ['manage_access'] });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /access sharing/i);
    });

    test('nobody can mint a key more powerful than themselves', async () => {
        const event = await createEvent(owner.client, { name: 'No Escalation' });
        const deputy = await newUser(server);
        await share(owner.client, event.id, deputy.email, ['checkin', 'manage_event']);

        // manage_tickets was never granted to this person.
        const over = await deputy.client.post(`/api/event/${event.id}/api-keys`, {
            name: 'Escalation attempt', scopes: ['checkin', 'manage_tickets'],
        });
        assert.equal(over.status, 403);
        assert.match(over.body.error, /do not have these permissions yourself/i);

        // What they do hold is fine.
        assert.equal((await deputy.client.post(`/api/event/${event.id}/api-keys`, { scopes: ['checkin'] })).status, 201);
    });

    test('managing keys needs manage_event', async () => {
        const event = await createEvent(owner.client, { name: 'Key Guard' });
        const doorStaff = await newUser(server);
        await share(owner.client, event.id, doorStaff.email, ['checkin']);

        assert.equal((await doorStaff.client.get(`/api/event/${event.id}/api-keys`)).status, 403);
        assert.equal((await doorStaff.client.post(`/api/event/${event.id}/api-keys`, { scopes: ['checkin'] })).status, 403);

        const anon = createClient(server.base);
        assert.equal((await anon.get(`/api/event/${event.id}/api-keys`)).status, 401);
    });
});

describe('authenticating', () => {
    test('rejects a request with no key, an unknown key, and a revoked key', async () => {
        const { key } = await eventWithKey(['checkin']);
        const bare = createClient(server.base);

        const none = await bare.get('/api/v1/registrations');
        assert.equal(none.status, 401);
        assert.equal(none.body.error.code, 'missing_key');

        const wrong = await bare.get('/api/v1/registrations', { headers: { authorization: 'Bearer wts_not-a-real-key' } });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.body.error.code, 'invalid_key');

        const live = apiClient(key.key);
        assert.equal((await live.get('/api/v1/me')).status, 200);
        assert.equal((await owner.client.del(`/api/api-keys/${key.id}`)).status, 200);
        assert.equal((await live.get('/api/v1/me')).status, 401, 'a revoked key must stop working at once');
    });

    test('accepts X-API-Key for tools that cannot set Authorization', async () => {
        const { key } = await eventWithKey(['checkin']);
        const c = createClient(server.base);
        const r = await c.get('/api/v1/me', { headers: { 'x-api-key': key.key } });
        assert.equal(r.status, 200);
    });

    test('/api/v1/me says what the key is for and what it may do', async () => {
        const { event, key, api } = await eventWithKey(['checkin', 'manage_tickets'], { name: 'Introspected' });
        const me = await api.get('/api/v1/me');
        assert.equal(me.status, 200);
        assert.equal(me.body.event.id, event.id);
        assert.equal(me.body.event.name, 'Introspected');
        assert.equal(me.body.key.prefix, key.prefix);
        assert.deepEqual([...me.body.scopes].sort(), ['checkin', 'manage_tickets']);
        assert.equal(me.body.key.key, undefined, 'introspection must not echo the secret back');
    });
});

describe('scopes', () => {
    test('a route refuses a key without its scope, and names the scope needed', async () => {
        const { api } = await eventWithKey(['checkin']);
        const r = await api.get('/api/v1/waitlist');
        assert.equal(r.status, 403);
        assert.equal(r.body.error.code, 'missing_scope');
        assert.match(r.body.error.message, /manage_waitlist/);
    });

    test('a read-only key cannot write', async () => {
        const { api } = await eventWithKey(['checkin']);
        const r = await api.post('/api/v1/registrations', { name: 'Should Fail', email: 'x@test.local' });
        assert.equal(r.status, 403);
        assert.equal(r.body.error.code, 'missing_scope');
    });

    test('undoing a check-in needs undo_checkin, not just checkin', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_tickets']);
        const made = await api.post('/api/v1/registrations', { name: 'Checked In', email: uniqueEmail('undo') });
        await api.post(`/api/v1/registrations/${made.body.id}/checkin`);

        const undo = await api.del(`/api/v1/registrations/${made.body.id}/checkin`);
        assert.equal(undo.status, 403);
        assert.ok((await listTickets(owner.client, event.id))[0].used_at, 'the check-in should stand');
    });

    test('a key narrows when its creator\'s access narrows', async () => {
        const event = await createEvent(owner.client, { name: 'Following Access' });
        const deputy = await newUser(server);
        await share(owner.client, event.id, deputy.email, ['checkin', 'manage_tickets', 'manage_event']);

        const key = await keyFor(deputy.client, event.id, ['checkin', 'manage_tickets']);
        const api = apiClient(key.key);
        assert.equal((await api.post('/api/v1/registrations', { name: 'While Allowed', email: uniqueEmail('allowed') })).status, 201);

        // The owner takes manage_tickets away from the person who made the key.
        const row = (await owner.client.get(`/api/event/${event.id}/access`)).body.access.find(a => a.email === deputy.email);
        await owner.client.patch(`/api/sheet/access/${row.id}`, { capabilities: ['checkin'] });

        const after = await api.post('/api/v1/registrations', { name: 'After Narrowing', email: uniqueEmail('denied') });
        assert.equal(after.status, 403, 'the key kept a permission its creator had lost');
        assert.deepEqual((await api.get('/api/v1/me')).body.scopes, ['checkin']);
    });

    test('a key dies when its creator loses the event entirely', async () => {
        const event = await createEvent(owner.client, { name: 'Revoked Creator' });
        const deputy = await newUser(server);
        await share(owner.client, event.id, deputy.email, ['checkin', 'manage_event']);

        const key = await keyFor(deputy.client, event.id, ['checkin']);
        const api = apiClient(key.key);
        assert.equal((await api.get('/api/v1/event')).status, 200);

        const row = (await owner.client.get(`/api/event/${event.id}/access`)).body.access.find(a => a.email === deputy.email);
        await owner.client.del(`/api/sheet/access/${row.id}`);

        assert.equal((await api.get('/api/v1/event')).status, 403, 'the key outlived its creator\'s access');
        assert.deepEqual((await api.get('/api/v1/me')).body.scopes, []);
    });
});

describe('a key reaches exactly one event', () => {
    test('it cannot see another event\'s registrations', async () => {
        const mine = await createEvent(owner.client, { name: 'Key Event' });
        const other = await createEvent(owner.client, { name: 'Other Event' });
        await addTicket(owner.client, other.id, { name: 'Not Visible' });
        await addTicket(owner.client, mine.id, { name: 'Visible' });

        const key = await keyFor(owner.client, mine.id, ['checkin']);
        const api = apiClient(key.key);

        const list = await api.get('/api/v1/registrations');
        assert.equal(list.body.total, 1);
        assert.equal(list.body.registrations[0].name, 'Visible');

        assert.equal((await api.get('/api/v1/event')).body.id, mine.id);
    });

    test('another event\'s registration id is simply not found', async () => {
        const mine = await createEvent(owner.client, { name: 'Scoped Key' });
        const other = await createEvent(owner.client, { name: 'Off Limits' });
        await addTicket(owner.client, other.id, { name: 'Theirs' });
        const [theirTicket] = await listTickets(owner.client, other.id);

        const key = await keyFor(owner.client, mine.id, ['checkin', 'manage_tickets', 'undo_checkin']);
        const api = apiClient(key.key);

        assert.equal((await api.get(`/api/v1/registrations/${theirTicket.registrationId}`)).status, 404);
        assert.equal((await api.post(`/api/v1/registrations/${theirTicket.registrationId}/checkin`)).status, 404);
        assert.equal((await api.del(`/api/v1/registrations/${theirTicket.registrationId}`)).status, 404);
        assert.equal((await listTickets(owner.client, other.id))[0].used_at, null);
    });

    test('another event\'s ticket scans as invalid, revealing nothing about it', async () => {
        const mine = await createEvent(owner.client, { name: 'Door Key' });
        const other = await createEvent(owner.client, { name: 'Elsewhere' });
        await addTicket(owner.client, other.id, { name: 'Secret Person' });
        const [theirTicket] = await listTickets(owner.client, other.id);

        const key = await keyFor(owner.client, mine.id, ['checkin']);
        const r = await apiClient(key.key).post('/api/v1/scan', { token: theirTicket.token });

        assert.equal(r.body.status, 'invalid');
        assert.ok(!JSON.stringify(r.body).includes('Secret Person'), 'a foreign ticket must not leak its holder');
    });

    test('a deleted event takes its keys with it', async () => {
        const event = await createEvent(owner.client, { name: 'Doomed With Keys' });
        const key = await keyFor(owner.client, event.id, ['checkin']);
        await owner.client.del(`/api/event/${event.id}`);
        assert.equal((await apiClient(key.key).get('/api/v1/me')).status, 401);
    });
});

describe('registrations through the API', () => {
    test('creates a group of tickets and reads it back', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_tickets'], { name: 'API Registrations' });

        const made = await api.post('/api/v1/registrations', {
            name: 'Grace Hopper', email: 'grace@test.local', ticketCount: 3,
            customFields: { Meal: 'Veg' },
        });
        assert.equal(made.status, 201);
        assert.equal(made.body.ticketCount, 3);
        assert.equal(made.body.firstName, 'Grace');
        assert.equal(made.body.lastName, 'Hopper');
        assert.equal(made.body.checkedIn, false);
        assert.equal(made.body.customFields.Meal, 'Veg');
        assert.equal(made.body.tickets.length, 3);

        const read = await api.get(`/api/v1/registrations/${made.body.id}`);
        assert.equal(read.body.id, made.body.id);
        assert.equal((await listTickets(owner.client, event.id)).length, 3);
    });

    test('validates its input', async () => {
        const { api } = await eventWithKey(['manage_tickets']);
        assert.equal((await api.post('/api/v1/registrations', { email: 'a@test.local' })).status, 400);
        assert.equal((await api.post('/api/v1/registrations', { name: 'No Email' })).status, 400);
    });

    test('does not email the attendee unless asked to', async () => {
        const { api } = await eventWithKey(['manage_tickets'], { name: 'Quiet API' });
        const email = uniqueEmail('silent');
        server.clearEmails();
        await api.post('/api/v1/registrations', { name: 'No Mail', email });
        await new Promise(r => setTimeout(r, 400));
        assert.ok(!server.emails().some(m => m.to === email), 'importing people must not spray tickets at them');
    });

    test('emails the ticket when asked, if the key may send email', async () => {
        const { api } = await eventWithKey(['manage_tickets', 'email_attendees'], { name: 'Mailing API' });
        const email = uniqueEmail('mailed');
        await api.post('/api/v1/registrations', { name: 'Send It', email, sendEmail: true });
        const mail = await server.waitForEmail(m => m.to === email);
        assert.match(mail.subject, /Mailing API/);
    });

    test('a key without email_attendees cannot make it send, even asking nicely', async () => {
        const { api } = await eventWithKey(['manage_tickets'], { name: 'No Mail Scope' });
        const email = uniqueEmail('unauthorised-mail');
        server.clearEmails();
        await api.post('/api/v1/registrations', { name: 'Tried', email, sendEmail: true });
        await new Promise(r => setTimeout(r, 400));
        assert.ok(!server.emails().some(m => m.to === email));
    });

    test('edits and deletes a registration', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_tickets']);
        const made = await api.post('/api/v1/registrations', { name: 'Before Edit', email: 'before@test.local', ticketCount: 2 });

        const edited = await api.patch(`/api/v1/registrations/${made.body.id}`, { name: 'After Edit', email: 'after@test.local' });
        assert.equal(edited.status, 200);
        assert.equal(edited.body.name, 'After Edit');
        assert.ok((await listTickets(owner.client, event.id)).every(t => t.name === 'After Edit'));

        const gone = await api.del(`/api/v1/registrations/${made.body.id}`);
        assert.equal(gone.body.deleted, 2);
        assert.equal((await listTickets(owner.client, event.id)).length, 0);
    });

    test('deleting a registration promotes the longest-waiting entry when the event has a waitlist', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_tickets'], { capacity: 1, waitlist: true });
        const made = await api.post('/api/v1/registrations', { name: 'Occupied Seat', email: 'occupied@test.local' });
        const waiterEmail = 'api-delete-waiter@test.local';
        await createClient(server.base).post(`/api/event/${event.id}/waitlist`, { name: 'Waiting Person', email: waiterEmail });

        const gone = await api.del(`/api/v1/registrations/${made.body.id}`);
        assert.equal(gone.status, 200, gone.text);
        assert.equal(gone.body.deleted, 1);
        assert.equal(gone.body.promoted, 1);

        assert.ok((await listTickets(owner.client, event.id)).some(t => t.email === waiterEmail));
    });

    test('filters by check-in state and by email', async () => {
        const { api } = await eventWithKey(['checkin', 'manage_tickets']);
        const a = await api.post('/api/v1/registrations', { name: 'Arrived', email: 'arrived@test.local' });
        await api.post('/api/v1/registrations', { name: 'Absent', email: 'absent@test.local' });
        await api.post(`/api/v1/registrations/${a.body.id}/checkin`);

        assert.equal((await api.get('/api/v1/registrations?checkedIn=true')).body.total, 1);
        assert.equal((await api.get('/api/v1/registrations?checkedIn=false')).body.total, 1);
        assert.equal((await api.get('/api/v1/registrations?email=absent@test.local')).body.registrations[0].name, 'Absent');
        assert.equal((await api.get('/api/v1/registrations?search=arri')).body.total, 1);
    });

    test('paginates', async () => {
        const { api } = await eventWithKey(['checkin', 'manage_tickets']);
        for (let i = 0; i < 5; i++) {
            await api.post('/api/v1/registrations', { name: `Person ${i}`, email: uniqueEmail(`p${i}`) });
        }
        const page = await api.get('/api/v1/registrations?limit=2&offset=0');
        assert.equal(page.body.total, 5);
        assert.equal(page.body.registrations.length, 2);

        const next = await api.get('/api/v1/registrations?limit=2&offset=2');
        assert.notEqual(next.body.registrations[0].id, page.body.registrations[0].id);
    });
});

describe('capacity still applies to the API', () => {
    test('a full event refuses, and says what is going on', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_tickets'], { capacity: 2 });
        await addTicket(owner.client, event.id, { name: 'One' });
        await addTicket(owner.client, event.id, { name: 'Two' });

        const r = await api.post('/api/v1/registrations', { name: 'Too Many', email: 'over@test.local' });
        assert.equal(r.status, 409);
        assert.equal(r.body.error.code, 'sold_out');
        assert.equal((await listTickets(owner.client, event.id)).length, 2);
    });

    test('a held seat outranks the API, same as everything else', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_tickets'], {
            capacity: 3, publicRegistration: true,
        });
        await addTicket(owner.client, event.id, { name: 'Seated One' });
        await addTicket(owner.client, event.id, { name: 'Seated Two' });

        const visitor = createClient(server.base);
        const hold = await visitor.post(`/api/event/${event.id}/hold`, {});
        assert.equal(hold.body.granted, true);

        const r = await api.post('/api/v1/registrations', { name: 'Seat Thief', email: 'thief@test.local' });
        assert.equal(r.status, 409, 'the API took a seat somebody was mid-signup for');
        assert.match(r.body.error.message, /being filled in right now/);
    });

    test('waitlists instead of refusing when the waitlist is on', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_tickets'], { capacity: 1, waitlist: true });
        await addTicket(owner.client, event.id, { name: 'Only Seat' });

        const r = await api.post('/api/v1/registrations', { name: 'In Line', email: 'inline@test.local' });
        assert.equal(r.status, 202);
        assert.equal(r.body.waitlisted, true);
        assert.equal(r.body.position, 1);
    });
});

describe('the door through the API', () => {
    test('checks a registration in, and is idempotent', async () => {
        const { api } = await eventWithKey(['checkin', 'manage_tickets']);
        const made = await api.post('/api/v1/registrations', { name: 'At The Door', email: 'door@test.local' });

        const first = await api.post(`/api/v1/registrations/${made.body.id}/checkin`);
        assert.equal(first.status, 200);
        assert.equal(first.body.checkedIn, true);
        assert.equal(first.body.alreadyCheckedIn, false);

        const second = await api.post(`/api/v1/registrations/${made.body.id}/checkin`);
        assert.equal(second.status, 200);
        assert.equal(second.body.alreadyCheckedIn, true, 'a repeat check-in should report, not fail');
    });

    test('scans a ticket the way a door device does', async () => {
        const { api } = await eventWithKey(['checkin', 'manage_tickets'], { name: 'Scanning API' });
        const made = await api.post('/api/v1/registrations', { name: 'Scan Me', email: 'scan@test.local' });
        const token = made.body.tickets[0].token;

        const first = await api.post('/api/v1/scan', { token });
        assert.equal(first.body.status, 'valid');
        assert.match(first.body.message, /Scanning API/);
        assert.equal(first.body.registration.name, 'Scan Me');

        const again = await api.post('/api/v1/scan', { token });
        assert.equal(again.body.status, 'already_used');
        assert.ok(again.body.checkedInAt);

        assert.equal((await api.post('/api/v1/scan', { token: 'nonsense' })).body.status, 'invalid');
    });

    test('accepts the "ticket:" prefix the QR code carries', async () => {
        const { api } = await eventWithKey(['checkin', 'manage_tickets']);
        const made = await api.post('/api/v1/registrations', { name: 'Prefixed', email: 'prefix@test.local' });
        const r = await api.post('/api/v1/scan', { token: `ticket:${made.body.tickets[0].token}` });
        assert.equal(r.body.status, 'valid');
    });

    test('undoes a check-in when scoped for it', async () => {
        const { api } = await eventWithKey(['checkin', 'undo_checkin', 'manage_tickets']);
        const made = await api.post('/api/v1/registrations', { name: 'Mistake', email: 'oops@test.local' });
        await api.post(`/api/v1/registrations/${made.body.id}/checkin`);

        const undone = await api.del(`/api/v1/registrations/${made.body.id}/checkin`);
        assert.equal(undone.status, 200);
        assert.equal(undone.body.checkedIn, false);
    });
});

describe('event and availability', () => {
    test('reports the event with live counts', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_tickets'], {
            name: 'Counted API', capacity: 10, locationName: 'The Hall', locationAddress: '1 Main St',
        });
        await api.post('/api/v1/registrations', { name: 'One', email: 'one@test.local' });

        const r = await api.get('/api/v1/event');
        assert.equal(r.body.id, event.id);
        assert.equal(r.body.name, 'Counted API');
        assert.equal(r.body.capacity, 10);
        assert.equal(r.body.registered, 1);
        assert.equal(r.body.remaining, 9);
        assert.equal(r.body.venue.name, 'The Hall');
        assert.match(r.body.registrationUrl, /register\.html\?id=/);
    });

    test('omits the venue entirely when there is none', async () => {
        const { api } = await eventWithKey(['checkin'], { name: 'No Venue API' });
        assert.equal((await api.get('/api/v1/event')).body.venue, null);
    });

    test('availability is a cheap poll', async () => {
        const { api } = await eventWithKey(['checkin'], { capacity: 5 });
        const r = await api.get('/api/v1/availability');
        assert.equal(r.body.capacity, 5);
        assert.equal(r.body.remaining, 5);
        assert.equal(r.body.soldOut, false);
    });
});

describe('waitlist and audit through the API', () => {
    test('lists the waitlist with positions and promotes from it', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_waitlist'], {
            capacity: 1, waitlist: true, publicRegistration: true,
        });
        await addTicket(owner.client, event.id, { name: 'Only Seat' });

        const visitor = createClient(server.base);
        await visitor.post(`/api/event/${event.id}/waitlist`, { name: 'Waiting Person', email: 'waiting@test.local' });

        const list = await api.get('/api/v1/waitlist');
        assert.equal(list.body.total, 1);
        assert.equal(list.body.entries[0].position, 1);

        const promoted = await api.post(`/api/v1/waitlist/${list.body.entries[0].id}/promote`);
        assert.equal(promoted.status, 200);
        assert.ok(promoted.body.ticket.token);
    });

    test('will not promote on a paid event — that path goes through Stripe', async () => {
        const { event, api } = await eventWithKey(['checkin', 'manage_waitlist'], {
            capacity: 1, waitlist: true, ticketPrice: 20,
        });
        await addTicket(owner.client, event.id, { name: 'Paid Seat' });
        const visitor = createClient(server.base);
        await visitor.post(`/api/event/${event.id}/waitlist`, { name: 'Paid Waiter', email: 'paidwait@test.local' });
        const entry = (await api.get('/api/v1/waitlist')).body.entries[0];

        const r = await api.post(`/api/v1/waitlist/${entry.id}/promote`);
        assert.equal(r.status, 409);
        assert.equal(r.body.error.code, 'paid_event');
    });

    test('API writes land in the audit trail, attributed to the key', async () => {
        const { event, api } = await eventWithKey(['manage_tickets', 'manage_event'], { name: 'Audited API' });
        await api.post('/api/v1/registrations', { name: 'Logged Person', email: 'logged@test.local' });

        const log = await api.get('/api/v1/audit-log');
        assert.equal(log.status, 200);
        const entry = log.body.entries.find(e => e.action === 'api.registration_created');
        assert.ok(entry, 'an API write should be auditable');
        assert.match(entry.userEmail, /^api-key:/, 'the audit trail should name the key, not just a person');

        // And it is the same trail the dashboard reads.
        const viaDashboard = await owner.client.get(`/api/event/${event.id}/audit-log`);
        assert.ok(viaDashboard.body.entries.some(e => e.action === 'api.registration_created'));
    });
});
