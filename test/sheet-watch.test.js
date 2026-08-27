// The Google Sheets import: previewing a connected sheet and matching rows
// against the trigger conditions that decide who gets a ticket.
//
// The watcher only ever fetches Google's own hosts (SSRF protection — see
// sheetHostAllowed in server.js), so there's no way to point it at a normal
// local test fixture over HTTP without either reaching the live network or
// weakening that check. SHEET_TEST_FIXTURES_DIR is the test-only escape
// hatch for that: a `test-fixture:<file>` URL reads a local CSV instead of
// fetching Google Sheets, so these tests exercise the exact preview and
// condition-matching code path a real several-thousand-row response sheet
// would hit — including at 10,000+ rows, which used to be untestable (and
// unpreviewable — the dashboard only ever showed the first 10 rows).
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.js';
import { newUser, createEvent } from './helpers/factories.js';

let server, owner, fixturesDir;

before(async () => {
    fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-sheet-fixtures-'));
    server = await startServer({ env: { SHEET_TEST_FIXTURES_DIR: fixturesDir } });
    owner = await newUser(server);
});
after(async () => {
    await server?.stop();
    try { fs.rmSync(fixturesDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * Writes a deterministic CSV fixture: every `matchEvery`-th row (0-indexed)
 * answers "Yes" to the trigger question, the rest answer "No" — so the
 * exact match count is known ahead of time and asserted, not eyeballed.
 */
function writeFixture(name, rowCount, matchEvery = 3) {
    const lines = ['Timestamp,First Name,Last Name,Email,Interested'];
    let matched = 0;
    for (let i = 0; i < rowCount; i++) {
        const isMatch = i % matchEvery === 0;
        if (isMatch) matched++;
        lines.push([
            `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}`,
            `First${i}`,
            `Last${i}`,
            `person${i}@sheetfixture.test.local`,
            isMatch ? 'Yes' : 'No',
        ].join(','));
    }
    fs.writeFileSync(path.join(fixturesDir, name), lines.join('\n'));
    return matched;
}

describe('sheet preview at scale', () => {
    test('previews every row of a 12,000-row sheet, not just the first 10', async () => {
        writeFixture('big.csv', 12000, 4);
        const ev = await createEvent(owner.client);

        const r = await owner.client.post(`/api/event/${ev.id}/sheet-watch/preview`, { url: 'test-fixture:big.csv' });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.rowCount, 12000);
        assert.equal(r.body.sampleRows.length, 12000, 'every row should come back, not a 10-row sample');
        assert.equal(r.body.truncated, false);
        assert.deepEqual(r.body.headers, ['Timestamp', 'First Name', 'Last Name', 'Email', 'Interested']);
        assert.equal(r.body.suggested.firstNameColumn, 'First Name');
        assert.equal(r.body.suggested.lastNameColumn, 'Last Name');
        assert.equal(r.body.suggested.emailColumn, 'Email');
        // Spot-check the far end of the sheet, not just row 0 — a slice(0, N)
        // regression would still pass a length check if N were miscounted.
        assert.equal(r.body.sampleRows[11999][3], 'person11999@sheetfixture.test.local');
    });

    test('caps and flags an extreme sheet instead of returning it whole', async () => {
        writeFixture('huge.csv', 60000, 5);
        const ev = await createEvent(owner.client);

        const r = await owner.client.post(`/api/event/${ev.id}/sheet-watch/preview`, { url: 'test-fixture:huge.csv' });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.rowCount, 60000);
        assert.equal(r.body.sampleRows.length, 50000, 'should stop at the payload sanity cap');
        assert.equal(r.body.truncated, true);
    });
});

describe('condition matching at scale (10,000+ rows)', () => {
    test('issues a ticket for exactly the rows that match, across 10,500 rows', { timeout: 120_000 }, async () => {
        const expectedMatches = writeFixture('matches.csv', 10500, 3); // 3,500 matches
        assert.equal(expectedMatches, 3500);
        const ev = await createEvent(owner.client);

        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:matches.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'Yes' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            includeExisting: true, // issue for rows already in the sheet, not just future ones
            sendEmail: false,      // skip the confirmation email — this test is about matching, not delivery
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);

        const poll = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(poll.status, 200, poll.text);
        assert.equal(poll.body.summary.matched, 3500);
        assert.equal(poll.body.summary.issued, 3500);
        assert.equal(poll.body.summary.failed, 0);
        assert.equal(poll.body.summary.alreadySeen, 0);

        const tickets = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(tickets.status, 200, tickets.text);
        assert.equal(tickets.body.length, 3500);

        const emails = new Set(tickets.body.map(t => t.email));
        assert.ok(emails.has('person0@sheetfixture.test.local'), 'row 0 (i%3===0) should have matched');
        assert.ok(emails.has('person3@sheetfixture.test.local'), 'row 3 (i%3===0) should have matched');
        assert.ok(!emails.has('person1@sheetfixture.test.local'), 'row 1 (i%3!==0) should not have matched');
        assert.ok(!emails.has('person2@sheetfixture.test.local'), 'row 2 (i%3!==0) should not have matched');

        // A second poll must not double-issue — every matching row is now
        // "seen", so re-running finds the same matches but issues nothing new.
        const secondPoll = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(secondPoll.status, 200, secondPoll.text);
        assert.equal(secondPoll.body.summary.matched, 3500);
        assert.equal(secondPoll.body.summary.issued, 0);
        assert.equal(secondPoll.body.summary.alreadySeen, 3500);
    });

    // A poll processes rows one at a time (a real internal HTTP call per
    // matched row — see pollSheetWatcher in server.js), so on a large enough
    // sheet a single pass runs well past the scheduler's own 1-second tick.
    // That used to mean two callers hitting the watcher close together —
    // "Check now" and the background scheduler, or two impatient clicks of
    // "Check now" — could both start a full pass concurrently, race on which
    // rows were already marked seen, and double-issue whichever rows landed
    // in the gap. This drives that race directly (two concurrent manual
    // polls) rather than waiting on scheduler timing, so it stays a fast,
    // deterministic regression check instead of a flaky timing-dependent one.
    test('two concurrent "Check now" calls never double-issue the same row', { timeout: 60_000 }, async () => {
        const expectedMatches = writeFixture('concurrent.csv', 2000, 3);
        const ev = await createEvent(owner.client);

        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:concurrent.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'Yes' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            includeExisting: true,
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);

        const [pollA, pollB] = await Promise.all([
            owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {}),
            owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {}),
        ]);
        assert.equal(pollA.status, 200, pollA.text);
        assert.equal(pollB.status, 200, pollB.text);

        // Both calls should report the same finished result — whichever
        // actually ran the work, the other coalesced onto that same promise
        // instead of starting an independent, racing pass.
        assert.equal(pollA.body.summary.matched, expectedMatches);
        assert.equal(pollB.body.summary.matched, expectedMatches);
        assert.equal(pollA.body.summary.issued + pollA.body.summary.alreadySeen, expectedMatches);
        assert.equal(pollB.body.summary.issued + pollB.body.summary.alreadySeen, expectedMatches);

        const tickets = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(tickets.status, 200, tickets.text);
        assert.equal(tickets.body.length, expectedMatches, 'concurrent polls must not double-issue');
        const uniqueEmails = new Set(tickets.body.map(t => t.email));
        assert.equal(uniqueEmails.size, expectedMatches, 'every issued ticket should be for a distinct row');
    });
});
