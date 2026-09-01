// Accounts and sessions: signup, email verification, login, logout,
// password change and reset, and the shape /api/auth/me returns — which both
// the web dashboard and the iOS app branch on.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, TEST_PASSWORD, ADMIN_EMAIL } from './helpers/server.js';
import { createClient } from './helpers/client.js';
import { newUser, newAdmin, uniqueEmail } from './helpers/factories.js';

// Mirrors server.js's totp() (RFC 6238, SHA1, 30s step, 6 digits) so tests
// can compute a code for the secret /api/account/2fa/setup hands back,
// instead of needing a mocked authenticator.
function base32Decode(str) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of str.replace(/=+$/, '').toUpperCase()) {
        const val = alphabet.indexOf(c);
        if (val === -1) continue;
        bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
}
function totpCode(secret, time = Date.now()) {
    const counter = Math.floor(time / 1000 / 30);
    const key = base32Decode(secret);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 | (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1_000_000;
    return String(code).padStart(6, '0');
}
async function enableTotp(client) {
    const setup = await client.post('/api/account/2fa/setup', {});
    const enable = await client.post('/api/account/2fa/enable', { code: totpCode(setup.body.secret) });
    assert.equal(enable.status, 200, enable.text);
    return setup.body.secret;
}

let server;
before(async () => { server = await startServer(); });
after(async () => { await server?.stop(); });

describe('signup', () => {
    test('requires an email and a password', async () => {
        const c = createClient(server.base);
        assert.equal((await c.post('/api/auth/signup', { email: 'x@test.local' })).status, 400);
        assert.equal((await c.post('/api/auth/signup', { password: 'x' })).status, 400);
    });

    test('creates an unverified account and emails a verification link', async () => {
        const c = createClient(server.base);
        const email = uniqueEmail('fresh');
        const r = await c.post('/api/auth/signup', { email, password: TEST_PASSWORD });
        assert.equal(r.status, 200);
        assert.equal(r.body.needsVerification, true);

        const mail = await server.waitForEmail(m => m.to === email && /verify/i.test(m.subject));
        assert.match(mail.html, /verify-email\.html\?token=[a-f0-9]{64}/);
    });

    test('will not log in an unverified account', async () => {
        const c = createClient(server.base);
        const email = uniqueEmail('unverified');
        await c.post('/api/auth/signup', { email, password: TEST_PASSWORD });
        const login = await c.post('/api/auth/login', { email, password: TEST_PASSWORD });
        assert.equal(login.status, 403);
        assert.equal(login.body.needsVerification, true);
    });

    test('rejects a second account on the same email', async () => {
        const { email } = await newUser(server);
        const c = createClient(server.base);
        const again = await c.post('/api/auth/signup', { email, password: TEST_PASSWORD });
        assert.equal(again.status, 400);
        assert.match(again.body.error, /already exists/i);
    });

    test('treats the email as case-insensitive', async () => {
        const c = createClient(server.base);
        const email = uniqueEmail('MixedCase').toUpperCase();
        await c.post('/api/auth/signup', { email, password: TEST_PASSWORD });
        const mail = await server.waitForEmail(m => m.to === email.toLowerCase() && /verify/i.test(m.subject));
        const token = mail.html.match(/token=([a-f0-9]+)/)[1];
        await c.get(`/api/auth/verify/${token}`);
        const login = await c.post('/api/auth/login', { email: email.toLowerCase(), password: TEST_PASSWORD });
        assert.equal(login.status, 200);
    });
});

describe('login', () => {
    test('rejects a wrong password and an unknown account with the same 401', async () => {
        const { email } = await newUser(server);
        const c = createClient(server.base);

        const wrongPw = await c.post('/api/auth/login', { email, password: 'not-the-password' });
        const noSuchUser = await c.post('/api/auth/login', { email: 'nobody@test.local', password: TEST_PASSWORD });

        assert.equal(wrongPw.status, 401);
        assert.equal(noSuchUser.status, 401);
        // Identical wording both ways — otherwise the response tells an
        // attacker which emails have accounts.
        assert.equal(wrongPw.body.error, noSuchUser.body.error);
    });

    test('a failed login leaves no session behind', async () => {
        const { email } = await newUser(server);
        const c = createClient(server.base);
        await c.post('/api/auth/login', { email, password: 'wrong' });
        const me = await c.get('/api/auth/me');
        assert.equal(me.status, 401);
    });

    test('sets a session cookie that /api/auth/me accepts', async () => {
        const { client, email } = await newUser(server);
        const me = await client.get('/api/auth/me');
        assert.equal(me.status, 200);
        assert.equal(me.body.user.email, email);
        assert.equal(me.body.user.isAdmin, false);
    });

    test('logout drops the session', async () => {
        const { client } = await newUser(server);
        assert.ok((await client.get('/api/auth/me')).body.user);
        const out = await client.post('/api/auth/logout', {});
        assert.equal(out.status, 200);
        assert.equal((await client.get('/api/auth/me')).status, 401);
    });

    test('one browser\'s session does not leak into another', async () => {
        const { email } = await newUser(server);
        const other = createClient(server.base);
        const me = await other.get('/api/auth/me');
        assert.equal(me.status, 401);
        assert.notEqual(me.body?.user?.email, email);
    });
});

describe('/api/auth/me', () => {
    test('flags the admin account', async () => {
        const admin = await newAdmin(server);
        const me = await admin.client.get('/api/auth/me');
        assert.equal(me.body.user.email, ADMIN_EMAIL);
        assert.equal(me.body.user.isAdmin, true);
    });
});

describe('password management', () => {
    test('changing a password requires the current one and then works', async () => {
        const { client, email } = await newUser(server);

        const wrong = await client.post('/api/account/password', { currentPassword: 'nope', newPassword: 'NewPass123!' });
        assert.equal(wrong.status, 401);

        const ok = await client.post('/api/account/password', { currentPassword: TEST_PASSWORD, newPassword: 'NewPass123!' });
        assert.equal(ok.status, 200);

        const fresh = createClient(server.base);
        assert.equal((await fresh.post('/api/auth/login', { email, password: TEST_PASSWORD })).status, 401);
        assert.equal((await fresh.post('/api/auth/login', { email, password: 'NewPass123!' })).status, 200);
    });

    test('forgot-password emails a reset link that sets a new password once', async () => {
        const { email } = await newUser(server);
        const c = createClient(server.base);

        const asked = await c.post('/api/auth/forgot-password', { email });
        assert.equal(asked.status, 200);

        const mail = await server.waitForEmail(m => m.to === email && /reset/i.test(m.subject));
        const token = (mail.html.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
        assert.ok(token, 'no reset token in the email');

        const reset = await c.post('/api/auth/reset-password', { token, password: 'ResetPass456!' });
        assert.equal(reset.status, 200);

        const fresh = createClient(server.base);
        assert.equal((await fresh.post('/api/auth/login', { email, password: 'ResetPass456!' })).status, 200);

        // The token is spent — replaying it must not work.
        const replay = await c.post('/api/auth/reset-password', { token, password: 'Another789!' });
        assert.notEqual(replay.status, 200);
    });

    test('forgot-password for an unknown address does not reveal that it is unknown', async () => {
        const c = createClient(server.base);
        const r = await c.post('/api/auth/forgot-password', { email: 'ghost@test.local' });
        assert.equal(r.status, 200);
    });
});

describe('two-factor', () => {
    test('starts disabled and reports status', async () => {
        const { client } = await newUser(server);
        const status = await client.get('/api/account/2fa/status');
        assert.equal(status.status, 200);
        assert.equal(status.body.enabled, false);
    });

    test('setup returns a secret without enabling anything yet', async () => {
        const { client } = await newUser(server);
        const setup = await client.post('/api/account/2fa/setup', {});
        assert.equal(setup.status, 200);
        assert.ok(setup.body.secret, 'no TOTP secret returned');
        assert.equal((await client.get('/api/account/2fa/status')).body.enabled, false);
    });

    test('enabling with a wrong code is refused', async () => {
        const { client } = await newUser(server);
        await client.post('/api/account/2fa/setup', {});
        const bad = await client.post('/api/account/2fa/enable', { code: '000000' });
        assert.notEqual(bad.status, 200);
        assert.equal((await client.get('/api/account/2fa/status')).body.enabled, false);
    });

    test('2FA endpoints require a session', async () => {
        const anon = createClient(server.base);
        assert.equal((await anon.get('/api/account/2fa/status')).status, 401);
        assert.equal((await anon.post('/api/account/2fa/setup', {})).status, 401);
    });

    test('logging in with 2FA enabled asks for a code instead of starting a session', async () => {
        const { client, email, password } = await newUser(server);
        await enableTotp(client);

        const fresh = createClient(server.base);
        const login = await fresh.post('/api/auth/login', { email, password });
        assert.equal(login.status, 200);
        assert.equal(login.body.needsTotp, true);
        assert.ok(login.body.pendingToken, 'no pendingToken in the needsTotp response');
        assert.equal((await fresh.get('/api/account/2fa/status')).status, 401, 'no session should exist yet');
    });

    test('the correct code exchanges the pendingToken for a real session', async () => {
        const { client, email, password } = await newUser(server);
        const secret = await enableTotp(client);

        const fresh = createClient(server.base);
        const login = await fresh.post('/api/auth/login', { email, password });
        const verify = await fresh.post('/api/auth/login/totp-verify', { pendingToken: login.body.pendingToken, code: totpCode(secret) });
        assert.equal(verify.status, 200, verify.text);
        assert.equal((await fresh.get('/api/account/2fa/status')).status, 200);
    });

    test('a wrong code does not exchange the pendingToken', async () => {
        const { client, email, password } = await newUser(server);
        await enableTotp(client);

        const fresh = createClient(server.base);
        const login = await fresh.post('/api/auth/login', { email, password });
        const verify = await fresh.post('/api/auth/login/totp-verify', { pendingToken: login.body.pendingToken, code: '000000' });
        assert.equal(verify.status, 401);
        assert.equal((await fresh.get('/api/account/2fa/status')).status, 401);
    });

    describe('TOTP_ENFORCEMENT_DISABLED override', () => {
        let bypassServer;
        before(async () => { bypassServer = await startServer({ env: { TOTP_ENFORCEMENT_DISABLED: '1' } }); });
        after(async () => { await bypassServer?.stop(); });

        test('logs straight in without asking for a code, and leaves the stored secret untouched', async () => {
            const { client, email, password } = await newUser(bypassServer);
            await enableTotp(client);
            assert.equal((await client.get('/api/account/2fa/status')).body.enabled, true);

            const fresh = createClient(bypassServer.base);
            const login = await fresh.post('/api/auth/login', { email, password });
            assert.equal(login.status, 200);
            assert.equal(login.body.success, true);
            assert.equal(login.body.needsTotp, undefined, 'should not be asked for a code while the override is on');

            // The account itself was never touched — status still reports
            // fully enabled, so turning the override back off restores 2FA
            // immediately with nothing to redo.
            assert.equal((await fresh.get('/api/account/2fa/status')).body.enabled, true);
        });
    });
});

describe('admin setup', () => {
    test('only works once', async () => {
        const c = createClient(server.base);
        const second = await c.post('/api/auth/setup-admin', { password: TEST_PASSWORD });
        assert.equal(second.status, 400);
        assert.match(second.body.error, /already exists/i);
    });
});
