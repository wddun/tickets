// Ticket-expiry cutoff customization: events.ticketExpiryLimit/ticketExpiryOrder
// let an organiser expire only some not-checked-in tickets when the cutoff
// (events.ticketExpiresAt) is reached, oldest- or newest-registered first,
// instead of the original all-or-nothing sweep. See ticketsEligibleForExpiry()
// in server.js for the selection logic this exercises.
//
// The cutoff only ever does anything when it would free a seat for someone —
// the event must have its waitlist enabled, at least one person still
// 'waiting', and the event must actually be full. Every test below that
// expects real expiry to happen sets capacity equal to the ticket count it
// registers (so the event is exactly full) and enables the waitlist with at
// least one waiter present, purely to satisfy that precondition — most of
// these tests are otherwise unconcerned with the waitlist itself (the
// "waitlist integration" describe block below is where that's the point).
//
// Both trigger paths run through the real, unmocked pipeline: an already-past
// cutoff saved directly (PUT /api/event/:id's immediate-expire branch) and a
// future one caught by the periodic sweep (TICKET_EXPIRY_SWEEP_MS shrunk here,
// the same test-only hook waitlist-automation.test.js uses for its own sweep).
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import {
    newUser, createEvent, addTicket, listTickets, uniqueEmail,
    setTicketExpiresAt, setTicketExpiryScope,
} from './helpers/factories.js';
import { createClient } from './helpers/client.js';

let server, owner;
before(async () => {
    server = await startServer({ env: { TICKET_EXPIRY_SWEEP_MS: '300' } });
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const visitor = () => createClient(server.base);

async function waitFor(pred, timeoutMs = 4000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const result = await pred();
        if (result) return result;
        if (Date.now() > until) throw new Error('condition never became true');
        await new Promise(r => setTimeout(r, 50));
    }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// created_at is millisecond-resolution; registrations meant to sort
// deterministically (oldest/newest tests) are spaced apart so ties can't
// happen — the app itself breaks equal-timestamp ties by rowid elsewhere
// (see waitlistPosition), but ticketsEligibleForExpiry deliberately mirrors
// no-show-release's simpler string-sort with no tiebreak, so tests must not
// rely on same-millisecond ordering.
async function addSpacedRegistration(client, eventId, opts) {
    await sleep(15);
    return addTicket(client, eventId, opts);
}

async function ticketFor(ownerClient, eventId, email) {
    const tickets = await listTickets(ownerClient, eventId);
    return tickets.find(t => t.email === email);
}

// The expiry cutoff only fires when the event is full and someone is
// waiting — see the file-level comment above. Joins one waiter so a test's
// event satisfies that precondition.
async function addWaiter(eventId, tag) {
    const email = uniqueEmail(tag);
    await visitor().post(`/api/event/${eventId}/waitlist`, { name: tag, email });
    return email;
}

describe('no limit set — capped by how many are actually waiting', () => {
    test('a past cutoff on save expires only as many tickets as there are waiters, oldest first', async () => {
        const ev = await createEvent(owner.client, { capacity: 3, waitlist: true });
        const emails = [uniqueEmail('all-a'), uniqueEmail('all-b'), uniqueEmail('all-c')];
        await addSpacedRegistration(owner.client, ev.id, { name: 'A', email: emails[0] });
        await addSpacedRegistration(owner.client, ev.id, { name: 'B', email: emails[1] });
        await addSpacedRegistration(owner.client, ev.id, { name: 'C', email: emails[2] });
        await addWaiter(ev.id, 'all-waiter');

        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        // Only one waiter, so only the single oldest registration should
        // expire — expiring the other two would just cancel a ticket with
        // nobody to hand the seat to.
        const tickets = await listTickets(owner.client, ev.id);
        assert.ok(tickets.find(t => t.email === emails[0]).expiredAt, 'the oldest registration should expire');
        assert.equal(tickets.find(t => t.email === emails[1]).expiredAt, null, 'no waiter left to receive this seat');
        assert.equal(tickets.find(t => t.email === emails[2]).expiredAt, null, 'no waiter left to receive this seat');
    });

    test('a freshly created event has no limit and defaults to oldest order', async () => {
        const ev = await createEvent(owner.client, {});
        assert.equal(ev.ticketExpiryLimit, null);
        assert.equal(ev.ticketExpiryOrder, 'oldest');
    });
});

describe('limited by count — oldest registrations first (the default order)', () => {
    test('only the oldest N registrations expire; newer ones stay active', async () => {
        const ev = await createEvent(owner.client, { capacity: 3, waitlist: true });
        const firstEmail = uniqueEmail('exp-oldest-1');
        const secondEmail = uniqueEmail('exp-oldest-2');
        const thirdEmail = uniqueEmail('exp-oldest-3');
        await addSpacedRegistration(owner.client, ev.id, { name: 'First', email: firstEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Second', email: secondEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Third', email: thirdEmail });
        await addWaiter(ev.id, 'exp-oldest-waiter');

        await setTicketExpiryScope(owner.client, ev.id, { limit: 2, order: 'oldest' });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        assert.ok((await ticketFor(owner.client, ev.id, firstEmail)).expiredAt, 'oldest registration should expire');
        assert.ok((await ticketFor(owner.client, ev.id, secondEmail)).expiredAt, 'second-oldest registration should expire');
        assert.equal((await ticketFor(owner.client, ev.id, thirdEmail)).expiredAt, null, 'newest registration should stay active');
    });

    test('the future-cutoff sweep respects the same limit and order', async () => {
        const ev = await createEvent(owner.client, { capacity: 3, waitlist: true });
        const firstEmail = uniqueEmail('sweep-oldest-1');
        const secondEmail = uniqueEmail('sweep-oldest-2');
        const thirdEmail = uniqueEmail('sweep-oldest-3');
        await addSpacedRegistration(owner.client, ev.id, { name: 'First', email: firstEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Second', email: secondEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Third', email: thirdEmail });
        await addWaiter(ev.id, 'sweep-oldest-waiter');

        await setTicketExpiryScope(owner.client, ev.id, { limit: 2, order: 'oldest' });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() + 150).toISOString());

        await waitFor(async () => (await ticketFor(owner.client, ev.id, secondEmail))?.expiredAt);
        assert.ok((await ticketFor(owner.client, ev.id, firstEmail)).expiredAt);
        assert.equal((await ticketFor(owner.client, ev.id, thirdEmail)).expiredAt, null);
    });
});

describe('limited by count — newest registrations first', () => {
    test('only the newest N registrations expire; older ones stay active', async () => {
        const ev = await createEvent(owner.client, { capacity: 3, waitlist: true });
        const firstEmail = uniqueEmail('exp-newest-1');
        const secondEmail = uniqueEmail('exp-newest-2');
        const thirdEmail = uniqueEmail('exp-newest-3');
        await addSpacedRegistration(owner.client, ev.id, { name: 'First', email: firstEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Second', email: secondEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Third', email: thirdEmail });
        await addWaiter(ev.id, 'exp-newest-waiter');

        await setTicketExpiryScope(owner.client, ev.id, { limit: 2, order: 'newest' });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        assert.equal((await ticketFor(owner.client, ev.id, firstEmail)).expiredAt, null, 'oldest registration should stay active');
        assert.ok((await ticketFor(owner.client, ev.id, secondEmail)).expiredAt, 'second-newest registration should expire');
        assert.ok((await ticketFor(owner.client, ev.id, thirdEmail)).expiredAt, 'newest registration should expire');
    });
});

describe('registration grouping', () => {
    test('a multi-ticket registration expires as a whole, even running over the limit', async () => {
        const ev = await createEvent(owner.client, { capacity: 5, waitlist: true });
        const soloEmail = uniqueEmail('group-solo');
        const familyEmail = uniqueEmail('group-family');
        const laterEmail = uniqueEmail('group-later');
        await addSpacedRegistration(owner.client, ev.id, { name: 'Solo', email: soloEmail, ticketCount: 1 });
        const family = await addSpacedRegistration(owner.client, ev.id, { name: 'Family', email: familyEmail, ticketCount: 3 });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Later', email: laterEmail, ticketCount: 1 });
        assert.equal(family.tickets.length, 3);
        await addWaiter(ev.id, 'group-waiter');

        // Limit of 2 lands mid-registration once the solo ticket is counted —
        // the whole 3-ticket family registration must still go together.
        await setTicketExpiryScope(owner.client, ev.id, { limit: 2, order: 'oldest' });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        const tickets = await listTickets(owner.client, ev.id);
        assert.ok(tickets.find(t => t.email === soloEmail).expiredAt);
        assert.ok(tickets.filter(t => t.email === familyEmail).every(t => t.expiredAt), 'every ticket in the family registration should expire together');
        assert.equal(tickets.filter(t => t.email === familyEmail && t.expiredAt).length, 3);
        assert.equal(tickets.find(t => t.email === laterEmail).expiredAt, null);

        const expiredCount = tickets.filter(t => t.expiredAt).length;
        assert.equal(expiredCount, 4, 'expiring the family registration whole should run over the limit of 2');
    });
});

describe('waitlist integration', () => {
    test('expiring a limited batch promotes exactly that many off the waitlist, oldest waiting first', async () => {
        const ev = await createEvent(owner.client, { capacity: 3, waitlist: true });
        const firstEmail = uniqueEmail('wl-seat-1');
        const secondEmail = uniqueEmail('wl-seat-2');
        const thirdEmail = uniqueEmail('wl-seat-3');
        await addSpacedRegistration(owner.client, ev.id, { name: 'Seat 1', email: firstEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Seat 2', email: secondEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Seat 3', email: thirdEmail });

        const waiterA = uniqueEmail('wl-waiter-a');
        const waiterB = uniqueEmail('wl-waiter-b');
        const waiterC = uniqueEmail('wl-waiter-c');
        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Waiter A', email: waiterA });
        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Waiter B', email: waiterB });
        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Waiter C', email: waiterC });

        await setTicketExpiryScope(owner.client, ev.id, { limit: 2, order: 'oldest' });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        // Two seats freed (the two oldest original registrations) should
        // promote exactly the two longest-waiting entries, and no more.
        const waitlist = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body;
        assert.equal(waitlist.find(w => w.email === waiterA).status, 'converted');
        assert.equal(waitlist.find(w => w.email === waiterB).status, 'converted');
        assert.equal(waitlist.find(w => w.email === waiterC).status, 'waiting');

        const tickets = await listTickets(owner.client, ev.id);
        assert.equal(tickets.filter(t => !t.expiredAt).length, 3, 'active tickets should stay at capacity: 1 original + 2 promoted');
        assert.ok(tickets.find(t => t.email === thirdEmail && !t.expiredAt), 'the third original registration should never have expired');
        assert.ok(tickets.some(t => t.email === waiterA));
        assert.ok(tickets.some(t => t.email === waiterB));
        assert.ok(!tickets.some(t => t.email === waiterC));
    });

    test('with no limit set, every eligible ticket still promotes its own waitlist entry (unchanged)', async () => {
        const ev = await createEvent(owner.client, { capacity: 2, waitlist: true });
        await addTicket(owner.client, ev.id, { name: 'Seat 1', email: uniqueEmail('wl-full-1') });
        await addTicket(owner.client, ev.id, { name: 'Seat 2', email: uniqueEmail('wl-full-2') });
        const waiterA = uniqueEmail('wl-full-waiter-a');
        const waiterB = uniqueEmail('wl-full-waiter-b');
        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'A', email: waiterA });
        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'B', email: waiterB });

        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        const waitlist = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body;
        assert.equal(waitlist.find(w => w.email === waiterA).status, 'converted');
        assert.equal(waitlist.find(w => w.email === waiterB).status, 'converted');
    });

    test('a stale past cutoff caught by the periodic sweep still respects the waitingCount budget', async () => {
        // Reproduces a production incident: a ticketExpiresAt left over from
        // earlier testing was already in the past by the time the event next
        // became full with a waitlist, so the periodic sweep (not a fresh
        // save) is what caught it — and with far more eligible tickets than
        // waiters, it expired every one of them instead of just the one
        // seat there was actually a waiter for.
        const ev = await createEvent(owner.client, { capacity: 3, waitlist: true });
        const emails = [uniqueEmail('stale-a'), uniqueEmail('stale-b'), uniqueEmail('stale-c')];
        await addSpacedRegistration(owner.client, ev.id, { name: 'A', email: emails[0] });
        await addSpacedRegistration(owner.client, ev.id, { name: 'B', email: emails[1] });
        await addSpacedRegistration(owner.client, ev.id, { name: 'C', email: emails[2] });
        await addWaiter(ev.id, 'stale-waiter');

        // Future cutoff so no immediate-expire-on-save branch fires — only
        // the periodic sweep (TICKET_EXPIRY_SWEEP_MS=300 for this file)
        // should catch it once it lapses.
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() + 150).toISOString());
        await waitFor(async () => (await ticketFor(owner.client, ev.id, emails[0]))?.expiredAt);

        await sleep(500);
        const tickets = await listTickets(owner.client, ev.id);
        assert.ok(tickets.find(t => t.email === emails[0]).expiredAt);
        assert.equal(tickets.find(t => t.email === emails[1]).expiredAt, null, 'no waiter left to receive this seat');
        assert.equal(tickets.find(t => t.email === emails[2]).expiredAt, null, 'no waiter left to receive this seat');
    });
});

describe('the limit is a running cap, not "N more every sweep tick"', () => {
    test('stays at the limit across several sweep intervals instead of creeping upward', async () => {
        const ev = await createEvent(owner.client, { capacity: 5, waitlist: true });
        const emails = [1, 2, 3, 4, 5].map(n => uniqueEmail(`cap-${n}`));
        for (const email of emails) await addSpacedRegistration(owner.client, ev.id, { name: `Reg ${email}`, email });
        await addWaiter(ev.id, 'cap-waiter');

        await setTicketExpiryScope(owner.client, ev.id, { limit: 2, order: 'oldest' });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() + 150).toISOString());

        await waitFor(async () => {
            const tickets = await listTickets(owner.client, ev.id);
            return tickets.filter(t => t.expiredAt).length === 2;
        });

        // Several more sweep ticks (TICKET_EXPIRY_SWEEP_MS=300) pass with the
        // cutoff still in the past — a naive "expire N eligible tickets every
        // tick" implementation would have expired all 5 by now.
        await sleep(1000);
        const tickets = await listTickets(owner.client, ev.id);
        assert.equal(tickets.filter(t => t.expiredAt).length, 2, 'the cap should hold, not grow, across repeated sweep ticks');
        assert.ok(tickets.find(t => t.email === emails[0]).expiredAt);
        assert.ok(tickets.find(t => t.email === emails[1]).expiredAt);
        assert.equal(tickets.find(t => t.email === emails[2]).expiredAt, null);
        assert.equal(tickets.find(t => t.email === emails[3]).expiredAt, null);
        assert.equal(tickets.find(t => t.email === emails[4]).expiredAt, null);
    });

    test('un-expiring a ticket lets the next sweep tick refill the cap', async () => {
        const ev = await createEvent(owner.client, { capacity: 5, waitlist: true });
        const emails = [1, 2, 3, 4, 5].map(n => uniqueEmail(`refill-${n}`));
        for (const email of emails) await addSpacedRegistration(owner.client, ev.id, { name: `Reg ${email}`, email });
        // Every expiry (2 up front, 1 more on refill) promotes a waiter and
        // re-fills the seat it just freed, which is what keeps the event
        // full — and therefore keeps satisfying the expiry precondition —
        // across the whole test. Three waiters covers all three expiries.
        await addWaiter(ev.id, 'refill-waiter-a');
        await addWaiter(ev.id, 'refill-waiter-b');
        await addWaiter(ev.id, 'refill-waiter-c');

        await setTicketExpiryScope(owner.client, ev.id, { limit: 2, order: 'oldest' });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        const oldest = await ticketFor(owner.client, ev.id, emails[0]);
        assert.ok(oldest.expiredAt);
        assert.ok((await ticketFor(owner.client, ev.id, emails[1])).expiredAt);

        const unexpire = await owner.client.post(`/api/ticket/${oldest.id}/unexpire`);
        assert.equal(unexpire.status, 200, unexpire.text);
        assert.equal((await ticketFor(owner.client, ev.id, emails[0])).expiredAt, null);

        // The cutoff is still in the past, so the next sweep tick should
        // notice the freed budget (limit 2, only 1 currently expired) and
        // re-expire the oldest still-active ticket — which is the one just
        // un-expired, since its created_at didn't change.
        await waitFor(async () => (await ticketFor(owner.client, ev.id, emails[0]))?.expiredAt);

        const tickets = await listTickets(owner.client, ev.id);
        assert.equal(tickets.filter(t => t.expiredAt).length, 2, 'total expired should return to the limit, not exceed it');
        assert.equal(tickets.find(t => t.email === emails[2]).expiredAt, null);
        assert.equal(tickets.find(t => t.email === emails[3]).expiredAt, null);
        assert.equal(tickets.find(t => t.email === emails[4]).expiredAt, null);
    });
});

describe('a manual per-ticket expire counts toward the limit too', () => {
    test('the cutoff only expires the remaining budget after a manual expire', async () => {
        const ev = await createEvent(owner.client, { capacity: 3, waitlist: true });
        const firstEmail = uniqueEmail('manual-1');
        const secondEmail = uniqueEmail('manual-2');
        const thirdEmail = uniqueEmail('manual-3');
        await addSpacedRegistration(owner.client, ev.id, { name: 'First', email: firstEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Second', email: secondEmail });
        await addSpacedRegistration(owner.client, ev.id, { name: 'Third', email: thirdEmail });
        // One waiter for the manual expire's own promotion (which re-fills
        // the event back to full), one left over so the cutoff's own
        // eligibility check below still finds someone waiting.
        await addWaiter(ev.id, 'manual-waiter-a');
        await addWaiter(ev.id, 'manual-waiter-b');

        const first = await ticketFor(owner.client, ev.id, firstEmail);
        const manual = await owner.client.post(`/api/ticket/${first.id}/expire`);
        assert.equal(manual.status, 200, manual.text);

        await setTicketExpiryScope(owner.client, ev.id, { limit: 2, order: 'oldest' });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        assert.ok((await ticketFor(owner.client, ev.id, firstEmail)).expiredAt, 'still expired from the manual action');
        assert.ok((await ticketFor(owner.client, ev.id, secondEmail)).expiredAt, 'the one remaining slot in the budget should go to the next-oldest');
        assert.equal((await ticketFor(owner.client, ev.id, thirdEmail)).expiredAt, null, 'the budget was already spent, so the third registration stays active');
    });
});

describe('edge cases', () => {
    test('a limit larger than the eligible count expires everyone without error', async () => {
        const ev = await createEvent(owner.client, { capacity: 2, waitlist: true });
        const emails = [uniqueEmail('overshoot-a'), uniqueEmail('overshoot-b')];
        await addTicket(owner.client, ev.id, { name: 'A', email: emails[0] });
        await addTicket(owner.client, ev.id, { name: 'B', email: emails[1] });
        await addWaiter(ev.id, 'overshoot-waiter');

        await setTicketExpiryScope(owner.client, ev.id, { limit: 100, order: 'oldest' });
        const r = await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());
        assert.equal(r.status, 200, r.text);

        // The freed seat goes straight to the waiter, so a fresh unexpired
        // ticket also exists now — check the two originals specifically.
        const tickets = await listTickets(owner.client, ev.id);
        const original = emails.map(email => tickets.find(t => t.email === email));
        assert.ok(original.every(t => t?.expiredAt));
    });

    test('checked-in tickets are never touched, limit or no limit', async () => {
        const ev = await createEvent(owner.client, { capacity: 2, waitlist: true });
        const checkedInEmail = uniqueEmail('checked-in');
        const notCheckedInEmail = uniqueEmail('not-checked-in');
        await addTicket(owner.client, ev.id, { name: 'Checked In', email: checkedInEmail });
        await addTicket(owner.client, ev.id, { name: 'Not Checked In', email: notCheckedInEmail });
        await addWaiter(ev.id, 'checked-in-waiter');

        const checkedIn = await ticketFor(owner.client, ev.id, checkedInEmail);
        const scan = await owner.client.post('/api/validate', { token: checkedIn.token, eventId: ev.id });
        assert.equal(scan.status, 200, scan.text);

        await setTicketExpiryScope(owner.client, ev.id, { limit: 5, order: 'oldest' });
        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());

        assert.equal((await ticketFor(owner.client, ev.id, checkedInEmail)).expiredAt, null, 'a checked-in ticket must never be marked expired');
        assert.ok((await ticketFor(owner.client, ev.id, notCheckedInEmail)).expiredAt);
    });
});

describe('scope validation', () => {
    test('the limit is clamped to at least 1', async () => {
        const ev = await createEvent(owner.client, {});
        await setTicketExpiryScope(owner.client, ev.id, { limit: 0 });
        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).body.ticketExpiryLimit, 1);

        await setTicketExpiryScope(owner.client, ev.id, { limit: -5 });
        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).body.ticketExpiryLimit, 1);
    });

    test('an unrecognized order falls back to oldest', async () => {
        const ev = await createEvent(owner.client, {});
        const r = await setTicketExpiryScope(owner.client, ev.id, { limit: 1, order: 'sideways' });
        assert.equal(r.status, 200, r.text);
        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).body.ticketExpiryOrder, 'oldest');
    });

    test('clearing the limit reverts to the waitingCount budget instead of the old explicit one', async () => {
        const ev = await createEvent(owner.client, { capacity: 2, waitlist: true });
        const emails = [uniqueEmail('clear-a'), uniqueEmail('clear-b')];
        await addTicket(owner.client, ev.id, { name: 'A', email: emails[0] });
        await addTicket(owner.client, ev.id, { name: 'B', email: emails[1] });
        await addWaiter(ev.id, 'clear-waiter-1');
        await addWaiter(ev.id, 'clear-waiter-2');

        await setTicketExpiryScope(owner.client, ev.id, { limit: 1 });
        await setTicketExpiryScope(owner.client, ev.id, { limit: null });
        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).body.ticketExpiryLimit, null);

        await setTicketExpiresAt(owner.client, ev.id, new Date(Date.now() - 1000).toISOString());
        // Two waiters now, not one — both originals should expire, which
        // only happens if the limit:1 budget from earlier didn't stick.
        const tickets = await listTickets(owner.client, ev.id);
        const original = emails.map(email => tickets.find(t => t.email === email));
        assert.ok(original.every(t => t?.expiredAt));
    });

    test('changing the expiry scope needs manage_event', async () => {
        const ev = await createEvent(owner.client, {});
        const stranger = await newUser(server);
        const r = await setTicketExpiryScope(stranger.client, ev.id, { limit: 2 });
        assert.equal(r.status, 403);
    });
});
