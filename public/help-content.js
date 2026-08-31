// Content for the dashboard's inline help ("?") icons — one entry per
// settings field, block type, or system concept. Loaded before every
// dashboard <script> block (see dashboard.html's <head>) so window.HELP_CONTENT
// is available wherever a helpIcon('key') is rendered.
//
// Shape per entry:
//   title:   short label, shown as the popover heading
//   summary: 1-2 sentences, what the field/system does
//   details: array of strings, each ONE distinct edge case / interaction /
//            constraint — rendered as bullet points. May contain simple
//            inline HTML (<strong>, <code>) since these are author-written,
//            not user input. Keep each point concrete and specific — no
//            filler like "this field is optional".
//
// MAINTENANCE: whenever a setting, field, or system behavior changes or is
// added anywhere in this app, update the matching entry here (or add a new
// one) in the same commit. This file is the one place all of it lives —
// see the "keep help content current" project memory for the full rule.
window.HELP_CONTENT = {

    // ── General tab ──────────────────────────────────────────────────────
    'general.name': {
        title: 'Event Name',
        summary: 'Shown everywhere the event is referenced — tickets, emails, the Apple Wallet pass, and the dashboard.',
        details: [
            `The dashboard blocks saving with this blank, but the server itself doesn't reject an empty value — if one somehow gets sent, the old name is silently kept rather than cleared.`,
        ],
    },
    'general.time': {
        title: 'Start Date & Time',
        summary: 'The event\'s start time, entered in whatever zone the Timezone field below is set to and converted to a stored UTC instant.',
        details: [
            `Clearing this field entirely is a valid state — an "undated" event. Several features (Apple Wallet pass layout, calendar invites) branch explicitly on there being no start time.`,
            `Changing this does <strong>not</strong> shift the ticket-expiry cutoff or anything else — every time-based setting on this event is independent.`,
        ],
    },
    'general.endTime': {
        title: 'End Date & Time',
        summary: 'Optional — marks the event as spanning a range rather than a single moment, for multi-day events.',
        details: [
            `If left blank, or set to a time at or before the start time, calendar invites (.ics) silently fall back to a 2-hour block starting at the start time instead of erroring.`,
            `With a real end time set, the Apple Wallet pass shows a date <strong>range</strong> instead of a single date, and the pass's own expiration becomes end time + 24h instead of start time + 24h.`,
            `With Show on Lock Screen also on, the reminder/geofence window widens to start&nbsp;−&nbsp;2h through end&nbsp;+&nbsp;2h instead of a single "Tonight at 8pm" message.`,
        ],
    },
    'general.timezone': {
        title: 'Timezone',
        summary: 'The IANA zone (e.g. America/New_York) the event physically happens in — governs how the times above, and everywhere else times are shown, get labeled.',
        details: [
            `An unrecognized zone string is silently ignored on save — the previous value is kept rather than the field going blank or erroring.`,
            `If never set, everything falls back to America/New_York (or this server's configured default).`,
            `Conversions are double-checked against the UTC offset near a Daylight Saving transition, so an edit made right around a DST change doesn't land on the wrong side of it.`,
        ],
    },
    'general.color': {
        title: 'Accent Color',
        summary: 'Used as the Apple Wallet pass background, and as the default accent for the ticket-confirmation email and (for some registration-page themes) the public registration page.',
        details: [
            `Greys out to a fixed dark grey on the Wallet pass automatically once a ticket is checked in or expired.`,
            `Only applies to the registration page for themes that opt into it (Classic and Midnight) — Professional, Fun, and Garden ignore the event color and always use their own fixed accent.`,
            `Email header/button text automatically flips between black and white depending on how light or dark this color is, so a very light accent never produces unreadable white-on-white text.`,
        ],
    },
    'general.venueName': {
        title: 'Venue Name',
        summary: 'Shown on tickets, emails, and the registration page.',
        details: [
            `Saving this field genuinely empty clears the venue (it used to silently keep the old value instead, which meant a name typed in by mistake could only ever be replaced, never removed).`,
        ],
    },
    'general.address': {
        title: 'Address',
        summary: 'Street address, with map coordinates captured from the autocomplete suggestions as you type.',
        details: [
            `The map pin and Wallet lock-screen geofence only update if you actually pick a suggestion from the autocomplete dropdown — typing free text and saving without selecting a suggestion leaves the underlying coordinates unchanged.`,
            `If no valid coordinates exist (a brand-new event, or free text never matched to a suggestion), the map/geofence silently falls back to the previous coordinates, or a generic default location if there were never any — so the printed address can be correct while the pin points somewhere else.`,
        ],
    },
    'general.image': {
        title: 'Event Image',
        summary: 'The event\'s photo — used as the ticket/registration page banner.',
        details: [
            `5&nbsp;MB max, PNG or JPEG only. A JPEG is automatically converted to PNG on upload.`,
            `"Remove Image" clears it immediately; the old file is deleted best-effort (a missing file on disk doesn't fail the request).`,
        ],
    },
    'general.allowReentry': {
        title: 'Allow Reentry',
        summary: 'Lets a checked-in attendee scan out and back in, instead of the ticket being permanently "used" after one scan.',
        details: [
            `With this on, scanning someone already inside doesn't check them out immediately — it prompts the scanner to confirm the exit first. Scanning again while they're marked outside re-admits them.`,
            `Turning this on for an event that already has check-ins from before: those older tickets have no reentry status recorded yet, so their next scan is treated as an exit-confirmation prompt rather than a fresh check-in.`,
            `The ticket's QR / Wallet pass stays active for repeated scanning rather than being voided after the first one.`,
        ],
    },
    'general.shuttleLink': {
        title: 'Allow Shuttle Linking',
        summary: 'Opts the event into a read-only integration where a linked shuttle/bus app can check riders\' existing tickets to board, without ever marking them "used".',
        details: [
            `<strong>Only enable this if tickets for this event are never also scanned at a door.</strong> Nothing stops both being on at once, but boarding a shuttle never checks someone in at the venue and vice versa — the two are deliberately kept independent, so mixing them on one event just produces confusing numbers.`,
            `This checkbox saves the instant you click it — it isn't part of the tab's batched Save bar, so it takes effect even if you navigate away without saving anything else on the page.`,
            `Riders can be checked any number of times boarding repeatedly; there's no one-time-use gate on this path.`,
        ],
    },
    'general.walletLockScreen': {
        title: 'Show on Lock Screen',
        summary: 'Controls whether the Apple Wallet pass surfaces a lock-screen reminder near the event time and when the phone is close to the venue.',
        details: [
            `On by default for every event.`,
            `Also saves the instant you click it, independent of the tab's batched Save bar — same as Allow Shuttle Linking.`,
            `Needs real map coordinates (see Address above) to set up the proximity trigger — without them, only the time-based "Tonight at 8pm" reminder still works, with no location component.`,
            `Toggling this pushes an updated pass to everyone who already has a ticket, so it takes effect on already-issued Wallet passes, not just new ones.`,
        ],
    },
    'general.capacity': {
        title: 'Capacity',
        summary: 'Maximum number of tickets this event can issue. Leave blank for unlimited.',
        details: [
            `Counts issued tickets + people currently mid-signup with an active seat hold + unclaimed waitlist offers — not just tickets already issued. This is what stops ten people filling in the form for four spots and six of them finding out only after typing everything in.`,
            `Lowering capacity below what's already issued/held is allowed — it's your event — but if it stranded anyone mid-signup, you'll see exactly how many, and it's recorded in the audit log.`,
            `A blank or non-numeric value means unlimited, not zero.`,
        ],
    },
    'general.ticketExpiresAt': {
        title: 'Tickets Expire At',
        summary: 'A cutoff after which any not-yet-checked-in ticket stops scanning and is marked expired — its Apple Wallet pass is voided, the same as a deleted ticket.',
        details: [
            `Never retroactive: once someone is checked in, this cutoff can never apply to them, no matter when it's set.`,
            `A cutoff that's already in the past when you save it takes effect immediately, in the same request — you don't have to wait for the periodic sweep (which otherwise re-checks every few minutes).`,
            `If the event has a waitlist enabled, every ticket this expires frees a seat and immediately offers it to whoever's been waiting longest.`,
            `Clearing this field does <strong>not</strong> un-expire tickets that already expired under a previous cutoff — bring one back individually with its own "Un-expire" action.`,
            `Leaving this blank means tickets never expire on their own.`,
            `See <strong>Limit How Many Expire</strong> below for narrowing this from "everyone" to a specific count.`,
        ],
    },
    'general.ticketExpiryLimit': {
        title: 'Limit How Many Expire',
        summary: 'By default the cutoff above expires every not-checked-in ticket at once. Set a number here to expire only that many instead, oldest- or newest-registered first.',
        details: [
            `Has no effect at all without a cutoff time set above — this only narrows what the cutoff does, it doesn't create one.`,
            `It's a running, all-time cap on this event, not "expire N more every time the sweep runs" — the remaining budget is recalculated every time from how many tickets have <em>already</em> been expired in total, by any means (the cutoff, the periodic sweep, or a manual per-ticket "Expire Ticket" action all count against it).`,
            `Un-expiring a ticket manually frees that budget back up — the next automatic pass can expire a different ticket to refill the cap, so the limit holds going forward rather than only mattering the one moment the cutoff first passed.`,
            `A shared registration (several tickets bought together) always expires as one unit and is never split — so the actual number expired can run slightly over your configured limit to keep a group intact.`,
            `Order picks which registrations are chosen first once the limit narrows things down: oldest-registered or newest-registered. Default is oldest.`,
            `A value of 0 or a negative number is clamped up to 1 rather than rejected.`,
        ],
    },
    'general.ticketPrice': {
        title: 'Ticket Price',
        summary: 'Charged via Stripe Checkout at registration. Leave blank or 0 for a free event.',
        details: [
            `<strong>Paid ticketing is a beta, testing-only feature.</strong> This field always saves regardless of whether a Stripe account is connected — setting a price here does not by itself let you collect any money.`,
            `The first time an event moves from free to paid, you'll see a one-time warning about this; editing an already-paid event's price again doesn't repeat it.`,
            `If checkout or a refund is actually attempted with no Stripe account connected, those fail on their own with a message pointing at support, rather than this field ever blocking the save.`,
            `A negative value is clamped to 0.`,
        ],
    },

    // ── Danger Zone ───────────────────────────────────────────────────────
    'dangerZone.deleteEvent': {
        title: 'Delete Event',
        summary: 'Permanently removes the event and everything tied to it. This cannot be undone.',
        details: [
            `Deletes: every ticket, push-notification subscriptions, scanner links and their access grants, active seat holds, API keys scoped to this event, giveaway winner records, the Google Sheet integration link and every sharing/access grant on it, and any connected sheet watcher.`,
            `Voids the Apple Wallet pass for every ticket that existed, the same as deleting a single ticket does.`,
            `Requires the specific "Delete the event" permission, not just general event-editing access — someone with no access at all is told the event doesn't exist rather than that they're forbidden, so they can't even confirm it's real.`,
            `Bulk-deleting several events at once does the identical cleanup per event, restricted to only the ones you're allowed to delete.`,
        ],
    },

    // ── Custom Fields tab ─────────────────────────────────────────────────
    'customFields.list': {
        title: 'Custom Fields',
        summary: 'A list of extra field names (e.g. "T-Shirt Size") that pre-fill as rows in the manual Add/Edit Registration form for staff.',
        details: [
            `<strong>Not shown on the public registration form.</strong> A public registrant never sees or fills these in — they exist purely to save staff from retyping the same field name every time they manually add or edit a registration.`,
            `Field names are matched exactly, case-sensitively — "Meal" and "meal" are treated as two different fields.`,
            `Removing a field from this list does not delete any values already saved on tickets under that name — it just stops being pinned/pre-filled in the editor; the data (and an editable row for it) stays on any ticket that has it.`,
            `Staff can always type in an arbitrary field name in the ticket editor regardless of what's defined here — this list is a convenience checklist, not an enforced schema.`,
            `Values collected under these names show up in: CSV export (only for fields actually filled in on at least one exported ticket), the optional "Custom fields" block in the confirmation email, the Apple Wallet pass, the scanner's check-in view, and the public API's ticket create/update calls.`,
        ],
    },

    // ── Registration tab ──────────────────────────────────────────────────
    'registration.publicRegistration': {
        title: 'Public Registration',
        summary: 'Turns the public self-registration link on or off. Off shows a "registration closed" page instead of the form.',
        details: [
            `A valid waitlist claim link still shows the form on a <strong>free</strong> event even with this off — free-event promotions issue the ticket directly and don't depend on this toggle at all.`,
            `On a <strong>paid</strong> event, this is checked before the claim token — so if you turn Public Registration off after already promoting someone off the waitlist, their claim link will fail at checkout rather than letting them through. If you're closing registration but still have pending paid claims, be aware those will stop working too.`,
            `Independent of At-Door Sales — either, both, or neither can be on without affecting the other.`,
        ],
    },
    'registration.allowMultiple': {
        title: 'Allow Registering Several People',
        summary: 'Shows a "Register Another Person" button after a successful signup, so one visitor can register a group.',
        details: [
            `Purely cosmetic — it only controls whether that button appears. It does <strong>not</strong> stop a second registration from going through; only "One Registration Per Email" or "One Registration Per Device" below actually block a repeat signup.`,
            `Defaults to on.`,
        ],
    },
    'registration.blockDuplicateEmails': {
        title: 'One Registration Per Email',
        summary: 'Refuses a new registration if that email address already has a ticket for this event.',
        details: [
            `Case-insensitive — "Jane@x.com" and "jane@x.com" count as the same registrant.`,
            `Scoped to this one event only; the same email can freely register for a different event.`,
            `A valid waitlist claim link bypasses this — that seat was already promised to that specific email.`,
            `Off by default.`,
        ],
    },
    'registration.oneRegPerDevice': {
        title: 'One Registration Per Device',
        summary: 'Sets a long-lived cookie on successful registration, so the same browser is turned away before it even sees the form again.',
        details: [
            `<strong>A deterrent, not a lock.</strong> Clearing cookies, a private/incognito window, or simply using a second device all defeat it — it only stops the same person casually registering twice by accident, nothing more.`,
            `For anything that actually needs to be enforced, pair it with "One Registration Per Email" instead — that one can't be sidestepped by clearing cookies.`,
            `A valid waitlist claim link bypasses this too.`,
            `Off by default.`,
        ],
    },
    'registration.theme': {
        title: 'Registration Page Look',
        summary: 'Picks the visual theme for the public registration page. The event\'s own photo (set under General) becomes the banner on every theme.',
        details: [
            `<strong>Classic</strong> — clean and neutral, uses your event color as the accent. The default for any event that's never had a theme chosen.`,
            `<strong>Professional</strong> — restrained navy and slate; ignores your event color and always uses its own fixed navy accent. Sharpest corners of the five.`,
            `<strong>Fun</strong> — bright and rounded with a warm orange-to-purple gradient header; also ignores your event color. Roundest corners of the five.`,
            `<strong>Midnight</strong> — dark background with a bright accent, the only dark-mode preset; uses your event color if set, otherwise a sky blue.`,
            `<strong>Garden</strong> — soft greens and cream, the only serif-font preset; ignores your event color, fixed green accent.`,
            `Saves immediately on click, unlike most of this tab's fields which batch into the floating Save bar — there's no separate step needed.`,
        ],
    },

    // ── Access & Sharing tab ─────────────────────────────────────────────
    'access.capabilities': {
        title: 'Permissions',
        summary: 'Access to an event is a checklist of specific capabilities, not a single "admin/not admin" switch — check exactly what someone should be able to do.',
        details: [
            `"Undo check-ins" always brings "Check attendees in" along with it — an undo-only grant would be unusable on its own, so it's added automatically.`,
            `"Manage who has access" can only be turned on by the real event owner (or the admin) — a collaborator holding it themselves still can't grant it to anyone else. This stops anyone quietly promoting themselves or a friend past what the owner actually gave them.`,
            `Nobody, including the owner, can edit their own grant through this screen — you can only change what someone <em>else</em> holds.`,
        ],
    },
    'access.roles': {
        title: 'Check-in Only / Full Access',
        summary: 'Two quick presets over the full permission checklist: Check-in Only grants exactly one thing (checking people in), Full Access grants everything.',
        details: [
            `Any combination other than these two exact sets shows as "Custom" in the People list, with its individual permissions spelled out instead of a preset badge — the badge is just a shorthand for a common case, not a separate kind of grant.`,
            `A grant made before this permission system existed still works exactly as it always did — it's read as the old "view" or "full" role until someone edits it, at which point it becomes a real granular grant.`,
        ],
    },
    'access.addSomeone': {
        title: 'Add Someone',
        summary: 'Shares this event with another account by email, at whatever permissions you check.',
        details: [
            `The person must already have an account here — they can't be invited by email into a new one from this screen.`,
            `You can't share with yourself or with the event's current owner.`,
            `At least one permission must be checked to share at all.`,
            `The first time you share an event, a sharing link is created automatically behind the scenes — that's why the link box below only appears after your first share.`,
        ],
    },
    'access.editPermissions': {
        title: 'Edit Permissions',
        summary: 'Changes what a collaborator can already do, without having to revoke and re-share.',
        details: [
            `Same restrictions as sharing: you can't edit your own grant, and only a real owner can turn "Manage who has access" on for someone.`,
        ],
    },
    'access.revoke': {
        title: 'Revoke',
        summary: 'Removes someone\'s access to this event entirely.',
        details: [
            `Anyone can revoke their own access. Revoking someone else's requires "Manage who has access".`,
            `Takes effect immediately on their next action — every permission check happens fresh against the database, there's no cached grant to expire. It doesn't forcibly close anything they already have open (a live scanner tab, a monitor view), but their very next scan or dashboard action will be refused.`,
        ],
    },
    'access.transferOwnership': {
        title: 'Transfer Ownership',
        summary: 'Hands full ownership of this event to someone else.',
        details: [
            `Only the real owner (or the admin) can do this — a collaborator with "Manage who has access" cannot, since transferring ownership is a bigger action than granting access.`,
            `The target must already have an account, and can't already be the current owner.`,
            `<strong>You are not locked out of your own event afterward</strong> — you're automatically left with full-access collaborator permissions on it, so you keep working exactly as before, just no longer as the owner.`,
        ],
    },
    'access.sharingLink': {
        title: 'Sharing Link',
        summary: 'A read-only reference link for this event\'s integration, created automatically the first time you share with someone.',
        details: [
            `This is informational/copy-only — actually granting someone access happens through "Add Someone" above by email, not by sending them this link.`,
        ],
    },
    'access.scanLinks': {
        title: 'Scan Links',
        summary: 'No-login links for door staff — anyone holding the link can scan and check in tickets for this one event, nothing else.',
        details: [
            `Deliberately narrow: no editing the event, no emailing attendees, no exports, no managing access — just checking people in (and undoing a mis-scan).`,
            `Create as many as you want, one per staffer or device, each independently labeled and revocable — nobody has to share one credential.`,
            `Revoking a link takes effect immediately — it's re-checked on every single scan, so anyone still using a revoked link is refused on their very next action, not at some later "session expiry".`,
            `Creating or revoking a link needs "Edit event settings"; anyone with any access at all to the event can view/copy an existing one.`,
            `Opening a scan link while already signed in behaves differently than opening it as a stranger: signed in, it grants your account standing check-in access to the event going forward (it shows up in Your Events from then on); as a stranger, it scopes that one browser session instead, which actually grants slightly more (check-in <em>and</em> undo) but only for as long as that session lasts.`,
            `A scan link stops working automatically the moment its event is deleted.`,
        ],
    },

    // ── Notifications tab ─────────────────────────────────────────────────
    'notifications.target': {
        title: 'Send To',
        summary: '"Everyone subscribed" reaches every device belonging to anyone who has opted into push notifications for this event in the app. "Select devices" lets you pick specific ones.',
        details: [
            `If someone is subscribed and signed into the app on three phones, all three get the push — this fans out per device, not per person.`,
        ],
    },
    'notifications.deviceList': {
        title: 'Device List',
        summary: 'Every device currently registered and subscribed to this event, labeled by owner.',
        details: [
            `Populated automatically — there's no manual "add a device" here. A device appears the moment its owner registers their token while subscribed, and quietly drops off on its own if a push to it ever comes back invalid (e.g. the app was uninstalled).`,
        ],
    },
    'notifications.sendPush': {
        title: 'Send Push',
        summary: 'Sends a notification through two channels at once: an instant in-app banner to any open scanner screens for this event, and a real push notification to reach devices where the app isn\'t currently open.',
        details: [
            `Title defaults to a generic "Update • [event name]" if you leave it blank.`,
            `Unlike most consequential actions in the dashboard, sending a push is <strong>not</strong> written to the Activity Log — it only shows up in the short-lived server log, which is lost on restart.`,
        ],
    },

    // ── Audit Log ─────────────────────────────────────────────────────────
    'auditLog.overview': {
        title: 'Activity Log',
        summary: 'A persistent record of who did what to this event and when — access grants, check-ins, waitlist actions, refunds, and more.',
        details: [
            `Not everything is logged. Notably: creating or editing an individual ticket through the manual Add/Edit form, most General-tab field edits (renaming the event, moving the venue, changing the image), and sending a push notification all leave no entry here — only certain higher-impact actions are recorded (bulk deletion, capacity being lowered onto people mid-signup, access changes, refunds, waitlist promotions, and similar).`,
            `Shows only the most recent entries — there's no "load more" in this view even if there's a longer history.`,
            `Nothing here is ever automatically pruned — the underlying record only grows.`,
            `An event's history outlives the event itself in the system, but this screen stops being reachable once the event is deleted, since it depends on the event still existing to check who's allowed to see it.`,
        ],
    },

    // ── Discounts tab ─────────────────────────────────────────────────────
    'discounts.code': {
        title: 'Code',
        summary: 'The word attendees type at checkout to redeem the discount.',
        details: [
            `Case-insensitive in practice — always stored and matched uppercased.`,
            `Only needs to be unique <em>within this event</em> — the same code can exist on two different events with completely different discounts behind it.`,
        ],
    },
    'discounts.type': {
        title: 'Discount Type',
        summary: '% off takes a percentage of the ticket price; $ off takes a fixed dollar amount.',
        details: [
            `A percentage discount is capped at 100%.`,
            `A fixed-amount discount larger than the ticket price is simply capped at the full price — it can never push the total below $0.`,
            `A code that reduces the price to exactly $0 issues the ticket directly rather than going through Stripe (a $0 Checkout session isn't something Stripe supports) — so a 100%-off code works even before any Stripe account is connected.`,
        ],
    },
    'discounts.value': {
        title: 'Value',
        summary: 'The size of the discount — a percentage (whole number, 1–100) for "% off", or a dollar amount for "$ off".',
        details: [
            `Must be a positive number.`,
        ],
    },
    'discounts.maxUses': {
        title: 'Max Uses',
        summary: 'Total number of times this code can be redeemed across everyone, event-wide. Leave blank for unlimited.',
        details: [
            `Not per-buyer — one person using it 5 times and 5 people using it once each count the same toward this cap.`,
            `The redemption count only increments once payment is actually confirmed (or immediately, for a 100%-off code that skips Stripe entirely) — someone who starts checkout with a code but never completes payment does not use up a redemption.`,
            `Under simultaneous checkouts right at the limit, it's technically possible for the count to tick one over — the check happens before payment, not as a hard database lock.`,
        ],
    },
    'discounts.status': {
        title: 'Status / Deactivate',
        summary: 'Deactivating a code stops it working immediately without deleting its history or usage count — reactivate any time.',
        details: [
            `This is the reversible way to retire a code. Prefer it over Delete if you might want the code (or its usage history) back later.`,
        ],
    },
    'discounts.delete': {
        title: 'Delete',
        summary: 'Permanently removes the code. This cannot be undone.',
        details: [
            `Orders that already used this code keep the dollar amount they were discounted — deleting the code doesn't change any past order, it just removes the code itself so it can no longer be redeemed or looked up.`,
            `There's no date-based expiry field in this screen — a code created here stays valid indefinitely until you deactivate or delete it yourself.`,
        ],
    },

    // ── Payments (Beta) tab ───────────────────────────────────────────────
    'payments.beta': {
        title: 'Payments (Beta)',
        summary: 'Paid ticketing is a testing-only feature — taking real money requires your own Stripe account connected to this system first.',
        details: [
            `Setting a ticket price always saves, whether or not Stripe is connected — the price alone doesn't collect anything.`,
            `Once Stripe is connected, everything on this tab (orders, refunds) works against real payments.`,
        ],
    },
    'payments.orders': {
        title: 'Orders',
        summary: 'Every checkout attempt for this event, in three possible states: pending (checkout started, not yet completed), fulfilled (paid and ticket issued), or refunded.',
        details: [
            `A long list of old "pending" rows is normal, not a sign something's broken — an abandoned checkout (the buyer closes the tab, a card declines) has no automatic cleanup and simply sits at "pending" forever.`,
            `An order made with a 100%-off discount code shows as "fulfilled" with no payment on file, since no money ever moved through Stripe for it — see Refund below.`,
        ],
    },
    'payments.refund': {
        title: 'Refund',
        summary: 'Issues a full refund back to the original payment method through Stripe. There is no partial-refund option here.',
        details: [
            `Only available on a fulfilled order that actually has a real Stripe charge behind it.`,
            `<strong>A 100%-off (fully discounted) order cannot be refunded here</strong> — it's not a bug to route around, there's genuinely nothing to refund since no charge was ever made.`,
            `Cannot be issued twice — an already-refunded order is blocked from a second refund attempt.`,
            `Stays in sync automatically if a refund is instead issued directly from your Stripe dashboard — either path updates the same order record, whichever happens first.`,
        ],
    },

    // ── Ticket Email editor: design panel ────────────────────────────────
    'email.variants': {
        title: 'Four Independent Emails',
        summary: 'One editor, four separate layouts: the Ticket email (every registration), the Winner email (giveaways), the Waitlist email (joining the list), and the Spot Available email (a waitlisted person promoted on a paid event).',
        details: [
            `Until you customize it yourself, the <strong>Winner</strong> email mirrors whatever the Ticket email currently is — not a fixed layout of its own. Editing the Ticket email later does <em>not</em> retroactively change an already-customized Winner email, only one that's still mirroring.`,
            `The <strong>Spot Available</strong> email only ever gets sent for a <strong>paid</strong> event — a free event's promoted waitlist entry gets a ticket immediately through the normal Ticket email instead, so customizing this tab has no effect until the event has a price.`,
            `Each tab's blocks, variables, and Reset behavior are independent — switching tabs is a genuine layout swap, not a shared draft.`,
        ],
    },
    'email.subject': {
        title: 'Subject Line',
        summary: 'Leave blank to use the automatic subject, which adapts to context (new registration, an edit, a resend, a giveaway win).',
        details: [
            `Supports the same {{variables}} listed at the bottom of this panel for whichever email you're editing.`,
            `On the Ticket/Winner emails, the automatic fallback genuinely adapts per send (different text for a brand-new ticket vs. an edited one vs. a plain resend vs. a giveaway win) — typing your own subject here replaces all of that with one fixed line regardless of which of those actually happened.`,
        ],
    },
    'email.accentColor': {
        title: 'Accent Colour',
        summary: '"Match event colour" uses the Accent Color set on the General tab; "Custom" lets you pick a different one just for this email.',
        details: [
            `With no event color set, "Match event colour" falls back to a default indigo rather than showing nothing.`,
            `Text painted on top of this color (header text, button labels) automatically switches between black and white for readability — you never end up with unreadable text on a light accent.`,
        ],
    },
    'email.backgrounds': {
        title: 'Backgrounds',
        summary: 'Page color is the full email background; card color is the panel the content sits inside.',
        details: [
            `An invalid color value falls back to the default rather than breaking the layout.`,
        ],
    },
    'email.formatting': {
        title: 'Text Formatting',
        summary: '**bold**, *italic*, and [link text](https://…) work inside any text you write — header text, paragraph blocks, button labels, footer lines.',
        details: [
            `Only http://, https://, and mailto: links are accepted — anything else in a [link](…) is left as plain unlinked text rather than silently breaking.`,
            `Does not apply to the dynamic blocks (event details, calendar, tickets, custom fields) — those are always rendered from the actual event/ticket data, not typed text.`,
        ],
    },
    'email.reset': {
        title: 'Reset',
        summary: 'Reverts this one email variant back to its starting point. Cannot be undone once confirmed.',
        details: [
            `For the Ticket, Waitlist, and Spot Available emails, this reverts to the app's built-in default layout.`,
            `For the <strong>Winner</strong> email specifically, Reset instead goes back to <em>mirroring the Ticket email</em> — not a fixed winner-specific layout — matching its normal "not yet customized" state.`,
            `Only resets the one variant you're currently viewing; the other three are untouched.`,
        ],
    },
    'email.preview': {
        title: 'Live Preview',
        summary: 'Renders through the exact same code path a real send uses, with sample data — what you see here is what actually goes out.',
        details: [
            `Uses real tickets from the event if any exist yet, otherwise realistic sample names/tokens.`,
            `The one deliberate difference from a real email: images here load from a live link for preview purposes, where a real send embeds them directly in the message so they display reliably in every email client.`,
        ],
    },

    // ── Ticket Email editor: block palette ───────────────────────────────
    'email.block.header': {
        title: 'Header Banner',
        summary: 'A colored bar (in your accent color) with an eyebrow line and title. Available on all four emails; only one per email.',
        details: [
            `Always renders, even with an empty title — this is the one block that's never silently skipped.`,
            `Title defaults to {{eventName}} if you clear it.`,
        ],
    },
    'email.block.text': {
        title: 'Text',
        summary: 'A paragraph you write yourself, with size, alignment, and color controls. You can add as many as you like.',
        details: [
            `Renders nothing at all if left blank — an empty text block doesn't show up as an empty gap, it's fully omitted.`,
            `Up to 4000 characters.`,
        ],
    },
    'email.block.intro': {
        title: 'Status Line',
        summary: 'A sentence that automatically explains why this email arrived — new registration, an update, a resend, or a giveaway win. No text to type; it\'s generated per send.',
        details: [
            `Ticket / Winner emails only, and only one per email.`,
        ],
    },
    'email.block.eventImage': {
        title: 'Event Photo',
        summary: 'The event\'s own photo (set on the General tab), shown full-width at the top.',
        details: [
            `Silently hidden for an event with no photo set — not a broken-image icon, just absent.`,
            `Available on all four emails; only one per email.`,
        ],
    },
    'email.block.eventDetails': {
        title: 'Event Details',
        summary: 'A card with the date, time, and location, pulled straight from the event.',
        details: [
            `The map-links toggle switches between clickable Google/Apple Maps links and plain address text.`,
            `Renders nothing if the event has neither a date nor a location set.`,
        ],
    },
    'email.block.calendar': {
        title: 'Add to Calendar',
        summary: 'Google Calendar and/or Apple/Outlook buttons. Ticket and Winner emails only.',
        details: [
            `With the Apple/Outlook option on, a real calendar-invite file is attached to the email too, so mail apps can offer "Add to Calendar" directly, not just as a link.`,
            `The Apple/Outlook button (and its attachment) needs the event to actually have a start time — without one, that half is silently skipped.`,
        ],
    },
    'email.block.tickets': {
        title: 'Tickets & QR',
        summary: 'The QR code(s) for this registration, with optional Apple Wallet buttons and the raw ticket code shown underneath. Ticket and Winner emails only.',
        details: [
            `Removing this block entirely (rather than just unchecking its options) skips generating the QR images and Wallet attachments altogether — a real way to keep the email lighter, not just cosmetic.`,
            `A registration with more than one ticket also gets an "Add all to Wallet" button above the individual QR cards.`,
        ],
    },
    'email.block.customFields': {
        title: 'Custom Fields',
        summary: 'The attendee\'s answers to this event\'s custom fields, as a simple table. Ticket and Winner emails only.',
        details: [
            `Renders nothing for a registration with no custom-field answers on it — which is most registrations made through the normal public form, since custom fields are mainly filled in through manual/imported entry.`,
        ],
    },
    'email.block.changes': {
        title: 'Change Summary',
        summary: 'A callout listing exactly what changed, shown only on a resend where something was actually edited. Ticket and Winner emails only.',
        details: [
            `Renders nothing on a brand-new registration, a plain resend with no edits, or a giveaway win — only on an edit-then-resend where fields genuinely differ from before.`,
        ],
    },
    'email.block.waitlistPosition': {
        title: 'Position Line',
        summary: 'The "you are #N in line" sentence. Waitlist email only.',
        details: [
            `Renders nothing if the person's position can't be determined at send time (e.g. re-joining a list they're already off).`,
        ],
    },
    'email.block.waitlistStatusButton': {
        title: 'View Position Button',
        summary: 'A button linking to the recipient\'s own live waitlist status page. Waitlist email only.',
        details: [
            `Always populated on a real send.`,
        ],
    },
    'email.block.waitlistClaimButton': {
        title: 'Claim Button',
        summary: 'The primary "Complete Registration" button linking to the reserved-spot checkout. Spot Available email only.',
        details: [
            `This is the whole point of this email — it's the one link that actually claims the seat.`,
        ],
    },
    'email.block.button': {
        title: 'Button',
        summary: 'A custom link styled as a button — your own label and destination. Available on all four emails, as many as you like.',
        details: [
            `Only https://, http://, and mailto: links are accepted — anything else is rejected and the button silently doesn't render.`,
            `Also doesn't render if the label is left empty.`,
            `Supports {{variables}} in the link itself, substituted right before the email is sent.`,
        ],
    },
    'email.block.image': {
        title: 'Image',
        summary: 'A hosted image, optionally wrapped in a link, with adjustable width and alignment.',
        details: [
            `Must be a publicly reachable URL — email clients can't load an image from behind a login. A path starting with "/" (like one copied from your own event photo) is automatically resolved against this site, so that shortcut works too.`,
            `Scales down to fit both the configured width and a maximum height without ever cropping — a very tall image ends up narrower than you set rather than being cut off.`,
            `Renders nothing if the URL doesn't validate.`,
        ],
    },
    'email.block.divider': {
        title: 'Divider',
        summary: 'A plain horizontal rule. No settings — always renders.',
    },
    'email.block.spacer': {
        title: 'Spacer',
        summary: 'Empty vertical gap, height adjustable.',
    },
    'email.block.footerNote': {
        title: 'Footer Note',
        summary: 'Small print lines under a divider, near the bottom — typically things like "retain this as your ticket." Only one per email.',
        details: [
            `Up to 6 lines, entered one per line.`,
            `Renders nothing at all if every line is left blank.`,
        ],
    },

    // ── API Access tab ────────────────────────────────────────────────────
    'api.keyName': {
        title: 'Key Name',
        summary: 'A label for your own reference — shown in the key list and attributed on every action this key takes in the Activity Log.',
        details: [
            `This is the only way to tell keys apart later, since the secret itself is never shown again after creation — a vague or duplicate name makes the audit trail harder to read.`,
        ],
    },
    'api.scopes': {
        title: 'Scopes',
        summary: 'Which specific things this key is allowed to do — the same permission list used for sharing the event with a person.',
        details: [
            `You can never grant a key a permission you don't hold yourself — the request is refused if you try.`,
            `"Manage who has access" can never be granted to a key at all, under any circumstances — access-sharing stays a human-only action.`,
            `"Undo check-ins" automatically brings "Check attendees in" with it, same as for a human grant.`,
            `A key's actual working permissions are re-checked <strong>on every request</strong>, not fixed at creation — if your own access to the event narrows later (a permission removed, or the event unshared with you), the key narrows with you immediately, with no delay and nothing to update on the key itself.`,
        ],
    },
    'api.createKey': {
        title: 'Create Key',
        summary: 'Generates a new secret key. It is shown to you exactly once, right here — there is no way to see it again afterward.',
        details: [
            `If you lose it, there's no recovery — revoke it and create a new one.`,
            `Only a scrambled hash of the key is ever stored, not the key itself, so even direct database access can't recover it.`,
        ],
    },
    'api.keyList': {
        title: 'Key List',
        summary: 'Every key created for this event, with its permissions and last-used time.',
        details: [
            `If a key's permissions have narrowed since it was created (because the creator's own access narrowed), the row shows exactly what it's actually limited to now, not just what it was originally granted.`,
            `Last-used time can lag by up to a minute under heavy use — it's updated in batches rather than on every single request, to avoid the overhead of writing on every call.`,
        ],
    },
    'api.revoke': {
        title: 'Revoke',
        summary: 'Immediately and permanently disables a key. Anything using it stops working on its very next request.',
        details: [
            `Cannot be undone — there's no "un-revoke", only creating a fresh key.`,
            `Anyone with permission to manage the event's settings can revoke any key on it, not just the person who created that particular key.`,
        ],
    },

    // ── Waitlist tab ──────────────────────────────────────────────────────
    'waitlist.enable': {
        title: 'Enable Waitlist',
        summary: 'Lets people join a waitlist instead of being turned away once the event is full.',
        details: [
            `Requires a capacity limit set on this event — with no capacity, the event can never actually sell out, so there's nothing to waitlist for.`,
            `Turning this off doesn't clear the existing list — anyone already on it stays there, just with no way for new people to join until it's re-enabled.`,
        ],
    },
    'waitlist.claimHours': {
        title: 'Claim Link Expires After',
        summary: 'For paid events only — how long a promoted person has to complete checkout before their reserved spot is automatically offered to the next person in line.',
        details: [
            `Has no effect on a free event — a free-event promotion issues the ticket immediately, with nothing to claim or expire.`,
            `Once a claim lapses, the seat is offered to whoever's waited longest, entirely automatically — nobody has to notice and click anything for the chain to keep moving.`,
            `Clamped to a sane range (1 hour to 10 days) — an out-of-range value is pulled back to the nearest valid bound rather than rejected.`,
        ],
    },
    'waitlist.joinEmail': {
        title: 'Waitlist Email',
        summary: 'Sent the moment someone joins the waitlist, confirming their position and linking to a live status page.',
        details: [
            `Fully customizable in the same drag-and-drop editor as the ticket confirmation email — click "Edit waitlist email" to open it.`,
        ],
    },
    'waitlist.claimEmail': {
        title: 'Spot Available Email',
        summary: 'Sent when a waitlisted person is promoted on a paid event, with the link to claim their reserved seat.',
        details: [
            `Only sent for paid events — a free event's promotion issues the ticket directly through the normal ticket-confirmation email instead, so this one never fires there.`,
            `Fully customizable in the same drag-and-drop editor, on its own "Spot Available" tab.`,
        ],
    },
    'waitlist.table': {
        title: 'Waitlist Entries',
        summary: 'Everyone currently on the list, searchable by name or email, filterable by status, and sortable by clicking a column header.',
        details: [
            `<strong>Waiting</strong> — hasn't been offered a spot yet. <strong>Spot offered</strong> — promoted on a paid event and waiting on them to claim it before the window runs out. <strong>Converted to ticket</strong> — successfully seated. <strong>Offer expired</strong> — a claim window lapsed unclaimed (their seat has already moved on to someone else).`,
            `Select several rows with the checkboxes to remove them all at once.`,
            `Promote seats someone immediately (or reserves their spot, for a paid event); Remove takes them off the list entirely with no notification sent.`,
        ],
    },
    'waitlist.noShowRelease': {
        title: 'Release No-Show Tickets to the Waitlist',
        summary: 'Cancels a chosen number of not-yet-checked-in tickets and offers those freed seats to the waitlist, oldest-waiting first.',
        details: [
            `Only appears once the event has actually started — this is meant for "the event is underway and some people clearly aren't coming," not for use beforehand.`,
            `Cancels whole registrations, not partial ones — a family of 4 registered together is released as one unit if any of it is released.`,
            `Never touches a checked-in ticket — only ones that haven't shown up yet are eligible.`,
            `Requires both ticket-management and waitlist-management permissions, since it's genuinely two different actions at once: cancelling someone's ticket, and deciding who gets the freed seat.`,
        ],
    },
    'waitlist.capacityRelease': {
        title: 'Increase Capacity for the Waitlist',
        summary: 'Raises the event\'s capacity and immediately hands that many new spots to the longest-waiting people — a free event gets a ticket directly, a paid event gets a claim link.',
        details: [
            `Automatically capped at how many people are actually waiting — you can't over-release past the size of the list.`,
            `Requires both event-editing and waitlist-management permissions, for the same two-actions-at-once reason as the no-show release above.`,
        ],
    },
};
