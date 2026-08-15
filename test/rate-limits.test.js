// Rate limiting on the login, password-reset and scan endpoints.
//
// Every other suite boots the server with DISABLE_RATE_LIMITS=1, because a
// test run logs in far more often than a person does. This one deliberately
// does not, so the limits themselves are still covered.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, TEST_PASSWORD } from './helpers/server.js';
import { createClient } from './helpers/client.js';

let server;
before(async () => { server = await startServer({ rateLimits: true }); });
after(async () => { await server?.stop(); });

const client = () => createClient(server.base);

describe('login', () => {
    test('locks out after repeated failures, and says so', async () => {
        const c = client();
        const attempts = [];
        for (let i = 0; i < 14; i++) {
            attempts.push(await c.post('/api/auth/login', { email: `brute-${i}@test.local`, password: 'guess' }));
        }

        const limited = attempts.filter(r => r.status === 429);
        assert.ok(limited.length > 0, 'password guessing was never rate limited');
        assert.match(limited[0].body.error, /too many/i);

        // The limit is 10 in 15 minutes, so the first handful get through to
        // the normal 401 and the rest are turned away.
        assert.ok(attempts.slice(0, 5).every(r => r.status === 401), 'ordinary failed logins should still answer 401');
    });

    test('the limit is announced in the response headers', async () => {
        const c = client();
        const r = await c.post('/api/auth/login', { email: 'headers@test.local', password: 'x' });
        assert.ok(r.headers.get('ratelimit-limit') || r.headers.get('ratelimit'), 'standard rate-limit headers are missing');
    });

    test('signup is behind the same limiter', async () => {
        const c = client();
        let sawLimit = false;
        for (let i = 0; i < 14 && !sawLimit; i++) {
            const r = await c.post('/api/auth/signup', { email: `flood-${Date.now()}-${i}@test.local`, password: TEST_PASSWORD });
            if (r.status === 429) sawLimit = true;
        }
        assert.ok(sawLimit, 'account creation was never rate limited');
    });
});

describe('password reset', () => {
    test('is limited more tightly than login', async () => {
        const c = client();
        let limitedAt = null;
        for (let i = 0; i < 10 && limitedAt === null; i++) {
            const r = await c.post('/api/auth/forgot-password', { email: `reset-${i}@test.local` });
            if (r.status === 429) limitedAt = i;
        }
        assert.notEqual(limitedAt, null, 'reset emails were never rate limited');
        assert.ok(limitedAt <= 6, `expected the tighter limit to bite early, but it took ${limitedAt} attempts`);
    });
});

describe('scanning', () => {
    test('is limited generously enough for a real door', async () => {
        // A busy door scans continuously; the limit exists to stop token
        // enumeration, not to slow staff down. 60 scans in a row must all
        // get through.
        const c = client();
        for (let i = 0; i < 60; i++) {
            const r = await c.post('/api/validate', { token: `probe-${i}` });
            assert.notEqual(r.status, 429, `a real door was rate limited after ${i} scans`);
        }
    });
});
