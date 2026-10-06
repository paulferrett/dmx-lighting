import { Pause, Play, Redo2, SkipBack, Undo2 } from 'lucide-react';
import { barBeatAt, formatClock } from '@engine/timeexpr.js';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { setConsole, useConsole } from '@/lib/store';
import { redo, seek, setBlackout, setOutput, togglePlay, undo } from '@/lib/runtime';

export function TopBar() {
  const show = useConsole((s) => s.show);
  const connected = useConsole((s) => s.connected);
  const playing = useConsole((s) => s.playing);
  const clock = useConsole((s) => s.clock);
  const mode = useConsole((s) => s.mode);
  const blackout = useConsole((s) => s.blackout);
  const output = useConsole((s) => s.output);
  const bb = show ? barBeatAt(show, clock) : null;
  const waiting = output.enabled && !output.connected;
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <span className={`size-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400' : 'bg-zinc-600'}`} title={connected ? 'Connected to the show server' : 'Reconnecting…'} />
      <strong className="mr-3 max-w-[28vw] truncate text-sm">{show?.title ?? 'Show'}</strong>
      <Button size="icon" variant="outline" className="size-8" title="Back to the start (Home)" onClick={() => seek(0)}><SkipBack className="size-4" /></Button>
      <Button size="icon" variant="outline" className="size-8" title="Play / pause (space)" onClick={togglePlay}>{playing ? <Pause className="size-4" /> : <Play className="size-4" />}</Button>
      <span className="w-14 text-right font-mono text-sm font-semibold text-sky-400 tabular-nums">{bb && bb.bar >= 1 ? `${bb.bar}.${Math.floor(bb.beat)}` : '—'}</span>
      <span className="w-20 font-mono text-sm font-semibold tabular-nums">{formatClock(clock)}</span>
      <ToggleGroup type="single" variant="outline" size="sm" className="ml-4" value={mode} onValueChange={(v: string) => v && setConsole({ mode: v as any, selection: { kind: 'none' } })}>
        <ToggleGroupItem value="show" className="h-8 px-3 text-xs">Show</ToggleGroupItem>
        <ToggleGroupItem value="rig" className="h-8 px-3 text-xs" title="Move the heads and the room on the stage">Rig</ToggleGroupItem>
      </ToggleGroup>
      <div className="flex-1" />
      <Button size="icon" variant="ghost" className="size-8" title="Undo (⌘Z)" onClick={undo}><Undo2 className="size-4" /></Button>
      <Button size="icon" variant="ghost" className="size-8" title="Redo (⇧⌘Z)" onClick={redo}><Redo2 className="size-4" /></Button>
      <Button size="sm" variant={blackout ? 'default' : 'outline'} className={blackout ? 'bg-white text-black hover:bg-white/90' : ''} title="Blackout (B)" onClick={() => setBlackout(!blackout)}>Blackout</Button>
      <Button size="sm" title={output.error ?? output.device ?? 'No ENTTEC found'} onClick={() => setOutput(!output.enabled)}
        className={waiting ? 'animate-pulse border border-amber-400 bg-amber-950 text-amber-200 hover:bg-amber-900'
          : output.enabled ? 'bg-red-600 font-bold text-white shadow-[0_0_12px] shadow-red-600 hover:bg-red-500'
            : 'border border-border bg-transparent text-foreground hover:bg-muted'}>
        {waiting ? 'DMX waiting…' : output.enabled ? 'DMX LIVE' : 'DMX off'}
      </Button>
    </header>
  );
}
