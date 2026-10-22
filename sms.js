// Ticket text messages, sent through Twilio's REST API.
//
// Off unless TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (an E.164
// number on that account, e.g. +19844004433) are all set. SMS_SINK diverts
// every send to a JSONL file instead, the same way EMAIL_SINK does for email,
// so the test suite can assert on texts without ever reaching Twilio.
//
// Replies of STOP / START / HELP are handled by Twilio itself on the number,
// so nothing here tracks opt-outs: a text to someone who replied STOP is
// refused by Twilio (error 21610) and just logged as a failure.
import fs from 'node:fs';

// Read on each call, not at import: server.js loads .env after its imports run.
const sink = () => process.env.SMS_SINK || null;

// Twilio's own ceiling for one message body is 1600 characters; anything
// near that is split into many billed segments, so keep texts short.
export const MAX_BODY = 640;

export function smsConfigured() {
    if (sink()) return true;
    const env = process.env;
    return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
}

// Accepts what people actually type for a US number — "(919) 555-0123",
// "919.555.0123", "+1 919 555 0123", "19195550123" — and returns E.164
// (+19195550123), or null when it isn't a plausible US number. Only US
// numbers are accepted: the sending number is registered for US texting.
export function normalizeUsPhone(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (/[^\d\s().+\-]/.test(s)) return null;
    let digits = s.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length !== 10) return null;
    // Area code and exchange can't start with 0 or 1 under the NANP.
    if (/^[01]/.test(digits) || /^[01]/.test(digits.slice(3))) return null;
    return '+1' + digits;
}

// "(919) 555-0123" for showing a stored number back to people.
export function formatUsPhone(e164) {
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 || '');
}

export async function sendSms({ to, body }) {
    const text = String(body || '').slice(0, MAX_BODY);
    if (sink()) {
        try {
            fs.appendFileSync(sink(), JSON.stringify({ to, body: text, at: new Date().toISOString() }) + '\n');
        } catch (err) {
            console.warn('[sms-sink] write failed:', err.message);
        }
        return { sid: 'sink' };
    }
    if (!smsConfigured()) throw new Error('SMS is not configured on this server');
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
            Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: text }),
        signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.message || `Twilio returned ${res.status}`);
        err.code = data.code;
        throw err;
    }
    return { sid: data.sid, status: data.status };
}
