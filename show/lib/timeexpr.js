// Musical time. Shows store seconds; people and Claude think in bars and
// sections. These convert between the two against the show's tempo grid:
// `offset` is where bar 1 beat 1 falls, `bpm` and `beatsPerBar` the rest.

export const secondsPerBeat = (show) => 60 / (show.bpm || 120);

// Continuous beat count since bar 1 beat 1 (negative before it).
export const beatAt = (show, t) => (t - (show.offset || 0)) / secondsPerBeat(show);

export function timeOfBar(show, bar, beat = 1) {
  const bpb = show.beatsPerBar || 4;
  return (show.offset || 0) + ((bar - 1) * bpb + (beat - 1)) * secondsPerBeat(show);
}

export function barBeatAt(show, t) {
  const bpb = show.beatsPerBar || 4;
  const beats = beatAt(show, t);
  const bar = Math.floor(beats / bpb) + 1;
  const beat = beats - (bar - 1) * bpb + 1;
  return { bar, beat };
}

export function formatClock(t) {
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${sign}${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function unitSeconds(show, n, unit) {
  const u = unit.toLowerCase();
  if (u.startsWith('bar')) return n * (show.beatsPerBar || 4) * secondsPerBeat(show);
  if (u.startsWith('beat')) return n * secondsPerBeat(show);
  return n;
}

function findMarker(show, label) {
  const want = label.trim().toLowerCase();
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return (show.markers || []).find((m) => m.label.toLowerCase() === want)
    ?? (show.markers || []).find((m) => slug(m.label) === slug(want));
}

function resolveAnchor(show, raw) {
  const s = raw.trim();
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*s?$/i))) return Number(m[1]);
  if ((m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^bar\s+(\d+)(?:\.(\d+)|\s+beat\s+(\d+(?:\.\d+)?))?$/i))) {
    return timeOfBar(show, Number(m[1]), Number(m[2] ?? m[3] ?? 1));
  }
  if (/^start$/i.test(s)) return 0;
  if (/^end$/i.test(s)) return show.duration;
  const marker = findMarker(show, s);
  if (marker) return marker.t;
  const labels = (show.markers || []).map((mk) => `"${mk.label}"`).join(', ') || 'none yet';
  throw new Error(`can't read time "${raw}" — use seconds, "m:ss", "bar N", "bar N.beat", or a marker label (markers: ${labels})`);
}

export function resolveTime(show, expr) {
  if (typeof expr === 'number') return expr;
  if (typeof expr !== 'string') throw new Error(`can't read time ${JSON.stringify(expr)}`);
  const m = expr.match(/^(.*?)\s*([+-])\s*(\d+(?:\.\d+)?)\s*(bars?|beats?|s|secs?|seconds?)$/i);
  if (m && m[1].trim()) {
    const base = resolveAnchor(show, m[1]);
    const delta = unitSeconds(show, Number(m[3]), m[4]);
    return m[2] === '+' ? base + delta : base - delta;
  }
  return resolveAnchor(show, expr);
}

export function resolveLength(show, expr) {
  if (typeof expr === 'number') return expr;
  const m = String(expr).trim().match(/^(\d+(?:\.\d+)?)\s*(bars?|beats?|s|secs?|seconds?)?$/i);
  if (!m) throw new Error(`can't read length "${expr}" — use "8 bars", "16 beats", "12s" or seconds`);
  return unitSeconds(show, Number(m[1]), m[2] || 's');
}
