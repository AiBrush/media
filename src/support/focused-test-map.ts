/**
 * Focused test → relevant media-test family mapping (REQUIREMENTS §8.1 — C3).
 *
 * Every change must run focused repo tests and the relevant media-test cell.
 * This module is the pure, Node-testable mapping — no browser APIs, no
 * fixture branching, never huge-alloc, deterministic.
 */

export type MediaTestFamily =
  | 'probe'
  | 'demux'
  | 'mux'
  | 'transcode'
  | 'trim'
  | 'robustness'
  | 'encryption'
  | 'streaming'
  | 'remux'
  | 'performance';

const FOCUSED_MAP: Record<string, MediaTestFamily> = {
  'src/drivers/mp4': 'probe',
  'src/drivers/webm': 'mux',
  'src/drivers/mpegts': 'mux',
  'src/drivers/ogg': 'demux',
  'src/drivers/wav': 'mux',
  'src/drivers/mp3': 'trim',
  'src/drivers/flac': 'demux',
  'src/dsp': 'transcode',
  'src/filters': 'transcode',
  'src/crypto': 'encryption',
  'src/support/perf': 'performance',
  'src/support/queue': 'performance',
  'src/support/browser': 'probe',
  'src/support/held-out': 'robustness',
  'src/support/evidence': 'probe',
};

export function relevantFamilyForPath(path: string): MediaTestFamily {
  if (typeof path !== 'string') throw new RangeError('path must be string');
  if (path.length > 500) throw new RangeError('path too long');
  for (const [prefix, family] of Object.entries(FOCUSED_MAP)) {
    if (path.startsWith(prefix)) return family;
  }
  return 'probe';
}

export function assertRelevantFamilyCovered(changedPaths: readonly string[], coveredFamilies: readonly string[]): void {
  if (!Array.isArray(changedPaths) || !Array.isArray(coveredFamilies)) throw new RangeError('must be arrays');
  if (changedPaths.length > 100 || coveredFamilies.length > 20) throw new RangeError('too many entries');
  for (const p of changedPaths) if (typeof p !== 'string') throw new RangeError('path must be string');
  for (const f of coveredFamilies) if (typeof f !== 'string') throw new RangeError('family must be string');
  const needed = new Set(changedPaths.map(relevantFamilyForPath));
  for (const fam of needed) if (!(coveredFamilies as readonly string[]).includes(fam)) throw new RangeError(`family not covered: ${fam}`);
}

export function familiesForChanges(changedPaths: readonly string[]): readonly MediaTestFamily[] {
  if (!Array.isArray(changedPaths)) throw new RangeError('changedPaths must be array');
  if (changedPaths.length > 100) throw new RangeError('too many paths');
  const set = new Set<MediaTestFamily>();
  for (const p of changedPaths) set.add(relevantFamilyForPath(p));
  return Object.freeze([...set].sort());
}
