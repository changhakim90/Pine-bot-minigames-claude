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
