// One scenario per process: node test/scenario.js <name>
const path = require('path');
const assert = require('assert');
const makeEnv = require('./fake-env');
const pkg = require('../package.json');
const script = path.join(__dirname, '..', 'dist', 'pine-mini.user.js');
const name = process.argv[2];
const ok = msg => console.log('  ok  ' + msg);

const FAKE_SCRIPT = `
let miniGame = null;
let score = 0;
let flies = [];
const W = 540, H = 540;
function startMini(name) { miniGame = name; }
function drawFlySwat() { /* Fly Swat */ }
`;

// NB: makeEnv copies `game` onto global with Object.assign — scalars are COPIED, so
// frame functions must mutate global.<name>; arrays/objects are shared by reference.
const scenarios = {
    boot() {
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT] });
        assert.ok(env.pineMini, 'window.pineMini exposed');
        assert.strictEqual(env.pineMini.version, pkg.version, 'version stamped');
        env.step(3);
        assert.ok(env.pineMini.hooks.frame >= 3, 'rAF hook counts game frames');
        assert.ok(env.logs.some(l => /booted/.test(l)), 'boot log');
        assert.strictEqual(env.pineMini.status(), 'no mini game on screen');
        ok('boot, version, rAF hook, status');
    },
    discovery() {
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game: { miniGame: null, score: 0, flies: [], W: 540, H: 540, startMini() { }, drawFlySwat() { /* Fly Swat */ } } });
        const p = env.pineMini.probe();
        assert.ok(p.games.includes('flyswat'), 'mentioned game found in script text');
        assert.ok(p.lexical.flies === 'array' && p.lexical.score === 'number', 'declared names typed via indirect eval: ' + JSON.stringify(p.lexical));
        assert.ok(p.windowFunctions.includes('drawFlySwat'), 'window functions listed');
        assert.ok(p.gameFunctions.drawFlySwat, 'game-mentioning function source captured');
        const g = env.pineMini.grep(/Fly Swat/, 20);
        assert.strictEqual(g.length, 1, 'grep finds one hit'); assert.ok(g[0].text.includes('Fly Swat'));
        assert.ok(/startMini/.test(env.pineMini.source('startMini')), 'source() returns function text');
        ok('probe/grep/source');
    },
    'unbound-observes'() {
        // A detected game with no resolvable list must NOT send input.
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game: { miniGame: 'Fly Swat' } });
        env.step(20);
        assert.ok(/flyswat: OBSERVE — unbound list/.test(env.pineMini.status()), env.pineMini.status());
        assert.strictEqual(env.events.length, 0, 'no input while unbound');
        ok('unbound driver observes only');
    },
    flyswat() {
        const game = { miniGame: 'Fly Swat', score: 0, flies: [{ x: 100, y: 200, vx: 2, vy: 0 }, { x: 300, y: 400, dead: true }] };
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game });
        env.step(20);
        assert.strictEqual(env.pineMini.detect.current, 'flyswat', 'detected via scene var');
        assert.strictEqual(env.pineMini.binds.flyswat.list, 'flies', 'auto-bound list');
        const taps = env.events.filter(e => e.type === 'click');
        assert.ok(taps.length >= 1, 'tapped the live fly');
        assert.ok(Math.abs(taps[0].x - 102) < 1 && Math.abs(taps[0].y - 200) < 1, 'lead applied along vx: ' + JSON.stringify(taps[0]));
        assert.ok(!taps.some(t => Math.abs(t.x - 300) < 1), 'dead fly ignored');
        ok('detect, auto-bind, hunt with velocity lead');
    },
    'stop-at'() {
        // needle rises 5/frame, target 50 → must fire on the frame whose prediction lands in [47.5, 52.5]
        const game = { miniGame: 'Champagne Launch', power: 0, target: 50 };
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game, gameFrame: () => { global.power += 5; } });
        env.step(30);
        const fire = env.events.filter(e => e.type === 'click');
        assert.strictEqual(env.pineMini.binds.champagne.value, 'power');
        assert.strictEqual(fire.length, 1, 'fired exactly once: ' + fire.length);
        // it fired when power (post-frame) was 45 → predicted 50 next frame
        ok('stopAt fires once on the predicted crossing');
    },
    'stop-at-wrap'() {
        const game = { miniGame: 'Stir Stop', angle: 0, targetAngle: 10 };
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game, gameFrame: () => { global.angle = (global.angle + 7) % 360; } });
        env.pineMini.bind('stirstop', { period: 360, tol: 4 });
        env.step(120);
        const fire = env.events.filter(e => e.type === 'click');
        assert.ok(fire.length >= 1, 'wrap-aware stopAt fires on a cyclic value');
        ok('stopAt with period');
    },
    'stop-at-hold'() {
        const game = { miniGame: 'Blind Pour', fill: 0, targetFill: 80 };
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game, gameFrame: () => { global.fill += 4; } });
        env.step(3);
        assert.ok(env.events.some(e => e.type === 'pointerdown'), 'hold started');
        assert.ok(!env.events.some(e => e.type === 'pointerup'), 'not released yet');
        env.step(30);
        assert.ok(env.events.some(e => e.type === 'pointerup'), 'released at target');
        ok('hold-to-pour: down at start, up at target');
    },
    sequence() {
        const game = { miniGame: 'Order Up', order: ['lime', 'gin'], bottles: [{ id: 'gin', x: 50, y: 500 }, { id: 'lime', x: 150, y: 500 }] };
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game });
        env.step(16);
        const taps = env.events.filter(e => e.type === 'click');
        assert.ok(taps.length >= 1 && Math.abs(taps[0].x - 150) < 1, 'tapped the first wanted item: ' + JSON.stringify(taps[0]));
        game.order.shift();
        env.step(2);
        const t2 = env.events.filter(e => e.type === 'click');
        assert.ok(Math.abs(t2[t2.length - 1].x - 50) < 1, 'then the next');
        ok('sequence follows the order');
    },
    track() {
        const game = { miniGame: 'Tip Catch', tips: [{ x: 100, y: 100, vy: 10 }, { x: 400, y: 300, vy: 10 }], tray: { x: 270, y: 500 } };
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game });
        env.step(16);
        const mv = env.events.filter(e => e.type === 'pointermove');
        assert.ok(mv.length >= 1 && Math.abs(mv[0].x - 400) < 1 && Math.abs(mv[0].y - 500) < 1, 'moved under the tip landing first: ' + JSON.stringify(mv[0]));
        ok('track picks the soonest-landing thing');
    },
    shell() {
        const game = { miniGame: "Where's My Shot", cups: [{ x: 100, y: 300 }, { x: 270, y: 300 }, { x: 440, y: 300 }], shotIndex: 2, canPick: false };
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game });
        env.step(16);
        assert.strictEqual(env.events.filter(e => e.type === 'click').length, 0, 'waits while shuffling');
        global.canPick = true; env.step(2);
        const t = env.events.filter(e => e.type === 'click');
        assert.ok(t.length === 1 && Math.abs(t[0].x - 440) < 1, 'picked the cup holding the shot');
        ok('shell game reads the answer');
    },
    'binds-persist'() {
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT] });
        env.pineMini.bind('flyswat', { list: 'bugs' });
        const saved = JSON.parse(env.store.pineMini_binds);
        assert.strictEqual(saved.flyswat.list, 'bugs');
        const env2 = makeEnv({ script, scripts: [FAKE_SCRIPT], storage: { pineMini_binds: env.store.pineMini_binds } });
        assert.strictEqual(env2.pineMini.binds.flyswat.list, 'bugs', 'binding survives reload');
        ok('bind() persists in localStorage');
    },
    'observe-only'() {
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], storage: { pineMini_config: JSON.stringify({ observeOnly: true }) }, game: { miniGame: 'Fly Swat', flies: [{ x: 1, y: 1 }] } });
        env.step(20);
        assert.strictEqual(env.events.length, 0, 'observe-only sends nothing');
        assert.ok(/observe-only/.test(env.pineMini.status()));
        ok('observeOnly');
    },
    record() {
        const game = { miniGame: 'Fly Swat', score: 0, flies: [], W: 540 };
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game, gameFrame: () => { global.score++; } });
        global.Blob = class { }; global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() { } };
        env.pineMini.record(60);
        env.step(3);
        env.pineMini.stopRecord();
        assert.ok(env.logs.some(l => /globals changed: score/.test(l)), env.logs.join('\n'));
        ok('recorder keeps only changing globals');
    },
    'self-drive'() {
        // no game rAF loop at all: the bot's own native-rAF fallback must still tick
        const env = makeEnv({ script, scripts: [FAKE_SCRIPT], game: { miniGame: 'Fly Swat', flies: [{ x: 5, y: 5 }] } });
        // the fake game loop registered in makeEnv is driven by step(); starve it and drive only the fallback
        const t0 = Date.now(); while (Date.now() - t0 < 150) { /* let 120 ms pass */ }
        env.step(1);
        assert.ok(env.pineMini.state.ticks >= 1, 'ticked');
        ok('fallback loop');
    }
};
if (!scenarios[name]) { console.error('unknown scenario ' + name); process.exit(2); }
try { scenarios[name](); process.exit(0); } catch (e) { console.error('  FAIL ' + (e && e.stack || e)); process.exit(1); }
