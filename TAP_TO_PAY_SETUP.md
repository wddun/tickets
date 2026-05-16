# Tap to Pay on iPhone — Setup Checklist

The code is in place. Three one-time setup tasks on your end before the in-app at-door flow will work end-to-end.

---

## 1. Apple — request the Tap to Pay on iPhone entitlement

The app's entitlements file already declares `com.apple.developer.proximity-reader.payment.acceptance`, but Apple has to enable it for your team before Xcode can sign with it.

1. Sign in at developer.apple.com → **Account** → **Membership**.
2. Open **Contact Us** → **Development and Technical** → **App Capabilities and Entitlements** → request **"Tap to Pay on iPhone"** for team `G39XK56M64`, bundle id `com.willstechsupport.wtstickets`.
3. Wait for the approval email (usually 1–3 business days). After approval, the entitlement appears under your App ID in the developer portal — Xcode picks it up automatically on the next build.

Until that approval lands, the SDK call will surface an `Error: Entitlement missing` message in the app — the build still succeeds.

## 2. Stripe — enable Terminal & verify webhook events

1. Stripe Dashboard → **Settings** → **Payments** → **Terminal**. Click **Get started** if you haven't already. (Free, no Terminal hardware needed for Tap to Pay on iPhone.)
2. Stripe Dashboard → **Developers** → **Webhooks** → click your existing endpoint → **Add events**. Make sure these are subscribed (the second one is new):
   - `checkout.session.completed`
   - `payment_intent.succeeded`
3. Do this in **both** test mode and live mode webhooks. The signing secrets stay the same.

The server already handles `payment_intent.succeeded` with `source=terminal` metadata, so once it's subscribed, every at-door sale will fire that event and the webhook will issue the ticket idempotently.

## 3. Xcode — add the Stripe Terminal Swift package

The Swift code already conditionally imports `StripeTerminal`. Adding the package "lights it up."

1. Open `Ticket Check In.xcodeproj` in Xcode.
2. **File → Add Package Dependencies…**
3. Paste: `https://github.com/stripe/stripe-terminal-ios`
4. **Dependency Rule:** Up to Next Major from `4.0.0` (whatever the latest 4.x is).
5. **Add Package**, then check **StripeTerminal** for the **Ticket Check In** target. Click **Add Package**.
6. Build & run on a physical iPhone (Tap to Pay does not work on the simulator). The first time you tap a card, iOS prompts the user to accept the Apple terms — that's expected.

## 4. (Already done) Files added / modified for you

Server:
- `db-sqlite.js` — `atDoorEnabled`, `paymentIntentId`, `channel` columns + new statements
- `server.js` — `issueTicketForPayment` helper, Terminal endpoints (`/api/terminal/...`), at-door toggle endpoint, webhook now also fulfills `payment_intent.succeeded`

Dashboard:
- `public/dashboard.html` — new "Enable At-Door Ticket Sales" toggle in event settings

iOS (auto-picked up by the synchronized file group):
- `Item.swift` — `Event.atDoorEnabled`, `Event.ticketPrice`
- `APIService.swift` — new Terminal API methods
- `TerminalService.swift` — Stripe Terminal SDK wrapper (Tap to Pay)
- `AtDoorView.swift` — at-door tab UI
- `EventsView.swift` — segmented picker in `AttendeesView` when at-door enabled
- `Ticket-Check-In-Info.plist` — `NSLocationWhenInUseUsageDescription`
- `Ticket Check In.entitlements` — `com.apple.developer.proximity-reader.payment.acceptance`

## 5. How to use it

For each event:

1. Open the **Dashboard** in a browser → open the event's settings → toggle **Enable At-Door Ticket Sales**.
2. In the iOS app, open that event in the Events tab. A new **At Door** segmented control appears next to **Attendees**.
3. Tap **At Door**, enter the buyer's name (and email if they want it), tap the big button.
4. Paid events: iPhone will show the Tap to Pay prompt — buyer taps card/phone on the back of the iPhone.
5. Ticket emails automatically. The buyer also shows up under **Attendees** for check-in.

---

# Kiosk Mode — implementation plan (deferred)

You asked about unattended-iPad kiosk mode. Apple does **not** allow Tap to Pay on iPhone to run unattended — there must be a staff member holding the device. So an iPad kiosk needs a separate physical reader.

## Recommended hardware

- **Stripe Reader S700** ($349) — countertop, Wi-Fi, customer-facing screen, runs an Android-based POS. Best UX for a kiosk; customers self-serve and you don't need an iPad at all.
- **BBPOS WisePOS E** ($249) — Wi-Fi, has its own touchscreen. Similar to S700, slightly cheaper.
- **BBPOS Chipper 2X BT** ($59) — Bluetooth, paired to an iPad. Cheapest. iPad shows the kiosk UI; small chipper handles the card.

For the cheapest path, use a Chipper 2X BT + an iPad in Guided Access mode locked to the WTS Tickets app.

## What to build

1. **Server**: extend the existing Terminal endpoints — the same `/api/terminal/payment-intent` works for any reader type. No code changes.
2. **iOS — new `KioskView.swift`**: full-screen, no chrome, large buttons. Reader connects via `BluetoothScanDiscoveryConfiguration` (Chipper) or `InternetConnectionConfiguration` (S700/WisePOS) instead of the Tap-to-Pay configuration.
3. **iOS — kiosk mode entry**: e.g. a long-press on the event row in Events tab → "Start Kiosk Mode". Stays in foreground.
4. **iPad lockdown**: Apple's Guided Access (Settings → Accessibility → Guided Access) locks the iPad to this app and disables home button. Three-finger triple-tap exits.
5. **Optional: auto-reset**: after each successful sale, the kiosk auto-returns to the start screen.

## Cost / time estimate

- Build: ~1 day of dev work after the iPhone Tap-to-Pay flow is verified working.
- Hardware: $60–$350 per kiosk.
- Stripe charges per-transaction fees only (no monthly Terminal fee).

Open the issue when you're ready and I'll wire this up.
