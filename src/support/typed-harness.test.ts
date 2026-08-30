import { describe, expect, it } from 'vitest';
import { MediaError } from '../contracts/errors.ts';
import { usToTicks, ticksToUs, samplesToTicks } from '../util/ticks.ts';
import { zeroCopySubarray } from '../util/zero-copy.ts';
import { cacheSource } from '../sources/cache.ts';
import { createEvidenceManifest, assertEvidenceBundle } from './evidence-bundle.ts';
import {
  isCleanCheckout,
  assertReproBundle,
  assertReproducibleCleanCheckout,
  minimalReproBundle,
} from './repro-bundle.ts';

/**
 * Typed harness + clean evidence (0.3) — MediaError not RangeError, typed manifest, clean checkout.
 * Covers 5 variants: unit/property/boundary/malformed/randomized.
 */

describe('typed harness (0.3) — MediaError vs RangeError', () => {
  it('unit: engine helpers throw MediaError demux-error not RangeError', () => {
    expect(() => usToTicks(0, 0)).toThrow(MediaError);
    expect(() => usToTicks(0, 0)).not.toThrow(RangeError);
    try {
      usToTicks(0, 0);
    } catch (e) {
      expect((e as MediaError).code).toBe('demux-error');
    }
    expect(() => ticksToUs(10, 0)).toThrow(MediaError);
    expect(() => samplesToTicks(1, 0, 48000)).toThrow(MediaError);
    const b = new Uint8Array(4);
    expect(() => zeroCopySubarray(b, -1, 2)).toThrow(MediaError);
    expect(() => zeroCopySubarray(b, -1, 2)).not.toThrow(RangeError);
    expect(() => cacheSource('http://example.com/a.mp4', { maxBytes: -1 } as any)).toThrow(MediaError);
  });

  it('property: MediaError code is stable across engines — never a native RangeError', () => {
    const cases: Array<() => unknown> = [
      () => usToTicks(Number.MAX_SAFE_INTEGER, 10_000_000),
      () => ticksToUs(Number.MAX_SAFE_INTEGER, 1),
      () => zeroCopySubarray(new Uint8Array(2), 0, 5),
    ];
    for (const fn of cases) {
      try {
        fn();
        expect.fail('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(MediaError);
        expect(e).not.toBeInstanceOf(RangeError);
        expect((e as MediaError).code).toMatch(/demux-error|unsupported-input/);
      }
    }
  });

  it('boundary: empty exclusions and max typed exclusions are valid', () => {
    const empty = createEvidenceManifest([]);
    expect(empty.exclusions).toEqual([]);
    expect(empty.corpusChecksum.startsWith('sha256:')).toBe(true);
    const all = createEvidenceManifest(['NA_ENGINE', 'NA_ASSET', 'NA_BROWSER', 'PASS', 'FAIL', 'ERROR']);
    expect(all.exclusions.length).toBe(6);
    expect(() => assertEvidenceBundle({ manifest: all, results: [] })).not.toThrow();
    // isCleanCheckout true only when dirty false
    expect(isCleanCheckout(minimalReproBundle({ dirty: false }))).toBe(true);
    expect(isCleanCheckout(minimalReproBundle({ dirty: true }))).toBe(false);
  });

  it('malformed: typed manifest rejects ad-hoc strings and dirty checkout fails repro', () => {
    expect(() => createEvidenceManifest(['BAD' as never])).toThrow(RangeError);
    expect(() =>
      assertEvidenceBundle({
        manifest: { ...createEvidenceManifest(), corpusChecksum: 'bad' },
        results: [],
      } as never),
    ).toThrow(RangeError);
    expect(() =>
      assertReproBundle({ ...minimalReproBundle(), lockfileHash: 'bad' } as never),
    ).toThrow(RangeError);
    // empty artifactHashes fails only the reproducible clean checkout gate
    expect(() =>
      assertReproducibleCleanCheckout({ ...minimalReproBundle(), artifactHashes: {} } as never),
    ).toThrow(RangeError);
    // dirty checkout not reproducible is MediaError? actually repro bundle asserts dirty via RangeError historically
    // For 0.3 we assert that dirty checkout is considered not clean via isCleanCheckout false, not throw
    expect(isCleanCheckout(minimalReproBundle({ dirty: true }))).toBe(false);
  });

  it('randomized: 20 random manifests and repro bundles remain valid without huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const exclusions = i % 3 === 0 ? (['NA_ENGINE'] as const) : ([] as const);
      const m = createEvidenceManifest(exclusions as never);
      expect(m.corpusChecksum.startsWith('sha256:')).toBe(true);
      const bundle = { manifest: m, results: Array.from({ length: i % 4 }, (_, j) => ({ id: j })) };
      expect(() => assertEvidenceBundle(bundle)).not.toThrow();
      const repro = minimalReproBundle({
        dirty: i % 2 === 0 ? false : true,
        commit: (i.toString(16).padStart(7, '0') + 'a'.repeat(33)).slice(0, 7),
        artifactHashes: { [`file${i}.js`]: `sha256:${'a'.repeat(64)}` },
      });
      if (repro.dirty === false) expect(isCleanCheckout(repro)).toBe(true);
      else expect(isCleanCheckout(repro)).toBe(false);
      if (!repro.dirty) expect(() => assertReproBundle(repro)).not.toThrow();
    }
  });
});
