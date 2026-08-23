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
 * The scene is drawn as if it were three-dimensional even though the canvas is
 * flat, because the shortcuts that make it look flat are all the same shortcut:
 * a slip is oriented by two real angles and shaded by that orientation against
 * one fixed light (see LIGHT); paper lying on the heap is projected through the
 * camera's angle (see GROUND_K); and the pot casts a shadow on a floor. Take
 * any one of those away and the pot goes back to looking like sprites sliding
 * over a picture of a bucket.
 */
(function () {
    'use strict';

    const PAPER_TONES = ['#fdf8ec', '#fbf3e2', '#fdfaf2', '#f7efdd', '#fffdf6'];
    const INK = '#2b2a26';
    const FONT_STACK = 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, sans-serif';

    // How hard the camera's angle foreshortens anything lying flat. It is the
    // pot mouth's own ry/rx ratio, so paper on the heap is squashed by exactly
    // as much as the opening it is seen through.
    const GROUND_K = 0.30;

    // One light for the whole scene, fixed in the world: up, front and a little
    // to the left. Every slip's brightness is its own face angled against this,
    // so the paper dims as it turns edge-on and flares as it comes back round.
    // A light that instead rode along with each slip — which is what a rotated
    // canvas shadow amounts to — makes them read as sliding stickers.
    const LIGHT = (function () {
        const v = [-0.34, -0.56, 0.76];
        const m = Math.hypot(v[0], v[1], v[2]);
        return [v[0] / m, v[1] / m, v[2] / m];
    })();

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
        let bounce = 0;        // 0..1, decaying compression of the heap
        let landFlash = 0;     // 0..1, decaying glint along the lip on a landing
        let spinState = null;  // set while a draw is running
        let running = false;
        let rafId = null;
        let lastFrame = 0;
        let loopGen = 0;       // see kick()/onVisibility
        let destroyed = false;

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
            const x = laneX + (hashRandom(seed) - 0.5) * (spread / lanes) * 0.7;
            // A big backlog falls faster — the shower has to clear before the
            // next poll lands or the pot never catches up — but never so fast
            // that a name is gone before it can be read.
            const fallMs = clamp(2100 - backlog * 6, 880, 2100);
            // Staggered above the top edge rather than all entering on the
            // same line: four slips released in the same frame that also start
            // at the same height fall as one rank, which reads as a machine
            // dealing cards, not as paper arriving.
            const startY = -L.slipH * (1 + hashRandom(seed + 43) * 2.2);
            const entryY = L.my - L.ry * 0.3;
            // Paper reaches terminal velocity almost at once and then descends
            // at a near-constant speed; it does not accelerate like a stone.
            // `vt` is what that steady speed has to be for the drop to take
            // roughly `fallMs`, and gravity is set to reach it in about 0.4s.
            const vt = (entryY - startY) / (fallMs / 1000);
            const spin = hashRandom(seed + 11) < 0.5 ? -1 : 1;
            // Twenty slips at the size a lone slip is drawn would be one solid
            // sheet of overlapping paper with nothing legible on it. A shower
            // draws smaller, which also reads as further away — so a burst
            // looks like paper pouring in from above rather than a pile-up.
            const size = clamp(1 - backlog / 220, 0.60, 1) * (0.92 + hashRandom(seed + 41) * 0.16);
            return {
                name: name,
                seed: seed,
                size: size,
                x: x,
                // Aim somewhere across the mouth, not always dead centre.
                targetX: L.cx + (hashRandom(seed + 7) - 0.5) * L.rx * 1.1,
                y: startY,
                vx: (hashRandom(seed + 17) - 0.5) * L.slipW * 0.9,
                vy: vt * 0.35,
                vt: vt,
                drag: 3.0,
                t: 0,
                // A dropped sheet falls in one of two ways, and this picks
                // between them the way a real slip does — mostly the first.
                // FLUTTER: it rocks about its horizontal axis, tipping maybe
                // fifty degrees each way and sliding toward whichever way it is
                // leaning, which is the side-to-side swooping descent everyone
                // recognises. TUMBLE: it goes over and over, end on end. The mix
                // is what stops a shower from looking choreographed — and the
                // flutter majority is also what keeps names facing the room
                // long enough to be read, which is the whole point of the style.
                tumbler: hashRandom(seed + 33) < 0.22,
                tumble: 0,
                tumblePhase: hashRandom(seed + 3) * Math.PI * 2,
                flutterAmp: 0.78 + hashRandom(seed + 35) * 0.42,
                flutterRate: spin * (3.4 + hashRandom(seed + 37) * 2.4),
                tumbleRate: spin * (2.1 + hashRandom(seed + 13) * 2.0),
                yaw: 0,
                yawPhase: hashRandom(seed + 19) * Math.PI * 2,
                yawAmp: 0.22 + hashRandom(seed + 21) * 0.34,
                yawRate: (hashRandom(seed + 23) - 0.5) * 1.9,
                phase: hashRandom(seed + 29) * Math.PI * 2,
                tilt: (hashRandom(seed + 5) - 0.5) * 0.45,
                roll: 0,
                curl: (hashRandom(seed + 31) - 0.3) * 0.10,
                tone: PAPER_TONES[seed % PAPER_TONES.length],
                settling: 0,         // 0..1 while it drops through the mouth
                scale: 1,
                flat: 0,             // 0..1, how far it has tipped onto the heap
                shade: 0,            // how much of the pot's shadow has taken it
                churn: false,        // a shake-loosened slip, not a new entry
            };
        }

        // How fast the backlog drains. Both numbers move with the queue: a
        // trickle of three names should read as three distinct slips, while a
        // hundred at once should look like paper pouring in rather than a
        // three-minute queue of polite single file.
        // Deliberately one slip per release, however big the backlog gets, with
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
                maxInFlight: Math.round(clamp(5 + q / 5, 5, 30)),
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

        // How much of the slip's face is turned toward the viewer, 0 (edge-on)
        // to 1 (flat on). Drag, brightness and readability all key off this.
        function faceOn(f) {
            return Math.abs(Math.cos(f.tumble) * Math.cos(f.yaw));
        }

        function updateFlyers(dt) {
            const entryY = L.my - L.ry * 0.3;
            for (let i = flyers.length - 1; i >= 0; i--) {
                const f = flyers[i];
                f.t += dt;

                if (f.churn) {
                    // Shaken loose: pops up out of the mouth and drops back in.
                    f.vy += 2400 * dt;
                    f.y += f.vy * dt;
                    f.x += f.vx * dt;
                    f.tumble += f.tumbleRate * dt;
                    f.yaw += f.yawRate * dt;
                    f.roll = f.tilt + Math.sin(f.tumble * 0.5) * 0.2;
                    if (f.y > L.my + L.ry * 0.4 && f.vy > 0) flyers.splice(i, 1);
                    continue;
                }

                if (f.settling <= 0) {
                    // Falling. A sheet presents more area to the air when it is
                    // face-on than edge-on, so it slows every time it flattens
                    // out and speeds up as it slices through — the uneven,
                    // stalling descent that reads as paper rather than a prop
                    // being lowered on a string.
                    const face = faceOn(f);
                    const k = f.drag * (0.70 + 0.60 * face);
                    f.vy += (f.vt * f.drag - k * f.vy) * dt;
                    f.y += f.vy * dt;

                    // Sideways, the tilt itself is the engine: a slip tipped one
                    // way slides that way, which is why real paper falls in
                    // swooping arcs instead of straight down. A gentle pull
                    // toward its target keeps it arriving over the pot anyway.
                    f.vx += Math.sin(f.tumble) * L.slipW * 2.6 * dt;
                    f.vx += (f.targetX - f.x) * 2.2 * dt;
                    f.vx -= f.vx * Math.min(1, 2.4 * dt);
                    f.x += f.vx * dt;
                    // Never let the swoop carry a name off the side of the stage.
                    const limit = L.slipW * 0.75;
                    if (f.x < f.targetX - limit) { f.x = f.targetX - limit; f.vx = Math.abs(f.vx) * 0.4; }
                    if (f.x > f.targetX + limit) { f.x = f.targetX + limit; f.vx = -Math.abs(f.vx) * 0.4; }

                    // Faster fall, faster flip.
                    const rush = 0.45 + 0.55 * (f.vy / f.vt);
                    if (f.tumbler) {
                        f.tumble += f.tumbleRate * rush * dt;
                        f.yaw += f.yawRate * dt;
                    } else {
                        f.tumblePhase += f.flutterRate * rush * dt;
                        f.tumble = Math.sin(f.tumblePhase) * f.flutterAmp;
                        // The yaw rocks at a different rate from the flutter, so
                        // the two never settle into a repeating figure.
                        f.yawPhase += f.yawRate * 0.62 * dt;
                        f.yaw = Math.sin(f.yawPhase) * f.yawAmp;
                    }
                    f.roll = f.tilt + Math.sin(f.tumblePhase * 0.5 + f.phase) * 0.14;

                    // The last stretch is the slip travelling away from the
                    // viewer as well as down, so it starts to recede before it
                    // ever reaches the rim.
                    const approach = clamp((f.y - (entryY - L.slipH * 1.6)) / (L.slipH * 1.6), 0, 1);
                    f.scale = 1 - approach * 0.12;
                    // The pot's shadow starts to reach it before it is over the
                    // rim, so it does not arrive at the opening at full daylight
                    // and then black out in a single frame.
                    f.shade = approach * 0.16;

                    if (f.y >= entryY || f.t > (L.slipH + entryY) / f.vt * 2.5) {
                        f.y = entryY;
                        f.settling = 0.0001;
                    }
                    continue;
                }

                // Inside now. It carries on away from the camera: converging on
                // the middle of the opening, tipping flat onto the heap, and
                // dropping into the shadow the front lip casts — which is where
                // it actually disappears. The rim clips it on the way (see
                // draw()), so it is cut off by the pot rather than fading out on
                // top of it.
                f.settling += dt / 0.46;
                const q = clamp(f.settling, 0, 1);
                f.x += (L.cx - f.x) * Math.min(1, dt * 2.6);
                f.y = entryY + q * L.ry * 1.05;
                f.scale = 0.9 - q * 0.34;
                f.flat = q;
                // Settling paper stops tumbling and lies down: ease the flip to
                // the nearest face-up angle rather than freezing it mid-turn.
                const target = Math.round((f.tumble - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
                f.tumble += (target - f.tumble) * Math.min(1, dt * 5.5);
                f.yaw += (0 - f.yaw) * Math.min(1, dt * 4);
                f.roll += (f.tilt * 1.6 - f.roll) * Math.min(1, dt * 3);
                // Held back at first so the name is still legible as it goes
                // over the rim, then plunging as it reaches the shadow.
                f.shade = 0.16 + 0.78 * Math.pow(q, 1.4);
                if (f.settling >= 1) {
                    flyers.splice(i, 1);
                    resting++;
                    shake = Math.min(1, shake + 0.05);
                    bounce = Math.min(1, bounce + 0.5);
                    landFlash = 1;
                    onEvent('land', { name: f.name, resting: resting });
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

        // A slip is not a rectangle. Real paper keeps a shallow curl across it,
        // and that curl is what stops a hundred of them in a heap from reading
        // as a stack of playing cards.
        function slipPath(w, h, curl) {
            const c = h * curl;
            ctx.beginPath();
            ctx.moveTo(-w / 2, -h / 2 + c);
            ctx.quadraticCurveTo(0, -h / 2 - c, w / 2, -h / 2 + c);
            ctx.lineTo(w / 2, h / 2 + c * 0.6);
            ctx.quadraticCurveTo(0, h / 2 - c * 1.4, -w / 2, h / 2 + c * 0.6);
            ctx.closePath();
        }

        // One slip of paper, drawn from its orientation rather than from a flat
        // "how squashed is it" number.
        //
        // `tumble` flips it about the horizontal axis (leading edge over
        // trailing edge — how a dropped sheet actually falls) and foreshortens
        // its height; `yaw` turns it about the vertical axis and foreshortens
        // its width; `rot` is the in-plane tilt. Shading comes from the face's
        // normal against the scene's one fixed light, so a slip dims as it turns
        // away and flares white as it comes edge-on through the beam.
        //
        // `shade` (0..1) is how much of the pot's interior darkness has fallen
        // over it. Nothing inside a pot is lit like something in front of one,
        // and losing the light on the way down does more to sell the depth than
        // the shrinking does.
        //
        // `ground` says the slip is lying flat rather than standing in the air.
        // That is a different projection, not a squashed version of the same
        // one: a slip on the heap is turned within the floor and only then
        // foreshortened by the camera's angle, so the transform has to scale
        // *before* it rotates. Rotating a pre-squashed rectangle instead — which
        // is what the obvious code does — swings it back out of the floor and
        // the heap comes out as a scatter of dashes at impossible angles.
        function paintSlip(o) {
            const tumble = o.tumble || 0, yaw = o.yaw || 0;
            const ct = Math.cos(tumble), cy = Math.cos(yaw);
            const flat = o.flat || 0;
            const ground = !!o.ground;
            // A slip lying on the heap is seen from the room's shallow angle,
            // not straight down, so it keeps a sliver of height instead of
            // vanishing the instant it goes flat.
            const hf = ground ? 1 : Math.max(Math.abs(ct), flat * GROUND_K);
            const wf = ground ? 1 : Math.abs(cy);
            const w = o.w * wf, h = o.h * hf;
            if (w < 0.5 || (h < 0.4 && !ground)) return;
            const shade = clamp(o.shade || 0, 0, 1);
            const front = ground || ct * cy >= 0;

            // Lambert against the fixed light. Paper is thin enough to be lit
            // from either side, hence the absolute value.
            const n = ground ? [0, -1, 0] : [Math.sin(yaw) * ct, -Math.sin(tumble), cy * ct];
            const lam = Math.abs(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
            const lit = 0.62 + 0.38 * lam;
            const base = tint(o.tone, (lit - 1) * 0.62);

            ctx.save();
            ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
            ctx.translate(o.x, o.y);
            if (ground) ctx.scale(1, GROUND_K);
            ctx.rotate(o.rot || 0);

            // Canvas shadow offsets are in device space, not the rotated frame,
            // so the cast shadow keeps falling the same way however the slip is
            // turned — the whole point of having one light.
            if (o.shadow !== false && ground) {
                // Tight and dark: on the heap, a slip's shadow on the one under
                // it is the only thing separating two cream rectangles.
                ctx.shadowColor = `rgba(0,0,0,${(0.55 * (1 - shade * 0.5)).toFixed(3)})`;
                ctx.shadowBlur = Math.max(1.5, o.h * 0.20);
                ctx.shadowOffsetY = Math.max(1, o.h * 0.11);
            } else if (o.shadow !== false) {
                ctx.shadowColor = `rgba(0,0,0,${(0.42 * (1 - shade * 0.6) * (1 - flat * 0.5)).toFixed(3)})`;
                ctx.shadowBlur = Math.max(2, o.h * 0.30);
                ctx.shadowOffsetY = Math.max(1, o.h * 0.14);
            }

            const curl = (o.curl == null ? 0.05 : o.curl) * (1 - flat * 0.7);
            slipPath(w, h, curl);
            const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
            g.addColorStop(0, tint(base, front ? 0.12 : 0.02));
            g.addColorStop(0.5, base);
            g.addColorStop(1, tint(base, front ? -0.10 : -0.16));
            ctx.fillStyle = g;
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // The cut edge, and the flare a sheet throws when it swings through
            // the light edge-on. That flash is the single strongest cue that
            // these are physical sheets and not sprites being scaled.
            if (hf < 0.30 && !flat) {
                ctx.globalAlpha = (ctx.globalAlpha || 1) * (1 - hf / 0.30) * 0.75 * (1 - shade);
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(-w / 2, -Math.max(0.7, h * 0.42), w, Math.max(1.4, h * 0.84));
                ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
            }

            if (ground) {
                // Flat paper gets its cut edge picked out, and nothing else —
                // the fold and the name are unreadable at this angle anyway, and
                // it is the edges that let the eye count separate sheets.
                ctx.strokeStyle = `rgba(74,60,36,${(0.55 * (1 - shade * 0.7)).toFixed(3)})`;
                ctx.lineWidth = Math.max(1.4, o.h * 0.10);
                ctx.stroke();
            } else if (front && h > o.h * 0.20) {
                // Torn-from-a-pad rule line, then the name. Below about a fifth
                // of the slip's full height the text is a smudge rather than a
                // name, so skip it and keep the paper clean.
                ctx.strokeStyle = `rgba(0,0,0,${(0.09 * (1 - shade)).toFixed(3)})`;
                ctx.lineWidth = Math.max(0.6, h * 0.02);
                ctx.beginPath();
                ctx.moveTo(-w * 0.36, -h * 0.24);
                ctx.lineTo(w * 0.36, -h * 0.24);
                ctx.stroke();

                if (h > o.h * 0.42 && o.name) {
                    const fit = layoutName(ctx, o.name, w * 0.84, h * 0.40, Math.max(7, h * 0.19), o.maxLines || 1);
                    ctx.fillStyle = INK;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    const lh = fit.px * 1.14;
                    const y0 = h * 0.08 - (fit.lines.length - 1) * lh / 2;
                    fit.lines.forEach((line, i) => ctx.fillText(line, 0, y0 + i * lh));
                }
            } else if (!front) {
                // The reverse side: ruled, never printed on.
                ctx.strokeStyle = `rgba(0,0,0,${(0.10 * (1 - shade)).toFixed(3)})`;
                ctx.lineWidth = Math.max(0.6, h * 0.02);
                for (let i = 1; i <= 3; i++) {
                    const ly = -h / 2 + (h * i) / 4;
                    ctx.beginPath();
                    ctx.moveTo(-w * 0.34, ly);
                    ctx.lineTo(w * 0.34, ly);
                    ctx.stroke();
                }
            }

            if (shade > 0) {
                slipPath(w, h, curl);
                // Warm dark, not the cold near-black used for a slip lost inside
                // the pot: paper shaded by the paper on top of it stays paper
                // coloured, and a blue-grey overlay turns the heap into gravel.
                ctx.fillStyle = ground
                    ? `rgba(46,32,14,${shade.toFixed(3)})`
                    : `rgba(3,5,11,${shade.toFixed(3)})`;
                ctx.fill();
            }
            ctx.restore();
        }

        function paintFlyer(f) {
            const s = (f.scale || 1) * (f.size || 1);
            paintSlip({
                x: f.x, y: f.y,
                w: L.slipW * s,
                h: L.slipH * s,
                rot: f.roll || 0,
                tumble: f.tumble, yaw: f.yaw,
                flat: f.flat || 0,
                curl: f.curl,
                tone: f.tone, name: f.name,
                shade: f.shade || 0,
            });
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

        // The heap is a FIXED set of slots, built once. Slot 0 sits at the
        // bottom of the pile and the last one at its peak; how many are shown
        // and how tall the pile stands are both smooth functions of the count,
        // and nothing else about a slot ever changes. That is what keeps the
        // heap from reflowing: landing one more slip reveals one more slot on
        // top, it does not renumber the ones already there. (The version before
        // this indexed every piece by its position among "however many are shown
        // right now", so each arrival re-laid the whole pile out in one frame.)
        const MOUND_SLOTS = 40;
        const moundSlots = [];
        for (let i = 0; i < MOUND_SLOTS; i++) {
            const hn = i / (MOUND_SLOTS - 1);                       // 0 base .. 1 peak
            const a = hashRandom(i * 7 + 1) * Math.PI * 2;
            // Radius falls away toward the peak, so the pile is a heap and not
            // a column; sqrt spreads the slots evenly over the area instead of
            // crowding them into the middle.
            const rr = Math.sqrt(hashRandom(i * 7 + 3)) * Math.pow(1 - hn, 0.5) * 0.94 + 0.05;
            moundSlots.push({
                dx: Math.cos(a) * rr,
                dy: Math.sin(a) * rr,
                hn: hn,
                // A heap of paper has no grain: every slip lies at its own angle.
                rot: (hashRandom(i * 7 + 5) - 0.5) * 2.6,
                w: 0.60 + hashRandom(i * 7 + 9) * 0.34,
                curl: (hashRandom(i * 7 + 15) - 0.35) * 0.09,
                tone: PAPER_TONES[(i * 3 + 1) % PAPER_TONES.length],
                // Buried paper is in shadow; what is near the top catches light.
                // The jitter matters as much as the ramp — an evenly graded pile
                // reads as one moulded lump, and it is the unevenness between
                // neighbours that makes it read as separate pieces of paper.
                shade: clamp(0.34 - hn * 0.30 + (hashRandom(i * 7 + 21) - 0.5) * 0.18, 0.00, 0.42),
            });
        }
        // Back to front, decided once from geometry alone — never from the
        // current count, or the draw order would shuffle as the pile grows.
        const moundOrder = moundSlots
            .map((s, i) => i)
            .sort((a, b) => (moundSlots[a].dy - moundSlots[a].hn * 1.5) - (moundSlots[b].dy - moundSlots[b].hn * 1.5));

        function drawMound() {
            if (shownResting <= 0.01) return;
            const fill = moundFillFrac();
            // A landing compresses the heap for a moment. Paper does not bounce
            // like rubber, so this is a small, fast squash, not a wobble.
            const squash = 1 - bounce * 0.10;
            const pileH = L.ry * (0.26 + fill * 1.10) * squash;
            const baseY = L.my + L.ry * 0.40;
            const spread = 0.34 + fill * 0.44;
            // Never more pieces than there are entries. Above about forty the
            // count and the picture part company — nobody counts a heap — but
            // showing ten slips for three would be a plain lie about the pot.
            const visible = Math.max(1, Math.min(shownResting, fill * MOUND_SLOTS));

            ctx.save();
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.93, L.ry * 0.9, 0, 0, Math.PI * 2);
            ctx.clip();

            // A dark bed under the heap. Paper piled in a bucket does not float
            // in the middle of the hole; the shadow it sits in is what puts it
            // on the bottom.
            const bed = ctx.createRadialGradient(
                L.cx, baseY - pileH * 0.2, L.rx * 0.10,
                L.cx, baseY, L.rx * (0.5 + spread * 0.6));
            bed.addColorStop(0, 'rgba(0,0,0,0.55)');
            bed.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = bed;
            ctx.fillRect(L.cx - L.rx, L.my - L.ry, L.rx * 2, L.ry * 2);

            for (const i of moundOrder) {
                if (i >= visible) continue;
                const s = moundSlots[i];
                // The newest slip fades in over the last fraction of a count so
                // a single arrival doesn't pop a whole sheet into existence.
                const alpha = Math.min(1, visible - i);
                // Slips nearer the top of the heap are nearer the camera, so
                // they are drawn slightly larger. Without that one cue a heap
                // seen from this angle reads as a flat mosaic however tall the
                // arithmetic says it is.
                const w = L.slipW * 0.46 * s.w * (0.74 + fill * 0.30) * (0.84 + s.hn * 0.30);
                paintSlip({
                    x: L.cx + s.dx * L.rx * spread,
                    y: baseY - s.hn * pileH + s.dy * L.ry * spread * 0.45,
                    w: w, h: w * 0.44,
                    rot: s.rot,
                    ground: true,
                    flat: 1,
                    curl: s.curl,
                    tone: s.tone,
                    shade: s.shade,
                    opacity: alpha,
                    shadow: i > MOUND_SLOTS * 0.35,
                });
            }

            // Sit the whole heap down into the hollow: light spills in over the
            // far lip, and the near half is under the pot's own shadow.
            const grad = ctx.createLinearGradient(0, L.my - L.ry, 0, L.my + L.ry);
            grad.addColorStop(0, 'rgba(0,0,0,0.22)');
            grad.addColorStop(0.42, 'rgba(0,0,0,0.00)');
            grad.addColorStop(1, 'rgba(0,0,0,0.42)');
            ctx.fillStyle = grad;
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

            // Still in open air, in front of and above the pot.
            for (const f of flyers) {
                if (f.churn || inMouth(f)) continue;
                paintFlyer(f);
            }
            // Shaken loose and above the rim: moving with the pot, because it is
            // the pot throwing them, but NOT clipped to the mouth. The mouth clip
            // is only the opening plus the air directly above it, and a slip
            // thrown clear lands outside that — it would be sliced off along a
            // dead-straight line partway across the paper.
            withPot(() => {
                for (const f of flyers) {
                    if (f.churn && !inMouth(f)) paintFlyer(f);
                }
            });
            // Going in, or churning back down inside. Clipped to the opening and
            // moving with the pot, so a shaken pot takes its contents with it.
            withPot(() => {
                ctx.save();
                clipToMouth();
                for (const f of flyers) {
                    if (inMouth(f)) paintFlyer(f);
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
                const settled = e * e;
                paintSlip({
                    x: x, y: y, w: w, h: w * 0.44,
                    rot: s.tilt * (1 - settled),
                    // Spins fast on the way up and eases to face-on at the top.
                    // Both angles have to wind down to exactly zero, not to some
                    // leftover phase: land on a half turn and the room is shown
                    // the blank back of the winning slip.
                    tumble: (1 - e) * (16 + s.phase),
                    yaw: (1 - e) * 5,
                    curl: 0.05,
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
                ctx.save();
                ctx.shadowColor = accent;
                ctx.shadowBlur = 30 * glow;
                paintSlip({
                    x: s.endX, y: s.endY, w: w, h: w * 0.44,
                    rot: 0, tumble: 0, yaw: 0, curl: 0.04,
                    tone: '#fffdf4', name: s.name, maxLines: 2,
                    shadow: false,
                });
                ctx.restore();
            }
        }

        function drawMotes() {
            for (const m of motes) {
                paintSlip({
                    x: m.x, y: m.y, w: m.w, h: m.w * 0.44,
                    rot: m.roll, tumble: m.tumble, yaw: m.yaw,
                    curl: 0.06, tone: m.tone,
                    opacity: clamp(m.life / 0.5, 0, 1),
                    shadow: false,
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
                    const spin = hashRandom(seed + 11) < 0.5 ? -1 : 1;
                    flyers.push({
                        name: name, seed: seed, churn: true,
                        x: L.cx + (hashRandom(seed) - 0.5) * L.rx * 1.2,
                        y: L.my - L.ry * 0.2,
                        vx: (hashRandom(seed + 2) - 0.5) * 190,
                        vy: -(430 + hashRandom(seed + 4) * 400),
                        tumble: hashRandom(seed + 6) * 6.28,
                        tumbleRate: spin * (6 + hashRandom(seed + 8) * 6),
                        yaw: hashRandom(seed + 18) * 6.28,
                        yawRate: (hashRandom(seed + 20) - 0.5) * 5,
                        phase: hashRandom(seed + 22) * 6.28,
                        tilt: (hashRandom(seed + 9) - 0.5) * 0.6,
                        roll: 0,
                        curl: (hashRandom(seed + 24) - 0.3) * 0.10,
                        tone: PAPER_TONES[seed % PAPER_TONES.length],
                        settling: 0, scale: 0.72, flat: 0, shade: 0.18,
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
                || shake > 0.002 || bounce > 0.002 || landFlash > 0.002
                || Math.abs(resting - shownResting) > 0.01);
        }

        function frame(now, gen) {
            if (destroyed || gen !== loopGen) return;
            const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
            lastFrame = now;

            if (spinState) updateSpin(now, dt);
            else shake = Math.max(0, shake - dt * 1.8);
            shownResting += (resting - shownResting) * Math.min(1, dt * 6);
            bounce = Math.max(0, bounce - dt * 3.4);
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
                bounce = 0;
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
