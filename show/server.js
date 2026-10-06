// The show server. Holds the open show, applies every edit (from the
// timeline or from Claude through mcp.js), keeps undo history, pushes changes
// to every open browser, relays transport and snapshot requests to the
// browser, and writes the browser's DMX frames to the ENTTEC.
//
// The browser is the clock: it plays the audio, evaluates the show at the
// audio's position, draws it, and sends the same bytes here for output.
//
//   npm start            → http://localhost:8280

import { createServer } from 'node:http';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { basename, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import { applyOps, describeOps } from './lib/ops.js';
import { clipTypes, COMMON_PARAMS, emptyShow } from './lib/schema.js';
import { evaluate } from './lib/engine.js';
import { encodeUniverse, fixtureChannels } from './lib/dmx.js';
import { analyse, decode } from './lib/analysis.js';
import { barBeatAt, resolveTime } from './lib/timeexpr.js';
import { findDevice } from './enttec.js';
import { Worker } from 'node:worker_threads';
import { prettyJson } from './lib/prettyjson.js';
import { normaliseRig } from './lib/rig.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 8280);
// SHOW_DATA points shows/, rig.json and the open-show state somewhere else —
// a scratch copy for testing next to a console that is running a real show.
const DATA = process.env.SHOW_DATA ?? ROOT;
const SHOWS = join(DATA, 'shows');
const SONGS = join(ROOT, 'songs');
const RIG_FILE = join(DATA, 'rig.json');
const STATE_FILE = join(DATA, '.state.json');
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.aif']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
};

mkdirSync(SHOWS, { recursive: true });
mkdirSync(SONGS, { recursive: true });

// ---------------------------------------------------------------- state

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'show';

let rig = readJson(RIG_FILE, null);
if (!rig) throw new Error(`can't read ${RIG_FILE}`);
normaliseRig(rig);

const state = readJson(STATE_FILE, {});
const showPath = (name) => join(SHOWS, `${name}.json`);
const listShows = () => readdirSync(SHOWS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

let currentName = state.current && existsSync(showPath(state.current)) ? state.current : listShows()[0];
if (!currentName) {
  currentName = 'untitled';
  writeFileSync(showPath(currentName), prettyJson(emptyShow('Untitled show')));
}
let show = readJson(showPath(currentName), emptyShow());
const history = new Map(); // name → { past: string[], future: string[] }
let lastWritten = { show: null, rig: prettyJson(rig) };

function saveState() { writeFileSync(STATE_FILE, JSON.stringify({ current: currentName }, null, 2) + '\n'); }

function writeShow() {
  const text = prettyJson(show);
  lastWritten.show = text;
  const tmp = showPath(currentName) + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, showPath(currentName));
}

function hist(name = currentName) {
  if (!history.has(name)) history.set(name, { past: [], future: [] });
  return history.get(name);
}

function commit(ops, { summary, source = 'ui' } = {}) {
  const { show: next, results } = applyOps(show, rig, ops);
  const h = hist();
  h.past.push(JSON.stringify(show));
  if (h.past.length > 200) h.past.shift();
  h.future = [];
  show = next;
  writeShow();
  const text = summary || describeOps(results);
  broadcast({ type: 'show', name: currentName, show, summary: text, source });
  return { results, summary: text };
}

function openShow(name) {
  if (!existsSync(showPath(name))) throw new Error(`no show "${name}" — shows: ${listShows().join(', ')}`);
  currentName = name;
  show = readJson(showPath(name), emptyShow());
  saveState();
  broadcast({ type: 'show', name: currentName, show, summary: `opened ${name}`, source: 'server' });
}

// Pick up edits made outside the server: git checkout, a hand edit.
watch(SHOWS, (event, file) => {
  if (file !== `${currentName}.json`) return;
  let text;
  try { text = readFileSync(showPath(currentName), 'utf8'); } catch { return; }
  if (text === lastWritten.show) return;
  try { show = JSON.parse(text); lastWritten.show = text; } catch { return; }
  broadcast({ type: 'show', name: currentName, show, summary: 'reloaded from disk', source: 'disk' });
});
watch(RIG_FILE, () => {
  let text;
  try { text = readFileSync(RIG_FILE, 'utf8'); } catch { return; }
  if (text === lastWritten.rig) return;
  try { rig = JSON.parse(text); lastWritten.rig = text; } catch { return; }
  broadcast({ type: 'rig', rig });
});

// ---------------------------------------------------------------- output

// DMX runs on its own thread (output-worker.js) so nothing here — HTTP, Vite,
// song analysis — can make the light stutter. The worker gets every show and
// rig change, the audio clock readings from the browser, and blackout; it
// reports its status back.
let outputWorker;
let outputState = { enabled: false, connected: false, device: findDevice(), error: null, frames: 0, lastFrameAt: null };
let blackout = false;
let statusWaiters = [];

function startOutputWorker() {
  outputWorker = new Worker(new URL('./output-worker.js', import.meta.url), { env: process.env });
  outputWorker.on('message', (m) => {
    if (m.type === 'log') console.log(m.text);
    if (m.type === 'status') {
      const before = outputState;
      outputState = m.output;
      statusWaiters.forEach((w) => w(outputState));
      statusWaiters = [];
      if (before.enabled !== outputState.enabled || before.connected !== outputState.connected || before.error !== outputState.error || outputState.enabled) broadcastOutput();
    }
  });
  outputWorker.on('error', (e) => console.error('output worker:', e));
  outputWorker.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`output worker exited (${code}) — restarting`);
    const wanted = outputState.enabled;
    startOutputWorker();
    if (wanted) outputWorker.postMessage({ type: 'output', enabled: true });
  });
  outputWorker.postMessage({ type: 'rig', rig });
  outputWorker.postMessage({ type: 'show', show });
  outputWorker.postMessage({ type: 'clock', clock });
  outputWorker.postMessage({ type: 'blackout', on: blackout });
}

function setOutput(enabled) {
  const next = new Promise((resolveStatus) => statusWaiters.push(resolveStatus));
  outputWorker.postMessage({ type: 'output', enabled });
  return Promise.race([next, new Promise((r) => setTimeout(() => r(outputState), 1000))]);
}

function setBlackout(on) {
  blackout = on;
  outputWorker.postMessage({ type: 'blackout', on });
  broadcast({ type: 'blackout', on });
}

const outputStatus = () => outputState;
function broadcastOutput() { broadcast({ type: 'output', output: outputStatus() }); }

// ---------------------------------------------------------------- browser link

const clients = new Set();
// The audio's position as last reported by the browser: it was at t seconds
// at wall time `at`. Extrapolated, never trusted to arrive on time.
let clock = { t: 0, playing: false, at: Date.now() };
const clockNow = () => (clock.playing ? clock.t + (Date.now() - clock.at) / 1000 : clock.t);
const pendingSnapshots = new Map();

function broadcast(msg) {
  if (msg.type === 'show') outputWorker?.postMessage({ type: 'show', show: msg.show });
  if (msg.type === 'rig') outputWorker?.postMessage({ type: 'rig', rig: msg.rig });
  const text = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(text);
}

function liveClients() { return [...clients].filter((ws) => ws.readyState === 1); }

function requestSnapshot(params) {
  const ws = liveClients().at(-1);
  if (!ws) return Promise.reject(new Error('no browser has the show open — open http://localhost:8280 and try again'));
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { pendingSnapshots.delete(id); reject(new Error('the browser did not answer within 30s')); }, 30000);
    pendingSnapshots.set(id, { resolve: resolvePromise, timer });
    ws.send(JSON.stringify({ type: 'snapshot', id, ...params }));
  });
}

// ---------------------------------------------------------------- songs

const songPath = (file) => {
  const p = normalize(join(SONGS, basename(file)));
  if (!existsSync(p)) throw new Error(`no song "${file}" in songs/ — songs: ${listSongs().map((s) => s.file).join(', ') || 'none'}`);
  return p;
};
const listSongs = () => readdirSync(SONGS).filter((f) => AUDIO_EXT.has(extname(f).toLowerCase())).sort()
  .map((file) => ({ file, analysed: existsSync(join(SONGS, `${file}.analysis.json`)) }));

const analysing = new Map();
async function analysisFor(file, { force = false } = {}) {
  const src = songPath(file);
  const cache = `${src}.analysis.json`;
  if (!force && existsSync(cache) && statSync(cache).mtimeMs >= statSync(src).mtimeMs) return readJson(cache, null);
  if (!analysing.has(file)) {
    analysing.set(file, (async () => {
      broadcast({ type: 'toast', text: `Analysing ${file}…` });
      const samples = await decode(src);
      const result = { file, ...analyse(samples, 22050) };
      writeFileSync(cache, JSON.stringify(result));
      broadcast({ type: 'analysis', file });
      return result;
    })().finally(() => analysing.delete(file)));
  }
  return analysing.get(file);
}

// ---------------------------------------------------------------- http

// Only the console itself may talk to this server. Any page open in the
// browser can aim a request or a WebSocket at localhost, so: the Host must be
// this server (no DNS rebinding), a browser Origin must be the console's own,
// and anything that changes state must be JSON, which a cross-site page can't
// send without a preflight this server never answers.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
function trusted(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function serveFile(req, res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    // Audio seeking needs byte ranges.
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

// Times from Claude arrive as numbers or expressions: "bar 17", "chorus 1 + 2 beats".
function timeParam(raw, fallback = 0) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'number') return raw;
  return /^-?\d+(\.\d+)?$/.test(String(raw).trim()) ? Number(raw) : resolveTime(show, String(raw));
}

function stateAt(t) {
  const { fixtures, active } = evaluate(show, rig, t);
  const universe = encodeUniverse(rig, fixtures);
  const channels = fixtureChannels(rig, universe);
  const out = {};
  for (const [id, s] of Object.entries(fixtures)) {
    const { dimmerSet, ...rest } = s;
    out[id] = { ...rest, pan: Math.round(s.pan * 10) / 10, tilt: Math.round(s.tilt * 10) / 10, dimmer: Math.round(s.dimmer * 1000) / 1000, dmx: channels[id] };
  }
  return { t, ...barBeatAt(show, t), active, fixtures: out };
}

const routes = {
  'GET /api/health': () => ({ ok: true, show: currentName, clients: liveClients().length }),
  'GET /api/rig': () => rig,
  'PUT /api/rig': (body) => {
    const next = { ...rig };
    for (const key of ['fixtures', 'groups', 'targets', 'room', 'home', 'name', 'notes']) if (body[key] !== undefined) next[key] = body[key];
    normaliseRig(next);
    const text = prettyJson(next);
    lastWritten.rig = text;
    writeFileSync(RIG_FILE, text);
    rig = next;
    broadcast({ type: 'rig', rig });
    return rig;
  },
  'GET /api/vocabulary': () => ({ common: COMMON_PARAMS, types: clipTypes(rig) }),
  'GET /api/shows': () => ({ current: currentName, shows: listShows() }),
  'POST /api/shows': (body) => {
    const name = slug(body.name ?? body.title ?? 'show');
    if (existsSync(showPath(name))) throw new Error(`a show called "${name}" already exists`);
    const fresh = { ...emptyShow(body.title ?? name), ...(body.audio ? { audio: body.audio } : {}) };
    writeFileSync(showPath(name), prettyJson(fresh));
    openShow(name);
    return { name, show };
  },
  'POST /api/shows/open': (body) => { openShow(body.name); return { name: currentName, show }; },
  'GET /api/show': () => ({ name: currentName, show }),
  'POST /api/show/ops': (body) => commit(body.ops ?? [], { summary: body.summary, source: body.source }),
  'POST /api/show/undo': () => {
    const h = hist();
    if (!h.past.length) throw new Error('nothing to undo');
    h.future.push(JSON.stringify(show));
    show = JSON.parse(h.past.pop());
    writeShow();
    broadcast({ type: 'show', name: currentName, show, summary: 'undo', source: 'undo' });
    return { ok: true, undoLeft: h.past.length };
  },
  'POST /api/show/redo': () => {
    const h = hist();
    if (!h.future.length) throw new Error('nothing to redo');
    h.past.push(JSON.stringify(show));
    show = JSON.parse(h.future.pop());
    writeShow();
    broadcast({ type: 'show', name: currentName, show, summary: 'redo', source: 'undo' });
    return { ok: true, redoLeft: h.future.length };
  },
  'GET /api/state': (_, url) => stateAt(timeParam(url.searchParams.get('t'), clockNow())),
  'GET /api/songs': () => ({ songs: listSongs() }),
  'POST /api/songs/import': (body) => {
    const src = String(body.path ?? '').replace(/^~(?=\/)/, process.env.HOME);
    if (!existsSync(src)) throw new Error(`no file at ${src}`);
    if (!AUDIO_EXT.has(extname(src).toLowerCase())) throw new Error(`${extname(src)} isn't an audio type this reads — ${[...AUDIO_EXT].join(' ')}`);
    const file = basename(src);
    copyFileSync(src, join(SONGS, file));
    return { file };
  },
  'POST /api/songs/analyze': async (body) => analysisFor(body.file, { force: Boolean(body.force) }),
  'GET /api/transport': () => ({ t: clockNow(), playing: clock.playing, reportedAgoMs: Date.now() - clock.at, clients: liveClients().length }),
  'POST /api/transport': (body) => {
    if (!liveClients().length) throw new Error('no browser has the show open — open http://localhost:8280');
    broadcast({ type: 'transport', action: body.action, t: body.at != null ? timeParam(body.at) : body.t });
    return { ok: true };
  },
  'GET /api/output': () => outputStatus(),
  'POST /api/output': async (body) => {
    if (body.blackout != null) setBlackout(Boolean(body.blackout));
    if (body.enabled != null) return { ...(await setOutput(Boolean(body.enabled))), blackout };
    return { ...outputStatus(), blackout };
  },
  'POST /api/snapshot': async (body) => requestSnapshot({
    camera: body.camera,
    width: body.width,
    height: body.height,
    t: body.at != null ? timeParam(body.at) : body.t,
    times: body.times?.map((x) => timeParam(x)),
  }),
};

const server = createServer(async (req, res) => {
  if (!trusted(req)) return send(res, 403, { error: 'not from the show console' });
  if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return send(res, 415, { error: 'send JSON' });
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) {
      const body = req.method === 'GET' ? {} : await readBody(req);
      return send(res, 200, await routes[key](body, url));
    }
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/songs\/(.+)\/analysis$/))) {
      return send(res, 200, await analysisFor(decodeURIComponent(m[1])));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/songs/')) return serveFile(req, res, songPath(decodeURIComponent(url.pathname.slice(7))));
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    // Everything else is the console, served by Vite.
    vite.middlewares(req, res, () => send(res, 404, { error: 'not found' }));
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

startOutputWorker();

// The console is a Vite app, run in middleware mode: no build step, and edits
// reload live. Its HMR socket shares this server; ours is /ws.
const vite = await createViteServer({
  configFile: join(ROOT, 'vite.config.ts'),
  server: { middlewareMode: true, ws: { server, path: '/__vite' } },
  appType: 'spa',
  logLevel: 'warn',
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return; // Vite's HMR
  if (!trusted(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', name: currentName, show, rig, output: outputStatus(), blackout, vocabulary: { common: COMMON_PARAMS, types: clipTypes(rig) } }));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'clock' && Number.isFinite(msg.t)) {
      clock = { t: msg.t, playing: Boolean(msg.playing), at: Number.isFinite(msg.at) ? msg.at : Date.now() };
      outputWorker.postMessage({ type: 'clock', clock });
    }
    if (msg.type === 'snapshot') {
      const pending = pendingSnapshots.get(msg.id);
      if (pending) { clearTimeout(pending.timer); pendingSnapshots.delete(msg.id); pending.resolve(msg.error ? { error: msg.error } : { image: msg.image, t: msg.t, camera: msg.camera }); }
    }
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`show server on http://localhost:${PORT} — show "${currentName}", ENTTEC ${outputState.device ?? "not found"}`);
});

let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  // The worker darkens the rig before it exits.
  outputWorker.postMessage({ type: 'shutdown' });
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
