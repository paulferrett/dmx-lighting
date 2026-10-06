#!/usr/bin/env python3
"""
Build a GDTF fixture definition for the Realsun 150W Beam moving head.

Channel data measured on the Disco 240 desk -- see README.md. The printed
manual describes a different fixture and is not used.

Usage:  python3 make_gdtf.py [output.gdtf]
        python3 make_gdtf.py --flat [output.gdtf]

--flat builds the EMU workaround variant. See FLAT below.
"""

import sys
import zipfile
from xml.sax.saxutils import escape

# ---------------------------------------------------------------------------
# FLAT -- the EMU workaround
#
# EMU cannot drive any DMX channel whose LogicalChannel holds more than one
# ChannelFunction. Measured 16 Aug 2026 against EMU 26.731.2: pan, tilt,
# pan/tilt speed and dimmer (one function each) respond; shutter, colour, gobo
# and prism (two or three functions each) show the right names, render the
# right colour wheel in the Attribute Manager -- and will not move, by fader or
# by picker. The split is exactly on the function count, nothing else.
#
# Subdividing a channel into several ChannelFunctions is correct GDTF and is
# what every real profile does, so this is an EMU importer limitation, not a
# fault in the file. --flat works around it by folding each channel down to a
# single ChannelFunction and expressing everything below it as ChannelSets.
#
# The cost is semantic detail: strobe Hz, wheel-spin rpm and shake rate stop
# being typed physical quantities and become named steps. Slot selection --
# which is what you actually program -- is unaffected. Keep the normal build
# for MagicQ / Capture / QLC+, which handle multi-function channels properly.
# ---------------------------------------------------------------------------
FLAT = False

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

MANUFACTURER = "Realsun"
NAME = "Beam 150"
SHORT_NAME = "B150"
LONG_NAME = "Realsun Beam 150W Moving Head"
FIXTURE_TYPE_ID = "3F2A6C10-8B41-4E7D-9C55-1A0E2D7B4F91"

# Physical. Not stated in the pages of the manual we have -- these are typical
# for this class of 150W beam. They only affect how the visualiser renders the
# fixture and its travel limits, never the DMX values it sends.
PAN_RANGE = 540.0        # degrees, total sweep
TILT_RANGE = 180.0       # degrees, total sweep
BEAM_ANGLE = 4.0         # degrees
POWER_W = 150.0
LUMINOUS_FLUX = 4500.0
COLOR_TEMP = 8500.0

# Colour wheel. Order OBSERVED on the desk: white, red, green, blue, yellow,
# purple, cyan, orange. (Note this is NOT the manual's implied order.) Values
# are CIE xyY -- only the visualiser's rendering depends on them.
COLOR_SLOTS = [
    ("Open",   "0.312700,0.329000,100.000000"),
    ("Red",    "0.640000,0.330000,21.260000"),
    ("Green",  "0.300000,0.600000,71.520000"),
    ("Blue",   "0.150000,0.060000,7.220000"),
    ("Yellow", "0.419300,0.505300,92.780000"),
    ("Purple", "0.280000,0.140000,20.000000"),
    ("Cyan",   "0.224600,0.328700,78.740000"),
    ("Orange", "0.500000,0.430000,40.000000"),
]

# Gobo wheel, MEASURED by eye. 8 slots, 8 DMX values apart.
GOBO_SLOTS = [
    "Open",             #  0  plain circle -- no gobo
    "Small Circle",     #  8  slightly smaller circle
    "4-Box Grid",       # 16  two-by-two grid of boxes
    "Star",             # 24
    "Flower 8-Petal",   # 32
    "Cross",            # 40
    "Segmented Donut",  # 48  donut split into three portions
    "Flower 6-Petal",   # 56
]

# --- Wheel range boundaries -------------------------------------------------
# Both wheels MEASURED. They use DIFFERENT slot widths, which is not a mistake:
#
#   Colour has no shake function, so its 8 slots spread over 0-127 at 16 each.
#   Gobo needs room for shake, so its 8 slots pack into 0-63 at 8 each, leaving
#   64-127 for the reverse-order shake. Both then scroll from 128 to full.
#
# Colours snap at 0 white, 16 red, 32 green, 48 blue, 64 yellow, 80 purple,
# 96 cyan, 112 orange. Gobos snap at 0 open, 8 small circle, 16 grid, and on
# in 8s. Everything lands on 128, which is this firmware's hard boundary.
COLOR_SLOT_WIDTH = 16    # MEASURED
GOBO_SLOT_WIDTH = 8      # MEASURED
COLOR_SCROLL_FROM = 128  # MEASURED -- fade/chase between colours, slow -> fast
GOBO_SHAKE_FROM = 64     # MEASURED -- steps back through the gobos, shaking
GOBO_SCROLL_FROM = 128   # MEASURED -- scrolls all gobos, slow -> fast
# Prism is MEASURED and does NOT follow the 16-wide block pattern -- it is a
# binary control with a small dead zone, then a speed ramp over the whole top
# half. 0-7 off, 8-127 prism in (static), 128-255 rotating, slow -> fast.
PRISM_ON_FROM = 8        # MEASURED
PRISM_ROTATE_FROM = 128  # MEASURED

# --- Flat-build ramp resolution ---------------------------------------------
# Only used by --flat. A speed ramp folded into a single ChannelSet gives you
# exactly one speed: the host snaps to the set's start value and there is
# nothing left to drag. Cutting each ramp into evenly spaced named steps gives
# the speed control back. Step 1 is slowest.
RAMP_STEPS = 8

# Only used by --flat. Folding channel 7 down to a single Shutter1 function
# takes the Shutter1Strobe attribute out of the file entirely, and EMU builds
# its Attribute Manager strobe control from that attribute -- so the control
# vanishes. Typing the whole channel as Shutter1Strobe instead keeps it: DMX 0
# is simply a strobe rate of zero, which is how the fixture behaves anyway.
# If channel 7 ever goes dead after an import, set this False and rebuild --
# you lose the strobe panel but keep the fader, which is the safe fallback.
FLAT_SHUTTER_AS_STROBE = True

# The manual's within-channel ranges (10-wide slots, gobo shake at 80-149) do
# not describe this fixture at all -- its slots are 16 wide. Disregard them.

# ---------------------------------------------------------------------------
# CHANNEL LAYOUT
#
# *** THE PRINTED MANUAL DOES NOT MATCH THIS FIXTURE. ***
#
# The manual's "9/13 DMX channel Table" puts Dimming on 1, Strobe on 2 and Pan
# on 3. Testing on the Disco 240 desk showed Pan on 1, Pan fine 2, Tilt 3, Tilt
# fine 4 -- so the manual is for a sibling model. Every row of it is suspect,
# not just the ones already disproved.
#
# The real layout, established by sweeping every slider on the Disco 240. The
# fixture is an 11-channel unit: 12 and 13 do nothing, so the manual's "Auto
# speed" and "Reset" channels do not exist here.
#
#   ch 5 is Pan/Tilt speed, confirmed by raising it to full and then swinging
#   pan -- the head crawls. It must default to 0 (= fastest); anything else and
#   every move in the rig feels broken.
# ---------------------------------------------------------------------------
MODES = {
    "11 Channel": {
        "pan": [1, 2],          # CONFIRMED  coarse + fine
        "tilt": [3, 4],         # CONFIRMED  coarse + fine
        "ptspeed": [5],         # CONFIRMED  0 = snap, 255 = crawl
        "dimmer": [6],          # CONFIRMED
        "shutter": [7],         # CONFIRMED  strobe
        "color": [8],           # CONFIRMED
        "gobo": [9],            # CONFIRMED
        "prism": [10],          # CONFIRMED
        "auto": [11],           # CONFIRMED  self-running chase
    },
    # 12-16 confirmed dead. The manual's 9-channel mode came from the same wrong
    # chart and has been removed rather than left in as a trap.
}

# ---------------------------------------------------------------------------
# GDTF construction
# ---------------------------------------------------------------------------

MATRIX_IDENTITY = ("{1.000000,0.000000,0.000000,0.000000}"
                   "{0.000000,1.000000,0.000000,0.000000}"
                   "{0.000000,0.000000,1.000000,0.000000}"
                   "{0.000000,0.000000,0.000000,1.000000}")


def dmx(value, byte_count):
    """GDTF DMX value literal, e.g. 128/1 or 32768/2."""
    return f"{value}/{byte_count}"


def channel_sets(sets):
    """Emit <ChannelSet> rows.

    For wheel slots the physical value is pinned to the slot index, and the
    parent function's physical range spans 1..n. That makes "user picked slot 3"
    a direct physical -> DMX lookup for the host, which is what a semantic
    colour/gobo picker needs in order to write a value back.
    """
    out = []
    for name, frm, byte_count, slot in sets:
        attrs = f'DMXFrom="{dmx(frm, byte_count)}"'
        if name:
            attrs += f' Name="{escape(name)}"'
        if slot:
            attrs += (f' PhysicalFrom="{slot:.6f}" PhysicalTo="{slot:.6f}"'
                      f' WheelSlotIndex="{slot}"')
        out.append(f"              <ChannelSet {attrs}/>")
    return "\n".join(out)


def ramp_sets(label, start, end, byte_count):
    """Cut a speed ramp into evenly spaced ChannelSets, slowest first."""
    span = end + 1 - start
    return [(f"{label} {i + 1}", start + i * span // RAMP_STEPS, byte_count, None)
            for i in range(RAMP_STEPS)]


def build_channel(key, offsets):
    """Return the <DMXChannel> XML for one logical function."""
    n = len(offsets)
    offset_attr = ",".join(str(o) for o in offsets)
    hi = (1 << (8 * n)) - 1

    def wrap(geometry, attribute, default, functions):
        chan_name = f"{geometry}_{attribute}"
        initial = f"{chan_name}.{attribute}.{functions[0]['name']}"
        body = []
        # Group functions by their logical channel (the attribute of the first).
        body.append(f'      <LogicalChannel Attribute="{attribute}" '
                    f'DMXChangeTimeLimit="0" Master="None" MibFade="0" Snap="No">')
        for f in functions:
            fn = (f'        <ChannelFunction Attribute="{f["attribute"]}" '
                  f'DMXFrom="{dmx(f["from"], n)}" Default="{dmx(f.get("default", f["from"]), n)}" '
                  f'Name="{escape(f["name"])}" OriginalAttribute="" '
                  f'PhysicalFrom="{f["pfrom"]}" PhysicalTo="{f["pto"]}" RealFade="0"')
            if f.get("wheel"):
                fn += f' Wheel="{f["wheel"]}"'
            if f.get("sets"):
                body.append(fn + ">")
                body.append(channel_sets(f["sets"]))
                body.append("        </ChannelFunction>")
            else:
                body.append(fn + "/>")
        body.append("      </LogicalChannel>")
        inner = "\n".join(body)
        return (f'    <DMXChannel DMXBreak="1" Default="{dmx(default, n)}" Geometry="{geometry}" '
                f'Highlight="None" InitialFunction="{initial}" Offset="{offset_attr}">\n'
                f'{inner}\n    </DMXChannel>')

    if key == "dimmer":
        return wrap("Beam", "Dimmer", 0, [dict(
            attribute="Dimmer", name="Dimmer", **{"from": 0}, pfrom="0.000000", pto="1.000000")])

    if key == "shutter":
        # 0-10 no strobe (open), 11-255 strobe slow -> fast
        if FLAT:
            strobe = FLAT_SHUTTER_AS_STROBE
            return wrap("Beam", "Shutter1", 0, [dict(
                attribute="Shutter1Strobe" if strobe else "Shutter1",
                name="Strobe" if strobe else "Shutter", **{"from": 0},
                pfrom="0.000000", pto="20.000000" if strobe else "1.000000",
                sets=[("Open", 0, n, None)] + ramp_sets("Strobe", 11, 255, n))])
        return wrap("Beam", "Shutter1", 0, [
            dict(attribute="Shutter1", name="Open", **{"from": 0}, pfrom="0.000000", pto="1.000000",
                 sets=[("Open", 0, n, None)]),
            dict(attribute="Shutter1Strobe", name="Strobe", **{"from": 11}, pfrom="0.500000", pto="20.000000"),
        ])

    if key == "pan":
        half = PAN_RANGE / 2.0
        default = (hi + 1) // 2
        return wrap("Yoke", "Pan", default, [dict(
            attribute="Pan", name="Pan", **{"from": 0}, default=default,
            pfrom=f"{-half:.6f}", pto=f"{half:.6f}")])

    if key == "tilt":
        half = TILT_RANGE / 2.0
        default = (hi + 1) // 2
        return wrap("Head", "Tilt", default, [dict(
            attribute="Tilt", name="Tilt", **{"from": 0}, default=default,
            pfrom=f"{-half:.6f}", pto=f"{half:.6f}")])

    if key == "ptspeed":
        # PositionMSpeed lives under Control.Control per the GDTF spec, NOT under
        # Position.PanTilt -- every *MSpeed attribute does. Getting this wrong
        # makes importers fail to recognise the channel and show it generically.
        # The spec's canonical definition sets no PhysicalUnit, so it is unitless.
        return wrap("Base", "PositionMSpeed", 0, [dict(
            attribute="PositionMSpeed", name="Pan/Tilt Speed", **{"from": 0},
            pfrom="0.000000", pto="1.000000")])

    if key == "color":
        sets = [(nm, i * COLOR_SLOT_WIDTH, n, i + 1) for i, (nm, _) in enumerate(COLOR_SLOTS)]
        if FLAT:
            return wrap("Beam", "Color1", 0, [dict(
                attribute="Color1", name="Colour", **{"from": 0},
                pfrom="1.000000", pto=f"{len(COLOR_SLOTS) + 1:.6f}", wheel="ColorWheel",
                sets=sets + ramp_sets("Scroll", COLOR_SCROLL_FROM, 255, n))])
        return wrap("Beam", "Color1", 0, [
            dict(attribute="Color1", name="Colour", **{"from": 0},
                 pfrom="1.000000", pto=f"{len(COLOR_SLOTS):.6f}",
                 wheel="ColorWheel", sets=sets),
            dict(attribute="Color1WheelSpin", name="Colour Scroll", **{"from": COLOR_SCROLL_FROM},
                 pfrom="0.000000", pto="60.000000", wheel="ColorWheel"),
        ])

    if key == "gobo":
        sets = [(nm, i * GOBO_SLOT_WIDTH, n, i + 1) for i, nm in enumerate(GOBO_SLOTS)]
        if FLAT:
            return wrap("Beam", "Gobo1", 0, [dict(
                attribute="Gobo1", name="Gobo", **{"from": 0},
                pfrom="1.000000", pto=f"{len(GOBO_SLOTS) + 2:.6f}", wheel="GoboWheel",
                sets=sets
                + ramp_sets("Shake", GOBO_SHAKE_FROM, GOBO_SCROLL_FROM - 1, n)
                + ramp_sets("Scroll", GOBO_SCROLL_FROM, 255, n))])
        return wrap("Beam", "Gobo1", 0, [
            dict(attribute="Gobo1", name="Gobo", **{"from": 0},
                 pfrom="1.000000", pto=f"{len(GOBO_SLOTS):.6f}",
                 wheel="GoboWheel", sets=sets),
            dict(attribute="Gobo1WheelShake", name="Gobo Shake", **{"from": GOBO_SHAKE_FROM},
                 pfrom="0.500000", pto="10.000000", wheel="GoboWheel"),
            dict(attribute="Gobo1WheelSpin", name="Gobo Scroll", **{"from": GOBO_SCROLL_FROM},
                 pfrom="0.000000", pto="60.000000", wheel="GoboWheel"),
        ])

    if key == "prism":
        if FLAT:
            return wrap("Beam", "Prism1", 0, [dict(
                attribute="Prism1", name="Prism", **{"from": 0},
                pfrom="1.000000", pto="3.000000", wheel="Prism",
                sets=[("Prism Off", 0, n, 1), ("Prism On", PRISM_ON_FROM, n, 2)]
                + ramp_sets("Rotate", PRISM_ROTATE_FROM, 255, n))])
        return wrap("Beam", "Prism1", 0, [
            dict(attribute="Prism1", name="Prism", **{"from": 0},
                 pfrom="1.000000", pto="2.000000",
                 wheel="Prism",
                 sets=[("Prism Off", 0, n, 1), ("Prism On", PRISM_ON_FROM, n, 2)]),
            dict(attribute="Prism1PosRotate", name="Prism Rotate", **{"from": PRISM_ROTATE_FROM},
                 pfrom="0.000000", pto="60.000000", wheel="Prism"),
        ])

    if key == "auto":
        sets = [("No effect", 0, n, None)]
        for i in range(4):
            sets.append((f"Auto {i + 1}", 30 + i * 30, n, None))
        for i in range(4):
            sets.append((f"Sound {i + 1}", 150 + i * 30, n, None))
        return wrap("Base", "Control1", 0, [dict(
            attribute="Control1", name="Auto Programs", **{"from": 0},
            pfrom="0.000000", pto="1.000000", sets=sets)])

    if key == "autospeed":
        return wrap("Base", "Control2", 0, [dict(
            attribute="Control2", name="Auto Speed", **{"from": 0},
            pfrom="0.000000", pto="1.000000")])

    if key == "reset":
        return wrap("Base", "Control3", 0, [dict(
            attribute="Control3", name="Reset", **{"from": 0},
            pfrom="0.000000", pto="1.000000",
            sets=[("No effect", 0, n, None), ("Reset after 3s", 250, n, None)])])

    raise ValueError(f"unknown channel key: {key}")


def build_mode(name, layout):
    # Emit in address order, so remapping a channel in MODES needs no other edit.
    order = sorted(layout, key=lambda k: layout[k][0])
    chans = [build_channel(k, layout[k]) for k in order]
    return (f'  <DMXMode Description="" Geometry="Base" Name="{escape(name)}">\n'
            f'   <DMXChannels>\n' + "\n".join(chans) + "\n   </DMXChannels>\n"
            f'   <Relations/>\n   <FTMacros/>\n  </DMXMode>')


def build_description():
    colors = "\n".join(
        f'    <Slot Color="{cie}" Name="{escape(nm)}"/>' for nm, cie in COLOR_SLOTS)
    gobos = "\n".join(
        f'    <Slot Color="0.312700,0.329000,100.000000" Name="{escape(nm)}"/>' for nm in GOBO_SLOTS)
    modes = "\n".join(build_mode(nm, layout) for nm, layout in MODES.items())

    return f"""<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<GDTF DataVersion="1.2">
 <FixtureType CanHaveChildren="Yes" Description="{escape(LONG_NAME)}" FixtureTypeID="{FIXTURE_TYPE_ID}" LongName="{escape(LONG_NAME)}" Manufacturer="{escape(MANUFACTURER)}" Name="{escape(NAME)}" RefFT="" ShortName="{escape(SHORT_NAME)}" Thumbnail="">
  <AttributeDefinitions>
   <ActivationGroups>
    <ActivationGroup Name="PanTilt"/>
    <ActivationGroup Name="Gobo1"/>
   </ActivationGroups>
   <FeatureGroups>
    <FeatureGroup Name="Dimmer" Pretty="Dimmer"><Feature Name="Dimmer"/></FeatureGroup>
    <FeatureGroup Name="Position" Pretty="Position"><Feature Name="PanTilt"/></FeatureGroup>
    <FeatureGroup Name="Gobo" Pretty="Gobo"><Feature Name="Gobo"/></FeatureGroup>
    <FeatureGroup Name="Color" Pretty="Colour"><Feature Name="Color"/></FeatureGroup>
    <FeatureGroup Name="Beam" Pretty="Beam"><Feature Name="Beam"/></FeatureGroup>
    <FeatureGroup Name="Control" Pretty="Control"><Feature Name="Control"/></FeatureGroup>
   </FeatureGroups>
   <Attributes>
    <Attribute Feature="Dimmer.Dimmer" Name="Dimmer" PhysicalUnit="LuminousIntensity" Pretty="Dim"/>
    <Attribute Feature="Beam.Beam" Name="Shutter1" PhysicalUnit="None" Pretty="Sh1"/>
    <Attribute Feature="Beam.Beam" MainAttribute="Shutter1" Name="Shutter1Strobe" PhysicalUnit="Frequency" Pretty="Strobe"/>
    <Attribute ActivationGroup="PanTilt" Feature="Position.PanTilt" Name="Pan" PhysicalUnit="Angle" Pretty="P"/>
    <Attribute ActivationGroup="PanTilt" Feature="Position.PanTilt" Name="Tilt" PhysicalUnit="Angle" Pretty="T"/>
    <Attribute Feature="Control.Control" Name="PositionMSpeed" Pretty="Pos MSpeed"/>
    <Attribute Feature="Color.Color" Name="Color1" PhysicalUnit="None" Pretty="C1"/>
    <Attribute Feature="Color.Color" MainAttribute="Color1" Name="Color1WheelSpin" PhysicalUnit="AngularSpeed" Pretty="C1 Spin"/>
    <Attribute ActivationGroup="Gobo1" Feature="Gobo.Gobo" Name="Gobo1" PhysicalUnit="None" Pretty="G1"/>
    <Attribute ActivationGroup="Gobo1" Feature="Gobo.Gobo" MainAttribute="Gobo1" Name="Gobo1WheelShake" PhysicalUnit="Frequency" Pretty="G1 Shake"/>
    <Attribute ActivationGroup="Gobo1" Feature="Gobo.Gobo" MainAttribute="Gobo1" Name="Gobo1WheelSpin" PhysicalUnit="AngularSpeed" Pretty="G1 Spin"/>
    <Attribute Feature="Beam.Beam" Name="Prism1" PhysicalUnit="None" Pretty="Prism1"/>
    <Attribute Feature="Beam.Beam" MainAttribute="Prism1" Name="Prism1PosRotate" PhysicalUnit="AngularSpeed" Pretty="Prism1 Rot"/>
    <Attribute Feature="Control.Control" Name="Control1" PhysicalUnit="None" Pretty="Auto"/>
    <Attribute Feature="Control.Control" Name="Control2" PhysicalUnit="None" Pretty="Auto Speed"/>
    <Attribute Feature="Control.Control" Name="Control3" PhysicalUnit="None" Pretty="Reset"/>
   </Attributes>
  </AttributeDefinitions>
  <Wheels>
   <Wheel Name="ColorWheel">
{colors}
   </Wheel>
   <Wheel Name="GoboWheel">
{gobos}
   </Wheel>
   <Wheel Name="Prism">
    <Slot Color="0.312700,0.329000,100.000000" Name="Open"/>
    <Slot Color="0.312700,0.329000,100.000000" Name="Prism">
     <Facet Color="0.312700,0.329000,100.000000" Rotation="{1.000000,0.000000,0.000000}{0.000000,1.000000,0.000000}{0.000000,0.000000,1.000000}"/>
     <Facet Color="0.312700,0.329000,100.000000" Rotation="{1.000000,0.000000,0.000000}{0.000000,1.000000,0.000000}{0.000000,0.000000,1.000000}"/>
     <Facet Color="0.312700,0.329000,100.000000" Rotation="{1.000000,0.000000,0.000000}{0.000000,1.000000,0.000000}{0.000000,0.000000,1.000000}"/>
   </Slot>
   </Wheel>
  </Wheels>
  <PhysicalDescriptions>
   <Emitters/>
   <Filters/>
   <ColorSpace Mode="sRGB"/>
   <DMXProfiles/>
   <Properties>
    <OperatingTemperature High="45.000000" Low="0.000000"/>
    <Weight Value="14.000000"/>
    <PowerConsumption Value="{POWER_W:.6f}"/>
   </Properties>
  </PhysicalDescriptions>
  <Models>
   <Model Height="0.120000" Length="0.230000" Name="Base" PrimitiveType="Base" Width="0.230000"/>
   <Model Height="0.230000" Length="0.230000" Name="Yoke" PrimitiveType="Yoke" Width="0.180000"/>
   <Model Height="0.260000" Length="0.180000" Name="Head" PrimitiveType="Head" Width="0.180000"/>
  </Models>
  <Geometries>
   <Base Model="Base" Name="Base" Position="{MATRIX_IDENTITY}">
    <Axis Model="Yoke" Name="Yoke" Position="{MATRIX_IDENTITY}">
     <Axis Model="Head" Name="Head" Position="{MATRIX_IDENTITY}">
      <Beam BeamAngle="{BEAM_ANGLE:.6f}" BeamRadius="0.045000" BeamType="Beam" ColorRenderingIndex="80" ColorTemperature="{COLOR_TEMP:.6f}" FieldAngle="{BEAM_ANGLE:.6f}" LampType="LED" LuminousFlux="{LUMINOUS_FLUX:.6f}" Model="Head" Name="Beam" Position="{MATRIX_IDENTITY}" PowerConsumption="{POWER_W:.6f}" RectangleRatio="1.777800" ThrowRatio="1.000000"/>
     </Axis>
    </Axis>
   </Base>
  </Geometries>
  <DMXModes>
{modes}
  </DMXModes>
  <Revisions>
   <Revision Date="2026-08-15T12:00:00" Text="Built from the manual's 9/13 DMX channel table." UserID="0"/>
  </Revisions>
 </FixtureType>
</GDTF>
"""


def validate(xml):
    """Fail the build rather than ship a file that silently half-works.

    The zero-width-range check exists because of a real bug: giving a slot
    selection function PhysicalFrom == PhysicalTo == 0 produces a file that
    validates, imports cleanly, shows the right channel names -- and then pins
    those channels at DMX 0 forever, because the host has no range to move the
    control across. It looked exactly like a DMX addressing fault.
    """
    import xml.etree.ElementTree as ET

    ft = ET.fromstring(xml).find("FixtureType")
    attrs = {a.get("Name") for a in ft.iter("Attribute")}
    wheels = {w.get("Name") for w in ft.iter("Wheel")}
    geoms = {g.get("Name") for g in ft.find("Geometries").iter() if g.get("Name")}
    problems = []

    for mode in ft.iter("DMXMode"):
        chans = list(mode.find("DMXChannels"))
        offsets = [int(o) for c in chans for o in c.get("Offset").split(",")]
        if sorted(offsets) != list(range(1, max(offsets) + 1)):
            problems.append(f"{mode.get('Name')}: offsets not contiguous {sorted(offsets)}")
        for c in chans:
            if c.get("Geometry") not in geoms:
                problems.append(f"unknown geometry {c.get('Geometry')}")
            for lc in c:
                prev = -1
                if FLAT and len(lc) > 1:
                    problems.append(f"{mode.get('Name')} ch{c.get('Offset')}: {len(lc)} "
                                    f"ChannelFunctions -- EMU cannot drive this channel")
                for f in lc:
                    where = f"{mode.get('Name')} ch{c.get('Offset')} '{f.get('Name')}'"
                    if f.get("Attribute") not in attrs:
                        problems.append(f"{where}: unknown attribute {f.get('Attribute')}")
                    if f.get("Wheel") and f.get("Wheel") not in wheels:
                        problems.append(f"{where}: unknown wheel {f.get('Wheel')}")
                    if float(f.get("PhysicalFrom")) == float(f.get("PhysicalTo")):
                        problems.append(f"{where}: ZERO-WIDTH physical range -- "
                                        f"this channel will pin at its lowest DMX value")
                    v = int(f.get("DMXFrom").split("/")[0])
                    if v <= prev:
                        problems.append(f"{where}: DMXFrom {v} not ascending")
                    prev = v
                    # Sets carry the steps a user actually picks; out-of-order
                    # ones silently swallow the ranges after them.
                    sprev = -1
                    for s in f:
                        sv = int(s.get("DMXFrom").split("/")[0])
                        if sv <= sprev:
                            problems.append(f"{where}: ChannelSet DMXFrom {sv} not ascending")
                        sprev = sv

    if problems:
        raise SystemExit("BUILD FAILED:\n  " + "\n  ".join(problems))


def main():
    global FLAT, NAME, SHORT_NAME, LONG_NAME, FIXTURE_TYPE_ID

    args = [a for a in sys.argv[1:] if a != "--flat"]
    FLAT = "--flat" in sys.argv

    if FLAT:
        # A distinct name and ID so both builds can sit in EMU's library at
        # once -- you want to patch one of each side by side to compare.
        NAME += " EMU"
        SHORT_NAME += "E"
        LONG_NAME += " (EMU single-function build)"
        FIXTURE_TYPE_ID = "3F2A6C11" + FIXTURE_TYPE_ID[8:]

    out = args[0] if args else (
        "Realsun_Beam_150_EMU.gdtf" if FLAT else "Realsun_Beam_150.gdtf")
    xml = build_description()
    validate(xml)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("description.xml", xml)
    print(f"wrote {out} ({len(xml)} bytes of XML) -- validated"
          f"{', EMU single-function build' if FLAT else ''}")


if __name__ == "__main__":
    main()
