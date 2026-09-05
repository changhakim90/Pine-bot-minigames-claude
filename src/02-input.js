
/* =====================================================================
 * 02 — input: canvas geometry and synthetic events
 * The game maps a pointer to canvas space with
 *   x = (clientX - rect.left) * (400 / rect.width)
 * so every event carries client coordinates derived from the live
 * bounding rect. `gameXY` reproduces the game's own formula from the
 * event actually dispatched, for drivers that must know the exact value
 * the game computed (Stir Stop's angle simulation).
 * ===================================================================== */
const input = {
    _id: 7,
    canvas() {
        const d = W.document;
        return d.getElementById('hh_fpcv') || d.getElementById('hh_gscv') || d.getElementById('hh_dgcv');
    },
    rect(cv) { return cv.getBoundingClientRect(); },
    client(cv, x, y) {
        const r = this.rect(cv);
        const cw = cv.width || 400, ch = cv.height || 480;
        return { clientX: r.left + x * (r.width / cw), clientY: r.top + y * (r.height / ch) };
    },
    gameXY(cv, ev) {
        const r = this.rect(cv);
        return { x: (ev.clientX - r.left) * ((cv.width || 400) / r.width), y: (ev.clientY - r.top) * ((cv.height || 480) / r.height) };
    },
    _ev(type, c, extra) {
        const init = Object.assign({
            bubbles: true, cancelable: true, composed: true, view: W,
            clientX: c.clientX, clientY: c.clientY, screenX: c.clientX, screenY: c.clientY,
            button: 0, buttons: /down|move/.test(type) ? 1 : 0, pointerId: this._id, pointerType: 'touch', isPrimary: true, pressure: /down|move/.test(type) ? 0.5 : 0
        }, extra || {});
        try { return new PointerEvent(type, init); } catch (e) { return new MouseEvent(type.replace('pointer', 'mouse'), init); }
    },
    // dispatch a pointer event of `type` on `el` at canvas coords (x,y) of `cv` (defaults: current canvas).
    // returns the event, so callers can read back the client coordinates the game saw.
    ptr(type, el, x, y, cv) {
        cv = cv || (el && el.tagName === 'CANVAS' ? el : this.canvas());
        let c;
        if (x == null) { const r = el.getBoundingClientRect(); c = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; }
        else c = this.client(cv, x, y);
        const ev = this._ev(type, c);
        el.dispatchEvent(ev);
        return ev;
    },
    down(el, x, y, cv) { return this.ptr('pointerdown', el, x, y, cv); },
    move(el, x, y, cv) { return this.ptr('pointermove', el, x, y, cv); },
    up(el, x, y, cv) { return this.ptr('pointerup', el, x, y, cv); },
    tap(el, x, y, cv) { this.down(el, x, y, cv); return this.up(el, x, y, cv); },
    // press-and-drag from (x0,y0) to (x1,y1) in one go: down, a move, up on the canvas (up bubbles to window)
    drag(cv, x0, y0, x1, y1) { this.down(cv, x0, y0, cv); this.move(cv, x1, y1, cv); return this.up(cv, x1, y1, cv); },
    click(el) { try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: W })); } catch (e) { el.click && el.click(); } },
    key(k, down) {
        const code = k.length === 1 ? 'Key' + k.toUpperCase() : k;
        W.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k, code, bubbles: true, cancelable: true }));
    },
    // feed the game's devicemotion handler directly; `acceleration` is what Shake Master reads first
    motion(x, y, z) {
        const fn = hooks.motion;
        if (!fn) return false;
        try { fn({ acceleration: { x, y, z }, accelerationIncludingGravity: { x, y, z: z + 9.8 }, interval: 16 }); } catch (e) { return false; }
        return true;
    },
    el(id) { return W.document.getElementById(id); },
    visible(el) { return !!el && !el.classList.contains('hidden') && el.offsetParent !== null; }
};
