// Every deploy restarts the pm2 process, which used to just abruptly drop
// every open SSE connection with no warning — a door display, monitor, or
// giveaway screen left open would silently sit on stale JS/HTML. On
// SIGTERM/SIGINT the server now broadcasts a 'restarting' message into every
// passive live channel before exiting (see broadcastRestartToAll in
// server.js), and each such page reloads itself a few seconds later. This
// boots its own server (rather than sharing one with other test files) since
// it deliberately kills the process.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { openSseReader } from './helpers/sse.js';
import { newUser, createEvent, addTicket } from './helpers/factories.js';

describe('deploy-triggered reload signal', () => {
    test('reaches the waitlist status stream, the door display, and the giveaway room before the process exits', async () => {
        const server = await startServer();
        try {
            const owner = await newUser(server);
            const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 5, waitlist: true });
            await addTicket(owner.client, ev.id, { name: 'Someone' });

            const joinR = await owner.client.post(`/api/event/${ev.id}/waitlist`, { name: 'Waiter', email: 'waiter@test.local' });
            const waitlistId = joinR.body.waitlistId;

            const displayToken = (await owner.client.get(`/api/display/token/${ev.id}`)).body.token;
            const giveawayToken = (await owner.client.get(`/api/event/${ev.id}/giveaway/token`)).body.token;

            const readers = {
                waitlist: await openSseReader(`${server.base}/api/waitlist/entry/${waitlistId}/stream`),
                display: await openSseReader(`${server.base}/api/display/stream/${displayToken}`),
                giveaway: await openSseReader(`${server.base}/api/giveaway/room/${ev.id}/stream?role=display&token=${giveawayToken}`),
                monitor: await openSseReader(`${server.base}/api/monitor/stream`, { headers: { cookie: owner.client.cookies() } }),
            };

            // Drain each stream's initial handshake message(s) so the
            // 'restarting' broadcast below is unambiguously the next one.
            await readers.waitlist.next();                 // 'connected'
            await readers.display.next();                   // 'init'
            await readers.giveaway.next();                   // 'connected'
            await readers.giveaway.next();                   // 'presence' (this connection joining the room)
            await readers.monitor.next();                    // 'monitor_connected'

            server.sendSignal('SIGTERM');

            const [waitlistMsg, displayMsg, giveawayMsg, monitorMsg] = await Promise.all([
                readers.waitlist.next(4000),
                readers.display.next(4000),
                readers.giveaway.next(4000),
                readers.monitor.next(4000),
            ]);

            for (const [name, msg] of Object.entries({ waitlist: waitlistMsg, display: displayMsg, giveaway: giveawayMsg, monitor: monitorMsg })) {
                assert.equal(msg?.type, 'restarting', `${name} stream never got the restart signal — got ${JSON.stringify(msg)}`);
            }

            for (const r of Object.values(readers)) r.close();

            // The signal handler must not turn a routine restart into a
            // stuck deploy — better-sqlite3 has nothing async to flush, so
            // this should be fast.
            await server.waitForExit(3000);
        } finally {
            await server.stop();
        }
    });

    test('the giveaway controller (not the display) never sees a message it would act on', async () => {
        // giveaway.html's own client JS has no 'restarting' branch in its
        // onmessage switch — unlike giveaway-display.html — even though both
        // roles share the same giveawayChannels connections server-side.
        // This just confirms the room stream still delivers the message
        // faithfully to a 'controller'-role connection; it's giveaway.html's
        // own (unedited-by-this-change) switch statement that ignores it.
        const server = await startServer();
        try {
            const owner = await newUser(server);
            const ev = await createEvent(owner.client);
            const reader = await openSseReader(
                `${server.base}/api/giveaway/room/${ev.id}/stream?role=controller`,
                { headers: { cookie: owner.client.cookies() } },
            );
            await reader.next(); // 'connected'
            await reader.next(); // 'presence' (this connection joining the room)
            server.sendSignal('SIGTERM');
            const msg = await reader.next(4000);
            assert.equal(msg?.type, 'restarting');
            reader.close();
            await server.waitForExit(3000);
        } finally {
            await server.stop();
        }
    });
});
