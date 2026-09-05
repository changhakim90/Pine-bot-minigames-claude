/* =====================================================================
 * 02 — INPUT: canvas geometry and synthetic pointer / touch / key input
 * ---------------------------------------------------------------------
 * The games are canvas-drawn and read pointer position through
 * getBoundingClientRect() scaling (CSS px -> canvas px). `toClient()`
 * inverts that mapping so drivers can think in canvas coordinates.
 * Every synthetic event carries clientX/Y, pageX/Y, offsetX/Y and a
 * matching touches list, so whichever family the game listens to, the
 * numbers line up. Synthetic events have isTrusted=false — the game's
 * handlers (read through hooks.listeners) do not check it.
 * ===================================================================== */
const input = {
    sent: 0,               // events dispatched since load
    lastTapAt: 0,
    canvas() {
        // The game's main canvas: the largest visible one, cached per frame.
        if (this._cv && this._cvFrame === hooks.frame) return this._cv;
        const list = safe(() => Array.from(document.querySelectorAll('canvas')), []) || [];
        let best = null, bestA = 0;
        for (const c of list) {
            const r = safe(() => c.getBoundingClientRect());
            if (!r || r.width < 50 || r.height < 50) continue;
            const a = r.width * r.height;
            if (a > bestA) { bestA = a; best = c; }
        }
        this._cv = best; this._cvFrame = hooks.frame;
        return best;
    },
    // canvas px -> client px
    toClient(x, y, cv) {
        cv = cv || this.canvas();
        if (!cv) return { x, y };
        const r = cv.getBoundingClientRect();
        const sx = r.width / (cv.width || r.width || 1), sy = r.height / (cv.height || r.height || 1);
        return { x: r.left + x * sx, y: r.top + y * sy };
    },
    // Which element should receive pointer events: the one the game listens on, else the canvas.
    target(type) {
        const pref = hooks.listeners.filter(l => l.type.startsWith(type) && l.target && l.target.nodeType === 1 && l.target !== document.documentElement && l.target.id !== 'pineMiniPanel');
        return pref.length ? pref[pref.length - 1].target : (this.canvas() || document.body);
    },
    _ev(Ctor, type, cx, cy, extra) {
        const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, buttons: type.endsWith('down') || type.endsWith('move') ? 1 : 0, pointerId: 1, pointerType: 'touch', isPrimary: true, view: window };
        let ev = null;
        try { ev = new Ctor(type, Object.assign(base, extra || {})); } catch (e) { try { ev = new MouseEvent(type, base); } catch (e2) { return null; } }
        return ev;
    },
    _touch(type, el, cx, cy) {
        if (typeof TouchEvent === 'undefined' || typeof Touch === 'undefined') return null;
        try {
            const t = new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy, pageX: cx + window.scrollX, pageY: cy + window.scrollY, screenX: cx, screenY: cy });
            const list = type === 'touchend' || type === 'touchcancel' ? [] : [t];
            return new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: list, targetTouches: list, changedTouches: [t], view: window });
        } catch (e) { return null; }
    },
    dispatch(el, ev) { if (el && ev) { this.sent++; return safe(() => el.dispatchEvent(ev)); } },
    // ---- primitives: all take CANVAS coordinates --------------------------
    down(x, y) {
        const el = this.target('pointer') || this.target('mouse') || this.target('touch');
        const c = this.toClient(x, y);
        this.dispatch(el, this._ev(window.PointerEvent || MouseEvent, 'pointerdown', c.x, c.y));
        this.dispatch(el, this._touch('touchstart', el, c.x, c.y));
        this.dispatch(el, this._ev(MouseEvent, 'mousedown', c.x, c.y));
        this._downAt = { x, y };
    },
    move(x, y) {
        const el = this.target('pointer') || this.target('mouse') || this.target('touch');
        const c = this.toClient(x, y);
        this.dispatch(el, this._ev(window.PointerEvent || MouseEvent, 'pointermove', c.x, c.y));
        this.dispatch(el, this._touch('touchmove', el, c.x, c.y));
        this.dispatch(el, this._ev(MouseEvent, 'mousemove', c.x, c.y));
    },
    up(x, y) {
        const el = this.target('pointer') || this.target('mouse') || this.target('touch');
        const c = this.toClient(x, y);
        this.dispatch(el, this._ev(window.PointerEvent || MouseEvent, 'pointerup', c.x, c.y));
        this.dispatch(el, this._touch('touchend', el, c.x, c.y));
        this.dispatch(el, this._ev(MouseEvent, 'mouseup', c.x, c.y));
        this.dispatch(el, this._ev(MouseEvent, 'click', c.x, c.y));
        this._downAt = null;
    },
    tap(x, y) { if (config.observeOnly) return; this.down(x, y); this.up(x, y); this.lastTapAt = now(); },
    // A drag along a path of canvas points, all within one frame (games that
    // integrate pointer deltas per event, not per frame, get the whole stroke).
    drag(points) {
        if (config.observeOnly || !points || !points.length) return;
        this.down(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) this.move(points[i].x, points[i].y);
        const last = points[points.length - 1];
        this.up(last.x, last.y);
    },
    key(code, type) {
        if (config.observeOnly) return;
        const el = this.target('key') || document;
        const key = code.length === 1 ? code : code.replace(/^Key|^Digit/, '');
        const init = { bubbles: true, cancelable: true, composed: true, key, code, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : (code === 'Space' ? 32 : 0), which: 0, view: window };
        init.which = init.keyCode;
        const types = type ? [type] : ['keydown', 'keyup'];
        for (const t of types) this.dispatch(el, safe(() => new KeyboardEvent(t, init)));
    },
    // Synthetic device shake for accelerometer-driven games (only if the game listens).
    shake(mag) {
        if (config.observeOnly) return;
        const ls = hooks.listeners.filter(l => l.type === 'devicemotion');
        if (!ls.length) return false;
        const g = mag || 30, s = (hooks.frame & 1) ? 1 : -1;
        const ev = { type: 'devicemotion', acceleration: { x: g * s, y: -g * s, z: g }, accelerationIncludingGravity: { x: g * s, y: 9.8 - g * s, z: g }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 };
        for (const l of ls) safe(() => l.fn.call(l.target, ev));
        return true;
    }
};
