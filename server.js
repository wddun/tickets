import express from 'express';
import { JSONFilePreset } from 'lowdb/node';
import { nanoid } from 'nanoid';
import QRCode from 'qrcode';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
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

function log(tag, msg) {
    console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}
function getIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}

const ses = new SESClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Rate limiter: ensures at least 100ms between sends (~10/sec max)
let lastSendTime = 0;
async function sendEmail({ to, subject, html, registrationId }) {
    const now = Date.now();
    const wait = Math.max(0, lastSendTime + 100 - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastSendTime = Date.now();

    // Inject 1x1 tracking pixel so we can detect email opens
    const tracked = registrationId
        ? html + `\n<img src="${BASE_URL}/api/track/open/${registrationId}" width="1" height="1" style="display:none;opacity:0;" alt="">`
        : html;

    return ses.send(new SendEmailCommand({
        Source: process.env.SES_FROM,
        Destination: { ToAddresses: [to] },
        Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Html: { Data: tracked, Charset: 'UTF-8' } }
        }
    }));
}

// 1x1 transparent GIF for email open tracking
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// ── APNs push for Wallet pass updates ──────────────────────────────────────
let _apnsJwtCache = { token: null, iat: 0 };

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

    const devices = (db.data.walletDevices || []).filter(d => serialNumbers.includes(d.serialNumber));
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
                    'apns-topic': passTypeId, 'apns-push-type': 'background', 'apns-priority': '5',
                    'content-type': 'application/json', 'content-length': '2',
                });
                req.write('{}'); req.end();
                req.on('response', (headers) => {
                    const status = headers[':status'];
                    log('apns', `📱 Push → ${pushToken.slice(0, 8)}… status: ${status}`);
                    if (status === 410) {
                        db.update(data => {
                            if (data.walletDevices) data.walletDevices = data.walletDevices.filter(d => d.pushToken !== pushToken);
                        });
                    }
                    resolve();
                });
                req.on('error', (err) => { log('apns', `❌ Push error: ${err.message}`); resolve(); });
            } catch (e) { resolve(); }
        });
    }
    try { client.close(); } catch {}
}

app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));
app.get('/support', (req, res) => res.redirect('/support.html'));
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

// Initialize Database
const defaultData = {
    users: [],
    events: [],
    tickets: [],
    sheetLinks: [],
    sheetAccess: []
};
const db = await JSONFilePreset(path.resolve(__dirname, 'db.json'), defaultData);

const uploadsDir = path.resolve(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
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

// Ensure arrays exist
if (!db.data.users) db.data.users = [];
if (!db.data.events) db.data.events = [];
if (!db.data.tickets) db.data.tickets = [];
if (!db.data.sheetLinks) db.data.sheetLinks = [];
if (!db.data.sheetAccess) db.data.sheetAccess = [];
if (!db.data.walletDevices) db.data.walletDevices = [];

// Migration: backfill scannerPin on any events that don't have one
const eventsMissingPin = db.data.events.filter(e => !e.scannerPin);
if (eventsMissingPin.length > 0) {
    console.log(`🔄 Adding scanner PINs to ${eventsMissingPin.length} existing event(s)...`);
    await db.update(data => {
        data.events.forEach(e => {
            if (!e.scannerPin) {
                e.scannerPin = Math.floor(100000 + Math.random() * 900000).toString();
            }
        });
    });
    console.log('✅ Scanner PINs assigned. View them in the dashboard.');
}

// Data Migration: If old structure exists, migrate it
if (db.data.event && db.data.events.length === 0) {
    console.log('🔄 Migrating legacy event data...');
    await db.update(data => {
        const legacyEvent = {
            id: 'legacy-event',
            userId: 'admin',
            name: data.event.name,
            time: data.event.time,
            color: data.event.color,
            location: {
                name: 'Main Hall',
                lat: 37.33182, // Apple HQ default for demo
                lng: -122.03118
            }
        };
        data.events.push(legacyEvent);

        // Update existing tickets to point to legacy event
        data.tickets.forEach(t => t.eventId = 'legacy-event');

        // Cleanup old simplified field
        delete data.event;
    });
}

// --- Auth API ---
// Signup enabled — creates a standard staff account
app.post('/api/auth/signup', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        log('signup', `❌ Missing fields — ip: ${getIP(req)}`);
        return res.status(400).json({ error: 'email and password required' });
    }

    const normalizedEmail = email.toLowerCase();
    log('signup', `📝 Attempt — email: ${normalizedEmail}  ip: ${getIP(req)}`);

    const existing = db.data.users.find(u => u.email === normalizedEmail);
    if (existing) {
        log('signup', `⚠️  Already exists — email: ${normalizedEmail}`);
        return res.status(400).json({ error: 'An account with this email already exists. Please log in instead.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: nanoid(), email: normalizedEmail, password: hashedPassword };
    await db.update(data => data.users.push(newUser));
    req.session.userId = newUser.id;
    log('signup', `✅ Account created — email: ${normalizedEmail}  id: ${newUser.id}`);
    res.json({ success: true, user: { id: newUser.id, email: newUser.email } });
});

// One-time admin setup — only works if no admin account exists yet
app.post('/api/auth/setup-admin', async (req, res) => {
    const { password } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL;
    log('setup-admin', `🔧 Attempt — ip: ${getIP(req)}`);
    if (!adminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL not set in .env' });
    if (!password) return res.status(400).json({ error: 'password required' });

    const existing = db.data.users.find(u => u.email === adminEmail);
    if (existing) {
        log('setup-admin', `⚠️  Admin already exists — email: ${adminEmail}`);
        return res.status(400).json({ error: 'Admin account already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: nanoid(), email: adminEmail, password: hashedPassword };
    await db.update(data => data.users.push(newUser));
    req.session.userId = newUser.id;
    log('setup-admin', `✅ Admin created — email: ${adminEmail}  id: ${newUser.id}`);
    res.json({ success: true, message: `Admin account created for ${adminEmail}` });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = (email || '').toLowerCase();
    log('login', `🔑 Attempt — email: ${normalizedEmail}  ip: ${getIP(req)}`);

    const user = db.data.users.find(u => u.email === normalizedEmail);
    if (!user) {
        log('login', `❌ No account found — email: ${normalizedEmail}  ip: ${getIP(req)}`);
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
        log('login', `❌ Wrong password — email: ${normalizedEmail}  ip: ${getIP(req)}`);
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isAdmin = user.email === process.env.ADMIN_EMAIL;
    req.session.userId = user.id;
    log('login', `✅ Success — email: ${normalizedEmail}  id: ${user.id}  role: ${isAdmin ? 'admin' : 'staff'}  ip: ${getIP(req)}`);
    res.json({ success: true, user: { id: user.id, email: user.email } });
});

app.get('/api/auth/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    const user = db.data.users.find(u => u.id === req.session.userId);
    res.json({ user: { id: user.id, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
    const userId = req.session.userId;
    const user = userId ? db.data.users.find(u => u.id === userId) : null;
    log('logout', `👋 User logged out — email: ${user?.email || 'unknown'}  id: ${userId || 'none'}  ip: ${getIP(req)}`);
    req.session.destroy();
    res.json({ success: true });
});

app.delete('/api/auth/account', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const userId = req.session.userId;
    const userToDelete = db.data.users.find(u => u.id === userId);
    log('account', `🗑️  Account deletion — email: ${userToDelete?.email || 'unknown'}  id: ${userId}  ip: ${getIP(req)}`);
    await db.update(data => {
        const eventIds = data.events.filter(e => e.userId === userId).map(e => e.id);
        data.tickets = data.tickets.filter(t => !eventIds.includes(t.eventId));
        data.events = data.events.filter(e => e.userId !== userId);
        data.sheetLinks = (data.sheetLinks || []).filter(l => l.userId !== userId);
        data.sheetAccess = (data.sheetAccess || []).filter(a => a.userId !== userId);
        data.users = data.users.filter(u => u.id !== userId);
    });
    req.session.destroy();
    res.json({ success: true });
});

// Middleware to protect routes
const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.data.users.find(u => u.id === req.session.userId);
    if (!user || user.email !== process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// Email open tracking pixel (public — no auth, called by email clients)
app.get('/api/track/open/:registrationId', async (req, res) => {
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(TRANSPARENT_GIF);
    // Record after responding so we don't slow the email client
    const { registrationId } = req.params;
    const tickets = db.data.tickets.filter(t => t.registrationId === registrationId);
    if (tickets.length && !tickets[0].email_opened_at) {
        const now = new Date().toISOString();
        await db.update(data => {
            data.tickets.filter(t => t.registrationId === registrationId)
                .forEach(t => { if (!t.email_opened_at) t.email_opened_at = now; });
        });
        log('email-open', `📬 Opened — regId: ${registrationId}  name: ${tickets[0].name}`);
    }
});

// Serve protected pages for admin only (scanner is PIN-protected itself, so excluded)
app.get('/admin.html', (req, res) => res.redirect('/dashboard.html'));
app.get('/dashboard.html', (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login.html');
    const user = db.data.users.find(u => u.id === req.session.userId);
    if (!user || user.email !== process.env.ADMIN_EMAIL) return res.redirect('/login.html');
    next();
});

// Block the public register page entirely
app.get('/register.html', (req, res) => res.redirect('/login.html'));

// API: Register Ticket — disabled, registration is handled via Google Sheets
app.post('/api/register', (req, res) => {
    res.status(403).json({ error: 'Public registration is not available' });
});

app.post('/api/register_disabled', async (req, res) => {
    const { name, email, eventId } = req.body;

    if (!name || !email || !eventId) {
        return res.status(400).json({ error: 'Name, email and eventId are required' });
    }

    const event = db.data.events.find(e => e.id === eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const token = nanoid(12);
    const newTicket = {
        id: nanoid(8),
        token,
        eventId,
        name,
        email,
        created_at: new Date().toISOString(),
        used_at: null
    };

    try {
        await db.update(({ tickets }) => tickets.push(newTicket));

        // Generate QR Data URL for email
        const qrContent = `ticket:${token}`;
        const qrDataUrl = await QRCode.toDataURL(qrContent);

        // Send Email
        if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 're_your_api_key') {
            await resend.emails.send({
                from: process.env.RESEND_FROM || 'onboarding@resend.dev',
                to: email,
                subject: `Your Ticket for ${event.name}`,
                html: `
                    <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                        <h2 style="color: #333;">Hello ${name}!</h2>
                        <p>Your registration for <strong>${event.name}</strong> was successful.</p>
                        ${event.imageUrl ? `
                        <div style="text-align: center; margin: 20px 0;">
                            <img src="${BASE_URL}${event.imageUrl}" alt="${event.name}" style="max-width: 100%; border-radius: 12px;" />
                        </div>` : ''}
                        <div style="text-align: center; margin: 30px 0;">
                            <img src="${BASE_URL}/qr/${token}" alt="QR Code" style="width: 200px; height: 200px;" />
                        </div>
                        <div style="text-align: center; margin-bottom: 20px;">
                            <a href="${BASE_URL}/api/pass/${token}.pkpass">
                                <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add to Apple Wallet" style="height: 40px;">
                            </a>
                        </div>
                        <p style="font-size: 12px; color: #666;">Token: ${token}</p>
                        <p>Location: ${event.location.name}</p>
                        <p>Time: ${new Date(event.time).toLocaleString()}</p>
                    </div>
                `
            });
        }

        res.json({ success: true, ticket: newTicket, qr: qrDataUrl });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Failed to process registration' });
    }
});

// API: Bulk Register Tickets (for Google Sheets integration)
app.post('/api/register-bulk', async (req, res) => {
    const { firstName, lastName, email, eventId, ticketCount } = req.body;
    const isResend = req.body.resend === true;

    if (!firstName || !lastName || !email || !eventId || !ticketCount) {
        return res.status(400).json({ error: 'firstName, lastName, email, eventId, and ticketCount are required' });
    }

    log('bulk-register', `📋 ${isResend ? 'Resend' : 'New'} registration — email: ${email}  name: ${firstName} ${lastName}  tickets: ${ticketCount}  eventId: ${eventId}  ip: ${getIP(req)}`);

    const event = db.data.events.find(e => e.id === eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const count = parseInt(ticketCount, 10);
    if (isNaN(count) || count < 1 || count > 500) {
        return res.status(400).json({ error: 'ticketCount must be a number between 1 and 500' });
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
        const matched = db.data.tickets.find(t => tokenSet.has(t.token));
        if (matched) {
            existingTickets = db.data.tickets.filter(t => t.registrationId === matched.registrationId);
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

            if (count > existingCount) {
                // Add more tickets with same registrationId
                const newTickets = Array.from({ length: count - existingCount }, () => ({
                    id: nanoid(8),
                    token: nanoid(12),
                    registrationId,
                    eventId,
                    name: fullName,
                    firstName,
                    lastName,
                    email,
                    customFields,
                    created_at: new Date().toISOString(),
                    used_at: null
                }));
                await db.update(({ tickets }) => {
                    // Update existing
                    existingTickets.forEach(t => {
                        const dbTicket = tickets.find(dt => dt.id === t.id);
                        if (dbTicket) {
                            dbTicket.name = fullName;
                            dbTicket.firstName = firstName;
                            dbTicket.lastName = lastName;
                            dbTicket.customFields = customFields;
                        }
                    });
                    // Add new
                    newTickets.forEach(t => tickets.push(t));
                });
                ticketsToSend = [...existingTickets, ...newTickets];
                countChanged = { from: existingCount, to: count };
            } else if (count < existingCount) {
                // Remove extra tickets — prefer unused ones first
                const unused = existingTickets.filter(t => !t.used_at);
                const used = existingTickets.filter(t => t.used_at);
                const toRemove = [...unused, ...used].slice(0, existingCount - count).map(t => t.id);
                const toKeep = existingTickets.filter(t => !toRemove.includes(t.id));
                await db.update(({ tickets }) => {
                    // Remove extras
                    toRemove.forEach(id => {
                        const idx = tickets.findIndex(t => t.id === id);
                        if (idx !== -1) tickets.splice(idx, 1);
                    });
                    // Update remaining
                    toKeep.forEach(t => {
                        const dbTicket = tickets.find(dt => dt.id === t.id);
                        if (dbTicket) {
                            dbTicket.name = fullName;
                            dbTicket.firstName = firstName;
                            dbTicket.lastName = lastName;
                            dbTicket.customFields = customFields;
                        }
                    });
                });
                ticketsToSend = toKeep;
                countChanged = { from: existingCount, to: count };
            } else {
                // Same count — just update name/customFields
                ticketsToSend = existingTickets;
                await db.update(({ tickets }) => {
                    ticketsToSend.forEach(t => {
                        const dbTicket = tickets.find(dt => dt.id === t.id);
                        if (dbTicket) {
                            dbTicket.name = fullName;
                            dbTicket.firstName = firstName;
                            dbTicket.lastName = lastName;
                            dbTicket.email = email;
                            dbTicket.customFields = customFields;
                        }
                    });
                });
            }
        } else {
            // New row (or resend with no existing tickets) — always create fresh tickets
            const registrationId = nanoid(10);
            ticketsToSend = Array.from({ length: count }, () => ({
                id: nanoid(8),
                token: nanoid(12),
                registrationId,
                eventId,
                name: fullName,
                firstName,
                lastName,
                email,
                customFields,
                created_at: new Date().toISOString(),
                used_at: null
            }));
            await db.update(({ tickets }) => ticketsToSend.forEach(t => tickets.push(t)));
        }

        // Build one email with all QR codes
        if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
            const actualCount = ticketsToSend.length;
            const ticketLabel = actualCount === 1 ? 'Ticket' : `${actualCount} Tickets`;
            const isUpdate = isResend && changes.length > 0;

            const walletButton = (token) => `
                <a href="${BASE_URL}/api/pass/${token}.pkpass" style="display:inline-block; text-decoration:none;">
                    <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add to Apple Wallet" style="height:44px; display:block;">
                </a>`;

            const qrBlocks = ticketsToSend.map((ticket, i) => `
                <div style="text-align:center; margin:24px 0; padding:20px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa;">
                    <p style="font-weight:600; font-size:14px; color:#555; margin:0 0 12px;">
                        ${actualCount > 1 ? `Ticket ${i + 1} of ${actualCount}` : 'Your Ticket'}
                    </p>
                    <img src="${BASE_URL}/qr/${ticket.token}" alt="QR Code ${i + 1}" style="width:200px; height:200px; display:block; margin:0 auto;" />
                    <p style="font-size:11px; color:#aaa; margin:10px 0 12px;">Token: ${ticket.token}</p>
                    ${walletButton(ticket.token)}
                </div>
            `).join('');

            const addAllButton = actualCount > 1 ? `
                <div style="text-align:center; margin:24px 0 8px;">
                    <p style="font-size:13px; font-weight:600; color:#555; margin:0 0 10px;">Add all ${actualCount} passes to Apple Wallet at once:</p>
                    <a href="${BASE_URL}/api/passes/bundle/${ticketsToSend[0].registrationId}" style="display:inline-block; text-decoration:none;">
                        <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add All to Apple Wallet" style="height:44px; display:block;">
                    </a>
                </div>
            ` : '';

            await sendEmail({
                to: email,
                subject: isUpdate ? `Your registration for ${event.name} has been updated` : `Your ${ticketLabel} for ${event.name}`,
                html: `
                    <div style="font-family:sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #eee; border-radius:12px;">
                        <h2 style="color:#333; margin-bottom:4px;">Hey ${firstName}!</h2>
                        <p style="color:#555;">${isUpdate ? `Your registration for <strong>${event.name}</strong> has been updated.` : `You're registered for <strong>${event.name}</strong>.`}</p>
                        ${isUpdate ? `
                        <div style="background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; padding:14px 18px; margin:16px 0;">
                            <p style="font-weight:600; color:#92400e; margin:0 0 8px;">What changed:</p>
                            <ul style="margin:0; padding-left:20px; color:#78350f;">
                                ${changes.map(c => `<li style="margin:4px 0;">${c}</li>`).join('')}
                            </ul>
                        </div>` : ''}
                        ${event.imageUrl ? `
                        <div style="text-align:center; margin:20px 0;">
                            <img src="${BASE_URL}${event.imageUrl}" alt="${event.name}" style="max-width:100%; border-radius:12px;" />
                        </div>` : ''}
                        <p style="color:#555;">📍 ${event.location.address
                        ? `<a href="https://maps.apple.com/?q=${encodeURIComponent(event.location.address)}" style="color:#555;">${event.location.name || event.location.address}</a>`
                        : event.location.name}</p>
                        <p style="color:#555;">🕐 ${new Date(event.time).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}</p>
                        ${Object.keys(customFields).length ? `
                        <table style="width:100%; border-collapse:collapse; margin:16px 0; font-size:14px;">
                            ${Object.entries(customFields).map(([k, v]) => `
                            <tr>
                                <td style="padding:7px 12px; color:#888; font-weight:600; width:40%; border-bottom:1px solid #f0f0f0;">${k}</td>
                                <td style="padding:7px 12px; color:#333; border-bottom:1px solid #f0f0f0;">${v}</td>
                            </tr>`).join('')}
                        </table>` : ''}
                        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">
                        ${addAllButton}
                        <p style="font-size:13px; color:#888; text-align:center; margin-bottom:4px;">
                            ${actualCount > 1 ? 'Or add tickets individually below.' : 'Show this QR code at the door.'}
                        </p>
                        <p style="font-size:12px; color:#e53e3e; text-align:center; margin-bottom:4px; font-weight:600;">
                            ⚠️ Each ticket is valid for one-time entry only and cannot be reused once scanned.
                        </p>
                        ${qrBlocks}
                    </div>
                `,
                registrationId: ticketsToSend[0].registrationId
            });
            log('bulk-register', `📧 Email ${isUpdate ? 'updated' : 'sent'} → ${email}  name: ${fullName}  tickets: ${actualCount}  event: ${event.name}  regId: ${ticketsToSend[0].registrationId}`);
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
    const { eventId, name, time, color, locationName, address, lat, lng, driveFileId } = req.body;

    if (!eventId) return res.status(400).json({ error: 'eventId is required' });

    const event = db.data.events.find(e => e.id === eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    try {
        if (name) event.name = name;
        if (time) event.time = time;
        if (color) event.color = color;
        if (locationName) event.location.name = locationName;
        if (address) event.location.address = address;
        if (lat != null && !isNaN(parseFloat(lat))) event.location.lat = parseFloat(lat);
        if (lng != null && !isNaN(parseFloat(lng))) event.location.lng = parseFloat(lng);

        if (driveFileId) {
            try { event.imageUrl = await fetchAndSaveImage(driveFileId); }
            catch (imgErr) { console.warn('Image update failed:', imgErr.message); }
        }

        await db.write();
        res.json({ success: true, event });
    } catch (error) {
        console.error('Update event error:', error);
        res.status(500).json({ error: 'Failed to update event' });
    }
});

// API: Create Event from Google Sheet (no auth required — keep your server URL private)
app.post('/api/sheet/create-event', async (req, res) => {
    const { name, time, color, locationName, address, lat, lng, driveFileId } = req.body;

    if (!name || !time) {
        return res.status(400).json({ error: 'name and time are required' });
    }

    // Find the owner account so events appear in the dashboard
    const ownerEmail = process.env.SHEET_USER_EMAIL;
    const owner = ownerEmail ? db.data.users.find(u => u.email === ownerEmail) : null;
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
        color: color || 'rgb(99, 102, 241)',
        imageUrl,
        scannerPin: Math.floor(100000 + Math.random() * 900000).toString(), // 6-digit PIN
        location: {
            name: locationName || address || 'Venue',
            address: address || '',
            lat: parseFloat(lat) || 0,
            lng: parseFloat(lng) || 0
        }
    };

    await db.update(data => data.events.push(newEvent));

    res.json({ success: true, eventId: newEvent.id, event: newEvent });
});

// API: Batch ticket scan status (for Google Sheet)
// Cache: keyed by sorted token list, expires after 60 seconds
const ticketStatusCache = new Map(); // key -> { result, expiresAt }
const TICKET_STATUS_TTL = 60_000;

app.post('/api/ticket-status', (req, res) => {
    const { tokens } = req.body;
    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ error: 'tokens array required' });
    }

    const trimmed = tokens.map(t => t.trim()).filter(Boolean);
    const cacheKey = trimmed.slice().sort().join(',');
    const cached = ticketStatusCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.result);
    }

    // Build index for O(1) lookups instead of scanning the full array per token
    const byToken = new Map(db.data.tickets.map(t => [t.token, t]));
    const result = trimmed.map(token => {
        const ticket = byToken.get(token);
        if (!ticket) return { token, status: 'not found' };
        return { token, status: ticket.used_at ? 'scanned' : 'not scanned', used_at: ticket.used_at || null };
    });

    ticketStatusCache.set(cacheKey, { result, expiresAt: Date.now() + TICKET_STATUS_TTL });
    res.json(result);
});

app.get('/api/events', requireAuth, (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (isAdmin) return res.json(db.data.events);

    // Events the user created + events they have sheetAccess to
    const myAccess = db.data.sheetAccess.filter(a => a.userId === req.session.userId);
    const linkedEventIds = new Set(
        myAccess.map(a => {
            const link = db.data.sheetLinks.find(l => l.id === a.sheetLinkId);
            return link ? link.eventId : null;
        }).filter(Boolean)
    );
    const userEvents = db.data.events.filter(e => e.userId === req.session.userId || linkedEventIds.has(e.id));
    res.json(userEvents);
});

app.get('/api/events/counts', requireAuth, (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    let userEvents;
    if (isAdmin) {
        userEvents = db.data.events;
    } else {
        const myAccess = db.data.sheetAccess.filter(a => a.userId === req.session.userId);
        const linkedEventIds = new Set(
            myAccess.map(a => {
                const link = db.data.sheetLinks.find(l => l.id === a.sheetLinkId);
                return link ? link.eventId : null;
            }).filter(Boolean)
        );
        userEvents = db.data.events.filter(e => e.userId === req.session.userId || linkedEventIds.has(e.id));
    }
    const counts = {};
    userEvents.forEach(e => {
        const tickets = db.data.tickets.filter(t => t.eventId === e.id);
        counts[e.id] = { total: tickets.length, scanned: tickets.filter(t => t.used_at).length };
    });
    res.json(counts);
});

app.get('/api/event/:id', (req, res) => {
    const event = db.data.events.find(e => e.id === req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
});

app.post('/api/events', requireAuth, upload.single('image'), async (req, res) => {
    const { name, time, color, locationName, lat, lng } = req.body;
    let imageUrl = null;

    if (req.file) {
        if (req.file.mimetype === 'image/jpeg') {
            const pngName = req.file.filename.replace(/.[^.]+$/, '.png');
            const pngPath = path.join(uploadsDir, pngName);
            await sharp(req.file.path).png().toFile(pngPath);
            await fs.promises.unlink(req.file.path);
            imageUrl = `/uploads/${pngName}`;
        } else {
            imageUrl = `/uploads/${req.file.filename}`;
        }
    }

    const newEvent = {
        id: nanoid(10),
        userId: req.session.userId,
        name,
        time,
        color,
        imageUrl,
        scannerPin: Math.floor(100000 + Math.random() * 900000).toString(), // 6-digit PIN
        location: {
            name: locationName || 'Venue',
            lat: parseFloat(lat) || 37.33182,
            lng: parseFloat(lng) || -122.03118
        }
    };
    await db.update(data => data.events.push(newEvent));
    res.json(newEvent);
});

// Edit event details
app.put('/api/event/:id', requireAuth, upload.single('image'), async (req, res) => {
    const event = db.data.events.find(e => e.id === req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (!isAdmin && event.userId !== req.session.userId) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const { name, time, color, locationName, locationAddress, lat, lng } = req.body;

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

    await db.update(data => {
        const ev = data.events.find(e => e.id === req.params.id);
        if (!ev) return;
        if (name) ev.name = name;
        if (time) ev.time = time;
        if (color) ev.color = color;
        ev.imageUrl = imageUrl;
        ev.location = {
            name: locationName || ev.location?.name || 'Venue',
            address: locationAddress || ev.location?.address || '',
            lat: parseFloat(lat) || ev.location?.lat || 37.33182,
            lng: parseFloat(lng) || ev.location?.lng || -122.03118,
        };
    });

    const updated = db.data.events.find(e => e.id === req.params.id);
    log('event-edit', `✏️  Updated event — name: ${updated.name}  id: ${updated.id}  by: ${req.session.userId}`);
    res.json(updated);
});

// Update event custom field definitions
app.patch('/api/event/:id', requireAuth, async (req, res) => {
    const { customFields } = req.body;
    if (!Array.isArray(customFields)) return res.status(400).json({ error: 'customFields must be an array of strings' });

    const event = db.data.events.find(e => e.id === req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (!isAdmin && event.userId !== req.session.userId) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const cleaned = [...new Set(customFields.map(f => String(f).trim()).filter(Boolean))];
    await db.update(data => {
        const ev = data.events.find(e => e.id === req.params.id);
        if (ev) ev.customFields = cleaned;
    });

    log('event-settings', `✏️  Updated customFields — event: ${event.name}  fields: [${cleaned.join(', ')}]  by: ${req.session.userId}`);
    res.json({ success: true, customFields: cleaned });
});

app.get('/api/event/:id/tickets', requireAuth, (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    // Check if user has sheetAccess to this event
    let hasSheetAccess = false;
    if (!isAdmin) {
        const myAccess = db.data.sheetAccess.filter(a => a.userId === req.session.userId);
        hasSheetAccess = myAccess.some(a => {
            const link = db.data.sheetLinks.find(l => l.id === a.sheetLinkId);
            return link && link.eventId === req.params.id;
        });
    }

    const event = db.data.events.find(e => e.id === req.params.id && (isAdmin || e.userId === req.session.userId || hasSheetAccess));
    if (!event) return res.status(401).json({ error: 'Unauthorized or not found' });
    const tickets = db.data.tickets.filter(t => t.eventId === req.params.id);
    res.json(tickets);
});

// Delete an event
app.delete('/api/event/:id', requireAuth, async (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const eventIndex = db.data.events.findIndex(e => e.id === req.params.id && (isAdmin || e.userId === req.session.userId));
    if (eventIndex === -1) return res.status(404).json({ error: 'Event not found' });

    // Remove the event
    db.data.events.splice(eventIndex, 1);

    // Clean up associated tickets
    db.data.tickets = db.data.tickets.filter(t => t.eventId !== req.params.id);

    await db.write();
    res.json({ success: true });
});

// Bulk delete events
app.delete('/api/events/bulk', requireAuth, async (req, res) => {
    const { eventIds } = req.body;
    if (!Array.isArray(eventIds) || !eventIds.length) return res.status(400).json({ error: 'eventIds required' });
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const allowed = new Set(
        db.data.events.filter(e => eventIds.includes(e.id) && (isAdmin || e.userId === req.session.userId)).map(e => e.id)
    );
    db.data.events = db.data.events.filter(e => !allowed.has(e.id));
    db.data.tickets = db.data.tickets.filter(t => !allowed.has(t.eventId));
    await db.write();
    res.json({ success: true, deleted: allowed.size });
});

// Bulk delete registrations (by registrationId)
app.delete('/api/registrations/bulk', requireAuth, async (req, res) => {
    const { registrationIds } = req.body;
    if (!Array.isArray(registrationIds) || !registrationIds.length) return res.status(400).json({ error: 'registrationIds required' });
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const before = db.data.tickets.length;

    const eventIds = new Set(db.data.tickets.filter(t => registrationIds.includes(t.registrationId)).map(t => t.eventId));
    let allowedRegistrationIds = new Set();

    for (const eventId of eventIds) {
        const event = db.data.events.find(e => e.id === eventId);
        if (!event) continue;
        const link = db.data.sheetLinks.find(l => l.eventId === eventId);
        const access = link ? db.data.sheetAccess.find(a => a.sheetLinkId === link.id && a.userId === req.session.userId) : null;
        if (isAdmin || event.userId === req.session.userId || (access && access.permission === 'full')) {
            db.data.tickets.filter(t => registrationIds.includes(t.registrationId) && t.eventId === eventId)
                .forEach(t => allowedRegistrationIds.add(t.registrationId));
        }
    }

    db.data.tickets = db.data.tickets.filter(t => !allowedRegistrationIds.has(t.registrationId));
    await db.write();
    res.json({ success: true, deleted: before - db.data.tickets.length });
});

// Create ticket manually
app.post('/api/event/:id/ticket', requireAuth, async (req, res) => {
    const { name, email, ticketCount, customFields = {} } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const event = db.data.events.find(e => e.id === req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = db.data.sheetLinks.find(l => l.eventId === event.id);
    const access = link ? db.data.sheetAccess.find(a => a.sheetLinkId === link.id && a.userId === req.session.userId) : null;

    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
        return res.status(403).json({ error: 'Not authorized to create tickets' });
    }

    const count = Math.max(1, parseInt(ticketCount) || 1);
    const registrationId = nanoid(10);
    const newTickets = [];

    for (let i = 0; i < count; i++) {
        newTickets.push({
            id: nanoid(8),
            token: nanoid(12),
            eventId: event.id,
            registrationId,
            name,
            firstName: name.split(' ')[0],
            lastName: name.split(' ').slice(1).join(' '),
            email,
            customFields: customFields || {},
            created_at: new Date().toISOString(),
            used_at: null
        });
    }

    await db.update(data => data.tickets.push(...newTickets));
    log('ticket-create', `🎟️  Created ${newTickets.length} ticket(s) — name: ${name}  email: ${email}  event: ${event.name} (${event.id})  regId: ${registrationId}  by: ${req.session.userId}`);

    if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        const actualCount = newTickets.length;
        const ticketLabel = actualCount === 1 ? 'Ticket' : `${actualCount} Tickets`;

        const walletButton = (token) => `
            <a href="${BASE_URL}/api/pass/${token}.pkpass" style="display:inline-block; text-decoration:none;">
                <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add to Apple Wallet" style="height:44px; display:block;">
            </a>`;

        const qrBlocks = newTickets.map((ticket, i) => `
            <div style="text-align:center; margin:24px 0; padding:20px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa;">
                <p style="font-weight:600; font-size:14px; color:#555; margin:0 0 12px;">
                    ${actualCount > 1 ? `Ticket ${i + 1} of ${actualCount}` : 'Your Ticket'}
                </p>
                <img src="${BASE_URL}/qr/${ticket.token}" alt="QR Code ${i + 1}" style="width:200px; height:200px; display:block; margin:0 auto;" />
                <p style="font-size:11px; color:#aaa; margin:10px 0 12px;">Token: ${ticket.token}</p>
                ${walletButton(ticket.token)}
            </div>
        `).join('');

        const addAllButton = actualCount > 1 ? `
            <div style="text-align:center; margin:24px 0 8px;">
                <p style="font-size:13px; font-weight:600; color:#555; margin:0 0 10px;">Add all ${actualCount} passes to Apple Wallet at once:</p>
                <a href="${BASE_URL}/api/passes/bundle/${registrationId}" style="display:inline-block; text-decoration:none;">
                    <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add All to Apple Wallet" style="height:44px; display:block;">
                </a>
            </div>
        ` : '';

        await sendEmail({
            to: email,
            subject: `Your ${ticketLabel} for ${event.name}`,
            html: `
                <div style="font-family:sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #eee; border-radius:12px;">
                    <h2 style="color:#333; margin-bottom:4px;">Hey ${newTickets[0].firstName}!</h2>
                    <p style="color:#555;">You're registered for <strong>${event.name}</strong>.</p>
                    <p style="color:#555;">📍 ${event.location.name}</p>
                    <p style="color:#555;">🕐 ${new Date(event.time).toLocaleString()}</p>
                    ${qrBlocks}
                    ${addAllButton}
                </div>
            `,
            registrationId
        }).catch(err => {
            log('ticket-create', `❌ Email send failed — email: ${email}  err: ${err.message}`);
        });
    }

    res.json({ success: true, ticket: newTickets[0], tickets: newTickets });
});

// Edit ticket manually
app.put('/api/ticket/:id', requireAuth, async (req, res) => {
    const { name, email, customFields = {}, noEmail } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    let updatedTickets = [];
    let event = null;
    await db.update(data => {
        const queryTicket = data.tickets.find(t => t.id === req.params.id);
        if (!queryTicket) throw new Error('Not found');
        event = data.events.find(e => e.id === queryTicket.eventId);
        if (!event) throw new Error('Event not found');

        const user = data.users.find(u => u.id === req.session.userId);
        const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
        const link = data.sheetLinks.find(l => l.eventId === event.id);
        const access = link ? data.sheetAccess.find(a => a.sheetLinkId === link.id && a.userId === req.session.userId) : null;

        if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
            throw new Error('Forbidden');
        }

        const groupTickets = data.tickets.filter(t => t.registrationId === queryTicket.registrationId);
        groupTickets.forEach(ticket => {
            ticket.name = name;
            ticket.firstName = name.split(' ')[0];
            ticket.lastName = name.split(' ').slice(1).join(' ');
            ticket.email = email;
            ticket.customFields = customFields;
            updatedTickets.push(ticket);
        });
    }).catch(e => {
        if (e.message === 'Forbidden') res.status(403).json({ error: 'Not authorized to edit tickets' });
        else res.status(404).json({ error: e.message });
    });

    if (!updatedTickets.length) return; // already sent response via catch

    // Stamp updated_at so PassKit web service can detect changes
    const editedAt = new Date().toISOString();
    await db.update(data => {
        data.tickets.filter(t => t.registrationId === updatedTickets[0].registrationId)
            .forEach(t => { t.updated_at = editedAt; });
    });

    log('ticket-edit', `✏️  Edited ${updatedTickets.length} ticket(s) — name: ${name}  email: ${email}  event: ${event.name} (${event.id})  regId: ${updatedTickets[0].registrationId}  by: ${req.session.userId}`);

    if (!noEmail && process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
        const actualCount = updatedTickets.length;

        const walletButton = (token) => `
            <a href="${BASE_URL}/api/pass/${token}.pkpass" style="display:inline-block; text-decoration:none;">
                <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add to Apple Wallet" style="height:44px; display:block;">
            </a>`;

        const qrBlocks = updatedTickets.map((ticket, i) => `
            <div style="text-align:center; margin:24px 0; padding:20px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa;">
                <p style="font-weight:600; font-size:14px; color:#555; margin:0 0 12px;">
                    ${actualCount > 1 ? `Updated Ticket ${i + 1} of ${actualCount}` : 'Your Updated Ticket'}
                </p>
                <img src="${BASE_URL}/qr/${ticket.token}" alt="QR Code ${i + 1}" style="width:200px; height:200px; display:block; margin:0 auto;" />
                <p style="font-size:11px; color:#aaa; margin:10px 0 12px;">Token: ${ticket.token}</p>
                ${walletButton(ticket.token)}
            </div>
        `).join('');

        const addAllButton = actualCount > 1 ? `
            <div style="text-align:center; margin:24px 0 8px;">
                <p style="font-size:13px; font-weight:600; color:#555; margin:0 0 10px;">Add all ${actualCount} updated passes to Apple Wallet at once:</p>
                <a href="${BASE_URL}/api/passes/bundle/${updatedTickets[0].registrationId}" style="display:inline-block; text-decoration:none;">
                    <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add All to Apple Wallet" style="height:44px; display:block;">
                </a>
            </div>
        ` : '';

        await sendEmail({
            to: email,
            subject: `Updated registration for ${event.name}`,
            html: `
                <div style="font-family:sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #eee; border-radius:12px;">
                    <h2 style="color:#333; margin-bottom:4px;">Hey ${updatedTickets[0].firstName}!</h2>
                    <p style="color:#555;">Your registration details for <strong>${event.name}</strong> have been updated by an admin.</p>
                    <p style="color:#555;">📍 ${event.location.name}</p>
                    <p style="color:#555;">🕐 ${new Date(event.time).toLocaleString()}</p>
                    ${qrBlocks}
                    ${addAllButton}
                </div>
            `,
            registrationId: updatedTickets[0].registrationId
        }).catch(err => {
            log('ticket-edit', `❌ Email send failed — email: ${email}  err: ${err.message}`);
        });
    } else if (noEmail) {
        log('ticket-edit', `⏭️  Email skipped (save only)`);
    } else {
        log('ticket-edit', `⚠️  Email skipped (SES not configured)`);
    }

    res.json({ success: true, tickets: updatedTickets });
    // Push wallet update to any registered devices (fire-and-forget)
    pushWalletUpdate(updatedTickets.map(t => t.token)).catch(() => {});
});

// Resend ticket email without changing any data
app.post('/api/ticket/:id/resend', requireAuth, async (req, res) => {
    const ticket = db.data.tickets.find(t => t.id === req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const event = db.data.events.find(e => e.id === ticket.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = db.data.sheetLinks.find(l => l.eventId === event.id);
    const access = link ? db.data.sheetAccess.find(a => a.sheetLinkId === link.id && a.userId === req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const groupTickets = db.data.tickets.filter(t => t.registrationId === ticket.registrationId);
    log('resend-email', `📧 Resending ${groupTickets.length} ticket(s) — email: ${ticket.email}  event: ${event.name}  regId: ${ticket.registrationId}  by: ${req.session.userId}`);

    if (!process.env.SES_FROM || !process.env.AWS_ACCESS_KEY_ID) {
        return res.status(503).json({ error: 'Email not configured' });
    }

    const actualCount = groupTickets.length;
    const walletButton = (token) => `
        <a href="${BASE_URL}/api/pass/${token}.pkpass" style="display:inline-block; text-decoration:none;">
            <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add to Apple Wallet" style="height:44px; display:block;">
        </a>`;

    const qrBlocks = groupTickets.map((t, i) => `
        <div style="text-align:center; margin:24px 0; padding:20px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa;">
            <p style="font-weight:600; font-size:14px; color:#555; margin:0 0 12px;">
                ${actualCount > 1 ? `Ticket ${i + 1} of ${actualCount}` : 'Your Ticket'}
            </p>
            <img src="${BASE_URL}/qr/${t.token}" alt="QR Code ${i + 1}" style="width:200px; height:200px; display:block; margin:0 auto;" />
            <p style="font-size:11px; color:#aaa; margin:10px 0 12px;">Token: ${t.token}</p>
            ${walletButton(t.token)}
        </div>
    `).join('');

    const addAllButton = actualCount > 1 ? `
        <div style="text-align:center; margin:24px 0 8px;">
            <p style="font-size:13px; font-weight:600; color:#555; margin:0 0 10px;">Add all ${actualCount} passes to Apple Wallet at once:</p>
            <a href="${BASE_URL}/api/passes/bundle/${ticket.registrationId}" style="display:inline-block; text-decoration:none;">
                <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add All to Apple Wallet" style="height:44px; display:block;">
            </a>
        </div>
    ` : '';

    await sendEmail({
        to: ticket.email,
        subject: `Your ticket${actualCount > 1 ? 's' : ''} for ${event.name} (resent)`,
        html: `
            <div style="font-family:sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #eee; border-radius:12px;">
                <h2 style="color:#333; margin-bottom:4px;">Hey ${groupTickets[0].firstName}!</h2>
                <p style="color:#555;">Here's a copy of your registration for <strong>${event.name}</strong>.</p>
                <p style="color:#555;">📍 ${event.location.name}</p>
                <p style="color:#555;">🕐 ${new Date(event.time).toLocaleString()}</p>
                ${qrBlocks}
                ${addAllButton}
            </div>
        `,
        registrationId: ticket.registrationId
    }).catch(err => {
        log('resend-email', `❌ Send failed — email: ${ticket.email}  err: ${err.message}`);
        return res.status(500).json({ error: 'Failed to send email' });
    });

    res.json({ success: true, count: actualCount });
});

// Print-friendly email preview
app.get('/api/ticket/:id/preview', requireAuth, async (req, res) => {
    const ticket = db.data.tickets.find(t => t.id === req.params.id);
    if (!ticket) return res.status(404).send('Ticket not found');

    const event = db.data.events.find(e => e.id === ticket.eventId);
    if (!event) return res.status(404).send('Event not found');

    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const link = db.data.sheetLinks.find(l => l.eventId === event.id);
    const access = link ? db.data.sheetAccess.find(a => a.sheetLinkId === link.id && a.userId === req.session.userId) : null;
    if (!isAdmin && event.userId !== req.session.userId && (!access || access.permission !== 'full')) {
        return res.status(403).send('Not authorized');
    }

    const groupTickets = db.data.tickets.filter(t => t.registrationId === ticket.registrationId);
    const actualCount = groupTickets.length;

    const qrBlocks = groupTickets.map((t, i) => `
        <div style="text-align:center; margin:24px 0; padding:20px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa; break-inside:avoid;">
            <p style="font-weight:600; font-size:14px; color:#555; margin:0 0 12px;">
                ${actualCount > 1 ? `Ticket ${i + 1} of ${actualCount}` : 'Ticket'}
            </p>
            <img src="${BASE_URL}/qr/${t.token}" alt="QR Code" style="width:180px; height:180px; display:block; margin:0 auto;" />
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
<title>Ticket — ${ticket.name} — ${event.name}</title>
<style>
    body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 24px; color: #333; }
    @media print { body { margin: 0; } .no-print { display: none; } }
</style>
</head>
<body>
<div class="no-print" style="margin-bottom:20px;">
    <button onclick="window.print()" style="padding:8px 18px;background:#6366f1;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;">🖨️ Print</button>
</div>
<h2 style="margin-bottom:4px;">${ticket.name}</h2>
<p style="color:#888;margin:0 0 4px;">${ticket.email}</p>
<p style="color:#888;margin:0 0 16px;">Registered ${new Date(groupTickets[0].created_at).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}</p>
<hr style="border:none;border-top:1px solid #eee;margin-bottom:16px;">
<p style="margin:0 0 4px;"><strong>${event.name}</strong></p>
<p style="color:#555;margin:0 0 4px;">📍 ${event.location?.name || ''}${event.location?.address ? ' — ' + event.location.address : ''}</p>
<p style="color:#555;margin:0 0 20px;">🕐 ${new Date(event.time).toLocaleString('en-US', { month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true })}</p>
${customFieldRows ? `<table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">${customFieldRows}</table>` : ''}
${qrBlocks}
</body>
</html>`);
});

// API: Validate QR Code
// Manual check-in by registrationId (marks all tickets in the group)
app.post('/api/checkin/:registrationId', requireAuth, async (req, res) => {
    const { registrationId } = req.params;

    // Try matching by registrationId first (check in all tickets for this registration)
    let tickets = db.data.tickets.filter(t => t.registrationId === registrationId);

    // Fall back to matching a single ticket by its own id
    if (!tickets.length) {
        const single = db.data.tickets.find(t => t.id === registrationId);
        if (single) tickets = [single];
    }

    if (!tickets.length) {
        log('checkin', `❌ FAILED — no ticket/registration found for id: ${registrationId}  by: ${req.session.userId}`);
        return res.status(404).json({ error: 'Not found' });
    }

    const checkinEvent = db.data.events.find(e => e.id === tickets[0].eventId);
    const now = new Date().toISOString();
    let checkedInCount = 0;
    tickets.forEach(t => {
        if (!t.used_at) {
            t.used_at = now;
            checkedInCount++;
        }
    });

    if (checkedInCount === 0) {
        log('checkin', `⚠️  Already checked in — regId: ${registrationId}  name: ${tickets[0]?.name}  event: ${checkinEvent?.name}  by: ${req.session.userId}`);
    } else {
        log('checkin', `✅ Checked in ${checkedInCount}/${tickets.length} ticket(s) — regId: ${registrationId}  name: ${tickets[0]?.name}  event: ${checkinEvent?.name}  by: ${req.session.userId}`);
    }

    tickets.forEach(t => { t.updated_at = now; });
    await db.write();
    ticketStatusCache.clear();
    res.json({ success: true });
    pushWalletUpdate(tickets.map(t => t.token)).catch(() => {});
});

app.delete('/api/checkin/:registrationId', requireAuth, async (req, res) => {
    const { registrationId } = req.params;

    let tickets = db.data.tickets.filter(t => t.registrationId === registrationId);
    if (!tickets.length) {
        const single = db.data.tickets.find(t => t.id === registrationId);
        if (single) tickets = [single];
    }

    if (!tickets.length) return res.status(404).json({ error: 'Not found' });

    // Only admin or event owner can undo checkin
    const event = db.data.events.find(e => e.id === tickets[0].eventId);
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    if (!isAdmin && (!event || event.userId !== req.session.userId)) {
        return res.status(403).json({ error: 'Only event owners or admins can undo check-ins' });
    }

    let clearedCount = 0;
    tickets.forEach(t => {
        if (t.used_at) { t.used_at = null; clearedCount++; }
    });

    const uncheckinNow = new Date().toISOString();
    tickets.forEach(t => { t.updated_at = uncheckinNow; });
    log('uncheckin', `↩️  Cleared ${clearedCount} ticket(s) — regId: ${registrationId}  name: ${tickets[0]?.name}  event: ${event?.name}  by: ${req.session.userId}`);
    await db.write();
    ticketStatusCache.clear();
    res.json({ success: true });
    pushWalletUpdate(tickets.map(t => t.token)).catch(() => {});
});

app.post('/api/validate', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const cleanToken = (token.startsWith('ticket:') ? token.split(':')[1] : token).trim();
    const ticket = db.data.tickets.find(t => t.token === cleanToken);

    if (!ticket) {
        log('validate', `❌ INVALID token: ${cleanToken}  ip: ${getIP(req)}`);
        return res.json({ status: 'invalid', message: 'Invalid ticket' });
    }

    const event = db.data.events.find(e => e.id === ticket.eventId);
    const ticketFields = {
        name: ticket.name, firstName: ticket.firstName ?? null, lastName: ticket.lastName ?? null,
        email: ticket.email, customFields: ticket.customFields ?? null,
        ticketId: ticket.id, registrationId: ticket.registrationId,
        eventId: ticket.eventId, eventName: event ? event.name : null,
    };

    if (ticket.used_at) {
        log('validate', `⚠️  ALREADY USED — ticket: ${ticket.id}  name: ${ticket.name}  event: ${event?.name}  used_at: ${ticket.used_at}  ip: ${getIP(req)}`);
        return res.json({ status: 'used', message: 'Ticket already used', used_at: ticket.used_at, ...ticketFields });
    }

    const validatedAt = new Date().toISOString();
    ticket.used_at = validatedAt;
    ticket.updated_at = validatedAt;
    await db.write();
    ticketStatusCache.clear();

    log('validate', `✅ VALID — ticket: ${ticket.id}  name: ${ticket.name}  event: ${event?.name}  ip: ${getIP(req)}`);
    res.json({ status: 'valid', message: `Welcome to ${event ? event.name : 'the event'} !`, ...ticketFields });
    pushWalletUpdate([ticket.token]).catch(() => {});
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

// Shared helper — builds and returns a .pkpass Buffer for a ticket+event
async function generatePassBuffer(ticket, event) {
    const certPath = path.resolve(__dirname, 'certs');
    const wwdrFile = path.join(certPath, 'wwdr.pem');
    const signerCertFile = path.join(certPath, 'signer.pem');
    const signerKeyFile = path.join(certPath, 'signer.key');
    const modelPath = path.resolve(__dirname, 'pass-assets.pass');

    const passOverride = {
        serialNumber: ticket.token,
        passTypeIdentifier: process.env.PASS_TYPE_ID,
        teamIdentifier: process.env.TEAM_ID,
        description: event.name,
        logoText: ticket.used_at ? "✓ CHECKED IN" : event.name,
        backgroundColor: ticket.used_at ? "rgb(90, 90, 90)" : (event.color || "rgb(99, 102, 241)"),
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

    pass.voided = !!ticket.used_at;

    if (!ticket.used_at) {
        pass.setBarcodes({
            format: "PKBarcodeFormatQR",
            message: `ticket:${ticket.token}`,
            messageEncoding: "iso-8859-1"
        });
    }

    const lat = event.location?.lat;
    const lng = event.location?.lng;
    if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
        pass.setLocations({
            latitude: Number(lat),
            longitude: Number(lng),
            relevantText: `${event.name} is starting!`
        });
    }

    // When checked in, show name + greyed-out event name; logoText already says "✓ CHECKED IN"
    pass.primaryFields.push({ key: "attendee", label: ticket.used_at ? "CHECKED IN" : "NAME", value: ticket.name });

    const customFields = ticket.customFields || {};
    const cfEntries = Object.entries(customFields);

    const eventDate = new Date(event.time);
    const hasNote = !!cfEntries[0];

    // If notes exist, keep date in the header and notes in secondary.
    // If no notes, place date in secondary (so the row isn't empty).
    if (hasNote) {
        if (!Number.isNaN(eventDate.getTime())) {
            pass.headerFields.push({
                key: "date", label: "DATE", value: eventDate,
                dateStyle: "PKDateStyleMedium", timeStyle: "PKDateStyleShort"
            });
            const windowStart = new Date(eventDate.getTime() - 2 * 60 * 60 * 1000);
            const windowEnd = new Date(eventDate.getTime() + 2 * 60 * 60 * 1000);
            const expiresAt = new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);
            pass.setRelevantDates([{ startDate: windowStart, endDate: windowEnd }]);
            pass.expirationDate = expiresAt;
        } else {
            pass.headerFields.push({ key: "date", label: "DATE", value: String(event.time) });
        }
        pass.secondaryFields.push({ key: 'cf_0', label: cfEntries[0][0].toUpperCase(), value: String(cfEntries[0][1]) });
    } else {
        if (!Number.isNaN(eventDate.getTime())) {
            pass.secondaryFields.push({
                key: "date", label: "DATE", value: eventDate,
                dateStyle: "PKDateStyleMedium", timeStyle: "PKDateStyleShort"
            });
            const windowStart = new Date(eventDate.getTime() - 2 * 60 * 60 * 1000);
            const windowEnd = new Date(eventDate.getTime() + 2 * 60 * 60 * 1000);
            const expiresAt = new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);
            pass.setRelevantDates([{ startDate: windowStart, endDate: windowEnd }]);
            pass.expirationDate = expiresAt;
        } else {
            pass.secondaryFields.push({ key: "date", label: "DATE", value: String(event.time) });
        }
    }

    // Auxiliary row: Location (two lines)
    const locName = event.location?.name || '';
    const locAddress = event.location?.address || '';
    const locValue = locName && locAddress && locName !== locAddress
        ? `${locName} n${locAddress} `
        : locName || locAddress;
    if (locValue) {
        pass.auxiliaryFields.push({ key: "loc", label: "LOCATION", value: locValue });
    }


    // Back: remaining custom fields
    cfEntries.slice(1).forEach(([label, value], i) => {
        pass.backFields.push({ key: `cf_back_${i} `, label: label, value: String(value) });
    });

    if (locAddress && (!locValue || locValue === locName)) {
        pass.backFields.push({
            key: 'venue_address',
            label: locName || 'VENUE',
            value: locAddress
        });
    }

    pass.backFields.push({
        key: 'terms',
        label: 'ENTRY POLICY',
        value: 'This ticket is valid for one-time entry only. Once scanned at the door it cannot be used again.'
    });

    if (event.imageUrl) {
        const imagePath = path.resolve(__dirname, 'public', event.imageUrl.replace(/^\/+/, ''));
        if (fs.existsSync(imagePath)) {
            const [thumb1x, thumb2x] = await Promise.all([
                sharp(imagePath).resize(90, 90, { fit: 'cover' }).png().toBuffer(),
                sharp(imagePath).resize(180, 180, { fit: 'cover' }).png().toBuffer(),
            ]);
            // Keep the default pass logo for the top-left; only swap the right-side thumbnail.
            pass.addBuffer('thumbnail.png', thumb1x);
            pass.addBuffer('thumbnail@2x.png', thumb2x);
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
    const ticket = db.data.tickets.find(t => t.token === token);
    if (!ticket) return res.status(404).send('Ticket not found');

    const event = db.data.events.find(e => e.id === ticket.eventId);
    if (!event) return res.status(404).send('Event not found');

    const prereqError = checkPassPrereqs();
    if (prereqError) return res.status(503).send(`Apple Wallet not configured: ${prereqError} `);

    try {
        log('wallet-download', `🎟️  Generating pass — name: ${ticket.name}  token: ${ticket.token}`);
        const buffer = await generatePassBuffer(ticket, event);
        log('wallet-download', `📦 Buffer ${buffer.length} bytes — token: ${ticket.token}`);

        // Record first download
        if (!ticket.wallet_downloaded_at) {
            await db.update(data => {
                const t = data.tickets.find(t => t.token === token);
                if (t) t.wallet_downloaded_at = new Date().toISOString();
            });
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
    const tickets = db.data.tickets.filter(t => t.registrationId === registrationId);
    if (!tickets.length) return res.status(404).send('No tickets found for this registration');

    // Single ticket — redirect to the standard pass endpoint
    if (tickets.length === 1) {
        return res.redirect(`/ api / passes / ${tickets[0].token} `);
    }

    const prereqError = checkPassPrereqs();
    if (prereqError) return res.status(503).send(`Apple Wallet not configured: ${prereqError} `);

    const event = db.data.events.find(e => e.id === tickets[0].eventId);
    if (!event) return res.status(404).send('Event not found');

    try {
        console.log(`📦 Generating bundle of ${tickets.length} passes for registration ${registrationId}`);
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
    const ticket = db.data.tickets.find(t => t.token === serialNumber);
    if (!ticket) return null;
    if (ticket.id + ticket.token !== token) return null; // must match passOverride.authenticationToken
    return ticket;
}

// Register a device to receive push updates for a pass
app.post('/api/wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    const { deviceId, serialNumber } = req.params;
    const ticket = walletAuth(req, serialNumber);
    if (!ticket) return res.status(401).send();

    const { pushToken } = req.body;
    if (!pushToken) return res.status(400).send();

    if (!db.data.walletDevices) await db.update(d => { d.walletDevices = []; });

    const existing = db.data.walletDevices.find(d => d.deviceId === deviceId && d.serialNumber === serialNumber);
    if (existing) {
        if (existing.pushToken !== pushToken) {
            await db.update(data => {
                const d = data.walletDevices.find(d => d.deviceId === deviceId && d.serialNumber === serialNumber);
                if (d) d.pushToken = pushToken;
            });
        }
        return res.status(200).send();
    }

    await db.update(data => {
        data.walletDevices.push({ id: nanoid(8), deviceId, passTypeId: req.params.passTypeId, serialNumber, pushToken, registeredAt: new Date().toISOString() });
    });
    log('wallet-register', `📲 Device registered — serial: ${serialNumber.slice(0, 8)}…  device: ${deviceId.slice(0, 8)}…`);
    res.status(201).send();
});

// Unregister a device
app.delete('/api/wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    const { deviceId, serialNumber } = req.params;
    const ticket = walletAuth(req, serialNumber);
    if (!ticket) return res.status(401).send();

    await db.update(data => {
        if (data.walletDevices) data.walletDevices = data.walletDevices.filter(d => !(d.deviceId === deviceId && d.serialNumber === serialNumber));
    });
    log('wallet-register', `📲 Device unregistered — serial: ${serialNumber.slice(0, 8)}…`);
    res.status(200).send();
});

// List passes updated since a given date for a device
app.get('/api/wallet/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
    const { deviceId } = req.params;
    const deviceEntries = (db.data.walletDevices || []).filter(d => d.deviceId === deviceId);
    if (!deviceEntries.length) return res.status(404).send();

    let serialNumbers = deviceEntries.map(d => d.serialNumber);

    const since = req.query.passesUpdatedSince;
    if (since) {
        const sinceDate = new Date(since);
        serialNumbers = serialNumbers.filter(sn => {
            const t = db.data.tickets.find(t => t.token === sn);
            return t && new Date(t.updated_at || t.created_at) > sinceDate;
        });
    }

    if (!serialNumbers.length) return res.status(204).send();
    res.json({ serialNumbers, lastUpdated: new Date().toISOString() });
});

// Return the latest version of a pass
app.get('/api/wallet/v1/passes/:passTypeId/:serialNumber', async (req, res) => {
    const { serialNumber } = req.params;
    const ticket = walletAuth(req, serialNumber);
    if (!ticket) return res.status(401).send();

    const event = db.data.events.find(e => e.id === ticket.eventId);
    if (!event) return res.status(404).send();

    const prereqError = checkPassPrereqs();
    if (prereqError) return res.status(503).send();

    try {
        const buffer = await generatePassBuffer(ticket, event);
        res.set('Content-Type', 'application/vnd.apple.pkpass');
        res.set('Last-Modified', new Date(ticket.updated_at || ticket.created_at).toUTCString());
        res.set('Cache-Control', 'no-store');
        res.send(buffer);
    } catch (err) {
        res.status(500).send();
    }
});

// Receive device error logs
app.post('/api/wallet/v1/log', (req, res) => {
    const { logs } = req.body || {};
    if (Array.isArray(logs)) logs.forEach(l => log('wallet-device', `📱 ${l}`));
    res.status(200).send();
});

// ============================================================
//  SHEET LINKING — allows Google Sheet users to link a sheet
//  to their website account so events appear in their dashboard
// ============================================================

// Generate a sharing link for a Google Sheet (called from Apps Script)
app.post('/api/sheet/generate-link', async (req, res) => {
    const { spreadsheetId, sheetName, eventId } = req.body;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId is required' });

    // Reuse existing link for same spreadsheet
    let link = db.data.sheetLinks.find(l => l.spreadsheetId === spreadsheetId);
    if (link) {
        // Update event ID and name if provided
        if (eventId) link.eventId = eventId;
        if (sheetName) link.sheetName = sheetName;
        await db.write();
        return res.json({ success: true, linkUrl: `${BASE_URL} /link/${link.token} `, token: link.token });
    }

    link = {
        id: nanoid(10),
        token: nanoid(20),
        spreadsheetId,
        sheetName: sheetName || 'Untitled Sheet',
        eventId: eventId || null,
        createdAt: new Date().toISOString()
    };
    await db.update(data => data.sheetLinks.push(link));
    res.json({ success: true, linkUrl: `${BASE_URL} /link/${link.token} `, token: link.token });
});

// Redirect /link/:token → link.html?token=...
app.get('/link/:token', (req, res) => {
    res.redirect(`/ link.html ? token = ${req.params.token} `);
});

// Get info about a link token (public)
app.get('/api/sheet/link-info/:token', (req, res) => {
    const link = db.data.sheetLinks.find(l => l.token === req.params.token);
    if (!link) return res.status(404).json({ error: 'Link not found or expired' });

    const event = link.eventId ? db.data.events.find(e => e.id === link.eventId) : null;
    let alreadyLinked = false;

    if (req.session.userId) {
        alreadyLinked = !!db.data.sheetAccess.find(
            a => a.sheetLinkId === link.id && a.userId === req.session.userId
        );
    }

    // Count how many users have access
    const accessCount = db.data.sheetAccess.filter(a => a.sheetLinkId === link.id).length;

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

    const link = db.data.sheetLinks.find(l => l.token === token);
    if (!link) return res.status(404).json({ error: 'Link not found' });

    // Check if already claimed
    const existing = db.data.sheetAccess.find(
        a => a.sheetLinkId === link.id && a.userId === req.session.userId
    );
    if (existing) return res.json({ success: true, message: 'Already linked' });

    const access = {
        id: nanoid(10),
        userId: req.session.userId,
        sheetLinkId: link.id,
        claimedAt: new Date().toISOString()
    };
    await db.update(data => data.sheetAccess.push(access));

    res.json({ success: true, message: 'Sheet linked to your account!' });
});

// Allow account creation during claim flow (since signup is normally disabled)
app.post('/api/auth/signup-for-link', async (req, res) => {
    const { email, password, token } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (!token) return res.status(400).json({ error: 'link token required' });

    // Verify the link token is valid
    const link = db.data.sheetLinks.find(l => l.token === token);
    if (!link) return res.status(400).json({ error: 'Invalid link token' });

    // Check if account already exists
    const existing = db.data.users.find(u => u.email === email.toLowerCase());
    if (existing) return res.status(400).json({ error: 'An account with this email already exists. Please log in instead.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: nanoid(), email: email.toLowerCase(), password: hashedPassword };
    await db.update(data => data.users.push(newUser));
    req.session.userId = newUser.id;
    res.json({ success: true, user: { id: newUser.id, email: newUser.email } });
});

// My Rooms — get all rooms/events the current user has access to
app.get('/api/my-rooms', requireAuth, (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    if (isAdmin) {
        // Admin sees all events with all access entries
        const rooms = db.data.events.map(event => {
            const link = db.data.sheetLinks.find(l => l.eventId === event.id);
            const accessEntries = link
                ? db.data.sheetAccess.filter(a => a.sheetLinkId === link.id).map(a => {
                    const u = db.data.users.find(u2 => u2.id === a.userId);
                    return { id: a.id, email: u ? u.email : 'Unknown', claimedAt: a.claimedAt };
                })
                : [];
            return { event, sheetLink: link || null, access: accessEntries, isAdmin: true };
        });
        return res.json(rooms);
    }

    // Regular user: events they have access to via sheetAccess
    const myAccess = db.data.sheetAccess.filter(a => a.userId === req.session.userId);
    const rooms = myAccess.map(access => {
        const link = db.data.sheetLinks.find(l => l.id === access.sheetLinkId);
        if (!link) return null;
        const event = link.eventId ? db.data.events.find(e => e.id === link.eventId) : null;
        return { event, sheetLink: link, accessId: access.id, claimedAt: access.claimedAt };
    }).filter(Boolean);

    res.json(rooms);
});

// Get access entries for a specific event (for settings cog in dashboard)
app.get('/api/event/:id/access', requireAuth, (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const event = db.data.events.find(e => e.id === req.params.id);
    const link = db.data.sheetLinks.find(l => l.eventId === req.params.id);

    let hasAccess = false;
    if (isAdmin || (event && event.userId === req.session.userId)) hasAccess = true;
    else if (link) {
        const myAccess = db.data.sheetAccess.find(a => a.sheetLinkId === link.id && a.userId === req.session.userId);
        if (myAccess && myAccess.permission === 'full') hasAccess = true;
    }

    if (!hasAccess) return res.status(403).json({ error: 'Admin access required' });

    if (!link) return res.json({ access: [], linkUrl: null });

    const accessEntries = db.data.sheetAccess
        .filter(a => a.sheetLinkId === link.id)
        .map(a => {
            const u = db.data.users.find(u2 => u2.id === a.userId);
            return { id: a.id, email: u ? u.email : 'Unknown', claimedAt: a.claimedAt, permission: a.permission || 'view' };
        });

    res.json({ access: accessEntries, linkUrl: BASE_URL + '/link/' + link.token });
});

app.post('/api/sheet/share', requireAuth, async (req, res) => {
    const { eventId, email, permission } = req.body;
    if (!eventId || !email || !permission) return res.status(400).json({ error: 'Missing fields' });

    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const event = db.data.events.find(e => e.id === eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    let link = db.data.sheetLinks.find(l => l.eventId === eventId);
    if (!link) {
        link = { id: nanoid(10), token: nanoid(20), spreadsheetId: 'manual', sheetName: event.name, eventId: event.id, createdAt: new Date().toISOString() };
        db.data.sheetLinks.push(link);
    }

    const myAccess = db.data.sheetAccess.find(a => a.sheetLinkId === link.id && a.userId === req.session.userId);

    if (!isAdmin && event.userId !== req.session.userId && (!myAccess || myAccess.permission !== 'full')) {
        return res.status(403).json({ error: 'Permission denied to share room' });
    }

    const targetUser = db.data.users.find(u => u.email === email.toLowerCase());
    if (!targetUser) return res.status(404).json({ error: 'User ' + email + ' does not have an account. They must register first.' });
    if (targetUser.id === req.session.userId) return res.status(400).json({ error: 'Cannot share with yourself' });

    let access = db.data.sheetAccess.find(a => a.sheetLinkId === link.id && a.userId === targetUser.id);
    if (access) {
        access.permission = permission;
    } else {
        access = { id: nanoid(10), userId: targetUser.id, sheetLinkId: link.id, claimedAt: new Date().toISOString(), permission };
        db.data.sheetAccess.push(access);
    }
    await db.write();
    res.json({ success: true, message: 'Access granted' });
});

// Revoke access to a room
app.delete('/api/sheet/access/:id', requireAuth, async (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;

    const accessIdx = db.data.sheetAccess.findIndex(a => a.id === req.params.id);
    if (accessIdx === -1) return res.status(404).json({ error: 'Access entry not found' });

    const access = db.data.sheetAccess[accessIdx];
    const link = db.data.sheetLinks.find(l => l.id === access.sheetLinkId);
    const event = link && link.eventId ? db.data.events.find(e => e.id === link.eventId) : null;
    const myAccess = link ? db.data.sheetAccess.find(a => a.sheetLinkId === link.id && a.userId === req.session.userId) : null;
    const isOwner = event && event.userId === req.session.userId;
    const hasFull = myAccess && myAccess.permission === 'full';

    if (!isAdmin && access.userId !== req.session.userId && !isOwner && !hasFull) {
        return res.status(403).json({ error: 'Not authorized to revoke others' });
    }

    db.data.sheetAccess.splice(accessIdx, 1);
    await db.write();
    res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`n🎟️  Ticket Check -in System running at: n - Local: http://localhost:${PORT}n   - Network:  http://0.0.0.0:${PORT}n`);
});
