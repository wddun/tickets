import express from 'express';
import { JSONFilePreset } from 'lowdb/node';
import { nanoid } from 'nanoid';
import QRCode from 'qrcode';
import { Resend } from 'resend';
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
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json());
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
app.get(['/dashboard.html', '/admin.html'], (req, res, next) => {
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
    if (isNaN(count) || count < 1 || count > 20) {
        return res.status(400).json({ error: 'ticketCount must be a number between 1 and 20' });
    }

    const fullName = `${firstName} ${lastName}`;
    const registrationId = nanoid(10);

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
        created_at: new Date().toISOString(),
        used_at: null
    }));

    try {
        await db.update(({ tickets }) => newTickets.forEach(t => tickets.push(t)));

        // Build one email with all QR codes
        if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 're_your_api_key') {
            const ticketLabel = count === 1 ? 'Ticket' : `${count} Tickets`;

            const qrBlocks = newTickets.map((ticket, i) => `
                <div style="text-align:center; margin:24px 0; padding:20px; border:1px solid #e5e7eb; border-radius:12px; background:#fafafa;">
                    <p style="font-weight:600; font-size:14px; color:#555; margin:0 0 12px;">
                        ${count > 1 ? `Ticket ${i + 1} of ${count}` : 'Your Ticket'}
                    </p>
                    <img src="${BASE_URL}/qr/${ticket.token}" alt="QR Code ${i + 1}" style="width:200px; height:200px; display:block; margin:0 auto;" />
                    <p style="font-size:11px; color:#aaa; margin:10px 0 12px;">Token: ${ticket.token}</p>
                    <a href="${BASE_URL}/api/pass/${ticket.token}.pkpass">
                        <img src="${BASE_URL}/apple-wallet-badge.png" alt="Add to Apple Wallet" style="height:38px;">
                    </a>
                </div>
            `).join('');

            const addAllButton = count > 1 ? `
                <div style="text-align:center; margin:24px 0 8px;">
                    <a href="${BASE_URL}/api/passes/bundle/${registrationId}" style="display:inline-block; text-decoration:none;">
                        <table cellpadding="0" cellspacing="0" border="0" style="display:inline-table; background:#000; border-radius:8px; overflow:hidden;">
                            <tr>
                                <td style="padding:11px 8px 11px 18px; vertical-align:middle;">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="27" viewBox="0 0 814 1000">
                                        <path fill="#fff" d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 790.7 0 663 0 541.8c0-207.5 135.4-317.3 269-317.3 71 0 130.5 46.4 174.9 46.4 42.7 0 109.2-49.9 189.2-49.9 30.6-.1 111.2 2.6 166 79zm-168-180.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/>
                                    </svg>
                                </td>
                                <td style="padding:11px 18px 11px 4px; vertical-align:middle; border-left:1px solid #333;">
                                    <div style="color:#fff; font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif; line-height:1.2;">
                                        <div style="font-size:11px; font-weight:400; letter-spacing:0.4px; opacity:0.85;">Add All ${count} Passes to</div>
                                        <div style="font-size:17px; font-weight:600; letter-spacing:0.2px;">Apple Wallet</div>
                                    </div>
                                </td>
                            </tr>
                        </table>
                    </a>
                    <p style="font-size:11px; color:#aaa; margin-top:10px;">Adds all ${count} tickets to your Wallet at once</p>
                </div>
            ` : '';

            await resend.emails.send({
                from: process.env.RESEND_FROM || 'onboarding@resend.dev',
                to: email,
                subject: `Your ${ticketLabel} for ${event.name}`,
                html: `
                    <div style="font-family:sans-serif; max-width:600px; margin:auto; padding:24px; border:1px solid #eee; border-radius:12px;">
                        <h2 style="color:#333; margin-bottom:4px;">Hey ${firstName}!</h2>
                        <p style="color:#555;">You're registered for <strong>${event.name}</strong> with <strong>${ticketLabel}</strong>.</p>
                        ${event.imageUrl ? `
                        <div style="text-align:center; margin:20px 0;">
                            <img src="${BASE_URL}${event.imageUrl}" alt="${event.name}" style="max-width:100%; border-radius:12px;" />
                        </div>` : ''}
                        <p style="color:#555;">📍 ${event.location.name}</p>
                        <p style="color:#555;">🕐 ${new Date(event.time).toLocaleString()}</p>
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

// API: Create Event from Google Sheet (no auth required — keep your server URL private)
app.post('/api/sheet/create-event', async (req, res) => {
    const { name, time, color, locationName, address, lat, lng, imageBase64, imageExt } = req.body;

    if (!name || !time) {
        return res.status(400).json({ error: 'name and time are required' });
    }

    // Find the owner account so events appear in the dashboard
    const ownerEmail = process.env.SHEET_USER_EMAIL;
    const owner = ownerEmail ? db.data.users.find(u => u.email === ownerEmail) : null;
    const userId = owner ? owner.id : 'sheet';

    let imageUrl = null;
    if (imageBase64) {
        try {
            const ext = (imageExt || 'png').toLowerCase().replace('jpeg', 'jpg');
            const filename = `${Date.now()}-${nanoid(8)}.${ext}`;
            const filepath = path.join(uploadsDir, filename);
            await fs.promises.writeFile(filepath, Buffer.from(imageBase64, 'base64'));

            if (ext === 'jpg') {
                const pngName = filename.replace(/\.[^.]+$/, '.png');
                const pngPath = path.join(uploadsDir, pngName);
                await sharp(filepath).png().toFile(pngPath);
                await fs.promises.unlink(filepath);
                imageUrl = `/uploads/${pngName}`;
            } else {
                imageUrl = `/uploads/${filename}`;
            }
        } catch (imgErr) {
            console.warn('Image save failed, continuing without image:', imgErr.message);
        }
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
    const event = db.data.events.find(e => e.id === req.params.id && e.userId === req.session.userId);
    if (!event) return res.status(401).json({ error: 'Unauthorized or not found' });
    const tickets = db.data.tickets.filter(t => t.eventId === req.params.id);
    res.json(tickets);
});

// Delete an event
app.delete('/api/event/:id', requireAuth, async (req, res) => {
    const eventIndex = db.data.events.findIndex(e => e.id === req.params.id && e.userId === req.session.userId);
    if (eventIndex === -1) return res.status(404).json({ error: 'Event not found' });

    // Remove the event
    db.data.events.splice(eventIndex, 1);

    // Clean up associated tickets
    db.data.tickets = db.data.tickets.filter(t => t.eventId !== req.params.id);

    await db.write();
    res.json({ success: true });
});

// API: Validate QR Code
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

    pass.primaryFields.push({ key: "event", label: "EVENT", value: event.name });
    pass.secondaryFields.push({ key: "attendee", label: "ATTENDEE", value: ticket.name });

    const eventDate = new Date(event.time);
    if (!Number.isNaN(eventDate.getTime())) {
        pass.auxiliaryFields.push({
            key: "date", label: "DATE", value: eventDate,
            dateStyle: "PKDateStyleMedium", timeStyle: "PKDateStyleShort"
        });
        const windowStart = new Date(eventDate.getTime() - 2 * 60 * 60 * 1000);
        const windowEnd   = new Date(eventDate.getTime() + 2 * 60 * 60 * 1000);
        pass.setRelevantDates([{ startDate: windowStart, endDate: windowEnd }]);
        pass.expirationDate = windowEnd;
    } else {
        pass.auxiliaryFields.push({ key: "date", label: "DATE", value: String(event.time) });
    }

    if (event.location?.name) {
        pass.auxiliaryFields.push({ key: "loc", label: "LOCATION", value: event.location.name });
    }

    if (ticket.used_at) {
        pass.auxiliaryFields.push({ key: "status", label: "STATUS", value: "USED / SCANNED" });
    }

    pass.backFields.push({
        key: 'terms',
        label: 'ENTRY POLICY',
        value: 'This ticket is valid for one-time entry only. Once scanned at the door it cannot be used again.'
    });

    if (event.imageUrl) {
        const imagePath = path.resolve(__dirname, 'public', event.imageUrl.replace(/^\/+/, ''));
        if (fs.existsSync(imagePath)) {
            const imageBuffer = fs.readFileSync(imagePath);
            pass.addBuffer('thumbnail.png', imageBuffer);
            pass.addBuffer('thumbnail@2x.png', imageBuffer);
            pass.addBuffer('logo.png', imageBuffer);
            pass.addBuffer('logo@2x.png', imageBuffer);
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
