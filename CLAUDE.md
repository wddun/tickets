# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## House style

- **No emojis in code, UI text, comments, commit messages, or files unless the user explicitly asks or there's no alternative that fits.** Prefer inline SVG icons (the codebase already uses them widely — see scanner.html, checkin.html, dashboard.html) or plain text labels. When editing existing UI that already contains emojis, do not add more — leave the existing ones in place unless asked to clean them up.

## Line endings

**Every file in this repo is LF.** `server.js` was the lone CRLF holdout and was converted
in one commit, precisely so no future edit has to preserve it. Don't reintroduce CRLF: a
scripted edit that normalises newlines would otherwise rewrite all 8000 lines and bury the
real change in the diff.

## Running the server

```bash
npm start          # production
npm run dev        # development (auto-restarts on file change via --watch)
pm2 restart ticketcheckin   # restart in production (PM2 manages the process)
pm2 logs ticketcheckin      # tail logs
```

No build step. The server is a single `server.js` file; `public/` is served as static files with no bundler.

## Tests

```bash
npm test                                                # everything, ~12s
node --test --test-reporter=spec "test/scanner.test.js" # one file
```

`test/` holds the whole suite (see `test/README.md`). Each file boots a **real** copy of `server.js` as a child process on its own port and talks to it over HTTP — nothing is mocked, so a test can only do what a browser or the iOS app could do. Isolation comes from six env vars that exist purely as test hooks and are unset in production: `TICKETS_DB`, `SESSIONS_DIR`, `PASS_CACHE_DIR`, `EMAIL_SINK` (diverts every send to a JSONL file instead of SES, which is also how the tests assert on email content), `DISABLE_RATE_LIMITS`, and `SHEET_TEST_FIXTURES_DIR` (lets a `test-fixture:<file>` sheet-watch URL read a local CSV instead of fetching Google Sheets, so the import-matching logic is testable at scale without a real network call). **No test can send real mail or reach a live Stripe account** — the sink intercepts before the SES client, the AWS credentials handed to the child are dummies, and the Stripe key is blanked so `stripe` stays `null`.

Run the suite before deploying. It covers auth, the capability model route by route, seat holds and ticket priority, the waitlist, scan links and the door display, the exact endpoint set the iOS app uses, the apiKey integration routes, email content, the audit log, and the service-worker contract.

## Architecture overview

### Backend (`server.js` + `db-sqlite.js`)

- **Single-file Express server** (`server.js`, ~2100+ lines). All routes live here.
- **Database**: `better-sqlite3` (SQLite WAL mode). Schema and all prepared statements are in `db-sqlite.js`. Always use the exported `stmt.*` prepared statements — never write ad-hoc queries in `server.js`. Row converters (`rowToTicket`, `rowToEvent`, `rowToUser`) parse JSON columns (location, customFields) before returning objects.
- **Admin**: Admin privileges are determined purely by `user.email === process.env.ADMIN_EMAIL` — there is no role column in the database. The admin has authority over every event, but **does not have every event listed as theirs**: `/api/events`, `/api/events/counts`, `/api/my-rooms` and the monitor routes are all scoped through `personalEventIdsForUser()` (owned + shared + scan-link), same as any other user. Everyone else's rooms live behind the admin-only `GET /api/admin/all-rooms`, which returns every room grouped by owner plus the full user list. The dashboard reaches those rooms with `openRoomAsAdmin()` → `GET /api/event/:id/context`.
- **Scan-link sessions (no-login door staff)**: resolving a scan link via `GET /api/scanner-links/:token` puts `req.session.scanLink = {token, eventId}` on the session — a scoped identity with no user account, granting `SCAN_LINK_CAPABILITIES` (`checkin`, `undo_checkin`) on that one event. Authorize these routes with `requestHasCapability(req, eventId, cap)` / `requestEventCapabilities(req, eventId)` and gate them with `requireAuthOrScanLink`, **not** `userHasEventCapability` (which only knows about `req.session.userId`). `sessionScanLink()` re-validates the link on every use, so revoking it or deleting the event takes effect immediately. `/api/auth/me` returns `{user: null, scanLink: {...}}` for these callers, which is how scanner.html resumes link mode with no token in the URL and how checkin.html knows not to bounce. `POST /api/scan-link/exit` drops the grant.
- **Service worker**: `public/sw.js` serves documents **network-first** (3.5s timeout, cache fallback) and everything else **stale-while-revalidate**. A connected device always renders current HTML; an offline one falls back to the `PRECACHE` copy so the door still works. **You do not need to bump `CACHE` to ship a change** — it only discards an old cache's shape, so bump it only if the caching layout itself changes. `public/sw-register.js` (included by scanner/checkin/index) handles registration, checks for updates every 15 min and on foreground, promotes a waiting worker, and reloads the page once a new worker claims it. A page can set `window.__swHoldReload = true` to defer that reload while something is on screen (scanner.html does this around scan results). **`?fresh=1`** is carried by every generated link — the `/scan/:token` redirect appends it (so links already printed on a QR code get it too, while the copyable URL stays clean) and display URLs include it. It is *conditional*: the page pings the active worker for its version, and only purges when nothing answers, which is how it tells a legacy cache-first worker (no message handler, can never reply) from a current one. On a current worker it strips the param and carries on, touching nothing — purging unconditionally would throw away the offline copy the door depends on at the worst possible moment. `scanToken` survives the purge-and-reload.
- **Who can open the dashboard**: `/dashboard.html` is served to anyone signed in, including an account with zero rooms — creating an event only requires `requireAuth` (`POST /api/events`), so a brand-new account needs the dashboard's empty state and "+ New" button to create its first one, same as the admin can with none of their own. (It used to redirect a roomless non-admin account to `/` instead, on the reasoning that they had "nothing to see" — that stranded new signups with no way to ever reach "+ New", and made `/login.html` bounce a signed-in roomless visitor back to `/` on every visit, which looked like an infinite loop from "Organizer Login".) Admin-only panels inside the dashboard (server logs, admin overview) are hidden on `currentUser.isAdmin` and enforced by `requireAdmin` server-side, so opening the page up doesn't expose them. `requireAdmin` is a hoisted `function`, not a `const` — routes registered earlier in the file reference it.
- **Transferring ownership**: `POST /api/event/:id/transfer-ownership` (`userOwnsEvent` only). Sets `events.userId`, drops the new owner's now-redundant share row, and leaves the outgoing owner a full-capability grant so they aren't locked out of their own event. Deleting an event tears down its `sheetLinks`/`sheetAccess` via `deleteEventSharing()` — without it, grants outlive the event and count toward `hasRooms`.
- **Permissions**: Access to an event is a list of capabilities, defined once in `CAPABILITIES` in `server.js` (`checkin`, `undo_checkin`, `manage_tickets`, `email_attendees`, `manage_event`, `manage_waitlist`, `manage_discounts`, `manage_payments`, `export_data`, `manage_access`, `delete_event`). Always authorize with `userHasEventCapability(userId, eventId, cap)` — never re-derive owner/admin checks inline. `sheetAccess.capabilities` holds the JSON array; rows predating it have `NULL` there and fall back to the old `permission` role via `capabilitiesForAccessRow()` (`'full'` → everything, `'view'` → `['checkin']`), so old grants keep working untouched. `manage_access` may only be **granted** by a real owner (or the admin) — `userOwnsEvent()` — so a collaborator who holds it cannot mint more people like themselves, and nobody may edit their own grant.
- **Sessions**: `express-session` + `session-file-store` (files in `sessions/`). Cookies are the only auth mechanism; no JWT.
- **Email**: AWS SES via `@aws-sdk/client-ses`. All sends go through the serialised `emailChain` queue in `server.js` to respect the SES rate limit (`SES_MIN_INTERVAL_MS`). Never call `ses.send()` directly — use `sendEmail()`.
- **Apple Wallet**: `passkit-generator` with certs in `certs/` (never committed). Pass template is `pass-assets.pass/`. Generated `.pkpass` files are cached in `pass-cache/`.
- **Audit log**: `auditLog` table (persistent — separate from the in-memory `logBuffer` ring buffer, which is lost on restart). Written via `logAudit(req, { eventId, action, details })`, called from consequential admin actions (event/registration CRUD, check-in/undo, bulk email, access sharing, refunds, discount codes, waitlist). `GET /api/event/:id/audit-log` (view access) and `GET /api/admin/audit-log` (admin only), both paginated.
- **Discount codes**: `discountCodes` table, percent or fixed-amount, per-event, optional `maxUses`/`expiresAt`. Applied in `POST /api/checkout/:eventId` via `discountCode` in the body; validated with `validateDiscountCode()`. A 100%-off code issues the ticket directly (bypasses Stripe — Checkout doesn't support $0 payment-mode sessions). `usedCount` only increments on confirmed payment (webhook), not at checkout creation, so abandoned carts don't burn a redemption.
- **Waitlist**: `waitlist` table + `events.waitlistEnabled`. Registering (free `/api/register` or paid `/api/checkout/:eventId`) for a full event with the waitlist enabled returns `{waitlisted: true}` instead of erroring. `POST /api/waitlist/:id/promote` issues a free ticket directly for free events, or emails a claim link for paid events (money still only changes hands through Stripe).
- **Payments (Beta)**: paid ticketing is a **testing-only** feature — an organiser can set a price with no Stripe account behind it, so the ticket-price field, the free→paid confirmation and the Payments panel all say it is beta and point at support@willstechsupport.com, and the `!stripe` refusals on checkout/refund say the same rather than "Stripe not configured". `POST /api/register` refuses a paid event outright (it is the free-ticket path; without that guard, posting to it hands out a paid event's tickets for nothing). `GET /api/event/:id/orders` lists orders; `POST /api/orders/:id/refund` issues a real Stripe refund and updates the order. Requires `orders.paymentIntentId`, which is set when the webhook fulfills a session — a 100%-discount order has none (nothing was ever charged) and can't be refunded through this route. The webhook also listens for `charge.refunded` so refunds issued directly from the Stripe dashboard stay in sync.

### Public HTTP API (`/api/v1`)

Documented at `public/api.html`, served at `/api.html` — that page is the contract, and `test/pages.test.js` fails if a `/api/v1` route exists without appearing in it.

- **Keys are per-event.** `apiKeys` rows bind one key to one event; no request names an event, the key decides. A leaked key is a leak of exactly one event. Only `sha256(secret)` is stored — the key is shown once at creation and is unrecoverable.
- **Scopes are the existing capabilities**, not a parallel system. `effectiveApiScopes()` intersects what the key was granted with `userEventCapabilities(key.userId, key.eventId)` **on every request**, so a key narrows when its creator's access narrows and dies when they lose the event. `POST /api/event/:id/api-keys` also refuses to grant a scope the creator doesn't hold, so nobody can mint authority they don't have. `manage_access` can never be given to a key.
- Auth is `Authorization: Bearer wts_…` (or `X-API-Key`), via `apiAuth`; routes are declared `...apiRoute('scope')`, which bundles auth + a per-key rate limit (300/min, keyed on the key id) + the scope check.
- Every write goes through the same helpers as the dashboard (`eventSeatUsage`, `joinWaitlist`), so the API cannot oversell or take a held seat, and lands in the same audit log attributed as `api-key:<name>`.
- Deleting an event deletes its keys.

### Real-time / SSE

Three in-memory maps manage live connections — these are lost on server restart:

| Variable | Purpose |
|---|---|
| `monitorClients` | Set of browser sessions subscribed to `/api/monitor/stream` (dashboard + monitor pages) |
| `scannerChannels` | `Map<pairToken, Response>` for web scanner SSE at `/api/scan/stream/:pairToken` |
| `scannerRegistry` | `Map<pairToken, scannerState>` — current state of every known scanner |

Key functions:
- `broadcastToMonitors(eventId, payload)` — fans a JSON event out to all `monitorClients` watching that event
- `upsertScanner(pairToken, patch)` — merges state into `scannerRegistry` and calls `broadcastToMonitors` with a `scanner_update` event
- `recordScan(pairToken, ...)` — called from `/api/validate` on every scan result; calls `upsertScanner` and `broadcastToMonitors` with a `ticket_scan` event

**Cloudflare/SSE requirement**: SSE responses must include `X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`, and an initial 2 KB padding chunk (`res.write(': ' + ' '.repeat(2048) + '\n\n')`) to force Cloudflare's edge to flush immediately. The `compression()` middleware is filtered to skip stream paths — do not remove that filter.

### Frontend (`public/`)

Plain HTML + vanilla JS, no framework, no bundler. Each page is self-contained:

- `dashboard.html` — event management for logged-in owners/admin (create events, manage tickets, metrics)
- `monitor.html` — live scanner monitor (SSE consumer, admin/owner only)
- `scanner.html` — installable web PWA scanner (SSE producer + consumer)
- `register.html` — public registration form
- `display.html` — browser-based door display (SSE consumer, opened via QR code)
- `checkin.html` — manual attendee check-in list
- `settings.html` — event settings page (custom fields, access sharing, notifications)
- `giveaway.html` — prize-draw controller (spinner styles, live entries, winner emails)
- `giveaway-display.html` — audience-facing giveaway screen, paired over SSE
- `giveaway-pot.js` — the Paper Pot animation, shared by both giveaway pages
- `help-content.js` — content for the dashboard's inline "?" help icons (`window.HELP_CONTENT`, one entry per settings field/block type/system concept, rendered via `helpIcon()`/`showHelp()` in dashboard.html). **Whenever a dashboard setting, field, or system behavior changes or is added, update the matching entry here (or add one) in the same commit** — this is the one place that documentation lives, and it drifting out of sync with the code defeats the point of it.

### iOS app (`Ticket Check In/`)

SwiftUI app, **minimum deployment target iOS 15.6** (supports iPhone 8). No external Swift packages.

**Always keep `#available(iOS 16, *)` and `#available(iOS 17, *)` guards and legacy `NavigationView` fallbacks** throughout the app — dropping them breaks iOS 15 compatibility.

Key files:
- `APIService.swift` — all server API calls; `@MainActor` singleton; uses `URLSession.shared` (session cookies persist automatically); keychain stores email/password for auto-login
- `Item.swift` — all model types (`Event`, `Ticket`, `AuthUser`, `ValidateResponse`, etc.)
- `ContentView.swift` — root tab bar: Scanner (0) / Events (1) / Settings (2)
- `EventsView.swift` — `EventsView` auth gate → `EventsListView` → `AttendeesView`; also contains `LoginView`, `AttendeeGroupRow`, `TicketPickerSheet`, `NotificationSettingsSheet`
- `ScannerView.swift` — camera QR scanning, BLE display pairing, checkout flow
- `DisplayView.swift` — fullscreen door display mode, SSE-based or BLE-based
- `BluetoothManager.swift` — CoreBluetooth scanner↔display pairing (no internet required)
- `NotificationManager.swift` — APNs device token handling and sync

`baseURL` in `APIService.swift` must match the server's `BASE_URL`.

## Environment variables

```
PORT=3002
BASE_URL=https://your-domain.com
SESSION_SECRET=...
ADMIN_EMAIL=...           # single admin; determines elevated access everywhere
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
SES_FROM=noreply@...
SES_MIN_INTERVAL_MS=100   # email throttle (default 100ms)
```

## Files never committed

`.env`, `sessions/`, `certs/`, `public/uploads/`, `*.pkpass`, `tickets.db*`, `db.json`

- **Capacity & seat holds**: capacity was only checked at submit, so ten people could fill in the form for four spots and six were told "sold out" after typing everything in — and on a paid event all ten could reach Stripe and pay, because the webhook issued tickets with no capacity check at all. `seatHolds` fixes both: opening the public form claims a short-lived hold (`POST /api/event/:id/hold`, 8 min, refreshed every 90s by the page; 25 min once bound to a Stripe session). `eventSeatUsage()` is the single source of truth — **issued tickets + live holds + unclaimed waitlist offers** — and every capacity decision must go through it, not a bare ticket count. `consumeHoldOrCheckRoom()` turns a hold into a seat at registration and still falls back to a plain capacity test, so a direct API call can't oversell. The hold endpoint returns `granted` (did *you* get a seat), deliberately **not** `held`, which is the number of seats other people are holding. `GET /api/event/:id/availability` is the public live counter the registration page polls.
- **Registration themes**: `REGISTRATION_THEMES` in `server.js` is the only definition — the dashboard picker and `register.html` both read it, so they can't drift. A theme with `useEventColor` defers to the event's own colour. The event image doubles as the registration banner. Set via `PUT /api/event/:id/theme` (`manage_event`).
- **Holds must be respected by every path that issues a ticket.** A hold is only worth something if nothing else can quietly take the seat — the manual add, sheet/CSV import and at-door routes all go through `eventSeatUsage()` for exactly this reason. If a new ticket-creating path counts `stmt.tickets.countByEventId` directly it will eat a held seat and oversell the event. `consumeHoldOrCheckRoom()` also refuses a *valid* hold when `issued >= capacity` (returning `filledUnderHold`), because a promise can't be honoured past the point where honouring it oversells. `GET /api/event/:id/availability?holdToken=…` answers from the caller's point of view — their own seat isn't counted against them, and `holdStillValid` tells the page when its hold has been overtaken.
- **Signup limits**: `allowMultipleRegistrations` (shows "Register Another Person"), `blockDuplicateEmails` (one ticket per email, case-insensitive), `oneRegistrationPerDevice` (a `wtsreg_<eventId>` cookie — a deterrent, not a lock; cookies clear, private windows exist). All three are enforced in one place, `signupBlockReason()`, called from the hold endpoint (so the visitor is turned away *before* filling anything in), `/api/register` and `/api/checkout/:eventId`. Defaults preserve the old behaviour. A waitlist claim link bypasses them — that seat was already promised.
- **Scanning is authorized per event, not per account.** `scannerAuthorized()` used to treat *any* signed-in session as proof for *every* event, so a stranger with an account could check in (or check out) someone else's attendee. A session now only counts when it carries `checkin` on that specific event; scan-link tokens and display tokens still work as before, scoped to their own event.
- **Clearing a venue clears it.** `PUT /api/event/:id` used to fall back to the stored location when a location field arrived empty, so a venue typed in by mistake could only ever be replaced, never removed — and it kept printing on every ticket. An empty field that was actually sent now means "clear this", the same way `time`/`endTime` treat it.
- **The sheet integration's key decides the event, not the reverse.** `requireSheetApiKey()` looks a link up *by the key presented* and then checks it belongs to that event. It used to find the first link naming the event and compare keys — and `POST /api/sheet/generate-link` had no authorization at all while accepting an `eventId`, so anyone holding a public registration link (event ids are in every one) could mint a working key for that event and then issue tickets and rewrite it. Binding a link to an event now needs `manage_event` on it, by session or by an existing key.
- **The sheet watcher only ever fetches Google.** `sheetCsvUrl()`/`fetchSheetRows()` are given a URL by a caller and fetch it server-side, and the preview endpoint hands the body straight back — an unrestricted URL there is SSRF with full response disclosure, reachable by any signed-up account. `SHEET_ALLOWED_HOSTS` gates the input URL and the post-redirect URL.
- **The scanner PIN is not public.** `GET /api/event/:id` is read by the registration page with no session, so it strips `scannerPin` unless the caller actually has access to the event. Callers who need it get it from the authenticated `/api/events`.
- **Confirmation emails are a per-source policy, not one switch.** `events.emailPolicy` (JSON) holds a boolean per source — `public` (the registration link, the kiosk, and the paid checkout receipt), `door` (staff at-door sales), `import` (sheet watcher, CSV, API) and `manual` (dashboard add/edit) — set via `PUT /api/event/:id/email-policy` and read through `shouldSendConfirmation(source, explicitFlag, event)`. It replaced `skipConfirmationEmails`, a single boolean that only ever governed staff-issued tickets: an organiser running a giveaway could silence their own imports but had **no way at all** to stop the public form emailing every entrant. A per-request `explicitFlag` (the sheet watcher's own setting, an import's "don't email" box) still wins over the policy; a `null` source means the send isn't policy-governed at all, which is how waitlist claim links, password resets and the operator's own Resend/Direct/Bulk email actions stay unaffected — switching those off would break what they exist for rather than just quieten them. `emailPolicy` being NULL means "never configured", and `eventEmailPolicy()` then reproduces the old flag's behaviour exactly, so no existing event changed what it does. The legacy column is still written in sync, and `PUT /api/event/:id/skip-confirmation-emails` still works, because a dashboard cached in someone's browser may still call it.
- **The giveaway's Paper Pot lives in one file, not two.** `giveaway.html` and `giveaway-display.html` each carry their own hand-kept copy of the reel and wheel physics, with "must match giveaway.html exactly" comments on every shared function — every change there has to be made twice or the operator's screen and the room's screen visibly disagree. The pot avoids that: `public/giveaway-pot.js` is one module both pages instantiate (`GiveawayPot.create(canvas, {accent, onEvent})`), driven by the same numbers over the existing SSE channel. It draws to a single canvas because a few hundred simultaneously tumbling DOM nodes is not something a projector-driving laptop keeps at 60fps. Its frame loop is generation-guarded (`loopGen`) and restarts on `visibilitychange`: a browser suspends `requestAnimationFrame` entirely in a background tab, so a loop that was mid-flight when the operator switched away never schedules its next frame, and without the restart the pot would stay frozen forever once they came back.
- **Live entries**: the giveaway pool used to be a snapshot taken when the page loaded — fine for a closed guest list, useless for a room filling in a Google Form while you watch. `giveaway.html` polls `GET /api/event/:id/giveaway/entrants` (a deliberately small one-row-per-registration feed — `/tickets` returns QR tokens, custom fields and scan history, far too much to re-fetch every few seconds with several hundred attendees) and hands the new names to the pot. Arrivals that land mid-spin are held in `arrivalsDuringSpin` and flushed when the spinner settles, so the pool can never move under a draw in progress. The pot paces its own queue — release gap, slips in flight and fall speed all scale with the backlog — so three arrivals read as three slips and a hundred read as paper pouring in, rather than a hundred appearing at once or a ten-minute single-file queue.
- **Boost sync**: `sheetWatchers.boostUntil`/`boostSeconds` (`POST /api/event/:id/sheet-watch/boost`, `minutes: 0` to stop) put a watcher on a few-seconds poll for a bounded window, for the minutes when a whole room is submitting the form at once — a 2-minute interval there means a hundred names land in one lump and then nothing. `boostUntil` is an absolute time so it expires on its own (a forgotten boost can't keep hammering Google, and a restart neither loses nor extends it), and `BOOST_MIN_SECONDS`/`BOOST_MAX_MINUTES` bound it. The scheduler ticks every second and asks `watcherPollDueMs()` per watcher. Speeding up only the page's own poll would be pointless — it would just poll faster for rows the server hasn't fetched yet — so the giveaway page's Boost button turns up both rates together.
- **Ticket priority**: issued tickets > waitlist claim offers > active seat holds > everyone else, *including staff*. A held spot outranks a manual add, a sheet/CSV import, an at-door sale and another visitor — all of them get refused rather than taking it. The only thing that can still take a held spot is the organiser lowering capacity below issued+held, which is allowed (it's their event) but returns `capacityWarning` on `PUT /api/event/:id` so the dashboard can say how many in-progress signups it strands. A Stripe payment that lands with no hold behind it is also seated rather than refused — the money is already taken — and logged as `capacity.exceeded`.
