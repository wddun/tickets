import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const db = new Database(path.join(__dirname, 'tickets.db'));

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT,
    emailVerified INTEGER DEFAULT 0,
    verifyToken TEXT,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    name TEXT,
    time TEXT,
    endTime TEXT,
    color TEXT,
    imageUrl TEXT,
    scannerPin TEXT,
    location TEXT,
    allowReentry INTEGER DEFAULT 0,
    capacity INTEGER,
    displayToken TEXT,
    reminderEnabled INTEGER DEFAULT 0,
    reminderMessage TEXT,
    reminderHoursBefore INTEGER DEFAULT 24,
    reminderSentAt TEXT,
    customFields TEXT,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    eventId TEXT NOT NULL,
    token TEXT UNIQUE,
    registrationId TEXT,
    name TEXT,
    firstName TEXT,
    lastName TEXT,
    email TEXT,
    customFields TEXT,
    used_at TEXT,
    reentry_status TEXT,
    passHash TEXT,
    updated_at TEXT,
    created_at TEXT,
    wallet_downloaded_at TEXT,
    email_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS sheetLinks (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE,
    spreadsheetId TEXT,
    sheetName TEXT,
    eventId TEXT,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS sheetAccess (
    id TEXT PRIMARY KEY,
    userId TEXT,
    sheetLinkId TEXT,
    claimedAt TEXT,
    permission TEXT DEFAULT 'view'
);

CREATE TABLE IF NOT EXISTS walletDevices (
    id TEXT PRIMARY KEY,
    deviceId TEXT,
    passTypeId TEXT,
    serialNumber TEXT,
    pushToken TEXT,
    registeredAt TEXT
);

CREATE TABLE IF NOT EXISTS pushDevices (
    id TEXT PRIMARY KEY,
    userId TEXT,
    token TEXT UNIQUE,
    createdAt TEXT,
    lastSeenAt TEXT
);

CREATE TABLE IF NOT EXISTS pushSubscriptions (
    id TEXT PRIMARY KEY,
    userId TEXT,
    eventId TEXT,
    enabled INTEGER DEFAULT 1,
    createdAt TEXT,
    updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS passwordResetTokens (
    id TEXT PRIMARY KEY,
    userId TEXT,
    tokenHash TEXT UNIQUE,
    expiresAt TEXT,
    createdAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_token ON tickets(token);
CREATE INDEX IF NOT EXISTS idx_tickets_registrationId ON tickets(registrationId);
CREATE INDEX IF NOT EXISTS idx_tickets_eventId ON tickets(eventId);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_events_userId ON events(userId);
CREATE INDEX IF NOT EXISTS idx_events_displayToken ON events(displayToken);
CREATE INDEX IF NOT EXISTS idx_walletDevices_serial ON walletDevices(serialNumber);
CREATE INDEX IF NOT EXISTS idx_walletDevices_deviceId ON walletDevices(deviceId);
CREATE INDEX IF NOT EXISTS idx_pushSubs_userEvent ON pushSubscriptions(userId, eventId);
CREATE INDEX IF NOT EXISTS idx_sheetLinks_eventId ON sheetLinks(eventId);
CREATE INDEX IF NOT EXISTS idx_sheetAccess_linkId ON sheetAccess(sheetLinkId);
CREATE INDEX IF NOT EXISTS idx_sheetAccess_userId ON sheetAccess(userId);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    sessionId TEXT UNIQUE,
    eventId TEXT,
    registrationId TEXT,
    buyerName TEXT,
    buyerEmail TEXT,
    amount INTEGER,
    currency TEXT DEFAULT 'usd',
    status TEXT DEFAULT 'pending',
    createdAt TEXT,
    fulfilledAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_sessionId ON orders(sessionId);
CREATE INDEX IF NOT EXISTS idx_orders_eventId ON orders(eventId);

CREATE TABLE IF NOT EXISTS auditLog (
    id TEXT PRIMARY KEY,
    userId TEXT,
    userEmail TEXT,
    eventId TEXT,
    action TEXT NOT NULL,
    details TEXT,
    ip TEXT,
    createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auditLog_eventId ON auditLog(eventId);
CREATE INDEX IF NOT EXISTS idx_auditLog_userId ON auditLog(userId);
CREATE INDEX IF NOT EXISTS idx_auditLog_createdAt ON auditLog(createdAt);

CREATE TABLE IF NOT EXISTS discountCodes (
    id TEXT PRIMARY KEY,
    eventId TEXT NOT NULL,
    code TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'percent',
    value INTEGER NOT NULL,
    maxUses INTEGER,
    usedCount INTEGER DEFAULT 0,
    expiresAt TEXT,
    active INTEGER DEFAULT 1,
    createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discountCodes_event_code ON discountCodes(eventId, code);

CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY,
    eventId TEXT NOT NULL,
    name TEXT,
    email TEXT NOT NULL,
    customFields TEXT,
    status TEXT NOT NULL DEFAULT 'waiting',
    createdAt TEXT NOT NULL,
    notifiedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_waitlist_eventId ON waitlist(eventId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_event_email ON waitlist(eventId, email);

-- No-login scanner access: anyone holding the token can scan/check in tickets
-- for exactly this one event (nothing else — no dashboard, no other events).
-- Multiple links per event so each staffer/device can be named and revoked
-- independently, rather than everyone sharing one link/credential.
CREATE TABLE IF NOT EXISTS scannerLinks (
    id TEXT PRIMARY KEY,
    eventId TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    createdBy TEXT,
    createdAt TEXT NOT NULL,
    lastUsedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_scannerLinks_token ON scannerLinks(token);
CREATE INDEX IF NOT EXISTS idx_scannerLinks_eventId ON scannerLinks(eventId);
`);

// ── Column migrations ─────────────────────────────────────────────────────────
try { db.exec(`ALTER TABLE events ADD COLUMN allowPublicRegistration INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE events ADD COLUMN ticketPrice INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE events ADD COLUMN atDoorEnabled INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE orders ADD COLUMN paymentIntentId TEXT`); } catch {}
try { db.exec(`ALTER TABLE orders ADD COLUMN channel TEXT DEFAULT 'online'`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_paymentIntentId ON orders(paymentIntentId)`); } catch {}
try { db.exec(`ALTER TABLE sheetLinks ADD COLUMN apiKey TEXT`); } catch {}
try { db.exec(`ALTER TABLE orders ADD COLUMN discountCodeId TEXT`); } catch {}
try { db.exec(`ALTER TABLE orders ADD COLUMN discountAmount INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE orders ADD COLUMN refundedAt TEXT`); } catch {}
try { db.exec(`ALTER TABLE orders ADD COLUMN refundAmount INTEGER`); } catch {}
try { db.exec(`ALTER TABLE events ADD COLUMN waitlistEnabled INTEGER DEFAULT 0`); } catch {}
// Shuttle linking: lets an external system (a linked shuttle/bus app room)
// read-only check tickets for this event via /api/ticket-check, using the
// same ticket the rider already has — without ever touching used_at. Only
// meant for events whose tickets are exclusively for shuttle use; never
// enable on an event whose tickets are also scanned at a door by /api/validate,
// since "boarded the bus" and "entered the venue" need to stay independent.
try { db.exec(`ALTER TABLE events ADD COLUMN shuttleLinkEnabled INTEGER DEFAULT 0`); } catch {}
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ticketScans (
            id TEXT PRIMARY KEY,
            ticketId TEXT NOT NULL,
            eventId TEXT NOT NULL,
            scannedAt TEXT NOT NULL,
            source TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ticketScans_ticketId ON ticketScans(ticketId);
        CREATE INDEX IF NOT EXISTS idx_ticketScans_eventId ON ticketScans(eventId);
    `);
} catch {}

// ── One-time migration from db.json ──────────────────────────────────────────

const migrationFlag = path.join(__dirname, 'db-migrated.flag');
const legacyDb = path.join(__dirname, 'db.json');

if (!fs.existsSync(migrationFlag) && fs.existsSync(legacyDb)) {
    console.log('[migration] Starting migration from db.json...');
    try {
        const raw = JSON.parse(fs.readFileSync(legacyDb, 'utf8'));

        const insertUser = db.prepare(`INSERT OR IGNORE INTO users (id, email, password, emailVerified, verifyToken, createdAt) VALUES (?,?,?,?,?,?)`);
        const insertEvent = db.prepare(`INSERT OR IGNORE INTO events (id, userId, name, time, endTime, color, imageUrl, scannerPin, location, allowReentry, capacity, displayToken, reminderEnabled, reminderMessage, reminderHoursBefore, reminderSentAt, customFields, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const insertTicket = db.prepare(`INSERT OR IGNORE INTO tickets (id, eventId, token, registrationId, name, firstName, lastName, email, customFields, used_at, reentry_status, passHash, updated_at, created_at, wallet_downloaded_at, email_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const insertSheetLink = db.prepare(`INSERT OR IGNORE INTO sheetLinks (id, token, spreadsheetId, sheetName, eventId, createdAt) VALUES (?,?,?,?,?,?)`);
        const insertSheetAccess = db.prepare(`INSERT OR IGNORE INTO sheetAccess (id, userId, sheetLinkId, claimedAt, permission) VALUES (?,?,?,?,?)`);
        const insertWalletDevice = db.prepare(`INSERT OR IGNORE INTO walletDevices (id, deviceId, passTypeId, serialNumber, pushToken, registeredAt) VALUES (?,?,?,?,?,?)`);
        const insertPushDevice = db.prepare(`INSERT OR IGNORE INTO pushDevices (id, userId, token, createdAt, lastSeenAt) VALUES (?,?,?,?,?)`);
        const insertPushSub = db.prepare(`INSERT OR IGNORE INTO pushSubscriptions (id, userId, eventId, enabled, createdAt, updatedAt) VALUES (?,?,?,?,?,?)`);
        const insertPwdToken = db.prepare(`INSERT OR IGNORE INTO passwordResetTokens (id, userId, tokenHash, expiresAt, createdAt) VALUES (?,?,?,?,?)`);

        const migrate = db.transaction(() => {
            let counts = {};

            counts.users = 0;
            for (const u of (raw.users || [])) {
                insertUser.run(u.id, u.email, u.password, u.emailVerified ? 1 : 0, u.verifyToken || null, u.createdAt || null);
                counts.users++;
            }

            counts.events = 0;
            for (const e of (raw.events || [])) {
                insertEvent.run(
                    e.id, e.userId, e.name, e.time, e.endTime || null, e.color || null,
                    e.imageUrl || null, e.scannerPin || null,
                    e.location ? JSON.stringify(e.location) : null,
                    e.allowReentry ? 1 : 0, e.capacity || null, e.displayToken || null,
                    e.reminderEnabled ? 1 : 0, e.reminderMessage || null,
                    e.reminderHoursBefore ?? 24, e.reminderSentAt || null,
                    e.customFields ? JSON.stringify(e.customFields) : null,
                    e.createdAt || null
                );
                counts.events++;
            }

            counts.tickets = 0;
            for (const t of (raw.tickets || [])) {
                insertTicket.run(
                    t.id, t.eventId, t.token, t.registrationId || null,
                    t.name || null, t.firstName || null, t.lastName || null, t.email || null,
                    t.customFields ? JSON.stringify(t.customFields) : null,
                    t.used_at || null, t.reentry_status || null, t.passHash || null,
                    t.updated_at || null, t.created_at || null,
                    t.wallet_downloaded_at || null, t.email_opened_at || null
                );
                counts.tickets++;
            }

            counts.sheetLinks = 0;
            for (const l of (raw.sheetLinks || [])) {
                insertSheetLink.run(l.id, l.token, l.spreadsheetId, l.sheetName || null, l.eventId || null, l.createdAt || null);
                counts.sheetLinks++;
            }

            counts.sheetAccess = 0;
            for (const a of (raw.sheetAccess || [])) {
                insertSheetAccess.run(a.id, a.userId, a.sheetLinkId, a.claimedAt || null, a.permission || 'view');
                counts.sheetAccess++;
            }

            counts.walletDevices = 0;
            for (const d of (raw.walletDevices || [])) {
                insertWalletDevice.run(d.id, d.deviceId, d.passTypeId || null, d.serialNumber, d.pushToken, d.registeredAt || null);
                counts.walletDevices++;
            }

            counts.pushDevices = 0;
            for (const d of (raw.pushDevices || [])) {
                insertPushDevice.run(d.id, d.userId, d.token, d.createdAt || null, d.lastSeenAt || null);
                counts.pushDevices++;
            }

            counts.pushSubscriptions = 0;
            for (const s of (raw.pushSubscriptions || [])) {
                insertPushSub.run(s.id, s.userId, s.eventId, s.enabled ? 1 : 0, s.createdAt || null, s.updatedAt || null);
                counts.pushSubscriptions++;
            }

            counts.passwordResetTokens = 0;
            for (const t of (raw.passwordResetTokens || [])) {
                insertPwdToken.run(t.id, t.userId, t.tokenHash, t.expiresAt, t.createdAt || null);
                counts.passwordResetTokens++;
            }

            return counts;
        });

        const counts = migrate();
        fs.writeFileSync(migrationFlag, new Date().toISOString());
        console.log(`[migration] Complete — tickets: ${counts.tickets}, users: ${counts.users}, events: ${counts.events}, sheetLinks: ${counts.sheetLinks}, walletDevices: ${counts.walletDevices}`);
    } catch (err) {
        console.error('[migration] FAILED:', err.message);
        console.error('[migration] db.json is intact — fix the error and restart to retry');
        process.exit(1);
    }
}

// ── Row-to-object converters ───────────────────────────────────────────────────

export function rowToTicket(row) {
    if (!row) return null;
    return {
        ...row,
        customFields: row.customFields ? JSON.parse(row.customFields) : {},
    };
}

export function rowToEvent(row) {
    if (!row) return null;
    return {
        ...row,
        location: row.location ? JSON.parse(row.location) : null,
        allowReentry: !!row.allowReentry,
        allowPublicRegistration: !!row.allowPublicRegistration,
        ticketPrice: row.ticketPrice || 0,
        atDoorEnabled: !!row.atDoorEnabled,
        reminderEnabled: !!row.reminderEnabled,
        waitlistEnabled: !!row.waitlistEnabled,
        shuttleLinkEnabled: !!row.shuttleLinkEnabled,
        customFields: row.customFields ? JSON.parse(row.customFields) : null,
    };
}

export function rowToUser(row) {
    if (!row) return null;
    return { ...row, emailVerified: !!row.emailVerified };
}

export function rowToDiscountCode(row) {
    if (!row) return null;
    return { ...row, active: !!row.active };
}

export function rowToWaitlistEntry(row) {
    if (!row) return null;
    return {
        ...row,
        customFields: row.customFields ? JSON.parse(row.customFields) : {},
    };
}

// ── Prepared statements ────────────────────────────────────────────────────────

export const stmt = {
    users: {
        byId: db.prepare('SELECT * FROM users WHERE id = ?'),
        byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
        byVerifyToken: db.prepare('SELECT * FROM users WHERE verifyToken = ?'),
        all: db.prepare('SELECT * FROM users'),
        insert: db.prepare(`INSERT INTO users (id, email, password, emailVerified, verifyToken, createdAt) VALUES (?,?,?,?,?,?)`),
        setVerified: db.prepare(`UPDATE users SET emailVerified = 1, verifyToken = NULL WHERE id = ?`),
        setVerifyToken: db.prepare(`UPDATE users SET verifyToken = ? WHERE email = ?`),
        setPassword: db.prepare(`UPDATE users SET password = ? WHERE id = ?`),
        deleteById: db.prepare(`DELETE FROM users WHERE id = ?`),
    },
    events: {
        byId: db.prepare('SELECT * FROM events WHERE id = ?'),
        byDisplayToken: db.prepare('SELECT * FROM events WHERE displayToken = ?'),
        byUserId: db.prepare('SELECT * FROM events WHERE userId = ?'),
        all: db.prepare('SELECT * FROM events'),
        insert: db.prepare(`INSERT INTO events (id, userId, name, time, endTime, color, imageUrl, scannerPin, location, allowReentry, capacity, displayToken, reminderEnabled, reminderMessage, reminderHoursBefore, reminderSentAt, customFields, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
        update: db.prepare(`UPDATE events SET name=?, time=?, endTime=?, color=?, imageUrl=?, allowReentry=?, capacity=?, location=? WHERE id=?`),
        updateFull: db.prepare(`UPDATE events SET name=?, time=?, endTime=?, color=?, imageUrl=?, allowReentry=?, capacity=?, location=?, reminderEnabled=?, reminderMessage=?, reminderHoursBefore=?, reminderSentAt=?, customFields=?, scannerPin=? WHERE id=?`),
        setDisplayToken: db.prepare(`UPDATE events SET displayToken=? WHERE id=?`),
        setReminderSentAt: db.prepare(`UPDATE events SET reminderSentAt=? WHERE id=?`),
        setReminder: db.prepare(`UPDATE events SET reminderEnabled=?, reminderMessage=?, reminderHoursBefore=?, reminderSentAt=? WHERE id=?`),
        setCustomFields: db.prepare(`UPDATE events SET customFields=? WHERE id=?`),
        setImageUrl: db.prepare(`UPDATE events SET imageUrl=? WHERE id=?`),
        setPublicRegistration: db.prepare(`UPDATE events SET allowPublicRegistration=? WHERE id=?`),
        setTicketPrice: db.prepare(`UPDATE events SET ticketPrice=? WHERE id=?`),
        setAtDoorEnabled: db.prepare(`UPDATE events SET atDoorEnabled=? WHERE id=?`),
        setWaitlistEnabled: db.prepare(`UPDATE events SET waitlistEnabled=? WHERE id=?`),
        setShuttleLinkEnabled: db.prepare(`UPDATE events SET shuttleLinkEnabled=? WHERE id=?`),
        setSheetFields: db.prepare(`UPDATE events SET name=?, time=?, endTime=?, color=?, location=? WHERE id=?`),
        setOwner: db.prepare(`UPDATE events SET userId=? WHERE id=?`),
        deleteById: db.prepare(`DELETE FROM events WHERE id=?`),
        deleteByUserId: db.prepare(`DELETE FROM events WHERE userId=?`),
        reminderDue: db.prepare(`SELECT * FROM events WHERE reminderEnabled=1 AND reminderSentAt IS NULL`),
    },
    tickets: {
        byToken: db.prepare('SELECT * FROM tickets WHERE token = ?'),
        byId: db.prepare('SELECT * FROM tickets WHERE id = ?'),
        byRegistrationId: db.prepare('SELECT * FROM tickets WHERE registrationId = ?'),
        firstByRegistrationId: db.prepare('SELECT * FROM tickets WHERE registrationId = ? LIMIT 1'),
        firstByRegistrationIdOrId: db.prepare('SELECT * FROM tickets WHERE registrationId = ? OR id = ? LIMIT 1'),
        byEventId: db.prepare('SELECT * FROM tickets WHERE eventId = ?'),
        countByEventId: db.prepare('SELECT COUNT(*) as cnt FROM tickets WHERE eventId = ?'),
        insert: db.prepare(`INSERT INTO tickets (id, eventId, token, registrationId, name, firstName, lastName, email, customFields, used_at, reentry_status, passHash, updated_at, created_at, wallet_downloaded_at, email_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
        updateInfo: db.prepare(`UPDATE tickets SET name=?, firstName=?, lastName=?, email=?, customFields=? WHERE id=?`),
        checkIn: db.prepare(`UPDATE tickets SET used_at=?, updated_at=? WHERE id=?`),
        checkInReentry: db.prepare(`UPDATE tickets SET used_at=?, updated_at=?, reentry_status='inside' WHERE id=?`),
        reentryEnter: db.prepare(`UPDATE tickets SET reentry_status='inside', updated_at=? WHERE id=?`),
        reentryExit: db.prepare(`UPDATE tickets SET reentry_status='outside', updated_at=? WHERE id=?`),
        undoCheckIn: db.prepare(`UPDATE tickets SET used_at=NULL, reentry_status=NULL, updated_at=? WHERE id=?`),
        setPassHash: db.prepare(`UPDATE tickets SET passHash=?, updated_at=? WHERE id=?`),
        setWalletDownloaded: db.prepare(`UPDATE tickets SET wallet_downloaded_at=? WHERE token=?`),
        setEmailOpened: db.prepare(`UPDATE tickets SET email_opened_at=? WHERE registrationId=? AND email_opened_at IS NULL`),
        deleteById: db.prepare(`DELETE FROM tickets WHERE id=?`),
        deleteByEventId: db.prepare(`DELETE FROM tickets WHERE eventId=?`),
    },
    ticketScans: {
        insert: db.prepare(`INSERT INTO ticketScans (id, ticketId, eventId, scannedAt, source) VALUES (?,?,?,?,?)`),
        countByTicket: db.prepare(`SELECT COUNT(*) as cnt FROM ticketScans WHERE ticketId=?`),
        lastByTicket: db.prepare(`SELECT * FROM ticketScans WHERE ticketId=? ORDER BY scannedAt DESC LIMIT 1`),
        byEventId: db.prepare(`SELECT * FROM ticketScans WHERE eventId=? ORDER BY scannedAt DESC`),
    },
    walletDevices: {
        byDeviceAndSerial: db.prepare(`SELECT * FROM walletDevices WHERE deviceId=? AND serialNumber=?`),
        byDeviceId: db.prepare(`SELECT * FROM walletDevices WHERE deviceId=?`),
        insert: db.prepare(`INSERT INTO walletDevices (id, deviceId, passTypeId, serialNumber, pushToken, registeredAt) VALUES (?,?,?,?,?,?)`),
        setPushToken: db.prepare(`UPDATE walletDevices SET pushToken=? WHERE deviceId=? AND serialNumber=?`),
        delete: db.prepare(`DELETE FROM walletDevices WHERE deviceId=? AND serialNumber=?`),
        deleteByPushToken: db.prepare(`DELETE FROM walletDevices WHERE pushToken=?`),
    },
    pushDevices: {
        byToken: db.prepare('SELECT * FROM pushDevices WHERE token=?'),
        byUserId: db.prepare('SELECT * FROM pushDevices WHERE userId=?'),
        insert: db.prepare(`INSERT INTO pushDevices (id, userId, token, createdAt, lastSeenAt) VALUES (?,?,?,?,?)`),
        upsert: db.prepare(`UPDATE pushDevices SET userId=?, lastSeenAt=? WHERE token=?`),
        deleteByToken: db.prepare(`DELETE FROM pushDevices WHERE token=?`),
        deleteByUserId: db.prepare(`DELETE FROM pushDevices WHERE userId=?`),
    },
    pushSubscriptions: {
        byUserAndEvent: db.prepare('SELECT * FROM pushSubscriptions WHERE userId=? AND eventId=?'),
        byEventEnabled: db.prepare('SELECT * FROM pushSubscriptions WHERE eventId=? AND enabled=1'),
        insert: db.prepare(`INSERT INTO pushSubscriptions (id, userId, eventId, enabled, createdAt, updatedAt) VALUES (?,?,?,?,?,?)`),
        setEnabled: db.prepare(`UPDATE pushSubscriptions SET enabled=?, updatedAt=? WHERE userId=? AND eventId=?`),
        deleteByEventId: db.prepare(`DELETE FROM pushSubscriptions WHERE eventId=?`),
        deleteByUserId: db.prepare(`DELETE FROM pushSubscriptions WHERE userId=?`),
    },
    sheetLinks: {
        bySpreadsheetId: db.prepare('SELECT * FROM sheetLinks WHERE spreadsheetId=?'),
        byToken: db.prepare('SELECT * FROM sheetLinks WHERE token=?'),
        byEventId: db.prepare('SELECT * FROM sheetLinks WHERE eventId=?'),
        byId: db.prepare('SELECT * FROM sheetLinks WHERE id=?'),
        insert: db.prepare(`INSERT INTO sheetLinks (id, token, spreadsheetId, sheetName, eventId, createdAt, apiKey) VALUES (?,?,?,?,?,?,?)`),
        update: db.prepare(`UPDATE sheetLinks SET eventId=?, sheetName=? WHERE id=?`),
        setApiKey: db.prepare(`UPDATE sheetLinks SET apiKey=? WHERE id=?`),
    },
    scannerLinks: {
        byToken: db.prepare('SELECT * FROM scannerLinks WHERE token=?'),
        byId: db.prepare('SELECT * FROM scannerLinks WHERE id=?'),
        byEventId: db.prepare('SELECT * FROM scannerLinks WHERE eventId=? ORDER BY createdAt DESC'),
        insert: db.prepare(`INSERT INTO scannerLinks (id, eventId, token, label, createdBy, createdAt) VALUES (?,?,?,?,?,?)`),
        touchLastUsed: db.prepare(`UPDATE scannerLinks SET lastUsedAt=? WHERE id=?`),
        deleteById: db.prepare(`DELETE FROM scannerLinks WHERE id=?`),
        deleteByEventId: db.prepare(`DELETE FROM scannerLinks WHERE eventId=?`),
    },
    sheetAccess: {
        byId: db.prepare('SELECT * FROM sheetAccess WHERE id=?'),
        byLinkId: db.prepare('SELECT * FROM sheetAccess WHERE sheetLinkId=?'),
        byUserId: db.prepare('SELECT * FROM sheetAccess WHERE userId=?'),
        byLinkAndUser: db.prepare('SELECT * FROM sheetAccess WHERE sheetLinkId=? AND userId=?'),
        countByLinkId: db.prepare('SELECT COUNT(*) as cnt FROM sheetAccess WHERE sheetLinkId=?'),
        insert: db.prepare(`INSERT INTO sheetAccess (id, userId, sheetLinkId, claimedAt, permission) VALUES (?,?,?,?,?)`),
        setPermission: db.prepare(`UPDATE sheetAccess SET permission=? WHERE sheetLinkId=? AND userId=?`),
        deleteById: db.prepare(`DELETE FROM sheetAccess WHERE id=?`),
        deleteByUserId: db.prepare(`DELETE FROM sheetAccess WHERE userId=?`),
    },
    passwordResetTokens: {
        byTokenHash: db.prepare('SELECT * FROM passwordResetTokens WHERE tokenHash=?'),
        insert: db.prepare(`INSERT INTO passwordResetTokens (id, userId, tokenHash, expiresAt, createdAt) VALUES (?,?,?,?,?)`),
        deleteByUserId: db.prepare(`DELETE FROM passwordResetTokens WHERE userId=?`),
        deleteByTokenHash: db.prepare(`DELETE FROM passwordResetTokens WHERE tokenHash=?`),
    },
    orders: {
        byId: db.prepare('SELECT * FROM orders WHERE id=?'),
        bySessionId: db.prepare('SELECT * FROM orders WHERE sessionId=?'),
        byPaymentIntentId: db.prepare('SELECT * FROM orders WHERE paymentIntentId=?'),
        byEventId: db.prepare('SELECT * FROM orders WHERE eventId=? ORDER BY createdAt DESC'),
        insert: db.prepare(`INSERT INTO orders (id, sessionId, eventId, registrationId, buyerName, buyerEmail, amount, currency, status, createdAt, discountCodeId, discountAmount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
        fulfill: db.prepare(`UPDATE orders SET status='fulfilled', registrationId=?, fulfilledAt=?, paymentIntentId=? WHERE sessionId=?`),
        refund: db.prepare(`UPDATE orders SET status='refunded', refundedAt=?, refundAmount=? WHERE id=?`),
    },
    auditLog: {
        insert: db.prepare(`INSERT INTO auditLog (id, userId, userEmail, eventId, action, details, ip, createdAt) VALUES (?,?,?,?,?,?,?,?)`),
        byEventId: db.prepare('SELECT * FROM auditLog WHERE eventId=? ORDER BY createdAt DESC LIMIT ? OFFSET ?'),
        countByEventId: db.prepare('SELECT COUNT(*) as cnt FROM auditLog WHERE eventId=?'),
        all: db.prepare('SELECT * FROM auditLog ORDER BY createdAt DESC LIMIT ? OFFSET ?'),
        countAll: db.prepare('SELECT COUNT(*) as cnt FROM auditLog'),
    },
    discountCodes: {
        byId: db.prepare('SELECT * FROM discountCodes WHERE id=?'),
        byEventId: db.prepare('SELECT * FROM discountCodes WHERE eventId=? ORDER BY createdAt DESC'),
        byEventAndCode: db.prepare('SELECT * FROM discountCodes WHERE eventId=? AND code=?'),
        insert: db.prepare(`INSERT INTO discountCodes (id, eventId, code, type, value, maxUses, expiresAt, active, createdAt) VALUES (?,?,?,?,?,?,?,?,?)`),
        incrementUse: db.prepare(`UPDATE discountCodes SET usedCount = usedCount + 1 WHERE id=?`),
        setActive: db.prepare(`UPDATE discountCodes SET active=? WHERE id=?`),
        deleteById: db.prepare(`DELETE FROM discountCodes WHERE id=?`),
        deleteByEventId: db.prepare(`DELETE FROM discountCodes WHERE eventId=?`),
    },
    waitlist: {
        byId: db.prepare('SELECT * FROM waitlist WHERE id=?'),
        byEventId: db.prepare('SELECT * FROM waitlist WHERE eventId=? ORDER BY createdAt ASC'),
        byEventAndEmail: db.prepare('SELECT * FROM waitlist WHERE eventId=? AND email=?'),
        countWaitingByEventId: db.prepare(`SELECT COUNT(*) as cnt FROM waitlist WHERE eventId=? AND status='waiting'`),
        insert: db.prepare(`INSERT INTO waitlist (id, eventId, name, email, customFields, status, createdAt) VALUES (?,?,?,?,?,?,?)`),
        setStatus: db.prepare(`UPDATE waitlist SET status=? WHERE id=?`),
        setNotified: db.prepare(`UPDATE waitlist SET status='notified', notifiedAt=? WHERE id=?`),
        deleteById: db.prepare(`DELETE FROM waitlist WHERE id=?`),
        deleteByEventId: db.prepare(`DELETE FROM waitlist WHERE eventId=?`),
    },
};

// Dynamic IN clause helper for walletDevices serial lookup
export function getWalletDevicesBySerials(serialNumbers) {
    if (!serialNumbers.length) return [];
    const placeholders = serialNumbers.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM walletDevices WHERE serialNumber IN (${placeholders})`).all(...serialNumbers);
}

// Dynamic IN clause helper for tickets by tokens
export function getTicketsByTokens(tokens) {
    if (!tokens.length) return [];
    const placeholders = tokens.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM tickets WHERE token IN (${placeholders})`).all(...tokens).map(rowToTicket);
}
