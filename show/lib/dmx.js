// Fixture state → DMX bytes, using the measured channel map in rig.json.
// Every channel is written on every frame, channel 5 included: a head that
// boots or re-patches parks pan/tilt speed at 128 and every move crawls, so
// nothing here leaves it to a default.

import { fixtureType } from './rig.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const speedByte = (from, speed) => from + Math.round(clamp01(speed) * (255 - from));

export function angleTo16(angle, range) {
  return Math.round(clamp01((angle + range / 2) / range) * 65535);
}

export function encodeFixture(rig, fixture, s, universe) {
  const type = fixtureType(rig, fixture);
  const ch = type.channels;
  const base = fixture.address - 1;
  const set = (c, v) => { if (c) universe[base + c - 1] = Math.max(0, Math.min(255, Math.round(v))); };

  const pan = angleTo16((fixture.panInvert ? -s.pan : s.pan) + (fixture.panOffset ?? 0), type.panRange);
  const tilt = angleTo16((fixture.tiltInvert ? -s.tilt : s.tilt) + (fixture.tiltOffset ?? 0), type.tiltRange);
  set(ch.pan, pan >> 8); set(ch.panFine, pan & 255);
  set(ch.tilt, tilt >> 8); set(ch.tiltFine, tilt & 255);
  set(ch.ptspeed, clamp01(s.crawl) * 255);
  set(ch.dimmer, clamp01(s.dimmer) * 255);
  set(ch.strobe, s.strobe > 0.001 ? speedByte(11, s.strobe) : 0);

  if (s.colourSpin > 0.001) set(ch.colour, speedByte(type.colourSpinFrom, s.colourSpin));
  else set(ch.colour, type.colours.find((c) => c.name === s.colour)?.dmx ?? 0);

  const goboIdx = Math.max(0, type.gobos.findIndex((g) => g.name === s.gobo));
  if (s.goboMode === 'scroll') set(ch.gobo, speedByte(type.goboScrollFrom, s.goboSpeed));
  else if (s.goboMode === 'shake') {
    // Measured: shake runs the gobos in reverse order in 8-wide blocks. The
    // slot-to-block pairing is unverified on the rig (goboShakeVerified).
    const block = type.gobos.length - 1 - goboIdx;
    set(ch.gobo, type.goboShakeFrom + block * 8 + Math.round(clamp01(s.goboSpeed) * 7));
  } else set(ch.gobo, type.gobos[goboIdx].dmx);

  if (s.prism === 'rotate') set(ch.prism, speedByte(type.prism.rotateFrom, s.prismSpeed));
  else set(ch.prism, s.prism === 'in' ? type.prism.in : type.prism.off);

  set(ch.auto, 0);
}

export function encodeUniverse(rig, states, universe = new Uint8Array(512)) {
  universe.fill(0);
  for (const f of rig.fixtures) if (states[f.id]) encodeFixture(rig, f, states[f.id], universe);
  return universe;
}

// Per-fixture channel values, for show_state_at and the DMX monitor.
export function fixtureChannels(rig, universe) {
  const out = {};
  for (const f of rig.fixtures) {
    const type = fixtureType(rig, f);
    const row = {};
    for (const [name, c] of Object.entries(type.channels)) row[name] = universe[f.address - 1 + c - 1];
    out[f.id] = { address: f.address, ...row };
  }
  return out;
}
