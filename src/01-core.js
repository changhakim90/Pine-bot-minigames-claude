// ==UserScript==
// @name         Pine & Co Minigame Bot
// @namespace    https://pineandco.online/
// @version      0.0.0
// @description  Record-chasing player for the Pine & Co mini games (Quick Tab, Shake Master, Ice Carving, Blind Pour, Fresh Squeeze, Champagne Launch, Stir Stop, Where Is My Shot, Fly Swat, Order Up, Table Rush, Tip Catch, Glass Stack). Reads the game's real state, drives it with frame-exact synthetic input, and ships a probe/recorder that dumps the game's internals so every driver is written against the real code, not guesses.
// @author       you
// @match        https://pineandco.online/*
// @match        https://www.pineandco.online/*
// @match        http://pineandco.online/*
// @grant        none
// @run-at       document-start
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
const SCRIPT_VERSION = '0.0.0';
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

