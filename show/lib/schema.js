// What a show is made of, described once. The inspector draws its forms from
// this, the MCP hands it to Claude as the vocabulary, and the server validates
// every edit against it — so all three agree on what a clip can say.

import { resolveFixtures, validateAim } from './rig.js';

export const FIGURES = ['circle', 'figure8', 'sweep', 'nod', 'fan', 'cross', 'wave', 'drift', 'snap', 'still'];
export const EFFECTS = ['pulse', 'chase', 'flash', 'wave', 'sparkle', 'colourStep', 'goboStep'];

export const COMMON_PARAMS = [
  { key: 'start', kind: 'time', help: 'When the clip starts. Seconds, "1:23.5", "bar 17", "bar 17.3" (beat 3), a marker label, or any of those "+ 4 bars" / "- 2 beats" / "+ 1.5s".' },
  { key: 'end', kind: 'time', help: 'When it ends, same forms as start. Or give `length` instead ("8 bars", "16 beats", "12s").' },
  { key: 'fixtures', kind: 'fixtures', default: 'all', help: 'A group name, a fixture id, or a list of them.' },
  { key: 'fadeIn', kind: 'number', min: 0, max: 60, step: 0.05, unit: 's', default: 0, help: 'Blend in over this many seconds from whatever the layers below are doing.' },
  { key: 'fadeOut', kind: 'number', min: 0, max: 60, step: 0.05, unit: 's', default: 0, help: 'Blend back out over the clip\'s last seconds.' },
  { key: 'label', kind: 'text', help: 'Optional name shown on the clip.' },
];

export function clipTypes(rig) {
  const type = Object.values(rig.fixtureTypes)[0];
  const colours = type.colours.map((c) => c.name);
  const gobos = type.gobos.map((g) => g.name);
  return {
    look: {
      help: 'A state: brightness, colour, gobo, prism, strobe, where the heads point. Only the fields you set are applied; everything else passes through from the layers below.',
      params: [
        { key: 'dimmer', kind: 'number', min: 0, max: 1, step: 0.01, help: '0 dark, 1 full.' },
        { key: 'colour', kind: 'enum', options: colours, help: 'A slot on the colour wheel. There is no colour mixing on these heads: these eight are the palette.' },
        { key: 'colourSpin', kind: 'number', min: 0, max: 1, step: 0.01, help: 'Spin the colour wheel continuously. 0 off, 1 fastest. Overrides colour.' },
        { key: 'gobo', kind: 'enum', options: gobos, help: 'Pattern in the beam.' },
        { key: 'goboMode', kind: 'enum', options: ['static', 'shake', 'scroll'], help: 'static holds the gobo, shake wobbles it, scroll cycles through all gobos.' },
        { key: 'goboSpeed', kind: 'number', min: 0, max: 1, step: 0.01, help: 'Speed for shake / scroll.' },
        { key: 'prism', kind: 'enum', options: ['off', 'in', 'rotate'], help: 'in splits the beam into three; rotate spins the split.' },
        { key: 'prismSpeed', kind: 'number', min: 0, max: 1, step: 0.01, help: 'Rotation speed when prism is rotate.' },
        { key: 'strobe', kind: 'number', min: 0, max: 1, step: 0.01, help: 'Shutter strobe. 0 open, 1 fastest. Free-running, not in time with the music — use an fx flash for that.' },
        { key: 'aim', kind: 'aim', help: 'Where to point: a target name (heads converge on it), [x, y, z] in metres, or {pan, tilt} in degrees (heads stay parallel).' },
        { key: 'crawl', kind: 'number', min: 0, max: 1, step: 0.01, help: 'Pan/tilt motor speed (channel 5). 0 full speed — normal. Higher makes every move a slow glide; good for ambient drifts, wrong for anything on the beat.' },
      ],
    },
    move: {
      help: 'Movement. A figure runs around a centre aim, in time with the beat grid. It sets pan and tilt only.',
      params: [
        { key: 'figure', kind: 'enum', options: FIGURES, default: 'circle', help: 'circle, figure8 (ballyhoo), sweep (pan side to side), nod (tilt up and down), fan (spread left to right, breathe to open and close), cross (left heads point right and vice versa), wave (nod rippling across the heads), drift (slow organic wander), snap (jump between positions each period), still (hold the centre).' },
        { key: 'aim', kind: 'aim', default: { pan: 0, tilt: 40 }, help: 'Centre of the figure.' },
        { key: 'width', kind: 'number', min: 0, max: 540, step: 1, unit: '°', default: 60, help: 'Pan size, peak to peak. For fan and cross, the total spread.' },
        { key: 'height', kind: 'number', min: 0, max: 180, step: 1, unit: '°', default: 30, help: 'Tilt size, peak to peak.' },
        { key: 'period', kind: 'number', min: 0.25, max: 256, step: 0.25, unit: 'beats', default: 4, help: 'Beats per cycle (4 = one bar in 4/4). For snap, beats per position.' },
        { key: 'spread', kind: 'number', min: 0, max: 1, step: 0.05, help: 'Phase offset across the heads, left to right. 0 all together, 1 evenly spread over one cycle. Default 0, or 1 for wave.' },
        { key: 'direction', kind: 'enum', options: ['forward', 'reverse'], default: 'forward' },
        { key: 'breathe', kind: 'number', min: 0, max: 256, step: 0.25, unit: 'beats', default: 0, help: 'fan only: open and close over this many beats. 0 holds the fan still.' },
        { key: 'positions', kind: 'aimList', help: 'snap only: the positions to step through.' },
        { key: 'crawl', kind: 'number', min: 0, max: 1, step: 0.01, help: 'Pan/tilt motor speed, as on a look.' },
      ],
    },
    fx: {
      help: 'A beat-synced effect on brightness, colour or gobo. Brightness effects multiply the dimmer set by a look below them; with no look below, they run at `level`.',
      params: [
        { key: 'effect', kind: 'enum', options: EFFECTS, default: 'pulse', help: 'pulse (hit then decay each period), chase (one head at a time), flash (on for `duty` of each period), wave (smooth brightness ripple), sparkle (random heads each period), colourStep (step through colours), goboStep (step through gobos).' },
        { key: 'period', kind: 'number', min: 0.125, max: 64, step: 0.125, unit: 'beats', default: 1, help: 'Beats per step or pulse.' },
        { key: 'spread', kind: 'number', min: 0, max: 1, step: 0.05, default: 0, help: 'Phase offset across the heads, left to right.' },
        { key: 'decay', kind: 'number', min: 0.05, max: 1, step: 0.05, default: 0.6, help: 'pulse: how much of the period the fade takes.' },
        { key: 'duty', kind: 'number', min: 0.05, max: 1, step: 0.05, default: 0.3, help: 'flash and sparkle: how much of the period the light is on.' },
        { key: 'floor', kind: 'number', min: 0, max: 1, step: 0.05, default: 0, help: 'Lowest brightness the effect drops to.' },
        { key: 'level', kind: 'number', min: 0, max: 1, step: 0.05, default: 1, help: 'Peak brightness when no look below sets a dimmer.' },
        { key: 'order', kind: 'enum', options: ['forward', 'reverse', 'pingpong', 'random'], default: 'forward', help: 'chase, colourStep and goboStep: the stepping order.' },
        { key: 'colours', kind: 'enumList', options: colours, help: 'colourStep: the colours to step through. Default every colour except white.' },
        { key: 'gobos', kind: 'enumList', options: gobos, help: 'goboStep: the gobos to step through. Default every gobo except open.' },
      ],
    },
  };
}

const COMMON_KEYS = new Set(['id', 'type', 'start', 'end', 'fixtures', 'fadeIn', 'fadeOut', 'label', 'muted']);

function checkParam(rig, spec, value) {
  const name = spec.key;
  switch (spec.kind) {
    case 'number':
      if (!Number.isFinite(value)) return `${name} must be a number`;
      if (spec.min != null && value < spec.min) return `${name} must be at least ${spec.min}`;
      if (spec.max != null && value > spec.max) return `${name} must be at most ${spec.max}`;
      return null;
    case 'enum':
      return spec.options.includes(value) ? null : `${name} "${value}" isn't available — choose one of ${spec.options.join(', ')}`;
    case 'enumList':
      if (!Array.isArray(value) || value.length === 0) return `${name} must be a non-empty list`;
      for (const v of value) if (!spec.options.includes(v)) return `${name}: "${v}" isn't available — choose from ${spec.options.join(', ')}`;
      return null;
    case 'aim':
      return validateAim(rig, value);
    case 'aimList':
      if (!Array.isArray(value) || value.length === 0) return `${name} must be a non-empty list of aims`;
      for (const v of value) { const e = validateAim(rig, v); if (e) return `${name}: ${e}`; }
      return null;
    case 'text':
      return typeof value === 'string' ? null : `${name} must be text`;
    default:
      return null;
  }
}

// Returns a list of problems; empty means the clip is good. Times must already
// be resolved to seconds.
export function validateClip(rig, clip) {
  const errors = [];
  const types = clipTypes(rig);
  const def = types[clip.type];
  if (!def) return [`clip type "${clip.type}" isn't one of ${Object.keys(types).join(', ')}`];
  if (!Number.isFinite(clip.start) || clip.start < 0) errors.push('start must resolve to a time ≥ 0');
  if (!Number.isFinite(clip.end) || !(clip.end > clip.start)) errors.push('end must come after start');
  for (const key of ['fadeIn', 'fadeOut']) {
    if (clip[key] != null && (!Number.isFinite(clip[key]) || clip[key] < 0)) errors.push(`${key} must be ≥ 0 seconds`);
  }
  try { resolveFixtures(rig, clip.fixtures ?? 'all'); } catch (e) { errors.push(e.message); }
  const known = new Map(def.params.map((p) => [p.key, p]));
  for (const [key, value] of Object.entries(clip)) {
    if (COMMON_KEYS.has(key) || value === undefined) continue;
    const spec = known.get(key);
    if (!spec) { errors.push(`"${key}" isn't a ${clip.type} field — ${clip.type} takes ${[...known.keys()].join(', ')}`); continue; }
    const err = checkParam(rig, spec, value);
    if (err) errors.push(err);
  }
  return errors;
}

export function emptyShow(title = 'Untitled show') {
  return {
    version: 1,
    title,
    audio: null,
    duration: 180,
    bpm: 120,
    offset: 0,
    beatsPerBar: 4,
    markers: [],
    tracks: [
      { id: 'base', name: 'Base look', muted: false, clips: [] },
      { id: 'move', name: 'Movement', muted: false, clips: [] },
      { id: 'fx', name: 'Effects', muted: false, clips: [] },
    ],
  };
}
