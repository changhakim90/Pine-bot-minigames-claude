# Changelog

## 0.4.2 — pause actually pauses (2026-09-05)

The panel button and `pineMini.pause()` / `resume()` now freeze the bot in
place — the current round is kept, not abandoned, and how-to / result timers
are shifted so the paused stretch does not count against them. `resume`
continues exactly where it stopped. (`stop()` still tears down fully.)

## 0.4.1 — Stir Stop diagnostics and tolerance (2026-09-05)

- Stir Stop finds its colour chips by size and row (a pixel of drift cannot
  blind it), falls back to steering by colour alone if the model disagrees
  with the HUD repeatedly, and reports when two seconds of stirring have not
  cooled the drink (pointer input not reaching the game).
- `pineMini.diag()` now includes the driver's own state (Stir Stop: phase,
  target, model temperature and spin, mismatches, what it is waiting for).

## 0.4.0 — max mode; Glass Stack and Table Rush fixed for real (2026-09-05)

**Max mode (default).** Every game now plays for the most a round allows.
Precision and capped games already did; the endless ones no longer stop at a
number: Order Up!, Where Is My Shot? and Glass Stack run until a round budget
(`roundBudgetMin`, 12 min) is spent and then end the round on purpose so the
record is as high as the time allowed; Table Rush plays until the game ends
it; Ice Carving makes as many balls per frame as the page can take
(2,250 in 15 s on the reference page, tuned); Champagne plans for 20,000 m.
`pineMini.target(game, n)` still pins a game to a number, `set('max', false)`
restores board-#1-plus-margin targeting.

**Glass Stack** — two real bugs:
- sprite extents were measured along the sprite's own axes, so a piece the
  game draws rotated by −90° (shot glass, pick) reported its height as its
  width; extents are now along the screen axes (unit-tested);
- the piece only exists at discrete frame positions, and with a page-speed
  extension those are ~15 px apart; tapping at the first crossing left errors
  the tray could not absorb. The driver now looks up to three swings ahead for
  the frame that samples nearest the lean-cancelling spot and taps on that
  frame: 40 stacked with placement errors of 0.1–1.6 px and the lean held at
  zero (131 s).

**Table Rush** — plays with its glasses instead of spending them: the hit
budget only opens once the hall is crowded (stage 4+) or the crowd has held
the waiter for most of a second, guests out of reach are pruned from the
search (the 52-guest halls no longer cost frames), and the horizon is a
time (0.35 s) rather than a frame count so a speed-up does not shorten it.
Stage 15 in 92 s.

**Also**
- `copy(pineMini.diag())` — everything a driver sees right now (sprites with
  positions, HUD texts, frame timing, target, recent results) as text on the
  clipboard, for reporting a game that misbehaves;
- panel: the pause button reads *resume* while paused; a ⏳ shows the budget
  left on an endless round;
- test art now has the real sprites' shapes (flat plates, tall glasses and
  people), so rotation and aspect handling are exercised end to end.

## 0.3.0 — sprite names survive keying; nothing waits on artwork (2026-09-05)

**The bug behind "the bot isn't clicking".** The game keys the white background
out of most sprites with `fpKey()`, which draws the image into a canvas and —
whenever the image is wider than that game's `maxW` — copies *that canvas into
a second one*. The bot's sprite naming only followed image→canvas draws, so on
the real site (large artwork) every keyed sprite arrived nameless: Tip Catch
never found `tc_jar` and never moved the jar, Fly Swat never matched
`fs_fly1/2`, Where Is My Shot never found `ws_cover`. The tests missed it
because the placeholder art was 64 px — below every `maxW`, so the downscale
path never ran. Names now follow canvas→canvas draws, the test art is 640 px,
and a unit test asserts the name survives a keyed downscale.

**Nothing waits on artwork any more.** The game only downloads a mini game's
art once its card is picked, so a fast bot (and any page-speed extension, which
compresses the bot's waits but not the network) could start a round before the
sprites existed — and Where Is My Shot, Glass Stack, Order Up and Table Rush
have no clock, so they waited for input forever.

- the bot now warms the same asset URLs the game is about to request and leaves
  the HOW TO PLAY screen when they have settled (a real network event, not a
  timer), up to `howtoMaxMs`;
- Glass Stack reads the rectangles, Table Rush the discs and Where Is My Shot
  the cup geometry that the game draws when a sprite is missing, so a slow load
  degrades the score instead of hanging the round;
- Tip Catch tracks the jar through the game's own lerp when its sprite is late;
- a watchdog leaves any round where the driver has not acted for
  `stallFrames` (3600) frames.

**Champagne Launch aims much further.** Nothing caps `power`, and the game
accepts taps during the launch hold too, so the driver keeps pumping while
there is still room to reach 45°. Default target 300 m → 2000 m; it landed
2696–2700 m, exactly as predicted. Set your own with
`pineMini.target('CHAMPAGNE LAUNCH', 20000)`.

**Also**

- `pineMini.target(game, value)` — per-game target for any unbounded game,
  persisted; `pineMini.target(game, null)` clears it.
- `pineMini.speed()` and a panel line report the frame regime: a page-speed
  extension shows up as dt pinned at the engines' 50 ms cap, which is where
  precision (Blind Pour, Stir Stop, Glass Stack) is lost.
- The panel's *hide* now collapses to a "▸ PineMini" chip that restores it
  (Ctrl+Shift+P still toggles); results record the mean dt and a `fast` flag.

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
