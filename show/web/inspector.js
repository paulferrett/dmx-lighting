// The right-hand panel. With a clip selected it is that clip's form, drawn
// from the server's vocabulary so it can only offer what the engine knows.
// With nothing selected it is the show: song, tempo, output, and a live
// readout of every head.

import { barBeatAt, formatClock } from '/lib/timeexpr.js';
import { clipSummary } from './timeline.js';

const el = (tag, cls, attrs = {}) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  return n;
};

const fmtBar = (show, t) => { const { bar, beat } = barBeatAt(show, t); return `bar ${bar}.${Math.floor(beat)}`; };

export class Inspector {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.liveRows = null;
  }

  render(ctx) {
    this.ctx = ctx;
    const { selection } = ctx;
    this.root.innerHTML = '';
    this.liveRows = null;
    if (selection.length === 1) {
      const hit = this.findClip(selection[0]);
      if (hit) return this.renderClip(hit.clip, hit.track);
    }
    if (selection.length > 1) return this.renderMany(selection);
    return this.renderShow();
  }

  findClip(id) {
    for (const track of this.ctx.show.tracks) { const c = track.clips.find((x) => x.id === id); if (c) return { track, clip: c }; }
    return null;
  }

  section(title) {
    const s = el('section', 'ins-section');
    s.append(el('h3', '', { text: title }));
    this.root.append(s);
    return s;
  }

  row(parent, label, control, help) {
    const r = el('label', 'ins-row');
    r.append(el('span', 'ins-label', { text: label, title: help ?? '' }), control);
    parent.append(r);
    return r;
  }

  patch(clip, fields) { this.hooks.commit([{ op: 'updateClips', clips: [{ id: clip.id, ...fields }] }]); }

  // ------------------------------------------------------------ one clip

  renderClip(clip, track) {
    const { show, vocabulary } = this.ctx;
    const head = el('div', 'ins-head');
    head.append(el('div', `ins-type t-${clip.type}`, { text: clip.type }), el('div', 'ins-title', { text: clipSummary(clip, this.ctx.rig) }));
    this.root.append(head);

    const when = this.section('When');
    for (const key of ['start', 'end']) {
      const input = el('input', 'txt', { value: String(clip[key]), title: 'Seconds, m:ss, "bar 17", "bar 17.3", a marker label, "+ 2 bars"…' });
      input.addEventListener('change', () => this.patch(clip, { [key]: /^\d+(\.\d+)?$/.test(input.value.trim()) ? Number(input.value) : input.value.trim() }));
      const wrap = el('div', 'ins-time');
      wrap.append(input, el('span', 'ins-hint', { text: `${fmtBar(show, clip[key])} · ${formatClock(clip[key])}` }));
      this.row(when, key, wrap);
    }
    const trackSel = el('select', 'sel');
    for (const t of show.tracks) trackSel.append(el('option', '', { value: t.id, text: t.name, selected: t.id === track.id }));
    trackSel.addEventListener('change', () => this.patch(clip, { track: trackSel.value }));
    this.row(when, 'track', trackSel);

    const who = this.section('Heads');
    who.append(this.fixturePicker(clip));

    const common = vocabulary.common.filter((p) => ['fadeIn', 'fadeOut', 'label'].includes(p.key));
    const fades = this.section('Blend');
    for (const p of common) this.row(fades, p.key, this.control(p, clip[p.key], (v) => this.patch(clip, { [p.key]: v }), true), p.help);

    const def = vocabulary.types[clip.type];
    const params = this.section(clip.type === 'look' ? 'Look' : clip.type === 'move' ? 'Movement' : 'Effect');
    params.append(el('p', 'ins-help', { text: def.help }));
    for (const p of def.params) {
      if (clip.type === 'move' && p.key === 'breathe' && clip.figure !== 'fan') continue;
      if (clip.type === 'move' && p.key === 'positions' && clip.figure !== 'snap') continue;
      if (clip.type === 'fx' && p.key === 'colours' && clip.effect !== 'colourStep') continue;
      if (clip.type === 'fx' && p.key === 'gobos' && clip.effect !== 'goboStep') continue;
      this.row(params, p.key, this.control(p, clip[p.key], (v) => this.patch(clip, { [p.key]: v }), clip.type === 'look' || p.default === undefined), p.help);
    }

    const actions = this.section('Clip');
    const bar = el('div', 'ins-actions');
    bar.append(
      el('button', 'btn', { text: clip.muted ? 'Unmute' : 'Mute', onclick: () => this.patch(clip, { muted: clip.muted ? null : true }) }),
      el('button', 'btn', { text: 'Duplicate after', onclick: () => this.hooks.duplicate([clip.id]) }),
      el('button', 'btn danger', { text: 'Delete', onclick: () => this.hooks.commit([{ op: 'deleteClips', ids: [clip.id] }]) }),
    );
    actions.append(bar, el('p', 'ins-help', { text: `id ${clip.id}` }));
  }

  fixturePicker(clip) {
    const { rig } = this.ctx;
    const current = clip.fixtures ?? 'all';
    const wrap = el('div', 'chips');
    for (const g of Object.keys(rig.groups)) {
      wrap.append(el('button', `chip${current === g ? ' on' : ''}`, { text: g, onclick: () => this.patch(clip, { fixtures: g === 'all' ? null : g }) }));
    }
    const ids = new Set(typeof current === 'string' ? (rig.groups[current] ?? [current]) : current.flatMap((x) => rig.groups[x] ?? [x]));
    const heads = el('div', 'chips');
    for (const f of rig.fixtures) {
      heads.append(el('button', `chip head${ids.has(f.id) ? ' on' : ''}`, {
        text: f.id, title: `${f.name} @ ${f.address}`,
        onclick: () => {
          const next = new Set(ids);
          next.has(f.id) ? next.delete(f.id) : next.add(f.id);
          if (!next.size) return;
          const list = rig.fixtures.map((x) => x.id).filter((id) => next.has(id));
          const group = Object.entries(rig.groups).find(([, m]) => m.length === list.length && m.every((id) => next.has(id)));
          this.patch(clip, { fixtures: group ? (group[0] === 'all' ? null : group[0]) : list });
        },
      }));
    }
    const box = el('div');
    box.append(wrap, heads);
    return box;
  }

  control(p, value, set, clearable) {
    const box = el('div', 'ins-ctl');
    const clear = () => { if (clearable && value !== undefined) box.append(el('button', 'mini', { text: '×', title: 'Unset — let the layer below decide', onclick: (e) => { e.preventDefault(); set(null); } })); };
    switch (p.kind) {
      case 'number': {
        const v = value ?? p.default ?? p.min ?? 0;
        const range = el('input', 'range', { type: 'range', min: p.min, max: Math.min(p.max, p.unit === '°' ? 360 : p.max), step: p.step ?? 0.01, value: v });
        const num = el('input', 'num', { type: 'number', min: p.min, max: p.max, step: p.step ?? 0.01, value: value ?? '' , placeholder: p.default != null ? String(p.default) : '—' });
        range.addEventListener('input', () => { num.value = range.value; });
        range.addEventListener('change', () => set(Number(range.value)));
        num.addEventListener('change', () => set(num.value === '' ? null : Number(num.value)));
        box.append(range, num);
        if (p.unit) box.append(el('span', 'unit', { text: p.unit }));
        if (value === undefined) box.classList.add('unset');
        clear();
        return box;
      }
      case 'enum': {
        const sel = el('select', 'sel');
        sel.append(el('option', '', { value: '', text: p.default != null ? `${p.default} (default)` : '—' }));
        for (const o of p.options) sel.append(el('option', '', { value: o, text: o, selected: o === value }));
        sel.addEventListener('change', () => set(sel.value === '' ? null : sel.value));
        box.append(sel);
        if (p.key === 'colour') {
          const type = Object.values(this.ctx.rig.fixtureTypes)[0];
          const sw = el('div', 'swatches');
          for (const c of type.colours) sw.append(el('button', `sw${c.name === value ? ' on' : ''}`, { title: c.name, style: `background:${c.hex}`, onclick: (e) => { e.preventDefault(); set(c.name); } }));
          box.append(sw);
        }
        return box;
      }
      case 'enumList': {
        const on = new Set(value ?? []);
        const chips = el('div', 'chips');
        for (const o of p.options) chips.append(el('button', `chip${on.has(o) ? ' on' : ''}`, {
          text: o, onclick: (e) => { e.preventDefault(); on.has(o) ? on.delete(o) : on.add(o); set(on.size ? p.options.filter((x) => on.has(x)) : null); },
        }));
        box.append(chips);
        return box;
      }
      case 'aim': box.append(this.aimEditor(value, set, p.default)); clear(); return box;
      case 'aimList': {
        const list = value ?? [];
        list.forEach((aim, i) => {
          const r = el('div', 'aim-item');
          r.append(this.aimEditor(aim, (v) => { const next = [...list]; next[i] = v ?? 'home'; set(next); }),
            el('button', 'mini', { text: '×', onclick: (e) => { e.preventDefault(); const next = list.filter((_, j) => j !== i); set(next.length ? next : null); } }));
          box.append(r);
        });
        box.append(el('button', 'btn small', { text: '+ position', onclick: (e) => { e.preventDefault(); set([...list, { pan: 0, tilt: 40 }]); } }));
        return box;
      }
      case 'text': {
        const input = el('input', 'txt', { value: value ?? '' });
        input.addEventListener('change', () => set(input.value.trim() || null));
        box.append(input);
        return box;
      }
      default: return box;
    }
  }

  aimEditor(value, set, fallback) {
    const { rig } = this.ctx;
    const wrap = el('div', 'aim');
    const kind = value == null ? '' : typeof value === 'string' ? value : Array.isArray(value) ? '@point' : '@pantilt';
    const sel = el('select', 'sel');
    sel.append(el('option', '', { value: '', text: fallback ? `default (${typeof fallback === 'object' ? `${fallback.pan}/${fallback.tilt}` : fallback})` : '—' }));
    sel.append(el('option', '', { value: 'home', text: 'home', selected: kind === 'home' }));
    for (const t of Object.keys(rig.targets)) sel.append(el('option', '', { value: t, text: `→ ${t}`, selected: kind === t }));
    sel.append(el('option', '', { value: '@pantilt', text: 'pan / tilt…', selected: kind === '@pantilt' }));
    sel.append(el('option', '', { value: '@point', text: 'point x y z…', selected: kind === '@point' }));
    sel.addEventListener('change', () => {
      if (sel.value === '') set(null);
      else if (sel.value === '@pantilt') set({ pan: 0, tilt: 40 });
      else if (sel.value === '@point') set([0, 3, 6]);
      else set(sel.value);
    });
    wrap.append(sel);
    const nums = (labels, values, build) => {
      const row = el('div', 'aim-nums');
      const inputs = labels.map((l, i) => {
        const input = el('input', 'num', { type: 'number', step: '0.5', value: values[i], title: l });
        input.addEventListener('change', () => set(build(inputs.map((x) => Number(x.value)))));
        row.append(el('span', 'unit', { text: l }), input);
        return input;
      });
      wrap.append(row);
    };
    if (kind === '@pantilt') nums(['pan', 'tilt'], [value.pan, value.tilt], ([pan, tilt]) => ({ pan, tilt }));
    if (kind === '@point') nums(['x', 'y', 'z'], value, (v) => v);
    return wrap;
  }

  // ------------------------------------------------------------ many clips

  renderMany(ids) {
    const s = this.section(`${ids.length} clips selected`);
    const bar = el('div', 'ins-actions');
    bar.append(
      el('button', 'btn', { text: 'Duplicate after', onclick: () => this.hooks.duplicate(ids) }),
      el('button', 'btn danger', { text: 'Delete all', onclick: () => this.hooks.commit([{ op: 'deleteClips', ids }]) }),
    );
    s.append(bar, el('p', 'ins-help', { text: 'Drag any of them to move the lot. Shift-click to add or remove.' }));
  }

  // ------------------------------------------------------------ the show

  renderShow() {
    const { show, shows, songs, analysis, output, rig } = this.ctx;
    const s = this.section('Show');
    const pick = el('select', 'sel');
    for (const name of shows) pick.append(el('option', '', { value: name, text: name, selected: name === this.ctx.name }));
    pick.addEventListener('change', () => this.hooks.openShow(pick.value));
    const newBtn = el('button', 'btn small', { text: 'New', onclick: () => {
      const input = el('input', 'txt', { placeholder: 'name, then Enter' });
      newBtn.replaceWith(input); input.focus();
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && input.value.trim()) this.hooks.newShow(input.value.trim()); });
    } });
    const pr = el('div', 'ins-inline'); pr.append(pick, newBtn);
    this.row(s, 'open', pr);
    const meta = (key, input, parse = (v) => v) => {
      input.addEventListener('change', () => this.hooks.commit([{ op: 'setMeta', [key]: parse(input.value) }]));
      this.row(s, key, input);
    };
    meta('title', el('input', 'txt', { value: show.title }));
    const song = el('select', 'sel');
    song.append(el('option', '', { value: '', text: '— none —' }));
    for (const x of songs) song.append(el('option', '', { value: x.file, text: x.file, selected: x.file === show.audio }));
    song.addEventListener('change', () => this.hooks.commit([{ op: 'setMeta', audio: song.value || null }]));
    this.row(s, 'song', song, 'Drop audio files into show/songs/, or ask Claude to import one.');
    meta('bpm', el('input', 'num', { type: 'number', step: '0.01', value: show.bpm }), Number);
    meta('offset', el('input', 'num', { type: 'number', step: '0.001', value: show.offset, title: 'Where bar 1 beat 1 falls, in seconds' }), Number);
    meta('beatsPerBar', el('input', 'num', { type: 'number', step: '1', value: show.beatsPerBar }), Number);
    meta('duration', el('input', 'num', { type: 'number', step: '0.1', value: show.duration }), Number);

    if (analysis) {
      const a = this.section('Detected in the song');
      a.append(el('p', 'ins-help', { text: `${analysis.bpm} bpm (confidence ${analysis.bpmConfidence}), bar 1 at ${analysis.offset}s, ${analysis.duration.toFixed(1)}s long, ${analysis.sections.length} energy changes, ${analysis.drops.length} drops.` }));
      const bar = el('div', 'ins-actions');
      bar.append(
        el('button', 'btn', { text: 'Use tempo + length', onclick: () => this.hooks.commit([{ op: 'setMeta', bpm: analysis.bpm, offset: analysis.offset, duration: Math.ceil(analysis.duration * 10) / 10 }]) }),
        el('button', 'btn', { text: 'Mark energy changes', onclick: () => this.hooks.commit([{ op: 'addMarkers', markers: analysis.sections.map((x, i) => ({ at: x.t, label: `${i + 1} ${x.level}` })) }]) }),
      );
      a.append(bar);
    }

    const o = this.section('Output');
    const toggle = el('label', 'chk');
    const box = el('input', '', { type: 'checkbox', checked: output.enabled, onchange: (e) => this.hooks.setOutput(e.target.checked) });
    toggle.append(box, document.createTextNode(' Send DMX to the ENTTEC'));
    o.append(toggle);
    o.append(el('p', `ins-help${output.error ? ' err' : ''}`, { text: output.error ?? `${output.device ?? 'No ENTTEC found'}${output.enabled ? ` · ${output.frames} frames sent` : ''}. Unplug the Disco 240 first — two transmitters on one line fight.` }));

    const live = this.section('Heads now');
    const table = el('table', 'live');
    const headRow = el('tr');
    for (const h of ['', 'dim', 'colour', 'gobo', 'pan', 'tilt', 'addr']) headRow.append(el('th', '', { text: h }));
    table.append(headRow);
    this.liveRows = {};
    for (const f of rig.fixtures) {
      const tr = el('tr');
      const cells = ['id', 'dim', 'colour', 'gobo', 'pan', 'tilt', 'addr'].map(() => el('td'));
      cells[0].textContent = f.id; cells[6].textContent = f.address;
      tr.append(...cells);
      table.append(tr);
      this.liveRows[f.id] = cells;
    }
    live.append(table);

    const k = this.section('Keys');
    k.append(el('pre', 'keys', { text: 'space   play / pause\nhome    back to the start\n← →     a beat  (⇧ a bar)\nM       marker at the playhead\nB       blackout\n⌫       delete selected clips\n⌘D      duplicate after\n⌘Z ⇧⌘Z  undo / redo\n1–5     camera: front wide top side booth' }));
  }

  updateLive(states, rig) {
    if (!this.liveRows) return;
    const type = Object.values(rig.fixtureTypes)[0];
    for (const [id, cells] of Object.entries(this.liveRows)) {
      const s = states[id];
      if (!s) continue;
      cells[1].textContent = `${Math.round(s.dimmer * 100)}`;
      const hex = type.colours.find((c) => c.name === s.colour)?.hex ?? '#fff';
      cells[2].innerHTML = '';
      const dot = el('span', 'dot'); dot.style.background = s.colourSpin > 0 ? 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' : hex;
      cells[2].append(dot, document.createTextNode(s.colourSpin > 0 ? 'spin' : s.colour));
      cells[3].textContent = s.goboMode === 'static' ? s.gobo : `${s.gobo} ${s.goboMode}`;
      cells[4].textContent = s.pan.toFixed(0);
      cells[5].textContent = s.tilt.toFixed(0) + (s.clamped ? '!' : '');
    }
  }
}
