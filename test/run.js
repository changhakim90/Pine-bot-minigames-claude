#!/usr/bin/env node
// Headless tests: the built script in a fake browser. The browser-level
// behaviour (every game end to end) is covered by test/e2e.js.
const assert = require('assert');
const { makeEnv } = require('./fake-env.js');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);   // values cross the vm boundary

test('boots, exposes the API, does not autoplay when told not to', () => {
    const env = makeEnv();
    const pm = env.window.pineMini;
    assert.ok(pm && pm.version, 'pineMini on window');
    assert.strictEqual(pm.flow.state, 'idle');
    assert.strictEqual(pm.flow.timer, null);
    assert.strictEqual(pm.config.submit, false, 'submit is always off');
    assert.strictEqual(Object.keys(pm.drivers).length, 13);
});

test('rankMetric follows the game: first number, ± and ⏱ are lower-is-better', () => {
    const pm = makeEnv().window.pineMini;
    eq(pm.rankMetric('MASTER ±0.5ml'), { v: 0.5, low: true });
    eq(pm.rankMetric('⏱18.9s 1X'), { v: 18.9, low: true });
    eq(pm.rankMetric('ROUND 12 KO'), { v: 12, low: false });
    eq(pm.rankMetric('301m!'), { v: 301, low: false });
    assert.strictEqual(pm.rankMetric('CRASH!!'), null);
});

test('canvas hooks record absolute coordinates, colours and image names per frame', () => {
    const env = makeEnv();
    const pm = env.window.pineMini;
    const cv = env.el('hh_fpcv', 'canvas');
    const ctx = cv.getContext('2d');
    const img = { tagName: 'IMG', src: 'https://x/assets/fs_fly1.png?v=3', width: 64, height: 64 };
    const off = new env.Node('canvas'); off.getContext('2d').drawImage(img, 0, 0);     // keying copy → name inherited
    let got = null;
    pm.hooks.onFrame = f => { got = f; };
    env.frame(1000, t => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgb(151,203,255)';
        ctx.fillRect(210, 22, 100, 30);
        ctx.save(); ctx.translate(120, 200); ctx.rotate(0.5); ctx.drawImage(off, -17, -17, 34, 34); ctx.restore();
        ctx.translate(0, 40); ctx.fillText('ROUND 3', 12, 28);
        ctx.ellipse(200, 350.5, 30, 3, 0, 0, 6.28);
    });
    assert.ok(got, 'frame published');
    assert.strictEqual(got.id, 'hh_fpcv');
    const r = got.rect(210, 22, 100, 30); assert.ok(r && /151/.test(r.fs));
    eq(got.rgb(r.fs), [151, 203, 255]);
    const fly = got.img('fs_fly1')[0];
    assert.ok(fly, 'keyed offscreen canvas carries the image name');
    assert.ok(Math.abs(fly.cx - 120) < 1e-9 && Math.abs(fly.cy - 200) < 1e-9 && Math.abs(fly.w - 34) < 1e-9, 'rotated draw centre/width');
    const tx = got.text(/^ROUND (\d+)$/, { x: 12, y: 68, d: 1 }); assert.ok(tx && tx.m[1] === '3', 'translated text position');
    assert.strictEqual(got.ellipses.length, 1);
    eq(got.rgb('#97cbff'), [151, 203, 255]);
});

test('blind pour: surface → ml is exact and the release rule aims target − tail', () => {
    const pm = makeEnv().window.pineMini;
    const g = pm.FP_GLASS[0];
    for (const ml of [3, 12.5, 27.83, 44]) {
        const y = g.inBot - (g.inBot - g.inTop) * ml / g.cap + Math.sin(777 / 60) * 2.0;
        assert.ok(Math.abs(pm.pourMlFromSurface(y, 777, 2.0, g) - ml) < 1e-9);
    }
    const tail = pm.pourTailModel(1 / 60);
    assert.ok(tail > 1.9 && tail < 2.3, 'tail model at 60 Hz ≈ 2.1 ml, got ' + tail);
    assert.ok(pm.pourTailModel(1 / 120) < tail && pm.pourTailModel(1 / 30) > tail);
});

test('blind pour driver: holds until armed, releases when ml + tail reaches the target', () => {
    const env = makeEnv();
    const pm = env.window.pineMini;
    const cv = env.el('hh_fpcv', 'canvas');
    const ctx = cv.getContext('2d');
    const d = pm.drivers['BLIND POUR'].make({ name: 'BLIND POUR', params: { bias: 0 }, cal: {}, target: { v: 0 }, log() { } });
    pm.hooks.onFrame = f => d.frame(f);
    const g = pm.FP_GLASS[0];
    let ml = 0, t = 1000, released = null;
    for (let i = 0; i < 400 && released == null; i++) {
        t += 1000 / 60;
        env.frame(t, tt => {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillText('POUR 1/3', 12, 48);
            if (ml > 0.05) ctx.ellipse(200, g.inBot - (g.inBot - g.inTop) * ml / g.cap + Math.sin(tt / 60) * 2.0, 20, 3, 0, 0, 6.28);
        });
        const ups = cv.events.filter(e => e.type === 'pointerup');
        if (ups.length) released = ml;
        else if (cv.events.some(e => e.type === 'pointerdown') && i > 5) ml += 10 / 60;   // pouring once the hold is accepted
    }
    assert.ok(released != null, 'released');
    assert.ok(released > 27.4 && released < 28.3, 'released at ' + released.toFixed(2) + ' (target 30 − tail)');
});

test('stir stop: model step matches the game update and the target colour round-trips', () => {
    const pm = makeEnv().window.pineMini;
    const ref = (s, dt) => {   // verbatim from the game
        const fr2 = s.dragging ? 5 : 11;
        s.omega -= Math.sign(s.omega) * Math.min(Math.abs(s.omega), dt * fr2);
        const om = Math.abs(s.omega);
        const cool = om * dt * 0.3 * (s.dragging ? 1 : 0.45) * (0.35 + 0.65 * Math.max(0, (s.temp + 8) / 28));
        s.temp = Math.max(-8, s.temp - cool);
        if (om < 0.5) s.temp = Math.min(20, s.temp + dt * 0.33);
        return s;
    };
    const a = { omega: 14, temp: 20, dragging: true }, b = { omega: 14, temp: 20, dragging: true };
    for (let i = 0; i < 600; i++) {
        const dt = 0.0166 + (i % 3) * 0.0004;
        pm.stStep(a, dt); ref(b, dt);
        if (i < 300) { a.omega = b.omega = 14; } else { a.dragging = b.dragging = false; }   // the driver re-pins ω every frame while stirring
    }
    assert.strictEqual(a.temp, b.temp); assert.strictEqual(a.omega, b.omega);
    assert.ok(a.temp < 5 && a.temp > 0, 'cooled to ~3.7° after 5 s at ω=14: ' + a.temp);
    const bottom = pm.stBottom({ omega: 14, temp: -1, dragging: true }, 1 / 60);
    assert.ok(bottom < -1 && bottom > -2.2, 'residual cooling after release: ' + bottom);
    for (let tp = -1.5; tp >= -4.0; tp -= 0.1) {
        const rgb = pm.stTempRGB(tp);
        const hex = '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('');
        eq(pm.Frame.prototype.rgb.call({}, hex), rgb);
    }
});

test('champagne: flight model is monotonic in R and the plan lands where asked', () => {
    const pm = makeEnv().window.pineMini;
    const f1 = pm.clFlight(1000, 45, 1 / 60), f2 = pm.clFlight(4000, 45, 1 / 60);
    assert.ok(f1 > 1000 && f2 > f1 && f2 > 4000, [f1, f2].join(' '));
    assert.ok(f2 / 4000 > 1.15 && f2 / 4000 < 1.45, 'range ≈ 1.2–1.4 R with bounces: ' + (f2 / 4000));
    assert.ok(Math.abs(pm.clPowerDecay(100, 1 / 60, 32) - 100 * Math.pow(1 - 0.55 / 60, 32)) < 0.3);
});

test('order up: POS button centres', () => {
    const pm = makeEnv().window.pineMini;
    const b0 = pm.OU_BTN(0), b7 = pm.OU_BTN(7);
    assert.ok(Math.abs(b0.x - 60.76) < 0.05 && Math.abs(b0.y - 240.57) < 0.05, JSON.stringify(b0));
    assert.ok(Math.abs(b7.x - (60.76 + 2 * 56.968)) < 0.05 && Math.abs(b7.y - (240.57 + 104.1)) < 0.05, JSON.stringify(b7));
});

test('scheduler: targets, beaten, wantsPlay and the tuner stay inside their ranges', () => {
    const pm = makeEnv().window.pineMini;
    pm.board.top['ORDER UP!'] = { v: 20, low: false, txt: 'ROUND 20 KO' };
    assert.strictEqual(pm.targetFor('ORDER UP!').v, 22, 'board #1 + margin');
    assert.strictEqual(pm.targetFor('BLIND POUR').v, 0);
    assert.strictEqual(pm.wantsPlay('ORDER UP!'), true);
    pm.learn.record('ORDER UP!', 'ROUND 22 KO', {});
    assert.strictEqual(pm.beaten('ORDER UP!'), true);
    assert.strictEqual(pm.wantsPlay('ORDER UP!'), false);
    pm.learn.record('BLIND POUR', '±0.4ml', { bias: 0 });
    assert.strictEqual(pm.beaten('BLIND POUR'), false);
    assert.strictEqual(pm.wantsPlay('BLIND POUR'), true);
    pm.learn.record('BLIND POUR', 'MASTER ±0.0ml', { bias: 0 });
    assert.strictEqual(pm.beaten('BLIND POUR'), true);
    for (let i = 0; i < 50; i++) {
        const p = pm.tune.pick('TIP CATCH', pm.drivers['TIP CATCH'].tunables);
        assert.ok(p.safety >= 0 && p.safety <= 12 && p.horizon >= 40 && p.horizon <= 110);
        pm.tune.report('TIP CATCH', p, 50 + p.safety);
    }
    const st = pm.learn.game('TIP CATCH').tune.safety.vals;
    assert.ok(Object.keys(st).length >= 2, 'explored more than one value');
});

test('result screen: OK only — never the name field or SUBMIT', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'dist', 'pine-mini.user.js'), 'utf8');
    assert.ok(!/hh_rrSubmit|hh_rrName/.test(src), 'no reference to the submit button or the name field');
    assert.ok(/hh_rrDone/.test(src));
});

(async () => {
    let fail = 0;
    for (const t of tests) {
        try { await t.fn(); console.log('ok   ' + t.name); }
        catch (e) { fail++; console.log('FAIL ' + t.name + '\n     ' + (e && e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
    }
    console.log(`${tests.length - fail}/${tests.length} passed`);
    process.exit(fail ? 1 : 0);
})();
