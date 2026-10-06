// The console: wires the stage, timeline and inspector to the server. The
// audio element is the clock; every frame evaluates the show at its position,
// draws it, and (when output is on) sends the same bytes to the ENTTEC.

import { evaluate } from '/lib/engine.js';
import { encodeUniverse } from '/lib/dmx.js';
import { barBeatAt, formatClock, secondsPerBeat } from '/lib/timeexpr.js';
import { Stage, CAMERAS } from './stage.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';

const $ = (sel) => document.querySelector(sel);
const app = {
  show: null, rig: null, vocabulary: null, name: null, shows: [], songs: [], analysis: null,
  output: { enabled: false }, selection: [], playing: false, t: 0, blackout: false, states: {},
};

// ------------------------------------------------------------ server

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1000); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
}
const setConn = (ok) => { $('#conn').className = ok ? 'conn ok' : 'conn'; $('#conn').title = ok ? 'Connected to the show server' : 'Reconnecting…'; };

async function refreshLists() {
  const [shows, songs] = await Promise.all([api('GET', '/api/shows'), api('GET', '/api/songs')]);
  app.shows = shows.shows;
  app.songs = songs.songs;
}

function onMessage(msg) {
  switch (msg.type) {
    case 'hello':
      app.rig = msg.rig; app.vocabulary = msg.vocabulary; app.output = msg.output;
      if (!stage) boot();
      else stage.setRig(app.rig);
      setShow(msg.show, msg.name, 'server');
      refreshLists().then(renderInspector);
      break;
    case 'show': setShow(msg.show, msg.name, msg.source, msg.summary); break;
    case 'rig': app.rig = msg.rig; stage.setRig(app.rig); timeline.setShow(app.show, app.rig); renderInspector(); break;
    case 'output': app.output = msg.output; paintOutput(); renderInspector(); break;
    case 'transport': transport(msg); break;
    case 'blackout': setBlackout(msg.on ?? !app.blackout); break;
    case 'snapshot': snapshot(msg); break;
    case 'toast': toast(msg.text); break;
    case 'analysis': if (msg.file === app.show?.audio) loadAnalysis(); refreshLists().then(renderInspector); break;
  }
}

function setShow(show, name, source, summary) {
  const before = new Map();
  for (const t of app.show?.tracks ?? []) for (const c of t.clips) before.set(c.id, JSON.stringify(c));
  const fresh = new Set();
  if (source !== 'ui' && app.show && name === app.name) {
    for (const t of show.tracks) for (const c of t.clips) if (before.get(c.id) !== JSON.stringify(c)) fresh.add(c.id);
  }
  const switched = name !== app.name;
  app.show = show;
  app.name = name;
  if (switched) app.selection = [];
  timeline.setShow(show, app.rig, { fresh });
  if (switched) timeline.fit();
  if (show.audio !== app.loadedAudio) loadAudio();
  renderInspector();
  $('#title').textContent = show.title;
  if (summary && source !== 'ui') toast(`${source === 'mcp' ? 'Claude' : source}: ${summary}`, source === 'mcp' ? 'ai' : '');
}

async function commit(ops, summary, selectNew = false) {
  try {
    const r = await api('POST', '/api/show/ops', { ops, summary, source: 'ui' });
    if (selectNew) {
      app.selection = r.results.flatMap((x) => x.ids ?? []);
      timeline.select(app.selection);
      renderInspector();
    }
    return r;
  } catch (e) {
    toast(e.message, 'err');
    const { show, name } = await api('GET', '/api/show');
    setShow(show, name, 'ui');
  }
}

function duplicate(ids) {
  const picked = [];
  for (const t of app.show.tracks) for (const c of t.clips) if (ids.includes(c.id)) picked.push({ track: t.id, clip: c });
  if (!picked.length) return;
  const span = Math.max(...picked.map((p) => p.clip.end)) - Math.min(...picked.map((p) => p.clip.start));
  const byTrack = new Map();
  for (const { track, clip } of picked) {
    const { id, ...rest } = clip;
    if (!byTrack.has(track)) byTrack.set(track, []);
    byTrack.get(track).push({ ...rest, start: clip.start + span, end: clip.end + span });
  }
  commit([...byTrack].map(([track, clips]) => ({ op: 'addClips', track, clips })), 'duplicated', true);
}

// ------------------------------------------------------------ audio & clock

const audio = new Audio();
audio.preload = 'auto';
let clockBase = { perf: performance.now(), t: 0 };
let snapNext = true;
const hasAudio = () => Boolean(app.show?.audio) && audio.readyState >= 1;

async function loadAudio() {
  app.loadedAudio = app.show.audio;
  app.analysis = null;
  timeline.setAnalysis(null);
  if (!app.show.audio) { audio.removeAttribute('src'); audio.load(); return; }
  audio.src = `/songs/${encodeURIComponent(app.show.audio)}`;
  audio.currentTime = app.t;
  loadAnalysis();
}

async function loadAnalysis() {
  const file = app.show?.audio;
  if (!file) return;
  try {
    const a = await api('GET', `/api/songs/${encodeURIComponent(file)}/analysis`);
    if (file !== app.show.audio) return;
    app.analysis = a;
    timeline.setAnalysis(a);
    timeline.setShow(app.show, app.rig);
    renderInspector();
  } catch (e) { toast(e.message, 'err'); }
}

function currentTime() {
  if (hasAudio()) return audio.currentTime;
  return app.playing ? clockBase.t + (performance.now() - clockBase.perf) / 1000 : app.t;
}

function play() {
  if (app.playing) return;
  if (app.t >= app.show.duration - 0.05) seek(0);
  app.playing = true;
  clockBase = { perf: performance.now(), t: app.t };
  if (hasAudio()) audio.play().catch((e) => toast(`Audio: ${e.message}`, 'err'));
  paintTransport();
}

function pause() {
  if (!app.playing) return;
  app.t = currentTime();
  app.playing = false;
  audio.pause();
  paintTransport();
}

function seek(t) {
  app.t = Math.max(0, Math.min(app.show.duration, t));
  if (hasAudio()) audio.currentTime = app.t;
  clockBase = { perf: performance.now(), t: app.t };
  snapNext = true;
}

function transport(msg) {
  if (msg.t != null) seek(msg.t);
  if (msg.action === 'play') play();
  if (msg.action === 'pause' || msg.action === 'stop') pause();
  if (msg.action === 'toggle') app.playing ? pause() : play();
  if (msg.action === 'stop') seek(0);
}

function setBlackout(on) {
  app.blackout = on;
  $('#blackout').classList.toggle('on', on);
}

// ------------------------------------------------------------ frame loop

let stage, timeline, inspector;
let last = performance.now();
let liveTick = 0;

function frame() {
  const p = performance.now();
  const dt = Math.min(0.1, (p - last) / 1000);
  last = p;
  let t = currentTime();
  if (app.playing && (t >= app.show.duration || (hasAudio() && audio.ended))) { pause(); t = Math.min(t, app.show.duration); }
  app.t = t;
  const res = evaluate(app.show, app.rig, t);
  app.states = res.fixtures;
  stage.update(res.fixtures, t, { dt, snap: snapNext, blackout: app.blackout });
  snapNext = false;
  stage.render();
  timeline.setPlayhead(t, res.active);
  paintClock(t);
  if (p - liveTick > 100) { inspector.updateLive(res.fixtures, app.rig); paintLabels(); liveTick = p; }
  requestAnimationFrame(frame);
}

// DMX and clock go to the server on a timer, not the animation frame, so
// output keeps running when the tab isn't drawing.
setInterval(() => {
  if (!ws || ws.readyState !== 1 || !app.show) return;
  if (app.output.enabled && app.output.connected) {
    const states = app.blackout
      ? Object.fromEntries(Object.entries(app.states).map(([id, s]) => [id, { ...s, dimmer: 0 }]))
      : evaluate(app.show, app.rig, currentTime()).fixtures;
    ws.send(encodeUniverse(app.rig, states).buffer);
  }
}, 25);
setInterval(() => { if (ws?.readyState === 1 && app.show) ws.send(JSON.stringify({ type: 'clock', t: app.t, playing: app.playing })); }, 250);

// ------------------------------------------------------------ snapshots for Claude

async function snapshot(msg) {
  try {
    if (app.playing) pause();
    const render = (t, w, h, camera) => {
      const states = evaluate(app.show, app.rig, t).fixtures;
      stage.update(states, t, { snap: true, blackout: app.blackout });
      return stage.snapshot(camera, w, h);
    };
    let image;
    if (Array.isArray(msg.times) && msg.times.length) {
      // A contact sheet: several moments in one image, labelled.
      const cols = msg.times.length <= 4 ? 2 : 3;
      const rows = Math.ceil(msg.times.length / cols);
      const w = 640, h = 360;
      const sheet = document.createElement('canvas');
      sheet.width = cols * w; sheet.height = rows * h;
      const g = sheet.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, sheet.width, sheet.height);
      for (let i = 0; i < msg.times.length; i++) {
        const t = msg.times[i];
        const img = new Image();
        img.src = render(t, w, h, msg.camera);
        await img.decode();
        const x = (i % cols) * w, y = Math.floor(i / cols) * h;
        g.drawImage(img, x, y);
        const { bar, beat } = barBeatAt(app.show, t);
        g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, 210, 26);
        g.fillStyle = '#fff'; g.font = '15px ui-monospace, Menlo, monospace';
        g.fillText(`${formatClock(t)}  bar ${bar}.${Math.floor(beat)}`, x + 8, y + 18);
      }
      image = sheet.toDataURL('image/jpeg', 0.82);
    } else {
      image = render(msg.t ?? app.t, msg.width ?? 1280, msg.height ?? 720, msg.camera);
    }
    snapNext = true;
    ws.send(JSON.stringify({ type: 'snapshot', id: msg.id, image, t: msg.t ?? app.t, camera: msg.camera ?? 'current' }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'snapshot', id: msg.id, error: e.message }));
  }
}

// ------------------------------------------------------------ chrome

function paintClock(t) {
  const { bar, beat } = barBeatAt(app.show, t);
  $('#clock').textContent = formatClock(t);
  $('#barbeat').textContent = bar >= 1 ? `${bar}.${Math.floor(beat)}` : '—';
}
function paintTransport() { $('#play').textContent = app.playing ? '❚❚' : '▶'; }
function paintOutput() {
  const b = $('#output');
  const waiting = app.output.enabled && !app.output.connected;
  b.classList.toggle('on', app.output.enabled && !waiting);
  b.classList.toggle('waiting', waiting);
  b.textContent = waiting ? 'DMX waiting…' : app.output.enabled ? 'DMX LIVE' : 'DMX off';
  b.title = app.output.error ?? app.output.device ?? 'No ENTTEC found';
}
function paintLabels() {
  const pos = stage.labelPositions();
  for (const [id, p] of Object.entries(pos)) {
    let node = document.getElementById(`lbl-${id}`);
    if (!node) { node = document.createElement('div'); node.id = `lbl-${id}`; node.className = 'head-label'; node.textContent = id; $('#labels').append(node); }
    node.style.transform = `translate(${p.x}px, ${p.y}px)`;
    node.style.display = p.visible ? '' : 'none';
  }
}

let toastTimer;
function toast(text, kind = '') {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
}

function renderInspector() {
  if (!inspector || !app.show) return;
  const active = document.activeElement;
  if (active && $('#inspector').contains(active) && active.matches('input, select')) {
    active.addEventListener('blur', () => setTimeout(renderInspector, 0), { once: true });
    return;
  }
  inspector.render({ ...app, selection: app.selection });
}

async function setOutput(enabled) {
  try { app.output = await api('POST', '/api/output', { enabled }); } catch (e) { toast(e.message, 'err'); }
  paintOutput(); renderInspector();
}

function boot() {
  stage = new Stage($('#stage'), app.rig);
  timeline = new Timeline($('#timeline'), {
    seek: (t) => { seek(t); },
    select: (ids) => { app.selection = ids; renderInspector(); },
    commit,
    preview: () => {},
    isPlaying: () => app.playing,
  });
  inspector = new Inspector($('#inspector'), {
    commit,
    duplicate,
    openShow: async (name) => { try { await api('POST', '/api/shows/open', { name }); } catch (e) { toast(e.message, 'err'); } },
    newShow: async (name) => { try { await api('POST', '/api/shows', { name, title: name }); await refreshLists(); } catch (e) { toast(e.message, 'err'); } },
    setOutput,
  });

  const cams = $('#cams');
  Object.keys(CAMERAS).forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'btn small'; b.textContent = name; b.title = `Camera ${i + 1}`;
    b.onclick = () => stage.setCamera(name);
    cams.append(b);
  });
  $('#play').onclick = () => (app.playing ? pause() : play());
  $('#rewind').onclick = () => seek(0);
  $('#blackout').onclick = () => setBlackout(!app.blackout);
  $('#output').onclick = () => setOutput(!app.output.enabled);
  $('#undo').onclick = () => api('POST', '/api/show/undo').catch((e) => toast(e.message));
  $('#redo').onclick = () => api('POST', '/api/show/redo').catch((e) => toast(e.message));
  paintOutput();
  paintTransport();

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea, [contenteditable]')) return;
    const beat = secondsPerBeat(app.show);
    const meta = e.metaKey || e.ctrlKey;
    if (e.code === 'Space') { e.preventDefault(); app.playing ? pause() : play(); }
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(app.t + (e.shiftKey ? beat * app.show.beatsPerBar : beat)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(app.t - (e.shiftKey ? beat * app.show.beatsPerBar : beat)); }
    else if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); api('POST', e.shiftKey ? '/api/show/redo' : '/api/show/undo').catch((er) => toast(er.message)); }
    else if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(app.selection); }
    else if ((e.key === 'Backspace' || e.key === 'Delete') && app.selection.length) { e.preventDefault(); commit([{ op: 'deleteClips', ids: app.selection }]); app.selection = []; }
    else if (e.key.toLowerCase() === 'm' && !meta) commit([{ op: 'addMarkers', markers: [{ at: timeline.snapTime(app.t), label: `Marker ${app.show.markers.length + 1}` }] }]);
    else if (e.key.toLowerCase() === 'b' && !meta) setBlackout(!app.blackout);
    else if (e.key === 'Escape') { app.selection = []; timeline.select([]); renderInspector(); }
    else if (/^[1-5]$/.test(e.key) && !meta) stage.setCamera(Object.keys(CAMERAS)[Number(e.key) - 1]);
  });

  requestAnimationFrame(frame);
  window.showConsole = { app, stage, timeline, inspector, seek, play, pause };
}

connect();
