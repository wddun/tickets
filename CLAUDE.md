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
- **Admin**: Admin privileges are determined purely by `user.email === process.env.ADMIN_EMAIL` — there is no role column in the database.
- **Sessions**: `express-session` + `session-file-store` (files in `sessions/`). Cookies are the only auth mechanism; no JWT.
- **Email**: AWS SES via `@aws-sdk/client-ses`. All sends go through the serialised `emailChain` queue in `server.js` to respect the SES rate limit (`SES_MIN_INTERVAL_MS`). Never call `ses.send()` directly — use `sendEmail()`.
- **Apple Wallet**: `passkit-generator` with certs in `certs/` (never committed). Pass template is `pass-assets.pass/`. Generated `.pkpass` files are cached in `pass-cache/`.

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
