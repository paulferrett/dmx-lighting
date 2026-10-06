# Show builder

A light show for the four Realsun Beam 150s, built on a timeline over the song,
drawn live in 3D, and run out of the ENTTEC. Claude can build and edit the whole
thing through the `dmx-show` MCP, and you watch it land in the console as it does.

```bash
npm install            # once
npm start              # → http://localhost:8280
npm test               # evaluator, DMX map, time parsing, edit ops, tempo detection
npm run probe          # ask the ENTTEC for serial + firmware (sends no DMX)
```

The MCP (`~/bs/.mcp.json` → `dmx-show`) starts the server itself if it isn't
running, so in practice you open `localhost:8280` and talk to Claude.

## How it fits together

```
          Claude ──MCP──▶ mcp.js ─┐
                                  ├─HTTP─▶ server.js ── shows/*.json (git)
 browser console ◀──WebSocket─────┘           │
   audio = clock                              └──▶ ENTTEC (/dev/cu.usbserial-EN495619)
   lib/engine.js → stage (Three.js)                 ▲
                 → lib/dmx.js → 512 bytes ──────────┘  40 fps, only when output is on
```

- **One evaluator.** `lib/engine.js` turns show + rig + time into what every head
  is doing. The browser runs it to draw the stage *and* to make the DMX, so the
  picture and the light can't disagree. Claude's `show_state_at` runs the same code.
- **The audio is the clock.** The browser plays the song and evaluates at its
  position. Two timers drifting apart over four minutes is the classic failure.
- **Every edit is an op** (`lib/ops.js`), all-or-nothing, validated against
  `lib/schema.js`, one undo step. Timeline drags and Claude's edits go through
  the same path, so undo covers both.
- **Times are musical.** Clips store seconds, but anything you or Claude type can
  be `bar 17`, `bar 17.3`, `chorus 1 + 4 bars`, `1:23.5`. Effects and figures run
  in beats against the show's `bpm` and `offset`.

## The show model

Tracks of clips. Tracks apply top to bottom; a later one overrides only the
attributes it sets. Three clip types:

| Type | What it sets | Fields |
|---|---|---|
| `look` | a state | dimmer, colour, colourSpin, gobo, goboMode, goboSpeed, prism, prismSpeed, strobe, aim, crawl |
| `move` | pan/tilt | figure (circle, figure8, sweep, nod, fan, cross, wave, drift, snap, still), aim, width, height, period (beats), spread, breathe, positions |
| `fx` | brightness / colour / gobo on the beat | effect (pulse, chase, flash, wave, sparkle, colourStep, goboStep), period, spread, decay, duty, floor, level, order |

`aim` is a named target from `rig.json` (heads converge on it), a point
`[x, y, z]`, or `{pan, tilt}` (heads stay parallel). Fades blend from the layer
below; a fade up from black arrives already in its colour.

## Song analysis

`lib/analysis.js`: ffmpeg decodes, then a plain-JS pass finds the tempo, bar 1,
energy per bar in three bands, energy changes on 4-bar phrase lines, and drops.
On synthetic tracks at 92–150 BPM it gets the tempo exact and bar 1 within ~10 ms.
On `rick.mp3` it reads 113.6 BPM and puts the first chorus jump at 0:44.

It hears energy, not words, so it can't tell a verse from a chorus. Claude names
the sections from the shape of the table. `allin1` (see
`../plans/song-to-show.md`) would label them properly, and is the upgrade if the
guessing gets in the way.

## Things that are assumed, not measured

All of these only change the picture, never the DMX:

- **Positions** in `rig.json`: four heads on stands at 1.5 m, 1.6 m apart.
  Measure the real setup and change them, or ask Claude to.
- **Tilt range 180°.** If it's really 180, an upright head can't point below its
  own horizon (`clamped: true` in the state). Check by sweeping tilt 0 → 255.
- **Pan range 540°, beam 4°, motor speeds, strobe 0.5–20 Hz, 3-facet prism.**
- **Gobo shake (64–127)** runs the gobos in reverse; which value lands on which
  gobo isn't checked yet. The README's measurement table is the place to record it.

`panOffset` / `tiltOffset` / `panInvert` / `tiltInvert` per fixture line the
preview up with the real heads once you've seen where DMX centre actually points.

## Running the real rig

Output is off until you turn it on (button top right, or ask Claude). Unplug the
Disco 240 first: two transmitters on one DMX line fight. Turning output off sends
an all-zero frame, so the rig goes dark rather than freezing on the last look.
Channel 5 (pan/tilt speed) is written on every frame, never left to the fixture's
default, which parks it at 128 and makes every move crawl.

## Files

| | |
|---|---|
| `rig.json` | fixtures, positions, groups, aim targets, the measured slot tables |
| `shows/*.json` | the shows — text, diffable, in git |
| `songs/` | audio and its cached `.analysis.json` (not in git) |
| `server.js` | HTTP + WebSocket, show storage, undo, ENTTEC output |
| `mcp.js` | the Claude tools |
| `enttec.js` | DMX USB PRO framing; `--probe` |
| `lib/` | engine, DMX encoding, schema, ops, time parsing, analysis — shared by Node and the browser |
| `web/` | the console: `stage.js` (3D), `timeline.js`, `inspector.js`, `app.js` |
| `test/mcp-call.js` | call any MCP tool from the shell: `node test/mcp-call.js preview_snapshot '{"at":"chorus 1"}' out.jpg` |
