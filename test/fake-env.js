// Minimal browser + game fake so the userscript can be loaded in Node.
// Returns { pineMini, store, logs, canvas, events, step } — `step(n)` runs n
// fake game frames through the (hooked) requestAnimationFrame, and `events`
// is every synthetic input event the bot dispatched at the canvas.
module.exports = function makeEnv(opts = {}) {
    const store = Object.assign({}, opts.storage || {});
    global.localStorage = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        get length() { return Object.keys(store).length; },
        key: i => Object.keys(store)[i] == null ? null : Object.keys(store)[i],
        _store: store
    };
    // ---- events ---------------------------------------------------------
    class EventTarget {
        constructor() { this._l = {}; }
        addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
        removeEventListener() { }
        dispatchEvent(ev) { ev.target = ev.target || this; events.push({ type: ev.type, x: ev.clientX, y: ev.clientY, target: this }); for (const fn of (this._l[ev.type] || [])) fn.call(this, ev); return true; }
    }
    class Event { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } }
    class MouseEvent extends Event { } class PointerEvent extends MouseEvent { } class KeyboardEvent extends Event { }
    class Touch { constructor(i) { Object.assign(this, i); } } class TouchEvent extends Event { }
    const events = [];
    Object.assign(global, { EventTarget, Event, MouseEvent, PointerEvent, KeyboardEvent, Touch, TouchEvent });
    // ---- DOM --------------------------------------------------------------
    const mkEl = (tag) => {
        const el = new EventTarget();
        Object.assign(el, { tagName: (tag || 'div').toUpperCase(), nodeType: 1, id: '', style: {}, children: [], textContent: '', innerHTML: '',
            appendChild(c) { this.children.push(c); return c; }, remove() { }, click() { }, setAttribute() { }, getAttribute() { return null; },
            querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, top: 0, width: 540, height: 540 }) });
        return el;
    };
    const canvas = mkEl('canvas'); canvas.width = 540; canvas.height = 540; canvas.id = 'game';
    const scripts = (opts.scripts || []).map(t => ({ src: '', textContent: t }));
    const body = mkEl('body'); body.innerText = opts.bodyText || '';
    global.document = new EventTarget();
    Object.assign(global.document, { readyState: 'complete', body, scripts, title: 'Pine & Co', nodeType: 9,
        getElementById: () => null, createElement: t => mkEl(t), querySelector: () => null,
        querySelectorAll: sel => sel === 'canvas' ? [canvas] : [], hidden: false });
    global.window = global;
    global.location = { href: 'https://pineandco.online/' };
    global.navigator = {}; global.scrollX = 0; global.scrollY = 0;
    global.getComputedStyle = () => ({});
    global.performance = { now: () => Date.now() };
    // ---- rAF: manual stepping -------------------------------------------
    let queue = [];
    global.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
    global.cancelAnimationFrame = () => { };
    // ---- game globals (lexical in the real page; plain globals resolve the same way for (0,eval)) ----
    Object.assign(global, opts.game || {});
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { const line = a.map(String).join(' '); if (/\[PineMini\]/.test(line)) logs.push(line); else origLog(...a); };
    const src = require('fs').readFileSync(opts.script, 'utf8');
    new Function(src)();
    // the game's own loop, registered AFTER the bot hooked rAF (like a real page: bot at document-start)
    const gameFrame = opts.gameFrame || (() => { });
    let ts = 0;
    (function loop() { gameFrame(); requestAnimationFrame(loop); })();
    const step = n => { for (let i = 0; i < (n || 1); i++) { const q = queue; queue = []; ts += 16.7; for (const cb of q) cb(ts); } };
    return { pineMini: global.window.pineMini, store, logs, canvas, events, step };
};
