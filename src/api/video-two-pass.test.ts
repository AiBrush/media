import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  type CodecDriver,
  DRIVER_API_VERSION,
  type EncodedChunk,
  type RawFrame,
  type StageOptions,
  type TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { buildMuxSamples } from '../drivers/mp4/mux.ts';
import { fromBytes } from '../sources/source.ts';
import {
  type H264TwoPassRunnerContext,
  decodeH264ReplayVideo,
  implicitRateControlWarmupFrames,
  installH264TwoPassQuantizer,
  sourceGeometryOf,
  tagH264ReplayDecodeError,
} from './video-two-pass-runner.ts';
import {
  type H264FirstPassSample,
  H264_FIRST_PASS_QUANTIZER,
  H264_TWO_PASS_MAX_PICTURE_EVIDENCE,
  planH264TwoPass,
} from './video-two-pass.ts';

function sample(
  timestampUs: number,
  byteLength: number,
  durationUs = 40_000,
  keyFrame = false,
): H264FirstPassSample {
  return { timestampUs, durationUs, byteLength, keyFrame };
}

function muxPresentationSpanUs(samples: readonly H264FirstPassSample[]): number {
  const muxSamples = buildMuxSamples(
    samples.map((value) => ({
      timestampUs: value.timestampUs,
      durationUs: value.durationUs,
      key: value.keyFrame,
      data: new Uint8Array([0]),
    })),
    1_000_000,
  );
  let dtsUs = 0;
  let firstPtsUs = Number.POSITIVE_INFINITY;
  let endPtsUs = Number.NEGATIVE_INFINITY;
  for (const value of muxSamples) {
    const ptsUs = dtsUs + value.cttsTicks;
    firstPtsUs = Math.min(firstPtsUs, ptsUs);
    endPtsUs = Math.max(endPtsUs, ptsUs + value.durationTicks);
    dtsUs += value.durationTicks;
  }
  return endPtsUs - firstPtsUs;
}

const REAL_H264_ABR_FIXTURE = new URL(
  '../../../media-test/fixtures/media/scenarios/demux/h264_1080p_30s/03.mp4',
  import.meta.url,
);

interface ReplayChunk {
  readonly byteLength: number;
  readonly timestamp: number;
}

class ReplayFrame {
  closeCount = 0;

  constructor(readonly timestamp: number) {}

  close(): void {
    this.closeCount++;
    if (this.closeCount > 1) throw new Error('replay frame closed twice');
  }
}

function replayChunkStream(values: readonly ReplayChunk[]): ReadableStream<EncodedChunk> {
  let index = 0;
  return new ReadableStream<EncodedChunk>(
    {
      pull(controller): void {
        const value = values[index++];
        if (value === undefined) controller.close();
        else controller.enqueue(value as unknown as EncodedChunk);
      },
    },
    { highWaterMark: 0 },
  );
}

function replayDecoder(
  createDecoder: (options: StageOptions | undefined) => TransformStream<EncodedChunk, RawFrame>,
): CodecDriver {
  return {
    id: 'webcodecs-video',
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'native',
    supports: async () => ({ supported: true }),
    createDecoder: (_config, options) => createDecoder(options),
    createEncoder: () => {
      throw new Error('replay decoder test must not encode');
    },
  };
}

function replayContext(codec: CodecDriver): H264TwoPassRunnerContext {
  return {
    routeCodec: async () => codec,
    applyVideoFilters: async (frames) => frames,
    stageOptions: (signal, options) => ({
      signal,
      determinism: options.strategy?.determinism ?? 'auto',
      ...(options.strategy?.pinDriver === undefined
        ? {}
        : { pinDriver: options.strategy.pinDriver }),
    }),
  };
}

async function drainReplayFrames(stream: ReadableStream<VideoFrame>): Promise<ReplayFrame[]> {
  const reader = stream.getReader();
  const frames: ReplayFrame[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return frames;
      frames.push(result.value as unknown as ReplayFrame);
    }
  } finally {
    reader.releaseLock();
  }
}

function runtimeMiss(message: string, cause: Error): CapabilityError {
  return new CapabilityError(
    message,
    { op: { kind: 'route', id: 'decode' }, tried: ['webcodecs-video'] },
    { cause },
  );
}

describe('H.264 replay decoder runtime fallback', () => {
  const config: VideoDecoderConfig = {
    codec: 'avc1.640020',
    codedWidth: 1280,
    codedHeight: 720,
  };

  it('replays the exact prefix once after an initial native miss and closes every output frame once', async () => {
    const chunks = [
      { byteLength: 5, timestamp: 0 },
      { byteLength: 7, timestamp: 40_000 },
      { byteLength: 11, timestamp: 80_000 },
    ] as const;
    const nativeSeen: ReplayChunk[] = [];
    const softwareSeen: ReplayChunk[] = [];
    let softwareCreates = 0;
    const codec = replayDecoder((stage) => {
      const software = stage?.determinism === 'force-software';
      if (software) softwareCreates++;
      return new TransformStream<EncodedChunk, RawFrame>({
        transform(chunk, controller): void {
          const value = chunk as unknown as ReplayChunk;
          (software ? softwareSeen : nativeSeen).push(value);
          if (!software) {
            throw runtimeMiss(
              'initial native miss',
              new DOMException('Decoding error', 'EncodingError'),
            );
          }
          controller.enqueue(new ReplayFrame(value.timestamp) as unknown as RawFrame);
        },
      });
    });

    const frames = await drainReplayFrames(
      decodeH264ReplayVideo(
        replayChunkStream(chunks),
        codec,
        config,
        new AbortController().signal,
        {},
        replayContext(codec),
        'source-replay',
      ),
    );

    expect(nativeSeen).toEqual([chunks[0]]);
    expect(softwareSeen[0]).toBe(chunks[0]);
    expect(softwareSeen[1]).toBe(chunks[1]);
    expect(softwareSeen[2]).toBe(chunks[2]);
    expect(softwareCreates).toBe(1);
    expect(frames.map((frame) => frame.timestamp)).toEqual([0, 40_000, 80_000]);
    for (const frame of frames) frame.close();
    expect(frames.map((frame) => frame.closeCount)).toEqual([1, 1, 1]);
  });

  it('commits after the first published source frame and preserves cause plus phase on a late miss', async () => {
    const dom = new DOMException('Decoding error', 'EncodingError');
    const primary = runtimeMiss('late native miss', dom);
    let softwareCreates = 0;
    const codec = replayDecoder((stage) => {
      if (stage?.determinism === 'force-software') softwareCreates++;
      return new TransformStream<EncodedChunk, RawFrame>({
        transform(chunk, controller): void {
          const value = chunk as unknown as ReplayChunk;
          if (value.timestamp !== 0) throw primary;
          controller.enqueue(new ReplayFrame(value.timestamp) as unknown as RawFrame);
        },
      });
    });
    const reader = decodeH264ReplayVideo(
      replayChunkStream([
        { byteLength: 5, timestamp: 0 },
        { byteLength: 5, timestamp: 40_000 },
      ]),
      codec,
      config,
      new AbortController().signal,
      {},
      replayContext(codec),
      'source-replay',
    ).getReader();

    const first = await reader.read();
    if (first.done) throw new Error('expected a published native frame');
    const frame = first.value as unknown as ReplayFrame;
    frame.close();
    const error = await reader.read().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({
      detail: {
        op: {
          id: 'h264-source-replay-decode',
          facts: {
            phase: 'source-replay',
            attempt: 'primary',
            primaryFrameEmitted: true,
          },
        },
      },
    });
    expect((error as Error).cause).toBe(primary);
    expect(primary.cause).toBe(dom);
    expect(softwareCreates).toBe(0);
    expect(frame.closeCount).toBe(1);
    reader.releaseLock();
  });

  it('reports a failed generated candidate as a phase-tagged decode fault after software retry', async () => {
    const native = runtimeMiss(
      'candidate native miss',
      new DOMException('native decode failed', 'EncodingError'),
    );
    const software = runtimeMiss(
      'candidate software miss',
      new DOMException('software decode failed', 'EncodingError'),
    );
    let softwareCreates = 0;
    const codec = replayDecoder((stage) => {
      const fallback = stage?.determinism === 'force-software';
      if (fallback) softwareCreates++;
      return new TransformStream<EncodedChunk, RawFrame>({
        transform(): void {
          throw fallback ? software : native;
        },
      });
    });
    const reader = decodeH264ReplayVideo(
      replayChunkStream([{ byteLength: 5, timestamp: 0 }]),
      codec,
      config,
      new AbortController().signal,
      {},
      replayContext(codec),
      'private-candidate',
    ).getReader();

    const error = await reader.read().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MediaError);
    expect(error).toMatchObject({
      code: 'decode-error',
      detail: {
        phase: 'private-candidate',
        attempt: 'fallback',
        primaryFrameEmitted: false,
        fallback: 'webcodecs-software',
      },
    });
    expect((error as Error).cause).toBe(software);
    expect(softwareCreates).toBe(1);
    reader.releaseLock();
  });
});

describe('planH264TwoPass', () => {
  it('warms H.264/AV1 bitrate control while preserving CRF and two-pass contracts', () => {
    expect(implicitRateControlWarmupFrames({}, 'avc1.64001F', 30)).toBe(3);
    expect(implicitRateControlWarmupFrames({}, 'av01.0.12M.08', 60)).toBe(8);
    expect(implicitRateControlWarmupFrames({}, 'av01.0.08M.08', 30)).toBeUndefined();
    expect(implicitRateControlWarmupFrames({}, 'av01.0.08M.08', 30.0000003)).toBeUndefined();
    expect(implicitRateControlWarmupFrames({}, 'av01.0.08M.08', 30.5)).toBeUndefined();
    expect(implicitRateControlWarmupFrames({}, 'av01.0.08M.08', 30.500001)).toBe(8);
    expect(implicitRateControlWarmupFrames({}, 'AVC3.64001F', undefined)).toBe(3);
    expect(implicitRateControlWarmupFrames({}, 'vp09.00.31.08', 60)).toBeUndefined();
    expect(implicitRateControlWarmupFrames({ bitrate: 2_000_000 }, 'avc1.64001F', 30)).toBe(3);
    expect(implicitRateControlWarmupFrames({ bitrate: 2_000_000 }, 'avc3.64001F', 60)).toBe(8);
    expect(
      implicitRateControlWarmupFrames({ bitrate: 2_000_000 }, 'vp09.00.31.08', 60),
    ).toBeUndefined();
    expect(
      implicitRateControlWarmupFrames({ bitrateMode: 'constant' }, 'avc1.64001F', 30),
    ).toBeUndefined();
    expect(implicitRateControlWarmupFrames({ crf: 22 }, 'av01.0.12M.08', 60)).toBeUndefined();
    expect(implicitRateControlWarmupFrames({ twoPass: true }, 'avc1.64001F', 30)).toBeUndefined();
    expect(
      implicitRateControlWarmupFrames(
        { quality: { metric: 'ssim-luma-v1', minimumMean: 0.95 } },
        'avc1.64001F',
        30,
      ),
    ).toBeUndefined();
  });

  it('primes the real portrait 60-fps ABR corpus geometry used by the strict golden gate', async () => {
    const bytes = new Uint8Array(await readFile(REAL_H264_ABR_FIXTURE));
    const tracks = await Mp4Driver.probe?.(fromBytes(bytes, { mime: 'video/mp4' }));
    const video = tracks?.find((track) => track.mediaType === 'video');
    if (video === undefined || video.config === undefined || !('codedWidth' in video.config)) {
      throw new Error('real H.264 ABR fixture did not expose a video geometry');
    }
    expect({
      width: video.config.codedWidth,
      height: video.config.codedHeight,
      fps: video.fps,
      codec: video.config.codec,
    }).toEqual({ width: 1080, height: 1920, fps: 60, codec: 'avc1.64002A' });
    expect(
      implicitRateControlWarmupFrames({ bitrate: 2_000_000 }, video.config.codec, video.fps),
    ).toBe(8);
  });

  it('maps known and unknown source geometry without inventing dimensions', () => {
    const known: TrackInfo = {
      id: 0,
      mediaType: 'video',
      codec: 'h264',
      config: { codec: 'avc1.42E01E', codedWidth: 320, codedHeight: 240 },
      rotation: 90,
      fps: 25,
      durationSec: 1,
    };
    expect(sourceGeometryOf(known)).toEqual({
      width: 320,
      height: 240,
      rotation: 90,
      fps: 25,
      durationSec: 1,
    });
    expect(
      sourceGeometryOf({
        id: 1,
        mediaType: 'video',
        codec: 'h264',
        durationSec: 0,
      }),
    ).toEqual({
      width: undefined,
      height: undefined,
    });
    expect(
      sourceGeometryOf({
        id: 2,
        mediaType: 'video',
        codec: 'h264',
        rotation: 180,
        fps: 60,
        durationSec: 2,
        bitrate: 3_000_000,
      }),
    ).toEqual({
      width: undefined,
      height: undefined,
      rotation: 180,
      fps: 60,
      durationSec: 2,
      bitrate: 3_000_000,
    });
    expect(
      sourceGeometryOf({
        id: 3,
        mediaType: 'video',
        codec: 'h264',
        config: { codec: 'avc1.42E01E', codedWidth: 640, codedHeight: 360 },
        durationSec: Number.NaN,
        bitrate: 1_000_000,
      }),
    ).toEqual({ width: 640, height: 360, bitrate: 1_000_000 });
  });

  it('tags only genuine capability misses and retains exact terminal attempt facts', () => {
    const ordinary = new Error('ordinary decode fault');
    expect(
      tagH264ReplayDecodeError(
        ordinary,
        'source-replay',
        'avc1.64001F',
        'webcodecs-video',
        undefined,
        { attempt: 'primary', primaryFrameEmitted: false },
      ),
    ).toBe(ordinary);

    const crossRealm = Object.assign(new Error('cross-realm miss'), {
      name: 'CapabilityError',
      code: 'capability-miss',
    });
    const tagged = tagH264ReplayDecodeError(
      crossRealm,
      'source-replay',
      'avc1.64001F',
      'webcodecs-video',
      'webcodecs-software',
      { attempt: 'fallback', primaryFrameEmitted: true },
    );
    expect(tagged).toBeInstanceOf(CapabilityError);
    expect(tagged).toMatchObject({
      detail: {
        tried: ['webcodecs-video', 'webcodecs-software'],
        op: {
          facts: {
            fallback: 'webcodecs-software',
            attempt: 'fallback',
            primaryFrameEmitted: true,
          },
        },
      },
    });
  });

  it('turns fixed-QP evidence into a bounded complexity-weighted target schedule', () => {
    const samples = [sample(0, 1_000, 40_000, true), sample(40_000, 4_000)];
    const bitrate = (5000 * 8) / 0.08;
    const plan = planH264TwoPass(samples, bitrate, 0.08);

    expect(H264_FIRST_PASS_QUANTIZER).toBe(28);
    expect(plan.sampleCount).toBe(2);
    expect(plan.firstPassBytes).toBe(5_000);
    expect(plan.targetBytes).toBe(5_000);
    expect(plan.evidenceBytes).toBe(18);
    expect(Math.abs(plan.predictedBytes - plan.targetBytes) / plan.targetBytes).toBeLessThan(0.15);
    expect(plan.quantizerForTimestamp(0)).toBeGreaterThanOrEqual(0);
    expect(plan.quantizerForTimestamp(40_000)).toBeLessThanOrEqual(51);
  });

  it('never gives a harder equal-duration inter picture a worse quantizer', () => {
    const samples = [
      sample(0, 1_000),
      sample(40_000, 2_000),
      sample(80_000, 4_000),
      sample(120_000, 8_000),
    ];
    const plan = planH264TwoPass(samples, 500_000, 0.16);
    const quantizers = samples.map(({ timestampUs }) => plan.quantizerForTimestamp(timestampUs));

    for (let index = 1; index < quantizers.length; index++) {
      expect(quantizers[index]).toBeLessThanOrEqual(quantizers[index - 1] ?? 51);
    }
    expect(quantizers.at(-1)).toBeLessThan(quantizers[0] ?? 0);
  });

  it('is invariant when evidence sizes and the byte budget scale together', () => {
    const samples = [
      sample(0, 1_000, 20_000, true),
      sample(20_000, 3_500, 40_000),
      sample(60_000, 1_800, 60_000),
    ];
    const scale = 8;
    const bitrate = 400_000;
    const plan = planH264TwoPass(samples, bitrate, 0.12);
    const scaledPlan = planH264TwoPass(
      samples.map((picture) => ({
        ...picture,
        byteLength: picture.byteLength * scale,
      })),
      bitrate * scale,
      0.12,
    );

    expect(samples.map(({ timestampUs }) => scaledPlan.quantizerForTimestamp(timestampUs))).toEqual(
      samples.map(({ timestampUs }) => plan.quantizerForTimestamp(timestampUs)),
    );
    expect(scaledPlan.targetBytes).toBe(plan.targetBytes * scale);
    expect(Math.abs(scaledPlan.predictedBytes - plan.predictedBytes * scale)).toBeLessThanOrEqual(
      scale / 2,
    );
  });

  it('bounds adjacent quantizer changes after allocating extreme complexity swings', () => {
    const samples = [
      sample(0, 64),
      sample(40_000, 64),
      sample(80_000, 1_000_000),
      sample(120_000, 1_000_000),
      sample(160_000, 64),
      sample(200_000, 64),
    ];
    const plan = planH264TwoPass(samples, 10_000_000, 0.24);
    const quantizers = samples.map(({ timestampUs }) => plan.quantizerForTimestamp(timestampUs));

    expect(Math.max(...quantizers) - Math.min(...quantizers)).toBeGreaterThan(0);
    for (let index = 1; index < quantizers.length; index++) {
      expect(Math.abs((quantizers[index] ?? 0) - (quantizers[index - 1] ?? 0))).toBeLessThanOrEqual(
        4,
      );
    }
  });

  it('calibrates the integer schedule to the predicted aggregate byte budget', () => {
    const samples = [
      sample(0, 1_400, 20_000, true),
      sample(20_000, 650, 20_000),
      sample(40_000, 5_200, 60_000),
      sample(100_000, 900, 40_000),
      sample(140_000, 2_700, 60_000),
    ];
    const plan = planH264TwoPass(samples, 480_000, 0.2);

    expect(Math.abs(plan.predictedBytes - plan.targetBytes) / plan.targetBytes).toBeLessThan(0.07);
  });

  it('keys B-frame evidence by PTS rather than callback order', () => {
    const plan = planH264TwoPass(
      [sample(80_000, 900), sample(0, 1_800, 40_000, true), sample(40_000, 600)],
      240_000,
      0.12,
    );
    expect(Array.from(plan.timestampsUs)).toEqual([0, 40_000, 80_000]);
    expect(plan.quantizerForTimestamp(80_000)).toBeTypeOf('number');
    expect(plan.quantizerForTimestamp(0)).toBeTypeOf('number');
  });

  it('uses VFR durations and a declared tail without assuming constant frame rate', () => {
    const plan = planH264TwoPass(
      [sample(0, 800, 20_000, true), sample(20_000, 1_200, 80_000), sample(100_000, 600, 50_000)],
      400_000,
      0.15,
    );
    expect(plan.durationUs).toBe(150_000);
    expect(plan.targetBytes).toBe(7_500);
  });

  it('anchors a declared duration to a non-zero first PTS', () => {
    const plan = planH264TwoPass(
      [
        { timestampUs: 1_000_000, byteLength: 900, keyFrame: true },
        { timestampUs: 1_040_000, byteLength: 700, keyFrame: false },
      ],
      200_000,
      0.08,
    );
    expect(plan.durationUs).toBe(80_000);
    expect(plan.targetBytes).toBe(2_000);
  });

  it('rejects duplicate/missing timestamps and invalid budgets instead of degrading to one pass', () => {
    expect(() => planH264TwoPass([sample(0, 100), sample(0, 200)], 100_000, 0.08)).toThrow(
      InputError,
    );
    const plan = planH264TwoPass([sample(0, 100)], 100_000, 0.04);
    expect(() => plan.quantizerForTimestamp(40_000)).toThrow(InputError);
    expect(() => planH264TwoPass([sample(0, 100)], 0, 0.04)).toThrow(InputError);
    expect(() => planH264TwoPass([], 100_000, 0.04)).toThrow(InputError);
  });

  it('rejects non-integral timeline facts and empty pictures before allocation', () => {
    expect(() =>
      planH264TwoPass([{ timestampUs: -1, byteLength: 100, keyFrame: true }], 100_000, 1),
    ).toThrow(InputError);
    expect(() =>
      planH264TwoPass([{ timestampUs: 0.5, byteLength: 100, keyFrame: true }], 100_000, 1),
    ).toThrow(InputError);
    expect(() =>
      planH264TwoPass([{ timestampUs: 0, byteLength: 0, keyFrame: true }], 100_000, 1),
    ).toThrow(InputError);
    expect(() =>
      planH264TwoPass(
        [{ timestampUs: 0, byteLength: 100, keyFrame: true, durationUs: 0 }],
        100_000,
        1,
      ),
    ).toThrow(InputError);
  });

  it('derives the final VFR duration from the previous presentation timestamp', () => {
    const plan = planH264TwoPass(
      [
        { timestampUs: 0, durationUs: 40_000, byteLength: 100, keyFrame: true },
        { timestampUs: 40_000, byteLength: 200, keyFrame: false },
      ],
      200_000,
    );
    expect(plan.durationUs).toBe(80_000);
  });

  it('rejects a one-picture pass without a declared or measured duration', () => {
    expect(() =>
      planH264TwoPass([{ timestampUs: 0, byteLength: 100, keyFrame: true }], 100_000),
    ).toThrow(InputError);
    expect(() =>
      planH264TwoPass([{ timestampUs: 0, byteLength: 100, keyFrame: true }], 100_000, 0),
    ).toThrow(InputError);
    expect(() =>
      planH264TwoPass([{ timestampUs: 0, byteLength: 100, keyFrame: true }], 100_000, 0.04),
    ).toThrow(/needs|duration/i);
  });

  it('measures the mux presentation span and rejects conflicting track metadata', () => {
    const evidence = [
      sample(0, 800, 40_000, true),
      sample(20_000, 1_200, 40_000),
      sample(100_000, 600, 50_000),
    ];
    const plan = planH264TwoPass(evidence, 400_000, 0.15);

    // Buffered MP4 muxing treats adjacent PTS gaps as authoritative for monotonic VFR output, even
    // when WebCodecs repeats a stale nominal duration on non-final chunks.
    expect(plan.durationUs).toBe(150_000);
    expect(plan.durationUs).toBe(muxPresentationSpanUs(evidence));
    expect(() => planH264TwoPass(evidence, 400_000, 0.14)).toThrow(
      /does not match measured presentation span 150000us/,
    );
  });

  it('matches buffered mux duration recovery for reordered output with incomplete durations', () => {
    const evidence: readonly H264FirstPassSample[] = [
      { timestampUs: 80_000, byteLength: 600, keyFrame: false },
      sample(0, 800, 40_000, true),
      sample(40_000, 1_200, 40_000),
    ];
    const plan = planH264TwoPass(evidence, 400_000, 0.12);
    expect(plan.durationUs).toBe(120_000);
    expect(plan.durationUs).toBe(muxPresentationSpanUs(evidence));
  });

  it('bounds picture evidence before reading or allocating an oversized schedule', () => {
    const oversized = {
      length: H264_TWO_PASS_MAX_PICTURE_EVIDENCE + 1,
    } as unknown as readonly H264FirstPassSample[];
    expect(() => planH264TwoPass(oversized, 100_000)).toThrowError(
      expect.objectContaining({
        name: 'CapabilityError',
        code: 'capability-miss',
        detail: expect.objectContaining({
          op: expect.objectContaining({
            kind: 'route',
            id: 'h264-two-pass-picture-evidence',
            facts: expect.objectContaining({
              maximumPictureCount: H264_TWO_PASS_MAX_PICTURE_EVIDENCE,
            }),
          }),
        }),
      }),
    );
    expect(() => planH264TwoPass(oversized, 100_000)).toThrow(CapabilityError);
  });

  it('derives the maximum presentation end iteratively for a high-but-bounded schedule', () => {
    const count = Math.floor(H264_TWO_PASS_MAX_PICTURE_EVIDENCE / 2) + 1;
    const evidence = Array.from({ length: count }, (_, timestampUs) =>
      sample(timestampUs, 1, 1, timestampUs === 0),
    );
    const plan = planH264TwoPass(evidence, 8_000_000, count / 1_000_000);
    expect(plan.sampleCount).toBe(count);
    expect(plan.durationUs).toBe(count);
  });

  it('rejects a target budget that rounds to zero for an ultra-short timeline', () => {
    expect(() =>
      planH264TwoPass([{ timestampUs: 0, byteLength: 100, durationUs: 1, keyFrame: true }], 1),
    ).toThrow(InputError);
  });

  it('rejects an aggregate first-pass size that exceeds safe integer accounting', () => {
    const picture = {
      byteLength: Number.MAX_SAFE_INTEGER,
      durationUs: 40_000,
      keyFrame: false,
    } as const;
    expect(() =>
      planH264TwoPass(
        [
          { timestampUs: 0, ...picture },
          { timestampUs: 40_000, ...picture },
        ],
        1_000_000,
      ),
    ).toThrow(InputError);
  });

  it('recalibrates a fresh schedule from exact candidate access-unit sizes and the next byte bound', () => {
    const first = [sample(0, 1_000, 40_000, true), sample(40_000, 700), sample(80_000, 1_300)];
    const plan = planH264TwoPass(first, 200_000, 0.12);
    const actual = [sample(0, 800, 40_000, true), sample(40_000, 500), sample(80_000, 900)];
    const next = plan.recalibrate(actual, plan.targetBytes * 2);

    expect(next.targetBytes).toBe(plan.targetBytes * 2);
    expect(next.predictedBytes).toBeGreaterThan(
      actual.reduce((sum, item) => sum + item.byteLength, 0),
    );
    expect(Array.from(next.quantizers)).not.toEqual(Array.from(plan.quantizers));
    expect(Array.from(next.quantizers).reduce((sum, value) => sum + value, 0)).toBeLessThan(
      Array.from(plan.quantizers).reduce((sum, value) => sum + value, 0),
    );
    expect(next.quantizerForTimestamp(0)).toBe(next.quantizers[0]);
  });

  it('normalizes candidate output order and rejects incomplete, empty, or unrepresentable evidence', () => {
    const plan = planH264TwoPass(
      [sample(0, 1_000, 40_000, true), sample(40_000, 700)],
      200_000,
      0.08,
    );
    expect(() => plan.recalibrate([sample(0, 500)], plan.targetBytes)).toThrow(InputError);
    expect(() =>
      plan.recalibrate([sample(40_000, 500), sample(0, 500)], plan.targetBytes),
    ).not.toThrow();
    expect(() => plan.recalibrate([sample(0, 0), sample(40_000, 500)], plan.targetBytes)).toThrow(
      InputError,
    );
    expect(() => plan.recalibrate([sample(0, 500), sample(40_000, 500)], 0)).toThrow(InputError);
  });

  it('requires candidate count, PTS, raw duration, and eventual mux span to match analysis', () => {
    const plan = planH264TwoPass(
      [sample(0, 1_000, 40_000, true), sample(40_000, 700, 40_000)],
      200_000,
      0.08,
    );
    expect(
      plan.validateCandidateTimeline([sample(40_000, 500), sample(0, 600, 40_000, true)]),
    ).toBe(80_000);
    expect(() =>
      plan.validateCandidateTimeline([sample(0, 600, 40_000, true), sample(40_000, 500, 41_000)]),
    ).toThrow(/changed picture duration at PTS 40000/);
    expect(() =>
      plan.validateCandidateTimeline([sample(0, 600, 40_000, true), sample(41_000, 500, 40_000)]),
    ).toThrow(/changed the analyzed presentation timeline/);
    expect(() => plan.validateCandidateTimeline([sample(0, 600, 40_000, true)])).toThrow(
      /emitted 1\/2 analyzed pictures/,
    );
  });

  it('advances a slightly over-ceiling schedule instead of repeating the invalid QPs', () => {
    const plan = planH264TwoPass(
      [sample(0, 1_000, 40_000, true), sample(40_000, 1_000)],
      200_000,
      0.08,
    );
    const actualPerPicture = Math.ceil(plan.targetBytes * 1.02) / 2;
    const next = plan.recalibrate(
      [
        sample(0, Math.ceil(actualPerPicture), 40_000, true),
        sample(40_000, Math.floor(actualPerPicture)),
      ],
      plan.targetBytes,
    );
    expect(next.predictedBytes).toBeLessThanOrEqual(plan.targetBytes);
    expect(
      Array.from(next.quantizers).some((value, index) => value > (plan.quantizers[index] ?? 0)),
    ).toBe(true);
  });

  it('fills sub-QP headroom with a mixed measured-complexity schedule below the byte bound', () => {
    const count = 120;
    const first = Array.from({ length: count }, (_, index) =>
      sample(index * 40_000, 1_000 + (index % 7) * 100, 40_000, index === 0),
    );
    const plan = planH264TwoPass(first, 300_000, 4.8);
    const actual = first.map((picture) => ({ ...picture, byteLength: picture.byteLength * 2 }));
    const actualBytes = actual.reduce((sum, picture) => sum + picture.byteLength, 0);
    const targetBytes = Math.floor(actualBytes / 1.02);
    const next = plan.recalibrate(actual, targetBytes);
    const uniqueQuantizers = new Set(next.quantizers);

    expect(next.predictedBytes).toBeLessThanOrEqual(targetBytes);
    expect(next.predictedBytes / targetBytes).toBeGreaterThan(0.99);
    expect(uniqueQuantizers.size).toBeGreaterThan(1);
    expect(Array.from(next.quantizers)).not.toEqual(Array.from(plan.quantizers));
  });

  it('installs a timestamp-checked replay quantizer and detects lifecycle mismatches', () => {
    const plan = planH264TwoPass(
      [sample(0, 1_000, 40_000, true), sample(40_000, 1_200)],
      220_000,
      0.08,
    );
    const installation = installH264TwoPassQuantizer({}, plan);
    const selector = installation.stage.quantizerAt;
    expect(selector).toBeDefined();
    if (selector === undefined) throw new Error('quantizer selector was not installed');

    const frame = (timestampUs: number) => ({
      index: timestampUs / 40_000,
      timestampUs,
      durationUs: 40_000,
      keyFrame: timestampUs === 0,
    });
    expect(selector(frame(0))).toBeTypeOf('number');
    expect(selector(frame(40_000))).toBeTypeOf('number');
    expect(() => selector(frame(40_000))).toThrow(InputError);
    expect(() => installation.assertComplete()).not.toThrow();

    const incomplete = installH264TwoPassQuantizer({}, plan);
    const incompleteSelector = incomplete.stage.quantizerAt;
    expect(incompleteSelector).toBeDefined();
    if (incompleteSelector === undefined) throw new Error('quantizer selector was not installed');
    incompleteSelector(frame(0));
    expect(() => incomplete.assertComplete()).toThrow(InputError);
  });
});
