// ==UserScript==
// @name         Pine & Co Minigame Bot
// @namespace    https://pineandco.online/
// @version      0.0.0
// @description  Autonomous record-chasing player for the Pine & Co "Bartender's Happy Hour" mini games. Watches the game's own canvas draw calls, drives every game with frame-exact synthetic input, plays the whole set on its own, tunes itself from its results and never submits a name to the leaderboard.
// @author       you
// @match        https://pineandco.online/*
// @match        https://www.pineandco.online/*
// @match        http://pineandco.online/*
// @grant        none
// @run-at       document-start
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
const SCRIPT_VERSION = '0.0.0';
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
