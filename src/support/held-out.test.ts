import { describe, expect, it } from 'vitest';
import {
  FIXTURE_PATTERNS,
  HELD_OUT_FRACTION,
  assertHeldOutCorpus,
  fixtureLint,
  heldOutSplit,
} from './held-out.ts';

describe('held-out corpus + fixture-recognition lint (REQUIREMENTS §10 — 0.9)', () => {
  it('held-out split is at least 20% and at least 1', () => {
    const corpus = Array.from({ length: 10 }, (_, i) => `scenario-${i}`);
    const { heldOut, training } = heldOutSplit(corpus);
    expect(heldOut.length).toBeGreaterThanOrEqual(Math.ceil(10 * HELD_OUT_FRACTION));
    expect(heldOut.length).toBeGreaterThanOrEqual(1);
    expect(heldOut.length + training.length).toBe(10);
    expect(new Set([...heldOut, ...training]).size).toBe(10);
  });

  it('tiny corpus still yields 1 held-out', () => {
    const { heldOut, training } = heldOutSplit(['a']);
    expect(heldOut.length).toBe(1);
    expect(training.length).toBe(0);
    const { heldOut: h2 } = heldOutSplit(['a', 'b']);
    expect(h2.length).toBe(1);
  });

  it('fixture lint detects fixture-name branching, clean source passes', () => {
    expect(fixtureLint('const x = fixtureName')).toContain(FIXTURE_PATTERNS[0]!.source);
    expect(fixtureLint('if (hash === fixtureHash)')).toContain(FIXTURE_PATTERNS[1]!.source);
    expect(fixtureLint('const clean = 42;')).toEqual([]);
    expect(fixtureLint('bear-4k-hevc.mp4')).toContain(FIXTURE_PATTERNS[3]!.source);
  });

  it('assertHeldOutCorpus validates size and 20% gate', () => {
    const corpus = ['a', 'b', 'c', 'd', 'e'];
    const split = heldOutSplit(corpus);
    expect(() => assertHeldOutCorpus(corpus, split)).not.toThrow();
    expect(() =>
      assertHeldOutCorpus(corpus, { heldOut: [], training: [...corpus] } as never),
    ).toThrow(/20%/);
    expect(() =>
      assertHeldOutCorpus(corpus, { heldOut: ['a'], training: ['b', 'c', 'd'] } as never),
    ).toThrow(/!= corpus/);
  });

  it('20× randomized splits remain deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const n = 5 + (i % 10);
      const corpus = Array.from({ length: n }, (_, j) => `s-${i}-${j}`);
      const a = heldOutSplit(corpus);
      const b = heldOutSplit([...corpus].reverse());
      expect(a.heldOut.length).toBe(b.heldOut.length);
      expect(fixtureLint(`clean-${i}`)).toEqual([]);
    }
  });

  it('boundary: empty corpus and empty source', () => {
    expect(heldOutSplit([])).toEqual({ heldOut: [], training: [] });
    expect(fixtureLint('')).toEqual([]);
    expect(() => assertHeldOutCorpus([], { heldOut: [], training: [] } as never)).not.toThrow();
  });

  it('malformed inputs throw typed RangeError, never huge-alloc', () => {
    expect(() => fixtureLint(null as never)).toThrow(RangeError);
    expect(() => assertHeldOutCorpus(['a'] as never, null as never)).toThrow();
    expect(() => heldOutSplit(null as never)).toThrow();
  });
});
