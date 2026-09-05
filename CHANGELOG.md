# Changelog

## 0.2.1 — Table Rush spends hits as passage (2026-09-05)

- Table Rush: the planner now searches three-segment key plans (9³ actions,
  21 frames) and treats a collision as what it is in this game — one glass
  for 1.5 s of invulnerability, with a glass back per cleared stage. It
  spends one hit per stage when that is faster than waiting for a gap, and
  keeps two glasses in reserve. Stage 15 in 80 s on the reference page
  (0.2.0 stalled around stage 8 waiting for gaps).
- Verified at the default targets: Order Up! ROUND 25 KO (5.3 min), Where Is
  My Shot? ROUND 25 KO (3.7 min), Glass Stack 40 STACKED (27 s), Table Rush
  STAGE 15 (81 s). Blind Pour over six plays: ±0.5 ±0.5 ±0.5 ±0.6 ±0.3 ±0.4.
  Tip Catch over four: 80 / 72 / 78 / 94.
- `test/e2e.js`: `--plays N` (play each game N times, learning check) and
  `--targets '{"TABLE RUSH":15}'`.

## 0.2.0 — plays every game by itself, from the canvas (2026-09-05)

Rewrite on the real architecture. The mini games keep their state inside a
nested IIFE, so nothing can be read by name; the bot now watches the game's
own canvas draw calls instead (see CLAUDE.md), and drives all thirteen games
end to end with no bindings, no probing, no guessing.

**Results** — reference page (real game code, placeholder art), headless
Chromium, first run, no leaderboard:

| game | result | note |
| --- | --- | --- |
| Blind Pour | MASTER ±0.5ml | tail model 2.13 ml vs 1.8 observed at first; learned per play, replays toward ±0.0 |
| Stir Stop | PERFECT ±0.00 | 0 model mismatches over the whole round |
| Ice Carving | 60 BALLS! | target 60 (one ball per frame is possible) |
| Champagne Launch | 301m! | target 300 (+2 aimed); flight model predicted 301 |
| Shake Master | 513 SHAKES! | ceiling 520 (one count per 25 ms) |
| Quick Tab | ⏱18.9s | the game's own animations set the floor |
| Order Up! | ROUND 8 KO | target 8 for the test; default 25 |
| Where Is My Shot? | ROUND 8 KO | target 8 for the test; default 25 |
| Fresh Squeeze | 1775ml! | 71 presses of 420 ms in 30 s |
| Tip Catch | 75 POINTS! | tunables: safety, horizon |
| Fly Swat | 187 FLIES! | every fly dies the frame it appears |
| Glass Stack | 20 STACKED! | target 20 for the test; default 40 |
| Table Rush | STAGE 6 | target 6 for the test; default 15; tunable: safety |

**Features**

- Canvas observation: `CanvasRenderingContext2D.prototype` wrapped at
  document-start; every rAF callback's ops (absolute coordinates, fill
  colours, image names — keying canvases inherit the name of the image
  copied into them) become one `Frame` for the driver.
- Hub flow: survivor title → Happy Hour → card → HOW TO PLAY → game →
  result → **OK only** (never the name field, never SUBMIT) → next game.
- Scheduler + learning: per-game best/plays/history, calibration EMAs
  (pour tail, cork flight ratio), a hill-climbing tuner for declared
  tunables, leaderboard read (GET) to set targets for the unbounded games,
  replay of whatever has not beaten its target, polishing loop after.
- Tests: fake-browser unit tests (`test/run.js`) and a Playwright e2e that
  plays all 13 games against `reference/happyhour.html` (`test/e2e.js`),
  both in CI.

**Removed**: the 0.1.0 indirect-eval bindings, engines, probe/recorder and
the survivor-style `G()` access — none of it could see the mini games.

## 0.1.0 — scaffold, hooks, engines, probe (2026-09-05)

The record-chasing bot for the thirteen Pine & Co mini games, as a repo with
the same shape as `pine-bot`: `src/` parts → `dist/pine-mini.user.js`, headless
tests, CI that refuses a stale `dist/`, and `@updateURL`/`@downloadURL` stamped
from `package.json` so Violentmonkey/Tampermonkey pull every push to `main`.

**What works now**

- Runs at `document-start` and wraps `requestAnimationFrame`,
  `EventTarget.addEventListener` and `Math.random` *observationally*: the bot
  ticks in lock-step with the game's own frame, knows which element handles
  which input, and never alters a frame, a listener or a random draw.
- Reads the game's module-scope state by name through an indirect `eval`
  (`pineMini.G('score')`) — the same trick `pine-bot` uses on the survivor
  game, since Pine & Co ships one plain classic script.
- Synthetic input in canvas coordinates: pointer + touch + mouse families
  fired together, drag strokes in one frame, keys, and synthetic
  `devicemotion` when a game listens for shaking.
- Six strategy engines with headless tests: **mash**, **stopAt** (fires on
  the *predicted* crossing, lead-compensated, wrap-aware for spinning
  needles, hold-to-pour aware), **hunt** (velocity-led entity tapping),
  **sequence**, **track** (soonest-landing catch), **trace**.
- Thirteen drivers wired to engines through *bindings* — data naming the
  game's own variables. Candidate names are tried automatically; an unbound
  driver stays in OBSERVE and reports what it is missing. Nothing sends blind
  input.
- Probe / recorder: `dumpSource()`, `dump()`, `grep()`, `source()`,
  `record()` — everything needed to capture the real game and bind each
  driver exactly.

**What is not done** — the bindings. This repo was built from an environment
that cannot reach `pineandco.online`, so no driver has been run against the
real game yet. See `reference/README.md` for the one-click capture; the next
version binds every driver from that capture.

No records claimed.
