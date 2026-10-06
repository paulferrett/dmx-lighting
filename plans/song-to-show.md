# Song → show: an AI lighting design pipeline

**Status:** written 2026-08-29. Layers 3–4 and the MCP built 2026-10-06 in [`../show/`](../show/README.md), with a browser renderer instead of the Python playout described below (one evaluator for preview and DMX). Song analysis is a lighter pure-JS pass; `allin1` section labels are still to do.

**Goal:** hand the system a song file. It reads the waveform and the lyrics,
works out the structure — intro, verse, chorus, bridge, the drop — and designs a
timed show for the rig. The AI knows where every fixture is and what each one can
do.

**The rig this is for:** 4 × Realsun Beam 150, 11 channels each, addressed 1 / 17
/ 33 / 49. Channel map is measured and machine-readable in
[`make_gdtf.py`](../make_gdtf.py) (`MODES["11 Channel"]`); the measured slot
boundaries are in [`README.md`](../README.md). Output via the ENTTEC DMX USB PRO,
which appears on this machine as `/dev/cu.usbserial-EN495619` — a plain FTDI
serial port.

---

## Why not off-the-shelf

Surveyed 2026-08-28. Everything AI-controllable today is console-shaped:

| What | Interface | Fit |
|---|---|---|
| `ma3-mcp`, `grandma2-mcp` | MCP → grandMA console (Lua/OSC, Telnet) | Real, but it's a full console's machinery for four beams. grandMA3 onPC *is* free. |
| `lacylights-mcp` | MCP → its own control system | Closest in spirit; imports QLC+ files. Still someone else's model of a rig. |
| **QLC+** | headless `-w`, websocket `ws://host:9999/qlcplusWS` — `CH\|<addr>\|<value>`, `QLC+API\|setFunctionStatus\|<id>\|1` | Best buy-not-build option. Build cues in the GUI, fire them by name. No native GDTF import (via Open Fixture Library, or hand-write the `.qxf`). |
| **OLA** | `brew install ola`; `ola_streaming_client -u 1 -d 1,2,255,255`, `ola_usbpro`, `ola_dmxmonitor` | Genuinely CLI-native, speaks ENTTEC USB Pro. But it's *transport* — no cues, no fixture profiles. |

None of them read a song. That's the actual product here, and it sits above
whatever pushes the DMX. The playout layer is the small part.

**Decision: build it.** Three facts make the ENTTEC path shorter than integrating
a controller:

1. The DMX USB PRO protocol is one framed packet — `0x7E`, label `6`, len LSB/MSB,
   `0x00` start code, 512 bytes, `0xE7`. ~30 lines with pyserial.
2. **The Pro has an internal frame buffer and retransmits the last frame at its
   configured 1–40 fps.** So writes can be stateless — no resident process
   bit-banging refreshes. (An Open DMX USB could not do this.)
3. The hard part — the measured channel map — is already done and in a dict.

Keep QLC+ in mind as the fallback if the rig ever grows past what a bespoke
renderer is worth maintaining.

---

## The one architectural call

**The AI designs a score. A deterministic renderer plays it.**

Claude never emits DMX frames. It emits a document that says *"chorus 1: heads fan
wide, cyan, snap on every downbeat; prism in on the drop at 1:47."* The renderer
turns that into 40 fps frames.

Why this and not real-time inference:

- The design becomes reviewable and diffable — a show is a text file in git.
- Iterating costs an edit, not a re-inference.
- Playout is repeatable. The same score gives the same show every time.
- It can be previewed without hardware.

Four layers, each testable alone:

```
song.mp3
  ├─ allin1      → tempo, beats, downbeats, section labels
  ├─ demucs      → stems → per-stem RMS envelopes
  ├─ whisperx    → word-level lyric timings
  └─ derived     → energy curve, builds, drops
        ↓
   song.analysis.json      ← the "understanding" layer
        +
   rig.yaml                ← positions, capabilities, groups
        ↓
   [ Claude designs ] → show.yaml    ← the score
        ↓
   renderer → 40fps frames → preview  |  ENTTEC
```

---

## Layer 1 — the rig model

GDTF describes the fixture *type*. The companion spec **MVR (My Virtual Rig)**
describes *where the fixtures are*: a zip containing `GeneralSceneDescription.xml`,
each fixture instance carrying its address and a transform —

```xml
<Matrix>{1,0,0}{0,1,0}{0,0,1}{6020.9,2838.6,4978.1}</Matrix>
```

— three rotation rows, then XYZ in millimetres. Same shape of job as
`make_gdtf.py`. MVR is read by Capture, MagicQ, grandMA3 and Vectorworks, so it
is the portable answer.

**But start with a hand-written `rig.yaml`.** For four heads it's five minutes'
work, Claude reads it far better than XML, and it can carry things MVR has no slot
for — the measured slot tables, the groups, the notes. Generate MVR as an *export*
when there's a reason to open the rig in a visualiser. Don't let the standard
become the bottleneck.

Sketch (positions below are placeholders — measure the real hang):

```yaml
interface:
  type: enttec_dmx_usb_pro
  port: /dev/cu.usbserial-EN495619
  fps: 40

fixture_types:
  realsun_beam_150:
    channels: 11
    gdtf: ../Realsun_Beam_150.gdtf
    map: {pan: [1,2], tilt: [3,4], ptspeed: 5, dimmer: 6,
          shutter: 7, colour: 8, gobo: 9, prism: 10, auto: 11}
    pan_range: 540      # assumed, affects rendering only
    tilt_range: 180     # assumed
    beam_angle: 4       # assumed
    colours:  {white: 0, red: 16, green: 32, blue: 48,
               yellow: 64, purple: 80, cyan: 96, orange: 112}
    gobos:    {open: 0, small_circle: 8, grid: 16, star: 24,
               flower8: 32, cross: 40, donut3: 48, flower6: 56}
    prism:    {off: 0, in: 64, rotate: [128, 255]}

fixtures:
  - {id: head1, type: realsun_beam_150, address: 1,  pos: [-2.0, 0, 2.5]}
  - {id: head2, type: realsun_beam_150, address: 17, pos: [-0.7, 0, 2.5]}
  - {id: head3, type: realsun_beam_150, address: 33, pos: [ 0.7, 0, 2.5]}
  - {id: head4, type: realsun_beam_150, address: 49, pos: [ 2.0, 0, 2.5]}

groups:
  all:    [head1, head2, head3, head4]
  odds:   [head1, head3]
  evens:  [head2, head4]
  outer:  [head1, head4]
  inner:  [head2, head3]
```

Generate the `fixture_types` block from `MODES` and the README tables rather than
retyping it, so there is one source of truth for the channel map.

---

## Layer 2 — song understanding

| Tool | Gives |
|---|---|
| **[`allin1`](https://github.com/mir-aidj/all-in-one)** — All-In-One Music Structure Analyzer | tempo, beats, **downbeats**, and **functional segment labels — literally `intro` / `verse` / `chorus` / `bridge` / `outro`** with start and end times |
| **Demucs** (`htdemucs`) | stems → per-stem RMS envelopes. Kick energy drives strobes; vocal presence marks where someone is actually singing |
| **WhisperX** | word-level timestamps via wav2vec2 forced alignment |
| derived | energy curve, build detection, drop detection |

`allin1` alone satisfies "know the chorus" — segment labelling is exactly what it
outputs.

### Two things the libraries won't do for you

**"Beat drop" is not a model output.** No MIR package detects it. It is derivable
and reliable, but it's your heuristic: a sharp low-band RMS rise, landing on a
downbeat, preceded by a build (rising spectral centroid with falling low energy).
Maybe 30 lines over the Demucs stems. Write it, tune it against songs you know,
and keep the threshold in the config where you can see it.

**Don't ask Whisper to hear the lyrics.** Singing transcription is poor — it will
confidently return the wrong words. Paste the real lyrics in as text and run
WhisperX in forced-alignment mode against them. You get accurate word timings
instead of a hallucinated transcript.

Output is one `song.analysis.json`. That file, plus `rig.yaml`, is Claude's entire
input.

---

## Layer 3 — the show score

```yaml
song: dancing-in-the-dark.mp3
analysis: dancing-in-the-dark.analysis.json

defaults: {ptspeed: 0, dimmer: 0, colour: white, gobo: open}

sections:
  - at: 41.2
    label: chorus_1
    look:     {colour: cyan, gobo: open, dimmer: 100, ptspeed: 0}
    movement: {figure: fan, width: 60, sync: downbeat}

  - at: 72.8
    label: verse_2
    look:     {colour: blue, gobo: flower8, dimmer: 55, ptspeed: 200}
    movement: {figure: drift, width: 25, sync: none}

hits:
  - at: 107.4
    kind: drop
    do: [prism_in, "strobe_burst 0.4s", "snap_to audience"]

  - every: downbeat
    within: chorus_1
    do: ["colour_step odds"]

  - every: kick
    within: chorus_2
    threshold: 0.7
    do: ["dimmer_bump 1.0 0.12s"]
```

The important property: **cues bind to musical events, not to raw seconds.**
"Every downbeat", "every 4th bar", "on each kick over 0.7". A re-analysis or a
tempo correction then doesn't invalidate the whole design.

Raw timestamps stay available for one-off moments (a specific lyric, a specific
hit) — but they're the exception, not the structure.

---

## Layer 4 — render & playout

One Python process:

- audio via `sounddevice`; **the audio device's playback position is the master
  clock**
- frame loop at 40 fps, evaluating the score at the current time into a 512-byte
  universe
- write to the ENTTEC only on change (the Pro holds and retransmits the last
  frame)

**Build the preview before the playout.** A top-down canvas plus a beam view,
scrubbing in sync with the audio. Without it, every iteration needs the rig
powered up in a dark room — and that friction is what will stop the iterating.
This is the piece that is easiest to underestimate and most responsible for
whether the whole thing gets used.

---

## The design vocabulary

Worth naming, because it shapes what "design" means with this rig. No CMY, no
zoom, no frost — eight fixed colours, eight gobos, prism in/out, strobe. So the
expressive range is **movement and timing**, not colour subtlety.

**Figures:** fan · cross · sweep · ballyhoo (phase-offset figure-8) · snap-to-position
on downbeat · slow drift · beam-out to audience

**Accents:** colour snap on section boundary · gobo shake on a build · prism in on
a drop · strobe on a hit · dimmer bump per kick

**Channel 5 is a creative asset, not just the trap the README warns about.** High
ptspeed gives ambient drift through verses; zero gives snaps on the drop. It
belongs in every section's `look`. It is the single biggest difference between
"lights changing" and "lights dancing".

---

## Traps

1. **Python 3.14.6 (this machine's default) is too new for this stack.** `allin1`
   depends on madmom, which on PyPI still wants numpy <1.20 and Python <3.10.
   Pin the analysis layer to its own `uv venv --python 3.11` and install madmom
   from git, not PyPI. Keep it isolated from everything else on the machine.
   (`beat_this` from CPJKU is the modern alternative if madmom becomes untenable,
   but it's beats only — no section labels.)

2. **Clock sync.** Don't run audio and DMX off separate timers. Take the timecode
   from the audio device's playback position or they will drift apart audibly
   over a four-minute song.

3. **The Disco 240 and the Mac cannot both drive the line.** Two transmitters on
   one cable will fight. One or the other, or a proper merge.

4. **Channel 5 needs zeroing at startup on every head.** A freshly patched fixture
   parks it at 128. The renderer should write it explicitly on the first frame
   rather than assuming a default — this is the same trap that bites in EMU,
   arriving by a different door.

5. **Machine is an M1 Pro.** Demucs and WhisperX will run on MPS but not fast.
   Analysis is a batch step, not interactive — cache `song.analysis.json` and
   never re-run it during design iteration.

---

## Build order

1. **`rig.yaml`** — generated from `MODES` + the README tables. Half a day.
2. **Analysis pipeline** → `song.analysis.json`. **Test this first against songs
   you know well.** The entire design rests on the assumption that section
   detection agrees with your ears; it's cheap to verify and expensive to
   discover late.
3. **Preview renderer** — score → canvas, synced to audio. No hardware.
4. **Playout** — score → ENTTEC. ~30 lines of framing plus the frame loop.
5. **MCP wrapper** — `analyze_song`, `get_rig`, `preview_show`, `run_show`,
   `jump_to(section)`, `blackout`.
6. **MVR export** — only if a visualiser becomes worth having.

Rough shape: analysis a day, renderer and playout two. The preview is the one that
decides whether the rest gets used.

---

## Sources

- [QLC+ web API command list](https://github.com/mcallegari/qlcplus/blob/master/webaccess/res/Test_Web_API.html) · [web interface docs](https://docs.qlcplus.org/v4/advanced/web-interface)
- [OLA command-line tools](https://www.openlighting.org/ola/getting-started/command-line-tools/)
- [ENTTEC DMX USB PRO API v1.44](https://cdn.enttec.com/pdf/assets/70304/70304_DMX_USB_PRO_API.pdf) · [latency & frame buffer KB](https://support.enttec.com/support/solutions/articles/101000395678-latency-on-usb-to-dmx-product) · [DMXEnttecPro](https://github.com/SavinaRoja/DMXEnttecPro)
- [All-In-One Music Structure Analyzer](https://github.com/mir-aidj/all-in-one) · [beat_this](https://github.com/CPJKU/beat_this) · [madmom numpy issue #527](https://github.com/CPJKU/madmom/issues/527)
- [MVR file format definition](https://gdtf-share.com/help/developers/mvr_1_6/file-format-definition/index.html) · [python-mvr](https://github.com/open-stage/python-mvr)
- [ma3-mcp](https://github.com/Pahegi/ma3-mcp) · [grandma2-mcp](https://github.com/drohi-r/grandma2-mcp) · [lacylights-mcp](https://github.com/bbernstein/lacylights-mcp)
