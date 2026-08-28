// Waitlist automation added alongside the giveaway rebuild: a configurable
// claim window, the claim-expiry auto-chain-promote sweep, and the
// organizer-triggered no-show release. Each of these needed a real,
// unmocked path through the actual expiry/promote logic, so this file boots
// its own server with WAITLIST_SWEEP_MS and WAITLIST_CLAIM_MS_OVERRIDE
// shrunk — both are test-only hooks (see server.js), unset in production.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { openSseReader } from './helpers/sse.js';
import { newUser, createEvent, publicRegister, addTicket, listTickets, uniqueEmail } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer({ env: { WAITLIST_SWEEP_MS: '300', WAITLIST_CLAIM_MS_OVERRIDE: '250' } });
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

describe('configurable claim window', () => {
    test('defaults to 48 hours and can be changed per event', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1, waitlist: true, ticketPrice: 25 });
        assert.equal(ev.waitlistClaimHours, 48);

        const r = await owner.client.put(`/api/event/${ev.id}/waitlist-claim-hours`, { hours: 6 });
        assert.equal(r.status, 200);
        assert.equal(r.body.waitlistClaimHours, 6);

        const fresh = await owner.client.get(`/api/event/${ev.id}`);
        assert.equal(fresh.body.waitlistClaimHours, 6);
    });

    test('is clamped to a sane range and needs manage_event', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1, waitlist: true, ticketPrice: 25 });
        const tooHigh = await owner.client.put(`/api/event/${ev.id}/waitlist-claim-hours`, { hours: 99999 });
        assert.equal(tooHigh.body.waitlistClaimHours, 240);

        const stranger = await newUser(server);
        assert.equal((await stranger.client.put(`/api/event/${ev.id}/waitlist-claim-hours`, { hours: 5 })).status, 403);
    });
});

describe('claim-expiry auto-chain promote', () => {
    test('an unclaimed offer expires and the next person in line is promoted automatically', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1, waitlist: true, ticketPrice: 25 });
        await addTicket(owner.client, ev.id, { name: 'Paid Seat' });

        const firstEmail = uniqueEmail('first-in-line');
        const secondEmail = uniqueEmail('second-in-line');
        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'First', email: firstEmail });
        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Second', email: secondEmail });

        const entries = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body;
        const first = entries.find(e => e.email === firstEmail);
        const promoted = await owner.client.post(`/api/waitlist/${first.id}/promote`, {});
        assert.equal(promoted.body.notified, true);

        // The offer (WAITLIST_CLAIM_MS_OVERRIDE=250ms) lapses, and the sweep
        // (WAITLIST_SWEEP_MS=300ms) should mark it expired and hand the seat
        // to the second person — nobody clicked anything for either step.
        await waitFor(async () => {
            const e = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body.find(x => x.id === first.id);
            return e.status === 'expired';
        });
        const secondNotified = await waitFor(async () => {
            const e = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body.find(x => x.email === secondEmail);
            return e.status === 'notified' ? e : null;
        });
        assert.ok(secondNotified, 'the next person in line was never auto-promoted');

        const mail = await server.waitForEmail(m => m.to === secondEmail && /spot opened up/i.test(m.subject));
        assert.match(mail.html, /claim=/);

        // The waitlist status page reflects the expiry directly (not just
        // via the legacy claimExpired-on-notified shape).
        const firstStatus = await visitor().get(`/api/waitlist/entry/${first.id}`);
        assert.equal(firstStatus.body.status, 'expired');
    });
});

describe('no-show release', () => {
    async function pastEventWithNoShowAndWaiter(capacity = 1) {
        const ev = await createEvent(owner.client, {
            publicRegistration: true, capacity, waitlist: true,
            time: new Date(Date.now() - 3600 * 1000).toISOString(),
        });
        const noShowEmail = uniqueEmail('no-show');
        await publicRegister(visitor(), ev.id, { name: 'Never Showed', email: noShowEmail });
        // fills the last remaining seat over capacity? no — capacity already
        // includes this registrant; anyone past it waitlists.
        const waiterEmail = uniqueEmail('waiting-for-noshow');
        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Waiting Person', email: waiterEmail });
        return { ev, noShowEmail, waiterEmail };
    }

    test('preview reports the not-checked-in and waiting counts', async () => {
        const { ev } = await pastEventWithNoShowAndWaiter();
        const r = await owner.client.get(`/api/event/${ev.id}/no-show-release/preview`);
        assert.equal(r.status, 200);
        assert.equal(r.body.notCheckedInCount, 1);
        assert.equal(r.body.waitingCount, 1);
        assert.equal(r.body.eventStarted, true);
    });

    test('refuses before the event has started', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1, waitlist: true });
        await publicRegister(visitor(), ev.id, { email: uniqueEmail('early-bird') });
        const preview = await owner.client.get(`/api/event/${ev.id}/no-show-release/preview`);
        assert.equal(preview.body.eventStarted, false);
        const r = await owner.client.post(`/api/event/${ev.id}/no-show-release`, { count: 1 });
        assert.equal(r.status, 409);
    });

    test('releasing cancels the no-show ticket and promotes the waiter', async () => {
        const { ev, noShowEmail, waiterEmail } = await pastEventWithNoShowAndWaiter();

        const r = await owner.client.post(`/api/event/${ev.id}/no-show-release`, { count: 1 });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.released, 1);
        assert.equal(r.body.promoted, 1);

        const tickets = await listTickets(owner.client, ev.id);
        assert.ok(!tickets.some(t => t.email === noShowEmail), 'the no-show ticket should have been cancelled');

        const waitlist = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body;
        const waiter = waitlist.find(w => w.email === waiterEmail);
        assert.equal(waiter.status, 'converted', 'a free event should seat the promoted waiter directly');
        assert.ok((await listTickets(owner.client, ev.id)).some(t => t.email === waiterEmail));
    });

    test('never releases a checked-in ticket, and needs both ticket and waitlist capability', async () => {
        const { ev } = await pastEventWithNoShowAndWaiter();
        const tickets = await listTickets(owner.client, ev.id);
        await owner.client.post('/api/validate', { token: tickets[0].token, eventId: ev.id });

        const preview = await owner.client.get(`/api/event/${ev.id}/no-show-release/preview`);
        assert.equal(preview.body.notCheckedInCount, 0);

        const release = await owner.client.post(`/api/event/${ev.id}/no-show-release`, { count: 1 });
        assert.equal(release.status, 409);

        const stranger = await newUser(server);
        assert.equal((await stranger.client.post(`/api/event/${ev.id}/no-show-release`, { count: 1 })).status, 403);
    });
});

describe('live waitlist status stream', () => {
    test('pushes a change ping when someone ahead in line leaves, instead of requiring a poll', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1, waitlist: true });
        await addTicket(owner.client, ev.id, { name: 'Only Seat' });

        const aheadEmail = uniqueEmail('ahead-in-line');
        const watchedEmail = uniqueEmail('watched-entry');
        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Ahead', email: aheadEmail });
        const joined = await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Watched', email: watchedEmail });
        assert.equal(joined.body.position, 2);

        const reader = await openSseReader(`${server.base}/api/waitlist/entry/${joined.body.waitlistId}/stream`);
        try {
            const first = await reader.next();
            assert.equal(first?.type, 'connected');

            const entries = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body;
            const ahead = entries.find(e => e.email === aheadEmail);
            await owner.client.del(`/api/waitlist/${ahead.id}`, {});

            const changed = await reader.next();
            assert.equal(changed?.type, 'changed', 'removing the person ahead should push a change to whoever is behind them');

            // The ping carries no data itself — confirm the page's own re-fetch
            // afterward actually reflects the move up a spot.
            const status = await visitor().get(`/api/waitlist/entry/${joined.body.waitlistId}`);
            assert.equal(status.body.position, 1);
        } finally {
            reader.close();
        }
    });

    test('404s for an unknown entry id instead of opening a stream to nothing', async () => {
        const res = await fetch(`${server.base}/api/waitlist/entry/does-not-exist/stream`);
        assert.equal(res.status, 404);
    });
});
