# Event groups and cross-event attendee identity

Design notes. Nothing here is built yet.

The idea: let an account put several events into a **group** (a season, a tour, a
conference with satellite sessions), recognise the same person across those events by
email, answer "who came to more than one of these", and optionally give each person one
reusable code they can present at any event in the group.

These are three separable features with very different costs, and they should ship in
that order.

## The constraint everything else follows from

`tickets.eventId` is load-bearing. It is not just a foreign key — it is the grain the
rest of the system is defined on:

- capacity goes through `eventSeatUsage()`, which counts tickets *for one event*
- check-in state is `used_at` / `reentry_status` **on the ticket row**
- scan authorization is `scannerAuthorized(req, ticket.eventId)`
- ticket expiry, waitlist claims, orders, refunds and Apple Wallet passes all key off it
- `/api/validate` deliberately refuses a ticket presented at the wrong event
  (`server.js`, the `req.body.eventId !== ticket.eventId` guard)

So the tempting version of "one code for multiple events" — make a ticket span events —
is the wrong shape. `used_at` immediately becomes meaningless (checked in *where*?),
per-event capacity has nothing to count, a pkpass has no single event to render, and the
wrong-event guard has to be deleted, which is a real security control.

**A ticket stays 1:1 with an event. Always.** The reusable code is a separate thing that
*resolves to* a ticket; see part 3.

## Part 1 — Groups

```sql
CREATE TABLE IF NOT EXISTS eventGroups (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,          -- owner; see the permission note below
    name TEXT,
    linkAttendees INTEGER DEFAULT 1,
    createdAt TEXT
);
ALTER TABLE events ADD COLUMN groupId TEXT;   -- NULL = ungrouped, behaves exactly as today
CREATE INDEX IF NOT EXISTS idx_events_group ON events(groupId);
```

Follow the existing migration style in `db-sqlite.js`: `try { db.exec('ALTER TABLE …') }
catch {}` with a comment saying what NULL means.

Routes: `POST/GET/PUT/DELETE /api/groups`, plus `PUT /api/event/:id/group` to set or
clear membership. Deleting a group must never delete events — it only clears `groupId`.

### The permission trap, and the rule that avoids it

Events are shareable. A collaborator can hold capabilities on event A and nothing at all
on event B. If both are in one group and the group view is readable by anyone with access
to *any* member event, then adding an event to a group silently hands that collaborator
attendee data from every other event in it. That is a data leak created by an organiser
action that does not look like a sharing action.

**Rule: group-level reads (`/api/group/:id/*`) are owner-only, plus the admin.** Putting
an event into a group requires `manage_event` on the event *and* ownership of the group.
Nothing about an event's own routes changes — a collaborator on event A sees event A
exactly as they do today, and sees no group data at all.

If per-collaborator group access is wanted later, the safe form is to intersect: return
only rows for events the caller holds `export_data` on. Do not start there; start
owner-only.

## Part 2 — Cross-event attendee view

Read-only. Touches no write path, so it cannot regress capacity, check-in or email.

```sql
CREATE TABLE IF NOT EXISTS groupPeople (
    id TEXT PRIMARY KEY,
    groupId TEXT NOT NULL,
    emailKey TEXT NOT NULL,        -- normalised; the match key
    email TEXT,                    -- raw, as first seen
    name TEXT,                     -- most recent non-empty
    code TEXT UNIQUE,              -- part 3; nanoid(12)
    createdAt TEXT,
    UNIQUE(groupId, emailKey)
);
ALTER TABLE tickets ADD COLUMN personId TEXT;
CREATE INDEX IF NOT EXISTS idx_tickets_person ON tickets(personId);
```

`tickets.personId` is a denormalisation, but a deliberate one: it records who the ticket
was linked to **at issue time**, so later edits to a ticket's email or a change of group
membership do not silently rewrite history in the reports.

### Normalisation

`emailKey = email.trim().toLowerCase()`. That is all.

`/api/register` already lowercases on insert, but the import paths (CSV, sheet watcher,
API, at-door) pass through whatever arrived — so this must be a shared helper applied at
match time, not an assumption about the column.

**Rejected:** stripping plus-addressing and Gmail dots. It merges two addresses a person
chose to keep distinct, and the failure is silent and unfixable from the UI. Two people
sharing one household address will already merge; that is inherent to matching on email
and should be stated in the UI rather than engineered around.

Treat a match as "probably the same person" — good enough for counts, an export and a
door badge. It is *not* good enough to be an entitlement, which is why part 3 issues a
code at registration rather than inferring identity at scan time.

### Routes

| Route | Returns |
|---|---|
| `GET /api/group/:id/attendees` | paginated people: events registered, events attended, first/last seen |
| `GET /api/group/:id/overlap` | per event-pair shared counts, plus an "attended N of M" histogram |
| `GET /api/group/:id/export` | the same as CSV |

All owner-only. All read from `groupPeople` joined to `tickets` by `personId`, falling
back to `emailKey` for rows issued before the group existed.

### Backfill

When an event joins a group, upsert `groupPeople` from its existing tickets and set
`personId` on them. One pass, in a transaction, at the moment of joining — so the view is
correct immediately rather than only for future registrations.

## Part 3 — One reusable code across the group

The code is a **lookup, never an entitlement.** It resolves to a ticket that already
exists; it can never create one, and so it can never oversell.

QR payload: `person:<code>`, alongside the existing `ticket:<token>` form.

In `/api/validate`:

1. If the token starts with `person:`, **require** `req.body.eventId`. Every current
   scanning client (web scanner, checkin, iOS `validateTicket`) already sends it. A caller
   that does not send one gets a 400 — do not guess an event.
2. Resolve the code to a `groupPeople` row, then to that person's ticket where
   `eventId = req.body.eventId`.
3. Hand that ticket to the **existing, unmodified** validate path — auth check, expiry,
   re-entry, `used_at`, wallet push, `recordScan`. Every invariant survives untouched.
4. If the person has no ticket for this event, return a new status `no_ticket`, not
   `invalid`. It is a different situation and it is actionable: they are in the series,
   just not on tonight's list, and staff can issue at the door from there. `scanner.html`
   and `DisplayView` need a case for it.

The wrong-event guard becomes moot on this path, because the ticket was resolved *by*
event rather than checked against one afterwards. `validateLimiter` already covers the
route.

### Where the code gets attached

Every path that issues a ticket must upsert the person and set `personId` — same
discipline, and the same list, as the holds rule in `CLAUDE.md`: `/api/register`,
`issueTicketForPayment()` (Stripe webhook), manual add, CSV import, sheet watcher,
at-door, and the `/api/v1` write routes. A path that skips it does not corrupt anything,
it just leaves a person invisible to the group view — a quiet failure, which is exactly
why it should be one shared helper called from all of them rather than seven call sites.

Gate on `event.groupId && group.linkAttendees`.

### Deliberately out of scope for a first cut

- **A wallet pass for the person code.** A pkpass needs one event to render; a group pass
  is a different pass type and a different problem. Per-event passes keep working.
- **Putting the code in the ticket email.** Worth doing eventually, but it changes every
  template and wants its own thought about what the attendee is told it means.

## Privacy

Groups are per-account, so linking never crosses organisers. But someone who registered
for event A did not agree to being recognised by name at event B's door. `linkAttendees`
is the switch; the honest default is on for the group's own reporting, with the door-side
"3rd time here" badge as a separate, off-by-default setting. Worth a line in the privacy
policy either way.

## Anything that ships here also needs

- entries in `public/help-content.js`, in the same commit — per `CLAUDE.md`, that is where
  this documentation lives
- `public/api.html` updated if any of it lands under `/api/v1`; `test/pages.test.js` fails
  otherwise
- a new `test/event-groups.test.js` covering, at minimum: the owner-only permission
  boundary (a collaborator on one member event gets 403 on group routes), person-code
  resolution including `no_ticket`, that a person code cannot oversell, and that a normal
  ticket token through `/api/validate` behaves identically to today

## Open questions

- When a ticket's email is edited to one already in the group, does it re-link, or keep
  its original `personId`? (Leaning: re-link, and audit-log it.)
- Should a group be shareable in its own right, with its own capability?
- Should `no_ticket` at the door offer a one-tap at-door issue, or just report?
- Does an event ever belong to more than one group? (Leaning: no. A single nullable
  `groupId` is a much smaller surface than a join table, and nothing here needs more.)
