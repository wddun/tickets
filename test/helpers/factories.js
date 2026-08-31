// Shared setup steps, written the way the real clients do them.
//
// Signing up really does require clicking a link in an email, so `newUser`
// pulls the verification URL back out of the captured mail rather than
// writing to the database behind the server's back. Every helper here goes
// through the public HTTP API for the same reason: if a helper can't do it,
// neither can a browser or the iOS app.
import assert from 'node:assert/strict';
import { createClient } from './client.js';
import { ADMIN_EMAIL, TEST_PASSWORD } from './server.js';

let seq = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}-${Date.now().toString(36)}-${seq++}@test.local`;

/** Signs up, verifies the emailed link, logs in. Returns a ready client. */
export async function newUser(server, email = uniqueEmail(), password = TEST_PASSWORD) {
    const client = createClient(server.base);
    const signup = await client.post('/api/auth/signup', { email, password });
    assert.equal(signup.status, 200, `signup failed: ${signup.text}`);

    const mail = await server.waitForEmail(m => m.to === email.toLowerCase() && /Verify/i.test(m.subject));
    const token = (mail.html.match(/verify-email\.html\?token=([a-f0-9]+)/) || [])[1];
    assert.ok(token, 'no verification token in the signup email');

    const verify = await client.get(`/api/auth/verify/${token}`);
    assert.ok(verify.status < 400, `verify failed: ${verify.status}`);

    const login = await client.post('/api/auth/login', { email, password });
    assert.equal(login.status, 200, `login failed: ${login.text}`);

    const me = await client.get('/api/auth/me');
    return { client, email: email.toLowerCase(), password, userId: me.body?.user?.id, me: me.body };
}

/** The one admin account, created through the one-time setup route. */
export async function newAdmin(server, password = TEST_PASSWORD) {
    const client = createClient(server.base);
    const setup = await client.post('/api/auth/setup-admin', { password });
    assert.equal(setup.status, 200, `setup-admin failed: ${setup.text}`);
    const me = await client.get('/api/auth/me');
    return { client, email: ADMIN_EMAIL, password, userId: me.body?.user?.id, me: me.body };
}

export async function createEvent(client, fields = {}) {
    const r = await client.post('/api/events', {
        name: fields.name || `Test Event ${seq++}`,
        time: fields.time || new Date(Date.now() + 86400000).toISOString(),
        endTime: fields.endTime || null,
        locationName: fields.locationName,
        locationAddress: fields.locationAddress,
        color: fields.color,
        timezone: fields.timezone,
    });
    assert.equal(r.status, 200, `createEvent failed: ${r.text}`);
    const event = r.body.event || r.body;

    // The remaining knobs each have their own endpoint, matching how the
    // dashboard saves them.
    if (fields.capacity != null) await setCapacity(client, event.id, fields.capacity);
    if (fields.ticketExpiresAt != null) await setTicketExpiresAt(client, event.id, fields.ticketExpiresAt);
    if (fields.ticketExpiryLimit != null || fields.ticketExpiryOrder != null) {
        await setTicketExpiryScope(client, event.id, { limit: fields.ticketExpiryLimit ?? null, order: fields.ticketExpiryOrder ?? 'oldest' });
    }
    if (fields.publicRegistration) await client.put(`/api/event/${event.id}/public-registration`, { enabled: true });
    if (fields.waitlist) await client.put(`/api/event/${event.id}/waitlist-enabled`, { enabled: true });
    if (fields.ticketPrice != null) await setTicketPrice(client, event.id, fields.ticketPrice);
    if (fields.limits) await client.put(`/api/event/${event.id}/registration-limits`, fields.limits);

    const fresh = await client.get(`/api/event/${event.id}`);
    return fresh.body || event;
}

/**
 * PUT /api/event/:id is a multipart form (it can carry an image), so edits go
 * through FormData exactly like the dashboard's save.
 */
export async function updateEvent(client, event, changes = {}) {
    const fd = new FormData();
    fd.append('name', changes.name ?? event.name ?? '');
    fd.append('time', changes.time ?? event.time ?? '');
    fd.append('endTime', changes.endTime ?? event.endTime ?? '');
    fd.append('color', changes.color ?? event.color ?? 'rgb(99, 102, 241)');
    fd.append('locationName', changes.locationName ?? event.location?.name ?? '');
    fd.append('locationAddress', changes.locationAddress ?? event.location?.address ?? '');
    fd.append('allowReentry', String(changes.allowReentry ?? !!event.allowReentry));
    if ('capacity' in changes) fd.append('capacity', changes.capacity === null ? '' : String(changes.capacity));
    else if (event.capacity) fd.append('capacity', String(event.capacity));
    if ('ticketPrice' in changes) fd.append('ticketPrice', String(changes.ticketPrice));
    else if (event.ticketPrice) fd.append('ticketPrice', String(event.ticketPrice / 100));
    if ('ticketExpiresAt' in changes) fd.append('ticketExpiresAt', changes.ticketExpiresAt === null ? '' : String(changes.ticketExpiresAt));
    else if (event.ticketExpiresAt) fd.append('ticketExpiresAt', event.ticketExpiresAt);
    if ('ticketExpiryLimit' in changes) fd.append('ticketExpiryLimit', changes.ticketExpiryLimit === null ? '' : String(changes.ticketExpiryLimit));
    else if (event.ticketExpiryLimit) fd.append('ticketExpiryLimit', String(event.ticketExpiryLimit));
    if ('ticketExpiryOrder' in changes) fd.append('ticketExpiryOrder', changes.ticketExpiryOrder || 'oldest');
    else if (event.ticketExpiryOrder) fd.append('ticketExpiryOrder', event.ticketExpiryOrder);
    return client.put(`/api/event/${event.id}`, undefined, { form: fd });
}

export async function setCapacity(client, eventId, capacity) {
    const cur = (await client.get(`/api/event/${eventId}`)).body;
    return updateEvent(client, cur, { capacity });
}

/** `iso` is a full ISO datetime string, or null to clear it. */
export async function setTicketExpiresAt(client, eventId, iso) {
    const cur = (await client.get(`/api/event/${eventId}`)).body;
    return updateEvent(client, cur, { ticketExpiresAt: iso });
}

/** `limit` is null/undefined for "expire everyone" (the default); `order` is 'oldest' | 'newest'. */
export async function setTicketExpiryScope(client, eventId, { limit = null, order = 'oldest' } = {}) {
    const cur = (await client.get(`/api/event/${eventId}`)).body;
    return updateEvent(client, cur, { ticketExpiryLimit: limit, ticketExpiryOrder: order });
}

/** `ticketPrice` here is dollars, as the form field is. */
export async function setTicketPrice(client, eventId, dollars) {
    const cur = (await client.get(`/api/event/${eventId}`)).body;
    return updateEvent(client, cur, { ticketPrice: dollars });
}

/** Manual add from the dashboard. Returns the created tickets. */
export async function addTicket(client, eventId, { name = 'Manual Guest', email = uniqueEmail('guest'), ticketCount = 1, noEmail = true } = {}) {
    const r = await client.post(`/api/event/${eventId}/ticket`, { name, email, ticketCount, noEmail });
    assert.equal(r.status, 200, `addTicket failed: ${r.text}`);
    return r.body;
}

/** Public self-registration, as register.html performs it. */
export async function publicRegister(client, eventId, { name = 'Walk Up', email = uniqueEmail('public'), holdToken } = {}) {
    return client.post('/api/register', { name, email, eventId, holdToken });
}

/** Every ticket for an event, via the API the dashboard/app use. */
export async function listTickets(client, eventId) {
    const r = await client.get(`/api/event/${eventId}/tickets`);
    assert.equal(r.status, 200, `listTickets failed: ${r.text}`);
    return r.body;
}

/** Creates a scan link and returns { link, client } where the client has resolved it. */
export async function scanLinkClient(server, ownerClient, eventId, label = 'Door 1') {
    const made = await ownerClient.post(`/api/event/${eventId}/scanner-links`, { label });
    assert.equal(made.status, 200, `scanner-link create failed: ${made.text}`);
    const link = made.body.link;

    const staff = createClient(server.base);
    const resolved = await staff.get(`/api/scanner-links/${link.token}`);
    assert.equal(resolved.status, 200, `scan link resolve failed: ${resolved.text}`);
    return { link, client: staff, info: resolved.body };
}

/** The apiKey used by the Google Sheets / external integration routes. */
export async function eventApiKey(client, eventId) {
    const r = await client.get(`/api/event/${eventId}/api-key`);
    assert.equal(r.status, 200, `api-key failed: ${r.text}`);
    return r.body.apiKey;
}

/** Shares an event with another user at the given capabilities. */
export async function share(ownerClient, eventId, email, capabilities) {
    return ownerClient.post('/api/sheet/share', { eventId, email, capabilities });
}
