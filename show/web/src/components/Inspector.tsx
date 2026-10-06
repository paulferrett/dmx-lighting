// The right-hand panel: the selected clip, the show's settings, or the rig.

import { useEffect, useState } from 'react';
import { barBeatAt, formatClock } from '@engine/timeexpr.js';
import { allTargets } from '@engine/rig.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { useConsole } from '@/lib/store';
import { commit, duplicate, newShow, openShow, setOutput } from '@/lib/runtime';
import { clipSummary, findClip } from '@/lib/clips';
import { AimField, AimListField, ChipsField, EnumField, NumberField, Row, Section, TextField, TimeField } from './fields';
import { RigPanel } from './RigPanel';
import type { Clip, ParamSpec, Rig, Show, Track, Vocabulary } from '@/types';

export function Inspector() {
  const selection = useConsole((s) => s.selection);
  const mode = useConsole((s) => s.mode);
  const [tab, setTab] = useState('show');
  useEffect(() => {
    if (selection.kind === 'clips') setTab('clip');
    else if (selection.kind === 'fixture' || selection.kind === 'object') setTab('rig');
  }, [selection]);
  useEffect(() => { if (mode === 'rig') setTab('rig'); }, [mode]);

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full flex-col gap-0 bg-card">
      <TabsList className="m-2 grid w-auto grid-cols-3">
        <TabsTrigger value="clip">Clip</TabsTrigger>
        <TabsTrigger value="show">Show</TabsTrigger>
        <TabsTrigger value="rig">Rig &amp; room</TabsTrigger>
      </TabsList>
      <ScrollArea className="min-h-0 flex-1">
        <TabsContent value="clip" className="mt-0"><ClipPanel /></TabsContent>
        <TabsContent value="show" className="mt-0"><ShowPanel /></TabsContent>
        <TabsContent value="rig" className="mt-0"><RigPanel /></TabsContent>
      </ScrollArea>
    </Tabs>
  );
}

// ------------------------------------------------------------------ clips

function ClipPanel() {
  const selection = useConsole((s) => s.selection);
  const show = useConsole((s) => s.show);
  const rig = useConsole((s) => s.rig);
  const vocabulary = useConsole((s) => s.vocabulary);
  if (!show || !rig || !vocabulary) return null;
  if (selection.kind !== 'clips' || !selection.ids.length) {
    return <p className="p-4 text-sm text-muted-foreground">Click a clip on the timeline. Double-click an empty lane to add one; shift-click or drag a box to pick several.</p>;
  }
  if (selection.ids.length > 1) {
    return (
      <Section title={`${selection.ids.length} clips selected`}>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => duplicate(selection.ids)}>Duplicate after</Button>
          <Button size="sm" variant="destructive" onClick={() => commit([{ op: 'deleteClips', ids: selection.ids }])}>Delete all</Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Drag any of them to move the lot.</p>
      </Section>
    );
  }
  const hit = findClip(show, selection.ids[0]);
  if (!hit) return null;
  return <ClipForm clip={hit.clip} track={hit.track} show={show} rig={rig} vocabulary={vocabulary} />;
}

function ClipForm({ clip, track, show, rig, vocabulary }: { clip: Clip; track: Track; show: Show; rig: Rig; vocabulary: Vocabulary }) {
  const patch = (fields: Record<string, unknown>) => commit([{ op: 'updateClips', clips: [{ id: clip.id, ...fields }] }]);
  const def = vocabulary.types[clip.type];
  const type = Object.values(rig.fixtureTypes)[0];
  const swatches = Object.fromEntries(type.colours.map((c) => [c.name, c.hex]));
  const targets = Object.keys(allTargets(rig));
  const fmt = (t: number) => { const { bar, beat } = barBeatAt(show, t); return `bar ${bar}.${Math.floor(beat)} · ${formatClock(t)}`; };
  const c = clip as any;
  const hidden = (p: ParamSpec) =>
    (clip.type === 'move' && p.key === 'breathe' && c.figure !== 'fan')
    || (clip.type === 'move' && p.key === 'positions' && c.figure !== 'snap')
    || (clip.type === 'fx' && p.key === 'colours' && c.effect !== 'colourStep')
    || (clip.type === 'fx' && p.key === 'gobos' && c.effect !== 'goboStep');

  const control = (p: ParamSpec) => {
    const value = c[p.key];
    const set = (v: unknown) => patch({ [p.key]: v });
    const clearable = clip.type === 'look' || p.default === undefined;
    switch (p.kind) {
      case 'number': return <NumberField spec={p} value={value} onCommit={set} clearable={clearable} />;
      case 'enum': return <EnumField options={p.options!} value={value} onCommit={set} placeholder={p.default != null ? `${p.default} (default)` : '—'} swatches={p.key === 'colour' ? swatches : undefined} />;
      case 'enumList': return <ChipsField options={p.options!} value={value} onCommit={set} />;
      case 'aim': return <AimField value={value} onCommit={set} targets={targets} fallback={p.default} />;
      case 'aimList': return <AimListField value={value} onCommit={set} targets={targets} />;
      case 'text': return <TextField value={value} onCommit={set} />;
      default: return null;
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 px-3 pt-1 pb-2">
        <Badge variant="secondary" className="uppercase">{clip.type}</Badge>
        <span className="truncate text-sm font-medium">{clipSummary(clip)}</span>
      </div>
      <Section title="When">
        <Row label="start"><TimeField value={clip.start} hint={fmt(clip.start)} onCommit={(v) => patch({ start: v })} /></Row>
        <Row label="end"><TimeField value={clip.end} hint={fmt(clip.end)} onCommit={(v) => patch({ end: v })} /></Row>
        <Row label="track">
          <Select value={track.id} onValueChange={(v) => patch({ track: v })}>
            <SelectTrigger size="sm" className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{show.tracks.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
          </Select>
        </Row>
      </Section>
      <Section title="Heads"><FixturePicker clip={clip} rig={rig} onCommit={(f) => patch({ fixtures: f })} /></Section>
      <Section title="Blend">
        {vocabulary.common.filter((p) => ['fadeIn', 'fadeOut'].includes(p.key)).map((p) => (
          <Row key={p.key} label={p.key} help={p.help}><NumberField spec={p} value={c[p.key]} onCommit={(v) => patch({ [p.key]: v })} clearable /></Row>
        ))}
        <Row label="label"><TextField value={clip.label} onCommit={(v) => patch({ label: v })} placeholder="optional name" /></Row>
      </Section>
      <Section title={clip.type === 'look' ? 'Look' : clip.type === 'move' ? 'Movement' : 'Effect'}>
        <p className="mb-2 text-xs text-muted-foreground">{def.help}</p>
        {def.params.filter((p) => !hidden(p)).map((p) => <Row key={p.key} label={p.key} help={p.help}>{control(p)}</Row>)}
      </Section>
      <Section title="Clip">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => patch({ muted: clip.muted ? null : true })}>{clip.muted ? 'Unmute' : 'Mute'}</Button>
          <Button size="sm" variant="outline" onClick={() => duplicate([clip.id])}>Duplicate after</Button>
          <Button size="sm" variant="destructive" onClick={() => commit([{ op: 'deleteClips', ids: [clip.id] }])}>Delete</Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">id {clip.id}</p>
      </Section>
    </div>
  );
}

function FixturePicker({ clip, rig, onCommit }: { clip: Clip; rig: Rig; onCommit: (f: string | string[] | null) => void }) {
  const current = clip.fixtures ?? 'all';
  const ids = new Set(typeof current === 'string' ? (rig.groups[current] ?? [current]) : current.flatMap((x) => rig.groups[x] ?? [x]));
  const pickHeads = (next: string[]) => {
    if (!next.length) return;
    const list = rig.fixtures.map((f) => f.id).filter((id) => next.includes(id));
    const group = Object.entries(rig.groups).find(([, m]) => m.length === list.length && m.every((id) => list.includes(id)));
    onCommit(group ? (group[0] === 'all' ? null : group[0]) : list);
  };
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup type="single" variant="outline" size="sm" className="flex flex-wrap justify-start"
        value={typeof current === 'string' && rig.groups[current] ? current : ''} onValueChange={(g: string) => g && onCommit(g === 'all' ? null : g)}>
        {Object.keys(rig.groups).map((g) => <ToggleGroupItem key={g} value={g} className="h-6 px-2 text-[11px]">{g}</ToggleGroupItem>)}
      </ToggleGroup>
      <ToggleGroup type="multiple" variant="outline" size="sm" className="justify-start" value={[...ids]} onValueChange={pickHeads}>
        {rig.fixtures.map((f) => <ToggleGroupItem key={f.id} value={f.id} className="h-6 px-2 font-mono text-[11px]" title={`${f.name} @ ${f.address}`}>{f.id}</ToggleGroupItem>)}
      </ToggleGroup>
    </div>
  );
}

// ------------------------------------------------------------------ the show

function ShowPanel() {
  const show = useConsole((s) => s.show);
  const name = useConsole((s) => s.name);
  const shows = useConsole((s) => s.shows);
  const songs = useConsole((s) => s.songs);
  const analysis = useConsole((s) => s.analysis);
  const output = useConsole((s) => s.output);
  const [creating, setCreating] = useState('');
  if (!show) return null;
  const meta = (fields: Record<string, unknown>) => commit([{ op: 'setMeta', ...fields }]);
  const num = (key: 'bpm' | 'offset' | 'beatsPerBar' | 'duration', step: number) => (
    <Input type="number" step={step} defaultValue={show[key]} key={`${key}-${show[key]}`} className="h-7 w-28 text-xs tabular-nums"
      onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== show[key]) meta({ [key]: key === 'beatsPerBar' ? Math.round(v) : v }); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
  return (
    <div>
      <Section title="Show">
        <Row label="open">
          <div className="flex gap-1">
            <Select value={name ?? undefined} onValueChange={openShow}>
              <SelectTrigger size="sm" className="h-7 flex-1 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{shows.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
            <Input className="h-7 w-24 text-xs" placeholder="new…" value={creating} onChange={(e) => setCreating(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && creating.trim()) { newShow(creating.trim()); setCreating(''); } }} />
          </div>
        </Row>
        <Row label="title"><TextField value={show.title} onCommit={(v) => v && meta({ title: v })} /></Row>
        <Row label="song" help="Drop audio files into show/songs/, or ask Claude to import one.">
          <EnumField options={songs.map((s) => s.file)} value={show.audio ?? undefined} onCommit={(v) => meta({ audio: v })} placeholder="— none —" />
        </Row>
        <Row label="bpm">{num('bpm', 0.01)}</Row>
        <Row label="offset" help="Where bar 1 beat 1 falls, in seconds">{num('offset', 0.001)}</Row>
        <Row label="beats / bar">{num('beatsPerBar', 1)}</Row>
        <Row label="duration">{num('duration', 0.1)}</Row>
      </Section>
      {analysis && (
        <Section title="Heard in the song">
          <p className="text-xs text-muted-foreground">{analysis.bpm} bpm (confidence {analysis.bpmConfidence}), bar 1 at {analysis.offset}s, {analysis.duration.toFixed(1)}s long, {analysis.sections.length} energy changes, {analysis.drops.length} drops.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => meta({ bpm: analysis.bpm, offset: analysis.offset, duration: Math.ceil(analysis.duration * 10) / 10 })}>Use tempo + length</Button>
            <Button size="sm" variant="outline" onClick={() => commit([{ op: 'addMarkers', markers: analysis.sections.map((x, i) => ({ at: x.t, label: `${i + 1} ${x.level}` })) }])}>Mark energy changes</Button>
          </div>
        </Section>
      )}
      <Section title="Output">
        <div className="flex items-center gap-2">
          <Switch checked={output.enabled} onCheckedChange={setOutput} id="dmx-out" />
          <label htmlFor="dmx-out" className="text-sm">Send DMX to the ENTTEC</label>
        </div>
        <p className={`mt-2 text-xs ${output.error ? 'text-red-400' : 'text-muted-foreground'}`}>
          {output.error ?? `${output.device ?? 'No ENTTEC found'}${output.connected ? ` · ${output.frames} frames sent` : ''}.`} Unplug the Disco 240 first: two transmitters on one line fight.
        </p>
      </Section>
      <LiveHeads />
      <Section title="Keys">
        <pre className="font-mono text-[11px] leading-relaxed text-muted-foreground">{`space   play / pause
home    back to the start
← →     a beat  (⇧ a bar)
M       marker at the playhead
B       blackout
⌫       delete selected clips
⌘D      duplicate after
⌘Z ⇧⌘Z  undo / redo
1–5     camera: front wide top side booth
⌘ scroll / pinch   zoom the timeline
rig mode: W move · E rotate · R resize`}</pre>
      </Section>
    </div>
  );
}

function LiveHeads() {
  const live = useConsole((s) => s.live);
  const rig = useConsole((s) => s.rig);
  if (!rig) return null;
  const type = Object.values(rig.fixtureTypes)[0];
  return (
    <Section title="Heads now">
      <table className="w-full font-mono text-[11px]">
        <thead><tr className="text-left text-muted-foreground"><th className="font-normal" /><th className="font-normal">dim</th><th className="font-normal">colour</th><th className="font-normal">gobo</th><th className="font-normal">pan</th><th className="font-normal">tilt</th></tr></thead>
        <tbody>
          {rig.fixtures.map((f) => {
            const s = live[f.id];
            if (!s) return null;
            const hex = type.colours.find((c) => c.name === s.colour)?.hex ?? '#fff';
            return (
              <tr key={f.id} className="border-t border-border/40">
                <td>{f.id}</td>
                <td>{Math.round(s.dimmer * 100)}</td>
                <td><span className="mr-1 inline-block size-2 rounded-full" style={{ background: s.colourSpin > 0 ? 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)' : hex }} />{s.colourSpin > 0 ? 'spin' : s.colour}</td>
                <td>{s.goboMode === 'static' ? s.gobo : `${s.gobo} ${s.goboMode}`}</td>
                <td>{s.pan.toFixed(0)}</td>
                <td>{s.tilt.toFixed(0)}{s.clamped ? '!' : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}
