// Deletion is archive-then-purge (archiveEvent / purgeExpiredDeletions /
// backfillOrphanedDeletions in db-sqlite.js), which is what privacy.html's Data
// Retention section promises:
//   - deleting an event (one, in bulk, or via account deletion) removes it and
//     everything attached to it from the live tables immediately;
//   - a snapshot plus the event's audit history are kept for the retention period
//     (90 days in production), then erased;
//   - a live event keeps its audit history for as long as it exists.
// These tests read the server's SQLite file directly (read-only) to check what is
// actually left behind, since nothing over HTTP can see a deleted event's rows.
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startServer } from './helpers/server.js';
import { newUser, createEvent, addTicket, scanLinkClient, eventApiKey, share, uniqueEmail } from './helpers/factories.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const servers = [];
after(async () => { for (const s of servers) await s.stop(); });
async function boot(env = {}) {
    const s = await startServer({ env });
    servers.push(s);
    return s;
}
const openDb = (server) => new Database(path.join(server.dir, 'tickets.db'), { readonly: true, fileMustExist: true });

// The list in db-sqlite.js, read from source so this test never imports that module
// (importing it would open the working database).
function eventScopedTablesFromSource() {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'db-sqlite.js'), 'utf8');
    const m = src.match(/export const EVENT_SCOPED_TABLES = \[([\s\S]*?)\];/);
    assert.ok(m, 'EVENT_SCOPED_TABLES not found in db-sqlite.js');
    return [...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]).sort();
}

function rowsForEvent(db, eventId) {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    const out = {};
    for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all().map(c => c.name);
        if (!cols.includes('eventId') || t === 'deletedEvents') continue;
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE eventId=?`).get(eventId).n;
        if (n) out[t] = n;
    }
    return out;
}

// An event with rows in as many tables as the HTTP API can reach without Stripe.
async function populatedEvent(server, owner) {
    const ev = await createEvent(owner.client, { publicRegistration: true, capacity: 1, waitlist: true });
    await addTicket(owner.client, ev.id, { name: 'Alice Attendee', email: uniqueEmail('alice') });
    const join = await createClientless(server).post(`/api/event/${ev.id}/waitlist`, { name: 'Wally Waiter', email: uniqueEmail('wally') });
    assert.equal(join.status, 200, `waitlist join failed: ${join.text}`);
    await scanLinkClient(server, owner.client, ev.id);
    await eventApiKey(owner.client, ev.id);
    const helper = await newUser(server);
    await share(owner.client, ev.id, helper.email, ['checkin']);
    return ev;
}
function createClientless(server) {
    // A visitor with no session, for the public waitlist route.
    return { post: (p, body) => fetch(server.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(async r => ({ status: r.status, text: await r.text() })) };
}

describe('archiving on delete', () => {
    test('EVENT_SCOPED_TABLES covers every table with an eventId column', async () => {
        const server = await boot();
        const db = openDb(server);
        const withEventId = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
            .filter(t => db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all().some(c => c.name === 'eventId'))
            // events is the event itself; auditLog and voidedTickets stay until the purge;
            // deletedEvents is the archive.
            .filter(t => !['events', 'auditLog', 'voidedTickets', 'deletedEvents'].includes(t))
            .sort();
        db.close();
        assert.deepEqual(eventScopedTablesFromSource(), withEventId,
            'a table with an eventId column is missing from EVENT_SCOPED_TABLES (or the list names one that no longer exists)');
    });

    test('deleting an event clears every live table, archives a snapshot, and keeps its audit history', async () => {
        const server = await boot();
        const owner = await newUser(server);
        const ev = await populatedEvent(server, owner);

        let db = openDb(server);
        const before = rowsForEvent(db, ev.id);
        db.close();
        for (const t of ['tickets', 'waitlist', 'scannerLinks', 'sheetLinks']) assert.ok(before[t], `setup should have created ${t} rows`);

        const del = await owner.client.del(`/api/event/${ev.id}`);
        assert.equal(del.status, 200, del.text);
        assert.equal((await owner.client.get(`/api/event/${ev.id}`)).status, 404, 'a deleted event is gone for its owner');

        db = openDb(server);
        const left = rowsForEvent(db, ev.id);
        const archived = db.prepare('SELECT * FROM deletedEvents WHERE eventId=?').get(ev.id);
        const sheetAccessLeft = db.prepare('SELECT COUNT(*) AS n FROM sheetAccess WHERE sheetLinkId NOT IN (SELECT id FROM sheetLinks)').get().n;
        const voided = db.prepare('SELECT eventId FROM voidedTickets').all();
        db.close();

        assert.deepEqual(Object.keys(left).sort(), ['auditLog', 'voidedTickets'],
            'only the audit history and the voided-pass tombstones should remain live until the purge');
        assert.equal(sheetAccessLeft, 0, 'sharing grants go with the event');
        assert.ok(archived, 'the event is archived');
        const snap = JSON.parse(archived.snapshot);
        assert.equal(snap.event.id, ev.id);
        assert.equal(snap.tickets.length, before.tickets);
        assert.equal(snap.waitlist.length, before.waitlist);
        assert.ok(snap.sheetAccess.length >= 1, 'sharing grants are in the snapshot');
        assert.ok(voided.every(v => v.eventId === ev.id), 'tombstones carry their eventId so they can be purged with it');
    });

    test('deleting an account archives every event it owns and drops its sign-in leftovers', async () => {
        const server = await boot();
        const owner = await newUser(server);
        const ev = await populatedEvent(server, owner);
        let db = openDb(server);
        const ownerId = db.prepare('SELECT userId FROM events WHERE id=?').get(ev.id).userId;
        db.close();

        const del = await owner.client.del('/api/auth/account');
        assert.equal(del.status, 200, del.text);

        db = openDb(server);
        const left = rowsForEvent(db, ev.id);
        const archived = db.prepare('SELECT * FROM deletedEvents WHERE eventId=?').get(ev.id);
        const account = db.prepare('SELECT * FROM deletedAccounts WHERE userId=?').get(ownerId);
        const auditActions = db.prepare('SELECT action FROM auditLog WHERE userId=?').all(ownerId).map(r => r.action);
        const resetTokens = db.prepare('SELECT COUNT(*) AS n FROM passwordResetTokens WHERE userId=?').get(ownerId).n;
        const trusted = db.prepare('SELECT COUNT(*) AS n FROM trustedDevices WHERE userId=?').get(ownerId).n;
        db.close();

        assert.deepEqual(Object.keys(left).sort(), ['auditLog', 'voidedTickets'], 'the waitlist, links and the rest used to survive account deletion');
        assert.ok(archived, 'owned events are archived, same as deleting them directly');
        assert.ok(account, 'the account deletion is recorded for the later purge');
        assert.equal(account.email, owner.email);
        assert.ok(auditActions.includes('account.deleted'));
        assert.ok(auditActions.includes('event.deleted'));
        assert.equal(resetTokens, 0);
        assert.equal(trusted, 0);
    });
});

describe('purging after the retention period', () => {
    test('erases a deleted event\'s archive and audit history, but never a live event\'s', async () => {
        const server = await boot({ DELETED_DATA_RETENTION_MS: '1500', DELETED_DATA_SWEEP_MS: '250' });
        const owner = await newUser(server);
        const doomed = await createEvent(owner.client, { name: 'Doomed' });
        const kept = await createEvent(owner.client, { name: 'Kept' });
        await addTicket(owner.client, doomed.id, { name: 'Gone Soon', email: uniqueEmail('gone') });
        await addTicket(owner.client, kept.id, { name: 'Stays', email: uniqueEmail('stays') });
        assert.equal((await owner.client.del(`/api/event/${doomed.id}`)).status, 200);

        let db = openDb(server);
        assert.ok(db.prepare('SELECT 1 FROM deletedEvents WHERE eventId=?').get(doomed.id), 'archived right after deletion');
        assert.ok(db.prepare('SELECT COUNT(*) AS n FROM auditLog WHERE eventId=?').get(doomed.id).n > 0, 'history kept during the retention period');
        db.close();

        await sleep(2500); // past the 1.5s retention, plus a sweep tick

        db = openDb(server);
        const archive = db.prepare('SELECT 1 FROM deletedEvents WHERE eventId=?').get(doomed.id);
        const doomedAudit = db.prepare('SELECT COUNT(*) AS n FROM auditLog WHERE eventId=?').get(doomed.id).n;
        const doomedVoided = db.prepare('SELECT COUNT(*) AS n FROM voidedTickets WHERE eventId=?').get(doomed.id).n;
        const keptAudit = db.prepare('SELECT COUNT(*) AS n FROM auditLog WHERE eventId=?').get(kept.id).n;
        const keptTickets = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE eventId=?').get(kept.id).n;
        db.close();
        assert.equal(archive, undefined, 'archive purged');
        assert.equal(doomedAudit, 0, 'audit history purged with it');
        assert.equal(doomedVoided, 0, 'voided-pass tombstones purged with it');
        assert.ok(keptAudit > 0, 'a live event keeps its audit history however old it is');
        assert.equal(keptTickets, 1);
    });

    test('a deleted account\'s own audit entries go after the retention period', async () => {
        const server = await boot({ DELETED_DATA_RETENTION_MS: '1500', DELETED_DATA_SWEEP_MS: '250' });
        const owner = await newUser(server);
        let db = openDb(server);
        const userId = db.prepare('SELECT id FROM users WHERE email=?').get(owner.email.toLowerCase()).id;
        db.close();
        assert.equal((await owner.client.del('/api/auth/account')).status, 200);
        await sleep(2500);
        db = openDb(server);
        const accountLevel = db.prepare('SELECT COUNT(*) AS n FROM auditLog WHERE userId=? AND eventId IS NULL').get(userId).n;
        const record = db.prepare('SELECT 1 FROM deletedAccounts WHERE userId=?').get(userId);
        db.close();
        assert.equal(accountLevel, 0);
        assert.equal(record, undefined);
    });
});

describe('catching up deletions made before archiving existed', () => {
    test('orphaned rows are archived at startup, dated by the original deletion', async (t) => {
        // A database file outside any server's own temp dir, so it survives a restart.
        const seededDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-retention-'));
        const seeded = path.join(seededDir, 'tickets.db');
        let second = null;
        // One hook, in order: the server has to let go of the file before it can be removed.
        t.after(async () => {
            if (second) await second.stop();
            fs.rmSync(seededDir, { recursive: true, force: true });
        });

        const first = await startServer({ env: { TICKETS_DB: seeded } });
        const owner = await newUser(first);
        const ev = await populatedEvent(first, owner);

        // What the old account deletion did: removed only the tickets and the event
        // row, leaving the waitlist, links and the rest. One deleted 10 days ago (still
        // inside the 90 days) and one deleted long ago (already past it).
        const recentAt = new Date(Date.now() - 10 * 86400000).toISOString();
        const longAgoAt = new Date(Date.now() - 200 * 86400000).toISOString();
        const old = await createEvent(owner.client, { name: 'Long gone' });
        await addTicket(owner.client, old.id, { name: 'Old Attendee', email: uniqueEmail('old') });
        await first.stop();
        const w = new Database(seeded);
        for (const [id, at] of [[ev.id, recentAt], [old.id, longAgoAt]]) {
            w.prepare('DELETE FROM tickets WHERE eventId=?').run(id);
            w.prepare('DELETE FROM events WHERE id=?').run(id);
            w.prepare(`INSERT INTO auditLog (id, userId, userEmail, eventId, action, details, ip, createdAt)
                       VALUES (?, NULL, NULL, ?, 'event.deleted', NULL, NULL, ?)`).run('legacy-' + id, id, at);
        }
        const leftBefore = rowsForEvent(w, ev.id);
        w.close();
        assert.ok(leftBefore.waitlist, 'setup: the old deletion left the waitlist behind');

        second = await startServer({ env: { TICKETS_DB: seeded } });
        const db = new Database(seeded, { readonly: true });
        const left = rowsForEvent(db, ev.id);
        const archived = db.prepare('SELECT * FROM deletedEvents WHERE eventId=?').get(ev.id);
        const oldLeft = rowsForEvent(db, old.id);
        const oldArchived = db.prepare('SELECT 1 FROM deletedEvents WHERE eventId=?').get(old.id);
        db.close();
        assert.deepEqual(Object.keys(left).sort(), ['auditLog'], 'leftovers moved out of the live tables');
        assert.ok(archived, 'archived');
        assert.equal(archived.deletedAt, recentAt, 'dated by the original deletion, so it is purged 90 days after that');
        assert.ok(JSON.parse(archived.snapshot).waitlist.length >= 1);
        assert.deepEqual(oldLeft, {}, 'a deletion already past 90 days is erased outright, audit history included');
        assert.equal(oldArchived, undefined);
    });
});
