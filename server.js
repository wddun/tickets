import express from 'express';
import { db, stmt, rowToTicket, rowToEvent, rowToUser, rowToDiscountCode, rowToWaitlistEntry, getWalletDevicesBySerials, getTicketsByTokens } from './db-sqlite.js';
import { nanoid } from 'nanoid';
import QRCode from 'qrcode';
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';
import { PKPass } from 'passkit-generator';
import JSZip from 'jszip';
import multer from 'multer';
import sharp from 'sharp';

import compression from 'compression';
import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import http2 from 'http2';
const FileStore = FileStoreFactory(session);

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REPLY_TO_EMAIL = 'support@willstechsupport.com';

const stripeMode = (process.env.STRIPE_MODE || 'live').toUpperCase();
const stripeSecretKey = process.env[`STRIPE_SECRET_KEY_${stripeMode}`];
const stripeWebhookSecret = process.env[`STRIPE_WEBHOOK_SECRET_${stripeMode}`];
let stripe = null;
if (stripeSecretKey) {
    const _require = createRequire(import.meta.url);
    try {
        _require.resolve('stripe');
        const { default: Stripe } = await import('stripe');
        stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
        console.log(`[stripe] Mode: ${stripeMode.toLowerCase()} (${stripeSecretKey.startsWith('sk_test') ? 'sandbox' : 'live charges'})`);
    } catch { console.warn('[stripe] Package not installed — Stripe features disabled.'); }
}

const logBuffer = [];
const MAX_LOG_ENTRIES = 500;
function log(tag, msg) {
    const entry = { time: new Date().toISOString(), tag, msg };
    console.log(`[${entry.time}] [${tag}] ${msg}`);
    logBuffer.unshift(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.pop();
}
function getIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

// Persistent audit trail (separate from the in-memory `log()` ring buffer
// above, which is lost on every restart and isn't meant for accountability —
// this is for "who did what, when" on consequential actions: event/ticket
// mutations, check-ins, refunds, discount codes, access changes.
function logAudit(req, { eventId = null, action, details = null }) {
    try {
        const userId = req.session?.userId || null;
        const user = userId ? rowToUser(stmt.users.byId.get(userId)) : null;
        stmt.auditLog.insert.run(
            nanoid(10),
            userId,
            user?.email || null,
            eventId,
            action,
            details ? JSON.stringify(details) : null,
            getIP(req),
            new Date().toISOString()
        );
    } catch (err) {
        log('audit', `[ERROR] Failed to write audit entry — action: ${action}  error: ${err.message}`);
    }
}

const ses = new SESClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Serialised email queue — guarantees a minimum gap between SES sends.
// SES default rate for new accounts is 1/sec; set SES_MIN_INTERVAL_MS in .env to tune.
const SES_INTERVAL_MS = parseInt(process.env.SES_MIN_INTERVAL_MS || '100');
let emailChain = Promise.resolve();

// Gmail (and several other clients) strip `data:` URI images out of HTML
// email bodies as a security measure — they only render images that are
// attached to the message and referenced by Content-ID (`cid:`). So any
// email carrying inline images (QR codes, the wallet badge) must be sent
// as a raw multipart/related MIME message rather than through SES's plain
// SendEmailCommand, which has no way to attach anything.
function wrapBase64Lines(buf) {
    return buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

// Small HTML→plain-text reducer for the mandatory text/plain alternative —
// not meant to preserve exact formatting, just to give mail filters a normal
// multipart/alternative message instead of an HTML-only one. Missing the
// plain-text part is a well-known spam-score signal at strict mail systems
// (university/enterprise filters especially).
function htmlToPlainText(html) {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
            const t = inner.replace(/<[^>]+>/g, '').trim();
            return t && t !== href ? `${t} (${href})` : href;
        })
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&mdash;/gi, '—')
        .replace(/&ndash;/gi, '–')
        .replace(/&hellip;/gi, '…')
        .replace(/&copy;/gi, '©')
        .replace(/&reg;/gi, '®')
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&quot;/gi, '"')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// multipart/alternative(text/plain, multipart/related(text/html, inline images))
// — the standard nesting for "plain fallback + rich HTML with inline images".
// Alternative parts are ordered least- to most-preferred per RFC 2046, so
// plain text comes first and the HTML+images part comes last.
// Attachments split two ways: anything carrying a `cid` is an inline image
// referenced from the HTML and belongs inside multipart/related; everything
// else (the .ics calendar invite) is a genuine file attachment and has to sit
// in an outer multipart/mixed instead. Putting a calendar part inside
// multipart/related as `inline` is what makes clients quietly ignore it rather
// than offering "Add to Calendar".
//
//   multipart/mixed
//   ├── multipart/alternative
//   │   ├── text/plain
//   │   └── multipart/related
//   │       ├── text/html
//   │       └── inline images (cid:)
//   └── file attachments
function buildRawMimeEmail({ from, to, replyTo, subject, html, text, attachments = [] }) {
    const mixedBoundary = `b_${crypto.randomBytes(16).toString('hex')}`;
    const altBoundary = `b_${crypto.randomBytes(16).toString('hex')}`;
    const relBoundary = `b_${crypto.randomBytes(16).toString('hex')}`;
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;

    const inlineParts = attachments.filter(a => a.cid);
    const fileParts = attachments.filter(a => !a.cid);

    const lines = [
        `From: ${from}`,
        `To: ${to}`,
    ];
    if (replyTo) lines.push(`Reply-To: ${replyTo}`);
    lines.push(`Subject: ${encodedSubject}`);
    lines.push(`MIME-Version: 1.0`);

    if (fileParts.length) {
        lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
        lines.push('');
        lines.push(`--${mixedBoundary}`);
    }

    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push('');

    lines.push(`--${altBoundary}`);
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push('');
    lines.push(wrapBase64Lines(Buffer.from(text, 'utf8')));

    lines.push(`--${altBoundary}`);
    lines.push(`Content-Type: multipart/related; boundary="${relBoundary}"`);
    lines.push('');
    lines.push(`--${relBoundary}`);
    lines.push(`Content-Type: text/html; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push('');
    lines.push(wrapBase64Lines(Buffer.from(html, 'utf8')));

    for (const att of inlineParts) {
        lines.push(`--${relBoundary}`);
        lines.push(`Content-Type: ${att.contentType}`);
        lines.push(`Content-Transfer-Encoding: base64`);
        lines.push(`Content-ID: <${att.cid}>`);
        lines.push(`Content-Disposition: inline; filename="${att.filename}"`);
        lines.push('');
        lines.push(wrapBase64Lines(att.content));
    }
    lines.push(`--${relBoundary}--`);
    lines.push(`--${altBoundary}--`);

    for (const att of fileParts) {
        lines.push(`--${mixedBoundary}`);
        lines.push(`Content-Type: ${att.contentType}${att.contentType.startsWith('text/') ? '; charset=UTF-8' : ''}${att.method ? `; method=${att.method}` : ''}`);
        lines.push(`Content-Transfer-Encoding: base64`);
        lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
        lines.push('');
        lines.push(wrapBase64Lines(att.content));
    }
    if (fileParts.length) lines.push(`--${mixedBoundary}--`);

    return lines.join('\r\n');
}

// EMAIL_SINK diverts every outgoing email to a JSONL file instead of SES.
// It exists for the test suite: a test run must never send real mail, and
// asserting on what would have been sent is the only way to cover the email
// content itself. Unset in production, where this whole branch is dead.
const EMAIL_SINK = process.env.EMAIL_SINK || null;
function sinkEmail(payload) {
    try {
        fs.appendFileSync(EMAIL_SINK, JSON.stringify({ ...payload, at: new Date().toISOString() }) + '\n');
    } catch (err) {
        console.warn('[email-sink] write failed:', err.message);
    }
}

async function sendEmail({ to, subject, html, registrationId, fromName, replyTo, attachments = [] }) {
    if (EMAIL_SINK) {
        sinkEmail({
            to, subject, html, registrationId, fromName, replyTo,
            attachments: attachments.map(a => ({ filename: a.filename, cid: a.cid, contentType: a.contentType }))
        });
        return { MessageId: 'sink-' + nanoid(8) };
    }
    const task = emailChain.then(() => new Promise(r => setTimeout(r, SES_INTERVAL_MS))).then(async () => {
        // Append legitimacy footer to every email
        const footer = `<div style="text-align:center; margin-top:40px; padding-top:24px; border-top:1px solid #e5e7eb; font-size:12px; color:#6b7280;">
            <p style="margin:0 0 8px; color:#4b5563;"><strong>Will's Tech Support</strong></p>
            <p style="margin:0 0 12px; color:#6b7280;">Questions? Reply to this email or visit <a href="${BASE_URL}" style="color:#0284c7; text-decoration:none;">our support page</a></p>
            <p style="margin:0; color:#9ca3af; font-size:11px;">&copy; 2026 Will's Tech Support. All rights reserved.<br>This is an automated message — please do not reply with sensitive information.</p>
        </div>`;
        const withFooter = html + footer;
        const text = htmlToPlainText(withFooter);

        const sesFrom = (process.env.SES_FROM || '').trim();
        // Only wrap in display-name format if sesFrom is a plain email (no angle brackets already)
        const source = (fromName && sesFrom && !sesFrom.includes('<'))
            ? `"${fromName.replace(/["<>\\]/g, '').trim()}" <${sesFrom}>`
            : sesFrom;

        if (attachments.length) {
            const raw = buildRawMimeEmail({ from: source, to, replyTo, subject, html: withFooter, text, attachments });
            return ses.send(new SendRawEmailCommand({ Source: source, RawMessage: { Data: Buffer.from(raw, 'utf8') } }));
        }

        return ses.send(new SendEmailCommand({
            Source: source,
            Destination: { ToAddresses: [to] },
            ReplyToAddresses: replyTo ? [replyTo] : undefined,
            Message: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: {
                    Html: { Data: withFooter, Charset: 'UTF-8' },
                    Text: { Data: text, Charset: 'UTF-8' }
                }
            }
        }));
    });
    // Keep the chain alive even if this send fails, so later sends still run
    emailChain = task.catch(() => { });
    return task;
}

// Resolves whether an admin-issued ticket (manual add, CSV import, sheet
// import, edit) should email a confirmation. An explicit flag on the request
// always wins; otherwise falls back to the event's default. Never used for
// public self-registration, checkout, or waitlist notifications — those
// always send regardless of this setting.
function shouldSendAdminEmail(explicitFlag, event) {
    if (explicitFlag !== undefined && explicitFlag !== null) return explicitFlag !== false;
    return !event.skipConfirmationEmails;
}

// Shared HTML email template used by all ticket confirmation emails
// Cached in memory (read once, reused for every email) so we're not doing
// disk I/O per send — this is a small static asset that never changes.
let _walletBadgeBuffer = null;
function getWalletBadgeBuffer() {
    if (!_walletBadgeBuffer) {
        _walletBadgeBuffer = fs.readFileSync(path.join(__dirname, 'public', 'apple-wallet-badge.png'));
    }
    return _walletBadgeBuffer;
}

// ── Event time formatting ──────────────────────────────────────────────────
// events.time is a true UTC instant. Rendering it needs an explicit zone:
// toLocaleString without `timeZone` uses the *server's* zone, which is UTC in
// production, so an 8pm Eastern event rendered as "12:00 AM" the next day in
// every email. Times are therefore always formatted in the event's own zone
// and always labelled (EDT/CST/…) so a reader never has to guess.
const DEFAULT_EVENT_TIMEZONE = process.env.DEFAULT_EVENT_TIMEZONE || 'America/New_York';

function isValidTimeZone(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function eventTimeZone(event) {
    return isValidTimeZone(event?.timezone) ? event.timezone : DEFAULT_EVENT_TIMEZONE;
}

function formatEventDateTime(value, event, { withWeekday = true, timeOnly = false, dateOnly = false, showZone = true } = {}) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    const opts = { timeZone: eventTimeZone(event) };
    if (!dateOnly) {
        Object.assign(opts, { hour: 'numeric', minute: '2-digit', hour12: true });
        if (showZone) opts.timeZoneName = 'short';
    }
    if (!timeOnly) {
        Object.assign(opts, { month: 'long', day: 'numeric', year: 'numeric' });
        if (withWeekday) opts.weekday = 'long';
    }
    return d.toLocaleString('en-US', opts);
}

// "Thursday, August 20, 2026 at 8:00 PM – 9:15 PM EDT" — the zone label is
// attached to whichever part ends the string so it reads naturally.
function formatEventDateRange(event, { withWeekday = true } = {}) {
    if (!event?.time) return '';
    const start = formatEventDateTime(event.time, event, { withWeekday, showZone: !event.endTime });
    if (!event.endTime) return start;
    const tz = eventTimeZone(event);
    const sameDay = new Date(event.time).toLocaleDateString('en-US', { timeZone: tz })
        === new Date(event.endTime).toLocaleDateString('en-US', { timeZone: tz });
    const end = formatEventDateTime(event.endTime, event, { withWeekday, timeOnly: sameDay });
    return `${start} – ${end}`;
}

// Wall-clock parts of an instant *in a given zone* — needed wherever the
// calendar-local date/time matters rather than the absolute instant (Google's
// ctz parameter, "is this event tonight?" phrasing).
function zonedParts(value, timeZone) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    // 'en-CA' renders midnight as 24 rather than 00 in some ICU builds.
    if (parts.hour === '24') parts.hour = '00';
    return parts;
}

// ── Calendar invites ───────────────────────────────────────────────────────
// Ticket emails carry the event as a real calendar attachment (.ics) plus a
// one-tap Google Calendar link, so attendees can add it without retyping
// anything. Apple Mail / Outlook surface an attached text/calendar part as an
// "Add to Calendar" affordance directly in the message.

// Events with no explicit end time get this much duration in the invite —
// an .ics with DTSTART == DTEND renders as a zero-length blip in most
// calendar clients rather than a normal block.
const DEFAULT_EVENT_DURATION_MS = 2 * 60 * 60 * 1000;

function icsEscape(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
}

// RFC 5545 caps content lines at 75 octets; longer lines are folded onto
// continuation lines beginning with a single space. Folding by octet (not
// character) matters because escaped UTF-8 text can be multi-byte.
function icsFold(line) {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length <= 75) return line;
    const parts = [];
    let start = 0;
    let limit = 75;
    while (start < bytes.length) {
        let end = Math.min(start + limit, bytes.length);
        // Don't split in the middle of a multi-byte sequence.
        while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        parts.push(bytes.subarray(start, end).toString('utf8'));
        start = end;
        limit = 74; // continuation lines lose one octet to the leading space
    }
    return parts.join('\r\n ');
}

function icsStamp(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function eventCalendarWindow(event) {
    if (!event?.time) return null;
    const start = new Date(event.time);
    if (isNaN(start.getTime())) return null;
    let end = event.endTime ? new Date(event.endTime) : null;
    if (!end || isNaN(end.getTime()) || end <= start) {
        end = new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS);
    }
    return { start, end };
}

// The event's venue, or nothing at all.
//
// Events created or edited without a location used to have their name written
// as the literal string 'Venue' (see /api/sheet/create-event and PUT
// /api/event/:id, which no longer do this). Downstream that placeholder read
// as a real venue, so tickets, wallet passes and reminder emails for an event
// with no location announced one called "Venue". Those rows are still in the
// database, so treat the placeholder as absent on the way out rather than
// rewriting people's data. Anything genuinely typed by an organiser — "TBD"
// included — is left alone, because they meant to say it.
function eventVenue(event) {
    let name = (event?.location?.name || '').trim();
    const address = (event?.location?.address || '').trim();
    if (name.toLowerCase() === 'venue') name = '';
    return { name, address, hasAny: !!(name || address) };
}

// ── Registration page themes ───────────────────────────────────────────────
//
// Presets for the public registration page, defined once here so the picker in
// the dashboard and the page itself can never disagree about what a theme is.
// Each is a small palette plus a couple of shape decisions; the event's own
// accent colour still wins when the theme says `useEventColor`.
const REGISTRATION_THEMES = [
    {
        key: 'classic',
        label: 'Classic',
        description: 'Clean and neutral. Uses your event colour as the accent.',
        useEventColor: true,
        vars: {
            bg: '#f3f4f6', surface: '#ffffff', text: '#111827', muted: '#6b7280',
            accent: '#4f46e5', accentText: '#ffffff', border: '#e5e7eb',
            radius: '14px', headerHeight: '150px', font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        },
    },
    {
        key: 'professional',
        label: 'Professional',
        description: 'Restrained navy and slate. Good for conferences and corporate events.',
        useEventColor: false,
        vars: {
            bg: '#eef1f6', surface: '#ffffff', text: '#0f172a', muted: '#64748b',
            accent: '#1e3a8a', accentText: '#ffffff', border: '#dbe2ec',
            radius: '8px', headerHeight: '140px', font: "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif",
        },
    },
    {
        key: 'fun',
        label: 'Fun',
        description: 'Bright and rounded, with a warm gradient header.',
        useEventColor: false,
        vars: {
            bg: '#fff7ed', surface: '#ffffff', text: '#1f2937', muted: '#78716c',
            accent: '#ea580c', accentText: '#ffffff', border: '#fed7aa',
            radius: '22px', headerHeight: '170px', font: "'Trebuchet MS', -apple-system, BlinkMacSystemFont, sans-serif",
            headerGradient: 'linear-gradient(135deg, #fb923c, #f43f5e 55%, #a855f7)',
        },
    },
    {
        key: 'midnight',
        label: 'Midnight',
        description: 'Dark background with a bright accent. Suits nightlife and concerts.',
        useEventColor: true,
        dark: true,
        vars: {
            bg: '#0b0f1a', surface: '#151b2b', text: '#f8fafc', muted: '#94a3b8',
            accent: '#38bdf8', accentText: '#0b0f1a', border: '#243049',
            radius: '16px', headerHeight: '170px', font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        },
    },
    {
        key: 'garden',
        label: 'Garden',
        description: 'Soft greens and cream. Fits weddings, brunches and daytime events.',
        useEventColor: false,
        vars: {
            bg: '#f2f7f0', surface: '#ffffff', text: '#1f2a24', muted: '#6b7d70',
            accent: '#3f7d5a', accentText: '#ffffff', border: '#d9e6dc',
            radius: '18px', headerHeight: '160px', font: "Georgia, 'Times New Roman', serif",
        },
    },
];
const REGISTRATION_THEME_KEYS = REGISTRATION_THEMES.map(t => t.key);
const DEFAULT_REGISTRATION_THEME = 'classic';

function themeForEvent(event) {
    const key = REGISTRATION_THEME_KEYS.includes(event?.theme) ? event.theme : DEFAULT_REGISTRATION_THEME;
    const theme = REGISTRATION_THEMES.find(t => t.key === key);
    const vars = { ...theme.vars };
    // The event's own colour is the organiser's choice, so it takes precedence
    // over the preset's accent wherever the preset allows it.
    if (theme.useEventColor && event?.color) vars.accent = normalizeCssColor(event.color) || vars.accent;
    return { key: theme.key, label: theme.label, dark: !!theme.dark, vars };
}

// "rgb(99, 102, 241)" → "#6366f1"; passes hex through untouched.
function normalizeCssColor(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (s.startsWith('#')) return s;
    const nums = s.match(/\d+/g);
    if (!nums || nums.length < 3) return null;
    return '#' + nums.slice(0, 3).map(n => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')).join('');
}

function eventLocationLine(event) {
    const { name, address } = eventVenue(event);
    if (name && address && name !== address) return `${name}, ${address}`;
    return name || address || '';
}

// Builds the VCALENDAR body for an event. `uid` should be stable per
// (event, recipient) so a re-sent ticket updates the existing calendar entry
// instead of creating a duplicate one.
function buildEventIcs(event, { uid, sequence = 0 } = {}) {
    const window = eventCalendarWindow(event);
    if (!window) return null;
    const stamp = icsStamp(new Date());
    const host = (() => { try { return new URL(BASE_URL).host; } catch { return 'tickets.local'; } })();

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        `PRODID:-//Will's Tech Support//WTS Tickets//EN`,
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${icsEscape(uid || `${event.id}@${host}`)}`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsStamp(window.start)}`,
        `DTEND:${icsStamp(window.end)}`,
        `SUMMARY:${icsEscape(event.name || 'Event')}`,
        `SEQUENCE:${Number.isFinite(sequence) ? sequence : 0}`,
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
    ];

    const location = eventLocationLine(event);
    if (location) lines.push(`LOCATION:${icsEscape(location)}`);
    lines.push(`URL:${icsEscape(BASE_URL)}`);
    lines.push('BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(event.name || 'Event')}`, 'END:VALARM');
    lines.push('END:VEVENT', 'END:VCALENDAR');

    return lines.map(icsFold).join('\r\n') + '\r\n';
}

function googleCalendarUrl(event) {
    const window = eventCalendarWindow(event);
    if (!window) return null;
    const tz = eventTimeZone(event);
    // Wall-clock times plus ctz, rather than a UTC instant: this pins the entry
    // to the *venue's* zone, so it still reads as an 8pm event for someone
    // whose Google Calendar is set to a different timezone than the event.
    const local = (d) => {
        const p = zonedParts(d, tz);
        return p ? `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}` : null;
    };
    const start = local(window.start);
    const end = local(window.end);
    if (!start || !end) return null;
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: event.name || 'Event',
        dates: `${start}/${end}`,
        ctz: tz,
    });
    const location = eventLocationLine(event);
    if (location) params.set('location', location);
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ── Ticket email templates ─────────────────────────────────────────────────
// The ticket email is a list of blocks stored per-event (events.emailTemplate),
// authored in the dashboard's drag-and-drop editor. Rendering lives here on the
// server and nowhere else — the editor's live preview calls back into this same
// renderer, so what an organiser sees is what actually gets mailed.
//
// Blocks are either *static* (text/button/image/divider — content comes from
// the template) or *dynamic* (tickets/eventDetails/calendar/changes/customFields
// — content comes from the send-time context and can't be typed by hand).

const EMAIL_TEXT_SIZES = { sm: 15, md: 16, lg: 18, xl: 22 };
const EMAIL_ALIGNMENTS = new Set(['left', 'center', 'right']);

function escEmailText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Only http(s)/mailto get through — a template is authored by an event owner,
// but the rendered result is mailed to third parties, so javascript:/data:
// URLs must never survive into the output.
function safeEmailUrl(value) {
    const url = String(value ?? '').trim();
    return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

function safeEmailColor(value, fallback) {
    const color = String(value ?? '').trim();
    return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? color : fallback;
}

function applyEmailVars(text, vars) {
    return String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : match);
}

// Deliberately tiny markup dialect rather than raw HTML: organiser-authored
// text is escaped first, then a fixed set of inline patterns is re-enabled.
// That keeps arbitrary markup (and anything script-shaped) out of mail we send
// on their behalf, while still allowing bold/italic/links.
function renderEmailInline(text, vars) {
    let out = escEmailText(applyEmailVars(text, vars));
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) =>
        /^(https?:\/\/|mailto:)/i.test(url)
            ? `<a href="${url}" style="color:#2563eb;text-decoration:underline;">${label}</a>`
            : match);
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out.replace(/\r?\n/g, '<br>');
}

const EMAIL_BLOCK_TYPES = new Set([
    'header', 'text', 'intro', 'eventDetails', 'calendar', 'changes',
    'customFields', 'tickets', 'button', 'divider', 'spacer', 'image', 'footerNote',
]);

const DEFAULT_TICKET_EMAIL_TEMPLATE = {
    version: 1,
    settings: { accent: 'auto', pageBackground: '#f3f4f6', cardBackground: '#ffffff', subject: '' },
    blocks: [
        { id: 'b-header', type: 'header', props: { eyebrow: 'Your Registration Confirmation', title: '{{eventName}}' } },
        { id: 'b-greeting', type: 'text', props: { text: 'Hi **{{firstName}}**,', size: 'md', align: 'left', color: '#374151' } },
        { id: 'b-body', type: 'text', props: { text: "Thank you for registering for **{{eventName}}**. This email confirms your registration and contains your event ticket. Please save this email—you'll need it to check in at the event.", size: 'sm', align: 'left', color: '#555555' } },
        { id: 'b-details', type: 'eventDetails', props: { showMaps: true } },
        { id: 'b-calendar', type: 'calendar', props: { google: true, ics: true } },
        { id: 'b-changes', type: 'changes', props: {} },
        { id: 'b-fields', type: 'customFields', props: {} },
        { id: 'b-tickets', type: 'tickets', props: { showWallet: true, showToken: true } },
        { id: 'b-footer', type: 'footerNote', props: { lines: ["Keep this email — it's your entry ticket.", "Don't share your QR code with others."] } },
    ],
};

// Coerces whatever the client sent into a template we're willing to render.
// Unknown block types and unknown props are dropped rather than rejected so a
// newer editor talking to an older server degrades instead of erroring.
function normalizeEmailTemplate(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks)) {
        return JSON.parse(JSON.stringify(DEFAULT_TICKET_EMAIL_TEMPLATE));
    }
    const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    const blocks = raw.blocks
        .filter(b => b && typeof b === 'object' && EMAIL_BLOCK_TYPES.has(b.type))
        .slice(0, 40)
        .map((b, i) => {
            const p = b.props && typeof b.props === 'object' ? b.props : {};
            const props = {};
            switch (b.type) {
                case 'header':
                    props.eyebrow = String(p.eyebrow ?? '').slice(0, 120);
                    props.title = String(p.title ?? '{{eventName}}').slice(0, 200);
                    break;
                case 'text':
                    props.text = String(p.text ?? '').slice(0, 4000);
                    props.size = EMAIL_TEXT_SIZES[p.size] ? p.size : 'sm';
                    props.align = EMAIL_ALIGNMENTS.has(p.align) ? p.align : 'left';
                    props.color = safeEmailColor(p.color, '#555555');
                    break;
                case 'eventDetails':
                    props.showMaps = p.showMaps !== false;
                    break;
                case 'calendar':
                    props.google = p.google !== false;
                    props.ics = p.ics !== false;
                    break;
                case 'tickets':
                    props.showWallet = p.showWallet !== false;
                    props.showToken = p.showToken !== false;
                    break;
                case 'button': {
                    props.label = String(p.label ?? 'View details').slice(0, 80);
                    props.url = safeEmailUrl(p.url) || '';
                    props.align = EMAIL_ALIGNMENTS.has(p.align) ? p.align : 'center';
                    break;
                }
                case 'spacer':
                    props.height = Math.min(80, Math.max(4, parseInt(p.height, 10) || 16));
                    break;
                case 'image':
                    props.url = safeEmailUrl(p.url) || '';
                    props.href = safeEmailUrl(p.href) || '';
                    props.width = Math.min(560, Math.max(40, parseInt(p.width, 10) || 320));
                    props.align = EMAIL_ALIGNMENTS.has(p.align) ? p.align : 'center';
                    break;
                case 'footerNote':
                    props.lines = (Array.isArray(p.lines) ? p.lines : [])
                        .slice(0, 6).map(l => String(l ?? '').slice(0, 300));
                    break;
                default:
                    break; // intro / changes / customFields / divider carry no props
            }
            return { id: typeof b.id === 'string' && b.id ? b.id.slice(0, 40) : `b-${i}`, type: b.type, props };
        });

    return {
        version: 1,
        settings: {
            accent: s.accent === 'auto' || !s.accent ? 'auto' : safeEmailColor(s.accent, 'auto'),
            pageBackground: safeEmailColor(s.pageBackground, '#f3f4f6'),
            cardBackground: safeEmailColor(s.cardBackground, '#ffffff'),
            subject: String(s.subject ?? '').slice(0, 200),
        },
        blocks: blocks.length ? blocks : JSON.parse(JSON.stringify(DEFAULT_TICKET_EMAIL_TEMPLATE.blocks)),
    };
}

// Renders one block to email-safe HTML. `ctx` carries everything dynamic:
// precomputed ticket/QR markup, event detail rows, calendar links, and the
// variable bag used for {{...}} substitution.
function renderEmailBlock(block, ctx) {
    const p = block.props || {};
    switch (block.type) {
        case 'header':
            return `<tr><td style="background:${ctx.accentHex};padding:28px 32px;text-align:center;">
    ${p.eyebrow ? `<p style="margin:0 0 6px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${renderEmailInline(p.eyebrow, ctx.vars)}</p>` : ''}
    <h1 style="margin:0;font-size:26px;font-weight:800;color:#fff;line-height:1.2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${renderEmailInline(p.title, ctx.vars)}</h1>
  </td></tr>`;

        case 'text':
            if (!String(p.text || '').trim()) return '';
            return `<p style="font-size:${EMAIL_TEXT_SIZES[p.size] || 15}px;color:${p.color};margin:0 0 24px;line-height:1.6;text-align:${p.align};">${renderEmailInline(p.text, ctx.vars)}</p>`;

        case 'intro':
            return ctx.intro ? `<p style="font-size:15px;color:#555;margin:0 0 24px;line-height:1.6;">${ctx.intro}</p>` : '';

        case 'eventDetails': {
            const rows = ctx.dateRowHtml + (p.showMaps ? ctx.locRowHtml : ctx.locRowPlainHtml);
            if (!rows.trim()) return '';
            return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;margin-bottom:24px;">
    <tr><td style="padding:18px 20px;"><table cellpadding="0" cellspacing="0" width="100%">${rows}</table></td></tr>
    </table>`;
        }

        case 'calendar': {
            const links = [];
            if (p.google && ctx.googleCalendarUrl) links.push({ href: ctx.googleCalendarUrl, label: 'Google Calendar' });
            if (p.ics && ctx.icsUrl) links.push({ href: ctx.icsUrl, label: 'Apple / Outlook' });
            if (!links.length) return '';
            return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;"><tr><td align="center" style="padding:4px 0 0;">
    <p style="font-size:13px;font-weight:600;color:#555;margin:0 0 10px;">Add this event to your calendar</p>
    ${links.map(l => `<a href="${l.href}" style="display:inline-block;margin:0 4px 6px;padding:9px 16px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;font-weight:600;color:#374151;text-decoration:none;background:#fff;">${l.label}</a>`).join('')}
    </td></tr></table>`;
        }

        case 'changes':
            return ctx.changesHtml || '';

        case 'customFields':
            return ctx.customFieldsHtml || '';

        case 'tickets':
            return ctx.addAllHtml + ctx.qrBlocksHtml;

        case 'button': {
            const url = safeEmailUrl(applyEmailVars(p.url, ctx.vars));
            if (!url || !p.label) return '';
            return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;"><tr><td align="${p.align}">
    <a href="${url}" style="display:inline-block;padding:13px 26px;background:${ctx.accentHex};color:#fff;font-size:15px;font-weight:700;border-radius:10px;text-decoration:none;">${renderEmailInline(p.label, ctx.vars)}</a>
    </td></tr></table>`;
        }

        case 'divider':
            return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;"><tr><td style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;

        case 'spacer':
            return `<div style="height:${p.height}px;line-height:${p.height}px;font-size:0;">&nbsp;</div>`;

        case 'image': {
            if (!p.url) return '';
            const img = `<img src="${p.url}" alt="" width="${p.width}" style="width:${p.width}px;max-width:100%;height:auto;display:block;border:0;border-radius:8px;">`;
            return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;"><tr><td align="${p.align}">${p.href ? `<a href="${p.href}" style="text-decoration:none;">${img}</a>` : img}</td></tr></table>`;
        }

        case 'footerNote': {
            const lines = (p.lines || []).filter(l => String(l).trim());
            if (!lines.length) return '';
            return `<table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f3f4f6;margin-top:8px;"><tr><td style="padding-top:20px;text-align:center;">
    ${lines.map((l, i) => `<p style="font-size:12px;color:#9ca3af;margin:0 0 ${i === lines.length - 1 ? '0' : '4px'};">${renderEmailInline(l, ctx.vars)}</p>`).join('')}
    </td></tr></table>`;
        }

        default:
            return '';
    }
}

// Ticket emails embed the QR (and the wallet badge) as inline images attached
// to the message and referenced by Content-ID (cid:), rather than linking to
// /qr/:token or the static badge file, or embedding them as `data:` URIs.
// Gmail (and several other mail clients) deliberately strip `data:` URI
// images from HTML bodies as a security measure and will only render images
// that arrive as real MIME attachments — cid: is the only reliable way to
// get an image to always render without a live fetch, on Gmail included.
// Returns { html, attachments, subject } — attachments must be passed to
// sendEmail(); subject is non-empty only when the template overrides it.
async function buildTicketEmailHtml({ firstName, intro, event, tickets, changesHtml = '', customFieldsHtml = '' }) {
    const dateStr = formatEventDateRange(event);
    const dateRowHtml = dateStr ? `
        <tr>
          <td style="padding:5px 0;font-size:14px;color:#6b7280;vertical-align:top;white-space:nowrap;width:20px;">📅</td>
          <td style="padding:5px 0 5px 8px;font-size:14px;color:#374151;">${dateStr}</td>
        </tr>` : '';

    const { name: locName, address: locAddress } = eventVenue(event);
    const mapsQuery = encodeURIComponent(locAddress || locName);
    const googleMapsUrl = mapsQuery ? `https://www.google.com/maps/search/?api=1&query=${mapsQuery}` : null;
    const appleMapsUrl  = mapsQuery ? `https://maps.apple.com/?q=${mapsQuery}` : null;
    const locCellOpen = `
        <tr>
          <td style="padding:5px 0;font-size:14px;color:#6b7280;vertical-align:top;white-space:nowrap;width:20px;">📍</td>
          <td style="padding:5px 0 5px 8px;font-size:14px;color:#374151;">
            ${locName || locAddress}`;
    const locRowHtml = (locName || locAddress) ? `${locCellOpen}
            ${googleMapsUrl ? `<br><span style="font-size:12px;"><a href="${googleMapsUrl}" style="color:#6366f1;text-decoration:none;font-weight:500;">Google Maps</a>&nbsp;&middot;&nbsp;<a href="${appleMapsUrl}" style="color:#6366f1;text-decoration:none;font-weight:500;">Apple Maps</a></span>` : ''}
          </td>
        </tr>` : '';
    const locRowPlainHtml = (locName || locAddress) ? `${locCellOpen}
          </td>
        </tr>` : '';

    // Accent color: convert "rgb(r,g,b)" → hex if needed
    const rawColor = event.color || 'rgb(99,102,241)';
    const eventAccentHex = rawColor.startsWith('rgb')
        ? '#' + rawColor.match(/\d+/g).map(n => parseInt(n).toString(16).padStart(2, '0')).join('')
        : rawColor;

    const template = normalizeEmailTemplate(event.emailTemplate);
    const accentHex = template.settings.accent === 'auto' ? eventAccentHex : template.settings.accent;

    // Only build what the template actually asks for: generating QR images (and
    // attaching the wallet badge, or the .ics) for blocks the organiser removed
    // would mean paying for the work and shipping unreferenced MIME parts.
    const ticketsBlock = template.blocks.find(b => b.type === 'tickets');
    const calendarBlock = template.blocks.find(b => b.type === 'calendar');

    const n = tickets.length;
    // Content-ID must look like an RFC 2392/822 addr-spec (unique-id@domain) —
    // a bare slug like "wallet-badge" is non-conformant and Gmail silently
    // fails to resolve the cid: reference even though the rest of the MIME
    // parses fine, leaving just the alt text where the image should be.
    const walletBadgeCid = 'wallet-badge@tickets.willstechsupport.com';
    const showWallet = !!ticketsBlock && ticketsBlock.props.showWallet !== false;
    const attachments = showWallet ? [{
        cid: walletBadgeCid,
        content: getWalletBadgeBuffer(),
        contentType: 'image/png',
        filename: 'add-to-apple-wallet.png',
    }] : [];

    const walletBadgeHtml = (url, alt) => `
    <a href="${url}" style="display:inline-block;text-decoration:none;">
      <table role="presentation" width="141" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td>
        <img src="cid:${walletBadgeCid}" alt="${alt}" width="141" height="44" style="display:block;width:141px;height:44px;">
      </td></tr></table>
    </a>`;

    const qrBlocksHtml = !ticketsBlock ? '' : (await Promise.all(tickets.map(async (t, i) => {
        const qrBuffer = await QRCode.toBuffer(`ticket:${t.token}`);
        const qrCid = `qr-${t.token}@tickets.willstechsupport.com`;
        attachments.push({ cid: qrCid, content: qrBuffer, contentType: 'image/png', filename: `ticket-qr-${i}.png` });
        return `
<div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin-bottom:16px;background:#fff;">
  ${n > 1 ? `<div style="background:${accentHex};padding:7px 16px;"><p style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.9);text-transform:uppercase;letter-spacing:1px;margin:0;">Ticket ${i + 1} of ${n}</p></div>` : ''}
  <div style="padding:24px;text-align:center;">
    <p style="font-size:15px;font-weight:600;color:#111;margin:0 0 16px;">${t.name}</p>
    <table role="presentation" width="200" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 12px;">
      <tr><td>
        <img src="cid:${qrCid}" alt="QR Code" width="200" height="200" style="width:200px;height:200px;display:block;border:1px solid #f3f4f6;border-radius:8px;background:#fff;padding:8px;">
      </td></tr>
    </table>
    ${ticketsBlock.props.showToken !== false ? `<p style="font-size:10px;color:#9ca3af;font-family:monospace;margin:0 0 16px;word-break:break-all;">${t.token}</p>` : ''}
    ${showWallet ? walletBadgeHtml(`${BASE_URL}/api/pass/${t.token}.pkpass`, 'Add to Apple Wallet') : ''}
  </div>
</div>`;
    }))).join('');

    const addAllHtml = (ticketsBlock && showWallet && n > 1) ? `
<div style="text-align:center;margin-bottom:20px;padding:16px;background:#f9fafb;border-radius:12px;border:1px solid #e5e7eb;">
  <p style="font-size:13px;font-weight:600;color:#555;margin:0 0 10px;">Add all ${n} tickets to Apple Wallet at once:</p>
  ${walletBadgeHtml(`${BASE_URL}/api/passes/bundle/${tickets[0].registrationId}`, 'Add All to Apple Wallet')}
</div>` : '';

    // The .ics rides along as a real file attachment (so Apple Mail/Outlook
    // offer "Add to Calendar" inline) *and* is linked, for clients that hide
    // attachments. UID is per-event so a re-send updates rather than duplicates.
    let icsUrl = null;
    if (calendarBlock && calendarBlock.props.ics && event.time) {
        const ics = buildEventIcs(event, { uid: `event-${event.id}@${(() => { try { return new URL(BASE_URL).host; } catch { return 'tickets.local'; } })()}` });
        if (ics) {
            attachments.push({
                content: Buffer.from(ics, 'utf8'),
                contentType: 'text/calendar',
                method: 'PUBLISH',
                filename: 'event.ics',
            });
            icsUrl = `${BASE_URL}/api/event/${event.id}/calendar.ics`;
        }
    }

    const ctx = {
        accentHex,
        intro,
        changesHtml,
        customFieldsHtml,
        dateRowHtml,
        locRowHtml,
        locRowPlainHtml,
        qrBlocksHtml,
        addAllHtml,
        icsUrl,
        googleCalendarUrl: (calendarBlock && calendarBlock.props.google) ? googleCalendarUrl(event) : null,
        vars: {
            firstName: firstName || '',
            fullName: tickets[0]?.name || firstName || '',
            lastName: tickets[0]?.lastName || '',
            eventName: event.name || '',
            eventDate: dateStr ? dateStr.replace(/&ndash;/g, '–') : '',
            eventLocation: eventLocationLine(event),
            ticketCount: String(n),
        },
    };

    // A `header` block is full-bleed (its own coloured row); everything else
    // lives inside the padded body cell. Consecutive body blocks are coalesced
    // into a single cell so padding isn't repeated between them.
    const rows = [];
    let bodyBuffer = [];
    const flushBody = () => {
        if (!bodyBuffer.length) return;
        const inner = bodyBuffer.join('\n').trim();
        bodyBuffer = [];
        if (inner) rows.push(`<tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${inner}</td></tr>`);
    };
    for (const block of template.blocks) {
        if (block.type === 'header') {
            flushBody();
            rows.push(renderEmailBlock(block, ctx));
        } else {
            bodyBuffer.push(renderEmailBlock(block, ctx));
        }
    }
    flushBody();

    const html = `
<div style="margin:0;padding:0;background:${template.settings.pageBackground};">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${template.settings.pageBackground};">
<tr><td align="center" style="padding:24px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${template.settings.cardBackground};border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
${rows.join('\n')}
</table>
</td></tr>
</table>
</div>`;

    const subject = template.settings.subject
        ? applyEmailVars(template.settings.subject, ctx.vars).trim()
        : '';

    return { html, attachments, subject };
}

// 1x1 transparent GIF for email open tracking
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// ── APNs push for Wallet pass updates ──────────────────────────────────────
let _apnsJwtCache = { token: null, iat: 0 };
const APP_BUNDLE_ID = process.env.APP_BUNDLE_ID || 'com.willstechsupport.wtstickets';

function getApnsJwt() {
    const now = Math.floor(Date.now() / 1000);
    if (_apnsJwtCache.token && now - _apnsJwtCache.iat < 3300) return _apnsJwtCache.token;
    const keyPath = process.env.APNS_KEY_PATH;
    if (!keyPath) return null;
    let key;
    try { key = fs.readFileSync(keyPath, 'utf8'); } catch { return null; }
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID || process.env.TEAM_ID;
    if (!keyId || !teamId) return null;
    const b64u = (v) => Buffer.from(typeof v === 'object' ? JSON.stringify(v) : String(v)).toString('base64url');
    const header = b64u({ alg: 'ES256', kid: keyId });
    const payload = b64u({ iss: teamId, iat: now });
    const msg = `${header}.${payload}`;
    const sig = crypto.sign('SHA256', Buffer.from(msg), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    _apnsJwtCache = { token: `${msg}.${sig}`, iat: now };
    return _apnsJwtCache.token;
}

async function pushWalletUpdate(serialNumbers) {
    if (!Array.isArray(serialNumbers)) serialNumbers = [serialNumbers];
    const passTypeId = process.env.PASS_TYPE_ID;
    if (!passTypeId || !process.env.APNS_KEY_ID || !process.env.APNS_KEY_PATH) return;
    const jwt = getApnsJwt();
    if (!jwt) return;

    const devices = getWalletDevicesBySerials(serialNumbers);
    if (!devices.length) return;
    const pushTokens = [...new Set(devices.map(d => d.pushToken))];

    const host = process.env.APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
    let client;
    try { client = http2.connect(`https://${host}`); } catch { return; }

    for (const pushToken of pushTokens) {
        await new Promise((resolve) => {
            try {
                const req = client.request({
                    ':method': 'POST', ':path': `/3/device/${pushToken}`,
                    'authorization': `bearer ${jwt}`,
                    'apns-topic': passTypeId,
                    'content-type': 'application/json', 'content-length': '2',
                });
                req.write('{}'); req.end();
                req.on('response', (headers) => {
                    const status = headers[':status'];
                    log('apns', `[device] Push → ${pushToken.slice(0, 8)}… status: ${status}`);
                    if (status === 410) {
                        stmt.walletDevices.deleteByPushToken.run(pushToken);
                    }
                    resolve();
                });
                req.on('error', (err) => { log('apns', `[ERR] Push error: ${err.message}`); resolve(); });
            } catch (e) { resolve(); }
        });
    }
    try { client.close(); } catch { }
}

// ── TOTP (RFC 6238) two-factor auth — implemented manually with Node's
// built-in crypto module, no otplib/speakeasy dependency ─────────────────────
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
    let bits = 0, value = 0, output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return output;
}

function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, value = 0;
    const bytes = [];
    for (const char of clean) {
        const idx = BASE32_ALPHABET.indexOf(char);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function generateBase32Secret(byteLength = 20) {
    return base32Encode(crypto.randomBytes(byteLength));
}

// HMAC-SHA1-based HOTP (RFC 4226)
function hotp(secretBuffer, counter, digits = 6) {
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuf.writeUInt32BE(counter % 0x100000000, 4);
    const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return (code % (10 ** digits)).toString().padStart(digits, '0');
}

// TOTP (RFC 6238): HOTP with counter derived from a 30s time step
function totp(base32Secret, { step = 30, digits = 6, time = Date.now() } = {}) {
    const counter = Math.floor(time / 1000 / step);
    return hotp(base32Decode(base32Secret), counter, digits);
}

// Accepts a code from the previous/current/next time step (+/-1) to tolerate clock drift
function verifyTotp(base32Secret, code, { step = 30, digits = 6, window = 1 } = {}) {
    if (!base32Secret || typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
    const now = Date.now();
    const codeBuf = Buffer.from(code);
    for (let w = -window; w <= window; w++) {
        const candidate = Buffer.from(totp(base32Secret, { step, digits, time: now + w * step * 1000 }));
        if (candidate.length === codeBuf.length && crypto.timingSafeEqual(candidate, codeBuf)) return true;
    }
    return false;
}

// ── Signed short-lived tokens for the 2FA login handshake, and signed
// "remember this device" cookies — both HMAC'd with SESSION_SECRET rather
// than stored/trusted as opaque values ───────────────────────────────────────
const PENDING_TOTP_TOKEN_TTL_MS = 5 * 60 * 1000;
const REMEMBER_DEVICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function hmacSign(payload) {
    return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
}

function timingSafeStringEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function signPendingTotpToken(userId) {
    const payload = `${userId}.${Date.now() + PENDING_TOTP_TOKEN_TTL_MS}`;
    return `${payload}.${hmacSign(payload)}`;
}

// Returns the userId if the token is well-formed, correctly signed, and not expired
function verifyPendingTotpToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [userId, expStr, sig] = parts;
    const payload = `${userId}.${expStr}`;
    if (!timingSafeStringEqual(hmacSign(payload), sig)) return null;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() > exp) return null;
    return userId;
}

function signDeviceToken() {
    const selector = crypto.randomBytes(24).toString('hex');
    const payload = `${selector}.${Date.now()}`;
    return `${payload}.${hmacSign(payload)}`;
}

// Returns the raw token string if well-formed, correctly signed, and within
// the remember-device max age; the caller still has to check the hash
// against a live (non-revoked) trustedDevices row.
function verifyDeviceToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [selector, issuedAtStr, sig] = parts;
    const payload = `${selector}.${issuedAtStr}`;
    if (!timingSafeStringEqual(hmacSign(payload), sig)) return null;
    const issuedAt = parseInt(issuedAtStr, 10);
    if (!issuedAt || Date.now() - issuedAt > REMEMBER_DEVICE_MAX_AGE_MS) return null;
    return token;
}

function hashDeviceToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const pair of header.split(';')) {
        const idx = pair.indexOf('=');
        if (idx < 0) continue;
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
    }
    return out;
}

// One-time backup codes shown once at 2FA-enable time; only bcrypt hashes are stored
function generateBackupCodes(count = 8, length = 10) {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
    const codes = [];
    for (let i = 0; i < count; i++) {
        const bytes = crypto.randomBytes(length);
        let code = '';
        for (let j = 0; j < length; j++) code += charset[bytes[j] % charset.length];
        codes.push(code);
    }
    return codes;
}

// Checks a submitted backup code against the account's stored bcrypt hashes.
// A match is consumed immediately (removed from storage) so it can never be
// replayed — backup codes are one-time by design, unlike a TOTP code which
// is naturally single-use only within its 30s window.
async function consumeBackupCode(user, submittedCode) {
    const clean = String(submittedCode || '').toUpperCase().replace(/[\s-]/g, '');
    if (!clean || !user.backupCodes) return false;
    let hashedCodes;
    try { hashedCodes = JSON.parse(user.backupCodes); } catch { return false; }
    if (!Array.isArray(hashedCodes) || !hashedCodes.length) return false;

    for (let i = 0; i < hashedCodes.length; i++) {
        if (await bcrypt.compare(clean, hashedCodes[i])) {
            const remaining = hashedCodes.filter((_, idx) => idx !== i);
            stmt.users.setBackupCodes.run(JSON.stringify(remaining), user.id);
            return true;
        }
    }
    return false;
}

function deviceLabelFromUserAgent(ua) {
    if (!ua) return 'Unknown device';
    const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
        : /Macintosh/.test(ua) ? 'Mac'
        : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
        : /Linux/.test(ua) ? 'Linux'
        : 'Unknown OS';
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
        : 'Browser';
    return `${browser} on ${os}`;
}

async function pushAppNotificationToUser(userId, { title, body, data } = {}) {
    if (!userId) return;
    if (!APP_BUNDLE_ID || !process.env.APNS_KEY_ID || !process.env.APNS_KEY_PATH) return;
    const jwt = getApnsJwt();
    if (!jwt) return;

    const user = rowToUser(stmt.users.byId.get(userId));
    if (!user) return;
    const devices = stmt.pushDevices.byUserId.all(user.id);
    if (!devices.length) return;

    const pushTokens = [...new Set(devices.map(d => d.token))];
    const payload = JSON.stringify({
        aps: {
            alert: { title: title || 'New Registration', body: body || '' },
            sound: 'default'
        },
        data: data || {}
    });

    const host = process.env.APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
    let client;
    try { client = http2.connect(`https://${host}`); } catch { return; }

    for (const pushToken of pushTokens) {
        await new Promise((resolve) => {
            try {
                const req = client.request({
                    ':method': 'POST', ':path': `/3/device/${pushToken}`,
                    'authorization': `bearer ${jwt}`,
                    'apns-topic': APP_BUNDLE_ID,
                    'apns-push-type': 'alert',
                    'apns-priority': '10',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload)
                });
                req.write(payload);
                req.end();
                req.on('response', (headers) => {
                    const status = headers[':status'];
                    log('apns', `[push] App push → ${pushToken.slice(0, 8)}… status: ${status}`);
                    if (status === 410) {
                        stmt.pushDevices.deleteByToken.run(pushToken);
                    }
                    resolve();
                });
                req.on('error', (err) => { log('apns', `[ERR] App push error: ${err.message}`); resolve(); });
            } catch { resolve(); }
        });
    }
    try { client.close(); } catch { }
}

async function pushAppNotificationToTokens(tokens, { title, body, data } = {}) {
    if (!Array.isArray(tokens) || !tokens.length) return;
    if (!APP_BUNDLE_ID || !process.env.APNS_KEY_ID || !process.env.APNS_KEY_PATH) return;
    const jwt = getApnsJwt();
    if (!jwt) return;

    const payload = JSON.stringify({
        aps: {
            alert: { title: title || 'Notification', body: body || '' },
            sound: 'default'
        },
        data: data || {}
    });

    const host = process.env.APNS_PRODUCTION === 'true' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
    let client;
    try { client = http2.connect(`https://${host}`); } catch { return; }

    for (const pushToken of [...new Set(tokens)]) {
        await new Promise((resolve) => {
            try {
                const req = client.request({
                    ':method': 'POST', ':path': `/3/device/${pushToken}`,
                    'authorization': `bearer ${jwt}`,
                    'apns-topic': APP_BUNDLE_ID,
                    'apns-push-type': 'alert',
                    'apns-priority': '10',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload)
                });
                req.write(payload);
                req.end();
                req.on('response', (headers) => {
                    const status = headers[':status'];
                    log('apns', `[push] App push → ${pushToken.slice(0, 8)}… status: ${status}`);
                    if (status === 410) {
                        stmt.pushDevices.deleteByToken.run(pushToken);
                    }
                    resolve();
                });
                req.on('error', (err) => { log('apns', `[ERR] App push error: ${err.message}`); resolve(); });
            } catch { resolve(); }
        });
    }
    try { client.close(); } catch { }
}

app.set('trust proxy', 1);
app.use(compression({
    filter: (req, res) => {
        // Never gzip Server-Sent Events — compression buffers small chunks and
        // breaks real-time delivery. Skip on path prefix because Content-Type may
        // not be set yet when the filter runs.
        if (req.path && /\/(stream|monitor\/stream)(\/|$)/.test(req.path)) return false;
        return compression.filter(req, res);
    }
}));
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-XSS-Protection', '0');
    next();
});
app.use(express.json({
    limit: '20mb',
    verify: (req, _res, buf) => { if (req.path === '/api/stripe/webhook') req.rawBody = buf; },
}));
app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.resolve(__dirname, 'public/sw.js'));
});
app.use(session({
    store: new FileStore({
        // SESSIONS_DIR lets a test run keep its sessions in a throwaway
        // directory instead of the real one. Unset in normal runs.
        path: process.env.SESSIONS_DIR || './sessions',
        retries: 0
    }),
    secret: process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET env var is required'); })(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000
    }
}));
// Gate these pages before express.static gets a chance to serve them
// unconditionally — static file matches short-circuit the pipeline, so this
// must run first (scanner is PIN-protected itself, so excluded).
app.get('/admin.html', (req, res) => res.redirect('/dashboard.html'));
// The dashboard is for anyone who actually has a room to manage — the event's
// owner, someone it was shared with, or the admin. Every API it calls is
// scoped to the caller, so a collaborator opening this page sees only their
// own rooms; the admin-only panels inside it are hidden client-side and
// enforced by requireAdmin server-side. Someone with no rooms at all has
// nothing to show, so they go back to the public site.
app.get('/dashboard.html', (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login.html');
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user) return res.redirect('/login.html');
    const isAdmin = user.email === process.env.ADMIN_EMAIL;
    if (!isAdmin && personalEventIdsForUser(req.session.userId).size === 0) return res.redirect('/');
    next();
});
app.use(express.static('public', { extensions: ['html'] }));
app.get('/html5-qrcode.min.js', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'node_modules/html5-qrcode/html5-qrcode.min.js'));
});
app.get('/support', (req, res) => res.redirect('/support.html'));

// Android TWA domain verification — fill in sha256_cert_fingerprints after generating your APK with PWA Builder
app.get('/.well-known/assetlinks.json', (req, res) => {
    res.json([{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
            namespace: 'android_app',
            package_name: process.env.ANDROID_PACKAGE_NAME || 'com.willstechsupport.tickets',
            sha256_cert_fingerprints: (process.env.ANDROID_SHA256_FINGERPRINT || '').split(',').filter(Boolean)
        }
    }]);
});

// Rate limiting is real protection in production but makes an automated
// test run flaky the moment it logs in eleven times, so the suite turns it
// off with DISABLE_RATE_LIMITS=1. The limiter tests deliberately boot a
// server without that flag, so the limits themselves still get exercised.
const rateLimitsOff = process.env.DISABLE_RATE_LIMITS === '1';
const passThrough = (req, res, next) => next();
const makeLimiter = (opts) => rateLimitsOff ? passThrough : rateLimit(opts);

const loginLimiter = makeLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again later.' }
});

const forgotPasswordLimiter = makeLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many password reset requests. Please try again later.' }
});

const validateLimiter = makeLimiter({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many scan requests.' }
});

// Create pass-cache directory for pre-generated .pkpass files
const passCacheDir = process.env.PASS_CACHE_DIR
    ? path.resolve(process.env.PASS_CACHE_DIR)
    : path.resolve(__dirname, 'pass-cache');
fs.mkdirSync(passCacheDir, { recursive: true });

// Backfill scannerPin on any events that don't have one yet
{
    const backfillPin = db.prepare(`UPDATE events SET scannerPin = ? WHERE id = ? AND (scannerPin IS NULL OR scannerPin = '')`);
    const eventsNoPin = db.prepare(`SELECT id FROM events WHERE scannerPin IS NULL OR scannerPin = ''`).all();
    if (eventsNoPin.length > 0) {
        console.log(`[sync] Adding scanner PINs to ${eventsNoPin.length} existing event(s)...`);
        const tx = db.transaction(() => {
            for (const e of eventsNoPin) {
                backfillPin.run(Math.floor(100000 + Math.random() * 900000).toString(), e.id);
            }
        });
        tx();
        console.log('[OK] Scanner PINs assigned. View them in the dashboard.');
    }
}

const uploadsDir = path.resolve(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Auto-generate PWA icons from icon.svg if the PNGs don't exist yet
const iconsDir = path.resolve(__dirname, 'public', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });
const svgIconPath = path.join(iconsDir, 'icon.svg');
const icon192Path = path.join(iconsDir, 'icon-192.png');
const icon512Path = path.join(iconsDir, 'icon-512.png');
if (fs.existsSync(svgIconPath) && (!fs.existsSync(icon192Path) || !fs.existsSync(icon512Path))) {
    const svgBuf = fs.readFileSync(svgIconPath);
    await Promise.all([
        sharp(svgBuf).resize(192, 192).png().toFile(icon192Path),
        sharp(svgBuf).resize(512, 512).png().toFile(icon512Path),
    ]);
    console.log('[OK] PWA icons generated (icon-192.png, icon-512.png)');
}
const upload = multer({
    storage: multer.diskStorage({
        destination: uploadsDir,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase() || '.png';
            cb(null, `${Date.now()}-${nanoid(8)}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = file.mimetype === 'image/png' || file.mimetype === 'image/jpeg';
        cb(ok ? null : new Error('Only PNG or JPG images are allowed'), ok);
    }
});

// --- Auth API ---
// Signup enabled — creates a standard staff account
app.post('/api/auth/signup', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        log('signup', `[ERR] Missing fields — ip: ${getIP(req)}`);
        return res.status(400).json({ error: 'email and password required' });
    }

    const normalizedEmail = email.toLowerCase();
    log('signup', `[note] Attempt — email: ${normalizedEmail}  ip: ${getIP(req)}`);

    const existing = rowToUser(stmt.users.byEmail.get(normalizedEmail));
    if (existing) {
        log('signup', `[warn] Already exists — email: ${normalizedEmail}`);
        return res.status(400).json({ error: 'An account with this email already exists. Please log in instead.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const newUser = {
        id: nanoid(),
        email: normalizedEmail,
        password: hashedPassword,
        emailVerified: false,
        verifyToken,
        createdAt: new Date().toISOString()
    };
    stmt.users.insert.run(newUser.id, newUser.email, newUser.password, 0, newUser.verifyToken, newUser.createdAt);
    log('signup', `[OK] Account created (unverified) — email: ${normalizedEmail}  id: ${newUser.id}`);

    const verifyURL = `${BASE_URL}/verify-email.html?token=${verifyToken}`;
    sendEmail({
        to: normalizedEmail,
        subject: 'Verify your WTS Tickets account',
        html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
  <div style="text-align:center;margin-bottom:28px;">
    <div style="background:#1a1f3c;display:inline-block;padding:14px 20px;border-radius:12px;">
      <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.5px;">WTS Tickets</span>
    </div>
  </div>
  <h2 style="font-size:22px;font-weight:700;color:#1a1f3c;margin:0 0 10px;">Verify your email</h2>
  <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 28px;">
    Thanks for signing up. Click the button below to verify your email address and activate your account.
  </p>
  <div style="text-align:center;margin-bottom:28px;">
    <a href="${verifyURL}" style="background:#c4294a;color:#fff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 32px;border-radius:10px;display:inline-block;">
      Verify Email Address
    </a>
  </div>
  <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0;">
    This link expires in 24 hours. If you didn't create an account, you can ignore this email.
  </p>
  <div style="margin-top:12px;padding:12px 14px;background:#f8fafc;border-radius:8px;word-break:break-all;">
    <span style="color:#64748b;font-size:12px;">${verifyURL}</span>
  </div>
</div>`,
    }).catch(err => log('signup', `[warn] Verification email failed — ${err.message}`));

    res.json({ success: true, needsVerification: true, email: normalizedEmail });
});

// One-time admin setup — only works if no admin account exists yet
app.post('/api/auth/setup-admin', loginLimiter, async (req, res) => {
    const { password } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL;
    log('setup-admin', `[setup] Attempt — ip: ${getIP(req)}`);
    if (!adminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL not set in .env' });
    if (!password) return res.status(400).json({ error: 'password required' });

    const existing = rowToUser(stmt.users.byEmail.get(adminEmail));
    if (existing) {
        log('setup-admin', `[warn] Admin already exists — email: ${adminEmail}`);
        return res.status(400).json({ error: 'Admin account already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: nanoid(), email: adminEmail, password: hashedPassword, emailVerified: true, createdAt: new Date().toISOString() };
    stmt.users.insert.run(newUser.id, newUser.email, newUser.password, 1, null, newUser.createdAt);
    req.session.userId = newUser.id;
    log('setup-admin', `[OK] Admin created — email: ${adminEmail}  id: ${newUser.id}`);
    res.json({ success: true, message: `Admin account created for ${adminEmail}` });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password, rememberMe } = req.body;
    const normalizedEmail = (email || '').toLowerCase();
    log('login', `[login] Attempt — email: ${normalizedEmail}  ip: ${getIP(req)}`);

    const user = rowToUser(stmt.users.byEmail.get(normalizedEmail));
    if (!user) {
        log('login', `[ERR] No account found — email: ${normalizedEmail}  ip: ${getIP(req)}`);
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
        log('login', `[ERR] Wrong password — email: ${normalizedEmail}  ip: ${getIP(req)}`);
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Block login for unverified accounts (field absent = legacy user, treat as verified)
    if (user.emailVerified === false) {
        log('login', `[warn] Unverified email — email: ${normalizedEmail}`);
        return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox for a verification link.', needsVerification: true, email: normalizedEmail });
    }

    const isAdmin = user.email === process.env.ADMIN_EMAIL;

    if (user.totpEnabled) {
        let deviceTrusted = false;
        const rawDeviceToken = parseCookies(req).rememberDevice;
        const verifiedToken = verifyDeviceToken(rawDeviceToken);
        if (verifiedToken) {
            const device = stmt.trustedDevices.byTokenHash.get(hashDeviceToken(verifiedToken));
            if (device && device.userId === user.id) {
                deviceTrusted = true;
                stmt.trustedDevices.touchLastUsed.run(new Date().toISOString(), device.id);
            }
        }

        if (!deviceTrusted) {
            const pendingToken = signPendingTotpToken(user.id);
            log('login', `[2fa] TOTP required — email: ${normalizedEmail}  id: ${user.id}  ip: ${getIP(req)}`);
            return res.json({ needsTotp: true, pendingToken });
        }
    }

    req.session.userId = user.id;
    // Unchecking "Remember me" drops the cookie's Expires/Max-Age so it's a
    // browser-session cookie — gone once the browser fully closes, instead
    // of the default 30-day persistent login.
    if (rememberMe === false) req.session.cookie.expires = false;
    log('login', `[OK] Success — email: ${normalizedEmail}  id: ${user.id}  role: ${isAdmin ? 'admin' : 'staff'}  ip: ${getIP(req)}`);
    res.json({ success: true, user: { id: user.id, email: user.email } });
});

// Second step of login when the account has TOTP 2FA enabled — exchanges the
// short-lived pendingToken from /api/auth/login plus a 6-digit code for a
// real session, optionally remembering this device for future logins.
app.post('/api/auth/login/totp-verify', loginLimiter, async (req, res) => {
    const { pendingToken, code, remember, rememberMe } = req.body;
    const userId = verifyPendingTotpToken(pendingToken);
    if (!userId) {
        log('login', `[2fa] [ERR] Invalid/expired pending token  ip: ${getIP(req)}`);
        return res.status(401).json({ error: 'Invalid code' });
    }

    const user = rowToUser(stmt.users.byId.get(userId));
    if (!user || !user.totpEnabled || !user.totpSecret) {
        return res.status(401).json({ error: 'Invalid code' });
    }

    const codeStr = String(code || '').trim();
    let usedBackupCode = false;
    if (!verifyTotp(user.totpSecret, codeStr)) {
        usedBackupCode = await consumeBackupCode(user, codeStr);
        if (!usedBackupCode) {
            log('login', `[2fa] [ERR] Wrong code — email: ${user.email}  id: ${user.id}  ip: ${getIP(req)}`);
            return res.status(401).json({ error: 'Invalid code' });
        }
        log('login', `[2fa] [OK] Backup code used — email: ${user.email}  id: ${user.id}  ip: ${getIP(req)}`);
    }

    req.session.userId = user.id;
    if (rememberMe === false) req.session.cookie.expires = false;

    if (remember === true) {
        const deviceToken = signDeviceToken();
        const now = new Date().toISOString();
        stmt.trustedDevices.insert.run(
            nanoid(),
            user.id,
            hashDeviceToken(deviceToken),
            deviceLabelFromUserAgent(req.headers['user-agent']),
            now,
            now
        );
        res.cookie('rememberDevice', deviceToken, {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
            maxAge: REMEMBER_DEVICE_MAX_AGE_MS,
        });
    }

    const isAdmin = user.email === process.env.ADMIN_EMAIL;
    log('login', `[OK] TOTP verified — email: ${user.email}  id: ${user.id}  role: ${isAdmin ? 'admin' : 'staff'}  ip: ${getIP(req)}`);
    res.json({ success: true, user: { id: user.id, email: user.email }, usedBackupCode });
});

app.get('/api/auth/verify/:token', async (req, res) => {
    const { token } = req.params;
    if (!token || token.length < 32) return res.status(400).json({ error: 'Invalid token.' });
    const user = rowToUser(stmt.users.byVerifyToken.get(token));
    if (!user) return res.status(400).json({ error: 'This verification link is invalid or has already been used.' });
    stmt.users.setVerified.run(user.id);
    req.session.userId = user.id;
    log('verify', `[OK] Email verified — email: ${user.email}  id: ${user.id}`);
    res.json({ success: true, user: { id: user.id, email: user.email } });
});

app.post('/api/auth/resend-verify', loginLimiter, async (req, res) => {
    const normalizedEmail = ((req.body.email || '') + '').toLowerCase().trim();
    if (!normalizedEmail) return res.status(400).json({ error: 'Email required.' });
    const user = rowToUser(stmt.users.byEmail.get(normalizedEmail));
    // Always 200 — don't reveal account existence
    if (!user || user.emailVerified !== false) return res.json({ success: true });
    const verifyToken = crypto.randomBytes(32).toString('hex');
    stmt.users.setVerifyToken.run(verifyToken, normalizedEmail);
    const verifyURL = `${BASE_URL}/verify-email.html?token=${verifyToken}`;
    sendEmail({
        to: normalizedEmail,
        subject: 'Verify your WTS Tickets account',
        html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
  <div style="text-align:center;margin-bottom:28px;">
    <div style="background:#1a1f3c;display:inline-block;padding:14px 20px;border-radius:12px;">
      <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.5px;">WTS Tickets</span>
    </div>
  </div>
  <h2 style="font-size:22px;font-weight:700;color:#1a1f3c;margin:0 0 10px;">Verify your email</h2>
  <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 28px;">
    Click the button below to verify your email address and activate your WTS Tickets account.
  </p>
  <div style="text-align:center;margin-bottom:28px;">
    <a href="${verifyURL}" style="background:#c4294a;color:#fff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 32px;border-radius:10px;display:inline-block;">
      Verify Email Address
    </a>
  </div>
  <p style="color:#94a3b8;font-size:13px;margin:0 0 8px;">If you didn't create an account, you can ignore this email.</p>
  <div style="margin-top:12px;padding:12px 14px;background:#f8fafc;border-radius:8px;word-break:break-all;">
    <span style="color:#64748b;font-size:12px;">${verifyURL}</span>
  </div>
</div>`,
    }).catch(err => log('resend-verify', `[warn] Email failed — email: ${normalizedEmail}  err: ${err.message}`));
    log('resend-verify', `[OK] Verification email resent — email: ${normalizedEmail}`);
    res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
    if (!req.session.userId) {
        // Door staff on a scan link have no account, but they are a caller —
        // report the scoped identity so the scanner and check-in list can tell
        // the difference between "not signed in" and "signed in as nobody".
        const scoped = sessionScanLink(req);
        if (scoped) {
            const event = rowToEvent(stmt.events.byId.get(scoped.eventId));
            // Enough for the scanner to rebuild its locked-event state when
            // the page is reopened without the token in the URL — coming back
            // from the check-in list, mainly.
            return res.json({
                user: null,
                scanLink: {
                    eventId: scoped.eventId,
                    eventName: event ? event.name : '',
                    color: event ? event.color : null,
                    allowReentry: event ? event.allowReentry : false,
                    capabilities: SCAN_LINK_CAPABILITIES.slice(),
                },
            });
        }
        return res.status(401).json({ error: 'Not logged in' });
    }
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user.email === process.env.ADMIN_EMAIL;
    // hasRooms tells the login page whether to land this user on the dashboard
    // or the public site — it's the same test the /dashboard.html guard uses.
    const hasRooms = isAdmin || personalEventIdsForUser(user.id).size > 0;
    res.json({ user: { id: user.id, email: user.email, isAdmin, hasRooms, createdAt: user.createdAt } });
});



app.post('/api/auth/logout', (req, res) => {
    const userId = req.session.userId;
    const user = userId ? rowToUser(stmt.users.byId.get(userId)) : null;
    log('logout', `[logout] User logged out — email: ${user?.email || 'unknown'}  id: ${userId || 'none'}  ip: ${getIP(req)}`);
    req.session.destroy();
    res.json({ success: true });
});

app.post('/api/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
    const normalizedEmail = ((req.body.email || '') + '').toLowerCase().trim();
    const user = rowToUser(stmt.users.byEmail.get(normalizedEmail));
    // Always respond 200 — don't reveal whether an account exists
    if (!user) {
        log('forgot-password', `[note] No account for email — ip: ${getIP(req)}`);
        return res.json({ success: true });
    }
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    stmt.passwordResetTokens.deleteByUserId.run(user.id);
    stmt.passwordResetTokens.insert.run(nanoid(10), user.id, tokenHash, expiresAt, new Date().toISOString());
    const resetUrl = `${BASE_URL}/reset-password.html?token=${rawToken}`;
    await sendEmail({
        to: normalizedEmail,
        subject: 'Reset your password — Will\'s Tech Support Tickets',
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:auto;padding:32px 24px;background:#fff;border-radius:12px;">
            <div style="margin-bottom:24px;"><img src="${BASE_URL}/logo.png" alt="Will's Tech Support" style="height:28px;"></div>
            <h2 style="color:#1a1f3c;margin:0 0 8px;">Reset your password</h2>
            <p style="color:#64748b;margin:0 0 28px;">We received a request to reset the password for <strong>${normalizedEmail}</strong>. Click the button below to choose a new password.</p>
            <div style="text-align:center;margin:0 0 28px;">
                <a href="${resetUrl}" style="background:#1a1f3c;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block;">Reset Password</a>
            </div>
            <p style="color:#94a3b8;font-size:13px;margin:0 0 8px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
            <p style="color:#cbd5e1;font-size:11px;word-break:break-all;">Direct link: ${resetUrl}</p>
        </div>`
    }).catch(err => log('forgot-password', `[ERR] Email failed — email: ${normalizedEmail}  err: ${err.message}`));
    log('forgot-password', `[OK] Reset email sent — email: ${normalizedEmail}  ip: ${getIP(req)}`);
    res.json({ success: true });
});

app.post('/api/auth/reset-password', forgotPasswordLimiter, async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const entry = stmt.passwordResetTokens.byTokenHash.get(tokenHash);
    if (!entry || new Date(entry.expiresAt) < new Date()) {
        log('reset-password', `[ERR] Invalid or expired token  ip: ${getIP(req)}`);
        return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }
    const user = rowToUser(stmt.users.byId.get(entry.userId));
    if (!user) return res.status(400).json({ error: 'Account not found.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    stmt.users.setPassword.run(hashedPassword, entry.userId);
    stmt.passwordResetTokens.deleteByTokenHash.run(tokenHash);
    log('reset-password', `[OK] Password reset — email: ${user.email}  ip: ${getIP(req)}`);
    res.json({ success: true });
});

app.delete('/api/auth/account', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.session.userId;
    const userToDelete = rowToUser(stmt.users.byId.get(userId));
    log('account', `[delete] Account deletion — email: ${userToDelete?.email || 'unknown'}  id: ${userId}  ip: ${getIP(req)}`);
    const deleteAccount = db.transaction(() => {
        const eventIds = stmt.events.byUserId.all(userId).map(e => e.id);
        for (const eventId of eventIds) stmt.tickets.deleteByEventId.run(eventId);
        stmt.events.deleteByUserId.run(userId);
        stmt.sheetAccess.deleteByUserId.run(userId);
        stmt.scannerAccess.deleteByUserId.run(userId);
        stmt.pushDevices.deleteByUserId.run(userId);
        stmt.pushSubscriptions.deleteByUserId.run(userId);
        stmt.users.deleteById.run(userId);
    });
    deleteAccount();
    req.session.destroy();
    res.json({ success: true });
});

// Middleware to protect routes
const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

// --- Optional TOTP two-factor auth (account settings) ---

// Start (or restart) 2FA setup: generates a new secret that isn't active
// until confirmed via /api/account/2fa/enable, so an abandoned setup never
// half-enables 2FA on the account.
app.post('/api/account/2fa/setup', requireAuth, async (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const secret = generateBase32Secret();
    stmt.users.setTotpPendingSecret.run(secret, user.id);

    const otpauthUrl = `otpauth://totp/WTS%20Tickets:${encodeURIComponent(user.email)}?secret=${secret}&issuer=WTS%20Tickets&algorithm=SHA1&digits=6&period=30`;
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    log('2fa', `[setup] Pending secret generated — email: ${user.email}  id: ${user.id}`);
    res.json({ secret, otpauthUrl, qrDataUrl });
});

// Confirm setup with a live code from the authenticator app; only now does
// totpPendingSecret get promoted to the real totpSecret and 2FA turn on.
app.post('/api/account/2fa/enable', requireAuth, async (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!user.totpPendingSecret) return res.status(400).json({ error: 'No pending 2FA setup. Start setup again.' });

    const codeStr = String(req.body?.code || '').trim();
    if (!verifyTotp(user.totpPendingSecret, codeStr)) {
        log('2fa', `[enable] [ERR] Wrong code — email: ${user.email}  id: ${user.id}`);
        return res.status(401).json({ error: 'Invalid code' });
    }

    const backupCodes = generateBackupCodes();
    const hashedCodes = await Promise.all(backupCodes.map(c => bcrypt.hash(c, 10)));
    stmt.users.enableTotp.run(user.totpPendingSecret, JSON.stringify(hashedCodes), user.id);
    log('2fa', `[enable] [OK] 2FA enabled — email: ${user.email}  id: ${user.id}`);
    // Backup codes are shown once, in plaintext, and never retrievable again.
    res.json({ success: true, backupCodes });
});

// Turn 2FA off. Re-checks the password (not just the session) since this is
// a security-lowering action, then clears secrets, backup codes, and every
// remembered device for the account.
app.post('/api/account/2fa/disable', requireAuth, async (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const match = user.password ? await bcrypt.compare(String(req.body?.password || ''), user.password) : false;
    if (!match) {
        log('2fa', `[disable] [ERR] Wrong password — email: ${user.email}  id: ${user.id}`);
        return res.status(401).json({ error: 'Invalid password' });
    }

    stmt.users.disableTotp.run(user.id);
    stmt.trustedDevices.deleteByUserId.run(user.id);
    log('2fa', `[disable] [OK] 2FA disabled — email: ${user.email}  id: ${user.id}`);
    res.json({ success: true });
});

app.get('/api/account/2fa/status', requireAuth, (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    let backupCodesRemaining = 0;
    if (user.backupCodes) {
        try { backupCodesRemaining = JSON.parse(user.backupCodes).length; } catch {}
    }
    res.json({ enabled: !!user.totpEnabled, backupCodesRemaining });
});

// Invalidates all existing backup codes and issues a fresh set of 8 — same
// one-time-display UX as at initial enable. Password-gated like disable,
// since this silently invalidates codes the user may still be holding onto.
app.post('/api/account/2fa/backup-codes/regenerate', requireAuth, async (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user || !user.totpEnabled) return res.status(400).json({ error: 'Two-factor authentication is not enabled' });

    const match = user.password ? await bcrypt.compare(String(req.body?.password || ''), user.password) : false;
    if (!match) {
        log('2fa', `[backup-codes] [ERR] Wrong password — email: ${user.email}  id: ${user.id}`);
        return res.status(401).json({ error: 'Invalid password' });
    }

    const backupCodes = generateBackupCodes();
    const hashedCodes = await Promise.all(backupCodes.map(c => bcrypt.hash(c, 10)));
    stmt.users.setBackupCodes.run(JSON.stringify(hashedCodes), user.id);
    log('2fa', `[backup-codes] [OK] Regenerated — email: ${user.email}  id: ${user.id}`);
    res.json({ success: true, backupCodes });
});

app.get('/api/account/2fa/devices', requireAuth, (req, res) => {
    const devices = stmt.trustedDevices.byUserId.all(req.session.userId).map(d => ({
        id: d.id,
        label: d.label,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
    }));
    res.json(devices);
});

app.delete('/api/account/2fa/devices/:id', requireAuth, (req, res) => {
    const device = stmt.trustedDevices.byId.get(req.params.id);
    if (!device || device.userId !== req.session.userId) {
        return res.status(404).json({ error: 'Not found' });
    }
    stmt.trustedDevices.deleteById.run(device.id);
    res.json({ success: true });
});

app.post('/api/account/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    stmt.users.setPassword.run(hashedPassword, user.id);
    res.json({ success: true });
});

app.get('/api/admin/logs', requireAdmin, (req, res) => {
    res.json(logBuffer);
});

// Persistent, per-event audit trail (view-level access — anyone who can see
// the event's dashboard can see who did what to it).
app.get('/api/event/:id/audit-log', requireAuth, (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventAccess(req.session.userId, eventId)) {
        return res.status(403).json({ error: 'You do not have access to this event' });
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const entries = stmt.auditLog.byEventId.all(eventId, limit, offset).map(row => ({
        ...row,
        details: row.details ? JSON.parse(row.details) : null,
    }));
    const total = stmt.auditLog.countByEventId.get(eventId)?.cnt ?? 0;
    res.json({ entries, total });
});

// Register device for app push notifications
app.post('/api/push/register', requireAuth, async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token required' });

    const userId = req.session.userId;
    const now = new Date().toISOString();

    const existing = stmt.pushDevices.byToken.get(token);
    if (existing) {
        stmt.pushDevices.upsert.run(userId, now, token);
    } else {
        stmt.pushDevices.insert.run(nanoid(8), userId, token, now, now);
    }

    res.json({ success: true });
});

// Declared as a function, not a const, so routes registered earlier in the
// file can reference it without hitting the temporal dead zone.
function requireAdmin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user || user.email !== process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// System-wide audit trail (admin only).
app.get('/api/admin/audit-log', requireAdmin, (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const entries = stmt.auditLog.all.all(limit, offset).map(row => ({
        ...row,
        details: row.details ? JSON.parse(row.details) : null,
    }));
    const total = stmt.auditLog.countAll.get()?.cnt ?? 0;
    res.json({ entries, total });
});

// ── Granular per-collaborator permissions ──────────────────────────────────
//
// A share used to be one of two things: 'view' (can check people in) or
// 'full' (can do everything the owner can). That's now the preset layer over
// a real capability list, so an owner can hand out, say, refunds and exports
// without also handing over the ability to delete the event.
//
// Order matters — it's the order capabilities render in the sharing UI.
const CAPABILITIES = [
    { key: 'checkin',          label: 'Check attendees in',       hint: 'Scan tickets and check people in at the door.' },
    { key: 'undo_checkin',     label: 'Undo check-ins',           hint: 'Reverse a check-in that was made by mistake.' },
    { key: 'manage_tickets',   label: 'Manage registrations',     hint: 'Add, edit, and remove attendees.' },
    { key: 'email_attendees',  label: 'Email and notify',         hint: 'Send confirmations, bulk email, reminders, and push.' },
    { key: 'manage_event',     label: 'Edit event settings',      hint: 'Change event details, custom fields, and scanner links.' },
    { key: 'manage_waitlist',  label: 'Manage the waitlist',      hint: 'Promote or remove people waiting for a spot.' },
    { key: 'manage_discounts', label: 'Manage discount codes',    hint: 'Create, edit, and delete discount codes.' },
    { key: 'manage_payments',  label: 'View orders and refund',   hint: 'See paid orders and issue refunds through Stripe.' },
    { key: 'export_data',      label: 'Export attendee data',     hint: 'Download CSVs and use the event API key.' },
    { key: 'manage_access',    label: 'Manage who has access',    hint: 'Share the event with others and change their permissions.' },
    { key: 'delete_event',     label: 'Delete the event',         hint: 'Permanently delete the event and everything in it.' },
];
const CAPABILITY_KEYS = CAPABILITIES.map(c => c.key);
// The two legacy roles, expressed as capability lists. 'view' has always meant
// "can check people in but not undo it", so that's exactly what it maps to.
const ROLE_CAPABILITIES = {
    view: ['checkin'],
    full: CAPABILITY_KEYS.slice(),
};

function normalizeCapabilities(list) {
    if (!Array.isArray(list)) return null;
    const seen = new Set(list.filter(c => CAPABILITY_KEYS.includes(c)));
    // Anything that implies being at the door implies being able to check in,
    // otherwise a grant like "undo check-ins" would be unusable on its own.
    if (seen.has('undo_checkin')) seen.add('checkin');
    return CAPABILITY_KEYS.filter(k => seen.has(k));
}

// The capability list a sheetAccess row actually grants. Rows written before
// the capabilities column existed have NULL there and fall back to their role.
function capabilitiesForAccessRow(access) {
    if (!access) return [];
    if (access.capabilities) {
        try {
            const parsed = normalizeCapabilities(JSON.parse(access.capabilities));
            if (parsed) return parsed;
        } catch { /* fall through to the role below */ }
    }
    return ROLE_CAPABILITIES[access.permission === 'full' ? 'full' : 'view'].slice();
}

// The role label to show for a grant: one of the two presets when the
// capability list matches it exactly, otherwise 'custom'.
function roleForCapabilities(caps) {
    const key = caps.slice().sort().join(',');
    if (key === ROLE_CAPABILITIES.full.slice().sort().join(',')) return 'full';
    if (key === ROLE_CAPABILITIES.view.slice().sort().join(',')) return 'view';
    return 'custom';
}

// Everything a user can do on an event. Admin and owner get the lot; a scan
// link grants check-in only; a share grants whatever its row says.
function userEventCapabilities(userId, eventId) {
    const user = rowToUser(stmt.users.byId.get(userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return [];
    // The admin keeps authority over every event — they just don't have those
    // events listed as theirs (see /api/events and /api/my-rooms).
    if (isAdmin || event.userId === userId) return CAPABILITY_KEYS.slice();

    const caps = new Set();
    if (stmt.scannerAccess.byUserAndEvent.get(userId, eventId)) caps.add('checkin');
    for (const a of stmt.sheetAccess.byUserId.all(userId)) {
        const link = stmt.sheetLinks.byId.get(a.sheetLinkId);
        if (!link || link.eventId !== eventId) continue;
        for (const c of capabilitiesForAccessRow(a)) caps.add(c);
    }
    return CAPABILITY_KEYS.filter(k => caps.has(k));
}

function userHasEventCapability(userId, eventId, capability) {
    return userEventCapabilities(userId, eventId).includes(capability);
}

// ── Scan-link sessions (no-login door staff) ───────────────────────────────
//
// Opening a scan link puts a scoped identity on the session: one event, a
// fixed set of capabilities, no user account. It lets door staff work the
// check-in list and put a display on screen without an account, while staying
// far short of what a real collaborator can do — no editing the event, no
// emailing attendees, no exports, no access management.
const SCAN_LINK_CAPABILITIES = ['checkin', 'undo_checkin'];

// The session's scan link, re-validated on every use so revoking the link (or
// deleting the event) takes effect immediately rather than at session expiry.
function sessionScanLink(req) {
    const scoped = req.session?.scanLink;
    if (!scoped?.token) return null;
    const link = stmt.scannerLinks.byToken.get(scoped.token);
    if (!link || link.eventId !== scoped.eventId) return null;
    if (!stmt.events.byId.get(link.eventId)) return null;
    return { linkId: link.id, eventId: link.eventId, token: link.token };
}

// What the caller may do to this event, whoever they are — a signed-in user
// or a scan link. Use this (not userHasEventCapability) on any route that
// no-login door staff are meant to reach.
function requestEventCapabilities(req, eventId) {
    if (req.session?.userId) return userEventCapabilities(req.session.userId, eventId);
    const scoped = sessionScanLink(req);
    if (scoped && scoped.eventId === eventId) return SCAN_LINK_CAPABILITIES.slice();
    return [];
}

function requestHasCapability(req, eventId, capability) {
    return requestEventCapabilities(req, eventId).includes(capability);
}

// Like requireAuth, but a scan-link session counts as a caller too.
function requireAuthOrScanLink(req, res, next) {
    if (req.session?.userId || sessionScanLink(req)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

// True when the user can see the event at all — any capability is enough.
function userHasEventAccess(userId, eventId) {
    return userEventCapabilities(userId, eventId).length > 0;
}

// Retained for the handful of places that genuinely mean "can do everything
// here", and for the `fullAccess` flag the dashboard and iOS app already read.
function userHasEventFullAccess(userId, eventId) {
    const caps = userEventCapabilities(userId, eventId);
    return CAPABILITY_KEYS.every(k => caps.includes(k));
}

// True when this user owns the event outright (or is the admin), as opposed to
// holding a share on it. Used to decide who may hand out `manage_access`.
function userOwnsEvent(userId, eventId) {
    const user = rowToUser(stmt.users.byId.get(userId));
    if (user && user.email === process.env.ADMIN_EMAIL) return true;
    const event = rowToEvent(stmt.events.byId.get(eventId));
    return !!(event && event.userId === userId);
}

// The event IDs this user has been given personally: owned outright, shared
// with them, or reached through a scan link. Deliberately does NOT special-case
// the admin — the admin's own room list is just their rooms, and everyone
// else's live behind the separate admin overview.
function personalEventIdsForUser(userId) {
    const ids = new Set(stmt.events.byUserId.all(userId).map(e => e.id));
    for (const a of stmt.sheetAccess.byUserId.all(userId)) {
        const link = stmt.sheetLinks.byId.get(a.sheetLinkId);
        if (link && link.eventId) ids.add(link.eventId);
    }
    for (const a of stmt.scannerAccess.byUserId.all(userId)) ids.add(a.eventId);
    // Grants can outlive the event they point at (older deletions didn't clean
    // up sheetLinks/sheetAccess). Drop the dead ones so callers that just count
    // this set — the dashboard guard, hasRooms — aren't fooled by a ghost.
    for (const id of ids) {
        if (!stmt.events.byId.get(id)) ids.delete(id);
    }
    return ids;
}

app.get('/api/event/:id/push-subscription', requireAuth, (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventAccess(req.session.userId, eventId)) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    const sub = stmt.pushSubscriptions.byUserAndEvent.get(req.session.userId, eventId);
    res.json({ enabled: !!(sub?.enabled) });
});

app.patch('/api/event/:id/push-subscription', requireAuth, async (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventAccess(req.session.userId, eventId)) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    const enabled = !!req.body?.enabled;
    const now = new Date().toISOString();
    const sub = stmt.pushSubscriptions.byUserAndEvent.get(req.session.userId, eventId);
    if (sub) {
        stmt.pushSubscriptions.setEnabled.run(enabled ? 1 : 0, now, req.session.userId, eventId);
    } else {
        stmt.pushSubscriptions.insert.run(nanoid(8), req.session.userId, eventId, enabled ? 1 : 0, now, now);
    }
    res.json({ success: true, enabled });
});

app.get('/api/event/:id/push-devices', requireAuth, (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventCapability(req.session.userId, eventId, 'email_attendees')) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    const subs = stmt.pushSubscriptions.byEventEnabled.all(eventId);
    const userIds = new Set(subs.map(s => s.userId));
    const allDevices = db.prepare(`SELECT * FROM pushDevices WHERE userId IN (${[...userIds].map(() => '?').join(',') || "''"})`)
        .all(...userIds);
    const devices = allDevices.map(d => {
        const u = rowToUser(stmt.users.byId.get(d.userId));
        return { id: d.id, token: d.token, userId: d.userId, email: u?.email || 'unknown', lastSeenAt: d.lastSeenAt || d.createdAt };
    });
    res.json(devices);
});

app.post('/api/event/:id/push-send', requireAuth, async (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventCapability(req.session.userId, eventId, 'email_attendees')) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const title = String(req.body?.title || '').trim() || `Update • ${event.name}`;
    const body = String(req.body?.body || '').trim();
    const target = req.body?.target === 'devices' ? 'devices' : 'subscribers';

    // Also show as an in-app banner to anyone with a scanner open for this
    // event right now — same mechanism as Monitor's Notify (SSE), so unlike
    // the real APNs push below it doesn't depend on notification permission
    // at all. APNs is still needed to reach devices where the app isn't open.
    const bannerPayload = { type: 'notification', title, message: body, sentAt: new Date().toISOString() };
    for (const [pairToken, data] of scannerRegistry) {
        if (data.eventId === eventId) broadcastToPair(pairToken, bannerPayload);
    }

    if (target === 'devices') {
        const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens.filter(Boolean) : [];
        if (!tokens.length) return res.status(400).json({ error: 'No devices selected' });
        await pushAppNotificationToTokens(tokens, { title, body });
        return res.json({ success: true, sent: tokens.length });
    }

    const subs = stmt.pushSubscriptions.byEventEnabled.all(eventId);
    const userIds = new Set(subs.map(s => s.userId));
    const tokens = userIds.size
        ? db.prepare(`SELECT token FROM pushDevices WHERE userId IN (${[...userIds].map(() => '?').join(',')})`).all(...userIds).map(d => d.token)
        : [];
    await pushAppNotificationToTokens(tokens, { title, body });
    res.json({ success: true, sent: tokens.length });
});

// Email open tracking pixel (public — no auth, called by email clients)
app.get('/api/track/open/:registrationId', async (req, res) => {
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(TRANSPARENT_GIF);
    // Record after responding so we don't slow the email client
    const { registrationId } = req.params;
    const tickets = stmt.tickets.byRegistrationId.all(registrationId).map(rowToTicket);
    if (tickets.length && !tickets[0].email_opened_at) {
        const now = new Date().toISOString();
        stmt.tickets.setEmailOpened.run(now, registrationId);
        log('email-open', `[opened] Opened — regId: ${registrationId}  name: ${tickets[0].name}`);
    }
});

// ── Seat holds ─────────────────────────────────────────────────────────────
//
// Capacity used to be checked only at submit, which meant ten people could
// fill in the form for four spots and six of them were told "sold out" after
// typing everything in. On a paid event it was worse: all ten could reach
// Stripe and pay, because the webhook issues the ticket without re-checking.
//
// A hold is a short-lived claim taken when the form is opened. Held seats
// count as occupied, so the eleventh person is turned away *before* filling
// anything in, and nobody pays for a seat that isn't there.

// How long a hold survives without being refreshed. Long enough to fill in a
// form unhurried; short enough that abandoned tabs free their seat quickly.
// The page refreshes its hold well inside this.
const SEAT_HOLD_MS = 8 * 60 * 1000;
// Checkout needs longer — the person is on Stripe's page, off ours.
const SEAT_HOLD_CHECKOUT_MS = 25 * 60 * 1000;

function purgeStaleHolds() {
    try { stmt.seatHolds.purgeStale.run(new Date().toISOString()); } catch (_) {}
}

// ── Signup limits ──────────────────────────────────────────────────────────
//
// Three independent restrictions an organiser can put on public registration.
// All default off (or, for multiple registrations, on) so existing events keep
// behaving exactly as they did.

// Nothing on this server parses cookies, and the only one we set is this
// marker, so a small reader beats pulling in cookie-parser.
function readCookie(req, name) {
    const raw = req.headers?.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
}

const deviceCookieName = (eventId) => `wtsreg_${eventId}`;

// A browser-level marker, not an identity. Clearing cookies, a private window
// or a second phone all defeat it — it stops the same person casually
// registering twice, and nothing more. Worth being honest about in the UI.
function deviceAlreadyRegistered(req, eventId) {
    return readCookie(req, deviceCookieName(eventId)) === '1';
}

function markDeviceRegistered(res, eventId) {
    res.cookie(deviceCookieName(eventId), '1', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 180 * 24 * 60 * 60 * 1000,
    });
}

function emailAlreadyRegistered(eventId, email) {
    if (!email) return false;
    return !!stmt.tickets.byEventAndEmail.get(eventId, String(email).trim().toLowerCase());
}

// The one place that decides whether this visitor may register at all, so the
// hold endpoint, the free path and checkout can't drift apart. Returns null
// when they're clear, or `{ code, error }` describing the refusal.
function signupBlockReason(req, event, email) {
    if (event.oneRegistrationPerDevice && deviceAlreadyRegistered(req, event.id)) {
        return { code: 'device_already_registered', error: 'This device has already registered for this event.' };
    }
    if (email && event.blockDuplicateEmails && emailAlreadyRegistered(event.id, email)) {
        return { code: 'email_already_registered', error: 'That email address is already registered for this event.' };
    }
    return null;
}

// The single source of truth for "is there room?". Issued tickets, live holds
// and unclaimed waitlist offers all occupy a seat.
function eventSeatUsage(eventId) {
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return null;
    const nowIso = new Date().toISOString();
    const issued = stmt.tickets.countByEventId.get(eventId)?.cnt ?? 0;
    const held = event.capacity ? (stmt.seatHolds.countActive.get(eventId, nowIso)?.cnt ?? 0) : 0;
    const claimed = event.capacity ? (stmt.waitlist.countActiveClaims.get(eventId, nowIso)?.cnt ?? 0) : 0;
    const capacity = event.capacity || null;
    const taken = issued + held + claimed;
    return {
        capacity,
        issued,
        held,
        claimed,
        taken,
        // Only what a stranger should see: how many seats are left, and whether
        // the door is shut. Never leaks the hold/claim breakdown publicly.
        remaining: capacity ? Math.max(0, capacity - taken) : null,
        soldOut: capacity ? taken >= capacity : false,
        unlimited: !capacity,
    };
}

// Take (or refresh) a hold. Refreshing an existing token never consumes a
// second seat, so a page that reloads mid-form keeps the one it already had.
// Responds with `granted` (did *you* get a seat) — deliberately not `held`,
// which is the number of seats other people are holding.
app.post('/api/event/:id/hold', (req, res) => {
    purgeStaleHolds();
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.allowPublicRegistration) {
        return res.status(403).json({ error: 'Registration is not open for this event' });
    }

    // Same door check as registration, applied up front — being told "you've
    // already registered" after filling in a form is the thing this whole
    // hold mechanism exists to avoid.
    const blocked = signupBlockReason(req, event, null);
    if (blocked) return res.status(409).json({ granted: false, reason: blocked.code, error: blocked.error, ...eventSeatUsage(event.id) });

    const qty = Math.max(1, Math.min(20, parseInt(req.body?.quantity, 10) || 1));
    const existingToken = (req.body?.holdToken || '').trim();
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SEAT_HOLD_MS).toISOString();

    // No capacity means no scarcity to manage — say so and skip the bookkeeping.
    if (!event.capacity) {
        return res.json({ granted: true, unlimited: true, holdToken: null, ...eventSeatUsage(event.id) });
    }

    const existing = existingToken ? stmt.seatHolds.byToken.get(existingToken) : null;
    if (existing && existing.eventId === event.id && existing.status === 'active' && existing.expiresAt > nowIso) {
        // Growing an existing hold still has to fit.
        if (qty > existing.quantity) {
            const usage = eventSeatUsage(event.id);
            if (usage.taken - existing.quantity + qty > usage.capacity) {
                return res.status(409).json({ granted: false, reason: 'not_enough_room', ...usage });
            }
        }
        stmt.seatHolds.touch.run(expiresAt, qty, existingToken);
        return res.json({ granted: true, holdToken: existingToken, expiresAt, ...eventSeatUsage(event.id) });
    }

    const usage = eventSeatUsage(event.id);
    if (usage.taken + qty > usage.capacity) {
        return res.status(409).json({
            granted: false,
            reason: usage.issued >= usage.capacity ? 'sold_out' : 'all_held',
            waitlistEnabled: !!event.waitlistEnabled,
            ...usage,
        });
    }

    const token = nanoid(20);
    stmt.seatHolds.insert.run(nanoid(10), event.id, token, qty, 'active', null, nowIso, expiresAt);
    res.json({ granted: true, holdToken: token, expiresAt, ...eventSeatUsage(event.id) });
});

// Give a seat back — sent when the form is closed or abandoned.
app.post('/api/event/:id/hold/release', (req, res) => {
    const token = (req.body?.holdToken || '').trim();
    if (token) {
        const hold = stmt.seatHolds.byToken.get(token);
        if (hold && hold.eventId === req.params.id && hold.status === 'active') {
            stmt.seatHolds.setStatus.run('released', token);
        }
    }
    res.json({ success: true });
});

// Live availability for the public registration page. Answers from the
// caller's point of view: pass your own holdToken and your seat is not counted
// against you, and you're told whether that seat is still good.
app.get('/api/event/:id/availability', (req, res) => {
    purgeStaleHolds();
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const usage = eventSeatUsage(event.id);

    const token = (req.query.holdToken || '').trim();
    const hold = token ? stmt.seatHolds.byToken.get(token) : null;
    const mine = hold && hold.eventId === event.id && hold.status === 'active'
        && hold.expiresAt > new Date().toISOString() ? hold.quantity : 0;

    // A hold only means something while issued tickets alone leave room for
    // it. Other paths (manual add, sheet import, door sales) can fill the
    // event out from under a holder, and telling them they still have a spot
    // when they don't is worse than telling them they lost it.
    const holdStillValid = usage.capacity ? (mine > 0 && usage.issued + mine <= usage.capacity) : !!mine;

    res.json({
        capacity: usage.capacity,
        registered: usage.issued,
        // Seats free to someone who isn't already holding one — a holder
        // shouldn't see "none left" while looking at their own reserved spot.
        remaining: usage.capacity ? Math.max(0, usage.capacity - usage.taken + mine) : null,
        soldOut: usage.capacity ? (usage.taken - mine) >= usage.capacity : false,
        unlimited: usage.unlimited,
        // Someone else is mid-signup — worth showing so a visitor understands
        // why the count moved without a ticket being issued.
        holding: Math.max(0, usage.held - mine),
        holdStillValid,
        waitlistEnabled: !!event.waitlistEnabled,
        registrationOpen: !!event.allowPublicRegistration,
    });
});

// Explains a refusal in terms the person reading it can act on — "at
// capacity" is confusing when the tickets aren't actually issued yet.
function heldSeatMessage(usage, wanted = 1) {
    const base = `Event is at capacity (${usage.capacity} max, ${usage.issued} registered`;
    if (usage.held > 0) {
        return `${base}, ${usage.held} being filled in right now). Those held spots are released automatically if they aren't completed.`;
    }
    return `${base})${wanted > 1 ? ` — not enough room for ${wanted}` : ''}.`;
}

// Turns a hold into a seat. Returns ok when the caller may proceed: either
// they presented a live hold, or there was room anyway.
function consumeHoldOrCheckRoom(event, holdToken, quantity = 1) {
    if (!event.capacity) return { ok: true };
    const nowIso = new Date().toISOString();
    const hold = holdToken ? stmt.seatHolds.byToken.get(holdToken) : null;
    const holdValid = hold && hold.eventId === event.id && hold.status === 'active' && hold.expiresAt > nowIso;

    if (holdValid) {
        // A hold is a promise, but it can't be honoured past the point where
        // honouring it oversells the event. Tickets issued through paths that
        // don't reserve seats — a manual add, a sheet import, a door sale —
        // can fill the event out from under a hold. Issue the ticket anyway
        // and the event goes over capacity, which is the one outcome nobody
        // can undo, so refuse and say plainly what happened.
        const usage = eventSeatUsage(event.id);
        if (usage.issued + quantity > usage.capacity) {
            stmt.seatHolds.setStatus.run('released', holdToken);
            return { ok: false, usage, filledUnderHold: true };
        }
        stmt.seatHolds.setStatus.run('consumed', holdToken);
        return { ok: true, usedHold: true };
    }

    // No hold (or it lapsed): fall back to the plain capacity test, so a
    // direct API call or an expired form still can't oversell.
    const usage = eventSeatUsage(event.id);
    if (usage.taken + quantity > usage.capacity) return { ok: false, usage };
    return { ok: true, usedHold: false };
}

// Public self-registration — creates a free ticket and emails it
app.post('/api/register', async (req, res) => {
    const { name, email, eventId, holdToken } = req.body;
    if (!name || !email || !eventId) {
        return res.status(400).json({ error: 'Name, email, and event are required' });
    }

    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.allowPublicRegistration) {
        return res.status(403).json({ error: 'Registration is not open for this event' });
    }
    // This is the free-ticket path. /api/checkout/:eventId refuses a free
    // event and points here; without the matching refusal in this direction,
    // posting straight to this route hands out a paid event's tickets for
    // nothing, Stripe never involved.
    if (event.ticketPrice > 0) {
        return res.status(400).json({ error: 'This event is paid — use the checkout link to buy a ticket' });
    }

    const blockedHere = signupBlockReason(req, event, email);
    if (blockedHere) return res.status(409).json({ error: blockedHere.error, reason: blockedHere.code });

    // Presenting a live hold guarantees the seat that was set aside when this
    // form was opened; without one this still falls back to a capacity check,
    // so a direct API call can't slip past.
    const seat = consumeHoldOrCheckRoom(event, holdToken);
    if (!seat.ok) {
        if (event.waitlistEnabled) {
            return res.json(await joinWaitlist(event, name, email));
        }
        return res.status(400).json({
            error: seat.filledUnderHold
                ? 'This event filled up while you were signing up, so the spot that was being held for you is no longer available.'
                : 'This event is sold out',
            reason: seat.filledUnderHold ? 'filled_under_hold' : 'sold_out',
        });
    }

    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;
    const token = nanoid(12);
    const ticketId = nanoid(8);
    const registrationId = nanoid(10);
    const now = new Date().toISOString();

    stmt.tickets.insert.run(ticketId, eventId, token, registrationId, name.trim(), firstName, lastName, email.trim().toLowerCase(), null, null, null, null, null, now, null, null);
    const ticket = rowToTicket(stmt.tickets.byToken.get(token));

    const qrDataUrl = await QRCode.toDataURL(`ticket:${token}`);

    if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        const { html, attachments, subject: subjectOverride } = await buildTicketEmailHtml({
            firstName,
            intro: `You&rsquo;re all set for <strong>${event.name}</strong>! We&rsquo;ll see you there.`,
            event,
            tickets: [ticket],
        });
        sendEmail({
            to: email.trim().toLowerCase(),
            fromName: `Tickets - ${event.name}`,
            replyTo: REPLY_TO_EMAIL,
            subject: subjectOverride || `Your ticket for ${event.name}`,
            html,
            attachments,
            registrationId,
        }).catch(() => {});
    }

    log('register', `[public] New registration — name: ${name}  email: ${email}  event: ${event.name}`);
    // Marks this browser so "one registration per device" can recognise it
    // later. Only set on success, so a failed attempt doesn't lock anyone out.
    if (event.oneRegistrationPerDevice) markDeviceRegistered(res, event.id);
    res.json({ success: true, ticket: { token, registrationId }, qr: qrDataUrl });
});

// Toggle public registration on/off for an event
app.put('/api/event/:id/public-registration', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) return res.status(403).json({ error: 'Forbidden' });

    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    stmt.events.setPublicRegistration.run(enabled ? 1 : 0, req.params.id);
    log('event-settings', `[edit] Public registration ${enabled ? 'enabled' : 'disabled'} — event: ${event.name}  by: ${req.session.userId}`);
    res.json({ success: true, allowPublicRegistration: enabled });
});

// ── Stripe ────────────────────────────────────────────────────────────────────

// Shared helper: issue a ticket + send confirmation email after a confirmed payment.
// Returns { ticket, dbEvent, firstName, registrationId } or null if event missing.
// Returns { discountCode, discountAmount, finalAmount } on success, or { error }.
// baseAmount is in cents. Does NOT increment usedCount — that only happens
// once a payment is actually confirmed (webhook), so abandoned checkouts
// don't burn a redemption.
function validateDiscountCode(eventId, rawCode, baseAmount) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) return { error: 'No code provided' };
    const row = stmt.discountCodes.byEventAndCode.get(eventId, code);
    if (!row) return { error: 'Invalid discount code' };
    const discountCode = rowToDiscountCode(row);
    if (!discountCode.active) return { error: 'This discount code is no longer active' };
    if (discountCode.expiresAt && new Date(discountCode.expiresAt) < new Date()) {
        return { error: 'This discount code has expired' };
    }
    if (discountCode.maxUses != null && discountCode.usedCount >= discountCode.maxUses) {
        return { error: 'This discount code has reached its usage limit' };
    }
    const discountAmount = discountCode.type === 'percent'
        ? Math.round(baseAmount * discountCode.value / 100)
        : Math.min(baseAmount, discountCode.value);
    return { discountCode, discountAmount, finalAmount: Math.max(0, baseAmount - discountAmount) };
}

async function issueTicketForPayment({ eventId, buyerName, buyerEmail }) {
    const dbEvent = rowToEvent(stmt.events.byId.get(eventId));
    if (!dbEvent) return null;

    const nameParts = (buyerName || '').split(/\s+/).filter(Boolean);
    const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : (nameParts[0] || '');
    const lastName  = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;
    const token = nanoid(12);
    const ticketId = nanoid(8);
    const registrationId = nanoid(10);
    const now = new Date().toISOString();

    stmt.tickets.insert.run(ticketId, eventId, token, registrationId, buyerName, firstName, lastName, buyerEmail, null, null, null, null, null, now, null, null);
    const ticket = rowToTicket(stmt.tickets.byToken.get(token));

    if (buyerEmail && process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        const { html, attachments, subject: subjectOverride } = await buildTicketEmailHtml({
            firstName,
            intro: `You&rsquo;re all set for <strong>${dbEvent.name}</strong>! We&rsquo;ll see you there.`,
            event: dbEvent,
            tickets: [ticket],
        });
        sendEmail({
            to: buyerEmail,
            fromName: `Tickets - ${dbEvent.name}`,
            replyTo: REPLY_TO_EMAIL,
            subject: subjectOverride || `Your ticket for ${dbEvent.name}`,
            html,
            attachments,
            registrationId,
        }).catch(() => {});
    }

    return { ticket, dbEvent, firstName, registrationId };
}

// Create a Checkout Session for a paid ticket
app.post('/api/checkout/:eventId', async (req, res) => {
    // Paid ticketing is beta: an organiser can set a price without a Stripe
    // account existing behind it, and the first person to notice is whoever
    // tries to buy. Say what's actually wrong and who fixes it.
    if (!stripe) return res.status(503).json({ error: 'Ticket sales are not connected for this event yet. The organiser needs to have a Stripe account connected (support@willstechsupport.com) before tickets can be sold.' });
    const { name, email, discountCode, claimToken } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const event = rowToEvent(stmt.events.byId.get(req.params.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.allowPublicRegistration) return res.status(403).json({ error: 'Registration is not open for this event' });
    if (!event.ticketPrice) return res.status(400).json({ error: 'This event is free — use /api/register' });

    const cleanEmail = email.trim().toLowerCase();
    const cleanName  = name.trim();

    // A promoted waitlist entry gets a claimToken good for a limited window —
    // presenting a still-active one bypasses the capacity gate entirely,
    // since the organizer already chose to seat this specific person.
    let claimEntry = null;
    if (claimToken) {
        const candidate = stmt.waitlist.byEventAndClaimToken.get(event.id, claimToken);
        if (candidate && candidate.status === 'notified' && candidate.claimExpiresAt > new Date().toISOString()) {
            claimEntry = candidate;
        }
    }

    // A promoted waitlist entry already has a seat set aside, so it skips the
    // capacity gate. Everyone else must still fit — counting issued tickets,
    // live holds and outstanding waitlist offers.
    const paidHoldToken = (req.body?.holdToken || '').trim();

    // A claim link is a seat the organiser already promised to this person, so
    // it isn't subject to the general signup limits.
    if (!claimEntry) {
        const blockedPaid = signupBlockReason(req, event, cleanEmail);
        if (blockedPaid) return res.status(409).json({ error: blockedPaid.error, reason: blockedPaid.code });
    }

    if (event.capacity && !claimEntry) {
        const usage = eventSeatUsage(event.id);
        const heldByCaller = paidHoldToken ? stmt.seatHolds.byToken.get(paidHoldToken) : null;
        const callerHoldsSeat = heldByCaller && heldByCaller.eventId === event.id
            && heldByCaller.status === 'active' && heldByCaller.expiresAt > new Date().toISOString();
        if (!callerHoldsSeat && usage.taken >= usage.capacity) {
            if (event.waitlistEnabled) {
                return res.json(await joinWaitlist(event, name, email));
            }
            return res.status(400).json({ error: 'This event is sold out' });
        }
    }

    let finalAmount = event.ticketPrice;
    let discountCodeId = null;
    let discountAmount = 0;
    if (discountCode) {
        const result = validateDiscountCode(event.id, discountCode, event.ticketPrice);
        if (result.error) return res.status(400).json({ error: result.error });
        discountCodeId = result.discountCode.id;
        discountAmount = result.discountAmount;
        finalAmount = result.finalAmount;
    }

    const dateLabel  = (() => { if (!event.time) return ''; try { return formatEventDateTime(event.time, event, { withWeekday: false, showZone: false }); } catch { return ''; } })();

    // A 100%-off code means nothing to actually charge — Stripe Checkout
    // doesn't support $0 payment-mode sessions, so issue the ticket directly
    // instead of round-tripping through Stripe for no reason.
    if (finalAmount <= 0) {
        const issued = await issueTicketForPayment({ eventId: event.id, buyerName: cleanName, buyerEmail: cleanEmail });
        if (!issued) return res.status(500).json({ error: 'Failed to issue ticket' });
        if (discountCodeId) stmt.discountCodes.incrementUse.run(discountCodeId);
        stmt.orders.insert.run(nanoid(8), nanoid(16), event.id, issued.registrationId, cleanName, cleanEmail, 0, 'usd', 'fulfilled', new Date().toISOString(), discountCodeId, discountAmount);
        if (claimEntry) stmt.waitlist.setStatus.run('converted', claimEntry.id);
        const qrDataUrl = await QRCode.toDataURL(`ticket:${issued.ticket.token}`);
        log('stripe', `[checkout] 100% discount — ticket issued directly — name: ${cleanName}  event: ${event.name}  code: ${discountCode}`);
        return res.json({ success: true, ticket: { token: issued.ticket.token, registrationId: issued.registrationId }, qr: qrDataUrl });
    }

    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
            price_data: {
                currency: 'usd',
                product_data: {
                    name: `${event.name} — Ticket`,
                    description: [eventVenue(event).name, dateLabel].filter(Boolean).join(' · ') || undefined,
                    images: event.imageUrl ? [`${BASE_URL}${event.imageUrl}`] : [],
                },
                unit_amount: finalAmount,
            },
            quantity: 1,
        }],
        mode: 'payment',
        customer_email: cleanEmail,
        metadata: { eventId: event.id, buyerName: cleanName, buyerEmail: cleanEmail, discountCodeId: discountCodeId || '', waitlistId: claimEntry?.id || '', holdToken: paidHoldToken || '' },
        success_url: `${BASE_URL}/register.html?session={CHECKOUT_SESSION_ID}&id=${event.id}`,
        cancel_url: `${BASE_URL}/register.html?id=${event.id}`,
    });

    // Keep the seat held while they're away on Stripe's page, and tie the hold
    // to the session so the webhook can turn it into the ticket. Without this
    // the hold would lapse mid-payment and the seat could be sold twice.
    if (event.capacity && paidHoldToken) {
        const hold = stmt.seatHolds.byToken.get(paidHoldToken);
        if (hold && hold.eventId === event.id && hold.status === 'active') {
            stmt.seatHolds.bindSession.run(session.id, new Date(Date.now() + SEAT_HOLD_CHECKOUT_MS).toISOString(), paidHoldToken);
        }
    }

    stmt.orders.insert.run(nanoid(8), session.id, event.id, null, cleanName, cleanEmail, finalAmount, 'usd', 'pending', new Date().toISOString(), discountCodeId, discountAmount);
    log('stripe', `[checkout] Session created — name: ${cleanName}  event: ${event.name}  amount: ${finalAmount}${discountCodeId ? ` (discount: ${discountAmount})` : ''}`);
    res.json({ url: session.url });
});

// Get order/ticket status for the post-payment success page
app.get('/api/stripe/session/:sessionId', async (req, res) => {
    const order = stmt.orders.bySessionId.get(req.params.sessionId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const ticket = order.registrationId
        ? stmt.tickets.byRegistrationId.all(order.registrationId).map(rowToTicket)[0]
        : null;
    let qr = null;
    if (ticket) {
        try { qr = await QRCode.toDataURL(`ticket:${ticket.token}`); } catch {}
    }
    // The paid path completes in the webhook, which has no browser to set a
    // cookie on — this poll from the success page is the first chance to mark
    // the device, and only once the order is actually fulfilled.
    if (order.status === 'fulfilled' && order.eventId) {
        const paidEvent = rowToEvent(stmt.events.byId.get(order.eventId));
        if (paidEvent?.oneRegistrationPerDevice) markDeviceRegistered(res, paidEvent.id);
    }
    res.json({
        status: order.status,
        name: order.buyerName,
        ticket: ticket ? { token: ticket.token } : null,
        qr,
    });
});

// Stripe webhook — issues ticket after confirmed payment
app.post('/api/stripe/webhook', async (req, res) => {
    if (!stripe) return res.status(503).send('Stripe not configured');
    const sig = req.headers['stripe-signature'];
    let stripeEvent;
    try {
        stripeEvent = stripe.webhooks.constructEvent(req.rawBody, sig, stripeWebhookSecret);
    } catch (err) {
        log('stripe', `[webhook] Bad signature: ${err.message}`);
        return res.status(400).send(`Webhook error: ${err.message}`);
    }

    if (stripeEvent.type === 'checkout.session.completed') {
        const session = stripeEvent.data.object;
        const { eventId, buyerName, buyerEmail, discountCodeId, waitlistId } = session.metadata || {};
        if (!eventId || !buyerName || !buyerEmail) return res.json({ received: true });

        const existing = stmt.orders.bySessionId.get(session.id);
        if (existing?.status === 'fulfilled') return res.json({ received: true });

        // Release the seat this payment was holding, so it isn't counted twice
        // once the ticket exists. The hold is looked up by session rather than
        // by token so it works even if the metadata was trimmed.
        const paidHold = stmt.seatHolds.bySessionId.get(session.id)
            || (session.metadata?.holdToken ? stmt.seatHolds.byToken.get(session.metadata.holdToken) : null);
        if (paidHold && paidHold.status === 'active') stmt.seatHolds.setStatus.run('consumed', paidHold.token);

        // Backstop: this route issued tickets with no capacity check at all, so
        // a paid event could be oversold outright. A payment that arrives with
        // no hold behind it and no room left is logged rather than silently
        // seated — the money is already taken, so refusing here would be worse
        // than seating them, but the organiser needs to know.
        const capEvent = rowToEvent(stmt.events.byId.get(eventId));
        if (capEvent?.capacity && !paidHold && !waitlistId) {
            const usage = eventSeatUsage(eventId);
            if (usage.issued >= usage.capacity) {
                log('stripe', `[webhook] OVER CAPACITY — paid with no seat hold: ${buyerEmail}  event: ${capEvent.name}  issued: ${usage.issued}/${usage.capacity}  session: ${session.id}`);
                logAudit(req, { eventId, action: 'capacity.exceeded', details: { email: buyerEmail, sessionId: session.id, issued: usage.issued, capacity: usage.capacity } });
            }
        }

        const issued = await issueTicketForPayment({ eventId, buyerName, buyerEmail });
        if (!issued) return res.json({ received: true });

        stmt.orders.fulfill.run(issued.registrationId, new Date().toISOString(), session.payment_intent || null, session.id);
        // Only counts toward the code's usage limit once payment is actually
        // confirmed — an abandoned checkout never gets here.
        if (discountCodeId) stmt.discountCodes.incrementUse.run(discountCodeId);
        // Releases the reserved-seat hold now that the promoted person has
        // actually completed checkout — the ticket itself is what counts
        // toward capacity from here on.
        if (waitlistId) stmt.waitlist.setStatus.run('converted', waitlistId);
        log('stripe', `[webhook] Ticket issued — name: ${buyerName}  event: ${issued.dbEvent.name}  session: ${session.id}`);
    } else if (stripeEvent.type === 'charge.refunded') {
        // Catches refunds issued directly from the Stripe dashboard, not just
        // ones initiated through our own refund endpoint below — keeps our
        // order status in sync either way.
        const charge = stripeEvent.data.object;
        const order = charge.payment_intent ? stmt.orders.byPaymentIntentId.get(charge.payment_intent) : null;
        if (order && order.status !== 'refunded') {
            stmt.orders.refund.run(new Date().toISOString(), charge.amount_refunded, order.id);
            log('stripe', `[webhook] Refund recorded — order: ${order.id}  amount: ${charge.amount_refunded}`);
        }
    }

    res.json({ received: true });
});

// ── At-Door (in-app) ──────────────────────────────────────────────────────────

// Toggle at-door ticket sales on/off for an event (owner or admin).
// When enabled, the iOS app shows an "At Door" tab — free events get an in-app
// register form; paid events get a QR code linking to the public registration
// page so the customer pays on their own phone via Stripe Checkout.
app.put('/api/event/:id/at-door', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) return res.status(403).json({ error: 'Forbidden' });

    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    stmt.events.setAtDoorEnabled.run(enabled ? 1 : 0, req.params.id);
    log('event-settings', `[edit] At-door sales ${enabled ? 'enabled' : 'disabled'} — event: ${event.name}  by: ${req.session.userId}`);
    res.json({ success: true, atDoorEnabled: enabled });
});

// Issue a free ticket at the door for a FREE event — staff fills the form in the iOS app.
app.post('/api/event/:eventId/at-door-register', requireAuth, async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.atDoorEnabled) return res.status(403).json({ error: 'At-door sales are not enabled for this event' });
    if (event.ticketPrice) return res.status(400).json({ error: 'This event is paid — share the registration QR code instead' });

    if (event.capacity) {
        // Counts seats people are holding mid-signup, not just issued tickets —
        // otherwise a door sale silently takes a spot already promised to
        // someone part-way through the online form, and the event oversells.
        const usage = eventSeatUsage(event.id);
        if (usage.taken >= usage.capacity) {
            return res.status(400).json({ error: heldSeatMessage(usage) });
        }
    }

    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const issued = await issueTicketForPayment({
        eventId: event.id,
        buyerName: name.trim(),
        buyerEmail: email ? email.trim().toLowerCase() : null,
    });
    if (!issued) return res.status(500).json({ error: 'Failed to issue ticket' });
    log('at-door', `[free] Ticket issued — name: ${name}  event: ${event.name}  by: ${req.session.userId}`);
    res.json({ ticket: issued.ticket, name });
});

// ── Discount / Promo Codes ─────────────────────────────────────────────────────

app.get('/api/event/:id/discount-codes', requireAuth, (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventAccess(req.session.userId, eventId)) {
        return res.status(403).json({ error: 'You do not have access to this event' });
    }
    res.json(stmt.discountCodes.byEventId.all(eventId).map(rowToDiscountCode));
});

app.post('/api/event/:id/discount-codes', requireAuth, (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventCapability(req.session.userId, eventId, 'manage_discounts')) {
        return res.status(403).json({ error: 'Only the event owner can manage discount codes' });
    }
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const code = String(req.body.code || '').trim().toUpperCase();
    const type = req.body.type === 'fixed' ? 'fixed' : 'percent';
    const value = parseInt(req.body.value, 10);
    if (!code) return res.status(400).json({ error: 'Code is required' });
    if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Value must be a positive number' });
    if (type === 'percent' && value > 100) return res.status(400).json({ error: 'Percent discount cannot exceed 100' });
    if (stmt.discountCodes.byEventAndCode.get(eventId, code)) {
        return res.status(409).json({ error: 'A code with that name already exists for this event' });
    }
    const maxUses = req.body.maxUses != null && req.body.maxUses !== '' ? parseInt(req.body.maxUses, 10) : null;
    const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt).toISOString() : null;

    const id = nanoid(10);
    stmt.discountCodes.insert.run(id, eventId, code, type, value, maxUses, expiresAt, 1, new Date().toISOString());
    logAudit(req, { eventId, action: 'discount_code.created', details: { code, type, value } });
    res.json({ success: true, discountCode: rowToDiscountCode(stmt.discountCodes.byId.get(id)) });
});

app.patch('/api/discount-codes/:id', requireAuth, (req, res) => {
    const discountCode = rowToDiscountCode(stmt.discountCodes.byId.get(req.params.id));
    if (!discountCode) return res.status(404).json({ error: 'Discount code not found' });
    if (!userHasEventCapability(req.session.userId, discountCode.eventId, 'manage_discounts')) {
        return res.status(403).json({ error: 'Only the event owner can manage discount codes' });
    }
    const active = req.body.active === true || req.body.active === 'true';
    stmt.discountCodes.setActive.run(active ? 1 : 0, req.params.id);
    logAudit(req, { eventId: discountCode.eventId, action: active ? 'discount_code.activated' : 'discount_code.deactivated', details: { code: discountCode.code } });
    res.json({ success: true });
});

app.delete('/api/discount-codes/:id', requireAuth, (req, res) => {
    const discountCode = rowToDiscountCode(stmt.discountCodes.byId.get(req.params.id));
    if (!discountCode) return res.status(404).json({ error: 'Discount code not found' });
    if (!userHasEventCapability(req.session.userId, discountCode.eventId, 'manage_discounts')) {
        return res.status(403).json({ error: 'Only the event owner can manage discount codes' });
    }
    stmt.discountCodes.deleteById.run(req.params.id);
    logAudit(req, { eventId: discountCode.eventId, action: 'discount_code.deleted', details: { code: discountCode.code } });
    res.json({ success: true });
});

// Public — lets the registration page preview a discount before checkout,
// without exposing the full code list.
app.get('/api/event/:id/discount-codes/preview', (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const result = validateDiscountCode(req.params.id, req.query.code, event.ticketPrice);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ valid: true, discountAmount: result.discountAmount, finalAmount: result.finalAmount });
});

// ── Waitlist ────────────────────────────────────────────────────────────────────

// Shared by /api/register and /api/checkout so both entry points behave
// identically. Emails an immediate confirmation with a link to check live
// status, since there's no attendee login to come back and look this up
// any other way.
async function joinWaitlist(event, name, email, sendEmailFlag = true) {
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();
    const existing = stmt.waitlist.byEventAndEmail.get(event.id, cleanEmail);
    if (existing) {
        const position = existing.status === 'waiting'
            ? (stmt.waitlist.countWaitingAheadOf.get(event.id, existing.createdAt)?.cnt ?? 0) + 1
            : null;
        return { waitlisted: true, alreadyOnList: true, position, waitlistId: existing.id };
    }
    const id = nanoid(10);
    const now = new Date().toISOString();
    stmt.waitlist.insert.run(id, event.id, cleanName, cleanEmail, null, 'waiting', now);
    const position = (stmt.waitlist.countWaitingAheadOf.get(event.id, now)?.cnt ?? 0) + 1;
    log('waitlist', `[join] Added to waitlist — name: ${cleanName}  email: ${cleanEmail}  event: ${event.name}  position: ${position}`);

    if (sendEmailFlag && process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        const statusUrl = `${BASE_URL}/waitlist-status.html?id=${id}`;
        sendEmail({
            to: cleanEmail,
            fromName: `Tickets - ${event.name}`,
            subject: `You're on the waitlist for ${event.name}`,
            html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
                <div style="margin-bottom:24px;"><div style="background:#1a1f3c;display:inline-block;padding:14px 20px;border-radius:12px;"><span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.5px;">WTS Tickets</span></div></div>
                <h2 style="color:#1a1f3c;margin:0 0 8px;">You're on the waitlist</h2>
                <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 4px;">You're <strong>#${position}</strong> in line for <strong>${event.name}</strong>.</p>
                <p style="color:#64748b;font-size:14px;line-height:1.6;margin:0 0 28px;">We'll email you the moment a spot opens up. You can check your live position any time.</p>
                <div style="text-align:center;margin-bottom:8px;">
                    <a href="${statusUrl}" style="background:#1a1f3c;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block;">Check My Position</a>
                </div>
            </div>`,
        }).catch(() => {});
    }

    return { waitlisted: true, position, waitlistId: id };
}

// Public — a waitlisted person's own status/position, looked up by their
// waitlist entry id (opaque nanoid, emailed to them — not guessable, no
// separate auth needed since it grants no more than "see your own position").
app.get('/api/waitlist/entry/:id', (req, res) => {
    const entry = rowToWaitlistEntry(stmt.waitlist.byId.get(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const event = rowToEvent(stmt.events.byId.get(entry.eventId));
    if (!event) return res.status(404).json({ error: 'Not found' });

    let position = null;
    if (entry.status === 'waiting') {
        position = (stmt.waitlist.countWaitingAheadOf.get(entry.eventId, entry.createdAt)?.cnt ?? 0) + 1;
    }

    const claimActive = entry.status === 'notified' && entry.claimToken && entry.claimExpiresAt && entry.claimExpiresAt > new Date().toISOString();
    res.json({
        status: entry.status,
        position,
        eventName: event.name,
        eventId: event.id,
        isPaid: event.ticketPrice > 0,
        claimUrl: claimActive ? `${BASE_URL}/register.html?id=${event.id}&claim=${entry.claimToken}` : null,
        claimExpired: entry.status === 'notified' && !claimActive,
    });
});

app.put('/api/event/:id/waitlist-enabled', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) return res.status(403).json({ error: 'Forbidden' });
    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    stmt.events.setWaitlistEnabled.run(enabled ? 1 : 0, req.params.id);
    logAudit(req, { eventId: event.id, action: enabled ? 'waitlist.enabled' : 'waitlist.disabled' });
    res.json({ success: true, waitlistEnabled: enabled });
});

// Default for admin-issued tickets (manual add, CSV import, sheet import,
// edits) — does not affect public self-registration, checkout, or waitlist
// notifications, which always send.
app.put('/api/event/:id/skip-confirmation-emails', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) return res.status(403).json({ error: 'Forbidden' });
    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    stmt.events.setSkipConfirmationEmails.run(enabled ? 1 : 0, req.params.id);
    logAudit(req, { eventId: event.id, action: enabled ? 'skipConfirmationEmails.enabled' : 'skipConfirmationEmails.disabled' });
    res.json({ success: true, skipConfirmationEmails: enabled });
});

// See the shuttleLinkEnabled comment in db-sqlite.js — only for events whose
// tickets are exclusively used for shuttle boarding, never a door.
app.put('/api/event/:id/shuttle-link-enabled', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) return res.status(403).json({ error: 'Forbidden' });
    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    stmt.events.setShuttleLinkEnabled.run(enabled ? 1 : 0, req.params.id);
    logAudit(req, { eventId: event.id, action: enabled ? 'shuttlelink.enabled' : 'shuttlelink.disabled' });
    res.json({ success: true, shuttleLinkEnabled: enabled });
});

// Apple Wallet passes can surface a lock-screen "Tonight at 8pm" style
// reminder near the event time and when the phone is near the venue
// (see setRelevantDates/setLocations in generatePassBuffer). This lets an
// organizer turn that off so the ticket sits silently in Wallet.
app.put('/api/event/:id/wallet-lock-screen-enabled', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) return res.status(403).json({ error: 'Forbidden' });
    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    stmt.events.setWalletLockScreenEnabled.run(enabled ? 1 : 0, req.params.id);
    logAudit(req, { eventId: event.id, action: enabled ? 'wallet_lock_screen.enabled' : 'wallet_lock_screen.disabled' });
    const updated = rowToEvent(stmt.events.byId.get(req.params.id));
    const eventTickets = stmt.tickets.byEventId.all(event.id).map(rowToTicket);
    pushWalletIfChanged(eventTickets, updated).catch(() => {});
    res.json({ success: true, walletLockScreenEnabled: enabled });
});

app.get('/api/event/:id/waitlist', requireAuth, (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventAccess(req.session.userId, eventId)) {
        return res.status(403).json({ error: 'You do not have access to this event' });
    }
    res.json(stmt.waitlist.byEventId.all(eventId).map(rowToWaitlistEntry));
});

// Join the waitlist directly (shown by register.html when an event is full).
app.post('/api/event/:id/waitlist', async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.waitlistEnabled) return res.status(403).json({ error: 'This event does not have a waitlist' });
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    res.json(await joinWaitlist(event, name, email));
});

// Promote someone off the waitlist: issues them a free ticket directly (for
// paid events, promoting sends them a personal note to complete checkout —
// keeps Stripe as the one place money actually changes hands) and marks the
// waitlist entry as converted. Doesn't auto-check capacity — the organizer is
// explicitly choosing to seat this person, e.g. after a cancellation.
app.post('/api/waitlist/:id/promote', requireAuth, async (req, res) => {
    const entry = rowToWaitlistEntry(stmt.waitlist.byId.get(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
    if (!userHasEventCapability(req.session.userId, entry.eventId, 'manage_waitlist')) {
        return res.status(403).json({ error: 'Only the event owner can manage the waitlist' });
    }
    const event = rowToEvent(stmt.events.byId.get(entry.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (event.ticketPrice > 0) {
        // A real reservation, not just a nudge: the claim token is good for
        // 48 hours, and the capacity check elsewhere treats an active claim
        // as an occupied seat, so this specific person's spot can't be lost
        // to someone else registering in the meantime.
        const claimToken = nanoid(24);
        const claimExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        stmt.waitlist.setClaim.run(new Date().toISOString(), claimToken, claimExpiresAt, entry.id);
        if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
            const claimUrl = `${BASE_URL}/register.html?id=${event.id}&claim=${claimToken}`;
            sendEmail({
                to: entry.email,
                fromName: `Tickets - ${event.name}`,
                replyTo: REPLY_TO_EMAIL,
                subject: `A spot opened up for ${event.name}!`,
                html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
                    <div style="margin-bottom:24px;"><div style="background:#1a1f3c;display:inline-block;padding:14px 20px;border-radius:12px;"><span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.5px;">WTS Tickets</span></div></div>
                    <h2 style="color:#1a1f3c;margin:0 0 8px;">A spot opened up!</h2>
                    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 4px;">Good news — a ticket for <strong>${event.name}</strong> just became available, and it's reserved for you.</p>
                    <p style="color:#64748b;font-size:14px;line-height:1.6;margin:0 0 28px;">This hold lasts <strong>48 hours</strong> — complete your registration before then to keep it.</p>
                    <div style="text-align:center;margin-bottom:8px;">
                        <a href="${claimUrl}" style="background:#1a1f3c;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block;">Complete Your Registration</a>
                    </div>
                </div>`,
            }).catch(() => {});
        }
        logAudit(req, { eventId: event.id, action: 'waitlist.notified', details: { email: entry.email } });
        return res.json({ success: true, notified: true });
    }

    const issued = await issueTicketForPayment({ eventId: event.id, buyerName: entry.name, buyerEmail: entry.email });
    if (!issued) return res.status(500).json({ error: 'Failed to issue ticket' });
    stmt.waitlist.setStatus.run('converted', entry.id);
    logAudit(req, { eventId: event.id, action: 'waitlist.promoted', details: { email: entry.email } });
    res.json({ success: true, ticket: issued.ticket });
});

app.delete('/api/waitlist/:id', requireAuth, (req, res) => {
    const entry = rowToWaitlistEntry(stmt.waitlist.byId.get(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
    if (!userHasEventCapability(req.session.userId, entry.eventId, 'manage_waitlist')) {
        return res.status(403).json({ error: 'Only the event owner can manage the waitlist' });
    }
    stmt.waitlist.deleteById.run(req.params.id);
    logAudit(req, { eventId: entry.eventId, action: 'waitlist.removed', details: { email: entry.email } });
    res.json({ success: true });
});

// ── Payments (Beta) — orders & refunds ─────────────────────────────────────────

app.get('/api/event/:id/orders', requireAuth, (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventCapability(req.session.userId, eventId, 'manage_payments')) {
        return res.status(403).json({ error: 'You do not have permission to view orders for this event' });
    }
    res.json(stmt.orders.byEventId.all(eventId));
});

app.post('/api/orders/:id/refund', requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe is not connected yet — email support@willstechsupport.com to connect your Stripe account.' });
    const order = stmt.orders.byId.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!userHasEventCapability(req.session.userId, order.eventId, 'manage_payments')) {
        return res.status(403).json({ error: 'Only the event owner can issue refunds' });
    }
    if (order.status === 'refunded') return res.status(400).json({ error: 'Already refunded' });
    if (order.status !== 'fulfilled') return res.status(400).json({ error: 'Only fulfilled orders can be refunded' });
    if (!order.paymentIntentId) return res.status(400).json({ error: 'No payment on file for this order (was it a 100%-discount ticket?)' });

    try {
        const refund = await stripe.refunds.create({ payment_intent: order.paymentIntentId });
        stmt.orders.refund.run(new Date().toISOString(), refund.amount, order.id);
        const event = rowToEvent(stmt.events.byId.get(order.eventId));
        logAudit(req, { eventId: order.eventId, action: 'order.refunded', details: { buyerEmail: order.buyerEmail, amount: refund.amount } });
        log('stripe', `[refund] Issued — order: ${order.id}  event: ${event?.name}  amount: ${refund.amount}  by: ${req.session.userId}`);
        res.json({ success: true, refundAmount: refund.amount });
    } catch (err) {
        log('stripe', `[refund] FAILED — order: ${order.id}  error: ${err.message}`);
        res.status(500).json({ error: err.message || 'Refund failed' });
    }
});

// Every sheet-integration call below (except create-event, which mints the key)
// must present the apiKey that was returned when the room's event was created.
function requireSheetApiKey(eventId, apiKey) {
    if (!apiKey) return false;
    const link = stmt.sheetLinks.byEventId.get(eventId);
    return !!(link && link.apiKey && link.apiKey === apiKey);
}

// API: Bulk Register Tickets (for Google Sheets integration)
app.post('/api/register-bulk', async (req, res) => {
    const { firstName, lastName, email, eventId, ticketCount, apiKey } = req.body;
    const isResend = req.body.resend === true;

    if (!requireSheetApiKey(eventId, apiKey)) {
        return res.status(401).json({ error: 'Invalid or missing apiKey for this room' });
    }

    if (!firstName || !lastName || !email || !eventId || !ticketCount) {
        return res.status(400).json({ error: 'firstName, lastName, email, eventId, and ticketCount are required' });
    }

    log('bulk-register', `[list] ${isResend ? 'Resend' : 'New'} registration — email: ${email}  name: ${firstName} ${lastName}  tickets: ${ticketCount}  eventId: ${eventId}  ip: ${getIP(req)}`);

    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const count = parseInt(ticketCount, 10);
    if (isNaN(count) || count < 1 || count > 500) {
        return res.status(400).json({ error: 'ticketCount must be a number between 1 and 500' });
    }

    // Capacity check — only enforced for new registrations, not resends.
    // Sheet rows are processed one at a time (Apps Script/the sheet-watch
    // poller are both synchronous per row), so re-querying `registered` on
    // every call naturally waitlists overflow rows in sheet order.
    if (!isResend && event.capacity) {
        const usage = eventSeatUsage(event.id);
        const registered = usage.taken;
        if (registered + count > event.capacity) {
            if (event.waitlistEnabled) {
                const result = await joinWaitlist(event, `${firstName} ${lastName}`, email, shouldSendAdminEmail(req.body.sendEmail, event));
                return res.json(result);
            }
            return res.status(409).json({ error: heldSeatMessage(usage, count) });
        }
    }

    const fullName = `${firstName} ${lastName}`;
    // customFields: any extra data from the sheet e.g. { "T-Shirt Size": "M", "Meal": "Veg" }
    const customFields = (req.body.customFields && typeof req.body.customFields === 'object')
        ? req.body.customFields : {};

    // When resending, use the tokens the sheet already has to pin to the exact registrationId.
    // Falling back to email+eventId would match ALL rows for that email (e.g. 2 different rows).
    let existingTickets = [];
    if (isResend && Array.isArray(req.body.existingTokens) && req.body.existingTokens.length > 0) {
        const tokenSet = new Set(req.body.existingTokens);
        const placeholders = [...tokenSet].map(() => '?').join(',');
        const matched = rowToTicket(db.prepare(`SELECT * FROM tickets WHERE token IN (${placeholders}) LIMIT 1`).get(...tokenSet));
        if (matched) {
            existingTickets = stmt.tickets.byRegistrationId.all(matched.registrationId).map(rowToTicket);
        }
    } else if (!isResend) {
        // New row — no lookup needed, always create fresh
    }

    let ticketsToSend;
    let countChanged = null;
    let changes = [];
    try {
        if (isResend && existingTickets.length > 0) {
            const existingCount = existingTickets.length;
            const registrationId = existingTickets[0].registrationId;

            // Compute what changed for the email
            const oldTicket = existingTickets[0];
            const oldName = oldTicket.name || '';
            const oldCustomFields = oldTicket.customFields || {};
            if (oldName !== fullName) changes.push(`Name: <strong>${oldName}</strong> → <strong>${fullName}</strong>`);
            if (existingCount !== count) changes.push(`Ticket count: <strong>${existingCount}</strong> → <strong>${count}</strong>`);
            const allFieldKeys = new Set([...Object.keys(oldCustomFields), ...Object.keys(customFields)]);
            allFieldKeys.forEach(k => {
                const oldVal = oldCustomFields[k] ?? null;
                const newVal = customFields[k] ?? null;
                if (oldVal !== newVal) {
                    changes.push(`${k}: <strong>${oldVal ?? '(none)'}</strong> → <strong>${newVal ?? '(removed)'}</strong>`);
                }
            });

            const cfJson = JSON.stringify(customFields);
            if (count > existingCount) {
                // Add more tickets with same registrationId
                const newTickets = Array.from({ length: count - existingCount }, () => ({
                    id: nanoid(8), token: nanoid(12), registrationId, eventId,
                    name: fullName, firstName, lastName, email, customFields,
                    created_at: new Date().toISOString(), used_at: null
                }));
                const bulkUpdate = db.transaction(() => {
                    for (const t of existingTickets) {
                        stmt.tickets.updateInfo.run(fullName, firstName, lastName, email, cfJson, t.id);
                        t.name = fullName; t.firstName = firstName; t.lastName = lastName; t.customFields = customFields;
                    }
                    for (const t of newTickets) {
                        stmt.tickets.insert.run(t.id, t.eventId, t.token, t.registrationId, t.name, t.firstName, t.lastName, t.email, cfJson, null, null, null, null, t.created_at, null, null);
                    }
                });
                bulkUpdate();
                ticketsToSend = [...existingTickets, ...newTickets];
                countChanged = { from: existingCount, to: count };
            } else if (count < existingCount) {
                // Remove extra tickets — prefer unused ones first
                const unused = existingTickets.filter(t => !t.used_at);
                const used = existingTickets.filter(t => t.used_at);
                const toRemove = [...unused, ...used].slice(0, existingCount - count).map(t => t.id);
                const toKeep = existingTickets.filter(t => !toRemove.includes(t.id));
                const bulkUpdate = db.transaction(() => {
                    for (const id of toRemove) stmt.tickets.deleteById.run(id);
                    for (const t of toKeep) {
                        stmt.tickets.updateInfo.run(fullName, firstName, lastName, email, cfJson, t.id);
                        t.name = fullName; t.firstName = firstName; t.lastName = lastName; t.customFields = customFields;
                    }
                });
                bulkUpdate();
                ticketsToSend = toKeep;
                countChanged = { from: existingCount, to: count };
            } else {
                // Same count — just update name/customFields
                ticketsToSend = existingTickets;
                const bulkUpdate = db.transaction(() => {
                    for (const t of ticketsToSend) {
                        stmt.tickets.updateInfo.run(fullName, firstName, lastName, email, cfJson, t.id);
                        t.name = fullName; t.firstName = firstName; t.lastName = lastName; t.email = email; t.customFields = customFields;
                    }
                });
                bulkUpdate();
            }
        } else {
            // New row (or resend with no existing tickets) — always create fresh tickets
            const registrationId = nanoid(10);
            ticketsToSend = Array.from({ length: count }, () => ({
                id: nanoid(8), token: nanoid(12), registrationId, eventId,
                name: fullName, firstName, lastName, email, customFields,
                created_at: new Date().toISOString(), used_at: null
            }));
            const cfJson = JSON.stringify(customFields);
            const insertAll = db.transaction(() => {
                for (const t of ticketsToSend) {
                    stmt.tickets.insert.run(t.id, t.eventId, t.token, t.registrationId, t.name, t.firstName, t.lastName, t.email, cfJson, null, null, null, null, t.created_at, null, null);
                }
            });
            insertAll();
        }

        if (!isResend) {
            const actualCount = ticketsToSend.length;
            const subs = stmt.pushSubscriptions.byEventEnabled.all(event.id);
            const userIds = [...new Set(subs.map(s => s.userId))];
            userIds.forEach(uid => {
                pushAppNotificationToUser(uid, {
                    title: 'New registration',
                    body: `${event.name} — ${fullName} • ${actualCount} ticket${actualCount === 1 ? '' : 's'}`
                }).catch(() => { });
            });
        }

        // Build one email with all QR codes
        if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
            const actualCount = ticketsToSend.length;
            const ticketLabel = actualCount === 1 ? 'Ticket' : `${actualCount} Tickets`;
            const isUpdate = isResend && changes.length > 0;

            const changesHtml = isUpdate && changes.length > 0 ? `
<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:14px 18px;margin:0 0 24px;">
  <p style="font-weight:700;color:#92400e;font-size:14px;margin:0 0 8px;">What changed:</p>
  <ul style="margin:0;padding-left:20px;color:#78350f;font-size:14px;">
    ${changes.map(c => `<li style="margin:4px 0;">${c}</li>`).join('')}
  </ul>
</div>` : '';
            const customFieldsHtml = Object.keys(customFields).length > 0 ? `
<div style="border:1px solid #f0f0f0;border-radius:10px;overflow:hidden;margin:0 0 24px;font-size:14px;">
  ${Object.entries(customFields).map(([k, v]) => `
  <div style="display:flex;padding:10px 14px;border-bottom:1px solid #f8f8f8;">
    <span style="color:#999;font-weight:600;min-width:38%;flex-shrink:0;">${k}</span>
    <span style="color:#333;">${v}</span>
  </div>`).join('')}
</div>` : '';
            const shouldSendEmail = shouldSendAdminEmail(req.body.sendEmail, event) && process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID;
            if (shouldSendEmail) {
                const { html, attachments, subject: subjectOverride } = await buildTicketEmailHtml({
                    firstName,
                    intro: isUpdate
                        ? `Your registration for <strong>${event.name}</strong> has been updated.`
                        : `You&rsquo;re all set for <strong>${event.name}</strong>! We&rsquo;ll see you there.`,
                    event,
                    tickets: ticketsToSend,
                    changesHtml,
                    customFieldsHtml,
                });
                await sendEmail({
                    to: email,
                    fromName: `Tickets - ${event.name}`,
                    replyTo: REPLY_TO_EMAIL,
                    subject: subjectOverride || (isUpdate ? `Your registration for ${event.name} has been updated` : `Your ${ticketLabel} for ${event.name}`),
                    html,
                    attachments,
                    registrationId: ticketsToSend[0].registrationId
                });
                log('bulk-register', `[email] Email ${isUpdate ? 'updated' : 'sent'} → ${email}  name: ${fullName}  tickets: ${actualCount}  event: ${event.name}  regId: ${ticketsToSend[0].registrationId}`);
            }
        }

        const response = {
            success: true,
            tokens: ticketsToSend.map(t => t.token),
            tickets: ticketsToSend
        };
        if (countChanged) response.countChanged = countChanged;
        res.json(response);
    } catch (error) {
        console.error('Bulk registration error:', error);
        res.status(500).json({ error: 'Failed to process registration' });
    }
});

// Shared helper — server fetches image directly from Google Drive thumbnail URL.
// This avoids sending large payloads through the reverse proxy entirely.
async function fetchAndSaveImage(driveFileId) {
    const url = `https://drive.google.com/thumbnail?id=${driveFileId}&sz=w1200`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Drive fetch failed: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const filename = `${Date.now()}-${nanoid(8)}.png`;
    const filepath = path.join(uploadsDir, filename);
    // Always convert to PNG via sharp (input is JPEG from Google's thumbnail)
    await sharp(buffer).png().toFile(filepath);
    return `/uploads/${filename}`;
}

// API: Update Event from Google Sheet
app.post('/api/sheet/update-event', async (req, res) => {
    const { eventId, name, time, endTime, color, locationName, address, lat, lng, driveFileId, apiKey } = req.body;

    if (!eventId) return res.status(400).json({ error: 'eventId is required' });
    if (!requireSheetApiKey(eventId, apiKey)) {
        return res.status(401).json({ error: 'Invalid or missing apiKey for this room' });
    }

    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    try {
        if (name) event.name = name;
        if (time) event.time = time;
        if (endTime !== undefined) event.endTime = endTime || null;
        if (color) event.color = color;
        if (!event.location) event.location = {};
        if (locationName) event.location.name = locationName;
        if (address) event.location.address = address;
        if (lat != null && !isNaN(parseFloat(lat))) event.location.lat = parseFloat(lat);
        if (lng != null && !isNaN(parseFloat(lng))) event.location.lng = parseFloat(lng);

        if (driveFileId) {
            try { event.imageUrl = await fetchAndSaveImage(driveFileId); }
            catch (imgErr) { console.warn('Image update failed:', imgErr.message); }
        }

        stmt.events.setSheetFields.run(event.name, event.time, event.endTime, event.color, JSON.stringify(event.location), event.id);
        if (driveFileId) stmt.events.setImageUrl.run(event.imageUrl, event.id);

        const eventTickets = stmt.tickets.byEventId.all(event.id).map(rowToTicket);
        pushWalletIfChanged(eventTickets, event).catch(() => {});

        res.json({ success: true, event });
    } catch (error) {
        console.error('Update event error:', error);
        res.status(500).json({ error: 'Failed to update event' });
    }
});

// API: Create Event from Google Sheet.
// Mints the room's identity: creates (or reuses) the sheetLinks row for this
// spreadsheetId and returns its apiKey — every other sheet-integration call
// below must present that key. This is what makes "one sheet per room" safe
// for many independent organizers sharing one server.
app.post('/api/sheet/create-event', async (req, res) => {
    const { name, time, endTime, color, locationName, address, lat, lng, driveFileId, spreadsheetId, sheetName } = req.body;

    if (!name || !time) {
        return res.status(400).json({ error: 'name and time are required' });
    }
    if (!spreadsheetId) {
        return res.status(400).json({ error: 'spreadsheetId is required' });
    }

    // Fallback owner until the organizer claims the sheet to their own account
    // (see /api/sheet/claim) — events created this way still show up somewhere
    // in the meantime rather than being orphaned.
    const ownerEmail = process.env.SHEET_USER_EMAIL;
    const owner = ownerEmail ? rowToUser(stmt.users.byEmail.get(ownerEmail)) : null;
    const userId = owner ? owner.id : 'sheet';

    let imageUrl = null;
    if (driveFileId) {
        try { imageUrl = await fetchAndSaveImage(driveFileId); }
        catch (imgErr) { console.warn('Image save failed, continuing without image:', imgErr.message); }
    }

    const newEvent = {
        id: nanoid(10),
        userId,
        name,
        time,
        endTime: endTime || null,
        color: color || 'rgb(99, 102, 241)',
        imageUrl,
        scannerPin: Math.floor(100000 + Math.random() * 900000).toString(),
        location: {
            // No placeholder: an event with no venue must stay empty, or it
            // shows up as a venue literally called "Venue" on tickets.
            name: locationName || address || '',
            address: address || '',
            lat: parseFloat(lat) || 0,
            lng: parseFloat(lng) || 0
        }
    };

    stmt.events.insert.run(newEvent.id, newEvent.userId, newEvent.name, newEvent.time, newEvent.endTime, newEvent.color, newEvent.imageUrl, newEvent.scannerPin, JSON.stringify(newEvent.location), 0, null, null, 0, null, 24, null, null, new Date().toISOString());

    let link = stmt.sheetLinks.bySpreadsheetId.get(spreadsheetId);
    if (link) {
        stmt.sheetLinks.update.run(newEvent.id, sheetName || link.sheetName, link.id);
        if (!link.apiKey) stmt.sheetLinks.setApiKey.run(nanoid(24), link.id);
        link = stmt.sheetLinks.byId.get(link.id);
    } else {
        link = {
            id: nanoid(10),
            token: nanoid(20),
            spreadsheetId,
            sheetName: sheetName || name,
            eventId: newEvent.id,
            createdAt: new Date().toISOString(),
            apiKey: nanoid(24),
        };
        stmt.sheetLinks.insert.run(link.id, link.token, link.spreadsheetId, link.sheetName, link.eventId, link.createdAt, link.apiKey);
    }

    res.json({ success: true, eventId: newEvent.id, event: newEvent, apiKey: link.apiKey });
});

// API: Batch ticket scan status (for Google Sheet)
// Cache: keyed by sorted token list, expires after 60 seconds
const ticketStatusCache = new Map(); // key -> { result, expiresAt }
const TICKET_STATUS_TTL = 60_000;

app.post('/api/ticket-status', (req, res) => {
    const { tokens, spreadsheetId, apiKey } = req.body;
    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ error: 'tokens array required' });
    }
    const link = spreadsheetId ? stmt.sheetLinks.bySpreadsheetId.get(spreadsheetId) : null;
    if (!link || !link.apiKey || link.apiKey !== apiKey) {
        return res.status(401).json({ error: 'Invalid or missing apiKey for this room' });
    }

    const trimmed = tokens.map(t => t.trim()).filter(Boolean);
    const cacheKey = trimmed.slice().sort().join(',');
    const cached = ticketStatusCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.result);
    }

    const fetched = getTicketsByTokens(trimmed);
    const byToken = new Map(fetched.map(t => [t.token, t]));
    const result = trimmed.map(token => {
        const ticket = byToken.get(token);
        if (!ticket) return { token, status: 'not found' };
        return { token, status: ticket.used_at ? 'scanned' : 'not scanned', used_at: ticket.used_at || null };
    });

    ticketStatusCache.set(cacheKey, { result, expiresAt: Date.now() + TICKET_STATUS_TTL });
    res.json(result);
});

// Decorates an event with what the current user may actually do to it, so the
// dashboard, iOS app and checkin.html can hide controls they'd only get a 403
// from. `fullAccess` is kept for older clients that read just that flag.
function withUserCapabilities(userId) {
    return (e) => {
        const capabilities = userEventCapabilities(userId, e.id);
        return {
            ...e,
            capabilities,
            fullAccess: CAPABILITY_KEYS.every(k => capabilities.includes(k)),
            isOwner: e.userId === userId,
        };
    };
}

// The rooms that belong to *you*: owned, shared with you, or reached via a
// scan link. Deliberately the same for the admin as for anyone else — being
// admin grants authority over every event, but other people's events are not
// the admin's own rooms and shouldn't clutter their list. The admin reaches
// everything else through /api/admin/all-rooms instead.
app.get('/api/events', requireAuthOrScanLink, (req, res) => {
    // A scan-link session has exactly one event, with the link's capabilities.
    if (!req.session.userId) {
        const scoped = sessionScanLink(req);
        const event = scoped && rowToEvent(stmt.events.byId.get(scoped.eventId));
        if (!event) return res.json([]);
        return res.json([{
            ...event,
            capabilities: SCAN_LINK_CAPABILITIES.slice(),
            fullAccess: false,
            isOwner: false,
        }]);
    }

    const withAccess = withUserCapabilities(req.session.userId);
    const owned = stmt.events.byUserId.all(req.session.userId).map(rowToEvent);
    const seen = new Set(owned.map(e => e.id));
    const shared = [...personalEventIdsForUser(req.session.userId)]
        .filter(id => !seen.has(id))
        .map(id => rowToEvent(stmt.events.byId.get(id)))
        .filter(Boolean);
    res.json([...owned, ...shared].map(withAccess));
});

// Admin-only overview: every room on the instance, grouped by who owns it,
// with the collaborators on each. This is where "see all users and their
// rooms" lives — separate from the admin's own room list above.
app.get('/api/admin/all-rooms', requireAdmin, (req, res) => {
    const mine = personalEventIdsForUser(req.session.userId);
    const rooms = stmt.events.all.all().map(rowToEvent).map(event => {
        const owner = rowToUser(stmt.users.byId.get(event.userId));
        const link = stmt.sheetLinks.byEventId.get(event.id);
        const collaborators = link
            ? stmt.sheetAccess.byLinkId.all(link.id)
                .filter(a => a.userId !== event.userId)
                .map(a => {
                    const u = rowToUser(stmt.users.byId.get(a.userId));
                    const capabilities = capabilitiesForAccessRow(a);
                    return { id: a.id, userId: a.userId, email: u ? u.email : 'Unknown', role: roleForCapabilities(capabilities), capabilities, claimedAt: a.claimedAt };
                })
            : [];
        return {
            event,
            owner: { userId: event.userId, email: owner ? owner.email : 'Unknown' },
            collaborators,
            ticketCount: stmt.tickets.countByEventId.get(event.id)?.cnt ?? 0,
            // Lets the UI mark which of these already show up under "My rooms".
            isMine: mine.has(event.id),
        };
    });

    // Everyone with an account, so the admin can see who exists even if they
    // hold no rooms at all.
    const users = stmt.users.all.all().map(rowToUser).map(u => ({
        id: u.id,
        email: u.email,
        emailVerified: !!u.emailVerified,
        createdAt: u.createdAt,
        ownedRooms: rooms.filter(r => r.owner.userId === u.id).length,
        sharedRooms: rooms.filter(r => r.collaborators.some(c => c.userId === u.id)).length,
    })).sort((a, b) => a.email.localeCompare(b.email));

    res.json({ rooms, users });
});

app.post('/api/events', requireAuth, async (req, res) => {
    const { name, time, endTime, locationName, locationAddress, lat, lng, color, timezone } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Event name is required' });

    const newEvent = {
        id: nanoid(10),
        userId: req.session.userId,
        name: name.trim(),
        time: time || null,
        endTime: endTime || null,
        color: color || 'rgb(99, 102, 241)',
        imageUrl: null,
        scannerPin: Math.floor(100000 + Math.random() * 900000).toString(),
        location: {
            name:    locationName    ? locationName.trim()    : '',
            address: locationAddress ? locationAddress.trim() : '',
            lat:     lat != null && !isNaN(parseFloat(lat)) ? parseFloat(lat) : null,
            lng:     lng != null && !isNaN(parseFloat(lng)) ? parseFloat(lng) : null,
        },
    };

    stmt.events.insert.run(newEvent.id, newEvent.userId, newEvent.name, newEvent.time, newEvent.endTime, newEvent.color, newEvent.imageUrl, newEvent.scannerPin, JSON.stringify(newEvent.location), 0, null, null, 0, null, 24, null, null, new Date().toISOString());
    // Captured from the organiser's browser so the event renders in the zone
    // it actually happens in, rather than the server's.
    if (isValidTimeZone(timezone)) stmt.events.setTimezone.run(timezone, newEvent.id);
    logAudit(req, { eventId: newEvent.id, action: 'event.created', details: { name: newEvent.name } });
    res.json({ success: true, eventId: newEvent.id, event: newEvent });
});

app.get('/api/events/counts', requireAuth, (req, res) => {
    // Scoped exactly like /api/events — the admin's counts cover their own
    // rooms, not everyone else's.
    const userEvents = [...personalEventIdsForUser(req.session.userId)]
        .map(id => rowToEvent(stmt.events.byId.get(id)))
        .filter(Boolean);
    const counts = {};
    userEvents.forEach(e => {
        const tickets = stmt.tickets.byEventId.all(e.id);
        counts[e.id] = { total: tickets.length, scanned: tickets.filter(t => t.used_at).length };
    });
    res.json(counts);
});

app.get('/api/event/:id', (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.capacity) {
        const usage = eventSeatUsage(event.id);
        // Held seats count as gone: showing them as available is what let ten
        // people start filling in a form for four spots.
        event.ticketsRemaining = usage.remaining;
        event.seatsHeld = usage.held;
        event.soldOut = usage.soldOut;
    }
    // Lets the public registration page style itself without a second request.
    event.themeStyle = themeForEvent(event);
    // So the form can hide "Register Another Person" and warn about a repeat
    // signup before the visitor fills anything in.
    event.deviceAlreadyRegistered = event.oneRegistrationPerDevice && deviceAlreadyRegistered(req, event.id);
    // This route is public — the registration page reads it with no session.
    // The scanner PIN is a door credential and has no business travelling to
    // anyone who merely knows an event id; callers with real access get it
    // from /api/events, which is authenticated.
    if (!req.session.userId || !userHasEventAccess(req.session.userId, event.id)) delete event.scannerPin;
    res.json(event);
});

// The theme catalog, for the picker in the dashboard.
app.get('/api/registration-themes', (req, res) => {
    res.json(REGISTRATION_THEMES.map(t => ({
        key: t.key, label: t.label, description: t.description,
        useEventColor: !!t.useEventColor, dark: !!t.dark, vars: t.vars,
    })));
});

app.put('/api/event/:id/registration-limits', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const b = req.body || {};
    const allowMultiple = b.allowMultipleRegistrations !== false;
    const perDevice = b.oneRegistrationPerDevice === true;
    const blockDupes = b.blockDuplicateEmails === true;
    stmt.events.setRegistrationLimits.run(allowMultiple ? 1 : 0, perDevice ? 1 : 0, blockDupes ? 1 : 0, event.id);
    logAudit(req, { eventId: event.id, action: 'event.registration_limits_changed', details: { allowMultiple, perDevice, blockDupes } });
    res.json({ success: true, allowMultipleRegistrations: allowMultiple, oneRegistrationPerDevice: perDevice, blockDuplicateEmails: blockDupes });
});

app.put('/api/event/:id/theme', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const theme = req.body?.theme;
    if (!REGISTRATION_THEME_KEYS.includes(theme)) {
        return res.status(400).json({ error: 'Unknown theme' });
    }
    stmt.events.setTheme.run(theme, event.id);
    logAudit(req, { eventId: event.id, action: 'event.theme_changed', details: { theme } });
    res.json({ success: true, theme, themeStyle: themeForEvent({ ...event, theme }) });
});

// One event decorated with the caller's capabilities, for opening a room that
// isn't in their own list — the admin reaching into someone else's room from
// the admin overview, mainly.
app.get('/api/event/:id/context', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventAccess(req.session.userId, event.id)) {
        return res.status(403).json({ error: 'You do not have access to this event' });
    }
    const owner = rowToUser(stmt.users.byId.get(event.userId));
    res.json({
        ...withUserCapabilities(req.session.userId)(event),
        owner: { userId: event.userId, email: owner ? owner.email : 'Unknown' },
    });
});

// Calendar invite for an event. Public on purpose: it's linked from ticket
// emails, so it has to open for a recipient who has no session — and it
// exposes nothing the public registration page doesn't already show.
app.get('/api/event/:id/calendar.ics', (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).send('Event not found');
    const ics = buildEventIcs(event);
    if (!ics) return res.status(400).send('This event has no scheduled time yet.');
    const safeName = (event.name || 'event').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'event';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.ics"`);
    res.send(ics);
});

// Edit event details
app.put('/api/event/:id', requireAuth, upload.single('image'), async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const { name, time, endTime, color, locationName, locationAddress, lat, lng, timezone } = req.body;

    let imageUrl = event.imageUrl;
    if (req.file) {
        if (req.file.mimetype === 'image/jpeg') {
            const pngName = req.file.filename.replace(/\.[^.]+$/, '.png');
            const pngPath = path.join(uploadsDir, pngName);
            await sharp(req.file.path).png().toFile(pngPath);
            await fs.promises.unlink(req.file.path);
            imageUrl = `/uploads/${pngName}`;
        } else {
            imageUrl = `/uploads/${req.file.filename}`;
        }
    } else if (req.body.removeImage === 'true') {
        if (event.imageUrl && event.imageUrl.startsWith('/uploads/')) {
            try {
                const oldPath = path.join(uploadsDir, path.basename(event.imageUrl));
                fs.unlinkSync(oldPath);
            } catch (_) {
                // best-effort — missing file shouldn't fail the request
            }
        }
        imageUrl = null;
    }

    const allowReentry = req.body.allowReentry === 'true';
    const capacityRaw = req.body.capacity !== undefined ? req.body.capacity : undefined;
    const newName = name || event.name;
    const newTime = time !== undefined ? (time || null) : event.time;
    const newEndTime = endTime !== undefined ? (endTime || null) : event.endTime;
    const newColor = color || event.color;
    const newCapacity = capacityRaw !== undefined ? (parseInt(capacityRaw) || null) : event.capacity;
    const newLocation = {
        // An empty field that was actually sent means "clear this", the same
        // way time/endTime treat it. Falling back to the stored value made a
        // venue impossible to remove once set — the organiser could only ever
        // replace it, so a venue typed in by mistake stayed on every ticket.
        name: locationName !== undefined ? String(locationName).trim() : (event.location?.name || ''),
        address: locationAddress !== undefined ? String(locationAddress).trim() : (event.location?.address || ''),
        lat: parseFloat(lat) || event.location?.lat || 37.33182,
        lng: parseFloat(lng) || event.location?.lng || -122.03118,
    };

    // Lowering capacity is the one remaining way a spot already promised to
    // someone mid-signup can be taken away — every ticket-issuing path now
    // counts held seats, but the organiser can still shrink the event out from
    // under them. It's their event, so this goes through; it just doesn't go
    // through silently.
    let capacityWarning = null;
    if (newCapacity && newCapacity !== event.capacity) {
        const before = eventSeatUsage(event.id);
        const stranded = Math.max(0, (before.issued + before.held) - newCapacity);
        if (stranded > 0 && before.held > 0) {
            const affected = Math.min(stranded, before.held);
            capacityWarning = `${affected} ${affected === 1 ? 'person is' : 'people are'} part-way through signing up and will lose their spot at this capacity. They'll be told the event filled up.`;
            logAudit(req, { eventId: event.id, action: 'capacity.lowered_over_holds', details: { from: event.capacity, to: newCapacity, affected } });
        }
    }

    stmt.events.update.run(newName, newTime, newEndTime, newColor, imageUrl, allowReentry ? 1 : 0, newCapacity, JSON.stringify(newLocation), req.params.id);
    if (isValidTimeZone(timezone)) stmt.events.setTimezone.run(timezone, req.params.id);

    const priceCents = req.body.ticketPrice !== undefined
        ? Math.round(Math.max(0, parseFloat(req.body.ticketPrice) || 0) * 100)
        : event.ticketPrice;
    stmt.events.setTicketPrice.run(priceCents, req.params.id);

    const updated = rowToEvent(stmt.events.byId.get(req.params.id));
    log('event-edit', `[edit] Updated event — name: ${updated.name}  id: ${updated.id}  by: ${req.session.userId}`);

    const eventTickets = stmt.tickets.byEventId.all(req.params.id).map(rowToTicket);
    pushWalletIfChanged(eventTickets, updated).catch(() => {});

    res.json(capacityWarning ? { ...updated, capacityWarning } : updated);
});

// Update event custom field definitions
app.patch('/api/event/:id', requireAuth, async (req, res) => {
    const { customFields } = req.body;
    if (!Array.isArray(customFields)) return res.status(400).json({ error: 'customFields must be an array of strings' });

    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const cleaned = [...new Set(customFields.map(f => String(f).trim()).filter(Boolean))];
    stmt.events.setCustomFields.run(JSON.stringify(cleaned), req.params.id);

    log('event-settings', `[edit] Updated customFields — event: ${event.name}  fields: [${cleaned.join(', ')}]  by: ${req.session.userId}`);
    res.json({ success: true, customFields: cleaned });
});

app.get('/api/event/:id/tickets', requireAuthOrScanLink, (req, res) => {
    if (!stmt.events.byId.get(req.params.id) || !requestEventCapabilities(req, req.params.id).length) {
        return res.status(401).json({ error: 'Unauthorized or not found' });
    }
    const tickets = stmt.tickets.byEventId.all(req.params.id).map(rowToTicket);
    res.json(tickets);
});

// Giveaway mode: email a spinner-drawn winner using their existing ticket(s)
// for this event — reuses the standard ticket-confirmation email/QR flow
// with a winner-specific intro, rather than a separate notification system.
app.post('/api/event/:id/giveaway/notify-winner', requireAuth, async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const { registrationId, prizeLabel, customMessage } = req.body;
    if (!registrationId) return res.status(400).json({ error: 'registrationId is required' });

    const tickets = stmt.tickets.byRegistrationId.all(registrationId).map(rowToTicket);
    if (!tickets.length || tickets[0].eventId !== event.id) {
        return res.status(404).json({ error: 'Registration not found for this event' });
    }

    if (!process.env.SES_FROM || !process.env.AWS_ACCESS_KEY_ID) {
        return res.status(400).json({ error: 'Email is not configured on this server' });
    }

    const winner = tickets[0];
    const prizeHtml = prizeLabel ? ` You won: <strong>${escEmailText(prizeLabel)}</strong>.` : '';
    const intro = customMessage
        ? `&#127881; ${escEmailText(customMessage)}${prizeHtml}`
        : `&#127881; Congratulations, you're a winner of the <strong>${event.name}</strong> giveaway!${prizeHtml}`;
    const { html, attachments, subject: subjectOverride } = await buildTicketEmailHtml({
        firstName: winner.firstName,
        intro,
        event,
        tickets,
    });
    try {
        await sendEmail({
            to: winner.email,
            fromName: `Tickets - ${event.name}`,
            replyTo: REPLY_TO_EMAIL,
            subject: subjectOverride || `You won! ${event.name}`,
            html,
            attachments,
            registrationId,
        });
    } catch (err) {
        log('giveaway', `[ERR] Email send failed — email: ${winner.email}  err: ${err.message}`);
        return res.status(502).json({ error: 'Failed to send the winner email' });
    }

    log('giveaway', `[winner] Notified — name: ${winner.name}  email: ${winner.email}  event: ${event.name} (${event.id})  by: ${req.session.userId}`);
    logAudit(req, { eventId: event.id, action: 'giveaway.winnerNotified', details: { email: winner.email, prizeLabel: prizeLabel || null } });
    res.json({ success: true });
});

// ── Giveaway presenter/display pairing (SSE) ──────────────────────────────────
// Lets the organizer control the spin from their own device while a second,
// audience-facing device (a TV/projector) shows a clean live view — no pool
// list, no controls, no attendee emails. sessionId is a client-generated
// crypto.randomUUID(), unguessable, and is the only "auth" the display needs
// (same pattern as scanner pairing tokens above); nothing sensitive is ever
// sent over this channel beyond entrant first/last names.
app.get('/api/giveaway/stream/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId) return res.status(400).send('sessionId required');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`: ${' '.repeat(2048)}\n\n`);

    const prev = giveawayChannels.get(sessionId);
    if (prev && prev !== res) { try { prev.end(); } catch (_) { } }
    giveawayChannels.set(sessionId, res);
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) { clearInterval(keepAlive); }
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        if (giveawayChannels.get(sessionId) === res) giveawayChannels.delete(sessionId);
    });
});

app.get('/api/giveaway/status/:sessionId', requireAuth, (req, res) => {
    res.json({ connected: giveawayChannels.has(req.params.sessionId) });
});

app.post('/api/giveaway/broadcast/:sessionId', requireAuth, (req, res) => {
    const { sessionId } = req.params;
    const ch = giveawayChannels.get(sessionId);
    if (!ch) return res.status(404).json({ error: 'No display connected for this session' });
    try {
        ch.write(`data: ${JSON.stringify({ type: req.body?.type, payload: req.body?.payload })}\n\n`);
    } catch (_) {
        giveawayChannels.delete(sessionId);
        return res.status(410).json({ error: 'Display disconnected' });
    }
    res.json({ success: true });
});

// Delete an event
app.delete('/api/event/:id', requireAuth, async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    // Still a 404 rather than a 403: someone with no access at all shouldn't
    // learn whether the event exists.
    if (!event || !userHasEventCapability(req.session.userId, event.id, 'delete_event')) {
        return res.status(404).json({ error: 'Event not found' });
    }

    const deleteEvent = db.transaction(() => {
        stmt.tickets.deleteByEventId.run(req.params.id);
        stmt.pushSubscriptions.deleteByEventId.run(req.params.id);
        stmt.scannerLinks.deleteByEventId.run(req.params.id);
        stmt.scannerAccess.deleteByEventId.run(req.params.id);
        stmt.seatHolds.deleteByEventId.run(req.params.id);
        deleteEventSharing(req.params.id);
        const watcher = stmt.sheetWatchers.byEventId.get(req.params.id);
        if (watcher) {
            stmt.sheetWatcherSeen.deleteByWatcherId.run(watcher.id);
            stmt.sheetWatchers.deleteById.run(watcher.id);
        }
        stmt.events.deleteById.run(req.params.id);
    });
    deleteEvent();
    logAudit(req, { eventId: event.id, action: 'event.deleted', details: { name: event.name } });
    res.json({ success: true });
});

// Bulk delete events
app.delete('/api/events/bulk', requireAuth, async (req, res) => {
    const { eventIds } = req.body;
    if (!Array.isArray(eventIds) || !eventIds.length) return res.status(400).json({ error: 'eventIds required' });
    const allowed = new Set(
        eventIds.filter(id => userHasEventCapability(req.session.userId, id, 'delete_event'))
    );
    const bulkDelete = db.transaction(() => {
        for (const eventId of allowed) {
            stmt.tickets.deleteByEventId.run(eventId);
            stmt.pushSubscriptions.deleteByEventId.run(eventId);
            stmt.scannerLinks.deleteByEventId.run(eventId);
            stmt.scannerAccess.deleteByEventId.run(eventId);
            stmt.seatHolds.deleteByEventId.run(eventId);
            deleteEventSharing(eventId);
            const watcher = stmt.sheetWatchers.byEventId.get(eventId);
            if (watcher) {
                stmt.sheetWatcherSeen.deleteByWatcherId.run(watcher.id);
                stmt.sheetWatchers.deleteById.run(watcher.id);
            }
            stmt.events.deleteById.run(eventId);
        }
    });
    bulkDelete();
    for (const eventId of allowed) {
        logAudit(req, { eventId, action: 'event.deleted', details: { bulk: true } });
    }
    res.json({ success: true, deleted: allowed.size });
});

// Bulk delete registrations (by registrationId)
app.delete('/api/registrations/bulk', requireAuth, async (req, res) => {
    const { registrationIds } = req.body;
    if (!Array.isArray(registrationIds) || !registrationIds.length) return res.status(400).json({ error: 'registrationIds required' });

    const allowedRegistrationIds = new Set();
    const eventIdsForRegs = new Set();
    for (const regId of registrationIds) {
        const tickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        for (const t of tickets) eventIdsForRegs.add(t.eventId);
    }

    for (const eventId of eventIdsForRegs) {
        const event = rowToEvent(stmt.events.byId.get(eventId));
        if (!event) continue;
        if (userHasEventCapability(req.session.userId, eventId, 'manage_tickets')) {
            for (const regId of registrationIds) {
                const tickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket).filter(t => t.eventId === eventId);
                for (const t of tickets) allowedRegistrationIds.add(t.registrationId);
            }
        }
    }

    let deleted = 0;
    const deletedEventIds = new Set();
    const bulkDel = db.transaction(() => {
        for (const regId of allowedRegistrationIds) {
            const tickets = stmt.tickets.byRegistrationId.all(regId);
            deleted += tickets.length;
            for (const t of tickets) {
                deletedEventIds.add(t.eventId);
                stmt.tickets.deleteById.run(t.id);
            }
        }
    });
    bulkDel();
    for (const eventId of deletedEventIds) {
        logAudit(req, { eventId, action: 'registrations.deleted', details: { count: allowedRegistrationIds.size } });
    }
    res.json({ success: true, deleted });
});

// Create ticket manually
app.post('/api/event/:id/ticket', requireAuth, async (req, res) => {
    const { name, email, ticketCount, customFields = {} } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });


    if (!userHasEventCapability(req.session.userId, event.id, 'manage_tickets')) {
        return res.status(403).json({ error: 'Not authorized to create tickets' });
    }

    const count = Math.max(1, parseInt(ticketCount) || 1);

    if (event.capacity) {
        const usage = eventSeatUsage(event.id);
        if (usage.taken + count > usage.capacity) {
            return res.status(409).json({ error: heldSeatMessage(usage, count) });
        }
    }
    const registrationId = nanoid(10);
    const newTickets = [];
    const now = new Date().toISOString();

    const insertTickets = db.transaction(() => {
        for (let i = 0; i < count; i++) {
            const nameParts = name.trim().split(/\s+/);
            const t = {
                id: nanoid(8),
                token: nanoid(12),
                eventId: event.id,
                registrationId,
                name,
                firstName: nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : nameParts[0],
                lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : null,
                email,
                customFields: customFields || {},
                created_at: now,
                used_at: null
            };
            stmt.tickets.insert.run(t.id, t.eventId, t.token, t.registrationId, t.name, t.firstName, t.lastName, t.email, JSON.stringify(t.customFields), null, null, null, null, t.created_at, null, null);
            newTickets.push(t);
        }
    });
    insertTickets();

    log('ticket-create', `[ticket] Created ${newTickets.length} ticket(s) — name: ${name}  email: ${email}  event: ${event.name} (${event.id})  regId: ${registrationId}  by: ${req.session.userId}`);

    const subs = stmt.pushSubscriptions.byEventEnabled.all(event.id);
    const userIds = [...new Set(subs.map(s => s.userId))];
    userIds.forEach(userId => {
        pushAppNotificationToUser(userId, {
            title: 'New registration',
            body: `${event.name} — ${name} • ${newTickets.length} ticket${newTickets.length === 1 ? '' : 's'}`
        }).catch(() => { });
    });

    const explicitSendEmail = req.body.noEmail === true ? false : req.body.sendEmail;
    if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID && shouldSendAdminEmail(explicitSendEmail, event)) {
        const actualCount = newTickets.length;
        const ticketLabel = actualCount === 1 ? 'Ticket' : `${actualCount} Tickets`;
        const eventOwner = rowToUser(stmt.users.byId.get(event.userId));

        const { html, attachments, subject: subjectOverride } = await buildTicketEmailHtml({
            firstName: newTickets[0].firstName,
            intro: `You&rsquo;re all set for <strong>${event.name}</strong>! We&rsquo;ll see you there.`,
            event,
            tickets: newTickets,
        });
        await sendEmail({
            to: email,
            fromName: `Tickets - ${event.name}`,
            replyTo: REPLY_TO_EMAIL,
            subject: subjectOverride || `Your ${ticketLabel} for ${event.name}`,
            html,
            attachments,
            registrationId
        }).catch(err => {
            log('ticket-create', `[ERR] Email send failed — email: ${email}  err: ${err.message}`);
        });
    }

    res.json({ success: true, ticket: newTickets[0], tickets: newTickets });
});

// Edit ticket manually
app.put('/api/ticket/:id', requireAuth, async (req, res) => {
    const { name, email, customFields = {}, noEmail } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const queryTicket = rowToTicket(stmt.tickets.byId.get(req.params.id));
    if (!queryTicket) return res.status(404).json({ error: 'Not found' });
    const event = rowToEvent(stmt.events.byId.get(queryTicket.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!userHasEventCapability(req.session.userId, event.id, 'manage_tickets')) {
        return res.status(403).json({ error: 'Not authorized to edit tickets' });
    }

    const groupTickets = stmt.tickets.byRegistrationId.all(queryTicket.registrationId).map(rowToTicket);
    const firstName = name.split(' ')[0];
    const lastName = name.split(' ').slice(1).join(' ');
    const updateGroup = db.transaction(() => {
        for (const t of groupTickets) {
            stmt.tickets.updateInfo.run(name, firstName, lastName, email, JSON.stringify(customFields), t.id);
        }
    });
    updateGroup();

    const updatedTickets = groupTickets.map(t => ({ ...t, name, firstName, lastName, email, customFields }));

    log('ticket-edit', `[edit] Edited ${updatedTickets.length} ticket(s) — name: ${name}  email: ${email}  event: ${event.name} (${event.id})  regId: ${updatedTickets[0].registrationId}  by: ${req.session.userId}`);

    const editExplicitSendEmail = noEmail === true ? false : undefined;
    if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID && shouldSendAdminEmail(editExplicitSendEmail, event)) {
        const eventOwner = rowToUser(stmt.users.byId.get(event.userId));
        const { html, attachments, subject: subjectOverride } = await buildTicketEmailHtml({
            firstName: updatedTickets[0].firstName,
            intro: `Your registration details for <strong>${event.name}</strong> have been updated.`,
            event,
            tickets: updatedTickets,
        });
        await sendEmail({
            to: email,
            fromName: `Tickets - ${event.name}`,
            replyTo: REPLY_TO_EMAIL,
            subject: subjectOverride || `Updated registration for ${event.name}`,
            html,
            attachments,
            registrationId: updatedTickets[0].registrationId
        }).catch(err => {
            log('ticket-edit', `[ERR] Email send failed — email: ${email}  err: ${err.message}`);
        });
    } else if (noEmail) {
        log('ticket-edit', `[skip] Email skipped (save only)`);
    } else {
        log('ticket-edit', `[warn] Email skipped (SES not configured)`);
    }

    res.json({ success: true, tickets: updatedTickets });
    pushWalletIfChanged(updatedTickets, event).catch(() => { });
});

// Resend ticket email without changing any data
// ── Ticket email template ──────────────────────────────────────────────────
// Authorisation reuses canManageEvent (admin, owner, or a 'full' sheet-share
// grant) — the same rule the rest of event settings uses.
app.get('/api/event/:id/email-template', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!canManageEvent(req, event.id)) return res.status(403).json({ error: 'Not authorized' });
    res.json({
        customized: !!event.emailTemplate,
        template: normalizeEmailTemplate(event.emailTemplate),
        defaultTemplate: DEFAULT_TICKET_EMAIL_TEMPLATE,
    });
});

app.put('/api/event/:id/email-template', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!canManageEvent(req, event.id)) return res.status(403).json({ error: 'Not authorized' });

    // An explicit null resets the event back to the built-in default rather
    // than persisting a copy of it, so future default changes still apply.
    if (req.body?.template === null) {
        stmt.events.setEmailTemplate.run(null, event.id);
        logAudit(req, { eventId: event.id, action: 'email_template_reset' });
        return res.json({ success: true, customized: false, template: DEFAULT_TICKET_EMAIL_TEMPLATE });
    }

    const template = normalizeEmailTemplate(req.body?.template);
    stmt.events.setEmailTemplate.run(JSON.stringify(template), event.id);
    logAudit(req, { eventId: event.id, action: 'email_template_update', details: { blocks: template.blocks.length } });
    res.json({ success: true, customized: true, template });
});

// Renders a draft template with sample data so the editor's preview goes
// through the exact same renderer that real sends do.
app.post('/api/event/:id/email-template/preview', requireAuth, async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!canManageEvent(req, event.id)) return res.status(403).json({ error: 'Not authorized' });

    const template = normalizeEmailTemplate(req.body?.template);
    const sampleCount = Math.min(2, Math.max(1, parseInt(req.body?.ticketCount, 10) || 1));
    const real = stmt.tickets.byEventId.all(event.id).map(rowToTicket);
    const sample = Array.from({ length: sampleCount }, (_, i) => real[i] || {
        token: `SAMPLE${i + 1}TOKEN`,
        name: i === 0 ? 'Jane Smith' : 'Alex Smith',
        firstName: i === 0 ? 'Jane' : 'Alex',
        lastName: 'Smith',
        registrationId: 'SAMPLEREG',
    });

    try {
        const { html } = await buildTicketEmailHtml({
            firstName: sample[0].firstName || 'Jane',
            intro: `You&rsquo;re all set for <strong>${event.name}</strong>! We&rsquo;ll see you there.`,
            event: { ...event, emailTemplate: template },
            tickets: sample,
        });
        // Inline images are cid: references that only resolve inside a real
        // message, so swap in a live QR endpoint for the preview only.
        const previewHtml = html
            .replace(/src="cid:qr-([^@"]+)@[^"]*"/g, (m, token) => `src="${BASE_URL}/qr/${encodeURIComponent(token)}"`)
            .replace(/src="cid:wallet-badge@[^"]*"/g, `src="${BASE_URL}/apple-wallet-badge.png"`);
        res.json({ html: previewHtml });
    } catch (err) {
        log('email-template', `[ERR] Preview failed — event: ${event.id}  ${err.message}`);
        res.status(500).json({ error: 'Could not render preview.' });
    }
});

app.post('/api/ticket/:id/resend', requireAuth, async (req, res) => {
    const ticket = rowToTicket(stmt.tickets.byId.get(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const groupTickets = stmt.tickets.byRegistrationId.all(ticket.registrationId).map(rowToTicket);
    log('resend-email', `[email] Resending ${groupTickets.length} ticket(s) — email: ${ticket.email}  event: ${event.name}  regId: ${ticket.registrationId}  by: ${req.session.userId}`);

    if (!process.env.SES_FROM || !process.env.AWS_ACCESS_KEY_ID) {
        return res.status(503).json({ error: 'Email not configured' });
    }

    const actualCount = groupTickets.length;
    const eventOwner = rowToUser(stmt.users.byId.get(event.userId));
    const { html, attachments, subject: subjectOverride } = await buildTicketEmailHtml({
        firstName: groupTickets[0].firstName,
        intro: `Here&rsquo;s a copy of your ticket${actualCount > 1 ? 's' : ''} for <strong>${event.name}</strong>.`,
        event,
        tickets: groupTickets,
    });
    await sendEmail({
        to: ticket.email,
        fromName: `Tickets - ${event.name}`,
        replyTo: REPLY_TO_EMAIL,
        subject: subjectOverride || `Your ticket${actualCount > 1 ? 's' : ''} for ${event.name}`,
        html,
        attachments,
        registrationId: ticket.registrationId
    }).then(() => {
        res.json({ success: true, count: actualCount });
    }).catch(err => {
        log('resend-email', `[ERR] Send failed — email: ${ticket.email}  err: ${err.message}`);
        res.status(500).json({ error: 'Failed to send email' });
    });
});

// Send a direct custom email to a ticket holder
app.post('/api/ticket/:id/direct-email', requireAuth, async (req, res) => {
    const ticket = rowToTicket(stmt.tickets.byId.get(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const { subject, message } = req.body;
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });

    const html = `
        <div style="font-family:sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #eee; border-radius:12px;">
            <p style="color:#555; white-space:pre-wrap;">${message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>
        </div>
    `;

    const eventOwner = rowToUser(stmt.users.byId.get(event.userId));
    try {
        await sendEmail({
            to: ticket.email,
            fromName: `Tickets - ${event.name}`,
            replyTo: REPLY_TO_EMAIL,
            subject,
            html,
            registrationId: ticket.registrationId
        });
        log('direct-email', `[email] Direct email sent — ticket: ${ticket.id}  to: ${ticket.email}  event: ${event.name}  by: ${req.session.userId}`);
        res.json({ success: true });
    } catch (err) {
        log('direct-email', `[ERR] Direct email failed — ticket: ${ticket.id}  err: ${err.message}`);
        res.status(500).json({ error: 'Failed to send email' });
    }
});

// Send a bulk custom email to all registrants of an event
app.post('/api/event/:id/bulk-email', requireAuth, async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const { subject, message, registrationIds } = req.body;
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });

    // One email per unique registration (not per ticket); optionally filtered to specific regIds
    const eventTickets = stmt.tickets.byEventId.all(event.id).map(rowToTicket);
    const seen = new Set();
    const registrations = eventTickets.filter(t => {
        if (registrationIds && !registrationIds.includes(t.registrationId)) return false;
        if (seen.has(t.registrationId)) return false;
        seen.add(t.registrationId);
        return true;
    });

    if (registrations.length === 0) return res.status(400).json({ error: 'No registrations found for this event' });

    const replyTo = REPLY_TO_EMAIL;
    const escapedMessage = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

    let sent = 0;
    const errors = [];
    for (const ticket of registrations) {
        const html = `
            <div style="margin:0;padding:0;background:#f3f4f6;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
            <tr><td align="center" style="padding:24px 16px;">
            <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
              <tr><td style="background:#2563eb;padding:24px 32px;text-align:center;">
                <p style="margin:0;font-size:11px;font-weight:700;color:rgba(255,255,255,0.8);text-transform:uppercase;letter-spacing:1px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Update from Event Organizer</p>
                <h2 style="margin:8px 0 0;font-size:22px;font-weight:700;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${event.name}</h2>
              </td></tr>
              <tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <p style="font-size:15px;color:#374151;margin:0 0 20px;line-height:1.6;">Hello,</p>
                <p style="font-size:14px;color:#666;margin:0 0 20px;line-height:1.6;">The event organizer has sent you an important update:</p>
                <div style="background:#f9fafb;border-left:4px solid #2563eb;padding:20px;margin:24px 0;border-radius:8px;">
                  <p style="color:#555;white-space:pre-wrap;margin:0;font-size:15px;line-height:1.6;">${escapedMessage}</p>
                </div>
                <p style="font-size:13px;color:#888;margin:0 0 12px;line-height:1.5;">If you have any questions, you can reply to this email and the organizer will get back to you shortly.</p>
              </td></tr>
            </table>
            </td></tr>
            </table>
            </div>
        `;
        try {
            await sendEmail({
                to: ticket.email,
                fromName: `Tickets - ${event.name}`,
                replyTo,
                subject,
                html,
                registrationId: ticket.registrationId
            });
            sent++;
        } catch (err) {
            errors.push(ticket.email);
            log('bulk-email', `[ERR] Failed — email: ${ticket.email}  err: ${err.message}`);
        }
    }

    log('bulk-email', `[email] Bulk email sent — event: ${event.name} (${event.id})  sent: ${sent}  failed: ${errors.length}  by: ${req.session.userId}`);
    logAudit(req, { eventId: event.id, action: 'email.bulk_sent', details: { subject, sent, failed: errors.length } });
    res.json({ success: true, sent, failed: errors.length });
});

// Print-friendly email preview
app.get('/api/ticket/:id/preview', requireAuth, async (req, res) => {
    const ticket = rowToTicket(stmt.tickets.byId.get(req.params.id));
    if (!ticket) return res.status(404).send('Ticket not found');

    const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
    if (!event) return res.status(404).send('Event not found');

    if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) {
        return res.status(403).send('Not authorized');
    }

    const groupTickets = stmt.tickets.byRegistrationId.all(ticket.registrationId).map(rowToTicket);
    const actualCount = groupTickets.length;

    const qrBlocks = groupTickets.map((t, i) => `
        <div class="qr-block">
            <p style="font-weight:600; font-size:14px; color:#555; margin:0 0 12px;">
                ${actualCount > 1 ? `Ticket ${i + 1} of ${actualCount}` : 'Ticket'}
            </p>
            <img src="${BASE_URL}/qr/${t.token}" alt="QR Code" width="180" height="180" style="display:block; margin:0 auto;" />
            <p style="font-size:11px; color:#aaa; margin:10px 0 0;">Token: ${t.token}</p>
            ${t.used_at ? `<p style="font-size:11px; color:#059669; margin:4px 0 0;">✓ Checked in ${new Date(t.used_at).toLocaleString()}</p>` : ''}
        </div>
    `).join('');

    const customFieldRows = Object.entries(groupTickets[0].customFields || {}).map(([k, v]) =>
        `<tr><td style="padding:6px 12px;font-weight:600;color:#555;border-bottom:1px solid #f0f0f0;">${k}</td><td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;">${v}</td></tr>`
    ).join('');

    res.type('html').send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ticket — ${ticket.name} — ${event.name}</title>
<style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 40px auto; padding: 24px; color: #333; }
    .qr-block { text-align:center; margin:24px 0; padding:20px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa; }
    @media print {
        body { margin: 0; max-width: 100%; padding: 16px; }
        .no-print { display: none !important; }
        .qr-block { break-inside: avoid; page-break-inside: avoid; border: 1px solid #ccc; }
    }
</style>
</head>
<body>
<div class="no-print" id="printBar" style="margin-bottom:20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
    <span id="loadHint" style="font-size:12px;color:#888;">Loading QR codes…</span>
</div>
<h2 style="margin-bottom:4px;">${ticket.name}</h2>
<p style="color:#888;margin:0 0 4px;">${ticket.email}</p>
<p style="color:#888;margin:0 0 16px;">Registered ${formatEventDateTime(groupTickets[0].created_at, event, { withWeekday: false, dateOnly: true })}</p>
<hr style="border:none;border-top:1px solid #eee;margin-bottom:16px;">
<p style="margin:0 0 4px;"><strong>${event.name}</strong></p>
${(() => { const v = eventVenue(event); return v.hasAny ? `<p style="color:#555;margin:0 0 4px;">📍 ${v.name}${v.name && v.address ? ' — ' : ''}${v.address}</p>` : ''; })()}
${event.time ? `<p style="color:#555;margin:0 0 20px;">🕐 ${formatEventDateRange(event, { withWeekday: false })}</p>` : ''}
${customFieldRows ? `<table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">${customFieldRows}</table>` : ''}
${qrBlocks}
<script>
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    // Once all QR images are loaded, show the appropriate action
    var imgs = document.querySelectorAll('img');
    var remaining = imgs.length;
    function onImgDone() {
        if (--remaining > 0) return;
        document.getElementById('loadHint').textContent = '';
        var bar = document.getElementById('printBar');
        if (isIOS) {
            // window.print() on iOS Safari blanks the page while the dialog is open — use native share instead
            bar.innerHTML = '<span style="font-size:14px;color:#444;">Tap <strong style=\\'font-weight:700;\\'>&#xfe0f; Share</strong> then <strong style=\\'font-weight:700;\\'>Print</strong> to save as PDF</span>';
        } else {
            var btn = document.createElement('button');
            btn.textContent = '🖨️ Print / Save PDF';
            btn.style.cssText = 'padding:8px 18px;background:#6366f1;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;';
            btn.onclick = function() { window.print(); };
            bar.appendChild(btn);
        }
    }
    if (remaining === 0) { onImgDone(); }
    else { imgs.forEach(function(img) {
        if (img.complete) onImgDone();
        else { img.addEventListener('load', onImgDone); img.addEventListener('error', onImgDone); }
    }); }
<\/script>
</body>
</html>`);
});

// Bulk print-friendly preview for multiple registrations
app.get('/api/tickets/bulk-preview', requireAuth, async (req, res) => {
    const rawIds = (req.query.regIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!rawIds.length) return res.status(400).send('No registration IDs provided');


    const sections = [];
    for (const regId of rawIds) {
        const groupTickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!groupTickets.length) continue;

        const ticket = groupTickets[0];
        const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
        if (!event) continue;

        if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) continue;

        const actualCount = groupTickets.length;
        const qrBlocks = groupTickets.map((t, i) => `
        <div class="qr-block">
            <p style="font-weight:600; font-size:14px; color:#555; margin:0 0 12px;">
                ${actualCount > 1 ? `Ticket ${i + 1} of ${actualCount}` : 'Ticket'}
            </p>
            <img src="${BASE_URL}/qr/${t.token}" alt="QR Code" width="180" height="180" style="display:block; margin:0 auto;" />
            <p style="font-size:11px; color:#aaa; margin:10px 0 0;">Token: ${t.token}</p>
            ${t.used_at ? `<p style="font-size:11px; color:#059669; margin:4px 0 0;">✓ Checked in ${new Date(t.used_at).toLocaleString()}</p>` : ''}
        </div>`).join('');

        const customFieldRows = Object.entries(groupTickets[0].customFields || {}).map(([k, v]) =>
            `<tr><td style="padding:6px 12px;font-weight:600;color:#555;border-bottom:1px solid #f0f0f0;">${k}</td><td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;">${v}</td></tr>`
        ).join('');

        sections.push(`
<div class="registration-block">
    <h2 style="margin-bottom:4px;">${ticket.name}</h2>
    <p style="color:#888;margin:0 0 4px;">${ticket.email}</p>
    <p style="color:#888;margin:0 0 16px;">Registered ${formatEventDateTime(ticket.created_at, event, { withWeekday: false, dateOnly: true })}</p>
    <hr style="border:none;border-top:1px solid #eee;margin-bottom:16px;">
    <p style="margin:0 0 4px;"><strong>${event.name}</strong></p>
    ${(() => { const v = eventVenue(event); return v.hasAny ? `<p style="color:#555;margin:0 0 4px;">📍 ${v.name}${v.name && v.address ? ' — ' : ''}${v.address}</p>` : ''; })()}
    ${event.time ? `<p style="color:#555;margin:0 0 20px;">🕐 ${formatEventDateRange(event, { withWeekday: false })}</p>` : ''}
    ${customFieldRows ? `<table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">${customFieldRows}</table>` : ''}
    ${qrBlocks}
</div>`);
    }

    if (!sections.length) return res.status(404).send('No accessible registrations found');

    res.type('html').send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tickets (${sections.length})</title>
<style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 40px auto; padding: 24px; color: #333; }
    .qr-block { text-align:center; margin:24px 0; padding:20px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa; }
    .registration-block { margin-bottom: 40px; }
    @media print {
        body { margin: 0; max-width: 100%; padding: 16px; }
        .no-print { display: none !important; }
        .qr-block { break-inside: avoid; page-break-inside: avoid; border: 1px solid #ccc; }
        .registration-block { page-break-after: always; }
        .registration-block:last-child { page-break-after: avoid; }
    }
</style>
</head>
<body>
<div class="no-print" style="margin-bottom:20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
    <span id="loadHint" style="font-size:12px;color:#888;">Loading QR codes…</span>
</div>
${sections.join('\n<hr style="border:none;border-top:2px solid #e5e7eb;margin:32px 0;">\n')}
<script>
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    var imgs = document.querySelectorAll('img');
    var remaining = imgs.length;
    function onImgDone() {
        if (--remaining > 0) return;
        document.getElementById('loadHint').textContent = '';
        var bar = document.querySelector('.no-print');
        if (isIOS) {
            bar.innerHTML = '<span style="font-size:14px;color:#444;">Tap <strong style=\\'font-weight:700;\\'>&#xfe0f; Share</strong> then <strong style=\\'font-weight:700;\\'>Print</strong> to save as PDF</span>';
        } else {
            var btn = document.createElement('button');
            btn.textContent = '🖨️ Print / Save PDF';
            btn.style.cssText = 'padding:8px 18px;background:#6366f1;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;';
            btn.onclick = function() { window.print(); };
            bar.appendChild(btn);
        }
    }
    if (remaining === 0) { onImgDone(); }
    else { imgs.forEach(function(img) {
        if (img.complete) onImgDone();
        else { img.addEventListener('load', onImgDone); img.addEventListener('error', onImgDone); }
    }); }
<\/script>
</body>
</html>`);
});

// Bulk check-in (must be defined before /:registrationId to avoid route conflict)
app.post('/api/checkin/bulk', requireAuth, async (req, res) => {
    const { registrationIds } = req.body;
    if (!Array.isArray(registrationIds) || !registrationIds.length) return res.status(400).json({ error: 'registrationIds required' });

    const now = new Date().toISOString();
    let checkedIn = 0;
    const touchedEventIds = new Map();

    for (const regId of registrationIds) {
        const tickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!tickets.length) continue;
        const event = rowToEvent(stmt.events.byId.get(tickets[0].eventId));
        if (!event) continue;
        if (!userHasEventCapability(req.session.userId, event.id, 'checkin')) continue;

        let eventCheckedIn = 0;
        db.transaction(() => {
            for (const t of tickets) {
                if (!t.used_at) {
                    checkedIn++;
                    eventCheckedIn++;
                    if (event.allowReentry) {
                        stmt.tickets.checkInReentry.run(now, now, t.id);
                    } else {
                        stmt.tickets.checkIn.run(now, now, t.id);
                    }
                }
            }
        })();
        if (eventCheckedIn > 0) touchedEventIds.set(event.id, (touchedEventIds.get(event.id) || 0) + eventCheckedIn);
        pushWalletIfChanged(tickets, event).catch(() => {});
    }

    ticketStatusCache.clear();
    log('checkin', `[bulk] Checked in ${checkedIn} ticket(s) across ${registrationIds.length} registration(s)  by: ${req.session.userId}`);
    for (const [eventId, count] of touchedEventIds) {
        logAudit(req, { eventId, action: 'checkin.bulk', details: { count } });
    }
    res.json({ success: true, checkedIn });
});

// Bulk undo check-in (must be defined before /:registrationId)
app.delete('/api/checkin/bulk', requireAuth, async (req, res) => {
    const { registrationIds } = req.body;
    if (!Array.isArray(registrationIds) || !registrationIds.length) return res.status(400).json({ error: 'registrationIds required' });

    const now = new Date().toISOString();
    let cleared = 0;
    const touchedEventIds = new Map();

    for (const regId of registrationIds) {
        const tickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!tickets.length) continue;
        const event = rowToEvent(stmt.events.byId.get(tickets[0].eventId));
        if (!event) continue;
        if (!userHasEventCapability(req.session.userId, event.id, 'undo_checkin')) continue;

        let eventCleared = 0;
        db.transaction(() => {
            for (const t of tickets) {
                if (t.used_at) { cleared++; eventCleared++; }
                stmt.tickets.undoCheckIn.run(now, t.id);
            }
        })();
        if (eventCleared > 0) touchedEventIds.set(event.id, (touchedEventIds.get(event.id) || 0) + eventCleared);
        pushWalletIfChanged(tickets, event).catch(() => {});
    }

    ticketStatusCache.clear();
    log('uncheckin', `[bulk] Cleared ${cleared} ticket(s) across ${registrationIds.length} registration(s)  by: ${req.session.userId}`);
    for (const [eventId, count] of touchedEventIds) {
        logAudit(req, { eventId, action: 'checkin.bulk_undo', details: { count } });
    }
    res.json({ success: true, cleared });
});

// Bulk resend ticket emails
app.post('/api/registrations/bulk-resend', requireAuth, async (req, res) => {
    const { registrationIds } = req.body;
    if (!Array.isArray(registrationIds) || !registrationIds.length) return res.status(400).json({ error: 'registrationIds required' });

    if (!process.env.SES_FROM || !process.env.AWS_ACCESS_KEY_ID) {
        return res.status(503).json({ error: 'Email not configured' });
    }

    let sent = 0, failed = 0;

    for (const regId of registrationIds) {
        const groupTickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!groupTickets.length) continue;
        const ticket = groupTickets[0];
        const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
        if (!event) continue;
        if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) continue;

        const actualCount = groupTickets.length;
        const eventOwner = rowToUser(stmt.users.byId.get(event.userId));
        try {
            const { html, attachments, subject: subjectOverride } = await buildTicketEmailHtml({
                firstName: ticket.firstName,
                intro: `Here&rsquo;s a copy of your ticket${actualCount > 1 ? 's' : ''} for <strong>${event.name}</strong>.`,
                event,
                tickets: groupTickets,
            });
            await sendEmail({
                to: ticket.email,
                fromName: `Tickets - ${event.name}`,
                replyTo: REPLY_TO_EMAIL,
                subject: subjectOverride || `Your ticket${actualCount > 1 ? 's' : ''} for ${event.name}`,
                html,
                attachments,
                registrationId: regId
            });
            sent++;
        } catch (err) {
            failed++;
            log('resend-email', `[ERR] Bulk resend failed — email: ${ticket.email}  err: ${err.message}`);
        }
    }

    log('resend-email', `[bulk] Resent to ${sent} registration(s)  failed: ${failed}  by: ${req.session.userId}`);
    res.json({ success: true, sent, failed });
});

// CSV export for selected registrations
app.get('/api/tickets/export-csv', requireAuth, async (req, res) => {
    const rawIds = (req.query.regIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!rawIds.length) return res.status(400).send('No registration IDs provided');


    const rows = [];
    const customFieldKeys = new Set();

    for (const regId of rawIds) {
        const groupTickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!groupTickets.length) continue;
        const ticket = groupTickets[0];
        const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
        if (!event) continue;
        if (!userHasEventCapability(req.session.userId, event.id, 'export_data')) continue;

        Object.keys(ticket.customFields || {}).forEach(k => customFieldKeys.add(k));
        rows.push({ ticket, groupTickets, event });
    }

    if (!rows.length) return res.status(404).send('No accessible registrations found');

    const cfKeys = [...customFieldKeys];
    const headers = ['Name', 'Email', 'Tickets', 'Registered', 'Status', ...cfKeys];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const csvRows = [headers.map(esc).join(',')];
    for (const { ticket, groupTickets, event } of rows) {
        const checkedIn = groupTickets.filter(t => t.used_at).length;
        const total = groupTickets.length;
        const status = checkedIn === 0 ? 'Pending' : checkedIn === total ? 'Checked In' : `${checkedIn}/${total} Checked In`;
        const registered = ticket.created_at ? new Date(ticket.created_at).toLocaleDateString('en-US', { timeZone: eventTimeZone(event) }) : '';
        csvRows.push([ticket.name, ticket.email, total, registered, status, ...cfKeys.map(k => ticket.customFields?.[k] ?? '')].map(esc).join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tickets-export.csv"`);
    res.send(csvRows.join('\r\n'));
});

// API: Validate QR Code
// Manual check-in by registrationId (marks all tickets in the group)
app.post('/api/checkin/:registrationId', requireAuthOrScanLink, async (req, res) => {
    const { registrationId } = req.params;

    let tickets = stmt.tickets.byRegistrationId.all(registrationId).map(rowToTicket);
    if (!tickets.length) {
        const single = rowToTicket(stmt.tickets.byId.get(registrationId));
        if (single) tickets = [single];
    }

    if (!tickets.length) {
        log('checkin', `[ERR] FAILED — no ticket/registration found for id: ${registrationId}  by: ${req.session.userId}`);
        return res.status(404).json({ error: 'Not found' });
    }

    // This route had no per-event check at all, so any signed-in account could
    // check in a ticket for an event it has nothing to do with.
    if (!requestHasCapability(req, tickets[0].eventId, 'checkin')) {
        return res.status(403).json({ error: 'Not authorized to check in for this event' });
    }

    const checkinEvent = rowToEvent(stmt.events.byId.get(tickets[0].eventId));
    const now = new Date().toISOString();
    let checkedInCount = 0;
    const doCheckin = db.transaction(() => {
        for (const t of tickets) {
            const wasUsed = !!t.used_at;
            if (!wasUsed) {
                t.used_at = now;
                checkedInCount++;
            }
            if (checkinEvent?.allowReentry) {
                t.reentry_status = 'inside';
                if (!wasUsed) {
                    stmt.tickets.checkInReentry.run(now, now, t.id);
                } else {
                    stmt.tickets.reentryEnter.run(now, t.id);
                }
            } else if (!wasUsed) {
                stmt.tickets.checkIn.run(now, now, t.id);
            }
        }
    });
    doCheckin();

    if (checkedInCount === 0) {
        log('checkin', `[warn] Already checked in — regId: ${registrationId}  name: ${tickets[0]?.name}  event: ${checkinEvent?.name}  by: ${req.session.userId}`);
    } else {
        log('checkin', `[OK] Checked in ${checkedInCount}/${tickets.length} ticket(s) — regId: ${registrationId}  name: ${tickets[0]?.name}  event: ${checkinEvent?.name}  by: ${req.session.userId}`);
    }

    ticketStatusCache.clear();
    if (checkedInCount > 0) {
        logAudit(req, { eventId: checkinEvent?.id, action: 'checkin.manual', details: { registrationId, name: tickets[0]?.name, count: checkedInCount } });
    }
    res.json({ success: true });
    pushWalletIfChanged(tickets, checkinEvent).catch(() => { });
});

app.delete('/api/checkin/:registrationId', requireAuthOrScanLink, async (req, res) => {
    const { registrationId } = req.params;

    let tickets = stmt.tickets.byRegistrationId.all(registrationId).map(rowToTicket);
    if (!tickets.length) {
        const single = rowToTicket(stmt.tickets.byId.get(registrationId));
        if (single) tickets = [single];
    }

    if (!tickets.length) return res.status(404).json({ error: 'Not found' });

    const event = rowToEvent(stmt.events.byId.get(tickets[0].eventId));
    if (!event || !requestHasCapability(req, event.id, 'undo_checkin')) {
        return res.status(403).json({ error: 'You do not have permission to undo check-ins for this event' });
    }

    const uncheckinNow = new Date().toISOString();
    let clearedCount = 0;
    const doUndo = db.transaction(() => {
        for (const t of tickets) {
            if (t.used_at) clearedCount++;
            t.used_at = null;
            t.reentry_status = null;
            t.updated_at = uncheckinNow;
            stmt.tickets.undoCheckIn.run(uncheckinNow, t.id);
        }
    });
    doUndo();

    log('uncheckin', `[undo] Cleared ${clearedCount} ticket(s) — regId: ${registrationId}  name: ${tickets[0]?.name}  event: ${event?.name}  by: ${req.session.userId}`);
    if (clearedCount > 0) {
        logAudit(req, { eventId: event?.id, action: 'checkin.undo', details: { registrationId, name: tickets[0]?.name, count: clearedCount } });
    }
    ticketStatusCache.clear();

    if (event?.displayToken) {
        const allT = stmt.tickets.byEventId.all(event.id);
        const payload = { type: 'scan', status: 'undo', name: tickets[0]?.name, registrationId, total: allT.length, scanned: allT.filter(t => t.used_at).length };
        broadcastToDisplayToken(event.displayToken, payload);
        for (const [pairToken, data] of scannerRegistry.entries()) {
            if (data.eventId === event.id) broadcastToPair(pairToken, payload);
        }
    }

    res.json({ success: true });
    pushWalletIfChanged(tickets, event).catch(() => { });
});

app.post('/api/validate', validateLimiter, async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const cleanToken = (token.startsWith('ticket:') ? token.split(':')[1] : token).trim();
    const ticket = rowToTicket(stmt.tickets.byToken.get(cleanToken));

    if (!ticket) {
        log('validate', `[ERR] INVALID token: ${cleanToken}  ip: ${getIP(req)}`);
        const pt = req.body.pairToken;
        if (pt) {
            const sd = scannerRegistry.get(pt);
            if (sd?.eventId) {
                const ev = rowToEvent(stmt.events.byId.get(sd.eventId));
                if (ev?.displayToken) {
                    const evT = stmt.tickets.byEventId.all(ev.id);
                    broadcastToDisplayToken(ev.displayToken, { type: 'scan', status: 'invalid', name: 'Unknown Ticket', total: evT.length, scanned: evT.filter(t => t.used_at).length });
                }
            }
        }
        return res.json({ status: 'invalid', message: 'Invalid ticket' });
    }

    // Require proof this caller is actually authorized to scan for this
    // ticket's event — a live session, a real scan-link token, or a real
    // display token. Checked before any ticket state is revealed or
    // mutated, so an unauthorized caller can't check someone in or even
    // learn the attendee's name/email.
    if (!scannerAuthorized(req, ticket.eventId)) {
        log('validate', `[ERR] UNAUTHORIZED scan attempt — ticket: ${ticket.id}  event: ${ticket.eventId}  ip: ${getIP(req)}`);
        return res.status(401).json({ status: 'unauthorized', message: 'Sign in or use a valid scan link to check in tickets.' });
    }

    // Security: a ticket is only ever valid for the event it was actually
    // issued for. Scanning clients pass the eventId the door staff selected
    // on their device — if it doesn't match the ticket's real event, reject
    // it as invalid rather than letting a ticket from event A validate at
    // event B. (Older, not-yet-updated scanner clients that don't send
    // eventId yet still fall through to the normal check below — this only
    // enforces once a caller actually tells us which event it's scanning for.)
    if (req.body.eventId && req.body.eventId !== ticket.eventId) {
        log('validate', `[ERR] WRONG EVENT — ticket: ${ticket.id}  ticketEvent: ${ticket.eventId}  scannedFor: ${req.body.eventId}  ip: ${getIP(req)}`);
        return res.json({ status: 'invalid', message: 'This ticket is not valid for this event' });
    }

    const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
    const ticketFields = {
        name: ticket.name, firstName: ticket.firstName ?? null, lastName: ticket.lastName ?? null,
        email: ticket.email, customFields: ticket.customFields ?? null,
        ticketId: ticket.id, registrationId: ticket.registrationId,
        eventId: ticket.eventId, eventName: event ? event.name : null,
    };

    if (ticket.used_at) {
        if (event && event.allowReentry) {
            const currentStatus = ticket.reentry_status || 'inside';
            if (currentStatus === 'inside') {
                log('validate', `[exit] REENTRY EXIT PROMPT — ticket: ${ticket.id}  name: ${ticket.name}  event: ${event?.name}  ip: ${getIP(req)}`);
                if (event?.displayToken) {
                    const _t = stmt.tickets.byEventId.all(event.id);
                    broadcastToDisplayToken(event.displayToken, { type: 'scan', status: 'reentry_exit', name: ticket.name, registrationId: ticket.registrationId, total: _t.length, scanned: _t.filter(t => t.used_at).length });
                }
                return res.json({ status: 'reentry_exit', message: 'Confirm check-out?', used_at: ticket.used_at, ...ticketFields });
            } else {
                const reentryAt = new Date().toISOString();
                ticket.reentry_status = 'inside';
                ticket.updated_at = reentryAt;
                stmt.tickets.reentryEnter.run(reentryAt, ticket.id);
                ticketStatusCache.clear();
                log('validate', `[OK] REENTRY ENTER — ticket: ${ticket.id}  name: ${ticket.name}  event: ${event?.name}  ip: ${getIP(req)}`);
                res.json({ status: 'reentry_enter', message: `Welcome back to ${event ? event.name : 'the event'}!`, ...ticketFields });
                if (event) { const _t = stmt.tickets.byEventId.all(event.id); recordScan(req.body.pairToken, event, 'reentry_enter', ticket, _t); }
                pushWalletIfChanged([ticket], event).catch(() => { });
                return;
            }
        }
        log('validate', `[warn] ALREADY USED — ticket: ${ticket.id}  name: ${ticket.name}  event: ${event?.name}  used_at: ${ticket.used_at}  ip: ${getIP(req)}`);
        res.json({ status: 'used', message: 'Ticket already used', used_at: ticket.used_at, ...ticketFields });
        if (event) { const _t = stmt.tickets.byEventId.all(event.id); recordScan(req.body.pairToken, event, 'used', ticket, _t); }
        return;
    }

    const validatedAt = new Date().toISOString();
    ticket.used_at = validatedAt;
    ticket.updated_at = validatedAt;
    if (event && event.allowReentry) {
        ticket.reentry_status = 'inside';
        stmt.tickets.checkInReentry.run(validatedAt, validatedAt, ticket.id);
    } else {
        stmt.tickets.checkIn.run(validatedAt, validatedAt, ticket.id);
    }
    ticketStatusCache.clear();

    log('validate', `[OK] VALID — ticket: ${ticket.id}  name: ${ticket.name}  event: ${event?.name}  ip: ${getIP(req)}`);
    res.json({ status: 'valid', message: `Welcome to ${event ? event.name : 'the event'} !`, ...ticketFields });
    if (event) { const _t = stmt.tickets.byEventId.all(event.id); recordScan(req.body.pairToken, event, 'valid', ticket, _t); }
    pushWalletIfChanged([ticket], event).catch(() => { });
});

// Read-only ticket check — for external systems linked to a specific event
// (e.g. a shuttle app checking riders onto a bus with the same ticket they
// already have for the event). Never sets used_at and never gates on it —
// a ticket can be checked as many times as the rider boards. Only usable for
// events the organizer has explicitly opted in via shuttleLinkEnabled, and
// only within the linked event (the caller's eventId must match). This is
// deliberately a separate endpoint from /api/validate rather than a mode on
// it, so door check-in logic is never at risk from this feature.
app.post('/api/ticket-check', validateLimiter, (req, res) => {
    const { token, eventId } = req.body;
    if (!token || !eventId) return res.status(400).json({ error: 'token and eventId are required' });

    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event || !event.shuttleLinkEnabled) {
        return res.status(403).json({ error: 'This event is not enabled for external ticket checks' });
    }

    const cleanToken = (token.startsWith('ticket:') ? token.split(':')[1] : token).trim();
    const ticket = rowToTicket(stmt.tickets.byToken.get(cleanToken));

    if (!ticket || ticket.eventId !== eventId) {
        log('ticket-check', `[ERR] INVALID/WRONG EVENT — token: ${cleanToken}  eventId: ${eventId}  ip: ${getIP(req)}`);
        return res.json({ valid: false });
    }

    // Informational log only — never gates future checks
    try { stmt.ticketScans.insert.run(nanoid(), ticket.id, ticket.eventId, new Date().toISOString(), req.body.source || null); } catch {}

    log('ticket-check', `[OK] ticket: ${ticket.id}  name: ${ticket.name}  event: ${event.name}  ip: ${getIP(req)}`);
    res.json({
        valid: true,
        name: ticket.name, firstName: ticket.firstName ?? null,
        ticketId: ticket.id, registrationId: ticket.registrationId,
        eventId: ticket.eventId, eventName: event.name,
    });
});

// Create a no-login scanner link for one event. Anyone with the link can
// scan/check in tickets for exactly this event (nothing else) — no account
// needed. Multiple links per event so each staffer/device can be named and
// revoked independently instead of everyone sharing one credential.
app.post('/api/event/:id/scanner-links', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_event')) return res.status(403).json({ error: 'Forbidden' });
    const label = (req.body.label || '').trim();
    const link = { id: nanoid(10), eventId: event.id, token: nanoid(24), label, createdBy: req.session.userId, createdAt: new Date().toISOString() };
    stmt.scannerLinks.insert.run(link.id, link.eventId, link.token, link.label, link.createdBy, link.createdAt);
    logAudit(req, { eventId: event.id, action: 'scannerlink.created', details: { label } });
    res.json({ success: true, link: { ...link, url: `${BASE_URL}/scan/${link.token}` } });
});

// Auto-creates a first link so a brand-new event always has something to
// show on the dashboard immediately — same lazy-init pattern as displayToken.
app.get('/api/event/:id/scanner-links', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventAccess(req.session.userId, event.id)) return res.status(403).json({ error: 'Forbidden' });
    if (!stmt.scannerLinks.byEventId.all(event.id).length) {
        const link = { id: nanoid(10), eventId: event.id, token: nanoid(24), label: '', createdBy: req.session.userId, createdAt: new Date().toISOString() };
        stmt.scannerLinks.insert.run(link.id, link.eventId, link.token, link.label, link.createdBy, link.createdAt);
    }
    const links = stmt.scannerLinks.byEventId.all(event.id).map(l => ({ ...l, url: `${BASE_URL}/scan/${l.token}` }));
    res.json(links);
});

// QR code PNG for a scan link — lets any phone's regular camera app open it
app.get('/api/scanner-links/:id/qr', requireAuth, async (req, res) => {
    const link = stmt.scannerLinks.byId.get(req.params.id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (!userHasEventAccess(req.session.userId, link.eventId)) return res.status(403).json({ error: 'Forbidden' });
    const url = `${BASE_URL}/scan/${link.token}`;
    try {
        const png = await QRCode.toBuffer(url, { width: 400, margin: 2 });
        res.set('Content-Type', 'image/png').set('Cache-Control', 'no-cache').send(png);
    } catch (err) {
        res.status(500).json({ error: 'QR generation failed' });
    }
});

app.delete('/api/scanner-links/:id', requireAuth, (req, res) => {
    const link = stmt.scannerLinks.byId.get(req.params.id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (!userHasEventCapability(req.session.userId, link.eventId, 'manage_event')) return res.status(403).json({ error: 'Forbidden' });
    stmt.scannerLinks.deleteById.run(link.id);
    logAudit(req, { eventId: link.eventId, action: 'scannerlink.revoked', details: { label: link.label } });
    res.json({ success: true });
});

// PUBLIC: resolve a scan link to its event — no auth required, this is the
// whole point. Scanning itself (/api/validate, /api/checkout) already works
// without a session; this endpoint's job is telling the device which event
// to lock to. If the request DOES carry a valid session (the person opening
// the link happens to be signed in), also grant that account standing
// "scanner" access to the event, so it shows up in Your Events from now on
// instead of only being locked in for this one device/session.
app.get('/api/scanner-links/:token', (req, res) => {
    const link = stmt.scannerLinks.byToken.get(req.params.token);
    if (!link) return res.status(404).json({ error: 'Invalid or revoked scan link' });
    const event = rowToEvent(stmt.events.byId.get(link.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    stmt.scannerLinks.touchLastUsed.run(new Date().toISOString(), link.id);
    if (req.session.userId && req.session.userId !== event.userId) {
        stmt.scannerAccess.insert.run(nanoid(10), req.session.userId, event.id, new Date().toISOString());
    } else if (!req.session.userId) {
        // Scope this session to the one event behind the link, so the rest of
        // the scanner (check-in list, undo, door display) works without a
        // login instead of only /api/validate.
        req.session.scanLink = { token: link.token, eventId: event.id };
    }
    res.json({
        eventId: event.id,
        eventName: event.name,
        color: event.color,
        allowReentry: event.allowReentry,
        capabilities: req.session.userId
            ? userEventCapabilities(req.session.userId, event.id)
            : SCAN_LINK_CAPABILITIES.slice(),
    });
});

// Hand back the scan link — used when door staff leave scan-link mode, so the
// scoped grant doesn't linger on the session.
app.post('/api/scan-link/exit', (req, res) => {
    if (req.session) req.session.scanLink = null;
    res.json({ success: true });
});

// fresh=1 rides along on every scan link, including ones already printed on a
// QR code or shared months ago — adding it here rather than to the emitted URL
// means the link people copy stays clean and old links get it for free. It is
// a no-op for a client already on a self-updating worker (see sw-register.js);
// it only does anything for one still stuck on the old cache-first build.
app.get('/scan/:token', (req, res) => {
    res.redirect(`/scanner.html?scanToken=${encodeURIComponent(req.params.token)}&fresh=1`);
});

// Confirm reentry check-out — no session required (scanner/display support
// no-login access via scan links and display tokens), but scannerAuthorized
// below still requires proof of one of those, same as /api/validate.
app.post('/api/checkout', async (req, res) => {
    const { token, registrationId, pairToken } = req.body;
    if (!token && !registrationId) return res.status(400).json({ error: 'Token or registrationId is required' });

    let ticket;
    if (token) {
        const cleanToken = (token.startsWith('ticket:') ? token.split(':')[1] : token).trim();
        ticket = rowToTicket(stmt.tickets.byToken.get(cleanToken));
    } else {
        ticket = rowToTicket(stmt.tickets.firstByRegistrationId.get(registrationId));
    }
    if (!ticket) return res.json({ status: 'invalid', message: 'Invalid ticket' });

    if (!scannerAuthorized(req, ticket.eventId)) {
        log('checkout', `[ERR] UNAUTHORIZED checkout attempt — ticket: ${ticket.id}  event: ${ticket.eventId}  ip: ${getIP(req)}`);
        return res.status(401).json({ status: 'unauthorized', message: 'Sign in or use a valid scan link to check out.' });
    }

    const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
    if (!event || !event.allowReentry) return res.status(400).json({ error: 'Reentry not enabled for this event' });

    const ticketFields = {
        name: ticket.name, firstName: ticket.firstName ?? null, lastName: ticket.lastName ?? null,
        email: ticket.email, customFields: ticket.customFields ?? null,
        ticketId: ticket.id, registrationId: ticket.registrationId,
        eventId: ticket.eventId, eventName: event.name,
    };

    const now = new Date().toISOString();
    ticket.reentry_status = 'outside';
    ticket.updated_at = now;
    stmt.tickets.reentryExit.run(now, ticket.id);
    ticketStatusCache.clear();

    log('checkout', `[exit] CHECKED OUT — ticket: ${ticket.id}  name: ${ticket.name}  event: ${event.name}  ip: ${getIP(req)}`);
    res.json({ status: 'checked_out', message: 'Checked out successfully', ...ticketFields });
    {
        const allT = stmt.tickets.byEventId.all(event.id).map(rowToTicket);
        const scanned = allT.filter(t => t.used_at).length;
        if (event?.displayToken) {
            const payload = { type: 'scan', status: 'checked_out', name: ticket.name, registrationId: ticket.registrationId, total: allT.length, scanned };
            broadcastToDisplayToken(event.displayToken, payload);
            for (const [pairToken, data] of scannerRegistry.entries()) {
                if (data.eventId === event.id) broadcastToPair(pairToken, payload);
            }
        }
        // Broadcast to dashboard / monitor so checkout reflects live
        broadcastToMonitors(event.id, {
            type: 'ticket_scan',
            eventId: event.id,
            pairToken: pairToken || null,
            registrationId: ticket.registrationId,
            status: 'checked_out',
            name: ticket.name,
            total: allT.length,
            scanned,
            usedAt: ticket.used_at,
            reentryStatus: 'outside',
        });
        if (pairToken) {
            upsertScanner(pairToken, {
                lastSeen: new Date().toISOString(),
                lastResult: { status: 'checked_out', name: ticket.name || '', registrationId: ticket.registrationId, total: allT.length, scanned }
            });
        }
    }
    pushWalletIfChanged([ticket], event).catch(() => { });
});

// Helper: QR Generation Route (Alternative for frontend display)
app.get('/qr/:token', async (req, res) => {
    try {
        const qrContent = `ticket:${req.params.token}`;
        const qrBuffer = await QRCode.toBuffer(qrContent);
        res.type('png').send(qrBuffer);
    } catch (err) {
        res.status(500).send('Error generating QR');
    }
});

// Stamp updated_at and push to Wallet only when pass content actually changed.
// Returns true if a push was triggered.
async function pushWalletIfChanged(tickets, events) {
    if (!Array.isArray(tickets)) tickets = [tickets];
    const changed = [];
    const now = new Date().toISOString();
    for (const ticket of tickets) {
        const event = events.find ? events.find(e => e.id === ticket.eventId) : events;
        if (!event) continue;
        const newHash = passContentHash(ticket, event);
        if (ticket.passHash !== newHash) {
            ticket.passHash = newHash;
            ticket.updated_at = now;
            stmt.tickets.setPassHash.run(newHash, now, ticket.id);
            // Invalidate pass cache so next Apple fetch regenerates
            const cachePath = path.join(passCacheDir, `${ticket.token}.pkpass`);
            try { if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath); } catch (_) {}
            try { if (fs.existsSync(cachePath + '.meta')) fs.unlinkSync(cachePath + '.meta'); } catch (_) {}
            changed.push(ticket.token);
        }
    }
    if (changed.length) {
        pushWalletUpdate(changed).catch(() => { });
    }
    return changed.length > 0;
}

// Compute a short hash of the fields that actually affect pass content.
// Only when this changes should we stamp updated_at and push to Wallet.
// Bump PASS_TEMPLATE_VERSION whenever template-level fields (organizationName, relevantText, etc.) change.
const PASS_TEMPLATE_VERSION = 13;
function passContentHash(ticket, event) {
    const data = JSON.stringify({
        _v: PASS_TEMPLATE_VERSION,
        name: ticket.name,
        token: ticket.token,
        used_at: ticket.used_at ?? null,
        reentry_status: ticket.reentry_status ?? null,
        customFields: ticket.customFields ?? {},
        eventName: event.name,
        eventColor: event.color,
        eventTime: event.time,
        eventLat: event.location?.lat,
        eventLng: event.location?.lng,
        allowReentry: !!event.allowReentry,
        walletLockScreenEnabled: !!event.walletLockScreenEnabled
    });
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// morning/afternoon/tonight has to be decided by the clock at the venue, not
// on the server — getHours() here would read UTC in production.
function humanEventTime(date, event) {
    const timeStr = formatEventDateTime(date, event, { timeOnly: true, showZone: false });
    const parts = zonedParts(date, eventTimeZone(event));
    const h = parts ? parseInt(parts.hour, 10) : date.getUTCHours();
    if (h < 12) return `This morning at ${timeStr}`;
    if (h < 17) return `This afternoon at ${timeStr}`;
    return `Tonight at ${timeStr}`;
}

// Shared helper — builds and returns a .pkpass Buffer for a ticket+event
async function generatePassBuffer(ticket, event) {
    const certPath = path.resolve(__dirname, 'certs');
    const wwdrFile = path.join(certPath, 'wwdr.pem');
    const signerCertFile = path.join(certPath, 'signer.pem');
    const signerKeyFile = path.join(certPath, 'signer.key');
    const modelPath = path.resolve(__dirname, 'pass-assets.pass');

    const isInsideReentry = event.allowReentry && ticket.reentry_status === 'inside';
    const isCheckedIn = !event.allowReentry && !!ticket.used_at;
    const showCheckedInStyle = isCheckedIn || isInsideReentry;

    const passOverride = {
        serialNumber: ticket.token,
        passTypeIdentifier: process.env.PASS_TYPE_ID,
        teamIdentifier: process.env.TEAM_ID,
        description: event.name,
        logoText: showCheckedInStyle ? "✓ CHECKED IN" : event.name,
        backgroundColor: showCheckedInStyle ? "rgb(90, 90, 90)" : (event.color || "rgb(99, 102, 241)"),
        foregroundColor: "rgb(255, 255, 255)",
        labelColor: "rgb(255, 255, 255)",
    };
    // Enable push updates if APNs is configured (authenticationToken must be ≥16 chars)
    if (process.env.APNS_KEY_ID && process.env.APNS_KEY_PATH) {
        passOverride.webServiceURL = `${BASE_URL}/api/wallet/`;
        passOverride.authenticationToken = ticket.id + ticket.token; // 8+12=20 chars
    }

    const pass = await PKPass.from({
        model: modelPath,
        certificates: {
            wwdr: fs.readFileSync(wwdrFile),
            signerCert: fs.readFileSync(signerCertFile),
            signerKey: fs.readFileSync(signerKeyFile),
            signerKeyPassphrase: process.env.PASS_CERT_PASSWORD || undefined,
        }
    }, passOverride);

    // Reentry events: never void — keep QR so attendee can re-scan. Change color/text instead.
    // Normal events: void and remove QR when checked in (existing behavior).
    pass.voided = isCheckedIn;

    if (!isCheckedIn) {
        pass.setBarcodes({
            format: "PKBarcodeFormatQR",
            message: `ticket:${ticket.token}`,
            messageEncoding: "iso-8859-1"
        });
    }

    const lat = event.location?.lat;
    const lng = event.location?.lng;
    // event.time is null for an intentionally undated event — new Date(null)
    // would silently evaluate to the Unix epoch rather than an invalid date,
    // so "has a time at all" and "has a *valid* time" are tracked separately.
    const hasTime = !!event.time;
    const eventDate = hasTime ? new Date(event.time) : null;
    const hasValidDate = hasTime && !Number.isNaN(eventDate.getTime());
    if (event.walletLockScreenEnabled) {
        if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
            const multiDay = !!(event.endTime && !Number.isNaN(new Date(event.endTime).getTime()));
            const locObj = { latitude: Number(lat), longitude: Number(lng) };
            if (!multiDay && hasValidDate) locObj.relevantText = humanEventTime(eventDate, event);
            pass.setLocations(locObj);
        }
    }

    // When checked in, show name + greyed-out event name; logoText already says "✓ CHECKED IN"
    pass.primaryFields.push({ key: "attendee", label: showCheckedInStyle ? "CHECKED IN" : "NAME", value: ticket.name });

    const customFields = ticket.customFields || {};
    const cfEntries = Object.entries(customFields);

    const eventEndDate = event.endTime ? new Date(event.endTime) : null;
    const isMultiDay = eventEndDate && !Number.isNaN(eventEndDate.getTime());
    const hasNote = !!cfEntries[0];

    const buildDateLabel = () => {
        if (!isMultiDay) return 'DATE';
        return 'DATES';
    };

    const buildDateValue = (date) => {
        if (!isMultiDay) return date;
        // For multi-day events show a compact range string
        const fmtOpts = { month: 'short', day: 'numeric', timeZone: eventTimeZone(event), hour: 'numeric', minute: '2-digit', hour12: true };
        const startStr = eventDate.toLocaleString('en-US', fmtOpts);
        const endStr = eventEndDate.toLocaleString('en-US', fmtOpts);
        return `${startStr} – ${endStr}`;
    };

    const setRelevantDatesAndExpiry = () => {
        const expiresAt = isMultiDay
            ? new Date(eventEndDate.getTime() + 24 * 60 * 60 * 1000)
            : new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);
        pass.expirationDate = expiresAt;
        if (event.walletLockScreenEnabled) {
            const windowStart = new Date(eventDate.getTime() - 2 * 60 * 60 * 1000);
            const windowEnd = isMultiDay
                ? new Date(eventEndDate.getTime() + 2 * 60 * 60 * 1000)
                : new Date(eventDate.getTime() + 2 * 60 * 60 * 1000);
            pass.setRelevantDates([{ startDate: windowStart, endDate: windowEnd }]);
        }
    };

    // If notes exist, keep date in the header and notes in secondary.
    // If no notes, place date in secondary (so the row isn't empty).
    // Three cases: a valid date (format it and drive relevance/expiry), a
    // present-but-unparseable legacy value (show the raw string, no
    // relevance/expiry), or no date at all (omit the field entirely — the
    // pass simply never auto-expires and carries no relevance window).
    if (hasNote) {
        if (hasValidDate) {
            if (isMultiDay) {
                pass.headerFields.push({ key: "date", label: buildDateLabel(), value: buildDateValue(eventDate) });
            } else {
                pass.headerFields.push({
                    key: "date", label: buildDateLabel(), value: eventDate,
                    dateStyle: "PKDateStyleMedium", timeStyle: "PKDateStyleShort"
                });
            }
            setRelevantDatesAndExpiry();
        } else if (hasTime) {
            pass.headerFields.push({ key: "date", label: "DATE", value: String(event.time) });
        }
        pass.secondaryFields.push({ key: 'cf_0', label: cfEntries[0][0].toUpperCase(), value: String(cfEntries[0][1]) });
    } else {
        if (hasValidDate) {
            if (isMultiDay) {
                pass.secondaryFields.push({ key: "date", label: buildDateLabel(), value: buildDateValue(eventDate) });
            } else {
                pass.secondaryFields.push({
                    key: "date", label: buildDateLabel(), value: eventDate,
                    dateStyle: "PKDateStyleMedium", timeStyle: "PKDateStyleShort"
                });
            }
            setRelevantDatesAndExpiry();
        } else if (hasTime) {
            pass.secondaryFields.push({ key: "date", label: "DATE", value: String(event.time) });
        }
    }

    // Auxiliary row: Location (two lines)
    const { name: locName, address: locAddress } = eventVenue(event);
    // Front: venue name, or just the street portion of the address
    const frontLoc = locName || (locAddress ? locAddress.split(',')[0].trim() : null);
    if (frontLoc) {
        pass.auxiliaryFields.push({ key: "loc", label: "LOCATION", value: frontLoc });
    }

    // Back: remaining custom fields
    cfEntries.slice(1).forEach(([label, value], i) => {
        pass.backFields.push({ key: `cf_back_${i} `, label: label, value: String(value) });
    });

    if (locAddress) {
        pass.backFields.push({
            key: 'venue_address',
            label: locName || 'VENUE ADDRESS',
            value: locAddress
        });
    }

    pass.backFields.push({
        key: 'ticket_id',
        label: 'TICKET ID',
        value: ticket.token
    });

    pass.backFields.push({
        key: 'terms',
        label: 'ENTRY POLICY',
        value: 'This ticket is valid for one-time entry only. Once scanned at the door it cannot be used again.'
    });

    if (event.imageUrl) {
        const imagePath = path.resolve(__dirname, 'public', event.imageUrl.replace(/^\/+/, ''));
        if (fs.existsSync(imagePath)) {
            const [thumb1x, thumb2x, thumb3x] = await Promise.all([
                sharp(imagePath).resize(90, 90, { fit: 'cover' }).png().toBuffer(),
                sharp(imagePath).resize(180, 180, { fit: 'cover' }).png().toBuffer(),
                sharp(imagePath).resize(270, 270, { fit: 'cover' }).png().toBuffer(),
            ]);
            pass.addBuffer('thumbnail.png', thumb1x);
            pass.addBuffer('thumbnail@2x.png', thumb2x);
            pass.addBuffer('thumbnail@3x.png', thumb3x);
        }
    }

    return pass.getAsBuffer();
}

// Validates Apple Wallet prerequisites, returns error string or null
function checkPassPrereqs() {
    const missing = [];
    if (!process.env.PASS_TYPE_ID) missing.push('PASS_TYPE_ID');
    if (!process.env.TEAM_ID) missing.push('TEAM_ID');
    if (missing.length) return `Missing env vars: ${missing.join(', ')} `;

    const certPath = path.resolve(__dirname, 'certs');
    const files = ['wwdr.pem', 'signer.pem', 'signer.key'];
    const missingFiles = files.filter(f => !fs.existsSync(path.join(certPath, f)));
    if (missingFiles.length) return `Missing cert files: ${missingFiles.join(', ')} `;

    const modelPath = path.resolve(__dirname, 'pass-assets.pass');
    if (!fs.existsSync(path.join(modelPath, 'pass.json'))) return 'Pass model missing';

    return null;
}

// API: Generate single Apple Wallet Pass
app.get(['/api/pass/:token', '/api/pass/:token.pkpass'], async (req, res) => {
    const rawToken = req.params.token;
    const token = rawToken.endsWith('.pkpass') ? rawToken.slice(0, -7) : rawToken;
    const ticket = rowToTicket(stmt.tickets.byToken.get(token));
    if (!ticket) return res.status(404).send('Ticket not found');

    const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
    if (!event) return res.status(404).send('Event not found');

    const prereqError = checkPassPrereqs();
    if (prereqError) return res.status(503).send(`Apple Wallet not configured: ${prereqError} `);

    try {
        // Serve from pass cache when content hash matches
        const currentHash = passContentHash(ticket, event);
        const cachePath = path.join(passCacheDir, `${ticket.token}.pkpass`);
        let buffer;
        try {
            if (fs.existsSync(cachePath) && fs.existsSync(cachePath + '.meta')) {
                const meta = JSON.parse(fs.readFileSync(cachePath + '.meta', 'utf8'));
                if (meta.hash === currentHash) buffer = fs.readFileSync(cachePath);
            }
        } catch (_) {}

        if (!buffer) {
            log('wallet-download', `[ticket] Generating pass — name: ${ticket.name}  token: ${ticket.token}`);
            buffer = await generatePassBuffer(ticket, event);
            log('wallet-download', `[pass] Buffer ${buffer.length} bytes — token: ${ticket.token}`);
            try {
                fs.writeFileSync(cachePath, buffer);
                fs.writeFileSync(cachePath + '.meta', JSON.stringify({ hash: currentHash }));
            } catch (_) {}
        }

        if (!ticket.wallet_downloaded_at) {
            stmt.tickets.setWalletDownloaded.run(new Date().toISOString(), token);
        }

        res.set('Content-Type', 'application/vnd.apple.pkpass');
        res.set('Content-Disposition', `attachment; filename = "ticket-${ticket.token}.pkpass"`);
        res.set('Content-Length', buffer.length);
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.send(buffer);
    } catch (err) {
        console.error('Error generating pass:', err);
        res.status(500).send('Error generating Apple Wallet Pass');
    }
});

// API: Bundle all passes for a registration into one .pkpassbundle
app.get('/api/passes/bundle/:registrationId', async (req, res) => {
    const { registrationId } = req.params;
    const tickets = stmt.tickets.byRegistrationId.all(registrationId).map(rowToTicket);
    if (!tickets.length) return res.status(404).send('No tickets found for this registration');

    if (tickets.length === 1) {
        return res.redirect(`/api/pass/${tickets[0].token}`);
    }

    const prereqError = checkPassPrereqs();
    if (prereqError) return res.status(503).send(`Apple Wallet not configured: ${prereqError} `);

    const event = rowToEvent(stmt.events.byId.get(tickets[0].eventId));
    if (!event) return res.status(404).send('Event not found');

    try {
        console.log(`[pass] Generating bundle of ${tickets.length} passes for registration ${registrationId}`);
        const zip = new JSZip();

        for (const ticket of tickets) {
            const passBuffer = await generatePassBuffer(ticket, event);
            zip.file(`ticket - ${ticket.token}.pkpass`, passBuffer);
        }

        const bundleBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
        res.set('Content-Type', 'application/vnd.apple.pkpasses');
        res.set('Content-Disposition', `attachment; filename = "tickets-${registrationId}.pkpassbundle"`);
        res.set('Content-Length', bundleBuffer.length);
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.send(bundleBuffer);
    } catch (err) {
        console.error('Error generating pass bundle:', err);
        res.status(500).send('Error generating Apple Wallet pass bundle');
    }
});

// ============================================================
//  APPLE WALLET PUSH UPDATE — PassKit Web Service Protocol
//  https://developer.apple.com/documentation/walletpasses/adding_a_web_service_to_update_passes
// ============================================================

// Helper: verify ApplePass auth token and return ticket
function walletAuth(req, serialNumber) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^ApplePass\s+/i, '').trim();
    const ticket = rowToTicket(stmt.tickets.byToken.get(serialNumber));
    if (!ticket) return null;
    if (ticket.id + ticket.token !== token) return null;
    return ticket;
}

// Register a device to receive push updates for a pass
app.post('/api/wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    const { deviceId, serialNumber } = req.params;
    const ticket = walletAuth(req, serialNumber);
    if (!ticket) return res.status(401).send();

    const { pushToken } = req.body;
    if (!pushToken) return res.status(400).send();

    const existing = stmt.walletDevices.byDeviceAndSerial.get(deviceId, serialNumber);
    if (existing) {
        if (existing.pushToken !== pushToken) {
            stmt.walletDevices.setPushToken.run(pushToken, deviceId, serialNumber);
        }
        return res.status(200).send();
    }

    stmt.walletDevices.insert.run(nanoid(8), deviceId, req.params.passTypeId, serialNumber, pushToken, new Date().toISOString());
    log('wallet-register', `[push] Device registered — serial: ${serialNumber.slice(0, 8)}…  device: ${deviceId.slice(0, 8)}…`);
    res.status(201).send();
});

// Unregister a device
app.delete('/api/wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    const { deviceId, serialNumber } = req.params;
    const ticket = walletAuth(req, serialNumber);
    if (!ticket) return res.status(401).send();

    stmt.walletDevices.delete.run(deviceId, serialNumber);
    log('wallet-register', `[push] Device unregistered — serial: ${serialNumber.slice(0, 8)}…`);
    res.status(200).send();
});

// List passes updated since a given date for a device
app.get('/api/wallet/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
    const { deviceId } = req.params;
    const deviceEntries = stmt.walletDevices.byDeviceId.all(deviceId);
    if (!deviceEntries.length) {
        log('wallet-list', `[list] Device not found — device: ${deviceId.slice(0, 8)}…`);
        return res.status(404).send();
    }

    let serialNumbers = deviceEntries.map(d => d.serialNumber);

    const since = req.query.passesUpdatedSince;
    if (since) {
        const sinceDate = new Date(since);
        serialNumbers = serialNumbers.filter(sn => {
            const t = stmt.tickets.byToken.get(sn);
            return t && new Date(t.updated_at || t.created_at) > sinceDate;
        });
    }

    if (!serialNumbers.length) {
        log('wallet-list', `[list] No updates — device: ${deviceId.slice(0, 8)}…  since: ${since || 'never'}`);
        return res.status(204).send();
    }
    log('wallet-list', `[list] ${serialNumbers.length} updated — device: ${deviceId.slice(0, 8)}…  serials: ${serialNumbers.map(s => s.slice(0, 8)).join(', ')}`);
    res.json({ serialNumbers, lastUpdated: new Date().toISOString() });
});

// Return the latest version of a pass
app.get('/api/wallet/v1/passes/:passTypeId/:serialNumber', async (req, res) => {
    const { serialNumber } = req.params;
    const ticket = walletAuth(req, serialNumber);
    if (!ticket) {
        log('wallet-pass', `[auth] Auth failed — serial: ${serialNumber.slice(0, 8)}…`);
        return res.status(401).send();
    }

    const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
    if (!event) return res.status(404).send();

    const prereqError = checkPassPrereqs();
    if (prereqError) return res.status(503).send();

    const ims = req.headers['if-modified-since'];
    if (ims) {
        const lastMod = new Date(ticket.updated_at || ticket.created_at);
        if (lastMod <= new Date(ims)) {
            log('wallet-pass', `[skip] Not modified — serial: ${serialNumber.slice(0, 8)}…`);
            return res.status(304).send();
        }
    }

    try {
        // Serve from pass cache when available and hash matches
        const currentHash = passContentHash(ticket, event);
        const cachePath = path.join(passCacheDir, `${ticket.token}.pkpass`);
        let buffer;
        try {
            if (fs.existsSync(cachePath) && fs.existsSync(cachePath + '.meta')) {
                const meta = JSON.parse(fs.readFileSync(cachePath + '.meta', 'utf8'));
                if (meta.hash === currentHash) buffer = fs.readFileSync(cachePath);
            }
        } catch (_) {}

        if (!buffer) {
            buffer = await generatePassBuffer(ticket, event);
            try {
                fs.writeFileSync(cachePath, buffer);
                fs.writeFileSync(cachePath + '.meta', JSON.stringify({ hash: currentHash }));
            } catch (_) {}
        }

        const lastMod = new Date(ticket.updated_at || ticket.created_at);
        res.set('Content-Type', 'application/vnd.apple.pkpass');
        res.set('Last-Modified', lastMod.toUTCString());
        res.set('Cache-Control', 'no-store');
        log('wallet-pass', `[pass] Serving updated pass — serial: ${serialNumber.slice(0, 8)}…  name: ${ticket.name}`);
        res.send(buffer);
    } catch (err) {
        log('wallet-pass', `[ERR] Generate failed — serial: ${serialNumber.slice(0, 8)}…  err: ${err.message}`);
        res.status(500).send();
    }
});

// Receive device error logs
app.post('/api/wallet/v1/log', (req, res) => {
    const { logs } = req.body || {};
    if (Array.isArray(logs)) logs.forEach(l => log('wallet-device', `[device] ${l}`));
    res.status(200).send();
});

// ============================================================
//  SHEET LINKING — allows Google Sheet users to link a sheet
//  to their website account so events appear in their dashboard
// ============================================================

// Generate a sharing link for a Google Sheet (called from Apps Script)
app.post('/api/sheet/generate-link', async (req, res) => {
    const { spreadsheetId, sheetName, eventId, apiKey } = req.body;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId is required' });

    let link = stmt.sheetLinks.bySpreadsheetId.get(spreadsheetId);
    if (link) {
        // Links created before the apiKey migration have none yet — allow this
        // one bootstrap call through, then require the key on every call after.
        if (link.apiKey && link.apiKey !== apiKey) {
            return res.status(401).json({ error: 'Invalid or missing apiKey for this room' });
        }
        if (!link.apiKey) stmt.sheetLinks.setApiKey.run(nanoid(24), link.id);
        if (eventId || sheetName) {
            stmt.sheetLinks.update.run(eventId || link.eventId, sheetName || link.sheetName, link.id);
        }
        link = stmt.sheetLinks.byId.get(link.id);
        return res.json({ success: true, linkUrl: `${BASE_URL}/link/${link.token}`, token: link.token, apiKey: link.apiKey });
    }

    link = {
        id: nanoid(10),
        token: nanoid(20),
        spreadsheetId,
        sheetName: sheetName || 'Untitled Sheet',
        eventId: eventId || null,
        createdAt: new Date().toISOString(),
        apiKey: nanoid(24),
    };
    stmt.sheetLinks.insert.run(link.id, link.token, link.spreadsheetId, link.sheetName, link.eventId, link.createdAt, link.apiKey);
    res.json({ success: true, linkUrl: `${BASE_URL}/link/${link.token}`, token: link.token, apiKey: link.apiKey });
});

// Redirect /link/:token → link.html?token=...
app.get('/link/:token', (req, res) => {
    res.redirect(`/link.html?token=${req.params.token}`);
});

// Get info about a link token (public)
app.get('/api/sheet/link-info/:token', (req, res) => {
    const link = stmt.sheetLinks.byToken.get(req.params.token);
    if (!link) return res.status(404).json({ error: 'Link not found or expired' });

    const event = link.eventId ? rowToEvent(stmt.events.byId.get(link.eventId)) : null;
    let alreadyLinked = false;
    if (req.session.userId) {
        alreadyLinked = !!stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId);
    }
    const accessCount = stmt.sheetAccess.countByLinkId.get(link.id).cnt;

    res.json({
        sheetName: link.sheetName,
        eventName: event ? event.name : null,
        eventId: link.eventId,
        alreadyLinked,
        accessCount
    });
});

// Claim a link — links the sheet to the current user's account
app.post('/api/sheet/claim', requireAuth, async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    const link = stmt.sheetLinks.byToken.get(token);
    if (!link) return res.status(404).json({ error: 'Link not found' });

    const existing = stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId);
    if (existing) return res.json({ success: true, message: 'Already linked' });

    // If the room's event still belongs to the shared fallback account (nobody
    // has claimed it yet), transfer real ownership to the claiming user instead
    // of only granting view access — this is what makes "different people,
    // their own rooms" true per-account isolation rather than everyone's sheet
    // events secretly belonging to one shared account.
    const fallbackEmail = process.env.SHEET_USER_EMAIL;
    const fallbackOwner = fallbackEmail ? rowToUser(stmt.users.byEmail.get(fallbackEmail)) : null;
    const fallbackUserId = fallbackOwner ? fallbackOwner.id : 'sheet';

    const event = link.eventId ? rowToEvent(stmt.events.byId.get(link.eventId)) : null;
    if (event && event.userId === fallbackUserId && event.userId !== req.session.userId) {
        stmt.events.setOwner.run(req.session.userId, event.id);
        log('sheet-claim', `[claim] Ownership transferred — event: ${event.name}  to: ${req.session.userId}`);
        return res.json({ success: true, message: 'Room claimed — it now belongs to your account!', ownershipTransferred: true });
    }

    stmt.sheetAccess.insert.run(nanoid(10), req.session.userId, link.id, new Date().toISOString(), 'view');
    res.json({ success: true, message: 'Sheet linked to your account!' });
});

// Allow account creation during claim flow (since signup is normally disabled)
app.post('/api/auth/signup-for-link', async (req, res) => {
    const { email, password, token } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (!token) return res.status(400).json({ error: 'link token required' });

    const link = stmt.sheetLinks.byToken.get(token);
    if (!link) return res.status(400).json({ error: 'Invalid link token' });

    const existing = rowToUser(stmt.users.byEmail.get(email.toLowerCase()));
    if (existing) return res.status(400).json({ error: 'An account with this email already exists. Please log in instead.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: nanoid(), email: email.toLowerCase(), password: hashedPassword };
    stmt.users.insert.run(newUser.id, newUser.email, newUser.password, 0, null, new Date().toISOString());
    req.session.userId = newUser.id;
    res.json({ success: true, user: { id: newUser.id, email: newUser.email } });
});

// My Rooms — get all rooms/events the current user has access to
// Rooms shared with this user. Same scoping rule as /api/events: the admin
// sees the rooms they were actually given, not every room on the instance.
app.get('/api/my-rooms', requireAuth, (req, res) => {
    const rooms = stmt.sheetAccess.byUserId.all(req.session.userId).map(access => {
        const link = stmt.sheetLinks.byId.get(access.sheetLinkId);
        if (!link) return null;
        const event = link.eventId ? rowToEvent(stmt.events.byId.get(link.eventId)) : null;
        if (!event) return null;
        const owner = rowToUser(stmt.users.byId.get(event.userId));
        return {
            event,
            sheetLink: link,
            accessId: access.id,
            claimedAt: access.claimedAt,
            owner: { userId: event.userId, email: owner ? owner.email : 'Unknown' },
            capabilities: capabilitiesForAccessRow(access),
            role: roleForCapabilities(capabilitiesForAccessRow(access)),
        };
    }).filter(Boolean);

    res.json(rooms);
});

// Get access entries for a specific event (for settings cog in dashboard).
// Always includes the owner as the first row so it's obvious who the event
// belongs to — theirs is the one grant nobody can edit or revoke.
app.get('/api/event/:id/access', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'manage_access')) {
        return res.status(403).json({ error: 'You do not have permission to manage access for this event' });
    }

    const owner = rowToUser(stmt.users.byId.get(event.userId));
    const ownerEntry = {
        id: null,
        userId: event.userId,
        email: owner ? owner.email : 'Unknown',
        claimedAt: event.createdAt || null,
        role: 'owner',
        capabilities: CAPABILITY_KEYS.slice(),
        isOwner: true,
        isSelf: event.userId === req.session.userId,
        grantedByEmail: null,
    };

    const link = stmt.sheetLinks.byEventId.get(req.params.id);
    const shared = link
        ? stmt.sheetAccess.byLinkId.all(link.id)
            // The owner can also hold a stale share row on their own event;
            // showing it twice would just be confusing.
            .filter(a => a.userId !== event.userId)
            .map(a => {
                const u = rowToUser(stmt.users.byId.get(a.userId));
                const grantedBy = a.grantedBy ? rowToUser(stmt.users.byId.get(a.grantedBy)) : null;
                const capabilities = capabilitiesForAccessRow(a);
                return {
                    id: a.id,
                    userId: a.userId,
                    email: u ? u.email : 'Unknown',
                    claimedAt: a.claimedAt,
                    role: roleForCapabilities(capabilities),
                    capabilities,
                    isOwner: false,
                    isSelf: a.userId === req.session.userId,
                    grantedByEmail: grantedBy ? grantedBy.email : null,
                };
            })
        : [];

    res.json({
        access: [ownerEntry, ...shared],
        owner: { userId: event.userId, email: ownerEntry.email },
        linkUrl: link ? BASE_URL + '/link/' + link.token : null,
        capabilityCatalog: CAPABILITIES,
        rolePresets: ROLE_CAPABILITIES,
        // Only a real owner (or the admin) may delegate the power to hand out
        // access, so the UI can grey that checkbox out for everyone else.
        canGrantManageAccess: userOwnsEvent(req.session.userId, event.id),
        // Same test — handing the event to someone else is an owner-only act.
        canTransferOwnership: userOwnsEvent(req.session.userId, event.id),
    });
});

// True when the session user may manage this event: admin, owner, or a
// sheet-share grant with 'full' permission (same rule used across settings).
// Authorization for scanner actions (/api/validate, /api/checkout) — these
// intentionally support no-login door staff via scan links, so they can't
// use requireAuth. But they must still prove ONE of: a logged-in session, a
// real scan-link token that exists in the DB for this exact event, or a
// real display token for this exact event. Without this, any client that
// merely presents a plausible-looking ticket token can check someone in —
// which is exactly what let a stale cached scanner.html page (with no live
// session and no scan-link) keep scanning.
function scannerAuthorized(req, eventId) {
    // Having *an* account was treated as proof for *every* event, so any
    // signed-in user could check in (or check out) an attendee at an event
    // they have nothing to do with. A session only counts when it actually
    // carries check-in rights here.
    if (req.session?.userId) return userHasEventCapability(req.session.userId, eventId, 'checkin');
    // A scan link opened in this session counts as proof for that one event,
    // the same as passing its token in the body.
    const scoped = sessionScanLink(req);
    if (scoped && scoped.eventId === eventId) return true;
    const linkToken = req.body?.scanLinkToken;
    if (linkToken) {
        const link = stmt.scannerLinks.byToken.get(linkToken);
        if (link && link.eventId === eventId) return true;
    }
    const dToken = req.body?.displayToken;
    if (dToken) {
        const event = rowToEvent(stmt.events.byId.get(eventId));
        if (event?.displayToken && event.displayToken === dToken) return true;
    }
    return false;
}

function canManageEvent(req, eventId) {
    if (!req.session.userId) return false;
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return false;
    if (isAdmin || event.userId === req.session.userId) return true;
    const link = stmt.sheetLinks.byEventId.get(eventId);
    if (!link) return false;
    const access = stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId);
    return !!(access && access.permission === 'full');
}

// Returns the event's integration apiKey, minting the backing sheetLink
// row if the event has never had one.
function ensureEventApiKey(eventId) {
    let link = stmt.sheetLinks.byEventId.get(eventId);
    if (!link) {
        link = {
            id: nanoid(10),
            token: nanoid(20),
            spreadsheetId: null,
            sheetName: 'API Access',
            eventId,
            createdAt: new Date().toISOString(),
            apiKey: nanoid(24),
        };
        stmt.sheetLinks.insert.run(link.id, link.token, link.spreadsheetId, link.sheetName, link.eventId, link.createdAt, link.apiKey);
        return link.apiKey;
    }
    if (!link.apiKey) {
        const apiKey = nanoid(24);
        stmt.sheetLinks.setApiKey.run(apiKey, link.id);
        return apiKey;
    }
    return link.apiKey;
}

// Get (or mint) the apiKey for an event, for use with /api/register-bulk from
// external integrations like a Google Form Apps Script trigger.
app.get('/api/event/:id/api-key', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!canManageEvent(req, req.params.id)) return res.status(403).json({ error: 'Admin access required' });
    res.json({ eventId: event.id, apiKey: ensureEventApiKey(event.id) });
});

// ============================================================
//  SHEET WATCHER — the server polls a link-shared Google Sheet
//  (a form's response sheet) and issues tickets for new rows
//  whose trigger column has the configured option checked.
//  The no-code alternative to the Apps Script snippet.
// ============================================================

// Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, newlines in cells).
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            rows.push(row); row = [];
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
}

// Normalises any pasted Google Sheets link into a CSV export URL.
// Handles regular /d/<id> share links (with optional #gid=), already-
// published /d/e/…/pub links, and passes through any other direct URL.
function sheetCsvUrl(shareUrl) {
    if (!/^https?:\/\//i.test(shareUrl)) return null;
    if (shareUrl.includes('/spreadsheets/d/e/')) {
        if (shareUrl.includes('output=csv')) return shareUrl;
        return shareUrl + (shareUrl.includes('?') ? '&' : '?') + 'output=csv';
    }
    const m = shareUrl.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (m) {
        const gid = (shareUrl.match(/[#?&]gid=(\d+)/) || [])[1] || '0';
        return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
    }
    return shareUrl;
}

async function fetchSheetRows(csvUrl) {
    let resp;
    try {
        resp = await fetch(csvUrl, { redirect: 'follow' });
    } catch (err) {
        throw new Error(`Could not reach the sheet: ${err.message}`);
    }
    if (!resp.ok) throw new Error(`Sheet fetch failed (HTTP ${resp.status}) — is the sheet shared as "Anyone with the link"?`);
    const text = await resp.text();
    if (/^\s*</.test(text)) throw new Error('Google returned a sign-in page instead of the sheet. Share it as "Anyone with the link — Viewer" and try again.');
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('The sheet appears to be empty.');
    return { headers: rows[0].map(h => String(h).trim()), rows: rows.slice(1) };
}

function watcherConfig(w) {
    try { return JSON.parse(w.config) || {}; } catch { return {}; }
}

const CONDITION_OPERATORS = new Set([
    'equals', 'notEquals', 'contains', 'notContains',
    'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual',
    'isEmpty', 'isNotEmpty',
]);

function cellMatchesCondition(cell, operator, targetValue) {
    const value = String(cell || '').trim();
    const target = String(targetValue || '').trim();
    switch (operator) {
        case 'equals': return value.toLowerCase() === target.toLowerCase();
        case 'notEquals': return value.toLowerCase() !== target.toLowerCase();
        case 'contains': return value.toLowerCase().includes(target.toLowerCase());
        case 'notContains': return !value.toLowerCase().includes(target.toLowerCase());
        case 'greaterThan': return parseFloat(value) > parseFloat(target);
        case 'lessThan': return parseFloat(value) < parseFloat(target);
        case 'greaterOrEqual': return parseFloat(value) >= parseFloat(target);
        case 'lessOrEqual': return parseFloat(value) <= parseFloat(target);
        case 'isEmpty': return value === '';
        case 'isNotEmpty': return value !== '';
        default: return false;
    }
}

// Evaluates a flat left-to-right chain of conditions — each condition's
// `join` ('AND'/'OR', absent on the first) combines it with the running
// result so far, the same way you'd read a row of spreadsheet formula
// terms. No parentheses/precedence — that's more control than a no-code
// trigger builder needs, and keeps the UI a straight list of rows.
function evaluateConditions(conditions, headers, row) {
    if (!Array.isArray(conditions) || !conditions.length) return false;
    let result = null;
    for (const cond of conditions) {
        const idx = headers.indexOf(cond.column);
        const cell = idx >= 0 ? row[idx] : '';
        const matched = cellMatchesCondition(cell, cond.operator, cond.value);
        result = result === null ? matched : (cond.join === 'OR' ? (result || matched) : (result && matched));
    }
    return !!result;
}

// Configs saved before the condition builder existed only have a single
// triggerColumn/triggerValue/matchMode — translate them into an equivalent
// one-condition list so old watchers keep working without a re-save.
function watcherConditions(cfg) {
    if (Array.isArray(cfg.conditions) && cfg.conditions.length) return cfg.conditions;
    if (cfg.triggerColumn) {
        return [{ column: cfg.triggerColumn, operator: 'contains', value: cfg.triggerValue }];
    }
    return [];
}

// ── Grouped condition model (the current format) ─────────────────────────────
// A node is either a leaf {column, operator, value} or a group
// {match:'all'|'any', children:[node,…]}. Groups nest arbitrarily, so the
// UI can express (A AND B) OR C and A AND (B OR C) unambiguously — no
// operator precedence to reason about, unlike the old flat left-to-right list.
function evaluateNode(node, headers, row) {
    if (!node) return false;
    if (Array.isArray(node.children)) {
        const kids = node.children;
        if (!kids.length) return false;
        return node.match === 'any'
            ? kids.some(k => evaluateNode(k, headers, row))
            : kids.every(k => evaluateNode(k, headers, row));
    }
    const idx = headers.indexOf(node.column);
    const cell = idx >= 0 ? row[idx] : '';
    return cellMatchesCondition(cell, node.operator, node.value);
}

// Unified "does this row trigger?" — prefers the grouped tree, falls back to
// the old flat list / legacy single-trigger config for watchers saved before
// the group model existed.
function watcherMatches(cfg, headers, row) {
    if (cfg.conditionGroup && Array.isArray(cfg.conditionGroup.children)) {
        return evaluateNode(cfg.conditionGroup, headers, row);
    }
    return evaluateConditions(watcherConditions(cfg), headers, row);
}

// Every column a tree references, so poll-time validation can confirm the
// sheet still has them and back-fill can key off the right cells.
function groupColumns(node, out = []) {
    if (!node) return out;
    if (Array.isArray(node.children)) node.children.forEach(k => groupColumns(k, out));
    else if (node.column) out.push(node.column);
    return out;
}

// Validate/clean an incoming tree from the dashboard: enforce the operator
// whitelist, cap nesting depth and total node count (a runaway payload guard),
// and drop leaves with no column. Returns null if nothing usable survives.
function sanitizeGroup(node, depth = 0, budget = { nodes: 0 }) {
    if (!node || depth > 4 || budget.nodes > 100) return null;
    budget.nodes++;
    if (Array.isArray(node.children)) {
        const children = node.children
            .map(k => sanitizeGroup(k, depth + 1, budget))
            .filter(Boolean);
        if (!children.length) return null;
        return { match: node.match === 'any' ? 'any' : 'all', children };
    }
    const column = String(node.column || '').trim();
    if (!column) return null;
    return {
        column,
        operator: CONDITION_OPERATORS.has(node.operator) ? node.operator : 'contains',
        value: String(node.value || '').trim(),
    };
}

// A row's dedupe key: normally form timestamp + email, so editing other
// columns (e.g. a leader's follow-up notes) never re-triggers a row, and a
// second submission by the same person (new timestamp) counts as a new row.
// When cfg.oneTicketPerEmail is set, the key is just the email — any repeat
// submission by the same address is treated as already seen.
function watcherRowKey(row, rowIndex, tsIdx, email, cfg) {
    if (cfg?.oneTicketPerEmail) return email.toLowerCase();
    return `${tsIdx >= 0 ? String(row[tsIdx]).trim() : 'row' + rowIndex}|${email.toLowerCase()}`;
}

async function pollSheetWatcher(watcher) {
    const cfg = watcherConfig(watcher);
    const conditionCols = cfg.conditionGroup ? groupColumns(cfg.conditionGroup) : watcherConditions(cfg).map(c => c.column);
    const summary = { matched: 0, issued: 0, alreadySeen: 0, failed: 0 };
    let lastError = null;
    try {
        const { headers, rows } = await fetchSheetRows(watcher.csvUrl);
        const need = (name, label) => {
            const i = headers.indexOf(name);
            if (i === -1) throw new Error(`${label} column "${name}" not found — did the sheet's headers change?`);
            return i;
        };
        if (!conditionCols.length) throw new Error('No trigger conditions configured');
        conditionCols.forEach(c => need(c, 'Condition'));
        const firstIdx = need(cfg.firstNameColumn, 'First-name');
        const emailIdx = need(cfg.emailColumn, 'Email');
        const lastIdx = cfg.lastNameColumn ? headers.indexOf(cfg.lastNameColumn) : -1;
        const tsIdx = headers.findIndex(h => h.toLowerCase().includes('timestamp'));
        const apiKey = ensureEventApiKey(watcher.eventId);

        for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            if (!watcherMatches(cfg, headers, row)) continue;
            summary.matched++;

            const email = String(row[emailIdx] || '').trim();
            if (!email.includes('@')) { summary.failed++; lastError = `Row ${r + 2}: missing or invalid email`; continue; }
            const key = watcherRowKey(row, r, tsIdx, email, cfg);
            if (stmt.sheetWatcherSeen.exists.get(watcher.id, key)) { summary.alreadySeen++; continue; }

            let firstName = String(row[firstIdx] || '').trim();
            let lastName = lastIdx >= 0 ? String(row[lastIdx] || '').trim() : '';
            if (!lastName && firstName.includes(' ')) {
                const parts = firstName.split(/\s+/);
                firstName = parts.shift();
                lastName = parts.join(' ');
            }
            if (!firstName) { summary.failed++; lastError = `Row ${r + 2}: missing first name`; continue; }

            // Copy selected columns onto the ticket, renaming to the custom
            // label the organizer chose (form-question headers are often long
            // and ugly — "What size shirt? (S/M/L)" → "Shirt Size").
            const customFields = {};
            (cfg.extraColumns || []).forEach(name => {
                const i = headers.indexOf(name);
                if (i >= 0 && String(row[i] || '').trim()) {
                    const label = (cfg.extraColumnLabels && cfg.extraColumnLabels[name]) || name;
                    customFields[label] = String(row[i]).trim();
                }
            });

            // Ticket count: fixed by default, or pulled per-row from a column
            // (e.g. a "How many guests?" answer). Strip non-digits so "+3" or
            // "3 people" still parse; cap so a typo can't issue hundreds. In
            // column mode an empty/unparseable cell means 1 (they're coming,
            // they just didn't say how many).
            let ticketCount = cfg.ticketCountColumn ? 1 : (cfg.ticketCount || 1);
            if (cfg.ticketCountColumn) {
                const tci = headers.indexOf(cfg.ticketCountColumn);
                if (tci >= 0) {
                    const parsed = parseInt(String(row[tci] || '').replace(/[^0-9]/g, ''), 10);
                    if (Number.isFinite(parsed) && parsed > 0) ticketCount = Math.min(parsed, 50);
                }
            }

            // Issue through the real register-bulk route so capacity checks,
            // audit logging, and the ticket email all stay on one code path.
            const resp = await fetch(`http://127.0.0.1:${PORT}/api/register-bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName,
                    lastName: lastName || '(none)',
                    email,
                    eventId: watcher.eventId,
                    ticketCount,
                    apiKey,
                    customFields,
                    sendEmail: cfg.sendEmail !== false,
                }),
            });
            if (resp.ok) {
                stmt.sheetWatcherSeen.insert.run(watcher.id, key, new Date().toISOString());
                stmt.sheetWatchers.incrementIssued.run(1, watcher.id);
                summary.issued++;
                log('sheet-watch', `[issued] ${firstName} ${lastName || ''} <${email}> — event: ${watcher.eventId}`);
            } else {
                // Deliberately NOT marked seen — a transient failure (e.g. at
                // capacity) retries on the next poll instead of losing the row.
                summary.failed++;
                const body = await resp.text().catch(() => '');
                lastError = `Row ${r + 2} (${email}): HTTP ${resp.status} ${body.slice(0, 200)}`;
                log('sheet-watch', `[ERR] ${lastError}`);
            }
        }
    } catch (err) {
        lastError = err.message;
        log('sheet-watch', `[ERR] Poll failed — watcher: ${watcher.id}  ${err.message}`);
    }
    stmt.sheetWatchers.setPollResult.run(new Date().toISOString(), lastError, watcher.id);
    return summary;
}

// Scheduler: wakes every 30s, polls each enabled watcher whose interval has
// elapsed. Cost per poll is one small HTTP GET + a few ms of parsing.
let sheetPollBusy = false;
setInterval(async () => {
    if (sheetPollBusy) return;
    sheetPollBusy = true;
    try {
        const now = Date.now();
        for (const w of stmt.sheetWatchers.allEnabled.all()) {
            const dueMs = (w.intervalMinutes || 2) * 60 * 1000;
            const last = w.lastPolledAt ? new Date(w.lastPolledAt).getTime() : 0;
            if (now - last >= dueMs - 5000) await pollSheetWatcher(w);
        }
    } catch (err) {
        log('sheet-watch', `[ERR] Poll loop: ${err.message}`);
    } finally {
        sheetPollBusy = false;
    }
}, 30 * 1000);

// Fetch the sheet once and return headers + sample rows + auto-suggested
// column mapping, so the dashboard can offer dropdowns instead of typing.
app.post('/api/event/:id/sheet-watch/preview', requireAuth, async (req, res) => {
    if (!canManageEvent(req, req.params.id)) return res.status(403).json({ error: 'Admin access required' });
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url required' });
    const csvUrl = sheetCsvUrl(url);
    if (!csvUrl) return res.status(400).json({ error: "That doesn't look like a link — paste the sheet's URL from your browser's address bar" });
    try {
        const { headers, rows } = await fetchSheetRows(csvUrl);
        const lower = headers.map(h => h.toLowerCase());
        const findH = (...words) => {
            const i = lower.findIndex(h => words.some(w => h.includes(w)));
            return i === -1 ? null : headers[i];
        };
        res.json({
            headers,
            sampleRows: rows.slice(0, 10),
            rowCount: rows.length,
            suggested: {
                conditionColumn: findH('check any', 'apply', 'interest'),
                firstNameColumn: findH('first name') || findH('name'),
                lastNameColumn: findH('last name'),
                emailColumn: findH('email'),
            },
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/event/:id/sheet-watch', requireAuth, (req, res) => {
    if (!canManageEvent(req, req.params.id)) return res.status(403).json({ error: 'Admin access required' });
    const w = stmt.sheetWatchers.byEventId.get(req.params.id);
    if (!w) return res.json({ watcher: null });
    res.json({ watcher: { ...w, config: watcherConfig(w), seenCount: stmt.sheetWatcherSeen.countByWatcherId.get(w.id).cnt } });
});

// Create or update the event's watcher.
app.post('/api/event/:id/sheet-watch', requireAuth, async (req, res) => {
    if (!canManageEvent(req, req.params.id)) return res.status(403).json({ error: 'Admin access required' });
    const { url, conditionGroup, conditions, firstNameColumn, lastNameColumn, emailColumn, extraColumns, extraColumnLabels, ticketCountColumn, intervalMinutes, ticketCount, includeExisting, oneTicketPerEmail } = req.body || {};
    // New grouped format (preferred); fall back to the old flat list if a
    // client still sends it.
    const cleanGroup = conditionGroup ? sanitizeGroup(conditionGroup) : null;
    const cleanConditions = Array.isArray(conditions)
        ? conditions
            .map((c, i) => ({
                column: String(c?.column || '').trim(),
                operator: CONDITION_OPERATORS.has(c?.operator) ? c.operator : 'contains',
                value: String(c?.value || '').trim(),
                ...(i > 0 ? { join: c?.join === 'OR' ? 'OR' : 'AND' } : {}),
            }))
            .filter(c => c.column)
            .slice(0, 10)
        : [];
    const conditionCount = cleanGroup ? groupColumns(cleanGroup).length : cleanConditions.length;
    if (!url || !conditionCount || !firstNameColumn || !emailColumn) {
        return res.status(400).json({ error: 'url, at least one condition, firstNameColumn, and emailColumn are required' });
    }
    const cleanUrl = String(url).trim();
    const csvUrl = sheetCsvUrl(cleanUrl);
    if (!csvUrl) return res.status(400).json({ error: "That doesn't look like a valid sheet link" });
    const interval = Math.min(15, Math.max(1, parseInt(intervalMinutes, 10) || 2));
    const cleanExtraColumns = Array.isArray(extraColumns) ? extraColumns.slice(0, 20) : [];
    // Keep only labels for columns that are actually selected, and only when
    // the label differs from the raw header (no point storing a no-op rename).
    const cleanLabels = {};
    if (extraColumnLabels && typeof extraColumnLabels === 'object') {
        cleanExtraColumns.forEach(col => {
            const lbl = String(extraColumnLabels[col] || '').trim().slice(0, 60);
            if (lbl && lbl !== col) cleanLabels[col] = lbl;
        });
    }
    const configObj = {
        firstNameColumn,
        lastNameColumn: lastNameColumn || null,
        emailColumn,
        extraColumns: cleanExtraColumns,
        extraColumnLabels: cleanLabels,
        ticketCountColumn: ticketCountColumn ? String(ticketCountColumn) : null,
        ticketCount: Math.min(10, Math.max(1, parseInt(ticketCount, 10) || 1)),
        oneTicketPerEmail: !!oneTicketPerEmail,
    };
    if (cleanGroup) configObj.conditionGroup = cleanGroup;
    else configObj.conditions = cleanConditions;
    const config = JSON.stringify(configObj);

    let watcher = stmt.sheetWatchers.byEventId.get(req.params.id);
    const isNew = !watcher;
    if (watcher) {
        stmt.sheetWatchers.updateConfig.run(cleanUrl, csvUrl, config, interval, watcher.id);
    } else {
        stmt.sheetWatchers.insert.run(nanoid(10), req.params.id, cleanUrl, csvUrl, config, interval, 1, new Date().toISOString());
    }
    watcher = stmt.sheetWatchers.byEventId.get(req.params.id);

    // On first connect, unless the user asked to back-fill existing rows,
    // mark every currently-matching row as seen so only rows submitted
    // from now on get tickets.
    if (isNew && !includeExisting) {
        try {
            const cfg = watcherConfig(watcher);
            const { headers, rows } = await fetchSheetRows(csvUrl);
            const emailIdx = headers.indexOf(cfg.emailColumn);
            const tsIdx = headers.findIndex(h => h.toLowerCase().includes('timestamp'));
            rows.forEach((row, r) => {
                if (!watcherMatches(cfg, headers, row)) return;
                const email = String(row[emailIdx] || '').trim();
                stmt.sheetWatcherSeen.insert.run(watcher.id, watcherRowKey(row, r, tsIdx, email, cfg), new Date().toISOString());
            });
        } catch { /* the first scheduled poll will surface any fetch error */ }
    }

    logAudit(req, { eventId: req.params.id, action: isNew ? 'sheet_watch.connected' : 'sheet_watch.updated', details: { url: cleanUrl, conditionCount, intervalMinutes: interval } });
    res.json({ success: true, watcher: { ...watcher, config: watcherConfig(watcher) } });
});

// Manual "Check now".
app.post('/api/event/:id/sheet-watch/poll', requireAuth, async (req, res) => {
    if (!canManageEvent(req, req.params.id)) return res.status(403).json({ error: 'Admin access required' });
    const w = stmt.sheetWatchers.byEventId.get(req.params.id);
    if (!w) return res.status(404).json({ error: 'No sheet watcher configured for this event' });
    const summary = await pollSheetWatcher(w);
    const fresh = stmt.sheetWatchers.byEventId.get(req.params.id);
    res.json({ success: true, summary, watcher: { ...fresh, config: watcherConfig(fresh) } });
});

app.post('/api/event/:id/sheet-watch/toggle', requireAuth, (req, res) => {
    if (!canManageEvent(req, req.params.id)) return res.status(403).json({ error: 'Admin access required' });
    const w = stmt.sheetWatchers.byEventId.get(req.params.id);
    if (!w) return res.status(404).json({ error: 'No sheet watcher configured for this event' });
    stmt.sheetWatchers.setEnabled.run(req.body?.enabled ? 1 : 0, w.id);
    logAudit(req, { eventId: req.params.id, action: req.body?.enabled ? 'sheet_watch.resumed' : 'sheet_watch.paused', details: {} });
    res.json({ success: true });
});

app.delete('/api/event/:id/sheet-watch', requireAuth, (req, res) => {
    if (!canManageEvent(req, req.params.id)) return res.status(403).json({ error: 'Admin access required' });
    const w = stmt.sheetWatchers.byEventId.get(req.params.id);
    if (!w) return res.status(404).json({ error: 'No sheet watcher configured for this event' });
    stmt.sheetWatcherSeen.deleteByWatcherId.run(w.id);
    stmt.sheetWatchers.deleteById.run(w.id);
    logAudit(req, { eventId: req.params.id, action: 'sheet_watch.disconnected', details: { url: w.url } });
    res.json({ success: true });
});

// Tear down an event's sharing rows. Deleting an event used to leave these
// behind, so a revoked-by-deletion collaborator kept a grant pointing at an
// event that no longer existed.
function deleteEventSharing(eventId) {
    for (const link of [stmt.sheetLinks.byEventId.get(eventId)].filter(Boolean)) {
        stmt.sheetAccess.deleteByLinkId.run(link.id);
    }
    stmt.sheetLinks.deleteByEventId.run(eventId);
}

// Sharing hangs off a sheetLink, which an event may not have yet (it only
// exists once someone shares or connects a sheet). Create one on demand.
function ensureSheetLink(event) {
    const existing = stmt.sheetLinks.byEventId.get(event.id);
    if (existing) return existing;
    const link = { id: nanoid(10), token: nanoid(20), spreadsheetId: 'manual', sheetName: event.name, eventId: event.id, createdAt: new Date().toISOString(), apiKey: nanoid(24) };
    stmt.sheetLinks.insert.run(link.id, link.token, link.spreadsheetId, link.sheetName, link.eventId, link.createdAt, link.apiKey);
    return link;
}

// Hand an event to another account. Only a real owner (or the admin) can do
// this, since it's the one action that takes control away from the person who
// has it. The outgoing owner keeps a full-capability share rather than being
// locked out of their own event — they can be revoked afterwards like anyone.
app.post('/api/event/:id/transfer-ownership', requireAuth, (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required' });

    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userOwnsEvent(req.session.userId, event.id)) {
        return res.status(403).json({ error: 'Only the event owner can transfer ownership' });
    }

    const target = rowToUser(stmt.users.byEmail.get(String(email).toLowerCase()));
    if (!target) return res.status(404).json({ error: 'User ' + email + ' does not have an account. They must register first.' });
    if (target.id === event.userId) return res.status(400).json({ error: 'That user already owns this event' });

    const previousOwner = rowToUser(stmt.users.byId.get(event.userId));
    const link = ensureSheetLink(event);

    db.transaction(() => {
        stmt.events.setOwner.run(target.id, event.id);
        // The new owner's old share row is now redundant — ownership already
        // grants everything, and leaving it would show them twice.
        const targetShare = stmt.sheetAccess.byLinkAndUser.get(link.id, target.id);
        if (targetShare) stmt.sheetAccess.deleteById.run(targetShare.id);
        // Keep the outgoing owner in the room with full permissions.
        if (previousOwner) {
            const caps = JSON.stringify(ROLE_CAPABILITIES.full);
            const existing = stmt.sheetAccess.byLinkAndUser.get(link.id, previousOwner.id);
            if (existing) stmt.sheetAccess.setGrant.run('full', caps, link.id, previousOwner.id);
            else stmt.sheetAccess.insert.run(nanoid(10), previousOwner.id, link.id, new Date().toISOString(), 'full', caps, req.session.userId);
        }
    })();

    logAudit(req, { eventId: event.id, action: 'event.ownership_transferred', details: { from: previousOwner?.email, to: target.email } });
    log('event-settings', `[owner] Ownership transferred — event: ${event.name}  from: ${previousOwner?.email}  to: ${target.email}  by: ${req.session.userId}`);

    if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        sendEmail({
            to: target.email,
            fromName: `Tickets - ${event.name}`,
            replyTo: REPLY_TO_EMAIL,
            subject: `You now own ${event.name}`,
            html: `
                <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
                    <div style="margin-bottom:24px;"><div style="background:#1a1f3c;display:inline-block;padding:14px 20px;border-radius:12px;"><span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.5px;">WTS Tickets</span></div></div>
                    <h2 style="color:#1a1f3c;margin:0 0 8px;">You've been given ownership</h2>
                    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 12px;"><strong>${previousOwner?.email || 'An administrator'}</strong> transferred ownership of <strong>${event.name}</strong> to you. You now have full control of the event, including who else can access it.</p>
                    <div style="text-align:center;margin:28px 0 8px;">
                        <a href="${BASE_URL}/login.html" style="background:#1a1f3c;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block;">Open the dashboard</a>
                    </div>
                </div>`,
        }).catch(() => {});
    }

    res.json({ success: true, owner: { userId: target.id, email: target.email } });
});

// Resolve what a share request is actually asking for. `capabilities` wins
// when present; otherwise the legacy `permission` role is expanded. Returns
// null when the request names no capability we recognise.
function resolveRequestedGrant({ permission, capabilities }) {
    const explicit = normalizeCapabilities(capabilities);
    if (explicit && explicit.length) return { role: roleForCapabilities(explicit), capabilities: explicit };
    if (permission === 'full' || permission === 'view') {
        const caps = ROLE_CAPABILITIES[permission].slice();
        return { role: permission, capabilities: caps };
    }
    return null;
}

app.post('/api/sheet/share', requireAuth, async (req, res) => {
    const { eventId, email, permission, capabilities } = req.body;
    if (!eventId || !email) return res.status(400).json({ error: 'Missing fields' });

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!userHasEventCapability(req.session.userId, event.id, 'manage_access')) {
        return res.status(403).json({ error: 'Permission denied to share room' });
    }

    const grant = resolveRequestedGrant({ permission, capabilities });
    if (!grant) return res.status(400).json({ error: 'Select at least one permission to grant' });
    // Only a real owner can pass on the right to manage access; a collaborator
    // who merely holds `manage_access` can't mint more people like themselves.
    if (grant.capabilities.includes('manage_access') && !userOwnsEvent(req.session.userId, event.id)) {
        return res.status(403).json({ error: 'Only the event owner can grant permission to manage access' });
    }

    const link = ensureSheetLink(event);

    const targetUser = rowToUser(stmt.users.byEmail.get(email.toLowerCase()));
    if (!targetUser) return res.status(404).json({ error: 'User ' + email + ' does not have an account. They must register first.' });
    if (targetUser.id === req.session.userId) return res.status(400).json({ error: 'Cannot share with yourself' });
    if (targetUser.id === event.userId) return res.status(400).json({ error: 'That user already owns this event' });

    const capsJson = JSON.stringify(grant.capabilities);
    const existingAccess = stmt.sheetAccess.byLinkAndUser.get(link.id, targetUser.id);
    if (existingAccess) {
        stmt.sheetAccess.setGrant.run(grant.role, capsJson, link.id, targetUser.id);
    } else {
        stmt.sheetAccess.insert.run(nanoid(10), targetUser.id, link.id, new Date().toISOString(), grant.role, capsJson, req.session.userId);
    }
    logAudit(req, { eventId: event.id, action: 'access.granted', details: { email: targetUser.email, permission: grant.role, capabilities: grant.capabilities } });

    if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        const permissionLabel = grant.role === 'full' ? 'full' : grant.role === 'view' ? 'view' : 'custom';
        sendEmail({
            to: targetUser.email,
            fromName: `Tickets - ${event.name}`,
            replyTo: REPLY_TO_EMAIL,
            subject: `${user?.email} shared access to ${event.name}`,
            html: `
                <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
                    <div style="margin-bottom:24px;"><div style="background:#1a1f3c;display:inline-block;padding:14px 20px;border-radius:12px;"><span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.5px;">WTS Tickets</span></div></div>
                    <h2 style="color:#1a1f3c;margin:0 0 8px;">You've been given access</h2>
                    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 12px;"><strong>${user?.email}</strong> shared <strong>${permissionLabel}</strong> access to <strong>${event.name}</strong> with you.</p>
                    <p style="color:#64748b;font-size:14px;line-height:1.6;margin:0 0 28px;">Log in to view it.</p>
                    <div style="text-align:center;margin-bottom:8px;">
                        <a href="${BASE_URL}/login.html" style="background:#1a1f3c;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block;">Log In</a>
                    </div>
                </div>`,
        }).catch(() => {});
    }

    res.json({ success: true, message: 'Access granted' });
});

// Change an existing collaborator's permissions without having to revoke and
// re-share them.
app.patch('/api/sheet/access/:id', requireAuth, (req, res) => {
    const access = stmt.sheetAccess.byId.get(req.params.id);
    if (!access) return res.status(404).json({ error: 'Access entry not found' });

    const link = stmt.sheetLinks.byId.get(access.sheetLinkId);
    const event = link && link.eventId ? rowToEvent(stmt.events.byId.get(link.eventId)) : null;
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!userHasEventCapability(req.session.userId, event.id, 'manage_access')) {
        return res.status(403).json({ error: 'You do not have permission to manage access for this event' });
    }
    // Nobody edits their own grant — that's the one way to quietly promote
    // yourself past what the owner gave you.
    if (access.userId === req.session.userId && !userOwnsEvent(req.session.userId, event.id)) {
        return res.status(403).json({ error: 'You cannot change your own permissions' });
    }

    const grant = resolveRequestedGrant(req.body || {});
    if (!grant) return res.status(400).json({ error: 'Select at least one permission to grant' });
    if (grant.capabilities.includes('manage_access') && !userOwnsEvent(req.session.userId, event.id)) {
        return res.status(403).json({ error: 'Only the event owner can grant permission to manage access' });
    }

    stmt.sheetAccess.setGrantById.run(grant.role, JSON.stringify(grant.capabilities), access.id);
    const targetUser = rowToUser(stmt.users.byId.get(access.userId));
    logAudit(req, { eventId: event.id, action: 'access.updated', details: { email: targetUser?.email, permission: grant.role, capabilities: grant.capabilities } });
    res.json({ success: true, role: grant.role, capabilities: grant.capabilities });
});

// Revoke access to a room
app.delete('/api/sheet/access/:id', requireAuth, async (req, res) => {
    const access = stmt.sheetAccess.byId.get(req.params.id);
    if (!access) return res.status(404).json({ error: 'Access entry not found' });

    const link = stmt.sheetLinks.byId.get(access.sheetLinkId);
    const event = link && link.eventId ? rowToEvent(stmt.events.byId.get(link.eventId)) : null;

    // Anyone may hand back their own access; removing someone else needs the
    // permission to manage access on that event.
    const removingSelf = access.userId === req.session.userId;
    if (!removingSelf && !(event && userHasEventCapability(req.session.userId, event.id, 'manage_access'))) {
        return res.status(403).json({ error: 'Not authorized to revoke others' });
    }

    stmt.sheetAccess.deleteById.run(req.params.id);
    const revokedUser = rowToUser(stmt.users.byId.get(access.userId));
    logAudit(req, { eventId: event?.id, action: 'access.revoked', details: { email: revokedUser?.email } });
    res.json({ success: true });
});

// ── 24-hour reminder emails ────────────────────────────────────────────────

function buildReminderHtml(event, customMessage) {
    const hours = event.reminderHoursBefore ?? 24;
    const timeLabel = hours === 24 ? 'tomorrow' : hours < 24 ? `in ${hours} hour${hours !== 1 ? 's' : ''}` : `in ${Math.round(hours / 24)} day${Math.round(hours / 24) !== 1 ? 's' : ''}`;
    const msg = (customMessage || `This is a friendly reminder that ${event.name} is coming up ${timeLabel}. We look forward to seeing you there!`)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    return `
        <div style="margin:0;padding:0;background:#f3f4f6;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
        <tr><td align="center" style="padding:24px 16px;">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr><td style="background:#059669;padding:24px 32px;text-align:center;">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.8);text-transform:uppercase;letter-spacing:1px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Event Reminder</p>
            <h1 style="margin:8px 0 0;font-size:26px;font-weight:800;color:#fff;line-height:1.2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">See you ${timeLabel}!</h1>
          </td></tr>
          <tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <p style="font-size:15px;color:#374151;margin:0 0 20px;line-height:1.6;">Hello,</p>
            <p style="font-size:14px;color:#666;margin:0 0 24px;line-height:1.6;">Your event is coming up ${timeLabel}. Here are the details so you can plan ahead:</p>

            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin:24px 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="padding-bottom:12px;">
                  <p style="font-weight:700;font-size:15px;color:#1a1a2e;margin:0 0 8px;">${event.name}</p>
                </td></tr>
                ${event.time ? `<tr><td style="padding-bottom:8px;">
                  <p style="color:#555;margin:0;font-size:14px;"><span style="font-weight:600;">Date & Time:</span><br>${formatEventDateRange(event)}</p>
                </td></tr>` : ''}
                ${(() => {
                    const venue = eventVenue(event);
                    if (!venue.hasAny) return '';
                    return `<tr><td>
                  <p style="color:#555;margin:0;font-size:14px;"><span style="font-weight:600;">Location:</span><br>${venue.name}${venue.name && venue.address ? '<br>' : ''}${venue.address}</p>
                </td></tr>`;
                })()}
              </table>
            </div>

            <div style="background:#f0f9ff;border-left:4px solid #0284c7;padding:16px;margin:24px 0;border-radius:6px;">
              <p style="color:#0c4a6e;white-space:pre-wrap;margin:0;font-size:14px;line-height:1.6;">${msg}</p>
            </div>

            <p style="font-size:14px;color:#666;margin:0 0 16px;line-height:1.6;"><strong>What you need to bring:</strong> This email contains your ticket. Save it or forward it to your phone so you can check in easily when you arrive.</p>
            <p style="font-size:13px;color:#888;margin:0;">Can't find your original ticket? Reply to this email and we'll send it to you right away.</p>
          </td></tr>
        </table>
        </td></tr>
        </table>
        </div>
    `;
}

// GET reminder settings
app.get('/api/event/:id/reminder', requireAuth, async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    res.json({
        enabled: !!event.reminderEnabled,
        message: event.reminderMessage || '',
        hoursBefore: event.reminderHoursBefore ?? 24,
        sentAt: event.reminderSentAt || null
    });
});

// PUT reminder settings
app.put('/api/event/:id/reminder', requireAuth, async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    const { enabled, message, hoursBefore } = req.body;
    const newHours = Math.max(1, Math.min(168, parseInt(hoursBefore) || 24));
    const resetSentAt = event.reminderSentAt && newHours !== (event.reminderHoursBefore ?? 24) ? null : event.reminderSentAt;
    stmt.events.setReminder.run(!!enabled ? 1 : 0, message || '', newHours, resetSentAt, req.params.id);
    log('reminder', `[config] Settings updated — event: ${event.name}  enabled: ${!!enabled}  by: ${req.session.userId}`);
    res.json({ success: true });
});

// GET reminder email preview
app.get('/api/event/:id/reminder/preview', requireAuth, async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).send('Event not found');
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!userHasEventCapability(req.session.userId, event.id, 'email_attendees')) {
        return res.status(403).send('Not authorized');
    }
    res.type('html').send(buildReminderHtml(event, event.reminderMessage));
});

// Background job: check every 5 minutes for events ~24h away
setInterval(async () => {
    const now = Date.now();

    const due = stmt.events.reminderDue.all().map(rowToEvent).filter(e => {
        if (!e.time) return false; // undated event — nothing to count down to
        const hours = e.reminderHoursBefore ?? 24;
        const eventMs = new Date(e.time).getTime();
        const windowStart = now + (hours - 1) * 60 * 60 * 1000;
        const windowEnd = now + (hours + 1) * 60 * 60 * 1000;
        return eventMs >= windowStart && eventMs <= windowEnd;
    });

    for (const event of due) {
        const tickets = stmt.tickets.byEventId.all(event.id).map(rowToTicket);
        const seen = new Set();
        const registrations = tickets.filter(t => {
            if (seen.has(t.registrationId)) return false;
            seen.add(t.registrationId);
            return true;
        });

        if (!registrations.length) continue;

        const replyTo = REPLY_TO_EMAIL;
        const html = buildReminderHtml(event, event.reminderMessage);
        let sent = 0;

        for (const ticket of registrations) {
            try {
                await sendEmail({
                    to: ticket.email,
                    fromName: `Tickets - ${event.name}`,
                    replyTo,
                    subject: `Reminder: ${event.name} is ${(event.reminderHoursBefore ?? 24) === 24 ? 'tomorrow' : 'coming up soon'}!`,
                    html,
                    registrationId: ticket.registrationId
                });
                sent++;
            } catch (err) {
                log('reminder', `[ERR] Send failed — email: ${ticket.email}  err: ${err.message}`);
            }
        }

        stmt.events.setReminderSentAt.run(new Date().toISOString(), event.id);
        log('reminder', `[email] Sent to ${sent} registrant(s) — event: ${event.name} (${event.id})`);
    }
}, 5 * 60 * 1000);



// ── Door Display / SSE ──────────────────────────────────────────────────────
const displayTokenClients = new Map(); // displayToken → Set<res>  (display screens, event-scoped)
const scannerChannels     = new Map(); // pairToken → res           (scanner's persistent SSE channel)
const scannerRegistry     = new Map(); // pairToken → flat scanner data object
const monitorClients      = new Set(); // { res, eventIds: Set<string> }
const giveawayChannels    = new Map(); // sessionId → res           (giveaway presenter-display SSE channel)

function broadcastToMonitors(eventId, payload) {
    const chunk = `data: ${JSON.stringify(payload)}\n\n`;
    let sent = 0, eligible = 0;
    for (const client of monitorClients) {
        if (client.eventIds.has(eventId)) {
            eligible++;
            try {
                if (client.res.writable && !client.res.socket?.destroyed) {
                    client.res.write(chunk);
                    sent++;
                }
            } catch (_) { }
        }
    }
    log('monitor-broadcast', `[${payload.type}] event=${eventId} sent=${sent}/${eligible} (${monitorClients.size} total clients)`);
}

function getClientIP(req) {
    return (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
}

function upsertScanner(pairToken, patch) {
    const existing = scannerRegistry.get(pairToken) || {};
    const updated = { ...existing, ...patch, pairToken };
    scannerRegistry.set(pairToken, updated);
    // If scanner switched events, notify the old event's monitors so they can remove the stale card
    if (existing.eventId && existing.eventId !== updated.eventId) {
        broadcastToMonitors(existing.eventId, { type: 'scanner_update', scanner: updated });
    }
    if (updated.eventId) broadcastToMonitors(updated.eventId, { type: 'scanner_update', scanner: updated });
    return updated;
}

function recordScan(pairToken, event, status, ticket, allTickets) {
    const scanned = allTickets.filter(t => t.used_at).length;
    const displayPayload = { type: 'scan', status, name: ticket.name, registrationId: ticket.registrationId, total: allTickets.length, scanned };
    if (event?.displayToken) broadcastToDisplayToken(event.displayToken, displayPayload);

    // Broadcast per-ticket update to dashboard / monitor clients so rows update live
    if (event) {
        broadcastToMonitors(event.id, {
            type: 'ticket_scan',
            eventId: event.id,
            pairToken: pairToken || null,
            registrationId: ticket.registrationId,
            status,
            name: ticket.name,
            total: allTickets.length,
            scanned,
            usedAt: ticket.used_at || null,
            reentryStatus: ticket.reentry_status || null,
        });
    }

    if (!pairToken || !event) return;
    upsertScanner(pairToken, {
        eventId: event.id, eventName: event.name, lastSeen: new Date().toISOString(),
        lastResult: { status, name: ticket.name || '', registrationId: ticket.registrationId, total: allTickets.length, scanned }
    });
}

// Send to a specific scanner's SSE channel (for admin notifications)
function broadcastToPair(pairToken, payload) {
    if (!pairToken) return false;
    const ch = scannerChannels.get(pairToken);
    if (!ch) return false;
    // Detect stale sockets (common on Windows where close events don't always fire)
    if (!ch.writable || ch.socket?.destroyed || ch.socket?.readyState === 'closed') {
        scannerChannels.delete(pairToken);
        return false;
    }
    try {
        ch.write(`data: ${JSON.stringify(payload)}\n\n`);
        return true;
    } catch {
        scannerChannels.delete(pairToken);
        return false;
    }
}

// Send to all display screens connected for a given event (by displayToken)
function broadcastToDisplayToken(displayToken, payload) {
    if (!displayToken) return;
    const clients = displayTokenClients.get(displayToken);
    if (!clients || clients.size === 0) return;
    const chunk = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
        try { client.write(chunk); } catch { /* disconnected */ }
    }
}

// Generate or retrieve display token (auth required — only event owner/access)
app.get('/api/display/token/:eventId', requireAuthOrScanLink, async (req, res) => {
    const { eventId } = req.params;
    if (!requestEventCapabilities(req, eventId).length) return res.status(403).json({ error: 'Not authorized' });
    let event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.displayToken) {
        const tok = crypto.randomBytes(24).toString('hex');
        stmt.events.setDisplayToken.run(tok, eventId);
        event = rowToEvent(stmt.events.byId.get(eventId));
    }
    res.json({ token: event.displayToken, url: `${BASE_URL}/display.html?token=${event.displayToken}&fresh=1` });
});

// QR code PNG for the display URL (used by web scanner settings page)
app.get('/api/display/qr/:eventId', requireAuthOrScanLink, async (req, res) => {
    const { eventId } = req.params;
    if (!requestEventCapabilities(req, eventId).length) return res.status(403).json({ error: 'Not authorized' });
    let event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.displayToken) {
        const tok = crypto.randomBytes(24).toString('hex');
        stmt.events.setDisplayToken.run(tok, eventId);
        event = rowToEvent(stmt.events.byId.get(eventId));
    }
    const pair = req.query.pair || '';
    const url = `${BASE_URL}/display.html?token=${event.displayToken}${pair ? `&pair=${encodeURIComponent(pair)}` : ''}&fresh=1`;
    try {
        const png = await QRCode.toBuffer(url, { width: 400, margin: 2 });
        res.set('Content-Type', 'image/png').set('Cache-Control', 'no-cache').send(png);
    } catch (err) {
        res.status(500).json({ error: 'QR generation failed' });
    }
});

// Regenerate display token (invalidates old links)
app.post('/api/display/token/:eventId/rotate', requireAuthOrScanLink, async (req, res) => {
    const { eventId } = req.params;
    if (!requestEventCapabilities(req, eventId).length) return res.status(403).json({ error: 'Not authorized' });
    const tok = crypto.randomBytes(24).toString('hex');
    stmt.events.setDisplayToken.run(tok, eventId);
    res.json({ token: tok, url: `${BASE_URL}/display.html?token=${tok}&fresh=1` });
});

// Event info for display page (public — display token is the auth)
app.get('/api/display/info/:token', (req, res) => {
    const event = rowToEvent(stmt.events.byDisplayToken.get(req.params.token));
    if (!event) return res.status(404).json({ error: 'Not found' });
    const tickets = stmt.tickets.byEventId.all(event.id);
    res.json({
        event: { id: event.id, name: event.name, time: event.time, location: event.location, capacity: event.capacity || null },
        total: tickets.length,
        scanned: tickets.filter(t => t.used_at).length
    });
});

// SSE stream — display token is the auth, pairToken routes to specific scanner
app.get('/api/display/stream/:token', (req, res) => {
    const { token } = req.params;
    if (!token || token.length < 32) return res.status(400).send('Invalid token');
    const event = rowToEvent(stmt.events.byDisplayToken.get(token));
    if (!event) return res.status(404).send('Not found');

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    const tickets = stmt.tickets.byEventId.all(event.id);
    res.write(`data: ${JSON.stringify({
        type: 'init',
        event: { id: event.id, name: event.name, time: event.time, capacity: event.capacity || null },
        total: tickets.length,
        scanned: tickets.filter(t => t.used_at).length
    })}\n\n`);

    if (!displayTokenClients.has(token)) displayTokenClients.set(token, new Set());
    displayTokenClients.get(token).add(res);

    const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        displayTokenClients.get(token)?.delete(res);
    });
});
// ── Scanner Monitor ──────────────────────────────────────────────────────────

app.get('/api/monitor/stream', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const { eventId } = req.query;

    // Naming one event still works for any event the user can reach (the
    // admin included); the unfiltered firehose is scoped to their own rooms.
    let eventIds;
    if (eventId) {
        if (!userHasEventAccess(userId, eventId)) return res.status(403).json({ error: 'Not authorized' });
        eventIds = new Set([eventId]);
    } else {
        eventIds = personalEventIdsForUser(userId);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // 2KB padding chunk forces Cloudflare/nginx to release its buffer immediately
    res.write(`: ${' '.repeat(2048)}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'monitor_connected' })}\n\n`);

    const client = { res, eventIds };
    monitorClients.add(client);

    const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) { clearInterval(keepAlive); }
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        monitorClients.delete(client);
    });
});


// ── Scanner-side notification SSE stream ──────────────────────────────────────
// ── Monitor bootstrap: list all known scanners ─────────────────────────────────
app.get('/api/monitor/scanners', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const userEventIds = personalEventIdsForUser(userId);
    const userEvents = [...userEventIds].map(id => rowToEvent(stmt.events.byId.get(id))).filter(Boolean);

    // Hydrate scannerRegistry; filter to events this user can see
    const scannerList = [...scannerRegistry.values()].filter(s =>
        !s.eventId || userEventIds.has(s.eventId)
    );

    res.json({ scanners: scannerList, events: userEvents });
});

// ── Scanner Heartbeat ────────────────────────────────────────────────────────
// Called by iOS app/web scanner on launch and every 30 s to stay visible in
// the monitor even before any scan has happened.
app.post('/api/scan/heartbeat', async (req, res) => {
    const { pairToken, eventId, platform, deviceName, appVersion, osVersion, pushEnabled, pushToken } = req.body;
    if (!pairToken) return res.status(400).json({ error: 'pairToken required' });

    const ev = eventId ? rowToEvent(stmt.events.byId.get(eventId)) : null;

    const patch = {
        ip: getClientIP(req),
        platform: platform || 'unknown',
        deviceName: deviceName || 'Unknown device',
        appVersion: appVersion || null,
        osVersion: osVersion || null,
        userAgent: req.headers['user-agent'] || null,
        lastSeen: new Date().toISOString(),
        online: scannerChannels.has(pairToken),
        eventId: eventId || null,
        eventName: ev ? ev.name : null,
        // Whether this device has OS notification permission granted — lets
        // admin spot devices that won't get a real push (they'll still get
        // the in-app banner via this SSE channel regardless) and nudge them
        // in person. Undefined (not 'true'/'false') means unknown, e.g. an
        // older app build that doesn't report it yet.
        pushEnabled: pushEnabled === undefined ? undefined : pushEnabled === true || pushEnabled === 'true',
    };
    // Unlike pushEnabled, only set pushToken when this heartbeat actually
    // carries one — a token stays valid across heartbeats, so a build that
    // doesn't report it yet (or a momentary gap before APNs registration
    // finishes) shouldn't wipe out a previously-known good token.
    if (pushToken) patch.pushToken = pushToken;
    upsertScanner(pairToken, patch);

    res.json({ ok: true });
});

// ── Scanner SSE Channel ───────────────────────────────────────────────────────
// Scanner opens this on launch to receive admin notifications and appear as
// "online" immediately — no scan required.
app.get('/api/scan/stream/:pairToken', async (req, res) => {
    const { pairToken } = req.params;
    const { eventId, platform, deviceName, appVersion, osVersion } = req.query;
    if (!pairToken) return res.status(400).send('pairToken required');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`: ${' '.repeat(2048)}\n\n`);

    const ev = eventId ? rowToEvent(stmt.events.byId.get(eventId)) : null;

    upsertScanner(pairToken, {
        ip: getClientIP(req),
        platform: platform || 'unknown',
        deviceName: deviceName || 'Unknown device',
        appVersion: appVersion || null,
        osVersion: osVersion || null,
        userAgent: req.headers['user-agent'] || null,
        lastSeen: new Date().toISOString(),
        online: true,
        eventId: eventId || (scannerRegistry.get(pairToken)?.eventId) || null,
        eventName: ev ? ev.name : (scannerRegistry.get(pairToken)?.eventName) || null,
    });

    // Close any previous channel for this token
    const prev = scannerChannels.get(pairToken);
    if (prev && prev !== res) { try { prev.end(); } catch (_) {} }
    scannerChannels.set(pairToken, res);

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    const keepAlive = setInterval(() => {
        try {
            res.write(': ping\n\n');
            const s = scannerRegistry.get(pairToken);
            if (s) { s.lastSeen = new Date().toISOString(); }
        } catch (_) { clearInterval(keepAlive); }
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        if (scannerChannels.get(pairToken) === res) scannerChannels.delete(pairToken);
        const s = scannerRegistry.get(pairToken);
        if (s) {
            s.online = false;
            if (s.eventId) broadcastToMonitors(s.eventId, { type: 'scanner_update', scanner: { ...s, online: false } });
        }
    });
});

// ── Monitor Notifications ────────────────────────────────────────────────────
// Send a message to one or all scanners (SSE → app shows alert/notification)
app.post('/api/monitor/notify', requireAuth, async (req, res) => {
    const { pairToken, title = 'Admin Message', message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const userId = req.session.userId;
    const userEventIds = personalEventIdsForUser(userId);

    const payload = { type: 'notification', title, message, sentAt: new Date().toISOString() };
    let notified = 0;
    let delivered = 0;
    let pushed = 0;

    // Deliver over the scanner's live SSE channel when the app has it open;
    // otherwise fall back to a real APNs push so it still reaches the
    // device's lock screen instead of silently going nowhere.
    const notifyOne = (token, data) => {
        notified++;
        if (broadcastToPair(token, payload)) { delivered++; return; }
        if (data?.pushToken) {
            pushAppNotificationToTokens([data.pushToken], { title, body: message }).catch(() => {});
            pushed++;
        }
    };

    if (pairToken === '*') {
        // Broadcast to all scanners for owned events
        for (const [token, data] of scannerRegistry) {
            if (!data.eventId || userEventIds.has(data.eventId)) notifyOne(token, data);
        }
    } else {
        // Notify a specific scanner — verify it belongs to an owned event
        const scannerData = scannerRegistry.get(pairToken);
        if (!scannerData) return res.status(404).json({ error: 'Scanner not found' });
        if (scannerData.eventId && !userEventIds.has(scannerData.eventId)) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        notifyOne(pairToken, scannerData);
    }

    log('monitor-notify', `[notify] SSE ${delivered}/${notified}, push fallback ${pushed} — by: ${userId}  msg: ${message.slice(0, 60)}`);
    res.json({ ok: true, notified, delivered, pushed });
});

// ── Per-Event Metrics ────────────────────────────────────────────────────────

app.get('/api/event/:id/metrics', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!userHasEventAccess(req.session.userId, event.id)) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const tickets = stmt.tickets.byEventId.all(event.id).map(rowToTicket);
    const total = tickets.length;
    const scanned = tickets.filter(t => t.used_at).length;
    const pct = total ? Math.round(scanned / total * 100) : 0;
    const uniqueRegistrations = new Set(tickets.map(t => t.registrationId || t.id)).size;
    const walletDownloads = tickets.filter(t => t.wallet_downloaded_at).length;
    const emailOpens = tickets.filter(t => t.email_opened_at).length;

    // Check-in timeline grouped by hour (server local time)
    const checkinByHour = {};
    tickets.filter(t => t.used_at).forEach(t => {
        const d = new Date(t.used_at);
        const key = `${d.getHours().toString().padStart(2, '0')}:00`;
        checkinByHour[key] = (checkinByHour[key] || 0) + 1;
    });
    const checkinTimeline = Object.entries(checkinByHour)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([hour, count]) => ({ hour, count }));

    // Registration timeline grouped by day
    const regByDay = {};
    tickets.forEach(t => {
        if (!t.created_at) return;
        const day = t.created_at.substring(0, 10);
        regByDay[day] = (regByDay[day] || 0) + 1;
    });
    const registrationTimeline = Object.entries(regByDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, count]) => ({ day, count }));

    // Custom field value breakdowns
    const customFieldBreakdowns = {};
    tickets.forEach(t => {
        const fields = t.customFields || {};
        Object.entries(fields).forEach(([key, val]) => {
            if (val == null || val === '') return;
            if (!customFieldBreakdowns[key]) customFieldBreakdowns[key] = {};
            const v = String(val).trim();
            customFieldBreakdowns[key][v] = (customFieldBreakdowns[key][v] || 0) + 1;
        });
    });

    res.json({ total, scanned, pct, uniqueRegistrations, walletDownloads, emailOpens, checkinTimeline, registrationTimeline, customFieldBreakdowns });
});

// ── Admin Overview Metrics ───────────────────────────────────────────────────

app.get('/api/admin/metrics', requireAdmin, (req, res) => {
    const allEvents = stmt.events.all.all().map(rowToEvent);
    let totalTickets = 0, totalScanned = 0, totalWallet = 0, totalEmailOpens = 0;

    const eventStats = allEvents.map(event => {
        const tickets = stmt.tickets.byEventId.all(event.id).map(rowToTicket);
        const total = tickets.length;
        const scanned = tickets.filter(t => t.used_at).length;
        const walletDownloads = tickets.filter(t => t.wallet_downloaded_at).length;
        const emailOpens = tickets.filter(t => t.email_opened_at).length;
        const uniqueRegistrations = new Set(tickets.map(t => t.registrationId || t.id)).size;
        totalTickets += total;
        totalScanned += scanned;
        totalWallet += walletDownloads;
        totalEmailOpens += emailOpens;
        return {
            id: event.id,
            name: event.name,
            time: event.time,
            color: event.color,
            total,
            scanned,
            pct: total ? Math.round(scanned / total * 100) : 0,
            walletDownloads,
            emailOpens,
            uniqueRegistrations
        };
    });

    // Sort by event time descending (most recent first)
    eventStats.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

    res.json({
        totalEvents: allEvents.length,
        totalTickets,
        totalScanned,
        totalPct: totalTickets ? Math.round(totalScanned / totalTickets * 100) : 0,
        totalWalletDownloads: totalWallet,
        totalEmailOpens,
        events: eventStats
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nTicket Check-in System running at:\n - Local: http://localhost:${PORT}\n   - Network:  http://0.0.0.0:${PORT}\n`);
});
