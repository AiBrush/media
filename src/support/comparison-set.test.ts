import { describe, expect, it } from 'vitest';
import {
  PINNED_ENGINES,
  assertPinnedComparisonSet,
  isPinnedEngine,
  isValidPinnedSet,
  pinnedEngineFor,
} from './comparison-set.ts';

describe('pinned comparison set — 4.6', () => {
  it('includes 6 engines with pinned versions', () => {
    expect(PINNED_ENGINES.length).toBe(6);
    expect(PINNED_ENGINES.map((e) => e.name)).toEqual([
      'mediabunny',
      'ffmpeg.wasm',
      'mp4box',
      'remotion',
      'web-demuxer',
      'native',
    ]);
    for (const e of PINNED_ENGINES) expect(isPinnedEngine(e)).toBe(true);
    expect(PINNED_ENGINES.find((e) => e.name === 'mediabunny')!.version).toBe('1.48.0');
    expect(PINNED_ENGINES.find((e) => e.name === 'native')!.version).toBe('browser');
    expect(() => assertPinnedComparisonSet([...PINNED_ENGINES])).not.toThrow();
    expect(isValidPinnedSet([...PINNED_ENGINES])).toBe(true);
  });

  it('rejects missing or duplicate engine', () => {
    expect(isValidPinnedSet(PINNED_ENGINES.slice(0, 5))).toBe(false);
    expect(() => assertPinnedComparisonSet(PINNED_ENGINES.slice(0, 5) as never)).toThrow(
      RangeError,
    );
    const dup = [...PINNED_ENGINES, PINNED_ENGINES[0]!] as never;
    expect(isValidPinnedSet(dup)).toBe(false);
    expect(isValidPinnedSet([])).toBe(false);
  });

  it('validates semver and family', () => {
    expect(
      isValidPinnedSet([...PINNED_ENGINES].map((e) => ({ ...e, version: 'bad' })) as never),
    ).toBe(false);
    expect(isPinnedEngine({ name: 'mediabunny', version: '1.48.0', family: 'general' })).toBe(true);
    expect(
      isPinnedEngine({ name: 'mediabunny', version: '1.48.0', family: 'unknown' } as never),
    ).toBe(false);
    expect(pinnedEngineFor('mediabunny').version).toBe('1.48.0');
    expect(() => pinnedEngineFor('unknown' as never)).toThrow(RangeError);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const name = PINNED_ENGINES[i % PINNED_ENGINES.length]!.name;
      expect(isPinnedEngine(pinnedEngineFor(name))).toBe(true);
      expect(isValidPinnedSet([...PINNED_ENGINES])).toBe(true);
      const shuffled = [...PINNED_ENGINES].sort(() => (i % 2 === 0 ? 1 : -1));
      expect(isValidPinnedSet(shuffled)).toBe(true);
    }
  });

  it('boundary: exactly 6 vs 5, native browser version', () => {
    expect(PINNED_ENGINES.length).toBe(6);
    expect(isValidPinnedSet([...PINNED_ENGINES])).toBe(true);
    expect(isValidPinnedSet(PINNED_ENGINES.slice(0, 5) as never)).toBe(false);
    expect(pinnedEngineFor('native').version).toBe('browser');
    expect(pinnedEngineFor('mp4box').version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(isPinnedEngine(null)).toBe(false);
    expect(isValidPinnedSet(null as never)).toBe(false);
    expect(() => assertPinnedComparisonSet(null as never)).toThrow(RangeError);
    expect(() => pinnedEngineFor(null as never)).toThrow(RangeError);
    expect(() => pinnedEngineFor('x'.repeat(50) as never)).toThrow(RangeError);
    expect(isPinnedEngine({ name: '', version: '1.0.0', family: 'general' } as never)).toBe(false);
    expect(
      isValidPinnedSet([{ name: 'mediabunny', version: '1.48.0', family: 'general' }] as never),
    ).toBe(false);
  });
});
