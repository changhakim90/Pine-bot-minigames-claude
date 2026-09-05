
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
        let round = 0, shotIdx = -1, picked = 0, failed = false;
        return {
            frame(F) {
                const c = input.el('hh_fpcv');
                if (!c || failed) return;
                const rt = F.text(/^ROUND (\d+)$/, { x: 12, y: 28, d: 4 });
                if (!rt) return;
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
                ctx.acted();
            }
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
    tunables: { safety: { min: 0, max: 12, step: 2, init: 4, explore: 0.2 }, horizon: { min: 40, max: 110, step: 10, init: 70, explore: 0.15 } },
    make(ctx) {
        let prev = [], jarX = 200, lastTX = null;
        return {
            frame(F) {
                const c = input.el('hh_fpcv');
                if (!c || F.has('TIME UP!')) return;
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
                const H = ctx.params.horizon;                       // frames of lookahead
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
                    // would we swallow a bad one that is in the window at the same time and near this x?
                    const risky = bads.some(b => Math.abs(b.x - it.x) < 74 && b.e.in < e.out + 2 && b.e.out > e.in - 2);
                    if (risky) continue;
                    const score = e.in - it.good * 3;
                    if (!best || score < best.score) best = { it, score };
                }
                let tx;
                if (best) tx = best.it.x;
                else {
                    // nothing catchable: dodge any bad item about to enter the window near the jar
                    const threat = bads.find(b => b.e.in < 14 && Math.abs(b.x - jarX) < 60);
                    tx = threat ? (threat.x > jarX ? threat.x - 80 : threat.x + 80) : jarX;
                }
                tx = clamp(tx, 36, 364);
                if (lastTX == null || Math.abs(tx - lastTX) > 0.01) { input.move(c, tx, 380, c); lastTX = tx; ctx.acted(); }
            }
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
        let prevX = null, prevLevel = -1, ended = false, tapped = 0, tapLevel = -1, waited = 0;
        return {
            frame(F) {
                const c = input.el('hh_gscv');
                if (!c || ended) return;
                const lv = F.text(/^(\d+)$/, { x: 200, y: 42, d: 4 });
                if (!lv || !F.has('STACKED')) { prevX = null; return; }
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
                if (level !== prevLevel) { prevLevel = level; prevX = null; waited = 0; }
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
                if (prevX == null) { prevX = x; return; }
                waited++;
                // phase from x, branch from the direction of motion
                const s = clamp((x - cx0) / amp, -1, 1);
                let ph = Math.asin(s);
                if (x < prevX) ph = Math.PI - ph;
                const want = topX + clamp(-lean / 0.78, -6, 6);
                const dNow = Math.abs(x - want);
                // scan up to three swings ahead for the frame that samples nearest `want`;
                // tap now only if this frame is that one (re-planned every frame, so timing
                // jitter over the wait never matters — the tap always uses the real x)
                const dt = F.dt, period = 2 * Math.PI / sp, K = Math.min(720, Math.ceil(3 * period / dt));
                let bestK = 0, bestD = dNow;
                for (let k = 1; k <= K; k++) {
                    const d = Math.abs(cx0 + Math.sin(ph + k * dt * sp) * amp - want) + k * 0.0015;
                    if (d < bestD) { bestD = d; bestK = k; }
                }
                // the longer we have waited, the more we accept (never more than half a frame-step)
                const step = amp * sp * dt;
                const tol = Math.min(step * 0.51 + 0.35, 1.0 + (waited / K) * step);
                if (bestK === 0 && dNow <= tol) {
                    input.down(c, 200, 240, c); ctx.acted(); tapped++; tapLevel = level;
                    if (config.verbose) ctx.log('placed level', level, 'dx', (x - topX).toFixed(2), 'lean', lean.toFixed(1), 'after', waited, 'frames');
                }
                prevX = x;
            },
            result(m) { ctx.log('stacked', m && m.v, 'taps', tapped, 'target', ctx.target.v); }
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
        let stage = 0, me = { x: 200, y: 424 }, prevMobs = [], invUntil = 0, glasses = 3, keysDown = {}, act = [0, 0], lastAct = null, lastMe = null, dying = false, hitsThisStage = 0, bestY = 1e9, stuckFrames = 0;
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
                const lv = +st.m[1];
                const t = F.t, dt = F.dt;
                if (lv !== stage) { stage = lv; prevMobs = []; me = { x: 200, y: 424 }; invUntil = t + 1000 - dt * 1000; lastMe = null; hitsThisStage = 0; bestY = 1e9; stuckFrames = 0; if (config.verbose) ctx.log('stage', lv, 'glasses', glasses, 'at', ((t - ctx.t0) / 1000).toFixed(1) + 's'); }
                // glasses HUD: arcs at y=25, gold = alive
                const arcs = F.arcs.filter(o => Math.abs(o.y - 25) < 0.6 && Math.abs(o.r - 7) < 0.6);
                if (arcs.length === 3) {
                    const alive = arcs.filter(o => /e6b450/i.test(o.fs)).length;
                    if (alive < glasses) { invUntil = Math.max(invUntil, t + 1500 - dt * 1000); hitsThisStage++; if (config.verbose) ctx.log('hit at stage', lv, 'glasses', alive, 'me', me.x.toFixed(0), me.y.toFixed(0)); }
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
                dying = lv > target;
                // the game collides at m.r (10–12.6) + me.r (12); `safety` is our margin on top
                const R = 12.6 + 12 + ctx.params.safety;
                const invLeft0 = Math.max(0, (invUntil - t) / 1000);
                // a hit is worth a glass once the hall is crowded (stage 4+) or the crowd has held
                // us for most of a second — early stages are crossed clean
                if (me.y < bestY - 2) { bestY = me.y; stuckFrames = 0; } else stuckFrames++;
                const stuck = stuckFrames > 0.8 / dt;
                const budget0 = dying || !(stuck || mobs.length >= 24) ? 0 : Math.max(0, glasses - 2 - hitsThisStage);   // never spend the last-but-one glass
                // 0.35 s horizon in three segments at the game's own frame step — guests turn
                // every 0.5–1.8 s, so longer predictions are mostly wrong; only guests that could
                // possibly be reached in that time take part (the rest cost nothing)
                const step = dt, H = Math.max(6, Math.round(0.35 / step)), SEG = Math.ceil(H / 3), spd = 118 * step;
                const reach = 118 * 1.45 * 0.35 + 160;
                const near = mobs.filter(m => hypot(m.x - me.x, m.y - me.y) < reach);
                const mx = [], my = [];
                for (let k = 1; k <= H; k++) { const ax = [], ay = []; for (const m of near) { ax.push(m.x + m.vx * step * k); ay.push(m.y + m.vy * step * k); } mx.push(ax); my.push(ay); }
                let best = null;
                const sim = (acts) => {
                    let x = me.x, y = me.y, cost = 0, inv = invLeft0, budget = budget0;
                    for (let k = 1; k <= H; k++) {
                        const ac = acts[Math.floor((k - 1) / SEG)];
                        x = clamp(x + ac[0] * spd, 20, 380); y = clamp(y + ac[1] * spd, 78, 434);
                        if (inv > 0) inv -= step;
                        else {
                            const px = mx[k - 1], py = my[k - 1];
                            for (let i = 0; i < px.length; i++) {
                                const ddx = px[i] - x, ddy = py[i] - y;
                                if (ddx * ddx + ddy * ddy < R * R) {
                                    if (dying) return -1000 + k;
                                    if (budget > 0) {
                                        budget--; inv = 1.5; cost += 70;
                                        const a = Math.atan2(y - py[i], x - px[i]); x = clamp(x + Math.cos(a) * 26, 20, 380); y = clamp(y + Math.sin(a) * 26, 78, 434);
                                    } else { return goalDist(x, y) + 600 + (H - k) * 10 + cost; }
                                    break;
                                }
                            }
                        }
                        if (y < 92 && Math.abs(x - 200) < 44) return cost - (H - k) * 6;
                    }
                    return goalDist(x, y) + cost;
                };
                const acts = [null, null, null];
                for (const a of TR_ACTS) { acts[0] = a; for (const b of TR_ACTS) { acts[1] = b; for (const c of TR_ACTS) { acts[2] = c;
                    const v = sim(acts) + (a[0] === 0 && a[1] === 0 ? 0.5 : 0);
                    if (!best || v < best.v) best = { v, a };
                } } }
                act = best ? best.a : [0, 0];
                if (dying && best && best.v > -500) {
                    // no mob reachable in the horizon: walk toward the closest one
                    let near = null, nd = 1e9;
                    for (const m of mobs) { const d = hypot(m.x - me.x, m.y - me.y); if (d < nd) { nd = d; near = m; } }
                    if (near) act = [Math.sign(near.x - me.x), Math.sign(near.y - me.y)];
                }
                setKeys(act);
                if (act[0] || act[1]) ctx.acted();
                lastAct = act;
            },
            stop() { setKeys([0, 0]); },
            result(m) { setKeys([0, 0]); ctx.log('stage', m && m.v, 'target', ctx.target.v); }
        };
    }
});
