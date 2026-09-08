// Custom field definitions: short-answer and multiple-choice questions an
// organiser can attach to an event, optionally surfaced as real questions on
// the public registration form (register.html) rather than staff-only boxes
// filled in from the dashboard.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, createEvent, publicRegister, listTickets, uniqueEmail } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const visitor = () => createClient(server.base);

async function setFields(eventId, fields) {
    const r = await owner.client.patch(`/api/event/${eventId}`, { customFields: fields });
    assert.equal(r.status, 200, r.text);
    return r.body.customFields;
}

describe('defining custom fields', () => {
    test('a multiple-choice field with no options is dropped — nothing to choose from', async () => {
        const ev = await createEvent(owner.client, { name: 'No Options' });
        const saved = await setFields(ev.id, [
            { label: 'Size', type: 'multiple_choice', options: [] },
            { label: 'Notes', type: 'short_answer' },
        ]);
        assert.deepEqual(saved.map(f => f.label), ['Notes']);
    });

    test('options are deduplicated and capped', async () => {
        const ev = await createEvent(owner.client, { name: 'Dupe Options' });
        const saved = await setFields(ev.id, [
            { label: 'Size', type: 'multiple_choice', options: ['S', 'M', 'S', 'L'] },
        ]);
        assert.deepEqual(saved[0].options, ['S', 'M', 'L']);
    });

    test('an unlabeled field is dropped', async () => {
        const ev = await createEvent(owner.client, { name: 'No Label' });
        const saved = await setFields(ev.id, [{ label: '  ', type: 'short_answer' }, { label: 'Real Field' }]);
        assert.deepEqual(saved.map(f => f.label), ['Real Field']);
    });
});

describe('the public registration form', () => {
    test('only shows fields the organiser opted into showing publicly', async () => {
        const ev = await createEvent(owner.client, { name: 'Mixed Fields', publicRegistration: true });
        await setFields(ev.id, [
            { label: 'Public Question', type: 'short_answer', showOnPublicForm: true },
            { label: 'Staff Only Notes', type: 'short_answer', showOnPublicForm: false },
        ]);
        const seen = (await visitor().get(`/api/event/${ev.id}`)).body.customFields;
        assert.deepEqual(seen.map(f => f.label), ['Public Question']);
    });

    test('a required field left blank is refused', async () => {
        const ev = await createEvent(owner.client, { name: 'Required Field', publicRegistration: true });
        await setFields(ev.id, [{ label: 'Dietary needs', type: 'short_answer', required: true, showOnPublicForm: true }]);

        const r = await publicRegister(visitor(), ev.id, { name: 'No Answer', email: uniqueEmail('noanswer') });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /Dietary needs/);
    });

    test('a multiple-choice answer outside the defined options is refused', async () => {
        const ev = await createEvent(owner.client, { name: 'Bad Option', publicRegistration: true });
        await setFields(ev.id, [{ label: 'Size', type: 'multiple_choice', options: ['S', 'M', 'L'], showOnPublicForm: true }]);

        const r = await publicRegister(visitor(), ev.id, {
            name: 'Sneaky', email: uniqueEmail('sneaky'), customFields: { Size: 'XXL' },
        });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /Size/);
    });

    test('a valid answer is stored on the ticket', async () => {
        const ev = await createEvent(owner.client, { name: 'Good Answer', publicRegistration: true });
        await setFields(ev.id, [
            { label: 'Size', type: 'multiple_choice', options: ['S', 'M', 'L'], showOnPublicForm: true },
            { label: 'Notes', type: 'short_answer', showOnPublicForm: true },
        ]);
        const email = uniqueEmail('good-answer');
        const r = await publicRegister(visitor(), ev.id, {
            name: 'Answered Everything', email, customFields: { Size: 'M', Notes: 'Aisle seat please' },
        });
        assert.equal(r.status, 200, r.text);

        const tickets = await listTickets(owner.client, ev.id);
        const ticket = tickets.find(t => t.email === email);
        assert.equal(ticket.customFields.Size, 'M');
        assert.equal(ticket.customFields.Notes, 'Aisle seat please');
    });

    test('a key that is not a public field is ignored — the form cannot smuggle extra data onto the ticket', async () => {
        const ev = await createEvent(owner.client, { name: 'No Smuggling', publicRegistration: true });
        await setFields(ev.id, [
            { label: 'Public Question', type: 'short_answer', showOnPublicForm: true },
            { label: 'Internal Notes', type: 'short_answer', showOnPublicForm: false },
        ]);
        const email = uniqueEmail('smuggler');
        const r = await publicRegister(visitor(), ev.id, {
            name: 'Sneaky Two', email,
            customFields: { 'Public Question': 'fine', 'Internal Notes': 'should not land', 'Made Up Field': 'nope' },
        });
        assert.equal(r.status, 200, r.text);

        const tickets = await listTickets(owner.client, ev.id);
        const ticket = tickets.find(t => t.email === email);
        assert.deepEqual(ticket.customFields, { 'Public Question': 'fine' });
    });

    test('an optional field left blank is simply omitted, not an error', async () => {
        const ev = await createEvent(owner.client, { name: 'Optional Field', publicRegistration: true });
        await setFields(ev.id, [{ label: 'Notes', type: 'short_answer', showOnPublicForm: true, required: false }]);
        const email = uniqueEmail('blank-optional');
        const r = await publicRegister(visitor(), ev.id, { name: 'No Notes', email, customFields: {} });
        assert.equal(r.status, 200, r.text);

        const tickets = await listTickets(owner.client, ev.id);
        const ticket = tickets.find(t => t.email === email);
        assert.deepEqual(ticket.customFields, {});
    });
});

describe('carrying answers through the waitlist', () => {
    test('an answer given while joining survives promotion to a free ticket', async () => {
        const ev = await createEvent(owner.client, { name: 'Waitlist Fields', publicRegistration: true, capacity: 1, waitlist: true });
        await owner.client.post(`/api/event/${ev.id}/ticket`, { name: 'Only Seat', email: uniqueEmail('seat'), noEmail: true });
        await setFields(ev.id, [{ label: 'Meal', type: 'multiple_choice', options: ['Veg', 'Meat'], showOnPublicForm: true }]);

        const email = uniqueEmail('waiting-with-answer');
        const joined = await publicRegister(visitor(), ev.id, { name: 'Patient Person', email, customFields: { Meal: 'Veg' } });
        assert.equal(joined.status, 200, joined.text);
        assert.equal(joined.body.waitlisted, true);

        const entry = (await owner.client.get(`/api/event/${ev.id}/waitlist`)).body[0];
        assert.equal(entry.customFields.Meal, 'Veg');

        const promoted = await owner.client.post(`/api/waitlist/${entry.id}/promote`, {});
        assert.equal(promoted.status, 200, promoted.text);

        const tickets = await listTickets(owner.client, ev.id);
        const ticket = tickets.find(t => t.email === email);
        assert.equal(ticket.customFields.Meal, 'Veg');
    });
});
