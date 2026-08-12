# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## House style

- **No emojis in code, UI text, comments, commit messages, or files unless the user explicitly asks or there's no alternative that fits.** Prefer inline SVG icons (the codebase already uses them widely — see scanner.html, checkin.html, dashboard.html) or plain text labels. When editing existing UI that already contains emojis, do not add more — leave the existing ones in place unless asked to clean them up.

## Running the server

```bash
npm start          # production
npm run dev        # development (auto-restarts on file change via --watch)
pm2 restart ticketcheckin   # restart in production (PM2 manages the process)
pm2 logs ticketcheckin      # tail logs
```

No build step. The server is a single `server.js` file; `public/` is served as static files with no bundler.

## Architecture overview

### Backend (`server.js` + `db-sqlite.js`)

- **Single-file Express server** (`server.js`, ~2100+ lines). All routes live here.
- **Database**: `better-sqlite3` (SQLite WAL mode). Schema and all prepared statements are in `db-sqlite.js`. Always use the exported `stmt.*` prepared statements — never write ad-hoc queries in `server.js`. Row converters (`rowToTicket`, `rowToEvent`, `rowToUser`) parse JSON columns (location, customFields) before returning objects.
- **Admin**: Admin privileges are determined purely by `user.email === process.env.ADMIN_EMAIL` — there is no role column in the database. The admin has authority over every event, but **does not have every event listed as theirs**: `/api/events`, `/api/events/counts`, `/api/my-rooms` and the monitor routes are all scoped through `personalEventIdsForUser()` (owned + shared + scan-link), same as any other user. Everyone else's rooms live behind the admin-only `GET /api/admin/all-rooms`, which returns every room grouped by owner plus the full user list. The dashboard reaches those rooms with `openRoomAsAdmin()` → `GET /api/event/:id/context`.
- **Scan-link sessions (no-login door staff)**: resolving a scan link via `GET /api/scanner-links/:token` puts `req.session.scanLink = {token, eventId}` on the session — a scoped identity with no user account, granting `SCAN_LINK_CAPABILITIES` (`checkin`, `undo_checkin`) on that one event. Authorize these routes with `requestHasCapability(req, eventId, cap)` / `requestEventCapabilities(req, eventId)` and gate them with `requireAuthOrScanLink`, **not** `userHasEventCapability` (which only knows about `req.session.userId`). `sessionScanLink()` re-validates the link on every use, so revoking it or deleting the event takes effect immediately. `/api/auth/me` returns `{user: null, scanLink: {...}}` for these callers, which is how scanner.html resumes link mode with no token in the URL and how checkin.html knows not to bounce. `POST /api/scan-link/exit` drops the grant.
- **Service worker**: `public/sw.js` serves documents **network-first** (3.5s timeout, cache fallback) and everything else **stale-while-revalidate**. A connected device always renders current HTML; an offline one falls back to the `PRECACHE` copy so the door still works. **You do not need to bump `CACHE` to ship a change** — it only discards an old cache's shape, so bump it only if the caching layout itself changes. `public/sw-register.js` (included by scanner/checkin/index) handles registration, checks for updates every 15 min and on foreground, promotes a waiting worker, and reloads the page once a new worker claims it. A page can set `window.__swHoldReload = true` to defer that reload while something is on screen (scanner.html does this around scan results). **`?fresh=1`** is carried by every generated link — the `/scan/:token` redirect appends it (so links already printed on a QR code get it too, while the copyable URL stays clean) and display URLs include it. It is *conditional*: the page pings the active worker for its version, and only purges when nothing answers, which is how it tells a legacy cache-first worker (no message handler, can never reply) from a current one. On a current worker it strips the param and carries on, touching nothing — purging unconditionally would throw away the offline copy the door depends on at the worst possible moment. `scanToken` survives the purge-and-reload.
- **Who can open the dashboard**: `/dashboard.html` is served to the admin, or to anyone whose `personalEventIdsForUser()` is non-empty (owner, collaborator, or scan-link) — everyone else is redirected to `/`. `GET /api/auth/me` returns `hasRooms` for the login page to make the same call. Admin-only panels inside the dashboard (server logs, admin overview) are hidden on `currentUser.isAdmin` and enforced by `requireAdmin` server-side, so opening the page up doesn't expose them. `requireAdmin` is a hoisted `function`, not a `const` — routes registered earlier in the file reference it.
- **Transferring ownership**: `POST /api/event/:id/transfer-ownership` (`userOwnsEvent` only). Sets `events.userId`, drops the new owner's now-redundant share row, and leaves the outgoing owner a full-capability grant so they aren't locked out of their own event. Deleting an event tears down its `sheetLinks`/`sheetAccess` via `deleteEventSharing()` — without it, grants outlive the event and count toward `hasRooms`.
- **Permissions**: Access to an event is a list of capabilities, defined once in `CAPABILITIES` in `server.js` (`checkin`, `undo_checkin`, `manage_tickets`, `email_attendees`, `manage_event`, `manage_waitlist`, `manage_discounts`, `manage_payments`, `export_data`, `manage_access`, `delete_event`). Always authorize with `userHasEventCapability(userId, eventId, cap)` — never re-derive owner/admin checks inline. `sheetAccess.capabilities` holds the JSON array; rows predating it have `NULL` there and fall back to the old `permission` role via `capabilitiesForAccessRow()` (`'full'` → everything, `'view'` → `['checkin']`), so old grants keep working untouched. `manage_access` may only be **granted** by a real owner (or the admin) — `userOwnsEvent()` — so a collaborator who holds it cannot mint more people like themselves, and nobody may edit their own grant.
- **Sessions**: `express-session` + `session-file-store` (files in `sessions/`). Cookies are the only auth mechanism; no JWT.
- **Email**: AWS SES via `@aws-sdk/client-ses`. All sends go through the serialised `emailChain` queue in `server.js` to respect the SES rate limit (`SES_MIN_INTERVAL_MS`). Never call `ses.send()` directly — use `sendEmail()`.
- **Apple Wallet**: `passkit-generator` with certs in `certs/` (never committed). Pass template is `pass-assets.pass/`. Generated `.pkpass` files are cached in `pass-cache/`.
- **Audit log**: `auditLog` table (persistent — separate from the in-memory `logBuffer` ring buffer, which is lost on restart). Written via `logAudit(req, { eventId, action, details })`, called from consequential admin actions (event/registration CRUD, check-in/undo, bulk email, access sharing, refunds, discount codes, waitlist). `GET /api/event/:id/audit-log` (view access) and `GET /api/admin/audit-log` (admin only), both paginated.
- **Discount codes**: `discountCodes` table, percent or fixed-amount, per-event, optional `maxUses`/`expiresAt`. Applied in `POST /api/checkout/:eventId` via `discountCode` in the body; validated with `validateDiscountCode()`. A 100%-off code issues the ticket directly (bypasses Stripe — Checkout doesn't support $0 payment-mode sessions). `usedCount` only increments on confirmed payment (webhook), not at checkout creation, so abandoned carts don't burn a redemption.
- **Waitlist**: `waitlist` table + `events.waitlistEnabled`. Registering (free `/api/register` or paid `/api/checkout/:eventId`) for a full event with the waitlist enabled returns `{waitlisted: true}` instead of erroring. `POST /api/waitlist/:id/promote` issues a free ticket directly for free events, or emails a claim link for paid events (money still only changes hands through Stripe).
- **Payments (Beta)**: `GET /api/event/:id/orders` lists orders; `POST /api/orders/:id/refund` issues a real Stripe refund and updates the order. Requires `orders.paymentIntentId`, which is set when the webhook fulfills a session — a 100%-discount order has none (nothing was ever charged) and can't be refunded through this route. The webhook also listens for `charge.refunded` so refunds issued directly from the Stripe dashboard stay in sync.

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
