export type Vec3 = [number, number, number];
export type Aim = string | Vec3 | { pan: number; tilt: number };

export interface Clip {
  id: string;
  type: 'look' | 'move' | 'fx';
  start: number;
  end: number;
  fixtures?: string | string[];
  fadeIn?: number;
  fadeOut?: number;
  label?: string;
  muted?: boolean;
  [field: string]: unknown;
}

export interface Track { id: string; name: string; muted: boolean; clips: Clip[] }
export interface Marker { id: string; t: number; label: string }

export interface Show {
  version: number;
  title: string;
  audio: string | null;
  duration: number;
  bpm: number;
  offset: number;
  beatsPerBar: number;
  markers: Marker[];
  tracks: Track[];
}

export interface Fixture {
  id: string;
  name: string;
  type: string;
  address: number;
  position: Vec3;
  rotation: Vec3;
  panOffset?: number;
  tiltOffset?: number;
  panInvert?: boolean;
  tiltInvert?: boolean;
}

export interface RoomObject {
  id: string;
  label: string;
  kind: 'wall' | 'box' | 'zone';
  position: Vec3;
  size: Vec3;
  rotation: number;
  crowd?: number;
}

export interface Room { haze: number; ceiling: number | null; objects: RoomObject[] }

export interface FixtureType {
  name: string;
  channels: Record<string, number>;
  panRange: number;
  tiltRange: number;
  beamAngle: number;
  panSpeed?: number;
  tiltSpeed?: number;
  strobeHz?: [number, number];
  colours: { name: string; dmx: number; hex: string }[];
  gobos: { name: string; dmx: number }[];
  prism: { off: number; in: number; rotateFrom: number; facets?: number };
}

export interface Rig {
  name: string;
  notes?: string;
  room: Room;
  home: { pan: number; tilt: number };
  targets: Record<string, Vec3>;
  fixtureTypes: Record<string, FixtureType>;
  fixtures: Fixture[];
  groups: Record<string, string[]>;
}

export interface ParamSpec {
  key: string;
  kind: 'number' | 'enum' | 'enumList' | 'aim' | 'aimList' | 'text' | 'time' | 'fixtures';
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  default?: unknown;
  help?: string;
}

export interface Vocabulary {
  common: ParamSpec[];
  types: Record<'look' | 'move' | 'fx', { help: string; params: ParamSpec[] }>;
}

export interface OutputStatus {
  enabled: boolean;
  connected: boolean;
  device: string | null;
  error: string | null;
  frames: number;
  lastFrameAt: number | null;
}

export interface Analysis {
  file: string;
  duration: number;
  bpm: number;
  bpmConfidence: number;
  offset: number;
  beatsPerBar: number;
  bars: { bar: number; t: number; energy: number; low: number; high: number; busy: number }[];
  sections: { bar: number; t: number; level: string; change: number }[];
  drops: { bar: number; t: number; strength: number }[];
  curve: { step: number; energy: number[]; low: number[] };
  peaks: { rate: number; min: number[]; max: number[] };
}

export interface FixtureState {
  dimmer: number;
  colour: string;
  colourSpin: number;
  gobo: string;
  goboMode: 'static' | 'shake' | 'scroll';
  goboSpeed: number;
  prism: 'off' | 'in' | 'rotate';
  prismSpeed: number;
  strobe: number;
  pan: number;
  tilt: number;
  crawl: number;
  clamped: boolean;
}

export type Selection =
  | { kind: 'none' }
  | { kind: 'clips'; ids: string[] }
  | { kind: 'fixture'; id: string }
  | { kind: 'object'; id: string };

export type Op = { op: string; [field: string]: unknown };
