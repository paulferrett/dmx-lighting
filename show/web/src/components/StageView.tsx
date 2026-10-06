import { useEffect, useRef, useState } from 'react';
import { Move3d, Rotate3d, Scaling } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CAMERAS, Stage } from '@/stage/stage';
import { getConsole, setConsole, useConsole } from '@/lib/store';
import { registerStage, saveRig } from '@/lib/runtime';
import type { Rig, Selection } from '@/types';

export let stageInstance: Stage | null = null;

// Apply a live drag from the 3D handles to the rig in the store (so the
// numbers in the panel move with it), and save it when the mouse lets go.
function applyEdit(sel: Selection, change: any, done: boolean) {
  const rig = getConsole().rig;
  if (!rig) return;
  let next: Rig = rig;
  if (sel.kind === 'fixture') {
    next = { ...rig, fixtures: rig.fixtures.map((f) => (f.id === sel.id ? { ...f, position: change.position, rotation: change.rotation } : f)) };
  } else if (sel.kind === 'object') {
    next = { ...rig, room: { ...rig.room, objects: rig.room.objects.map((o) => (o.id === sel.id ? { ...o, position: change.position, rotation: change.rotation, size: change.size } : o)) } };
  }
  setConsole({ rig: next });
  if (done) saveRig(sel.kind === 'fixture' ? { fixtures: next.fixtures } : { room: next.room });
}

export function StageView() {
  const box = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState<ReturnType<Stage['labelPositions']>>([]);
  const mode = useConsole((s) => s.mode);
  const selection = useConsole((s) => s.selection);
  const tool = useConsole((s) => s.editTool);
  const [snap, setSnap] = useState(true);
  const rigLoaded = useConsole((s) => Boolean(s.rig));

  useEffect(() => {
    const rig = getConsole().rig;
    if (!box.current || !rig) return;
    const stage = new Stage(box.current, rig, {
      onPick: (sel) => setConsole({ selection: sel }),
      onEdit: applyEdit,
    });
    stageInstance = stage;
    registerStage(stage);
    const timer = setInterval(() => setLabels(stage.labelPositions()), 100);
    return () => { clearInterval(timer); registerStage(null); stage.dispose(); stageInstance = null; };
  }, [rigLoaded]);

  useEffect(() => { stageInstance?.setEditing(mode === 'rig', tool, snap); }, [mode, tool, snap]);
  useEffect(() => {
    if (selection.kind === 'fixture' || selection.kind === 'object') stageInstance?.select(selection);
    else stageInstance?.select({ kind: 'none' });
  }, [selection, mode, tool]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <div ref={box} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-0">
        {labels.map((l) => (
          <div key={`${l.kind}-${l.id}`} className={`absolute -translate-x-1/2 font-mono text-[10px] [text-shadow:0_1px_2px_#000] ${l.kind === 'object' ? 'text-sky-300/80' : 'text-zinc-400'}`}
            style={{ transform: `translate(${l.x}px, ${l.y}px) translateX(-50%)` }}>{l.text}</div>
        ))}
      </div>
      <div className="absolute top-2 right-2 flex gap-1">
        {Object.keys(CAMERAS).map((name, i) => (
          <Button key={name} size="sm" variant="secondary" className="h-7 bg-black/50 text-xs backdrop-blur" title={`Camera ${i + 1}`} onClick={() => stageInstance?.setCamera(name)}>{name}</Button>
        ))}
      </div>
      {mode === 'rig' && (
        <div className="absolute top-2 left-2 flex items-center gap-2 rounded-md bg-black/60 p-1.5 backdrop-blur">
          <ToggleGroup type="single" size="sm" variant="outline" value={tool} onValueChange={(v: string) => v && setConsole({ editTool: v as any })}>
            <ToggleGroupItem value="translate" title="Move (W)" className="h-7 px-2 text-xs"><Move3d className="size-3.5" />Move</ToggleGroupItem>
            <ToggleGroupItem value="rotate" title="Rotate (E)" className="h-7 px-2 text-xs"><Rotate3d className="size-3.5" />Rotate</ToggleGroupItem>
            <ToggleGroupItem value="scale" title="Resize a room object (R)" className="h-7 px-2 text-xs"><Scaling className="size-3.5" />Resize</ToggleGroupItem>
          </ToggleGroup>
          <label className="flex items-center gap-1.5 text-xs text-zinc-300"><Switch checked={snap} onCheckedChange={setSnap} />Snap 5 cm / 15°</label>
          <span className="pr-1 text-[11px] text-zinc-400">{selection.kind === 'fixture' || selection.kind === 'object' ? `editing ${selection.id}` : 'click a head or a room object'}</span>
        </div>
      )}
    </div>
  );
}
