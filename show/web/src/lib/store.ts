// What React draws from. Per-frame values (the playhead, every head's state)
// stay out of here and live in runtime.ts; the store only carries what
// changes at human speed, plus a throttled clock for the readouts.

import { create } from 'zustand';
import type { Analysis, FixtureState, OutputStatus, Rig, Selection, Show, Vocabulary } from '@/types';

export interface ConsoleState {
  connected: boolean;
  name: string | null;
  show: Show | null;
  rig: Rig | null;
  vocabulary: Vocabulary | null;
  output: OutputStatus;
  shows: string[];
  songs: { file: string; analysed: boolean }[];
  analysis: Analysis | null;
  selection: Selection;
  mode: 'show' | 'rig';
  playing: boolean;
  blackout: boolean;
  /** Clip ids changed by someone else (Claude) in the last edit — flashed on the timeline. */
  fresh: Set<string>;
  /** Throttled copies for readouts (~15 Hz). */
  clock: number;
  live: Record<string, FixtureState>;
  editTool: 'translate' | 'rotate' | 'scale';
  snap: 'bar' | 'beat' | 'half' | 'off';
}

export const useConsole = create<ConsoleState>()(() => ({
  connected: false,
  name: null,
  show: null,
  rig: null,
  vocabulary: null,
  output: { enabled: false, connected: false, device: null, error: null, frames: 0, lastFrameAt: null },
  shows: [],
  songs: [],
  analysis: null,
  selection: { kind: 'none' },
  mode: 'show',
  playing: false,
  blackout: false,
  fresh: new Set(),
  clock: 0,
  live: {},
  editTool: 'translate',
  snap: 'beat',
}));

export const setConsole = useConsole.setState;
export const getConsole = useConsole.getState;
