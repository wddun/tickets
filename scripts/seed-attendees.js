#!/usr/bin/env node
// Interactive tool for seeding fake attendees into a real event, for manual
// QA (load-testing the dashboard/check-in/giveaway pages with a realistic
// attendee count, exercising name-escaping edge cases, etc). Talks to the
// app's own public API (mints a real per-event API key, same as any other
// integration would) rather than a private/backdoor route — it never
// disables rate limits or bypasses anything, and confirmation emails are
// off by default (sendEmail is only ever true if a menu option you pick
// asks for it explicitly).
//
// Usage:
//   node scripts/seed-attendees.js
//
// Env vars (all optional):
//   TICKETS_BASE_URL   default https://tickets.willstechsupport.com
//   TICKETS_EMAIL       default willdunning01@gmail.com
//   TICKETS_PASSWORD    if unset, you're prompted (input hidden)

import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

const BASE_URL = (process.env.TICKETS_BASE_URL || 'https://tickets.willstechsupport.com').replace(/\/$/, '');
const LOGIN_EMAIL = process.env.TICKETS_EMAIL || 'willdunning01@gmail.com';

let sessionCookie = null;
let apiKeyId = null;
let apiKey = null;
let apiEvent = null;
const createdRegistrationIds = [];

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// Ctrl+C, Ctrl+D, and the backspace byte most terminals actually send
// (0x7f, DEL) — as escapes rather than literal control bytes so the source
// stays plain text instead of carrying invisible characters.
const ETX = '\x03';
const EOT = '\x04';
const DEL = '\x7f';

function askHidden(query) {
    return new Promise((resolve) => {
        stdout.write(query);
        const wasRaw = stdin.isRaw;
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let input = '';
        const cleanup = () => {
            stdin.removeListener('data', onData);
            if (stdin.isTTY) stdin.setRawMode(wasRaw);
            stdin.pause();
        };
        const onData = (ch) => {
            ch = ch.toString();
            if (ch === '\n' || ch === '\r' || ch === EOT) {
                cleanup();
                stdout.write('\n');
                resolve(input);
            } else if (ch === ETX) {
                cleanup();
                stdout.write('\n');
                process.exit(1);
            } else if (ch === DEL || ch === '\b') {
                input = input.slice(0, -1);
            } else {
                input += ch;
            }
        };
        stdin.on('data', onData);
    });
}

async function request(method, path, { body, auth = 'session' } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth === 'session' && sessionCookie) headers.Cookie = sessionCookie;
    if (auth === 'key') headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const sid = setCookie.find((c) => c.startsWith('connect.sid='));
    if (sid) sessionCookie = sid.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
}

async function login() {
    console.log(`Logging in as ${LOGIN_EMAIL} at ${BASE_URL} ...`);
    const password = process.env.TICKETS_PASSWORD || await askHidden('Password: ');
    let res = await request('POST', '/api/auth/login', { body: { email: LOGIN_EMAIL, password, rememberMe: false } });
    if (res.data?.needsTotp) {
        const code = await ask('2FA code: ');
        res = await request('POST', '/api/auth/login/totp-verify', {
            body: { pendingToken: res.data.pendingToken, code, remember: false },
        });
    }
    if (!res.ok || !res.data?.success) {
        console.error('Login failed:', res.data?.error || res.status);
        process.exit(1);
    }
    console.log('Logged in.\n');
}

async function pickEvent() {
    const res = await request('GET', '/api/events');
    if (!res.ok) { console.error('Could not list events:', res.data); process.exit(1); }
    const events = res.data;
    if (!events.length) { console.error('No events on this account.'); process.exit(1); }
    console.log('Your events:');
    events.forEach((e, i) => {
        console.log(`  ${i + 1}. ${e.name}  (capacity: ${e.capacity ?? 'unlimited'}, waitlist: ${e.waitlistEnabled ? 'on' : 'off'})`);
    });
    const idx = parseInt(await ask('\nPick an event by number: '), 10) - 1;
    if (!(idx >= 0 && idx < events.length)) { console.error('Invalid choice.'); process.exit(1); }
    return events[idx];
}

async function mintApiKey(eventId) {
    const res = await request('POST', `/api/event/${eventId}/api-keys`, {
        body: { name: `seed-attendees ${new Date().toISOString()}`, scopes: ['manage_tickets', 'checkin', 'undo_checkin'] },
    });
    if (!res.ok) {
        console.error('Could not create an API key for this event (need manage_event on it):', res.data);
        process.exit(1);
    }
    apiKeyId = res.data.id;
    apiKey = res.data.key;
}

async function revokeApiKey() {
    if (!apiKeyId) return;
    await request('DELETE', `/api/api-keys/${apiKeyId}`);
}

async function registerOne(name, email, { customFields, sendEmail = false } = {}) {
    return request('POST', '/api/v1/registrations', {
        auth: 'key',
        body: { name, email, ticketCount: 1, customFields, sendEmail },
    });
}

async function seedStandardBatch() {
    const count = parseInt(await ask('How many? [200]: '), 10) || 200;
    const start = parseInt(await ask('Start numbering at? [1]: '), 10) || 1;
    console.log(`\nCreating ${count}: willdunning01+${start}@gmail.com .. willdunning01+${start + count - 1}@gmail.com\n`);
    let created = 0, waitlisted = 0, failed = 0;
    for (let i = 0; i < count; i++) {
        const n = start + i;
        const res = await registerOne(`William Dunning${n}`, `willdunning01+${n}@gmail.com`);
        if (res.status === 201) { created++; createdRegistrationIds.push(res.data.id); }
        else if (res.status === 202) waitlisted++;
        else { failed++; console.log(`  [${n}] failed: ${res.status} ${JSON.stringify(res.data)}`); }
        if ((i + 1) % 25 === 0) console.log(`  ...${i + 1}/${count}`);
    }
    console.log(`\nDone. created=${created} waitlisted=${waitlisted} failed=${failed}\n`);
}

// A grab-bag of the inputs that most often break name handling, rendering,
// or storage: unicode, emoji, markup, quoting, whitespace, and a
// SQL-injection-shaped string (prepared statements should make this a
// non-issue, but it's cheap to keep checking).
const EDGE_CASES = [
    { tag: 'long', name: 'Alexandra '.repeat(12).trim() + ' Longname' },
    { tag: 'unicode', name: 'José García-Muñoz' },
    { tag: 'emoji', name: '🎉 Party Person 🎊' },
    { tag: 'html', name: '<script>alert(1)</script>' },
    { tag: 'html2', name: '<img src=x onerror=alert(1)>' },
    { tag: 'quotes', name: `O'Brien "The Great"` },
    { tag: 'whitespace', name: '   Spacey   Name   ' },
    { tag: 'sqlish', name: "Robert'); DROP TABLE tickets;--" },
    { tag: 'rtl', name: 'محمد أحمد' },
    { tag: 'single-char', name: 'X' },
    { tag: 'newline', name: 'Line1\nLine2' },
    { tag: 'ampersand', name: 'Smith & Sons <b>Co</b>' },
    { tag: 'one-word', name: 'Cher' },
    { tag: 'numeric', name: '12345' },
    { tag: 'mixed-emoji', name: 'Test 😀 User' },
    { tag: 'multi-space', name: 'John    Doe' },
];

async function seedEdgeCases() {
    console.log(`\nCreating ${EDGE_CASES.length} edge-case attendees...\n`);
    let created = 0, waitlisted = 0, failed = 0;
    for (const c of EDGE_CASES) {
        const res = await registerOne(c.name, `willdunning01+edge-${c.tag}@gmail.com`);
        if (res.status === 201) { created++; createdRegistrationIds.push(res.data.id); console.log(`  ok   [${c.tag}]`); }
        else if (res.status === 202) { waitlisted++; console.log(`  wait [${c.tag}]`); }
        else { failed++; console.log(`  ERR  [${c.tag}] ${res.status} ${JSON.stringify(res.data)}`); }
    }
    console.log(`\nDone. created=${created} waitlisted=${waitlisted} failed=${failed}\n`);
}

async function seedConcurrentBurst() {
    const count = parseInt(await ask('How many at once? [20]: '), 10) || 20;
    const start = parseInt(await ask('Start numbering at? [9000]: '), 10) || 9000;
    console.log(`\nFiring ${count} registrations simultaneously (capacity/race handling)...\n`);
    const results = await Promise.all(
        Array.from({ length: count }, (_, i) => {
            const n = start + i;
            return registerOne(`William Dunning${n}`, `willdunning01+${n}@gmail.com`);
        })
    );
    let created = 0, waitlisted = 0, failed = 0;
    for (const res of results) {
        if (res.status === 201) { created++; createdRegistrationIds.push(res.data.id); }
        else if (res.status === 202) waitlisted++;
        else failed++;
    }
    console.log(`Done. created=${created} waitlisted=${waitlisted} failed=${failed}\n`);
}

async function checkinRandomSubset() {
    if (!createdRegistrationIds.length) { console.log('Nothing created this session yet.\n'); return; }
    const pct = Math.min(100, Math.max(0, parseInt(
        await ask(`Check in what fraction of the ${createdRegistrationIds.length} created this session? (0-100) [50]: `), 10
    ) || 50)) / 100;
    const shuffled = [...createdRegistrationIds].sort(() => Math.random() - 0.5);
    const subset = shuffled.slice(0, Math.round(shuffled.length * pct));
    const res = await request('POST', '/api/checkin/bulk', { body: { registrationIds: subset } });
    if (res.ok) console.log(`Checked in ${res.data.checkedIn} tickets.\n`);
    else console.log('Check-in failed:', res.data, '\n');
}

async function showStats() {
    const res = await request('GET', '/api/v1/registrations?limit=1', { auth: 'key' });
    if (res.ok) console.log(`\n"${apiEvent.name}": ${res.data.total} total registrations.\n`);
    else console.log('Could not fetch stats:', res.data, '\n');
}

async function toggleEmailPolicy() {
    const choice = (await ask('Turn public-registration confirmation emails ON or OFF? [off]: ')).trim().toLowerCase();
    const on = choice === 'on' || choice === 'true' || choice === 'yes';
    const res = await request('PUT', `/api/event/${apiEvent.id}/email-policy`, { body: { public: on } });
    if (res.ok) console.log(`Public confirmation emails are now ${on ? 'ON' : 'OFF'} for "${apiEvent.name}".\n`);
    else console.log('Failed:', res.data, '\n');
}

async function deleteCreatedThisSession() {
    if (!createdRegistrationIds.length) { console.log('Nothing created this session yet.\n'); return; }
    const confirm = await ask(`Delete all ${createdRegistrationIds.length} registrations created this session? Type "yes" to confirm: `);
    if (confirm.trim().toLowerCase() !== 'yes') { console.log('Cancelled.\n'); return; }
    let deleted = 0, failed = 0;
    for (const id of createdRegistrationIds) {
        const res = await request('DELETE', `/api/v1/registrations/${id}`, { auth: 'key' });
        if (res.ok) deleted++; else failed++;
    }
    createdRegistrationIds.length = 0;
    console.log(`Deleted ${deleted}, failed ${failed}.\n`);
}

async function fetchAllRegistrations(search) {
    let all = [];
    let offset = 0;
    for (;;) {
        const res = await request('GET', `/api/v1/registrations?search=${encodeURIComponent(search)}&limit=500&offset=${offset}`, { auth: 'key' });
        if (!res.ok) throw new Error(JSON.stringify(res.data));
        all = all.concat(res.data.registrations);
        offset += res.data.registrations.length;
        if (!res.data.registrations.length || offset >= res.data.total) break;
    }
    return all;
}

async function findAndDeleteByEmailPattern() {
    const needle = await ask('Search term (e.g. "willdunning01+"), matches name or email: ');
    const matches = await fetchAllRegistrations(needle);
    console.log(`Found ${matches.length} matching registrations.`);
    if (!matches.length) { console.log(); return; }
    const confirm = await ask('Delete all of them? Type "yes" to confirm: ');
    if (confirm.trim().toLowerCase() !== 'yes') { console.log('Cancelled.\n'); return; }
    let deleted = 0, failed = 0;
    for (const reg of matches) {
        const res = await request('DELETE', `/api/v1/registrations/${reg.id}`, { auth: 'key' });
        if (res.ok) deleted++; else failed++;
    }
    console.log(`Deleted ${deleted}, failed ${failed}.\n`);
}

async function mainMenu() {
    for (;;) {
        console.log(`=== ${apiEvent.name} ===`);
        console.log('  1) Seed N standard fake attendees (William Dunning{n} / willdunning01+{n}@gmail.com)');
        console.log('  2) Seed a batch of edge-case names (unicode, emoji, HTML, quotes, SQL-ish, ...)');
        console.log('  3) Fire a concurrent burst of registrations (capacity/race test)');
        console.log('  4) Check in a random subset of what this session created');
        console.log('  5) Show registration count for this event');
        console.log('  6) Turn public-registration confirmation emails on/off');
        console.log('  7) Delete everything created this session');
        console.log('  8) Find & delete by search term (e.g. leftovers from a previous run)');
        console.log('  q) Quit');
        const choice = (await ask('\n> ')).trim().toLowerCase();
        try {
            if (choice === '1') await seedStandardBatch();
            else if (choice === '2') await seedEdgeCases();
            else if (choice === '3') await seedConcurrentBurst();
            else if (choice === '4') await checkinRandomSubset();
            else if (choice === '5') await showStats();
            else if (choice === '6') await toggleEmailPolicy();
            else if (choice === '7') await deleteCreatedThisSession();
            else if (choice === '8') await findAndDeleteByEmailPattern();
            else if (choice === 'q') break;
            else console.log('Not a valid choice.\n');
        } catch (err) {
            console.error('Error:', err.message, '\n');
        }
    }
}

async function main() {
    await login();
    apiEvent = await pickEvent();
    await mintApiKey(apiEvent.id);
    console.log(`\nAPI key minted for "${apiEvent.name}". Confirmation emails stay off unless you turn them on with option 6.\n`);
    await mainMenu();
    const revoke = await ask('\nRevoke the API key created for this session? (Y/n): ');
    if (revoke.trim().toLowerCase() !== 'n') await revokeApiKey();
    rl.close();
    console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
