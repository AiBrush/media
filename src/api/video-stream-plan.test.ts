/**
 * CFR retimer duration discipline (Session 10). At low target fps a non-integer-second source would, with
 * uniform `1/fps` frame durations, over-run its true length (a 22.5 s source at 1 fps → 23 × 1 s = 23 s),
 * failing the `probe(out).dur ≈ probe(x).dur` invariant (`transcode/extreme_fps_1`). Both the streaming
 * retimer and the non-streaming planner clamp the final grid frame to the declared source end so the
 * materialized duration matches. The clamp must be robust to source frame granularity: at 30 fps → 1 fps
 * the true final source frame is ~1/30 s and the last 1 fps grid point (t = 22 s) is emitted inside an
 * *interior* source interval, so a clamp tied only to the final source frame silently misses it — the
 * fine-grained (675-frame) cases below reproduce exactly that. Steady-state cadence and high-fps cases
 * (negligible remainder) are unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  type FrameTiming,
  type TimedClosableFrame,
  planCfrFrameRetiming,
  retimeTimedFrameStream,
} from './video-stream-plan.ts';

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

  it('clamps the tail even when source frames are finer than the CFR period (transcode/extreme_fps_1)', async () => {
    // The real regression: transcode/extreme_fps_1/02.mp4 is 675 frames @ 30 fps, container 22.506667 s. Each
    // source frame is ~1/30 s — far shorter than the 1 s target period — so the last 1 fps grid point (t = 22
    // s) is emitted inside an *interior* source interval, never the ~1/30 s final one. A clamp tied to the
    // final source frame therefore never fires and the output over-runs to 23 s; the source-duration clamp
    // catches it. This case fails against a final-source-frame-only clamp (which the 30-frame case masks).
    const containerUs = 22_506_667;
    const durations = await retimedDurations(675, 22_500_000, 1, containerUs);
    expect(durations).toHaveLength(23);
    for (const d of durations.slice(0, -1)) expect(d).toBe(1_000_000);
    expect(durations.at(-1)).toBe(containerUs - 22_000_000); // 506_667 µs tail, not a full 1 s (23 s over-run)
    expect(durations.reduce((sum, d) => sum + d, 0)).toBe(containerUs);
  });
});

/** Build `count` constant-frame-rate presentation timings at `fps` (matches a WebCodecs CFR decode). */
function cfrFrames(count: number, fps: number): FrameTiming[] {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = Math.round((index * 1_000_000) / fps);
    const next = Math.round(((index + 1) * 1_000_000) / fps);
    return { timestamp, duration: next - timestamp };
  });
}

describe('planCfrFrameRetiming — final-frame duration clamp', () => {
  it('clamps its last frame so Σ(durations) equals the declared source duration (transcode/extreme_fps_1)', () => {
    // Same 675-frame @ 30 fps → 1 fps case as the stream, driving the non-streaming planner: without the
    // clamp the last of the 23 outputs takes a full 1 s and the plan sums to 23 s; with it the tail carries
    // the remainder and the plan sums to exactly the container duration.
    const containerUs = 22_506_667;
    const plan = planCfrFrameRetiming(cfrFrames(675, 30), { fps: 1, durationUs: containerUs });
    expect(plan.outputs).toHaveLength(23);
    expect(plan.endsAtUs).toBe(containerUs);
    const durations = plan.outputs.map((o) => o.duration);
    for (const d of durations.slice(0, -1)) expect(d).toBe(1_000_000);
    expect(durations.at(-1)).toBe(containerUs - 22_000_000); // 506_667 µs tail
    expect(durations.reduce((sum, d) => sum + d, 0)).toBe(containerUs);
  });

  it('leaves an on-grid source at uniform cadence (remainder is exactly one period)', () => {
    // 60 frames @ 30 fps (2.0 s) → 2 fps: the source end (2 s) lands on the grid, so the clamped last frame
    // equals a full 1/fps and Σ still matches — the clamp is a no-op for integer-second sources.
    const plan = planCfrFrameRetiming(cfrFrames(60, 30), { fps: 2, durationUs: 2_000_000 });
    expect(plan.outputs).toHaveLength(4);
    for (const o of plan.outputs) expect(o.duration).toBe(500_000);
    expect(plan.outputs.reduce((sum, o) => sum + o.duration, 0)).toBe(2_000_000);
  });
});
