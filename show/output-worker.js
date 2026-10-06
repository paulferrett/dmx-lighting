// DMX output, on its own thread. Playback and the light are what matter in a
// show; the 3D view, the timeline and the server's web work can stall and
// skip frames, and none of that may reach the rig. So this thread holds its
// own copy of the show and rig, keeps time from timestamped readings of the
// audio's position, evaluates the show 40 times a second and writes the
// ENTTEC. The main thread only posts it news.
//
// Clock readings are {t, playing, at}: the audio was at t seconds at wall
// time `at` (Date.now(), the same clock on this machine). A reading that
// arrives late is still exact, because time is extrapolated from `at`, not
// from when the message landed.

import { parentPort } from 'node:worker_threads';
import { evaluate } from './lib/engine.js';
import { encodeUniverse } from './lib/dmx.js';
import { Enttec, findDevice } from './enttec.js';

const FRAME_MS = 25;

let show = null;
let rig = null;
let clock = { t: 0, playing: false, at: Date.now() };
let blackout = false;

// `enabled` is what was asked for; `connected` is whether the port is open.
// When the ENTTEC drops off USB, output stays wanted and resumes on its own.
const output = { enabled: false, connected: false, device: findDevice(), error: null, frames: 0, lastFrameAt: null };
let enttec = null;
let last = new Uint8Array(512);
let resend = false;
let lastProbe = 0;

const status = () => parentPort.postMessage({ type: 'status', output: { ...output } });

function now() {
  const t = clock.playing ? clock.t + (Date.now() - clock.at) / 1000 : clock.t;
  return Math.max(0, Math.min(show?.duration ?? t, t));
}

function connect() {
  const path = process.env.DMX_DEVICE ?? findDevice();
  if (!path) { output.error = 'ENTTEC not connected — output will start when it is plugged in'; return false; }
  try {
    enttec = new Enttec(path);
    enttec.open();
    output.device = path;
    output.connected = true;
    output.error = null;
    resend = true;
    return true;
  } catch (e) {
    enttec?.close();
    enttec = null;
    output.error = `can't open ${path}: ${e.code ?? e.message} — retrying`;
    return false;
  }
}

function setOutput(enabled) {
  output.enabled = enabled;
  if (enabled && !enttec) connect();
  if (!enabled) {
    if (enttec) {
      // Leave the rig dark, not frozen on the last look.
      try { enttec.sendDmx(new Uint8Array(512)); } catch { /* port gone */ }
      enttec.close();
      enttec = null;
    }
    output.connected = false;
    output.error = null;
  }
  status();
}

function dropped(e) {
  enttec?.close();
  enttec = null;
  output.connected = false;
  const at = new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  output.error = `ENTTEC dropped at ${at} (${e.code ?? e.message}) — output resumes when it is back`;
  parentPort.postMessage({ type: 'log', text: output.error });
  status();
}

function tick() {
  if (!output.enabled) return;
  if (!enttec) {
    // Look for the device again once a second.
    if (Date.now() - lastProbe > 1000) { lastProbe = Date.now(); if (connect()) status(); else status(); }
    if (!enttec) return;
  }
  if (!show || !rig) return;
  let universe;
  try {
    const states = evaluate(show, rig, now()).fixtures;
    if (blackout) for (const s of Object.values(states)) s.dimmer = 0;
    universe = encodeUniverse(rig, states);
  } catch (e) {
    parentPort.postMessage({ type: 'log', text: `evaluate failed: ${e.message}` });
    return;
  }
  const changed = universe.some((v, i) => v !== last[i]);
  const stale = Date.now() - (output.lastFrameAt ?? 0) > 1000;
  if (!changed && !stale && !resend) return;
  try {
    enttec.sendDmx(universe);
    last = universe;
    resend = false;
    output.frames++;
    output.lastFrameAt = Date.now();
  } catch (e) {
    dropped(e);
  }
}

parentPort.on('message', (m) => {
  switch (m.type) {
    case 'show': show = m.show; break;
    case 'rig': rig = m.rig; break;
    case 'clock': clock = m.clock; break;
    case 'blackout': blackout = m.on; break;
    case 'output': setOutput(m.enabled); break;
    case 'status': status(); break;
    case 'shutdown': setOutput(false); process.exit(0);
  }
});

setInterval(tick, FRAME_MS);
// Frame counts for the console, a couple of times a second.
setInterval(() => { if (output.enabled) status(); }, 500);
status();
