// The rig: which heads exist, where they stand, what each can do, and the
// geometry that turns "point at the crowd" into pan and tilt for each head.
//
// Angle convention, per fixture and in degrees:
//   tilt 0   = beam straight out of the base (up, for an upright head)
//   tilt 90  = beam level with the base, pointing the way pan faces
//   pan 0    = facing the audience (+z); positive pan turns toward +x,
//              which is the audience's right
// Mount "hung" turns the head upside down, so tilt 0 points at the floor.

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

function toLocal(fixture, [x, y, z]) {
  const yaw = (fixture.yaw ?? 0) * DEG;
  // undo yaw about y
  let lx = x * Math.cos(-yaw) + z * Math.sin(-yaw);
  let lz = -x * Math.sin(-yaw) + z * Math.cos(-yaw);
  let ly = y;
  if (fixture.mount === 'hung') { lx = -lx; ly = -ly; }
  return [lx, ly, lz];
}

function toWorld(fixture, [lx, ly, lz]) {
  if (fixture.mount === 'hung') { lx = -lx; ly = -ly; }
  const yaw = (fixture.yaw ?? 0) * DEG;
  return [lx * Math.cos(yaw) + lz * Math.sin(yaw), ly, -lx * Math.sin(yaw) + lz * Math.cos(yaw)];
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

// An aim is a target name, an [x, y, z] point, or {pan, tilt}. Points make the
// heads converge; {pan, tilt} keeps them parallel.
export function resolveAim(rig, fixture, aim) {
  if (aim == null) return { ...rig.home, clamped: false };
  if (typeof aim === 'string') {
    if (aim === 'home') return { ...rig.home, clamped: false };
    const point = rig.targets[aim];
    if (!point) throw new Error(`unknown target "${aim}" — targets: ${Object.keys(rig.targets).join(', ')}`);
    return panTiltToPoint(rig, fixture, point);
  }
  if (Array.isArray(aim)) return panTiltToPoint(rig, fixture, aim);
  if (typeof aim === 'object' && 'pan' in aim && 'tilt' in aim) return clampAngles(rig, fixture, aim.pan, aim.tilt);
  throw new Error(`can't read aim ${JSON.stringify(aim)} — use a target name, [x, y, z] or {pan, tilt}`);
}

export function validateAim(rig, aim) {
  if (aim == null || aim === 'home') return null;
  if (typeof aim === 'string') return rig.targets[aim] ? null : `unknown target "${aim}" — targets: ${Object.keys(rig.targets).join(', ')}`;
  if (Array.isArray(aim)) return aim.length === 3 && aim.every(Number.isFinite) ? null : 'a point aim is [x, y, z] in metres';
  if (typeof aim === 'object' && Number.isFinite(aim.pan) && Number.isFinite(aim.tilt)) return null;
  return `can't read aim ${JSON.stringify(aim)} — use a target name, [x, y, z] or {pan, tilt}`;
}
