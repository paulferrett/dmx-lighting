// The console's engine room, outside React: the server link, the audio clock,
// the frame loop that evaluates the show and drives the stage and the
// playhead, DMX frames to the server, and snapshots for Claude.

import { evaluate } from '@engine/engine.js';
import { barBeatAt, formatClock, secondsPerBeat } from '@engine/timeexpr.js';
import { toast } from 'sonner';
import { getConsole, setConsole } from './store';
import type { Analysis, Clip, FixtureState, Op, Rig, Selection, Show } from '@/types';
import type { Stage } from '@/stage/stage';

// ------------------------------------------------------------------ server

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

let ws: WebSocket | null = null;

export function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => setConsole({ connected: true });
  ws.onclose = () => { setConsole({ connected: false }); setTimeout(connect, 1000); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
}

export async function refreshLists() {
  const [shows, songs] = await Promise.all([api('GET', '/api/shows'), api('GET', '/api/songs')]);
  setConsole({ shows: shows.shows, songs: songs.songs });
}

function onMessage(msg: any) {
  switch (msg.type) {
    case 'hello':
      setConsole({ rig: msg.rig, vocabulary: msg.vocabulary, output: msg.output, blackout: Boolean(msg.blackout) });
      stage?.setRig(msg.rig);
      applyShow(msg.show, msg.name, 'server');
      refreshLists();
      break;
    case 'show': applyShow(msg.show, msg.name, msg.source, msg.summary); break;
    case 'rig':
      setConsole({ rig: msg.rig });
      stage?.setRig(msg.rig);
      api('GET', '/api/vocabulary').then((v) => setConsole({ vocabulary: v }));
      break;
    case 'output': setConsole({ output: msg.output }); break;
    case 'transport': transport(msg); break;
    case 'blackout': setConsole({ blackout: msg.on ?? !getConsole().blackout }); break;
    case 'snapshot': snapshot(msg); break;
    case 'toast': toast(msg.text); break;
    case 'analysis': if (msg.file === getConsole().show?.audio) loadAnalysis(); refreshLists(); break;
  }
}

function applyShow(show: Show, name: string, source: string, summary?: string) {
  const { show: before, name: beforeName, selection } = getConsole();
  const fresh = new Set<string>();
  if (source !== 'ui' && before && name === beforeName) {
    const old = new Map<string, string>();
    for (const t of before.tracks) for (const c of t.clips) old.set(c.id, JSON.stringify(c));
    for (const t of show.tracks) for (const c of t.clips) if (old.get(c.id) !== JSON.stringify(c)) fresh.add(c.id);
  }
  let nextSelection: Selection = selection;
  if (name !== beforeName) nextSelection = { kind: 'none' };
  else if (selection.kind === 'clips') {
    const exists = new Set(show.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    const ids = selection.ids.filter((id) => exists.has(id));
    nextSelection = ids.length ? { kind: 'clips', ids } : { kind: 'none' };
  }
  preview = null;
  setConsole({ show, name, fresh, selection: nextSelection });
  if (show.audio !== loadedAudio) loadAudio(show);
  if (summary && source !== 'ui') toast(`${source === 'mcp' ? 'Claude' : source}: ${summary}`);
}

export async function commit(ops: Op[], summary?: string, selectNew = false) {
  try {
    const r = await api('POST', '/api/show/ops', { ops, summary, source: 'ui' });
    if (selectNew) {
      const ids = r.results.flatMap((x: any) => x.ids ?? []);
      if (ids.length) setConsole({ selection: { kind: 'clips', ids } });
    }
    return r;
  } catch (e: any) {
    toast.error(e.message);
    const { show, name } = await api('GET', '/api/show');
    applyShow(show, name, 'ui');
  }
}

export const undo = () => api('POST', '/api/show/undo').catch((e) => toast(e.message));
export const redo = () => api('POST', '/api/show/redo').catch((e) => toast(e.message));

export function duplicate(ids: string[]) {
  const show = getConsole().show;
  if (!show || !ids.length) return;
  const picked: { track: string; clip: Clip }[] = [];
  for (const t of show.tracks) for (const c of t.clips) if (ids.includes(c.id)) picked.push({ track: t.id, clip: c });
  if (!picked.length) return;
  const span = Math.max(...picked.map((p) => p.clip.end)) - Math.min(...picked.map((p) => p.clip.start));
  const byTrack = new Map<string, Partial<Clip>[]>();
  for (const { track, clip } of picked) {
    const { id: _id, ...rest } = clip;
    if (!byTrack.has(track)) byTrack.set(track, []);
    byTrack.get(track)!.push({ ...rest, start: clip.start + span, end: clip.end + span });
  }
  commit([...byTrack].map(([track, clips]) => ({ op: 'addClips', track, clips })), 'duplicated', true);
}

export async function saveRig(patch: Partial<Rig>) {
  try {
    const rig = await api<Rig>('PUT', '/api/rig', patch);
    setConsole({ rig });
    return rig;
  } catch (e: any) {
    toast.error(e.message);
    const rig = await api<Rig>('GET', '/api/rig');
    setConsole({ rig });
    stage?.setRig(rig);
  }
}

export async function setOutput(enabled: boolean) {
  try { setConsole({ output: await api('POST', '/api/output', { enabled }) }); } catch (e: any) { toast.error(e.message); }
}

export async function openShow(name: string) {
  try { await api('POST', '/api/shows/open', { name }); } catch (e: any) { toast.error(e.message); }
}

export async function newShow(name: string) {
  try { await api('POST', '/api/shows', { name, title: name }); await refreshLists(); } catch (e: any) { toast.error(e.message); }
}

// ------------------------------------------------------------------ audio & clock

/** The clock. Wavesurfer draws from this same element, so its cursor follows. */
export const audio = new Audio();
audio.preload = 'auto';
let loadedAudio: string | null | undefined;
let clockBase = { perf: performance.now(), t: 0 };
let t = 0;
let snapNext = true;

const hasAudio = () => Boolean(getConsole().show?.audio) && audio.readyState >= 1;

function loadAudio(show: Show) {
  loadedAudio = show.audio;
  setConsole({ analysis: null });
  if (!show.audio) { audio.removeAttribute('src'); audio.load(); return; }
  audio.src = `/songs/${encodeURIComponent(show.audio)}`;
  audio.currentTime = t;
  loadAnalysis();
}

export async function loadAnalysis() {
  const file = getConsole().show?.audio;
  if (!file) return;
  try {
    const a = await api<Analysis>('GET', `/api/songs/${encodeURIComponent(file)}/analysis`);
    if (file === getConsole().show?.audio) setConsole({ analysis: a });
  } catch (e: any) { toast.error(e.message); }
}

export function currentTime() {
  if (hasAudio()) return audio.currentTime;
  return getConsole().playing ? clockBase.t + (performance.now() - clockBase.perf) / 1000 : t;
}

export function play() {
  const { show, playing } = getConsole();
  if (!show || playing) return;
  if (t >= show.duration - 0.05) seek(0);
  clockBase = { perf: performance.now(), t };
  setConsole({ playing: true });
  if (hasAudio()) audio.play().catch((e) => toast.error(`Audio: ${e.message}`));
  reportClock();
}

export function pause() {
  if (!getConsole().playing) return;
  t = currentTime();
  setConsole({ playing: false });
  audio.pause();
  reportClock();
}

export const togglePlay = () => (getConsole().playing ? pause() : play());

export function seek(to: number) {
  const show = getConsole().show;
  t = Math.max(0, Math.min(show?.duration ?? Infinity, to));
  if (hasAudio()) audio.currentTime = t;
  clockBase = { perf: performance.now(), t };
  snapNext = true;
  reportClock();
}

export function nudge(beats: number) {
  const show = getConsole().show;
  if (show) seek(t + beats * secondsPerBeat(show));
}

function transport(msg: { action?: string; t?: number }) {
  if (msg.t != null) seek(msg.t);
  if (msg.action === 'play') play();
  if (msg.action === 'pause' || msg.action === 'stop') pause();
  if (msg.action === 'toggle') togglePlay();
  if (msg.action === 'stop') seek(0);
}

// ------------------------------------------------------------------ the frame loop

export interface TimelineHandle { setPlayhead(t: number, active: string[], playing: boolean): void }

let stage: Stage | null = null;
let timeline: TimelineHandle | null = null;
let preview: Show | null = null;
let states: Record<string, FixtureState> = {};

export const registerStage = (s: Stage | null) => { stage = s; snapNext = true; };
export const registerTimeline = (h: TimelineHandle | null) => { timeline = h; };
/** A working copy shown while a clip is being dragged, before it is committed. */
export const setPreview = (s: Show | null) => { preview = s; };

let last = performance.now();
let lastReadout = 0;
function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const { show, rig, playing, blackout } = getConsole();
  if (show && rig) {
    t = currentTime();
    if (playing && (t >= show.duration || (hasAudio() && audio.ended))) { pause(); t = Math.min(t, show.duration); }
    const res = evaluate(preview ?? show, rig, t);
    states = res.fixtures;
    if (stage) {
      stage.update(states, t, { dt, snap: snapNext, blackout });
      stage.render();
      snapNext = false;
    }
    timeline?.setPlayhead(t, res.active, playing);
    if (now - lastReadout > 66) { setConsole({ clock: t, live: states }); lastReadout = now; }
  }
  requestAnimationFrame(frame);
}

// The server's output thread makes the DMX; all it needs from here is where
// the audio is. Each reading carries the wall time it was taken, so one that
// is sent late (a slow frame, a background tab) is still exact. Readings go
// out on every play, pause and seek, and a few times a second while playing
// to trim drift between the audio clock and the wall clock.
function reportClock() {
  if (!ws || ws.readyState !== 1 || !getConsole().show) return;
  ws.send(JSON.stringify({ type: 'clock', t: currentTime(), playing: getConsole().playing, at: Date.now() }));
}

// Only a console that someone is driving reports: play, pause and seek here,
// and the periodic readings while this console is the one playing. A console
// that has just opened, or is sitting paused, says nothing, so opening a
// second window never moves a show that is running.
function startTimers() {
  setInterval(() => { if (getConsole().playing) reportClock(); }, 200);
  // The audio element stalls when it buffers; say so, so the light waits too,
  // and pick up again when it resumes.
  audio.addEventListener('waiting', () => { if (getConsole().playing) ws?.send(JSON.stringify({ type: 'clock', t: audio.currentTime, playing: false, at: Date.now() })); });
  audio.addEventListener('playing', () => { if (getConsole().playing) reportClock(); });
}

export async function setBlackout(on: boolean) {
  setConsole({ blackout: on });
  try { await api('POST', '/api/output', { blackout: on }); } catch (e: any) { toast.error(e.message); }
}

// ------------------------------------------------------------------ snapshots for Claude

async function snapshot(msg: any) {
  const reply = (body: object) => ws?.send(JSON.stringify({ type: 'snapshot', id: msg.id, ...body }));
  try {
    const { show, rig, blackout } = getConsole();
    if (!stage || !show || !rig) throw new Error('the stage is not ready');
    // No pause: a snapshot draws a frame, it doesn't touch playback. The
    // frame loop puts the stage back on the next animation frame.
    const render = (at: number, w: number, h: number) => {
      stage!.update(evaluate(show, rig, at).fixtures, at, { snap: true, blackout });
      return stage!.snapshot(msg.camera, w, h);
    };
    let image: string;
    if (Array.isArray(msg.times) && msg.times.length) {
      const cols = msg.times.length <= 4 ? 2 : 3;
      const rows = Math.ceil(msg.times.length / cols);
      const w = 640, h = 360;
      const sheet = document.createElement('canvas');
      sheet.width = cols * w; sheet.height = rows * h;
      const g = sheet.getContext('2d')!;
      g.fillStyle = '#000'; g.fillRect(0, 0, sheet.width, sheet.height);
      for (let i = 0; i < msg.times.length; i++) {
        const at = msg.times[i];
        const img = new Image();
        img.src = render(at, w, h);
        await img.decode();
        const x = (i % cols) * w, y = Math.floor(i / cols) * h;
        g.drawImage(img, x, y);
        const { bar, beat } = barBeatAt(show, at);
        g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, 210, 26);
        g.fillStyle = '#fff'; g.font = '15px ui-monospace, Menlo, monospace';
        g.fillText(`${formatClock(at)}  bar ${bar}.${Math.floor(beat)}`, x + 8, y + 18);
      }
      image = sheet.toDataURL('image/jpeg', 0.82);
    } else {
      image = render(msg.t ?? t, msg.width ?? 1280, msg.height ?? 720);
    }
    snapNext = true;
    reply({ image, t: msg.t ?? t, camera: msg.camera ?? 'current' });
  } catch (e: any) {
    reply({ error: e.message });
  }
}

let started = false;
export function start() {
  if (started) return;
  started = true;
  connect();
  startTimers();
  requestAnimationFrame(frame);
  // A handle for poking at the console from devtools (and headless tests).
  (window as any).showConsole = { getConsole, setConsole, seek, play, pause, getTime, stage: () => stage };
}

export const getTime = () => t;
