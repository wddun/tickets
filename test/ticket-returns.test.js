// Self-service ticket returns: an attendee handing their own ticket back
// rather than emailing the organiser to be taken off the list.
//
// A return is deliberately not a new kind of void — it goes through the same
// expireTicket() the organiser's "Expire Ticket" button uses, so the seat
// accounting, the voided Wallet pass, the door refusal and the waitlist
// promotion are all the existing, already-tested behaviour. What these tests
// pin down is the part that is new: who is allowed to do it, when the window
// is open, what the attendee is shown and told, and that the two routes are
// safe to expose with no session behind them.
//
// The refund path runs with `stripe` null (see test/helpers/server.js — no
// test can ever reach a live payments account), which is exactly the
// degradation this feature has to get right: the seat must still be released
// and the attendee must be told plainly that the money did not come back.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import {
    newUser, createEvent, addTicket, listTickets, publicRegister,
    share, uniqueEmail,
} from './helpers/factories.js';
import { createClient } from './helpers/client.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

/** A logged-out browser — how an attendee actually arrives at these routes. */
const anon = () => createClient(server.base);

async function enableReturns(client, eventId, { refund = 'none', cutoffValue = 0, cutoffUnit = 'hours' } = {}) {
    const r = await client.put(`/api/event/${eventId}/ticket-returns`, { enabled: true, refund, cutoffValue, cutoffUnit });
    assert.equal(r.status, 200, `enable returns failed: ${r.text}`);
    return r.body;
}

/** The registration id an attendee's manage link is keyed on. */
async function oneRegistration(client, eventId, opts) {
    const made = await addTicket(client, eventId, opts);
    const tickets = Array.isArray(made) ? made : (made.tickets || []);
    assert.ok(tickets.length, `no tickets came back from addTicket: ${JSON.stringify(made)}`);
    return { registrationId: tickets[0].registrationId, tickets };
}

describe('the return setting', () => {
    test('is off until the organiser turns it on, and the attendee is told so', async () => {
        const ev = await createEvent(owner.client, { name: 'Returns Off' });
        const { registrationId } = await oneRegistration(owner.client, ev.id);

        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.status, 200, 'the page must still load and show the booking');
        assert.equal(view.body.returns.enabled, false);
        assert.equal(view.body.returns.open, false);
        assert.equal(view.body.returns.reason, 'disabled');

        const attempt = await anon().post(`/api/registration/${registrationId}/return`, {});
        assert.equal(attempt.status, 403, `a disabled event must refuse the return: ${attempt.text}`);

        const [ticket] = await listTickets(owner.client, ev.id);
        assert.equal(ticket.expiredAt ?? null, null, 'nothing may have been voided');
    });

    test('only someone with manage_event may change it', async () => {
        const ev = await createEvent(owner.client, { name: 'Returns Perms' });
        const stranger = await newUser(server);
        const helper = await newUser(server);
        await share(owner.client, ev.id, helper.email, ['checkin']);

        assert.equal((await stranger.client.put(`/api/event/${ev.id}/ticket-returns`, { enabled: true })).status, 403);
        assert.equal((await helper.client.put(`/api/event/${ev.id}/ticket-returns`, { enabled: true })).status, 403);
        assert.equal((await anon().put(`/api/event/${ev.id}/ticket-returns`, { enabled: true })).status, 401);
        assert.equal((await owner.client.put(`/api/event/${ev.id}/ticket-returns`, { enabled: true })).status, 200);
    });

    test('stores what it was given, clamped, and reports it back', async () => {
        const ev = await createEvent(owner.client, { name: 'Returns Settings' });
        const saved = await enableReturns(owner.client, ev.id, { refund: 'auto', cutoffValue: 12, cutoffUnit: 'hours' });
        assert.deepEqual(
            { e: saved.ticketReturnsEnabled, r: saved.ticketReturnRefund, m: saved.ticketReturnCutoffMinutes, u: saved.ticketReturnCutoffUnit },
            { e: true, r: 'auto', m: 720, u: 'hours' },
        );

        // Anything that isn't the explicit opt-in must read as 'none' — a
        // typo can't be allowed to mean "refund everyone automatically" — and
        // an unknown unit falls back rather than being taken at face value.
        const odd = await owner.client.put(`/api/event/${ev.id}/ticket-returns`, { enabled: true, refund: 'sure', cutoffValue: -5, cutoffUnit: 'fortnights' });
        assert.equal(odd.body.ticketReturnRefund, 'none');
        assert.equal(odd.body.ticketReturnCutoffMinutes, 0);
        assert.equal(odd.body.ticketReturnCutoffUnit, 'hours');

        const fresh = await owner.client.get(`/api/event/${ev.id}`);
        assert.equal(fresh.body.ticketReturnsEnabled, true);
        assert.equal(fresh.body.ticketReturnRefund, 'none');
    });

    test('every unit converts to the same stored minutes', async () => {
        const cases = [
            { cutoffValue: 90, cutoffUnit: 'minutes', minutes: 90 },
            { cutoffValue: 2, cutoffUnit: 'hours', minutes: 120 },
            { cutoffValue: 3, cutoffUnit: 'days', minutes: 4320 },
            { cutoffValue: 1, cutoffUnit: 'weeks', minutes: 10080 },
        ];
        for (const c of cases) {
            const ev = await createEvent(owner.client, { name: `Cutoff ${c.cutoffUnit}` });
            const saved = await enableReturns(owner.client, ev.id, c);
            assert.equal(saved.ticketReturnCutoffMinutes, c.minutes, `${c.cutoffValue} ${c.cutoffUnit}`);
            assert.equal(saved.ticketReturnCutoffUnit, c.cutoffUnit, 'the unit typed in must be remembered for redisplay');
            assert.equal(saved.cutoffValue, c.cutoffValue, 'and convert back to exactly the number that was typed');
        }

        // "2 days" and "48 hours" are the same cutoff, however they were typed.
        const a = await createEvent(owner.client, { name: 'Two Days' });
        const b = await createEvent(owner.client, { name: 'Forty Eight Hours' });
        assert.equal(
            (await enableReturns(owner.client, a.id, { cutoffValue: 2, cutoffUnit: 'days' })).ticketReturnCutoffMinutes,
            (await enableReturns(owner.client, b.id, { cutoffValue: 48, cutoffUnit: 'hours' })).ticketReturnCutoffMinutes,
        );
    });

    test('clamps a cutoff that would close returns before the ticket is even issued', async () => {
        const ev = await createEvent(owner.client, { name: 'Absurd Cutoff' });
        const saved = await enableReturns(owner.client, ev.id, { cutoffValue: 9999, cutoffUnit: 'weeks' });
        assert.equal(saved.ticketReturnCutoffMinutes, 525600, 'a year is the ceiling');
    });
});

describe('what the attendee is shown', () => {
    test('lists the booking without leaking the QR tokens that would make it a ticket', async () => {
        const ev = await createEvent(owner.client, { name: 'Manage View' });
        await enableReturns(owner.client, ev.id);
        const { registrationId } = await oneRegistration(owner.client, ev.id, { name: 'Ada Lovelace', ticketCount: 2 });

        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.status, 200);
        assert.equal(view.body.eventName, 'Manage View');
        assert.equal(view.body.tickets.length, 2);
        assert.ok(view.body.tickets.every(t => t.returnable));
        assert.ok(view.body.theme?.vars, 'the organiser theme must come through');

        const serialized = JSON.stringify(view.body);
        const real = await listTickets(owner.client, ev.id);
        for (const t of real) {
            assert.ok(!serialized.includes(t.token), 'a manage link must never double as a scannable ticket');
        }
    });

    test('is a 404 for an id that names no booking', async () => {
        assert.equal((await anon().get('/api/registration/not-a-real-id/manage')).status, 404);
        assert.equal((await anon().post('/api/registration/not-a-real-id/return', {})).status, 404);
    });
});

describe('returning a ticket', () => {
    test('voids it, frees the seat, and stops it working at the door', async () => {
        const ev = await createEvent(owner.client, { name: 'Free Return', capacity: 2 });
        await enableReturns(owner.client, ev.id);
        const { registrationId } = await oneRegistration(owner.client, ev.id);

        const before = await anon().get(`/api/event/${ev.id}/availability`);
        assert.equal(before.body.remaining, 1);

        const done = await anon().post(`/api/registration/${registrationId}/return`, {});
        assert.equal(done.status, 200, done.text);
        assert.equal(done.body.returned, 1);

        const [ticket] = await listTickets(owner.client, ev.id);
        assert.ok(ticket.expiredAt, 'a return is an expiry');
        assert.ok(ticket.returnedAt, 'and is marked as one the attendee performed');

        const after = await anon().get(`/api/event/${ev.id}/availability`);
        assert.equal(after.body.remaining, 2, 'the seat must go back into the pool');

        const scan = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(scan.body.status, 'expired', `a returned ticket must not scan in: ${scan.text}`);
    });

    test('a group booking can give back some tickets and keep the rest', async () => {
        const ev = await createEvent(owner.client, { name: 'Partial Return' });
        await enableReturns(owner.client, ev.id);
        const { registrationId, tickets } = await oneRegistration(owner.client, ev.id, { ticketCount: 3 });

        const done = await anon().post(`/api/registration/${registrationId}/return`, { ticketIds: [tickets[0].id] });
        assert.equal(done.status, 200, done.text);
        assert.equal(done.body.returned, 1);

        const all = await listTickets(owner.client, ev.id);
        assert.equal(all.filter(t => t.returnedAt).length, 1);
        assert.equal(all.filter(t => !t.expiredAt).length, 2, 'the other two must be untouched');

        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.body.tickets.filter(t => t.returnable).length, 2);
        assert.equal(view.body.tickets.filter(t => t.returned).length, 1);
    });

    test('refuses a ticket that has already been used at the door', async () => {
        const ev = await createEvent(owner.client, { name: 'Already In' });
        await enableReturns(owner.client, ev.id);
        const { registrationId } = await oneRegistration(owner.client, ev.id);
        assert.equal((await owner.client.post(`/api/checkin/${registrationId}`, {})).status, 200);

        const attempt = await anon().post(`/api/registration/${registrationId}/return`, {});
        assert.equal(attempt.status, 409, `a checked-in ticket has already done its job: ${attempt.text}`);

        const [ticket] = await listTickets(owner.client, ev.id);
        assert.equal(ticket.expiredAt ?? null, null);

        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.body.tickets[0].returnable, false);
        assert.equal(view.body.tickets[0].checkedIn, true);
    });

    test('refuses a second return of the same ticket', async () => {
        const ev = await createEvent(owner.client, { name: 'Twice' });
        await enableReturns(owner.client, ev.id);
        const { registrationId } = await oneRegistration(owner.client, ev.id);

        assert.equal((await anon().post(`/api/registration/${registrationId}/return`, {})).status, 200);
        assert.equal((await anon().post(`/api/registration/${registrationId}/return`, {})).status, 409);
    });

    test('ignores ticket ids from someone else\'s booking', async () => {
        const ev = await createEvent(owner.client, { name: 'Cross Booking' });
        await enableReturns(owner.client, ev.id);
        const mine = await oneRegistration(owner.client, ev.id, { name: 'Mine' });
        const theirs = await oneRegistration(owner.client, ev.id, { name: 'Theirs' });

        const attempt = await anon().post(`/api/registration/${mine.registrationId}/return`, {
            ticketIds: [theirs.tickets[0].id],
        });
        assert.equal(attempt.status, 409, 'nothing in *this* booking was named, so there is nothing to return');

        const all = await listTickets(owner.client, ev.id);
        assert.equal(all.filter(t => t.expiredAt).length, 0, 'no ticket of either booking may have been voided');
    });

    test('the organiser can reinstate a returned ticket', async () => {
        const ev = await createEvent(owner.client, { name: 'Changed My Mind' });
        await enableReturns(owner.client, ev.id);
        const { registrationId } = await oneRegistration(owner.client, ev.id);
        await anon().post(`/api/registration/${registrationId}/return`, {});

        let [ticket] = await listTickets(owner.client, ev.id);
        assert.equal((await owner.client.post(`/api/ticket/${ticket.id}/unexpire`, {})).status, 200);

        [ticket] = await listTickets(owner.client, ev.id);
        assert.equal(ticket.expiredAt ?? null, null);
        assert.equal(ticket.returnedAt ?? null, null, 'a reinstated ticket is no longer a returned one');

        const scan = await owner.client.post('/api/validate', { token: ticket.token, eventId: ev.id });
        assert.equal(scan.body.status, 'valid', `it must work at the door again: ${scan.text}`);
    });
});

describe('the return window', () => {
    test('closes the configured number of hours before the event starts', async () => {
        const ev = await createEvent(owner.client, {
            name: 'Catering Ordered',
            time: new Date(Date.now() + 3600000).toISOString(), // starts in an hour
        });
        await enableReturns(owner.client, ev.id, { cutoffValue: 2, cutoffUnit: 'hours' }); // ...so returns shut an hour ago
        const { registrationId } = await oneRegistration(owner.client, ev.id);

        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.body.returns.enabled, true);
        assert.equal(view.body.returns.open, false);
        assert.equal(view.body.returns.reason, 'closed');
        assert.ok(view.body.returns.closesAt, 'the page needs the moment it closed to say so');
        assert.equal(view.body.returns.cutoffMinutes, 120);
        assert.equal(view.body.returns.cutoffUnit, 'hours');

        const attempt = await anon().post(`/api/registration/${registrationId}/return`, {});
        assert.equal(attempt.status, 409, attempt.text);
    });

    test('a zero cutoff leaves returns open right up to the start time', async () => {
        const ev = await createEvent(owner.client, {
            name: 'Open Till Doors',
            time: new Date(Date.now() + 3600000).toISOString(),
        });
        await enableReturns(owner.client, ev.id, { cutoffValue: 0 });
        const { registrationId } = await oneRegistration(owner.client, ev.id);

        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.body.returns.open, true);
        assert.equal((await anon().post(`/api/registration/${registrationId}/return`, {})).status, 200);
    });

    test('an event that has already started accepts no more returns', async () => {
        const ev = await createEvent(owner.client, {
            name: 'Already Running',
            time: new Date(Date.now() - 3600000).toISOString(),
        });
        await enableReturns(owner.client, ev.id);
        const { registrationId } = await oneRegistration(owner.client, ev.id);

        const attempt = await anon().post(`/api/registration/${registrationId}/return`, {});
        assert.equal(attempt.status, 409, attempt.text);
    });
});

describe('interaction with the waitlist', () => {
    test('a returned seat goes straight to the next person in line', async () => {
        const ev = await createEvent(owner.client, {
            name: 'Waitlist Return',
            capacity: 1,
            publicRegistration: true,
            waitlist: true,
        });
        await enableReturns(owner.client, ev.id);

        const seated = uniqueEmail('seated');
        const first = await publicRegister(anon(), ev.id, { name: 'Seated', email: seated });
        assert.equal(first.status, 200, first.text);

        const waiting = uniqueEmail('waiting');
        const second = await publicRegister(anon(), ev.id, { name: 'Waiting', email: waiting });
        assert.equal(second.body.waitlisted, true, `the event is full, so this one waits: ${second.text}`);

        const registrationId = (await listTickets(owner.client, ev.id))
            .find(t => t.email === seated).registrationId;

        const done = await anon().post(`/api/registration/${registrationId}/return`, {});
        assert.equal(done.status, 200, done.text);

        // Free event: promotion issues the ticket outright rather than
        // emailing a claim link, so the waiter is simply seated now.
        const after = await listTickets(owner.client, ev.id);
        assert.ok(
            after.some(t => t.email === waiting && !t.expiredAt),
            `the waiting registrant should have been given the returned seat: ${JSON.stringify(after.map(t => t.email))}`,
        );
    });
});

describe('paid events', () => {
    test('with refunds off, the seat is released and the money is left alone', async () => {
        const ev = await createEvent(owner.client, { name: 'Paid No Refund', ticketPrice: 25 });
        await enableReturns(owner.client, ev.id, { refund: 'none' });
        const { registrationId } = await oneRegistration(owner.client, ev.id);

        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.body.isPaid, true);
        assert.equal(view.body.returns.refund, 'none');

        const done = await anon().post(`/api/registration/${registrationId}/return`, {});
        assert.equal(done.status, 200, done.text);
        assert.equal(done.body.refund.attempted, false, 'no refund should even have been attempted');
        assert.ok((await listTickets(owner.client, ev.id))[0].returnedAt);
    });

    test('with refunds on but Stripe unreachable, the seat is still released and the failure is reported', async () => {
        const ev = await createEvent(owner.client, { name: 'Paid Auto Refund', ticketPrice: 25 });
        await enableReturns(owner.client, ev.id, { refund: 'auto' });
        const { registrationId } = await oneRegistration(owner.client, ev.id);

        const done = await anon().post(`/api/registration/${registrationId}/return`, {});
        assert.equal(done.status, 200, done.text);
        assert.equal(done.body.refund.attempted, true);
        assert.equal(done.body.refund.status, 'unavailable', `must not claim a refund that did not happen: ${done.text}`);

        const [ticket] = await listTickets(owner.client, ev.id);
        assert.ok(ticket.returnedAt, 'the seat is released regardless — re-seating someone who has said they are not coming would be worse');
    });

    test('a free event never reports an automatic refund, whatever is stored', async () => {
        const ev = await createEvent(owner.client, { name: 'Free But Auto' });
        await enableReturns(owner.client, ev.id, { refund: 'auto' });
        const { registrationId } = await oneRegistration(owner.client, ev.id);

        const view = await anon().get(`/api/registration/${registrationId}/manage`);
        assert.equal(view.body.isPaid, false);
        assert.equal(view.body.returns.refund, 'none', 'there is no money to give back');
    });
});

describe('the confirmation email', () => {
    test('carries the return link only once the organiser has turned returns on', async () => {
        const quiet = await createEvent(owner.client, { name: 'Quiet Event' });
        const email = uniqueEmail('attendee');
        await owner.client.post(`/api/event/${quiet.id}/ticket`, { name: 'No Link', email, ticketCount: 1 });
        const without = await server.waitForEmail(m => m.to === email && /Quiet Event/.test(m.html));
        assert.ok(!/manage-ticket\.html/.test(without.html), 'an event that never opted in must send the email it always did');

        const open = await createEvent(owner.client, { name: 'Open Event' });
        await enableReturns(owner.client, open.id);
        const email2 = uniqueEmail('attendee');
        await owner.client.post(`/api/event/${open.id}/ticket`, { name: 'Has Link', email: email2, ticketCount: 1 });
        const with_ = await server.waitForEmail(m => m.to === email2 && /Open Event/.test(m.html));

        const registrationId = (await listTickets(owner.client, open.id))
            .find(t => t.email === email2).registrationId;
        assert.ok(
            with_.html.includes(`/manage-ticket.html?id=${registrationId}`),
            'the link must point at that person\'s own booking',
        );
    });
});
