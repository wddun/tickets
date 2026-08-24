/* Paper Pot — the giveaway's third spinner style.
 *
 * Names arrive on slips of paper that flutter down into a pot, one visible
 * slip at a time when entries trickle in and a readable shower of them when a
 * whole room submits at once. Drawing the winner shakes the pot and lifts one
 * slip back out.
 *
 * Shared by giveaway.html (the operator's controller) and
 * giveaway-display.html (the room's screen) rather than copied into both:
 * the reel and wheel physics are duplicated across those two files and every
 * change has to be made twice, in lockstep, or the screens visibly disagree.
 * Both pages create a pot from this one file and feed it the same numbers.
 *
 * Everything is drawn on a single 2D canvas. A DOM node per slip would be
 * simpler to write, but a few hundred simultaneously animating, rotating,
 * shadowed elements is not something a projector-driving laptop keeps at 60fps.
 *
 * The pot is staged like an object standing in a room — it throws a shadow on
 * a floor, its rim catches the light, its count is pressed into its side — and
 * a draw dims everything around it. The slips are deliberately simpler than
 * that: one turning axis, one flat paper tone. They were briefly given a full
 * lighting model and it made them worse, because a name shaded by its own angle
 * spends most of its fall too dim to read, and a name is the only thing on a
 * slip anyone cares about.
 */
(function () {
    'use strict';

    const PAPER_TONES = ['#fdf8ec', '#fbf3e2', '#fdfaf2', '#f7efdd', '#fffdf6'];
    const INK = '#2b2a26';
    const FONT_STACK = 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, sans-serif';

    // Deterministic per-slip randomness: a slip's wobble, tone and tilt have to
    // be the same on every frame, and the resting mound has to stop rearranging
    // itself each time it redraws.
    function hashRandom(seed) {
        let h = seed * 2654435761 % 4294967296;
        h = (h ^ (h >>> 15)) * 2246822507 % 4294967296;
        h = (h ^ (h >>> 13)) * 3266489909 % 4294967296;
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
    function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }
    function easeOutBack(p) { const c = 1.70158; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); }
    function easeInOutSine(p) { return 0.5 - Math.cos(Math.PI * p) / 2; }

    // Lighten (k > 0) or darken (k < 0) a hex colour, staying in hex so the
    // result can be fed straight back in for the next step of a gradient.
    function tint(hex, k) {
        const p = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
        const t = k >= 0 ? 255 : 0;
        const a = Math.abs(k);
        const c = p.map(v => Math.round(v + (t - v) * a));
        return '#' + c.map(v => clamp(v, 0, 255).toString(16).padStart(2, '0')).join('');
    }

    function lerpColor(a, b, t) {
        const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
        const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
        const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
    }

    // Shrink the name until it fits, wrap it if the caller allows more than one
    // line, and only then cut it. A giveaway pot full of "Christophe…" is worse
    // than one with slightly small type, and a winner's name is worth two lines.
    function layoutName(ctx, text, maxWidth, startPx, minPx, maxLines) {
        const words = String(text || '').split(/\s+/).filter(Boolean);
        if (!words.length) return { lines: [], px: startPx };
        for (let px = Math.round(startPx); px >= minPx; px -= 1) {
            ctx.font = `700 ${px}px ${FONT_STACK}`;
            const lines = [];
            let line = '';
            let ok = true;
            for (const word of words) {
                const next = line ? line + ' ' + word : word;
                if (ctx.measureText(next).width <= maxWidth) { line = next; continue; }
                if (line) lines.push(line);
                line = word;
                if (ctx.measureText(word).width > maxWidth) { ok = false; break; }
                if (lines.length >= maxLines) { ok = false; break; }
            }
            if (!ok) continue;
            lines.push(line);
            if (lines.length <= maxLines) return { lines: lines, px: px };
        }
        ctx.font = `700 ${minPx}px ${FONT_STACK}`;
        let cut = String(text || '');
        while (cut.length > 1 && ctx.measureText(cut + '…').width > maxWidth) cut = cut.slice(0, -1);
        return { lines: [cut + '…'], px: minPx };
    }

    function create(canvas, opts) {
        opts = opts || {};
        const ctx = canvas.getContext('2d');
        const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};

        let accent = opts.accent || '#ffd400';
        let W = 0, H = 0, dpr = 1;
        let seedCounter = 1;

        let queue = [];        // names waiting to be dropped in
        let flyers = [];       // slips currently on screen
        let motes = [];        // celebratory paper thrown up on the reveal
        let resting = 0;       // slips settled in the pot (drives the mound)
        // What the heap is *drawn* from, chasing `resting` over a few frames.
        // The heap's height and spread are smooth functions of the count, so a
        // count that jumps by a whole slip moves every piece already in the pot
        // a little, all in one frame. Easing the number the drawing reads makes
        // that a settle instead of a twitch.
        let shownResting = 0;
        let label = '';

        let lastReleaseAt = 0;
        // Consecutive slips take consecutive lanes across the stage, so a run of
        // arrivals fans out instead of queueing down one column.
        const LANES = 5;
        let releaseLane = 0;
        let shake = 0;         // 0..1, decaying pot wobble
        let landFlash = 0;     // 0..1, decaying glint along the lip on a landing
        let spinState = null;  // set while a draw is running
        let running = false;
        let rafId = null;
        let lastFrame = 0;
        let loopGen = 0;       // see kick()/onVisibility
        let destroyed = false;

        // Fixed once, for the life of the pot — never reseeded by how many
        // entrants are resting. A pile built from a FIXED number of stacked
        // layers, each perturbed by these same points every frame, can grow or
        // shrink smoothly without a single element ever changing where it sits
        // relative to its neighbours.
        const MOUND_RIM_PTS = 16;
        const moundRimNoise = Array.from({ length: MOUND_RIM_PTS }, (_, i) => hashRandom(i * 41 + 900) - 0.5);

        // ── Layout ──────────────────────────────────────────────────────
        // Recomputed on resize; everything else works in these numbers so the
        // same code drives a 340px phone stage and a 900px projector.
        let L = {};
        function layout() {
            const rect = canvas.getBoundingClientRect();
            W = Math.max(1, Math.round(rect.width));
            H = Math.max(1, Math.round(rect.height));
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(W * dpr);
            canvas.height = Math.round(H * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            // Sized against both axes so the same code gives a phone-width
            // controller stage and a projector a pot of sensible proportions,
            // with enough clear air above it for a slip to be read on the way
            // down. Capped so a very large screen doesn't get a silly bucket.
            const potW = Math.min(W * 0.68, H * 0.62, 520);
            const rx = potW / 2;
            const ry = rx * 0.30;
            const bodyH = potW * 0.72;
            const my = H - bodyH - ry - H * 0.08;   // mouth centre
            L = {
                cx: W / 2,
                my,
                rx,
                ry,
                baseY: my + bodyH,
                baseRx: rx * 0.74,
                // Big enough that a name is readable at a glance while it falls
                // — the whole point of the style — without a burst of them
                // becoming one solid sheet of paper.
                slipW: clamp(W * 0.38, 88, 230),
            };
            L.slipH = L.slipW * 0.44;
        }

        // ── Slips ───────────────────────────────────────────────────────
        function spawnFlyer(name, lane, lanes) {
            const seed = seedCounter++;
            // Lanes fan a burst out across the stage so several names are
            // readable side by side instead of stacking on one column.
            const spread = clamp(W * 0.78, 120, 620);
            const laneX = W / 2 - spread / 2 + spread * ((lane + 0.5) / lanes);
            const backlog = queue.length;
            // Staggered above the top edge rather than all entering on the same
            // line, so consecutive releases don't descend the stage as a rank.
            const startY = -L.slipH * (1 + hashRandom(seed + 43) * 1.6);
            return {
                name: name,
                seed: seed,
                x: laneX + (hashRandom(seed) - 0.5) * (spread / lanes) * 0.7,
                // Aim somewhere across the mouth, not always dead centre.
                targetX: L.cx + (hashRandom(seed + 7) - 0.5) * L.rx * 1.1,
                y: startY,
                startY: startY,
                // A big backlog falls faster — the shower has to clear before
                // the next poll lands or the pot never catches up — but never
                // so fast that a name is gone before it can be read.
                fallMs: clamp(1900 - backlog * 5, 850, 1900),
                t: 0,
                phase: hashRandom(seed + 3) * Math.PI * 2,
                spinRate: 2.0 + hashRandom(seed + 11) * 1.6,
                tilt: (hashRandom(seed + 5) - 0.5) * 0.5,
                tone: PAPER_TONES[seed % PAPER_TONES.length],
                settling: 0,         // 0..1 while it drops through the mouth
                fade: 0,             // 0..1, dissolving into the heap it lands on
                scale: 1,
                squash: 1,           // vertical foreshortening as it tips away
                shade: 0,            // how much of the pot's shadow has taken it
                churn: false,        // a shake-loosened slip, not a new entry
            };
        }

        // How fast the backlog drains. Both numbers move with the queue: a
        // trickle of three names should read as three distinct slips, while a
        // hundred at once should look like paper pouring in rather than a
        // three-minute queue of polite single file.
        //
        // Deliberately one slip per release however big the backlog gets, with
        // only the interval between them moving. Letting a big queue push four
        // out at once looks like more paper for about a second and then stops
        // looking like paper at all: four slips released in the same frame fall
        // as a rank, the rank saturates the in-flight cap, nothing more can go
        // until the whole rank lands, and the shower turns into waves of clumps
        // with empty air between them. Dripping them out fast instead fills the
        // stage evenly, and the cap then throttles the rate on its own — the
        // release simply stalls whenever the air is full.
        function releasePlan() {
            const q = queue.length;
            return {
                gapMs: clamp(700 / (1 + q * 0.09), 45, 700),
                maxInFlight: Math.round(clamp(5 + q / 8, 5, 18)),
            };
        }

        function releaseDue(now) {
            if (!queue.length || spinState) return;
            const plan = releasePlan();
            if (now - lastReleaseAt < plan.gapMs) return;
            // Only what is still in the air counts against the cap. A slip
            // that has gone over the rim is spoken for, and holding the next
            // release back for it leaves a visible gap in the shower.
            const live = flyers.filter(f => !f.churn && f.settling <= 0).length;
            if (live >= plan.maxInFlight) return;
            // Not left-to-right: consecutive slips jump two lanes across, so a
            // steady stream doesn't sweep the stage like a printer head.
            releaseLane = (releaseLane + 2) % LANES;
            flyers.push(spawnFlyer(queue.shift(), releaseLane, LANES));
            lastReleaseAt = now;
        }

        function updateFlyers(dt) {
            for (let i = flyers.length - 1; i >= 0; i--) {
                const f = flyers[i];
                f.t += dt;
                f.phase += f.spinRate * dt;

                if (f.churn) {
                    // Shaken loose: pops up out of the mouth and drops back in.
                    f.vy += 2400 * dt;
                    f.y += f.vy * dt;
                    f.x += f.vx * dt;
                    if (f.y > L.my + L.ry * 0.4 && f.vy > 0) flyers.splice(i, 1);
                    continue;
                }

                const p = clamp(f.t * 1000 / f.fallMs, 0, 1);
                // Gravity-ish on the way down, but drifting sideways toward the
                // mouth the whole time so a slip that spawned at the edge of the
                // stage still lands in the pot. It aims at the far lip rather
                // than the middle of the opening, so the descent that follows
                // crosses the mouth from back to front — the same visible
                // journey whether the pot is empty or nearly full.
                const entryY = L.my - L.ry * 0.3;
                f.y = f.startY + (entryY - f.startY) * (p * p * 0.72 + p * 0.28);
                const wobble = Math.sin(f.phase * 1.1) * L.slipW * 0.16 * (1 - p * 0.6);
                f.x += ((f.targetX + wobble) - f.x) * Math.min(1, dt * 3.2);

                // Approach: the last stretch is the slip travelling away from
                // the viewer and down into the opening, not just down the
                // screen, so it starts to recede before it ever reaches the rim.
                const approach = clamp((p - 0.72) / 0.28, 0, 1);
                f.scale = 1 - approach * 0.14;
                f.squash = 1 - approach * 0.20;

                if (p >= 1) {
                    // Inside now. It carries on away from the camera: converging
                    // on the middle of the opening, foreshortening hard as it
                    // tips flat, and dropping into the shadow the front lip
                    // casts — which is where it actually disappears. The rim
                    // clips it on the way (see draw()), so it is cut off by the
                    // pot rather than fading out on top of it.
                    //
                    // It has to end up *gone*, and it has to go by merging into
                    // the heap rather than by darkening on top of it. Driving
                    // the shade to black instead just trades one visible slip
                    // for another: a black card silhouetted against a pale pile
                    // of paper, which is if anything easier to see. So the slip
                    // keeps roughly the colour of what it is landing among, and
                    // fades out over the second half of the drop while the pot's
                    // own shadow takes it — it is indistinguishable from the
                    // heap before it is removed, and nothing blinks out.
                    f.settling += dt / 0.42;
                    const q = clamp(f.settling, 0, 1);
                    f.x += (L.cx - f.x) * Math.min(1, dt * 2.6);
                    f.y = entryY + q * L.ry * 1.3;
                    f.scale = 0.88 - q * 0.40;
                    f.squash = 0.78 - q * 0.52;
                    f.shade = 0.34 * q;
                    // Held back at first so the name is still legible as it goes
                    // over the rim; gone entirely before the slip is spliced out.
                    f.fade = clamp((q - 0.45) / 0.5, 0, 1);
                    if (f.settling >= 1) {
                        flyers.splice(i, 1);
                        resting++;
                        shake = Math.min(1, shake + 0.06);
                        landFlash = 1;
                        onEvent('land', { name: f.name, resting: resting });
                    }
                }
            }
        }

        function updateMotes(dt) {
            for (let i = motes.length - 1; i >= 0; i--) {
                const m = motes[i];
                m.life -= dt;
                if (m.life <= 0) { motes.splice(i, 1); continue; }
                m.vy += 900 * dt;
                m.vx -= m.vx * Math.min(1, 0.7 * dt);
                m.x += m.vx * dt;
                m.y += m.vy * dt;
                m.tumble += m.tumbleRate * dt;
                m.yaw += m.yawRate * dt;
            }
        }

        // ── Drawing ─────────────────────────────────────────────────────

        // ── Drawing ─────────────────────────────────────────────────────
        function roundRect(x, y, w, h, r) {
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + r);
            ctx.lineTo(x + w, y + h - r);
            ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
            ctx.lineTo(x + r, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - r);
            ctx.lineTo(x, y + r);
            ctx.quadraticCurveTo(x, y, x + r, y);
            ctx.closePath();
        }

        // A slip, drawn face-on at `turn`=1 and edge-on at `turn`=0. Squashing
        // the horizontal axis by the cosine of its tumble is what sells these as
        // pieces of paper turning over rather than sprites sliding down.
        //
        // `shade` (0..1) is how much of the pot's interior darkness has fallen
        // over it. Nothing inside a pot is lit like something in front of one,
        // and losing the light on the way down does more to sell the depth than
        // the shrinking does.
        //
        // `glowColor`/`glowBlur` replace the paper's own cast shadow, for the
        // one slip that is being held up as the winner rather than falling.
        function drawSlip(o) {
            const w = o.w, h = o.h;
            const turn = o.turn;
            const face = Math.abs(turn);
            const shade = o.shade || 0;
            ctx.save();
            ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
            ctx.translate(o.x, o.y);
            ctx.rotate(o.rot);

            if (face < 0.1) {
                // Edge-on: a lit sliver, no face, no text.
                ctx.fillStyle = `rgba(255,255,255,${(0.55 * (1 - shade)).toFixed(3)})`;
                ctx.fillRect(-Math.max(1.2, w * face * 0.5), -h / 2, Math.max(2.4, w * face), h);
                ctx.restore();
                return;
            }

            ctx.scale(face, 1);
            const radius = Math.min(5, Math.abs(h) * 0.14);
            ctx.shadowColor = o.glowColor || 'rgba(0,0,0,0.45)';
            ctx.shadowBlur = o.glowBlur != null ? o.glowBlur : Math.abs(h) * 0.35;
            ctx.shadowOffsetY = o.glowColor ? 0 : Math.abs(h) * 0.12;
            roundRect(-w / 2, -h / 2, w, h, radius);
            ctx.fillStyle = o.tone;
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Backs of slips get no text — you're looking at the reverse side.
            if (turn < 0) {
                ctx.strokeStyle = 'rgba(0,0,0,0.10)';
                ctx.lineWidth = 1;
                for (let i = 1; i <= 3; i++) {
                    const ly = -h / 2 + (h * i) / 4;
                    ctx.beginPath();
                    ctx.moveTo(-w * 0.36, ly);
                    ctx.lineTo(w * 0.36, ly);
                    ctx.stroke();
                }
                if (shade > 0) {
                    roundRect(-w / 2, -h / 2, w, h, radius);
                    ctx.fillStyle = `rgba(3,5,11,${shade.toFixed(3)})`;
                    ctx.fill();
                }
                ctx.restore();
                return;
            }

            // Torn-from-a-pad top edge, then the name. Below about a third of
            // the slip's full height the text is a smudge rather than a name, so
            // skip it and keep the paper clean.
            ctx.strokeStyle = 'rgba(0,0,0,0.07)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-w * 0.38, -h * 0.22);
            ctx.lineTo(w * 0.38, -h * 0.22);
            ctx.stroke();

            if (h > L.slipH * 0.34) {
                const fit = layoutName(ctx, o.name || '', w * 0.82, h * 0.42,
                    Math.max(7, h * 0.2), o.maxLines || 1);
                ctx.fillStyle = INK;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const lh = fit.px * 1.14;
                const y0 = h * 0.09 - (fit.lines.length - 1) * lh / 2;
                fit.lines.forEach((line, i) => ctx.fillText(line, 0, y0 + i * lh));
            }

            if (shade > 0) {
                roundRect(-w / 2, -h / 2, w, h, radius);
                ctx.fillStyle = `rgba(3,5,11,${shade.toFixed(3)})`;
                ctx.fill();
            }
            ctx.restore();
        }

        function slipDraw(f) {
            const scale = f.scale || 1;
            const squash = f.squash == null ? 1 : f.squash;
            return {
                x: f.x, y: f.y,
                w: L.slipW * scale,
                h: L.slipH * scale * squash,
                rot: f.tilt + Math.sin(f.phase * 0.5) * 0.22,
                turn: Math.cos(f.phase),
                tone: f.tone,
                name: f.name,
                shade: f.shade || 0,
                opacity: f.fade ? 1 - f.fade * f.fade : 1,
            };
        }

        // Where the top of the heap sits inside the mouth. Logarithmic: the
        // difference between 5 and 50 entries should be obvious, the difference
        // between 300 and 350 need not be, and the heap must never reach the rim
        // however many there are.
        function moundFillFrac() {
            return shownResting <= 0 ? 0 : Math.min(1, Math.log10(shownResting + 1) / 2.4);
        }

        // Everything a slip on its way into the pot can still be seen through:
        // the opening itself, plus the open air above the back of the rim, since
        // a slip only half-swallowed still has its top sticking up over the far
        // edge. Clipping to this is what makes a slip get *cut off* by the rim
        // on the way down instead of fading out on top of the pot.
        function clipToMouth() {
            ctx.beginPath();
            ctx.rect(-W, -H, W * 3, H + (L.my - L.ry));
            ctx.ellipse(L.cx, L.my, L.rx * 0.94, L.ry * 0.92, 0, 0, Math.PI * 2);
            ctx.clip();
        }

        function moundBottomY() { return L.my + L.ry * 0.30; }
        function moundTopY() {
            if (shownResting <= 0) return moundBottomY();
            return moundBottomY() - L.ry * (0.30 + moundFillFrac() * 0.95);
        }

        // A wobbly-rimmed ellipse — not a perfect one — traced through
        // moundRimNoise so a heap of paper doesn't read as a stamped-out disc.
        // `noiseOffset` walks a different slice of the same fixed array per
        // layer, so the layers don't all wobble in lockstep.
        function moundLayerPath(cx, cy, rx, ry, noiseOffset) {
            ctx.beginPath();
            for (let i = 0; i <= MOUND_RIM_PTS; i++) {
                const a = (i / MOUND_RIM_PTS) * Math.PI * 2;
                const n = moundRimNoise[(i + noiseOffset) % MOUND_RIM_PTS];
                const rrx = rx * (1 + n * 0.16);
                const rry = ry * (1 + n * 0.22);
                const x = cx + Math.cos(a) * rrx;
                const y = cy + Math.sin(a) * rry;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
        }

        // The pile of slips already in the pot, seen through the mouth. Not
        // individual pieces of paper any more — once a slip lands it's part of
        // the pile, not a name anyone needs to keep reading — but a rounded
        // volume built from a FIXED number of stacked, wobbly-rimmed layers.
        // Only *where* the stack sits (between moundBottomY and moundTopY, both
        // smooth functions of the count) depends on how many are resting; the
        // layers themselves, their wobble and their shading never change shape,
        // which is what keeps this from ever visibly reflowing.
        const MOUND_LAYERS = 5;
        function drawMound() {
            if (shownResting <= 0.01) return;
            const bottom = moundBottomY();
            const top = moundTopY();
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.93, L.ry * 0.9, 0, 0, Math.PI * 2);
            ctx.clip();

            // A handful of slips shouldn't span the same footprint as a few
            // hundred — the width tapers with the same fill fraction that
            // drives the height, so a near-empty pot shows a small heap in the
            // middle rather than a full-width smear squashed flat.
            const widthScale = 0.46 + moundFillFrac() * 0.54;
            for (let i = 0; i < MOUND_LAYERS; i++) {
                const t = i / (MOUND_LAYERS - 1);          // 0 = base, 1 = peak
                const y = bottom + (top - bottom) * t;
                const rx = L.rx * (0.82 - t * 0.34) * widthScale;
                const ry = L.ry * (0.62 - t * 0.20) * widthScale;
                moundLayerPath(L.cx, y, rx, ry, i * 5);
                if (i === MOUND_LAYERS - 1) {
                    // The peak catches the light — a radial highlight rather
                    // than a flat fill is what makes it read as rounded instead
                    // of as a lid sitting on top of the stack.
                    const peak = ctx.createRadialGradient(
                        L.cx - rx * 0.3, y - ry * 0.4, rx * 0.1,
                        L.cx, y, rx * 1.1
                    );
                    peak.addColorStop(0, '#fffef8');
                    peak.addColorStop(0.55, PAPER_TONES[1]);
                    peak.addColorStop(1, lerpColor('#c9b98a', '#fdf8ec', 0.5));
                    ctx.fillStyle = peak;
                } else {
                    ctx.fillStyle = lerpColor('#a8987a', '#fdf8ec', t);
                }
                ctx.fill();
                ctx.strokeStyle = `rgba(0,0,0,${(0.22 - t * 0.10).toFixed(2)})`;
                ctx.lineWidth = 1;
                ctx.stroke();
            }

            // A few fixed creases on the peak — texture, not clutter, and never
            // reseeded by count since they belong to the layer, not to any one
            // entrant.
            const peakY = bottom + (top - bottom);
            const peakRx = L.rx * 0.48, peakRy = L.ry * 0.42;
            ctx.strokeStyle = 'rgba(120,105,70,0.28)';
            ctx.lineWidth = 1;
            for (let i = 0; i < 7; i++) {
                const fx = (hashRandom(i * 61 + 3) - 0.5) * 1.7;
                const fy = (hashRandom(i * 61 + 7) - 0.5) * 1.7;
                const len = 0.12 + hashRandom(i * 61 + 11) * 0.14;
                const rot = hashRandom(i * 61 + 13) * Math.PI;
                const cx0 = L.cx + fx * peakRx, cy0 = peakY + fy * peakRy;
                ctx.beginPath();
                ctx.moveTo(cx0 - Math.cos(rot) * len * peakRx, cy0 - Math.sin(rot) * len * peakRy);
                ctx.lineTo(cx0 + Math.cos(rot) * len * peakRx, cy0 + Math.sin(rot) * len * peakRy);
                ctx.stroke();
            }

            // Shade the whole pile toward the back of the pot so it sits in a
            // hollow rather than floating as a flat sticker.
            const shade = ctx.createLinearGradient(0, L.my - L.ry, 0, L.my + L.ry);
            shade.addColorStop(0, 'rgba(0,0,0,0.55)');
            shade.addColorStop(0.55, 'rgba(0,0,0,0.05)');
            shade.addColorStop(1, 'rgba(0,0,0,0.35)');
            ctx.fillStyle = shade;
            ctx.fillRect(L.cx - L.rx, L.my - L.ry, L.rx * 2, L.ry * 2);
            ctx.restore();
        }

        // The pot's own shadow on the floor it stands on. Without it the pot
        // hangs in the middle of a black rectangle; with it there is a room.
        function drawFloor() {
            ctx.save();
            const cy = L.baseY + L.ry * 0.12;
            const rx = L.baseRx * 2.0, ry = L.ry * 0.85;
            const g = ctx.createRadialGradient(L.cx, cy, 0, L.cx, cy, rx);
            g.addColorStop(0, 'rgba(0,0,0,0.62)');
            g.addColorStop(0.45, 'rgba(0,0,0,0.34)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.beginPath();
            ctx.ellipse(L.cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.fillStyle = g;
            ctx.fill();
            ctx.restore();
        }

        // Back rim and the dark interior. Drawn before the slips so anything
        // falling shows up against the inside of the pot.
        function drawPotBack() {
            ctx.save();
            const rim = ctx.createLinearGradient(L.cx - L.rx, L.my - L.ry, L.cx + L.rx, L.my + L.ry);
            rim.addColorStop(0, '#2c3142');
            rim.addColorStop(0.42, '#7b849f');
            rim.addColorStop(0.62, '#5c6480');
            rim.addColorStop(1, '#262a38');
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx, L.ry, 0, 0, Math.PI * 2);
            ctx.fillStyle = rim;
            ctx.fill();

            // The inside. Lit from above and in front, so the far wall at the
            // top of the opening catches a little and the near wall directly
            // under the front lip is in the deepest shadow — that difference is
            // most of what makes this read as a hole rather than a dark disc.
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.93, L.ry * 0.9, 0, 0, Math.PI * 2);
            const inner = ctx.createLinearGradient(0, L.my - L.ry, 0, L.my + L.ry);
            inner.addColorStop(0, '#1b2231');
            inner.addColorStop(0.45, '#0a0d14');
            inner.addColorStop(1, '#020306');
            ctx.fillStyle = inner;
            ctx.fill();

            ctx.save();
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.93, L.ry * 0.9, 0, 0, Math.PI * 2);
            ctx.clip();
            // Wall thickness: a soft dark ring just inside the rim, so the lip
            // has a near edge and a far edge instead of being a painted line.
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.93, L.ry * 0.9, 0, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';
            ctx.lineWidth = Math.max(2, L.ry * 0.30);
            ctx.stroke();
            // Daylight down the far wall, so the back of the inside is a
            // surface rather than the same flat black as the bottom.
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my - L.ry * 0.12, L.rx * 0.86, L.ry * 0.74, 0, Math.PI * 1.06, Math.PI * 1.94);
            ctx.strokeStyle = 'rgba(150,168,205,0.22)';
            ctx.lineWidth = Math.max(1.5, L.ry * 0.22);
            ctx.stroke();
            ctx.restore();
            ctx.restore();
        }

        // Front lip and body, drawn after the slips: a slip that has dropped
        // below the front of the rim is hidden by this, which is what makes it
        // read as going *into* the pot instead of behind it.
        function drawPotFront() {
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(L.cx - L.rx, L.my);
            ctx.ellipse(L.cx, L.my, L.rx, L.ry, 0, Math.PI, 0, true);
            ctx.lineTo(L.cx + L.baseRx, L.baseY - L.ry * 0.5);
            ctx.ellipse(L.cx, L.baseY - L.ry * 0.5, L.baseRx, L.ry * 0.7, 0, 0, Math.PI);
            ctx.lineTo(L.cx - L.rx, L.my);
            ctx.closePath();
            ctx.save();
            ctx.clip();

            const body = ctx.createLinearGradient(L.cx - L.rx, 0, L.cx + L.rx, 0);
            body.addColorStop(0, '#151821');
            body.addColorStop(0.14, '#333849');
            body.addColorStop(0.36, '#666f8b');
            body.addColorStop(0.50, '#7c85a1');
            body.addColorStop(0.68, '#454b5f');
            body.addColorStop(0.88, '#22262f');
            body.addColorStop(1, '#101319');
            ctx.fillStyle = body;
            ctx.fillRect(L.cx - L.rx, L.my - L.ry, L.rx * 2, L.baseY - L.my + L.ry * 2);

            // Curved surfaces are darker where they turn away from the light
            // and toward the floor. One vertical gradient over the whole body
            // does more for the illusion of a solid vessel than any amount of
            // outline work.
            const vert = ctx.createLinearGradient(0, L.my, 0, L.baseY + L.ry);
            vert.addColorStop(0, 'rgba(0,0,0,0.34)');
            vert.addColorStop(0.28, 'rgba(0,0,0,0)');
            vert.addColorStop(0.82, 'rgba(0,0,0,0.30)');
            vert.addColorStop(1, 'rgba(0,0,0,0.62)');
            ctx.fillStyle = vert;
            ctx.fillRect(L.cx - L.rx, L.my - L.ry, L.rx * 2, L.baseY - L.my + L.ry * 2);

            // A soft specular column where the light hits, and a cold rim light
            // down the far edge to lift it off the background.
            const spec = ctx.createLinearGradient(L.cx - L.rx * 0.55, 0, L.cx + L.rx * 0.10, 0);
            spec.addColorStop(0, 'rgba(255,255,255,0)');
            spec.addColorStop(0.55, 'rgba(255,255,255,0.13)');
            spec.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = spec;
            ctx.fillRect(L.cx - L.rx, L.my, L.rx * 2, L.baseY - L.my);

            const rimlight = ctx.createLinearGradient(L.cx + L.rx * 0.60, 0, L.cx + L.rx, 0);
            rimlight.addColorStop(0, 'rgba(150,170,215,0)');
            rimlight.addColorStop(1, 'rgba(150,170,215,0.30)');
            ctx.fillStyle = rimlight;
            ctx.fillRect(L.cx, L.my, L.rx, L.baseY - L.my);

            // Two hoops. Embossed — a dark groove with a lit edge under it —
            // rather than a painted line, so the body reads as a made object.
            [0.34, 0.66].forEach(f => {
                const y = L.my + (L.baseY - L.my) * f;
                const w = L.rx + (L.baseRx - L.rx) * f;
                const t = Math.max(2, L.ry * 0.16);
                ctx.beginPath();
                ctx.ellipse(L.cx, y, w, L.ry * 0.55, 0, 0.10, Math.PI - 0.10);
                ctx.strokeStyle = 'rgba(0,0,0,0.42)';
                ctx.lineWidth = t;
                ctx.stroke();
                ctx.beginPath();
                ctx.ellipse(L.cx, y + t * 0.62, w, L.ry * 0.55, 0, 0.16, Math.PI - 0.16);
                ctx.strokeStyle = 'rgba(190,205,240,0.13)';
                ctx.lineWidth = Math.max(1, t * 0.42);
                ctx.stroke();
            });

            drawLabel();
            ctx.restore();

            // Contact shadow the front lip casts back into the pot, drawn over
            // the contents so anything dropping in passes under it.
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.93, L.ry * 0.9, 0, 0, Math.PI * 2);
            ctx.clip();
            const ao = ctx.createLinearGradient(0, L.my - L.ry * 0.05, 0, L.my + L.ry * 0.85);
            ao.addColorStop(0, 'rgba(0,0,0,0)');
            ao.addColorStop(0.55, 'rgba(0,0,0,0.55)');
            ao.addColorStop(1, 'rgba(0,0,0,0.95)');
            ctx.fillStyle = ao;
            ctx.fillRect(L.cx - L.rx, L.my - L.ry * 0.1, L.rx * 2, L.ry * 1.1);
            ctx.restore();

            // The lip: an accent band around the front half of the rim, faded
            // out at both ends into the shadowed sides instead of stopping dead
            // where the ellipse does. A landing lights it up for a moment.
            const lipW = Math.max(3, L.ry * 0.32);
            const band = ctx.createLinearGradient(L.cx - L.rx, 0, L.cx + L.rx, 0);
            band.addColorStop(0, 'rgba(0,0,0,0)');
            band.addColorStop(0.16, accent);
            band.addColorStop(0.5, tint(accent.length === 7 ? accent : '#ffd400', 0.25));
            band.addColorStop(0.86, accent);
            band.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx, L.ry, 0, 0.04, Math.PI - 0.04);
            ctx.lineWidth = lipW;
            ctx.strokeStyle = band;
            ctx.globalAlpha = 0.9;
            if (landFlash > 0.01) {
                ctx.shadowColor = accent;
                ctx.shadowBlur = 26 * landFlash;
            }
            ctx.stroke();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;

            // A hairline of true highlight along the top of that band — the one
            // place the rim actually catches the light square-on. Faded at both
            // ends like the band itself, or it ends in two bright ticks poking
            // out past where the lip has curved away from the viewer.
            const hair = ctx.createLinearGradient(L.cx - L.rx, 0, L.cx + L.rx, 0);
            hair.addColorStop(0, 'rgba(255,255,255,0)');
            hair.addColorStop(0.30, 'rgba(255,255,255,0.42)');
            hair.addColorStop(0.70, 'rgba(255,255,255,0.42)');
            hair.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my - lipW * 0.30, L.rx * 0.99, L.ry * 0.97, 0, 0.30, Math.PI - 0.30);
            ctx.lineWidth = Math.max(1, lipW * 0.16);
            ctx.strokeStyle = hair;
            ctx.stroke();
            ctx.restore();
        }

        // The running count, engraved into the pot rather than printed on it:
        // a dark impression with a lit lower edge. When the label is a plain
        // number — which is all either page ever sends — it gets a caption, so
        // a bare "37" on the side of a bucket reads as something.
        function drawLabel() {
            if (!label) return;
            const y = L.my + (L.baseY - L.my) * 0.48;
            const px = Math.max(13, L.rx * 0.30);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `800 ${px}px ${FONT_STACK}`;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillText(label, L.cx, y);
            ctx.fillStyle = 'rgba(226,234,255,0.30)';
            ctx.fillText(label, L.cx, y + Math.max(1, px * 0.045));

            // Only on a pot big enough to read it. On the controller's phone-
            // width stage the caption comes out at eight pixels of letterspaced
            // capitals, which is a grey smudge, and that page carries its own
            // caption under the canvas anyway.
            if (L.rx >= 120 && /^\d+$/.test(label)) {
                const cap = Math.max(8, px * 0.26);
                ctx.font = `700 ${cap}px -apple-system, BlinkMacSystemFont, sans-serif`;
                ctx.letterSpacing = '0.18em';
                ctx.fillStyle = 'rgba(0,0,0,0.45)';
                ctx.fillText('IN THE POT', L.cx, y + px * 0.72);
                ctx.fillStyle = 'rgba(226,234,255,0.20)';
                ctx.fillText('IN THE POT', L.cx, y + px * 0.72 + 1);
                ctx.letterSpacing = '0px';
            }
        }

        // A slip is "in the mouth" once it has dropped past the far edge of the
        // rim — from there on it is seen *through* the opening and has to be
        // clipped to it.
        function inMouth(f) {
            return f.settling > 0 || f.y > L.my - L.ry;
        }

        // The room's lights going down. Everything outside the pot dims while a
        // draw runs and comes back afterwards, which is what turns the spin from
        // an animation playing in a corner into the thing being watched.
        function drawVignette() {
            const v = spinState ? spinState.vig : 0;
            if (v <= 0.01) return;
            const fy = L.my - (spinState.stage === 'reveal' || spinState.stage === 'rise' ? H * 0.16 : 0);
            const r = Math.max(W, H) * (0.86 - v * 0.30);
            const g = ctx.createRadialGradient(L.cx, fy, r * 0.16, L.cx, fy, r);
            g.addColorStop(0, 'rgba(0,0,0,0)');
            g.addColorStop(0.55, `rgba(0,0,0,${(v * 0.34).toFixed(3)})`);
            g.addColorStop(1, `rgba(0,0,0,${(v * 0.82).toFixed(3)})`);
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
        }

        function draw(now) {
            ctx.clearRect(0, 0, W, H);

            // The whole pot wobbles during a shake; the slips in the air do not,
            // so the pot moves under them the way a real one would.
            const wob = shake > 0 ? Math.sin(now / 1000 * 38) * shake * L.rx * 0.09 : 0;
            const wobY = shake > 0 ? Math.abs(Math.sin(now / 1000 * 22)) * shake * L.ry * 0.35 : 0;
            const withPot = (fn) => {
                ctx.save();
                ctx.translate(wob, -wobY);
                ctx.rotate(wob / (L.rx * 8));
                fn();
                ctx.restore();
            };

            withPot(() => { drawFloor(); drawPotBack(); drawMound(); });

            // Still in open air, in front of and above the pot — including a
            // slip the shake has thrown clear of the rim, which is above the
            // mouth clip's region and would be sliced off along a dead-straight
            // line partway across the paper if it were drawn inside it.
            for (const f of flyers) {
                if (inMouth(f)) continue;
                drawSlip(slipDraw(f));
            }
            // Going in. Clipped to the opening and moving with the pot, so a
            // shaken pot takes its contents with it.
            withPot(() => {
                ctx.save();
                clipToMouth();
                for (const f of flyers) {
                    if (!inMouth(f)) continue;
                    drawSlip(slipDraw(f));
                }
                ctx.restore();
            });

            if (spinState) drawSpinSlips();

            withPot(drawPotFront);

            drawVignette();

            if (spinState && spinState.stage === 'reveal') {
                drawRevealHalos();
                drawMotes();
                drawRevealSlips();
            }
        }

        // ── The draw ────────────────────────────────────────────────────
        // Three beats: rattle the pot, lift the winning slip(s) out, hold them
        // up face-on. Timings are fractions of the caller's duration so the
        // controller and the room's screen, which start their own clocks from
        // their own `now`, still land together.
        const SHAKE_END = 0.42;
        const RISE_END = 0.86;

        function drawSpinSlips() {
            if (spinState.stage !== 'rise') return;
            const p = spinState.riseP;
            for (const s of spinState.slips) {
                const e = easeOutCubic(clamp((p - s.delay) / (1 - s.delay), 0, 1));
                if (e <= 0) continue;
                const x = L.cx + (s.endX - L.cx) * e;
                const y = L.my + (s.endY - L.my) * e;
                const w = L.slipW + (s.endW - L.slipW) * e;
                // Spins fast on the way up and eases to face-on at the top.
                // `turn` has to arrive at exactly 1, not at some leftover phase,
                // or the room is shown the blank back of the winning slip.
                const turn = Math.cos(s.phase + (1 - e) * 14);
                const settled = e * e;
                drawSlip({
                    x: x, y: y, w: w, h: w * 0.44,
                    rot: s.tilt * (1 - settled),
                    turn: turn * (1 - settled) + settled,
                    tone: s.tone, name: s.name,
                    maxLines: 2,
                    // Comes up out of the pot's shadow into the light as it rises.
                    shade: 0.75 * Math.pow(1 - e, 2),
                });
            }
        }

        // Every halo first, then every card. Drawn one winner at a time, the
        // second winner's halo lies over the first winner's finished card and
        // the third lies over both, so a three-way draw washes the whole screen
        // — and everything behind it — in accent colour.
        function drawRevealHalos() {
            const pop = easeOutBack(clamp(spinState.revealP, 0, 1));
            // Three haloes overlapping are three times the light of one. Share
            // it out, or a multi-winner draw floods the stage.
            const glow = clamp(spinState.revealP * 1.4, 0, 1) / Math.sqrt(spinState.slips.length);
            for (const s of spinState.slips) {
                const w = s.endW * (0.94 + pop * 0.06);
                // A halo behind the slip, not a blur on it: the winning name
                // stays crisp while the light around it does the celebrating.
                // Tied to the stage as well as to the slip: on the controller's
                // narrow panel a halo sized off the card alone is most of the
                // panel, and the winner arrives inside a wash of accent instead
                // of lit by it.
                const r = Math.min(w * 0.86, W * 0.42);
                const halo = ctx.createRadialGradient(s.endX, s.endY, w * 0.20, s.endX, s.endY, r);
                halo.addColorStop(0, `rgba(255,255,255,${(0.14 * glow).toFixed(3)})`);
                halo.addColorStop(0.40, hexToRgba(accent, 0.30 * glow));
                halo.addColorStop(0.74, hexToRgba(accent, 0.09 * glow));
                halo.addColorStop(1, hexToRgba(accent, 0));
                ctx.fillStyle = halo;
                ctx.beginPath();
                ctx.ellipse(s.endX, s.endY, r, r * 0.62, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        function drawRevealSlips() {
            const pop = easeOutBack(clamp(spinState.revealP, 0, 1));
            const glow = clamp(spinState.revealP * 1.4, 0, 1);
            for (const s of spinState.slips) {
                const w = s.endW * (0.94 + pop * 0.06);
                drawSlip({
                    x: s.endX, y: s.endY, w: w, h: w * 0.44,
                    rot: 0, turn: 1,
                    tone: '#fffdf4', name: s.name, maxLines: 2,
                    glowColor: accent, glowBlur: 30 * glow,
                });
            }
        }

        function drawMotes() {
            for (const m of motes) {
                drawSlip({
                    x: m.x, y: m.y, w: m.w, h: m.w * 0.44,
                    rot: m.roll, turn: Math.cos(m.tumble),
                    tone: m.tone,
                    opacity: clamp(m.life / 0.5, 0, 1),
                });
            }
        }

        function hexToRgba(hex, a) {
            if (!/^#[0-9a-f]{6}$/i.test(hex)) return `rgba(255,212,0,${a})`;
            const p = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
            return `rgba(${p[0]},${p[1]},${p[2]},${a})`;
        }

        function spawnMotes() {
            const n = clamp(Math.round(W / 42), 12, 30);
            for (let i = 0; i < n; i++) {
                const seed = seedCounter++;
                const a = (hashRandom(seed) - 0.5) * 2.4 - Math.PI / 2;
                const sp = 380 + hashRandom(seed + 3) * 520;
                motes.push({
                    x: L.cx + (hashRandom(seed + 5) - 0.5) * L.rx * 1.3,
                    y: L.my,
                    vx: Math.cos(a) * sp,
                    vy: Math.sin(a) * sp,
                    w: L.slipW * (0.16 + hashRandom(seed + 7) * 0.16),
                    tumble: hashRandom(seed + 9) * 6.28,
                    tumbleRate: (hashRandom(seed + 11) - 0.5) * 16,
                    yaw: hashRandom(seed + 13) * 6.28,
                    yawRate: (hashRandom(seed + 15) - 0.5) * 12,
                    roll: hashRandom(seed + 17) * 6.28,
                    tone: PAPER_TONES[seed % PAPER_TONES.length],
                    life: 0.9 + hashRandom(seed + 19) * 0.7,
                });
            }
        }

        function updateSpin(now, dt) {
            const p = clamp((now - spinState.start) / spinState.durationMs, 0, 1);
            // Lights down over the first beat, back up once the winner is held.
            spinState.vig = clamp(p / 0.22, 0, 1);
            if (p < SHAKE_END) {
                spinState.stage = 'shake';
                // Build, hold, then release — the pot settles just before the
                // slip comes out, so the lift reads as the payoff.
                const q = p / SHAKE_END;
                shake = Math.max(shake, easeInOutSine(Math.min(1, q * 1.6)) * (1 - Math.pow(q, 3)));
                if (now - spinState.lastChurn > 110) {
                    spinState.lastChurn = now;
                    const seed = seedCounter++;
                    const name = spinState.churnNames.length
                        ? spinState.churnNames[seed % spinState.churnNames.length] : '';
                    flyers.push({
                        name: name, seed: seed, churn: true,
                        x: L.cx + (hashRandom(seed) - 0.5) * L.rx * 1.2,
                        y: L.my - L.ry * 0.2,
                        vx: (hashRandom(seed + 2) - 0.5) * 170,
                        vy: -(420 + hashRandom(seed + 4) * 380),
                        t: 0, phase: hashRandom(seed + 6) * 6.28,
                        spinRate: 5 + hashRandom(seed + 8) * 5,
                        tilt: (hashRandom(seed + 9) - 0.5) * 0.6,
                        tone: PAPER_TONES[seed % PAPER_TONES.length],
                        settling: 0, scale: 0.82, squash: 1, shade: 0,
                    });
                    onEvent('rattle', {});
                }
            } else if (p < RISE_END) {
                spinState.stage = 'rise';
                shake = Math.max(0, shake - dt * 2.4);
                spinState.riseP = (p - SHAKE_END) / (RISE_END - SHAKE_END);
            } else {
                if (spinState.stage !== 'reveal') {
                    spinState.stage = 'reveal';
                    spinState.revealP = 0;
                    spawnMotes();
                    onEvent('reveal', { names: spinState.slips.map(s => s.name) });
                }
                spinState.riseP = 1;
                spinState.revealP += dt / 0.4;
            }
            if (p >= 1 && !spinState.done) {
                spinState.done = true;
                if (spinState.onDone) spinState.onDone();
            }
        }

        // ── Frame loop ──────────────────────────────────────────────────
        // Runs only while something is moving; an idle pot is a still image and
        // has no business burning a projector laptop's battery at 60fps.
        function busy() {
            return !!(spinState || flyers.length || queue.length || motes.length
                || shake > 0.002 || landFlash > 0.002
                || Math.abs(resting - shownResting) > 0.01);
        }

        function frame(now, gen) {
            if (destroyed || gen !== loopGen) return;
            const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
            lastFrame = now;

            if (spinState) updateSpin(now, dt);
            else shake = Math.max(0, shake - dt * 1.8);
            shownResting += (resting - shownResting) * Math.min(1, dt * 6);
            landFlash = Math.max(0, landFlash - dt * 2.2);

            releaseDue(now);
            updateFlyers(dt);
            updateMotes(dt);
            draw(now);

            if (busy()) rafId = requestAnimationFrame(t => frame(t, gen));
            else { running = false; rafId = null; }
        }

        // `loopGen` exists because of hidden tabs. A browser suspends
        // requestAnimationFrame entirely while its tab is in the background, so
        // a loop that was mid-flight when the operator switched away never gets
        // its next frame — and with `running` left true, nothing would ever
        // start it again. Restarting bumps the generation, so a suspended loop
        // that does eventually wake up exits instead of running alongside the
        // new one at double speed.
        function kick() {
            if (running || destroyed) return;
            running = true;
            const gen = ++loopGen;
            lastFrame = performance.now();
            rafId = requestAnimationFrame(t => frame(t, gen));
        }

        function onVisibility() {
            if (destroyed || document.visibilityState !== 'visible') return;
            // A frame within the last second means the loop is alive; anything
            // longer and it was frozen with the tab.
            if (running && performance.now() - lastFrame > 1000) {
                running = false;
                kick();
            } else if (!running) {
                redraw();
            }
        }

        function redraw() {
            if (destroyed) return;
            if (running) return;
            draw(performance.now());
        }

        const onResize = () => { layout(); redraw(); };
        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', onVisibility);
        layout();
        draw(performance.now());

        return {
            // New entries, animated in. Order is preserved; pacing is the pot's
            // business, not the caller's.
            addNames(names) {
                if (!names || !names.length) return;
                for (const n of names) queue.push(n || '(no name)');
                // A backlog nobody will ever see individually is not worth the
                // memory: past this point the extras go straight into the heap
                // so the count stays honest without a ten-minute queue.
                const OVERFLOW = 320;
                if (queue.length > OVERFLOW) {
                    resting += queue.length - OVERFLOW;
                    queue = queue.slice(-OVERFLOW);
                }
                kick();
            },
            // Slips already in the pot when the page loaded — no animation, the
            // room didn't watch those arrive.
            setResting(n) {
                resting = Math.max(0, n | 0);
                // Straight to it, with no settle: this is the pot's state when
                // the page loaded, not something the room watched arrive.
                shownResting = resting;
                redraw();
            },
            setLabel(text) { label = text || ''; redraw(); },
            setAccent(color) { accent = color || accent; redraw(); },
            // Everything the pot still owes the count: queued names plus the
            // slips currently in the air. A caller resyncing the resting heap
            // to a pool size has to subtract these or it double-counts them
            // when they land.
            pendingCount() { return queue.length + flyers.filter(f => !f.churn).length; },
            restingCount() { return resting; },
            // `churnNames` are only ever decoration on the shaken slips; the
            // winner is decided by the caller, never here.
            spin(o) {
                const names = (o && o.names && o.names.length) ? o.names : ['(no name)'];
                const durationMs = (o && o.durationMs) || 5200;
                // Anything still in the air would be drawing attention away
                // from the pot at the exact moment it matters.
                flyers = [];
                motes = [];
                // The winner is held in the clear air above the rim, and that
                // air is all there is: sizing the slips off the stage width
                // alone gives a card that overlaps the pot it just came out of.
                const cols = Math.min(names.length, 3);
                const rows = Math.ceil(names.length / cols);
                const air = Math.max(40, L.my - L.ry);
                const slipW = Math.min(W * 0.78, 380, (W * 0.86) / cols, (air * 1.55) / (0.55 + rows * 0.45));
                const top = air * 0.5;
                spinState = {
                    start: performance.now(),
                    durationMs: durationMs,
                    stage: 'shake',
                    riseP: 0,
                    revealP: 0,
                    vig: 0,
                    lastChurn: 0,
                    done: false,
                    churnNames: (o && o.churnNames) || [],
                    onDone: o && o.onDone,
                    slips: names.map((name, i) => {
                        const row = Math.floor(i / cols);
                        const col = i % cols;
                        const w = slipW;
                        return {
                            name: name,
                            endX: L.cx + (col - (cols - 1) / 2) * (w * 1.06),
                            endY: top + (row - (rows - 1) / 2) * (w * 0.52),
                            endW: w,
                            delay: Math.min(0.45, i * 0.08),
                            phase: hashRandom(i + 77) * 6.28,
                            tilt: (hashRandom(i + 13) - 0.5) * 0.8,
                            tone: PAPER_TONES[i % PAPER_TONES.length],
                        };
                    }),
                };
                kick();
            },
            // Back to the idle pot after a winner is confirmed or put back.
            reset() {
                spinState = null;
                shake = 0;
                motes = [];
                kick();
                redraw();
            },
            clear() {
                queue = [];
                flyers = [];
                motes = [];
                spinState = null;
                resting = 0;
                shownResting = 0;
                shake = 0;
                landFlash = 0;
                redraw();
            },
            resize() { layout(); redraw(); },
            destroy() {
                destroyed = true;
                if (rafId) cancelAnimationFrame(rafId);
                window.removeEventListener('resize', onResize);
                document.removeEventListener('visibilitychange', onVisibility);
            },
        };
    }

    window.GiveawayPot = { create: create };
})();
