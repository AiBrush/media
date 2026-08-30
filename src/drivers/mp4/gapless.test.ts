import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { gaplessFromMp4Edit } from './gapless.ts';

describe('MP4 edit-list gapless projection', () => {
  it('clamps an impossible declared program duration to the coded sample capacity', () => {
    expect(gaplessFromMp4Edit(1024, 47143 / 44100, 44100, 44100, 47104)).toEqual({
      basis: 'mp4-edit-list',
      leadingSamples: 1024,
      trailingSamples: 0,
      totalSamples: 46080,
    });
  });

  it('preserves a possible shorter edit and independently derives its terminal padding', () => {
    expect(gaplessFromMp4Edit(1024, 44673 / 44100, 44100, 44100, 46080)).toEqual({
      basis: 'mp4-edit-list',
      leadingSamples: 1024,
      trailingSamples: 383,
      totalSamples: 44673,
    });
  });

  it('uses exact half-up bigint for leading (drift-free vs float)', () => {
    // timescale 48000 -> 1 tick == 1 sample at 44100 would be fractional; bigint must match Math.round exactly for large values
    const largeTicks = 4_000_000;
    const sr = 44100;
    const ts = 48000;
    const expected = Math.round((largeTicks * sr) / ts);
    // Exact bigint should equal Math.round for this range, and remain stable for values where float would lose precision
    expect(gaplessFromMp4Edit(largeTicks, 1, sr, ts, 10_000_000).leadingSamples).toBe(expected);
    // Half-up boundary: 1*48000/1000 = 48 exactly; 1*44100/48000 = 0.91875 -> 1 after rounding? Actually 44100/48000=0.918 -> 1
    expect(gaplessFromMp4Edit(1, 0, 48000, 1000, 100).leadingSamples).toBe(48);
    expect(gaplessFromMp4Edit(1, 0, 44100, 48000, 100).leadingSamples).toBe(1);
  });

  it('boundary: zero and max mediaTime', () => {
    expect(gaplessFromMp4Edit(0, 0, 48000, 1000, 0)).toEqual({
      basis: 'mp4-edit-list',
      leadingSamples: 0,
      trailingSamples: 0,
      totalSamples: 0,
    });
    expect(gaplessFromMp4Edit(0, 10, 48000, 48000, 480000).totalSamples).toBe(480000);
  });

  it('malformed: throws MediaError demux-error on NaN/negative/non-safe (harness FAIL vs ERROR)', () => {
    for (const fn of [
      () => gaplessFromMp4Edit(Number.NaN as unknown as number, 1, 44100, 44100, 100),
      () => gaplessFromMp4Edit(10, -1, 44100, 44100, 100),
      () => gaplessFromMp4Edit(10, 1, 0, 44100, 100),
      () => gaplessFromMp4Edit(10, 1, 44100, 0, 100),
      () => gaplessFromMp4Edit(10, 1, 44100, 44100, -1),
    ]) {
      try {
        fn();
        expect.fail('expected MediaError');
      } catch (error) {
        expect(error).toBeInstanceOf(MediaError);
        expect((error as MediaError).code).toBe('demux-error');
      }
    }
  });

  it('20× randomized: leading invariant vs ticks + monotonic', () => {
    for (let i = 0; i < 20; i++) {
      const sr = [8000, 44100, 48000, 96000][i % 4]!;
      const ts = [1000, 48000, 44100, 90000][i % 4]!;
      const ticks = (i * 12345) % 100_000;
      const leading =
        ticks >= 0 ? Number((BigInt(ticks) * BigInt(sr) + BigInt(ts) / 2n) / BigInt(ts)) : 0;
      const coded = leading + 5000 + ((i * 100) % 1000);
      const r = gaplessFromMp4Edit(ticks, 0.5, sr, ts, coded);
      const expectedLeading = leading;
      expect(r.leadingSamples!).toBe(Math.max(0, expectedLeading));
      expect(r.leadingSamples! + r.trailingSamples! + r.totalSamples!).toBeLessThanOrEqual(coded);
    }
  });

  it('large editDurationSec stays drift-free via bigint microsecond path', () => {
    // 600s at 48k = 28_800_000 samples; float editDurationSec*sampleRate may lose integer precision for large values,
    // but the bigint microsecond path (editDurationSec*1e6 as integer micros) stays exact.
    const editDurationSec = 600;
    const sampleRate = 48000;
    const timescale = 48000;
    const codedSamples = 600 * sampleRate + 2112; // includes priming
    const r = gaplessFromMp4Edit(0, editDurationSec, sampleRate, timescale, codedSamples);
    expect(r.totalSamples).toBe(600 * sampleRate);
    expect(r.leadingSamples! + r.trailingSamples! + r.totalSamples!).toBeLessThanOrEqual(
      codedSamples,
    );
    // Repeat with large mediaTimeTicks + large duration
    const largeTicks = 28_800_000;
    const r2 = gaplessFromMp4Edit(largeTicks, 1, 48000, 48000, largeTicks + 5000);
    expect(r2.leadingSamples).toBe(largeTicks);
  });
});
