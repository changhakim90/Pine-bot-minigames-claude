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
