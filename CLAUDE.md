# Pine Bot Minigames — Claude Development Guide

## About This Project

An autonomous record-chasing player for the thirteen mini games on Pine & Co
(pineandco.online, "Bartender's Happy Hour"): Quick Tab, Shake Master, Ice
Carving, Blind Pour, Fresh Squeeze, Champagne Launch, Stir Stop, Where Is My
Shot?, Fly Swat, Order Up!, Table Rush, Tip Catch, Glass Stack. It is a
userscript built from source parts, tested headless and end to end, and
runnable via Violentmonkey/Tampermonkey or Playwright. Sibling of
`changhakim90/pine-bot` (the survivor-mode bot); separate script, own
localStorage namespace (`pineMini_*`).

**How it sees the game.** The mini games' state is closure-private, so the bot
watches what the game *draws*: at `document-start` it wraps
`CanvasRenderingContext2D.prototype` (drawImage/fillText/fillRect/moveTo/
lineTo/arc/ellipse) and `requestAnimationFrame`. Every game frame becomes a
`Frame` of draw ops with absolute canvas coordinates, fill colours and image
names; the active driver reads sprites, HUD numbers and colours from it and
answers with synthetic pointer/keyboard/motion input before the next frame.
Where the game exposes something (`window.__qtT`, `window.__ouSeq`) it is used.

**What it must never do.** Patch game functions, force `Math.random`, rewrite
scores, call the game's submit function, **type a name or press SUBMIT on the
result screen** — it reads the result text, presses OK and moves on. There is
a test that fails the build if `hh_rrSubmit` or `hh_rrName` appears in `dist/`.

## Project Structure

```
src/        the script in six ordered parts (edit these)
              01-core      header, storage, canvas + rAF hooks, Frame model
              02-input     canvas geometry, synthetic pointer/key/motion input
              03-flow      rankMetric, learning store, tuner, leaderboard (GET), scheduler
              04-games-a   Blind Pour, Stir Stop, Ice Carving, Champagne, Shake, Quick Tab, Order Up
              05-games-b   Where Is My Shot, Fresh Squeeze, Tip Catch, Fly Swat, Glass Stack, Table Rush
              06-panel     panel, public API (window.pineMini), boot
dist/       pine-mini.user.js — built output, what the browser installs
test/       run.js (fake browser, unit), server.js (reference page + placeholder art), e2e.js (Playwright, every game)
run/        Playwright runner against the live site
reference/  happyhour.html — the game's real code (see reference/README.md)
CHANGELOG.md
```

## Build & Test

```bash
npm run build     # src/*.js -> dist/pine-mini.user.js, version stamped
npm test          # build + syntax check + headless unit tests
node test/e2e.js  # every game against reference/happyhour.html in headless Chromium (~3 min)
node test/e2e.js --games "STIR STOP,GLASS STACK" --verbose
npm run run       # Playwright against the live site (profile/ keeps what it learned)
```

The e2e needs `playwright` (optional dependency) and a Chromium: `npx playwright
install chromium`, or set `PINE_CHROME` to a headless-shell binary
(`PLAYWRIGHT_BROWSERS_PATH` is also scanned).

## Development Workflow

1. Edit **source files only** in `src/` — never `dist/pine-mini.user.js`.
2. `npm test`, and `node test/e2e.js` for anything touching a driver.
3. Bump the version in `package.json` only — the build stamps `@version` and
   `SCRIPT_VERSION`. Violentmonkey only updates when `@version` grows, so
   **every push to `main` that changes `dist/` must bump it**. CI fails a
   push whose `dist/` is stale.
4. Tag releases `vX.Y.Z`.

## How a driver is written (the rule)

Every number in a driver comes from the game's source in
`reference/happyhour.html` — button ids, the update formulas, draw positions,
scoring. The driver mirrors the game's own per-frame update where timing must
be exact (Stir Stop, Champagne, Blind Pour, Glass Stack) and verifies the
model against what was drawn (Stir Stop checks its temperature against the
HUD colour every frame and counts mismatches). A driver declares:

- `kind`: `precision` (error, floor 0), `capped` (a game-imposed ceiling) or
  `unbounded` (the driver picks a target: the board's #1 + margin, or a default);
- optional `tunables` — small ranges the scheduler explores between plays and
  scores by result (`tune` in `03-flow`);
- `make(ctx) → { frame(F), tick(), stop(), result(m, txt) }`, where `result`
  is where calibration is learned (`learn.ema`).

Never let a driver act on a guess: if the frame does not show what it needs,
it waits.

## Learning

`localStorage.pineMini_learn` keeps per game: plays, best, recent history,
tunable statistics, and calibration (`cal`) — Blind Pour's measured dribble
tail, Champagne's flight ratio, Stir Stop's model-mismatch count. The
scheduler replays games that have not beaten their target (`wantsPlay`),
least-played first, and keeps polishing when `config.loop` is on.
`pineMini.best()` shows where each game stands; `pineMini.reset()` forgets.

## Important Notes

- Version is single source of truth in `package.json`.
- `pineBot.rawBase` in `package.json` is the raw GitHub base used for the
  userscript's `@updateURL`/`@downloadURL`.
- Claude sessions usually cannot reach `pineandco.online`; everything about
  the game must then come from `reference/happyhour.html`.
- Only one bot (this or `pine-bot`) should be active on the page; both wrap
  `requestAnimationFrame`.
