# Test suite

```bash
npm test
```

Runs every `test/*.test.js` file with the built-in Node test runner. No
dependencies, no build step, ~12 seconds.

```bash
node --test --test-reporter=spec "test/scanner.test.js"   # one file, readable output
npm run test:watch                                        # re-run on save
```

## How it works

Each test file boots **a real server** — the same `server.js` that runs in
production — as a child process, and talks to it over HTTP. Nothing is mocked.
If a helper here can't do something, neither can a browser or the iOS app.

Every file gets its own throwaway world under `os.tmpdir()`:

| Env var | What it isolates |
|---|---|
| `TICKETS_DB` | its own SQLite file, so the working database is never touched |
| `SESSIONS_DIR` | its own session store |
| `PASS_CACHE_DIR` | its own wallet-pass cache |
| `EMAIL_SINK` | every outgoing email, written to a JSONL file instead of SES |
| `DISABLE_RATE_LIMITS` | the login/scan limiters, which a test run would otherwise trip |
| `SHEET_TEST_FIXTURES_DIR` | lets a `test-fixture:<file>` sheet-watch URL read a local CSV instead of fetching Google Sheets |

These are the only test hooks in the application code. All six are unset in
production, where the extra branches are dead.

**No test can send real mail or reach a live Stripe account.** `EMAIL_SINK`
diverts every send before the SES client is involved, the AWS credentials
passed to the child are dummies, and the Stripe key is explicitly blanked so
`stripe` stays `null` — which is also how a customer's instance behaves before
their own Stripe account has been connected, so the paid-event tests cover
that path for real.

## Helpers

- `helpers/server.js` — boots and tears down an isolated server; `emails()`,
  `waitForEmail()`, `clearEmails()` read the sink.
- `helpers/client.js` — an HTTP client with its own cookie jar. "A user" in
  these tests is just a client with its own jar; two clients are two browsers.
  Door staff on a scan link and logged-out visitors are modelled the same way.
- `helpers/factories.js` — setup steps performed the way the real clients do
  them. `newUser()` really does sign up, pull the verification link out of the
  captured email, click it, and log in.

## What each file covers

| File | Area |
|---|---|
| `auth.test.js` | signup, email verification, login, logout, password change/reset, 2FA, admin setup |
| `permissions.test.js` | the capability model — every capability proved to gate its routes, sharing, editing and revoking grants, ownership transfer, admin scoping |
| `events.test.js` | event CRUD, themes, toggles, signup limits, deletion |
| `registration.test.js` | public self-registration, the live availability counter, duplicate-email and per-device limits |
| `capacity.test.js` | seat holds and ticket priority: who gets the last seat |
| `waitlist.test.js` | joining, position, promotion (free and paid), claim offers holding a seat |
| `tickets.test.js` | manual add/edit/delete, bulk check-in and undo, CSV export, QR and tracking |
| `scanner.test.js` | validating tickets, re-entry, the three ways to prove you may scan, scan links, the door display, the shuttle check |
| `ios-app.test.js` | the exact endpoints `APIService.swift` calls, asserted against what `Item.swift` decodes |
| `api-access.test.js` | the apiKey-authenticated integration routes (Google Sheets and anything else outside) |
| `paid-events.test.js` | paid ticketing as a beta feature, the beta notices, discount codes, orders |
| `email.test.js` | what actually lands in the inbox, including the venue row being omitted when there is no venue |
| `admin.test.js` | admin-only routes, per-event metrics, the audit trail |
| `pages.test.js` | which pages are served to whom, the service-worker contract, `?fresh=1` on generated links |
| `rate-limits.test.js` | the login/reset/scan limiters — this file boots its own server with them left on |
| `sheet-watch.test.js` | sheet import preview: row cap/truncation, condition matching correctness at 10,000+ rows |

## Writing a new test

Prefer asserting on behaviour someone would notice — a ticket issued, a seat
lost, a message shown — over asserting on an implementation detail. Where a
test pins down something surprising, say why in a comment: several of these
exist because of a specific bug, and the comment is what stops the next person
"simplifying" the fix away.
