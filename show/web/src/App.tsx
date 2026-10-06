import { useEffect } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { TopBar } from '@/components/TopBar';
import { StageView, stageInstance } from '@/components/StageView';
import { Inspector } from '@/components/Inspector';
import { Timeline, snapTime } from '@/components/Timeline';
import { CAMERAS } from '@/stage/stage';
import { getConsole, setConsole, useConsole } from '@/lib/store';
import { commit, duplicate, getTime, nudge, redo, seek, setBlackout, togglePlay, undo } from '@/lib/runtime';

function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]')) return;
      const { show, selection, mode, blackout } = getConsole();
      if (!show) return;
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Home') seek(0);
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(e.shiftKey ? show.beatsPerBar : 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-(e.shiftKey ? show.beatsPerBar : 1)); }
      else if (meta && key === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); }
      else if (meta && key === 'd') { e.preventDefault(); if (selection.kind === 'clips') duplicate(selection.ids); }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && selection.kind === 'clips') { e.preventDefault(); commit([{ op: 'deleteClips', ids: selection.ids }]); }
      else if (key === 'm' && !meta) commit([{ op: 'addMarkers', markers: [{ at: snapTime(show, getTime()), label: `Marker ${show.markers.length + 1}` }] }]);
      else if (key === 'b' && !meta) setBlackout(!blackout);
      else if (e.key === 'Escape') setConsole({ selection: { kind: 'none' } });
      else if (/^[1-5]$/.test(e.key) && !meta) stageInstance?.setCamera(Object.keys(CAMERAS)[Number(e.key) - 1]);
      else if (mode === 'rig' && !meta && key === 'w') setConsole({ editTool: 'translate' });
      else if (mode === 'rig' && !meta && key === 'e') setConsole({ editTool: 'rotate' });
      else if (mode === 'rig' && !meta && key === 'r') setConsole({ editTool: 'scale' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  useKeys();
  const ready = useConsole((s) => Boolean(s.show && s.rig && s.vocabulary));
  if (!ready) return <div className="grid h-screen place-items-center text-sm text-muted-foreground">Connecting to the show server…</div>;
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar />
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="60" minSize={160}>
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="74" minSize={320}><StageView /></ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize="26" minSize={300}><Inspector /></ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="40" minSize={180}><Timeline /></ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
