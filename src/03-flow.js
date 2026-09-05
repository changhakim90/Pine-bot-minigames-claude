
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
