// Boots a real, isolated copy of the server for a test file.
//
// Every run gets its own SQLite file, session directory, pass cache and email
// sink under os.tmpdir(), so tests never touch the working database and never
// leave anything behind in the repo. Nothing is mocked: the tests talk to the
// same Express app that runs in production, over HTTP.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ADMIN_EMAIL = 'admin@test.local';
export const TEST_PASSWORD = 'CorrectHorse9!';

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} [opts]
 * @param {boolean} [opts.rateLimits=false]  leave the real rate limiters on
 * @param {object}  [opts.env]               extra env for the child process
 */
export async function startServer(opts = {}) {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-test-'));
    const emailSink = path.join(dir, 'emails.jsonl');
    fs.writeFileSync(emailSink, '');

    const env = {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        BASE_URL: `http://127.0.0.1:${port}`,
        SESSION_SECRET: 'test-secret-not-a-real-one',
        ADMIN_EMAIL,
        TICKETS_DB: path.join(dir, 'tickets.db'),
        SESSIONS_DIR: path.join(dir, 'sessions'),
        PASS_CACHE_DIR: path.join(dir, 'pass-cache'),
        EMAIL_SINK: emailSink,
        SES_MIN_INTERVAL_MS: '0',
        // Defence in depth: even if the email sink ever failed to divert a
        // send, these credentials cannot reach a real SES account.
        AWS_ACCESS_KEY_ID: 'test-key-id',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        SES_FROM: 'tests@test.local',
        // No Stripe key -> `stripe` stays null, so no test can ever reach a
        // live payments account. The paid-event tests assert on that path.
        STRIPE_MODE: 'TEST',
        STRIPE_SECRET_KEY_TEST: '',
        STRIPE_WEBHOOK_SECRET_TEST: '',
        DISABLE_RATE_LIMITS: opts.rateLimits ? '0' : '1',
        ...(opts.env || {}),
    };

    const child = spawn(process.execPath, ['server.js'], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });

    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20000;
    for (;;) {
        if (exited) throw new Error(`Server exited during boot (${JSON.stringify(exited)}):\n${output}`);
        try {
            const r = await fetch(`${base}/api/registration-themes`);
            if (r.ok) break;
        } catch { /* not listening yet */ }
        if (Date.now() > deadline) throw new Error(`Server did not start within 20s:\n${output}`);
        await sleep(100);
    }

    return {
        base,
        port,
        dir,
        /** Everything the server has written to stdout/stderr so far. */
        log: () => output,
        /** Every email the server tried to send, oldest first. */
        emails() {
            const raw = fs.readFileSync(emailSink, 'utf8').trim();
            return raw ? raw.split('\n').map(l => JSON.parse(l)) : [];
        },
        /** Forget all captured emails, so a test can assert on just its own. */
        clearEmails() { fs.writeFileSync(emailSink, ''); },
        /**
         * Waits for an email matching `pred` to be captured. Sends are queued
         * and fired after the HTTP response returns, so tests that assert on
         * mail have to wait for it rather than read straight after the call.
         */
        async waitForEmail(pred, timeoutMs = 5000) {
            const until = Date.now() + timeoutMs;
            for (;;) {
                const hit = this.emails().find(pred);
                if (hit) return hit;
                if (Date.now() > until) {
                    throw new Error(`No matching email within ${timeoutMs}ms. Captured: ` +
                        JSON.stringify(this.emails().map(e => ({ to: e.to, subject: e.subject }))));
                }
                await sleep(50);
            }
        },
        /** Sends a real signal to the server process — e.g. SIGTERM, the same
         *  one a `pm2 restart` sends, to test the graceful-shutdown path
         *  without actually going through pm2. */
        sendSignal(sig) { child.kill(sig); },
        /** Resolves once the process has actually exited (or immediately, if
         *  it already had) — for asserting a signal handler doesn't hang. */
        async waitForExit(timeoutMs = 5000) {
            const until = Date.now() + timeoutMs;
            while (!exited) {
                if (Date.now() > until) throw new Error(`Process did not exit within ${timeoutMs}ms`);
                await sleep(50);
            }
            return exited;
        },
        async stop() {
            if (!exited) {
                child.kill('SIGKILL');
                await new Promise(r => child.once('exit', r));
            }
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        },
    };
}
