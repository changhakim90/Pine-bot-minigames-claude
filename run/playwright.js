#!/usr/bin/env node
// Run the bot without a userscript manager.
//   npm i playwright && npx playwright install chromium
//   node run/playwright.js [--headless] [--profile DIR] [--url URL]
// A persistent profile keeps the game's localStorage (bindings, config, best
// scores) between launches, exactly like a browser. The script is injected
// with addInitScript, i.e. before the page's own scripts — the same timing as
// @run-at document-start in Violentmonkey.
const path = require('path');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const headless = !!flag('--headless', false);
const url = flag('--url', 'https://pineandco.online/');
const profile = path.resolve(flag('--profile', './profile'));
const script = path.join(__dirname, '..', 'dist', 'pine-mini.user.js');

(async () => {
    const { chromium } = require('playwright');
    const ctx = await chromium.launchPersistentContext(profile, {
        headless,
        viewport: { width: 1100, height: 800 },
        acceptDownloads: true,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    });
    await ctx.addInitScript({ path: script });
    const page = ctx.pages().length ? ctx.pages()[0] : await ctx.newPage();
    page.on('console', m => { const t = m.text(); if (/\[PineMini\]/.test(t)) console.log(t.split('\n')[0]); });
    // probe/record downloads land in reference/ so they can be committed straight away
    page.on('download', async d => { const to = path.join(__dirname, '..', 'reference', d.suggestedFilename()); await d.saveAs(to); console.log('saved', to); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log(`pine-mini: running ${url}, profile ${profile}, headless=${headless}. Ctrl+C to stop.`);
    setInterval(async () => {
        try { const s = await page.evaluate(() => window.pineMini && window.pineMini.status()); if (s) console.log('[status]', s); } catch (e) { }
    }, 10000);
})().catch(e => { console.error(e); process.exit(1); });
