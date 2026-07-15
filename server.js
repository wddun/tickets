import express from 'express';
import { db, stmt, rowToTicket, rowToEvent, rowToUser, rowToDiscountCode, rowToWaitlistEntry, getWalletDevicesBySerials, getTicketsByTokens } from './db-sqlite.js';
import { nanoid } from 'nanoid';
import QRCode from 'qrcode';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
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

async function sendEmail({ to, subject, html, registrationId, fromName, replyTo }) {
    const task = emailChain.then(() => new Promise(r => setTimeout(r, SES_INTERVAL_MS))).then(async () => {
        // Append copyright footer to every email
        const footer = `<div style="text-align:center; margin-top:32px; padding-top:16px; border-top:1px solid #eee; font-size:11px; color:#aaa;">&copy; 2026 Will's Tech Support</div>`;
        const withFooter = html + footer;

        // Inject 1x1 tracking pixel so we can detect email opens
        const tracked = registrationId
            ? withFooter + `\n<img src="${BASE_URL}/api/track/open/${registrationId}" width="1" height="1" style="display:none;opacity:0;" alt="">`
            : withFooter;

        const sesFrom = (process.env.SES_FROM || '').trim();
        // Only wrap in display-name format if sesFrom is a plain email (no angle brackets already)
        const source = (fromName && sesFrom && !sesFrom.includes('<'))
            ? `"${fromName.replace(/["<>\\]/g, '').trim()}" <${sesFrom}>`
            : sesFrom;

        return ses.send(new SendEmailCommand({
            Source: source,
            Destination: { ToAddresses: [to] },
            ReplyToAddresses: replyTo ? [replyTo] : undefined,
            Message: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: { Html: { Data: tracked, Charset: 'UTF-8' } }
            }
        }));
    });
    // Keep the chain alive even if this send fails, so later sends still run
    emailChain = task.catch(() => { });
    return task;
}

// Shared HTML email template used by all ticket confirmation emails
// Cached in memory (read once, reused for every email) so we're not doing
// disk I/O per send — this is a small static asset that never changes.
let _walletBadgeDataUri = null;
function getWalletBadgeDataUri() {
    if (!_walletBadgeDataUri) {
        const buf = fs.readFileSync(path.join(__dirname, 'public', 'apple-wallet-badge.png'));
        _walletBadgeDataUri = `data:image/png;base64,${buf.toString('base64')}`;
    }
    return _walletBadgeDataUri;
}

// Ticket emails embed the QR (and the wallet badge) as inline base64 data URIs
// rather than linking to /qr/:token or the static badge file. Some mail apps
// (Gmail's app has been reported doing this) fail to load remote images when
// reopening an email on weak/no connectivity — embedding the image bytes
// directly in the message means nothing needs to be fetched again once the
// email itself has synced to the device.
async function buildTicketEmailHtml({ firstName, intro, event, tickets, changesHtml = '', customFieldsHtml = '' }) {
    const dateStr = (() => {
        try {
            const start = new Date(event.time).toLocaleString('en-US', {
                weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit', hour12: true
            });
            if (event.endTime) {
                const end = new Date(event.endTime).toLocaleString('en-US', {
                    hour: 'numeric', minute: '2-digit', hour12: true
                });
                return `${start} &ndash; ${end}`;
            }
            return start;
        } catch (_) { return String(event.time); }
    })();

    const locName = event.location?.name || '';
    const locAddress = event.location?.address || '';
    const mapsQuery = encodeURIComponent(locAddress || locName);
    const googleMapsUrl = mapsQuery ? `https://www.google.com/maps/search/?api=1&query=${mapsQuery}` : null;
    const appleMapsUrl  = mapsQuery ? `https://maps.apple.com/?q=${mapsQuery}` : null;
    const locRowHtml = (locName || locAddress) ? `
        <tr>
          <td style="padding:5px 0;font-size:14px;color:#6b7280;vertical-align:top;white-space:nowrap;width:20px;">📍</td>
          <td style="padding:5px 0 5px 8px;font-size:14px;color:#374151;">
            ${locName || locAddress}
            ${googleMapsUrl ? `<br><span style="font-size:12px;"><a href="${googleMapsUrl}" style="color:#6366f1;text-decoration:none;font-weight:500;">Google Maps</a>&nbsp;&middot;&nbsp;<a href="${appleMapsUrl}" style="color:#6366f1;text-decoration:none;font-weight:500;">Apple Maps</a></span>` : ''}
          </td>
        </tr>` : '';

    // Accent color: convert "rgb(r,g,b)" → hex if needed
    const rawColor = event.color || 'rgb(99,102,241)';
    const accentHex = rawColor.startsWith('rgb')
        ? '#' + rawColor.match(/\d+/g).map(n => parseInt(n).toString(16).padStart(2, '0')).join('')
        : rawColor;

    const n = tickets.length;
    const walletBadgeDataUri = getWalletBadgeDataUri();
    const qrBlocksHtml = (await Promise.all(tickets.map(async (t, i) => {
        const qrDataUri = await QRCode.toDataURL(`ticket:${t.token}`);
        return `
<div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin-bottom:16px;background:#fff;">
  ${n > 1 ? `<div style="background:${accentHex};padding:7px 16px;"><p style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.9);text-transform:uppercase;letter-spacing:1px;margin:0;">Ticket ${i + 1} of ${n}</p></div>` : ''}
  <div style="padding:24px;text-align:center;">
    <p style="font-size:15px;font-weight:600;color:#111;margin:0 0 16px;">${t.name}</p>
    <img src="${qrDataUri}" alt="QR Code" style="width:200px;height:200px;display:block;margin:0 auto 12px;border:1px solid #f3f4f6;border-radius:8px;background:#fff;padding:8px;">
    <p style="font-size:10px;color:#9ca3af;font-family:monospace;margin:0 0 16px;word-break:break-all;">${t.token}</p>
    <a href="${BASE_URL}/api/pass/${t.token}.pkpass" style="display:inline-block;text-decoration:none;">
      <img src="${walletBadgeDataUri}" alt="Add to Apple Wallet" style="height:44px;width:auto;display:block;margin:0 auto;">
    </a>
  </div>
</div>`;
    }))).join('');

    const addAllHtml = n > 1 ? `
<div style="text-align:center;margin-bottom:20px;padding:16px;background:#f9fafb;border-radius:12px;border:1px solid #e5e7eb;">
  <p style="font-size:13px;font-weight:600;color:#555;margin:0 0 10px;">Add all ${n} tickets to Apple Wallet at once:</p>
  <a href="${BASE_URL}/api/passes/bundle/${tickets[0].registrationId}" style="display:inline-block;text-decoration:none;">
    <img src="${walletBadgeDataUri}" alt="Add All to Apple Wallet" style="height:44px;width:auto;display:block;margin:0 auto;">
  </a>
</div>` : '';

    return `
<div style="margin:0;padding:0;background:#f3f4f6;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:24px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">

  <!-- Header -->
  <tr><td style="background:${accentHex};padding:28px 32px;text-align:center;">
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Your Ticket</p>
    <h1 style="margin:0;font-size:26px;font-weight:800;color:#fff;line-height:1.2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${event.name}</h1>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p style="font-size:16px;color:#374151;margin:0 0 24px;line-height:1.6;">Hi <strong>${firstName}</strong>,<br>${intro}</p>

    <!-- Event details card -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;margin-bottom:24px;">
    <tr><td style="padding:18px 20px;">
      <table cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="padding:5px 0;font-size:14px;color:#6b7280;vertical-align:top;white-space:nowrap;width:20px;">📅</td>
          <td style="padding:5px 0 5px 8px;font-size:14px;color:#374151;">${dateStr}</td>
        </tr>
        ${locRowHtml}
      </table>
    </td></tr>
    </table>

    ${changesHtml}
    ${customFieldsHtml}

    <!-- Tickets -->
    ${addAllHtml}
    ${qrBlocksHtml}

    <!-- Footer note -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f3f4f6;margin-top:8px;">
    <tr><td style="padding-top:20px;text-align:center;">
      <p style="font-size:12px;color:#9ca3af;margin:0 0 4px;">Keep this email &mdash; it&rsquo;s your entry ticket.</p>
      <p style="font-size:12px;color:#9ca3af;margin:0;">Don&rsquo;t share your QR code with others.</p>
    </td></tr>
    </table>

  </td></tr>
</table>
</td></tr>
</table>
</div>`;
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
app.use(session({
    store: new FileStore({
        path: './sessions',
        retries: 0
    }),
    secret: process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET env var is required'); })(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again later.' }
});

const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many password reset requests. Please try again later.' }
});

const validateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many scan requests.' }
});

// Create pass-cache directory for pre-generated .pkpass files
const passCacheDir = path.resolve(__dirname, 'pass-cache');
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
    const { email, password } = req.body;
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
    req.session.userId = user.id;
    log('login', `[OK] Success — email: ${normalizedEmail}  id: ${user.id}  role: ${isAdmin ? 'admin' : 'staff'}  ip: ${getIP(req)}`);
    res.json({ success: true, user: { id: user.id, email: user.email } });
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
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user.email === process.env.ADMIN_EMAIL;
    res.json({ user: { id: user.id, email: user.email, isAdmin } });
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

app.get('/api/admin/logs', requireAuth, (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user || user.email !== process.env.ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
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

const requireAdmin = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user || user.email !== process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

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

function userHasEventAccess(userId, eventId) {
    const user = rowToUser(stmt.users.byId.get(userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (isAdmin) return true;
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return false;
    if (event.userId === userId) return true;
    const myAccess = stmt.sheetAccess.byUserId.all(userId);
    return myAccess.some(a => {
        const link = stmt.sheetLinks.byId.get(a.sheetLinkId);
        return link && link.eventId === eventId;
    });
}

function userHasEventFullAccess(userId, eventId) {
    const user = rowToUser(stmt.users.byId.get(userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (isAdmin) return true;
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return false;
    if (event.userId === userId) return true;
    const myAccess = stmt.sheetAccess.byUserId.all(userId);
    return myAccess.some(a => {
        const link = stmt.sheetLinks.byId.get(a.sheetLinkId);
        return link && link.eventId === eventId && a.permission === 'full';
    });
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
    if (!userHasEventFullAccess(req.session.userId, eventId)) {
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
    if (!userHasEventFullAccess(req.session.userId, eventId)) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const title = String(req.body?.title || '').trim() || `Update • ${event.name}`;
    const body = String(req.body?.body || '').trim();
    const target = req.body?.target === 'devices' ? 'devices' : 'subscribers';

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

// Serve protected pages for admin only (scanner is PIN-protected itself, so excluded)
app.get('/admin.html', (req, res) => res.redirect('/dashboard.html'));
app.get('/dashboard.html', (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login.html');
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user || user.email !== process.env.ADMIN_EMAIL) return res.redirect('/login.html');
    next();
});

// Public self-registration — creates a free ticket and emails it
app.post('/api/register', async (req, res) => {
    const { name, email, eventId } = req.body;
    if (!name || !email || !eventId) {
        return res.status(400).json({ error: 'Name, email, and event are required' });
    }

    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.allowPublicRegistration) {
        return res.status(403).json({ error: 'Registration is not open for this event' });
    }

    if (event.capacity) {
        const count = stmt.tickets.byEventId.all(eventId).length;
        if (count >= event.capacity) {
            if (event.waitlistEnabled) {
                const cleanEmail = email.trim().toLowerCase();
                const existing = stmt.waitlist.byEventAndEmail.get(eventId, cleanEmail);
                if (existing) return res.json({ waitlisted: true, alreadyOnList: true });
                stmt.waitlist.insert.run(nanoid(10), eventId, name.trim(), cleanEmail, null, 'waiting', new Date().toISOString());
                log('waitlist', `[join] Added to waitlist — name: ${name}  email: ${cleanEmail}  event: ${event.name}`);
                return res.json({ waitlisted: true });
            }
            return res.status(400).json({ error: 'This event is sold out' });
        }
    }

    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || null;
    const token = nanoid(12);
    const ticketId = nanoid(8);
    const registrationId = nanoid(10);
    const now = new Date().toISOString();

    stmt.tickets.insert.run(ticketId, eventId, token, registrationId, name.trim(), firstName, lastName, email.trim().toLowerCase(), null, null, null, null, null, now, null, null);
    const ticket = rowToTicket(stmt.tickets.byToken.get(token));

    const qrDataUrl = await QRCode.toDataURL(`ticket:${token}`);

    if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        sendEmail({
            to: email.trim().toLowerCase(),
            fromName: `Tickets - ${event.name}`,
            replyTo: rowToUser(stmt.users.byId.get(event.userId))?.email,
            subject: `Your ticket for ${event.name}`,
            html: await buildTicketEmailHtml({
                firstName,
                intro: `You&rsquo;re all set for <strong>${event.name}</strong>! We&rsquo;ll see you there.`,
                event,
                tickets: [ticket],
            }),
            registrationId,
        }).catch(() => {});
    }

    log('register', `[public] New registration — name: ${name}  email: ${email}  event: ${event.name}`);
    res.json({ success: true, ticket: { token, registrationId }, qr: qrDataUrl });
});

// Toggle public registration on/off for an event
app.put('/api/event/:id/public-registration', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const isOwner = event.userId === req.session.userId;
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

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

    const nameParts = (buyerName || '').split(/\s+/);
    const firstName = nameParts[0] || buyerName || '';
    const lastName  = nameParts.slice(1).join(' ') || null;
    const token = nanoid(12);
    const ticketId = nanoid(8);
    const registrationId = nanoid(10);
    const now = new Date().toISOString();

    stmt.tickets.insert.run(ticketId, eventId, token, registrationId, buyerName, firstName, lastName, buyerEmail, null, null, null, null, null, now, null, null);
    const ticket = rowToTicket(stmt.tickets.byToken.get(token));

    if (buyerEmail && process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        sendEmail({
            to: buyerEmail,
            fromName: `Tickets - ${dbEvent.name}`,
            replyTo: rowToUser(stmt.users.byId.get(dbEvent.userId))?.email,
            subject: `Your ticket for ${dbEvent.name}`,
            html: await buildTicketEmailHtml({
                firstName,
                intro: `You&rsquo;re all set for <strong>${dbEvent.name}</strong>! We&rsquo;ll see you there.`,
                event: dbEvent,
                tickets: [ticket],
            }),
            registrationId,
        }).catch(() => {});
    }

    return { ticket, dbEvent, firstName, registrationId };
}

// Create a Checkout Session for a paid ticket
app.post('/api/checkout/:eventId', async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const { name, email, discountCode } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const event = rowToEvent(stmt.events.byId.get(req.params.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.allowPublicRegistration) return res.status(403).json({ error: 'Registration is not open for this event' });
    if (!event.ticketPrice) return res.status(400).json({ error: 'This event is free — use /api/register' });

    const cleanEmail = email.trim().toLowerCase();
    const cleanName  = name.trim();

    if (event.capacity) {
        const registered = stmt.tickets.countByEventId.get(event.id)?.cnt ?? 0;
        if (registered >= event.capacity) {
            if (event.waitlistEnabled) {
                const existing = stmt.waitlist.byEventAndEmail.get(event.id, cleanEmail);
                if (existing) return res.json({ waitlisted: true, alreadyOnList: true });
                stmt.waitlist.insert.run(nanoid(10), event.id, cleanName, cleanEmail, null, 'waiting', new Date().toISOString());
                log('waitlist', `[join] Added to waitlist — name: ${cleanName}  email: ${cleanEmail}  event: ${event.name}`);
                return res.json({ waitlisted: true });
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

    const dateLabel  = (() => { try { return new Date(event.time).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch { return ''; } })();

    // A 100%-off code means nothing to actually charge — Stripe Checkout
    // doesn't support $0 payment-mode sessions, so issue the ticket directly
    // instead of round-tripping through Stripe for no reason.
    if (finalAmount <= 0) {
        const issued = await issueTicketForPayment({ eventId: event.id, buyerName: cleanName, buyerEmail: cleanEmail });
        if (!issued) return res.status(500).json({ error: 'Failed to issue ticket' });
        if (discountCodeId) stmt.discountCodes.incrementUse.run(discountCodeId);
        stmt.orders.insert.run(nanoid(8), nanoid(16), event.id, issued.registrationId, cleanName, cleanEmail, 0, 'usd', 'fulfilled', new Date().toISOString(), discountCodeId, discountAmount);
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
                    description: [event.location?.name, dateLabel].filter(Boolean).join(' · ') || undefined,
                    images: event.imageUrl ? [`${BASE_URL}${event.imageUrl}`] : [],
                },
                unit_amount: finalAmount,
            },
            quantity: 1,
        }],
        mode: 'payment',
        customer_email: cleanEmail,
        metadata: { eventId: event.id, buyerName: cleanName, buyerEmail: cleanEmail, discountCodeId: discountCodeId || '' },
        success_url: `${BASE_URL}/register.html?session={CHECKOUT_SESSION_ID}&id=${event.id}`,
        cancel_url: `${BASE_URL}/register.html?id=${event.id}`,
    });

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
        const { eventId, buyerName, buyerEmail, discountCodeId } = session.metadata || {};
        if (!eventId || !buyerName || !buyerEmail) return res.json({ received: true });

        const existing = stmt.orders.bySessionId.get(session.id);
        if (existing?.status === 'fulfilled') return res.json({ received: true });

        const issued = await issueTicketForPayment({ eventId, buyerName, buyerEmail });
        if (!issued) return res.json({ received: true });

        stmt.orders.fulfill.run(issued.registrationId, new Date().toISOString(), session.payment_intent || null, session.id);
        // Only counts toward the code's usage limit once payment is actually
        // confirmed — an abandoned checkout never gets here.
        if (discountCodeId) stmt.discountCodes.incrementUse.run(discountCodeId);
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
    const isOwner = event.userId === req.session.userId;
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

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
        const registered = stmt.tickets.countByEventId.get(event.id)?.cnt ?? 0;
        if (registered >= event.capacity) return res.status(400).json({ error: 'This event is sold out' });
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
    if (!userHasEventFullAccess(req.session.userId, eventId)) {
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
    if (!userHasEventFullAccess(req.session.userId, discountCode.eventId)) {
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
    if (!userHasEventFullAccess(req.session.userId, discountCode.eventId)) {
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

app.put('/api/event/:id/waitlist-enabled', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventFullAccess(req.session.userId, event.id)) return res.status(403).json({ error: 'Forbidden' });
    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    stmt.events.setWaitlistEnabled.run(enabled ? 1 : 0, req.params.id);
    logAudit(req, { eventId: event.id, action: enabled ? 'waitlist.enabled' : 'waitlist.disabled' });
    res.json({ success: true, waitlistEnabled: enabled });
});

// See the shuttleLinkEnabled comment in db-sqlite.js — only for events whose
// tickets are exclusively used for shuttle boarding, never a door.
app.put('/api/event/:id/shuttle-link-enabled', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventFullAccess(req.session.userId, event.id)) return res.status(403).json({ error: 'Forbidden' });
    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    stmt.events.setShuttleLinkEnabled.run(enabled ? 1 : 0, req.params.id);
    logAudit(req, { eventId: event.id, action: enabled ? 'shuttlelink.enabled' : 'shuttlelink.disabled' });
    res.json({ success: true, shuttleLinkEnabled: enabled });
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
    const cleanEmail = email.trim().toLowerCase();
    const existing = stmt.waitlist.byEventAndEmail.get(event.id, cleanEmail);
    if (existing) return res.json({ waitlisted: true, alreadyOnList: true });
    stmt.waitlist.insert.run(nanoid(10), event.id, name.trim(), cleanEmail, null, 'waiting', new Date().toISOString());
    log('waitlist', `[join] Added to waitlist — name: ${name}  email: ${cleanEmail}  event: ${event.name}`);
    res.json({ waitlisted: true });
});

// Promote someone off the waitlist: issues them a free ticket directly (for
// paid events, promoting sends them a personal note to complete checkout —
// keeps Stripe as the one place money actually changes hands) and marks the
// waitlist entry as converted. Doesn't auto-check capacity — the organizer is
// explicitly choosing to seat this person, e.g. after a cancellation.
app.post('/api/waitlist/:id/promote', requireAuth, async (req, res) => {
    const entry = rowToWaitlistEntry(stmt.waitlist.byId.get(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
    if (!userHasEventFullAccess(req.session.userId, entry.eventId)) {
        return res.status(403).json({ error: 'Only the event owner can manage the waitlist' });
    }
    const event = rowToEvent(stmt.events.byId.get(entry.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (event.ticketPrice > 0) {
        stmt.waitlist.setNotified.run(new Date().toISOString(), entry.id);
        if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
            sendEmail({
                to: entry.email,
                fromName: `Tickets - ${event.name}`,
                replyTo: rowToUser(stmt.users.byId.get(event.userId))?.email,
                subject: `A spot opened up for ${event.name}!`,
                html: `<div style="font-family:sans-serif; max-width:600px; margin:auto; padding:24px;"><p>Good news — a ticket for <strong>${event.name}</strong> just became available. <a href="${BASE_URL}/register.html?id=${event.id}">Complete your registration</a> to claim it before it's gone.</p></div>`,
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
    if (!userHasEventFullAccess(req.session.userId, entry.eventId)) {
        return res.status(403).json({ error: 'Only the event owner can manage the waitlist' });
    }
    stmt.waitlist.deleteById.run(req.params.id);
    logAudit(req, { eventId: entry.eventId, action: 'waitlist.removed', details: { email: entry.email } });
    res.json({ success: true });
});

// ── Payments (Beta) — orders & refunds ─────────────────────────────────────────

app.get('/api/event/:id/orders', requireAuth, (req, res) => {
    const eventId = req.params.id;
    if (!userHasEventAccess(req.session.userId, eventId)) {
        return res.status(403).json({ error: 'You do not have access to this event' });
    }
    res.json(stmt.orders.byEventId.all(eventId));
});

app.post('/api/orders/:id/refund', requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const order = stmt.orders.byId.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!userHasEventFullAccess(req.session.userId, order.eventId)) {
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

    // Capacity check — only enforced for new registrations, not resends
    if (!isResend && event.capacity) {
        const registered = stmt.tickets.countByEventId.get(event.id).cnt;
        if (registered + count > event.capacity) {
            return res.status(409).json({ error: `Event is at capacity (${event.capacity} tickets max, ${registered} registered)` });
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
            await sendEmail({
                to: email,
                fromName: `Tickets - ${event.name}`,
                replyTo: rowToUser(stmt.users.byId.get(event.userId))?.email,
                subject: isUpdate ? `Your registration for ${event.name} has been updated` : `Your ${ticketLabel} for ${event.name}`,
                html: await buildTicketEmailHtml({
                    firstName,
                    intro: isUpdate
                        ? `Your registration for <strong>${event.name}</strong> has been updated.`
                        : `You&rsquo;re all set for <strong>${event.name}</strong>! We&rsquo;ll see you there.`,
                    event,
                    tickets: ticketsToSend,
                    changesHtml,
                    customFieldsHtml,
                }),
                registrationId: ticketsToSend[0].registrationId
            });
            log('bulk-register', `[email] Email ${isUpdate ? 'updated' : 'sent'} → ${email}  name: ${fullName}  tickets: ${actualCount}  event: ${event.name}  regId: ${ticketsToSend[0].registrationId}`);
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
            name: locationName || address || 'Venue',
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

app.get('/api/events', requireAuth, (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (isAdmin) return res.json(stmt.events.all.all().map(rowToEvent));

    const myAccess = stmt.sheetAccess.byUserId.all(req.session.userId);
    const linkedEventIds = new Set(
        myAccess.map(a => {
            const link = stmt.sheetLinks.byId.get(a.sheetLinkId);
            return link ? link.eventId : null;
        }).filter(Boolean)
    );
    const userEvents = stmt.events.byUserId.all(req.session.userId).map(rowToEvent);
    const linkedEvents = [...linkedEventIds].map(id => rowToEvent(stmt.events.byId.get(id))).filter(Boolean);
    const seen = new Set(userEvents.map(e => e.id));
    res.json([...userEvents, ...linkedEvents.filter(e => !seen.has(e.id))]);
});

app.post('/api/events', requireAuth, async (req, res) => {
    const { name, time, endTime, locationName, locationAddress, lat, lng, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Event name is required' });
    if (!time) return res.status(400).json({ error: 'Event date/time is required' });

    const newEvent = {
        id: nanoid(10),
        userId: req.session.userId,
        name: name.trim(),
        time,
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
    logAudit(req, { eventId: newEvent.id, action: 'event.created', details: { name: newEvent.name } });
    res.json({ success: true, eventId: newEvent.id, event: newEvent });
});

app.get('/api/events/counts', requireAuth, (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    let userEvents;
    if (isAdmin) {
        userEvents = stmt.events.all.all().map(rowToEvent);
    } else {
        const myAccess = stmt.sheetAccess.byUserId.all(req.session.userId);
        const linkedEventIds = new Set(
            myAccess.map(a => {
                const link = stmt.sheetLinks.byId.get(a.sheetLinkId);
                return link ? link.eventId : null;
            }).filter(Boolean)
        );
        const owned = stmt.events.byUserId.all(req.session.userId).map(rowToEvent);
        const linked = [...linkedEventIds].map(id => rowToEvent(stmt.events.byId.get(id))).filter(Boolean);
        const seen = new Set(owned.map(e => e.id));
        userEvents = [...owned, ...linked.filter(e => !seen.has(e.id))];
    }
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
        const registered = stmt.tickets.countByEventId.get(event.id)?.cnt ?? 0;
        event.ticketsRemaining = Math.max(0, event.capacity - registered);
    }
    res.json(event);
});

// Edit event details
app.put('/api/event/:id', requireAuth, upload.single('image'), async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (!isAdmin && event.userId !== req.session.userId) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const { name, time, endTime, color, locationName, locationAddress, lat, lng } = req.body;

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
    }

    const allowReentry = req.body.allowReentry === 'true';
    const capacityRaw = req.body.capacity !== undefined ? req.body.capacity : undefined;
    const newName = name || event.name;
    const newTime = time || event.time;
    const newEndTime = endTime !== undefined ? (endTime || null) : event.endTime;
    const newColor = color || event.color;
    const newCapacity = capacityRaw !== undefined ? (parseInt(capacityRaw) || null) : event.capacity;
    const newLocation = {
        name: locationName || event.location?.name || 'Venue',
        address: locationAddress || event.location?.address || '',
        lat: parseFloat(lat) || event.location?.lat || 37.33182,
        lng: parseFloat(lng) || event.location?.lng || -122.03118,
    };

    stmt.events.update.run(newName, newTime, newEndTime, newColor, imageUrl, allowReentry ? 1 : 0, newCapacity, JSON.stringify(newLocation), req.params.id);

    const priceCents = req.body.ticketPrice !== undefined
        ? Math.round(Math.max(0, parseFloat(req.body.ticketPrice) || 0) * 100)
        : event.ticketPrice;
    stmt.events.setTicketPrice.run(priceCents, req.params.id);

    const updated = rowToEvent(stmt.events.byId.get(req.params.id));
    log('event-edit', `[edit] Updated event — name: ${updated.name}  id: ${updated.id}  by: ${req.session.userId}`);

    const eventTickets = stmt.tickets.byEventId.all(req.params.id).map(rowToTicket);
    pushWalletIfChanged(eventTickets, updated).catch(() => {});

    res.json(updated);
});

// Update event custom field definitions
app.patch('/api/event/:id', requireAuth, async (req, res) => {
    const { customFields } = req.body;
    if (!Array.isArray(customFields)) return res.status(400).json({ error: 'customFields must be an array of strings' });

    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (!isAdmin && event.userId !== req.session.userId) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const cleaned = [...new Set(customFields.map(f => String(f).trim()).filter(Boolean))];
    stmt.events.setCustomFields.run(JSON.stringify(cleaned), req.params.id);

    log('event-settings', `[edit] Updated customFields — event: ${event.name}  fields: [${cleaned.join(', ')}]  by: ${req.session.userId}`);
    res.json({ success: true, customFields: cleaned });
});

app.get('/api/event/:id/tickets', requireAuth, (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    let hasSheetAccess = false;
    if (!isAdmin) {
        const myAccess = stmt.sheetAccess.byUserId.all(req.session.userId);
        hasSheetAccess = myAccess.some(a => {
            const link = stmt.sheetLinks.byId.get(a.sheetLinkId);
            return link && link.eventId === req.params.id;
        });
    }

    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event || (!isAdmin && event.userId !== req.session.userId && !hasSheetAccess)) {
        return res.status(401).json({ error: 'Unauthorized or not found' });
    }
    const tickets = stmt.tickets.byEventId.all(req.params.id).map(rowToTicket);
    res.json(tickets);
});

// Delete an event
app.delete('/api/event/:id', requireAuth, async (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event || (!isAdmin && event.userId !== req.session.userId)) {
        return res.status(404).json({ error: 'Event not found' });
    }

    const deleteEvent = db.transaction(() => {
        stmt.tickets.deleteByEventId.run(req.params.id);
        stmt.pushSubscriptions.deleteByEventId.run(req.params.id);
        stmt.scannerLinks.deleteByEventId.run(req.params.id);
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
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const allEvents = stmt.events.all.all().map(rowToEvent);
    const allowed = new Set(
        allEvents.filter(e => eventIds.includes(e.id) && (isAdmin || e.userId === req.session.userId)).map(e => e.id)
    );
    const bulkDelete = db.transaction(() => {
        for (const eventId of allowed) {
            stmt.tickets.deleteByEventId.run(eventId);
            stmt.pushSubscriptions.deleteByEventId.run(eventId);
            stmt.scannerLinks.deleteByEventId.run(eventId);
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
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    const allowedRegistrationIds = new Set();
    const eventIdsForRegs = new Set();
    for (const regId of registrationIds) {
        const tickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        for (const t of tickets) eventIdsForRegs.add(t.eventId);
    }

    for (const eventId of eventIdsForRegs) {
        const event = rowToEvent(stmt.events.byId.get(eventId));
        if (!event) continue;
        const link = stmt.sheetLinks.byEventId.get(eventId);
        const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
        if (isAdmin || event.userId === req.session.userId || (access && access.permission === 'full')) {
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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;

    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
        return res.status(403).json({ error: 'Not authorized to create tickets' });
    }

    const count = Math.max(1, parseInt(ticketCount) || 1);

    if (event.capacity) {
        const registered = stmt.tickets.countByEventId.get(event.id).cnt;
        if (registered + count > event.capacity) {
            return res.status(409).json({ error: `Event is at capacity (${event.capacity} tickets max, ${registered} registered)` });
        }
    }
    const registrationId = nanoid(10);
    const newTickets = [];
    const now = new Date().toISOString();

    const insertTickets = db.transaction(() => {
        for (let i = 0; i < count; i++) {
            const t = {
                id: nanoid(8),
                token: nanoid(12),
                eventId: event.id,
                registrationId,
                name,
                firstName: name.split(' ')[0],
                lastName: name.split(' ').slice(1).join(' '),
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

    if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        const actualCount = newTickets.length;
        const ticketLabel = actualCount === 1 ? 'Ticket' : `${actualCount} Tickets`;
        const eventOwner = rowToUser(stmt.users.byId.get(event.userId));

        await sendEmail({
            to: email,
            fromName: `Tickets - ${event.name}`,
            replyTo: eventOwner?.email,
            subject: `Your ${ticketLabel} for ${event.name}`,
            html: await buildTicketEmailHtml({
                firstName: newTickets[0].firstName,
                intro: `You&rsquo;re all set for <strong>${event.name}</strong>! We&rsquo;ll see you there.`,
                event,
                tickets: newTickets,
            }),
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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
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

    if (!noEmail && process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        const eventOwner = rowToUser(stmt.users.byId.get(event.userId));
        await sendEmail({
            to: email,
            fromName: `Tickets - ${event.name}`,
            replyTo: eventOwner?.email,
            subject: `Updated registration for ${event.name}`,
            html: await buildTicketEmailHtml({
                firstName: updatedTickets[0].firstName,
                intro: `Your registration details for <strong>${event.name}</strong> have been updated.`,
                event,
                tickets: updatedTickets,
            }),
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
app.post('/api/ticket/:id/resend', requireAuth, async (req, res) => {
    const ticket = rowToTicket(stmt.tickets.byId.get(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const groupTickets = stmt.tickets.byRegistrationId.all(ticket.registrationId).map(rowToTicket);
    log('resend-email', `[email] Resending ${groupTickets.length} ticket(s) — email: ${ticket.email}  event: ${event.name}  regId: ${ticket.registrationId}  by: ${req.session.userId}`);

    if (!process.env.SES_FROM || !process.env.AWS_ACCESS_KEY_ID) {
        return res.status(503).json({ error: 'Email not configured' });
    }

    const actualCount = groupTickets.length;
    const eventOwner = rowToUser(stmt.users.byId.get(event.userId));
    await sendEmail({
        to: ticket.email,
        fromName: `Tickets - ${event.name}`,
        replyTo: eventOwner?.email,
        subject: `Your ticket${actualCount > 1 ? 's' : ''} for ${event.name}`,
        html: await buildTicketEmailHtml({
            firstName: groupTickets[0].firstName,
            intro: `Here&rsquo;s a copy of your ticket${actualCount > 1 ? 's' : ''} for <strong>${event.name}</strong>.`,
            event,
            tickets: groupTickets,
        }),
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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
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
            replyTo: eventOwner?.email,
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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
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

    const replyTo = rowToUser(stmt.users.byId.get(event.userId))?.email;
    const escapedMessage = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

    let sent = 0;
    const errors = [];
    for (const ticket of registrations) {
        const html = `
            <div style="font-family:sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #eee; border-radius:12px;">
                <p style="color:#555; white-space:pre-wrap;">${escapedMessage}</p>
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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
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
<p style="color:#888;margin:0 0 16px;">Registered ${new Date(groupTickets[0].created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
<hr style="border:none;border-top:1px solid #eee;margin-bottom:16px;">
<p style="margin:0 0 4px;"><strong>${event.name}</strong></p>
<p style="color:#555;margin:0 0 4px;">📍 ${event.location?.name || ''}${event.location?.address ? ' — ' + event.location.address : ''}</p>
<p style="color:#555;margin:0 0 20px;">🕐 ${new Date(event.time).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}${event.endTime ? ` – ${new Date(event.endTime).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}</p>
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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    const sections = [];
    for (const regId of rawIds) {
        const groupTickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!groupTickets.length) continue;

        const ticket = groupTickets[0];
        const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
        if (!event) continue;

        const link = stmt.sheetLinks.byEventId.get(event.id);
        const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
        if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) continue;

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
    <p style="color:#888;margin:0 0 16px;">Registered ${new Date(ticket.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
    <hr style="border:none;border-top:1px solid #eee;margin-bottom:16px;">
    <p style="margin:0 0 4px;"><strong>${event.name}</strong></p>
    <p style="color:#555;margin:0 0 4px;">📍 ${event.location?.name || ''}${event.location?.address ? ' — ' + event.location.address : ''}</p>
    <p style="color:#555;margin:0 0 20px;">🕐 ${new Date(event.time).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}${event.endTime ? ` – ${new Date(event.endTime).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}</p>
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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const now = new Date().toISOString();
    let checkedIn = 0;
    const touchedEventIds = new Map();

    for (const regId of registrationIds) {
        const tickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!tickets.length) continue;
        const event = rowToEvent(stmt.events.byId.get(tickets[0].eventId));
        if (!event) continue;
        const link = stmt.sheetLinks.byEventId.get(event.id);
        const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
        if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission === 'view')) continue;

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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const now = new Date().toISOString();
    let cleared = 0;
    const touchedEventIds = new Map();

    for (const regId of registrationIds) {
        const tickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!tickets.length) continue;
        const event = rowToEvent(stmt.events.byId.get(tickets[0].eventId));
        if (!event) continue;
        if (!isAdmin && event.userId !== req.session.userId) continue;

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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    let sent = 0, failed = 0;

    for (const regId of registrationIds) {
        const groupTickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!groupTickets.length) continue;
        const ticket = groupTickets[0];
        const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
        if (!event) continue;
        const link = stmt.sheetLinks.byEventId.get(event.id);
        const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
        if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) continue;

        const actualCount = groupTickets.length;
        const eventOwner = rowToUser(stmt.users.byId.get(event.userId));
        try {
            await sendEmail({
                to: ticket.email,
                fromName: `Tickets - ${event.name}`,
                replyTo: eventOwner?.email,
                subject: `Your ticket${actualCount > 1 ? 's' : ''} for ${event.name}`,
                html: await buildTicketEmailHtml({
                    firstName: ticket.firstName,
                    intro: `Here&rsquo;s a copy of your ticket${actualCount > 1 ? 's' : ''} for <strong>${event.name}</strong>.`,
                    event,
                    tickets: groupTickets,
                }),
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

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    const rows = [];
    const customFieldKeys = new Set();

    for (const regId of rawIds) {
        const groupTickets = stmt.tickets.byRegistrationId.all(regId).map(rowToTicket);
        if (!groupTickets.length) continue;
        const ticket = groupTickets[0];
        const event = rowToEvent(stmt.events.byId.get(ticket.eventId));
        if (!event) continue;
        const link = stmt.sheetLinks.byEventId.get(event.id);
        const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
        if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) continue;

        Object.keys(ticket.customFields || {}).forEach(k => customFieldKeys.add(k));
        rows.push({ ticket, groupTickets, event });
    }

    if (!rows.length) return res.status(404).send('No accessible registrations found');

    const cfKeys = [...customFieldKeys];
    const headers = ['Name', 'Email', 'Tickets', 'Registered', 'Status', ...cfKeys];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const csvRows = [headers.map(esc).join(',')];
    for (const { ticket, groupTickets } of rows) {
        const checkedIn = groupTickets.filter(t => t.used_at).length;
        const total = groupTickets.length;
        const status = checkedIn === 0 ? 'Pending' : checkedIn === total ? 'Checked In' : `${checkedIn}/${total} Checked In`;
        const registered = ticket.created_at ? new Date(ticket.created_at).toLocaleDateString('en-US') : '';
        csvRows.push([ticket.name, ticket.email, total, registered, status, ...cfKeys.map(k => ticket.customFields?.[k] ?? '')].map(esc).join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tickets-export.csv"`);
    res.send(csvRows.join('\r\n'));
});

// API: Validate QR Code
// Manual check-in by registrationId (marks all tickets in the group)
app.post('/api/checkin/:registrationId', requireAuth, async (req, res) => {
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

app.delete('/api/checkin/:registrationId', requireAuth, async (req, res) => {
    const { registrationId } = req.params;

    let tickets = stmt.tickets.byRegistrationId.all(registrationId).map(rowToTicket);
    if (!tickets.length) {
        const single = rowToTicket(stmt.tickets.byId.get(registrationId));
        if (single) tickets = [single];
    }

    if (!tickets.length) return res.status(404).json({ error: 'Not found' });

    const event = rowToEvent(stmt.events.byId.get(tickets[0].eventId));
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (!isAdmin && (!event || event.userId !== req.session.userId)) {
        return res.status(403).json({ error: 'Only event owners or admins can undo check-ins' });
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
    if (!userHasEventFullAccess(req.session.userId, event.id)) return res.status(403).json({ error: 'Forbidden' });
    const label = (req.body.label || '').trim();
    const link = { id: nanoid(10), eventId: event.id, token: nanoid(24), label, createdBy: req.session.userId, createdAt: new Date().toISOString() };
    stmt.scannerLinks.insert.run(link.id, link.eventId, link.token, link.label, link.createdBy, link.createdAt);
    logAudit(req, { eventId: event.id, action: 'scannerlink.created', details: { label } });
    res.json({ success: true, link: { ...link, url: `${BASE_URL}/scan/${link.token}` } });
});

app.get('/api/event/:id/scanner-links', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!userHasEventAccess(req.session.userId, event.id)) return res.status(403).json({ error: 'Forbidden' });
    const links = stmt.scannerLinks.byEventId.all(event.id).map(l => ({ ...l, url: `${BASE_URL}/scan/${l.token}` }));
    res.json(links);
});

app.delete('/api/scanner-links/:id', requireAuth, (req, res) => {
    const link = stmt.scannerLinks.byId.get(req.params.id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (!userHasEventFullAccess(req.session.userId, link.eventId)) return res.status(403).json({ error: 'Forbidden' });
    stmt.scannerLinks.deleteById.run(link.id);
    logAudit(req, { eventId: link.eventId, action: 'scannerlink.revoked', details: { label: link.label } });
    res.json({ success: true });
});

// PUBLIC: resolve a scan link to its event — no auth, this is the whole point.
// Scanning itself (/api/validate, /api/checkout) already requires no session;
// this endpoint's only job is telling a no-account device which event to lock to.
app.get('/api/scanner-links/:token', (req, res) => {
    const link = stmt.scannerLinks.byToken.get(req.params.token);
    if (!link) return res.status(404).json({ error: 'Invalid or revoked scan link' });
    const event = rowToEvent(stmt.events.byId.get(link.eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    stmt.scannerLinks.touchLastUsed.run(new Date().toISOString(), link.id);
    res.json({
        eventId: event.id,
        eventName: event.name,
        color: event.color,
        allowReentry: event.allowReentry,
    });
});

app.get('/scan/:token', (req, res) => {
    res.redirect(`/scanner.html?scanToken=${encodeURIComponent(req.params.token)}`);
});

// Confirm reentry check-out (no auth required — scanner uses PIN, not session)
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
const PASS_TEMPLATE_VERSION = 11;
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
        allowReentry: !!event.allowReentry
    });
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

function humanEventTime(date) {
    const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const h = date.getHours();
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
    if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
        const multiDay = !!(event.endTime && !Number.isNaN(new Date(event.endTime).getTime()));
        const locObj = { latitude: Number(lat), longitude: Number(lng) };
        if (!multiDay) locObj.relevantText = humanEventTime(new Date(event.time));
        pass.setLocations(locObj);
    }

    // When checked in, show name + greyed-out event name; logoText already says "✓ CHECKED IN"
    pass.primaryFields.push({ key: "attendee", label: showCheckedInStyle ? "CHECKED IN" : "NAME", value: ticket.name });

    const customFields = ticket.customFields || {};
    const cfEntries = Object.entries(customFields);

    const eventDate = new Date(event.time);
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
        const fmtOpts = { month: 'short', day: 'numeric' };
        const startStr = eventDate.toLocaleString('en-US', { ...fmtOpts, hour: 'numeric', minute: '2-digit', hour12: true });
        const endStr = eventEndDate.toLocaleString('en-US', { ...fmtOpts, hour: 'numeric', minute: '2-digit', hour12: true });
        return `${startStr} – ${endStr}`;
    };

    const setRelevantDatesAndExpiry = () => {
        const windowStart = new Date(eventDate.getTime() - 2 * 60 * 60 * 1000);
        const windowEnd = isMultiDay
            ? new Date(eventEndDate.getTime() + 2 * 60 * 60 * 1000)
            : new Date(eventDate.getTime() + 2 * 60 * 60 * 1000);
        const expiresAt = isMultiDay
            ? new Date(eventEndDate.getTime() + 24 * 60 * 60 * 1000)
            : new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);
        pass.setRelevantDates([{ startDate: windowStart, endDate: windowEnd }]);
        pass.expirationDate = expiresAt;
    };

    // If notes exist, keep date in the header and notes in secondary.
    // If no notes, place date in secondary (so the row isn't empty).
    if (hasNote) {
        if (!Number.isNaN(eventDate.getTime())) {
            if (isMultiDay) {
                pass.headerFields.push({ key: "date", label: buildDateLabel(), value: buildDateValue(eventDate) });
            } else {
                pass.headerFields.push({
                    key: "date", label: buildDateLabel(), value: eventDate,
                    dateStyle: "PKDateStyleMedium", timeStyle: "PKDateStyleShort"
                });
            }
            setRelevantDatesAndExpiry();
        } else {
            pass.headerFields.push({ key: "date", label: "DATE", value: String(event.time) });
        }
        pass.secondaryFields.push({ key: 'cf_0', label: cfEntries[0][0].toUpperCase(), value: String(cfEntries[0][1]) });
    } else {
        if (!Number.isNaN(eventDate.getTime())) {
            if (isMultiDay) {
                pass.secondaryFields.push({ key: "date", label: buildDateLabel(), value: buildDateValue(eventDate) });
            } else {
                pass.secondaryFields.push({
                    key: "date", label: buildDateLabel(), value: eventDate,
                    dateStyle: "PKDateStyleMedium", timeStyle: "PKDateStyleShort"
                });
            }
            setRelevantDatesAndExpiry();
        } else {
            pass.secondaryFields.push({ key: "date", label: "DATE", value: String(event.time) });
        }
    }

    // Auxiliary row: Location (two lines)
    const locName = event.location?.name || '';
    const locAddress = event.location?.address || '';
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
            const [strip1x, strip2x] = await Promise.all([
                sharp(imagePath).resize(320, 123, { fit: 'cover' }).png().toBuffer(),
                sharp(imagePath).resize(640, 246, { fit: 'cover' }).png().toBuffer(),
            ]);
            pass.addBuffer('strip.png', strip1x);
            pass.addBuffer('strip@2x.png', strip2x);
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
app.get('/api/my-rooms', requireAuth, (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    if (isAdmin) {
        const rooms = stmt.events.all.all().map(rowToEvent).map(event => {
            const link = stmt.sheetLinks.byEventId.get(event.id);
            const accessEntries = link
                ? stmt.sheetAccess.byLinkId.all(link.id).map(a => {
                    const u = rowToUser(stmt.users.byId.get(a.userId));
                    return { id: a.id, email: u ? u.email : 'Unknown', claimedAt: a.claimedAt };
                })
                : [];
            return { event, sheetLink: link || null, access: accessEntries, isAdmin: true };
        });
        return res.json(rooms);
    }

    const myAccess = stmt.sheetAccess.byUserId.all(req.session.userId);
    const rooms = myAccess.map(access => {
        const link = stmt.sheetLinks.byId.get(access.sheetLinkId);
        if (!link) return null;
        const event = link.eventId ? rowToEvent(stmt.events.byId.get(link.eventId)) : null;
        return { event, sheetLink: link, accessId: access.id, claimedAt: access.claimedAt };
    }).filter(Boolean);

    res.json(rooms);
});

// Get access entries for a specific event (for settings cog in dashboard)
app.get('/api/event/:id/access', requireAuth, (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    const link = stmt.sheetLinks.byEventId.get(req.params.id);

    let hasAccess = false;
    if (isAdmin || (event && event.userId === req.session.userId)) hasAccess = true;
    else if (link) {
        const myAccess = stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId);
        if (myAccess && myAccess.permission === 'full') hasAccess = true;
    }

    if (!hasAccess) return res.status(403).json({ error: 'Admin access required' });
    if (!link) return res.json({ access: [], linkUrl: null });

    const accessEntries = stmt.sheetAccess.byLinkId.all(link.id).map(a => {
        const u = rowToUser(stmt.users.byId.get(a.userId));
        return { id: a.id, email: u ? u.email : 'Unknown', claimedAt: a.claimedAt, permission: a.permission || 'view' };
    });

    res.json({ access: accessEntries, linkUrl: BASE_URL + '/link/' + link.token });
});

app.post('/api/sheet/share', requireAuth, async (req, res) => {
    const { eventId, email, permission } = req.body;
    if (!eventId || !email || !permission) return res.status(400).json({ error: 'Missing fields' });

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    let link = stmt.sheetLinks.byEventId.get(eventId);
    if (!link) {
        const newLink = { id: nanoid(10), token: nanoid(20), spreadsheetId: 'manual', sheetName: event.name, eventId: event.id, createdAt: new Date().toISOString(), apiKey: nanoid(24) };
        stmt.sheetLinks.insert.run(newLink.id, newLink.token, newLink.spreadsheetId, newLink.sheetName, newLink.eventId, newLink.createdAt, newLink.apiKey);
        link = newLink;
    }

    const myAccess = stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId);
    if (!isAdmin && event.userId !== req.session.userId && (!myAccess || myAccess.permission !== 'full')) {
        return res.status(403).json({ error: 'Permission denied to share room' });
    }

    const targetUser = rowToUser(stmt.users.byEmail.get(email.toLowerCase()));
    if (!targetUser) return res.status(404).json({ error: 'User ' + email + ' does not have an account. They must register first.' });
    if (targetUser.id === req.session.userId) return res.status(400).json({ error: 'Cannot share with yourself' });

    const existingAccess = stmt.sheetAccess.byLinkAndUser.get(link.id, targetUser.id);
    if (existingAccess) {
        stmt.sheetAccess.setPermission.run(permission, link.id, targetUser.id);
    } else {
        stmt.sheetAccess.insert.run(nanoid(10), targetUser.id, link.id, new Date().toISOString(), permission);
    }
    logAudit(req, { eventId: event.id, action: 'access.granted', details: { email: targetUser.email, permission } });
    res.json({ success: true, message: 'Access granted' });
});

// Revoke access to a room
app.delete('/api/sheet/access/:id', requireAuth, async (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    const access = stmt.sheetAccess.byId.get(req.params.id);
    if (!access) return res.status(404).json({ error: 'Access entry not found' });

    const link = stmt.sheetLinks.byId.get(access.sheetLinkId);
    const event = link && link.eventId ? rowToEvent(stmt.events.byId.get(link.eventId)) : null;
    const myAccess = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    const isOwner = event && event.userId === req.session.userId;
    const hasFull = myAccess && myAccess.permission === 'full';

    if (!isAdmin && access.userId !== req.session.userId && !isOwner && !hasFull) {
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
        <div style="font-family:sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #eee; border-radius:12px;">
            <h2 style="color:#333; margin-bottom:4px;">See you ${timeLabel}!</h2>
            <p style="color:#555;">Your event is coming up ${timeLabel}.</p>
            <div style="background:#f4f5f7; border-radius:10px; padding:16px 20px; margin:20px 0;">
                <p style="font-weight:700; font-size:16px; color:#1a1a2e; margin:0 0 6px;">${event.name}</p>
                <p style="color:#555; margin:0 0 4px;">📅 ${new Date(event.time).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}${event.endTime ? ` – ${new Date(event.endTime).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}</p>
                <p style="color:#555; margin:0;">📍 ${event.location?.name || ''}${event.location?.address ? ' — ' + event.location.address : ''}</p>
            </div>
            <p style="color:#555; white-space:pre-wrap;">${msg}</p>
            <p style="color:#aaa; font-size:12px; margin-top:24px;">Can't find your ticket? Reply to this email and we'll send it again.</p>
        </div>
    `;
}

// GET reminder settings
app.get('/api/event/:id/reminder', requireAuth, async (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
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
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
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
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
        return res.status(403).send('Not authorized');
    }
    res.type('html').send(buildReminderHtml(event, event.reminderMessage));
});

// Background job: check every 5 minutes for events ~24h away
setInterval(async () => {
    const now = Date.now();

    const due = stmt.events.reminderDue.all().map(rowToEvent).filter(e => {
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

        const replyTo = rowToUser(stmt.users.byId.get(event.userId))?.email;
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
app.get('/api/display/token/:eventId', requireAuth, async (req, res) => {
    const { eventId } = req.params;
    if (!userHasEventAccess(req.session.userId, eventId)) return res.status(403).json({ error: 'Not authorized' });
    let event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.displayToken) {
        const tok = crypto.randomBytes(24).toString('hex');
        stmt.events.setDisplayToken.run(tok, eventId);
        event = rowToEvent(stmt.events.byId.get(eventId));
    }
    res.json({ token: event.displayToken, url: `${BASE_URL}/display.html?token=${event.displayToken}` });
});

// QR code PNG for the display URL (used by web scanner settings page)
app.get('/api/display/qr/:eventId', requireAuth, async (req, res) => {
    const { eventId } = req.params;
    if (!userHasEventAccess(req.session.userId, eventId)) return res.status(403).json({ error: 'Not authorized' });
    let event = rowToEvent(stmt.events.byId.get(eventId));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.displayToken) {
        const tok = crypto.randomBytes(24).toString('hex');
        stmt.events.setDisplayToken.run(tok, eventId);
        event = rowToEvent(stmt.events.byId.get(eventId));
    }
    const pair = req.query.pair || '';
    const url = `${BASE_URL}/display.html?token=${event.displayToken}${pair ? `&pair=${encodeURIComponent(pair)}` : ''}`;
    try {
        const png = await QRCode.toBuffer(url, { width: 400, margin: 2 });
        res.set('Content-Type', 'image/png').set('Cache-Control', 'no-cache').send(png);
    } catch (err) {
        res.status(500).json({ error: 'QR generation failed' });
    }
});

// Regenerate display token (invalidates old links)
app.post('/api/display/token/:eventId/rotate', requireAuth, async (req, res) => {
    const { eventId } = req.params;
    if (!userHasEventAccess(req.session.userId, eventId)) return res.status(403).json({ error: 'Not authorized' });
    const tok = crypto.randomBytes(24).toString('hex');
    stmt.events.setDisplayToken.run(tok, eventId);
    res.json({ token: tok, url: `${BASE_URL}/display.html?token=${tok}` });
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
    const user = rowToUser(stmt.users.byId.get(userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const { eventId } = req.query;

    let eventIds;
    if (eventId) {
        if (!userHasEventAccess(userId, eventId)) return res.status(403).json({ error: 'Not authorized' });
        eventIds = new Set([eventId]);
    } else {
        const allEvents = isAdmin ? stmt.events.all.all().map(rowToEvent) : stmt.events.byUserId.all(userId).map(rowToEvent);
        if (!isAdmin) {
            const myAccess = stmt.sheetAccess.byUserId.all(userId);
            for (const a of myAccess) {
                const link = stmt.sheetLinks.byId.get(a.sheetLinkId);
                if (link?.eventId) allEvents.push(rowToEvent(stmt.events.byId.get(link.eventId)));
            }
        }
        eventIds = new Set(allEvents.filter(Boolean).map(e => e.id));
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
    const user = rowToUser(stmt.users.byId.get(userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    let userEvents = isAdmin ? stmt.events.all.all().map(rowToEvent) : stmt.events.byUserId.all(userId).map(rowToEvent);
    if (!isAdmin) {
        const myAccess = stmt.sheetAccess.byUserId.all(userId);
        for (const a of myAccess) {
            const link = stmt.sheetLinks.byId.get(a.sheetLinkId);
            if (link?.eventId) {
                const ev = rowToEvent(stmt.events.byId.get(link.eventId));
                if (ev && !userEvents.find(e => e.id === ev.id)) userEvents.push(ev);
            }
        }
    }

    const userEventIds = new Set(userEvents.map(e => e.id));

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
    const { pairToken, eventId, platform, deviceName, appVersion, osVersion } = req.body;
    if (!pairToken) return res.status(400).json({ error: 'pairToken required' });

    const ev = eventId ? rowToEvent(stmt.events.byId.get(eventId)) : null;

    upsertScanner(pairToken, {
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
    });

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
    const user = rowToUser(stmt.users.byId.get(userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    const userEventIds = new Set(
        isAdmin
            ? stmt.events.all.all().map(e => e.id)
            : stmt.events.byUserId.all(userId).map(e => e.id)
    );

    const payload = { type: 'notification', title, message, sentAt: new Date().toISOString() };
    let notified = 0;

    let delivered = 0;
    if (pairToken === '*') {
        // Broadcast to all scanners for owned events
        for (const [token, data] of scannerRegistry) {
            if (!data.eventId || userEventIds.has(data.eventId)) {
                if (broadcastToPair(token, payload)) delivered++;
                notified++;
            }
        }
    } else {
        // Notify a specific scanner — verify it belongs to an owned event
        const scannerData = scannerRegistry.get(pairToken);
        if (!scannerData) return res.status(404).json({ error: 'Scanner not found' });
        if (scannerData.eventId && !userEventIds.has(scannerData.eventId)) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        if (broadcastToPair(pairToken, payload)) delivered++;
        notified = 1;
    }

    log('monitor-notify', `[notify] Delivered to ${delivered}/${notified} scanner(s) — by: ${userId}  msg: ${message.slice(0, 60)}`);
    res.json({ ok: true, notified, delivered });
});

// ── Per-Event Metrics ────────────────────────────────────────────────────────

app.get('/api/event/:id/metrics', requireAuth, (req, res) => {
    const event = rowToEvent(stmt.events.byId.get(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = stmt.sheetLinks.byEventId.get(event.id);
    const access = link ? stmt.sheetAccess.byLinkAndUser.get(link.id, req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && !access) {
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

app.get('/api/admin/metrics', requireAuth, (req, res) => {
    const user = rowToUser(stmt.users.byId.get(req.session.userId));
    if (!user || user.email !== process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Admin only' });
    }

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
