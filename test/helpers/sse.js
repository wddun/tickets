// A tiny SSE reader for tests — no EventSource in Node, but fetch()'s
// response body is a real ReadableStream, so this reads `data: ...\n\n`
// frames off it directly. Used to verify the app's push channels actually
// push, not just that their HTTP routes respond.
export async function openSseReader(url, { headers } = {}) {
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    async function next(timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
                const chunk = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const dataLines = chunk.split('\n').filter(l => l.startsWith('data: '));
                if (!dataLines.length) continue; // a bare comment/keepalive/retry-only frame
                try { return JSON.parse(dataLines.map(l => l.slice(6)).join('')); } catch { continue; }
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;
            const step = await Promise.race([
                reader.read(),
                new Promise(r => setTimeout(() => r({ timedOut: true }), remaining)),
            ]);
            if (step.timedOut) return null;
            if (step.done) return null;
            buffer += decoder.decode(step.value, { stream: true });
        }
    }

    function close() { try { controller.abort(); } catch { /* already closed */ } }
    return { next, close };
}
