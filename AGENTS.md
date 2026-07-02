# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Aider, etc.) working in this repo.
The full project guidance lives in `CLAUDE.md`. This file mirrors the conventions every agent should follow regardless of which tool is in use.

## House style

- **No emojis** in code, UI text, comments, commit messages, or generated files unless the user explicitly asks or there is genuinely no alternative. Prefer inline SVG icons (the codebase already uses them widely in `scanner.html`, `checkin.html`, `dashboard.html`, etc.) or plain text labels. When editing existing UI that already contains emojis, do not add more — leave the existing ones in place unless asked to clean them up.

See `CLAUDE.md` for the rest of the project structure, build commands, and architectural notes.

---

## 2026-07-02 Audit — Security, Cleanup, Bugs Fixed

Full pass over the repo for cruft, security, and UI correctness (same treatment given to
`singlink` the same day — see that repo's `AGENTS.md` for comparison). Findings below so a
future session doesn't have to re-derive them.

### Repo cleanup
- Untracked (kept on disk, just stopped version-controlling): `db-migrated.flag` (a
  runtime migration marker written by `db-sqlite.js` — tracking it in git means a fresh
  clone/deploy inherits a stale "already migrated" flag, which is wrong), `screenshot.png`
  (a 743×23px non-meaningful debug image, not a real screenshot), and
  `.claude/worktrees/eloquent-curie` (a **dangling git submodule reference** — mode
  `160000`, no `.gitmodules` — left behind from a git worktree operation in a past session;
  classic footgun where `git add`-ing a directory that itself contains a `.git` folder
  silently records a gitlink instead of the directory's contents).
- Untracked `pass.json` at the repo root — a dead, unused duplicate of the real Apple
  Wallet pass template at `pass-assets.pass/pass.json` (server.js only ever reads the
  latter; grep for `'pass.json'` to confirm before assuming either copy matters).
- `convert-certs.js` and `google-sheets-script.gs` were reviewed and kept — both are
  legitimate manual/external utility scripts (cert conversion tool, Google Apps Script glue
  for the sheet-import flow), not dead code, even though neither is invoked by `server.js`
  directly.

### Security findings
- **`SESSION_SECRET`, JWT-equivalent auth**: already done right — `session()` config throws
  at startup if `SESSION_SECRET` is unset (no insecure fallback), cookies are
  `httpOnly` + `sameSite: strict` + `secure` in production. Don't "fix" this, it's fine.
- **Confirmed stored XSS, fixed**: `public/dashboard.html`'s shared `esc()` helper only
  escaped `& < >`, not `"` or `'`. It's used to render values into `value="${esc(...)}"`
  HTML attributes — including `ticketValues[k]` custom-field answers that **anonymous
  attendees submit through the public `/api/register` endpoint** (see `server.js` around
  the `customFields` handling, ~line 1197). A registrant could submit a custom field value
  like `" onfocus="autofocus" onblur="fetch(...)` and have it execute inside the event
  organizer's authenticated dashboard session the next time they viewed/edited that ticket.
  Fixed by switching `esc()` to escape all five `& < > " '` characters, matching the
  (correct) `escape()`/`escHtml()`/`escAttr()` implementations already used in
  `at-door.html`, `kiosk.html`, `checkin.html`, and `scanner.html` — those were never
  vulnerable. `public/monitor.html`'s `esc()` had the same gap (missing `'` only) and was
  fixed the same way for consistency, though no confirmed exploit path was found there.
- **`/api/auth/setup-admin`**: creates the one-and-only admin account for `ADMIN_EMAIL`
  with a password anyone can submit, no rate limit, no auth required — a "race to claim
  admin" window on first deploy. **Not currently exploitable**: confirmed live that
  production already has an admin account, so the endpoint permanently returns "Admin
  account already exists" now. Added `loginLimiter` to it anyway for defense-in-depth /
  consistency with every other auth route. If this project is ever redeployed fresh, claim
  that endpoint immediately after first boot, before the URL is shared anywhere.
- SQL injection surface reviewed — all dynamic `IN (...)` clause construction only
  interpolates `?` placeholder counts, never raw values; actual data is always bound via
  `.run()/.get()/.all()` args. No issues found.
- Reflected-XSS check on `/api/auth/verify/:token` and similar token-echo endpoints — all
  error messages are static strings, never echo the token or other user input back. Clean.

### Bug fixed
- `public/support.html` had the **entire privacy policy pasted inline** below its own
  contact-info card, duplicating all six sections of `public/privacy.html` word-for-word,
  alongside a redundant "View the full policy" link to the very page it was duplicating.
  Trimmed `support.html` back down to just the support contact card + link. If the privacy
  policy ever needs updating, `privacy.html` is now the only place to do it.

### Reviewed and found OK
- Login page and other public auth pages looked broken in one screenshot (card pinned to
  the corner with a large empty void) at a 1280×800 preview viewport — this was a **preview
  tool rendering artifact**, not a real bug (same class of issue hit earlier with
  `moviepicker`'s viewport). Confirmed via computed-style inspection that the layout centers
  correctly, and it renders correctly at 800×600. Don't waste time chasing this again if a
  future screenshot at a wide viewport looks similarly "broken" — verify with
  `preview_inspect` bounding boxes before assuming a CSS bug.
