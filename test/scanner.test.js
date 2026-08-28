// The door: scanning a QR code, checking people in and undoing it, and the
// three ways a scanner proves it is allowed to do that (a session, a scan
// link, or a display token).
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, addTicket, listTickets, scanLinkClient, share, setTicketExpiresAt } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const anon = () => createClient(server.base);

/** An event with one ticket on it, plus that ticket. */
async function eventWithTicket(fields = {}, name = 'Scan Me') {
    const ev = await createEvent(owner.client, fields);
    await addTicket(owner.client, ev.id, { name });
    const [ticket] = await listTickets(owner.client, ev.id);
    return { ev, ticket };
}

describe('validating a ticket', () => {
    test('a first scan checks the person in', async () => {
        const { ev, ticket } = await eventWithTicket({}, 'Ada Lovelace');
        const r = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });

        assert.equal(r.status, 200);
        assert.equal(r.body.status, 'valid');
        assert.equal(r.body.name, 'Ada Lovelace');
        assert.equal(r.body.eventId, ev.id);
        assert.equal(r.body.eventName, ev.name);
        assert.ok(r.body.registrationId);

        const [after2] = await listTickets(owner.client, ev.id);
        assert.ok(after2.used_at, 'the ticket was not marked used');
    });

    test('accepts the "ticket:" prefix the QR code actually carries', async () => {
        const { ev, ticket } = await eventWithTicket();
        const r = await owner.client.post('/api/validate', { token: `ticket:${ticket.token}`, eventId: ev.id });
        assert.equal(r.body.status, 'valid');
    });

    test('a second scan reports the ticket as already used', async () => {
        const { ev, ticket } = await eventWithTicket();
        await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });

        const again = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(again.body.status, 'used');
        assert.ok(again.body.used_at);
    });

    test('an unknown token is invalid', async () => {
        const r = await owner.client.post('/api/validate', { token: 'not-a-real-token' });
        assert.equal(r.body.status, 'invalid');
    });

    test('a token is required', async () => {
        assert.equal((await owner.client.post('/api/validate', {})).status, 400);
    });

    test('a ticket for another event is refused at this door', async () => {
        const { ticket } = await eventWithTicket({}, 'Wrong Door');
        const otherEvent = await createEvent(owner.client, { name: 'A Different Event' });

        const r = await owner.client.post('/api/validate', { token: ticket.token, eventId: otherEvent.id });
        assert.equal(r.body.status, 'invalid');
        assert.match(r.body.message, /not valid for this event/i);

        // And it was not quietly checked in anyway.
        const [untouched] = await listTickets(owner.client, ticket.eventId);
        assert.equal(untouched.used_at, null);
    });
});

describe('ticket expiry cutoff', () => {
    test('a not-yet-used ticket refuses to scan once the cutoff has passed', async () => {
        const { ev, ticket } = await eventWithTicket({}, 'Cutoff Guest');
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        const r = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(r.body.status, 'expired');
        assert.match(r.body.message, /expired/i);

        const [untouched] = await listTickets(owner.client, ev.id);
        assert.equal(untouched.used_at, null, 'an expired ticket must not be marked used');
    });

    test('a cutoff in the future does not block scanning', async () => {
        const { ev, ticket } = await eventWithTicket({}, 'Not Yet');
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() + 3600_000).toISOString());

        const r = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(r.body.status, 'valid');
    });

    test('a ticket already checked in before the cutoff keeps working', async () => {
        const { ev, ticket } = await eventWithTicket({}, 'Already In');
        await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        // Scanning it again reports the normal "already used" status, not expired.
        const r = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(r.body.status, 'used');
    });

    test('GET tickets exposes expired for not-yet-used tickets past the cutoff', async () => {
        const { ev } = await eventWithTicket({}, 'Listed Guest');
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());
        const [ticket] = await listTickets(owner.client, ev.id);
        assert.equal(ticket.expired, true);
    });

    test('clearing the cutoff (blank) makes a ticket scannable again', async () => {
        const { ev, ticket } = await eventWithTicket({}, 'Reprieved');
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());
        await setTicketExpiresAt(owner.client, ev.id, null);

        const r = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(r.body.status, 'valid');
    });

    test('only manage_event can set it', async () => {
        const { ev } = await eventWithTicket();
        const stranger = await newUser(server);
        const r = await setTicketExpiresAt(stranger.client, ev.id, new Date().toISOString());
        assert.equal(r.status, 403);
    });
});

describe('re-entry', () => {
    test('prompts for check-out, then welcomes the person back', async () => {
        const ev = await createEvent(owner.client, { name: 'Re-entry Event' });
        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('allowReentry', 'true');
        await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });

        await addTicket(owner.client, ev.id, { name: 'In And Out' });
        const [ticket] = await listTickets(owner.client, ev.id);

        assert.equal((await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id })).body.status, 'valid');

        const exit = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(exit.body.status, 'reentry_exit', 'a re-entry event should ask to confirm the check-out');
    });
});

describe('who is allowed to scan', () => {
    test('nobody, without any proof at all', async () => {
        const { ev, ticket } = await eventWithTicket();
        const r = await anon().post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(r.status, 401);
        assert.equal(r.body.status, 'unauthorized');

        const [untouched] = await listTickets(owner.client, ev.id);
        assert.equal(untouched.used_at, null, 'an unauthorized scan must not check anyone in');
    });

    test('a signed-in user with no access to the event cannot scan its tickets', async () => {
        const { ev, ticket } = await eventWithTicket();
        const stranger = await newUser(server);

        const r = await stranger.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(r.status, 401, 'having any account must not be enough to scan someone else\'s event');

        const [untouched] = await listTickets(owner.client, ev.id);
        assert.equal(untouched.used_at, null);
    });

    test('a collaborator with checkin can scan', async () => {
        const { ev, ticket } = await eventWithTicket();
        const staff = await newUser(server);
        await share(owner.client, ev.id, staff.email, ['checkin']);

        const r = await staff.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(r.body.status, 'valid');
    });

    test('a scan link works with no account at all', async () => {
        const { ev, ticket } = await eventWithTicket();
        const { client: door } = await scanLinkClient(server, owner.client, ev.id);

        const r = await door.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(r.body.status, 'valid');
    });

    test('the scan link token can be passed in the body instead of the session', async () => {
        const { ev, ticket } = await eventWithTicket();
        const made = await owner.client.post(`/api/event/${ev.id}/scanner-links`, { label: 'Body Token' });
        const token = made.body.link.token;

        const r = await anon().post('/api/validate', { token: ticket.token, eventId: ev.id, scanLinkToken: token });
        assert.equal(r.body.status, 'valid');
    });

    test('a display token counts as proof for its own event', async () => {
        const { ev, ticket } = await eventWithTicket();
        const display = (await owner.client.get(`/api/display/token/${ev.id}`)).body;

        const r = await anon().post('/api/validate', { token: ticket.token, eventId: ev.id, displayToken: display.token });
        assert.equal(r.body.status, 'valid');
    });

    test('another event\'s scan link is not proof for this one', async () => {
        const { ev, ticket } = await eventWithTicket();
        const elsewhere = await createEvent(owner.client, { name: 'Somewhere Else' });
        const { client: wrongDoor } = await scanLinkClient(server, owner.client, elsewhere.id);

        const r = await wrongDoor.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(r.status, 401);
    });
});

describe('manual check-in and undo', () => {
    test('checks a whole registration in, and undoes it', async () => {
        const ev = await createEvent(owner.client, { name: 'Group Check-in' });
        await addTicket(owner.client, ev.id, { name: 'Party Of Three', ticketCount: 3 });
        const tickets = await listTickets(owner.client, ev.id);
        const regId = tickets[0].registrationId;

        const inn = await owner.client.post(`/api/checkin/${regId}`, {});
        assert.equal(inn.status, 200);
        assert.ok((await listTickets(owner.client, ev.id)).every(t => t.used_at), 'the whole group should be checked in');

        const out = await owner.client.del(`/api/checkin/${regId}`);
        assert.equal(out.status, 200);
        assert.ok((await listTickets(owner.client, ev.id)).every(t => !t.used_at), 'undo should clear the whole group');
    });

    test('404s an id that matches nothing', async () => {
        assert.equal((await owner.client.post('/api/checkin/no-such-registration', {})).status, 404);
    });

    test('door staff on a scan link can check in and undo', async () => {
        const { ev, ticket } = await eventWithTicket();
        const { client: door } = await scanLinkClient(server, owner.client, ev.id);

        assert.equal((await door.post(`/api/checkin/${ticket.registrationId}`, {})).status, 200);
        assert.equal((await door.del(`/api/checkin/${ticket.registrationId}`)).status, 200);
    });

    test('a signed-in stranger cannot check in someone else\'s attendee', async () => {
        const { ev, ticket } = await eventWithTicket();
        const stranger = await newUser(server);
        assert.equal((await stranger.client.post(`/api/checkin/${ticket.registrationId}`, {})).status, 403);
        assert.equal((await listTickets(owner.client, ev.id))[0].used_at, null);
    });
});

describe('scan links', () => {
    test('are created with a URL, listed, and revoked', async () => {
        const ev = await createEvent(owner.client, { name: 'Link Admin' });

        const made = await owner.client.post(`/api/event/${ev.id}/scanner-links`, { label: 'Front Gate' });
        assert.equal(made.status, 200);
        assert.equal(made.body.link.label, 'Front Gate');
        assert.match(made.body.link.url, /\/scan\/[A-Za-z0-9_-]{24}$/);

        const list = await owner.client.get(`/api/event/${ev.id}/scanner-links`);
        assert.ok(list.body.some(l => l.id === made.body.link.id));

        assert.equal((await owner.client.del(`/api/scanner-links/${made.body.link.id}`)).status, 200);
        assert.ok(!(await owner.client.get(`/api/event/${ev.id}/scanner-links`)).body.some(l => l.id === made.body.link.id));
    });

    test('a brand-new event gets its first link automatically', async () => {
        const ev = await createEvent(owner.client, { name: 'Auto Link' });
        const list = await owner.client.get(`/api/event/${ev.id}/scanner-links`);
        assert.equal(list.status, 200);
        assert.equal(list.body.length, 1, 'an event with no links should mint one on first read');
    });

    test('the copyable URL stays clean while /scan/:token redirects with ?fresh=1', async () => {
        const ev = await createEvent(owner.client, { name: 'Fresh Redirect' });
        const made = await owner.client.post(`/api/event/${ev.id}/scanner-links`, { label: 'QR' });
        const token = made.body.link.token;

        // The printed link itself carries no cache-busting noise…
        assert.ok(!made.body.link.url.includes('fresh'), 'the copyable link should stay clean');

        // …but following it does, so a device holding a stale service worker
        // from some other app's link is forced to pick up the current one.
        const hop = await anon().get(`/scan/${token}`);
        assert.equal(hop.status, 302);
        const location = hop.headers.get('location');
        assert.match(location, /fresh=1/);
        assert.match(location, new RegExp(`scanToken=${token}|token=${token}`));
    });

    test('resolving a link locks that browser to the one event', async () => {
        const ev = await createEvent(owner.client, { name: 'Locked Event' });
        const elsewhere = await createEvent(owner.client, { name: 'Off Limits' });
        await addTicket(owner.client, elsewhere.id, { name: 'Not Yours' });

        const { client: door, info } = await scanLinkClient(server, owner.client, ev.id);
        assert.equal(info.eventId, ev.id);
        assert.equal(info.eventName, 'Locked Event');
        assert.deepEqual([...info.capabilities].sort(), ['checkin', 'undo_checkin']);

        // Their event list is exactly the one event behind the link.
        const list = await door.get('/api/events');
        assert.equal(list.body.length, 1);
        assert.equal(list.body[0].id, ev.id);

        // And nothing else is reachable.
        assert.equal((await door.get(`/api/event/${elsewhere.id}/tickets`)).status, 401);
    });

    test('/api/auth/me tells the scanner it is on a link rather than signed in', async () => {
        const ev = await createEvent(owner.client, { name: 'Resumed Event' });
        const { client: door } = await scanLinkClient(server, owner.client, ev.id);

        const me = await door.get('/api/auth/me');
        assert.equal(me.status, 200);
        assert.equal(me.body.user, null);
        assert.equal(me.body.scanLink.eventId, ev.id);
        assert.equal(me.body.scanLink.eventName, 'Resumed Event');
        assert.deepEqual([...me.body.scanLink.capabilities].sort(), ['checkin', 'undo_checkin']);
    });

    test('scanning a different event\'s link moves the lock to that event', async () => {
        const first = await createEvent(owner.client, { name: 'First Lock' });
        const second = await createEvent(owner.client, { name: 'Second Lock' });

        const { client: device } = await scanLinkClient(server, owner.client, first.id);
        assert.equal((await device.get('/api/auth/me')).body.scanLink.eventId, first.id);

        const secondLink = (await owner.client.post(`/api/event/${second.id}/scanner-links`, {})).body.link;
        await device.get(`/api/scanner-links/${secondLink.token}`);

        const me = await device.get('/api/auth/me');
        assert.equal(me.body.scanLink.eventId, second.id, 'a new link should re-lock the device, not stack');
        assert.equal((await device.get('/api/events')).body.length, 1);
    });

    test('exiting drops the grant', async () => {
        const ev = await createEvent(owner.client, { name: 'Exit Event' });
        const { client: door } = await scanLinkClient(server, owner.client, ev.id);

        assert.equal((await door.post('/api/scan-link/exit', {})).status, 200);
        assert.equal((await door.get('/api/auth/me')).status, 401);
        assert.equal((await door.get(`/api/event/${ev.id}/tickets`)).status, 401);
    });

    test('revoking a link stops it working immediately, including sessions already on it', async () => {
        const { ev, ticket } = await eventWithTicket({}, 'Revoked Door');
        const { link, client: door } = await scanLinkClient(server, owner.client, ev.id);

        assert.equal((await door.get(`/api/event/${ev.id}/tickets`)).status, 200);

        assert.equal((await owner.client.del(`/api/scanner-links/${link.id}`)).status, 200);

        // The link is re-validated on every use, so a door already holding the
        // session loses access the moment it is revoked.
        assert.equal((await door.get(`/api/event/${ev.id}/tickets`)).status, 401);
        assert.equal((await door.post('/api/validate', { token: ticket.token, eventId: ev.id })).status, 401);
        assert.equal((await anon().get(`/api/scanner-links/${link.token}`)).status, 404);
    });

    test('creating one needs manage_event', async () => {
        const ev = await createEvent(owner.client, { name: 'Link Guard' });
        const stranger = await newUser(server);
        assert.equal((await stranger.client.post(`/api/event/${ev.id}/scanner-links`, {})).status, 403);
        assert.equal((await anon().post(`/api/event/${ev.id}/scanner-links`, {})).status, 401);
    });

    test('an unknown token resolves to nothing', async () => {
        assert.equal((await anon().get('/api/scanner-links/made-up-token')).status, 404);
    });

    test('resolving always says what the caller may actually do on that event', async () => {
        // The scanner page refuses to enter an event unless the answer grants
        // check-in, so this response is what authorizes the switch.
        const ev = await createEvent(owner.client, { name: 'Capability Answer' });
        const link = (await owner.client.post(`/api/event/${ev.id}/scanner-links`, {})).body.link;

        const anonymous = await anon().get(`/api/scanner-links/${link.token}`);
        assert.ok(anonymous.body.capabilities.includes('checkin'));

        // A signed-in stranger holding the link gets standing check-in access
        // to that one event — the link is the credential.
        const stranger = await newUser(server);
        const before = (await stranger.client.get('/api/events')).body;
        assert.ok(!before.some(e => e.id === ev.id), 'no access before the link is used');

        const resolved = await stranger.client.get(`/api/scanner-links/${link.token}`);
        assert.equal(resolved.status, 200);
        assert.ok(resolved.body.capabilities.includes('checkin'));

        const seen = (await stranger.client.get('/api/events')).body.find(e => e.id === ev.id);
        assert.deepEqual(seen.capabilities, ['checkin'], 'a scan link confers check-in and nothing more');
    });
});

describe('the door display', () => {
    test('hands out a token and a URL carrying ?fresh=1', async () => {
        const ev = await createEvent(owner.client, { name: 'Display Event' });
        const r = await owner.client.get(`/api/display/token/${ev.id}`);
        assert.equal(r.status, 200);
        assert.ok(r.body.token?.length >= 32);
        assert.match(r.body.url, /display\.html\?token=.+fresh=1/);
    });

    test('the display page reads its own event by token, with no login', async () => {
        const ev = await createEvent(owner.client, { name: 'Shown Event' });
        await addTicket(owner.client, ev.id, { name: 'Counted Guest' });
        const { token } = (await owner.client.get(`/api/display/token/${ev.id}`)).body;

        const info = await anon().get(`/api/display/info/${token}`);
        assert.equal(info.status, 200);
        assert.equal(info.body.event.name, 'Shown Event');
        assert.equal(info.body.total, 1);
        assert.equal(info.body.scanned, 0);
    });

    test('rotating the token invalidates the old one', async () => {
        const ev = await createEvent(owner.client, { name: 'Rotated Display' });
        const { token: oldToken } = (await owner.client.get(`/api/display/token/${ev.id}`)).body;

        const rotated = await owner.client.post(`/api/display/token/${ev.id}/rotate`, {});
        assert.equal(rotated.status, 200);
        assert.notEqual(rotated.body.token, oldToken);

        assert.equal((await anon().get(`/api/display/info/${oldToken}`)).status, 404);
        assert.equal((await anon().get(`/api/display/info/${rotated.body.token}`)).status, 200);
    });

    test('door staff on a scan link can open the display for their event', async () => {
        const ev = await createEvent(owner.client, { name: 'Staff Display' });
        const { client: door } = await scanLinkClient(server, owner.client, ev.id);

        const r = await door.get(`/api/display/token/${ev.id}`);
        assert.equal(r.status, 200, 'the scan link tab bar needs this to open the display screen');
        assert.ok(r.body.token);

        const qr = await door.get(`/api/display/qr/${ev.id}`, { raw: true });
        assert.equal(qr.status, 200);
        assert.equal(qr.headers.get('content-type'), 'image/png');
    });

    test('a stranger cannot get a display token', async () => {
        const ev = await createEvent(owner.client, { name: 'Guarded Display' });
        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/display/token/${ev.id}`)).status, 403);
        assert.equal((await anon().get(`/api/display/token/${ev.id}`)).status, 401);
    });

    test('an unknown display token shows nothing', async () => {
        assert.equal((await anon().get('/api/display/info/nope')).status, 404);
    });
});

describe('the shuttle / external ticket check', () => {
    test('is refused unless the organiser opts the event in', async () => {
        const { ev, ticket } = await eventWithTicket({}, 'Bus Rider');
        const r = await anon().post('/api/ticket-check', { token: ticket.token, eventId: ev.id });
        assert.equal(r.status, 403);
    });

    test('reads a ticket without ever consuming it', async () => {
        const { ev, ticket } = await eventWithTicket({}, 'Bus Rider');
        await owner.client.put(`/api/event/${ev.id}/shuttle-link-enabled`, { enabled: true });

        for (let i = 0; i < 3; i++) {
            const r = await anon().post('/api/ticket-check', { token: ticket.token, eventId: ev.id, source: 'shuttle' });
            assert.equal(r.status, 200);
            assert.equal(r.body.valid, true, 'a rider should be able to board more than once');
            assert.equal(r.body.name, 'Bus Rider');
        }

        const [untouched] = await listTickets(owner.client, ev.id);
        assert.equal(untouched.used_at, null, 'the shuttle check must never mark a ticket used');
    });

    test('will not read a ticket belonging to another event', async () => {
        const { ticket } = await eventWithTicket({}, 'Other Event Rider');
        const shuttleEvent = await createEvent(owner.client, { name: 'Shuttle Event' });
        await owner.client.put(`/api/event/${shuttleEvent.id}/shuttle-link-enabled`, { enabled: true });

        const r = await anon().post('/api/ticket-check', { token: ticket.token, eventId: shuttleEvent.id });
        assert.equal(r.body.valid, false);
    });

    test('needs both a token and an event', async () => {
        assert.equal((await anon().post('/api/ticket-check', { token: 'x' })).status, 400);
        assert.equal((await anon().post('/api/ticket-check', { eventId: 'x' })).status, 400);
    });
});
