// Admin Overview -> Phone Call. The real server talks to a fake Asterisk
// Manager Interface (a TCP server in this file) and a stand-in speech
// generator (a tiny node script), so the whole flow runs — speech file,
// originate, answer, hangup — without a PBX or Kokoro on the test machine.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, newAdmin } from './helpers/factories.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** A fake AMI: logs in anyone with the right secret, records every action, answers originates. */
function startFakeAmi({ secret }) {
    const actions = [];
    const server = net.createServer(sock => {
        sock.write('Asterisk Call Manager/7.0.3\r\n');
        let buf = '';
        sock.on('data', chunk => {
            buf += chunk;
            let end;
            while ((end = buf.indexOf('\r\n\r\n')) !== -1) {
                const msg = {};
                for (const line of buf.slice(0, end).split('\r\n')) {
                    const i = line.indexOf(':');
                    if (i > 0) msg[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                }
                buf = buf.slice(end + 4);
                actions.push(msg);
                const reply = (fields) => sock.write(Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
                if (msg.Action === 'Login') {
                    reply({ Response: msg.Secret === secret ? 'Success' : 'Error', ActionID: msg.ActionID, Message: 'Authentication' });
                } else if (msg.Action === 'Originate') {
                    reply({ Response: 'Success', ActionID: msg.ActionID, Message: 'Originate successfully queued' });
                    const chan = `${msg.Channel}-00000001;1`;
                    // A number ending 0003 never picks up; everything else answers, then hangs up.
                    if (msg.Channel.includes('0003@')) {
                        setTimeout(() => reply({ Event: 'OriginateResponse', ActionID: msg.ActionID, Response: 'Failure', Channel: msg.Channel, Reason: '3' }), 50);
                    } else {
                        setTimeout(() => reply({ Event: 'OriginateResponse', ActionID: msg.ActionID, Response: 'Success', Channel: chan, Reason: '4' }), 50);
                        setTimeout(() => reply({ Event: 'Hangup', Channel: chan, Cause: '16' }), 300);
                    }
                }
            }
        });
        sock.on('error', () => {});
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        actions,
        close: () => new Promise(r => server.close(r)),
    })));
}

let plain, wired, ami, ttsDir, fakeTts;
let plainAdmin, plainUser, admin;

before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-phone-'));
    ttsDir = path.join(dir, 'tts');
    fs.mkdirSync(ttsDir);
    // Stand-in for Kokoro's say.py: same arguments, writes <base>.wav16. "slow" in the text takes a second.
    fakeTts = path.join(dir, 'fake-tts.mjs');
    fs.writeFileSync(fakeTts, `
        import fs from 'node:fs';
        const [text, base, voice] = process.argv.slice(2);
        if (text.includes('slow')) await new Promise(r => setTimeout(r, 1000));
        fs.writeFileSync(base + '.wav16', 'RIFF' + voice);
    `);
    ami = await startFakeAmi({ secret: 'ami-test-secret' });

    plain = await startServer({ env: { PHONE_AMI_USER: '', PHONE_AMI_SECRET: '', PHONE_TTS_PYTHON: '', PHONE_TTS_SCRIPT: '' } });
    plainAdmin = await newAdmin(plain);
    plainUser = await newUser(plain);

    wired = await startServer({ env: {
        PHONE_AMI_PORT: String(ami.port),
        PHONE_AMI_USER: 'tickets',
        PHONE_AMI_SECRET: 'ami-test-secret',
        PHONE_TTS_PYTHON: process.execPath,
        PHONE_TTS_SCRIPT: fakeTts,
        PHONE_TTS_DIR: ttsDir,
        PHONE_EXTENSIONS: '101:Desk phone,102:iPhone',
    } });
    admin = await newAdmin(wired);
});

after(async () => {
    await plain?.stop();
    await wired?.stop();
    await ami?.close();
});

async function waitForCall(client, id, done = c => c.status === 'ended' || c.status === 'failed') {
    const until = Date.now() + 8000;
    for (;;) {
        const r = await client.get(`/api/admin/phone/call/${id}`);
        if (r.status === 200 && done(r.body.call)) return r.body.call;
        if (Date.now() > until) throw new Error('call never finished: ' + JSON.stringify(r.body));
        await sleep(50);
    }
}

describe('access and the off switch', () => {
    test('is admin only', async () => {
        const anon = createClient(plain.base);
        assert.equal((await anon.get('/api/admin/phone')).status, 401);
        assert.equal((await plainUser.client.get('/api/admin/phone')).status, 403);
        assert.equal((await plainUser.client.post('/api/admin/phone/call', { target: '102', text: 'hi' })).status, 403);
    });

    test('without the PHONE_* settings the tool reports itself off and refuses calls', async () => {
        const r = await plainAdmin.client.get('/api/admin/phone');
        assert.equal(r.status, 200);
        assert.equal(r.body.enabled, false);
        const call = await plainAdmin.client.post('/api/admin/phone/call', { target: '102', text: 'hi' });
        assert.equal(call.status, 503);
    });
});

describe('placing calls', () => {
    test('lists extensions and voices when set up', async () => {
        const r = await admin.client.get('/api/admin/phone');
        assert.equal(r.body.enabled, true);
        assert.deepEqual(r.body.extensions.map(e => e.ext), ['101', '102']);
        assert.ok(r.body.voices.some(v => v.id === 'af_heart'));
    });

    test('an extension call renders speech, rings Local/<ext>@ring-ext and plays it in say-text', async () => {
        const r = await admin.client.post('/api/admin/phone/call', { target: '102', text: 'Hello from the tests', voice: 'am_michael' });
        assert.equal(r.status, 202, r.text);
        assert.equal(r.body.call.status, 'generating');

        const call = await waitForCall(admin.client, r.body.call.id);
        assert.equal(call.status, 'ended');
        assert.ok(call.answeredAt && call.endedAt);

        const login = ami.actions.find(a => a.Action === 'Login');
        assert.equal(login.Username, 'tickets');
        const orig = ami.actions.filter(a => a.Action === 'Originate').at(-1);
        assert.equal(orig.Channel, 'Local/102@ring-ext');
        assert.equal(orig.Context, 'say-text');
        assert.equal(orig.Exten, 's');
        assert.equal(orig.Variable, `PROMPT=${path.join(ttsDir, `call-${call.id}`)}`);
        // The audio is gone once the call is over.
        assert.deepEqual(fs.readdirSync(ttsDir), []);
    });

    test('a typed number is normalised to E.164 and dialled through callout', async () => {
        const r = await admin.client.post('/api/admin/phone/call', { target: '(919) 555-0123', text: 'Your repair is ready' });
        assert.equal(r.status, 202, r.text);
        assert.equal(r.body.call.label, '(919) 555-0123');
        await waitForCall(admin.client, r.body.call.id);
        const orig = ami.actions.filter(a => a.Action === 'Originate').at(-1);
        assert.equal(orig.Channel, 'Local/+19195550123@callout');
    });

    test('no answer is reported as a failed call with the reason', async () => {
        const r = await admin.client.post('/api/admin/phone/call', { target: '919-555-0003', text: 'Anyone there?' });
        const call = await waitForCall(admin.client, r.body.call.id);
        assert.equal(call.status, 'failed');
        assert.equal(call.detail, 'No answer');
    });

    test('only one call at a time', async () => {
        const first = await admin.client.post('/api/admin/phone/call', { target: '101', text: 'slow one' });
        assert.equal(first.status, 202);
        const second = await admin.client.post('/api/admin/phone/call', { target: '102', text: 'second' });
        assert.equal(second.status, 409);
        await waitForCall(admin.client, first.body.call.id);
    });

    test('bad input is refused before anything is generated or dialled', async () => {
        const before = ami.actions.length;
        const bad = [
            { target: '+44 20 7946 0958', text: 'hi' },     // international
            { target: '900-555-1234', text: 'hi' },         // premium rate
            { target: '555', text: 'hi' },                  // not an extension or a number
            { target: '102', text: '   ' },                 // nothing to say
            { target: '102', text: 'x'.repeat(501) },       // too long
            { target: '102', text: 'hi', voice: 'nope' },   // unknown voice
        ];
        for (const body of bad) {
            const r = await admin.client.post('/api/admin/phone/call', body);
            assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
        }
        assert.equal(ami.actions.length, before);
    });

    test('each call lands in the audit log without the message text', async () => {
        const r = await admin.client.get('/api/admin/audit-log?limit=200');
        const entry = (r.body.entries || []).find(e => e.action === 'phone.call');
        assert.ok(entry, 'phone.call audit entry');
        assert.ok(!JSON.stringify(entry).includes('Hello from the tests'));
    });
});
