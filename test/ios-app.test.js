// The exact API surface the iOS app uses, called the way APIService.swift
// calls it.
//
// The Swift models decode with non-optional fields, and every call site does
// `guard http.statusCode == 200`, so a renamed key or a changed status code
// doesn't degrade in the app — it throws. These tests hold that contract:
// each response is checked for the keys Item.swift declares as required.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, TEST_PASSWORD } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, addTicket, listTickets, scanLinkClient, uniqueEmail } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const anon = () => createClient(server.base);

/** JSONEncoder().encode([String: String]) — every value the app sends is a string. */
const iosBody = (obj) => {
    for (const [k, v] of Object.entries(obj)) {
        assert.equal(typeof v, 'string', `the app sends ${k} as a string`);
    }
    return obj;
};

const requireKeys = (obj, keys, what) => {
    for (const k of keys) {
        assert.notEqual(obj?.[k], undefined, `${what}: Swift decodes "${k}" as non-optional, but it is missing`);
        assert.notEqual(obj?.[k], null, `${what}: Swift decodes "${k}" as non-optional, but it is null`);
    }
};

describe('signing in from the app', () => {
    test('login then getCurrentUser returns an AuthUserResponse', async () => {
        const user = await newUser(server);
        const app = createClient(server.base);

        const login = await app.post('/api/auth/login', { email: user.email, password: TEST_PASSWORD });
        assert.equal(login.status, 200);

        // AuthUserResponse { user: AuthUser { id, email, isAdmin? } }
        const me = await app.get('/api/auth/me');
        assert.equal(me.status, 200);
        requireKeys(me.body, ['user'], 'AuthUserResponse');
        requireKeys(me.body.user, ['id', 'email'], 'AuthUser');
        assert.equal(typeof me.body.user.isAdmin, 'boolean');
    });

    test('a bad password is a 401, which the app turns into .unauthorized', async () => {
        const user = await newUser(server);
        const app = createClient(server.base);
        assert.equal((await app.post('/api/auth/login', { email: user.email, password: 'wrong' })).status, 401);
    });

    test('checkAuth on a fresh install is a 401, not an empty 200', async () => {
        // The app branches on the status code to decide whether to show the
        // login screen, so a 200 with a null user would keep it stuck.
        assert.equal((await anon().get('/api/auth/me')).status, 401);
    });

    test('logout ends the session', async () => {
        const user = await newUser(server);
        assert.equal((await user.client.post('/api/auth/logout', {})).status, 200);
        assert.equal((await user.client.get('/api/auth/me')).status, 401);
    });
});

describe('the events tab', () => {
    test('getEvents decodes as [Event] with the fields the app reads', async () => {
        const ev = await createEvent(owner.client, {
            name: 'App Event', locationName: 'The Hall', locationAddress: '1 Main St',
        });

        const list = await owner.client.get('/api/events');
        assert.equal(list.status, 200);
        assert.ok(Array.isArray(list.body), 'Swift decodes this as an array');

        const seen = list.body.find(e => e.id === ev.id);
        requireKeys(seen, ['id', 'name'], 'Event');
        assert.equal(typeof seen.fullAccess, 'boolean', 'the app gates undo on fullAccess');
        assert.equal(seen.userId, owner.userId);
        assert.equal(seen.location.name, 'The Hall');
        // ticketPrice is cents, and the app treats 0/nil as free.
        assert.ok(seen.ticketPrice === 0 || seen.ticketPrice == null || typeof seen.ticketPrice === 'number');
    });

    test('getTickets decodes as [Ticket]', async () => {
        const ev = await createEvent(owner.client, { name: 'App Tickets' });
        await addTicket(owner.client, ev.id, { name: 'Grace Hopper' });

        const r = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.body));

        const t = r.body[0];
        requireKeys(t, ['id', 'token', 'registrationId', 'eventId', 'name'], 'Ticket');
        // used_at is `var used_at: String?` — present as null before check-in.
        assert.equal(t.used_at, null);
    });

    test('getTickets for an event the account cannot see is a 401', async () => {
        const ev = await createEvent(owner.client, { name: 'Private Event' });
        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/event/${ev.id}/tickets`)).status, 401);
    });
});

describe('the scanner tab', () => {
    test('validateTicket returns a ValidateResponse the app can decode', async () => {
        const ev = await createEvent(owner.client, { name: 'App Scan' });
        await addTicket(owner.client, ev.id, { name: 'Alan Turing' });
        const [ticket] = await listTickets(owner.client, ev.id);

        const r = await owner.client.post('/api/validate', iosBody({
            token: `ticket:${ticket.token}`,
            eventId: ev.id,
            pairToken: 'ios-pair-token-1',
        }));

        assert.equal(r.status, 200, 'the app throws on any non-200');
        requireKeys(r.body, ['status'], 'ValidateResponse');
        assert.equal(r.body.status, 'valid');
        assert.equal(r.body.name, 'Alan Turing');
        assert.equal(r.body.eventName, 'App Scan');
        assert.ok(r.body.registrationId);
        assert.ok(r.body.ticketId);
    });

    test('an already-used ticket still comes back 200 so the app can show it', async () => {
        const ev = await createEvent(owner.client, { name: 'App Rescan' });
        await addTicket(owner.client, ev.id, { name: 'Twice Scanned' });
        const [ticket] = await listTickets(owner.client, ev.id);

        await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        const again = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });

        assert.equal(again.status, 200, 'a used ticket must not be an HTTP error — the app would show a generic failure');
        assert.equal(again.body.status, 'used');
        assert.ok(again.body.used_at);
    });

    test('an unreadable QR code is a 200 "invalid", not an error', async () => {
        const r = await owner.client.post('/api/validate', { token: 'garbage-from-a-random-qr' });
        assert.equal(r.status, 200);
        assert.equal(r.body.status, 'invalid');
    });

    test('checkIn, checkInTicket and undoCheckIn all answer 200', async () => {
        const ev = await createEvent(owner.client, { name: 'App Manual' });
        await addTicket(owner.client, ev.id, { name: 'Manual Person' });
        const [ticket] = await listTickets(owner.client, ev.id);

        assert.equal((await owner.client.post(`/api/checkin/${ticket.registrationId}`, {})).status, 200);
        assert.equal((await owner.client.del(`/api/checkin/${ticket.registrationId}`)).status, 200);

        // checkInTicket passes a ticket id to the same route.
        assert.equal((await owner.client.post(`/api/checkin/${ticket.id}`, {})).status, 200);
        assert.ok((await listTickets(owner.client, ev.id))[0].used_at);
    });

    test('confirmCheckout completes a re-entry check-out', async () => {
        const ev = await createEvent(owner.client, { name: 'App Reentry' });
        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('allowReentry', 'true');
        await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });

        await addTicket(owner.client, ev.id, { name: 'Steps Outside' });
        const [ticket] = await listTickets(owner.client, ev.id);
        await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });

        const out = await owner.client.post('/api/checkout', iosBody({
            token: ticket.token,
            pairToken: 'ios-pair-token-2',
        }));
        assert.equal(out.status, 200);

        // Back in through the door: the next scan is a welcome-back.
        const back = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(back.body.status, 'reentry_enter');
    });

    test('confirmCheckoutByRegistrationId works the same way', async () => {
        const ev = await createEvent(owner.client, { name: 'App Reentry By Reg' });
        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('allowReentry', 'true');
        await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });

        await addTicket(owner.client, ev.id, { name: 'Reg Id Exit' });
        const [ticket] = await listTickets(owner.client, ev.id);
        await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });

        const out = await owner.client.post('/api/checkout', iosBody({
            registrationId: ticket.registrationId,
            pairToken: 'ios-pair-token-3',
        }));
        assert.equal(out.status, 200);
    });

    test('check-out on an event without re-entry is refused', async () => {
        const ev = await createEvent(owner.client, { name: 'No Reentry' });
        await addTicket(owner.client, ev.id, { name: 'One Way' });
        const [ticket] = await listTickets(owner.client, ev.id);
        await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });

        const out = await owner.client.post('/api/checkout', { token: ticket.token, pairToken: 'p' });
        assert.equal(out.status, 400);
    });
});

describe('the app on a no-login scan link', () => {
    test('resolveScannerLink returns a ScannerLinkInfo', async () => {
        const ev = await createEvent(owner.client, { name: 'App Link Event', color: 'rgb(1, 2, 3)' });
        const made = await owner.client.post(`/api/event/${ev.id}/scanner-links`, { label: 'iPhone at the gate' });
        const token = made.body.link.token;

        const device = createClient(server.base);
        const info = await device.get(`/api/scanner-links/${token}`);
        assert.equal(info.status, 200);
        // ScannerLinkInfo { eventId, eventName, color?, allowReentry? }
        requireKeys(info.body, ['eventId', 'eventName'], 'ScannerLinkInfo');
        assert.equal(info.body.eventId, ev.id);
        assert.equal(info.body.eventName, 'App Link Event');
    });

    test('the app can scan with the link token in the body, with no session', async () => {
        const ev = await createEvent(owner.client, { name: 'App Link Scan' });
        await addTicket(owner.client, ev.id, { name: 'Link Scanned' });
        const [ticket] = await listTickets(owner.client, ev.id);
        const token = (await owner.client.post(`/api/event/${ev.id}/scanner-links`, {})).body.link.token;

        // A fresh install with no cookies at all — the persisted token is the
        // only credential it has.
        const device = createClient(server.base);
        const r = await device.post('/api/validate', iosBody({
            token: ticket.token,
            eventId: ev.id,
            scanLinkToken: token,
            pairToken: 'ios-link-pair',
        }));
        assert.equal(r.status, 200);
        assert.equal(r.body.status, 'valid');
    });

    test('a revoked link stops the app scanning', async () => {
        const ev = await createEvent(owner.client, { name: 'App Link Revoked' });
        await addTicket(owner.client, ev.id, { name: 'After Revoke' });
        const [ticket] = await listTickets(owner.client, ev.id);
        const link = (await owner.client.post(`/api/event/${ev.id}/scanner-links`, {})).body.link;

        await owner.client.del(`/api/scanner-links/${link.id}`);

        const device = createClient(server.base);
        const r = await device.post('/api/validate', { token: ticket.token, eventId: ev.id, scanLinkToken: link.token });
        assert.equal(r.status, 401);
    });
});

describe('at-door sales from the app', () => {
    test('issues a free ticket and returns it', async () => {
        const ev = await createEvent(owner.client, { name: 'App At Door' });
        await owner.client.put(`/api/event/${ev.id}/at-door`, { enabled: true });

        const r = await owner.client.post(`/api/event/${ev.id}/at-door-register`, iosBody({
            name: 'Walk Up Sale', email: uniqueEmail('atdoor'),
        }));
        assert.equal(r.status, 200);
        requireKeys(r.body, ['ticket'], 'AtDoorRegisterResponse');
        assert.ok(r.body.ticket.token);

        assert.equal((await listTickets(owner.client, ev.id)).length, 1);
    });

    test('is refused until the organiser enables it', async () => {
        const ev = await createEvent(owner.client, { name: 'App At Door Off' });
        const r = await owner.client.post(`/api/event/${ev.id}/at-door-register`, { name: 'Too Early' });
        assert.equal(r.status, 403);
    });

    test('is refused on a paid event — those go through the QR checkout instead', async () => {
        const ev = await createEvent(owner.client, { name: 'App At Door Paid', ticketPrice: 20 });
        await owner.client.put(`/api/event/${ev.id}/at-door`, { enabled: true });

        const r = await owner.client.post(`/api/event/${ev.id}/at-door-register`, { name: 'Cash Please' });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /paid/i);
    });
});

describe('display pairing and the monitor heartbeat', () => {
    test('getDisplayToken returns a DisplayTokenResponse', async () => {
        const ev = await createEvent(owner.client, { name: 'App Display' });
        const r = await owner.client.get(`/api/display/token/${ev.id}`);
        assert.equal(r.status, 200);
        // DisplayTokenResponse { token: String, url: String } — both non-optional.
        requireKeys(r.body, ['token', 'url'], 'DisplayTokenResponse');
    });

    test('a heartbeat registers the device on the monitor', async () => {
        const ev = await createEvent(owner.client, { name: 'App Heartbeat' });
        const pairToken = 'ios-heartbeat-' + Date.now();

        const r = await owner.client.post('/api/scan/heartbeat', iosBody({
            pairToken,
            platform: 'ios-app',
            deviceName: 'Test iPhone',
            osVersion: 'iOS 17.0',
            appVersion: '1.4.2',
            pushEnabled: 'true',
            eventId: ev.id,
        }));
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);

        const scanners = await owner.client.get('/api/monitor/scanners');
        assert.equal(scanners.status, 200);
        const mine = (scanners.body.scanners || scanners.body).find(s => s.pairToken === pairToken);
        assert.ok(mine, 'the scanner did not appear on the monitor');
        assert.equal(mine.platform, 'ios-app');
        assert.equal(mine.deviceName, 'Test iPhone');
        assert.equal(mine.appVersion, '1.4.2');
        assert.equal(mine.pushEnabled, true, 'pushEnabled arrives as the string "true" and must be read as a boolean');
    });

    test('a heartbeat with no push token does not wipe a known one', async () => {
        const pairToken = 'ios-token-keep-' + Date.now();
        await owner.client.post('/api/scan/heartbeat', {
            pairToken, platform: 'ios-app', deviceName: 'Token Phone', pushToken: 'apns-token-abc',
        });
        await owner.client.post('/api/scan/heartbeat', {
            pairToken, platform: 'ios-app', deviceName: 'Token Phone',
        });

        const scanners = await owner.client.get('/api/monitor/scanners');
        const mine = (scanners.body.scanners || scanners.body).find(s => s.pairToken === pairToken);
        assert.equal(mine.pushToken, 'apns-token-abc', 'a heartbeat without a token must not clear the stored one');
    });
});

describe('push notification settings', () => {
    test('registering a device token is accepted', async () => {
        const r = await owner.client.post('/api/push/register', { token: 'a'.repeat(64) });
        assert.equal(r.status, 200);
    });

    test('per-event subscription round-trips', async () => {
        const ev = await createEvent(owner.client, { name: 'App Push' });

        const before = await owner.client.get(`/api/event/${ev.id}/push-subscription`);
        assert.equal(before.status, 200);
        assert.equal(typeof before.body.enabled, 'boolean', 'PushSubscriptionResponse.enabled is non-optional');

        assert.equal((await owner.client.patch(`/api/event/${ev.id}/push-subscription`, { enabled: true })).status, 200);
        assert.equal((await owner.client.get(`/api/event/${ev.id}/push-subscription`)).body.enabled, true);

        await owner.client.patch(`/api/event/${ev.id}/push-subscription`, { enabled: false });
        assert.equal((await owner.client.get(`/api/event/${ev.id}/push-subscription`)).body.enabled, false);
    });

    test('push endpoints need a session', async () => {
        const ev = await createEvent(owner.client, { name: 'App Push Guard' });
        assert.equal((await anon().post('/api/push/register', { token: 'x' })).status, 401);
        assert.equal((await anon().get(`/api/event/${ev.id}/push-subscription`)).status, 401);
    });
});
