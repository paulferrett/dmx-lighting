# Show builder

A light show for the four Realsun Beam 150s, built on a timeline over the song,
drawn live in 3D in the room they're in, and run out of the ENTTEC. Claude can
build and edit the whole thing through the `dmx-show` MCP, and you watch it land
in the console as it does.

```bash
npm install            # once
npm start              # → http://localhost:8280 (no build step)
npm test               # engine, DMX map, rotations, room, time parsing, ops, tempo
npm run typecheck      # the console's TypeScript
npm run probe          # ask the ENTTEC for serial + firmware (sends no DMX)
```

The MCP (`~/bs/.mcp.json` → `dmx-show`) starts the server itself if it isn't
running, so in practice you open `localhost:8280` and talk to Claude.

## Playback and DMX come first

The picture is allowed to stutter; the light and the music are not. So they
don't share a thread with anything that draws:

```
 browser                                 server.js (main thread)          output-worker.js (own thread)
 ───────                                 ───────────────────────          ─────────────────────────────
 <audio>  ── plays on the audio thread
   │  {t, playing, at}  clock readings ──▶ forwards ─────────────────────▶ own copy of show + rig
   │  on play/pause/seek, 5×/s playing     HTTP, Vite, song analysis,      40×/s: evaluate at the
 stage, timeline, panels  (display only)   undo, files, MCP calls          extrapolated clock →
   can drop frames, nothing follows        can stall, nothing follows      ENTTEC DMX USB PRO
```

- **The audio element is the clock.** Each reading says *when* it was taken
  (`at`, wall time), so the worker extrapolates exactly even if a reading
  arrives late behind a slow frame.
- **The worker holds its own copy** of the show and rig and writes the ENTTEC
  itself. Measured: with the server's main thread busy for half a second (a song
  analysis), frames kept coming every 25.9 ms, same as idle.
- **Only a console someone is driving moves the clock.** A newly opened or
  paused console says nothing, and a snapshot for Claude draws a frame without
  touching playback.
- **If the ENTTEC drops off USB**, output stays wanted ("DMX waiting…"), the
  worker looks for it once a second, and frames resume when it's back.

## The console

React + Tailwind + shadcn, served by Vite inside `server.js` (edits reload live).

- **Timeline — vis-timeline.** Tracks and clips; ⌘-scroll or pinch to zoom,
  scroll to pan, drag to move (also between tracks), drag edges to stretch, snap
  to bar / beat / ½ beat (⌥ drag ignores it), overlapping clips stack,
  shift-click to pick several, double-click a lane to add, the red line scrubs,
  section markers drag and rename. 4-bar phrases are shaded.
- **Waveform — wavesurfer.js**, above the timeline and following its zoom, with
  a ruler in bars that lands on the song's bar 1 and a hover readout.
- **Stage — three.js.** Haze beams, gobo streaks, prism splits, beams stopping
  on whatever they hit, gobos projected onto it, heads that move no faster than
  the motors.
- **Rig mode** (top bar → *Rig*): click a head or a room object and move /
  rotate / resize it with three.js's TransformControls (W / E / R, snap 5 cm /
  15°), or type exact numbers in *Rig & room*. Heads take a full 3D rotation —
  upright, hung, on a wall, angled — and the engine aims with the same maths
  the stage draws with (tested against three.js).

## The room

`rig.json → room`: haze, ceiling height (or `null` for open air), and objects:

| kind | what it is |
|---|---|
| `wall` | solid: beams stop on it, gobos land on it |
| `box` | solid too — the DJ booth, a bar, a speaker stack |
| `zone` | an area of floor — the dancefloor, where the crowd is drawn |

Each has `position` (base centre, metres), `size` `[w, h, d]`, `rotation` about
the vertical. Every object is an aim target by its id — a wall's centre, a box's
top, a zone's centre on the floor — so Claude can design to the room: "sweep the
dancefloor", "gobos on the back wall".

## The show model

Tracks of clips. Tracks apply top to bottom; a later one overrides only the
attributes it sets. Three clip types:

| Type | What it sets | Fields |
|---|---|---|
| `look` | a state | dimmer, colour, colourSpin, gobo, goboMode, goboSpeed, prism, prismSpeed, strobe, aim, crawl |
| `move` | pan/tilt | figure (circle, figure8, sweep, nod, fan, cross, wave, drift, snap, still), aim, width, height, period (beats), spread, breathe, positions |
| `fx` | brightness / colour / gobo on the beat | effect (pulse, chase, flash, wave, sparkle, colourStep, goboStep), period, spread, decay, duty, floor, level, order |

`aim` is a target or room object (heads converge on it), a point `[x, y, z]`, or
`{pan, tilt}` (heads stay parallel). Times can be musical everywhere you type
them: `bar 17`, `bar 17.3`, `chorus 1 + 4 bars`, `1:23.5`. Every edit — timeline,
panel or Claude — is one all-or-nothing op batch with undo (`lib/ops.js`).

## Song analysis

`lib/analysis.js`: ffmpeg decodes, then plain JS finds the tempo, bar 1, energy
per bar in three bands, energy changes on 4-bar phrase lines, and drops. Exact
tempo and bar 1 within ~10 ms on synthetic tracks at 92–150 BPM; 113.6 BPM on
`rick.mp3`. It hears energy, not words: Claude names the sections from the
shape. `allin1` (`../plans/song-to-show.md`) is the upgrade for real labels.

## Assumed, not measured

Only the picture depends on these, never the DMX: the head positions until you
place them, tilt range 180° (if real, an upright head can't point below its own
horizon — `clamped: true`), pan 540°, beam 4°, motor speeds, strobe 0.5–20 Hz,
a 3-facet prism, and which gobo each shake value (64–127) lands on.
`panOffset` / `tiltOffset` / invert per head line the preview up with the real
heads once you've seen where DMX centre points.

## Running the real rig

Output is off until you turn it on (top right, or ask Claude). Unplug the Disco
240 first: two transmitters on one DMX line fight. Turning output off sends an
all-zero frame, so the rig goes dark rather than freezing. Channel 5 (pan/tilt
speed) is written on every frame, never left to the fixture's default of 128.

## Testing next to a running show

A second server never needs to touch the real one:

```bash
PORT=8289 SHOW_DATA=/tmp/copy DMX_DEVICE=/nonexistent node server.js
PORT=8289 node test/mcp-call.js preview_snapshot '{"at":"chorus 1"}' out.jpg
```

`SHOW_DATA` points `shows/`, `rig.json` and the open-show state at a copy;
`DMX_DEVICE` pins the serial port (a pty works for output tests). `mcp-call.js`
passes the environment through to `mcp.js` — without that, the MCP SDK drops
`PORT` and the call reaches the real console.

## Files

| | |
|---|---|
| `rig.json` | heads, the room, groups, aim targets, the measured slot tables |
| `shows/*.json` | the shows — text, diffable, in git |
| `songs/` | audio and its cached `.analysis.json` (not in git) |
| `server.js` | HTTP + WebSocket, show storage, undo, the console via Vite |
| `output-worker.js` | the DMX thread |
| `mcp.js` | the Claude tools |
| `enttec.js` | DMX USB PRO framing; `--probe` |
| `lib/` | engine, DMX encoding, rig geometry and room, schema, ops, time parsing, analysis — shared by Node and the browser |
| `web/src/` | the console: `stage/stage.ts`, `components/` (Timeline, StageView, Inspector, RigPanel), `lib/runtime.ts` (clock, frame loop, snapshots) |
| `test/` | `node --test`; `mcp-call.js` calls any MCP tool from the shell |
