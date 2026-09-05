# reference/

`happyhour.html` is the game as served by pineandco.online (captured from the
page source on 2026-09-05), trimmed to what the bot needs:

- the survivor title screen is a stub with the same `goHappyHour()` button;
- the `#happyHour` DOM, the `hhOpen()/hhClose()` bridge and the whole
  "Bartender's Happy Hour" script are **verbatim** — every mini game runs
  from its real code;
- the three base64 pong clips are stubbed (`PONG_CLIPS = ["","",""]`).

`test/server.js` serves it with generated placeholder PNGs for every asset,
and `test/e2e.js` plays every game against it in headless Chromium. When the
site changes, recapture the page source and replace this file; the drivers'
constants live in `src/04-games-a.js` / `src/05-games-b.js` with the source
line they came from.
