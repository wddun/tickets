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
app.post('/api/auth/signup', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const existing = db.data.users.find(u => u.email === email);
    if (existing) return res.status(400).json({ error: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: nanoid(), email, password: hashedPassword };

    await db.update(data => data.users.push(newUser));
    req.session.userId = newUser.id;
    res.json({ success: true, user: { id: newUser.id, email: newUser.email } });
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

// API: Register Ticket
app.post('/api/register', async (req, res) => {
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

    // Create N tickets
    const newTickets = Array.from({ length: count }, () => ({
        id: nanoid(8),
        token: nanoid(12),
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
                        <p style="font-size:13px; color:#888; text-align:center; margin-bottom:4px;">
                            ${count > 1 ? 'Scan each QR code separately at the door.' : 'Show this QR code at the door.'}
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

// API: Create Event from Google Sheet (API key auth, no session required)
app.post('/api/sheet/create-event', async (req, res) => {
    const { apiKey, name, time, color, locationName, address, lat, lng, imageBase64, imageExt } = req.body;

    if (!apiKey || apiKey !== process.env.SHEET_API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }

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

// --- Event APIs ---
app.get('/api/events', requireAuth, (req, res) => {
    const userEvents = db.data.events.filter(e => e.userId === req.session.userId);
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

    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }

    // Standardize token format (handle "ticket:<token>" if scanned as is)
    const cleanToken = token.startsWith('ticket:') ? token.split(':')[1] : token;

    const ticket = db.data.tickets.find(t => t.token === cleanToken);

    if (!ticket) {
        return res.json({ status: 'invalid', message: 'Invalid ticket' });
    }

    if (ticket.used_at) {
        return res.json({
            status: 'used',
            message: 'Ticket already used',
            used_at: ticket.used_at,
            name: ticket.name
        });
    }

    // Mark as used
    ticket.used_at = new Date().toISOString();
    await db.write();

    const event = db.data.events.find(e => e.id === ticket.eventId);

    res.json({
        status: 'valid',
        message: `Success! Welcome to ${event ? event.name : 'the event'}.`,
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

const handlePassRequest = async (req, res) => {
    const rawToken = req.params.token;
    const token = rawToken.endsWith('.pkpass') ? rawToken.slice(0, -7) : rawToken;
    const ticket = db.data.tickets.find(t => t.token === token);

    if (!ticket) return res.status(404).send('Ticket not found');

    const event = db.data.events.find(e => e.id === ticket.eventId);
    if (!event) return res.status(404).send('Event not found');

    try {
        const certPath = path.resolve(__dirname, 'certs');
        const wwdrFile = path.join(certPath, 'wwdr.pem');
        const signerCertFile = path.join(certPath, 'signer.pem');
        const signerKeyFile = path.join(certPath, 'signer.key');

        const missingEnv = [];
        if (!process.env.PASS_TYPE_ID) missingEnv.push('PASS_TYPE_ID');
        if (!process.env.TEAM_ID) missingEnv.push('TEAM_ID');

        if (missingEnv.length) {
            console.warn(`⚠️ Apple Wallet env vars missing: ${missingEnv.join(', ')}`);
            return res.status(503).send(`Apple Wallet integration not fully configured. Missing env vars: ${missingEnv.join(', ')}`);
        }

        const missingFiles = [];
        if (!fs.existsSync(wwdrFile)) missingFiles.push('wwdr.pem');
        if (!fs.existsSync(signerCertFile)) missingFiles.push('signer.pem');
        if (!fs.existsSync(signerKeyFile)) missingFiles.push('signer.key');

        if (missingFiles.length) {
            console.warn(`⚠️ Apple Wallet certificates missing: ${missingFiles.join(', ')}`);
            return res.status(503).send(`Apple Wallet integration not fully configured. Missing files: ${missingFiles.join(', ')}`);
        }

        const modelPath = path.resolve(__dirname, 'pass-assets.pass');
        const passJsonPath = path.join(modelPath, 'pass.json');
        if (!fs.existsSync(modelPath) || !fs.existsSync(passJsonPath)) {
            console.warn('⚠️ Apple Wallet pass model missing in /pass-assets.pass.');
            return res.status(503).send('Apple Wallet integration not fully configured. Pass model missing.');
        }

        console.log(`🎟️ Generating pass for: ${ticket.name} (${ticket.token})`);

        const signerKeyPassphrase = process.env.PASS_CERT_PASSWORD || undefined;

        const passOverrides = {
            serialNumber: ticket.token,
            passTypeIdentifier: process.env.PASS_TYPE_ID,
            teamIdentifier: process.env.TEAM_ID,
            description: event.name,
            logoText: event.name,
            backgroundColor: event.color || "rgb(99, 102, 241)",
        };

        const pass = await PKPass.from({
            model: modelPath,
            certificates: {
                wwdr: fs.readFileSync(wwdrFile),
                signerCert: fs.readFileSync(signerCertFile),
                signerKey: fs.readFileSync(signerKeyFile),
                signerKeyPassphrase,
            }
        }, passOverrides);

        // Set Top-Level Properties
        pass.voided = !!ticket.used_at;

        // Add Barcode
        pass.setBarcodes({
            format: "PKBarcodeFormatQR",
            message: `ticket:${ticket.token}`,
            messageEncoding: "iso-8859-1"
        });

        // Add Geolocation
        const lat = event.location?.lat;
        const lng = event.location?.lng;
        const hasValidCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
        if (hasValidCoords) {
            console.log(`📍 Geofencing: ${lat}, ${lng}`);
            pass.setLocations({
                latitude: Number(lat),
                longitude: Number(lng),
                relevantText: `${event.name} is starting!`
            });
        }

        // Push Fields into the pre-existing arrays from pass.json
        pass.primaryFields.push({ key: "event", label: "EVENT", value: event.name });
        pass.secondaryFields.push({ key: "attendee", label: "ATTENDEE", value: ticket.name });

        const eventDate = new Date(event.time);
        if (!Number.isNaN(eventDate.getTime())) {
            pass.auxiliaryFields.push({
                key: "date",
                label: "DATE",
                value: eventDate,
                dateStyle: "PKDateStyleMedium",
                timeStyle: "PKDateStyleShort"
            });

            // Show on lock screen from 2 hours before to 2 hours after start.
            const windowStart = new Date(eventDate.getTime() - 2 * 60 * 60 * 1000);
            const windowEnd = new Date(eventDate.getTime() + 2 * 60 * 60 * 1000);
            pass.setRelevantDates([{ startDate: windowStart, endDate: windowEnd }]);
            pass.expirationDate = windowEnd;
        } else {
            pass.auxiliaryFields.push({
                key: "date",
                label: "DATE",
                value: String(event.time)
            });
        }

        if (event.location && event.location.name) {
            pass.auxiliaryFields.push({ key: "loc", label: "LOCATION", value: event.location.name });
        }

        if (ticket.used_at) {
            pass.auxiliaryFields.push({
                key: "status",
                label: "STATUS",
                value: "USED / SCANNED",
                // Pass properties colors must be string or Apple won't render
            });
        }

        if (event.imageUrl) {
            const imagePath = path.resolve(__dirname, 'public', event.imageUrl.replace(/^\/+/, ''));
            if (fs.existsSync(imagePath)) {
                const imageBuffer = fs.readFileSync(imagePath);
                pass.addBuffer('thumbnail.png', imageBuffer);
                pass.addBuffer('thumbnail@2x.png', imageBuffer);
            }
        }


        console.log('✅ Pass object created, getting buffer...');
        const buffer = pass.getAsBuffer();
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
};

// API: Generate Apple Wallet Pass
app.get(['/api/pass/:token', '/api/pass/:token.pkpass'], handlePassRequest);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎟️  Ticket Check-in System running at:\n   - Local:    http://localhost:${PORT}\n   - Network:  http://0.0.0.0:${PORT}\n`);
});
