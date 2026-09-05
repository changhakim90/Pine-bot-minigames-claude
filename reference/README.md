# reference/ — the game's real code

The drivers in `src/04-games.js` are bound to the game's own variable and
function names. Those names come from the game's source, not from guesses,
and the source is captured from the browser because this repo's build
environment cannot reach `pineandco.online`.

Drop these files here and commit them:

| file | how to get it |
| --- | --- |
| `pineandco-inline-scripts.js` | panel **source ⬇** button, or `pineMini.dumpSource()` in the console, or paste `tools/console-capture.js` into the console (works without the userscript) |
| `pine-mini-probe-*.json` | panel **probe ⬇** / `pineMini.dump()` — which games the script mentions (with context), every top-level name and its runtime type, window functions, listeners, canvases |
| `pine-mini-record-*.json` | panel **rec 15s** / `pineMini.record(15)` — play one round by hand while it samples every global per frame; only the globals that changed are kept, which is exactly the list of bindings that game needs |

Capture the probe and the recording **while the mini game is on screen**, one
recording per game. `run/playwright.js` saves the downloads into this folder
automatically.
