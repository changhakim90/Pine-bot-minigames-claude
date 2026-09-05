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
| Ice Carving | 2,250 BALLS | 17 taps + DONE per ball, several balls per frame (tuned) |
| Champagne Launch | 20,000m planned | pumps power through the launch hold too; flight model calibrates itself |
| Shake Master | 513 (ceiling 520) | feeds the motion listener every 25 ms |
| Quick Tab | ⏱18.9s (floor) | types the total on the first answer frame |
| Order Up! | ROUND n KO (time budget) | punches the whole order in one frame; ends the round when the budget is spent |
| Where Is My Shot? | ROUND n KO (time budget) | follows the cover the shot went under |
| Fresh Squeeze | 1775ml (≈ceiling) | one gesture burst per 421 ms press cycle |
| Tip Catch | 75 | tracks every item's speed, catches the earliest reachable good one |
| Fly Swat | 187 | one shot per fly per frame |
| Glass Stack | n STACKED (time budget) | looks three swings ahead for the frame that lands on the lean-cancelling spot (0.1–1.6 px) |
| Table Rush | STAGE n (until it falls) | receding-horizon search over key plans; in crowded halls spends one hit per stage as 1.5 s of passage (a glass comes back per stage) |

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
| `pause()` / `resume()` | freeze the bot in place and continue (keeps the round) |
| `start()` / `stop()` / `skip()` | begin / tear down / abandon this round |
| `play('GLASS STACK')` | queue one game next |
| `best()` | every game: best, plays, board #1, target, beaten |
| `results()` | the play log |
| `target('CHAMPAGNE LAUNCH', 50000)` | pin an unbounded game to a number; `null` clears it |
| `diag()` | what the driver sees right now, as text — `copy(pineMini.diag())` |
| `speed()` | the frame regime — tells you when a page-speed extension is costing precision |
| `set('loop', false)` | config; persisted. Keys: `games`, `max`, `roundBudgetMin`, `targets`, `loop`, `stopWhenBeaten`, `margin`, `minMargin`, `howtoWaitMs`, `howtoMaxMs`, `stallFrames`, `board`, `verbose`, `panel` |
| `reset()` | forget everything learned |
| `frame` | the last canvas frame (draw ops), for poking at a driver |

Unbounded games (Ice Carving, Champagne, Order Up, Where Is My Shot, Glass
Stack, Table Rush) have no ceiling in the game itself. In **max mode** (the
default) the bot plays each for the most a round allows: Ice Carving as many
balls per frame as the page can take, Champagne 20,000 m, Table Rush until
the game ends it, and the endless rounds (Order Up, Where Is My Shot, Glass
Stack) until a time budget (`roundBudgetMin`, 12 min) is spent — then the
driver ends the round on purpose so the record is as high as the time
allowed. Pin a game to a number with `pineMini.target(game, value)`, or
`pineMini.set('max', false)` to aim at the board's #1 + `margin` instead.
Nothing is ever submitted.

**Reporting a game that misbehaves:** while it is running, paste
`copy(pineMini.diag())` in the console — everything the driver sees (sprites
with positions, HUD texts, frame timing, target, recent results) lands on
your clipboard as text.

**Page-speed extensions.** Every engine computes its physics as
`dt = Math.min(0.05, …)`, so a 100× extension does *not* give 100× — the
simulation advances at most 50 ms per frame (about 3× wall-clock), and each
frame is a coarser step. Unbounded and timed games are fine and finish sooner;
precision suffers, because the bot can only act on frame boundaries: Blind Pour
resolves 0.5 ml per frame instead of 0.17, and Glass Stack's piece jumps ~15 px
between frames instead of ~5. `pineMini.speed()` reports the regime, and results
are tagged with the mean dt. Use the speed-up for the grinding games, and turn
it off for Blind Pour, Stir Stop and Glass Stack.

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
