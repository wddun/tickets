// The waitlist: joining it when an event is full, watching your position,
// and being promoted off it.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, publicRegister, addTicket, listTickets, uniqueEmail } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const visitor = () => createClient(server.base);

/** A full, open event with the waitlist turned on. */
async function fullEventWithWaitlist(capacity = 1) {
    const ev = await createEvent(owner.client, { publicRegistration: true, capacity, waitlist: true });
    for (let i = 0; i < capacity; i++) await addTicket(owner.client, ev.id, { name: `Seat ${i}` });
    return ev;
}

describe('joining the waitlist', () => {
    test('a full event waitlists a registration instead of refusing it', async () => {
        const ev = await fullEventWithWaitlist();
        const email = uniqueEmail('waiting');

        const r = await publicRegister(visitor(), ev.id, { name: 'Patient Person', email });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.waitlisted, true);
        assert.equal(r.body.position, 1);
        assert.ok(r.body.waitlistId);
    });

    test('a full event with no waitlist still refuses outright', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1 });
        await addTicket(owner.client, ev.id, { name: 'Only Seat' });

        const r = await publicRegister(visitor(), ev.id);
        assert.equal(r.status, 400);
        assert.equal(r.body.reason, 'sold_out');
    });

    test('two people joining in the same millisecond still get distinct positions', async () => {
        // createdAt has millisecond resolution, so a burst of joins shared a
        // timestamp and everyone in it was told they were the same number in
        // the queue. Insertion order breaks the tie.
        const ev = await fullEventWithWaitlist();
        const joins = await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
                publicRegister(visitor(), ev.id, { name: `Burst ${i}`, email: uniqueEmail(`burst${i}`) })),
        );
        const positions = joins.map(r => r.body.position).sort((a, b) => a - b);
        assert.deepEqual(positions, [1, 2, 3, 4, 5, 6], 'every position in the queue must be distinct');
    });

    test('positions are handed out in the order people arrive', async () => {
        const ev = await fullEventWithWaitlist();
        const first = await publicRegister(visitor(), ev.id, { name: 'First In', email: uniqueEmail('w1') });
        const second = await publicRegister(visitor(), ev.id, { name: 'Second In', email: uniqueEmail('w2') });
        const third = await publicRegister(visitor(), ev.id, { name: 'Third In', email: uniqueEmail('w3') });

        assert.equal(first.body.position, 1);
        assert.equal(second.body.position, 2);
        assert.equal(third.body.position, 3);
    });

    test('joining twice keeps the original place in line', async () => {
        const ev = await fullEventWithWaitlist();
        const email = uniqueEmail('repeat-waiter');
        const first = await publicRegister(visitor(), ev.id, { email });
        await publicRegister(visitor(), ev.id, { email: uniqueEmail('someone-else') });

        const again = await publicRegister(visitor(), ev.id, { email });
        assert.equal(again.body.alreadyOnList, true);
        assert.equal(again.body.position, first.body.position);

        assert.equal((await owner.client.get(`/api/event/${ev.id}/waitlist`)).body.length, 2);
    });

    test('emails a confirmation with the position and a status link', async () => {
        const ev = await fullEventWithWaitlist();
        const email = uniqueEmail('mailed-waiter');
        await publicRegister(visitor(), ev.id, { email });

        const mail = await server.waitForEmail(m => m.to === email && /waitlist/i.test(m.subject));
        assert.match(mail.html, /waitlist-status\.html\?id=/);
    });

    test('a custom waitlist email template changes what is actually sent', async () => {
        const ev = await fullEventWithWaitlist();
        const template = {
            version: 1,
            settings: { accent: 'auto', pageBackground: '#f3f4f6', cardBackground: '#ffffff', subject: 'Waitlist for {{eventName}}' },
            blocks: [
                { id: 'b-header', type: 'header', props: { eyebrow: 'Waitlist', title: '{{eventName}}' } },
                { id: 'b-position', type: 'waitlistPosition', props: {} },
                { id: 'b-body', type: 'text', props: { text: "We'll email you if we have shirts left over.", size: 'sm', align: 'left', color: '#64748b' } },
                { id: 'b-button', type: 'waitlistStatusButton', props: {} },
            ],
        };
        const set = await owner.client.put(`/api/event/${ev.id}/email-template`, { template, variant: 'waitlist' });
        assert.equal(set.status, 200, set.text);
        assert.equal(set.body.customized, true);

        const email = uniqueEmail('custom-template-waiter');
        await publicRegister(visitor(), ev.id, { email });

        const mail = await server.waitForEmail(m => m.to === email && /shirts left over/.test(m.html));
        assert.match(mail.subject, new RegExp(`Waitlist for ${ev.name}`));
        assert.match(mail.html, /waitlist-status\.html\?id=/);
        assert.doesNotMatch(mail.html, /notified by email if a spot becomes available/);
    });

    test('ticket-only blocks are stripped from a waitlist template', async () => {
        const ev = await fullEventWithWaitlist();
        const template = {
            version: 1,
            settings: { accent: 'auto', pageBackground: '#f3f4f6', cardBackground: '#ffffff', subject: '' },
            blocks: [{ id: 'b-tickets', type: 'tickets', props: { showWallet: true, showToken: true } }],
        };
        const r = await owner.client.put(`/api/event/${ev.id}/email-template`, { template, variant: 'waitlist' });
        assert.equal(r.status, 200, r.text);
        // Invalid for this variant, filtered out, and the block list falls
        // back to the default rather than saving empty.
        assert.ok(r.body.template.blocks.length > 0);
        assert.ok(!r.body.template.blocks.some(b => b.type === 'tickets'));
    });

    test('GET reports the waitlist template alongside the ticket and winner ones', async () => {
        const ev = await fullEventWithWaitlist();
        const r = await owner.client.get(`/api/event/${ev.id}/email-template`);
        assert.equal(r.status, 200);
        assert.equal(r.body.waitlistCustomized, false);
        assert.ok(r.body.waitlistTemplate.blocks.some(b => b.type === 'waitlistPosition'));
    });

    test('the waitlist email preview renders through the same renderer', async () => {
        const ev = await fullEventWithWaitlist();
        const r = await owner.client.post(`/api/event/${ev.id}/email-template/preview`, { template: null, variant: 'waitlist' });
        assert.equal(r.status, 200, r.text);
        assert.match(r.body.html, /You are number <strong>3<\/strong> in line/);
    });

    test('setting the waitlist email template needs manage_event', async () => {
        const ev = await fullEventWithWaitlist();
        const stranger = await newUser(server);
        const r = await stranger.client.put(`/api/event/${ev.id}/email-template`, { template: null, variant: 'waitlist' });
        assert.equal(r.status, 403);
    });

    test('can be joined directly, without going through a refused registration', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 5, waitlist: true });
        const r = await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Direct Join', email: uniqueEmail('direct') });
        assert.equal(r.status, 200);
        assert.equal(r.body.waitlisted, true);
    });

    test('is refused on an event with no waitlist', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true });
        const r = await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Nope', email: uniqueEmail('nope') });
        assert.equal(r.status, 403);
    });

    test('needs a name and an email', async () => {
        const ev = await fullEventWithWaitlist();
        assert.equal((await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'No Email' })).status, 400);
        assert.equal((await visitor().post(`/api/event/${ev.id}/waitlist`, { email: 'a@test.local' })).status, 400);
    });
});

describe('checking your own place in line', () => {
    test('is public, by entry id, and reports the live position', async () => {
        const ev = await fullEventWithWaitlist();
        const first = await publicRegister(visitor(), ev.id, { email: uniqueEmail('pos1') });
        const second = await publicRegister(visitor(), ev.id, { email: uniqueEmail('pos2') });

        const status = await visitor().get(`/api/waitlist/entry/${second.body.waitlistId}`);
        assert.equal(status.status, 200);
        assert.equal(status.body.status, 'waiting');
        assert.equal(status.body.position, 2);
        assert.equal(status.body.eventName, ev.name);
        assert.equal(status.body.isPaid, false);

        // Once the person ahead is promoted, everyone behind moves up.
        const entries = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body;
        const firstEntry = entries.find(e => e.id === first.body.waitlistId);
        await owner.client.post(`/api/waitlist/${firstEntry.id}/promote`, {});

        const moved = await visitor().get(`/api/waitlist/entry/${second.body.waitlistId}`);
        assert.equal(moved.body.position, 1);
    });

    test('404s an id that does not exist', async () => {
        assert.equal((await visitor().get('/api/waitlist/entry/nope')).status, 404);
    });
});

describe('promoting someone off the waitlist', () => {
    test('a free event issues the ticket straight away and emails it', async () => {
        const ev = await fullEventWithWaitlist();
        const email = uniqueEmail('promoted');
        await publicRegister(visitor(), ev.id, { name: 'Lucky Person', email });

        const entry = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body[0];
        const r = await owner.client.post(`/api/waitlist/${entry.id}/promote`, {});
        assert.equal(r.status, 200, r.text);
        assert.ok(r.body.ticket?.token, 'no ticket issued on promotion');

        const entries = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body;
        assert.equal(entries.find(e => e.id === entry.id).status, 'converted');

        const tickets = await listTickets(owner.client, ev.id);
        assert.ok(tickets.some(t => t.email === email), 'the promoted person has no ticket');
    });

    test('seats them even though the event is full — that is the point', async () => {
        const ev = await fullEventWithWaitlist(2);
        await publicRegister(visitor(), ev.id, { email: uniqueEmail('over-capacity') });

        const entry = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body[0];
        assert.equal((await owner.client.post(`/api/waitlist/${entry.id}/promote`, {})).status, 200);

        // The organiser explicitly chose to seat this person, e.g. after a
        // cancellation, so the ticket count is allowed past capacity here.
        assert.equal((await listTickets(owner.client, ev.id)).length, 3);
    });

    test('a paid event sends a claim link instead of issuing a ticket', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1, waitlist: true, ticketPrice: 25 });
        await addTicket(owner.client, ev.id, { name: 'Paid Seat' });

        const email = uniqueEmail('paid-waiter');
        const joined = await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Paid Waiter', email });
        assert.equal(joined.status, 200);

        const entry = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body[0];
        const r = await owner.client.post(`/api/waitlist/${entry.id}/promote`, {});
        assert.equal(r.status, 200);
        assert.equal(r.body.notified, true, 'a paid promotion must not issue a free ticket');
        assert.equal(r.body.ticket, undefined);

        // No ticket was created — money still only changes hands through Stripe.
        assert.ok(!(await listTickets(owner.client, ev.id)).some(t => t.email === email));

        const mail = await server.waitForEmail(m => m.to === email && /spot is available/i.test(m.subject));
        assert.match(mail.html, /register\.html\?id=[^&]+&claim=/);

        // The claim is a real reservation: the status route hands the same
        // link back so the page can show it.
        const status = await visitor().get(`/api/waitlist/entry/${entry.id}`);
        assert.equal(status.body.status, 'notified');
        assert.ok(status.body.claimUrl?.includes('claim='));
        assert.equal(status.body.claimExpired, false);
    });

    test('an unclaimed paid offer holds the seat against other buyers', async () => {
        const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 2, waitlist: true, ticketPrice: 25 });
        await addTicket(owner.client, ev.id, { name: 'First Paid Seat' });

        await visitor().post(`/api/event/${ev.id}/waitlist`, { name: 'Offered Person', email: uniqueEmail('offered') });
        const entry = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body[0];
        await owner.client.post(`/api/waitlist/${entry.id}/promote`, {});

        // One issued + one unclaimed offer = both seats spoken for.
        const seen = (await visitor().get(`/api/event/${ev.id}/availability`)).body;
        assert.equal(seen.soldOut, true, 'an outstanding claim offer must occupy its seat');

        const jumper = await visitor().post(`/api/event/${ev.id}/hold`, {});
        assert.equal(jumper.status, 409);
    });

    test('needs manage_waitlist, and 404s an unknown entry', async () => {
        const ev = await fullEventWithWaitlist();
        await publicRegister(visitor(), ev.id, { email: uniqueEmail('guarded') });
        const entry = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body[0];

        const stranger = await newUser(server);
        assert.equal((await stranger.client.post(`/api/waitlist/${entry.id}/promote`, {})).status, 403);
        assert.equal((await owner.client.post('/api/waitlist/nope/promote', {})).status, 404);
    });
});

describe('managing the list', () => {
    test('the owner can read it and a stranger cannot', async () => {
        const ev = await fullEventWithWaitlist();
        await publicRegister(visitor(), ev.id, { name: 'Listed Person', email: uniqueEmail('listed') });

        const list = await owner.client.get(`/api/event/${ev.id}/waitlist`);
        assert.equal(list.status, 200);
        assert.equal(list.body.length, 1);
        assert.equal(list.body[0].name, 'Listed Person');
        assert.equal(list.body[0].status, 'waiting');

        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/event/${ev.id}/waitlist`)).status, 403);

        const anon = createClient(server.base);
        assert.equal((await anon.get(`/api/event/${ev.id}/waitlist`)).status, 401);
    });

    test('an entry can be removed, which frees the place for those behind', async () => {
        const ev = await fullEventWithWaitlist();
        const first = await publicRegister(visitor(), ev.id, { email: uniqueEmail('r1') });
        const second = await publicRegister(visitor(), ev.id, { email: uniqueEmail('r2') });

        assert.equal((await owner.client.del(`/api/waitlist/${first.body.waitlistId}`)).status, 200);
        assert.equal((await owner.client.get(`/api/event/${ev.id}/waitlist`)).body.length, 1);

        const moved = await visitor().get(`/api/waitlist/entry/${second.body.waitlistId}`);
        assert.equal(moved.body.position, 1);
    });

    test('removal needs manage_waitlist', async () => {
        const ev = await fullEventWithWaitlist();
        const joined = await publicRegister(visitor(), ev.id, { email: uniqueEmail('protected') });
        const stranger = await newUser(server);
        assert.equal((await stranger.client.del(`/api/waitlist/${joined.body.waitlistId}`)).status, 403);
    });

    test('turning the waitlist off makes a full event refuse again', async () => {
        const ev = await fullEventWithWaitlist();
        assert.equal((await publicRegister(visitor(), ev.id, { email: uniqueEmail('before-off') })).body.waitlisted, true);

        await owner.client.put(`/api/event/${ev.id}/waitlist-enabled`, { enabled: false });

        const r = await publicRegister(visitor(), ev.id, { email: uniqueEmail('after-off') });
        assert.equal(r.status, 400);
        assert.equal(r.body.reason, 'sold_out');
    });
});
