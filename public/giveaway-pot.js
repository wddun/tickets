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

    // Every slip is drawn in these coordinates and scaled onto the screen in one
    // step, whatever size it is on screen. Only the ratio matters; it is the
    // slips' own 0.44.
    const CARD_W = 200, CARD_H = 88;
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

    // A falling slip's glide is real: each one carries (vx, vy) and every
    // frame integrates actual lift and drag from its current velocity and
    // orientation, the same way a falling card or leaf accelerates and
    // stalls. The lift/drag coefficient curves are lifted directly from
    // Pomerenk & Ristroph, "Equilibria and stability of plates in flowing
    // soap films" (2024/2025, extending Li et al. 2022 and Andersen,
    // Pesavento & Wang, J. Fluid Mech. 541, 2005; arxiv.org/abs/2408.08864,
    // eq. 4.4) — CL1/CL2/CD0/CD1/CDPI2 and the stall-blend constants below
    // are their published numbers, not guesses.
    //
    // The *rotation* deliberately is not derived from that model. A torque
    // driven off the real aerodynamics (the sin(2*alpha) destabilising
    // moment classically used for this — see Tanabe & Kaneko 1994, and the
    // firsthand description in Mahadevan, Ryu & Samuel, "Tumbling cards",
    // Phys. Fluids 11, 1, 1999) is the physically honest choice, but across
    // three tuning passes it was never reliable at this scale: too strong
    // and it read as buzzing, too weak and half the slips barely turned at
    // all, and it could never be pointed at a specific look ("tumble end
    // over end, no bending") on request. A slip's spin is instead a fixed
    // rate chosen at release, gently modulated so it never reads as
    // mechanical — see spawnFlyer. It still turns through real orientations
    // that feed the lift/drag above, it's just not fighting a torque to get
    // there.
    const AERO_CL1 = 5.2, AERO_CL2 = 0.95;
    const AERO_CD0 = 0.1, AERO_CD1 = 5.0, AERO_CDPI2 = 1.9;
    const AERO_ALPHA0 = 14 * Math.PI / 180, AERO_DELTA = 6 * Math.PI / 180;
    // Gravity tuned for a slow, watchable drop — this is a deliberately
    // floaty descent, not a realistic terminal velocity, so there's time to
    // actually see a slip tumble and read its name before it's gone.
    const AERO_K = 0.0034, AERO_GRAVITY = 260;
    // Lift/drag coefficients and centre-of-pressure offset as functions of
    // the angle of attack, valid on alpha ∈ [0, π/2] — folded into that
    // range by the caller, per the symmetry the source paper describes.
    function aeroCoeffs(aFold) {
        const blend = 0.5 * (1 - Math.tanh((aFold - AERO_ALPHA0) / AERO_DELTA));
        const CL = blend * AERO_CL1 * Math.sin(aFold) + (1 - blend) * AERO_CL2 * Math.sin(2 * aFold);
        const s2 = Math.sin(aFold) * Math.sin(aFold);
        const CD = blend * (AERO_CD0 + AERO_CD1 * s2) + (1 - blend) * AERO_CDPI2 * s2;
        return { CL: CL, CD: CD };
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
        // How much of the container's height the pot is allowed to claim
        // before width takes over as the limiting axis — see the comment in
        // layout() below. Split out as an option (rather than a single
        // constant shared by both callers) because the controller's stage is
        // a narrow, tall box (width-bound already, so this rarely even
        // applies) while the presenter display's stage is close to square —
        // the same fraction that looks right on one starves the other of
        // headroom or gives it away for nothing.
        const heightFactor = typeof opts.heightFactor === 'number' ? opts.heightFactor : 0.66;
        // Reads the live "Pot size" / "Space above pot" multiplier straight
        // off the canvas's computed style rather than caching it at create()
        // time — a slider move only ever reaches this module through the
        // caller resizing the canvas's CSS box and calling resize(), so the
        // current value has to be re-read on every layout(), not just once.
        // Falls back to 1 both when a caller (the controller stage) never
        // defines the variable at all and when a slider is mid-drag at an
        // invalid value.
        function readPotMult(varName) {
            const v = parseFloat(getComputedStyle(canvas).getPropertyValue(varName));
            return Number.isFinite(v) && v > 0 ? v : 1;
        }
        let W = 0, H = 0, dpr = 1;
        let seedCounter = 1;

        let queue = [];        // names waiting to be dropped in
        let flyers = [];       // slips currently on screen
        let motes = [];        // celebratory paper thrown up on the reveal
        // A slip that reaches the pot keeps falling — real gravity, a
        // bounce if it drifts into the pot's own wall — until it's fallen
        // far enough to be genuinely out of sight (past the mouth's clip
        // region, under the front lip drawn over everything else), at
        // which point it's removed outright. `resting` only ever counts
        // them; nothing is kept around to look like a pile in the opening.
        let resting = 0;

        let lastReleaseAt = 0;
        // Consecutive slips fan out across the stage in mirrored pairs (see
        // releaseDue) rather than queueing down one column. `releaseIndex`
        // counts every release ever made, `releaseMags` is the sequence of
        // distances-from-centre each pair steps through before repeating.
        let releaseIndex = 0;
        const releaseMags = [0.4, 0.16, 0.28];
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
            // `heightFactor` is deliberately smaller than the width one
            // (0.84): on a wide/short stage (the projector display) it's
            // height, not width, that decides the pot's size, and a factor
            // as big as the width one there meant a taller container just
            // grew a bigger pot instead of leaving more open air for the
            // fall — exactly backwards from wanting slips visible for longer.
            // It's a caller-supplied option rather than a fixed constant for
            // the same reason: the presenter display's near-square stage is
            // height-bound at any reasonable factor, so the value has to be
            // small enough to leave real headroom there, while the
            // controller's narrow, tall stage is comfortably width-bound
            // regardless — a value tuned for one axis-bound regime doesn't
            // need to (and shouldn't have to) also suit the other.
            // The 0.78 zooms the whole pot out from its original size, applied
            // after the axis caps rather than baked into them separately —
            // tweaking the two caps unevenly shrank the pot by a different
            // proportion on a phone-width controller stage (width-bound) than
            // on a wide projector display (height-bound), so the same "zoom
            // out" read as barely-changed on one stage and much-too-small on
            // the other. A single multiplier after the min() keeps both
            // stages shrinking by the same fraction.
            //
            // The operator's "Pot size" / "Space above pot" sliders resize
            // this canvas's own box via CSS (--pot-size-mult scales its
            // width, --pot-headroom-mult its height — see the display page's
            // applyPotStage). Sizing straight off the resulting W/H used to
            // make the two sliders fight each other on this height-bound
            // stage: growing the box to add headroom grew the pot right
            // along with it, so "Space above pot" mostly just made a bigger
            // pot instead of more open air, and "Pot size" did nothing once
            // the height term was already the smaller (binding) one.
            // Dividing each multiplier back out of the measured W/H recovers
            // the box's *un-scaled* reference size, so the natural pot size
            // stays put regardless of how much headroom is dialed in; the
            // size multiplier is then reapplied explicitly, so it's the only
            // thing that changes the pot's size, and headroom is whatever
            // real vertical space the (unaffected) pot doesn't use.
            const sizeMult = readPotMult('--pot-size-mult');
            const headroomMult = readPotMult('--pot-headroom-mult');
            const referenceW = W / sizeMult;
            const referenceH = H / headroomMult;
            let potW = Math.min(referenceW * 0.84, referenceH * heightFactor, 680) * 0.78 * sizeMult;
            potW = Math.min(potW, W * 0.94); // never wider than the box itself, however the sliders are set
            const rx = potW / 2;
            const ry = rx * 0.34;
            const bodyH = potW * 0.72;
            const my = Math.max(0, H - bodyH - ry - H * 0.015);   // mouth centre
            L = {
                cx: W / 2,
                my,
                rx,
                ry,
                baseY: my + bodyH,
                baseRx: rx * 0.74,
                // Big enough that a name is readable at a glance while it falls
                // — the whole point of the style — without a burst of them
                // becoming one solid sheet of paper. Still read as oversized
                // on the presentation screen's wider stage even after the
                // previous pass at this (e68d26e); shrunk again.
                slipW: clamp(W * 0.26, 62, 158),
            };
            L.slipH = L.slipW * 0.44;
        }

        // ── Slips ───────────────────────────────────────────────────────
        // `offsetFrac` is a signed fraction of the spread (±0.5 at the
        // extremes, 0 dead centre) — see releaseDue for how it's chosen.
        function spawnFlyer(name, offsetFrac) {
            const seed = seedCounter++;
            // Fans a burst out across the stage so several names are
            // readable side by side instead of stacking on one column.
            const spread = clamp(W * 0.78, 120, 620);
            const laneX = W / 2 + spread * offsetFrac;
            const backlog = queue.length;
            // Staggered above the top edge rather than all entering on the same
            // line, so consecutive releases don't descend the stage as a rank.
            const startY = -L.slipH * (1 + hashRandom(seed + 43) * 1.6);
            // A big backlog falls faster — the shower has to clear before the
            // next poll lands or the pot never catches up — but never so fast
            // that a name is gone before it can be read. Scales gravity and
            // the aerodynamic force together, which is the same trick the
            // source model uses to non-dimensionalise time: push every force
            // in the simulation up by the same factor and the whole fall
            // plays out faster without changing its character.
            const paceScale = clamp(1 + backlog * 0.0035, 1, 2.3);
            return {
                name: name,
                seed: seed,
                x: laneX + (hashRandom(seed) - 0.5) * spread * 0.14,
                y: startY,
                startY: startY,
                vy: 40 + hashRandom(seed + 51) * 40,
                vx: (hashRandom(seed + 7) - 0.5) * L.slipW * 0.6,
                // Orientation and spin it's released with — a slip doesn't
                // enter perfectly edge-on and still, it's tossed with some
                // tumble already on it, the way a card leaves your fingers.
                // The rate is fixed at release rather than driven by torque
                // (see the comment above aeroCoeffs) — a slow, steady spin
                // one direction the whole way down, which is what reads as
                // tumbling end over end instead of rocking in place.
                theta: hashRandom(seed + 3) * Math.PI * 2,
                omega: (hashRandom(seed + 11) < 0.5 ? -1 : 1) * (3.0 + hashRandom(seed + 13) * 2.6),
                // A slow drift so the rate isn't perfectly mechanical —
                // never enough to flatten out or reverse direction.
                omegaWobble: 0.7 + hashRandom(seed + 17) * 0.5,
                omegaWobbleSeed: hashRandom(seed + 19) * Math.PI * 2,
                paceScale: paceScale,
                t: 0,
                // A second, independent turn about the vertical axis — the
                // coin-flip a piece of paper does as it falls, alternating
                // its printed face toward and away from the room. Not the
                // same motion as the end-over-end tumble above (theta) and
                // doesn't drive it: a card can be turning fast or slow while
                // still flipping face-to-back at its own rate, the way real
                // dropped paper does both at once.
                flipPhase: hashRandom(seed + 71) * Math.PI * 2,
                flipRate: 1.8 + hashRandom(seed + 73) * 1.6,
                // A third, also independent turn — about the card's own
                // long (horizontal) axis this time, so the long top and
                // bottom edges swap places over the card's short dimension,
                // rather than the short left/right edges swapping over the
                // long one the way flipPhase does. Combined with the other
                // two this is what makes a slip read as genuinely tumbling
                // in every direction instead of spinning on one fixed axis.
                tumblePhase: hashRandom(seed + 81) * Math.PI * 2,
                tumbleRate: 2.0 + hashRandom(seed + 83) * 1.8,
                tone: PAPER_TONES[seed % PAPER_TONES.length],
                scale: 1,
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
            const live = flyers.filter(f => !f.churn).length;
            if (live >= plan.maxInFlight) return;
            // Every pair of releases lands mirrored across the centre line —
            // one left, one right, at the same distance — so any run of
            // slips balances itself as it goes instead of drifting to one
            // side. The distance cycles through releaseMags pair by pair,
            // which is what keeps a long stream from reading as two fixed
            // columns either side of the pot.
            const pairIdx = Math.floor(releaseIndex / 2);
            const mag = releaseMags[pairIdx % releaseMags.length];
            const side = releaseIndex % 2 === 0 ? 1 : -1;
            releaseIndex++;
            flyers.push(spawnFlyer(queue.shift(), side * mag));
            lastReleaseAt = now;
        }

        function updateFlyers(dt) {
            for (let i = flyers.length - 1; i >= 0; i--) {
                const f = flyers[i];
                f.t += dt;

                if (f.churn) {
                    // Jostled inside a shaking bucket, not thrown on a clean
                    // parabola: a random sideways kick lands every fraction of
                    // a second on top of gravity, so it reads as being tumbled
                    // around rather than tossed once and falling back.
                    f.jitterAt = (f.jitterAt || 0) - dt;
                    if (f.jitterAt <= 0) {
                        f.jitterAt = 0.05 + hashRandom(seedCounter++) * 0.08;
                        f.vx += (hashRandom(seedCounter++) - 0.5) * 300;
                    }
                    f.vy += 2400 * dt;
                    f.y += f.vy * dt;
                    f.x += f.vx * dt;
                    // Bounces off the inside of the rim instead of drifting
                    // past it, so a burst of them visibly rattles in place.
                    const bound = L.rx * 1.05;
                    if (f.x < L.cx - bound) { f.x = L.cx - bound; f.vx = Math.abs(f.vx) * 0.5; }
                    if (f.x > L.cx + bound) { f.x = L.cx + bound; f.vx = -Math.abs(f.vx) * 0.5; }
                    f.theta += f.omega * dt;
                    if (f.y > L.my + L.ry * 0.4 && f.vy > 0) flyers.splice(i, 1);
                    continue;
                }

                const entryY = L.my - L.ry * 0.3;
                if (f.y < entryY) {
                    // Real lift and drag, integrated in the slip's own body
                    // frame each substep (see aeroCoeffs above for where the
                    // coefficient curves come from) — this is what replaced a
                    // hand-tuned sine oscillator with an actual falling-plate
                    // simulation for the glide. Substepped rather than
                    // integrated once at the frame's own dt: the forces are
                    // quadratic in speed and this is a stiff enough system
                    // that a single ~16ms step visibly misbehaves (it's how
                    // the very first version of this blew up into a
                    // multi-hundred-rad/s spin, back when rotation was also
                    // driven through this loop).
                    const SUBSTEPS = 4;
                    const sdt = dt / SUBSTEPS;
                    const g = AERO_GRAVITY * f.paceScale;
                    const aeroK = AERO_K * f.paceScale;
                    for (let sub = 0; sub < SUBSTEPS; sub++) {
                        const uCx = Math.sin(f.theta), uCy = -Math.cos(f.theta);
                        const uWx = Math.cos(f.theta), uWy = Math.sin(f.theta);
                        // Body-frame velocity: x' along the chord (the card's
                        // short/tumbling axis), y' perpendicular to it.
                        const vxp = f.vx * uCx + f.vy * uCy;
                        const vyp = f.vx * uWx + f.vy * uWy;
                        const q = Math.hypot(vxp, vyp);
                        if (q > 1e-4) {
                            const a = Math.atan2(vyp, vxp);
                            const b = Math.abs(a) % Math.PI;
                            const aFold = Math.min(b, Math.PI - b);
                            const co = aeroCoeffs(aFold);
                            // Lift perpendicular to the relative flow, drag
                            // opposing it — same construction as the source,
                            // in body-frame components. Lift also carries a
                            // cos(theta) sign: converting a body-frame force
                            // to world coordinates using the card's own
                            // current rotation, then folding CL/CD's angle
                            // into [0, pi/2] for magnitude only, otherwise
                            // makes the lift's WORLD-frame direction come out
                            // independent of theta entirely — it collapses to
                            // "whatever's 90 degrees off the world velocity,"
                            // full stop. For a fall that's dominated by
                            // straight-down gravity, that's the same
                            // direction for every slip, every frame: a
                            // constant sideways push, not a wobble — which
                            // is exactly the rightward drift this fixes. A
                            // real plate's lift direction flips with which
                            // face is presented to the flow, i.e. with a
                            // period of pi, not 2*pi (turning it 180 degrees
                            // is the same physical shape) — cos(theta) is
                            // the missing piece of that symmetry, and
                            // reintroducing it is what makes the sideways
                            // push flip with the tumble instead of pointing
                            // one way for the whole fall.
                            const liftSign = Math.cos(f.theta);
                            const liftX = liftSign * co.CL * q * vyp, liftY = -liftSign * co.CL * q * vxp;
                            const dragX = -co.CD * q * vxp, dragY = -co.CD * q * vyp;
                            const Fxp = liftX + dragX, Fyp = liftY + dragY;
                            f.vx += (Fxp * uCx + Fyp * uWx) * aeroK * sdt;
                            f.vy += (Fxp * uCy + Fyp * uWy) * aeroK * sdt;
                        }
                        f.vy += g * sdt;
                        f.x += f.vx * sdt;
                        f.y += f.vy * sdt;
                    }
                    // The end-over-end tumble — a fixed rate, not aerodynamic
                    // torque (see the comment above aeroCoeffs for why) —
                    // with a slow modulation so it doesn't read as a motor.
                    // The wobble factor stays well clear of zero, so the spin
                    // never stalls or reverses; it just breathes a little.
                    const wobble = 0.82 + 0.24 * Math.sin(f.t * f.omegaWobble + f.omegaWobbleSeed);
                    f.theta += f.omega * wobble * dt;
                    // A real dropped card has a whole room to land in; this
                    // one only has the width of the canvas, and the lift the
                    // aerodynamics above generates is easily strong enough to
                    // carry it well past the pot before it ever reaches
                    // entryY — a weaker pull here just lost that tug-of-war
                    // outright and let slips drift off the stage without
                    // ever landing. This nudge is strong enough to win it,
                    // and the hard bound below is the backstop for whatever
                    // it doesn't catch in time.
                    f.vx += (L.cx - f.x) * 2.4 * dt;
                    const xBound = clamp(L.rx * 2.3, W * 0.18, W * 0.48);
                    if (f.x < L.cx - xBound) { f.x = L.cx - xBound; f.vx = Math.abs(f.vx) * 0.35; }
                    if (f.x > L.cx + xBound) { f.x = L.cx + xBound; f.vx = -Math.abs(f.vx) * 0.35; }

                    // The two coin-flips (see spawnFlyer) run on their own
                    // clocks, a little faster when the real tumble is livelier.
                    f.flipPhase += (f.flipRate + Math.abs(f.omega) * 0.12) * dt;
                    f.tumblePhase += (f.tumbleRate + Math.abs(f.omega) * 0.1) * dt;

                    // Approach: the last stretch is the slip travelling away
                    // from the viewer and down into the opening, not just down
                    // the screen, so it starts to recede before it ever
                    // reaches the rim. Uniform, never squashed on one axis
                    // alone — something further away shrinks in both
                    // directions at once, and squashing only its height would
                    // change the card's proportions while the name is still
                    // being read.
                    const approach = clamp((f.y - (entryY - L.slipH * 1.6)) / (L.slipH * 1.6), 0, 1);
                    f.scale = 1 - approach * 0.14;
                    continue;
                }

                // Past the rim: it keeps falling under plain gravity, with a
                // bounce if it drifts into the pot's own inner wall instead
                // of a hard stop, until it's dropped far enough to be
                // genuinely out of sight — clipped away by the mouth's own
                // clip region (see clipToMouth/draw), with the front lip
                // drawn over everything else as a second backstop. At that
                // point it's removed outright. No pile object to hand off
                // to and nothing left on screen to represent it: it drops
                // in, goes far enough to disappear, and is gone.
                f.vy += 700 * dt;
                f.x += f.vx * dt;
                f.y += f.vy * dt;
                const wallBound = L.rx * 0.85;
                if (f.x < L.cx - wallBound) { f.x = L.cx - wallBound; f.vx = Math.abs(f.vx) * 0.4; }
                if (f.x > L.cx + wallBound) { f.x = L.cx + wallBound; f.vx = -Math.abs(f.vx) * 0.4; }
                // Keeps turning at the same rate it was spinning at the
                // instant it crossed the rim — freezing it here instead
                // read as a glitch of its own: a card visibly tumbling the
                // whole way down would suddenly lock still while continuing
                // to fall and disappear.
                f.theta += f.omega * dt;
                f.flipPhase += f.flipRate * dt;
                f.tumblePhase += f.tumbleRate * dt;

                const goneY = L.my + L.ry * 1.3;
                if (f.y >= goneY) {
                    flyers.splice(i, 1);
                    resting++;
                    shake = Math.min(1, shake + 0.06);
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

        // The card's outline, rounded at the corners and bowed by `curl` — the
        // top and bottom edges flex toward or away from each other at their
        // midpoint (a pinch or a barrel, depending on curl's sign) while the
        // corners stay exactly where a flat card's would be. That "corners
        // anchored, midline flexes" shape is what keeps the card's own centre
        // — which is where the name is drawn — from moving: a bow that instead
        // shifted the top and bottom edges the same direction (an earlier
        // version of this did) translates the whole visible card while the
        // text drawn on it stays put in card-space, so the name visibly slides
        // and re-centres against the paper every time curl changes sign.
        const CARD_R = CARD_H * 0.07;
        function cardPath(curl) {
            const r = CARD_R;
            const bow = (curl || 0) * CARD_H * 0.55;
            ctx.beginPath();
            ctx.moveTo(-CARD_W / 2 + r, -CARD_H / 2);
            ctx.quadraticCurveTo(0, -CARD_H / 2 + bow, CARD_W / 2 - r, -CARD_H / 2);
            ctx.quadraticCurveTo(CARD_W / 2, -CARD_H / 2, CARD_W / 2, -CARD_H / 2 + r);
            ctx.lineTo(CARD_W / 2, CARD_H / 2 - r);
            ctx.quadraticCurveTo(CARD_W / 2, CARD_H / 2, CARD_W / 2 - r, CARD_H / 2);
            ctx.quadraticCurveTo(0, CARD_H / 2 - bow, -CARD_W / 2 + r, CARD_H / 2);
            ctx.quadraticCurveTo(-CARD_W / 2, CARD_H / 2, -CARD_W / 2, CARD_H / 2 - r);
            ctx.lineTo(-CARD_W / 2, -CARD_H / 2 + r);
            ctx.quadraticCurveTo(-CARD_W / 2, -CARD_H / 2, -CARD_W / 2 + r, -CARD_H / 2);
            ctx.closePath();
        }

        // A name is laid out ONCE, in the card's own coordinates, and cached.
        // Fitting it to the slip's current on-screen size every frame is what
        // made the type look like it was swelling and shrinking against the
        // paper: the fitter picks a whole-pixel size, the slip's height changes
        // a little on every frame of its fall, and the name jumps a size at each
        // threshold it crosses. Type printed on a card does not do that.
        const nameLayouts = new Map();
        function cardName(name, maxLines) {
            const key = maxLines + '\u0000' + name;
            let fit = nameLayouts.get(key);
            if (!fit) {
                // The whole block of `maxLines` lines has to fit the card's
                // text band, not just each line's width on its own. Picking
                // the widest px that satisfies width alone — the old bug — can
                // choose a size whose second line sits below the card's own
                // bottom edge, which read as the name falling off the paper.
                const startPx = Math.min(CARD_H * 0.42, (CARD_H * 0.58) / (maxLines * 1.14));
                fit = layoutName(ctx, name, CARD_W * 0.82, startPx, CARD_H * 0.15, maxLines);
                // A giveaway can run for hours with names arriving the whole
                // time; this is a cache, not a ledger.
                if (nameLayouts.size > 500) nameLayouts.clear();
                nameLayouts.set(key, fit);
            }
            return fit;
        }

        // A slip, drawn face-on at `turn`=1 and edge-on at `turn`=0. Squashing
        // the horizontal axis by the cosine of its tumble is what sells these as
        // pieces of paper turning over rather than sprites sliding down.
        //
        // The card and everything printed on it are drawn in one fixed
        // coordinate system and scaled onto the screen in a single step, so the
        // name is fixed to the paper: it turns with it, recedes with it, and
        // keeps exactly the same place on it however big the slip is drawn.
        //
        // `shade` (0..1) is how much of the pot's interior darkness has fallen
        // over it. Nothing inside a pot is lit like something in front of one,
        // and losing the light on the way down does more to sell the depth than
        // the shrinking does.
        //
        // `glowColor`/`glowBlur` replace the paper's own cast shadow, for the
        // one slip that is being held up as the winner rather than falling.
        function drawSlip(o) {
            const face = Math.abs(o.turn);
            // `tumble` is the second, independent flip axis (see slipDraw) —
            // callers that don't set it (the winner rising out of the pot,
            // the reveal, the celebration motes) get 1, i.e. no extra
            // squash, so this is a no-op for every draw path except a
            // falling slip.
            const tumble = o.tumble == null ? 1 : Math.abs(o.tumble);
            const shade = o.shade || 0;
            ctx.save();
            ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
            ctx.translate(o.x, o.y);
            ctx.rotate(o.rot);

            if (face < 0.1 || tumble < 0.1) {
                // Edge-on: a lit sliver, no face, no text. Both dimensions
                // still scale continuously with face/tumble, same as the
                // normal card render below (ctx.scale by face and tumble) —
                // only the axis actually going edge-on gets floored to a
                // minimum visible width, or it snaps from a scaled height
                // straight to the full unscaled one right at this
                // threshold, which read as the slip suddenly growing
                // *longer* the instant it went thin.
                const thin = face < tumble;
                let w = o.w * face;
                let h = o.h * tumble;
                if (thin) w = Math.max(2.4, w); else h = Math.max(2.4, h);
                ctx.fillStyle = `rgba(255,255,255,${(0.55 * (1 - shade)).toFixed(3)})`;
                ctx.fillRect(-w / 2, -h / 2, w, h);
                ctx.restore();
                return;
            }

            // Set from the on-screen size, not the card's: canvas shadow offsets
            // and blurs are in device space and ignore the transform below.
            ctx.shadowColor = o.glowColor || 'rgba(0,0,0,0.45)';
            ctx.shadowBlur = o.glowBlur != null ? o.glowBlur : Math.abs(o.h) * 0.35;
            ctx.shadowOffsetY = o.glowColor ? 0 : Math.abs(o.h) * 0.12;

            // Into card space. `face` rides the horizontal scale and `tumble`
            // the vertical one — two independent flip axes, not one.
            ctx.scale((o.w / CARD_W) * face, (o.h / CARD_H) * tumble);
            cardPath(o.curl);
            ctx.fillStyle = o.tone;
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Which side is showing is whichever face an ODD number of the
            // two flips has turned up — two half-flips cancel out, one
            // doesn't, same as physically turning a card over twice.
            const showingBack = (o.turn < 0) !== (o.tumble < 0);
            if (showingBack) {
                // Backs of slips get no text — you're looking at the reverse side.
                ctx.strokeStyle = 'rgba(0,0,0,0.10)';
                ctx.lineWidth = CARD_H * 0.012;
                for (let i = 1; i <= 3; i++) {
                    const ly = -CARD_H / 2 + (CARD_H * i) / 4;
                    ctx.beginPath();
                    ctx.moveTo(-CARD_W * 0.36, ly);
                    ctx.lineTo(CARD_W * 0.36, ly);
                    ctx.stroke();
                }
            } else {
                // Torn-from-a-pad top edge, then the name.
                ctx.strokeStyle = 'rgba(0,0,0,0.07)';
                ctx.lineWidth = CARD_H * 0.012;
                ctx.beginPath();
                ctx.moveTo(-CARD_W * 0.38, -CARD_H * 0.22);
                ctx.lineTo(CARD_W * 0.38, -CARD_H * 0.22);
                ctx.stroke();

                // Below about a third of a slip's full size the text is a
                // smudge rather than a name, so it is faded off rather than cut
                // off — a hard threshold takes the name away while the paper is
                // still plainly there, which looks like a rendering fault.
                const textAlpha = clamp((Math.abs(o.h) / L.slipH - 0.22) / 0.20, 0, 1);
                if (o.name && textAlpha > 0.01) {
                    const base = o.opacity == null ? 1 : o.opacity;
                    ctx.globalAlpha = base * textAlpha;
                    const fit = cardName(o.name, o.maxLines || 1);
                    ctx.font = `700 ${fit.px}px ${FONT_STACK}`;
                    ctx.fillStyle = INK;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    const lh = fit.px * 1.14;
                    const y0 = CARD_H * 0.09 - (fit.lines.length - 1) * lh / 2;
                    fit.lines.forEach((line, i) => ctx.fillText(line, 0, y0 + i * lh));
                    ctx.globalAlpha = base;
                }
            }

            if (shade > 0) {
                cardPath(o.curl);
                ctx.fillStyle = `rgba(3,5,11,${shade.toFixed(3)})`;
                ctx.fill();
            }
            ctx.restore();
        }

        function slipDraw(f) {
            const scale = f.scale || 1;
            return {
                x: f.x, y: f.y,
                w: L.slipW * scale,
                h: L.slipH * scale,
                // `theta` is the slip's real, physically-simulated tumble —
                // the axis it turns about points straight out of the screen
                // (the mechanism Mahadevan, Ryu & Samuel describe watching:
                // "the axis of rotation always points out of the plane of
                // the paper") — so it's drawn rotating in the screen plane,
                // never squashed down to an edge-on sliver by this angle.
                // `turn` is the separate, independent face/back flip
                // (`flipPhase` for a fall, `theta` reused for churn, which
                // has no flip of its own) — the coin-flip alternation of
                // which side faces the room, layered on top of the real
                // in-plane spin rather than replacing it. `tumble` is a
                // third, independent turn about the card's long axis — its
                // long top and bottom edges swapping over its short
                // dimension, the "end over end" companion to turn's
                // short-edges-over-long-dimension flip.
                rot: f.theta,
                turn: Math.cos(f.churn ? f.theta : f.flipPhase),
                tumble: f.churn ? 1 : Math.cos(f.tumblePhase),
                // No bow: a falling slip stays a flat, crisp card. It used
                // to flex with its spin rate, but that read as bending
                // across the wrong axis more often than it read as paper.
                curl: 0,
                tone: f.tone,
                name: f.name,
            };
        }

        // Just the opening itself. This used to be a compound path — this
        // ellipse unioned with a big rect covering the open air above the
        // rim, so a slip only half-swallowed could still show its top
        // sticking up over the far edge instead of getting a hard clip line
        // across it. That relied on canvas engines treating an oversized
        // rect and an ellipse subpath as one clean union under the nonzero
        // winding rule, and on Safari specifically it didn't hold: slips
        // flickered behind the back wall and a visible black box appeared
        // above the pot, neither reproducible in Chromium. A single simple
        // shape has no unioning to get wrong. inMouth() below now delays
        // the switch into this clip until a slip is already comfortably
        // inside the ellipse's own width, not right at its pinched-shut top
        // edge, which is what made the plain rect unnecessary in the first
        // place — see the comment there.
        function clipToMouth() {
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx * 0.94, L.ry * 0.92, 0, 0, Math.PI * 2);
            ctx.clip();
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

            // The lip: a plain metal band around the front half of the rim —
            // the same material as the body, just brighter, the way a bucket's
            // rolled edge catches more light than its sides — faded out at
            // both ends into the shadowed sides instead of stopping dead where
            // the ellipse does.
            const lipW = Math.max(3, L.ry * 0.32);
            const band = ctx.createLinearGradient(L.cx - L.rx, 0, L.cx + L.rx, 0);
            band.addColorStop(0, 'rgba(0,0,0,0)');
            band.addColorStop(0.16, '#7c85a1');
            band.addColorStop(0.5, '#c9d0e2');
            band.addColorStop(0.86, '#7c85a1');
            band.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.beginPath();
            ctx.ellipse(L.cx, L.my, L.rx, L.ry, 0, 0.04, Math.PI - 0.04);
            ctx.lineWidth = lipW;
            ctx.strokeStyle = band;
            ctx.globalAlpha = 0.9;
            ctx.stroke();
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

        // A slip switches to being clipped through the opening (see
        // clipToMouth) once it's dropped a bit past the rim's own top edge
        // — not the instant it crosses it. The mouth ellipse pinches to
        // zero width at its very top point, so clipping a slip in there
        // right away would crop nearly the whole card in one frame; by
        // L.ry * 0.6 below centre the ellipse is already better than
        // three-quarters as wide as at its middle, wide enough that the
        // switch from fully visible to clipped doesn't read as a pop. Above
        // this line a slip is still drawn in full, unclipped, in front of
        // the pot's own back wall — close enough to the opening that the
        // difference isn't visible for the brief moment it takes to cross.
        function inMouth(f) {
            return f.y > L.my - L.ry * 0.6;
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

        // What a gripped bucket does under a hand, not what a machine does: a
        // slower sway carries the whole motion the way an arm does, a faster
        // judder rides on top the way a grip trembles, and — since none of
        // these periods share a common factor — the sum never lands on a beat
        // the eye can anticipate. The single clean sine this replaced had
        // exactly one frequency, so a shake read as a mechanism vibrating
        // rather than a person shaking something.
        function handShake(now) {
            const t = now / 1000;
            const x = 0.60 * Math.sin(t * 17.3 + 0.7)
                    + 0.27 * Math.sin(t * 28.6 + 2.4)
                    + 0.15 * Math.sin(t * 47.9 + 4.1);
            const y = 0.58 * Math.abs(Math.sin(t * 14.1 + 1.3))
                    + 0.28 * Math.abs(Math.sin(t * 36.5 + 3.6));
            const twist = Math.sin(t * 21.4 + 1.9);
            return { x, y, twist };
        }

        function draw(now) {
            ctx.clearRect(0, 0, W, H);

            // The whole pot wobbles during a shake; the slips in the air do not,
            // so the pot moves under them the way a real one would.
            const hs = shake > 0 ? handShake(now) : null;
            const wob = hs ? hs.x * shake * L.rx * 0.10 : 0;
            const wobY = hs ? hs.y * shake * L.ry * 0.32 : 0;
            const withPot = (fn) => {
                ctx.save();
                ctx.translate(wob, -wobY);
                ctx.rotate(hs ? (wob / (L.rx * 7) + hs.twist * shake * 0.03) : 0);
                fn();
                ctx.restore();
            };

            withPot(() => { drawFloor(); drawPotBack(); });

            // Still in open air, in front of and above the pot — including a
            // slip the shake has thrown clear of the rim, which is above the
            // mouth clip's region and would be sliced off along a dead-straight
            // line partway across the paper if it were drawn inside it.
            for (const f of flyers) {
                if (inMouth(f)) continue;
                drawSlip(slipDraw(f));
            }
            // Whatever's still on its way through the opening — clipped to
            // the mouth and moving with the pot as one, so a shaken pot
            // takes it with it, and cut off cleanly by the rim on the way
            // down rather than fading out on top of it. Nothing stays here
            // once it's fallen far enough to disappear (see updateFlyers).
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
                    // Reveal draws this same card at maxLines:2 the instant
                    // the rise ends — matching that here, instead of the
                    // maxLines:1 this used to carry, is what removed the
                    // "one line, then two" snap: a long name used to get
                    // truncated with an ellipsis for the whole rise and then
                    // re-wrap onto two lines at a smaller font in the same
                    // frame the reveal took over. Same tone too, so nothing
                    // about the card visibly swaps at that handoff — only
                    // its size, position and glow keep animating.
                    tone: '#fffdf4', name: s.name,
                    maxLines: 2,
                    // Settles flat as it arrives; still a little unsettled
                    // mid-flight, the way paper flexes while it's moving.
                    curl: 0.07 * Math.sin(s.phase * 1.5 + s.tilt) * (1 - settled),
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
            // Full height from the first frame of reveal — the rise this
            // hands off from already ends with the card open (see the
            // `settled` ramp in drawSpinSlips), so animating height here too
            // snapped it shut and back open again: unfolded once at the top
            // of the rise, then a second, spurious fold-and-unfold right on
            // top of it. One unfold per draw, not two.
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
                        jitterAt: 0,
                        t: 0, theta: hashRandom(seed + 6) * 6.28,
                        omega: 5 + hashRandom(seed + 8) * 5,
                        tone: PAPER_TONES[seed % PAPER_TONES.length],
                        scale: 0.82,
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
                || shake > 0.002);
        }

        function frame(now, gen) {
            if (destroyed || gen !== loopGen) return;
            const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
            lastFrame = now;

            if (spinState) updateSpin(now, dt);
            else shake = Math.max(0, shake - dt * 1.8);

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
            // Slips already in the pot when the page loaded — no animation,
            // the room didn't watch those arrive, so the count just starts
            // there rather than being simulated in one by one.
            setResting(n) {
                resting = Math.max(0, n | 0);
                redraw();
            },
            // Accepted and ignored. The pot no longer prints anything on
            // itself — a number pressed into the side of the bucket competed
            // with the names, and both pages already show the count in their own
            // markup, in type meant to be read. Kept because both of them call
            // it, and a caller shouldn't have to know which of the pot's styles
            // has a place to put a caption.
            setLabel() {},
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
                // Sized off the same ratio as the falling slips (~0.26 of the
                // stage), not the far larger W*0.78/380 this used to allow —
                // the revealed winner is one ticket, not a poster.
                const slipW = Math.min(W * 0.6, 300, (W * 0.68) / cols, (air * 1.55) / (0.55 + rows * 0.45));
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
