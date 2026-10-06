// Every edit to a show — from the timeline, from Claude, from anywhere — is a
// list of ops applied here. A batch is all-or-nothing: if any op fails, the
// show is left untouched and the error says which op and why.

import { emptyShow, validateClip } from './schema.js';
import { resolveLength, resolveTime } from './timeexpr.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

function newId(prefix, taken) {
  for (;;) {
    const id = prefix + Math.random().toString(36).slice(2, 8);
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

function allIds(show) {
  const ids = new Set();
  for (const m of show.markers) ids.add(m.id);
  for (const t of show.tracks) { ids.add(t.id); for (const c of t.clips) ids.add(c.id); }
  return ids;
}

function findTrack(show, ref) {
  if (ref == null) return null;
  return show.tracks.find((t) => t.id === ref)
    ?? show.tracks.find((t) => t.name.toLowerCase() === String(ref).toLowerCase())
    ?? null;
}

function findClip(show, id) {
  for (const track of show.tracks) {
    const i = track.clips.findIndex((c) => c.id === id);
    if (i >= 0) return { track, index: i, clip: track.clips[i] };
  }
  return null;
}

const SHOW_META = {
  title: (v) => typeof v === 'string' && v.trim() ? null : 'title must be text',
  audio: (v) => v === null || typeof v === 'string' ? null : 'audio is a file name in songs/, or null',
  duration: (v) => Number.isFinite(v) && v > 0 ? null : 'duration must be seconds > 0',
  bpm: (v) => Number.isFinite(v) && v >= 20 && v <= 300 ? null : 'bpm must be 20–300',
  offset: (v) => Number.isFinite(v) ? null : 'offset must be seconds (where bar 1 beat 1 falls)',
  beatsPerBar: (v) => Number.isInteger(v) && v >= 1 && v <= 16 ? null : 'beatsPerBar must be a whole number 1–16',
};

// Turn a clip as written (times as expressions, maybe `length`) into a stored
// clip: times in seconds, no helper keys.
function buildClip(show, input, existing = {}) {
  const merged = { ...existing };
  for (const [k, v] of Object.entries(input)) {
    if (['track', 'length', 'id'].includes(k)) continue;
    if (v === null) delete merged[k]; else merged[k] = v;
  }
  if (input.start != null) merged.start = resolveTime(show, input.start);
  if (input.end != null) merged.end = resolveTime(show, input.end);
  if (input.length != null) merged.end = merged.start + resolveLength(show, input.length);
  if (input.start != null && input.end == null && input.length == null && existing.end != null && existing.start != null) {
    // Moving a clip by its start keeps its length.
    merged.end = merged.start + (existing.end - existing.start);
  }
  merged.start = r3(merged.start);
  merged.end = r3(merged.end);
  return merged;
}

const handlers = {
  setMeta(show, op) {
    const changed = [];
    for (const key of Object.keys(SHOW_META)) {
      if (op[key] === undefined) continue;
      const err = SHOW_META[key](op[key]);
      if (err) throw new Error(err);
      show[key] = op[key];
      changed.push(key);
    }
    return { changed };
  },

  setMarkers(show, op, ctx) {
    show.markers = [];
    return handlers.addMarkers(show, op, ctx);
  },

  addMarkers(show, op, ctx) {
    const ids = [];
    for (const m of op.markers ?? []) {
      if (!m.label) throw new Error('a marker needs a label');
      const t = r3(resolveTime(show, m.at ?? m.t));
      const id = newId('m', ctx.ids);
      show.markers.push({ id, t, label: String(m.label) });
      ids.push(id);
    }
    show.markers.sort((a, b) => a.t - b.t);
    return { ids };
  },

  updateMarker(show, op) {
    const m = show.markers.find((x) => x.id === op.id || x.label === op.id);
    if (!m) throw new Error(`no marker ${op.id}`);
    if (op.label != null) m.label = String(op.label);
    if (op.at != null || op.t != null) m.t = r3(resolveTime(show, op.at ?? op.t));
    show.markers.sort((a, b) => a.t - b.t);
    return { id: m.id };
  },

  deleteMarkers(show, op) {
    const kill = new Set(op.ids ?? []);
    const before = show.markers.length;
    show.markers = show.markers.filter((m) => !kill.has(m.id) && !kill.has(m.label));
    return { deleted: before - show.markers.length };
  },

  addTrack(show, op, ctx) {
    if (!op.name) throw new Error('a track needs a name');
    const track = { id: newId('t', ctx.ids), name: String(op.name), muted: false, clips: [] };
    const at = Number.isInteger(op.index) ? op.index : show.tracks.length;
    show.tracks.splice(at, 0, track);
    return { id: track.id };
  },

  updateTrack(show, op) {
    const track = findTrack(show, op.id);
    if (!track) throw new Error(`no track ${op.id}`);
    if (op.name != null) track.name = String(op.name);
    if (op.muted != null) track.muted = Boolean(op.muted);
    if (Number.isInteger(op.index)) {
      show.tracks.splice(show.tracks.indexOf(track), 1);
      show.tracks.splice(Math.max(0, Math.min(show.tracks.length, op.index)), 0, track);
    }
    return { id: track.id };
  },

  deleteTrack(show, op) {
    const track = findTrack(show, op.id);
    if (!track) throw new Error(`no track ${op.id}`);
    show.tracks.splice(show.tracks.indexOf(track), 1);
    return { id: track.id, clipsDeleted: track.clips.length };
  },

  addClips(show, op, ctx) {
    let track = findTrack(show, op.track);
    if (!track) {
      if (!op.track) throw new Error(`addClips needs a track — tracks: ${show.tracks.map((t) => t.name).join(', ')}`);
      track = { id: newId('t', ctx.ids), name: String(op.track), muted: false, clips: [] };
      show.tracks.push(track);
    }
    const ids = [];
    (op.clips ?? []).forEach((input, i) => {
      if (input.start == null) throw new Error(`clip ${i + 1}: needs a start`);
      if (input.end == null && input.length == null) throw new Error(`clip ${i + 1}: needs an end or a length`);
      const clip = { id: newId('c', ctx.ids), ...buildClip(show, input) };
      const errors = validateClip(ctx.rig, clip);
      if (errors.length) throw new Error(`clip ${i + 1}${clip.label ? ` (${clip.label})` : ''}: ${errors.join('; ')}`);
      track.clips.push(clip);
      ids.push(clip.id);
    });
    track.clips.sort((a, b) => a.start - b.start);
    return { track: track.id, ids };
  },

  updateClips(show, op, ctx) {
    const ids = [];
    for (const patch of op.clips ?? []) {
      const hit = findClip(show, patch.id);
      if (!hit) throw new Error(`no clip ${patch.id}`);
      const clip = { id: hit.clip.id, ...buildClip(show, patch, hit.clip) };
      const errors = validateClip(ctx.rig, clip);
      if (errors.length) throw new Error(`clip ${patch.id}: ${errors.join('; ')}`);
      let target = hit.track;
      if (patch.track != null) {
        target = findTrack(show, patch.track);
        if (!target) throw new Error(`no track ${patch.track}`);
      }
      hit.track.clips.splice(hit.index, 1);
      target.clips.push(clip);
      target.clips.sort((a, b) => a.start - b.start);
      ids.push(clip.id);
    }
    return { ids };
  },

  deleteClips(show, op) {
    const kill = new Set(op.ids ?? []);
    const track = op.track != null ? findTrack(show, op.track) : null;
    if (op.track != null && !track) throw new Error(`no track ${op.track}`);
    const from = op.from != null ? resolveTime(show, op.from) : null;
    const to = op.to != null ? resolveTime(show, op.to) : null;
    const inRange = from != null || to != null;
    let deleted = 0;
    for (const t of show.tracks) {
      if (track && t !== track) continue;
      const keep = t.clips.filter((c) => {
        const byId = kill.has(c.id);
        const byRange = inRange && c.start >= (from ?? -Infinity) && c.end <= (to ?? Infinity);
        return !(byId || byRange);
      });
      deleted += t.clips.length - keep.length;
      t.clips = keep;
    }
    return { deleted };
  },

  replaceShow(show, op, ctx) {
    const next = { ...emptyShow(), ...op.show };
    for (const key of Object.keys(SHOW_META)) {
      const err = next[key] === undefined ? null : SHOW_META[key](next[key]);
      if (err) throw new Error(err);
    }
    for (const track of next.tracks) for (const clip of track.clips) {
      const errors = validateClip(ctx.rig, clip);
      if (errors.length) throw new Error(`clip ${clip.id}: ${errors.join('; ')}`);
    }
    Object.keys(show).forEach((k) => delete show[k]);
    Object.assign(show, next);
    return { replaced: true };
  },
};

export const OP_NAMES = Object.keys(handlers);

export function applyOps(show, rig, ops) {
  const next = structuredClone(show);
  const ctx = { rig, ids: allIds(next) };
  const results = [];
  ops.forEach((op, i) => {
    const handler = handlers[op?.op];
    if (!handler) throw new Error(`op ${i + 1}: unknown op "${op?.op}" — ops: ${OP_NAMES.join(', ')}`);
    try {
      results.push({ op: op.op, ...handler(next, op, ctx) });
    } catch (e) {
      throw new Error(ops.length > 1 ? `op ${i + 1} (${op.op}): ${e.message}` : e.message);
    }
  });
  return { show: next, results };
}

export function describeOps(results) {
  const parts = [];
  for (const r of results) {
    if (r.op === 'addClips') parts.push(`added ${r.ids.length} clip${r.ids.length === 1 ? '' : 's'}`);
    else if (r.op === 'updateClips') parts.push(`changed ${r.ids.length} clip${r.ids.length === 1 ? '' : 's'}`);
    else if (r.op === 'deleteClips') parts.push(`removed ${r.deleted} clip${r.deleted === 1 ? '' : 's'}`);
    else if (r.op === 'addMarkers' || r.op === 'setMarkers') parts.push(`set ${r.ids.length} marker${r.ids.length === 1 ? '' : 's'}`);
    else if (r.op === 'setMeta') parts.push(`set ${r.changed.join(', ')}`);
    else parts.push(r.op);
  }
  return parts.join(', ');
}
