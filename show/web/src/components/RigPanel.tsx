// The rig and the room, as numbers. The same things move live on the stage
// in rig mode; whichever you use, a change is saved to rig.json and Claude
// reads it from rig_get.

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { useConsole, setConsole } from '@/lib/store';
import { saveRig } from '@/lib/runtime';
import { NumberInput, Row, Section, TextField, Vec3Field, EnumField } from './fields';
import type { Fixture, Rig, RoomObject, Vec3 } from '@/types';

// Common ways to mount a head. Rotation is degrees about x, y, z; the base
// arrow on the stage shows which way pan 0 faces.
const ORIENTATIONS: { label: string; rotation: Vec3; help: string }[] = [
  { label: 'Upright', rotation: [0, 0, 0], help: 'On the floor or a stand, beam up' },
  { label: 'Hung', rotation: [0, 0, 180], help: 'Upside down from a truss or ceiling, beam down' },
  { label: 'Back wall', rotation: [90, 0, 0], help: 'Base against the back wall, beam out at the room' },
  { label: 'Left wall', rotation: [0, 0, -90], help: 'Base on the left wall, beam across to the right' },
  { label: 'Right wall', rotation: [0, 0, 90], help: 'Base on the right wall, beam across to the left' },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'thing';

export function RigPanel() {
  const rig = useConsole((s) => s.rig);
  const selection = useConsole((s) => s.selection);
  const mode = useConsole((s) => s.mode);
  if (!rig) return null;
  const select = (sel: typeof selection) => setConsole({ selection: sel, mode: 'rig' });
  const fixture = selection.kind === 'fixture' ? rig.fixtures.find((f) => f.id === selection.id) : undefined;
  const object = selection.kind === 'object' ? rig.room.objects.find((o) => o.id === selection.id) : undefined;

  return (
    <div>
      {mode !== 'rig' && (
        <div className="mx-3 mt-1 mb-2 rounded-md border border-border/60 bg-muted/40 p-2 text-xs text-muted-foreground">
          Switch the top bar to <b>Rig</b> to click things on the stage and drag them into place.
        </div>
      )}
      <Section title="Heads" actions={<Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => addFixture(rig, select)}><Plus className="size-3.5" />Head</Button>}>
        <div className="flex flex-wrap gap-1">
          {rig.fixtures.map((f) => (
            <Button key={f.id} size="sm" variant={fixture?.id === f.id ? 'default' : 'outline'} className="h-7 font-mono text-xs" onClick={() => select({ kind: 'fixture', id: f.id })}>
              {f.id}<span className="text-muted-foreground">@{f.address}</span>
            </Button>
          ))}
        </div>
      </Section>
      {fixture && <FixtureForm rig={rig} fixture={fixture} onDeleted={() => select({ kind: 'none' })} />}

      <Section title="Room" actions={
        <div className="flex gap-1">
          {(['wall', 'box', 'zone'] as const).map((k) => (
            <Button key={k} size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => addObject(rig, k, select)}><Plus className="size-3.5" />{k}</Button>
          ))}
        </div>
      }>
        <Row label="haze" help="How much the beams show in the air.">
          <Slider min={0} max={1} step={0.05} defaultValue={[rig.room.haze]} key={rig.room.haze} onValueCommit={([v]) => saveRig({ room: { ...rig.room, haze: v } })} />
        </Row>
        <Row label="ceiling" help="Off for open air. Beams stop on a ceiling and gobos land on it.">
          <div className="flex items-center gap-2">
            <Switch checked={rig.room.ceiling != null} onCheckedChange={(on) => saveRig({ room: { ...rig.room, ceiling: on ? 3.5 : null } })} />
            {rig.room.ceiling != null && <><NumberInput value={rig.room.ceiling} step={0.1} min={1} onCommit={(v) => v && saveRig({ room: { ...rig.room, ceiling: v } })} /><span className="text-xs text-muted-foreground">m</span></>}
          </div>
        </Row>
        <div className="mt-2 flex flex-wrap gap-1">
          {rig.room.objects.map((o) => (
            <Button key={o.id} size="sm" variant={object?.id === o.id ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => select({ kind: 'object', id: o.id })}>
              {o.label || o.id}<span className="text-muted-foreground">{o.kind}</span>
            </Button>
          ))}
        </div>
      </Section>
      {object && <ObjectForm rig={rig} object={object} onDeleted={() => select({ kind: 'none' })} />}

      <TargetsSection rig={rig} />
    </div>
  );
}

function FixtureForm({ rig, fixture, onDeleted }: { rig: Rig; fixture: Fixture; onDeleted: () => void }) {
  const save = (patch: Partial<Fixture>) => saveRig({ fixtures: rig.fixtures.map((f) => (f.id === fixture.id ? { ...f, ...patch } : f)) });
  return (
    <Section title={`${fixture.id} — ${fixture.name}`} actions={
      <Button size="sm" variant="ghost" className="h-6 text-xs text-red-400" onClick={() => { saveRig({ fixtures: rig.fixtures.filter((f) => f.id !== fixture.id) }); onDeleted(); }}><Trash2 className="size-3.5" />Remove</Button>
    }>
      <Row label="name"><TextField value={fixture.name} onCommit={(v) => v && save({ name: v })} /></Row>
      <Row label="address" help="DMX start address. The Disco 240 spaces heads 16 apart: 1, 17, 33, 49…">
        <NumberInput value={fixture.address} step={1} min={1} max={512} onCommit={(v) => v && save({ address: Math.round(v) })} />
      </Row>
      <Row label="position" help="Metres. x left → right as the audience sees it, y up, z toward the audience. The base of the head."><Vec3Field value={fixture.position} onCommit={(v) => save({ position: v })} /></Row>
      <Row label="rotation" help="Degrees about x, y, z. Or pick a mount below."><Vec3Field value={fixture.rotation} step={5} onCommit={(v) => save({ rotation: v })} /></Row>
      <Row label="mount">
        <div className="flex flex-wrap gap-1">
          {ORIENTATIONS.map((o) => (
            <Button key={o.label} size="sm" variant={o.rotation.every((d, i) => Math.abs(d - fixture.rotation[i]) < 0.5) ? 'default' : 'outline'} className="h-6 px-2 text-[11px]" title={o.help}
              onClick={() => save({ rotation: o.rotation })}>{o.label}</Button>
          ))}
        </div>
      </Row>
      <Row label="pan offset" help="If the real head's pan 0 doesn't face where the arrow on the stage points, the difference in degrees.">
        <div className="flex items-center gap-2">
          <NumberInput value={fixture.panOffset ?? 0} step={1} onCommit={(v) => save({ panOffset: v ?? 0 })} />
          <label className="flex items-center gap-1 text-xs text-muted-foreground"><Switch checked={Boolean(fixture.panInvert)} onCheckedChange={(on) => save({ panInvert: on })} />invert</label>
        </div>
      </Row>
      <Row label="tilt offset">
        <div className="flex items-center gap-2">
          <NumberInput value={fixture.tiltOffset ?? 0} step={1} onCommit={(v) => save({ tiltOffset: v ?? 0 })} />
          <label className="flex items-center gap-1 text-xs text-muted-foreground"><Switch checked={Boolean(fixture.tiltInvert)} onCheckedChange={(on) => save({ tiltInvert: on })} />invert</label>
        </div>
      </Row>
    </Section>
  );
}

function ObjectForm({ rig, object, onDeleted }: { rig: Rig; object: RoomObject; onDeleted: () => void }) {
  const save = (patch: Partial<RoomObject>) => saveRig({ room: { ...rig.room, objects: rig.room.objects.map((o) => (o.id === object.id ? { ...o, ...patch } : o)) } });
  return (
    <Section title={object.label || object.id} actions={
      <Button size="sm" variant="ghost" className="h-6 text-xs text-red-400" onClick={() => { saveRig({ room: { ...rig.room, objects: rig.room.objects.filter((o) => o.id !== object.id) } }); onDeleted(); }}><Trash2 className="size-3.5" />Remove</Button>
    }>
      <Row label="label"><TextField value={object.label} onCommit={(v) => v && save({ label: v })} /></Row>
      <Row label="kind" help="wall and box are solid: beams stop on them. zone is an area of floor — the dancefloor, where the crowd stands.">
        <EnumField options={['wall', 'box', 'zone']} value={object.kind} onCommit={(v) => v && save({ kind: v as RoomObject['kind'], size: v === 'zone' ? [object.size[0], 0, object.size[2]] : object.size })} />
      </Row>
      <Row label="position" help="Centre of its base, metres."><Vec3Field value={object.position} onCommit={(v) => save({ position: v })} /></Row>
      <Row label="size" help="Width, height, depth in metres."><Vec3Field value={object.size} labels={['w', 'h', 'd']} onCommit={(v) => save({ size: v })} /></Row>
      <Row label="rotation" help="Degrees around the vertical.">
        <NumberInput value={object.rotation} step={5} onCommit={(v) => save({ rotation: v ?? 0 })} />
      </Row>
      {object.kind === 'zone' && (
        <Row label="crowd" help="How many people to draw standing here.">
          <NumberInput value={object.crowd ?? 0} step={1} min={0} onCommit={(v) => save({ crowd: Math.max(0, Math.round(v ?? 0)) })} />
        </Row>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">Aim at it as “{object.id}”.</p>
    </Section>
  );
}

function TargetsSection({ rig }: { rig: Rig }) {
  const save = (targets: Record<string, Vec3>) => saveRig({ targets });
  return (
    <Section title="Aim targets" actions={
      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => {
        let n = 1; while (rig.targets[`target-${n}`]) n++;
        save({ ...rig.targets, [`target-${n}`]: [0, 3, 6] });
      }}><Plus className="size-3.5" />Target</Button>
    }>
      <p className="mb-2 text-xs text-muted-foreground">Named points the heads can converge on. Room objects are targets too.</p>
      {Object.entries(rig.targets).map(([name, p]) => (
        <div key={name} className="flex items-center gap-1 py-0.5">
          <span className="w-24 truncate font-mono text-[11px]">{name}</span>
          <Vec3Field value={p} onCommit={(v) => save({ ...rig.targets, [name]: v })} />
          <Button size="icon" variant="ghost" className="size-6 text-muted-foreground" onClick={() => { const { [name]: _, ...rest } = rig.targets; save(rest); }}><Trash2 className="size-3" /></Button>
        </div>
      ))}
    </Section>
  );
}

function addFixture(rig: Rig, select: (s: any) => void) {
  let n = rig.fixtures.length + 1;
  while (rig.fixtures.some((f) => f.id === `h${n}`)) n++;
  const last = rig.fixtures.at(-1);
  const address = Math.max(0, ...rig.fixtures.map((f) => f.address)) + 16;
  const fixture: Fixture = {
    id: `h${n}`, name: `Head ${n}`, type: last?.type ?? Object.keys(rig.fixtureTypes)[0], address,
    position: last ? [last.position[0] + 1.6, last.position[1], last.position[2]] : [0, 1.5, 0],
    rotation: last ? [...last.rotation] as Vec3 : [0, 0, 0],
    panOffset: 0, tiltOffset: 0, panInvert: false, tiltInvert: false,
  };
  saveRig({ fixtures: [...rig.fixtures, fixture] }).then((r) => r && select({ kind: 'fixture', id: fixture.id }));
}

function addObject(rig: Rig, kind: RoomObject['kind'], select: (s: any) => void) {
  const label = kind === 'wall' ? 'Wall' : kind === 'box' ? 'Box' : 'Zone';
  let id = slug(label);
  for (let n = 2; rig.room.objects.some((o) => o.id === id); n++) id = `${slug(label)}-${n}`;
  const object: RoomObject = {
    id, label, kind, rotation: 0,
    position: kind === 'wall' ? [5, 0, 3] : kind === 'box' ? [3, 0, 3] : [0, 0, 6],
    size: kind === 'wall' ? [0.2, 3, 8] : kind === 'box' ? [1, 1, 1] : [4, 0, 4],
    ...(kind === 'zone' ? { crowd: 0 } : {}),
  };
  saveRig({ room: { ...rig.room, objects: [...rig.room.objects, object] } }).then((r) => r && select({ kind: 'object', id }));
}
