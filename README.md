# Realsun Beam 150 — GDTF fixture definition

A GDTF profile for the Realsun 150W beam moving heads (bought 16 Apr 2026 via
Tokopedia, bundled with the Disco 240 desk).

| File | What it is |
|---|---|
| `Realsun_Beam_150.gdtf` | The fixture definition. Import this into MagicQ / Capture / QLC+. |
| `Realsun_Beam_150_EMU.gdtf` | Same fixture, folded to one ChannelFunction per channel. **Use this one in EMU** — see below. |
| `make_gdtf.py` | Generator. Edit the CONFIG block, re-run, get a new `.gdtf`. |
| `plans/song-to-show.md` | Design for the song-driven show pipeline — analyse a track, design a show, play it out. |
| `show/` | **The show builder** built from that plan: timeline over the song, 3D preview, ENTTEC output, and the `dmx-show` MCP so Claude can design and run shows. See [`show/README.md`](show/README.md). |

Rebuild both with:

```bash
python3 make_gdtf.py Realsun_Beam_150.gdtf
python3 make_gdtf.py --flat
```

## ⚠️ The printed manual is for a different fixture — don't use it

The manual's "9/13 DMX channel Table" says Dimming 1, Strobe 2, Pan 3. **The
actual fixture is Pan 1, Pan fine 2, Tilt 3, Tilt fine 4, and it has 11 channels,
not 13.** Every number in that manual should be treated as a hint only.

Everything below was established empirically by sweeping each slider on the
Disco 240 and watching the fixture.

## The channel map

| Ch | Function | Detail | Source |
|---:|---|---|---|
| 1 | Pan | coarse | desk |
| 2 | Pan fine | | desk |
| 3 | Tilt | coarse | desk |
| 4 | Tilt fine | | desk |
| 5 | **Pan/Tilt speed** | 0 = snap, 255 = crawl | desk |
| 6 | Dimmer | | desk |
| 7 | Strobe | 0–10 open, then slow → fast | desk |
| 8 | Colour | white, red, green, blue, yellow, purple, cyan, orange · then fade/chase between them at varying speed | desk |
| 9 | Gobo | discrete gobos · then shake at varying speed · then scroll at varying speed | desk |
| 10 | Prism | off · on (splits the beam) · then rotate, faster toward full | desk |
| 11 | Auto | fixture runs its own chase, ignores DMX | desk |
| 12–16 | *dead* | confirmed nothing | desk |

### Channel 5 is a trap worth knowing about

Pan/Tilt speed is invisible unless the head is moving, so it reads as a dead
channel. At full the head crawls. Two consequences:

- **Leave it at 0 for normal programming.** If software parks it high, every
  move in the rig feels broken and the cause is not obvious.
- **It's genuinely useful** for slow ambient drifts — you get smooth movement
  without programming long fade times into every cue.

The GDTF defaults it to 0.

## The colour wheel — measured

Slots are **16 DMX values wide**, not the manual's 10:

| DMX | Colour |
|---:|---|
| 0 | White / open |
| 16 | Red |
| 32 | Green |
| 48 | Blue (the darker one) |
| 64 | Yellow |
| 80 | Purple |
| 96 | Cyan (the bright blue) |
| 112 | Orange |
| 128–255 | Fades/chases between colours, speeding up toward full |

Eight slots × 16 = 128 exactly, so the scroll boundary falls where it has to.
Note the gobo wheel uses a *different* width — see below for why.

## The prism — measured

| DMX | Effect |
|---:|---|
| 0–7 | Off |
| 8–127 | Prism in, static — one beam becomes many |
| 128–255 | Prism rotating, speeding up to full |

Note this does **not** use the 16-wide block pattern. It's a binary control with
a small dead zone, then a speed ramp over the whole top half. The 128 boundary
holds though, which is now confirmed on two separate channels.

## The gobo wheel — measured

Slots are **8 DMX values wide** — half the colour wheel's spacing:

| DMX | Gobo |
|---:|---|
| 0 | Open — plain circle, no gobo |
| 8 | Small circle (only slightly smaller) |
| 16 | 2×2 grid of boxes |
| 24 | Star |
| 32 | Flower — 8 petals |
| 40 | Cross |
| 48 | Donut split into three segments |
| 56 | Flower — 6 petals |
| 64–127 | Steps back through the gobos, shaking |
| 128–255 | Scrolls all gobos, speeding up to full |

### Why the two wheels use different widths

Not a mistake, and worth understanding if you ever profile another fixture from
this family:

- **Colour** has no shake function, so its 8 slots spread across 0–127 at 16 each
- **Gobo** needs room for shake, so its 8 slots pack into 0–63 at 8 each, leaving
  64–127 for the reverse-order shake

Both then scroll from 128. Every channel on this fixture lands on 128 as its hard
boundary — colour, gobo and prism alike.

## Everything is now measured

There are no remaining guesses in the DMX map. The only assumptions left are the
physical properties below, which affect rendering only.

Ignore the manual's within-channel ranges entirely (10-wide slots, gobo shake at
80–149, 9 gobos). They describe a different fixture.

## Physical properties — assumed

These affect **only how a visualiser draws the fixture**, never the DMX sent, so
a wrong value here cannot break a show.

| Setting | Assumed | How to check |
|---|---|---|
| `PAN_RANGE` | 540° | Push pan 0 → 255, see how far it sweeps |
| `TILT_RANGE` | 180° | Same with tilt |
| `BEAM_ANGLE` | 4° | It's a beam, so narrow; eyeball against a wall |

## EMU can only drive single-function channels

**Measured 16 Aug 2026, EMU 26.731.2.** Dimmer, pan, tilt and pan/tilt speed
respond. Shutter, colour, gobo and prism do not — they show the right names,
and the Attribute Manager draws the colour wheel with all eight slots in the
right order and the right colours, but nothing moves them. Not the picker, not
the fader.

The split is exactly on how many `<ChannelFunction>` elements the channel has:

| Ch | Function | ChannelFunctions | EMU |
|---:|---|---:|---|
| 1–4 | Pan / Tilt | 1 | works |
| 5 | Pan/Tilt speed | 1 | works |
| 6 | Dimmer | 1 | works |
| 7 | Shutter | 2 | **dead** |
| 8 | Colour | 2 | **dead** |
| 9 | Gobo | 3 | **dead** |
| 10 | Prism | 2 | **dead** |

Nothing else correlates. It isn't the attribute names — EMU's own import record
(`~/Documents/EMU/Preferences/gdtf-library.emulib`, gzipped JSON, worth reading
when EMU misbehaves) shows every channel mapped correctly: channel 8 → `Color1`,
eight presets at 0/16/32/…/112, `wheelSlotIndex` 1–8, colours converted from our
CIE values. It isn't zero-width physical ranges either — the shutter carries
proper ranges on both its functions and is just as dead.

Splitting a channel into several ChannelFunctions is correct GDTF and is what
every real profile does, so this is an EMU importer limitation, not a fault in
the file. Don't "fix" the normal build.

**Fix, confirmed working 16 Aug 2026:** `make_gdtf.py --flat` builds
`Realsun_Beam_150_EMU.gdtf`, which folds each channel down to one
ChannelFunction and expresses everything under it as ChannelSets. It patches as
*Beam 150 EMU* under a different FixtureTypeID. Colour, gobo, prism and strobe
all drive from the Attribute Manager.

Keep the normal build for MagicQ, Capture and QLC+, which handle multi-function
channels properly. Don't "fix" it to match the flat one.

### Speed ramps need cutting into steps

First flat build folded each speed ramp into one ChannelSet — and a ramp with
one step is one speed. Prism rotate came out as on/off with no rate control at
all, because EMU snaps to the set's start value and there's nothing left to
drag.

`RAMP_STEPS` (default 8) cuts every ramp into evenly spaced named steps, step 1
slowest:

| Channel | Steps |
|---|---|
| 7 Shutter | `Strobe 1`–`8` at DMX 11, 41, 72, 102, 133, 164, 194, 225 |
| 8 Colour | `Scroll 1`–`8` at 128, 144 … 240 |
| 9 Gobo | `Shake 1`–`8` at 64, 72 … 120, then `Scroll 1`–`8` at 128 … 240 |
| 10 Prism | `Rotate 1`–`8` at 128, 144 … 240 |

Raise `RAMP_STEPS` if eight speeds isn't fine enough. The colour wheel picker
ignores these — it only draws ChannelSets carrying a `WheelSlotIndex`, so the
ring stays at eight segments however many scroll steps exist.

What's genuinely lost in the flat build is *typing*: strobe Hz, spin rpm and
shake rate stop being physical quantities a visualiser can reason about and
become named steps. Slot selection — the thing you actually program — is
unaffected.

### The strobe panel lives on the attribute, not the channel

Folding channel 7 into a single `Shutter1` function made it drivable and made
EMU's Attribute Manager strobe control disappear — EMU builds that panel from
the `Shutter1Strobe` attribute, and collapsing the channel had taken that
attribute out of the file altogether.

The fix is not a second ChannelFunction (that's what breaks EMU in the first
place). It's typing the *whole* channel as `Shutter1Strobe`: DMX 0 is simply a
strobe rate of zero, which is how the fixture behaves anyway. The LogicalChannel
still carries `Shutter1` as its main attribute, so this stays valid GDTF, and
EMU derives its category from the ChannelFunction rather than the LogicalChannel
— which is exactly how the original two-function build got a Strobe group.

`FLAT_SHUTTER_AS_STROBE = False` reverts to a plain `Shutter1` channel: you lose
the panel, keep the fader. That's the fallback if channel 7 ever goes dead.

The general lesson for this fixture: **a control in the Attribute Manager
appears because of the GDTF attribute name, and works because there is only one
ChannelFunction.** Those are two separate requirements and it's easy to satisfy
one at the cost of the other.

### The Attribute Manager only writes to selected fixtures

Once all four heads are on the same profile and one still won't change colour,
stop looking at the file. The Attribute Manager acts on the **current
selection**, and a selected fixture is drawn with a light outline around its
whole card — an unselected one has no outline. One head changing colour while
the other three sit at Open, all four patched identically, is a selection, not a
mapping.

Shift-click from the first head's header to the last, or marquee-drag across the
cards. Better, build a Group in the Groups panel (bottom right, `+`) so all four
select in one click and it stops being a thing you can forget.

Watch **Spread** at the top of the Colour page while you're there: at *Linear by
DMX address* a multi-fixture selection gets colours spread across it rather than
all taking the one you picked.

### Re-patch every head, not just one

EMU's GDTF library came out of the import holding *only* `Beam 150 EMU`; the old
`Beam 150` was gone. Fixtures already patched against the old profile keep its
behaviour, so a rig where head 1 does everything and heads 2–4 still only do
dimmer and position is not a new fault — those three are on the dead profile.

Delete them from Patch and re-add as *Beam 150 EMU* at 17, 33 and 49. Then zero
channel 5 on each and save it into the default Program: a freshly patched
fixture parks it at 128, which is the pan/tilt-speed trap arriving again.

### While you're in the log: the integrity check

`~/Documents/EMU/logs/` carries this at startup, on 15 and 16 Aug:

```
integrity.check.state. {"detector":"ManufacturerNotAllowed","effect":"ChannelMapOffset"}
```

Not the interface — that one is a genuine ENTTEC. So "manufacturer" most likely
means the *fixture's*: EMU is on the free tier here (`preferences.json` →
`LastKnownLicenseTier: "Free"`, `License.Policy: "Demo"`), Realsun is not in its
licensed library, and the named effect is an offset applied to the channel map.
All unverified — the strings are encrypted and ENTTEC don't document it — but if
the rig ever responds on the wrong channels while EMU's own faders look right,
start here rather than re-measuring the fixture.

## A GDTF gotcha worth remembering

`PositionMSpeed` belongs to **`Control.Control`**, not `Position.PanTilt` — and
so does every other `*MSpeed` attribute (`IntensityMSpeed`, `ColorMixMSpeed`,
`ZoomMSpeed`, `GlobalMSpeed`…). It reads like a Position attribute and it is not.

Getting this wrong doesn't break the file — it validates fine and the DMX still
goes out — but importers stop recognising the channel and display it generically
as "CHANNEL" instead of "Pan/Tilt Speed".

The Position feature group only ever contains: `Pan`, `Tilt`, `PanRotate`,
`TiltRotate`, `PositionEffect`, `PositionEffectRate`, `PositionEffectFade`.

The spec's canonical definition also sets no `PhysicalUnit`, so it's unitless.

### EMU does not import this attribute

Tested both ways — `Position.PanTilt` and the spec-correct `Control.Control` —
and EMU shows channel 5 as a generic **`Channel`** either way, after a clean
delete-and-reimport. ENTTEC don't publish their GDTF attribute mapping, so this
is an EMU importer limitation, not a fault in the file.

Two consequences, one of which bites:

- The label is generic. Cosmetic, ignorable.
- **EMU ignores the channel's default of 0 and parks it at 128** — i.e. half-speed
  crawl — every time you patch a fixture. This is the pan/tilt speed trap arriving
  by the back door.

**Fix:** zero channel 5 on every fixture once, then save that into your default
Program so it loads at 0 every time. Don't rely on remembering.

If the label genuinely matters, EMU's own custom fixture editor *does* offer
"Pan/Tilt speed" in its Position category — you'd define the fixture natively in
EMU instead of importing this GDTF. Keep the GDTF regardless: it's the portable,
spec-correct definition, and it's what MagicQ, Capture and QLC+ will want.

## Addressing

The Disco 240 assigns **16 channels per scanner** whatever the fixture uses, so
its addresses land on 1, 17, 33, 49, … and channels 12–16 of each block go
unused. Harmless.

If you later drive these from a PC instead, you can pack them tighter — 11, 21,
31, … — but only once you've stopped using the Disco 240, or the two addressing
schemes will fight.
