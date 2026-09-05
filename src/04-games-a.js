
/* =====================================================================
 * 04 — drivers A: Blind Pour, Stir Stop, Ice Carving, Champagne Launch,
 *                 Shake Master, Quick Tab, Order Up!
 * Every constant below is read from the game's source (reference/happyhour.html).
 * ===================================================================== */

// ---------------------------------------------------------------- BLIND POUR
// Hold pours 10 ml/s once the bottle is flipped; releasing leaves a random
// "dribble" tail (10·dt/(1-e^(-dt/τ)), τ∈[0.17,0.24]): ~1.8–2.5 ml at 60 Hz.
// The liquid surface is drawn as ellipse(200, sy2, …, 3) with
// sy2 = lvlY(ml) + sin(t/60)·wA, so ml is read back exactly every frame.
// Score is the summed absolute error over 3 pours (30/45/60 ml), lower is better.
const FP_GLASS = [
    { cap: 45, target: 30, h: 146, top: .225, bot: .665 },
    { cap: 60, target: 45, h: 164, top: .095, bot: .495 },
    { cap: 90, target: 60, h: 170, top: .195, bot: .655 }
].map(g => { const gy0 = 444 - g.h; return Object.assign(g, { inTop: gy0 + g.top * g.h, inBot: gy0 + g.bot * g.h }); });

// expected tail for a frame period dt (mean over τ ~ U[0.17, 0.24])
function pourTailModel(dt) {
    let s = 0, n = 0;
    for (let tau = 0.17; tau <= 0.2401; tau += 0.005) { s += 10 * dt / (1 - Math.exp(-dt / tau)); n++; }
    return s / n;
}
function pourMlFromSurface(sy2, t, wA, g) {
    const y = sy2 - Math.sin(t / 60) * wA;
    return g.cap * (g.inBot - y) / (g.inBot - g.inTop);
}

defineDriver('BLIND POUR', {
    kind: 'precision', floor: 0, maxPlays: 600,
    tunables: { bias: { min: -0.4, max: 0.4, step: 0.05, init: 0, explore: 0.15 } },
    make(ctx) {
        const cv = () => input.el('hh_fpcv');
        let pour = -1, holding = false, released = false, relT = 0, relMl = 0, lastMl = 0, dtAvg = 1 / 60, judged = false;
        const pours = [];
        const tail = () => pourTailModel(dtAvg) + (ctx.cal.tailBias || 0) + ctx.params.bias;
        return {
            frame(F) {
                const c = cv();
                if (!c) return;
                if (F.dt > 0.004 && F.dt < 0.05) dtAvg += (F.dt - dtAvg) * 0.1;
                const pt = F.text(/^POUR (\d)\/3$/, { x: 12, y: 48, d: 60 });
                if (!pt) return;
                const idx = +pt.m[1] - 1;
                if (idx !== pour) { pour = idx; holding = false; released = false; judged = false; lastMl = 0; }
                const g = FP_GLASS[idx];
                const stamp = F.text(/^(\d+\.\d\d) \/ \d+\.00ml$/);
                if (stamp) {
                    // judged: the exact final ml is on screen → learn the tail we got
                    if (!judged && released) {
                        judged = true;
                        const finalMl = +stamp.m[1], sample = finalMl - relMl;
                        pours.push({ idx, relMl, finalMl, sample, err: finalMl - g.target });
                        const bias = sample - pourTailModel(dtAvg);
                        learn.ema(ctx.name, 'tailBias', bias, 0.15);
                        ctx.cal.tailN = (ctx.cal.tailN || 0) + 1;
                        if (config.verbose) ctx.log('pour', idx + 1, 'released at', relMl.toFixed(2), 'final', finalMl, 'tail', sample.toFixed(2));
                    }
                    return;
                }
                if (released) return;
                // surface ellipse: x≈200, ry=3
                const el = F.ellipses.find(o => Math.abs(o.x - 200) < 0.6 && Math.abs(o.ry - 3) < 0.01);
                if (!el) {
                    // not pouring yet: press until the game accepts the hold (ignored while unarmed)
                    input.down(c, 200, 300);
                    holding = true;
                    return;
                }
                const ml = pourMlFromSurface(el.y, F.t, 2.0, g);
                lastMl = ml;
                // release now if the predicted final (ml + tail) is at least as close as waiting one more frame
                const step = 10 * F.dt;
                const predNow = ml + tail(), predNext = ml + step + tail();
                if (Math.abs(predNow - g.target) <= Math.abs(predNext - g.target) || predNow >= g.target) {
                    released = true; relT = F.t; relMl = ml;
                    input.up(c, 200, 300); ctx.acted();
                }
            },
            result(m, txt) {
                if (pours.length) {
                    const tot = pours.reduce((a, p) => a + Math.abs(p.err), 0);
                    ctx.log('pours', pours.map(p => p.err.toFixed(2)).join(' '), 'total', tot.toFixed(2), '→', txt);
                }
            }
        };
    }
});

// ---------------------------------------------------------------- STIR STOP
// Exact simulation of the game's thermal model, driven by the same rAF
// timestamps the game uses. Spin to ω=14, release so the residual cooling
// bottoms out just under the target, let it warm at 0.33°/s and serve on
// the frame nearest the target → "PERFECT ±0.00".
function stTempRGB(tp) {
    let r, g, b;
    if (tp >= 0) { const p = Math.min(1, (20 - tp) / 20); r = 236 - 26 * p; g = 226 + 9 * p; b = 198 + 57 * p; }
    else { const p = Math.min(1, -tp / 8); r = 210 - 140 * p; g = 235 - 75 * p; b = 255; }
    return [Math.round(r), Math.round(g), Math.round(b)];
}
function stTempColor(tp) { const c = stTempRGB(tp); return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
// canvas fillStyle reads back as '#rrggbb', so colours are compared as numbers
const sameRGB = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
function stStep(s, dt) {
    // one game frame of the 'play' update, mutating s = {omega, temp, dragging}
    const fr2 = s.dragging ? 5 : 11;
    s.omega -= Math.sign(s.omega) * Math.min(Math.abs(s.omega), dt * fr2);
    const om = Math.abs(s.omega);
    const cool = om * dt * 0.3 * (s.dragging ? 1 : 0.45) * (0.35 + 0.65 * Math.max(0, (s.temp + 8) / 28));
    s.temp = Math.max(-8, s.temp - cool);
    if (om < 0.5) s.temp = Math.min(20, s.temp + dt * 0.33);
    return s;
}
// temperature reached if we let go now and never touch it again (until spin dies)
function stBottom(s, dt) {
    const q = { omega: s.omega, temp: s.temp, dragging: false };
    let guard = 0, min = q.temp;
    while (Math.abs(q.omega) >= 0.5 && guard++ < 4000) { stStep(q, dt); if (q.temp < min) min = q.temp; }
    return min;
}
const ST_TARGETS = []; for (let i = 15; i <= 40; i++) ST_TARGETS.push(-i / 10);

defineDriver('STIR STOP', {
    kind: 'precision', floor: 0, maxPlays: 200,
    make(ctx) {
        const cv = () => input.el('hh_fpcv');
        const s = { omega: 0, temp: 20, dragging: false };
        let play = false, target = null, lastA = null, phase = 'spin', served = false, mism = 0, dtLast = 1 / 60, frames = 0, waitingFor = 'play', colourOnly = false, spinFrames = 0, inputWarned = false;
        const angleOf = (c, ev) => { const p = input.gameXY(c, ev); return Math.atan2(p.y - 272, p.x - 200); };
        const wrapD = d2 => { while (d2 > Math.PI) d2 -= 6.283; while (d2 < -Math.PI) d2 += 6.283; return d2; };
        const moveTo = (c, ang) => {
            // dispatch a pointermove on the rim and mirror the game's omega update exactly
            const ev = input.move(c, 200 + Math.cos(ang) * 110, 272 + Math.sin(ang) * 110, c);
            const a2 = angleOf(c, ev);
            if (s.dragging && lastA != null) { const d2 = wrapD(a2 - lastA); s.omega = Math.max(-14, Math.min(14, s.omega + d2 * 4)); }
            lastA = a2;
        };
        return {
            frame(F) {
                const c = cv();
                if (!c || served) return;
                // the two colour chips: fillRect(90,22,100,30) NOW and (210,22,100,30) TARGET —
                // matched by size and row first, so a pixel of drift cannot blind the driver
                const chips = F.rects.filter(o => Math.abs(o.w - 100) < 2 && Math.abs(o.h - 30) < 2 && Math.abs(o.y - 22) < 4);
                const nowRect = chips.find(o => Math.abs(o.x - 90) < 4), tgtRect = chips.find(o => Math.abs(o.x - 210) < 4);
                waitingFor = (!nowRect || !tgtRect) ? 'colour chips (play state)' : '';
                if (!nowRect || !tgtRect) return;         // not in 'play' yet
                if (!play) { play = true; dtLast = F.dt; return; }   // first play frame: game did one idle step (temp stays 20)
                frames++;
                // mirror the frame the game just ran
                stStep(s, F.dt); dtLast = F.dt;
                if (target == null) {
                    const tr = F.rgb(tgtRect.fs);
                    const hit = ST_TARGETS.find(tp => sameRGB(stTempRGB(tp), tr));
                    if (hit != null) { target = hit; ctx.log('target', target.toFixed(1) + '°C'); }
                    else if (frames > 5) { target = -2.75; ctx.log('target colour unknown', tgtRect.fs, '— assuming', target); }
                }
                // model check against what the game drew: text while temp > 5, colour always
                const tt = F.text(/^(-?\d+\.\d\d)°C$/);
                if (tt) { const drawn = +tt.m[1]; if (Math.abs(drawn - s.temp) > 0.011) { mism++; s.temp = drawn; } }
                else {
                    const rgb = F.rgb(nowRect.fs);
                    if (rgb && !sameRGB(rgb, stTempRGB(s.temp))) {
                        mism++;
                        if (config.verbose) ctx.log('colour mismatch', nowRect.fs, 'model', stTempColor(s.temp), s.temp.toFixed(3));
                        // resync from the colour (≈0.03° resolution); the spin state is still exact
                        s.temp = rgb[0] <= 210 && rgb[2] === 255 ? -(210 - rgb[0]) / 140 * 8 : 20 - (236 - rgb[0]) / 26 * 20;
                    }
                }
                if (target == null) return;
                ctx.acted();
                // if the model keeps disagreeing with what is drawn, something about this page
                // differs from the source we simulate: fall back to steering by colour alone
                // (the chips match exactly within ~0.03 °C) rather than trusting the numbers
                if (mism > 40 && !colourOnly) { colourOnly = true; ctx.log('model disagrees with the HUD', mism, 'times — steering by colour only'); }
                if (colourOnly) {
                    const same = sameRGB(F.rgb(nowRect.fs), F.rgb(tgtRect.fs));
                    const nowT = s.temp;                    // resynced from the colour above
                    if (phase === 'spin') {
                        if (!s.dragging) { const ev = input.down(c, 310, 272, c); s.dragging = true; lastA = angleOf(c, ev); }
                        moveTo(c, lastA + 0.6);
                        if (nowT <= target + 0.05) { input.up(c, 310, 272, c); s.dragging = false; lastA = null; phase = 'settle'; }
                    } else if (same || (Math.abs(s.omega) < 0.5 && nowT >= target)) {
                        served = true; input.down(input.el('hh_stServe')); ctx.acted();
                        ctx.log('served by colour at', nowT.toFixed(2), 'target', target);
                    }
                    return;
                }
                if (phase === 'spin') {
                    if (!s.dragging) { const ev = input.down(c, 310, 272, c); s.dragging = true; lastA = angleOf(c, ev); spinFrames = 0; }
                    // keep ω pinned at 14 with one small move per frame, then decide whether to let go
                    moveTo(c, lastA + 0.6);
                    spinFrames++;
                    // sanity: after 2 s of stirring the drink must be cooling; if the HUD still shows
                    // room temperature our pointer input is not reaching the game
                    if (spinFrames * F.dt > 2 && s.temp > 19 && !inputWarned) { inputWarned = true; waitingFor = 'stir input is not cooling the drink'; ctx.log(waitingFor); }
                    const bottom = stBottom(s, F.dt);
                    if (bottom <= target - 0.012) {
                        input.up(c, 310, 272, c); s.dragging = false; lastA = null; phase = 'settle';
                        if (config.verbose) ctx.log('released at', s.temp.toFixed(3), 'expected bottom', bottom.toFixed(3));
                    }
                } else if (phase === 'settle') {
                    // serve on the frame whose temp is nearest the target (warming 0.33°/s once the spin is dead)
                    const next = stStep({ omega: s.omega, temp: s.temp, dragging: false }, dtLast).temp;
                    const dNow = Math.abs(s.temp - target), dNext = Math.abs(next - target);
                    if (dNow <= dNext && Math.abs(s.omega) < 0.5) {
                        served = true;
                        input.down(input.el('hh_stServe')); ctx.acted();
                        ctx.log('served at', s.temp.toFixed(4), 'target', target, 'model mismatches', mism);
                        learn.ema(ctx.name, 'mismatches', mism, 0.3);
                    }
                }
            },
            state() { return { play, phase, target, temp: +s.temp.toFixed(3), omega: +s.omega.toFixed(3), dragging: s.dragging, served, mismatches: mism, colourOnly, waitingFor, frames }; }
        };
    }
});

// ---------------------------------------------------------------- ICE CARVING
// Each TAP adds 5.25 to a gauge that decays 38/s; DONE at ≥88 = +1 ball,
// below = shatter (600 ms stun). The gauge is drawn as a fill rect at x=354,
// so it is read back exactly. 17 taps + DONE inside one frame = one ball
// per frame; the driver paces balls to reach its target across the 15 s.
// Every ball costs the game a particle burst and a sound, so balls-per-frame is
// tuned rather than fixed: too many and the page slows, the engine's dt hits its
// cap and fewer frames — hence fewer balls — fit in the 15 s.
defineDriver('ICE CARVING', {
    kind: 'unbounded', defaultTarget: 60,
    tunables: { perFrame: { min: 2, max: 14, step: 2, init: 6, explore: 0.3 } },
    make(ctx) {
        let count = 0, armedAt = 0, stunUntil = 0;
        const maxPerFrame = ctx.params.perFrame || 6;
        return {
            frame(F) {
                const bT = input.el('hh_icTap'), bD = input.el('hh_icDone');
                if (!bT || !bD) return;
                if (F.has('TIME UP!')) return;
                const tm = F.text(/^(\d+\.\d)s$/, { x: 200, y: 34, d: 4 });
                if (!tm) return;
                const left = +tm.m[1];
                if (left >= 15) return;          // not armed yet
                if (!armedAt) armedAt = F.t;
                if (F.has('SHATTERED!!') && stunUntil < F.t) stunUntil = F.t + 620;
                if (F.t < stunUntil) return;
                const target = ctx.target.v;
                const elapsed = 15 - left;
                let todo;
                if (!isFinite(target)) todo = maxPerFrame;                                   // max mode: flat out
                else {
                    const due = Math.min(target, Math.ceil(target * (elapsed + 0.4) / 15));   // pace with a little slack
                    todo = Math.max(0, due - count);
                    if (left < 1.0) todo = Math.max(0, target - count);                      // finish early rather than late
                    todo = Math.min(todo, maxPerFrame);
                }
                // gauge = (420 - fy) / 270 * 100 from fillRect(354, fy, 16, 420 - fy)
                const gr = F.rects.find(o => Math.abs(o.x - 354) < 0.6 && Math.abs(o.w - 16) < 0.6);
                let gauge = gr ? (420 - gr.y) / 270 * 100 : 0;
                for (let b = 0; b < todo; b++) {
                    const taps = Math.ceil((88 - gauge) / 5.25);
                    for (let i = 0; i < taps; i++) input.down(bT);
                    input.down(bD);
                    gauge = 0; count++;
                }
            },
            result(m) { if (m) ctx.log('balls', m.v, 'target', ctx.target.v); }
        };
    }
});

// ---------------------------------------------------------------- CHAMPAGNE LAUNCH
// RUN taps: power += 2.8, vel = min(460, vel+62). HOLD raises the angle 62°/s
// and brakes 1400 px/s². Release fires the cork: R = power·1.6·sin(2θ)^2.2·40 px
// then a real parabola + 3 bounces. Distance = round((ckX - 2200)/40) m.
// Power leaks 55 %/s so the driver keeps it topped up to exactly what it
// will have left at the 45° release, by simulating the game's own update.
function clFlight(R, thDeg, dt) {
    const th = thDeg * Math.PI / 180, GRV = 700, GY = 402;
    const s2 = Math.max(0.06, Math.sin(2 * th));
    const v0 = Math.sqrt(R * GRV / s2);
    let x = 0, y = GY - 104, vx = v0 * Math.cos(th), vy = -v0 * Math.sin(th), bounces = 0, guard = 0;
    while (guard++ < 2e6) {
        vy += GRV * dt; x += vx * dt; y += vy * dt;
        if (y >= GY - 8 && vy > 0) {
            y = GY - 8; vy = -vy * 0.42; vx *= 0.55; bounces++;
            if (bounces >= 3 || Math.abs(vy) < 45) return x;
        }
    }
    return x;
}
function clPowerDecay(p, dt, frames) { for (let i = 0; i < frames; i++) p = Math.max(0, p - p * dt * 0.55 - dt * 0.3); return p; }

// Nothing caps `power`: it is 2.8 per tap, and taps are accepted for the whole run
// (including while the launch button is held). The distance a run reaches is set by
// how much power the bot chooses to build, so the target is the strategy — with
// `pineMini.target('CHAMPAGNE LAUNCH', 20000)` it will build the power for 20,000 m.
// Very large targets do cost the game work: it draws a 25 m tick on its minimap for
// every mark, and one particle per tap.
defineDriver('CHAMPAGNE LAUNCH', {
    kind: 'unbounded', defaultTarget: 2000, maxTarget: 20000,
    make(ctx) {
        const m = { worldX: 0, vel: 0, power: 0, angle: 12, hold: false, fired: false, launchX: 0, R: 0, pFire: 0 };
        let run = false, dtAvg = 1 / 60, planned = null;
        const HOLD_AT = 2200 - 320;   // vel 460 brakes in 75.6 px; the rest is room to keep tapping to 45°
        const plan = () => {
            const k = ctx.cal.flightK || 1;
            const wantPx = (ctx.target.v + 2) * 40 + 2200 - (HOLD_AT + 76 + 47);   // cork travel needed from launchX
            let lo = 20, hi = 1e7;
            for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); if (clFlight(mid, 45, dtAvg) * k < wantPx) lo = mid; else hi = mid; }
            const R = hi, pFire = R / (1.6 * 40);     // sin(90°)^2.2 = 1
            const holdFrames = Math.ceil((45 - 12) / (62 * dtAvg));
            return { R, pFire, holdFrames, pHold: pFire / Math.pow(1 - 0.55 * dtAvg, holdFrames) + 0.3 * dtAvg * holdFrames };
        };
        return {
            frame(F) {
                const bT = input.el('hh_clTap'), bG = input.el('hh_clGo');
                if (!bT || !bG) return;
                if (m.fired) { ctx.acted(); return; }      // watching our own cork fly is not a stall
                if (F.dt > 0.004 && F.dt < 0.05) dtAvg += (F.dt - dtAvg) * 0.1;
                const bar = F.rect(30, 18, 340, 10);
                if (!bar) return;                  // intro
                if (!run) { run = true; planned = plan(); ctx.log('plan: R', planned.R.toFixed(0), 'power at fire', planned.pFire.toFixed(1), 'k', (ctx.cal.flightK || 1).toFixed(3)); return; }
                // mirror the frame the game just ran
                const dt = F.dt;
                m.vel = m.hold ? Math.max(0, m.vel - dt * 1400) : Math.max(30, m.vel - dt * 230);
                m.worldX += m.vel * dt;
                m.power = Math.max(0, m.power - m.power * dt * 0.55 - dt * 0.3);
                if (m.hold) m.angle = Math.min(88, m.angle + dt * 62);
                // resync worldX from the progress bar (340·worldX/2200)
                const prog = F.rects.find(o => Math.abs(o.x - 30) < 0.6 && Math.abs(o.y - 18) < 0.6 && Math.abs(o.h - 10) < 0.6 && o.w < 340 - 1e-6);
                if (prog) m.worldX = prog.w / 340 * 2200;
                const pw = F.text(/^PWR (\d+)$/); if (pw && Math.abs(+pw.m[1] - m.power) > 1.5) m.power = +pw.m[1];
                // top the power up to what the 45° release needs, before AND during the hold —
                // the game accepts taps throughout the run. While holding, only tap while the
                // extra speed still leaves room to reach 45° before the wall fires us early.
                const framesTo45 = Math.max(0, (45 - m.angle) / (62 * dtAvg));
                const room = 2200 - m.worldX - m.vel * framesTo45 * dtAvg - 40;
                if (!m.hold || room > 0) {
                    const need = planned.pHold - m.power;
                    const taps = Math.min(1200, Math.max(0, Math.ceil(need / 2.8)));
                    for (let i = 0; i < taps; i++) { input.down(bT); m.power += 2.8; m.vel = Math.min(460, m.vel + 62); }
                    if (taps) ctx.acted();
                }
                if (!m.hold) {
                    if (m.worldX >= HOLD_AT) { input.down(bG); m.hold = true; }
                    else if (m.vel < 400) { input.down(bT); m.power += 2.8; m.vel = Math.min(460, m.vel + 62); }
                } else {
                    // release on the frame nearest 45°
                    const next = Math.min(88, m.angle + dtAvg * 62);
                    if (Math.abs(m.angle - 45) <= Math.abs(next - 45) || m.angle >= 45) {
                        m.fired = true; m.launchX = m.worldX + 47; m.pFire = m.power;
                        const th = m.angle * Math.PI / 180;
                        m.R = Math.max(20, m.power * 1.6 * Math.pow(Math.max(0, Math.sin(2 * th)), 2.2)) * 40;
                        input.up(bG); ctx.acted();
                        ctx.log('fired at', m.angle.toFixed(2) + '°', 'power', m.power.toFixed(1), 'R', m.R.toFixed(0));
                    }
                }
            },
            result(r) {
                if (!r || !m.fired || m.R <= 0) return;
                const observed = r.v * 40 + 2200 - m.launchX;
                const predicted = clFlight(m.R, m.angle, dtAvg);
                if (predicted > 0 && observed > 0) {
                    const k = learn.ema(ctx.name, 'flightK', observed / predicted, 0.35);
                    ctx.log('distance', r.v + 'm', 'predicted', ((predicted * (ctx.cal.flightK || 1) + m.launchX - 2200) / 40).toFixed(0) + 'm', 'flightK →', k.toFixed(3));
                }
            }
        };
    }
});

// ---------------------------------------------------------------- SHAKE MASTER
// Counts a shake when |acceleration| > 11 after a direction flip, at most one
// per 25 ms, for 13 s → 520 is the ceiling. The devicemotion listener the
// game registers is called directly with alternating ±20 m/s² every 25 ms
// from a MessageChannel loop (sub-millisecond timing, unlike setTimeout).
defineDriver('SHAKE MASTER', {
    kind: 'capped',
    make(ctx) {
        let started = false, ch = null, sign = 1, lastCall = 0, calls = 0, stopped = false;
        const pump = () => {
            if (stopped) return;
            let t = now();
            if (t - lastCall >= 24.2) {
                while ((t = now()) - lastCall < 25.06) { /* spin the last ~1 ms: message latency would cost a count */ }
                lastCall = t; sign = -sign; if (input.motion(sign * 20, 0, 0)) calls++;
            }
            ch.port2.postMessage(0);
        };
        return {
            frame(F) {
                if (stopped) return;
                if (!started) {
                    const b = input.el('hh_smStart');
                    if (b && F.has('PRESS START')) { input.click(b); started = true; ctx.acted(); ctx.log('start'); }
                    return;
                }
                if (!ch && hooks.motion) { ch = new MessageChannel(); ch.port1.onmessage = pump; ch.port2.postMessage(0); }
                if (calls) ctx.acted();
                if (F.has('TIME UP!')) { stopped = true; }
            },
            stop() { stopped = true; if (ch) { ch.port1.onmessage = null; ch.port1.close(); ch.port2.close(); } },
            result(m) { ctx.log('shakes', m && m.v, 'motion calls', calls); }
        };
    }
});

// ---------------------------------------------------------------- QUICK TAB
// Seven receipts; the correct total is exposed as window.__qtT (and readable
// from the '$n' lines anyway). Keys are accepted only in the 'answer' state,
// marked by the elapsed-seconds text at (388,30): type CLR, digits, OK in one
// frame. The clock runs through the game's fixed animations, so ~18.9 s is the floor.
defineDriver('QUICK TAB', {
    kind: 'capped',
    make(ctx) {
        let answered = -1;
        const btn = label => [...W.document.querySelectorAll('#hh_qtPad button')].find(b => b.textContent.trim() === label);
        return {
            frame(F) {
                const timer = F.text(/^\d+\.\ds$/, { x: 388, y: 30, d: 4 });
                if (!timer) return;
                const bill = F.text(/^BILL (\d)\/7$/);
                const round = bill ? +bill.m[1] : 0;
                let total = W.__qtT;
                if (typeof total !== 'number') {
                    // fallback: sum the '$n' price lines above the TOTAL row
                    const tot = F.text('TOTAL');
                    total = F.texts.filter(o => /^\$\d+$/.test(o.s) && (!tot || o.y < tot.y - 1)).reduce((a, o) => a + parseInt(o.s.slice(1), 10), 0);
                }
                if (!total) return;
                const clr = btn('CLR'), ok = btn('OK');
                if (!clr || !ok) return;
                input.down(clr);
                for (const ch of String(total)) { const b = btn(ch); if (b) input.down(b); }
                input.down(ok); ctx.acted();
                if (round !== answered) { answered = round; if (config.verbose) ctx.log('bill', round, 'total', total); }
            }
        };
    }
});

// ---------------------------------------------------------------- ORDER UP!
// The sequence is exposed as window.__ouSeq (and the bubbles are watched as a
// fallback). In the 'input' state ('PUNCH THE ORDER!' on screen) every button
// can be tapped in the same frame; rounds go on until the driver's target,
// where it taps a wrong button on purpose so the record reads "ROUND n KO".
const OU_BTN = i => ({ x: 32.28 + (i % 5) * 56.968 + 28.484, y: 188.52 + Math.floor(i / 5) * 104.1 + 52.05 });
defineDriver('ORDER UP!', {
    kind: 'unbounded', defaultTarget: 25,
    make(ctx) {
        let seen = [], seenRound = 0, doneRound = 0, failed = false;
        return {
            frame(F) {
                const c = input.el('hh_fpcv');
                if (!c || failed) return;
                const rt = F.text(/^ROUND (\d+)$/, { x: 12, y: 28, d: 4 });
                if (!rt) return;
                const round = +rt.m[1];
                if (round !== seenRound) { seenRound = round; seen = []; }
                // fallback recorder: bubble cocktail icon (86 px) while ordering
                const bubble = F.imgs.find(o => /^ou_ck\d$/.test(o.src) && Math.abs(o.w - 86) < 0.6);
                if (bubble) { const k = +bubble.src.slice(5); if (!seen.length || seen[seen.length - 1] !== k || F.text(/^ORDER (\d+) \/ \d+$/) && +F.text(/^ORDER (\d+) \/ \d+$/).m[1] > seen.length) { if (!seen.length || seen[seen.length - 1] !== k) seen.push(k); } }
                if (!F.has('PUNCH THE ORDER!') || doneRound === round) return;
                let seq = Array.isArray(W.__ouSeq) && W.__ouRound === round ? W.__ouSeq.slice() : (Array.isArray(W.__ouSeq) && W.__ouSeq.length === 3 + round ? W.__ouSeq.slice() : seen);
                if (!seq.length) return;
                doneRound = round;
                if (round >= ctx.target.v || ctx.overBudget()) {
                    const wrong = (seq[0] + 1) % 10;
                    const p = OU_BTN(wrong); input.down(c, p.x, p.y, c); ctx.acted(); failed = true;
                    ctx.log('KO on purpose at round', round, '(target', ctx.target.v + ')');
                    return;
                }
                for (const i of seq) { const p = OU_BTN(i); input.down(c, p.x, p.y, c); }
                ctx.acted();
            }
        };
    }
});
