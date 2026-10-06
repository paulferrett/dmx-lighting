import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../lib/engine.js';
import { encodeUniverse, fixtureChannels } from '../lib/dmx.js';
import { applyOps } from '../lib/ops.js';
import { emptyShow } from '../lib/schema.js';
import { resolveTime, timeOfBar, barBeatAt } from '../lib/timeexpr.js';
import { beamDirection, panTiltToPoint } from '../lib/rig.js';
import { analyse } from '../lib/analysis.js';

const rig = JSON.parse(readFileSync(new URL('../rig.json', import.meta.url)));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function showWith(ops) {
  const base = { ...emptyShow('t'), bpm: 120, offset: 0.5 };
  return applyOps(base, rig, ops).show;
}

test('time expressions read bars, markers and offsets against the grid', () => {
  const show = showWith([{ op: 'setMarkers', markers: [{ at: 'bar 9', label: 'Chorus 1' }] }]);
  near(timeOfBar(show, 1), 0.5);
  near(resolveTime(show, 'bar 2'), 0.5 + 2);
  near(resolveTime(show, 'bar 2.3'), 0.5 + 2 + 1);
  near(resolveTime(show, 'bar 2 beat 3'), 0.5 + 3);
  near(resolveTime(show, '1:02.5'), 62.5);
  near(resolveTime(show, 'chorus 1'), 0.5 + 16);
  near(resolveTime(show, 'Chorus 1 + 4 bars'), 0.5 + 24);
  near(resolveTime(show, 'chorus1 - 2 beats'), 0.5 + 15);
  assert.deepEqual(barBeatAt(show, 0.5 + 2.5), { bar: 2, beat: 2 });
  assert.throws(() => resolveTime(show, 'the drop'), /marker label/);
});

test('aiming at a point converges the heads and round-trips through the beam direction', () => {
  for (const f of rig.fixtures) {
    const target = [0.3, 4, 5];
    const { pan, tilt, clamped } = panTiltToPoint(rig, f, target);
    assert.equal(clamped, false);
    const d = beamDirection(f, pan, tilt);
    const v = target.map((x, i) => x - f.position[i]);
    const len = Math.hypot(...v);
    v.forEach((x, i) => near(x / len, d[i], 1e-9));
  }
  const hung = { ...rig.fixtures[0], rotation: [0, 30, 180], position: [0, 4, 0] };
  const { pan, tilt } = panTiltToPoint(rig, hung, [1, 0, 3]);
  const d = beamDirection(hung, pan, tilt);
  const v = [1, -4, 3]; const len = Math.hypot(...v);
  v.forEach((x, i) => near(x / len, d[i], 1e-9));
});

test('an upright head cannot reach below its horizon on a 180° tilt, and says so', () => {
  const r = panTiltToPoint(rig, rig.fixtures[0], [-2.4, 0, 3]);
  assert.equal(r.clamped, true);
  assert.equal(r.tilt, 90);
});

test('a look fades in from black already in its colour, and layers override', () => {
  const show = showWith([
    { op: 'addClips', track: 'Base look', clips: [{ type: 'look', start: 0, end: 10, dimmer: 1, colour: 'cyan', fadeIn: 2 }] },
    { op: 'addClips', track: 'Effects', clips: [{ type: 'look', start: 4, end: 6, fixtures: 'odds', colour: 'red' }] },
  ]);
  const at1 = evaluate(show, rig, 1).fixtures.h1;
  near(at1.dimmer, 0.5);
  assert.equal(at1.colour, 'cyan');
  const at5 = evaluate(show, rig, 5).fixtures;
  assert.equal(at5.h1.colour, 'red');
  assert.equal(at5.h2.colour, 'cyan');
  assert.equal(evaluate(show, rig, 11).fixtures.h1.dimmer, 0);
});

test('a pulse multiplies the look below it, on the beat grid', () => {
  const show = showWith([
    { op: 'addClips', track: 'Base look', clips: [{ type: 'look', start: 0, end: 20, dimmer: 0.8 }] },
    { op: 'addClips', track: 'Effects', clips: [{ type: 'fx', effect: 'pulse', start: 0, end: 20, period: 1, decay: 0.5 }] },
  ]);
  near(evaluate(show, rig, 0.5).fixtures.h1.dimmer, 0.8);     // on the beat: full
  near(evaluate(show, rig, 0.5 + 0.125).fixtures.h1.dimmer, 0.8 * 0.25); // quarter beat in
  near(evaluate(show, rig, 0.5 + 0.3).fixtures.h1.dimmer, 0);  // past the decay
});

test('a chase lights one head at a time, left to right', () => {
  const show = showWith([{ op: 'addClips', track: 'Effects', clips: [{ type: 'fx', effect: 'chase', start: 0, end: 20, period: 1 }] }]);
  const lit = (t) => Object.entries(evaluate(show, rig, t).fixtures).filter(([, s]) => s.dimmer > 0).map(([id]) => id);
  assert.deepEqual(lit(0.6), ['h1']);
  assert.deepEqual(lit(1.1), ['h2']);
  assert.deepEqual(lit(2.6), ['h1']);
});

test('a fan spreads the heads symmetrically about the centre', () => {
  const show = showWith([{ op: 'addClips', track: 'Movement', clips: [{ type: 'move', figure: 'fan', start: 0, end: 10, width: 90, aim: { pan: 0, tilt: 45 } }] }]);
  const s = evaluate(show, rig, 3).fixtures;
  near(s.h1.pan, -45); near(s.h4.pan, 45); near(s.h2.pan, -15); near(s.h3.pan, 15);
  near(s.h1.tilt, 45);
});

test('DMX lands on the measured channels, with channel 5 written as 0', () => {
  const show = showWith([{ op: 'addClips', track: 'Base look', clips: [{ type: 'look', start: 0, end: 10, dimmer: 1, colour: 'blue', gobo: 'star', prism: 'in', aim: { pan: 0, tilt: 0 } }] }]);
  const u = encodeUniverse(rig, evaluate(show, rig, 1).fixtures);
  const ch = fixtureChannels(rig, u);
  assert.equal(ch.h1.dimmer, 255);
  assert.equal(ch.h1.colour, 48);
  assert.equal(ch.h1.gobo, 24);
  assert.equal(ch.h1.prism, 64);
  assert.equal(ch.h1.ptspeed, 0);
  assert.equal(ch.h1.pan, 128); // centre of 540°
  assert.equal(u[17 - 1 + 6 - 1], 255); // head 2 dimmer at 17+5
  assert.equal(u[49 - 1 + 8 - 1], 48);  // head 4 colour
});

test('bad clips are refused with a reason, and the batch leaves the show alone', () => {
  const base = emptyShow('t');
  assert.throws(() => applyOps(base, rig, [
    { op: 'addClips', track: 'Base look', clips: [{ type: 'look', start: 0, end: 4, dimmer: 1 }] },
    { op: 'addClips', track: 'Base look', clips: [{ type: 'look', start: 0, end: 4, colour: 'pink' }] },
  ]), /pink.*isn't available/);
  assert.equal(base.tracks[0].clips.length, 0);
  assert.throws(() => applyOps(base, rig, [{ op: 'addClips', track: 'x', clips: [{ type: 'move', start: 0, end: 4, wobble: 3 }] }]), /"wobble" isn't a move field/);
});

test('moving a clip by its start keeps its length; length sets end', () => {
  let show = showWith([{ op: 'addClips', track: 'Base look', clips: [{ type: 'look', start: 'bar 1', length: '2 bars', dimmer: 1 }] }]);
  const id = show.tracks[0].clips[0].id;
  near(show.tracks[0].clips[0].end, 0.5 + 4);
  show = applyOps(show, rig, [{ op: 'updateClips', clips: [{ id, start: 'bar 3' }] }]).show;
  near(show.tracks[0].clips[0].start, 4.5);
  near(show.tracks[0].clips[0].end, 8.5);
});

test('analysis finds the tempo and bar 1 of a synthetic kick track', () => {
  const sr = 22050;
  const bpm = 126;
  const start = 0.37;
  const seconds = 40;
  const samples = new Float32Array(sr * seconds);
  const beat = 60 / bpm;
  for (let k = 0; start + k * beat < seconds - 0.2; k++) {
    const t0 = Math.round((start + k * beat) * sr);
    const amp = k % 4 === 0 ? 1 : 0.55; // accent the downbeat
    for (let i = 0; i < sr * 0.12; i++) samples[t0 + i] += amp * Math.sin(2 * Math.PI * 55 * i / sr) * Math.exp(-i / (sr * 0.04));
    // hats on the off-beat
    const h0 = Math.round((start + (k + 0.5) * beat) * sr);
    for (let i = 0; i < sr * 0.02; i++) samples[h0 + i] += 0.15 * (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.005));
  }
  const a = analyse(samples, sr);
  assert.ok(Math.abs(a.bpm - bpm) < 1, `bpm ${a.bpm}`);
  near(a.offset, start, 0.03);
  assert.ok(a.bars.length > 15);
});

test('fixture rotation matches three.js exactly, so the stage draws what the engine aims', async () => {
  const THREE = await import('three');
  const rot = [20, 45, 160];
  const fixture = { ...rig.fixtures[0], rotation: rot, position: [1, 3, -1] };
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot.map((d) => d * Math.PI / 180), 'XYZ'));
  for (const [pan, tilt] of [[0, 0], [30, 45], [-120, 80], [200, -60]]) {
    const local = new THREE.Vector3(Math.sin(tilt * Math.PI / 180) * Math.sin(pan * Math.PI / 180), Math.cos(tilt * Math.PI / 180), Math.sin(tilt * Math.PI / 180) * Math.cos(pan * Math.PI / 180));
    const want = local.applyMatrix4(m);
    const got = beamDirection(fixture, pan, tilt);
    near(got[0], want.x, 1e-9); near(got[1], want.y, 1e-9); near(got[2], want.z, 1e-9);
  }
  // and aiming at a point round-trips through it
  const target = [2, 0.5, 4];
  const { pan, tilt, clamped } = panTiltToPoint(rig, fixture, target);
  if (!clamped) {
    const d = beamDirection(fixture, pan, tilt);
    const v = target.map((x, i) => x - fixture.position[i]); const len = Math.hypot(...v);
    v.forEach((x, i) => near(x / len, d[i], 1e-9));
  }
});

test('the old mount/yaw form reads the same as the rotation it became', () => {
  const old = { ...rig.fixtures[0], rotation: undefined, mount: 'hung', yaw: 30 };
  const now = { ...rig.fixtures[0], rotation: [0, 30, 180] };
  const a = beamDirection(old, 40, 50), b = beamDirection(now, 40, 50);
  a.forEach((x, i) => near(x, b[i], 1e-12));
});

test('room objects are aim targets, and an old stage block becomes a room', async () => {
  const { normaliseRig, allTargets } = await import('../lib/rig.js');
  const old = structuredClone(rig);
  delete old.room;
  old.stage = { haze: 0.4, wall: true };
  old.fixtures = old.fixtures.map(({ rotation, ...f }) => ({ ...f, mount: 'hung', yaw: 10 }));
  normaliseRig(old);
  assert.equal(old.stage, undefined);
  assert.equal(old.room.haze, 0.4);
  assert.deepEqual(old.fixtures[0].rotation, [0, 10, 180]);
  assert.equal(old.fixtures[0].mount, undefined);
  const t = allTargets(old);
  assert.deepEqual(t['back-wall'], [0, 2, -2.5]);   // a wall's centre
  assert.deepEqual(t['dj-booth'], [0, 1.05, -1.1]); // a box's top
  assert.deepEqual(t.dancefloor, [0, 0, 6.2]);      // a zone on the floor
  assert.ok(t.crowd, 'named targets still there');
});

test('a rig with clashing addresses or ids is refused with the reason', async () => {
  const { normaliseRig } = await import('../lib/rig.js');
  const bad = structuredClone(rig);
  bad.fixtures[1].address = 5;
  assert.throws(() => normaliseRig(bad), /h2 at 5 overlaps h1/);
  const dup = structuredClone(rig);
  dup.room.objects.push({ ...dup.room.objects[0] });
  assert.throws(() => normaliseRig(dup), /unique/);
});
