# WTS Tickets

A full-stack ticket registration and check-in system built for live events. Handles everything from registration and Apple Wallet passes to real-time scanning, door displays, and a live scanner monitor.

## Features

### Registration & Ticketing
- Per-attendee QR ticket generation with unique signed tokens
- Multi-ticket registrations (general admission, VIP, etc.)
- Apple Wallet pass integration (`.pkpass`)
- Bulk registration import and re-send
- Custom fields per event
- Capacity limits with automatic enforcement
- Email delivery via AWS SES

### Scanning & Check-In
- **iOS native app** — camera-based QR scanner with instant audio/haptic feedback and fullscreen color flash
- **Web scanner PWA** — installable on any device, works in Safari/Chrome with the same UX
- Manual check-in list with per-ticket and bulk check-in
- Re-entry tracking (check-out / check back in flow)
- Offline-tolerant: scanner works without login for read-only validation

### Door Display
Connect a second screen at the door that shows every scan result in large text.

| Mode | How it works |
|------|-------------|
| **Bluetooth (iOS)** | Scanner phone sends results to display phone over BLE — no internet required |
| **Internet / SSE** | Scanner shows a QR code; display device opens it in a browser or iOS app and connects via Server-Sent Events |

**Connecting a display:**
1. Open the **Display tab** in the web scanner (or gear → Display Setup in the iOS app)
2. The QR code shown can be scanned by:
   - Any phone's camera app → opens `display.html` in the browser automatically
   - The iOS Tickets app main scanner → launches fullscreen display mode directly
3. Rotate the display link at any time to invalidate old connections

### Live Scanner Monitor
Admin dashboard at `/monitor.html` showing every active scanner in real time:
- Online/offline status (SSE heartbeat — appears the moment a scanner opens)
- Platform badge (iOS app vs. web), device name, OS version, IP address
- Last scan result per scanner
- Per-scanner and mass notification (browser Notification API on web; in-app alert on iOS)
- Event-level access control: admins see all, event owners see their own

### Auth & Accounts
- Email/password accounts with **email verification** on signup
- Password reset via email
- Session-based auth with keychain persistence on iOS
- Admin account (`ADMIN_EMAIL`) has elevated access; set up once via `/api/auth/setup-admin`

### Push Notifications
- iOS: APNs push (requires Apple Push certificate)
- Web: `Notification` API (browser permission prompt on first open)
- Admin can notify all scanners for an event from the monitor dashboard

## Tech Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js, Express |
| Database | LowDB (JSON file) |
| Email | AWS SES |
| Sessions | express-session + session-file-store |
| QR | `qrcode` |
| Passes | `passkit-generator` |
| Images | `sharp` |
| iOS app | Swift, SwiftUI, CoreBluetooth, AVFoundation |

## Setup

### Prerequisites
- Node.js 18+
- AWS account with SES access
- (Optional) Apple Developer account for Wallet passes and APNs

### Environment Variables

Create a `.env` file:

```env
PORT=3002
BASE_URL=https://your-domain.com

# AWS SES
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
SES_FROM=noreply@your-domain.com

# Auth
SESSION_SECRET=a-long-random-string
ADMIN_EMAIL=you@example.com

# Optional
SES_MIN_INTERVAL_MS=100   # throttle between emails (default: 100ms)
```

### Install & Run

```bash
npm install
npm start
```

App is available at `http://localhost:3002` (or `BASE_URL` in production).

### First-Time Admin Setup

Navigate to `/login.html` and create the admin account:

```bash
curl -X POST https://your-domain.com/api/auth/setup-admin \
  -H "Content-Type: application/json" \
  -d '{"password":"your-password"}'
```

Or use the setup form if one is available. The admin email is set by `ADMIN_EMAIL` in `.env`.

### Apple Wallet Certificates

Place certs in `certs/` (never commit these):

```
certs/wwdr.pem
certs/signer.pem
certs/signer.key
```

## Files Not Committed

```
.env
db.json
sessions/
certs/
public/uploads/
*.pkpass
```

## iOS App

The Xcode project is in `Ticket Check In/`. Requires:
- iOS 15.6+
- Xcode 15+
- No external Swift packages (uses only system frameworks)

Set `baseURL` in `APIService.swift` to your server's `BASE_URL`.

Background modes required in Info.plist: `bluetooth-central`, `bluetooth-peripheral`.
