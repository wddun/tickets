# TicketCheckin 🎟️

A complete Node.js ticket registration and check-in system. Features include QR code generation, email delivery (via Resend), and a mobile-optimized camera scanner with real-time validation.

## Security / Secrets

Do **not** commit secrets, pass certificates, or local data to GitHub.
This repo expects the following to stay local:

- `.env` (API keys and secrets)
- `certs/` (Apple Wallet certs and private key)
- `Certificates.p12`, `pass.cer`, `wwdr.cer`, `CertificateSigningRequest.certSigningRequest`
- `db.json` (user/ticket data)
- `sessions/` (session store)
- `public/uploads/` (user-uploaded images)
- `*.pkpass` (generated passes)

See `.env.example` for required environment variables.

## Apple Wallet Certificates

Place your Apple Wallet certs in `certs/` with the following filenames:

- `certs/wwdr.pem`
- `certs/signer.pem`
- `certs/signer.key`

These files should never be committed. See `certs/README.md` for a quick guide.

## Features
- **Registration**: Capture name and email, generate signed tickets.
- **Email Integration**: Automatically send QR codes to attendees using Resend.
- **Mobile Scanner**: Camera-based scanner with instant feedback.
- **Security**: Single-use tickets validated against a local database.
- **Aesthetics**: Premium UI with smooth transitions and audio cues.
- Restore 100ms SES interval; queue still prevents exceeding it
- Fix SES rate limiting with serialized promise queue
- Add email selected attendees functionality
- feat: add bulk email to all attendees of an event
- Set reply‑to organizer email on all outgoing ticket emails


## Tech Stack
- **Backend**: Node.js, Express, LowDB (pure JS JSON database).
- **Frontend**: Vanilla JS, HTML5-QRCode, modern CSS.
- **Services**: Resend (Email).

## Getting Started

### 1. Prerequisites
- Node.js installed.
- A Resend API Key (get one at [resend.com](https://resend.com)).

### 2. Setup
1. Clone the repository or extract the files.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file based on `.env.example`:
   ```env
   PORT=3002
   RESEND_API_KEY=re_your_api_key
   RESEND_FROM=onboarding@resend.dev
   ```

### 3. Run
Start the server:
```bash
npm start
```
The app will be available at:
- **Local**: `http://localhost:3002`
- **Network**: `http://<your-ip>:3002` (Use this for mobile scanning)

## Usage
1. Open **/register.html** on your computer.
2. Register a test attendee.
3. Open **/scanner.html** on your phone (make sure it's on the same Wi-Fi).
4. Scan the QR code.
   - **Green + High Tone**: Success! Ticket marked as used.
   - **Red + Low Tone**: Error! Ticket invalid or already used.
