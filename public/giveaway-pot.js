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
 */
(function () {
    'use strict';

    const PAPER_TONES = ['#fdf8ec', '#fbf3e2', '#fdfaf2', '#f7efdd', '#fffdf6'];
    const INK = '#2b2a26';

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
    function easeInOutSine(p) { return 0.5 - Math.cos(Math.PI * p) / 2; }

    // Shrink the name until it fits the slip, and only then cut it. A giveaway
    // pot full of "Christophe…" is worse than one with slightly small type.
    function fitText(ctx, text, maxWidth, startPx, minPx) {
        let px = startPx;
        while (px > minPx) {
            ctx.font = `700 ${px}px ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, sans-serif`;
            if (ctx.measureText(text).width <= maxWidth) return text;
            px -= 1;
        }
        ctx.font = `700 ${minPx}px ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, sans-serif`;
        let cut = text;
        while (cut.length > 1 && ctx.measureText(cut + '…').width > maxWidth) cut = cut.slice(0, -1);
        return cut.length === text.length ? text : cut + '…';
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
        let resting = 0;       // slips settled in the pot (drives the mound)
        let label = '';

        let lastReleaseAt = 0;
        let shake = 0;         // 0..1, decaying pot wobble
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
            const potW = Math.min(W * 0.62, H * 0.62, 520);
            const rx = potW / 2;
            const ry = rx * 0.30;
            const bodyH = potW * 0.72;
            const my = H - bodyH - ry - H * 0.06;   // mouth centre
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
            return {
                name: name,
                seed: seed,
                x: laneX + (hashRandom(seed) - 0.5) * (spread / lanes) * 0.7,
                // Aim somewhere across the mouth, not always dead centre.
                targetX: L.cx + (hashRandom(seed + 7) - 0.5) * L.rx * 1.1,
                y: -L.slipH,
                startY: -L.slipH,
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
        function releasePlan() {
            const q = queue.length;
            return {
                gapMs: clamp(700 - q * 9, 80, 700),
                maxInFlight: Math.round(clamp(4 + q / 6, 4, 24)),
                perRelease: q > 120 ? 4 : q > 60 ? 3 : q > 20 ? 2 : 1,
            };
        }

        function releaseDue(now) {
            if (!queue.length || spinState) return;
            const plan = releasePlan();
            if (now - lastReleaseAt < plan.gapMs) return;
            const live = flyers.filter(f => !f.churn).length;
            if (live >= plan.maxInFlight) return;
            const n = Math.min(plan.perRelease, queue.length, plan.maxInFlight - live);
            for (let i = 0; i < n; i++) flyers.push(spawnFlyer(queue.shift(), i, n));
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
                    f.settling += dt / 0.42;
                    const q = clamp(f.settling, 0, 1);
                    f.x += (L.cx - f.x) * Math.min(1, dt * 2.6);
                    f.y = entryY + q * L.ry * 1.05;
                    f.scale = 0.88 - q * 0.33;
                    f.squash = 0.78 - q * 0.46;
                    // Held back at first so the name is still legible as it goes
                    // over the rim, then plunging as it reaches the shadow.
                    f.shade = 0.92 * q * q;
                    if (f.settling >= 1) {
                        flyers.splice(i, 1);
                        resting++;
                        shake = Math.min(1, shake + 0.06);
                        onEvent('land', { name: f.name, resting: resting });
                    }
                }
            }
        }

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
            ctx.shadowColor = 'rgba(0,0,0,0.45)';
            ctx.shadowBlur = Math.abs(h) * 0.35;
            ctx.shadowOffsetY = Math.abs(h) * 0.12;
            roundRect(-w / 2, -h / 2, w, h, radius);
            ctx.fillStyle = o.tone;
            ctx.fill();
            ctx.shadowColor = 'transparent';

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
                const text = fitText(ctx, o.name || '', w * 0.82, h * 0.42, Math.max(7, h * 0.2));
                ctx.fillStyle = INK;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, 0, h * 0.09);
            }

            if (shade > 0) {
                roundRect(-w / 2, -h / 2, w, h, radius);
                ctx.fillStyle = `rgba(3,5,11,${shade.toFixed(3)})`;
                ctx.fill();
            }
            ctx.restore();
        }

        // Where the top of the heap sits inside the mouth. Logarithmic: the
        // difference between 5 and 50 entries should be obvious, the difference
        // between 300 and 350 need not be, and the heap must never reach the rim
        // however many there are. Falling slips aim at this, so they land *on*
        // the pile rather than through it.
        // The heap stops well short of the near lip. That strip of empty shadow
        // between the paper and the front of the opening is not decoration: it
        // is the dark the arriving slips sink into, and without it a slip lands
        // on a field of identical white paper and vanishes instantly instead of
        // being seen to go in.
        function moundBottomY() { return L.my + L.ry * 0.30; }
        function moundTopY() {
            if (resting <= 0) return moundBottomY();
            const fill = Math.min(1, Math.log10(resting + 1) / 2.4);
            return moundBottomY() - L.ry * (0.30 + fill * 0.95);
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

        // The heap of slips already in the pot, seen through the mouth. Clipped
        // to the interior so it can never spill over the rim, and seeded so it
        // stops rearranging itself on every frame.
        function drawMound() {
            if (resting <= 0) return;
            const shown = Math.min(resting, 44);
            const bottom = moundBottomY();
            const top = moundTopY();
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.93, L.ry * 0.9, 0, 0, Math.PI * 2);
            ctx.clip();
            // Back to front, so the slips nearest the viewer are drawn last.
            for (let i = 0; i < shown; i++) {
                const r1 = hashRandom(i * 31 + 5);
                const r2 = hashRandom(i * 17 + 91);
                const r3 = hashRandom(i * 53 + 7);
                const w = L.rx * (0.26 + r1 * 0.26);
                const h = Math.max(2.5, L.ry * 0.20);
                const x = L.cx + (r2 - 0.5) * L.rx * 1.35;
                const y = top + (bottom - top) * (i / Math.max(1, shown - 1)) + (r3 - 0.5) * L.ry * 0.22;
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate((r1 - 0.5) * 1.15);
                roundRect(-w / 2, -h / 2, w, h, 1.5);
                ctx.fillStyle = PAPER_TONES[i % PAPER_TONES.length];
                ctx.fill();
                ctx.strokeStyle = 'rgba(0,0,0,0.28)';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.restore();
            }
            // Shade the heap toward the back of the pot so it sits in a hollow
            // rather than floating as a flat sticker.
            const shade = ctx.createLinearGradient(0, L.my - L.ry, 0, L.my + L.ry);
            shade.addColorStop(0, 'rgba(0,0,0,0.55)');
            shade.addColorStop(0.55, 'rgba(0,0,0,0.05)');
            shade.addColorStop(1, 'rgba(0,0,0,0.35)');
            ctx.fillStyle = shade;
            ctx.fillRect(L.cx - L.rx, L.my - L.ry, L.rx * 2, L.ry * 2);
            ctx.restore();
        }

        // Back rim and the dark interior. Drawn before the slips so anything
        // falling shows up against the inside of the pot.
        function drawPotBack() {
            ctx.save();
            const rim = ctx.createLinearGradient(L.cx - L.rx, L.my, L.cx + L.rx, L.my);
            rim.addColorStop(0, '#3a3f52');
            rim.addColorStop(0.5, '#6b7391');
            rim.addColorStop(1, '#343849');
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
            inner.addColorStop(0, '#171d2a');
            inner.addColorStop(0.45, '#0a0d14');
            inner.addColorStop(1, '#020306');
            ctx.fillStyle = inner;
            ctx.fill();

            // Wall thickness: a soft dark ring just inside the rim, so the lip
            // has a near edge and a far edge instead of being a painted line.
            ctx.save();
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.93, L.ry * 0.9, 0, 0, Math.PI * 2);
            ctx.clip();
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.93, L.ry * 0.9, 0, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';
            ctx.lineWidth = Math.max(2, L.ry * 0.30);
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

            const body = ctx.createLinearGradient(L.cx - L.rx, 0, L.cx + L.rx, 0);
            body.addColorStop(0, '#20242f');
            body.addColorStop(0.30, '#4d5468');
            body.addColorStop(0.52, '#6d7590');
            body.addColorStop(0.78, '#333846');
            body.addColorStop(1, '#191c25');
            ctx.fillStyle = body;
            ctx.fill();

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

            // Lip: a bright band along the front half of the rim.
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx, L.ry, 0, 0, Math.PI);
            ctx.lineWidth = Math.max(3, L.ry * 0.30);
            ctx.strokeStyle = accent;
            ctx.globalAlpha = 0.85;
            ctx.stroke();
            ctx.globalAlpha = 1;

            // Two hoops, so the body reads as a vessel and not a grey wedge.
            ctx.strokeStyle = 'rgba(0,0,0,0.30)';
            ctx.lineWidth = Math.max(2, L.ry * 0.18);
            [0.34, 0.66].forEach(f => {
                const y = L.my + (L.baseY - L.my) * f;
                const w = L.rx + (L.baseRx - L.rx) * f;
                ctx.beginPath();
                ctx.ellipse(L.cx, y, w, L.ry * 0.55, 0, 0.12, Math.PI - 0.12);
                ctx.stroke();
            });

            if (label) {
                ctx.font = `700 ${Math.max(11, L.rx * 0.14)}px -apple-system, BlinkMacSystemFont, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = 'rgba(255,255,255,0.82)';
                ctx.fillText(label, L.cx, L.my + (L.baseY - L.my) * 0.5);
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
            };
        }

        // A slip is "in the mouth" once it has dropped past the far edge of the
        // rim — from there on it is seen *through* the opening and has to be
        // clipped to it.
        function inMouth(f) {
            return f.settling > 0 || f.y > L.my - L.ry;
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

            withPot(() => { drawPotBack(); drawMound(); });

            // Still in open air, in front of and above the pot.
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

            if (spinState && spinState.stage === 'reveal') drawRevealSlips();
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
                const turn = Math.cos(s.phase + (1 - e) * 14);
                const settled = e * e;
                // Comes up out of the pot's shadow into the light as it rises.
                drawSlip({
                    x, y, w, h: w * 0.44,
                    rot: s.tilt * (1 - settled),
                    turn: turn * (1 - settled) + settled,
                    tone: s.tone, name: s.name,
                    shade: 0.7 * Math.pow(1 - e, 2),
                });
            }
        }

        function drawRevealSlips() {
            const pop = easeOutCubic(clamp(spinState.revealP, 0, 1));
            for (const s of spinState.slips) {
                const w = s.endW * (1 + pop * 0.06);
                ctx.save();
                ctx.shadowColor = accent;
                ctx.shadowBlur = 30 * pop;
                drawSlip({ x: s.endX, y: s.endY, w, h: w * 0.44, rot: 0, turn: 1, tone: '#fffdf4', name: s.name });
                ctx.restore();
            }
        }

        function updateSpin(now, dt) {
            const p = clamp((now - spinState.start) / spinState.durationMs, 0, 1);
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
                    onEvent('reveal', { names: spinState.slips.map(s => s.name) });
                }
                spinState.riseP = 1;
                spinState.revealP += dt / 0.35;
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
            return !!(spinState || flyers.length || queue.length || shake > 0.002);
        }

        function frame(now, gen) {
            if (destroyed || gen !== loopGen) return;
            const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
            lastFrame = now;

            if (spinState) updateSpin(now, dt);
            else shake = Math.max(0, shake - dt * 1.8);

            releaseDue(now);
            updateFlyers(dt);
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
                const baseW = Math.min(W * 0.74, 340);
                spinState = {
                    start: performance.now(),
                    durationMs: durationMs,
                    stage: 'shake',
                    riseP: 0,
                    revealP: 0,
                    lastChurn: 0,
                    done: false,
                    churnNames: (o && o.churnNames) || [],
                    onDone: o && o.onDone,
                    slips: names.map((name, i) => {
                        const cols = Math.min(names.length, 3);
                        const row = Math.floor(i / cols);
                        const rows = Math.ceil(names.length / cols);
                        const col = i % cols;
                        const w = Math.min(baseW, (W * 0.9) / cols);
                        return {
                            name: name,
                            endX: L.cx + (col - (cols - 1) / 2) * (w * 1.06),
                            endY: H * 0.25 + (row - (rows - 1) / 2) * (w * 0.52),
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
                kick();
                redraw();
            },
            clear() {
                queue = [];
                flyers = [];
                spinState = null;
                resting = 0;
                shake = 0;
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
