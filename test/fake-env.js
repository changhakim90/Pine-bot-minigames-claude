// Minimal fake browser for the headless tests: enough window/document/canvas
// for the script to boot, hook the canvas prototype, record frames and let
// drivers dispatch input. No real DOM, no timers beyond setTimeout.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function makeEnv(config) {
    const listeners = new Map();
    class Node {
        constructor(tag, id) {
            this.tagName = tag.toUpperCase(); this.id = id || ''; this.className = ''; this.textContent = ''; this.innerHTML = ''; this.style = {}; this.children = []; this.events = []; this.width = 400; this.height = 480; this.offsetParent = {}; this.hidden = false;
            const set = new Set();
            this.classList = { add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)), contains: c => set.has(c), toggle: (c, f) => f ? set.add(c) : set.delete(c) };
            this._cls = set;
        }
        getBoundingClientRect() { return { left: 10, top: 20, width: this.width, height: this.height }; }
        addEventListener(type, fn) { const k = this; if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push({ type, fn }); }
        removeEventListener() { }
        dispatchEvent(ev) { this.events.push(ev); (listeners.get(this) || []).forEach(l => { if (l.type === ev.type) l.fn(ev); }); if (this.onclick && ev.type === 'click') this.onclick(ev); return true; }
        appendChild(c) { this.children.push(c); return c; }
        querySelector() { return null; }
        querySelectorAll(sel) { if (sel === '#hh_qtPad button') return this.children.filter(c => c.tagName === 'BUTTON'); return []; }
        click() { this.dispatchEvent({ type: 'click' }); }
        getContext() { if (!this._ctx) this._ctx = new Ctx(this); return this._ctx; }
    }
    class Ctx {
        constructor(canvas) { this.canvas = canvas; this.m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; this.fillStyle = '#000000'; this.stack = []; }
        getTransform() { return Object.assign({}, this.m); }
        setTransform(a, b, c, d, e, f) { this.m = { a, b, c, d, e, f }; }
        translate(x, y) { const m = this.m; m.e += m.a * x + m.c * y; m.f += m.b * x + m.d * y; }
        scale(sx, sy) { const m = this.m; m.a *= sx; m.b *= sx; m.c *= sy; m.d *= sy; }
        rotate(r) { const m = this.m, cs = Math.cos(r), sn = Math.sin(r); const a = m.a * cs + m.c * sn, b = m.b * cs + m.d * sn, c = -m.a * sn + m.c * cs, d = -m.b * sn + m.d * cs; m.a = a; m.b = b; m.c = c; m.d = d; }
        save() { this.stack.push(Object.assign({}, this.m)); } restore() { this.m = this.stack.pop() || this.m; }
        drawImage() { } fillText() { } fillRect() { } moveTo() { } lineTo() { } arc() { } ellipse() { } beginPath() { } fill() { } stroke() { } clearRect() { } strokeRect() { } closePath() { }
    }
    const els = new Map();
    const document = {
        readyState: 'complete',
        body: new Node('body'),
        getElementById: id => els.get(id) || null,
        querySelector: () => null,
        querySelectorAll: sel => { if (sel === '#hh_qtPad button') { const p = els.get('hh_qtPad'); return p ? p.children : []; } return []; },
        createElement: tag => new Node(tag),
        addEventListener: () => { }
    };
    const rafQ = [];
    class Evt { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } preventDefault() { } }
    const storage = new Map();
    const window = {
        document, console,
        localStorage: { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
        performance: { now: () => Date.now() },
        requestAnimationFrame: cb => { rafQ.push(cb); return rafQ.length; },
        cancelAnimationFrame: () => { },
        setInterval: () => 0, clearInterval: () => { }, setTimeout, clearTimeout,
        CanvasRenderingContext2D: Ctx,
        EventTarget: { prototype: Node.prototype },
        PointerEvent: Evt, MouseEvent: Evt, KeyboardEvent: Evt,
        MessageChannel: class { constructor() { this.port1 = { close() { } }; this.port2 = { postMessage() { }, close() { } }; } },
        fetch: () => Promise.reject(new Error('no network')),
        dispatchEvent: ev => { window.events.push(ev); return true; },
        addEventListener: () => { },
        events: [],
        __pineMiniConfig: Object.assign({ auto: false, panel: false, board: false }, config || {})
    };
    window.window = window;
    window.globalThis = window;
    const ctx = vm.createContext(window);
    const script = fs.readFileSync(path.join(__dirname, '..', 'dist', 'pine-mini.user.js'), 'utf8');
    vm.runInContext(script, ctx, { filename: 'pine-mini.user.js' });
    return {
        window, document, els, Node, Ctx, rafQ,
        el(id, tag) { const n = new Node(tag || 'div', id); els.set(id, n); return n; },
        // run one game frame: cb draws on the canvas ctx, then the bot's hooks publish it
        frame(t, draw) {
            const cbs = rafQ.splice(0);
            let ran = false;
            for (const cb of cbs) { cb(t); ran = true; }
            if (!ran) { window.requestAnimationFrame(draw); return this.frame(t, draw); }
        }
    };
}
module.exports = { makeEnv };
