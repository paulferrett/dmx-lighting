// The timeline: vis-timeline for the tracks and clips (zoom, pan, pinch,
// drag, stretch, snap, stacking, multi-select, a draggable playhead and
// section markers), and wavesurfer.js above it for the song's waveform and a
// ruler in bars. vis-timeline owns the visible window; the waveform follows.

import { useEffect, useRef } from 'react';
import * as vis from 'vis-timeline/standalone';
import { Timeline as VisTimeline } from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.css';
import WaveSurfer from 'wavesurfer.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import HoverPlugin from 'wavesurfer.js/dist/plugins/hover.esm.js';
import { barBeatAt, formatClock, secondsPerBeat } from '@engine/timeexpr.js';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getConsole, setConsole, useConsole } from '@/lib/store';
import { audio, commit, getTime, registerTimeline, seek, setPreview } from '@/lib/runtime';
import { clipColour, clipSummary } from '@/lib/clips';
import type { Clip, Show, Track } from '@/types';

const LABEL_W = 150;
// The standalone build exports its own DataSet at runtime; its types don't say so.
const DataSet: any = (vis as any).DataSet;
const toDate = (t: number) => new Date(Math.round(t * 1000));
const toSec = (d: Date | number | string) => new Date(d).valueOf() / 1000;

// Snapping reads the live setting; ⌥ held while dragging turns it off.
let altHeld = false;
window.addEventListener('keydown', (e) => { if (e.key === 'Alt') altHeld = true; });
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') altHeld = false; });
window.addEventListener('blur', () => { altHeld = false; });

export function snapTime(show: Show, t: number, mode = getConsole().snap) {
  const beat = secondsPerBeat(show);
  const step = { bar: beat * (show.beatsPerBar || 4), beat, half: beat / 2, off: 0 }[mode];
  if (!step || altHeld) return Math.max(0, Math.round(t * 1000) / 1000);
  const off = show.offset || 0;
  return Math.max(0, Math.round((off + Math.round((t - off) / step) * step) * 1000) / 1000);
}

function defaultClipFor(track: Track): Partial<Clip> {
  const name = track.name.toLowerCase();
  if (/mov|position|pan|tilt/.test(name)) return { type: 'move', figure: 'circle' };
  if (/fx|effect|chase|pulse/.test(name)) return { type: 'fx', effect: 'pulse' };
  return { type: 'look', dimmer: 1, colour: 'white' };
}

function el(tag: string, className: string, text?: string) {
  const n = document.createElement(tag);
  n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function Timeline() {
  const visRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<VisTimeline | null>(null);
  const items = useRef(new DataSet());
  const groups = useRef(new DataSet());
  const markerIds = useRef(new Set<string>());
  const wsRef = useRef<WaveSurfer | null>(null);
  const rulerTier = useRef('');
  const show = useConsole((s) => s.show);
  const rig = useConsole((s) => s.rig);
  const analysis = useConsole((s) => s.analysis);
  const selection = useConsole((s) => s.selection);
  const fresh = useConsole((s) => s.fresh);
  const snap = useConsole((s) => s.snap);
  const name = useConsole((s) => s.name);

  // ---------------------------------------------------------------- create once
  useEffect(() => {
    const container = visRef.current!;
    const tl = new VisTimeline(container, items.current, groups.current, {
      height: '100%',
      // No start/end here: given those, vis stays hidden until a range change
      // it may never see. The window is set right after, and on every new show.
      min: toDate(0), max: toDate(600),
      zoomMin: 2000, zoomMax: 3600 * 1000,
      zoomKey: 'ctrlKey', horizontalScroll: true, verticalScroll: true,
      // A thin m:ss scale on top — bars are on the waveform's ruler — which
      // also gives the section markers a strip of their own above the lanes.
      showMajorLabels: false, showMinorLabels: true, showCurrentTime: false,
      format: { minorLabels: (date: any) => formatClock(Math.round(date.valueOf() / 1000)).replace(/\.00$/, '') },
      orientation: { axis: 'top', item: 'top' },
      stack: true, multiselect: true,
      editable: { add: true, updateTime: true, updateGroup: true, remove: true, overrideItems: false },
      itemsAlwaysDraggable: { item: true, range: true },
      groupOrder: 'order',
      dataAttributes: ['id'],
      margin: { item: { horizontal: 0, vertical: 4 }, axis: 0 },
      snap: (date: Date) => {
        const s = getConsole().show;
        return s ? toDate(snapTime(s, toSec(date))) : date;
      },
      template: (item: any) => {
        if (!item?.clip) return '';
        const box = el('div', 'clip-body');
        box.append(el('span', 'clip-label', clipSummary(item.clip)));
        return box;
      },
      groupTemplate: (group: any) => {
        if (!group) return '';
        const box = el('div', 'track-label');
        box.style.width = `${LABEL_W - 16}px`;
        box.append(el('div', 'track-name', group.track.name), el('div', 'track-sub', `${group.track.clips.length} clips`));
        const btns = el('div', 'track-btns');
        const mk = (text: string, title: string, on: boolean, run: () => void) => {
          const b = el('button', `track-btn${on ? ' on' : ''}`, text) as HTMLButtonElement;
          b.title = title;
          b.addEventListener('pointerdown', (e) => e.stopPropagation());
          b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
          btns.append(b);
        };
        mk('M', 'Mute', group.track.muted, () => commit([{ op: 'updateTrack', id: group.track.id, muted: !group.track.muted }]));
        mk('↑', 'Move up', false, () => commit([{ op: 'updateTrack', id: group.track.id, index: Math.max(0, group.index - 1) }]));
        mk('×', 'Delete track (undo brings it back)', false, () => commit([{ op: 'deleteTrack', id: group.track.id }]));
        box.append(btns);
        return box;
      },
      tooltipOnItemUpdateTime: {
        template: (item: any) => {
          const s = getConsole().show!;
          const f = (t: number) => { const { bar, beat } = barBeatAt(s, t); return `${bar}.${Math.floor(beat)}`; };
          return `bar ${f(toSec(item.start))} → ${f(toSec(item.end))}`;
        },
      },
      onAdd: (item: any, callback: (i: any) => void) => {
        callback(null); // we add it ourselves, snapped, through the server
        const s = getConsole().show!;
        const track = s.tracks.find((t) => t.id === item.group);
        if (!track) return;
        const start = snapTime(s, toSec(item.start));
        const bar = secondsPerBeat(s) * (s.beatsPerBar || 4);
        commit([{ op: 'addClips', track: track.id, clips: [{ ...defaultClipFor(track), start, end: start + bar }] }], 'added a clip', true);
      },
      onMoving: (item: any, callback: (i: any) => void) => {
        // Preview the drag on the stage before it's committed.
        const s = getConsole().show!;
        const next = structuredClone(s);
        for (const t of next.tracks) {
          const c = t.clips.find((x) => x.id === item.id);
          if (c) { c.start = toSec(item.start); c.end = toSec(item.end); }
        }
        setPreview(next);
        callback(item);
      },
      onMove: (item: any, callback: (i: any) => void) => {
        callback(item);
        commit([{ op: 'updateClips', clips: [{ id: item.id, start: toSec(item.start), end: toSec(item.end), track: item.group }] }], 'moved a clip');
      },
      onRemove: (item: any, callback: (i: any) => void) => {
        callback(null);
        commit([{ op: 'deleteClips', ids: [item.id] }]);
      },
    } as any);
    tlRef.current = tl;
    markerIds.current = new Set(); // a fresh timeline has none of the old one's markers
    const first = getConsole().show;
    tl.setWindow(toDate(0), toDate(Math.max(10, first?.duration ?? 60)), { animation: false });
    tl.addCustomTime(toDate(0), 'playhead');

    tl.on('select', ({ items: ids }: { items: string[] }) => {
      setConsole({ selection: ids.length ? { kind: 'clips', ids } : { kind: 'none' } });
    });
    tl.on('timechange', ({ id, time }: any) => { if (id === 'playhead') seek(toSec(time)); });
    tl.on('timechanged', ({ id, time }: any) => {
      if (id === 'playhead') seek(toSec(time));
      else if (String(id).startsWith('marker-')) {
        const s = getConsole().show!;
        commit([{ op: 'updateMarker', id: String(id).slice(7), at: snapTime(s, toSec(time)) }]);
      }
    });
    tl.on('markerchanged', ({ id, title }: any) => {
      if (String(id).startsWith('marker-') && title?.trim()) commit([{ op: 'updateMarker', id: String(id).slice(7), label: title.trim() }]);
    });
    tl.on('click', (props: any) => {
      // ⌥-click a marker to delete it; click the empty axis strip to seek.
      if (props.what === 'custom-time' && props.event?.altKey && String(props.customTime).startsWith('marker-')) {
        commit([{ op: 'deleteMarkers', ids: [String(props.customTime).slice(7)] }]);
      }
    });
    tl.on('rangechange', () => syncWave());
    tl.on('rangechanged', () => syncWave());
    tl.on('changed', () => alignWave());

    // The playhead and the clips in play, from the frame loop.
    let lastMove = 0;
    let active = new Set<string>();
    registerTimeline({
      setPlayhead(t, now, playing) {
        const p = performance.now();
        if (p - lastMove > 33) {
          tl.setCustomTime(toDate(t), 'playhead');
          lastMove = p;
          if (playing) {
            const w = tl.getWindow();
            const s = toSec(w.start), e = toSec(w.end);
            if (t > e - (e - s) * 0.05 || t < s) tl.setWindow(toDate(t - (e - s) * 0.1), toDate(t + (e - s) * 0.9), { animation: false });
          }
        }
        const next = new Set(now);
        if (next.size !== active.size || [...next].some((id) => !active.has(id))) {
          for (const node of container.querySelectorAll<HTMLElement>('.vis-item[data-id]')) node.classList.toggle('playing', next.has(node.dataset.id!));
          active = next;
        }
      },
    });
    return () => { registerTimeline(null); tl.destroy(); tlRef.current = null; };
  }, []);

  // ---------------------------------------------------------------- the show into vis
  useEffect(() => {
    const tl = tlRef.current;
    if (!tl || !show || !rig) return;
    const dur = Math.max(10, show.duration);
    tl.setOptions({ max: toDate(dur), zoomMax: dur * 1000 });

    groups.current.update(show.tracks.map((track, i) => ({ id: track.id, order: i, track, index: i, className: track.muted ? 'muted' : '' })));
    const groupIds = new Set(show.tracks.map((t) => t.id));
    groups.current.remove(groups.current.getIds().filter((id: string | number) => !groupIds.has(String(id))));

    const want: any[] = [];
    for (const track of show.tracks) for (const clip of track.clips) {
      want.push({
        id: clip.id, group: track.id, clip, start: toDate(clip.start), end: toDate(clip.end), type: 'range',
        className: `clip clip-${clip.type}${clip.muted ? ' muted' : ''}${fresh.has(clip.id) ? ' fresh' : ''}`,
        style: `--clip:${clipColour(clip, rig)}`,
      });
    }
    // 4-bar phrases shaded across every lane, so clips line up with the music
    const bar = secondsPerBeat(show) * (show.beatsPerBar || 4);
    for (let i = 0, t = show.offset || 0; t < dur; i++, t += bar * 4) {
      if (i % 2 === 1) want.push({ id: `phrase-${i}`, start: toDate(t), end: toDate(Math.min(dur, t + bar * 4)), type: 'background', className: 'phrase', editable: false });
    }
    const wantIds = new Set(want.map((x) => x.id));
    items.current.remove(items.current.getIds().filter((id: string | number) => !wantIds.has(String(id))));
    items.current.update(want);

    // section markers
    const mids = new Set(show.markers.map((m) => `marker-${m.id}`));
    for (const id of markerIds.current) if (!mids.has(id)) { try { tl.removeCustomTime(id); } catch { /* gone */ } markerIds.current.delete(id); }
    for (const m of show.markers) {
      const id = `marker-${m.id}`;
      if (!markerIds.current.has(id)) { tl.addCustomTime(toDate(m.t), id); markerIds.current.add(id); }
      else tl.setCustomTime(toDate(m.t), id);
      (tl as any).setCustomTimeMarker(m.label, id, true);
    }
  }, [show, rig, fresh]);

  // A new show: fit it.
  useEffect(() => {
    const tl = tlRef.current;
    if (tl && show) tl.setWindow(toDate(0), toDate(Math.max(10, show.duration)), { animation: false });
  }, [name]);

  // Selection from elsewhere (the inspector, Claude) shows on the timeline.
  useEffect(() => {
    const tl = tlRef.current;
    if (!tl) return;
    tl.setSelection(selection.kind === 'clips' ? selection.ids : []);
  }, [selection]);

  useEffect(() => { tlRef.current?.redraw(); }, [snap]);

  // ---------------------------------------------------------------- waveform
  useEffect(() => {
    wsRef.current?.destroy();
    wsRef.current = null;
    rulerTier.current = '';
    if (!analysis || !waveRef.current) return;
    const peaks = new Float32Array(analysis.peaks.max.length);
    for (let i = 0; i < peaks.length; i++) peaks[i] = Math.max(Math.abs(analysis.peaks.min[i]), Math.abs(analysis.peaks.max[i])) / 127;
    const ws = WaveSurfer.create({
      container: waveRef.current,
      height: 44,
      waveColor: '#2f6fb0',
      progressColor: '#5ed6ff',
      cursorColor: '#ff4d6d',
      cursorWidth: 1,
      media: audio,
      peaks: [peaks],
      duration: analysis.duration,
      hideScrollbar: true,
      autoScroll: false,
      autoCenter: false,
      dragToSeek: true,
      normalize: true,
      minPxPerSec: 1,
    });
    ws.registerPlugin(HoverPlugin.create({
      lineColor: '#ffffff88', labelBackground: '#111', labelColor: '#fff', labelSize: '11px',
      formatTimeCallback: (t: number) => { const s = getConsole().show!; const { bar, beat } = barBeatAt(s, t); return `${bar}.${Math.floor(beat)}  ${formatClock(t)}`; },
    }));
    ws.on('interaction', (t: number) => seek(t));
    ws.on('ready', () => syncWave());
    wsRef.current = ws;
    syncWave();
    return () => { ws.destroy(); };
  }, [analysis]);

  // The ruler: a notch per beat, a number per bar, thinned as you zoom out.
  // Rebuilt only when the density changes.
  function ruler(pxPerSec: number) {
    const ws = wsRef.current;
    const s = getConsole().show;
    if (!ws || !s) return;
    const beat = secondsPerBeat(s);
    const bpb = s.beatsPerBar || 4;
    const barPx = beat * bpb * pxPerSec;
    const every = barPx > 44 ? 1 : barPx > 18 ? 4 : barPx > 8 ? 8 : 16;
    const notch = barPx > 44 ? beat : beat * bpb;
    const tier = `${every}:${notch}:${s.bpm}:${s.offset}:${bpb}`;
    if (tier === rulerTier.current) return;
    rulerTier.current = tier;
    for (const p of ws.getActivePlugins()) if ((p as any).constructor?.name === 'TimelinePlugin') p.destroy();
    const barSec = beat * bpb;
    const timeOffset = (((s.offset || 0) % barSec) + barSec) % barSec;
    const firstBar = 1 - Math.round(((s.offset || 0) - timeOffset) / barSec);
    const notchesPerLabel = Math.round((barSec * every) / notch);
    ws.registerPlugin(TimelinePlugin.create({
      height: 14,
      timeInterval: notch,
      primaryLabelInterval: 1e9,
      secondaryLabelInterval: 1e9,
      primaryLabelSpacing: notchesPerLabel,
      timeOffset,
      formatTimeCallback: (e: number) => String(firstBar + Math.round(e / barSec)),
      style: { color: '#9a9ab5', fontSize: '10px' },
    }));
  }

  function alignWave() {
    const left = visRef.current?.querySelector<HTMLElement>('.vis-panel.vis-left');
    if (left && waveRef.current) waveRef.current.style.marginLeft = `${left.offsetWidth}px`;
  }

  let raf = 0;
  function syncWave() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const tl = tlRef.current, ws = wsRef.current, box = waveRef.current;
      if (!tl || !ws || !box) return;
      alignWave();
      const { start, end } = tl.getWindow();
      const s = toSec(start), e = toSec(end);
      const width = box.clientWidth;
      if (!width || e <= s) return;
      const pps = width / (e - s);
      ws.zoom(pps);
      ws.setScroll(s * pps);
      ruler(pps);
    });
  }

  // Wheel over the waveform pans and zooms the timeline, same as over the lanes.
  function onWaveWheel(e: React.WheelEvent) {
    const tl = tlRef.current;
    const box = waveRef.current;
    if (!tl || !box) return;
    const { start, end } = tl.getWindow();
    const s = start.valueOf(), en = end.valueOf(), span = en - s;
    if (e.ctrlKey || e.metaKey) {
      const x = (e.clientX - box.getBoundingClientRect().left) / box.clientWidth;
      const anchor = s + x * span;
      const k = Math.exp(e.deltaY * 0.01);
      tl.setWindow(new Date(anchor - (anchor - s) * k), new Date(anchor + (en - anchor) * k), { animation: false });
    } else {
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / box.clientWidth * span;
      tl.setWindow(new Date(s + d), new Date(en + d), { animation: false });
    }
  }

  const addTrack = () => { const s = getConsole().show; if (s) commit([{ op: 'addTrack', name: `Track ${s.tracks.length + 1}` }]); };
  const addMarker = () => { const s = getConsole().show; if (s) commit([{ op: 'addMarkers', markers: [{ at: snapTime(s, getTime()), label: `Marker ${s.markers.length + 1}` }] }]); };
  const fit = () => { const s = getConsole().show; if (s) tlRef.current?.setWindow(toDate(0), toDate(s.duration), { animation: false }); };

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={fit}>Fit</Button>
        <Select value={snap} onValueChange={(v) => setConsole({ snap: v as any })}>
          <SelectTrigger size="sm" className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="bar">Snap: bar</SelectItem>
            <SelectItem value="beat">Snap: beat</SelectItem>
            <SelectItem value="half">Snap: ½ beat</SelectItem>
            <SelectItem value="off">Snap: off</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={addTrack}><Plus className="size-3.5" />Track</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={addMarker}><Plus className="size-3.5" />Marker</Button>
        <span className="ml-2 truncate text-[11px] text-muted-foreground">⌘-scroll or pinch to zoom · drag the red line to scrub · double-click a lane to add · ⌥ drag ignores snap · ⌥-click a marker to delete it</span>
      </div>
      <div className="relative shrink-0 border-b border-border/60" style={{ height: 60 }}>
        <div className="absolute top-0 left-0 flex h-full items-center px-3 text-xs text-muted-foreground" style={{ width: LABEL_W }}>
          <div className="truncate">{show?.audio ?? 'No song'}<div className="text-[10px]">{analysis ? `${analysis.bpm} bpm heard` : show?.audio ? 'analysing…' : ''}</div></div>
        </div>
        <div ref={waveRef} className="wave h-full" style={{ marginLeft: LABEL_W }} onWheel={onWaveWheel} />
      </div>
      <div ref={visRef} className="show-timeline min-h-0 flex-1" />
    </div>
  );
}
