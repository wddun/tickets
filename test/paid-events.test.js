// Paid ticketing, which is a beta, testing-only feature.
//
// This instance runs with no Stripe key, which is also how a customer's
// instance behaves until their own Stripe account has been connected — so
// these tests cover exactly what an organiser hits when they set a price
// without that being in place, and check that the message says who to
// contact rather than "Stripe not configured".
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, addTicket, listTickets, share, uniqueEmail } from './helpers/factories.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORT_EMAIL = 'support@willstechsupport.com';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const buyer = () => createClient(server.base);

describe('setting a price', () => {
    test('is stored in cents and marks the event paid', async () => {
        const ev = await createEvent(owner.client, { name: 'Paid Event', ticketPrice: 12.5 });
        const fresh = (await owner.client.get(`/api/event/${ev.id}`)).body;
        assert.equal(fresh.ticketPrice, 1250);
    });

    test('setting it back to zero makes the event free again', async () => {
        const ev = await createEvent(owner.client, { name: 'Back To Free', ticketPrice: 10 });
        const fd = new FormData();
        fd.append('name', ev.name);
        fd.append('ticketPrice', '0');
        await owner.client.put(`/api/event/${ev.id}`, undefined, { form: fd });

        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).body.ticketPrice, 0);
    });

    test('a paid event turns the public form into a checkout, not a free signup', async () => {
        const ev = await createEvent(owner.client, { name: 'No Free Lunch', publicRegistration: true, ticketPrice: 30 });
        const r = await buyer().post('/api/register', { name: 'Freeloader', email: uniqueEmail('free'), eventId: ev.id });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /paid/i);
        assert.equal((await listTickets(owner.client, ev.id)).length, 0,
            'posting straight to the free-registration route must not hand out a paid event\'s tickets');
    });
});

describe('checkout without a connected Stripe account', () => {
    test('refuses, and the message names who to contact', async () => {
        const ev = await createEvent(owner.client, { name: 'Unconnected Checkout', publicRegistration: true, ticketPrice: 25 });

        const r = await buyer().post(`/api/checkout/${ev.id}`, { name: 'Would Be Buyer', email: uniqueEmail('buyer') });
        assert.equal(r.status, 503);
        assert.match(r.body.error, new RegExp(SUPPORT_EMAIL),
            'the refusal must say how to get Stripe connected, not just "not configured"');
        assert.equal((await listTickets(owner.client, ev.id)).length, 0, 'no ticket may be issued without payment');
    });

    test('a refund attempt says the same thing', async () => {
        const r = await owner.client.post('/api/orders/some-order/refund', {});
        assert.equal(r.status, 503);
        assert.match(r.body.error, new RegExp(SUPPORT_EMAIL));
    });

    test('the orders list is still readable, and simply empty', async () => {
        const ev = await createEvent(owner.client, { name: 'No Orders Yet', ticketPrice: 40 });
        const r = await owner.client.get(`/api/event/${ev.id}/orders`);
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, []);
    });
});

describe('the dashboard tells the organiser payments are beta', () => {
    // The notice lives in the page, so this reads the shipped file rather
    // than guessing. It is the only warning an organiser gets before their
    // attendees hit a dead checkout.
    const dashboard = fs.readFileSync(path.join(REPO_ROOT, 'public', 'dashboard.html'), 'utf8');

    test('the ticket price field carries a beta notice with the support address', async () => {
        const priceSection = dashboard.slice(dashboard.indexOf('editEventTicketPrice'));
        const notice = priceSection.slice(0, 1500);
        assert.match(notice, /beta/i, 'the price field should say paid ticketing is beta');
        assert.match(notice, new RegExp(SUPPORT_EMAIL), 'the price field should give the support address');
    });

    test('turning an event paid asks for confirmation first', async () => {
        assert.match(dashboard, /Paid ticketing is in beta[\s\S]{0,400}support@willstechsupport\.com/,
            'saving a price for the first time should confirm with a beta warning');
    });

    test('the payments panel is labelled beta and says testing only', async () => {
        const payments = dashboard.slice(dashboard.indexOf('async function renderPaymentsSection'));
        assert.match(payments.slice(0, 4000), /Testing only/i);
        assert.match(payments.slice(0, 4000), new RegExp(SUPPORT_EMAIL));
    });
});

describe('discount codes', () => {
    test('are created, listed, deactivated and deleted', async () => {
        const ev = await createEvent(owner.client, { name: 'Coded Event', ticketPrice: 50 });

        const made = await owner.client.post(`/api/event/${ev.id}/discount-codes`, { code: 'earlybird', type: 'percent', value: 20 });
        assert.equal(made.status, 200);
        assert.equal(made.body.discountCode.code, 'EARLYBIRD', 'codes are stored upper-case');
        assert.equal(made.body.discountCode.active, true);

        const list = await owner.client.get(`/api/event/${ev.id}/discount-codes`);
        assert.equal(list.body.length, 1);

        assert.equal((await owner.client.patch(`/api/discount-codes/${made.body.discountCode.id}`, { active: false })).status, 200);
        assert.equal((await owner.client.get(`/api/event/${ev.id}/discount-codes`)).body[0].active, false);

        assert.equal((await owner.client.del(`/api/discount-codes/${made.body.discountCode.id}`)).status, 200);
        assert.equal((await owner.client.get(`/api/event/${ev.id}/discount-codes`)).body.length, 0);
    });

    test('reject nonsense values', async () => {
        const ev = await createEvent(owner.client, { name: 'Bad Codes', ticketPrice: 50 });
        const post = (body) => owner.client.post(`/api/event/${ev.id}/discount-codes`, body);

        assert.equal((await post({ type: 'percent', value: 10 })).status, 400);
        assert.equal((await post({ code: 'ZERO', type: 'percent', value: 0 })).status, 400);
        assert.equal((await post({ code: 'NEG', type: 'percent', value: -5 })).status, 400);
        assert.equal((await post({ code: 'TOOMUCH', type: 'percent', value: 101 })).status, 400);
    });

    test('refuse a duplicate code on the same event', async () => {
        const ev = await createEvent(owner.client, { name: 'Dupe Codes', ticketPrice: 50 });
        await owner.client.post(`/api/event/${ev.id}/discount-codes`, { code: 'SAME', type: 'percent', value: 10 });
        const again = await owner.client.post(`/api/event/${ev.id}/discount-codes`, { code: 'same', type: 'fixed', value: 500 });
        assert.equal(again.status, 409);
    });

    test('the public preview prices a percentage code', async () => {
        const ev = await createEvent(owner.client, { name: 'Preview Percent', ticketPrice: 50 });
        await owner.client.post(`/api/event/${ev.id}/discount-codes`, { code: 'HALF', type: 'percent', value: 50 });

        const r = await buyer().get(`/api/event/${ev.id}/discount-codes/preview?code=HALF`);
        assert.equal(r.status, 200);
        assert.equal(r.body.valid, true);
        assert.equal(r.body.discountAmount, 2500);
        assert.equal(r.body.finalAmount, 2500);
    });

    test('the public preview prices a fixed-amount code and never goes below zero', async () => {
        const ev = await createEvent(owner.client, { name: 'Preview Fixed', ticketPrice: 10 });
        await owner.client.post(`/api/event/${ev.id}/discount-codes`, { code: 'BIGCUT', type: 'fixed', value: 5000 });

        const r = await buyer().get(`/api/event/${ev.id}/discount-codes/preview?code=BIGCUT`);
        assert.equal(r.body.discountAmount, 1000, 'a discount larger than the price is capped at the price');
        assert.equal(r.body.finalAmount, 0);
    });

    test('the preview rejects an unknown, deactivated, expired or spent code', async () => {
        const ev = await createEvent(owner.client, { name: 'Preview Refusals', ticketPrice: 50 });
        const preview = (code) => buyer().get(`/api/event/${ev.id}/discount-codes/preview?code=${code}`);

        assert.equal((await preview('NOSUCHCODE')).status, 400);

        const off = await owner.client.post(`/api/event/${ev.id}/discount-codes`, { code: 'TURNEDOFF', type: 'percent', value: 10 });
        await owner.client.patch(`/api/discount-codes/${off.body.discountCode.id}`, { active: false });
        const inactive = await preview('TURNEDOFF');
        assert.equal(inactive.status, 400);
        assert.match(inactive.body.error, /no longer active/i);

        await owner.client.post(`/api/event/${ev.id}/discount-codes`, {
            code: 'LASTYEAR', type: 'percent', value: 10, expiresAt: '2020-01-01T00:00:00.000Z',
        });
        const expired = await preview('LASTYEAR');
        assert.equal(expired.status, 400);
        assert.match(expired.body.error, /expired/i);
    });

    test('a code only works on the event it was made for', async () => {
        const a = await createEvent(owner.client, { name: 'Code Event A', ticketPrice: 50 });
        const b = await createEvent(owner.client, { name: 'Code Event B', ticketPrice: 50 });
        await owner.client.post(`/api/event/${a.id}/discount-codes`, { code: 'ONLYHERE', type: 'percent', value: 10 });

        assert.equal((await buyer().get(`/api/event/${a.id}/discount-codes/preview?code=ONLYHERE`)).status, 200);
        assert.equal((await buyer().get(`/api/event/${b.id}/discount-codes/preview?code=ONLYHERE`)).status, 400);
    });

    test('the full code list is not public', async () => {
        const ev = await createEvent(owner.client, { name: 'Private Codes', ticketPrice: 50 });
        await owner.client.post(`/api/event/${ev.id}/discount-codes`, { code: 'SECRET', type: 'percent', value: 90 });

        assert.equal((await buyer().get(`/api/event/${ev.id}/discount-codes`)).status, 401);
        const stranger = await newUser(server);
        assert.equal((await stranger.client.get(`/api/event/${ev.id}/discount-codes`)).status, 403);
    });
});

describe('orders', () => {
    test('need manage_payments to read', async () => {
        const ev = await createEvent(owner.client, { name: 'Orders Guard', ticketPrice: 20 });
        const doorStaff = await newUser(server);
        await share(owner.client, ev.id, doorStaff.email, ['checkin']);

        assert.equal((await doorStaff.client.get(`/api/event/${ev.id}/orders`)).status, 403);
        assert.equal((await buyer().get(`/api/event/${ev.id}/orders`)).status, 401);
    });

    test('refunding an order that does not exist is a 404 once Stripe is connected — and a 503 before that', async () => {
        // With no Stripe account behind it, the connection problem is the
        // first thing the organiser needs to hear about.
        const r = await owner.client.post('/api/orders/nope/refund', {});
        assert.equal(r.status, 503);
    });
});

describe('the at-door tab on a paid event', () => {
    test('is described as sending the customer to the registration link', async () => {
        const ev = await createEvent(owner.client, { name: 'Paid At Door', ticketPrice: 15 });
        await owner.client.put(`/api/event/${ev.id}/at-door`, { enabled: true });

        // There is no separate at-door payment flow — the route says so
        // rather than quietly issuing a free ticket.
        const r = await owner.client.post(`/api/event/${ev.id}/at-door-register`, { name: 'Cash Buyer' });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /registration QR code/i);
        assert.equal((await listTickets(owner.client, ev.id)).length, 0);
    });
});
