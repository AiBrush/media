import { describe, expect, it } from 'vitest';
import type { VideoEncoderStageOptions } from '../codecs/webcodecs-video.ts';
import {
  type CodecDriver,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type Demuxer,
  type EncodedChunk,
  type MuxedTrackAudit,
  type Packet,
  type RawFrame,
  type TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, ConstraintUnsatisfiedError, InputError } from '../contracts/errors.ts';
import {
  type ChunkStruct,
  MP4_H264_MAX_NAL_UNITS_PER_ACCESS_UNIT,
  auditMp4H264MuxedPackets,
  auditMp4H264MuxedTrack,
} from '../drivers/mp4/mux.ts';
import type { Source } from '../sources/source.ts';
import type { CallOptions, VideoTarget } from './types.ts';
import {
  H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES,
  assertH264QualityConstraintPreflight,
  averageBitrateByteBudget,
} from './video-quality-constraint.ts';
import {
  type H264QualityOutputRoute,
  MAXIMUM_CANDIDATE_PASSES,
  allocatorTargetCorrection,
  analyzeH264QualityConstrained,
  copyDisplayedRgbaForQuality,
  nextNativeRateRequest,
} from './video-quality-runner.ts';

const WIDTH = 8;
const HEIGHT = 8;
const FRAME_DURATION_US = 40_000;
const FRAME_COUNT = 4;
const SOURCE_TRACK: TrackInfo = {
  id: 1,
  mediaType: 'video',
  codec: 'avc1.42E01E',
  config: { codec: 'avc1.42E01E', codedWidth: WIDTH, codedHeight: HEIGHT },
  fps: 25,
  durationSec: (FRAME_COUNT * FRAME_DURATION_US) / 1_000_000,
};

interface FakeEncodedChunk {
  readonly timestamp: number;
  readonly duration: number;
  readonly byteLength: number;
  readonly type: 'key' | 'delta';
  readonly pixels: Uint8Array;
  copyTo(destination: AllowSharedBufferSource): void;
}

class FakeFrame {
  readonly codedWidth = WIDTH;
  readonly codedHeight = HEIGHT;
  readonly displayWidth = WIDTH;
  readonly displayHeight = HEIGHT;
  readonly duration = FRAME_DURATION_US;
  readonly format = 'RGBA' as const;
  closed = 0;

  constructor(
    readonly timestamp: number,
    readonly pixels: Uint8Array,
    private readonly onClose: () => void,
  ) {}

  async copyTo(destination: AllowSharedBufferSource): Promise<readonly PlaneLayout[]> {
    if (this.closed !== 0) throw new Error('copy after close');
    const bytes = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    bytes.set(this.pixels);
    return [{ offset: 0, stride: WIDTH * 4 }];
  }

  close(): void {
    if (this.closed !== 0) throw new Error('frame closed twice');
    this.closed++;
    this.onClose();
  }
}

function referencePixels(): Uint8Array {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    const value = (pixel * 4) % 256;
    const offset = pixel * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function quantizedPixels(source: Uint8Array, quantizer: number): Uint8Array {
  const step = Math.max(1, Math.round(quantizer * 2));
  return source.map((value, index) =>
    index % 4 === 3 ? 255 : Math.min(255, Math.round(value / step) * step),
  );
}

function fakeChunk(
  timestamp: number,
  byteLength: number,
  pixels: Uint8Array,
  keyFrame: boolean,
  duration = FRAME_DURATION_US,
): EncodedChunk {
  const chunk: FakeEncodedChunk = {
    timestamp,
    duration,
    byteLength,
    type: keyFrame ? 'key' : 'delta',
    pixels,
    copyTo(destination): void {
      const bytes = ArrayBuffer.isView(destination)
        ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
        : new Uint8Array(destination);
      bytes.fill(0x55, 0, Math.min(bytes.byteLength, byteLength));
      if (byteLength >= 5 && bytes.byteLength >= byteLength) {
        const nalLength = byteLength - 4;
        bytes[0] = (nalLength >>> 24) & 0xff;
        bytes[1] = (nalLength >>> 16) & 0xff;
        bytes[2] = (nalLength >>> 8) & 0xff;
        bytes[3] = nalLength & 0xff;
        bytes[4] = keyFrame ? 0x65 : 0x41;
      }
    },
  };
  return chunk as unknown as EncodedChunk;
}

function streamOf<T>(values: readonly T[]): ReadableStream<T> {
  let index = 0;
  return new ReadableStream<T>({
    pull(controller): void {
      const value = values[index++];
      if (value === undefined) controller.close();
      else controller.enqueue(value);
    },
  });
}

interface FakeRuntimeState {
  demuxOpened: number;
  demuxClosed: number;
  nativeDecodersCreated: number;
  softwareDecodersCreated: number;
  framesCreated: number;
  framesClosed: number;
  muxersCreated: number;
  auditMuxOptions: H264QualityOutputRoute['muxOptions'] | undefined;
  candidateEncodedBytes: number[];
  candidateQuantizers: number[][];
  candidateBitrates: Array<number | undefined>;
  candidateRateControlWarmupFrames: Array<number | undefined>;
}

function fakeRuntime(
  onEncodedChunk?: () => void,
  behavior: {
    readonly candidateDurationDeltaUs?: number;
    readonly candidateByteLengthFactors?: readonly number[];
    readonly candidateQualityQuantizers?: readonly number[];
    readonly qualityDecoderRouteError?: Error;
    readonly nativeDecoderFailure?: {
      readonly decoder: number;
      readonly afterFrames?: number;
      readonly error: CapabilityError;
    };
  } = {},
): {
  readonly source: Source;
  readonly container: ContainerDriver;
  readonly outputRoute: H264QualityOutputRoute;
  readonly context: Parameters<typeof analyzeH264QualityConstrained>[8];
  readonly state: FakeRuntimeState;
} {
  const state: FakeRuntimeState = {
    demuxOpened: 0,
    demuxClosed: 0,
    nativeDecodersCreated: 0,
    softwareDecodersCreated: 0,
    framesCreated: 0,
    framesClosed: 0,
    muxersCreated: 0,
    auditMuxOptions: undefined,
    candidateEncodedBytes: [],
    candidateQuantizers: [],
    candidateBitrates: [],
    candidateRateControlWarmupFrames: [],
  };
  const source: Source = {
    __media: 'source',
    kind: 'bytes',
    size: 1,
    stream: () => streamOf([new Uint8Array([1])]),
  };
  const sourcePixels = referencePixels();
  let decodeRoutes = 0;
  let encoderPass = 0;
  const makeFrame = (timestamp: number, pixels: Uint8Array): VideoFrame => {
    state.framesCreated++;
    return new FakeFrame(timestamp, pixels, () => state.framesClosed++) as unknown as VideoFrame;
  };
  const codec: CodecDriver = {
    id: 'webcodecs-video',
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'native',
    supports: async () => ({ supported: true }),
    createDecoder: (_config, stage) => {
      const software = stage?.determinism === 'force-software';
      const decoder = software ? undefined : ++state.nativeDecodersCreated;
      if (software) state.softwareDecodersCreated++;
      let frames = 0;
      return new TransformStream<EncodedChunk, RawFrame>({
        transform(chunk, controller): void {
          const failure = behavior.nativeDecoderFailure;
          if (
            failure !== undefined &&
            !software &&
            decoder === failure.decoder &&
            frames >= (failure.afterFrames ?? 0)
          ) {
            throw failure.error;
          }
          const encoded = chunk as unknown as FakeEncodedChunk;
          controller.enqueue(makeFrame(encoded.timestamp, encoded.pixels));
          frames++;
        },
      });
    },
    createEncoder(config, options) {
      const stage = options as VideoEncoderStageOptions | undefined;
      const candidateIndex = encoderPass++ - 1;
      if (candidateIndex >= 0) {
        state.candidateEncodedBytes[candidateIndex] = 0;
        state.candidateQuantizers[candidateIndex] = [];
        state.candidateBitrates[candidateIndex] = 'bitrate' in config ? config.bitrate : undefined;
        state.candidateRateControlWarmupFrames[candidateIndex] = stage?.rateControlWarmupFrames;
      }
      let index = 0;
      let published = false;
      return new TransformStream<RawFrame, EncodedChunk>({
        transform(rawFrame, controller): void {
          const frame = rawFrame as unknown as FakeFrame;
          try {
            if (!published) {
              if (!('width' in config) || !('height' in config)) throw new Error('video config');
              stage?.onDecoderConfig?.({
                codec: config.codec,
                codedWidth: config.width,
                codedHeight: config.height,
                description: new Uint8Array([1, 0x42, 0xe0, 0x1e, 0xff]),
              });
              published = true;
            }
            const quantizer =
              stage?.quantizerAt?.({
                index,
                timestampUs: frame.timestamp,
                durationUs: frame.duration,
                keyFrame: index === 0,
              }) ??
              stage?.quantizer ??
              28;
            const modeledByteLength = 1_000 * 2 ** ((28 - quantizer) / 6);
            const byteLengthFactor =
              candidateIndex < 0 ? 1 : (behavior.candidateByteLengthFactors?.[candidateIndex] ?? 1);
            const byteLength = Math.max(1, Math.round(modeledByteLength * byteLengthFactor));
            if (candidateIndex >= 0) {
              state.candidateEncodedBytes[candidateIndex] =
                (state.candidateEncodedBytes[candidateIndex] ?? 0) + byteLength;
              state.candidateQuantizers[candidateIndex]?.push(quantizer);
            }
            const qualityQuantizer =
              candidateIndex < 0
                ? quantizer
                : (behavior.candidateQualityQuantizers?.[candidateIndex] ?? quantizer);
            onEncodedChunk?.();
            controller.enqueue(
              fakeChunk(
                frame.timestamp,
                byteLength,
                quantizedPixels(frame.pixels, qualityQuantizer),
                index === 0,
                FRAME_DURATION_US +
                  (stage?.quantizerAt === undefined ? 0 : (behavior.candidateDurationDeltaUs ?? 0)),
              ),
            );
            index++;
          } finally {
            frame.close();
          }
        },
      });
    },
  };
  const container: ContainerDriver = {
    id: 'fake-mp4',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: () => true,
    async demux(): Promise<Demuxer> {
      state.demuxOpened++;
      return {
        tracks: [SOURCE_TRACK],
        packets: () =>
          streamOf<Packet>(
            Array.from({ length: FRAME_COUNT }, (_, index) => ({
              chunk: fakeChunk(index * FRAME_DURATION_US, 1, sourcePixels, index === 0),
            })),
          ),
        close: async () => {
          state.demuxClosed++;
        },
      };
    },
    createMuxer() {
      state.muxersCreated++;
      throw new Error('quality analysis must not create a muxer');
    },
    async auditMuxedTrack(track, packets, options) {
      state.auditMuxOptions = options;
      return auditMp4H264MuxedPackets(track, packets, options);
    },
  };
  const context: Parameters<typeof analyzeH264QualityConstrained>[8] = {
    routeCodec: async (query) => {
      if (query.direction === 'decode') {
        decodeRoutes++;
        if (decodeRoutes === 4 && behavior.qualityDecoderRouteError !== undefined) {
          throw behavior.qualityDecoderRouteError;
        }
      }
      return codec;
    },
    applyVideoFilters: async (frames) => frames,
    stageOptions: (signal, callOptions) => ({
      signal,
      determinism: callOptions.strategy?.determinism ?? 'auto',
      ...(callOptions.strategy?.pinDriver === undefined
        ? {}
        : { pinDriver: callOptions.strategy.pinDriver }),
    }),
  };
  return {
    source,
    container,
    outputRoute: { driver: container, format: 'mp4', muxOptions: { container: 'mp4' } },
    context,
    state,
  };
}

function target(minimumMean: number): VideoTarget {
  return {
    codec: 'h264',
    bitrate: 160_000,
    maxAverageBitrate: 300_000,
    quality: { metric: 'ssim-luma-v1', minimumMean, samples: 4 },
  };
}

describe('native H.264 request calibration', () => {
  it('uses byte correction for over-cap or unmeasured candidates', () => {
    expect(nextNativeRateRequest(1_000_000, 200, 100, 0.99, 0.95)).toBe(500_000);
    expect(nextNativeRateRequest(1_000_000, 80, 100, undefined, 0.95)).toBe(1_250_000);
  });

  it('uses the larger of rate headroom and measured SSIM distortion when quality is available', () => {
    expect(nextNativeRateRequest(1_000_000, 100, 100, 0.9, 0.95)).toBe(2_000_000);
    expect(nextNativeRateRequest(1_000_000, 80, 100, 0.96, 0.95)).toBe(1_250_000);
    expect(nextNativeRateRequest(1, 1, 1, 0.99, 1)).toBeGreaterThan(1);
  });

  it('always moves off a request whose overshoot is only a rounding step', () => {
    // Measured stall: 2,373,685 bytes against a 2,373,583-byte ceiling. The byte ratio alone (0.99996)
    // returns essentially the same request, and the encoder answers it with the same payload forever.
    const request = 1_820_000;
    const next = nextNativeRateRequest(request, 2_373_685, 2_373_583, undefined, 0.95);
    expect(next).toBeLessThan(request);
    expect(next).toBeLessThanOrEqual(Math.floor(request * 0.99));
    expect(next).toBeGreaterThan(0);
  });

  it('strictly decreases on every overshoot, from a single byte over to a 4x blowout', () => {
    const ceiling = 1_000_000;
    for (const over of [1, 100, 10_000, 500_000, 3_000_000]) {
      let current = 1_820_000;
      for (let pass = 0; pass < 32; pass++) {
        const next = nextNativeRateRequest(current, ceiling + over, ceiling, undefined, 0.95);
        expect(next).toBeLessThan(current);
        expect(Number.isSafeInteger(next)).toBe(true);
        current = next;
        if (current <= 1) break;
      }
    }
  });

  it('never returns a non-positive or non-integer request', () => {
    for (const [current, actual, cap] of [
      [1, 2, 1],
      [2, 1_000_000, 1],
      [7, 8, 7],
    ] as const) {
      const next = nextNativeRateRequest(current, actual, cap, undefined, 0.95);
      expect(Number.isSafeInteger(next)).toBe(true);
      expect(next).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('allocatorTargetCorrection — spend the byte budget the QP schedule left unused', () => {
  it('aims the next pass so the achieved payload lands on the ceiling', () => {
    // Measured 480p ABR rung: requested 2,373,583, achieved 2,256,210 (95.1%) at SSIM 0.9498/0.95.
    const correction = allocatorTargetCorrection(2_373_583, 2_256_210, 2_373_583);
    expect(correction).toBeGreaterThan(1);
    expect(2_256_210 * correction).toBeCloseTo(2_373_583, 0);
  });

  it('leaves an over-ceiling candidate to aim at the ceiling itself', () => {
    expect(allocatorTargetCorrection(1_000, 1_200, 1_000)).toBe(1);
    expect(allocatorTargetCorrection(1_200, 1_000, 1_000)).toBe(1.2);
  });

  it('never boosts below one and is bounded above', () => {
    expect(allocatorTargetCorrection(500, 1_000, 2_000)).toBe(1);
    expect(allocatorTargetCorrection(10_000, 100, 1_000)).toBe(1.5);
  });

  it('degrades to a no-op on degenerate evidence', () => {
    for (const [requested, achieved, cap] of [
      [0, 100, 1_000],
      [100, 0, 1_000],
      [Number.NaN, 100, 1_000],
      [100, Number.POSITIVE_INFINITY, 1_000],
      [-5, 100, 1_000],
    ] as const) {
      expect(allocatorTargetCorrection(requested, achieved, cap)).toBe(1);
    }
  });
});

const AVC_DESCRIPTION = new Uint8Array([1, 0x42, 0xe0, 0x1e, 0xff]);

function avccSample(byteLength: number, timestampUs: number, durationUs: number): ChunkStruct {
  const data = new Uint8Array(byteLength).fill(0x55);
  const nalLength = byteLength - 4;
  data[0] = (nalLength >>> 24) & 0xff;
  data[1] = (nalLength >>> 16) & 0xff;
  data[2] = (nalLength >>> 8) & 0xff;
  data[3] = nalLength & 0xff;
  data[4] = timestampUs === 0 ? 0x65 : 0x41;
  return { timestampUs, durationUs, key: timestampUs === 0, data };
}

function annexBAccessUnit(nalus: readonly Uint8Array[], startCodeLength = 3): Uint8Array {
  const byteLength = nalus.reduce((total, nal) => total + startCodeLength + nal.byteLength, 0);
  const data = new Uint8Array(byteLength);
  let offset = 0;
  for (const nal of nalus) {
    if (startCodeLength === 4) data[offset++] = 0;
    data.set([0, 0, 1], offset);
    offset += 3;
    data.set(nal, offset);
    offset += nal.byteLength;
  }
  return data;
}

function repeatedAnnexBAccessUnit(nalUnitCount: number): Uint8Array {
  const data = new Uint8Array(nalUnitCount * 4);
  for (let index = 0; index < nalUnitCount; index++) {
    data.set([0, 0, 1, 0x41], index * 4);
  }
  return data;
}

describe('quality display-reference pixels', () => {
  it('materializes deferred display scaling instead of cropping the coded raster', async () => {
    const frame = {
      codedWidth: 8,
      codedHeight: 8,
      displayWidth: 4,
      displayHeight: 4,
      visibleRect: { x: 0, y: 0, width: 8, height: 8 },
      copyTo: () => {
        throw new Error('deferred scaling must not use a coded-raster copy');
      },
    } as unknown as VideoFrame;
    const expected = new Uint8Array(4 * 4 * 4).fill(0x7f);
    let materializations = 0;
    const copied = await copyDisplayedRgbaForQuality(frame, async (value, width, height) => {
      expect(value).toBe(frame);
      expect([width, height]).toEqual([4, 4]);
      materializations++;
      return expected;
    });

    expect(copied).toEqual({ data: expected, width: 4, height: 4 });
    expect(materializations).toBe(1);
  });

  it('copies an unscaled visible raster from its exact coded offset', async () => {
    let copiedRect: DOMRectInit | undefined;
    const frame = {
      codedWidth: 12,
      codedHeight: 10,
      displayWidth: 8,
      displayHeight: 8,
      visibleRect: { x: 2, y: 1, width: 8, height: 8 },
      copyTo: async (destination: AllowSharedBufferSource, options?: VideoFrameCopyToOptions) => {
        copiedRect = options?.rect;
        const bytes = ArrayBuffer.isView(destination)
          ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
          : new Uint8Array(destination);
        bytes.fill(0x3a);
        return [{ offset: 0, stride: 32 }];
      },
    } as unknown as VideoFrame;

    const copied = await copyDisplayedRgbaForQuality(frame, async () => {
      throw new Error('matching visible/display geometry must not materialize');
    });

    expect(copied.data).toEqual(new Uint8Array(8 * 8 * 4).fill(0x3a));
    expect(copiedRect).toEqual({ x: 2, y: 1, width: 8, height: 8 });
  });
});

describe('exact MP4 H.264 output audit', () => {
  const track: TrackInfo = {
    id: 1,
    mediaType: 'video',
    codec: 'avc1.42E01E',
    config: {
      codec: 'avc1.42E01E',
      codedWidth: 1920,
      codedHeight: 1080,
      description: AVC_DESCRIPTION,
    },
    fps: 30,
  };

  it('uses prepared AVCC payload bytes and neutral-demux tick-rounded presentation span', () => {
    const chunks = [
      avccSample(3_334, 0, 33_349),
      avccSample(3_334, 33_349, 33_349),
      avccSample(3_333, 66_698, 33_349),
    ];
    const audit = auditMp4H264MuxedTrack(track, chunks);

    expect(audit).toMatchObject({
      elementaryPayloadBytes: 10_001,
      presentationSpanUs: 100_000,
      sampleCount: 3,
      preparedSampleByteLengths: [3_334, 3_334, 3_333],
    });
    // The pre-mux microsecond denominator would admit 10,001 bytes; the authored MP4 cannot.
    expect(10_001).toBeLessThanOrEqual(averageBitrateByteBudget(800_000, 100_047));
    expect(audit.elementaryPayloadBytes).toBeGreaterThan(
      averageBitrateByteBudget(800_000, audit.presentationSpanUs),
    );
  });

  it('accounts for Annex-B start-code expansion before applying the hard byte gate', () => {
    const data = new Uint8Array(9_999).fill(0x55);
    data.set([0, 0, 1, 0x67], 0);
    data.set([0, 0, 1, 0x68], 5_003);
    const audit = auditMp4H264MuxedTrack(track, [
      { timestampUs: 0, durationUs: 100_000, key: true, data },
    ]);

    expect(data.byteLength).toBeLessThanOrEqual(averageBitrateByteBudget(800_000, 100_000));
    expect(audit).toMatchObject({
      elementaryPayloadBytes: 10_001,
      presentationSpanUs: 100_000,
      sampleCount: 1,
      preparedSampleByteLengths: [10_001],
    });
    expect(audit.elementaryPayloadBytes).toBeGreaterThan(
      averageBitrateByteBudget(800_000, audit.presentationSpanUs),
    );
  });

  it('matches progressive versus fragmented neutral-demux rounding for reordered PTS', () => {
    const chunks = [
      { ...avccSample(5, 33_350, 33_350), key: true },
      avccSample(5, 0, 33_301),
      avccSample(5, 66_651, 33_333),
    ];

    expect(auditMp4H264MuxedTrack(track, chunks).presentationSpanUs).toBe(99_966);
    expect(auditMp4H264MuxedTrack(track, chunks, { fragmented: true }).presentationSpanUs).toBe(
      99_967,
    );
  });

  it('bounds Annex-B NAL evidence independently of the compressed-byte spool', () => {
    const atLimit = repeatedAnnexBAccessUnit(MP4_H264_MAX_NAL_UNITS_PER_ACCESS_UNIT);
    expect(
      auditMp4H264MuxedTrack(track, [
        { timestampUs: 0, durationUs: 100_000, key: true, data: atLimit },
      ]),
    ).toMatchObject({
      elementaryPayloadBytes: MP4_H264_MAX_NAL_UNITS_PER_ACCESS_UNIT * 5,
      sampleCount: 1,
    });

    const overLimit = repeatedAnnexBAccessUnit(MP4_H264_MAX_NAL_UNITS_PER_ACCESS_UNIT + 1);
    expect(() =>
      auditMp4H264MuxedTrack(track, [
        { timestampUs: 0, durationUs: 100_000, key: true, data: overLimit },
      ]),
    ).toThrow(CapabilityError);
    try {
      auditMp4H264MuxedTrack(track, [
        { timestampUs: 0, durationUs: 100_000, key: true, data: overLimit },
      ]);
    } catch (error) {
      expect(error).toMatchObject({
        detail: expect.objectContaining({
          op: expect.objectContaining({
            id: 'mp4-h264-access-unit-evidence',
            facts: expect.objectContaining({
              maximumNalUnitsPerAccessUnit: MP4_H264_MAX_NAL_UNITS_PER_ACCESS_UNIT,
            }),
          }),
        }),
      });
    }
  });

  it('enforces avcC parameter-set counts before copying and skips unused sets with a description', () => {
    const parameterSets = [
      ...Array.from({ length: 32 }, (_, index) => Uint8Array.of(0x67, 0x42, 0xe0, index + 1)),
      Uint8Array.of(0x68, 0xce, 0x3c, 0x80),
    ];
    const data = annexBAccessUnit(parameterSets);
    const bareTrack: TrackInfo = {
      ...track,
      codec: 'h264',
      config: { codec: 'h264', codedWidth: 1920, codedHeight: 1080 },
    };

    expect(() =>
      auditMp4H264MuxedTrack(bareTrack, [{ timestampUs: 0, durationUs: 100_000, key: true, data }]),
    ).toThrow(/too many H.264 SPS parameter sets/);
    expect(
      auditMp4H264MuxedTrack(track, [{ timestampUs: 0, durationUs: 100_000, key: true, data }]),
    ).toMatchObject({ sampleCount: 1 });
  });
});

describe('replay-backed H.264 quality candidate runner', () => {
  it('typed-declines a counterfeit built-in ID whose selected object cannot prove sample accounting', async () => {
    const runtime = fakeRuntime();
    const counterfeitMp4: ContainerDriver = {
      id: 'mp4',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp4'],
      supports: runtime.container.supports,
      demux: runtime.container.demux,
      createMuxer: runtime.container.createMuxer,
    };
    const videoTarget = target(0.98);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const error = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      { driver: counterfeitMp4, format: 'mp4', muxOptions: { container: 'mp4' } },
      runtime.context,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({
      detail: expect.objectContaining({
        op: expect.objectContaining({
          id: 'h264-quality-output-audit',
          facts: { outputDriver: 'mp4', outputFormat: 'mp4' },
        }),
      }),
    });
    expect(runtime.state).toMatchObject({ demuxOpened: 0, demuxClosed: 0, muxersCreated: 0 });
  });

  it('forwards cancellation into a pending selected-driver audit and closes the encoded replay', async () => {
    const controller = new AbortController();
    const runtime = fakeRuntime();
    let forwardedSignal: AbortSignal | undefined;
    const pendingAuditDriver: ContainerDriver = {
      ...runtime.container,
      async auditMuxedTrack(_track, _packets, _options, signal): Promise<MuxedTrackAudit> {
        forwardedSignal = signal;
        controller.abort('caller stopped during mux audit');
        return new Promise<never>(() => {});
      },
    };
    const videoTarget = target(0.98);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const error = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      controller.signal,
      {},
      false,
      { ...runtime.outputRoute, driver: pendingAuditDriver },
      runtime.context,
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'aborted' });
    expect(forwardedSignal).toBe(controller.signal);
    expect(runtime.state).toMatchObject({ demuxOpened: 2, demuxClosed: 2, muxersCreated: 0 });
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
  });

  it('classifies malformed selected-driver audit evidence as a typed capability miss', async () => {
    const runtime = fakeRuntime();
    const malformedAuditDriver: ContainerDriver = {
      ...runtime.container,
      async auditMuxedTrack(): Promise<MuxedTrackAudit> {
        return {
          elementaryPayloadBytes: 1,
          preparedSampleByteLengths: [1n],
          presentationSpanUs: 1,
          sampleCount: 1,
        } as unknown as MuxedTrackAudit;
      },
    };
    const videoTarget = target(0.98);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const error = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      { ...runtime.outputRoute, driver: malformedAuditDriver },
      runtime.context,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({
      detail: expect.objectContaining({
        op: expect.objectContaining({ id: 'h264-quality-output-audit' }),
      }),
    });
    expect(runtime.state).toMatchObject({ demuxOpened: 2, demuxClosed: 2, muxersCreated: 0 });
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
  });

  it('uses measured undershoot to spend only declared max-rate headroom and publishes one valid spool', async () => {
    const runtime = fakeRuntime();
    const videoTarget = target(0.98);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');
    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {} satisfies CallOptions,
      false,
      runtime.outputRoute,
      runtime.context,
    );

    expect(candidate.attempts).toHaveLength(3);
    expect(candidate.attempts[0]).toMatchObject({ qualitySamples: 4 });
    expect(candidate.attempts[0]?.qualityMean).toBeLessThan(0.98);
    expect(candidate.attempts[1]?.qualityMean).toBeGreaterThanOrEqual(0.98);
    expect(candidate.attempts[2]?.qualityMean).toBeLessThan(0.98);
    expect(candidate.byteLength).toBe(candidate.attempts[1]?.actualBytes);
    expect(candidate.qualityMean).toBeGreaterThanOrEqual(0.98);
    expect(candidate.averageBitrate).toBeLessThanOrEqual(300_000);
    expect(candidate.chunks).toHaveLength(FRAME_COUNT);
    expect(candidate.track.config).toMatchObject({ codec: 'avc1.42E00A' });
    expect(runtime.state).toMatchObject({
      demuxOpened: 7,
      demuxClosed: 7,
      muxersCreated: 0,
    });
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
    expect(runtime.state.auditMuxOptions).toBe(runtime.outputRoute.muxOptions);
  });

  it('recovers the first-pass source replay from one initial native miss without reopening the demuxer', async () => {
    const dom = new DOMException('Decoding error', 'EncodingError');
    const primary = new CapabilityError(
      'source native runtime miss',
      { op: { kind: 'route', id: 'decode' }, tried: ['webcodecs-video'] },
      { cause: dom },
    );
    const runtime = fakeRuntime(undefined, {
      nativeDecoderFailure: { decoder: 1, error: primary },
    });
    const videoTarget = target(0.98);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    );

    expect(candidate.qualityMean).toBeGreaterThanOrEqual(request.quality.minimumMean);
    expect(runtime.state.softwareDecodersCreated).toBe(1);
    expect(runtime.state).toMatchObject({ demuxOpened: 7, demuxClosed: 7, muxersCreated: 0 });
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
    expect(primary.cause).toBe(dom);
  });

  it('recovers a private candidate from one initial native miss and closes every replay resource once', async () => {
    const primary = new CapabilityError(
      'private candidate native runtime miss',
      { op: { kind: 'route', id: 'decode' }, tried: ['webcodecs-video'] },
      { cause: new DOMException('Decoding error', 'EncodingError') },
    );
    const runtime = fakeRuntime(undefined, {
      // First pass, candidate encode replay, and measurement source are the first three native decoders.
      nativeDecoderFailure: { decoder: 4, error: primary },
    });
    const videoTarget = target(0.98);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    );

    expect(candidate.qualityMean).toBeGreaterThanOrEqual(request.quality.minimumMean);
    expect(runtime.state.softwareDecodersCreated).toBe(1);
    expect(runtime.state).toMatchObject({ demuxOpened: 7, demuxClosed: 7, muxersCreated: 0 });
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
  });

  it('retries a high-quality half-rate first candidate and returns the pass closer to preferred', async () => {
    const runtime = fakeRuntime(undefined, {
      candidateByteLengthFactors: [0.5, 0.5],
      candidateQualityQuantizers: [0, 0],
    });
    const videoTarget = target(0.99);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    );

    expect(candidate.attempts).toHaveLength(2);
    const first = candidate.attempts[0];
    const second = candidate.attempts[1];
    expect(first).toMatchObject({ qualitySamples: 4 });
    expect(first?.qualityMean).toBeGreaterThanOrEqual(0.99);
    expect(first?.averageBitrate).toBeLessThan(request.bitrate);
    expect(candidate.byteLength).toBe(second?.actualBytes);
    expect(Math.abs(candidate.averageBitrate - request.bitrate)).toBeLessThan(
      Math.abs((first?.averageBitrate ?? 0) - request.bitrate),
    );
  });

  it('keeps the earlier feasible spool when later retries exceed the hard ceiling', async () => {
    const runtime = fakeRuntime(undefined, {
      candidateByteLengthFactors: [0.5, 4, 20],
      candidateQualityQuantizers: [0, 0, 0],
    });
    const videoTarget = target(0.99);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    );

    expect(candidate.attempts).toHaveLength(3);
    expect(candidate.byteLength).toBe(candidate.attempts[0]?.actualBytes);
    expect(candidate.averageBitrate).toBe(candidate.attempts[0]?.averageBitrate);
    expect(candidate.attempts[1]?.averageBitrate).toBeGreaterThan(request.maxAverageBitrate);
    expect(candidate.attempts[2]?.averageBitrate).toBeGreaterThan(request.maxAverageBitrate);
  });

  it('retains only the closest of multiple feasible candidates', async () => {
    const runtime = fakeRuntime(undefined, {
      candidateByteLengthFactors: [0.5, 0.4, 0.1],
      candidateQualityQuantizers: [0, 0, 0],
    });
    const videoTarget = target(0.99);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    );

    const feasible = candidate.attempts.filter(
      (attempt) =>
        attempt.averageBitrate <= request.maxAverageBitrate &&
        (attempt.qualityMean ?? -1) >= request.quality.minimumMean,
    );
    expect(feasible).toHaveLength(3);
    const closest = feasible.reduce((best, attempt) =>
      Math.abs(attempt.averageBitrate - request.bitrate) <
      Math.abs(best.averageBitrate - request.bitrate)
        ? attempt
        : best,
    );
    expect(closest.attempt).toBe(2);
    expect(candidate.byteLength).toBe(closest.actualBytes);
  });

  it('terminates when preferred-rate recalibration cannot change a clamped schedule', async () => {
    const runtime = fakeRuntime(undefined, {
      candidateByteLengthFactors: [0.5],
      candidateQualityQuantizers: [0],
    });
    const videoTarget: VideoTarget = {
      ...target(0.99),
      bitrate: 5_000_000,
      maxAverageBitrate: 5_000_000,
    };
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    );

    expect(candidate.attempts).toHaveLength(1);
    expect(runtime.state.candidateQuantizers).toEqual([[0, 0, 0, 0]]);
    expect(candidate.averageBitrate).toBeLessThan(request.bitrate);
  });

  it('never retains an over-ceiling or below-quality candidate as the feasible fallback', async () => {
    const runtime = fakeRuntime(undefined, {
      candidateByteLengthFactors: [2, 1],
      candidateQualityQuantizers: [0, 51],
    });
    const videoTarget = target(0.99);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const error = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ConstraintUnsatisfiedError);
    const attempts = (error as ConstraintUnsatisfiedError).detail.attempts;
    expect(attempts[0]?.averageBitrate).toBeGreaterThan(request.maxAverageBitrate);
    expect(attempts[0]?.qualityMean).toBeUndefined();
    expect(attempts[1]?.averageBitrate).toBeLessThanOrEqual(request.maxAverageBitrate);
    expect(attempts[1]?.qualityMean).toBeLessThan(request.quality.minimumMean);
  });

  it('falls back to an audited native-rate candidate when scheduled QPs cannot meet quality', async () => {
    const runtime = fakeRuntime(undefined, {
      candidateQualityQuantizers: [51, 51, 51, 0],
    });
    const videoTarget = target(0.99);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    );

    expect(candidate.qualityMean).toBeGreaterThanOrEqual(request.quality.minimumMean);
    expect(candidate.averageBitrate).toBeLessThanOrEqual(request.maxAverageBitrate);
    // The scheduled-QP passes come first (no `bitrate` on the encoder config) and exhaust their budget
    // before the native rate controller is asked for anything; the winning native pass carries the
    // rate-control warm-up frames.
    const nativeIndex = runtime.state.candidateBitrates.findIndex((rate) => rate !== undefined);
    expect(nativeIndex).toBe(MAXIMUM_CANDIDATE_PASSES);
    expect(
      runtime.state.candidateBitrates.slice(0, nativeIndex).every((r) => r === undefined),
    ).toBe(true);
    expect(runtime.state.candidateBitrates[nativeIndex]).toBe(request.maxAverageBitrate);
    expect(runtime.state.candidateQuantizers[nativeIndex]).toEqual([28, 28, 28, 28]);
    expect(runtime.state.candidateRateControlWarmupFrames[nativeIndex]).toBe(3);
    expect(
      runtime.state.candidateRateControlWarmupFrames
        .slice(0, nativeIndex)
        .every((f) => f === undefined),
    ).toBe(true);
  });

  it('rejects an over-cap native candidate and corrects its controller request downward', async () => {
    const runtime = fakeRuntime(undefined, {
      // The scheduled-QP passes run first, so the over-cap candidate is placed on the FIRST native pass.
      candidateByteLengthFactors: [1, 1, 1, 2, 1],
      candidateQualityQuantizers: [51, 51, 51, 0, 0],
    });
    const videoTarget = target(0.99);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    );

    const nativeIndex = runtime.state.candidateBitrates.findIndex((rate) => rate !== undefined);
    expect(nativeIndex).toBeGreaterThanOrEqual(0);
    expect(candidate.attempts[nativeIndex]?.averageBitrate).toBeGreaterThan(
      request.maxAverageBitrate,
    );
    expect(candidate.attempts[nativeIndex]?.qualityMean).toBeUndefined();
    expect(candidate.qualityMean).toBeGreaterThanOrEqual(request.quality.minimumMean);
    expect(runtime.state.candidateBitrates[nativeIndex]).toBe(request.maxAverageBitrate);
    // The over-cap response must move the controller request by a resolvable amount, not a rounding step.
    const corrected = runtime.state.candidateBitrates[nativeIndex + 1] as number;
    expect(corrected).toBeLessThanOrEqual(request.maxAverageBitrate * (1 - 0.01));
  });

  it('retains no over-spool native bytes before a later bounded candidate succeeds', async () => {
    const runtime = fakeRuntime(undefined, {
      candidateByteLengthFactors: [1, 1, 50_000, 1],
      candidateQualityQuantizers: [51, 51, 0, 0],
    });
    const videoTarget = target(0.99);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const candidate = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    );

    expect(candidate.attempts).toHaveLength(4);
    expect(candidate.attempts[2]?.actualBytes).toBeGreaterThan(
      H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES,
    );
    expect(candidate.attempts[2]?.qualityMean).toBeUndefined();
    expect(candidate.qualityMean).toBeGreaterThanOrEqual(request.quality.minimumMean);
    expect(runtime.state.muxersCreated).toBe(0);
  });

  it('returns typed bounded evidence and no muxed output when the declared floor is impossible', async () => {
    const runtime = fakeRuntime();
    const videoTarget = target(1);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const error = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ConstraintUnsatisfiedError);
    expect(error).toMatchObject({
      code: 'constraint-unsatisfied',
      detail: {
        constraint: 'h264-quality-rate',
        preferredAverageBitrate: 160_000,
        maxAverageBitrate: 300_000,
      },
    });
    expect((error as ConstraintUnsatisfiedError).detail.attempts.length).toBeGreaterThan(0);
    expect((error as ConstraintUnsatisfiedError).detail.attempts.length).toBeLessThanOrEqual(6);
    expect(runtime.state.muxersCreated).toBe(0);
    expect(runtime.state.demuxClosed).toBe(runtime.state.demuxOpened);
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
  });

  it('rejects a candidate that changes raw picture duration before quality scoring or mux publication', async () => {
    const runtime = fakeRuntime(undefined, { candidateDurationDeltaUs: 1 });
    const videoTarget = target(0.98);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const error = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(InputError);
    expect(error).toMatchObject({ message: expect.stringMatching(/changed picture duration/) });
    expect(runtime.state).toMatchObject({ demuxOpened: 2, demuxClosed: 2, muxersCreated: 0 });
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
  });

  it('closes the prepared source replay when candidate decoder routing fails during quality setup', async () => {
    const primary = new Error('candidate decoder route failed');
    const runtime = fakeRuntime(undefined, { qualityDecoderRouteError: primary });
    const videoTarget = target(0.98);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const error = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    ).catch((reason: unknown) => reason);

    expect(error).toBe(primary);
    expect(runtime.state).toMatchObject({ demuxOpened: 3, demuxClosed: 3, muxersCreated: 0 });
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
  });

  it('fails with a typed operational limit before opening an over-cap candidate replay', async () => {
    const runtime = fakeRuntime();
    const durationUs = FRAME_COUNT * FRAME_DURATION_US;
    const overCapRate = Math.ceil(
      ((H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES + 1) * 8_000_000) / durationUs,
    );
    const videoTarget: VideoTarget = {
      ...target(0.98),
      maxAverageBitrate: overCapRate,
    };
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const error = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      new AbortController().signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({
      detail: expect.objectContaining({
        op: expect.objectContaining({ id: 'h264-quality-candidate-spool' }),
      }),
    });
    expect(runtime.state).toMatchObject({ demuxOpened: 1, demuxClosed: 1, muxersCreated: 0 });
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
  });

  it('races cancellation through the first pass and closes every opened resource', async () => {
    const controller = new AbortController();
    let encodedChunks = 0;
    const runtime = fakeRuntime(() => {
      encodedChunks++;
      if (encodedChunks === 1) controller.abort('caller stopped');
    });
    const videoTarget = target(0.98);
    const request = assertH264QualityConstraintPreflight(videoTarget, runtime.source);
    if (request === undefined) throw new Error('expected quality request');

    const error = await analyzeH264QualityConstrained(
      runtime.source,
      runtime.container,
      videoTarget,
      request,
      controller.signal,
      {},
      false,
      runtime.outputRoute,
      runtime.context,
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'aborted' });
    expect(runtime.state.muxersCreated).toBe(0);
    expect(runtime.state.demuxOpened).toBe(1);
    expect(runtime.state.demuxClosed).toBe(runtime.state.demuxOpened);
    expect(runtime.state.framesClosed).toBe(runtime.state.framesCreated);
  });
});
