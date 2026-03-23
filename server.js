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

import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import bcrypt from 'bcryptjs';

const FileStore = FileStoreFactory(session);

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const ses = new SESClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Rate limiter: ensures at least 100ms between sends (~10/sec max)
let lastSendTime = 0;
async function sendEmail({ to, subject, html }) {
    const now = Date.now();
    const wait = Math.max(0, lastSendTime + 100 - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastSendTime = Date.now();

    return ses.send(new SendEmailCommand({
        Source: process.env.SES_FROM,
        Destination: { ToAddresses: [to] },
        Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body:    { Html:  { Data: html,    Charset: 'UTF-8' } }
        }
    }));
}

app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));
app.use(session({
    store: new FileStore({
        path: './sessions',
        retries: 0
    }),
    secret: process.env.SESSION_SECRET || 'ticket-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Initialize Database
const defaultData = {
    users: [],
    events: [],
    tickets: []
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
// Signup disabled — admin account is created via /api/auth/setup-admin on first run
app.post('/api/auth/signup', (req, res) => {
    res.status(403).json({ error: 'Registration is not open' });
});

// One-time admin setup — only works if no admin account exists yet
app.post('/api/auth/setup-admin', async (req, res) => {
    const { password } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL not set in .env' });
    if (!password)   return res.status(400).json({ error: 'password required' });

    const existing = db.data.users.find(u => u.email === adminEmail);
    if (existing) return res.status(400).json({ error: 'Admin account already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: nanoid(), email: adminEmail, password: hashedPassword };
    await db.update(data => data.users.push(newUser));
    req.session.userId = newUser.id;
    res.json({ success: true, message: `Admin account created for ${adminEmail}` });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = db.data.users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId = user.id;
    res.json({ success: true, user: { id: user.id, email: user.email } });
});

app.get('/api/auth/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    const user = db.data.users.find(u => u.id === req.session.userId);
    res.json({ user: { id: user.id, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
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

    if (!firstName || !lastName || !email || !eventId || !ticketCount) {
        return res.status(400).json({ error: 'firstName, lastName, email, eventId, and ticketCount are required' });
    }

    const event = db.data.events.find(e => e.id === eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const count = parseInt(ticketCount, 10);
    if (isNaN(count) || count < 1 || count > 500) {
        return res.status(400).json({ error: 'ticketCount must be a number between 1 and 500' });
    }

    const fullName = `${firstName} ${lastName}`;
    const registrationId = nanoid(10);
    // customFields: any extra data from the sheet e.g. { "T-Shirt Size": "M", "Meal": "Veg" }
    const customFields = (req.body.customFields && typeof req.body.customFields === 'object')
        ? req.body.customFields : {};

    // Create N tickets — all share a registrationId so they can be bundled
    const newTickets = Array.from({ length: count }, () => ({
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

    try {
        await db.update(({ tickets }) => newTickets.forEach(t => tickets.push(t)));

        // Build one email with all QR codes
        if (process.env.SES_FROM && process.env.AWS_ACCESS_KEY_ID) {
            const ticketLabel = count === 1 ? 'Ticket' : `${count} Tickets`;

            const walletButton = (token) => `
                <a href="${BASE_URL}/api/pass/${token}.pkpass" style="display:inline-block; text-decoration:none;">
                    <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add to Apple Wallet" style="height:44px; display:block;">
                </a>`;

            const qrBlocks = newTickets.map((ticket, i) => `
                <div style="text-align:center; margin:24px 0; padding:20px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa;">
                    <p style="font-weight:600; font-size:14px; color:#555; margin:0 0 12px;">
                        ${count > 1 ? `Ticket ${i + 1} of ${count}` : 'Your Ticket'}
                    </p>
                    <img src="${BASE_URL}/qr/${ticket.token}" alt="QR Code ${i + 1}" style="width:200px; height:200px; display:block; margin:0 auto;" />
                    <p style="font-size:11px; color:#aaa; margin:10px 0 12px;">Token: ${ticket.token}</p>
                    ${walletButton(ticket.token)}
                </div>
            `).join('');

            const addAllButton = count > 1 ? `
                <div style="text-align:center; margin:24px 0 8px;">
                    <p style="font-size:13px; font-weight:600; color:#555; margin:0 0 10px;">Add all ${count} passes to Apple Wallet at once:</p>
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
                        <h2 style="color:#333; margin-bottom:4px;">Hey ${firstName}!</h2>
                        <p style="color:#555;">You're registered for <strong>${event.name}</strong>.</p>
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
                            ${count > 1 ? 'Or add tickets individually below.' : 'Show this QR code at the door.'}
                        </p>
                        <p style="font-size:12px; color:#e53e3e; text-align:center; margin-bottom:4px; font-weight:600;">
                            ⚠️ Each ticket is valid for one-time entry only and cannot be reused once scanned.
                        </p>
                        ${qrBlocks}
                    </div>
                `
            });
        }

        res.json({
            success: true,
            tokens: newTickets.map(t => t.token),
            tickets: newTickets
        });
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
        if (name)         event.name = name;
        if (time)         event.time = time;
        if (color)        event.color = color;
        if (locationName) event.location.name = locationName;
        if (address)      event.location.address = address;
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
app.post('/api/ticket-status', (req, res) => {
    const { tokens } = req.body;
    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ error: 'tokens array required' });
    }
    const statuses = tokens.map(token => {
        const ticket = db.data.tickets.find(t => t.token === token.trim());
        if (!ticket) return { token, status: 'not found' };
        return { token, status: ticket.used_at ? 'scanned' : 'not scanned', used_at: ticket.used_at || null };
    });
    res.json(statuses);
});

// --- Event APIs ---
app.get('/api/events', requireAuth, (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const userEvents = isAdmin
        ? db.data.events
        : db.data.events.filter(e => e.userId === req.session.userId);
    res.json(userEvents);
});

app.get('/api/events/counts', requireAuth, (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const userEvents = isAdmin
        ? db.data.events
        : db.data.events.filter(e => e.userId === req.session.userId);
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
            const pngName = req.file.filename.replace(/\.[^.]+$/, '.png');
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

app.get('/api/event/:id/tickets', requireAuth, (req, res) => {
    const user = db.data.users.find(u => u.id === req.session.userId);
    const isAdmin = user && user.email === process.env.ADMIN_EMAIL;
    const event = db.data.events.find(e => e.id === req.params.id && (isAdmin || e.userId === req.session.userId));
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
    const before = db.data.tickets.length;
    db.data.tickets = db.data.tickets.filter(t => !registrationIds.includes(t.registrationId));
    await db.write();
    res.json({ success: true, deleted: before - db.data.tickets.length });
});

// API: Validate QR Code
// Manual check-in by registrationId (marks all tickets in the group)
app.post('/api/checkin/:registrationId', requireAuth, async (req, res) => {
    const tickets = db.data.tickets.filter(t => t.registrationId === req.params.registrationId);
    if (!tickets.length) return res.status(404).json({ error: 'Not found' });
    const now = new Date().toISOString();
    tickets.forEach(t => { if (!t.used_at) t.used_at = now; });
    await db.write();
    res.json({ success: true });
});

app.post('/api/validate', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const cleanToken = token.startsWith('ticket:') ? token.split(':')[1] : token;
    const ticket = db.data.tickets.find(t => t.token === cleanToken);

    if (!ticket) return res.json({ status: 'invalid', message: 'Invalid ticket' });

    if (ticket.used_at) {
        return res.json({ status: 'used', message: 'Ticket already used', used_at: ticket.used_at, name: ticket.name });
    }

    ticket.used_at = new Date().toISOString();
    await db.write();

    const event = db.data.events.find(e => e.id === ticket.eventId);
    res.json({
        status: 'valid',
        message: `Welcome to ${event ? event.name : 'the event'}!`,
        name: ticket.name,
        email: ticket.email
    });
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

    const pass = await PKPass.from({
        model: modelPath,
        certificates: {
            wwdr: fs.readFileSync(wwdrFile),
            signerCert: fs.readFileSync(signerCertFile),
            signerKey: fs.readFileSync(signerKeyFile),
            signerKeyPassphrase: process.env.PASS_CERT_PASSWORD || undefined,
        }
    }, {
        serialNumber: ticket.token,
        passTypeIdentifier: process.env.PASS_TYPE_ID,
        teamIdentifier: process.env.TEAM_ID,
        description: event.name,
        logoText: event.name,
        backgroundColor: event.color || "rgb(99, 102, 241)",
    });

    pass.voided = !!ticket.used_at;

    pass.setBarcodes({
        format: "PKBarcodeFormatQR",
        message: `ticket:${ticket.token}`,
        messageEncoding: "iso-8859-1"
    });

    const lat = event.location?.lat;
    const lng = event.location?.lng;
    if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
        pass.setLocations({
            latitude: Number(lat),
            longitude: Number(lng),
            relevantText: `${event.name} is starting!`
        });
    }

    // event.name is already in logoText (top bar) — don't repeat it
    pass.primaryFields.push({ key: "attendee", label: "NAME", value: ticket.name });

    const customFields = ticket.customFields || {};
    const cfEntries = Object.entries(customFields);

    // Secondary row: Date + up to 2 custom fields (max 3 total to avoid crowding)
    const eventDate = new Date(event.time);
    if (!Number.isNaN(eventDate.getTime())) {
        pass.secondaryFields.push({
            key: "date", label: "DATE", value: eventDate,
            dateStyle: "PKDateStyleMedium", timeStyle: "PKDateStyleShort"
        });
        const windowStart  = new Date(eventDate.getTime() - 2 * 60 * 60 * 1000);
        const windowEnd    = new Date(eventDate.getTime() + 2 * 60 * 60 * 1000);
        const expiresAt    = new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);
        pass.setRelevantDates([{ startDate: windowStart, endDate: windowEnd }]);
        pass.expirationDate = expiresAt;
    } else {
        pass.secondaryFields.push({ key: "date", label: "DATE", value: String(event.time) });
    }
    if (cfEntries[0]) {
        pass.secondaryFields.push({ key: 'cf_0', label: cfEntries[0][0].toUpperCase(), value: String(cfEntries[0][1]) });
    }

    // Auxiliary row: Location + 1 custom field
    const locName    = event.location?.name || '';
    const locAddress = event.location?.address || '';
    const locValue   = locName && locAddress && locName !== locAddress
        ? `${locName}\n${locAddress}`
        : locName || locAddress;
    if (locValue) {
        pass.auxiliaryFields.push({ key: "loc", label: "LOCATION", value: locValue });
    }
    if (cfEntries[1]) {
        pass.auxiliaryFields.push({ key: 'cf_1', label: cfEntries[1][0].toUpperCase(), value: String(cfEntries[1][1]) });
    }

    if (ticket.used_at) {
        pass.auxiliaryFields.push({ key: "status", label: "STATUS", value: "USED / SCANNED" });
    }

    // Back: remaining custom fields
    cfEntries.slice(2).forEach(([label, value], i) => {
        pass.backFields.push({ key: `cf_back_${i}`, label: label, value: String(value) });
    });

    pass.backFields.push({
        key: 'terms',
        label: 'ENTRY POLICY',
        value: 'This ticket is valid for one-time entry only. Once scanned at the door it cannot be used again.'
    });

    if (event.imageUrl) {
        const imagePath = path.resolve(__dirname, 'public', event.imageUrl.replace(/^\/+/, ''));
        if (fs.existsSync(imagePath)) {
            const [logo1x, logo2x, thumb1x, thumb2x] = await Promise.all([
                sharp(imagePath).resize(160, 50, { fit: 'inside' }).png().toBuffer(),
                sharp(imagePath).resize(320, 100, { fit: 'inside' }).png().toBuffer(),
                sharp(imagePath).resize(90, 90, { fit: 'cover' }).png().toBuffer(),
                sharp(imagePath).resize(180, 180, { fit: 'cover' }).png().toBuffer(),
            ]);
            pass.addBuffer('logo.png', logo1x);
            pass.addBuffer('logo@2x.png', logo2x);
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
    if (!process.env.TEAM_ID)      missing.push('TEAM_ID');
    if (missing.length) return `Missing env vars: ${missing.join(', ')}`;

    const certPath = path.resolve(__dirname, 'certs');
    const files = ['wwdr.pem', 'signer.pem', 'signer.key'];
    const missingFiles = files.filter(f => !fs.existsSync(path.join(certPath, f)));
    if (missingFiles.length) return `Missing cert files: ${missingFiles.join(', ')}`;

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
    if (prereqError) return res.status(503).send(`Apple Wallet not configured: ${prereqError}`);

    try {
        console.log(`🎟️ Generating pass for: ${ticket.name} (${ticket.token})`);
        const buffer = await generatePassBuffer(ticket, event);
        console.log(`📦 Buffer generated: ${buffer.length} bytes`);
        res.set('Content-Type', 'application/vnd.apple.pkpass');
        res.set('Content-Disposition', `attachment; filename="ticket-${ticket.token}.pkpass"`);
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
        return res.redirect(`/api/passes/${tickets[0].token}`);
    }

    const prereqError = checkPassPrereqs();
    if (prereqError) return res.status(503).send(`Apple Wallet not configured: ${prereqError}`);

    const event = db.data.events.find(e => e.id === tickets[0].eventId);
    if (!event) return res.status(404).send('Event not found');

    try {
        console.log(`📦 Generating bundle of ${tickets.length} passes for registration ${registrationId}`);
        const zip = new JSZip();

        for (const ticket of tickets) {
            const passBuffer = await generatePassBuffer(ticket, event);
            zip.file(`ticket-${ticket.token}.pkpass`, passBuffer);
        }

        const bundleBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
        res.set('Content-Type', 'application/vnd.apple.pkpasses');
        res.set('Content-Disposition', `attachment; filename="tickets-${registrationId}.pkpassbundle"`);
        res.set('Content-Length', bundleBuffer.length);
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.send(bundleBuffer);
    } catch (err) {
        console.error('Error generating pass bundle:', err);
        res.status(500).send('Error generating Apple Wallet pass bundle');
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎟️  Ticket Check-in System running at:\n   - Local:    http://localhost:${PORT}\n   - Network:  http://0.0.0.0:${PORT}\n`);
});
