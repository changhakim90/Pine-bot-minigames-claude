# Pine Bot Minigames — Claude Development Guide

## About This Project

A record-chasing bot for the thirteen mini games on Pine & Co
(pineandco.online): Quick Tab, Shake Master, Ice Carving, Blind Pour, Fresh
Squeeze, Champagne Launch, Stir Stop, Where Is My Shot, Fly Swat, Order Up,
Table Rush, Tip Catch, Glass Stack. It is a userscript built from source
parts, tested headless, and runnable via Violentmonkey/Tampermonkey or
Playwright. It is a sibling of `changhakim90/pine-bot` (the survivor-mode bot)
and shares its conventions, but it is a separate script with its own
localStorage namespace (`pineMini_*`).

The bot reads the game's real state (module-scope variables by name, via
indirect eval), runs in lock-step with the game's animation frame, and drives
each game with frame-exact synthetic input. It never alters game code, frames
or random draws — it plays with perfect information and perfect timing.

## Project Structure

```
src/        the script in six ordered parts (edit these)
              01-core      header, storage, global access, hooks, discovery
              02-input     canvas geometry + synthetic input
              03-engines   strategy engines (mash, stopAt, hunt, sequence, track, trace)
              04-games     the 13 drivers + their BINDINGS (game variable names)
              05-probe     probe() / record() / dumpSource()
              06-panel     panel, main loop, boot
dist/       pine-mini.user.js — built output, what the browser installs
test/       headless tests (fake DOM + game globals, no browser)
run/        Playwright runner
tools/      console-capture.js — capture the game source with no userscript
reference/  the game's captured source / probe / recordings (commit them)
results/    record log
CHANGELOG.md
```

## Build & Test

```bash
npm run build          # src/*.js -> dist/pine-mini.user.js, version stamped
npm test               # build + syntax check + headless tests
npm run run            # Playwright, headed (downloads land in reference/)
npm run run:headless
```

## Development Workflow

1. Edit **source files only** in `src/` — never `dist/pine-mini.user.js`.
2. Run `npm test` before committing. CI fails a push whose `dist/` is stale,
   so rebuild and commit `dist/` with every source change.
3. Bump the version in `package.json` only — the build stamps `@version` and
   `SCRIPT_VERSION`. Violentmonkey only updates when `@version` grows, so
   **every push to `main` that changes `dist/` must bump it**.
4. Tag releases `vX.Y.Z`.

## How a driver gets written (the rule)

A driver is an engine plus bindings. **Bindings come from the game's source,
never from guessing.** The flow:

1. Capture: `reference/pineandco-inline-scripts.js` (panel *source ⬇* or
   `tools/console-capture.js`), plus a probe and a per-game recording
   (`pineMini.record(15)` while playing one round by hand). See
   `reference/README.md`.
2. Read the game's code for that mini game: its state variables, how input is
   handled (which element, which event family, per-event or per-frame), how
   the score is computed, and any cap (per-frame debounce, max taps, timer).
3. Set the bindings in `DEFAULT_BINDS` (`src/04-games.js`) and, if the
   mechanic needs it, extend the engine — with a headless scenario in
   `test/scenario.js` that reproduces the mechanic with synthetic state.
4. Verify in the browser; log the score in `CHANGELOG.md`.

An unbound driver must stay in OBSERVE. Never make a driver send input it
cannot justify from the game's state.

## What the bot must not do

- Patch game functions, force `Math.random`, rewrite scores, or call
  submit/leaderboard functions directly. It reads state and sends input.
- Run alongside the survivor bot on the same page unless both are idle: they
  do not share storage, but both wrap `requestAnimationFrame`.

## Important Notes

- Version is single source of truth in `package.json`.
- `pineBot.rawBase` in `package.json` is the raw GitHub base used for the
  userscript's `@updateURL`/`@downloadURL`.
- The build environment used by Claude sessions may not be able to reach
  `pineandco.online`; everything about the game must then come from
  `reference/`.
