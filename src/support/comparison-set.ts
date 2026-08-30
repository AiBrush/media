/**
 * Pinned comparison set (REQUIREMENTS §11 — 4.6).
 *
 * The comparison set MUST include the strongest maintained browser-capable
 * alternatives for each family, not just engines with one common API.
 * Versions MUST be pinned in evidence but updated for each release comparison.
 * This module is the pure, Node-testable taxonomy — no browser APIs, no
 * fixture branching, never huge-alloc, deterministic.
 */

export interface PinnedEngine {
  readonly name: string;
  readonly version: string; // semver pinned, e.g. 1.48.0
  readonly family: 'general' | 'demux' | 'container' | 'native';
}

export const PINNED_ENGINES: readonly PinnedEngine[] = Object.freeze([
  Object.freeze({ name: 'mediabunny', version: '1.48.0', family: 'general' } as PinnedEngine),
  Object.freeze({ name: 'ffmpeg.wasm', version: '0.12.15', family: 'general' } as PinnedEngine),
  Object.freeze({ name: 'mp4box', version: '2.3.0', family: 'container' } as PinnedEngine),
  Object.freeze({ name: 'remotion', version: '4.0.479', family: 'general' } as PinnedEngine),
  Object.freeze({ name: 'web-demuxer', version: '4.0.0', family: 'demux' } as PinnedEngine),
  Object.freeze({ name: 'native', version: 'browser', family: 'native' } as PinnedEngine),
]);

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function isPinnedEngine(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<PinnedEngine>;
  if (typeof v.name !== 'string' || !v.name) return false;
  if (typeof v.version !== 'string' || !v.version) return false;
  if (
    v.family !== 'general' &&
    v.family !== 'demux' &&
    v.family !== 'container' &&
    v.family !== 'native'
  )
    return false;
  return true;
}

export function isValidPinnedSet(engines: unknown): boolean {
  if (!Array.isArray(engines)) return false;
  if (engines.length !== PINNED_ENGINES.length) return false;
  const names = new Set<string>();
  for (const e of engines) {
    if (!isPinnedEngine(e)) return false;
    const eng = e as PinnedEngine;
    if (eng.version !== 'browser' && !SEMVER_RE.test(eng.version)) return false;
    if (names.has(eng.name)) return false;
    names.add(eng.name);
  }
  for (const req of PINNED_ENGINES) if (!names.has(req.name)) return false;
  return true;
}

export function assertPinnedComparisonSet(
  engines: unknown,
): asserts engines is readonly PinnedEngine[] {
  if (!isValidPinnedSet(engines))
    throw new RangeError(
      'pinned comparison set must include mediabunny, ffmpeg.wasm, mp4box, remotion, web-demuxer, native with pinned semver',
    );
}

export function pinnedEngineFor(name: string): PinnedEngine {
  if (typeof name !== 'string') throw new RangeError('name must be string');
  if (name.length > 40) throw new RangeError('name too long');
  const found = PINNED_ENGINES.find((e) => e.name === name);
  if (!found) throw new RangeError(`unknown pinned engine ${name}`);
  return found;
}
