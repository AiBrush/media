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
import { CapabilityError, InputError } from '../contracts/errors.ts';
import {
  type FrameTiming,
  type TimedClosableFrame,
  planCfrFrameRetiming,
  planVideoBitDepthConversion,
  retimeTimedFrameStream,
  videoColorMuxIntent,
  videoFilterRouteCost,
  videoFilterSpecs,
  videoTargetPixelBoundaryBitDepth,
} from './video-stream-plan.ts';

interface StubFrame extends TimedClosableFrame {
  readonly timestamp: number;
  duration?: number;
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
    if (value.duration === undefined) throw new Error('retimed frame omitted its duration');
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

describe('video route-cost saturation', () => {
  it('saturates finite work products and rejects overflowing pixel areas as unknown', () => {
    expect(
      videoFilterRouteCost({}, { width: 1e154, height: 1e154, fps: 240, durationSec: 1e308 }),
    ).toEqual({
      inputPixels: 1e308,
      outputPixels: 1e308,
      videoFrames: Number.MAX_SAFE_INTEGER,
      videoPixelWork: Number.MAX_VALUE,
      mediaSeconds: 1e308,
    });
    expect(videoFilterRouteCost({}, { width: Number.MAX_VALUE, height: 2 })).toEqual({});
  });
});

describe('video colour-transform compatibility', () => {
  const combinedTarget = {
    colorspace: { to: 'bt2020' },
    tonemap: { to: 'sdr' as const },
  };

  it('rejects a combined colorspace and tonemap target before source geometry is touched', () => {
    const untouchedSource = new Proxy(
      { width: undefined, height: undefined },
      {
        get(): never {
          throw new Error('source geometry was touched');
        },
      },
    );
    let error: unknown;
    try {
      videoFilterSpecs(combinedTarget, untouchedSource);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({
      code: 'capability-miss',
      detail: {
        op: {
          kind: 'route',
          id: 'convert',
          facts: { colorspace: 'bt2020', tonemap: 'sdr' },
        },
        tried: [],
      },
    });
  });

  it('rejects the same unsupported combination while planning mux colour metadata', () => {
    expect(() => videoColorMuxIntent(combinedTarget)).toThrow(CapabilityError);
  });
});

function trackedFrame(timestamp: number, duration?: number): StubFrame {
  return {
    timestamp,
    ...(duration === undefined ? {} : { duration }),
    closed: 0,
    close(): void {
      this.closed++;
    },
  };
}

function trackedSource(frames: readonly StubFrame[]): ReadableStream<StubFrame> {
  let cursor = 0;
  return new ReadableStream<StubFrame>({
    pull(controller): void {
      const frame = frames[cursor++];
      if (frame === undefined) controller.close();
      else controller.enqueue(frame);
    },
  });
}

async function drainTrackedRetiming(
  inputs: readonly StubFrame[],
  fps: number,
  durationUs?: number,
): Promise<readonly StubFrame[]> {
  const output = retimeTimedFrameStream(trackedSource(inputs), {
    fps,
    ...(durationUs === undefined ? {} : { durationUs }),
    restamp: (_frame, timing): StubFrame => trackedFrame(timing.timestamp, timing.duration),
  });
  const reader = output.getReader();
  const result: StubFrame[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return result;
    result.push(next.value);
  }
}

describe('retimeTimedFrameStream — inferred tails and failure ownership', () => {
  it('infers a missing final duration from frame metadata, a VFR delta, then the CFR period', async () => {
    const explicit = [trackedFrame(0, 250_000)];
    const explicitOut = await drainTrackedRetiming(explicit, 4);
    expect(explicitOut.map(({ timestamp, duration }) => ({ timestamp, duration }))).toEqual([
      { timestamp: 0, duration: 250_000 },
    ]);

    const vfr = [trackedFrame(0), trackedFrame(250_000)];
    const vfrOut = await drainTrackedRetiming(vfr, 4);
    expect(vfrOut.map(({ timestamp, duration }) => ({ timestamp, duration }))).toEqual([
      { timestamp: 0, duration: 250_000 },
      { timestamp: 250_000, duration: 250_000 },
    ]);

    const cfrFallback = [trackedFrame(0)];
    const cfrOut = await drainTrackedRetiming(cfrFallback, 4);
    expect(cfrOut.map(({ timestamp, duration }) => ({ timestamp, duration }))).toEqual([
      { timestamp: 0, duration: 250_000 },
    ]);

    for (const frame of [...explicit, ...vfr, ...cfrFallback]) expect(frame.closed).toBe(1);
    for (const frame of [...explicitOut, ...vfrOut, ...cfrOut]) frame.close();
  });

  it('clamps an explicit end inside a long VFR interval and closes held frames on cancellation', async () => {
    const inputs = [trackedFrame(0), trackedFrame(10_000_000)];
    const output = retimeTimedFrameStream(trackedSource(inputs), {
      fps: 1,
      durationUs: 1_500_000,
      restamp: (_frame, timing): StubFrame => trackedFrame(timing.timestamp, timing.duration),
    });
    const reader = output.getReader();
    const first = await reader.read();
    const second = await reader.read();
    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect([first.value?.duration, second.value?.duration]).toEqual([1_000_000, 500_000]);
    first.value?.close();
    second.value?.close();
    await reader.cancel('declared end reached');
    expect(inputs.map((frame) => frame.closed)).toEqual([1, 1]);
  });

  it('closes both frames exactly once when presentation timestamps regress', async () => {
    const inputs = [trackedFrame(1), trackedFrame(0)];
    const reader = retimeTimedFrameStream(trackedSource(inputs), {
      fps: 30,
      restamp: (_frame, timing): StubFrame => trackedFrame(timing.timestamp, timing.duration),
    }).getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(InputError);
    expect(inputs.map((frame) => frame.closed)).toEqual([1, 1]);
  });

  it('closes the current and look-ahead frames exactly once when restamping fails', async () => {
    const inputs = [trackedFrame(0), trackedFrame(1_000)];
    const reader = retimeTimedFrameStream(trackedSource(inputs), {
      fps: 1_000,
      restamp: () => {
        throw new Error('restamp failed');
      },
    }).getReader();
    await expect(reader.read()).rejects.toThrow('restamp failed');
    expect(inputs.map((frame) => frame.closed)).toEqual([1, 1]);
  });

  it('closes a final frame when finite timestamp arithmetic cannot represent a positive tail', async () => {
    const input = trackedFrame(Number.MAX_VALUE, 1);
    const reader = retimeTimedFrameStream(trackedSource([input]), {
      fps: 30,
      restamp: (_frame, timing): StubFrame => trackedFrame(timing.timestamp, timing.duration),
    }).getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(InputError);
    expect(input.closed).toBe(1);
  });
});

describe('planVideoBitDepthConversion — partial codec metadata', () => {
  it('recognizes HEVC Main/Main10 and does not invent depth for truncated VP9 fields', () => {
    expect(
      planVideoBitDepthConversion({
        sourceCodec: 'hvc1.1.6.L93.B0',
        targetCodec: 'hvc1.2.4.L120.B0',
      }),
    ).toEqual({
      kind: 'encoder-widen',
      sourceBitDepth: 8,
      targetBitDepth: 10,
      requiresPixelPath: true,
    });
    expect(
      planVideoBitDepthConversion({ sourceCodec: 'vp09.00.10', targetCodec: 'hvc1.3.4.L120.B0' }),
    ).toEqual({
      kind: 'none',
      sourceBitDepth: undefined,
      targetBitDepth: undefined,
      requiresPixelPath: false,
    });
  });

  it('classifies 8/10-bit exact widening to 12-bit through an explicit planar copy', () => {
    expect(planVideoBitDepthConversion({ sourceBitDepth: 8, targetBitDepth: 12 })).toEqual({
      kind: 'encoder-widen',
      sourceBitDepth: 8,
      targetBitDepth: 12,
      requiresPixelPath: true,
    });
    expect(planVideoBitDepthConversion({ sourceBitDepth: 10, targetBitDepth: 12 })).toEqual({
      kind: 'encoder-widen',
      sourceBitDepth: 10,
      targetBitDepth: 12,
      requiresPixelPath: true,
    });
  });

  it('uses a bounded 8-bit pixel path for 10/12-bit downconversion', () => {
    expect(planVideoBitDepthConversion({ sourceBitDepth: 10, targetBitDepth: 8 })).toEqual({
      kind: 'downconvert',
      sourceBitDepth: 10,
      targetBitDepth: 8,
      requiresPixelPath: true,
    });
    expect(planVideoBitDepthConversion({ sourceBitDepth: 12, targetBitDepth: 8 })).toEqual({
      kind: 'downconvert',
      sourceBitDepth: 12,
      targetBitDepth: 8,
      requiresPixelPath: true,
    });
    expect(
      planVideoBitDepthConversion({
        sourceBitDepth: 12,
        targetBitDepth: 8,
        pixelPathBitDepth: 8,
      }),
    ).toEqual({
      kind: 'downconvert',
      sourceBitDepth: 12,
      targetBitDepth: 8,
      requiresPixelPath: false,
    });
  });

  it('rejects 12→10 and high-depth preservation across an existing RGBA8 filter boundary', () => {
    expect(() => planVideoBitDepthConversion({ sourceBitDepth: 12, targetBitDepth: 10 })).toThrow(
      CapabilityError,
    );
    expect(() =>
      planVideoBitDepthConversion({
        sourceBitDepth: 10,
        targetBitDepth: 10,
        pixelPathBitDepth: 8,
      }),
    ).toThrow(CapabilityError);
    expect(() =>
      planVideoBitDepthConversion({
        sourceBitDepth: 10,
        targetBitDepth: 12,
        pixelPathBitDepth: 8,
      }),
    ).toThrow(CapabilityError);
    expect(() => planVideoBitDepthConversion({ targetBitDepth: 12, pixelPathBitDepth: 8 })).toThrow(
      CapabilityError,
    );
  });

  it('allows an 8-bit source to filter then explicitly widen and validates pixel-boundary depth', () => {
    expect(
      planVideoBitDepthConversion({
        sourceBitDepth: 8,
        targetBitDepth: 12,
        pixelPathBitDepth: 8,
      }),
    ).toEqual({
      kind: 'encoder-widen',
      sourceBitDepth: 8,
      targetBitDepth: 12,
      requiresPixelPath: true,
    });
    expect(() =>
      planVideoBitDepthConversion({
        sourceBitDepth: 8,
        targetBitDepth: 10,
        pixelPathBitDepth: 9,
      }),
    ).toThrow(InputError);
  });
});

describe('videoTargetPixelBoundaryBitDepth', () => {
  const source = { width: 1920, height: 1080, fps: 60 };

  it('classifies every current pixel filter as an RGBA8 boundary', () => {
    const targets = [
      { crop: { x: 0, y: 0, width: 1280, height: 720 } },
      { width: 1280, height: 720 },
      { pad: { width: 2560, height: 1440 } },
      { rotate: 90 as const },
      { flip: 'h' as const },
      { colorspace: { to: 'bt2020' } },
      { tonemap: { to: 'sdr' as const } },
    ];
    for (const target of targets) {
      expect(videoTargetPixelBoundaryBitDepth(target, source)).toBe(8);
    }
  });

  it('does not mistake fps-only retiming or an identity resize for a pixel conversion', () => {
    expect(videoTargetPixelBoundaryBitDepth({ fps: 24 }, source)).toBeUndefined();
    expect(
      videoTargetPixelBoundaryBitDepth({ width: 1920, height: 1080, fps: 24 }, source),
    ).toBeUndefined();
  });

  it('classifies VPx alpha merge and split as RGBA8 boundaries', () => {
    expect(videoTargetPixelBoundaryBitDepth({ alpha: 'keep' }, source)).toBe(8);
    expect(videoTargetPixelBoundaryBitDepth({}, source, true)).toBe(8);
  });
});
