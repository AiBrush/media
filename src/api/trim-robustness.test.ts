/**
 * Trim range-validation robustness (BUILD_INSTRUCTIONS §4/§7, ADR-021).
 *
 * A malformed trim range must REJECT with a typed {@link InputError} before any cut — never fabricate
 * output. This mirrors the 558-feature acceptance harness's `trim/robust_*` scenarios, whose
 * `graceful-failure` oracle PASSes only when the op throws/rejects (no output) on a degenerate range:
 * negative start, inverted range, zero-length range, start past EOF, end far past EOF.
 *
 * UNITS: the public `trim` API takes SECONDS (`opts.start`/`opts.end`). The harness ranges are in
 * microseconds and its adapter divides by 1e6 before calling the engine, so each `startUs/endUs` below
 * maps to `startUs/1e6` seconds here. Subject media are REAL corpus MP4s (never synthetic); ranges are
 * derived from each file's probed duration so the test tracks the real corpus, not magic constants.
 */

import { describe, expect, it } from 'vitest';
import { createMedia } from './create-media.ts';
import { InputError } from '../contracts/errors.ts';
import { fixtureSource } from '../test-support/corpus.ts';
import { assertTrimRange } from './engine.ts';

/** Real, stream-copyable MP4s (h264; ≥3 distinct files, varied duration/tracks). */
const MP4_FIXTURES = ['movie_5.mp4', 'test.mp4', 'h264.mp4'] as const;

const media = () => createMedia();

async function durationOf(id: string): Promise<number> {
  const info = await media().probe(await fixtureSource(id));
  expect(info.durationSec).toBeGreaterThan(0); // all corpus MP4s are timed
  return info.durationSec;
}

async function trimBytes(id: string, start: number, end: number): Promise<Uint8Array> {
  const out = await media().trim(await fixtureSource(id), { start, end, mode: 'keyframe' });
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

describe('trim range validation (real corpus MP4s)', () => {
  it('a valid in-range trim still succeeds and returns non-empty bytes', async () => {
    for (const id of MP4_FIXTURES) {
      const dur = await durationOf(id);
      // A well-formed sub-range strictly inside [0, dur): first ~60% of the clip from t=0.
      const out = await trimBytes(id, 0, dur * 0.6);
      expect(out.byteLength).toBeGreaterThan(0);
    }
  });

  it('rejects a negative start with a typed InputError (robust_negative_start)', async () => {
    for (const id of MP4_FIXTURES) {
      // harness: startUs=-2e6, endUs=4e6 → -2s..4s
      await expect(trimBytes(id, -2, 4)).rejects.toBeInstanceOf(InputError);
    }
  });

  it('rejects an inverted range with a typed InputError (robust_inverted_range)', async () => {
    for (const id of MP4_FIXTURES) {
      const dur = await durationOf(id);
      // end < start, both inside the media (harness: 8s..2s; here scaled to the fixture).
      await expect(trimBytes(id, dur * 0.6, dur * 0.2)).rejects.toBeInstanceOf(InputError);
    }
  });

  it('rejects a zero-length range with a typed InputError (robust_zero_length_range)', async () => {
    for (const id of MP4_FIXTURES) {
      const dur = await durationOf(id);
      const t = dur * 0.5; // end == start (harness: 5s..5s)
      await expect(trimBytes(id, t, t)).rejects.toBeInstanceOf(InputError);
    }
  });

  it('rejects a start at/past EOF with a typed InputError (robust_start_past_eof)', async () => {
    for (const id of MP4_FIXTURES) {
      const dur = await durationOf(id);
      // start ≥ duration (harness: 40s..45s on a 30s file). end stays above start.
      await expect(trimBytes(id, dur + 10, dur + 15)).rejects.toBeInstanceOf(InputError);
    }
  });

  it('rejects an end far past EOF with a typed InputError (robust_end_far_past_eof)', async () => {
    for (const id of MP4_FIXTURES) {
      const dur = await durationOf(id);
      // valid start, end wildly past EOF (harness: 50s..~2.7h on a 30s file). Here start is in-range so
      // the past-EOF *end* branch (not the start branch) is what rejects.
      await expect(trimBytes(id, dur * 0.1, dur + 9999)).rejects.toBeInstanceOf(InputError);
    }
  });

  it('rejects a non-finite range with a typed InputError', async () => {
    for (const id of MP4_FIXTURES) {
      await expect(trimBytes(id, Number.NaN, 4)).rejects.toBeInstanceOf(InputError);
    }
  });
});

// Direct guard coverage: a pure numeric predicate, exercised across every branch — including the
// unknown-duration (durationSec ≤ 0) path that always-timed real corpus media cannot reach through the
// public op. Real-media behavior is covered by the suite above; this pins the boundary algebra.
describe('assertTrimRange (guard branches)', () => {
  const DUR = 30; // a known media duration, in seconds

  it('accepts well-formed in-range ranges (including the boundaries)', () => {
    expect(() => assertTrimRange(2, 8, DUR)).not.toThrow();
    expect(() => assertTrimRange(0, 5, DUR)).not.toThrow(); // start == 0 is valid
    expect(() => assertTrimRange(27, DUR, DUR)).not.toThrow(); // end == duration is valid (to-EOF)
    expect(() => assertTrimRange(27, DUR + 1, DUR)).not.toThrow(); // within the EOF slack band
  });

  it('rejects non-finite, negative, inverted, and zero-length ranges', () => {
    expect(() => assertTrimRange(Number.NaN, 8, DUR)).toThrow(InputError);
    expect(() => assertTrimRange(2, Number.POSITIVE_INFINITY, DUR)).toThrow(InputError);
    expect(() => assertTrimRange(-2, 4, DUR)).toThrow(InputError);
    expect(() => assertTrimRange(8, 2, DUR)).toThrow(InputError); // inverted
    expect(() => assertTrimRange(5, 5, DUR)).toThrow(InputError); // zero-length
  });

  it('rejects start-past-EOF and end-far-past-EOF when the duration is known', () => {
    expect(() => assertTrimRange(40, 45, DUR)).toThrow(InputError); // start ≥ duration
    expect(() => assertTrimRange(DUR, DUR + 1, DUR)).toThrow(InputError); // start == duration
    expect(() => assertTrimRange(3, DUR + 9999, DUR)).toThrow(InputError); // end far past EOF
    expect(() => assertTrimRange(3, DUR + 2, DUR)).toThrow(InputError); // just beyond the slack band
  });

  it('skips duration-relative bounds when the duration is unknown (≤ 0)', () => {
    // Domain rules still apply, but past-EOF rules are suppressed (no duration to bound against).
    expect(() => assertTrimRange(40, 45, 0)).not.toThrow(); // would be past-EOF if dur were known
    expect(() => assertTrimRange(0, 9999, 0)).not.toThrow();
    expect(() => assertTrimRange(-1, 4, 0)).toThrow(InputError); // negative still rejected
    expect(() => assertTrimRange(5, 5, 0)).toThrow(InputError); // zero-length still rejected
  });
});
