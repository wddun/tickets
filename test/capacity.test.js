// Seat holds and who gets the last ticket.
//
// The rule these tests pin down: issued tickets > waitlist claim offers >
// active seat holds > everyone else, staff included. Somebody part-way
// through the public form owns that seat, and a manual add, a sheet import,
// a door sale or another visitor all get refused rather than taking it. The
// one thing that can still take it is the organiser lowering capacity, which
// is their call — and that answer comes back with a warning saying how many
// signups it strands.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, publicRegister, addTicket, listTickets, uniqueEmail, eventApiKey } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const visitor = () => createClient(server.base);

/** An open event with `capacity` seats, `issued` of them already taken. */
async function eventWithSeats(capacity, issued = 0, extra = {}) {
    const ev = await createEvent(owner.client, { publicRegistration: true, capacity, ...extra });
    for (let i = 0; i < issued; i++) await addTicket(owner.client, ev.id, { name: `Seated ${i}` });
    return ev;
}

/** Someone opens the public form and gets the last seat set aside for them. */
async function holderOnLastSeat(ev) {
    const holder = visitor();
    const hold = await holder.post(`/api/event/${ev.id}/hold`, {});
    assert.equal(hold.status, 200, `hold failed: ${hold.text}`);
    assert.equal(hold.body.granted, true);
    return { holder, holdToken: hold.body.holdToken };
}

describe('taking a hold', () => {
    test('reserves a seat that the counter then treats as gone', async () => {
        const ev = await eventWithSeats(4);
        const { holdToken } = await holderOnLastSeat(ev);
        assert.ok(holdToken, 'a capacity-limited event should issue a hold token');

        const seen = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(seen.remaining, 3, 'a held seat must not still be offered to other people');
        assert.equal(seen.holding, 1);
        assert.equal(seen.registered, 0, 'a hold is not a registration');
    });

    test('a holder is not shown their own seat as taken', async () => {
        const ev = await eventWithSeats(1);
        const { holder, holdToken } = await holderOnLastSeat(ev);

        const others = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(others.soldOut, true, 'everyone else sees a full event');

        const mine = (await holder.get(`/api/event/${ev.id}/availability?holdToken=${holdToken}`)).body;
        assert.equal(mine.soldOut, false, 'the holder should still see their own seat');
        assert.equal(mine.remaining, 1);
        assert.equal(mine.holdStillValid, true);
    });

    test('an uncapped event grants without bookkeeping', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true });
        const r = await visitor().post(`/api/event/${ev.id}/hold`, {});
        assert.equal(r.status, 200);
        assert.equal(r.body.granted, true);
        assert.equal(r.body.unlimited, true);
        assert.equal(r.body.holdToken, null);
    });

    test('refreshing an existing hold keeps the same seat rather than taking a second', async () => {
        const ev = await eventWithSeats(2);
        const { holder, holdToken } = await holderOnLastSeat(ev);

        const again = await holder.post(`/api/event/${ev.id}/hold`, { holdToken });
        assert.equal(again.status, 200);
        assert.equal(again.body.granted, true);
        assert.equal(again.body.holdToken, holdToken);

        const seen = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(seen.holding, 1, 'refreshing a hold must not consume another seat');
    });

    test('the last seat is refused to a second visitor', async () => {
        const ev = await eventWithSeats(1);
        await holderOnLastSeat(ev);

        const second = await visitor().post(`/api/event/${ev.id}/hold`, {});
        assert.equal(second.status, 409);
        assert.equal(second.body.granted, false);
        assert.equal(second.body.reason, 'all_held', 'nothing is issued yet — the seats are being filled in');
    });

    test('reports sold_out rather than all_held once the tickets really are issued', async () => {
        const ev = await eventWithSeats(1, 1);
        const r = await visitor().post(`/api/event/${ev.id}/hold`, {});
        assert.equal(r.status, 409);
        assert.equal(r.body.reason, 'sold_out');
    });

    test('releasing a hold puts the seat back', async () => {
        const ev = await eventWithSeats(1);
        const { holder, holdToken } = await holderOnLastSeat(ev);

        assert.equal((await holder.post(`/api/event/${ev.id}/hold/release`, { holdToken })).status, 200);

        const seen = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(seen.soldOut, false);
        assert.equal(seen.remaining, 1);
    });

    test('a hold cannot be taken on a closed event', async () => {
        const ev = await createEvent(owner.client, { capacity: 5 });
        assert.equal((await visitor().post(`/api/event/${ev.id}/hold`, {})).status, 403);
    });

    test('asking for several seats reserves several', async () => {
        const ev = await eventWithSeats(5);
        const r = await visitor().post(`/api/event/${ev.id}/hold`, { quantity: 3 });
        assert.equal(r.status, 200);
        const seen = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(seen.holding, 3);
        assert.equal(seen.remaining, 2);
    });

    test('asking for more seats than exist is refused', async () => {
        const ev = await eventWithSeats(2);
        const r = await visitor().post(`/api/event/${ev.id}/hold`, { quantity: 5 });
        assert.equal(r.status, 409);
        assert.equal(r.body.granted, false);
    });
});

describe('a hold outranks everyone else', () => {
    // Each case: one seat left, a visitor holding it, and someone else trying
    // to take it. The someone else must be refused, and the holder must then
    // still be able to finish.
    async function lastSeatHeld() {
        const ev = await eventWithSeats(4, 3);
        const { holder, holdToken } = await holderOnLastSeat(ev);
        return { ev, holder, holdToken };
    }

    async function assertHolderStillGetsIn(ev, holder, holdToken) {
        const done = await publicRegister(holder, ev.id, { name: 'Held Seat Person', holdToken });
        assert.equal(done.status, 200, `the holder lost their seat: ${done.text}`);
        assert.equal(done.body.success, true);
    }

    test('beats a manual add from the dashboard', async () => {
        const { ev, holder, holdToken } = await lastSeatHeld();

        const add = await owner.client.post(`/api/event/${ev.id}/ticket`, { name: 'Staff Add', email: uniqueEmail('staff'), noEmail: true });
        assert.equal(add.status, 409);
        assert.match(add.body.error, /being filled in right now/,
            'the refusal should say the seat is mid-signup, not report it as registered');

        await assertHolderStillGetsIn(ev, holder, holdToken);
    });

    test('beats another visitor on the public form', async () => {
        const { ev, holder, holdToken } = await lastSeatHeld();

        const queueJumper = await publicRegister(visitor(), ev.id, { name: 'Queue Jumper' });
        assert.equal(queueJumper.status, 400);
        assert.equal(queueJumper.body.reason, 'sold_out');

        await assertHolderStillGetsIn(ev, holder, holdToken);
    });

    test('beats an at-door sale', async () => {
        const ev = await eventWithSeats(4, 3);
        await owner.client.put(`/api/event/${ev.id}/at-door`, { enabled: true });
        const { holder, holdToken } = await holderOnLastSeat(ev);

        // The at-door route answers 400 where the other paths answer 409 —
        // the iOS app treats every non-200 the same, so what matters is that
        // it refuses and says why.
        const door = await owner.client.post(`/api/event/${ev.id}/at-door-register`, { name: 'Door Sale', email: uniqueEmail('door') });
        assert.equal(door.status, 400, `an at-door sale took a held seat: ${door.text}`);
        assert.match(door.body.error, /being filled in right now/);

        await assertHolderStillGetsIn(ev, holder, holdToken);
    });

    test('beats a sheet/API bulk import', async () => {
        const { ev, holder, holdToken } = await lastSeatHeld();
        const apiKey = await eventApiKey(owner.client, ev.id);

        const imported = await visitor().post('/api/register-bulk', {
            firstName: 'Sheet', lastName: 'Import', email: uniqueEmail('sheet'),
            eventId: ev.id, ticketCount: 1, apiKey,
        });
        assert.equal(imported.status, 409, `a sheet import took a held seat: ${imported.text}`);
        assert.match(imported.body.error, /being filled in right now/);

        await assertHolderStillGetsIn(ev, holder, holdToken);
    });

    test('but a hold cannot be honoured past the point where honouring it oversells', async () => {
        // Capacity 4, three issued, one seat held. The organiser then drops
        // the capacity to 3, so the held seat no longer exists.
        const { ev, holder, holdToken } = await lastSeatHeld();

        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('capacity', '3');
        const lowered = await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });
        assert.equal(lowered.status, 200);

        const done = await publicRegister(holder, ev.id, { name: 'Stranded', holdToken });
        assert.equal(done.status, 400);
        assert.equal(done.body.reason, 'filled_under_hold');
        assert.match(done.body.error, /filled up while you were signing up/i);

        // And the event did not oversell.
        assert.equal((await listTickets(owner.client, ev.id)).length, 3);
    });

    test('the holder is told their hold has been overtaken', async () => {
        const { ev, holder, holdToken } = await lastSeatHeld();

        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('capacity', '3');
        await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });

        const seen = (await holder.get(`/api/event/${ev.id}/availability?holdToken=${holdToken}`)).body;
        assert.equal(seen.holdStillValid, false, 'the page must be able to tell the visitor their spot is gone');
    });
});

describe('lowering capacity under people who are mid-signup', () => {
    test('warns how many signups it strands', async () => {
        const ev = await eventWithSeats(6, 3);
        await holderOnLastSeat(ev);
        await holderOnLastSeat(ev);

        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('capacity', '4');
        const r = await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });
        assert.equal(r.status, 200);
        assert.ok(r.body.capacityWarning, 'lowering capacity under a holder should warn the organiser');
        assert.match(r.body.capacityWarning, /1 person is part-way through/);
    });

    test('pluralises when more than one signup is stranded', async () => {
        const ev = await eventWithSeats(6, 3);
        await holderOnLastSeat(ev);
        await holderOnLastSeat(ev);

        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('capacity', '3');
        const r = await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });
        assert.match(r.body.capacityWarning, /2 people are part-way through/);
    });

    test('says nothing when capacity goes up', async () => {
        const ev = await eventWithSeats(4, 3);
        await holderOnLastSeat(ev);

        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('capacity', '10');
        const r = await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });
        assert.equal(r.status, 200);
        assert.ok(!r.body.capacityWarning, 'raising capacity should not warn about anything');
    });

    test('says nothing when nobody is mid-signup', async () => {
        const ev = await eventWithSeats(10, 2);
        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('capacity', '3');
        const r = await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });
        assert.ok(!r.body.capacityWarning);
    });
});

describe('capacity is enforced on every path that issues a ticket', () => {
    test('a manual add cannot exceed it', async () => {
        const ev = await eventWithSeats(2, 2);
        const r = await owner.client.post(`/api/event/${ev.id}/ticket`, { name: 'One Too Many', email: uniqueEmail('over'), noEmail: true });
        assert.equal(r.status, 409);
        assert.equal((await listTickets(owner.client, ev.id)).length, 2);
    });

    test('a multi-ticket manual add is refused as a whole, not partly issued', async () => {
        const ev = await eventWithSeats(4, 2);
        const r = await owner.client.post(`/api/event/${ev.id}/ticket`, { name: 'Group Of Five', email: uniqueEmail('group'), ticketCount: 5, noEmail: true });
        assert.equal(r.status, 409);
        assert.equal((await listTickets(owner.client, ev.id)).length, 2, 'a refused group must not leave partial tickets behind');
    });

    test('a bulk import cannot exceed it', async () => {
        const ev = await eventWithSeats(2, 2);
        const apiKey = await eventApiKey(owner.client, ev.id);
        const r = await visitor().post('/api/register-bulk', {
            firstName: 'Over', lastName: 'Flow', email: uniqueEmail('bulk'),
            eventId: ev.id, ticketCount: 1, apiKey,
        });
        assert.equal(r.status, 409);
        assert.equal((await listTickets(owner.client, ev.id)).length, 2);
    });

    test('an at-door sale cannot exceed it', async () => {
        const ev = await eventWithSeats(2, 2);
        await owner.client.put(`/api/event/${ev.id}/at-door`, { enabled: true });
        const r = await owner.client.post(`/api/event/${ev.id}/at-door-register`, { name: 'Door Over', email: uniqueEmail('door') });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /at capacity/i);
        assert.equal((await listTickets(owner.client, ev.id)).length, 2);
    });

    test('a registration with a stale hold token still cannot oversell', async () => {
        const ev = await eventWithSeats(1, 1);
        const r = await publicRegister(visitor(), ev.id, { holdToken: 'not-a-real-hold-token' });
        assert.equal(r.status, 400);
        assert.equal(r.body.reason, 'sold_out');
        assert.equal((await listTickets(owner.client, ev.id)).length, 1);
    });
});
