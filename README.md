# Pine Bot — Minigames

Autonomous record-chasing player for the thirteen mini games on
[Pine & Co](https://pineandco.online/) ("Bartender's Happy Hour"):
Quick Tab · Shake Master · Ice Carving · Blind Pour · Fresh Squeeze · Champagne
Launch · Stir Stop · Where Is My Shot? · Fly Swat · Order Up! · Table Rush · Tip
Catch · Glass Stack.

Install it, open the site, and it plays the whole set on its own: it walks the
hub, starts each game, plays it from what the game draws on its canvas,
reads the result, presses **OK** — never a name, never SUBMIT — and goes to
the next one. It reads the public leaderboard to know what #1 is, aims past
it, learns from every result (its pour tail, its cork's flight, its tuned
parameters) and keeps replaying whatever has not beaten its target yet.

Sibling of [`pine-bot`](https://github.com/changhakim90/pine-bot) (the
survivor-mode bot); same layout and release loop, separate script.

## What it gets (reference page, headless, first run — see CHANGELOG)

| game | result | how |
| --- | --- | --- |
| Blind Pour | MASTER ±0.5ml → learns its dribble tail, replays toward ±0.0 | reads the liquid surface each frame, releases when ml + expected tail meets the target |
| Stir Stop | PERFECT ±0.00 | exact simulation of the thermal model, serve on the frame nearest the target |
| Ice Carving | 60 BALLS (target) | 17 taps + DONE per frame, paced to the target |
| Champagne Launch | 301m (target 300) | keeps power topped to what the 45° release will have left; flight model calibrates itself |
| Shake Master | 513 (ceiling 520) | feeds the motion listener every 25 ms |
| Quick Tab | ⏱18.9s (floor) | types the total on the first answer frame |
| Order Up! | ROUND n KO (target) | punches the whole order in one frame, fails on purpose at the target |
| Where Is My Shot? | ROUND n KO (target) | follows the cover the shot went under |
| Fresh Squeeze | 1775ml (≈ceiling) | one gesture burst per 421 ms press cycle |
| Tip Catch | 75 | tracks every item's speed, catches the earliest reachable good one |
| Fly Swat | 187 | one shot per fly per frame |
| Glass Stack | n STACKED (target) | predicts the swing, taps at the crossing that cancels the lean |
| Table Rush | STAGE n (target) | receding-horizon search over key plans; spends one hit per stage as 1.5 s of free passage (a glass comes back per stage) |

## Layout

```
src/        the script, in six ordered parts (edit these, never dist/)
dist/       pine-mini.user.js — built, committed, what the browser installs
test/       run.js (fake browser), server.js + e2e.js (every game in headless Chromium)
run/        Playwright runner — no userscript manager needed
reference/  happyhour.html — the game's real code, used by the tests
```

## Install in a browser (Violentmonkey / Tampermonkey)

The build stamps these headers into `dist/pine-mini.user.js` from
`package.json` → `pineBot.rawBase`:

```
// @updateURL    https://raw.githubusercontent.com/changhakim90/Pine-bot-minigames-claude/main/dist/pine-mini.user.js
// @downloadURL  https://raw.githubusercontent.com/changhakim90/Pine-bot-minigames-claude/main/dist/pine-mini.user.js
```

1. **Install FROM the raw URL once** (not by pasting the file into the editor):
   open <https://raw.githubusercontent.com/changhakim90/Pine-bot-minigames-claude/main/dist/pine-mini.user.js>
   in the browser that has Violentmonkey — it offers to install.
2. Every push to `main` bumps the version and commits a rebuilt `dist/`
   (CI fails the push otherwise). Violentmonkey pulls the new file on its
   own schedule — set *Settings → Update → check interval* to 1 hour, or
   force it from the dashboard's ⟳ button.

If the survivor bot (`pine-bot`) is also installed, disable one while the
other plays — both hook the page's animation frame.

## Using it

Open pineandco.online. The bot presses START, enters the hub and plays.
A panel at bottom-left shows the state, the last result, each game's best,
the board's #1 and a ✓ when beaten (`pause` / `skip` / `board` / `hide`;
Ctrl+Shift+P brings it back).

Console API — `pineMini.*`:

| call | does |
| --- | --- |
| `start()` / `stop()` / `skip()` | control the loop |
| `play('GLASS STACK')` | queue one game next |
| `best()` | every game: best, plays, board #1, target, beaten |
| `results()` | the play log |
| `set('loop', false)` | config; persisted. Keys: `games`, `loop`, `stopWhenBeaten`, `margin`, `minMargin`, `howtoWaitMs`, `board`, `verbose`, `panel` |
| `reset()` | forget everything learned |
| `frame` | the last canvas frame (draw ops), for poking at a driver |

Unbounded games (Ice Carving, Champagne, Order Up, Where Is My Shot, Glass
Stack, Table Rush) aim at the board's #1 × (1 + `margin`) or + `minMargin`,
whichever is larger, and stop there; without a board they use each driver's
default. Nothing is ever submitted — the result stays on your screen.

## Run with Playwright instead

```bash
npm i playwright && npx playwright install chromium
npm run run                 # headed; profile/ keeps what it learned
npm run run:headless
node run/playwright.js --games "STIR STOP" --once --verbose
```

## Development

```bash
npm test            # build + syntax + unit tests
node test/e2e.js    # all 13 games against reference/happyhour.html
```

See `CLAUDE.md` for the rules a driver has to follow.
