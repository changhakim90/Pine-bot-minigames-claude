// ==UserScript==
// @name         Pine & Co Minigame Bot
// @namespace    https://pineandco.online/
// @version      0.5.4
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
const SCRIPT_VERSION = '0.5.4';
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
    howtoWaitMs: 1200,      // minimum time on the HOW TO PLAY screen
    howtoMaxMs: 30000,      // ...and the longest to wait there for the game's artwork
    stallFrames: 3600,      // frames a driver may go without acting before the round is abandoned (~1 min)
    targets: {},            // per-game target override, e.g. {'ORDER UP!': 60}
    resultWaitMs: 900,      // read the result screen this long before pressing OK
    max: true,              // unbounded games play for the most the round allows (below); false = board #1 + margin
    roundBudgetMin: 12,     // max mode: minutes an endless round may run before the driver ends it on purpose
    margin: 0.10,           // (max: false) unbounded games aim this far above the board's #1 (fraction)
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
    listeners: [],      // {type, fn, target}
    dtMean: 1 / 60,     // rolling mean of the dt the engines compute
    dtCapped: 0         // fraction of frames at the engines' 0.05 cap (page-speed extensions pin it there)
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
                        // Offscreen keying canvases inherit the name of what is copied into them.
                        // fpKey() draws the <img> into one canvas, then — whenever the image is
                        // wider than the game's maxW — copies THAT canvas into a smaller one, so
                        // the name has to survive canvas→canvas draws too or every keyed sprite
                        // (ws_cover, fs_fly1, ou_ck3, tc_jar…) reaches us nameless.
                        const im = arguments[0];
                        if (im) {
                            if (im.tagName === 'IMG') cv.__pmSrc = imgName(im);
                            else if (im.__pmSrc) cv.__pmSrc = im.__pmSrc;
                        }
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
            // extents along the SCREEN axes (a sprite drawn after rotate(-90°) is as wide on
            // screen as its dh) — Glass Stack rotates some pieces, Table Rush every guest
            const w = Math.abs(dw * m.a) + Math.abs(dh * m.c), h = Math.abs(dw * m.b) + Math.abs(dh * m.d);
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
    if (f.dt > 0.0005) {
        hooks.dtMean += (f.dt - hooks.dtMean) * 0.02;
        hooks.dtCapped += ((f.dt >= 0.0499 ? 1 : 0) - hooks.dtCapped) * 0.02;
    }
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

// ---------------------------------------------------------------- assets
// The game downloads a mini game's artwork only when its card is picked, while
// the HOW TO PLAY panel is up. A driver that reads sprites therefore has to
// start AFTER they exist — the more so with a page-speed extension, where the
// bot's own waits are compressed but the network is not. These are the files
// each game's loader asks for (from the game's source); the bot warms the very
// same URLs and starts the round once they have settled.
const ASSETS = {
    'BLIND POUR': ['fp_bg', 'fp_bottle', 'fp_logo', 'fp_shot', 'fp_jigger', 'fp_rocks'],
    'STIR STOP': ['st_glass', 'st_ice1', 'st_ice2', 'st_top', 'st_spoon', 'st_logo'],
    'ICE CARVING': ['ic_ice', 'ic_pick', 'ic_broke', 'ic_logo'],
    'CHAMPAGNE LAUNCH': ['cl_run1', 'cl_run2', 'cl_run3', 'cl_run4', 'cl_run5', 'cl_skid', 'cl_cork', 'cl_logo'],
    'SHAKE MASTER': ['sm_ice1', 'sm_ice2', 'sm_ice3', 'sm_cap1', 'sm_cap2', 'sm_closed', 'sm_logo'],
    'QUICK TAB': ['qt_receipt', 'qt_logo', 'qt_cust1', 'qt_cust2', 'qt_cust3', 'qt_cust4', 'qt_cust5', 'qt_cust6', 'qt_cust7'],
    'ORDER UP!': ['ou_pos', 'ou_logo'].concat(Array.from({ length: 10 }, (_, i) => 'ou_ck' + i), Array.from({ length: 8 }, (_, i) => 'ou_cu' + (i + 1))),
    'WHERE IS MY SHOT?': ['ws_cover', 'ws_shot', 'ws_logo'],
    'FRESH SQUEEZE': ['sq_basket', 'sq_board', 'sq_closed', 'sq_cup', 'sq_half', 'sq_lime', 'sq_logo', 'sq_open', 'sq_spent', 'sq_trash'],
    'TIP CATCH': ['tc_jar', 'tc_receipt', 'tc_env', 'tc_cap', 'tc_logo', 'bill_10000', 'bill_50000', 'coin_gold', 'bottle_whiskey', 'bottle_gin', 'bottle_rum'],
    'FLY SWAT': ['fs_logo', 'fs_bigfly', 'fs_fly1', 'fs_fly2', 'fs_basket', 'fs_basket2', 'fs_basket3'],
    'GLASS STACK': ['gs_tray', 'gs_hand', 'gs_logo', 'gs_plate1', 'gs_plate1b', 'gs_plate1c', 'gs_plate2', 'gs_plate2b', 'gs_plate2c', 'gs_wine', 'gs_wineb', 'gs_coupe', 'gs_coupeb', 'gs_shot', 'gs_shotb', 'gs_rocks', 'gs_highball', 'gs_martini', 'gs_pick'],
    'TABLE RUSH': ['dg_waiter', 'dg_cust1', 'dg_cust2', 'dg_cust3', 'dg_cust4', 'dg_cust5', 'dg_cust6', 'dg_floor', 'dg_bar', 'dg_table', 'dg_glass1', 'dg_glass2', 'dg_glass3', 'dg_logo']
};
const preload = {
    game: null, total: 0, done: 0, started: 0, imgs: [],
    start(name) {
        this.game = name; this.done = 0; this.imgs = []; this.started = now();
        const list = ASSETS[name] || [];
        this.total = list.length;
        for (const k of list) {
            const im = new Image();
            const settle = () => { this.done++; };
            im.onload = settle; im.onerror = settle;
            im.src = 'assets/' + k + '.png';
            this.imgs.push(im);
        }
    },
    // ready when every request has settled (loaded or 404'd) — a real network event,
    // so a page-speed extension cannot fast-forward past it
    ready() { return !this.total || this.done >= this.total; }
};

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
        const forced = (config.targets && config.targets[name]) || (config.e2eTargets && config.e2eTargets[name]);
        if (forced) return { v: forced, low: false, why: 'set' };
        // max mode: no number to stop at — the round runs to the game's end or the time budget
        if (config.max) return { v: spec.maxTarget == null ? Infinity : spec.maxTarget, low: false, why: 'max' };
        let v = spec.defaultTarget || 10;
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
// did one of the last three plays set the best?
function improving(g) {
    const h = g.hist.slice(-3);
    return !!g.best && h.some(e => e.at === g.best.at);
}
// does this game deserve another play right now?
function wantsPlay(name) {
    const g = learn.game(name), spec = drivers[name] || {};
    if (!drivers[name]) return false;
    if (!g.plays) return true;
    if (spec.kind === 'precision') return !beaten(name) && g.plays < (spec.maxPlays || 400);
    if (spec.kind === 'unbounded') return !beaten(name) && !(config.max && g.plays >= (spec.maxPlays || 3) && !improving(g));
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
    paused: false,       // frozen in place: no ticking, no input, but the round is kept
    pausedAt: 0,
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
    // freeze without abandoning the round; timers are shifted on resume so a paused
    // stretch does not count against how-to / result waits
    pause() { if (!this.timer || this.paused) return; this.paused = true; this.pausedAt = now(); log('paused'); },
    resume() { if (!this.paused) { if (!this.timer) this.start(); return; } const d = now() - this.pausedAt; this.since += d; if (this.game) this.game.t0 += d; this.paused = false; log('resumed'); },
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
        if (!d || !d.body || this.paused) return;
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
                    preload.start(name);
                    input.click(card);
                    this.set('howto');
                    break;
                }
                case 'howto': {
                    const ht = input.el('hh_howto');
                    if (ht && !ht.classList.contains('hidden')) {
                        // start only once the artwork has arrived: the drivers read sprites, and
                        // the game itself draws crude fallbacks (rects/discs) until the art lands
                        const waited = this.age() >= config.howtoWaitMs;
                        if (waited && (preload.ready() || this.age() >= config.howtoMaxMs)) {
                            if (!preload.ready()) warn('starting with ' + (preload.total - preload.done) + '/' + preload.total + ' assets still loading');
                            hooks.lastT = 0; input.down(ht); this.set('game');
                        }
                    } else if (this.age() > 30000) { warn('how-to screen never came'); this.endGame(); this.set('hub'); }
                    break;
                }
                case 'game': {
                    const rr = input.el('hh_roundResult');
                    if (rr && !rr.classList.contains('hidden')) { this.set('result'); break; }
                    if (this.game && this.game.driver && this.game.driver.tick) this.game.driver.tick();
                    if (!input.visible(input.el('hh_game')) && this.age() > 3000) { warn('game screen gone'); this.endGame(); this.set('hub'); }
                    // Where Is My Shot, Glass Stack, Order Up and Table Rush have no clock: they
                    // wait for input forever. If a driver has gone this many frames without acting,
                    // it is stuck (missing artwork, an unexpected screen) — leave rather than hang.
                    if (this.game && this.game.frames - this.game.aliveAt > config.stallFrames) {
                        warn(this.game.name + ': no action for ' + config.stallFrames + ' frames — leaving the round');
                        this.leaveGame();
                    }
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
        const ctx = { name, params, cal: g.cal, learn: g, target: targetFor(name), board: board.top[name] || null, frames: 0, t0: 0, acted: () => { }, log: (...a) => log(name + ':', ...a) };
        // acted(): made progress (dispatched input). alive(): recognised my screen this frame,
        // even with nothing to do. The stall watchdog uses liveness — a quiet Tip Catch frame or
        // a Where Is My Shot shuffle is not a stall; only a driver that cannot find its screen is.
        ctx.acted = () => { if (this.game) { this.game.actedAt = this.game.frames; this.game.aliveAt = this.game.frames; } };
        ctx.alive = () => { if (this.game) this.game.aliveAt = this.game.frames; };
        // max mode: endless rounds get a wall-clock budget; drivers that can end a round on
        // purpose (Order Up, Where Is My Shot, Glass Stack) do so once it runs out
        ctx.budgetMs = config.max && !isFinite(ctx.target.v) ? config.roundBudgetMin * 60000 : Infinity;
        ctx.overBudget = () => now() - this.game.t0 > ctx.budgetMs;
        this.game = { name, params, ctx, driver: spec.make(ctx), t0: now(), frames: 0, actedAt: 0, aliveAt: 0 };
        log('playing', name, 'target', isFinite(ctx.target.v) ? ctx.target.v : 'max', '(' + ctx.target.why + ')', 'params', JSON.stringify(params));
    },
    frame(f) {
        const g = this.game;
        if (!g || this.state !== 'game' || this.paused) return;
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
        const rec = { name: g.name, txt, v: m ? m.v : null, at: Date.now(), best: nb, frames: g.frames, ms: Math.round(now() - g.t0), dt: +hooks.dtMean.toFixed(4), fast: hooks.dtCapped > 0.5 };
        this.results.push(rec);
        if (this.results.length > 300) this.results.splice(0, this.results.length - 300);
        store.set('results', this.results);
        this.played++;
        const top = board.top[g.name];
        log('result', g.name, '→', txt, nb ? '(new best)' : '', top ? ('board #1: ' + top.txt) : '');
        this.endGame();
    },
    // give up on a round that cannot be played (nothing to click) and go back to the hub
    leaveGame() {
        this.endGame();
        const bb = input.el('hh_backBtn');
        if (bb && !bb.classList.contains('hidden')) input.click(bb);
        this.set('hub');
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
                ctx.alive();                    // the pause between pours is not a stall
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
        let dragging = false, lastA = null, phase = 'spin', served = false, target = null, frames = 0, spinFrames = 0, warned = false, waitingFor = 'play', lastT = null;
        const angleOf = (c, ev) => { const p = input.gameXY(c, ev); return Math.atan2(p.y - 272, p.x - 200); };
        const wrapD = d2 => { while (d2 > Math.PI) d2 -= 6.283; while (d2 < -Math.PI) d2 += 6.283; return d2; };
        const moveTo = (c, ang) => { input.move(c, 200 + Math.cos(ang) * 110, 272 + Math.sin(ang) * 110, c); };
        // observed temperature: the °C text while it is shown (temp > 5), else inverted from the
        // NOW colour chip (the game's own drawn colour — ~0.03 °C resolution). This is the value
        // the game judges on, so serving by it is correct however fast the drink actually cools.
        const obsTemp = (F, nowRect) => {
            const tt = F.text(/^(-?\d+\.\d\d)°C$/);
            if (tt) return +tt.m[1];
            const rgb = F.rgb(nowRect.fs);
            if (!rgb) return null;
            return rgb[2] >= 254 ? -(210 - rgb[0]) / 140 * 8 : 20 - (236 - rgb[0]) / 26 * 20;
        };
        const ST_TARGETS = []; for (let i = 15; i <= 40; i++) ST_TARGETS.push(-i / 10);
        return {
            frame(F) {
                const c = cv();
                if (!c || served) return;
                const chips = F.rects.filter(o => Math.abs(o.w - 100) < 2 && Math.abs(o.h - 30) < 2 && Math.abs(o.y - 22) < 4);
                const nowRect = chips.find(o => Math.abs(o.x - 90) < 4), tgtRect = chips.find(o => Math.abs(o.x - 210) < 4);
                if (!nowRect || !tgtRect) { waitingFor = 'colour chips (play state)'; return; }
                ctx.alive(); waitingFor = ''; frames++;
                if (target == null) {
                    const tr = F.rgb(tgtRect.fs);
                    const hit = ST_TARGETS.find(tp => { const g = stTempRGB(tp); return g[0] === tr[0] && g[1] === tr[1] && g[2] === tr[2]; });
                    target = hit != null ? hit : 20 - (236 - tr[0]) / 26 * 20;
                    ctx.log('target', target.toFixed(2) + '°C');
                }
                const T = obsTemp(F, nowRect);
                if (T == null) return;
                if (phase === 'spin') {
                    if (!dragging) { const ev = input.down(c, 310, 272, c); dragging = true; lastA = angleOf(c, ev); spinFrames = 0; }
                    moveTo(c, (lastA == null ? 0 : lastA) + 0.6); lastA = (lastA == null ? 0 : lastA) + 0.6;
                    spinFrames++;
                    if (spinFrames * F.dt > 2.5 && T > 18 && !warned) { warned = true; waitingFor = 'stir input is not cooling the drink'; ctx.log(waitingFor); }
                    // stop stirring once the drawn temperature has reached the target; residual
                    // cooling then carries it a touch below, and it warms back — we serve on the way up
                    if (T <= target) { input.up(c, 310, 272, c); dragging = false; lastA = null; phase = 'settle'; ctx.log('released at', T.toFixed(2)); }
                } else {
                    // serve when the warming drink is at/just past the target (closest achievable);
                    // if it is still falling below target, wait for the turn
                    const rising = lastT != null && T > lastT + 1e-4;
                    if (T >= target - 0.03 && (rising || T >= target)) {
                        served = true; input.down(input.el('hh_stServe')); ctx.acted();
                        ctx.log('served at', T.toFixed(3), 'target', target);
                    }
                }
                lastT = T;
            },
            state() { return { phase, target, obsTemp: lastT == null ? null : +lastT.toFixed(3), dragging, served, spinFrames, waitingFor, frames }; }
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
                ctx.alive();
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
                ctx.alive();
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
                if (!F.text(/^BILL \d\/7$/, { x: 12, y: 30, d: 6 }) && !timer) return;
                ctx.alive();
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
                ctx.alive();                    // showing / memorising the order is not a stall
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
        let ended = false, tapped = 0, tapLevel = -1, seenLevel = 0, sinceTap = 0, lastX = 0, lastWant = 0, lastLean = 0;
        return {
            frame(F) {
                const c = input.el('hh_gscv');
                if (!c || ended) return;
                const lv = F.text(/^(\d+)$/, { x: 200, y: 42, d: 9 });     // level counter (canvas may shake a few px)
                if (!lv) return;
                const level = +lv.m[1];
                // pieces by sprite name; the game falls back to fillRect when a sprite is missing
                let pieces = F.imgs.filter(o => /^gs_/.test(o.src) && !/^gs_(tray|hand|logo)$/.test(o.src)).map(o => ({ cx: o.cx, w: o.w }));
                if (!pieces.length) { pieces = F.rects.filter(o => o.w > 12 && o.w <= 205 && o.h > 6 && o.h < 200 && o.y > 100).map(o => ({ cx: o.x + o.w / 2, w: o.w })); if (pieces.length) pieces.shift(); }
                if (!pieces.length) return;
                ctx.alive();
                const cur = pieces[pieces.length - 1];
                const top = pieces.length > 1 ? pieces[pieces.length - 2] : null;
                const topX = top ? top.cx : 200, topW = top ? top.w : 200;
                // once per placed level; if a tap somehow did not register, retry after ~1.2 s
                if (level !== seenLevel) { seenLevel = level; sinceTap = 0; }
                if (tapLevel === level) { sinceTap += (F.dt > 0.0005 ? F.dt : 0.0042); if (sinceTap > 1.2) tapLevel = -1; return; }
                const bal = F.rects.find(o => Math.abs(o.x - 200) < 1 && Math.abs(o.y - 74) < 1 && Math.abs(o.h - 8) < 1);
                const lean = bal ? bal.w : 0;
                const x = cur.cx, want = topX + clamp(-lean / 0.78, -6, 6);
                lastX = x; lastWant = want; lastLean = lean;
                const target = ctx.target.v;
                if ((isFinite(target) && level >= target) || safe(() => ctx.overBudget(), false)) {
                    // deliberate finish (a pinned target): tap when the overlap is too small to hold
                    const w = cur.w, need = Math.min(w, topW) * 0.30;
                    const over = Math.min(x + w / 2, topX + topW / 2) - Math.max(x - w / 2, topX - topW / 2);
                    if (over < need - 1) { input.down(c, 200, 240, c); ctx.acted(); tapLevel = level; ended = true; ctx.log('slid off on purpose at', level); }
                    return;
                }
                // Stateless placement: the piece swings through `want` every pass and spawns
                // right over it, so tap whenever it is within one frame-step of `want`. No
                // frame-to-frame state to desync — a missing HUD frame or a canvas shake cannot
                // stall it (which is what left it frozen at a level on the live build).
                const amp = Math.min(150, 80 + level * 3.5), sp = 1.03 + level * 0.06;
                const step = Math.max(2, (F.dt > 0.0005 ? F.dt : 0.05) * amp * sp);
                if (Math.abs(x - want) <= step * 0.6 + 1.2) {
                    input.down(c, 200, 240, c); ctx.acted(); tapped++; tapLevel = level; sinceTap = 0;
                    if (config.verbose) ctx.log('placed level', level, 'dx', (x - topX).toFixed(2), 'lean', lean.toFixed(1));
                }
            },
            result(m) { ctx.log('stacked', m && m.v, 'taps', tapped, 'target', isFinite(ctx.target.v) ? ctx.target.v : 'max'); },
            state() { return { level: seenLevel, tapped, tapLevel, curX: Math.round(lastX), want: Math.round(lastWant), dx: Math.round(lastX - lastWant), lean: +lastLean.toFixed(1), over: safe(() => ctx.overBudget(), null), targetInf: !isFinite(ctx.target.v) }; }
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
        el.innerHTML = '<div id="pmBody"><div id="pmTxt"></div><div style="margin-top:6px"><button id="pmPause">pause</button> <button id="pmResume">resume</button> <button id="pmSkip">skip</button> <button id="pmBoard">board</button> <button id="pmHide">hide</button></div></div>'
            + '<button id="pmShow" hidden style="all:unset;cursor:pointer;padding:2px 6px;color:#e6b450;font:11px monospace">▸ PineMini</button>';
        d.body.appendChild(el);
        this.el = el;
        // two explicit, idempotent buttons: pause always pauses, resume always resumes
        // (and starts the bot if it was stopped). pressing either again is harmless.
        this.pauseBtn = el.querySelector('#pmPause');
        this.resumeBtn = el.querySelector('#pmResume');
        this.pauseBtn.onclick = () => { api.pause(); this.render(); };
        this.resumeBtn.onclick = () => { api.resume(); this.render(); };
        el.querySelector('#pmSkip').onclick = () => api.skip();
        el.querySelector('#pmBoard').onclick = () => board.refresh().then(() => this.render());
        // hide collapses to a chip that brings it back — never to nothing
        const body = el.querySelector('#pmBody'), show = el.querySelector('#pmShow');
        const collapse = (v) => { body.hidden = v; show.hidden = !v; el.style.padding = v ? '2px 4px' : '8px 10px'; };
        el.querySelector('#pmHide').onclick = () => collapse(true);
        show.onclick = () => collapse(false);
        this.collapse = collapse;
        // Ctrl+Shift+P toggles it too
        d.addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') collapse(!body.hidden); });
    },
    render() {
        if (!this.el || this.el.querySelector('#pmBody').hidden) return;
        const running = flow.timer && !flow.paused;
        if (this.pauseBtn) { this.pauseBtn.disabled = !running; this.pauseBtn.textContent = flow.paused ? 'paused' : 'pause'; }
        if (this.resumeBtn) this.resumeBtn.disabled = running;
        const g = flow.game;
        const lines = ['PineMini v' + SCRIPT_VERSION + '  ' + (!flow.timer ? 'STOPPED' : flow.paused ? 'PAUSED' : flow.state) + (g ? '  ' + g.name + ' (' + g.frames + 'f)' : '')];
        const last = flow.results[flow.results.length - 1];
        if (last) lines.push('last: ' + last.name + ' → ' + last.txt + (last.best ? ' ★' : ''));
        for (const n of config.games) {
            const L = learn.game(n), top = board.top[n];
            if (!L.plays && !top) continue;
            lines.push((L.plays ? L.plays + '× ' : '   ') + n.padEnd(17) + (L.best ? L.best.txt : '-').padEnd(16) + (top ? ' #1 ' + top.txt : '') + (beaten(n) ? ' ✓' : ''));
            if (g && g.name === n && isFinite(g.ctx.budgetMs)) lines[lines.length - 1] += '  ⏳' + Math.max(0, Math.round((g.ctx.budgetMs - (now() - g.t0)) / 60000)) + 'm';
        }
        if (hooks.dtCapped > 0.3) lines.push('page speed-up: dt ' + (hooks.dtMean * 1000).toFixed(0) + 'ms (' + Math.round(hooks.dtCapped * 100) + '% at the engines\' 50ms cap)');
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
    pause() { flow.pause(); return flow.paused ? 'paused' : (flow.timer ? 'running' : 'stopped'); },
    resume() { if (!flow.timer) { flow.start(); return 'started'; } flow.resume(); return flow.paused ? 'paused' : 'running'; },
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
    // per-game target for the unbounded games (Champagne metres, Order Up / Where Is My Shot
    // rounds, Ice Carving balls, Glass Stack height, Table Rush stages). null clears it.
    target(name, v) {
        name = String(name || '').toUpperCase();
        if (!drivers[name]) return 'unknown game: ' + name;
        const t = Object.assign({}, config.targets);
        if (v == null) delete t[name]; else t[name] = v;
        api.set('targets', t);
        return name + ' → ' + JSON.stringify(targetFor(name));
    },
    // everything a driver can see right now, as text — `copy(pineMini.diag())` in the console
    diag() {
        const f = api.frame, g = flow.game;
        const count = arr => { const o = {}; for (const k of arr) o[k] = (o[k] || 0) + 1; return o; };
        const d = {
            version: SCRIPT_VERSION, state: flow.state, game: g && g.name, frames: g && g.frames, actedAt: g && g.actedAt, err: flow.err,
            speed: api.speed(), target: g && g.ctx.target, params: g && g.params,
            driver: g && g.driver.state ? safe(() => g.driver.state(), 'state() threw') : null,
            frame: f ? { t: Math.round(f.t), dt: +f.dt.toFixed(4), canvas: f.id, imgs: count(f.imgs.map(o => o.src)), texts: f.texts.map(o => o.s + '@' + Math.round(o.x) + ',' + Math.round(o.y)), rects: f.rects.length, arcs: f.arcs.length, ellipses: f.ellipses.length,
                sprites: f.imgs.filter(o => !/floor|bg_|logo/.test(o.src)).slice(0, 40).map(o => o.src + '@' + Math.round(o.cx) + ',' + Math.round(o.cy) + ' ' + Math.round(o.w) + 'x' + Math.round(o.h)) } : null,
            results: flow.results.slice(-8).map(r => r.name + ' ' + r.txt + (r.fast ? ' (fast)' : ''))
        };
        return JSON.stringify(d, null, 1);
    },
    // how fast the page's clock is running compared with the engines' own frame budget
    speed() { return { dtMs: +(hooks.dtMean * 1000).toFixed(2), cappedFrames: +(hooks.dtCapped * 100).toFixed(0) + '%', frames: hooks.frames, note: hooks.dtCapped > 0.5 ? 'accelerated: the engines clamp dt to 50ms, so the sim advances in coarse steps' : 'normal' }; },
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
