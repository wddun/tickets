// A tiny HTTP client with its own cookie jar.
//
// Sessions are the only authentication this app has, so "a user" in these
// tests is just a client with its own jar — two clients against the same
// server are two independent browsers. Scan-link door staff and logged-out
// visitors are modelled the same way.

/**
 * @param {string} base  server origin, e.g. http://127.0.0.1:5555
 */
export function createClient(base) {
    const jar = new Map();

    function cookieHeader() {
        return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    function absorb(res) {
        const raw = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
        for (const line of raw) {
            const [pair] = line.split(';');
            const idx = pair.indexOf('=');
            if (idx === -1) continue;
            const name = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();
            // An expiry in the past is a delete (this is how logout clears the
            // session cookie) — mirror that instead of keeping a dead cookie.
            if (/expires=thu, 01 jan 1970/i.test(line) || /max-age=0/i.test(line)) jar.delete(name);
            else jar.set(name, value);
        }
    }

    async function request(method, path, { body, headers = {}, form, raw, redirect = 'manual' } = {}) {
        const init = { method, headers: { ...headers }, redirect };
        const cookies = cookieHeader();
        if (cookies) init.headers.cookie = cookies;

        if (form) {
            init.body = form; // FormData — let fetch set the boundary
        } else if (body !== undefined) {
            init.headers['content-type'] = init.headers['content-type'] || 'application/json';
            init.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        const res = await fetch(base + path, init);
        absorb(res);

        const out = { status: res.status, headers: res.headers, res };
        if (raw) {
            out.buffer = Buffer.from(await res.arrayBuffer());
            return out;
        }
        const text = await res.text();
        out.text = text;
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
            try { out.body = JSON.parse(text); } catch { out.body = null; }
        } else {
            out.body = null;
        }
        return out;
    }

    return {
        base,
        jar,
        cookies: cookieHeader,
        setCookie(name, value) { jar.set(name, value); },
        clearCookies() { jar.clear(); },
        get: (p, o) => request('GET', p, o),
        post: (p, body, o) => request('POST', p, { ...o, body }),
        put: (p, body, o) => request('PUT', p, { ...o, body }),
        patch: (p, body, o) => request('PATCH', p, { ...o, body }),
        del: (p, body, o) => request('DELETE', p, { ...o, body }),
        request,
    };
}
