// ==UserScript==
// @name         Pine & Co Minigame Bot
// @namespace    https://pineandco.online/
// @version      0.1.0
// @description  Record-chasing player for the Pine & Co mini games (Quick Tab, Shake Master, Ice Carving, Blind Pour, Fresh Squeeze, Champagne Launch, Stir Stop, Where Is My Shot, Fly Swat, Order Up, Table Rush, Tip Catch, Glass Stack). Reads the game's real state, drives it with frame-exact synthetic input, and ships a probe/recorder that dumps the game's internals so every driver is written against the real code, not guesses.
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
 * PINE MINI — how this script talks to the game
 * ---------------------------------------------------------------------
 * Pine & Co ships as a plain classic <script>: its top-level `let`/`const`
 * live in the GLOBAL LEXICAL ENVIRONMENT (invisible on `window`), while its
 * top-level `function` declarations DO land on `window`. With @grant none
 * this userscript runs in the page realm, so an INDIRECT eval — `(0, eval)
 * ('someName')` — resolves those lexical bindings by name, and a bare call
 * `someGameFunction()` works too. That is the whole trick, inherited from
 * the survivor bot (changhakim90/pine-bot).
 *
 * This script runs at document-start so it can wrap requestAnimationFrame,
 * EventTarget.addEventListener and Math.random BEFORE the game's script
 * executes. Every wrap is observational: the game's frames, listeners and
 * random draws run exactly as they would without us. The bot only READS
 * state and SENDS input.
 *
 * Parts (src/, concatenated in order by build.js):
 *   01-core      header, storage, global-lexical access, hooks, discovery
 *   02-input     canvas geometry + synthetic pointer/touch/keyboard input
 *   03-engines   reusable strategy engines (mash, stopAt, hunt, sequence…)
 *   04-games     the 13 mini game drivers, bound to the game's real names
 *   05-probe     probe() / record() — dump internals for driver authoring
 *   06-panel     floating panel, main loop, boot
 * ===================================================================== */
(function () {
'use strict';
const SCRIPT_VERSION = '0.1.0';
const TAG = '[PineMini]';
const NS = 'pineMini_';                       // localStorage namespace — never collides with pine-bot's pineBotUCB_*

// ---------------------------------------------------------------- utils
const safe = (fn, dflt) => { try { return fn(); } catch (e) { return dflt; } };
const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const log = (...a) => safe(() => console.log(TAG, ...a));
const warn = (...a) => safe(() => console.warn(TAG, ...a));

// Read / write a binding in the global lexical environment (or window) by name.
// Indirect eval evaluates in the global scope, which sees top-level let/const
// of every classic script on the page. Unknown names yield undefined, never throw.
const G = name => { try { return (0, eval)(name); } catch (e) { return undefined; } };
const setG = (name, value) => { try { (0, eval)('(function(v){' + name + '=v;})')(value); return true; } catch (e) { return false; } };
// Call a game function by name, if it exists (window function or lexical const fn).
const callG = (name, ...args) => { const f = G(name); return typeof f === 'function' ? safe(() => f(...args)) : undefined; };

// ---------------------------------------------------------------- storage
const store = {
    get(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(NS + k); } catch (e) { } }
};

// ---------------------------------------------------------------- config
// Everything here can be overridden at runtime with pineMini.set({...}); the
// override persists in localStorage under pineMini_config.
const DEFAULT_CONFIG = {
    auto: true,               // drive a detected mini game automatically
    observeOnly: false,       // hooks + panel + probe, but never send input
    inputLeadMs: 0,           // extra lead applied to every timed input (measure with pineMini.latency())
    mashPerFrame: 3,          // taps per animation frame for mash-type games
    panel: true,
    verbose: false
};
const config = Object.assign({}, DEFAULT_CONFIG, store.get('config', {}));

// ---------------------------------------------------------------- hooks
// Installed synchronously at document-start, before the game script parses.
const hooks = {
    frame: 0,                 // animation frames observed since load
    lastFrameTs: 0,
    frameDtMs: 16.7,          // EMA of real time between frames
    before: [],               // fns run before each game rAF callback
    after: [],                // fns run after each game rAF callback
    listeners: [],            // { target, type, fn, opts } every addEventListener seen
    random: { count: 0, ring: new Array(64).fill(0), head: 0 },   // Math.random tap (observation only)
    installed: false
};

function installHooks() {
    if (hooks.installed) return;
    hooks.installed = true;
    // rAF: wrap the callback so the bot runs in lock-step with the game loop.
    // The wrapper registers exactly one native callback per game callback, so
    // the game's own re-registration pattern is unchanged (and pine-speed's
    // rAF multiplier, if installed, composes with this either way).
    const nativeRAF = window.requestAnimationFrame;
    if (typeof nativeRAF === 'function') {
        hooks.nativeRAF = cb => nativeRAF.call(window, cb);
        window.requestAnimationFrame = function (cb) {
            return nativeRAF.call(window, function (ts) {
                hooks.frame++;
                if (hooks.lastFrameTs) hooks.frameDtMs = hooks.frameDtMs * 0.9 + (ts - hooks.lastFrameTs) * 0.1;
                hooks.lastFrameTs = ts;
                for (const f of hooks.before) safe(() => f(ts));
                try { return cb(ts); } finally { for (const f of hooks.after) safe(() => f(ts)); }
            });
        };
    }
    // Listener registry: which element handles which input type. The input
    // synthesizer uses it to pick the right target, and drivers may call a
    // captured handler directly (fastest possible path, no event plumbing).
    const proto = typeof EventTarget !== 'undefined' && EventTarget.prototype;
    if (proto && typeof proto.addEventListener === 'function') {
        const origAdd = proto.addEventListener;
        proto.addEventListener = function (type, fn, opts) {
            if (typeof fn === 'function' && /^(pointer|mouse|touch|key|click|dblclick|contextmenu|wheel|devicemotion|deviceorientation)/.test(String(type)))
                hooks.listeners.push({ target: this, type: String(type), fn, opts });
            return origAdd.call(this, type, fn, opts);
        };
    }
    // Math.random tap: records draw count + last 64 values. Never alters them.
    const origRandom = Math.random;
    Math.random = function () {
        const v = origRandom();
        const r = hooks.random;
        r.count++; r.ring[r.head] = v; r.head = (r.head + 1) & 63;
        return v;
    };
}
installHooks();

// ---------------------------------------------------------------- discovery
// Which mini game is on screen, and which script/function/variable names the
// game uses for it. Everything below is text-scanning + type probing; the
// driver bindings in 04-games are what turn it into play.
const GAME_NAMES = {
    quicktab:      ['Quick Tab', 'quickTab', 'quick_tab', 'quicktab'],
    shakemaster:   ['Shake Master', 'shakeMaster', 'shake_master', 'shakemaster'],
    icecarving:    ['Ice Carving', 'iceCarving', 'ice_carving', 'icecarving'],
    blindpour:     ['Blind Pour', 'blindPour', 'blind_pour', 'blindpour'],
    freshsqueeze:  ['Fresh Squeeze', 'freshSqueeze', 'fresh_squeeze', 'freshsqueeze'],
    champagne:     ['Champagne Launch', 'champagneLaunch', 'champagne_launch', 'champagne'],
    stirstop:      ['Stir Stop', 'stirStop', 'stir_stop', 'stirstop'],
    whereismyshot: ['Where Is My Shot', "Where's My Shot", 'whereIsMyShot', 'wheresMyShot', 'shellgame', 'shell_game'],
    flyswat:       ['Fly Swat', 'flySwat', 'fly_swat', 'flyswat'],
    orderup:       ['Order Up', 'orderUp', 'order_up', 'orderup'],
    tablerush:     ['Table Rush', 'tableRush', 'table_rush', 'tablerush'],
    tipcatch:      ['Tip Catch', 'tipCatch', 'tip_catch', 'tipcatch'],
    glassstack:    ['Glass Stack', 'glassStack', 'glass_stack', 'glassstack']
};

function inlineScripts() {
    return safe(() => Array.from(document.scripts).filter(s => !s.src && s.textContent && s.textContent.length > 40).map(s => s.textContent), []) || [];
}

// Names declared at the top level of any inline script (let/const/var/function/class).
// Column-0 declarations only: nested code is indented in every build of this game seen so far.
function declaredNames(text) {
    const out = new Set();
    const re = /^(?:let|const|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;
    let m; while ((m = re.exec(text))) out.add(m[1]);
    // `let a = 1, b = 2;` lists and destructuring are not walked — the probe reports them by text.
    return Array.from(out);
}

// Everything the game exposes: window functions + resolvable global lexical names.
function scanGlobals() {
    const winFns = safe(() => Object.keys(window).filter(k => typeof window[k] === 'function' && !/^(webkit|on|moz|ms)/.test(k)), []);
    const lex = {};
    for (const text of inlineScripts()) for (const name of declaredNames(text)) {
        if (name in lex) continue;
        const v = G(name);
        if (v !== undefined) lex[name] = Array.isArray(v) ? 'array' : typeof v;
    }
    return { winFns, lex };
}

// Which mini games does the page's script even know about?
function mentionedGames(texts) {
    const found = {};
    for (const [id, names] of Object.entries(GAME_NAMES)) {
        for (const text of texts) for (const n of names) {
            const i = text.indexOf(n);
            if (i >= 0) { (found[id] = found[id] || []).push({ name: n, at: i }); }
        }
    }
    return found;
}

// Visible text on screen (DOM-driven menus/overlays). Canvas-only games show nothing here.
function visibleText() {
    return safe(() => (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim(), '');
}


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

/* =====================================================================
 * 04 — GAMES: the thirteen drivers.
 * ---------------------------------------------------------------------
 * A driver is play logic (an engine from 03) plus BINDINGS: the names of
 * the game's own variables that hold the state the engine needs. Bindings
 * are data, not code — they live in DEFAULT_BINDS below, can be overridden
 * at runtime with pineMini.bind('flyswat', { list: 'flies' }) (persisted
 * in localStorage), and are meant to be filled in from a pineMini.probe()
 * dump of the real game. A driver whose required bindings are unresolved
 * stays in OBSERVE and reports which names it is missing, so an unbound
 * game never sends blind input.
 *
 * Binding value forms:
 *   'name'          a global (lexical or window) — read with G()
 *   'obj.a.b'       a path walked from a global
 *   'fn()'          call a global function and use its return value
 *   {x, y}          a literal point (canvas px)
 *   function        computed at read time (runtime overrides only)
 * ===================================================================== */
const DEFAULT_BINDS = {
    // shared: how to tell which mini game is active, its score, and how to (re)start
    _common: {
        // candidate globals whose string value names the current game / scene
        sceneVars: ['miniGame', 'minigame', 'currentGame', 'currentMini', 'game', 'scene', 'mode', 'state', 'screen', 'gameState'],
        // candidate globals holding a mini-game-level score / time
        scoreVars: ['miniScore', 'score', 'points', 'combo', 'streak'],
        // candidate globals that mean "a round is in progress"
        activeVars: ['miniActive', 'playing', 'running', 'started', 'active', 'inGame'],
        // candidate globals that mean "round over"
        overVars: ['miniOver', 'gameOver', 'over', 'ended', 'finished', 'done'],
        startFn: null,      // e.g. 'startMini' — set from the probe
        restartFn: null     // e.g. 'restartMini'
    },
    quicktab:      { kind: 'mash',     at: 'center', perFrame: null, tryLists: [] },
    shakemaster:   { kind: 'shake',    at: 'center', mode: 'auto' },                                   // auto: tap + drag wiggle + devicemotion, whichever the game listens to
    freshsqueeze:  { kind: 'mash',     at: 'center', perFrame: null },
    icecarving:    { kind: 'trace',    path: null, tryLists: ['path', 'shape', 'outline', 'points', 'targetPath', 'carvePath'] },
    blindpour:     { kind: 'stopAt',   value: null, target: null, hold: true, tol: null, tryValues: ['pour', 'fill', 'level', 'amount', 'poured', 'liquid'], tryTargets: ['target', 'goal', 'targetFill', 'targetLevel', 'want'] },
    champagne:     { kind: 'stopAt',   value: null, target: null, hold: false, tol: null, tryValues: ['power', 'meter', 'charge', 'bar', 'gauge'], tryTargets: ['target', 'sweet', 'sweetSpot', 'goal', 'perfect'] },
    stirstop:      { kind: 'stopAt',   value: null, target: null, hold: false, period: null, tol: null, tryValues: ['angle', 'rot', 'rotation', 'needle', 'spin', 'theta'], tryTargets: ['target', 'targetAngle', 'goal', 'zone', 'sweet'] },
    glassstack:    { kind: 'stopAt',   value: null, target: null, hold: false, tol: null, tryValues: ['glassX', 'x', 'pos', 'slide', 'offset', 'moverX'], tryTargets: ['lastX', 'baseX', 'towerX', 'stackX', 'prevX'] },
    tipcatch:      { kind: 'track',    list: null, catcherY: null, catcherX: null, tryLists: ['tips', 'coins', 'drops', 'items', 'falling', 'money'], tryCatchers: ['tray', 'jar', 'player', 'catcher', 'hand', 'basket'] },
    flyswat:       { kind: 'hunt',     list: null, alive: null, tryLists: ['flies', 'bugs', 'targets', 'insects', 'enemies', 'spawns'] },
    whereismyshot: { kind: 'shell',    cups: null, index: null, canPick: null, tryLists: ['cups', 'glasses', 'shots', 'shells'], tryIndex: ['shotIndex', 'ballIndex', 'answer', 'correct', 'winner', 'shotCup', 'target'], tryCanPick: ['canPick', 'pickable', 'shuffling', 'revealed', 'shuffled', 'choosing'] },
    orderup:       { kind: 'sequence', need: null, slots: null, tryNeeds: ['order', 'orders', 'recipe', 'queue', 'wanted', 'currentOrder'], tryLists: ['buttons', 'ingredients', 'slots', 'options', 'choices', 'bottles'] },
    tablerush:     { kind: 'hunt',     list: null, alive: null, tryLists: ['tables', 'customers', 'guests', 'orders', 'requests', 'seats'] }
};

const binds = (() => {
    const saved = store.get('binds', {});
    const out = {};
    for (const id of Object.keys(DEFAULT_BINDS)) out[id] = Object.assign({}, DEFAULT_BINDS[id], saved[id] || {});
    return out;
})();
function bind(id, patch) {
    if (!binds[id]) throw new Error('unknown game ' + id);
    Object.assign(binds[id], patch);
    const saved = store.get('binds', {});
    saved[id] = Object.assign({}, saved[id] || {}, patch);
    store.set('binds', saved);
    return binds[id];
}

// Resolve a binding spec to a value (see forms above).
function read(spec) {
    if (spec == null) return undefined;
    if (typeof spec === 'function') return safe(spec);
    if (typeof spec !== 'string') return spec;
    if (spec === 'center') { const cv = input.canvas(); return cv ? { x: cv.width / 2, y: cv.height / 2 } : { x: 270, y: 270 }; }
    if (spec.endsWith('()')) return callG(spec.slice(0, -2));
    const parts = spec.split('.');
    let v = G(parts[0]);
    for (let i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
    return v;
}
// Point extraction from whatever the game stores: {x,y}, {pos:{x,y}}, [x,y], {cx,cy}.
function pointOf(e) {
    if (!e) return null;
    if (isFinite(e.x) && isFinite(e.y)) return { x: e.x + (isFinite(e.w) ? e.w / 2 : isFinite(e.width) ? e.width / 2 : 0), y: e.y + (isFinite(e.h) ? e.h / 2 : isFinite(e.height) ? e.height / 2 : 0) };
    if (e.pos && isFinite(e.pos.x)) return { x: e.pos.x, y: e.pos.y };
    if (isFinite(e.cx) && isFinite(e.cy)) return { x: e.cx, y: e.cy };
    if (Array.isArray(e) && isFinite(e[0]) && isFinite(e[1])) return { x: e[0], y: e[1] };
    return null;
}
const isAlive = e => !(e.dead || e.hit || e.done || e.gone || e.removed || e.caught || e.alive === false || e.active === false || e.swatted || e.served);

// Auto-bind: fill an unresolved binding from the first candidate name that
// resolves to the right shape right now (array for lists, number for values).
function autoBind(id) {
    const b = binds[id]; const got = [];
    const tryFill = (key, names, ok) => {
        if (b[key] != null || !names) return;
        for (const n of names) { const v = read(n); if (ok(v)) { b[key] = n; got.push(key + '=' + n); return; } }
    };
    tryFill('list', b.tryLists, v => Array.isArray(v));
    tryFill('path', b.tryLists, v => Array.isArray(v) && v.length > 1 && pointOf(v[0]));
    tryFill('cups', b.tryLists, v => Array.isArray(v) && v.length > 1);
    tryFill('slots', b.tryLists, v => Array.isArray(v) && v.length > 0);
    tryFill('need', b.tryNeeds, v => v != null);
    tryFill('value', b.tryValues, v => typeof v === 'number');
    tryFill('target', b.tryTargets, v => typeof v === 'number' || (Array.isArray(v) && v.length === 2));
    tryFill('index', b.tryIndex, v => typeof v === 'number');
    tryFill('canPick', b.tryCanPick, v => typeof v === 'boolean');
    tryFill('catcherX', b.tryCatchers, v => v && typeof v === 'object' && isFinite(v.x));
    if (got.length) { log(id, 'auto-bound', got.join(' ')); bind(id, {}); }
    return got;
}

// Which required bindings are still unresolved for a game?
function missing(id) {
    const b = binds[id], need = [];
    const req = { mash: [], shake: [], trace: ['path'], stopAt: ['value', 'target'], track: ['list'], hunt: ['list'], shell: ['cups', 'index'], sequence: ['need', 'slots'] }[b.kind] || [];
    for (const k of req) if (b[k] == null || read(b[k]) === undefined) need.push(k);
    return need;
}

// ---------------------------------------------------------------- drivers
// tick(s) is called once per game frame with the driver's private state `s`
// (reset when the active game changes). Returns a short status string.
const drivers = {
    quicktab(s) { const b = binds.quicktab; return 'mash x' + engines.mash(s, read(b.at), b.perFrame); },
    freshsqueeze(s) { const b = binds.freshsqueeze; return 'mash x' + engines.mash(s, read(b.at), b.perFrame); },
    shakemaster(s) {
        const b = binds.shakemaster, at = read(b.at), mode = b.mode;
        let did = [];
        if (mode === 'auto' || mode === 'motion') { if (input.shake()) did.push('motion'); }
        if (mode === 'auto' || mode === 'drag') { const a = (hooks.frame & 1) ? 60 : -60; input.drag([{ x: at.x - a, y: at.y }, { x: at.x + a, y: at.y }]); did.push('drag'); }
        if (mode === 'auto' || mode === 'tap') { engines.mash(s, at, b.perFrame); did.push('tap'); }
        return 'shake ' + did.join('+');
    },
    icecarving(s) {
        const b = binds.icecarving;
        const pts = () => (read(b.path) || []).map(pointOf).filter(Boolean);
        return engines.trace(s, pts) ? 'traced' : (s.done ? 'done' : 'no path');
    },
    _stopAt(id, s) {
        const b = binds[id];
        const value = () => Number(read(b.value)), target = () => read(b.target), at = read(b.at || 'center');
        if (b.hold && !s.holding) { input.down(at.x, at.y); s.holding = true; }
        const fire = () => { if (b.hold) { input.up(at.x, at.y); s.holding = false; } else input.tap(at.x, at.y); };
        const opts = { tol: b.tol == null ? undefined : b.tol, period: b.period || undefined, leadMs: b.leadMs || 0 };
        const hit = engines.stopAt(s, value, target, fire, opts);
        return (hit ? 'FIRE ' : '') + 'v=' + (+value()).toFixed(2) + ' t=' + JSON.stringify(target());
    },
    blindpour(s) { return drivers._stopAt('blindpour', s); },
    champagne(s) { return drivers._stopAt('champagne', s); },
    stirstop(s) { return drivers._stopAt('stirstop', s); },
    glassstack(s) { return drivers._stopAt('glassstack', s); },
    flyswat(s) { const b = binds.flyswat; return 'swat x' + engines.hunt(s, () => read(b.list), pointOf, b.alive ? e => read(b.alive)(e) : isAlive, 12); },
    tablerush(s) { const b = binds.tablerush; return 'serve x' + engines.hunt(s, () => read(b.list), pointOf, b.alive ? e => read(b.alive)(e) : e => isAlive(e) && (e.wants || e.order || e.waiting || e.ready || e.needs || true), 6); },
    tipcatch(s) {
        const b = binds.tipcatch;
        const catcher = read(b.catcherX);
        const cy = b.catcherY != null ? Number(read(b.catcherY)) : (catcher && isFinite(catcher.y) ? catcher.y : (input.canvas() || { height: 540 }).height * 0.85);
        const ok = engines.track(s, () => (read(b.list) || []).map(t => Object.assign({}, pointOf(t), { vx: t.vx || t.dx || 0, vy: t.vy || t.dy || t.speed || 0 })), cy, x => input.move(x, cy));
        return ok ? 'track' : 'idle';
    },
    whereismyshot(s) {
        const b = binds.whereismyshot;
        const can = b.canPick == null ? true : !!read(b.canPick);
        const cups = read(b.cups) || [], idx = Number(read(b.index));
        if (!can || !cups.length || !isFinite(idx) || !cups[idx]) return 'watch idx=' + idx;
        if (s.pickedAt != null && hooks.frame - s.pickedAt < 30) return 'picked';
        const p = pointOf(cups[idx]); if (!p) return 'no point';
        input.tap(p.x, p.y); s.pickedAt = hooks.frame;
        return 'PICK ' + idx;
    },
    orderup(s) {
        const b = binds.orderup;
        const need = () => { const n = read(b.need); if (Array.isArray(n)) return n.length ? (n[0] && n[0].id != null ? n[0].id : n[0]) : null; return n && n.id != null ? n.id : n; };
        const slots = () => (read(b.slots) || []).map((sl, i) => Object.assign({ id: sl.id != null ? sl.id : sl.name != null ? sl.name : sl.type != null ? sl.type : i }, pointOf(sl)));
        return engines.sequence(s, need, slots) ? 'tap ' + need() : 'need ' + need();
    }
};

// ---------------------------------------------------------------- detection
// 1) a scene/mode global whose string names a game; 2) the game's title in
// the visible DOM text; 3) nothing → null. Cached for 15 frames.
const detect = {
    current: null, at: 0, how: '',
    scan() {
        const names = Object.entries(GAME_NAMES);
        for (const v of binds._common.sceneVars) {
            const val = read(v);
            const str = typeof val === 'string' ? val : (val && typeof val === 'object' && typeof val.name === 'string') ? val.name : null;
            if (!str) continue;
            const lc = str.toLowerCase().replace(/[\s_'-]/g, '');
            for (const [id, ns] of names) if (ns.some(n => lc === n.toLowerCase().replace(/[\s_'-]/g, '')) || lc.includes(id)) { this.how = v + '=' + str; return id; }
        }
        const text = visibleText();
        if (text) for (const [id, ns] of names) if (ns.some(n => text.includes(n))) { this.how = 'dom:' + ns.find(n => text.includes(n)); return id; }
        return null;
    },
    tick() {
        if (hooks.frame - this.at < 15 && this.at) return this.current;
        this.at = hooks.frame || 1;
        const id = this.scan();
        if (id !== this.current) { this.current = id; log('game:', id || 'none', this.how); }
        return this.current;
    }
};

/* =====================================================================
 * 05 — PROBE / RECORD: dump what the game actually is.
 * ---------------------------------------------------------------------
 * The drivers above are only as good as their bindings, and the bindings
 * come from reading the game's code — not from guessing. These tools make
 * that a one-click job:
 *   pineMini.dumpSource()   download every inline <script> as one .js file
 *   pineMini.probe()        structured summary: which games the script
 *                           mentions (with source context), every top-level
 *                           name and its runtime type, window functions
 *                           whose source mentions a game, listeners, canvases
 *   pineMini.dump()         download probe() as JSON
 *   pineMini.grep(/re/, n)  source snippets around a regex, n chars of context
 *   pineMini.source(name)   a function's source text
 *   pineMini.record(sec)    sample every scalar/array-length global per frame
 *                           while YOU play, then download the trace
 *   pineMini.stopRecord()   end a recording early
 * Commit the downloads into reference/ so the next driver pass is written
 * against the real thing.
 * ===================================================================== */
function download(name, text, type) {
    try {
        const blob = new Blob([text], { type: type || 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        return true;
    } catch (e) { warn('download failed', e); return false; }
}
function ctxAround(text, i, n) {
    const a = Math.max(0, i - n), b = Math.min(text.length, i + n);
    return text.slice(a, b);
}
function grep(re, n, texts) {
    n = n || 300;
    if (typeof re === 'string') re = new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    if (!re.global) re = new RegExp(re.source, re.flags + 'g');
    const out = [];
    for (const text of (texts || inlineScripts())) {
        re.lastIndex = 0; let m, k = 0;
        while ((m = re.exec(text)) && k++ < 200) out.push({ at: m.index, line: text.slice(0, m.index).split('\n').length, text: ctxAround(text, m.index, n) });
    }
    return out;
}
function source(name) { const f = G(name); return typeof f === 'function' ? String(f) : undefined; }

function probe() {
    const texts = inlineScripts();
    const { winFns, lex } = scanGlobals();
    const mentions = mentionedGames(texts);
    const contexts = {};
    for (const [id, hits] of Object.entries(mentions)) {
        contexts[id] = hits.slice(0, 12).map(h => { const t = texts.find(x => x.indexOf(h.name) >= 0); return { name: h.name, at: h.at, ctx: t ? ctxAround(t, h.at, 500) : '' }; });
    }
    const gameFns = {};
    const allNames = Object.values(GAME_NAMES).flat();
    for (const fn of winFns) {
        const src = source(fn); if (!src) continue;
        if (allNames.some(n => src.includes(n)) || /mini|Mini|MINI/.test(fn)) gameFns[fn] = src.length > 6000 ? src.slice(0, 6000) + '\n/* …' + (src.length - 6000) + ' more chars */' : src;
    }
    const listeners = hooks.listeners.map(l => ({ target: safe(() => l.target === window ? 'window' : l.target === document ? 'document' : (l.target.tagName + (l.target.id ? '#' + l.target.id : '')), '?'), type: l.type, fn: safe(() => String(l.fn).slice(0, 400)) }));
    const canvases = safe(() => Array.from(document.querySelectorAll('canvas')).map(c => ({ id: c.id, w: c.width, h: c.height, css: (r => ({ x: r.left, y: r.top, w: r.width, h: r.height }))(c.getBoundingClientRect()) })), []);
    return {
        version: SCRIPT_VERSION, url: location.href, title: document.title, when: new Date().toISOString(),
        frame: hooks.frame, frameDtMs: hooks.frameDtMs, randomDraws: hooks.random.count,
        visibleText: visibleText().slice(0, 2000),
        scripts: texts.map(t => ({ length: t.length, sha: hashStr(t) })),
        games: Object.keys(mentions), mentions, contexts,
        lexical: lex, windowFunctions: winFns, gameFunctions: gameFns,
        listeners, canvases,
        detected: detect.current, binds
    };
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }
function dump() { const p = probe(); download('pine-mini-probe-' + p.when.replace(/[:.]/g, '-') + '.json', JSON.stringify(p, null, 1)); return p; }
function dumpSource() {
    const texts = inlineScripts();
    const body = texts.map((t, i) => '// ===== inline script #' + (i + 1) + ' (' + t.length + ' chars) =====\n' + t).join('\n\n');
    download('pineandco-inline-scripts.js', '// ' + location.href + ' — captured ' + new Date().toISOString() + ' by PineMini ' + SCRIPT_VERSION + '\n' + body, 'text/javascript');
    return texts.length;
}

// Per-frame recorder of every scalar global (+ array lengths + first-element
// shallow copy) for `seconds`, while a human plays. Only values that changed
// at least once are kept, so the trace shows exactly which globals the game
// animates — those are the bindings.
const recorder = { on: false, frames: [], names: [], t0: 0, until: 0 };
function record(seconds, names) {
    const { lex } = scanGlobals();
    recorder.names = names || Object.keys(lex).filter(n => ['number', 'string', 'boolean', 'array', 'object'].includes(lex[n]));
    recorder.frames = []; recorder.on = true; recorder.t0 = now(); recorder.until = recorder.t0 + (seconds != null ? seconds : 10) * 1000;
    log('recording', recorder.names.length, 'globals for', seconds != null ? seconds : 10, 's — play the game now (pineMini.stopRecord() ends early)');
}
function recordTick() {
    if (!recorder.on) return;
    const row = { f: hooks.frame, t: Math.round(now() - recorder.t0) };
    for (const n of recorder.names) {
        const v = G(n);
        if (v == null) continue;
        const t = typeof v;
        if (t === 'number' || t === 'string' || t === 'boolean') row[n] = v;
        else if (Array.isArray(v)) { row[n + '.length'] = v.length; if (v[0] && typeof v[0] === 'object') row[n + '[0]'] = shallow(v[0]); }
        else if (t === 'object') row[n] = shallow(v);
    }
    recorder.frames.push(row);
    if (now() >= recorder.until) finishRecord();
}
function shallow(o) { const r = {}; let k = 0; for (const key in o) { const v = o[key]; const t = typeof v; if (t === 'number' || t === 'string' || t === 'boolean') { r[key] = v; if (++k > 24) break; } } return r; }
function finishRecord() {
    recorder.on = false;
    const frames = recorder.frames; if (!frames.length) return;
    // keep only columns that changed
    const keys = new Set(); const first = {};
    for (const row of frames) for (const k in row) { if (k === 'f' || k === 't') continue; if (!(k in first)) first[k] = JSON.stringify(row[k]); else if (JSON.stringify(row[k]) !== first[k]) keys.add(k); }
    const trimmed = frames.map(row => { const r = { f: row.f, t: row.t }; for (const k of keys) if (k in row) r[k] = row[k]; return r; });
    const out = { version: SCRIPT_VERSION, url: location.href, when: new Date().toISOString(), detected: detect.current, changing: Array.from(keys), frames: trimmed };
    log('recorded', frames.length, 'frames;', keys.size, 'globals changed:', Array.from(keys).join(', '));
    download('pine-mini-record-' + out.when.replace(/[:.]/g, '-') + '.json', JSON.stringify(out));
    return out;
}

/* =====================================================================
 * 06 — PANEL, MAIN LOOP, BOOT
 * ===================================================================== */
const state = { game: null, s: {}, status: 'boot', ticks: 0, best: store.get('best', {}), lastScore: null, lastGameTick: 0 };

function currentScore() {
    for (const v of binds._common.scoreVars) { const x = read(v); if (typeof x === 'number') return x; }
    return null;
}

// One bot step, in lock-step with the game's frame.
function tick() {
    state.ticks++;
    recordTick();
    const id = detect.tick();
    if (id !== state.game) { state.game = id; state.s = {}; if (id) autoBind(id); }
    if (!id) { state.status = 'no mini game on screen'; return; }
    const sc = currentScore();
    if (sc != null) { state.lastScore = sc; if (sc > (state.best[id] || 0)) { state.best[id] = sc; store.set('best', state.best); } }
    const miss = missing(id);
    if (miss.length) { state.status = id + ': OBSERVE — unbound ' + miss.join(',') + ' (pineMini.dump() → fill binds)'; if (hooks.frame % 300 === 0) autoBind(id); return; }
    if (!config.auto || config.observeOnly) { state.status = id + ': ' + (config.observeOnly ? 'observe-only' : 'auto off'); return; }
    const d = drivers[id];
    state.status = id + ': ' + (d ? safe(() => d(state.s), 'driver error') : 'no driver');
}

// ---------------------------------------------------------------- panel
let panelEl = null;
function panelHtml() {
    return '<div style="font-weight:700">PineMini v' + SCRIPT_VERSION + '</div>' +
        '<div id="pmStatus" style="white-space:pre-wrap;max-width:260px"></div>' +
        '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px">' +
        '<button data-a="auto">auto</button><button data-a="observe">observe</button>' +
        '<button data-a="src" title="download every inline script — commit to reference/">source ⬇</button>' +
        '<button data-a="dump" title="download probe JSON">probe ⬇</button>' +
        '<button data-a="rec" title="record 15 s of globals while you play">rec 15s</button>' +
        '<button data-a="hide">×</button></div>';
}
function mountPanel() {
    if (panelEl || !config.panel || !document.body) return;
    panelEl = document.createElement('div');
    panelEl.id = 'pineMiniPanel';
    panelEl.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;background:rgba(10,12,20,.88);color:#eee;font:12px/1.35 monospace;padding:6px 8px;border-radius:6px;border:1px solid #444;pointer-events:auto;user-select:none';
    panelEl.innerHTML = panelHtml();
    panelEl.addEventListener('click', e => {
        const a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
        if (!a) return;
        e.stopPropagation();
        if (a === 'auto') api.set({ auto: !config.auto, observeOnly: false });
        else if (a === 'observe') api.set({ observeOnly: !config.observeOnly });
        else if (a === 'src') dumpSource();
        else if (a === 'dump') dump();
        else if (a === 'rec') record(15);
        else if (a === 'hide') { panelEl.remove(); panelEl = null; }
    });
    document.body.appendChild(panelEl);
}
function renderPanel() {
    if (!panelEl) return;
    const el = panelEl.querySelector('#pmStatus'); if (!el) return;
    const best = state.game ? (state.best[state.game] || 0) : 0;
    el.textContent = state.status + '\nframe ' + hooks.frame + ' · ' + hooks.frameDtMs.toFixed(1) + 'ms · in ' + input.sent +
        (state.lastScore != null ? ' · score ' + state.lastScore + ' (best ' + best + ')' : '') +
        (recorder.on ? '\n● REC' : '') + (config.observeOnly ? '\n[observe-only]' : config.auto ? '' : '\n[auto off]');
    panelEl.querySelector('[data-a=auto]').style.background = config.auto && !config.observeOnly ? '#2a6' : '';
    panelEl.querySelector('[data-a=observe]').style.background = config.observeOnly ? '#a62' : '';
}

// ---------------------------------------------------------------- api
const api = {
    version: SCRIPT_VERSION, config, hooks, input, engines, drivers, binds, bind, read, G, setG, callG,
    state, detect, probe, dump, dumpSource, grep, source, record, stopRecord: finishRecord, scanGlobals, GAME_NAMES,
    set(patch) { Object.assign(config, patch); store.set('config', Object.assign(store.get('config', {}), patch)); renderPanel(); return config; },
    auto(on) { return api.set({ auto: on !== false, observeOnly: false }); },
    status() { return state.status; },
    best() { return state.best; },
    reset() { store.del('binds'); store.del('config'); store.del('best'); log('storage cleared — reload'); }
};
try { window.pineMini = api; } catch (e) { }

// ---------------------------------------------------------------- boot
// Game frames (wrapped rAF) drive tick(); a native rAF fallback keeps the bot
// alive on pages that run their loop from setInterval instead.
hooks.after.push(() => { state.lastGameTick = now(); tick(); renderPanel(); });
function boot() {
    mountPanel();
    const nativeRAF = safe(() => hooks.nativeRAF) || (cb => setTimeout(() => cb(now()), 16));
    let lastRender = 0;
    (function loop() {
        const t = now();
        if (t - state.lastGameTick > 120) { hooks.frame++; tick(); }        // no game frames flowing: self-drive
        if (t - lastRender > 250) { lastRender = t; mountPanel(); renderPanel(); }
        nativeRAF(loop);
    })();
    log('v' + SCRIPT_VERSION + ' booted · auto=' + config.auto + ' observeOnly=' + config.observeOnly + ' · pineMini.dumpSource() / pineMini.dump() to capture the game');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
