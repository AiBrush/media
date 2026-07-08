/**
 * CFR retimer duration discipline (Session 10). At low target fps a non-integer-second source would, with
 * uniform `1/fps` frame durations, over-run its true length (a 22.5 s source at 1 fps → 23 × 1 s = 23 s),
 * failing the `probe(out).dur ≈ probe(x).dur` invariant (`transcode/extreme_fps_1`). The stream's final
 * frame is clamped to the source end so the materialized duration matches; steady-state cadence and
 * high-fps cases (negligible remainder) are unchanged.
 */

import { describe, expect, it } from 'vitest';
import { type TimedClosableFrame, retimeTimedFrameStream } from './video-stream-plan.ts';

interface StubFrame extends TimedClosableFrame {
  readonly timestamp: number;
  duration: number;
  closed: number;
  close(): void;
}

function sourceStream(count: number, spanUs: number): ReadableStream<StubFrame> {
  const frames: StubFrame[] = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      timestamp: Math.round((i * spanUs) / count),
      duration: 0,
      closed: 0,
      close(): void {
        this.closed++;
      },
    });
  }
  let i = 0;
  return new ReadableStream<StubFrame>({
    pull(controller): void {
      const next = frames[i];
      i++;
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
  });
}

async function retimedDurations(
  count: number,
  spanUs: number,
  fps: number,
  durationUs: number,
): Promise<number[]> {
  const out = retimeTimedFrameStream(sourceStream(count, spanUs), {
    fps,
    durationUs,
    restamp: (_f, t): StubFrame => ({
      timestamp: t.timestamp,
      duration: t.duration,
      closed: 0,
      close(): void {},
    }),
  });
  const reader = out.getReader();
  const durations: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    durations.push(value.duration);
  }
  return durations;
}

describe('retimeTimedFrameStream — final-frame duration clamp', () => {
  it('clamps the last frame so a 22.5 s source at 1 fps materializes to exactly 22.5 s', async () => {
    const durations = await retimedDurations(30, 22_500_000, 1, 22_500_000);
    expect(durations).toHaveLength(23);
    // Every frame but the last holds a full second; the tail carries the 0.5 s remainder.
    for (const d of durations.slice(0, -1)) expect(d).toBe(1_000_000);
    expect(durations.at(-1)).toBe(500_000);
    const total = durations.reduce((sum, d) => sum + d, 0);
    expect(total).toBe(22_500_000);
  });

  it('leaves an integer-second source at uniform cadence (no spurious clamp)', async () => {
    const durations = await retimedDurations(48, 24_000_000, 2, 24_000_000);
    // 24 s at 2 fps = 48 frames of exactly 0.5 s; the final frame lands on the end, so no remainder.
    expect(durations).toHaveLength(48);
    for (const d of durations) expect(d).toBe(500_000);
    expect(durations.reduce((sum, d) => sum + d, 0)).toBe(24_000_000);
  });

  it('keeps a high-fps clamp negligible (240 fps tail is at most one frame interval)', async () => {
    const durations = await retimedDurations(300, 5_000_000, 240, 5_000_000);
    const nominal = Math.round(1_000_000 / 240);
    // Steady-state frames sit on the rounded CFR grid (±1 µs); the clamp touches only the tail, which is
    // never longer than one nominal interval — and the total still lands exactly on the source length.
    for (const d of durations.slice(0, -1)) expect(Math.abs(d - nominal)).toBeLessThanOrEqual(1);
    expect(durations.at(-1)).toBeLessThanOrEqual(nominal + 1);
    expect(durations.reduce((sum, d) => sum + d, 0)).toBe(5_000_000);
  });
});
