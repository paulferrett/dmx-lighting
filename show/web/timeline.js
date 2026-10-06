// The timeline: ruler in bars, the song's waveform with its energy, a row per
// track, clips you can drag, stretch and snap to the beat. Edits are applied
// to a working copy while the mouse is down, so the stage previews the drag,
// and committed as one op when it's let go.

import { barBeatAt, secondsPerBeat, timeOfBar } from '/lib/timeexpr.js';

const HEAD_W = 168;
const RULER_H = 30;
const WAVE_H = 64;
const LANE_H = 46;
const EDGE = 7;
const SUB_H = 26;

// Overlapping clips on one track get their own sub-rows, first fit, so a
// pulse and a colour step running together are both visible.
function stackClips(clips) {
  const ends = [];
  const rowOf = new Map();
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    let r = ends.findIndex((end) => end <= c.start + 1e-6);
    if (r < 0) { r = ends.length; ends.push(0); }
    ends[r] = c.end;
    rowOf.set(c.id, r);
  }
  return { rowOf, rows: Math.max(1, ends.length) };
}

const el = (tag, cls, attrs = {}) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  return n;
};

export function clipSummary(clip, rig) {
  if (clip.label) return clip.label;
  const parts = [];
  if (clip.type === 'look') {
    if (clip.dimmer != null) parts.push(`${Math.round(clip.dimmer * 100)}%`);
    if (clip.colourSpin) parts.push('colour spin');
    else if (clip.colour) parts.push(clip.colour);
    if (clip.gobo && clip.gobo !== 'open') parts.push(clip.gobo + (clip.goboMode && clip.goboMode !== 'static' ? ` ${clip.goboMode}` : ''));
    if (clip.prism && clip.prism !== 'off') parts.push(`prism ${clip.prism}`);
    if (clip.strobe) parts.push('strobe');
    if (clip.aim != null) parts.push(`→ ${typeof clip.aim === 'string' ? clip.aim : Array.isArray(clip.aim) ? 'point' : `${clip.aim.pan}/${clip.aim.tilt}`}`);
    if (clip.crawl) parts.push('crawl');
  } else if (clip.type === 'move') {
    parts.push(clip.figure ?? 'circle');
    if (!['fan', 'cross', 'still', 'snap'].includes(clip.figure)) parts.push(`/${clip.period ?? 4}`);
    if (clip.figure === 'snap') parts.push(`${clip.positions?.length ?? 1} pos /${clip.period ?? 4}`);
  } else {
    parts.push(clip.effect ?? 'pulse');
    parts.push(`/${clip.period ?? 1}`);
  }
  const fx = clip.fixtures && clip.fixtures !== 'all' ? ` · ${[].concat(clip.fixtures).join('+')}` : '';
  return parts.join(' · ') + fx;
}

function clipColour(clip, rig) {
  if (clip.type === 'look') {
    const type = Object.values(rig.fixtureTypes)[0];
    if (clip.colourSpin) return 'conic';
    const hex = type.colours.find((c) => c.name === clip.colour)?.hex;
    return hex ?? '#8a8a99';
  }
  return clip.type === 'move' ? '#5b7cfa' : '#c056ff';
}

export class Timeline {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.pps = 40;
    this.snap = 'beat';
    this.follow = true;
    this.selection = new Set();
    this.markerSelection = null;
    this.analysis = null;
    this.active = new Set();
    this.t = 0;
    this.build();
  }

  build() {
    this.root.innerHTML = '';
    const tools = el('div', 'tl-tools');
    tools.append(
      el('button', 'btn', { text: '−', title: 'Zoom out', onclick: () => this.zoom(1 / 1.5) }),
      el('button', 'btn', { text: '+', title: 'Zoom in (⌘ + scroll)', onclick: () => this.zoom(1.5) }),
      el('button', 'btn', { text: 'Fit', title: 'Fit the whole show', onclick: () => this.fit() }),
    );
    const snap = el('select', 'sel', { title: 'Snap', onchange: (e) => { this.snap = e.target.value; } });
    for (const [v, label] of [['bar', 'Snap: bar'], ['beat', 'Snap: beat'], ['half', 'Snap: ½ beat'], ['off', 'Snap: off']]) {
      const o = el('option', '', { value: v, text: label });
      if (v === this.snap) o.selected = true;
      snap.append(o);
    }
    const follow = el('label', 'chk');
    const box = el('input', '', { type: 'checkbox', onchange: (e) => { this.follow = e.target.checked; } });
    box.checked = true;
    follow.append(box, document.createTextNode(' Follow'));
    tools.append(snap, follow,
      el('button', 'btn', { text: '+ Track', onclick: () => this.hooks.commit([{ op: 'addTrack', name: `Track ${this.show.tracks.length + 1}` }]) }),
      el('span', 'tl-hint', { text: 'Double-click a lane to add a clip · drag edges to stretch · ⌥ drag ignores snap · M adds a marker' }));
    this.scroll = el('div', 'tl-scroll');
    this.root.append(tools, this.scroll);
    this.scroll.addEventListener('scroll', () => this.drawCanvases());
    this.scroll.addEventListener('wheel', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const x = e.clientX - this.scroll.getBoundingClientRect().left - HEAD_W + this.scroll.scrollLeft;
      const t = x / this.pps;
      this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, t, e.clientX - this.scroll.getBoundingClientRect().left - HEAD_W);
    }, { passive: false });
    new ResizeObserver(() => this.drawCanvases()).observe(this.scroll);
  }

  zoom(k, aroundT = null, screenX = null) {
    const viewW = this.scroll.clientWidth - HEAD_W;
    const t = aroundT ?? (this.scroll.scrollLeft + viewW / 2) / this.pps;
    const sx = screenX ?? viewW / 2;
    this.pps = Math.max(4, Math.min(600, this.pps * k));
    this.render();
    this.scroll.scrollLeft = Math.max(0, t * this.pps - sx);
  }

  fit() {
    const viewW = this.scroll.clientWidth - HEAD_W - 20;
    this.pps = Math.max(4, viewW / Math.max(10, this.show.duration));
    this.render();
    this.scroll.scrollLeft = 0;
  }

  setShow(show, rig, { fresh = new Set() } = {}) {
    this.show = show;
    this.rig = rig;
    for (const id of [...this.selection]) if (!this.findClip(id)) this.selection.delete(id);
    this.render(fresh);
  }

  setAnalysis(a) { this.analysis = a; this.drawCanvases(); }

  findClip(id) {
    for (const track of this.show.tracks) { const c = track.clips.find((x) => x.id === id); if (c) return { track, clip: c }; }
    return null;
  }

  gridStep() {
    const beat = secondsPerBeat(this.show);
    return { bar: beat * (this.show.beatsPerBar || 4), beat, half: beat / 2, off: 0 }[this.snap];
  }

  snapTime(t, free = false) {
    const step = this.gridStep();
    if (free || !step) return Math.max(0, Math.round(t * 1000) / 1000);
    const off = this.show.offset || 0;
    return Math.max(0, Math.round((off + Math.round((t - off) / step) * step) * 1000) / 1000);
  }

  render(fresh = new Set()) {
    if (!this.show) return;
    const width = HEAD_W + this.show.duration * this.pps + 200;
    this.scroll.innerHTML = '';
    this.inner = el('div', 'tl-inner');
    this.inner.style.width = `${width}px`;

    // Ruler with markers
    const rulerRow = el('div', 'tl-row tl-ruler-row');
    rulerRow.style.height = `${RULER_H}px`;
    rulerRow.append(el('div', 'tl-head tl-head-ruler', { text: this.show.title }));
    const rulerLane = el('div', 'tl-lane tl-ruler');
    this.rulerCanvas = el('canvas', 'tl-canvas');
    rulerLane.append(this.rulerCanvas);
    for (const m of this.show.markers) rulerLane.append(this.markerEl(m));
    rulerLane.addEventListener('pointerdown', (e) => { if (e.target === rulerLane || e.target === this.rulerCanvas) this.scrub(e, rulerLane); });
    rulerLane.addEventListener('dblclick', (e) => {
      if (e.target !== rulerLane && e.target !== this.rulerCanvas) return;
      const t = this.snapTime(this.timeAt(e, rulerLane));
      this.hooks.commit([{ op: 'addMarkers', markers: [{ at: t, label: `Marker ${this.show.markers.length + 1}` }] }]);
    });
    rulerRow.append(rulerLane);

    // Waveform
    const waveRow = el('div', 'tl-row tl-wave-row');
    waveRow.style.height = `${WAVE_H}px`;
    const waveHead = el('div', 'tl-head tl-head-wave');
    waveHead.append(el('div', 'tl-track-name', { text: this.show.audio ?? 'No song' }));
    if (this.analysis) waveHead.append(el('div', 'tl-sub', { text: `${this.analysis.bpm} bpm detected` }));
    waveRow.append(waveHead);
    const waveLane = el('div', 'tl-lane tl-wave');
    this.waveCanvas = el('canvas', 'tl-canvas');
    waveLane.append(this.waveCanvas);
    waveLane.addEventListener('pointerdown', (e) => this.scrub(e, waveLane));
    waveRow.append(waveLane);
    this.inner.append(rulerRow, waveRow);

    // Tracks
    this.clipEls = new Map();
    this.show.tracks.forEach((track, ti) => {
      const { rowOf, rows } = stackClips(track.clips);
      const row = el('div', `tl-row tl-track${track.muted ? ' muted' : ''}`);
      row.style.height = `${rows > 1 ? rows * SUB_H + 8 : LANE_H}px`;
      const head = el('div', 'tl-head');
      const name = el('div', 'tl-track-name', { text: track.name, title: 'Double-click to rename' });
      name.addEventListener('dblclick', () => this.inlineEdit(name, track.name, (v) => this.hooks.commit([{ op: 'updateTrack', id: track.id, name: v }])));
      const btns = el('div', 'tl-track-btns');
      btns.append(
        el('button', `mini${track.muted ? ' on' : ''}`, { text: 'M', title: 'Mute', onclick: () => this.hooks.commit([{ op: 'updateTrack', id: track.id, muted: !track.muted }]) }),
        el('button', 'mini', { text: '↑', title: 'Move up', onclick: () => ti > 0 && this.hooks.commit([{ op: 'updateTrack', id: track.id, index: ti - 1 }]) }),
        el('button', 'mini', { text: '×', title: 'Delete track (undo brings it back)', onclick: () => this.hooks.commit([{ op: 'deleteTrack', id: track.id }]) }),
      );
      head.append(name, el('div', 'tl-sub', { text: `${track.clips.length} clip${track.clips.length === 1 ? '' : 's'}` }), btns);
      const lane = el('div', 'tl-lane tl-clips');
      lane.dataset.track = track.id;
      lane.addEventListener('pointerdown', (e) => {
        if (e.target !== lane) return;
        if (!e.shiftKey) { this.selection.clear(); this.markerSelection = null; this.paintSelection(); this.hooks.select([...this.selection]); }
      });
      lane.addEventListener('dblclick', (e) => { if (e.target === lane) this.addClipAt(track, this.timeAt(e, lane)); });
      for (const clip of track.clips) {
        const c = this.clipEl(clip, track);
        if (rows > 1) { c.style.top = `${4 + rowOf.get(clip.id) * SUB_H}px`; c.style.bottom = 'auto'; c.style.height = `${SUB_H - 3}px`; }
        if (fresh.has(clip.id)) c.classList.add('fresh');
        lane.append(c);
        this.clipEls.set(clip.id, c);
      }
      row.append(head, lane);
      this.inner.append(row);
    });

    this.playhead = el('div', 'tl-playhead');
    this.inner.append(this.playhead);
    this.scroll.append(this.inner);
    this.paintSelection();
    this.setPlayhead(this.t, [...this.active], true);
    this.drawCanvases();
  }

  timeAt(e, lane) { return Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / this.pps); }

  scrub(e, lane) {
    e.preventDefault();
    const move = (ev) => this.hooks.seek(Math.min(this.show.duration, this.timeAt(ev, lane)));
    move(e);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  inlineEdit(node, value, done) {
    const input = el('input', 'inline-edit', { value });
    node.replaceWith(input);
    input.focus(); input.select();
    let finished = false;
    const finish = (save) => {
      if (finished) return; finished = true;
      input.replaceWith(node);
      const v = input.value.trim();
      if (save && v && v !== value) done(v);
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  }

  markerEl(m) {
    const node = el('div', `tl-marker${this.markerSelection === m.id ? ' sel' : ''}`, { title: `${m.label} — drag to move, double-click to rename, ⌥-click to delete` });
    node.style.left = `${m.t * this.pps}px`;
    const label = el('span', '', { text: m.label });
    node.append(label);
    node.addEventListener('dblclick', (e) => { e.stopPropagation(); this.inlineEdit(label, m.label, (v) => this.hooks.commit([{ op: 'updateMarker', id: m.id, label: v }])); });
    node.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.altKey) { this.hooks.commit([{ op: 'deleteMarkers', ids: [m.id] }]); return; }
      this.markerSelection = m.id;
      const x0 = e.clientX;
      let t = m.t;
      const move = (ev) => {
        t = this.snapTime(m.t + (ev.clientX - x0) / this.pps, ev.altKey);
        node.style.left = `${t * this.pps}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        if (t !== m.t) this.hooks.commit([{ op: 'updateMarker', id: m.id, at: t }]);
        else this.hooks.seek(m.t);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return node;
  }

  clipEl(clip, track) {
    const node = el('div', `tl-clip tl-${clip.type}${clip.muted ? ' muted' : ''}`);
    node.dataset.id = clip.id;
    this.placeClip(node, clip);
    const colour = clipColour(clip, this.rig);
    if (colour === 'conic') node.style.setProperty('--clip', '#fff'), node.classList.add('spin');
    else node.style.setProperty('--clip', colour);
    const len = clip.end - clip.start;
    if (clip.fadeIn > 0) { const f = el('div', 'fade-in'); f.style.width = `${(clip.fadeIn / len) * 100}%`; node.append(f); }
    if (clip.fadeOut > 0) { const f = el('div', 'fade-out'); f.style.width = `${(clip.fadeOut / len) * 100}%`; node.append(f); }
    node.append(el('span', 'tl-clip-label', { text: clipSummary(clip, this.rig) }));
    node.title = `${clipSummary(clip, this.rig)}\n${clip.type} · ${clip.start.toFixed(2)}–${clip.end.toFixed(2)}s`;
    node.addEventListener('pointerdown', (e) => this.dragClip(e, clip, track, node));
    node.addEventListener('pointermove', (e) => {
      const r = node.getBoundingClientRect();
      const x = e.clientX - r.left;
      node.style.cursor = x < EDGE || x > r.width - EDGE ? 'ew-resize' : 'grab';
    });
    return node;
  }

  placeClip(node, clip) {
    node.style.left = `${clip.start * this.pps}px`;
    node.style.width = `${Math.max(3, (clip.end - clip.start) * this.pps)}px`;
  }

  dragClip(e, clip, track, node) {
    e.stopPropagation();
    e.preventDefault();
    const rect = node.getBoundingClientRect();
    const ox = e.clientX - rect.left;
    const mode = ox < EDGE ? 'start' : ox > rect.width - EDGE ? 'end' : 'move';
    if (!this.selection.has(clip.id)) {
      if (!e.shiftKey) this.selection.clear();
      this.selection.add(clip.id);
    } else if (e.shiftKey) {
      this.selection.delete(clip.id);
      this.paintSelection(); this.hooks.select([...this.selection]);
      return;
    }
    this.paintSelection();
    this.hooks.select([...this.selection]);

    const moving = mode === 'move' ? [...this.selection].map((id) => this.findClip(id)).filter(Boolean) : [{ track, clip }];
    const orig = new Map(moving.map(({ clip: c }) => [c.id, { start: c.start, end: c.end }]));
    const x0 = e.clientX;
    const y0 = e.clientY;
    let delta = 0;
    let targetTrack = track;
    let moved = false;
    const lanes = [...this.inner.querySelectorAll('.tl-clips')];

    const move = (ev) => {
      const dx = (ev.clientX - x0) / this.pps;
      if (Math.abs(ev.clientX - x0) > 2 || Math.abs(ev.clientY - y0) > 4) moved = true;
      if (!moved) return;
      const o = orig.get(clip.id);
      if (mode === 'move') {
        const start = this.snapTime(o.start + dx, ev.altKey);
        delta = start - o.start;
        const minStart = Math.min(...[...orig.values()].map((v) => v.start));
        if (minStart + delta < 0) delta = -minStart;
        if (moving.length === 1) {
          const lane = lanes.find((l) => { const r = l.getBoundingClientRect(); return ev.clientY >= r.top && ev.clientY < r.bottom; });
          if (lane) targetTrack = this.show.tracks.find((t) => t.id === lane.dataset.track) ?? track;
        }
        for (const { clip: c } of moving) {
          const v = orig.get(c.id);
          c.start = v.start + delta; c.end = v.end + delta;
          this.placeClip(this.clipEls.get(c.id), c);
        }
        if (targetTrack !== track) {
          const from = lanes.find((l) => l.dataset.track === track.id).getBoundingClientRect();
          const to = lanes.find((l) => l.dataset.track === targetTrack.id).getBoundingClientRect();
          node.style.transform = `translateY(${to.top - from.top}px)`;
        } else node.style.transform = '';
      } else if (mode === 'start') {
        clip.start = Math.min(o.end - 0.05, this.snapTime(o.start + dx, ev.altKey));
        this.placeClip(node, clip);
      } else {
        clip.end = Math.max(o.start + 0.05, this.snapTime(o.end + dx, ev.altKey));
        this.placeClip(node, clip);
      }
      this.hooks.preview();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      const patches = moving.map(({ clip: c }) => ({ id: c.id, start: c.start, end: c.end }));
      if (targetTrack !== track) patches[0].track = targetTrack.id;
      this.hooks.commit([{ op: 'updateClips', clips: patches }], mode === 'move' ? 'moved clips' : 'resized a clip');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  addClipAt(track, t) {
    const start = this.snapTime(t);
    const bar = secondsPerBeat(this.show) * (this.show.beatsPerBar || 4);
    const name = track.name.toLowerCase();
    const type = /mov|position|pan|tilt/.test(name) ? 'move' : /fx|effect|chase|pulse/.test(name) ? 'fx' : 'look';
    const defaults = { look: { dimmer: 1, colour: 'white' }, move: { figure: 'circle' }, fx: { effect: 'pulse' } }[type];
    this.hooks.commit([{ op: 'addClips', track: track.id, clips: [{ type, start, end: start + bar, ...defaults }] }], `added a ${type}`, true);
  }

  paintSelection() {
    for (const [id, node] of this.clipEls ?? []) node.classList.toggle('sel', this.selection.has(id));
  }

  select(ids) {
    this.selection = new Set(ids);
    this.paintSelection();
  }

  setPlayhead(t, active = [], force = false) {
    this.t = t;
    if (!this.playhead) return;
    this.playhead.style.left = `${HEAD_W + t * this.pps}px`;
    this.playhead.style.display = t * this.pps < this.scroll.scrollLeft ? 'none' : '';
    const next = new Set(active);
    if (force || next.size !== this.active.size || [...next].some((id) => !this.active.has(id))) {
      for (const [id, node] of this.clipEls) node.classList.toggle('active', next.has(id));
      this.active = next;
    }
    if (this.follow && this.hooks.isPlaying()) {
      const x = t * this.pps;
      const viewW = this.scroll.clientWidth - HEAD_W;
      if (x < this.scroll.scrollLeft || x > this.scroll.scrollLeft + viewW - 60) this.scroll.scrollLeft = Math.max(0, x - viewW * 0.2);
    }
  }

  drawCanvases() {
    if (!this.rulerCanvas || !this.show) return;
    const viewW = Math.max(1, this.scroll.clientWidth - HEAD_W);
    const left = this.scroll.scrollLeft;
    const dpr = window.devicePixelRatio || 1;
    for (const [canvas, h] of [[this.rulerCanvas, RULER_H], [this.waveCanvas, WAVE_H]]) {
      canvas.style.left = `${left}px`;
      canvas.style.width = `${viewW}px`;
      canvas.style.height = `${h}px`;
      canvas.width = viewW * dpr;
      canvas.height = h * dpr;
    }
    const t0 = left / this.pps;
    const t1 = (left + viewW) / this.pps;
    const x = (t) => (t - t0) * this.pps;

    // Ruler: bar numbers, beat ticks, thinned as you zoom out.
    const g = this.rulerCanvas.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#101016'; g.fillRect(0, 0, viewW, RULER_H);
    const beat = secondsPerBeat(this.show);
    const bpb = this.show.beatsPerBar || 4;
    const barPx = beat * bpb * this.pps;
    const every = barPx > 60 ? 1 : barPx > 24 ? 4 : barPx > 8 ? 8 : 16;
    const firstBar = Math.max(1, Math.floor(barBeatAt(this.show, t0).bar));
    g.font = '11px ui-monospace, Menlo, monospace';
    for (let bar = firstBar; ; bar++) {
      const tb = timeOfBar(this.show, bar);
      if (tb > t1 + 1) break;
      const bx = x(tb);
      if ((bar - 1) % every === 0) {
        g.fillStyle = '#6e6e85'; g.fillRect(bx, 10, 1, RULER_H - 10);
        g.fillStyle = '#a8a8c0'; g.fillText(String(bar), bx + 3, 11);
      } else if (every <= 4) { g.fillStyle = '#3a3a4c'; g.fillRect(bx, 18, 1, RULER_H - 18); }
      if (barPx > 60) for (let b = 1; b < bpb; b++) { g.fillStyle = '#2c2c3a'; g.fillRect(bx + b * beat * this.pps, 22, 1, RULER_H - 22); }
    }

    // Waveform and energy.
    const w = this.waveCanvas.getContext('2d');
    w.scale(dpr, dpr);
    w.fillStyle = '#0b0b10'; w.fillRect(0, 0, viewW, WAVE_H);
    const a = this.analysis;
    if (a?.peaks) {
      const mid = WAVE_H / 2;
      const { rate, min, max } = a.peaks;
      if (a.curve) {
        w.fillStyle = 'rgba(255, 90, 60, 0.18)';
        const step = a.curve.step;
        for (let i = Math.floor(t0 / step); i < Math.min(a.curve.low.length, t1 / step + 1); i++) {
          const h = a.curve.low[i] * (WAVE_H - 4);
          w.fillRect(x(i * step), WAVE_H - h, step * this.pps + 0.5, h);
        }
      }
      w.fillStyle = '#5ed6ff';
      for (let px = 0; px < viewW; px++) {
        const ta = t0 + px / this.pps;
        const tb = ta + 1 / this.pps;
        let lo = 0, hi = 0;
        for (let i = Math.floor(ta * rate); i <= Math.min(max.length - 1, Math.floor(tb * rate)); i++) {
          if (min[i] < lo) lo = min[i]; if (max[i] > hi) hi = max[i];
        }
        if (hi || lo) w.fillRect(px, mid - (hi / 127) * (mid - 2), 1, Math.max(1, ((hi - lo) / 127) * (mid - 2)));
      }
      for (const d of a.drops ?? []) { w.fillStyle = '#ff4d6d'; w.fillRect(x(d.t), 0, 2, WAVE_H); }
    } else {
      w.fillStyle = '#4a4a5c'; w.font = '12px system-ui';
      w.fillText(this.show.audio ? 'Analysing…' : 'No song — pick one in the show panel (click empty space on the timeline)', 10, WAVE_H / 2 + 4);
    }
    // Bar lines over the waveform.
    for (let bar = firstBar - ((firstBar - 1) % every); ; bar += every) {
      const tb = timeOfBar(this.show, bar);
      if (tb > t1 + 1) break;
      w.fillStyle = 'rgba(255,255,255,0.06)'; w.fillRect(x(tb), 0, 1, WAVE_H);
    }
  }
}
