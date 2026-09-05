// ==UserScript==
// @name         Pine & Co Minigame Bot
// @namespace    https://pineandco.online/
// @version      0.2.1
// @description  Autonomous record-chasing player for the Pine & Co "Bartender's Happy Hour" mini games. Watches the game's own canvas draw calls, drives every game with frame-exact synthetic input, plays the whole set on its own, tunes itself from its results and never submits a name to the leaderboard.
// @author       you
// @match        https://pineandco.online/*
// @match        https://www.pineandco.online/*
// @match        http://pineandco.online/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/changhakim90/Pine-bot-minigames-claude/main/dist/pine-mini.user.js
// @downloadURL  https://raw.githubusercontent.com/changhakim90/Pine-bot-minigames-claude/main/dist/pine-mini.user.js
// ==/UserScript==

/* =====================================================================
 * PINE MINI — how this script sees and plays the game
 * ---------------------------------------------------------------------
 * The mini games live inside a nested IIFE: their state (ml, temp, power,
 * the mob list…) is closure-private and cannot be read by name. What the
 * game cannot hide is what it DRAWS. This script runs at document-start and
 * wraps CanvasRenderingContext2D.prototype so every drawImage / fillText /
 * fillRect / path op on a game canvas (id "hh_*") is recorded with its
 * absolute canvas coordinates, its fill colour and the source image's name.
 * requestAnimationFrame is wrapped too, so after each game frame is drawn
 * the recorded ops are handed to the active driver, which reads the
 * position of every sprite, every HUD number and colour, and answers with
 * synthetic pointer / keyboard / motion input before the next frame runs.
 *
 * Nothing in the game is altered: no function is patched, Math.random is
 * untouched, scores are the game's own. The bot only looks and taps.
 * It also never types a name or presses SUBMIT on the result screen —
 * it reads the result, presses OK and moves on.
 *
 * Parts (src/, concatenated in order by build.js):
 *   01-core     header, storage, canvas + rAF hooks, frame model
 *   02-input    canvas geometry + synthetic pointer/key/motion input
 *   03-flow     hub navigation, scheduler, leaderboard reading, learning
 *   04-games-a  Blind Pour, Stir Stop, Ice Carving, Champagne, Shake, Quick Tab, Order Up
 *   05-games-b  Where Is My Shot, Fresh Squeeze, Tip Catch, Fly Swat, Glass Stack, Table Rush
 *   06-panel    panel, public API, boot
 * ===================================================================== */
(function () {
'use strict';
const SCRIPT_VERSION = '0.2.1';
const TAG = '[PineMini]';
const NS = 'pineMini_';
const W = (typeof window !== 'undefined') ? window : globalThis;

// ---------------------------------------------------------------- utils
const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
const now = () => (W.performance && W.performance.now) ? W.performance.now() : Date.now();
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const log = (...a) => { try { console.log(TAG, ...a); } catch (e) { } };
const warn = (...a) => { try { console.warn(TAG, ...a); } catch (e) { } };
const hypot = (a, b) => Math.sqrt(a * a + b * b);

const store = {
    get(k, d) { return safe(() => { const v = W.localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); }, d); },
    set(k, v) { safe(() => W.localStorage.setItem(NS + k, JSON.stringify(v))); },
    del(k) { safe(() => W.localStorage.removeItem(NS + k)); }
};

const GAME_NAMES = ['BLIND POUR', 'STIR STOP', 'ICE CARVING', 'CHAMPAGNE LAUNCH', 'SHAKE MASTER', 'QUICK TAB', 'ORDER UP!', 'WHERE IS MY SHOT?', 'FRESH SQUEEZE', 'TIP CATCH', 'FLY SWAT', 'GLASS STACK', 'TABLE RUSH'];

const DEFAULT_CONFIG = {
    auto: true,             // play on its own as soon as the hub is reachable
    games: GAME_NAMES,      // queue; order is followed on the first pass
    loop: true,             // keep replaying unbeaten / improvable games after the first pass
    stopWhenBeaten: false,  // stop once every game beats the board's #1 (else keep improving)
    howtoWaitMs: 1400,      // let the game warm its assets on the HOW TO PLAY screen
    resultWaitMs: 900,      // read the result screen this long before pressing OK
    margin: 0.10,           // unbounded games aim this far above the board's #1 (fraction)
    minMargin: 2,           // ...and at least this many units above it
    board: true,            // read the public leaderboard (GET only) to set targets
    submit: false,          // NEVER submit — kept here only so the rule is visible; ignored if true
    verbose: false,
    panel: true
};
const config = Object.assign({}, DEFAULT_CONFIG, store.get('config', {}), safe(() => W.__pineMiniConfig, null) || {});
config.submit = false;

// ---------------------------------------------------------------- hooks
// frame model: every rAF callback that drew on a game canvas produces one
// Frame {t, dt, id, ops, texts, imgs, rects, paths, arcs} handed to `onFrame`.
const hooks = {
    installed: false,
    nativeRAF: null,
    nativeCAF: null,
    frames: 0,
    lastT: 0,
    cur: null,          // ops being recorded for the callback running now
    onFrame: null,      // function(frame)
    motion: null,       // the game's devicemotion listener (Shake Master)
    listeners: []       // {type, fn, target}
};

function imgName(src) {
    if (!src) return 'canvas';
    if (src.__pmSrc) return src.__pmSrc;
    const s = typeof src === 'string' ? src : (src.currentSrc || src.src || '');
    if (!s) return src.tagName === 'CANVAS' ? 'canvas' : 'img';
    const base = s.split('?')[0].split('#')[0].split('/').pop();
    return base.replace(/\.(png|webp|jpe?g|gif|svg)$/i, '');
}

function isGameCanvas(cv) {
    const id = cv && cv.id;
    return !!id && id.charCodeAt(0) === 104 && id.slice(0, 3) === 'hh_' && id !== 'hh_decoCv';
}

function installHooks() {
    if (hooks.installed) return;
    hooks.installed = true;
    const P = W.CanvasRenderingContext2D && W.CanvasRenderingContext2D.prototype;
    if (P) {
        const wrap = (name, rec) => {
            const nat = P[name];
            if (typeof nat !== 'function') return;
            P[name] = function () {
                const cv = this.canvas;
                if (cv) {
                    if (isGameCanvas(cv)) {
                        const cur = hooks.cur;
                        if (cur) { try { rec.call(this, cur, arguments); } catch (e) { } }
                    } else if (name === 'drawImage' && !cv.id && !cv.__pmSrc) {
                        // offscreen keying canvases (fpKey) inherit the name of the image copied into them
                        const im = arguments[0];
                        if (im && im.tagName === 'IMG') cv.__pmSrc = imgName(im);
                    }
                }
                return nat.apply(this, arguments);
            };
        };
        const xf = (ctx, x, y) => { const m = ctx.getTransform(); return [m.e + m.a * x + m.c * y, m.f + m.b * x + m.d * y, m]; };
        wrap('drawImage', function (cur, a) {
            let dx, dy, dw, dh, sx = 0, sy = 0;
            const im = a[0];
            if (a.length >= 9) { sx = a[1]; sy = a[2]; dx = a[5]; dy = a[6]; dw = a[7]; dh = a[8]; }
            else { dx = a[1]; dy = a[2]; dw = a.length >= 5 ? a[3] : (im.width || 0); dh = a.length >= 5 ? a[4] : (im.height || 0); }
            const [cx, cy, m] = xf(this, dx + dw / 2, dy + dh / 2);
            const w = dw * hypot(m.a, m.b), h = dh * hypot(m.c, m.d);
            cur.push({ op: 'img', src: imgName(im), cx, cy, w, h, sx, sy, rot: Math.atan2(m.b, m.a) });
        });
        wrap('fillText', function (cur, a) {
            const [x, y] = xf(this, a[1], a[2]);
            cur.push({ op: 'text', s: String(a[0]), x, y, fs: typeof this.fillStyle === 'string' ? this.fillStyle : '' });
        });
        wrap('fillRect', function (cur, a) {
            const [x, y, m] = xf(this, a[0], a[1]);
            cur.push({ op: 'rect', x, y, w: a[2] * m.a, h: a[3] * m.d, fs: typeof this.fillStyle === 'string' ? this.fillStyle : '' });
        });
        wrap('moveTo', function (cur, a) { const [x, y] = xf(this, a[0], a[1]); cur.push({ op: 'move', x, y }); });
        wrap('lineTo', function (cur, a) { const [x, y] = xf(this, a[0], a[1]); cur.push({ op: 'line', x, y }); });
        wrap('arc', function (cur, a) {
            const [x, y, m] = xf(this, a[0], a[1]);
            cur.push({ op: 'arc', x, y, r: a[2] * hypot(m.a, m.b), fs: typeof this.fillStyle === 'string' ? this.fillStyle : '' });
        });
        wrap('ellipse', function (cur, a) {
            const [x, y, m] = xf(this, a[0], a[1]);
            cur.push({ op: 'ellipse', x, y, rx: a[2] * hypot(m.a, m.b), ry: a[3] * hypot(m.c, m.d), fs: typeof this.fillStyle === 'string' ? this.fillStyle : '' });
        });
    }
    // requestAnimationFrame: record each callback's draw ops and publish them as one frame
    if (typeof W.requestAnimationFrame === 'function') {
        hooks.nativeRAF = W.requestAnimationFrame.bind(W);
        hooks.nativeCAF = W.cancelAnimationFrame ? W.cancelAnimationFrame.bind(W) : null;
        W.requestAnimationFrame = function (cb) {
            return hooks.nativeRAF(function (t) {
                const ops = [];
                const prev = hooks.cur;
                hooks.cur = ops;
                try { cb(t); }
                finally {
                    hooks.cur = prev;
                    if (ops.length) publishFrame(t, ops);
                }
            });
        };
    }
    // devicemotion: keep the game's listener so Shake Master can be fed directly
    const ET = W.EventTarget && W.EventTarget.prototype;
    if (ET && typeof ET.addEventListener === 'function') {
        const natAdd = ET.addEventListener, natRem = ET.removeEventListener;
        ET.addEventListener = function (type, fn, opt) {
            if (type === 'devicemotion' && typeof fn === 'function') hooks.motion = fn;
            if (typeof fn === 'function' && /^(pointer|touch|key|click|devicemotion)/.test(type)) {
                hooks.listeners.push({ type, fn, target: this });
                if (hooks.listeners.length > 400) hooks.listeners.splice(0, 100);
            }
            return natAdd.call(this, type, fn, opt);
        };
        ET.removeEventListener = function (type, fn, opt) {
            if (type === 'devicemotion' && hooks.motion === fn) hooks.motion = null;
            return natRem.call(this, type, fn, opt);
        };
    }
}

// ---------------------------------------------------------------- frame model
function Frame(t, ops) {
    this.t = t;
    this.dt = hooks.lastT ? Math.min(0.05, (t - hooks.lastT) / 1000) : 1 / 60;   // exactly how the game computes dt
    this.ops = ops;
    this.id = '';
    this.texts = []; this.imgs = []; this.rects = []; this.arcs = []; this.ellipses = [];
    for (let i = 0; i < ops.length; i++) {
        const o = ops[i];
        if (o.op === 'img') this.imgs.push(o);
        else if (o.op === 'text') this.texts.push(o);
        else if (o.op === 'rect') this.rects.push(o);
        else if (o.op === 'arc') this.arcs.push(o);
        else if (o.op === 'ellipse') this.ellipses.push(o);
    }
}
Frame.prototype.text = function (re, near) {
    // first text op whose string matches `re` (string or RegExp); `near` = {x, y, d} restricts by position
    for (const o of this.texts) {
        const m = typeof re === 'string' ? (o.s.indexOf(re) >= 0 ? [o.s] : null) : o.s.match(re);
        if (!m) continue;
        if (near && (Math.abs(o.x - near.x) > (near.d || 6) || Math.abs(o.y - near.y) > (near.d || 6))) continue;
        return { s: o.s, m, x: o.x, y: o.y, fs: o.fs };
    }
    return null;
};
Frame.prototype.has = function (re, near) { return !!this.text(re, near); };
Frame.prototype.img = function (re) { return this.imgs.filter(o => (typeof re === 'string' ? o.src === re : re.test(o.src))); };
Frame.prototype.rect = function (x, y, w, h, tol) {
    const d = tol == null ? 1.5 : tol;
    for (const o of this.rects) if (Math.abs(o.x - x) < d && Math.abs(o.y - y) < d && (w == null || Math.abs(o.w - w) < d) && (h == null || Math.abs(o.h - h) < d)) return o;
    return null;
};
Frame.prototype.rgb = function (fs) {
    // 'rgb(r,g,b)' / '#rrggbb' → [r,g,b]
    if (!fs) return null;
    let m = fs.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    m = fs.match(/^#([0-9a-f]{6})$/i);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    m = fs.match(/^#([0-9a-f]{3})$/i);
    if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
    return null;
};

function publishFrame(t, ops) {
    // ops of one rAF callback; the canvas id comes from the DOM element the ops were drawn on
    const f = new Frame(t, ops);
    hooks.frames++;
    f.id = currentGameCanvasId();
    const cb = hooks.onFrame;
    if (cb) { try { cb(f); } catch (e) { warn('frame handler', e); } }
    hooks.lastT = t;
}
function currentGameCanvasId() {
    const d = W.document;
    if (!d) return '';
    for (const id of ['hh_fpcv', 'hh_gscv', 'hh_dgcv']) if (d.getElementById(id)) return id;
    return '';
}

installHooks();


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


/* =====================================================================
 * 03 — flow: ranking metric, learning store, leaderboard, scheduler
 * ===================================================================== */
// The game's own ranking rule: first number in the result text; '±' and '⏱' mean lower is better.
function rankMetric(t) {
    const s = String(t || '');
    const m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    return { v: parseFloat(m[0]), low: s.indexOf('±') >= 0 || s.indexOf('⏱') >= 0 };
}
function rankCmp(a, b) {
    const ma = rankMetric(a.t), mb = rankMetric(b.t);
    if (ma && mb) return ma.low ? ma.v - mb.v : mb.v - ma.v;
    if (ma) return -1;
    if (mb) return 1;
    return (b.s || 0) - (a.s || 0);
}
const isBetter = (v, than, low) => than == null ? true : (low ? v < than : v > than);

// ---------------------------------------------------------------- learning store
// learn[name] = { plays, best:{v,txt,at}, hist:[{v,txt,at,params}], params:{}, cal:{} }
const learn = {
    data: store.get('learn', {}),
    game(name) {
        let g = this.data[name];
        if (!g) g = this.data[name] = { plays: 0, best: null, hist: [], params: {}, cal: {} };
        if (!g.params) g.params = {};
        if (!g.cal) g.cal = {};
        if (!g.hist) g.hist = [];
        return g;
    },
    save() { store.set('learn', this.data); },
    reset(name) { if (name) delete this.data[name]; else this.data = {}; this.save(); },
    // record a finished play; returns true when it is a new best
    record(name, txt, params) {
        const g = this.game(name), m = rankMetric(txt);
        g.plays++;
        const entry = { v: m ? m.v : null, txt, at: Date.now(), params: Object.assign({}, params || {}) };
        g.hist.push(entry);
        if (g.hist.length > 60) g.hist.splice(0, g.hist.length - 60);
        let nb = false;
        if (m && (!g.best || isBetter(m.v, g.best.v, m.low))) { g.best = { v: m.v, txt, at: entry.at, low: m.low }; nb = true; }
        this.save();
        return nb;
    },
    // exponential moving average helper for calibration values
    ema(name, key, sample, alpha) {
        const c = this.game(name).cal;
        const prev = c[key];
        c[key] = prev == null ? sample : prev + (sample - prev) * (alpha == null ? 0.3 : alpha);
        c[key + '_n'] = (c[key + '_n'] || 0) + 1;
        this.save();
        return c[key];
    }
};

// ---------------------------------------------------------------- tunables
// A driver declares tunables {key: {min, max, step, init}}. Before each play
// the scheduler picks values: the best-known value most of the time, one step
// up or down otherwise, and keeps per-value averages so the pick converges
// on what actually scores best. Honest hill-climbing, nothing more.
const tune = {
    pick(name, spec) {
        const g = learn.game(name), out = {};
        g.tune = g.tune || {};
        for (const k in spec) {
            const s = spec[k], st = g.tune[k] = g.tune[k] || { vals: {} };
            const cur = g.params[k] == null ? s.init : g.params[k];
            let best = cur, bestMean = -Infinity;
            for (const v in st.vals) { const e = st.vals[v]; if (e.n && e.mean > bestMean) { bestMean = e.mean; best = +v; } }
            let v = best;
            const explore = Math.random() < (s.explore == null ? 0.25 : s.explore);
            if (explore) v = clamp(best + (Math.random() < 0.5 ? -1 : 1) * s.step, s.min, s.max);
            out[k] = +v.toFixed(6);
        }
        Object.assign(g.params, out);
        return out;
    },
    // score is "higher is better" for the tuner; drivers pass -error for precision games
    report(name, params, score) {
        const g = learn.game(name);
        g.tune = g.tune || {};
        for (const k in params) {
            const st = g.tune[k] = g.tune[k] || { vals: {} };
            const key = String(params[k]);
            const e = st.vals[key] = st.vals[key] || { n: 0, mean: 0 };
            e.n++; e.mean += (score - e.mean) / e.n;
        }
        learn.save();
    }
};

// ---------------------------------------------------------------- leaderboard (read-only)
const BOARD_URL = 'https://barparty-board.showjojo100.workers.dev';
const board = {
    top: {},      // name → {v, txt, low, n}
    at: 0,
    async refresh() {
        if (!config.board) return false;
        try {
            const r = await fetch(BOARD_URL + '?all=1&t=' + Date.now());
            const j = await r.json();
            const games = (j && j.ok && j.games) || (j && !j.ok ? null : j) || null;
            if (!games) return false;
            for (const name of GAME_NAMES) {
                const arr = [...(games[name] || [])].sort(rankCmp);
                if (arr.length) { const m = rankMetric(arr[0].t); this.top[name] = m ? { v: m.v, low: m.low, txt: arr[0].t, n: arr[0].n } : null; }
            }
            this.at = Date.now();
            store.set('board', { top: this.top, at: this.at });
            return true;
        } catch (e) { warn('board unavailable', e && e.message); return false; }
    },
    load() { const b = store.get('board', null); if (b) { this.top = b.top || {}; this.at = b.at || 0; } }
};
board.load();

// ---------------------------------------------------------------- drivers registry
// A driver spec: { kind:'unbounded'|'capped'|'precision', floor, defaultTarget, tunables,
//                  make(game) → { frame(F), tick(), stop(), result(m) } }
const drivers = {};
function defineDriver(name, spec) { drivers[name] = spec; }

// target for a game: beat the board's #1 by a margin (unbounded), reach the floor (precision), else "as much as possible"
function targetFor(name) {
    const spec = drivers[name] || {};
    const top = board.top[name];
    const g = learn.game(name);
    if (spec.kind === 'precision') return { v: spec.floor == null ? 0 : spec.floor, low: true, why: 'floor' };
    if (spec.kind === 'unbounded') {
        let v = (config.e2eTargets && config.e2eTargets[name]) || spec.defaultTarget || 10;
        if (top && !top.low) v = Math.ceil(Math.max(top.v * (1 + config.margin), top.v + config.minMargin));
        if (g.best && !g.best.low && g.best.v >= v && top && g.best.v > top.v) v = g.best.v;    // already there: hold
        return { v, low: false, why: top ? 'board' : 'default' };
    }
    return { v: top ? top.v : null, low: top ? top.low : false, why: top ? 'board' : 'none' };
}
function beaten(name) {
    const g = learn.game(name), spec = drivers[name] || {};
    if (!g.best) return false;
    const t = targetFor(name);
    if (spec.kind === 'precision') return g.best.v <= t.v + 1e-9;
    if (t.v == null) return false;
    if (spec.kind === 'unbounded') return g.best.v >= t.v;
    return isBetter(g.best.v, t.v, t.low);
}
// does this game deserve another play right now?
function wantsPlay(name) {
    const g = learn.game(name), spec = drivers[name] || {};
    if (!drivers[name]) return false;
    if (!g.plays) return true;
    if (spec.kind === 'precision') return !beaten(name) && g.plays < (spec.maxPlays || 400);
    if (spec.kind === 'unbounded') return !beaten(name);
    // capped: keep playing while the recent plays still improve
    if (g.plays < 3) return true;
    const h = g.hist.slice(-6);
    const last = h[h.length - 1], m = rankMetric(last.txt);
    let improved = false;
    for (let i = h.length - 3; i < h.length; i++) if (i >= 0 && g.best && h[i].at === g.best.at) improved = true;
    return improved || (m && !beaten(name) && g.plays < 12);
}

// ---------------------------------------------------------------- flow
const flow = {
    state: 'idle',       // idle | title | hub | howto | game | result | stopped
    since: 0,
    game: null,          // {name, driver, t0, params, frames}
    queue: [],
    pass: 0,
    played: 0,
    results: store.get('results', []),
    timer: null,
    lastFrameAt: 0,
    err: '',
    start() {
        if (this.timer) return;
        this.state = 'idle'; this.since = now();
        this.queue = config.games.filter(n => drivers[n]);
        this.timer = setInterval(() => this.tick(), 100);
        hooks.onFrame = f => this.frame(f);
        if (config.board) board.refresh();
        log('auto play started, queue:', this.queue.join(', '));
    },
    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.endGame();
        this.state = 'stopped';
        log('stopped');
    },
    set(state) { if (state !== this.state) { this.state = state; this.since = now(); if (config.verbose) log('→', state); } },
    age() { return now() - this.since; },
    hubReady() {
        const tg = input.el('hh_titleGames');
        return !!tg && tg.classList.contains('on') && input.visible(input.el('hh_title')) && W.document.querySelectorAll('#hh_sbwrap2 .gcard').length > 0;
    },
    nextGame() {
        if (this.queue.length) return this.queue.shift();
        if (config.once) return null;
        // after the first pass: whichever game still wants a play, least-played first
        const cands = config.games.filter(n => drivers[n] && wantsPlay(n));
        if (cands.length) { cands.sort((a, b) => learn.game(a).plays - learn.game(b).plays); return cands[0]; }
        if (config.stopWhenBeaten || !config.loop) return null;
        // everything beaten / saturated: keep polishing, least-played first
        const all = config.games.filter(n => drivers[n]).sort((a, b) => learn.game(a).plays - learn.game(b).plays);
        return all[0] || null;
    },
    tick() {
        const d = W.document;
        if (!d || !d.body) return;
        try {
            const hh = input.el('happyHour');
            switch (this.state) {
                case 'idle':
                case 'title': {
                    if (hh && hh.classList.contains('on')) { this.set('hub'); break; }
                    this.set('title');
                    // survivor title → happy hour: the page's own button; fall back to hhOpen()
                    const btn = d.querySelector('button.imgbtn[onclick*="goHappyHour"], [onclick*="goHappyHour"]');
                    if (btn && this.age() > 300) { input.click(btn); this.since = now(); }
                    else if (!btn && typeof W.hhOpen === 'function' && this.age() > 1500) { safe(() => W.hhOpen()); this.since = now(); }
                    break;
                }
                case 'hub': {
                    if (!this.hubReady()) { if (this.age() > 15000) { this.set('idle'); } break; }
                    if (this.age() < 250) break;
                    const name = this.nextGame();
                    if (!name) { log('nothing left to play — stopping'); this.stop(); break; }
                    const card = [...d.querySelectorAll('#hh_sbwrap2 .gcard')].find(c => { const n = c.querySelector('.gname'); return n && n.textContent.trim() === name; });
                    if (!card) { warn('no card for', name); this.since = now(); break; }
                    this.beginGame(name);
                    input.click(card);
                    this.set('howto');
                    break;
                }
                case 'howto': {
                    const ht = input.el('hh_howto');
                    if (ht && !ht.classList.contains('hidden')) {
                        if (this.age() >= config.howtoWaitMs) { hooks.lastT = 0; input.down(ht); this.set('game'); }
                    } else if (this.age() > 8000) { warn('how-to screen never came'); this.endGame(); this.set('hub'); }
                    break;
                }
                case 'game': {
                    const rr = input.el('hh_roundResult');
                    if (rr && !rr.classList.contains('hidden')) { this.set('result'); break; }
                    if (this.game && this.game.driver && this.game.driver.tick) this.game.driver.tick();
                    if (!input.visible(input.el('hh_game')) && this.age() > 3000) { warn('game screen gone'); this.endGame(); this.set('hub'); }
                    if (this.age() > 20 * 60000) { warn('game timeout'); this.endGame(); this.set('hub'); }
                    break;
                }
                case 'result': {
                    if (this.age() < config.resultWaitMs) break;
                    const txt = (input.el('hh_rrRate') || {}).textContent || '';
                    this.finishGame(txt.trim());
                    // never a name, never SUBMIT: only OK
                    const ok = input.el('hh_rrDone');
                    if (ok) input.click(ok);
                    this.set('hub');
                    break;
                }
                case 'stopped': break;
            }
        } catch (e) { this.err = String(e && e.message || e); warn('tick', e); }
    },
    beginGame(name) {
        const spec = drivers[name];
        const params = spec.tunables ? tune.pick(name, spec.tunables) : {};
        const g = learn.game(name);
        const ctx = { name, params, cal: g.cal, learn: g, target: targetFor(name), board: board.top[name] || null, frames: 0, t0: 0, log: (...a) => log(name + ':', ...a) };
        this.game = { name, params, ctx, driver: spec.make(ctx), t0: now(), frames: 0 };
        log('playing', name, 'target', ctx.target.v, '(' + ctx.target.why + ')', 'params', JSON.stringify(params));
    },
    frame(f) {
        const g = this.game;
        if (!g || this.state !== 'game') return;
        g.frames++; g.ctx.frames++;
        if (!g.ctx.t0) g.ctx.t0 = f.t;
        this.lastFrameAt = now();
        try { g.driver.frame(f); } catch (e) { this.err = String(e && e.message || e); if (config.verbose) warn('driver', e); }
    },
    finishGame(txt) {
        const g = this.game;
        if (!g) return;
        const m = rankMetric(txt);
        const nb = learn.record(g.name, txt, g.params);
        if (g.driver.result) safe(() => g.driver.result(m, txt));
        const spec = drivers[g.name];
        if (spec.tunables && m) tune.report(g.name, g.params, m.low ? -m.v : m.v);
        const rec = { name: g.name, txt, v: m ? m.v : null, at: Date.now(), best: nb, frames: g.frames, ms: Math.round(now() - g.t0) };
        this.results.push(rec);
        if (this.results.length > 300) this.results.splice(0, this.results.length - 300);
        store.set('results', this.results);
        this.played++;
        const top = board.top[g.name];
        log('result', g.name, '→', txt, nb ? '(new best)' : '', top ? ('board #1: ' + top.txt) : '');
        this.endGame();
    },
    endGame() {
        const g = this.game;
        if (g && g.driver && g.driver.stop) safe(() => g.driver.stop());
        this.game = null;
    }
};


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
                    input.up(c, 200, 300);
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
        let play = false, target = null, lastA = null, phase = 'spin', served = false, mism = 0, dtLast = 1 / 60, frames = 0;
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
                const nowRect = F.rect(90, 22, 100, 30), tgtRect = F.rect(210, 22, 100, 30);
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
                if (phase === 'spin') {
                    if (!s.dragging) { const ev = input.down(c, 310, 272, c); s.dragging = true; lastA = angleOf(c, ev); }
                    // keep ω pinned at 14 with one small move per frame, then decide whether to let go
                    moveTo(c, lastA + 0.6);
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
                        input.down(input.el('hh_stServe'));
                        ctx.log('served at', s.temp.toFixed(4), 'target', target, 'model mismatches', mism);
                        learn.ema(ctx.name, 'mismatches', mism, 0.3);
                    }
                }
            }
        };
    }
});

// ---------------------------------------------------------------- ICE CARVING
// Each TAP adds 5.25 to a gauge that decays 38/s; DONE at ≥88 = +1 ball,
// below = shatter (600 ms stun). The gauge is drawn as a fill rect at x=354,
// so it is read back exactly. 17 taps + DONE inside one frame = one ball
// per frame; the driver paces balls to reach its target across the 15 s.
defineDriver('ICE CARVING', {
    kind: 'unbounded', defaultTarget: 60,
    make(ctx) {
        let count = 0, armedAt = 0, stunUntil = 0;
        const maxPerFrame = 6;
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
                const due = Math.min(target, Math.ceil(target * (elapsed + 0.4) / 15));   // pace with a little slack
                let todo = Math.max(0, due - count);
                if (left < 1.0) todo = Math.max(0, target - count);                      // finish early rather than late
                todo = Math.min(todo, maxPerFrame);
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

defineDriver('CHAMPAGNE LAUNCH', {
    kind: 'unbounded', defaultTarget: 300,
    make(ctx) {
        const m = { worldX: 0, vel: 0, power: 0, angle: 12, hold: false, fired: false, launchX: 0, R: 0, pFire: 0 };
        let run = false, dtAvg = 1 / 60, planned = null;
        const HOLD_AT = 2200 - 118;   // vel 460 brakes to 0 in 75.6 px; leaves ~40 px before the wall
        const plan = () => {
            const k = ctx.cal.flightK || 1;
            const wantPx = (ctx.target.v + 2) * 40 + 2200 - (HOLD_AT + 75 + 47);   // cork travel needed from launchX
            let lo = 20, hi = 1e7;
            for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); if (clFlight(mid, 45, dtAvg) * k < wantPx) lo = mid; else hi = mid; }
            const R = hi, pFire = R / (1.6 * 40);     // sin(90°)^2.2 = 1
            const holdFrames = Math.ceil((45 - 12) / (62 * dtAvg));
            return { R, pFire, holdFrames, pHold: pFire / Math.pow(1 - 0.55 * dtAvg, holdFrames) + 0.3 * dtAvg * holdFrames };
        };
        return {
            frame(F) {
                const bT = input.el('hh_clTap'), bG = input.el('hh_clGo');
                if (!bT || !bG || m.fired) return;
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
                if (!m.hold) {
                    if (m.worldX >= HOLD_AT) {
                        input.down(bG); m.hold = true;
                    } else {
                        // tap enough that, were the hold to start now, power at 45° would be pFire
                        const need = planned.pHold - m.power;
                        const taps = Math.min(400, Math.max(0, Math.ceil(need / 2.8)));
                        for (let i = 0; i < taps; i++) { input.down(bT); m.power += 2.8; m.vel = Math.min(460, m.vel + 62); }
                        if (taps === 0 && m.vel < 400) { input.down(bT); m.power += 2.8; m.vel = Math.min(460, m.vel + 62); }
                    }
                } else {
                    // release on the frame nearest 45°
                    const next = Math.min(88, m.angle + dtAvg * 62);
                    if (Math.abs(m.angle - 45) <= Math.abs(next - 45) || m.angle >= 45) {
                        m.fired = true; m.launchX = m.worldX + 47; m.pFire = m.power;
                        const th = m.angle * Math.PI / 180;
                        m.R = Math.max(20, m.power * 1.6 * Math.pow(Math.max(0, Math.sin(2 * th)), 2.2)) * 40;
                        input.up(bG);
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
                    if (b && F.has('PRESS START')) { input.click(b); started = true; ctx.log('start'); }
                    return;
                }
                if (!ch && hooks.motion) { ch = new MessageChannel(); ch.port1.onmessage = pump; ch.port2.postMessage(0); }
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
                input.down(ok);
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
                if (round >= ctx.target.v) {
                    const wrong = (seq[0] + 1) % 10;
                    const p = OU_BTN(wrong); input.down(c, p.x, p.y, c); failed = true;
                    ctx.log('KO on purpose at round', round, '(target', ctx.target.v + ')');
                    return;
                }
                for (const i of seq) { const p = OU_BTN(i); input.down(c, p.x, p.y, c); }
            }
        };
    }
});


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
// wander or stand. Every frame a receding-horizon search over three-segment
// key plans (9³ actions, 21 frames) picks the move that reaches the table
// soonest. Touching a guest costs a glass but grants 1.5 s of invulnerability,
// and every cleared stage gives a glass back — so the planner spends one hit
// per stage (keeping two glasses in reserve) as free passage through the crowd.
const TR_ACTS = []; for (let iy = -1; iy <= 1; iy++) for (let ix = -1; ix <= 1; ix++) TR_ACTS.push([ix, iy]);
defineDriver('TABLE RUSH', {
    kind: 'unbounded', defaultTarget: 15,
    tunables: { safety: { min: 1, max: 9, step: 2, init: 5, explore: 0.2 } },
    make(ctx) {
        let stage = 0, me = { x: 200, y: 424 }, prevMobs = [], invUntil = 0, glasses = 3, keysDown = {}, act = [0, 0], lastAct = null, lastMe = null, dying = false, hitsThisStage = 0;
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
                if (lv !== stage) { stage = lv; prevMobs = []; me = { x: 200, y: 424 }; invUntil = t + 1000 - dt * 1000; lastMe = null; hitsThisStage = 0; if (config.verbose) ctx.log('stage', lv, 'glasses', glasses, 'at', ((t - ctx.t0) / 1000).toFixed(1) + 's'); }
                // glasses HUD: arcs at y=25, gold = alive
                const arcs = F.arcs.filter(o => Math.abs(o.y - 25) < 0.6 && Math.abs(o.r - 7) < 0.6);
                if (arcs.length === 3) {
                    const alive = arcs.filter(o => /e6b450/i.test(o.fs)).length;
                    if (alive < glasses) { invUntil = Math.max(invUntil, t + 1500 - dt * 1000); hitsThisStage++; if (config.verbose) ctx.log('hit at stage', lv, 'glasses', alive, 'me', me.x.toFixed(0), me.y.toFixed(0)); }
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
                const invLeft0 = Math.max(0, (invUntil - t) / 1000);
                // a hit costs one glass but buys 1.5 s of walking through the crowd; every
                // cleared stage gives one glass back, so glasses-1 hits per stage are free
                const budget0 = dying ? 0 : Math.max(0, glasses - 2 - hitsThisStage);   // never spend the last-but-one glass
                // three segments of 7 frames over the 9 actions; mob positions precomputed per step
                const SEG = 7, NSEG = 3, H = SEG * NSEG, spd = 118 * dt;
                const mx = [], my = [];
                for (let k = 1; k <= H; k++) { const ax = [], ay = []; for (const m of mobs) { ax.push(m.x + m.vx * dt * k); ay.push(m.y + m.vy * dt * k); } mx.push(ax); my.push(ay); }
                let best = null;
                const sim = (acts) => {
                    let x = me.x, y = me.y, cost = 0, inv = invLeft0, budget = budget0, hits = 0;
                    for (let k = 1; k <= H; k++) {
                        const ac = acts[Math.floor((k - 1) / SEG)];
                        x = clamp(x + ac[0] * spd, 20, 380); y = clamp(y + ac[1] * spd, 78, 434);
                        if (inv > 0) inv -= dt;
                        else {
                            const px = mx[k - 1], py = my[k - 1];
                            for (let i = 0; i < px.length; i++) {
                                const ddx = px[i] - x, ddy = py[i] - y;
                                if (ddx * ddx + ddy * ddy < R * R) {
                                    hits++;
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
                lastAct = act;
            },
            stop() { setKeys([0, 0]); },
            result(m) { setKeys([0, 0]); ctx.log('stage', m && m.v, 'target', ctx.target.v); }
        };
    }
});


/* =====================================================================
 * 06 — panel, public API, boot
 * ===================================================================== */
const panel = {
    el: null, last: '',
    mount() {
        if (this.el || !config.panel || !W.document || !W.document.body) return;
        const d = W.document, el = d.createElement('div');
        el.id = 'pineMiniPanel';
        el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:rgba(10,12,10,.88);color:#e8e6dd;font:11px/1.5 monospace;padding:8px 10px;border:1px solid #3a7d4f;border-radius:6px;max-width:330px;pointer-events:auto;white-space:pre-wrap';
        el.addEventListener('pointerdown', e => e.stopPropagation());
        el.innerHTML = '<div id="pmTxt"></div><div style="margin-top:6px"><button id="pmToggle">pause</button> <button id="pmSkip">skip</button> <button id="pmBoard">board</button> <button id="pmHide">hide</button></div>';
        d.body.appendChild(el);
        this.el = el;
        el.querySelector('#pmToggle').onclick = () => { if (flow.timer) { flow.stop(); } else { flow.start(); } this.render(); };
        el.querySelector('#pmSkip').onclick = () => api.skip();
        el.querySelector('#pmBoard').onclick = () => board.refresh().then(() => this.render());
        el.querySelector('#pmHide').onclick = () => { el.style.display = 'none'; };
        // Ctrl+Shift+P shows it again
        d.addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') el.style.display = ''; });
    },
    render() {
        if (!this.el) return;
        const g = flow.game;
        const lines = ['PineMini v' + SCRIPT_VERSION + '  ' + (flow.timer ? flow.state : 'PAUSED') + (g ? '  ' + g.name + ' (' + g.frames + 'f)' : '')];
        const last = flow.results[flow.results.length - 1];
        if (last) lines.push('last: ' + last.name + ' → ' + last.txt + (last.best ? ' ★' : ''));
        for (const n of config.games) {
            const L = learn.game(n), top = board.top[n];
            if (!L.plays && !top) continue;
            lines.push((L.plays ? L.plays + '× ' : '   ') + n.padEnd(17) + (L.best ? L.best.txt : '-').padEnd(16) + (top ? ' #1 ' + top.txt : '') + (beaten(n) ? ' ✓' : ''));
        }
        if (flow.err) lines.push('err: ' + flow.err);
        const txt = lines.join('\n');
        if (txt !== this.last) { this.last = txt; this.el.querySelector('#pmTxt').textContent = txt; }
    }
};

const api = {
    version: SCRIPT_VERSION,
    config, learn, board, flow, drivers, hooks, input,
    start() { flow.start(); return 'started'; },
    stop() { flow.stop(); return 'stopped'; },
    skip() { if (flow.game) { log('skipping', flow.game.name); flow.endGame(); } const ok = input.el('hh_rrDone'); const bb = input.el('hh_backBtn'); if (ok && input.visible(input.el('hh_roundResult'))) input.click(ok); else if (bb && !bb.classList.contains('hidden')) input.click(bb); flow.set('hub'); return 'skipped'; },
    play(name) { name = String(name || '').toUpperCase(); if (!drivers[name]) return 'unknown game: ' + name; flow.queue.unshift(name); if (!flow.timer) flow.start(); return 'queued ' + name; },
    set(k, v) { config[k] = v; store.set('config', Object.assign(store.get('config', {}), { [k]: v })); return config; },
    status() {
        const g = flow.game;
        return { state: flow.state, game: g && g.name, frames: g && g.frames, played: flow.played, err: flow.err, results: flow.results.slice(-5).map(r => r.name + ' ' + r.txt) };
    },
    results() { return flow.results.slice(); },
    best() { const o = {}; for (const n of GAME_NAMES) { const L = learn.game(n); o[n] = { best: L.best && L.best.txt, plays: L.plays, board: board.top[n] && board.top[n].txt, target: targetFor(n), beaten: beaten(n) }; } return o; },
    reset(name) { learn.reset(name); flow.results = []; store.del('results'); return 'reset'; },
    frame: null,     // the most recent frame (debugging)
    rankMetric, targetFor, beaten, wantsPlay, tune, pourTailModel, pourMlFromSurface, FP_GLASS, stStep, stBottom, stTempColor, stTempRGB, clFlight, clPowerDecay, OU_BTN, Frame, publishFrame
};
W.pineMini = api;

// keep the latest frame around for debugging without holding drivers up
const _onFrame = f => { api.frame = f; };

function boot() {
    const d = W.document;
    if (!d) return;
    log('v' + SCRIPT_VERSION, 'loaded; auto =', config.auto);
    const onReady = () => {
        panel.mount();
        setInterval(() => panel.render(), 500);
        if (config.auto) flow.start();
        else hooks.onFrame = _onFrame;
        const _f = hooks.onFrame; hooks.onFrame = f => { api.frame = f; if (_f && _f !== _onFrame) _f(f); };
        // refresh the board every 10 minutes
        if (config.board) setInterval(() => board.refresh(), 600000);
    };
    if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', onReady);
    else onReady();
}
boot();

})();
