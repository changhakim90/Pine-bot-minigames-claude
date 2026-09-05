
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
