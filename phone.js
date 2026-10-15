// Admin "Phone Call" tool: speak typed text to an internal extension or a phone number.
//
// The PBX is Asterisk on this same server (see the wts-phone repo's pbx/ folder). A call is:
//   1. Kokoro-82M renders the text to <PHONE_TTS_DIR>/<id>.wav16 (PHONE_TTS_PYTHON + PHONE_TTS_SCRIPT).
//   2. An AMI Originate on 127.0.0.1 dials Local/<ext>@ring-ext or Local/<+1number>@callout and,
//      once answered, runs the say-text context with PROMPT pointing at that file.
//   3. AMI events move the call through dialing -> answered -> ended (or failed).
//
// Nothing here is persisted: the recent-calls list lives in memory, and each
// call's audio is deleted once the call is over. The audit log records who
// called where (server.js).
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';

export const MAX_CHARS = 500;
export const VOICES = [
    { id: 'af_heart', label: 'Heart (US female)' },
    { id: 'af_bella', label: 'Bella (US female)' },
    { id: 'am_michael', label: 'Michael (US male)' },
    { id: 'am_fenrir', label: 'Fenrir (US male)' },
    { id: 'bf_emma', label: 'Emma (UK female)' },
    { id: 'bm_george', label: 'George (UK male)' },
];

const TTS_TIMEOUT_MS = 180_000;
const RING_TIMEOUT_MS = 45_000;
const MAX_CALL_MS = 10 * 60_000;
const KEEP_RECENT = 20;

function config() {
    const env = process.env;
    return {
        amiHost: env.PHONE_AMI_HOST || '127.0.0.1',
        amiPort: Number(env.PHONE_AMI_PORT || 5038),
        amiUser: env.PHONE_AMI_USER || '',
        amiSecret: env.PHONE_AMI_SECRET || '',
        ttsPython: env.PHONE_TTS_PYTHON || '',
        ttsScript: env.PHONE_TTS_SCRIPT || '',
        ttsDir: env.PHONE_TTS_DIR || '/var/lib/wts-tts',
        // "101:Desk phone,102:iPhone"
        extensions: (env.PHONE_EXTENSIONS || '101:Desk phone,102:iPhone')
            .split(',').map(s => s.trim()).filter(Boolean)
            .map(s => { const [ext, ...rest] = s.split(':'); return { ext: ext.trim(), label: rest.join(':').trim() || ext.trim() }; })
            .filter(e => /^\d{2,6}$/.test(e.ext)),
    };
}

export function phoneEnabled() {
    const c = config();
    return Boolean(c.amiUser && c.amiSecret && c.ttsPython && c.ttsScript);
}

export function phoneExtensions() {
    return config().extensions;
}

/**
 * Turns what the admin typed into a dial target, or throws a message fit to show them.
 * Internal extensions must be in PHONE_EXTENSIONS; numbers must be US/Canada and not premium-rate
 * (the PBX dialplan refuses anything else too).
 */
export function parseTarget(raw) {
    const input = String(raw || '').trim();
    const ext = config().extensions.find(e => e.ext === input);
    if (ext) return { kind: 'extension', dial: ext.ext, label: `${ext.label} (${ext.ext})` };

    const digits = input.replace(/[^\d+]/g, '');
    let e164 = null;
    if (/^\+1\d{10}$/.test(digits)) e164 = digits;
    else if (/^1\d{10}$/.test(digits)) e164 = '+' + digits;
    else if (/^\d{10}$/.test(digits)) e164 = '+1' + digits;
    if (!e164 || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) {
        throw new Error('Enter one of your extensions or a 10-digit US/Canada phone number.');
    }
    if (/^\+1(900|976)/.test(e164)) throw new Error('Premium-rate numbers are blocked.');
    return { kind: 'number', dial: e164, label: e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') };
}

// ---------------------------------------------------------------- call tracking

const calls = new Map(); // id -> call, insertion order = age
const TERMINAL = new Set(['ended', 'failed']);

function publicCall(c) {
    const { id, kind, label, voice, preview, status, detail, createdAt, answeredAt, endedAt } = c;
    return { id, kind, label, voice, preview, status, detail, createdAt, answeredAt, endedAt };
}

function update(call, patch) {
    Object.assign(call, patch);
}

export function recentCalls() {
    return [...calls.values()].reverse().map(publicCall);
}

export function getCall(id) {
    const c = calls.get(id);
    return c ? publicCall(c) : null;
}

export function callInProgress() {
    return [...calls.values()].some(c => !TERMINAL.has(c.status));
}

/** Starts a call in the background and returns it straight away (status: generating). */
export function startCall({ target, text, voice }) {
    const call = {
        id: nanoid(10),
        kind: target.kind,
        dial: target.dial,
        label: target.label,
        voice,
        text,
        preview: text.length > 80 ? text.slice(0, 77) + '...' : text,
        status: 'generating',
        detail: 'Generating speech',
        createdAt: new Date().toISOString(),
        answeredAt: null,
        endedAt: null,
    };
    calls.set(call.id, call);
    while (calls.size > KEEP_RECENT) calls.delete(calls.keys().next().value);

    runCall(call).catch(err => {
        update(call, { status: 'failed', detail: err.message || 'Call failed', endedAt: new Date().toISOString() });
    });
    return publicCall(call);
}

async function runCall(call) {
    const c = config();
    const base = path.join(c.ttsDir, `call-${call.id}`);
    try {
        await renderSpeech(c, call.text, base, call.voice);
        update(call, { status: 'dialing', detail: 'Ringing' });
        await originate(c, call, base);
    } finally {
        fs.rm(base + '.wav16', { force: true }, () => {});
    }
}

function renderSpeech(c, text, base, voice) {
    return new Promise((resolve, reject) => {
        // Arguments go straight to the process (no shell), so the text can't be interpreted.
        const child = spawn(c.ttsPython, [c.ttsScript, text, base, voice], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, TTS_TIMEOUT_MS);
        child.on('error', err => { clearTimeout(timer); reject(new Error(`Speech generator failed to start: ${err.message}`)); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(base + '.wav16')) return resolve();
            console.error('[phone] TTS failed:', code, stderr.trim().split('\n').slice(-3).join(' | '));
            reject(new Error(code === null ? 'Speech generation timed out' : 'Speech generation failed'));
        });
    });
}

// ---------------------------------------------------------------- AMI

const ORIGINATE_REASONS = {
    0: 'Could not reach the phone',
    1: 'Call was hung up',
    3: 'No answer',
    5: 'Busy',
    8: 'Phone unavailable',
};

/** Minimal Asterisk Manager Interface client: one connection per call. */
function amiConnect(c) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ host: c.amiHost, port: c.amiPort });
        let buf = '';
        let greeted = false;
        const waiters = new Map(); // ActionID -> resolve
        const listeners = new Set();

        sock.setEncoding('utf8');
        sock.setTimeout(MAX_CALL_MS + RING_TIMEOUT_MS);
        sock.on('timeout', () => sock.destroy(new Error('Phone system stopped responding')));
        sock.on('error', err => {
            if (!greeted) reject(new Error('Could not reach the phone system'));
            for (const l of listeners) l({ __error: err });
        });
        sock.on('close', () => { for (const l of listeners) l({ __closed: true }); });
        sock.on('data', chunk => {
            buf += chunk;
            if (!greeted) {
                const nl = buf.indexOf('\r\n');
                if (nl === -1) return;
                greeted = true; // "Asterisk Call Manager/x.y.z"
                buf = buf.slice(nl + 2);
                resolve(api);
            }
            let end;
            while ((end = buf.indexOf('\r\n\r\n')) !== -1) {
                const block = buf.slice(0, end);
                buf = buf.slice(end + 4);
                const msg = {};
                for (const line of block.split('\r\n')) {
                    const i = line.indexOf(':');
                    if (i > 0) msg[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                }
                if (msg.Response && msg.ActionID && waiters.has(msg.ActionID)) {
                    waiters.get(msg.ActionID)(msg);
                    waiters.delete(msg.ActionID);
                }
                if (msg.Event) for (const l of listeners) l(msg);
            }
        });

        const api = {
            send(action) {
                const id = action.ActionID || nanoid(8);
                const lines = Object.entries({ ...action, ActionID: id })
                    .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, ' ')}`);
                return new Promise(res => {
                    waiters.set(id, res);
                    sock.write(lines.join('\r\n') + '\r\n\r\n');
                });
            },
            onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            close() { try { sock.end('Action: Logoff\r\n\r\n'); } catch { /* already gone */ } sock.destroy(); },
        };
    });
}

async function originate(c, call, promptBase) {
    const ami = await amiConnect(c);
    try {
        const login = await ami.send({ Action: 'Login', Username: c.amiUser, Secret: c.amiSecret, Events: 'call' });
        if (login.Response !== 'Success') throw new Error('Phone system refused the login');

        const actionId = `call-${call.id}`;
        const channel = call.kind === 'extension' ? `Local/${call.dial}@ring-ext` : `Local/${call.dial}@callout`;

        // Everything after the originate request arrives as events on this connection.
        const outcome = new Promise((resolve) => {
            let answeredChannel = null;
            const ringTimer = setTimeout(() => resolve({ failed: 'No answer' }), RING_TIMEOUT_MS + 15_000);
            let callTimer = null;
            const stop = ami.onMessage(msg => {
                if (msg.__error || msg.__closed) {
                    clearTimeout(ringTimer); clearTimeout(callTimer); stop();
                    return resolve(answeredChannel ? { ended: true } : { failed: 'Lost connection to the phone system' });
                }
                if (msg.Event === 'OriginateResponse' && msg.ActionID === actionId) {
                    clearTimeout(ringTimer);
                    if (msg.Response !== 'Success') {
                        stop();
                        return resolve({ failed: ORIGINATE_REASONS[msg.Reason] || 'Call failed' });
                    }
                    answeredChannel = msg.Channel;
                    update(call, { status: 'answered', detail: 'Speaking', answeredAt: new Date().toISOString() });
                    callTimer = setTimeout(() => { stop(); resolve({ ended: true }); }, MAX_CALL_MS);
                    return;
                }
                if (msg.Event === 'Hangup' && answeredChannel && msg.Channel === answeredChannel) {
                    clearTimeout(callTimer); stop();
                    return resolve({ ended: true });
                }
            });
        });

        const res = await ami.send({
            Action: 'Originate',
            ActionID: actionId,
            Channel: channel,
            Context: 'say-text',
            Exten: 's',
            Priority: 1,
            Timeout: RING_TIMEOUT_MS,
            Variable: `PROMPT=${promptBase}`,
            Async: 'true',
        });
        if (res.Response !== 'Success') throw new Error(res.Message || 'Phone system rejected the call');

        const result = await outcome;
        if (result.failed) throw new Error(result.failed);
        update(call, { status: 'ended', detail: 'Call ended', endedAt: new Date().toISOString() });
    } finally {
        ami.close();
    }
}
