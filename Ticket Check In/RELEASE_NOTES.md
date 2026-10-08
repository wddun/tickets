# WTS Tickets iOS release notes

Newest first. The "What's New" block under each version is the App Store / TestFlight
text, ready to paste. The "Details" list is for us.

## 1.12.0 (build 3), 2026-10-08

### What's New

- Scan links open in the app. Tap a scan link an organizer sends you and it opens
  straight into the scanner, set to that event, with no account needed. If the app
  isn't installed, the same link opens the web scanner instead.
- Offline backup. When an organizer turns it on, the scanner keeps a copy of the
  guest list and keeps checking people in if the connection drops. Those check-ins
  sync automatically when you're back online.
- Losing signal no longer signs you out or locks the scanner.
- Fixed an issue where switching events could quietly switch back, making valid
  tickets show "not valid for this event".
- Open Web Dashboard now opens the event you're working on.
- Two-factor codes autofill from Passwords and other password managers.

### Details

- Universal Links for `https://tickets.willstechsupport.com/scan/*` (server serves
  `/.well-known/apple-app-site-association`), plus a `wtstickets://scan/<token>`
  URL scheme. Handled in `ContentView.openScanLink`. Needs the Associated Domains
  capability on the App ID.
- `OfflineBackupStore`: snapshot from `POST /api/event/:id/offline-snapshot`, queue
  replayed through `POST /api/event/:id/offline-sync`. `verifyEventAccess()` treats
  a `URLError` as unreachable, not signed out.
- `verifyEventAccess()` / `ManualCheckInView.verifyAccess` only apply their result
  if the selected event is unchanged. The SSE listener and heartbeat restart on an
  event switch.
- `DashboardWebSheet` opens `dashboard.html?event=<id>`.
- 2FA code field uses `.textContentType(.oneTimeCode)`.
- Removed the unused email-opens stat.

## 1.11.9 (build 2), 2026-09-24

- Bluetooth usage description string.
