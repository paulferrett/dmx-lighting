// The evaluator: show + rig + time → what every head is doing. Pure and
// stateless, so the browser preview, the DMX output and Claude's
// show_state_at all get the same answer for the same moment.
//
// Layering: tracks apply in order, and within a track clips apply in start
// order. A later layer overrides the attributes it sets and leaves the rest
// alone. Fades blend a layer in from whatever was below it.

import { clampAngles, fixtureType, rankByX, resolveAim, resolveFixtures } from './rig.js';
import { beatAt } from './timeexpr.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, k) => a + (b - a) * k;
const mod = (a, n) => ((a % n) + n) % n;

// Deterministic 0..1 from integers, for sparkle and random order.
function hash01(...ints) {
  let h = 2166136261;
  for (const i of ints) { h ^= i | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; }
  return ((h >>> 0) % 100000) / 100000;
}

export function baseState(rig, fixture) {
  const type = fixtureType(rig, fixture);
  return {
    dimmer: 0, dimmerSet: false,
    colour: type.colours[0].name, colourSpin: 0,
    gobo: type.gobos[0].name, goboMode: 'static', goboSpeed: 0,
    prism: 'off', prismSpeed: 0,
    strobe: 0,
    pan: rig.home.pan, tilt: rig.home.tilt,
    crawl: 0,
    clamped: false,
  };
}

export function clipAlpha(clip, t) {
  if (t < clip.start || t >= clip.end) return 0;
  let a = 1;
  if (clip.fadeIn > 0) a = Math.min(a, (t - clip.start) / clip.fadeIn);
  if (clip.fadeOut > 0) a = Math.min(a, (clip.end - t) / clip.fadeOut);
  return clamp01(a);
}

// Fixture lists per clip, cached against the rig and clip objects.
const targetCache = new WeakMap();
function clipTargets(rig, clip) {
  let perRig = targetCache.get(rig);
  if (!perRig) { perRig = new WeakMap(); targetCache.set(rig, perRig); }
  let hit = perRig.get(clip);
  if (!hit) {
    const fixtures = resolveFixtures(rig, clip.fixtures ?? 'all');
    const rank = rankByX(fixtures);
    const cx = fixtures.reduce((s, f) => s + f.position[0], 0) / (fixtures.length || 1);
    hit = { fixtures, rank, cx };
    perRig.set(clip, hit);
  }
  return hit;
}

// Discrete attributes (colour, gobo, prism) can't blend. They switch halfway
// through a fade, or straight away if the head is dark underneath, so a fade
// up from black arrives already in the right colour.
const switchNow = (s, a) => a >= 0.5 || (a > 0 && s.dimmer < 0.02);

function applyLook(rig, s, fixture, clip, a) {
  const discrete = switchNow(s, a);
  if (clip.dimmer != null) { s.dimmer = lerp(s.dimmer, clip.dimmer, a); s.dimmerSet = true; }
  if (clip.strobe != null) s.strobe = lerp(s.strobe, clip.strobe, a);
  if (clip.crawl != null) s.crawl = lerp(s.crawl, clip.crawl, a);
  if (discrete) {
    if (clip.colour != null) { s.colour = clip.colour; s.colourSpin = 0; }
    if (clip.colourSpin != null) s.colourSpin = clip.colourSpin;
    if (clip.gobo != null) { s.gobo = clip.gobo; s.goboMode = 'static'; }
    if (clip.goboMode != null) s.goboMode = clip.goboMode;
    if (clip.goboSpeed != null) s.goboSpeed = clip.goboSpeed;
    if (clip.prism != null) s.prism = clip.prism;
    if (clip.prismSpeed != null) s.prismSpeed = clip.prismSpeed;
  }
  if (clip.aim != null) {
    const p = resolveAim(rig, fixture, clip.aim);
    s.pan = lerp(s.pan, p.pan, a);
    s.tilt = lerp(s.tilt, p.tilt, a);
    s.clamped ||= p.clamped;
  }
}

function figureOffset(clip, beats, rank, n, side) {
  const figure = clip.figure ?? 'circle';
  const W = clip.width ?? 60;
  const H = clip.height ?? 30;
  const period = clip.period ?? 4;
  const spread = clip.spread ?? (figure === 'wave' ? 1 : 0);
  const dir = clip.direction === 'reverse' ? -1 : 1;
  const phi = TAU * (dir * beats / period + spread * rank / n);
  switch (figure) {
    case 'circle': return [W / 2 * Math.sin(phi), H / 2 * Math.cos(phi)];
    case 'figure8': return [W / 2 * Math.sin(phi), H / 2 * Math.sin(2 * phi)];
    case 'sweep': return [W / 2 * Math.sin(phi), 0];
    case 'nod':
    case 'wave': return [0, H / 2 * Math.sin(phi)];
    case 'fan': {
      const k = n > 1 ? rank / (n - 1) - 0.5 : 0;
      const breathe = clip.breathe ?? 0;
      const w = breathe > 0 ? W * (0.5 - 0.5 * Math.cos(TAU * beats / breathe)) : W;
      return [w * k, 0];
    }
    case 'cross': return [-side * W / 2, 0];
    case 'drift': return [
      W / 2 * (0.6 * Math.sin(phi * 0.37 + rank * 1.7) + 0.4 * Math.sin(phi * 0.83 + rank * 4.1)),
      H / 2 * (0.6 * Math.sin(phi * 0.53 + rank * 2.9) + 0.4 * Math.cos(phi * 0.29 + rank * 0.7)),
    ];
    default: return [0, 0];
  }
}

function applyMove(rig, show, s, fixture, clip, a, t, rank, n, side) {
  const beats = beatAt(show, t);
  let target;
  if ((clip.figure ?? 'circle') === 'snap') {
    const positions = clip.positions?.length ? clip.positions : [clip.aim ?? { pan: 0, tilt: 40 }];
    const L = positions.length;
    const dir = clip.direction === 'reverse' ? -1 : 1;
    const step = Math.floor(beats / (clip.period ?? 4));
    const idx = mod(dir * step + Math.floor((clip.spread ?? 0) * rank * L / n), L);
    target = resolveAim(rig, fixture, positions[idx]);
  } else {
    const centre = resolveAim(rig, fixture, clip.aim ?? { pan: 0, tilt: 40 });
    const [dp, dt] = figureOffset(clip, beats, rank, n, side);
    target = clampAngles(rig, fixture, centre.pan + dp, centre.tilt + dt);
    target.clamped ||= centre.clamped;
  }
  s.pan = lerp(s.pan, target.pan, a);
  s.tilt = lerp(s.tilt, target.tilt, a);
  s.clamped ||= target.clamped;
  if (clip.crawl != null) s.crawl = lerp(s.crawl, clip.crawl, a);
}

function sequenceIndex(order, step, L) {
  switch (order) {
    case 'reverse': return L - 1 - mod(step, L);
    case 'pingpong': {
      if (L < 2) return 0;
      const i = mod(step, 2 * L - 2);
      return i < L ? i : 2 * L - 2 - i;
    }
    case 'random': return Math.floor(hash01(step, 7919) * L);
    default: return mod(step, L);
  }
}

function applyFx(rig, show, s, fixture, clip, a, t, rank, n) {
  const type = fixtureType(rig, fixture);
  const beats = beatAt(show, t);
  const period = clip.period ?? 1;
  const effect = clip.effect ?? 'pulse';
  const spread = clip.spread ?? 0;
  const local = beats / period + spread * rank / n;
  const frac = local - Math.floor(local);
  const step = Math.floor(beats / period);

  if (effect === 'colourStep' || effect === 'goboStep') {
    if (!switchNow(s, a)) return;
    const list = effect === 'colourStep'
      ? (clip.colours ?? type.colours.slice(1).map((c) => c.name))
      : (clip.gobos ?? type.gobos.slice(1).map((g) => g.name));
    const idx = sequenceIndex(clip.order, step + Math.floor(spread * rank * list.length / n), list.length);
    if (effect === 'colourStep') { s.colour = list[idx]; s.colourSpin = 0; }
    else { s.gobo = list[idx]; s.goboMode = 'static'; }
    return;
  }

  let env;
  switch (effect) {
    case 'pulse': { const d = clip.decay ?? 0.6; env = frac < d ? (1 - frac / d) ** 2 : 0; break; }
    case 'flash': env = frac < (clip.duty ?? 0.3) ? 1 : 0; break;
    case 'wave': env = 0.5 + 0.5 * Math.cos(TAU * local); break;
    case 'chase': env = sequenceIndex(clip.order, step, n) === rank ? 1 : 0; break;
    case 'sparkle': env = hash01(step, rank, 104729) < (clip.duty ?? 0.3) ? 1 : 0; break;
    default: env = 1;
  }
  const floor = clip.floor ?? 0;
  const mult = floor + (1 - floor) * env;
  if (s.dimmerSet) s.dimmer *= lerp(1, mult, a);
  else { s.dimmer = lerp(s.dimmer, (clip.level ?? 1) * mult, a); s.dimmerSet = true; }
}

// Everything happening at time t. `fixtures` maps id → state; `active` lists
// the clip ids in play, for the timeline to highlight.
export function evaluate(show, rig, t) {
  const states = {};
  for (const f of rig.fixtures) states[f.id] = baseState(rig, f);
  const active = [];
  for (const track of show.tracks) {
    if (track.muted) continue;
    const clips = [...track.clips].sort((x, y) => x.start - y.start);
    for (const clip of clips) {
      if (clip.muted) continue;
      const a = clipAlpha(clip, t);
      if (a <= 0) continue;
      active.push(clip.id);
      let targets;
      try { targets = clipTargets(rig, clip); } catch { continue; }
      const { fixtures, rank, cx } = targets;
      const n = fixtures.length;
      for (const f of fixtures) {
        const s = states[f.id];
        const r = rank.get(f.id);
        try {
          if (clip.type === 'look') applyLook(rig, s, f, clip, a);
          else if (clip.type === 'move') applyMove(rig, show, s, f, clip, a, t, r, n, Math.sign(f.position[0] - cx));
          else if (clip.type === 'fx') applyFx(rig, show, s, f, clip, a, t, r, n);
        } catch {
          // A clip naming a target that has since been removed from the rig:
          // skip it rather than stop the show. Validation reports it on edit.
        }
      }
    }
  }
  return { t, fixtures: states, active };
}
