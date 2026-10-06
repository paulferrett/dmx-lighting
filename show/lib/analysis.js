// Song analysis, enough to design to: tempo, where bar 1 falls, energy per
// bar in three bands, likely section changes, and likely drops. ffmpeg
// decodes; the rest is plain JS over the samples.
//
// It is a heuristic pass, not a music model. It knows nothing about verse vs
// chorus — it sees where the energy changes, on phrase boundaries. Claude
// names the sections by listening through these numbers; allin1 (see
// plans/song-to-show.md) would label them properly and can replace this later.

import { spawn } from 'node:child_process';

export function decode(file, sampleRate = 22050) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { err += c; });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${file}: ${err.trim()}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

function biquad(samples, sr, kind, freq, q = 0.707) {
  const w0 = 2 * Math.PI * freq / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  if (kind === 'low') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
  else { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

function frameRms(samples, hop) {
  const n = Math.floor(samples.length / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const o = f * hop;
    for (let i = 0; i < hop; i++) { const v = samples[o + i]; sum += v * v; }
    out[f] = Math.sqrt(sum / hop);
  }
  return out;
}

const normalise = (arr) => {
  let max = 0;
  for (const v of arr) if (v > max) max = v;
  return max > 0 ? Array.from(arr, (v) => v / max) : Array.from(arr, () => 0);
};

function onsetEnvelope(bands, n, weights = bands.map(() => 1)) {
  const env = new Float32Array(n);
  bands.forEach((band, b) => {
    for (let i = 1; i < n; i++) {
      const d = Math.log(band[i] + 1e-4) - Math.log(band[i - 1] + 1e-4);
      if (d > 0) env[i] += weights[b] * d;
    }
  });
  // subtract a local mean so steady loud passages don't read as onsets
  const w = 16;
  const out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += env[i];
    if (i >= w) acc -= env[i - w];
    out[i] = Math.max(0, env[i] - acc / Math.min(i + 1, w));
  }
  return out;
}

function smooth(arr, radius = 2) {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, w = 0;
    for (let j = -radius; j <= radius; j++) {
      const v = arr[i + j];
      if (v === undefined) continue;
      const k = Math.exp(-0.5 * (j / (radius / 1.5)) ** 2);
      s += v * k; w += k;
    }
    out[i] = s / w;
  }
  return out;
}

// Tempo by autocorrelation, scored as a comb (the lag and its double and
// quadruple) on a smoothed envelope so fractional beat lengths still line up,
// with a gentle preference for ~120 BPM so 128 doesn't come back as 64.
function estimateTempo(onset, hopSec) {
  const env = smooth(onset);
  const maxLag = Math.ceil(4 * 60 / 60 / hopSec) + 2;
  const R = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    R[lag] = s;
  }
  const at = (x) => { const i = Math.floor(x); const f = x - i; return (R[i] ?? 0) * (1 - f) + (R[i + 1] ?? 0) * f; };
  const scores = [];
  for (let bpm = 60; bpm <= 200; bpm += 0.1) {
    const lag = 60 / bpm / hopSec;
    const comb = at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    scores.push({ bpm, s: comb * prior });
  }
  let best = scores[0];
  for (const x of scores) if (x.s > best.s) best = x;
  const mean = scores.reduce((p, x) => p + x.s, 0) / scores.length;
  return { bpm: best.bpm, confidence: best.s > 0 ? Math.max(0, 1 - mean / best.s) : 0 };
}

const sample = (env, x) => { const i = Math.floor(x); const f = x - i; return (env[i] ?? 0) * (1 - f) + (env[i + 1] ?? 0) * f; };

function bestPhase(env, period, steps = 48) {
  let best = { phase: 0, s: -1 };
  for (let k = 0; k < steps; k++) {
    const phase = (k / steps) * period;
    let s = 0;
    for (let x = phase; x < env.length - 1; x += period) s += sample(env, x);
    if (s > best.s) best = { phase, s };
  }
  return best;
}

// The autocorrelation gets within about a BPM; over a four-minute song that
// is a whole bar of drift. Refine by sliding a beat grid across the whole
// track and keeping the tempo and phase that land on the most onsets.
function refineGrid(env, hopSec, bpm) {
  let best = { bpm, phase: 0, s: -1 };
  for (let b = bpm - 1.5; b <= bpm + 1.5; b += 0.02) {
    const period = 60 / b / hopSec;
    const { phase, s } = bestPhase(env, period);
    if (s > best.s) best = { bpm: b, phase, s };
  }
  // and once more, finer, around the winner
  const coarse = best;
  for (let b = coarse.bpm - 0.03; b <= coarse.bpm + 0.03; b += 0.002) {
    const period = 60 / b / hopSec;
    const { phase, s } = bestPhase(env, period, 96);
    if (s > best.s) best = { bpm: b, phase, s };
  }
  return best;
}

export function analyse(samples, sampleRate, { beatsPerBar = 4 } = {}) {
  const hop = 512;
  const hopSec = hop / sampleRate;
  const duration = samples.length / sampleRate;
  const full = frameRms(samples, hop);
  const low = frameRms(biquad(samples, sampleRate, 'low', 150), hop);
  const high = frameRms(biquad(samples, sampleRate, 'high', 2500), hop);
  const n = full.length;

  const onset = onsetEnvelope([low, full, high], n, [1, 0.5, 0.25]);
  const { bpm: rawBpm, confidence } = estimateTempo(onset, hopSec);
  const grid = refineGrid(smooth(onset, 1), hopSec, rawBpm);
  const bpm = Math.round(grid.bpm * 100) / 100;
  const beatFrames = 60 / grid.bpm / hopSec;
  const beatPhase = grid.phase;

  // Downbeat: of the beatsPerBar candidate phases, the one whose beats carry
  // the most low-end onset.
  // Low-band level just after each beat, not its onset: on a four-on-the-floor
  // track every beat has a kick, and the accent is in how loud it is.
  const lowAccent = smooth(low, 2);
  let down = 0, downScore = -1;
  for (let k = 0; k < beatsPerBar; k++) {
    let s = 0;
    for (let x = beatPhase + k * beatFrames; x < n - 1; x += beatFrames * beatsPerBar) s += sample(lowAccent, x);
    if (s > downScore) { downScore = s; down = k; }
  }
  const barSec = beatsPerBar * 60 / bpm;
  let offset = (beatPhase + down * beatFrames) * hopSec;
  offset = ((offset % barSec) + barSec) % barSec;

  // Per-bar means, normalised to the loudest bar.
  const barStats = [];
  for (let t = offset, bar = 1; t < duration; t += barSec, bar++) {
    const a = Math.floor(t / hopSec);
    const b = Math.min(n, Math.floor((t + barSec) / hopSec));
    if (b <= a) break;
    let f = 0, l = 0, h = 0, o = 0;
    for (let i = a; i < b; i++) { f += full[i]; l += low[i]; h += high[i]; o += onset[i]; }
    const k = b - a;
    barStats.push({ bar, t: Math.round(t * 1000) / 1000, f: f / k, l: l / k, h: h / k, o: o / k });
  }
  const nf = normalise(barStats.map((x) => x.f));
  const nl = normalise(barStats.map((x) => x.l));
  const nh = normalise(barStats.map((x) => x.h));
  const no = normalise(barStats.map((x) => x.o));
  const r2 = (v) => Math.round(v * 100) / 100;
  const bars = barStats.map((x, i) => ({ bar: x.bar, t: x.t, energy: r2(nf[i]), low: r2(nl[i]), high: r2(nh[i]), busy: r2(no[i]) }));

  // Section changes: compare the 4 bars before each phrase boundary with the
  // 4 after. Big differences on a 4-bar line are where the song turns.
  const level = (e) => (e < 0.35 ? 'quiet' : e < 0.7 ? 'mid' : 'full');
  const mean = (arr, a, b, key) => { const s = arr.slice(Math.max(0, a), Math.max(0, b)); return s.length ? s.reduce((p, x) => p + x[key], 0) / s.length : 0; };
  const sections = [{ bar: 1, t: bars[0]?.t ?? 0, level: level(mean(bars, 0, 4, 'energy')), change: 1 }];
  for (let i = 4; i < bars.length - 1; i += 4) {
    const de = Math.abs(mean(bars, i, i + 4, 'energy') - mean(bars, i - 4, i, 'energy'));
    const dl = Math.abs(mean(bars, i, i + 4, 'low') - mean(bars, i - 4, i, 'low'));
    const dh = Math.abs(mean(bars, i, i + 4, 'high') - mean(bars, i - 4, i, 'high'));
    const change = de + 0.6 * dl + 0.4 * dh;
    if (change > 0.18) sections.push({ bar: bars[i].bar, t: bars[i].t, level: level(mean(bars, i, i + 4, 'energy')), change: r2(change) });
  }

  // Drops: the low end arriving hard after at least two thinner bars.
  const drops = [];
  for (let i = 2; i < bars.length; i++) {
    const before = Math.max(bars[i - 1].low, bars[i - 2].low);
    const jump = bars[i].low - before;
    if (bars[i].low > 0.65 && jump > 0.3) drops.push({ bar: bars[i].bar, t: bars[i].t, strength: r2(jump) });
  }

  // A coarse energy curve and waveform peaks, for drawing.
  const curveStep = 0.25;
  const per = Math.max(1, Math.round(curveStep / hopSec));
  const curve = { step: curveStep, energy: [], low: [] };
  const fn = normalise(full), ln = normalise(low);
  for (let i = 0; i < n; i += per) {
    let a = 0, b = 0, k = 0;
    for (let j = i; j < Math.min(n, i + per); j++) { a += fn[j]; b += ln[j]; k++; }
    curve.energy.push(r2(a / k)); curve.low.push(r2(b / k));
  }
  const peakRate = 50;
  const span = Math.floor(sampleRate / peakRate);
  const peaks = { rate: peakRate, min: [], max: [] };
  for (let i = 0; i < samples.length; i += span) {
    let lo = 0, hi = 0;
    for (let j = i; j < Math.min(samples.length, i + span); j++) { const v = samples[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    peaks.min.push(Math.round(lo * 127)); peaks.max.push(Math.round(hi * 127));
  }

  return {
    duration: Math.round(duration * 1000) / 1000,
    bpm,
    bpmConfidence: r2(confidence),
    offset: Math.round(offset * 1000) / 1000,
    beatsPerBar,
    bars,
    sections,
    drops,
    curve,
    peaks,
  };
}
