# Pine Bot — Minigames

Record-chasing bot for the thirteen mini games on [Pine & Co](https://pineandco.online/):
Quick Tab · Shake Master · Ice Carving · Blind Pour · Fresh Squeeze · Champagne
Launch · Stir Stop · Where Is My Shot · Fly Swat · Order Up · Table Rush · Tip
Catch · Glass Stack.

It reads the game's real state by name, ticks in lock-step with the game's own
animation frame, and answers with frame-exact synthetic input — a tap the
instant a needle will cross its target, a swat on every fly with its velocity
led, the shell that actually holds the shot. It does not modify the game.

Sibling of [`pine-bot`](https://github.com/changhakim90/pine-bot) (the
survivor-mode bot); same layout and release loop, separate script.

## Layout

```
src/        the script, in six ordered parts (edit these, never dist/)
dist/       pine-mini.user.js — built, committed, what the browser installs
test/       headless tests (fake DOM + game globals, no browser)
run/        Playwright runner — no userscript manager needed
tools/      console-capture.js — grab the game source from DevTools
reference/  the game's captured source, probes, recordings
results/    record log
```

## Install in a browser (Violentmonkey / Tampermonkey)

The build stamps these headers into `dist/pine-mini.user.js` from
`package.json` → `pineBot.rawBase`:

```
// @updateURL    https://raw.githubusercontent.com/changhakim90/Pine-bot-minigames-claude/main/dist/pine-mini.user.js
// @downloadURL  https://raw.githubusercontent.com/changhakim90/Pine-bot-minigames-claude/main/dist/pine-mini.user.js
```

So auto-update needs exactly two things:

1. **Install FROM the raw URL once** (not by pasting the file into the editor):
   open <https://raw.githubusercontent.com/changhakim90/Pine-bot-minigames-claude/main/dist/pine-mini.user.js>
   in the browser that has Violentmonkey — it offers to install.
2. **Every push to `main` bumps the version and commits a rebuilt `dist/`**
   (CI fails the push otherwise). Violentmonkey compares the remote
   `@version` against the installed one and pulls the new file on its own
   schedule — set *Violentmonkey → Settings → Update → check interval* to
   1 hour, or force it from the dashboard's ⟳ button.

Check what the update URL is serving (raw.githubusercontent can lag a push by a few minutes):

```
curl -s https://raw.githubusercontent.com/changhakim90/Pine-bot-minigames-claude/main/dist/pine-mini.user.js | grep -m2 -E '@version|SCRIPT_VERSION'
```

If the survivor bot (`pine-bot`) is also installed, disable one while the
other plays — both hook the page's animation frame.

## Using it

A small panel sits bottom-right. Console API: `pineMini.*`.

| | |
| --- | --- |
| **auto** | drive the detected mini game (default on) |
| **observe** | hooks and panel only, no input |
| **source ⬇** | download every inline script of the page → commit to `reference/` |
| **probe ⬇** | download a JSON summary of the game's internals |
| **rec 15s** | record every changing global for 15 s while *you* play |
| `pineMini.bind('flyswat', { list: 'flies' })` | set a driver's bindings (persisted) |
| `pineMini.set({ inputLeadMs: 8 })` | config (persisted) |
| `pineMini.grep(/Stir Stop/, 400)` | source snippets around a regex |
| `pineMini.G('score')` | read any game global by name |
| `pineMini.best()` | best score seen per game |

## Status

**0.1.0 — framework complete, drivers unbound.** Every driver is written and
tested headless against synthetic state, but none has been run against the
real game yet: the environment this repo was built in cannot reach
`pineandco.online`. The bot therefore stays in OBSERVE on every game until its
bindings resolve. Capture the game once (see `reference/README.md`), commit the
capture, and the next version binds all thirteen.

## Develop

```
npm run build     # src/*.js -> dist/pine-mini.user.js
npm test          # build + syntax check + headless tests
node run/playwright.js [--headless]   # persistent ./profile, downloads → reference/
```

Bump the version in `package.json` only. Tag releases `vX.Y.Z`.
