import type { Clip, Rig } from '@/types';

/** One line that says what a clip does, for its label on the timeline. */
export function clipSummary(clip: Clip): string {
  if (clip.label) return clip.label;
  const parts: string[] = [];
  const c = clip as any;
  if (clip.type === 'look') {
    if (c.dimmer != null) parts.push(`${Math.round(c.dimmer * 100)}%`);
    if (c.colourSpin) parts.push('colour spin');
    else if (c.colour) parts.push(c.colour);
    if (c.gobo && c.gobo !== 'open') parts.push(c.gobo + (c.goboMode && c.goboMode !== 'static' ? ` ${c.goboMode}` : ''));
    if (c.prism && c.prism !== 'off') parts.push(`prism ${c.prism}`);
    if (c.strobe) parts.push('strobe');
    if (c.aim != null) parts.push(`→ ${typeof c.aim === 'string' ? c.aim : Array.isArray(c.aim) ? 'point' : `${c.aim.pan}/${c.aim.tilt}`}`);
    if (c.crawl) parts.push('crawl');
  } else if (clip.type === 'move') {
    const figure = c.figure ?? 'circle';
    parts.push(figure);
    if (figure === 'snap') parts.push(`${c.positions?.length ?? 1} pos /${c.period ?? 4}`);
    else if (!['fan', 'cross', 'still'].includes(figure)) parts.push(`/${c.period ?? 4}`);
  } else {
    parts.push(c.effect ?? 'pulse', `/${c.period ?? 1}`);
  }
  const who = clip.fixtures && clip.fixtures !== 'all' ? ` · ${([] as string[]).concat(clip.fixtures).join('+')}` : '';
  return parts.join(' · ') + who;
}

/** The clip's colour on the timeline: a look shows its colour wheel slot. */
export function clipColour(clip: Clip, rig: Rig): string {
  if (clip.type === 'look') {
    const type = Object.values(rig.fixtureTypes)[0];
    if ((clip as any).colourSpin) return '#e879f9';
    return type.colours.find((c) => c.name === (clip as any).colour)?.hex ?? '#8a8a99';
  }
  return clip.type === 'move' ? '#5b7cfa' : '#c056ff';
}

export function findClip<T extends { clips: Clip[] }>(show: { tracks: T[] }, id: string): { track: T; clip: Clip } | null {
  for (const track of show.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { track, clip };
  }
  return null;
}
