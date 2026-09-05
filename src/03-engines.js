/* =====================================================================
 * 03 — ENGINES: reusable strategies. Each is pure play logic over a
 * `read()` view of the game's state; the drivers in 04 supply the reads.
 * All are written to be testable headless with synthetic state.
 * ===================================================================== */
const engines = {
    // MASH — as many taps as the game will count per frame, at a point.
    // `count` is a function of frame so drivers can stagger (some games
    // debounce per frame; then mashPerFrame=1 is the true ceiling).
    mash(ctx, at, perFrame) {
        const n = perFrame != null ? perFrame : config.mashPerFrame;
        for (let i = 0; i < n; i++) input.tap(at.x, at.y);
        return n;
    },

    // STOP-AT — fire the instant a moving value will hit a target, taking
    // input lead into account. `s` is per-driver state kept across frames.
    //   value():  the moving quantity (angle, fill level, needle position…)
    //   target(): where it should stop (a number, or [lo, hi] window)
    //   fire():   the input that stops it
    // Predicts one lead-interval ahead using the observed per-frame delta
    // (linear), so a value that will pass the target between now and the
    // next frame fires NOW instead of one frame late.
    stopAt(s, value, target, fire, opts) {
        opts = opts || {};
        const v = value();
        if (!isFinite(v)) return false;
        const prev = s.prev; s.prev = v;
        if (prev == null) return false;
        const dv = v - prev;                                       // per frame
        const leadFrames = (config.inputLeadMs + (opts.leadMs || 0)) / Math.max(1, hooks.frameDtMs);
        const next = v + dv * (1 + leadFrames);                     // where it will be when our input lands
        const t = target();
        let lo, hi;
        if (Array.isArray(t)) { lo = t[0]; hi = t[1]; } else { const tol = opts.tol != null ? opts.tol : Math.abs(dv) / 2; lo = t - tol; hi = t + tol; }
        const center = (lo + hi) / 2;
        // Fire if the predicted landing is inside the window, or if the value
        // will cross the center between now and landing (never wait a frame
        // and overshoot). Wrap-aware for cyclic values (opts.period).
        const P = opts.period;
        const dist = x => P ? (((x - center) % P) + P * 1.5) % P - P / 2 : x - center;
        const dNow = dist(v), dNext = dist(next);
        const inside = dNext >= lo - center && dNext <= hi - center;
        const crossing = (dNow < 0 && dNext >= 0) || (dNow > 0 && dNext <= 0);
        if (inside || crossing) {
            if (s.firedAt != null && hooks.frame - s.firedAt < (opts.refractoryFrames || 10)) return false;
            s.firedAt = hooks.frame;
            fire();
            return true;
        }
        return false;
    },

    // HUNT — tap every live entity in a list, nearest-first, up to a per-frame budget.
    //   list(): array of entities;  pos(e): {x,y} in canvas px;  alive(e): bool
    //   Predicts each entity's movement by its own velocity if it exposes vx/vy.
    hunt(ctx, list, pos, alive, budget) {
        const es = (list() || []).filter(e => e && (!alive || alive(e)));
        const lead = 1 + config.inputLeadMs / Math.max(1, hooks.frameDtMs);
        let n = 0;
        for (const e of es) {
            if (n >= (budget || 8)) break;
            const p = pos(e);
            if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
            const x = p.x + (isFinite(e.vx) ? e.vx * lead : 0), y = p.y + (isFinite(e.vy) ? e.vy * lead : 0);
            input.tap(x, y);
            n++;
        }
        return n;
    },

    // SEQUENCE — the game shows an order (list of ids); tap the matching
    // button/slot for each in turn. `slots()` returns [{id, x, y}], `need()`
    // returns the id wanted next (or null when the order is complete).
    sequence(s, need, slots, opts) {
        const id = need();
        if (id == null) return false;
        const slot = (slots() || []).find(sl => sl.id === id);
        if (!slot) return false;
        if (s.lastId === id && s.lastFrame === hooks.frame) return false;
        s.lastId = id; s.lastFrame = hooks.frame;
        input.tap(slot.x, slot.y);
        return true;
    },

    // TRACK — hold the pointer on a moving x (catch games): one move per
    // frame to where the falling thing will be when it reaches the catcher.
    //   things(): entities with x,y,vy;  catcherY: number;  set(x): move the catcher
    track(s, things, catcherY, set) {
        const ts = (things() || []).filter(t => t && isFinite(t.x) && isFinite(t.y) && t.y <= catcherY);
        if (!ts.length) return false;
        // The one that lands first.
        let best = null, bestT = Infinity;
        for (const t of ts) {
            const vy = isFinite(t.vy) && t.vy > 0 ? t.vy : 1;
            const eta = (catcherY - t.y) / vy;
            if (eta < bestT) { bestT = eta; best = t; }
        }
        const x = best.x + (isFinite(best.vx) ? best.vx * bestT : 0);
        set(x);
        return true;
    },

    // TRACE — drag along a path of canvas points (carving / drawing games),
    // `points()` in order; the whole stroke goes out in one frame.
    trace(s, points) {
        if (s.done) return false;
        const pts = points();
        if (!pts || pts.length < 2) return false;
        input.drag(pts);
        s.done = true;
        return true;
    }
};
