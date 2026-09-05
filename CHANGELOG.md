# Changelog

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
