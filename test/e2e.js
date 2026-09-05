#!/usr/bin/env node
// End-to-end: run the built userscript against the reference page (the game's
// real code, placeholder art) in headless Chromium and check every game's result.
//   node test/e2e.js [--games "BLIND POUR,STIR STOP"] [--verbose] [--timeout 240] [--pages 3]
const path = require('path');
const fs = require('fs');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const ALL = ['BLIND POUR', 'STIR STOP', 'ICE CARVING', 'CHAMPAGNE LAUNCH', 'SHAKE MASTER', 'QUICK TAB', 'ORDER UP!', 'WHERE IS MY SHOT?', 'FRESH SQUEEZE', 'TIP CATCH', 'FLY SWAT', 'GLASS STACK', 'TABLE RUSH'];
const games = String(flag('--games', ALL.join(','))).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const verbose = !!flag('--verbose', false);
const timeoutS = +flag('--timeout', 300);
const nPages = Math.max(1, +flag('--pages', 3));
const port = 8123 + Math.floor(Math.random() * 500);

// what "good" means per game on the reference page (placeholder art, no board)
const EXPECT = {
    'BLIND POUR': m => m.low && m.v <= 1.5,
    'STIR STOP': m => m.low && m.v <= 0.05,
    'ICE CARVING': m => m.v >= 55,
    'CHAMPAGNE LAUNCH': m => m.v >= 280,
    'SHAKE MASTER': m => m.v >= 480,
    'QUICK TAB': m => m.low && m.v <= 21,
    'ORDER UP!': m => m.v >= 8,
    'WHERE IS MY SHOT?': m => m.v >= 8,
    'FRESH SQUEEZE': m => m.v >= 1500,
    'TIP CATCH': m => m.v >= 45,
    'FLY SWAT': m => m.v >= 120,
    'GLASS STACK': m => m.v >= 20,
    'TABLE RUSH': m => m.v >= 6
};
// e2e targets are lower than the defaults so the run stays short
const E2E_TARGET = { 'ICE CARVING': 60, 'CHAMPAGNE LAUNCH': 300, 'ORDER UP!': 8, 'WHERE IS MY SHOT?': 8, 'GLASS STACK': 20, 'TABLE RUSH': 6 };

function chromePath() {
    if (process.env.PINE_CHROME) return process.env.PINE_CHROME;
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (root && fs.existsSync(root)) {
        const shell = fs.readdirSync(root).filter(n => /^chromium_headless_shell-/.test(n)).sort().pop();
        if (shell) { const p = path.join(root, shell, 'chrome-linux', 'headless_shell'); if (fs.existsSync(p)) return p; }
    }
    return undefined;
}

(async () => {
    const server = require('./server.js');
    await new Promise(r => server.listen(port, '127.0.0.1', r));
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true, executablePath: chromePath(), args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    const script = fs.readFileSync(path.join(__dirname, '..', 'dist', 'pine-mini.user.js'), 'utf8');
    const results = {};
    const t0 = Date.now();
    const chunks = Array.from({ length: Math.min(nPages, games.length) }, () => []);
    games.forEach((g, i) => chunks[i % chunks.length].push(g));
    await Promise.all(chunks.map(async (list, pi) => {
        const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
        page.on('console', m => { const t = m.text(); if (/\[PineMini\]/.test(t) && (verbose || /result|playing|target|fired|served|KO|plan|distance|pours/.test(t))) console.log('[p' + pi + ']', t.slice(0, 220)); });
        page.on('pageerror', e => console.log('[p' + pi + ' pageerror]', e.message));
        const cfg = { games: list, loop: false, once: true, board: false, panel: false, howtoWaitMs: 500, resultWaitMs: 300, verbose, e2eTargets: E2E_TARGET };
        await page.addInitScript('window.__pineMiniConfig = ' + JSON.stringify(cfg) + ';\n' + script);
        await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded' });
        const deadline = Date.now() + timeoutS * 1000;
        while (Date.now() < deadline) {
            await page.waitForTimeout(1000);
            const r = await page.evaluate(() => window.pineMini ? window.pineMini.results() : []).catch(() => []);
            for (const x of r) results[x.name] = x;
            if (list.every(g => results[g])) break;
        }
        await page.close();
    }));
    await browser.close();
    server.close();
    let fail = 0;
    for (const g of games) {
        const r = results[g];
        const m = r && r.txt && (() => { const mm = String(r.txt).match(/-?\d+(?:\.\d+)?/); return mm ? { v: parseFloat(mm[0]), low: /[±⏱]/.test(r.txt) } : null; })();
        const ok = !!(m && (!EXPECT[g] || EXPECT[g](m)));
        if (!ok) fail++;
        console.log((ok ? 'PASS ' : 'FAIL ') + g.padEnd(18) + (r ? r.txt + '  (' + (r.ms / 1000).toFixed(1) + 's)' : 'no result'));
    }
    console.log('e2e: ' + (games.length - fail) + '/' + games.length + ' passed in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
