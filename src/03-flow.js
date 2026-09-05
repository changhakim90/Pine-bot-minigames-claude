
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
    heldResult: false,   // paused ON the scoreboard (OK not yet pressed)
    resultRecorded: false,
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
    resume() {
        if (this.heldResult) {                       // was holding on the scoreboard: press OK and go on
            const ok = input.el('hh_rrDone'); if (ok) input.click(ok);
            this.heldResult = false; this.resultRecorded = false; this.paused = false; this.set('hub');
            log('resumed — advanced past the scoreboard'); return;
        }
        if (!this.paused) { if (!this.timer) this.start(); return; }
        const d = now() - this.pausedAt; this.since += d; if (this.game) this.game.t0 += d; this.paused = false; log('resumed');
    },
    // play a specific game now (name), or 'ALL' for the whole set; (re)starts if needed
    play(name) {
        name = String(name == null ? 'ALL' : name).toUpperCase();
        if (name === 'ALL' || name === '') config.games = GAME_NAMES.slice();
        else { if (!drivers[name]) return 'unknown game: ' + name; config.games = [name]; }
        store.set('config', Object.assign(store.get('config', {}), { games: config.games }));
        this.heldResult = false; this.resultRecorded = false;
        this.endGame();
        this.queue = config.games.filter(n => drivers[n]);
        if (!this.timer) this.start(); else { this.paused = false; this.set('hub'); }
        return 'playing ' + config.games.join(', ');
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
                    if (rr && !rr.classList.contains('hidden')) { this.resultRecorded = false; this.set('result'); break; }
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
                    if (!this.resultRecorded) { const txt = (input.el('hh_rrRate') || {}).textContent || ''; this.finishGame(txt.trim()); this.resultRecorded = true; }
                    // hold on the scoreboard until the user resumes, if asked
                    if (config.pauseOnResult && !this.heldResult) { this.heldResult = true; this.pause(); break; }
                    if (this.paused) break;
                    // never a name, never SUBMIT: only OK
                    const ok = input.el('hh_rrDone');
                    if (ok) input.click(ok);
                    this.resultRecorded = false;
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
