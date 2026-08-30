import { describe, expect, it } from 'vitest';
import {
  type SeekChunk,
  frameSatisfiesSeekMode,
  indexForSeekMode,
  indexOfExactSeekStart,
  indexOfKeyframeAfter,
  indexOfKeyframeBefore,
  indexOfNearestKeyframe,
} from './seek-modes.ts';

function c(type: SeekChunk['type'], ts: number): SeekChunk {
  return { type, timestamp: ts };
}

describe('seek modes — keyframe-before/after/nearest/exact (REQUIREMENTS §5.3 1.2.6)', () => {
  it('keyframe-before: last keyframe at/before target (B-frame PTS reorder preserved)', () => {
    // DTS order: I(0) P(3000) B(6000) but PTS: I0 P6000 B3000 — packets in DTS order carry PTS as timestamp
    const chunks = [c('key', 0), c('delta', 3000), c('key', 6000), c('delta', 7000)] as const;
    // For target 3500, last keyframe before is at 0, not 6000 (since 6000 >3500)
    expect(indexOfKeyframeBefore(chunks as unknown as SeekChunk[], 3500)).toBe(0);
    expect(indexOfKeyframeBefore(chunks as unknown as SeekChunk[], 6000)).toBe(2);
    expect(indexOfKeyframeBefore(chunks as unknown as SeekChunk[], 0)).toBe(0);
    expect(indexOfKeyframeBefore(chunks as unknown as SeekChunk[], 10)).toBe(0);
    // B-frame scenario where PTS reorder: ensure we use PTS, not DTS index
    const bframes: SeekChunk[] = [c('key', 0), c('delta', 6000), c('delta', 3000)]; // DTS order but PTS 0,6000,3000
    // last keyframe before 3500 is still key at 0
    expect(indexOfKeyframeBefore(bframes, 3500)).toBe(0);
  });

  it('keyframe-after: first keyframe at/after target, VFR varying deltas', () => {
    const chunks: SeekChunk[] = [
      c('key', 0),
      c('delta', 1000),
      c('delta', 3000),
      c('key', 8000),
      c('delta', 9000),
    ];
    expect(indexOfKeyframeAfter(chunks, 0)).toBe(0);
    expect(indexOfKeyframeAfter(chunks, 1)).toBe(3);
    expect(indexOfKeyframeAfter(chunks, 8000)).toBe(3);
    expect(indexOfKeyframeAfter(chunks, 9000)).toBeUndefined();
    expect(indexOfKeyframeAfter([], 100)).toBeUndefined();
  });

  it('nearest: closest keyframe, tie goes to before', () => {
    const chunks: SeekChunk[] = [c('key', 0), c('delta', 10), c('key', 100), c('delta', 110)];
    expect(indexOfNearestKeyframe(chunks, 0)).toBe(0);
    expect(indexOfNearestKeyframe(chunks, 49)).toBe(0); // 49-0=49 < 100-49=51
    expect(indexOfNearestKeyframe(chunks, 50)).toBe(0); // tie 50 vs 50 -> before
    expect(indexOfNearestKeyframe(chunks, 51)).toBe(2);
    expect(indexOfNearestKeyframe(chunks, 200)).toBe(2);
    expect(indexOfNearestKeyframe([], 10)).toBeUndefined();
    // single keyframe
    expect(indexOfNearestKeyframe([c('key', 500)], 0)).toBe(0);
    expect(indexOfNearestKeyframe([c('key', 500)], 1000)).toBe(0);
  });

  it('exact: dependency decode via last keyframe before target, open-GOP fallback', () => {
    const chunks: SeekChunk[] = [c('key', 0), c('delta', 10), c('key', 20), c('delta', 30)];
    expect(indexOfExactSeekStart(chunks, 5)).toBe(0);
    expect(indexOfExactSeekStart(chunks, 25)).toBe(2);
    expect(indexOfExactSeekStart(chunks, 100)).toBe(2);
    expect(indexOfExactSeekStart([], 10)).toBe(0);
    // open-GOP: leading deltas before first keyframe
    const open: SeekChunk[] = [c('delta', 0), c('delta', 10), c('key', 20), c('delta', 30)];
    expect(indexOfExactSeekStart(open, 5)).toBe(2); // no keyframe before 5, fallback to first key at 20
    expect(indexOfExactSeekStart(open, 25)).toBe(2);
    // no keyframes at all
    const noKeys: SeekChunk[] = [c('delta', 0), c('delta', 10)];
    expect(indexOfExactSeekStart(noKeys, 5)).toBe(0);
  });

  it('indexForSeekMode dispatches all four modes', () => {
    const chunks: SeekChunk[] = [c('key', 0), c('delta', 10), c('key', 100)];
    expect(indexForSeekMode(chunks, 50, 'keyframe-before')).toBe(0);
    expect(indexForSeekMode(chunks, 50, 'keyframe-after')).toBe(2);
    expect(indexForSeekMode(chunks, 50, 'nearest')).toBe(0);
    expect(indexForSeekMode(chunks, 50, 'exact')).toBe(0);
    expect(() => indexForSeekMode(chunks, 50, 'unknown' as never)).toThrow();
  });

  it('malformed: NaN/negative/ non-finite target throws, non-finite chunk timestamp throws', () => {
    const chunks: SeekChunk[] = [c('key', 0)];
    expect(() => indexOfKeyframeBefore(chunks, Number.NaN)).toThrow();
    expect(() => indexOfKeyframeBefore(chunks, -1)).toThrow();
    expect(() =>
      indexOfKeyframeBefore(chunks, Number.POSITIVE_INFINITY as unknown as number),
    ).toThrow();
    const bad: SeekChunk[] = [c('key', Number.NaN)];
    expect(() => indexOfKeyframeBefore(bad, 10)).toThrow();
    expect(() => indexOfKeyframeAfter(bad, 10)).toThrow();
    expect(() => indexOfNearestKeyframe(bad, 10)).toThrow();
    expect(() => frameSatisfiesSeekMode({ timestamp: Number.NaN }, 10, 'exact')).toThrow();
  });

  it('frameSatisfiesSeekMode respects mode and keyframe type', () => {
    expect(frameSatisfiesSeekMode({ timestamp: 100, type: 'key' }, 100, 'keyframe-before')).toBe(
      true,
    );
    expect(frameSatisfiesSeekMode({ timestamp: 90, type: 'key' }, 100, 'keyframe-before')).toBe(
      true,
    );
    expect(frameSatisfiesSeekMode({ timestamp: 110, type: 'key' }, 100, 'keyframe-before')).toBe(
      false,
    );
    expect(frameSatisfiesSeekMode({ timestamp: 100, type: 'delta' }, 100, 'keyframe-before')).toBe(
      false,
    );
    expect(frameSatisfiesSeekMode({ timestamp: 100, type: 'key' }, 100, 'keyframe-after')).toBe(
      true,
    );
    expect(frameSatisfiesSeekMode({ timestamp: 110, type: 'key' }, 100, 'keyframe-after')).toBe(
      true,
    );
    expect(frameSatisfiesSeekMode({ timestamp: 90, type: 'key' }, 100, 'keyframe-after')).toBe(
      false,
    );
    expect(frameSatisfiesSeekMode({ timestamp: 100 }, 100, 'exact')).toBe(true);
    expect(frameSatisfiesSeekMode({ timestamp: 99 }, 100, 'exact')).toBe(false);
    expect(frameSatisfiesSeekMode({ timestamp: 100 }, 100, 'nearest')).toBe(true);
  });

  it('20× randomized invariants: monotonic DTS preserved, PTS check, nearest tie', () => {
    for (let seed = 0; seed < 20; seed++) {
      const n = 5 + (seed % 5);
      const chunks: SeekChunk[] = [];
      let ts = 0;
      for (let i = 0; i < n; i++) {
        const isKey = i === 0 || seed % 3 === 0 ? i % 2 === 0 : i % 3 === 0;
        const delta = 1000 + ((seed * 13 + i * 7) % 2000);
        ts += delta;
        // VFR: delta varies, plus occasional B-frame negative jitter on PTS vs DTS
        const pts = isKey ? ts : ts + ((seed + i) % 2 === 0 ? -200 : 0);
        chunks.push(
          c((pts as number) >= 0 ? (isKey ? 'key' : 'delta') : 'delta', Math.max(0, pts)),
        );
      }
      // ensure at least one keyframe
      if (!chunks.some((ch) => ch.type === 'key')) chunks[0] = c('key', chunks[0]!.timestamp);
      const target = (seed * 500) % (ts + 1);
      const before = indexOfKeyframeBefore(chunks, target);
      const after = indexOfKeyframeAfter(chunks, target);
      const nearest = indexOfNearestKeyframe(chunks, target);
      const exact = indexOfExactSeekStart(chunks, target);
      // invariants
      if (before !== undefined) expect(chunks[before]!.timestamp).toBeLessThanOrEqual(target);
      if (after !== undefined) expect(chunks[after]!.timestamp).toBeGreaterThanOrEqual(target);
      if (before !== undefined && after !== undefined) {
        const dB = target - chunks[before]!.timestamp;
        const dA = chunks[after]!.timestamp - target;
        if (dA < dB) expect(nearest).toBe(after);
        else expect(nearest).toBe(before);
      }
      expect(exact).toBeGreaterThanOrEqual(0);
      expect(exact).toBeLessThan(chunks.length);
      // keyframe-before must be <= exact when both exist (exact is at least before)
      if (before !== undefined) expect(exact).toBeGreaterThanOrEqual(before);
    }
  });

  it('nonzero start / edit-list: target in presentation time after edit offset still selects correct GOP', () => {
    // Simulate edit list that drops first 1024 ticks ~ 21333µs at 48kHz
    const editOffset = 21333;
    const chunks: SeekChunk[] = [
      c('key', editOffset),
      c('delta', editOffset + 1000),
      c('key', editOffset + 5000),
    ];
    // target 0 in presentation time corresponds to 21333 in coded time, but chunks already in presentation time
    expect(indexOfKeyframeBefore(chunks, 0)).toBeUndefined();
    expect(indexOfExactSeekStart(chunks, 0)).toBe(0); // fallback to first key
    expect(indexOfKeyframeBefore(chunks, editOffset)).toBe(0);
    expect(indexOfKeyframeAfter(chunks, editOffset)).toBe(0);
  });
});
