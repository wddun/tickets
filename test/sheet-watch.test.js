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

    test('returns a sheet whole even past the old 50,000-row cap', async () => {
        // The preview used to stop at 50,000 rows as a payload sanity limit —
        // dropped once the dashboard's match-preview table became virtualized
        // (renders only the rows scrolled into view, so a huge sample no
        // longer costs anything to display) and the live watcher itself was
        // already scanning every row uncapped, making the preview the only
        // place that couldn't show what the watcher would actually do.
        writeFixture('huge.csv', 60000, 5);
        const ev = await createEvent(owner.client);

        const r = await owner.client.post(`/api/event/${ev.id}/sheet-watch/preview`, { url: 'test-fixture:huge.csv' });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.rowCount, 60000);
        assert.equal(r.body.sampleRows.length, 60000, 'every row should come back, no cap');
        assert.equal(r.body.truncated, false);
        assert.equal(r.body.sampleRows[59999][3], 'person59999@sheetfixture.test.local');
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

// A production sheet watcher connected (without "include existing rows") to
// a long-running sheet with a handful of legacy rows that have no usable
// email ("N/U", a typo missing the @) — those rows get swept into "seen" at
// connect time same as every other already-matching row, but used to still
// fail email validation on every later poll anyway (the check ran before the
// seen check), permanently overwriting lastError with the same unfixable,
// unactionable complaint about a row nobody can do anything about.
describe('a bad row that was already marked seen at connect time', () => {
    test('never resurfaces as lastError once swept in by the include-existing-rows skip', async () => {
        const lines = ['Timestamp,First Name,Last Name,Email,Interested'];
        lines.push(['2024-01-01T00:00:00', 'Alice', 'Anderson', 'alice@sheetfixture.test.local', 'Yes'].join(','));
        lines.push(['2024-01-01T00:00:01', 'Bob', 'Broken', 'N/U', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'legacy-bad-email.csv'), lines.join('\n'));

        const ev = await createEvent(owner.client);
        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:legacy-bad-email.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'Yes' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            includeExisting: false, // both rows are swept into "seen" without issuing
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);
        assert.equal(connect.body.watcher.lastError, null, 'connecting must not itself report the legacy row as an error');

        // Poll repeatedly, the way the real scheduler would — Bob's row is
        // "seen" from connect time, so it should be silently skipped
        // (alreadySeen), not re-validated and re-reported, every single time.
        for (let i = 0; i < 3; i++) {
            const poll = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
            assert.equal(poll.status, 200, poll.text);
            assert.equal(poll.body.summary.matched, 2);
            assert.equal(poll.body.summary.issued, 0, 'both rows predate the watcher and must not be issued');
            assert.equal(poll.body.summary.alreadySeen, 2, 'Bob\'s bad-email row is already seen, not freshly failed');
            assert.equal(poll.body.summary.failed, 0);
            assert.equal(poll.body.watcher.lastError, null, `poll ${i + 1} must not resurface the legacy row's stale error`);
        }

        // A genuinely NEW row with a bad email — appended after connect, so
        // it was never swept into "seen" — must still be caught and reported;
        // this isn't about silencing real, actionable problems.
        lines.push(['2024-01-01T00:00:02', 'Cara', 'NewBadEmail', 'not-an-email', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'legacy-bad-email.csv'), lines.join('\n'));
        const pollAfterNewRow = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(pollAfterNewRow.status, 200, pollAfterNewRow.text);
        assert.equal(pollAfterNewRow.body.summary.matched, 3);
        assert.equal(pollAfterNewRow.body.summary.alreadySeen, 2);
        assert.equal(pollAfterNewRow.body.summary.failed, 1);
        assert.match(pollAfterNewRow.body.watcher.lastError, /Row 4: missing or invalid email/);
    });
});

// A row's position key falls back to its blank timestamp cell as if that
// were a real distinguishing value, unless the fix below is in — so several
// pre-existing rows for the same email with no timestamp (typed or pasted
// straight into the sheet, not a live Form submission) all collapse onto
// one identical key. Sweeping the first of them as "existing" at connect
// time used to also silently swallow a brand-new row for that same email
// added after the reconnect, since it looked identical by position.
describe('blank-timestamp rows for the same email', () => {
    test('a new blank-timestamp row is not confused with an old one already swept', async () => {
        const lines = ['Timestamp,First Name,Last Name,Email,Interested'];
        // Several old, blank-timestamp rows for the same address — a typed
        // or pasted entry, not a Form submission, same as the real sheet.
        lines.push([',Old,One,repeat2@sheetfixture.test.local,Yes'].join(','));
        lines.push([',Old,Two,repeat2@sheetfixture.test.local,Yes'].join(','));
        lines.push([',Old,Three,repeat2@sheetfixture.test.local,Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'blank-ts-repeat.csv'), lines.join('\n'));

        const ev = await createEvent(owner.client, { name: 'Blank Timestamp Repeat' });
        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:blank-ts-repeat.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'Yes' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            oneTicketPerEmail: true,
            includeExisting: false, // all 3 old rows swept into "seen" without issuing
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);

        const pollBefore = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(pollBefore.body.summary.issued, 0);
        assert.equal(pollBefore.body.summary.alreadySeen, 3);

        // A genuinely new row for the same address, added after connect —
        // also blank timestamp, exactly like someone typing it in by hand
        // right after a reconnect.
        lines.push([',New,Entry,repeat2@sheetfixture.test.local,Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'blank-ts-repeat.csv'), lines.join('\n'));

        const pollAfter = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(pollAfter.status, 200, pollAfter.text);
        assert.equal(pollAfter.body.summary.matched, 4);
        assert.equal(pollAfter.body.summary.issued, 1, 'the new blank-timestamp row must not be mistaken for an already-swept old one');
        assert.equal(pollAfter.body.summary.alreadySeen, 3);

        const tickets = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(tickets.body.length, 1);
        assert.equal(tickets.body[0].email, 'repeat2@sheetfixture.test.local');
    });
});

// The connect-time "skip existing" sweep used to record bare-email keys
// under oneTicketPerEmail, exactly like a real issue does — so an address
// that merely appeared somewhere in the sheet's pre-connect history (e.g. a
// long-running weekly sign-in sheet reused for a one-off giveaway) was
// permanently barred from ever getting a ticket, even from a genuinely new
// row submitted well after the watcher connected. "Ignore everything
// already in the sheet" must mean per *row*, not blacklist the email.
describe('oneTicketPerEmail and the skip-existing sweep together', () => {
    test('a new row from an email seen only in pre-connect history still gets a ticket', async () => {
        const lines = ['Timestamp,First Name,Last Name,Email,Interested'];
        // Several old rows already used this address, long before the watcher
        // ever existed — same shape as a year of recurring meeting sign-ins.
        lines.push(['2024-01-01T00:00:00', 'Repeat', 'Visitor', 'repeat@sheetfixture.test.local', 'Yes'].join(','));
        lines.push(['2024-02-01T00:00:00', 'Repeat', 'Visitor', 'repeat@sheetfixture.test.local', 'Yes'].join(','));
        lines.push(['2024-03-01T00:00:00', 'Repeat', 'Visitor', 'repeat@sheetfixture.test.local', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'oneticket-history.csv'), lines.join('\n'));

        const ev = await createEvent(owner.client);
        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:oneticket-history.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'Yes' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            oneTicketPerEmail: true,
            includeExisting: false, // all 3 historical rows swept into "seen", none issued
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);

        const pollBefore = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(pollBefore.body.summary.matched, 3);
        assert.equal(pollBefore.body.summary.issued, 0);
        assert.equal(pollBefore.body.summary.alreadySeen, 3);

        const tickets0 = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(tickets0.body.length, 0, 'no ticket yet for an email only ever seen in pre-connect history');

        // A brand-new submission today from that same address — a real,
        // fresh giveaway entry, not one of the old rows.
        lines.push(['2026-09-08T20:00:00', 'Repeat', 'Visitor', 'repeat@sheetfixture.test.local', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'oneticket-history.csv'), lines.join('\n'));

        const pollAfter = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(pollAfter.status, 200, pollAfter.text);
        assert.equal(pollAfter.body.summary.matched, 4);
        assert.equal(pollAfter.body.summary.issued, 1, 'the new row must be issued, not blocked by its own pre-connect history');
        assert.equal(pollAfter.body.summary.alreadySeen, 3);

        const tickets1 = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(tickets1.body.length, 1);
        assert.equal(tickets1.body[0].email, 'repeat@sheetfixture.test.local');

        // Now that this email has actually received a ticket, oneTicketPerEmail
        // does its real job: a second new row from the same address today is
        // correctly blocked, not issued a duplicate.
        lines.push(['2026-09-08T20:05:00', 'Repeat', 'Visitor', 'repeat@sheetfixture.test.local', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'oneticket-history.csv'), lines.join('\n'));

        const pollDup = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(pollDup.status, 200, pollDup.text);
        assert.equal(pollDup.body.summary.matched, 5);
        assert.equal(pollDup.body.summary.issued, 0, 'a second new row from an already-issued email must not get a second ticket');
        // The 3 historical rows and the first new row are each already seen
        // by position; the duplicate new row is a fresh position but is
        // caught by the separate per-email check — all 5 land in alreadySeen.
        assert.equal(pollDup.body.summary.alreadySeen, 5);

        const tickets2 = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(tickets2.body.length, 1, 'still exactly one ticket for this email');
    });

    // sheetWatcherSeen deliberately outlives the ticket it caused, so a
    // re-polled *unchanged* row can never loop and re-issue itself forever.
    // But an organiser deleting that ticket clearly means to let the address
    // register again — and without clearing the bare-email key, a genuinely
    // new future row from that address would stay blocked forever too, with
    // no ticket anywhere to show why. Deleting the ticket must lift that
    // specific block.
    test('deleting the issued ticket lets a later new row for that address issue again', async () => {
        // Connects on an empty sheet, deliberately — writing the target row
        // before connect would sweep it into "seen" as pre-connect history
        // (like the test above) rather than issuing it for real, which is
        // the case this test needs: an address that has actually received
        // and then lost a ticket, not one that was merely swept.
        const header = 'Timestamp,First Name,Last Name,Email,Interested';
        fs.writeFileSync(path.join(fixturesDir, 'oneticket-deleted.csv'), header);

        const ev = await createEvent(owner.client);
        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:oneticket-deleted.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'Yes' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            oneTicketPerEmail: true,
            includeExisting: false,
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);

        const lines = [header];
        lines.push(['2026-09-08T22:00:00', 'Repeat', 'Deleted', 'deleted@sheetfixture.test.local', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'oneticket-deleted.csv'), lines.join('\n'));

        const pollFirst = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(pollFirst.body.summary.issued, 1);

        const issued = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(issued.body.length, 1);

        const del = await owner.client.del('/api/registrations/bulk', { registrationIds: [issued.body[0].registrationId] });
        assert.equal(del.status, 200, del.text);

        const afterDelete = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(afterDelete.body.length, 0);

        // A brand-new row for the same address, submitted after the delete —
        // not the same one that already issued.
        lines.push(['2026-09-09T15:05:00', 'Repeat', 'Deleted', 'deleted@sheetfixture.test.local', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'oneticket-deleted.csv'), lines.join('\n'));

        const pollSecond = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(pollSecond.status, 200, pollSecond.text);
        assert.equal(pollSecond.body.summary.issued, 1, 'a new row must issue again once the earlier ticket for that address was deleted');

        const reissued = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(reissued.body.length, 1);
        assert.equal(reissued.body[0].email, 'deleted@sheetfixture.test.local');
    });
});

// register-bulk's own duplicate-email guard (see api-access.test.js for the
// guard itself) must not silently swallow a watcher deliberately configured
// to allow it — "dedupe by email" off means one ticket per *row*, even from
// a repeat address, and that's the whole point of turning it off.
describe('oneTicketPerEmail off', () => {
    test('a repeat address gets a separate ticket per row, not silently deduped', async () => {
        const lines = ['Timestamp,First Name,Last Name,Email,Interested'];
        lines.push(['2024-01-01T00:00:00', 'Jordan', 'Lee', 'jordan@sheetfixture.test.local', 'Yes'].join(','));
        lines.push(['2024-01-01T00:00:01', 'Jordan', 'Lee', 'jordan@sheetfixture.test.local', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'no-dedupe.csv'), lines.join('\n'));

        const ev = await createEvent(owner.client, { name: 'Multi Entry' });
        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:no-dedupe.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'Yes' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            oneTicketPerEmail: false,
            includeExisting: true,
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);

        const poll = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(poll.status, 200, poll.text);
        assert.equal(poll.body.summary.matched, 2);
        assert.equal(poll.body.summary.issued, 2, 'both rows must be issued — dedupe-by-email is explicitly off');

        const tickets = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(tickets.body.length, 2);
        assert.ok(tickets.body.every(t => t.email === 'jordan@sheetfixture.test.local'));
        assert.notEqual(tickets.body[0].registrationId, tickets.body[1].registrationId, 'two rows, two separate registrations');
    });
});

// Disconnecting is a deliberate reset: it forgets which rows were already
// decided, so a later reconnect draws the "ignore what's already in the
// sheet" line fresh, at whatever the sheet looks like at that moment —
// same as any first-ever connect. That must never mean someone can get a
// second ticket, though, so that guarantee lives one level down, in
// register-bulk's own duplicate-email check (emailAlreadyRegistered) —
// independent of whatever the watcher's own bookkeeping does or doesn't
// remember. This test exercises both halves through the real
// disconnect/reconnect flow; the dedicated register-bulk test below
// exercises the guard itself directly.
describe('reconnecting the same sheet', () => {
    test('forgets nothing was "seen", but still never double-issues a ticket', async () => {
        const lines = ['Timestamp,First Name,Last Name,Email,Interested'];
        lines.push(['2024-01-01T00:00:00', 'Priya', 'Patel', 'priya@sheetfixture.test.local', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'reconnect.csv'), lines.join('\n'));

        const ev = await createEvent(owner.client, { name: 'Reconnect Test' });
        const connectBody = {
            url: 'test-fixture:reconnect.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'Yes' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            oneTicketPerEmail: true,
            includeExisting: true, // Priya's row is issued for real, not swept
            sendEmail: false,
            intervalMinutes: 15,
        };
        const connect1 = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, connectBody);
        assert.equal(connect1.status, 200, connect1.text);

        const poll1 = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(poll1.body.summary.issued, 1, 'Priya should get a real ticket on the first connect');

        const disconnect = await owner.client.del(`/api/event/${ev.id}/sheet-watch`);
        assert.equal(disconnect.status, 200, disconnect.text);

        // Reconnect to the exact same sheet — Priya's row is still sitting
        // there, still matching, exactly as it would be in practice.
        const connect2 = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, connectBody);
        assert.equal(connect2.status, 200, connect2.text);

        const poll2 = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(poll2.status, 200, poll2.text);
        assert.equal(poll2.body.summary.issued, 0, 'reconnecting must not re-issue someone who already has a ticket');
        assert.equal(poll2.body.summary.alreadySeen, 1);

        const tickets = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(tickets.body.length, 1, 'still exactly one ticket after the reconnect');

        // A genuinely new row submitted after the reconnect must still work
        // normally — the fix isn't "nothing new can ever come in again".
        lines.push(['2024-01-02T00:00:00', 'Omar', 'Osei', 'omar@sheetfixture.test.local', 'Yes'].join(','));
        fs.writeFileSync(path.join(fixturesDir, 'reconnect.csv'), lines.join('\n'));
        const poll3 = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(poll3.body.summary.issued, 1, 'a real new submission after the reconnect must still be issued');

        const ticketsAfter = await owner.client.get(`/api/event/${ev.id}/tickets`);
        assert.equal(ticketsAfter.body.length, 2);
    });
});

describe('date conditions ("only rows after a given date/time")', () => {
    test('dateAfter matches only rows timestamped later than the picked value', async () => {
        const lines = ['Timestamp,First Name,Last Name,Email'];
        const rows = [
            ['8/25/2026 9:00:00', 'Alice', 'Anderson', 'alice@sheetfixture.test.local'],
            ['8/26/2026 10:30:00', 'Bob', 'Brown', 'bob@sheetfixture.test.local'],
            ['8/27/2026 18:45:00', 'Carol', 'Clark', 'carol@sheetfixture.test.local'],
            ['8/28/2026 6:15:00', 'Dave', 'Davis', 'dave@sheetfixture.test.local'],
        ];
        for (const r of rows) lines.push(r.join(','));
        fs.writeFileSync(path.join(fixturesDir, 'dates.csv'), lines.join('\n'));

        const ev = await createEvent(owner.client);
        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:dates.csv',
            // Everything strictly after midnight at the start of 8/27 — should
            // catch Carol (8/27 18:45) and Dave (8/28 6:15) but not Alice or Bob.
            conditionGroup: { match: 'all', children: [{ column: 'Timestamp', operator: 'dateAfter', value: '2026-08-27T00:00' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            includeExisting: true,
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);

        const poll = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(poll.status, 200, poll.text);
        assert.equal(poll.body.summary.matched, 2);
        assert.equal(poll.body.summary.issued, 2);

        const tickets = await owner.client.get(`/api/event/${ev.id}/tickets`);
        const emails = new Set(tickets.body.map(t => t.email));
        assert.ok(emails.has('carol@sheetfixture.test.local'));
        assert.ok(emails.has('dave@sheetfixture.test.local'));
        assert.ok(!emails.has('alice@sheetfixture.test.local'));
        assert.ok(!emails.has('bob@sheetfixture.test.local'));
    });

    test('dateBefore matches only rows timestamped earlier than the picked value, and an unparseable cell never matches either way', async () => {
        const lines = [
            'Timestamp,First Name,Last Name,Email',
            '8/25/2026 9:00:00,Eve,Evans,eve@sheetfixture.test.local',
            '8/28/2026 6:15:00,Frank,Foster,frank@sheetfixture.test.local',
            'not a date,Gina,Garcia,gina@sheetfixture.test.local',
        ];
        fs.writeFileSync(path.join(fixturesDir, 'dates-before.csv'), lines.join('\n'));

        const ev = await createEvent(owner.client);
        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:dates-before.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Timestamp', operator: 'dateBefore', value: '2026-08-27T00:00' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            includeExisting: true,
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);

        const poll = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(poll.status, 200, poll.text);
        assert.equal(poll.body.summary.matched, 1, 'only the row before the cutoff — the unparseable row matches neither dateBefore nor dateAfter');

        const tickets = await owner.client.get(`/api/event/${ev.id}/tickets`);
        const emails = new Set(tickets.body.map(t => t.email));
        assert.ok(emails.has('eve@sheetfixture.test.local'));
        assert.ok(!emails.has('frank@sheetfixture.test.local'));
        assert.ok(!emails.has('gina@sheetfixture.test.local'));
    });
});

describe('case-sensitive matching', () => {
    test('caseSensitive:true only matches an exact-case answer; the default stays case-insensitive', async () => {
        const lines = [
            'Timestamp,First Name,Last Name,Email,Interested',
            '2024-01-01T00:00:00,Alice,Anderson,alice@sheetfixture.test.local,YES',
            '2024-01-01T00:00:01,Bob,Brown,bob@sheetfixture.test.local,yes',
            '2024-01-01T00:00:02,Carol,Clark,carol@sheetfixture.test.local,No',
        ];
        fs.writeFileSync(path.join(fixturesDir, 'case.csv'), lines.join('\n'));

        const ev = await createEvent(owner.client);
        const connect = await owner.client.post(`/api/event/${ev.id}/sheet-watch`, {
            url: 'test-fixture:case.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'YES', caseSensitive: true }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            includeExisting: true,
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect.status, 200, connect.text);

        const poll = await owner.client.post(`/api/event/${ev.id}/sheet-watch/poll`, {});
        assert.equal(poll.status, 200, poll.text);
        assert.equal(poll.body.summary.matched, 1, 'only the exact-case "YES" — lowercase "yes" should not match');

        const tickets = await owner.client.get(`/api/event/${ev.id}/tickets`);
        const emails = new Set(tickets.body.map(t => t.email));
        assert.ok(emails.has('alice@sheetfixture.test.local'));
        assert.ok(!emails.has('bob@sheetfixture.test.local'), 'lowercase "yes" must not match a case-sensitive "YES"');
        assert.ok(!emails.has('carol@sheetfixture.test.local'));

        // Same sheet, same condition, but without the flag — should now catch
        // both "YES" and "yes" the way every other condition always has.
        const ev2 = await createEvent(owner.client);
        const connect2 = await owner.client.post(`/api/event/${ev2.id}/sheet-watch`, {
            url: 'test-fixture:case.csv',
            conditionGroup: { match: 'all', children: [{ column: 'Interested', operator: 'equals', value: 'YES' }] },
            firstNameColumn: 'First Name',
            lastNameColumn: 'Last Name',
            emailColumn: 'Email',
            includeExisting: true,
            sendEmail: false,
            intervalMinutes: 15,
        });
        assert.equal(connect2.status, 200, connect2.text);

        const poll2 = await owner.client.post(`/api/event/${ev2.id}/sheet-watch/poll`, {});
        assert.equal(poll2.status, 200, poll2.text);
        assert.equal(poll2.body.summary.matched, 2, 'without caseSensitive, "YES" and "yes" both match as before');
    });
});
