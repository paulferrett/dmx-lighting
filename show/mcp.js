#!/usr/bin/env node
// MCP server: lets a Claude session read the rig and the music, write the
// show, scrub it, look at it and run it. Every tool goes through the show
// server's HTTP API, so the open browser updates as Claude works and undo
// covers Claude's edits like anyone else's. Starts the show server if it
// isn't already running.

import { spawn, execFile } from 'node:child_process';
import { openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const BASE = `http://localhost:${process.env.PORT ?? 8280}`;

async function ensureServer() {
  try { await fetch(`${BASE}/api/health`); return; } catch { /* not running */ }
  const log = openSync(join(ROOT, '.server.log'), 'a');
  spawn(process.execPath, [join(ROOT, 'server.js')], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { await fetch(`${BASE}/api/health`); return; } catch { /* still starting */ }
  }
  throw new Error(`the show server didn't start — see ${join(ROOT, '.server.log')}`);
}

async function api(method, path, body) {
  await ensureServer();
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
const tool = (fn) => async (args) => { try { return await fn(args ?? {}); } catch (e) { return fail(e); } };

const TIME = z.union([z.number(), z.string()]).describe('Seconds, "m:ss.s", "bar 17", "bar 17.3" (bar 17 beat 3), a marker label, or any of those with "+ 4 bars" / "- 2 beats" / "+ 1.5s".');
const CAMERA = z.enum(['front', 'wide', 'top', 'side', 'booth']);
const CLIP = z.looseObject({
  type: z.enum(['look', 'move', 'fx']),
  start: TIME,
  end: TIME.optional(),
  length: z.union([z.number(), z.string()]).optional().describe('Instead of end: "8 bars", "16 beats", "12s".'),
  fixtures: z.union([z.string(), z.array(z.string())]).optional().describe('Group name, fixture id, or a list. Default "all".'),
  fadeIn: z.number().optional(),
  fadeOut: z.number().optional(),
  label: z.string().optional(),
}).describe('A clip. Add the type\'s own fields alongside these (see rig_get → vocabulary).');

const GUIDE = `How a show works

• A show is tracks of clips over the song. Tracks apply top to bottom; a later
  track overrides only the attributes its clips set, so put the base look
  first, movement next, effects last. Overlapping clips on one track: the
  later-starting one wins.
• look = a state (dimmer, colour, gobo, prism, strobe, aim, crawl). Unset
  fields pass through from below. fadeIn/fadeOut blend from the layer below;
  a fade up from black arrives already in its colour.
• move = a figure around a centre aim, locked to the beat grid (period in beats).
• fx = beat-synced brightness (pulse, chase, flash, wave, sparkle) that
  multiplies the dimmer below it, or colourStep / goboStep.
• Times can be musical: "bar 17", "chorus 1 + 4 bars". Set bpm/offset first
  (song_analysis finds them) so bars land on the music, then mark sections.

The rig is four 150W beams: eight fixed colours, no mixing, no zoom. The
expressive range is movement and timing. Design with that:
• Channel 5 (crawl) — 0 for anything on the beat; high for slow ambient drifts.
• Positions reachable: tilt is ±90° from straight out of the base, so upright
  heads can't point below their own horizon (state shows clamped:true).
• Beams read best with haze and pointed over the crowd, not into eyes.
• A good show breathes: hold back in verses (fewer heads, slower moves,
  darker), open up on choruses, save prism/strobe/fast chase for drops.

Workflow: rig_get → song_analysis → show_settings (bpm, offset, duration) →
markers_set (sections) → clips_add per section → preview_snapshot to look →
adjust. preview_snapshot needs the console open in a browser (console_open).`;

const server = new McpServer({ name: 'dmx-show', version: '0.1.0' }, { instructions: GUIDE });

server.registerTool('rig_get', {
  title: 'Rig, vocabulary and the open show',
  description: 'Start here. The fixtures (positions in metres, addresses, groups, named aim targets), what each head can do, the full clip vocabulary with every field explained, the conventions, and a summary of the open show.',
  inputSchema: {},
}, tool(async () => {
  const [rig, vocabulary, { name, show }, health, shows] = await Promise.all([
    api('GET', '/api/rig'), api('GET', '/api/vocabulary'), api('GET', '/api/show'), api('GET', '/api/health'), api('GET', '/api/shows'),
  ]);
  return text({
    guide: GUIDE,
    console: { url: BASE, browsersOpen: health.clients },
    rig,
    vocabulary,
    openShow: {
      name, title: show.title, audio: show.audio, bpm: show.bpm, offset: show.offset, beatsPerBar: show.beatsPerBar, duration: show.duration,
      markers: show.markers, tracks: show.tracks.map((t) => ({ id: t.id, name: t.name, muted: t.muted, clips: t.clips.length })),
    },
    shows: shows.shows,
  });
}));

server.registerTool('rig_update', {
  title: 'Change the rig',
  description: 'Replace whole sections of the rig: fixtures (position [x,y,z] metres — x audience-left to right, y up, z toward the audience; mount "upright" or "hung"; yaw degrees; panOffset/tiltOffset/panInvert/tiltInvert to line the preview up with the real heads), groups, targets (name → [x,y,z]), stage ({haze 0–1, wall}). Read rig_get first and send back the full section you change.',
  inputSchema: {
    fixtures: z.array(z.looseObject({ id: z.string(), address: z.number(), position: z.array(z.number()).length(3) })).optional(),
    groups: z.record(z.string(), z.array(z.string())).optional(),
    targets: z.record(z.string(), z.array(z.number()).length(3)).optional(),
    stage: z.looseObject({}).optional(),
  },
}, tool(async (args) => {
  const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  const rig = await api('PUT', '/api/rig', body);
  return text({ ok: true, fixtures: rig.fixtures.map((f) => ({ id: f.id, position: f.position, mount: f.mount })), groups: Object.keys(rig.groups), targets: Object.keys(rig.targets) });
}));

server.registerTool('shows', {
  title: 'List, open or start a show',
  description: 'action "list" names the saved shows; "open" switches the console to one; "new" creates an empty show (Base look / Movement / Effects tracks) and opens it.',
  inputSchema: {
    action: z.enum(['list', 'open', 'new']),
    name: z.string().optional(),
    title: z.string().optional(),
    audio: z.string().optional().describe('new only: a file already in songs/.'),
  },
}, tool(async ({ action, name, title, audio }) => {
  if (action === 'list') return text(await api('GET', '/api/shows'));
  if (action === 'open') { const r = await api('POST', '/api/shows/open', { name }); return text({ opened: r.name }); }
  const r = await api('POST', '/api/shows', { name: name ?? title, title: title ?? name, audio });
  return text({ created: r.name });
}));

server.registerTool('show_get', {
  title: 'Read the open show',
  description: 'The open show in full: settings, markers, and every track and clip with ids. Pass from/to to see only clips overlapping that window.',
  inputSchema: { from: TIME.optional(), to: TIME.optional() },
}, tool(async ({ from, to }) => {
  const { name, show } = await api('GET', '/api/show');
  if (from == null && to == null) return text({ name, show });
  const state = async (t) => (await api('GET', `/api/state?t=${encodeURIComponent(t)}`)).t;
  const a = from != null ? await state(from) : 0;
  const b = to != null ? await state(to) : Infinity;
  return text({ name, show: { ...show, tracks: show.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.end > a && c.start < b) })) } });
}));

server.registerTool('show_settings', {
  title: 'Song, tempo and length',
  description: 'Set the show title, song (a file in songs/), bpm, offset (seconds where bar 1 beat 1 falls), beatsPerBar and duration. Set the grid before placing clips in bars.',
  inputSchema: {
    title: z.string().optional(), audio: z.string().nullable().optional(), bpm: z.number().optional(),
    offset: z.number().optional(), beatsPerBar: z.number().int().optional(), duration: z.number().optional(),
    summary: z.string().optional().describe('One line shown in the console, e.g. "tempo from the song".'),
  },
}, tool(async ({ summary, ...meta }) => {
  const set = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  const r = await api('POST', '/api/show/ops', { ops: [{ op: 'setMeta', ...set }], summary, source: 'mcp' });
  return text(r.summary);
}));

server.registerTool('markers_set', {
  title: 'Mark the song\'s sections',
  description: 'Add named markers (intro, verse 1, chorus 1, drop…). Clips can then start at "chorus 1" or "chorus 1 + 4 bars". replace: true clears existing markers first. Marker times take the same forms as clip times.',
  inputSchema: {
    markers: z.array(z.object({ at: TIME, label: z.string() })),
    replace: z.boolean().optional(),
    summary: z.string().optional(),
  },
}, tool(async ({ markers, replace, summary }) => {
  const r = await api('POST', '/api/show/ops', { ops: [{ op: replace ? 'setMarkers' : 'addMarkers', markers }], summary, source: 'mcp' });
  return text({ summary: r.summary, ids: r.results[0].ids });
}));

server.registerTool('clips_add', {
  title: 'Add clips',
  description: 'Add clips to a track (by name or id; a new name makes a new track). Each clip needs type, start and end or length, plus the type\'s fields — rig_get → vocabulary lists them all. The whole call is refused if any clip is invalid, with the reason, and nothing changes.',
  inputSchema: {
    track: z.string(),
    clips: z.array(CLIP).min(1),
    summary: z.string().optional().describe('One line shown in the console, e.g. "chorus 1: cyan fan, pulse on the beat".'),
  },
}, tool(async ({ track, clips, summary }) => {
  const r = await api('POST', '/api/show/ops', { ops: [{ op: 'addClips', track, clips }], summary, source: 'mcp' });
  return text({ summary: r.summary, track: r.results[0].track, ids: r.results[0].ids });
}));

server.registerTool('clips_update', {
  title: 'Change clips',
  description: 'Patch clips by id. Send only the fields to change; null removes a field (so it passes through from below). Changing start alone keeps the length; "track" moves a clip to another track.',
  inputSchema: {
    clips: z.array(z.looseObject({ id: z.string(), start: TIME.optional(), end: TIME.optional(), length: z.union([z.number(), z.string()]).optional(), track: z.string().optional() })).min(1),
    summary: z.string().optional(),
  },
}, tool(async ({ clips, summary }) => {
  const r = await api('POST', '/api/show/ops', { ops: [{ op: 'updateClips', clips }], summary, source: 'mcp' });
  return text(r.summary);
}));

server.registerTool('clips_delete', {
  title: 'Remove clips',
  description: 'Remove clips by id, or every clip lying wholly inside from–to (optionally on one track).',
  inputSchema: { ids: z.array(z.string()).optional(), track: z.string().optional(), from: TIME.optional(), to: TIME.optional(), summary: z.string().optional() },
}, tool(async ({ summary, ...op }) => {
  const r = await api('POST', '/api/show/ops', { ops: [{ op: 'deleteClips', ...op }], summary, source: 'mcp' });
  return text(r.summary);
}));

server.registerTool('tracks_edit', {
  title: 'Add, rename, mute, reorder or delete a track',
  description: 'action add (name, index?), rename (id, name), mute (id, muted), move (id, index — 0 is applied first), delete (id; its clips go too).',
  inputSchema: {
    action: z.enum(['add', 'rename', 'mute', 'move', 'delete']),
    id: z.string().optional().describe('Track id or name.'),
    name: z.string().optional(), muted: z.boolean().optional(), index: z.number().int().optional(),
  },
}, tool(async ({ action, id, name, muted, index }) => {
  const op = action === 'add' ? { op: 'addTrack', name, index }
    : action === 'delete' ? { op: 'deleteTrack', id }
      : { op: 'updateTrack', id, ...(action === 'rename' ? { name } : action === 'mute' ? { muted } : { index }) };
  const r = await api('POST', '/api/show/ops', { ops: [op], source: 'mcp' });
  return text(r.results[0]);
}));

server.registerTool('show_edit', {
  title: 'Several edits as one step',
  description: 'Apply a list of ops atomically — all or nothing, one undo step. Ops: setMeta {title,audio,bpm,offset,beatsPerBar,duration} · setMarkers/addMarkers {markers:[{at,label}]} · updateMarker {id,at?,label?} · deleteMarkers {ids} · addTrack {name,index?} · updateTrack {id,name?,muted?,index?} · deleteTrack {id} · addClips {track,clips} · updateClips {clips} · deleteClips {ids | track,from,to}. Use it to rebuild a section in one go: delete the old clips and add the new ones together.',
  inputSchema: { ops: z.array(z.looseObject({ op: z.string() })).min(1), summary: z.string().optional() },
}, tool(async ({ ops, summary }) => {
  const r = await api('POST', '/api/show/ops', { ops, summary, source: 'mcp' });
  return text({ summary: r.summary, results: r.results });
}));

server.registerTool('show_undo', {
  title: 'Undo or redo',
  description: 'Step the open show back (or forward with redo: true). Covers edits from the console and from Claude alike.',
  inputSchema: { redo: z.boolean().optional(), steps: z.number().int().min(1).max(50).optional() },
}, tool(async ({ redo, steps = 1 }) => {
  let r;
  for (let i = 0; i < steps; i++) r = await api('POST', redo ? '/api/show/redo' : '/api/show/undo');
  return text(r);
}));

server.registerTool('show_state_at', {
  title: 'What every head is doing at a moment',
  description: 'Evaluate the show at a time: per head the dimmer, colour, gobo, prism, strobe, pan/tilt (clamped:true if the aim is out of reach), crawl, and the raw DMX channel values; plus the ids of the clips in play. The numbers behind a snapshot.',
  inputSchema: { at: TIME },
}, tool(async ({ at }) => text(await api('GET', `/api/state?t=${encodeURIComponent(at)}`))));

server.registerTool('preview_snapshot', {
  title: 'Look at the show',
  description: 'Render the stage at a moment and return the picture. Pass times (up to 9) for a labelled contact sheet of several moments in one image — the quickest way to review a section. camera: front (from the crowd, default), wide, top, side, booth (behind the rig). Needs the console open in a browser.',
  inputSchema: { at: TIME.optional(), times: z.array(TIME).max(9).optional(), camera: CAMERA.optional() },
}, tool(async ({ at, times, camera }) => {
  const r = await api('POST', '/api/snapshot', { at, times, camera: camera ?? 'front' });
  if (r.error) throw new Error(r.error);
  const data = r.image.replace(/^data:image\/jpeg;base64,/, '');
  return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: times ? `contact sheet, ${times.length} frames, camera ${camera ?? 'front'}` : `t=${r.t.toFixed(2)}s, camera ${r.camera}` }] };
}));

server.registerTool('transport', {
  title: 'Play, pause, seek',
  description: 'Drive the console\'s playback: play, pause, stop (pause and go to the start), or seek. at seeks first (any time form). Needs the console open in a browser. Returns where the playhead is.',
  inputSchema: { action: z.enum(['play', 'pause', 'stop', 'seek']), at: TIME.optional() },
}, tool(async ({ action, at }) => {
  await api('POST', '/api/transport', { action: action === 'seek' ? undefined : action, at });
  await new Promise((r) => setTimeout(r, 400));
  return text(await api('GET', '/api/transport'));
}));

server.registerTool('output', {
  title: 'DMX output to the real heads',
  description: 'enabled: true sends the console\'s frames to the ENTTEC DMX USB PRO, so the real rig follows the show; false stops and leaves the rig dark. blackout: true holds every dimmer at 0 (on screen and on the rig) until blackout: false. With no arguments, reports status. Only turn output on when Paul has asked to run the real lights — and the Disco 240 must be unplugged from the line.',
  inputSchema: { enabled: z.boolean().optional(), blackout: z.boolean().optional() },
}, tool(async ({ enabled, blackout }) => {
  if (enabled == null && blackout == null) return text(await api('GET', '/api/output'));
  return text(await api('POST', '/api/output', { enabled, blackout }));
}));

server.registerTool('song_import', {
  title: 'Bring a song in',
  description: 'Copy an audio file (mp3, wav, m4a, aac, flac, ogg, aiff) from anywhere on this Mac into songs/. Then set it as the show\'s audio with show_settings.',
  inputSchema: { path: z.string() },
}, tool(async ({ path }) => text(await api('POST', '/api/songs/import', { path }))));

server.registerTool('song_analysis', {
  title: 'What\'s in the music',
  description: 'Analyse a song (default: the open show\'s): tempo, where bar 1 falls, and a per-bar table of energy, low end (kick/bass), high end (hats/vocals presence) and busyness, each 0–1 against the loudest bar; likely section changes on 4-bar phrase lines; likely drops. It hears energy, not words — name sections by reading the shape: a quiet low-end-light stretch is a verse or breakdown, full low end after a build is a drop or chorus. Takes a few seconds the first time.',
  inputSchema: { file: z.string().optional(), force: z.boolean().optional() },
}, tool(async ({ file, force }) => {
  const target = file ?? (await api('GET', '/api/show')).show.audio;
  if (!target) throw new Error('the open show has no song — pass file, or set one with show_settings');
  const a = await api('POST', '/api/songs/analyze', { file: target, force });
  const rows = a.bars.map((b) => `${String(b.bar).padStart(4)} ${b.t.toFixed(2).padStart(7)} ${b.energy.toFixed(2)} ${b.low.toFixed(2)} ${b.high.toFixed(2)} ${b.busy.toFixed(2)}`);
  return text([
    `${target}: ${a.duration.toFixed(1)}s, ${a.bpm} bpm (confidence ${a.bpmConfidence}), bar 1 at ${a.offset}s, ${a.beatsPerBar}/4`,
    `To use: show_settings bpm=${a.bpm} offset=${a.offset} duration=${Math.ceil(a.duration * 10) / 10}`,
    '',
    `Section changes: ${a.sections.map((s) => `bar ${s.bar} (${s.t}s, ${s.level}, Δ${s.change})`).join('; ')}`,
    `Drops: ${a.drops.length ? a.drops.map((d) => `bar ${d.bar} (${d.t}s, +${d.strength})`).join('; ') : 'none found'}`,
    '',
    ' bar    time   enrg  low high busy',
    ...rows,
  ].join('\n'));
}));

server.registerTool('console_open', {
  title: 'Open the console',
  description: 'Open the show console in Paul\'s default browser — the stage render, the timeline, the controls. Snapshots and transport need it open.',
  inputSchema: {},
}, tool(async () => {
  await ensureServer();
  await new Promise((res, rej) => execFile('open', [BASE], (e) => (e ? rej(e) : res())));
  return text(`opened ${BASE}`);
}));

await server.connect(new StdioServerTransport());
