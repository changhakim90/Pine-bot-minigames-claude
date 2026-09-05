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
