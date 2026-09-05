
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
                const covers = F.img('ws_cover');
                const shot = F.img('ws_shot')[0];
                if (shot && covers.length && (F.has('WATCH THE SHOT!') || F.has('FIND IT!'))) {
                    let best = -1, bd = 1e9;
                    covers.forEach((o, i) => { const d = Math.abs(o.cx - shot.cx); if (d < bd) { bd = d; best = i; } });
                    if (bd < 3) shotIdx = best;
                }
                if (!F.has('WHERE IS IT? TAP!') || picked === round) return;
                if (!covers.length) return;
                picked = round;
                let idx = shotIdx >= 0 ? shotIdx : 0;
                if (round >= ctx.target.v) { idx = (idx + 1) % covers.length; failed = true; ctx.log('KO on purpose at round', round, '(target', ctx.target.v + ')'); }
                else if (shotIdx < 0) ctx.log('lost the shot this round — guessing');
                input.down(c, covers[idx].cx, 288, c);
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
            lastBurst = now(); bursts++;
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
                const jar = F.img('tc_jar')[0];
                if (!jar) return;
                jarX = jar.cx;
                const dt = F.dt;
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
                if (lastTX == null || Math.abs(tx - lastTX) > 0.01) { input.move(c, tx, 380, c); lastTX = tx; }
            }
        };
    }
});

// ---------------------------------------------------------------- FLY SWAT
// A tap kills the nearest fly within 32 px. Flies are drawn 34 px wide, so
// every fly on screen gets one pointerdown at its own centre, every frame —
// nothing ever lands on the fruit.
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
                    if (!/^fs_fly[12]$/.test(o.src) || Math.abs(o.w - 34) > 0.6) continue;
                    input.down(c, o.cx, o.cy, c); shots++;
                }
            },
            result(m) { ctx.log('flies', m && m.v, 'shots', shots); }
        };
    }
});

// ---------------------------------------------------------------- GLASS STACK
// The swinging piece is drawn at cx0 + sin(ph)·amp with known amp/speed per
// level, so its next position is predicted exactly from this frame's x.
// Tap when the piece crosses the point that also cancels the tray's lean
// (read back from the BALANCE bar). At the target height, miss on purpose.
defineDriver('GLASS STACK', {
    kind: 'unbounded', defaultTarget: 40,
    make(ctx) {
        let prevX = null, prevLevel = -1, ended = false, tapped = 0, tapLevel = -1;
        return {
            frame(F) {
                const c = input.el('hh_gscv');
                if (!c || ended) return;
                const lv = F.text(/^(\d+)$/, { x: 200, y: 42, d: 4 });
                if (!lv || !F.has('STACKED')) { prevX = null; return; }
                const level = +lv.m[1];
                const pieces = F.imgs.filter(o => /^gs_/.test(o.src) && !/^gs_(tray|hand|logo)$/.test(o.src));
                if (!pieces.length) return;
                const cur = pieces[pieces.length - 1];
                const top = pieces.length > 1 ? pieces[pieces.length - 2] : null;
                const topX = top ? top.cx : 200;
                const topW = top ? Math.min(top.w, top.h) : 200;
                if (level !== prevLevel) { prevLevel = level; prevX = null; }
                if (tapLevel === level) { prevX = cur.cx; return; }     // tapped already, waiting for the new piece
                const bal = F.rects.find(o => Math.abs(o.x - 200) < 0.6 && Math.abs(o.y - 74) < 0.6 && Math.abs(o.h - 8) < 0.6);
                const lean = bal ? bal.w : 0;
                const amp = Math.min(150, 80 + level * 3.5), sp = 1.03 + level * 0.06;
                const cx0 = Math.max(70, Math.min(330, topX));
                const x = cur.cx;
                const target = ctx.target.v;
                if (level >= target) {
                    // slide it off: tap when the overlap is below 30 % of the narrower piece
                    const w = Math.min(cur.w, cur.h), need = Math.min(w, topW) * 0.30;
                    const over = Math.min(x + w / 2, topX + topW / 2) - Math.max(x - w / 2, topX - topW / 2);
                    if (over < need - 1) { input.down(c, 200, 240, c); tapLevel = level; ended = true; ctx.log('slid off on purpose at', level); }
                    prevX = x; return;
                }
                if (prevX == null) { prevX = x; return; }
                // phase from x, branch from the direction of motion, then predict next frame
                const s = clamp((x - cx0) / amp, -1, 1);
                let ph = Math.asin(s);
                if (x < prevX) ph = Math.PI - ph;
                const nextX = cx0 + Math.sin(ph + F.dt * sp) * amp;
                const want = topX + clamp(-lean / 0.78, -6, 6);
                const dNow = Math.abs(x - want), dNext = Math.abs(nextX - want);
                const step = amp * sp * F.dt;
                if (dNow <= dNext && dNow <= step * 0.51 + 0.35) {
                    input.down(c, 200, 240, c); tapped++; tapLevel = level;
                    if (config.verbose) ctx.log('placed level', level, 'dx', (x - topX).toFixed(2), 'lean', lean.toFixed(1));
                }
                prevX = x;
            },
            result(m) { ctx.log('stacked', m && m.v, 'taps', tapped, 'target', ctx.target.v); }
        };
    }
});

// ---------------------------------------------------------------- TABLE RUSH
// Waiter 118 px/s per axis (diagonals are faster), mobs of radius 10–12.6
// wander or stand. Every frame a receding-horizon search over two-step key
// plans (9×9 actions) picks the move that reaches the table soonest without
// touching anyone — except while invulnerable, when walking through is free.
// One glass comes back per stage, so a single hit per stage is sustainable.
const TR_ACTS = []; for (let iy = -1; iy <= 1; iy++) for (let ix = -1; ix <= 1; ix++) TR_ACTS.push([ix, iy]);
defineDriver('TABLE RUSH', {
    kind: 'unbounded', defaultTarget: 15,
    tunables: { safety: { min: 1, max: 9, step: 2, init: 5, explore: 0.2 } },
    make(ctx) {
        let stage = 0, me = { x: 200, y: 424 }, prevMobs = [], invUntil = 0, glasses = 3, keysDown = {}, act = [0, 0], lastAct = null, lastMe = null, dying = false;
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
                if (lv !== stage) { stage = lv; prevMobs = []; me = { x: 200, y: 424 }; invUntil = t + 1000 - dt * 1000; lastMe = null; }
                // glasses HUD: arcs at y=25, gold = alive
                const arcs = F.arcs.filter(o => Math.abs(o.y - 25) < 0.6 && Math.abs(o.r - 7) < 0.6);
                if (arcs.length === 3) {
                    const alive = arcs.filter(o => /e6b450/i.test(o.fs)).length;
                    if (alive < glasses) invUntil = Math.max(invUntil, t + 1500 - dt * 1000);
                    glasses = alive;
                }
                // waiter position (hidden on blink frames while invulnerable → integrate our own input)
                const w = F.img('dg_waiter')[0];
                if (w) me = { x: w.cx, y: w.cy };
                else { me.x = clamp(me.x + act[0] * 118 * dt, 20, 380); me.y = clamp(me.y + act[1] * 118 * dt, 78, 434); if (Math.floor(t / 90) % 2 === 0) invUntil = Math.max(invUntil, t + 1); }
                // mobs with velocity from the previous frame
                const mobs = [];
                for (const o of F.imgs) {
                    if (!/^dg_cust/.test(o.src)) continue;
                    let m = null, bd = 14;
                    for (const p of prevMobs) { if (p.used) continue; const d = hypot(p.x - o.cx, p.y - o.cy); if (d < bd) { bd = d; m = p; } }
                    let vx = 0, vy = 0;
                    if (m) { m.used = true; vx = (o.cx - m.x) / dt; vy = (o.cy - m.y) / dt; if (hypot(vx, vy) < 8) vx = vy = 0; vx = m.vx * 0.4 + vx * 0.6; vy = m.vy * 0.4 + vy * 0.6; }
                    mobs.push({ x: o.cx, y: o.cy, vx, vy });
                }
                prevMobs = mobs;
                const target = ctx.target.v;
                dying = lv > target;
                const R = 12.6 + 12 + ctx.params.safety;
                const invLeft = (invUntil - t) / 1000;
                // two-step plans: action a for h1 frames, then b for the rest of the horizon
                const H = 20, h1 = 8;
                let best = null;
                const sim = (a, b) => {
                    let x = me.x, y = me.y, cost = 0, hit = -1;
                    for (let k = 1; k <= H; k++) {
                        const ac = k <= h1 ? a : b;
                        const spd = 118 * dt;
                        x = clamp(x + ac[0] * spd, 20, 380); y = clamp(y + ac[1] * spd, 78, 434);
                        if (k * dt > invLeft) {
                            for (const m of mobs) { const mx = m.x + m.vx * dt * k, my = m.y + m.vy * dt * k; if (hypot(mx - x, my - y) < R) { hit = k; break; } }
                        }
                        if (hit > 0) break;
                        if (y < 92 && Math.abs(x - 200) < 44) { cost -= (H - k) * 6; break; }
                    }
                    const gd = goalDist(x, y);
                    if (dying) return hit > 0 ? -1000 + hit : gd;          // seek the nearest collision
                    return gd + (hit > 0 ? 600 + (H - hit) * 10 : 0) + cost;
                };
                for (const a of TR_ACTS) for (const b of TR_ACTS) {
                    const v = sim(a, b) + (a[0] === 0 && a[1] === 0 ? 0.5 : 0);
                    if (!best || v < best.v) best = { v, a };
                }
                act = best ? best.a : [0, 0];
                if (dying && best && best.v > -500) {
                    // no mob reachable in the horizon: walk toward the closest one
                    let near = null, nd = 1e9;
                    for (const m of mobs) { const d = hypot(m.x - me.x, m.y - me.y); if (d < nd) { nd = d; near = m; } }
                    if (near) act = [Math.sign(near.x - me.x), Math.sign(near.y - me.y)];
                }
                setKeys(act);
                lastAct = act;
            },
            stop() { setKeys([0, 0]); },
            result(m) { setKeys([0, 0]); ctx.log('stage', m && m.v, 'target', ctx.target.v); }
        };
    }
});
