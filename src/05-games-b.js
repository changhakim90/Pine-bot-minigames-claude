
/* =====================================================================
 * 05 — drivers B: Where Is My Shot?, Fresh Squeeze, Tip Catch, Fly Swat,
 *                 Glass Stack, Table Rush
 * ===================================================================== */

// ---------------------------------------------------------------- WHERE IS MY SHOT?
// Covers are drawn every frame in cups-array order, so "the i-th cover" is a
// stable identity through the shuffle. During 'place' the shot is drawn at
// its cover's x → remember that index, tap that cover when 'WHERE IS IT? TAP!'
// shows. Rounds continue until the target, then a wrong cover on purpose.
defineDriver('WHERE IS MY SHOT?', {
    kind: 'unbounded', defaultTarget: 25,
    make(ctx) {
        let round = 0, shotIdx = -1, picked = 0, failed = false, waitingFor = 'ROUND hud', lastN = 0;
        return {
            frame(F) {
                const c = input.el('hh_fpcv');
                if (!c || failed) return;
                const rt = F.text(/^ROUND (\d+)$/, { x: 12, y: 28, d: 4 });
                if (!rt) { waitingFor = 'ROUND hud'; return; }
                ctx.alive();                    // on the WS screen — watching/shuffling is not a stall
                waitingFor = '';
                if (+rt.m[1] !== round) { round = +rt.m[1]; shotIdx = -1; picked = 0; }
                // Covers by sprite name; if the artwork is unnamed for any reason, fall back to
                // the shadow ellipses the game draws once per cover (ry 8) and under the shot (ry 7).
                let covers = F.img('ws_cover');
                let shot = F.img('ws_shot')[0];
                if (!covers.length) covers = F.ellipses.filter(o => Math.abs(o.y - 332) < 1 && Math.abs(o.ry - 8) < 0.6).map(o => ({ cx: o.x }));
                if (!shot) { const e = F.ellipses.find(o => Math.abs(o.y - 330) < 1 && Math.abs(o.ry - 7) < 0.6); if (e) shot = { cx: e.x }; }
                if (shot && covers.length && (F.has('WATCH THE SHOT!') || F.has('FIND IT!'))) {
                    let best = -1, bd = 1e9;
                    covers.forEach((o, i) => { const d = Math.abs(o.cx - shot.cx); if (d < bd) { bd = d; best = i; } });
                    if (bd < 3) shotIdx = best;
                }
                if (!F.has('WHERE IS IT? TAP!') || picked === round) return;
                if (!covers.length) {
                    // nothing recognisable was drawn (artwork still loading): the cup positions are
                    // pure geometry — cupX(slot, n) with n = min(5, 1 + round) — so tap anyway
                    // rather than sit in a round that never ends
                    const n = Math.min(5, 1 + round), sp = Math.min(96, 340 / Math.max(1, n - 1));
                    covers = Array.from({ length: n }, (_, i) => ({ cx: 200 + (i - (n - 1) / 2) * sp }));
                    ctx.log('covers not drawn — tapping by geometry');
                }
                picked = round;
                let idx = shotIdx >= 0 ? shotIdx : 0;
                if (round >= ctx.target.v || ctx.overBudget()) { idx = (idx + 1) % covers.length; failed = true; ctx.log('KO on purpose at round', round, '(target', ctx.target.v + ')'); }
                else if (shotIdx < 0) ctx.log('lost the shot this round — guessing');
                input.down(c, covers[idx].cx, 288, c);
                lastN = covers.length;
                ctx.acted();
            },
            state() { return { round, shotIdx, picked, failed, waitingFor, covers: lastN }; }
        };
    }
});

// ---------------------------------------------------------------- FRESH SQUEEZE
// grab → cut → load → press (420 ms timer, +25 ml) → trash → … One burst of
// seven gestures advances the state machine from any phase to 'pressing'
// (every other gesture is a no-op in the phases it does not belong to). The
// next burst is scheduled 421 ms after each press, right behind the game's own timer.
const SQ = { BK: { x: 58, y: 300 }, BD: { x: 175, y: 398 }, SZ: { x: 292, y: 186 }, TR: { x: 334, y: 492 } };
defineDriver('FRESH SQUEEZE', {
    kind: 'capped',
    make(ctx) {
        let play = false, lastBurst = 0, timer = null, bursts = 0, stopped = false;
        const burst = () => {
            const c = input.el('hh_fpcv');
            if (!c || stopped) return;
            const { BK, BD, SZ, TR } = SQ;
            input.drag(c, SZ.x, SZ.y, TR.x, TR.y);            // trash spent half
            input.drag(c, BD.x, BD.y, SZ.x, SZ.y);            // load a half
            input.drag(c, SZ.x, SZ.y, SZ.x, SZ.y + 60);       // press (slide down)
            input.drag(c, BK.x, BK.y, BD.x, BD.y);            // grab a lime to the board
            input.drag(c, BD.x - 30, BD.y, BD.x + 30, BD.y);  // slice
            input.drag(c, BD.x, BD.y, SZ.x, SZ.y);            // load
            input.drag(c, SZ.x, SZ.y, SZ.x, SZ.y + 60);       // press
            lastBurst = now(); bursts++; ctx.acted();
            if (timer) clearTimeout(timer);
            timer = setTimeout(burst, 421);
        };
        return {
            frame(F) {
                if (stopped) return;
                if (F.has('TIME UP!')) { stopped = true; if (timer) clearTimeout(timer); return; }
                if (!F.has('FRESH LIME JUICE')) return;
                ctx.alive();
                if (!play) { play = true; burst(); return; }
                if (now() - lastBurst > 470) burst();      // safety net if a timer was lost
            },
            stop() { stopped = true; if (timer) clearTimeout(timer); },
            result(m) { ctx.log('ml', m && m.v, 'bursts', bursts); }
        };
    }
});

// ---------------------------------------------------------------- TIP CATCH
// Items fall straight (receipts sway); the jar follows the pointer with
// jarX += (jarTX - jarX)·min(1, dt·14) and catches at y∈(318,352), |x-jarX|<37.
// Each frame the driver tracks every item's velocity, picks the earliest good
// item the jar can still reach without swallowing a bad one, and moves there.
const TC_GOOD = { bill_10000: 2, bill_50000: 3, coin_gold: 1 };
const TC_BAD = /^(bottle_|tc_receipt|tc_env|tc_cap)/;
defineDriver('TIP CATCH', {
    kind: 'capped',
    tunables: { safety: { min: 0, max: 12, step: 2, init: 4, explore: 0.2 }, horizonSec: { min: 0.5, max: 2.0, step: 0.25, init: 1.2, explore: 0.15 } },
    make(ctx) {
        let prev = [], jarX = 200, lastTX = null, waitingFor = 'play', chasing = false;
        return {
            frame(F) {
                const c = input.el('hh_fpcv');
                if (!c || F.has('TIME UP!')) return;
                // in play once the coin/timer HUD is up — a frame with no reachable item is not a stall
                if (!F.text(/^x \d+$/, { x: 44, y: 38, d: 8 }) && !F.text(/^\d+\.\ds$/, { x: 280, y: 38, d: 10 })) { waitingFor = 'tip-catch HUD'; return; }
                ctx.alive();
                waitingFor = '';
                const dt = F.dt;
                // The jar is where the game's own lerp puts it: jarX += (jarTX - jarX)·min(1, dt·14).
                // Read it from the sprite when it is drawn, and keep the model in step so a missing
                // jar image (artwork still loading) cannot stop the driver.
                const jar = F.img('tc_jar')[0];
                if (jar) jarX = jar.cx;
                else if (lastTX != null) jarX += (lastTX - jarX) * Math.min(1, dt * 14);
                // track items: match to previous frame by name and proximity
                const items = [];
                for (const o of F.imgs) {
                    const good = TC_GOOD[o.src];
                    if (!good && !TC_BAD.test(o.src)) continue;
                    let m = null, bd = 40;
                    for (const p of prev) { if (p.src !== o.src || p.used) continue; const d = Math.abs(p.x - o.cx) + Math.abs(p.y + p.vy * dt - o.cy); if (d < bd) { bd = d; m = p; } }
                    const vy = m ? clamp((o.cy - m.y) / dt, 120, 420) : 220;
                    if (m) m.used = true;
                    items.push({ src: o.src, x: o.cx, y: o.cy, vy: m ? (m.vy * 0.5 + vy * 0.5) : vy, good: good || 0, sway: o.src === 'tc_receipt' });
                }
                prev = items;
                const q = 1 - Math.min(1, dt * 14);
                const H = ctx.params.horizonSec / dt;               // lookahead in FRAMES (horizon is seconds)
                const reach = ctx.params.safety;                    // px inside the 37 px window we insist on
                // frames until an item reaches the window entry (y > 318) and exit (y ≥ 352)
                const eta = it => ({ in: Math.max(0, (318.5 - it.y) / (it.vy * dt)), out: Math.max(0, (351.5 - it.y) / (it.vy * dt)) });
                const bads = items.filter(i => !i.good).map(i => Object.assign({ e: eta(i) }, i));
                let best = null;
                for (const it of items) {
                    if (!it.good) continue;
                    const e = eta(it);
                    if (e.out <= 0 || e.in > H) continue;
                    const d0 = Math.abs(it.x - jarX);
                    const need = d0 <= 37 - reach ? 0 : Math.log((37 - reach) / d0) / Math.log(q);
                    if (need > e.out - 1) continue;
                    // reject only a bad item that would actually be in the catch window (|dx|<40)
                    // at the same time we are there (overlapping frames) — 37px is the catch radius
                    const risky = bads.some(b => Math.abs(b.x - it.x) < 40 && b.e.in < e.out && b.e.out > e.in);
                    if (risky) continue;
                    const score = e.in - it.good * 3;
                    if (!best || score < best.score) best = { it, score };
                }
                let tx;
                if (best) tx = best.it.x;
                else {
                    // nothing catchable: dodge a bad item about to be caught; otherwise hold
                    const threat = bads.find(b => b.e.in * dt < 0.08 && Math.abs(b.x - jarX) < 40);
                    tx = threat ? (threat.x > jarX ? threat.x - 80 : threat.x + 80) : jarX;
                }
                tx = clamp(tx, 36, 364);
                chasing = !!best;
                if (lastTX == null || Math.abs(tx - lastTX) > 0.01) { input.move(c, tx, 380, c); lastTX = tx; ctx.acted(); }
            },
            state() { return { jarX: Math.round(jarX), targetX: lastTX == null ? null : Math.round(lastTX), items: prev.length, chasingGood: chasing, waitingFor }; }
        };
    }
});

// ---------------------------------------------------------------- FLY SWAT
// A tap kills the nearest fly within 32 px. Every fly on screen (fs_fly1/2,
// drawn rotated to its heading) gets one pointerdown at its own centre, every
// frame — nothing ever lands on the fruit.
defineDriver('FLY SWAT', {
    kind: 'capped',
    make(ctx) {
        let shots = 0;
        return {
            frame(F) {
                const c = input.el('hh_fpcv');
                if (!c || F.has('TIME UP!')) return;
                if (!F.text(/^x \d+$/, { x: 14, y: 38, d: 4 })) return;      // HUD only in 'play'
                ctx.alive();
                for (const o of F.imgs) {
                    if (!/^fs_fly[12]$/.test(o.src)) continue;      // the intro's big fly is fs_bigfly
                    input.down(c, o.cx, o.cy, c); shots++; ctx.acted();
                }
            },
            result(m) { ctx.log('flies', m && m.v, 'shots', shots); }
        };
    }
});

// ---------------------------------------------------------------- GLASS STACK
// The swinging piece is drawn at cx0 + sin(ph)·amp with known amp/speed per
// level, so every future frame's position follows from this frame's x. The
// piece only exists at discrete frame positions — up to 15 px apart when a
// page-speed extension pins dt at 50 ms — so rather than tapping at the first
// crossing, the driver looks a few swings ahead for the sampled position that
// lands nearest the spot which also cancels the tray's lean (read back from
// the BALANCE bar), and taps on that frame. At the target height, miss on purpose.
defineDriver('GLASS STACK', {
    kind: 'unbounded', defaultTarget: 40,
    make(ctx) {
        let prevX = null, prevLevel = -1, ended = false, tapped = 0, tapLevel = -1, waited = 0, xLo = 1e9, xHi = -1e9, lastX = 0, lastWant = 0, lastLean = 0;
        return {
            frame(F) {
                const c = input.el('hh_gscv');
                if (!c || ended) return;
                const lv = F.text(/^(\d+)$/, { x: 200, y: 42, d: 4 });
                if (!lv || !F.has('STACKED')) { prevX = null; return; }
                ctx.alive();                    // waiting for the swing to line up is not a stall
                const level = +lv.m[1];
                // Pieces by sprite name; when a piece image is missing the game draws
                // fillRect(x - w/2, y, w, h) instead, so read those in the same order.
                let pieces = F.imgs.filter(o => /^gs_/.test(o.src) && !/^gs_(tray|hand|logo)$/.test(o.src))
                    .map(o => ({ cx: o.cx, w: o.w }));      // o.w is the on-screen width, rotation included
                if (!pieces.length) {
                    pieces = F.rects.filter(o => o.w > 12 && o.w <= 205 && o.h > 6 && o.h < 200 && o.y > 100)
                        .map(o => ({ cx: o.x + o.w / 2, w: o.w }));
                    if (pieces.length) pieces.shift();      // the tray is drawn first
                }
                if (!pieces.length) return;
                const cur = pieces[pieces.length - 1];
                const top = pieces.length > 1 ? pieces[pieces.length - 2] : null;
                const topX = top ? top.cx : 200;
                const topW = top ? top.w : 200;
                if (level !== prevLevel) { prevLevel = level; prevX = null; waited = 0; xLo = 1e9; xHi = -1e9; }
                if (tapLevel === level) { prevX = cur.cx; return; }     // tapped already, waiting for the new piece
                const bal = F.rects.find(o => Math.abs(o.x - 200) < 0.6 && Math.abs(o.y - 74) < 0.6 && Math.abs(o.h - 8) < 0.6);
                const lean = bal ? bal.w : 0;
                const amp = Math.min(150, 80 + level * 3.5), sp = 1.03 + level * 0.06;
                const cx0 = Math.max(70, Math.min(330, topX));
                const x = cur.cx;
                const target = ctx.target.v;
                if (level >= target || ctx.overBudget()) {
                    // slide it off: tap when the overlap is below 30 % of the narrower piece
                    const w = cur.w, need = Math.min(w, topW) * 0.30;
                    const over = Math.min(x + w / 2, topX + topW / 2) - Math.max(x - w / 2, topX - topW / 2);
                    if (over < need - 1) { input.down(c, 200, 240, c); ctx.acted(); tapLevel = level; ended = true; ctx.log('slid off on purpose at', level); }
                    prevX = x; return;
                }
                if (prevX == null) { prevX = x; xLo = xHi = x; return; }
                waited++;
                if (x < xLo) xLo = x;
                if (x > xHi) xHi = x;
                const want = topX + clamp(-lean / 0.78, -6, 6);
                lastX = x; lastWant = want; lastLean = lean;
                // Primary: tap the frame the swing crosses `want` (the lean-cancelling spot) —
                // precise to one frame-step at any refresh. Fallback: if no crossing has fired
                // for ~2 s (some live builds sample the swing so it never straddles `want`
                // cleanly), tap at the nearest approach so the driver can never stall at a level.
                const secs = waited * (F.dt > 0.0005 ? F.dt : 0.0042);
                const amp2 = Math.max(1, (xHi - xLo) / 2);
                const crossed = (x - want) * (prevX - want) <= 0 && x !== prevX;
                const nearest = secs > 2 && Math.abs(x - want) <= Math.abs(prevX - want) && Math.abs(x - want) < amp2 * 0.08;
                if (crossed || nearest) {
                    input.down(c, 200, 240, c); ctx.acted(); tapped++; tapLevel = level;
                    if (config.verbose) ctx.log('placed level', level, 'dx', (x - topX).toFixed(2), 'lean', lean.toFixed(1), 'after', waited, 'frames', crossed ? 'cross' : 'nearest');
                }
                prevX = x;
            },
            result(m) { ctx.log('stacked', m && m.v, 'taps', tapped, 'target', isFinite(ctx.target.v) ? ctx.target.v : 'max'); },
            state() { return { level: prevLevel, tapped, tapLevel, waited, curX: Math.round(lastX), want: Math.round(lastWant), prevX: prevX == null ? null : Math.round(prevX), swing: [Math.round(xLo), Math.round(xHi)], lean: +lastLean.toFixed(1), over: safe(() => ctx.overBudget(), null), targetInf: !isFinite(ctx.target.v) }; }
        };
    }
});

// ---------------------------------------------------------------- TABLE RUSH
// Waiter 118 px/s per axis (diagonals are faster), mobs of radius 10–12.6
// wander or stand. Every frame a receding-horizon search over three-segment
// key plans (9³ actions, 0.35 s) picks the move that reaches the table soonest
// without touching anyone. Touching a guest costs a glass but grants 1.5 s of
// invulnerability, and every cleared stage gives a glass back — so once the hall
// is crowded the planner may spend one hit per stage (keeping two glasses in
// reserve) as passage. In max mode the round ends when the game ends it.
const TR_ACTS = []; for (let iy = -1; iy <= 1; iy++) for (let ix = -1; ix <= 1; ix++) TR_ACTS.push([ix, iy]);
defineDriver('TABLE RUSH', {
    kind: 'unbounded', defaultTarget: 15,
    tunables: { safety: { min: 1, max: 9, step: 2, init: 5, explore: 0.2 } },
    make(ctx) {
        let stage = 0, me = { x: 200, y: 424 }, prevMobs = [], invUntil = 0, glasses = 3, keysDown = {}, act = [0, 0], dying = false, lastPlanT = 0, bestY = 1e9, stuckFrames = 0;
        const setKeys = a => {
            const want = { d: a[0] > 0, a: a[0] < 0, s: a[1] > 0, w: a[1] < 0 };
            for (const k in want) { if (!!keysDown[k] !== want[k]) { input.key(k, want[k]); keysDown[k] = want[k]; } }
        };
        const goalDist = (x, y) => Math.max(0, y - 88) + Math.max(0, Math.abs(x - 200) - 40) * 1.2;
        return {
            frame(F) {
                const c = input.el('hh_dgcv');
                if (!c) return;
                const st = F.text(/^STAGE (\d+)$/, { x: 26, y: 29, d: 4 });
                if (!st) { if (F.has('TRAY DOWN') || F.has('STAGE')) setKeys([0, 0]); return; }
                ctx.alive();
                const lv = +st.m[1];
                const t = F.t, dt = F.dt;
                if (lv !== stage) { stage = lv; prevMobs = []; me = { x: 200, y: 424 }; invUntil = t + 1000 - dt * 1000; lastPlanT = 0; bestY = 1e9; stuckFrames = 0; if (config.verbose) ctx.log('stage', lv, 'glasses', glasses, 'at', ((t - (ctx.t0 || 0)) / 1000).toFixed(1) + 's'); }
                // glasses HUD: arcs at y=25, gold = alive
                const arcs = F.arcs.filter(o => Math.abs(o.y - 25) < 0.6 && Math.abs(o.r - 7) < 0.6);
                if (arcs.length === 3) {
                    const alive = arcs.filter(o => /e6b450/i.test(o.fs)).length;
                    if (alive < glasses) { invUntil = Math.max(invUntil, t + 1500 - dt * 1000); if (config.verbose) ctx.log('hit at stage', lv, 'glasses', alive, 'me', me.x.toFixed(0), me.y.toFixed(0)); }
                    glasses = alive;
                }
                // waiter position (hidden on blink frames while invulnerable → integrate our own input)
                // drawSprite() draws an arc of radius w/2 when a sprite is missing:
                // the waiter is 35 px wide, a guest 30 px.
                const w = F.img('dg_waiter')[0] || F.arcs.filter(o => Math.abs(o.r - 17.5) < 0.6).map(o => ({ cx: o.x, cy: o.y }))[0];
                if (w) me = { x: w.cx, y: w.cy };
                else { me.x = clamp(me.x + act[0] * 118 * dt, 20, 380); me.y = clamp(me.y + act[1] * 118 * dt, 78, 434); if (Math.floor(t / 90) % 2 === 0) invUntil = Math.max(invUntil, t + 1); }
                // mobs with velocity from the previous frame
                const mobs = [];
                const drawn = F.imgs.filter(o => /^dg_cust/.test(o.src));
                const seen = drawn.length ? drawn : F.arcs.filter(o => Math.abs(o.r - 15) < 0.6).map(o => ({ cx: o.x, cy: o.y }));
                for (const o of seen) {
                    let m = null, bd = 14;
                    for (const p of prevMobs) { if (p.used) continue; const d = hypot(p.x - o.cx, p.y - o.cy); if (d < bd) { bd = d; m = p; } }
                    let vx = 0, vy = 0;
                    if (m) { m.used = true; vx = (o.cx - m.x) / dt; vy = (o.cy - m.y) / dt; if (hypot(vx, vy) < 8) vx = vy = 0; vx = m.vx * 0.4 + vx * 0.6; vy = m.vy * 0.4 + vy * 0.6; }
                    mobs.push({ x: o.cx, y: o.cy, vx, vy });
                }
                prevMobs = mobs;
                const target = ctx.target.v;
                dying = isFinite(target) && lv > target;
                // the game collides at m.r (10–12.6) + me.r (12); `safety` is our margin
                const R = 12.6 + 12 + ctx.params.safety;
                const invLeft = (invUntil - t) / 1000;

                // upward progress bookkeeping (a hit knocks us back, so "no new best y" = walled)
                if (me.y < bestY - 2) { bestY = me.y; stuckFrames = 0; } else stuckFrames += 1;
                const stuck = stuckFrames * dt > 0.7;

                // Re-plan on a throttled clock (~45 ms), not every rendered frame. Deciding
                // 240×/s made the choice flip frame to frame, so the waiter jittered in place.
                // Between plans the keys are simply held, so it commits and crosses the floor.
                if (t - lastPlanT >= 45) {
                    lastPlanT = t;
                    const preds = [0.12, 0.28].map(La => mobs.map(m => ({ x: m.x + m.vx * La, y: m.y + m.vy * La })));
                    // climb to the table (y↓), then centre on x=200
                    const goalPot = (x, y) => 1.5 * Math.max(0, y - 80) + Math.max(0, Math.abs(x - 200) - 30) * (y < 140 ? 2.2 : 0.7);
                    const RR = R + 14;
                    const repel = (x, y) => { let r = 0; for (const pred of preds) for (const m of pred) { const d = hypot(m.x - x, m.y - y); if (d < RR) r += (RR - d) * 16; } return r; };
                    const spd = 118 * 0.15;
                    const pick = useRepel => {
                        let best = null;
                        for (const a of TR_ACTS) {
                            const nx = clamp(me.x + a[0] * spd, 20, 380), ny = clamp(me.y + a[1] * spd, 78, 430);
                            const keep = (a[0] === act[0] && a[1] === act[1]) ? -8 : 0;
                            const idle = (a[0] === 0 && a[1] === 0) ? 6 : 0;
                            const v = goalPot(nx, ny) + (useRepel ? repel(nx, ny) : 0) + keep + idle;
                            if (!best || v < best.v) best = { v, a };
                        }
                        return best.a;
                    };
                    if (dying) {
                        // deliberate loss (a pinned target): walk into the nearest guest
                        let n = null, nd = 1e9;
                        for (const m of mobs) { const d = hypot(m.x - me.x, m.y - me.y); if (d < nd) { nd = d; n = m; } }
                        act = n ? [Math.sign(n.x - me.x), Math.sign(n.y - me.y)] : [0, 1];
                    } else if (invLeft > 0.15) {
                        // invulnerable: ignore the crowd and sprint for the table
                        act = pick(false);
                    } else if (stuck && glasses > 1) {
                        // walled by the crowd with a glass to spare: punch straight toward the goal,
                        // take the hit, and the 1.5 s shield that follows carries us through
                        act = pick(false);
                    } else {
                        act = pick(true);
                    }
                }
                setKeys(act);
                if (act[0] || act[1]) ctx.acted();
                lastAct = act;
            },
            stop() { setKeys([0, 0]); },
            result(m) { setKeys([0, 0]); ctx.log('stage', m && m.v, 'target', isFinite(ctx.target.v) ? ctx.target.v : 'max'); },
            state() { return { stage, glasses, dying, me: { x: Math.round(me.x), y: Math.round(me.y) }, mobs: prevMobs.length, act, invMs: Math.max(0, Math.round(invUntil - (api.frame ? api.frame.t : 0))) }; }
        };
    }
});
