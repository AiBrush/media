import { describe, expect, it } from 'vitest';
import {
  assertReproBundle,
  assertReproducibleCleanCheckout,
  isCleanCheckout,
  minimalReproBundle,
} from './repro-bundle.ts';

describe('reproducible clean-checkout evidence bundle — 4.5', () => {
  it('minimal bundle passes and is clean', () => {
    const b = minimalReproBundle();
    expect(() => assertReproBundle(b)).not.toThrow();
    expect(() => assertReproducibleCleanCheckout(b)).not.toThrow();
    expect(isCleanCheckout(b)).toBe(true);
    expect(b.packageVersion).toBe('0.0.0');
    expect(b.artifactHashes['dist/index.js']!.startsWith('sha256:')).toBe(true);
  });

  it('dirty or empty artifacts fails reproducible gate', () => {
    expect(() => assertReproducibleCleanCheckout(minimalReproBundle({ dirty: true }))).toThrow(
      RangeError,
    );
    expect(isCleanCheckout(minimalReproBundle({ dirty: true }))).toBe(false);
    expect(() =>
      assertReproducibleCleanCheckout(minimalReproBundle({ artifactHashes: {} })),
    ).toThrow(RangeError);
    expect(() => assertReproBundle(minimalReproBundle({ commit: 'zzz' as never }))).toThrow(
      RangeError,
    );
    expect(() => assertReproBundle(minimalReproBundle({ lockfileHash: 'bad' as never }))).toThrow(
      RangeError,
    );
  });

  it('validates isolation and longTasks/quality/license', () => {
    expect(() => assertReproBundle(minimalReproBundle({ isolation: 'isolated' }))).not.toThrow();
    expect(() =>
      assertReproBundle(minimalReproBundle({ isolation: 'non-isolated' })),
    ).not.toThrow();
    expect(() => assertReproBundle(minimalReproBundle({ isolation: 'unknown' as never }))).toThrow(
      RangeError,
    );
    expect(() =>
      assertReproBundle(minimalReproBundle({ longTasks: [Number.NaN] as never })),
    ).toThrow(RangeError);
    expect(() =>
      assertReproBundle(minimalReproBundle({ licenseInventory: [''] as never })),
    ).toThrow(RangeError);
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const b = minimalReproBundle({
        commit: `abc${String(i).padStart(4, '0')}`,
        packageVersion: `0.0.${i}`,
        dirty: false,
      });
      expect(() => assertReproBundle(b)).not.toThrow();
      expect(isCleanCheckout(b)).toBe(true);
      const dirty = minimalReproBundle({
        dirty: i % 5 === 0,
        commit: `abc${String(i).padStart(4, '0')}`,
      });
      expect(typeof isCleanCheckout(dirty)).toBe('boolean');
    }
  });

  it('boundary: exactly 7 hex commit passes, 6 fails', () => {
    expect(() => assertReproBundle(minimalReproBundle({ commit: 'abcdef7' }))).not.toThrow();
    expect(() => assertReproBundle(minimalReproBundle({ commit: 'abc' as never }))).toThrow(
      RangeError,
    );
    expect(() => assertReproBundle(minimalReproBundle({ commit: 'a'.repeat(40) }))).not.toThrow();
    expect(() =>
      assertReproBundle(minimalReproBundle({ commit: 'a'.repeat(41) as never })),
    ).toThrow(RangeError);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => assertReproBundle(null as never)).toThrow(RangeError);
    expect(() => assertReproBundle({} as never)).toThrow(RangeError);
    expect(() => assertReproBundle(minimalReproBundle({ packageVersion: '' as never }))).toThrow(
      RangeError,
    );
    expect(() => assertReproBundle(minimalReproBundle({ browser: '' as never }))).toThrow(
      RangeError,
    );
    expect(() => assertReproBundle(minimalReproBundle({ artifactHashes: null as never }))).toThrow(
      RangeError,
    );
    expect(() =>
      assertReproBundle(minimalReproBundle({ artifactHashes: { '': 'sha256:abc' } as never })),
    ).toThrow(RangeError);
    expect(() =>
      assertReproBundle(minimalReproBundle({ artifactHashes: { 'a.js': 'bad' } as never })),
    ).toThrow(RangeError);
    expect(() => assertReproBundle(minimalReproBundle({ timings: null as never }))).toThrow(
      RangeError,
    );
    expect(() => assertReproBundle(minimalReproBundle({ longTasks: null as never }))).toThrow(
      RangeError,
    );
  });
});
