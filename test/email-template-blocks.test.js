// Email block-editor normalization and rendering: the spacer/image "0 is
// falsy" bug, and the divider/button/text/image customization added
// alongside the fix.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { newUser, createEvent } from './helpers/factories.js';

let server, owner;
before(async () => {
    server = await startServer();
    owner = await newUser(server);
});
after(async () => { await server?.stop(); });

const baseSettings = { accent: 'auto', pageBackground: '#f3f4f6', cardBackground: '#ffffff', subject: '' };
function templateWith(blocks, settings = baseSettings) {
    return { version: 1, settings, blocks };
}

describe('spacer height normalization', () => {
    // parseInt(p.height, 10) || 16 treated an explicit 0 as absent (0 is
    // falsy in JS), silently turning a deliberately tight/no-gap spacer into
    // the 16px default — bigger than even a plain 4px spacer.
    test('an explicit 0 clamps to the 4px minimum, not the 16px default', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.put(`/api/event/${ev.id}/email-template`, {
            template: templateWith([{ id: 'b1', type: 'spacer', props: { height: 0 } }]),
            variant: 'ticket',
        });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.template.blocks[0].props.height, 4);
    });

    test('a missing height still falls back to the 16px default', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.put(`/api/event/${ev.id}/email-template`, {
            template: templateWith([{ id: 'b1', type: 'spacer', props: {} }]),
            variant: 'ticket',
        });
        assert.equal(r.body.template.blocks[0].props.height, 16);
    });

    test('an in-range height is kept as-is', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.put(`/api/event/${ev.id}/email-template`, {
            template: templateWith([{ id: 'b1', type: 'spacer', props: { height: 40 } }]),
            variant: 'ticket',
        });
        assert.equal(r.body.template.blocks[0].props.height, 40);
    });
});

describe('image width normalization', () => {
    test('an explicit 0 clamps to the 40px minimum, not the 320px default', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.put(`/api/event/${ev.id}/email-template`, {
            template: templateWith([{ id: 'b1', type: 'image', props: { url: 'https://example.com/a.png', width: 0 } }]),
            variant: 'ticket',
        });
        assert.equal(r.body.template.blocks[0].props.width, 40);
    });
});

describe('divider customization', () => {
    test('colour and thickness are stored and clamp to sane bounds', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.put(`/api/event/${ev.id}/email-template`, {
            template: templateWith([{ id: 'b1', type: 'divider', props: { color: '#ff0000', thickness: 3 } }]),
            variant: 'ticket',
        });
        assert.equal(r.body.template.blocks[0].props.color, '#ff0000');
        assert.equal(r.body.template.blocks[0].props.thickness, 3);

        const capped = await owner.client.put(`/api/event/${ev.id}/email-template`, {
            template: templateWith([{ id: 'b1', type: 'divider', props: { thickness: 999 } }]),
            variant: 'ticket',
        });
        assert.equal(capped.body.template.blocks[0].props.thickness, 6, 'thickness caps at 6px');
    });

    test('renders with the custom colour and thickness in the actual email', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.post(`/api/event/${ev.id}/email-template/preview`, {
            template: templateWith([{ id: 'b1', type: 'divider', props: { color: '#ff0000', thickness: 3 } }]),
            variant: 'ticket',
        });
        assert.equal(r.status, 200, r.text);
        assert.match(r.body.html, /border-top:3px solid #ff0000/);
    });
});

describe('button colour override', () => {
    test('defaults to the template accent colour', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.post(`/api/event/${ev.id}/email-template/preview`, {
            template: templateWith(
                [{ id: 'b1', type: 'button', props: { label: 'Go', url: 'https://example.com', align: 'center', color: 'auto' } }],
                { ...baseSettings, accent: '#123456' },
            ),
            variant: 'ticket',
        });
        assert.equal(r.status, 200, r.text);
        assert.match(r.body.html, /background:#123456/);
    });

    test('a custom colour overrides the accent', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.post(`/api/event/${ev.id}/email-template/preview`, {
            template: templateWith(
                [{ id: 'b1', type: 'button', props: { label: 'Go', url: 'https://example.com', align: 'center', color: '#abcdef' } }],
                { ...baseSettings, accent: '#123456' },
            ),
            variant: 'ticket',
        });
        assert.match(r.body.html, /background:#abcdef/);
        assert.doesNotMatch(r.body.html, /background:#123456/);
    });
});

describe('text bold', () => {
    test('renders a heavier font-weight when on', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.post(`/api/event/${ev.id}/email-template/preview`, {
            template: templateWith([{ id: 'b1', type: 'text', props: { text: 'Hello there', size: 'sm', align: 'left', color: '#555555', bold: true } }]),
            variant: 'ticket',
        });
        assert.match(r.body.html, /font-weight:700[^>]*>Hello there/);
    });

    test('stays at normal weight by default', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.post(`/api/event/${ev.id}/email-template/preview`, {
            template: templateWith([{ id: 'b1', type: 'text', props: { text: 'Hello there', size: 'sm', align: 'left', color: '#555555' } }]),
            variant: 'ticket',
        });
        assert.match(r.body.html, /font-weight:400[^>]*>Hello there/);
    });
});

describe('image alt text', () => {
    test('is escaped and rendered on the img tag', async () => {
        const ev = await createEvent(owner.client);
        const r = await owner.client.post(`/api/event/${ev.id}/email-template/preview`, {
            template: templateWith([{ id: 'b1', type: 'image', props: { url: 'https://example.com/a.png', width: 300, align: 'center', alt: 'A <cute> logo' } }]),
            variant: 'ticket',
        });
        assert.match(r.body.html, /alt="A &lt;cute&gt; logo"/);
    });
});
