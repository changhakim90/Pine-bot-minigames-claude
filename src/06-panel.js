
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
        el.innerHTML = '<div id="pmBody"><div id="pmTxt"></div><div style="margin-top:6px"><button id="pmToggle">pause</button> <button id="pmSkip">skip</button> <button id="pmBoard">board</button> <button id="pmHide">hide</button></div></div>'
            + '<button id="pmShow" hidden style="all:unset;cursor:pointer;padding:2px 6px;color:#e6b450;font:11px monospace">▸ PineMini</button>';
        d.body.appendChild(el);
        this.el = el;
        const tg = el.querySelector('#pmToggle');
        tg.onclick = () => { if (flow.timer) { flow.stop(); } else { flow.start(); } this.render(); };
        this.toggle = tg;
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
        if (this.toggle) this.toggle.textContent = flow.timer ? 'pause' : 'resume';
        const g = flow.game;
        const lines = ['PineMini v' + SCRIPT_VERSION + '  ' + (flow.timer ? flow.state : 'PAUSED') + (g ? '  ' + g.name + ' (' + g.frames + 'f)' : '')];
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
