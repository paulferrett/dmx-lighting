// The rig: which heads exist, where they stand, what each can do, and the
// geometry that turns "point at the crowd" into pan and tilt for each head.
//
// Angle convention, per fixture and in degrees:
//   tilt 0   = beam straight out of the base (up, for an upright head)
//   tilt 90  = beam level with the base, pointing the way pan faces
//   pan 0    = facing the audience (+z); positive pan turns toward +x,
//              which is the audience's right
// Orientation is a full rotation (see fixtureRotation): a hung head's tilt 0
// points at the floor, a wall-mounted one's points sideways.

const DEG = Math.PI / 180;

export function fixtureType(rig, fixture) {
  const type = rig.fixtureTypes[fixture.type];
  if (!type) throw new Error(`fixture ${fixture.id} has unknown type ${fixture.type}`);
  return type;
}

// A clip's `fixtures` is a group name, a fixture id, or a list of either.
// Returns fixtures in rig order with duplicates removed.
export function resolveFixtures(rig, spec = 'all') {
  const want = new Set();
  const names = Array.isArray(spec) ? spec : [spec];
  for (const name of names) {
    if (rig.groups[name]) rig.groups[name].forEach((id) => want.add(id));
    else if (rig.fixtures.some((f) => f.id === name)) want.add(name);
    else throw new Error(`"${name}" is not a fixture or group — groups: ${Object.keys(rig.groups).join(', ')}; fixtures: ${rig.fixtures.map((f) => f.id).join(', ')}`);
  }
  return rig.fixtures.filter((f) => want.has(f.id));
}

// Left-to-right order of a set of fixtures as the audience sees it: 0 for the
// leftmost, n-1 for the rightmost. Fans and crosses spread by this.
export function rankByX(fixtures) {
  const sorted = [...fixtures].sort((a, b) => a.position[0] - b.position[0]);
  return new Map(sorted.map((f, i) => [f.id, i]));
}

// A fixture's orientation is `rotation: [x, y, z]` in degrees, applied the
// way three.js applies an Euler 'XYZ' rotation (matrix Rx·Ry·Rz), so the
// stage draws exactly what the engine aims. [0, 0, 0] is upright on the
// floor facing the audience; [0, 0, 180] hangs it upside down.
// Older rigs said `mount: 'hung'` and `yaw`; those still read the same.
export function fixtureRotation(fixture) {
  if (Array.isArray(fixture.rotation)) return fixture.rotation;
  return [0, fixture.yaw ?? 0, fixture.mount === 'hung' ? 180 : 0];
}

const matrixCache = new WeakMap();
function rotationMatrix(fixture) {
  const key = fixtureRotation(fixture).join(',');
  const hit = matrixCache.get(fixture);
  if (hit && hit.key === key) return hit.m;
  const [a, b, c] = fixtureRotation(fixture).map((d) => d * DEG);
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  // Rx(a) · Ry(b) · Rz(c), row-major
  const m = [
    [cb * cc, -cb * sc, sb],
    [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb],
    [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb],
  ];
  matrixCache.set(fixture, { key, m });
  return m;
}

function toWorld(fixture, v) {
  const m = rotationMatrix(fixture);
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
}

function toLocal(fixture, v) {
  const m = rotationMatrix(fixture);
  return [0, 1, 2].map((j) => m[0][j] * v[0] + m[1][j] * v[1] + m[2][j] * v[2]);
}

// Unit vector in world space for a head at (pan, tilt).
export function beamDirection(fixture, pan, tilt) {
  const p = pan * DEG;
  const t = tilt * DEG;
  return toWorld(fixture, [Math.sin(t) * Math.sin(p), Math.cos(t), Math.sin(t) * Math.cos(p)]);
}

// Pan/tilt that points a head at a world point. Tilt is kept non-negative so
// pan stays continuous for anything in front of the rig; the seam is directly
// behind the head, where nothing gets aimed.
export function panTiltToPoint(rig, fixture, point) {
  const [px, py, pz] = fixture.position;
  const d = toLocal(fixture, [point[0] - px, point[1] - py, point[2] - pz]);
  const len = Math.hypot(...d) || 1;
  const [dx, dy, dz] = d.map((v) => v / len);
  const pan = Math.atan2(dx, dz) / DEG;
  const tilt = Math.acos(Math.max(-1, Math.min(1, dy))) / DEG;
  return clampAngles(rig, fixture, pan, tilt);
}

export function clampAngles(rig, fixture, pan, tilt) {
  const type = fixtureType(rig, fixture);
  const pMax = type.panRange / 2;
  const tMax = type.tiltRange / 2;
  const cp = Math.max(-pMax, Math.min(pMax, pan));
  const ct = Math.max(-tMax, Math.min(tMax, tilt));
  return { pan: cp, tilt: ct, clamped: cp !== pan || ct !== tilt };
}

// The room: walls and boxes (solid — beams stop on them, gobos land on them)
// and floor zones (the dancefloor, where the crowd stands). Each is
// {id, label, kind, position: [x, y, z] of its base centre, size: [w, h, d],
// rotation: degrees about y}. Every object is also an aim target by its id:
// a wall's centre, a box's top, a zone's centre on the floor.
export function roomTargets(rig) {
  const out = {};
  for (const o of rig.room?.objects ?? []) {
    const [x, y, z] = o.position;
    const h = o.size?.[1] ?? 0;
    out[o.id] = o.kind === 'wall' ? [x, y + h / 2, z] : o.kind === 'box' ? [x, y + h, z] : [x, y, z];
  }
  if (rig.room?.ceiling) out.ceiling = [0, rig.room.ceiling, 3];
  return out;
}

export function allTargets(rig) {
  return { ...roomTargets(rig), ...rig.targets };
}

const targetNames = (rig) => Object.keys(allTargets(rig)).join(', ');

// An aim is a target name, an [x, y, z] point, or {pan, tilt}. Points make the
// heads converge; {pan, tilt} keeps them parallel.
export function resolveAim(rig, fixture, aim) {
  if (aim == null) return { ...rig.home, clamped: false };
  if (typeof aim === 'string') {
    if (aim === 'home') return { ...rig.home, clamped: false };
    const point = allTargets(rig)[aim];
    if (!point) throw new Error(`unknown target "${aim}" — targets: ${targetNames(rig)}`);
    return panTiltToPoint(rig, fixture, point);
  }
  if (Array.isArray(aim)) return panTiltToPoint(rig, fixture, aim);
  if (typeof aim === 'object' && 'pan' in aim && 'tilt' in aim) return clampAngles(rig, fixture, aim.pan, aim.tilt);
  throw new Error(`can't read aim ${JSON.stringify(aim)} — use a target name, [x, y, z] or {pan, tilt}`);
}

export function validateAim(rig, aim) {
  if (aim == null || aim === 'home') return null;
  if (typeof aim === 'string') return allTargets(rig)[aim] ? null : `unknown target "${aim}" — targets: ${targetNames(rig)}`;
  if (Array.isArray(aim)) return aim.length === 3 && aim.every(Number.isFinite) ? null : 'a point aim is [x, y, z] in metres';
  if (typeof aim === 'object' && Number.isFinite(aim.pan) && Number.isFinite(aim.tilt)) return null;
  return `can't read aim ${JSON.stringify(aim)} — use a target name, [x, y, z] or {pan, tilt}`;
}

const vec = (v, n = 3) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);

// Bring a rig up to date and check it before it is saved. Older rigs had a
// `stage` block and mount/yaw; both become the room and rotations. Throws
// with the reason if a fixture or room object can't be read.
export function normaliseRig(rig) {
  if (!rig.room) {
    const st = rig.stage ?? {};
    rig.room = {
      haze: st.haze ?? 0.6,
      ceiling: null,
      objects: [
        ...(st.wall === false ? [] : [{ id: 'back-wall', label: 'Back wall', kind: 'wall', position: [0, 0, -2.5], size: [14, 4, 0.2], rotation: 0 }]),
        { id: 'dj-booth', label: 'DJ booth', kind: 'box', position: [0, 0, -1.1], size: [2, 1.05, 0.8], rotation: 0 },
        { id: 'dancefloor', label: 'Dancefloor', kind: 'zone', position: [0, 0, 6.2], size: [9.2, 0, 6.5], rotation: 0, crowd: 46 },
      ],
    };
  }
  delete rig.stage;
  rig.targets ??= {};
  rig.home ??= { pan: 0, tilt: 0 };

  const ids = new Set();
  const used = new Map();
  for (const f of rig.fixtures) {
    if (!f.id || ids.has(f.id)) throw new Error(`fixture ids must be unique — "${f.id}"`);
    ids.add(f.id);
    if (!rig.fixtureTypes[f.type]) throw new Error(`${f.id}: unknown type ${f.type}`);
    if (!Number.isInteger(f.address) || f.address < 1 || f.address > 512) throw new Error(`${f.id}: address must be 1–512`);
    const footprint = rig.fixtureTypes[f.type].footprint ?? 16;
    for (let a = f.address; a < f.address + Object.keys(rig.fixtureTypes[f.type].channels).length; a++) {
      if (used.has(a)) throw new Error(`${f.id} at ${f.address} overlaps ${used.get(a)} — the Disco 240 spaces heads ${footprint} apart`);
      used.set(a, f.id);
    }
    if (!vec(f.position)) throw new Error(`${f.id}: position is [x, y, z] in metres`);
    if (!Array.isArray(f.rotation)) { f.rotation = fixtureRotation(f); delete f.mount; delete f.yaw; }
    if (!vec(f.rotation)) throw new Error(`${f.id}: rotation is [x, y, z] in degrees`);
  }
  const objectIds = new Set();
  for (const o of rig.room.objects) {
    if (!o.id || objectIds.has(o.id) || ids.has(o.id)) throw new Error(`room object ids must be unique — "${o.id}"`);
    objectIds.add(o.id);
    if (!['wall', 'box', 'zone'].includes(o.kind)) throw new Error(`${o.id}: kind is wall, box or zone`);
    if (!vec(o.position) || !vec(o.size)) throw new Error(`${o.id}: position and size are [x, y, z] in metres`);
    o.rotation = Number(o.rotation) || 0;
  }
  // Groups follow the fixtures: "all" is every head, and a removed head
  // leaves every group it was in.
  rig.groups = Object.fromEntries(Object.entries(rig.groups ?? {}).map(([g, m]) => [g, m.filter((id) => ids.has(id))]).filter(([, m]) => m.length));
  rig.groups.all = rig.fixtures.map((f) => f.id);
  return rig;
}
