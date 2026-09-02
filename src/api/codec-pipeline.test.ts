/**
 * Unit tests for the codec-tier pipeline helpers (`./codec-pipeline.ts`) — the pure routing + config
 * normalization that turns public convert/encode options into concrete WebCodecs `EncoderConfig`s,
 * `FilterSpec` chains, mux `TrackInfo`s, container choices, and the seek control flow. These are real,
 * can-fail oracles (exact expected values, not smoke) and run with NO WebCodecs — the live frame
 * round-trips are validated in the browser harness. Frame/chunk-touching functions (`seekFrame`,
 * `drainEncoderToMuxer`) are exercised with fake closable items so close-once and ordering are pinned.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  DecoderConfig,
  EncodedChunk,
  FilterSpec,
  Packet,
  RawFrame,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { audioFilterSpecs } from './audio-stream-plan.ts';
import {
  FIREFOX_ADTS_AAC_LEADING_SAMPLES,
  audioCodecToken,
  audioDecodeLeadingSamplesForRuntime,
  audioDecodeNativeGaplessSuppressionForRuntime,
  audioEncodeNeedsSoftwareRuntime,
  audioEncodeSoftwareDriverForRuntime,
  audioEncoderCodecString,
  audioTargetCanBypassFilterPlanner,
  audioTrackAfterLeadingSampleTrim,
  audioTrackAfterNativeGaplessSuppression,
  audioTrackInfoFromDecoderConfig,
  buildAudioEncoderConfig,
  buildVideoEncoderConfig,
  buildVideoEncoderConfigForRuntime,
  canCopyAudioTrackToContainer,
  canCopyVpxAlphaSideData,
  canDeferVpxAlphaFrameRepack,
  canUseVpxAlphaGeometryPacketTranscode,
  canUseVpxAlphaPacketTranscode,
  chooseOutputContainer,
  containerHasChunkMuxer,
  createDrainTaskGroup,
  decodeVideoPacketsWithAlpha,
  defaultOpusAudioEncodeTarget,
  drainEncoderToMuxer,
  encodeVideoFramesWithAlpha,
  encodeVpxAlphaFrameStreams,
  firefoxAdtsAacLeadingSamples,
  firefoxAudioTranscodeDeclineReason,
  firefoxOpusAudioEncodeTarget,
  firefoxOpusEncodeUsesWasm,
  firefoxVideoTranscodeDeclineReason,
  firefoxVorbisEncodeUsesWasm,
  frameSatisfiesSeek,
  h264CodecStringForDimensions,
  h264LevelIdcForDimensions,
  hasTrackSelection,
  isPcmContainer,
  isPureStreamCopy,
  isUnsupportedHevcEncodeProfile,
  mergeVpxAlphaLuma,
  mergeVpxAlphaRgba,
  normalizeDecoderCodec,
  outputDimensions,
  outputGaplessForAudioEncoder,
  outputVideoRotation,
  periodicVideoKeyFrameInterval,
  qualifiedVideoSourceCodec,
  resolveAudioEncodeTargetForRuntime,
  resolveVideoEncoderCodecString,
  seekFrame,
  selectTrackInfos,
  sourceVideoBitrateFromPacketStats,
  sourceVideoBitrateFromPacketTable,
  splitRgbaForVpxAlpha,
  transcodeVpxAlphaPackets,
  unwrapPackets,
  videoCodecToken,
  videoLatencyMode,
  videoPixelRotation,
  videoTrackInfoFromDecoderConfig,
  vpxAlphaDecodeSoftwareDriverForRuntime,
  vpxAlphaI420FromPackedGrayscale,
  vpxAlphaI420FromPackedRgba,
  vpxAlphaI420FromPlane,
  webkitAdtsAacLeadingSamples,
  webkitCrossCodecH264Config,
  webkitVideoTranscodeDeclineReason,
} from './codec-pipeline.ts';
import {
  CADENCE_BASELINE_FPS,
  EVIDENCE_BITRATE_FLOOR,
  EVIDENCE_BITRATE_HEADROOM,
  HIGH_CADENCE_FPS_THRESHOLD,
  IMPLICIT_BITS_PER_PIXEL_PER_SECOND,
  IMPLICIT_VIDEO_BITRATE_FLOOR,
  VIDEO_CODEC_RATE_EFFICIENCY,
} from './encoder-config.ts';
import { selectDecodeTrackInfo } from './track-select.ts';
import type { VideoTarget } from './types.ts';
import {
  planCfrFrameRetiming,
  planH264AbrLadder,
  planVideoBitDepthConversion,
  planVideoRateControl,
  retimeTimedFrameStream,
  videoFilterRouteCost,
  videoFilterSpecs,
} from './video-stream-plan.ts';

async function withNavigator<T>(value: unknown, fn: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value,
  });
  try {
    return await fn();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(globalThis, 'navigator', original);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  }
}

async function withVideoFrameConstructor<T>(
  value: typeof VideoFrame,
  fn: () => T | Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    value,
  });
  try {
    return await fn();
  } finally {
    if (original !== undefined) Object.defineProperty(globalThis, 'VideoFrame', original);
    else Reflect.deleteProperty(globalThis, 'VideoFrame');
  }
}

interface AlphaLifecycleFrameInit {
  readonly timestamp: number;
  readonly format?: VideoPixelFormat | null;
  readonly duration?: number | null;
  readonly clones?: AlphaLifecycleFrame[];
}

class AlphaLifecycleFrame {
  readonly codedWidth = 2;
  readonly codedHeight = 2;
  readonly displayWidth = 2;
  readonly displayHeight = 2;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly format: VideoPixelFormat | null;
  readonly #clones: AlphaLifecycleFrame[] | undefined;
  closeCount = 0;

  constructor(init: AlphaLifecycleFrameInit) {
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.format = init.format ?? null;
    this.#clones = init.clones;
  }

  allocationSize(): number {
    return 16;
  }

  copyTo(destination: AllowSharedBufferSource): Promise<readonly PlaneLayout[]> {
    const bytes = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    bytes.set([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
    return Promise.resolve([{ offset: 0, stride: 8 }]);
  }

  clone(): VideoFrame {
    const clone = new AlphaLifecycleFrame({
      timestamp: this.timestamp,
      format: this.format,
      duration: this.duration,
    });
    this.#clones?.push(clone);
    return clone as unknown as VideoFrame;
  }

  close(): void {
    this.closeCount++;
  }
}

function alphaVideoFrameConstructor(
  constructed: AlphaLifecycleFrame[],
  failAtConstruction?: number,
): typeof VideoFrame {
  let constructionCount = 0;
  function FakeVideoFrame(
    _data: AllowSharedBufferSource,
    init: VideoFrameBufferInit,
  ): AlphaLifecycleFrame {
    constructionCount++;
    if (constructionCount === failAtConstruction)
      throw new Error('derived frame construction failed');
    const frame = new AlphaLifecycleFrame({
      timestamp: init.timestamp,
      format: 'RGBA',
      duration: init.duration ?? null,
    });
    constructed.push(frame);
    return frame;
  }
  return FakeVideoFrame as unknown as typeof VideoFrame;
}

function alphaEncodedChunk(timestamp: number): EncodedChunk {
  return { timestamp } as unknown as EncodedChunk;
}

function alphaPacket(timestamp: number, alphaTimestamp?: number): Packet {
  return {
    chunk: alphaEncodedChunk(timestamp),
    ...(alphaTimestamp === undefined
      ? {}
      : { alpha: alphaEncodedChunk(alphaTimestamp) as EncodedVideoChunk }),
  };
}

describe('splitRgbaForVpxAlpha', () => {
  it('turns RGBA pixels into opaque color plus grayscale alpha planes', () => {
    const split = splitRgbaForVpxAlpha({
      width: 3,
      height: 1,
      data: Uint8ClampedArray.from([10, 20, 30, 0, 40, 50, 60, 127, 70, 80, 90, 255]),
    });

    expect([...split.color.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
    expect([...split.alpha.data]).toEqual([0, 0, 0, 255, 127, 127, 127, 255, 255, 255, 255, 255]);
  });
});

describe('mergeVpxAlphaRgba', () => {
  it('preserves randomized RGB bytes and takes alpha from the grayscale red channel', () => {
    let state = 0x8c03_d274;
    const nextByte = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state >>> 24;
    };
    const color = Uint8ClampedArray.from({ length: 4_096 * 4 }, nextByte);
    const alpha = Uint8ClampedArray.from({ length: color.length }, nextByte);
    const expected = color.slice();
    for (let offset = 0; offset < expected.length; offset += 4) {
      expected[offset + 3] = alpha[offset] as number;
    }

    mergeVpxAlphaRgba(color, alpha);

    expect(color).toEqual(expected);
  });

  it('preserves exact bytes for unaligned views through the portable path', () => {
    const colorBacking = Uint8ClampedArray.from([99, 10, 20, 30, 40, 50, 60, 70, 80, 88]);
    const alphaBacking = Uint8ClampedArray.from([77, 1, 2, 3, 4, 5, 6, 7, 8, 66]);
    const color = colorBacking.subarray(1, 9);
    const alpha = alphaBacking.subarray(1, 9);

    mergeVpxAlphaRgba(color, alpha);

    expect([...colorBacking]).toEqual([99, 10, 20, 30, 1, 50, 60, 70, 5, 88]);
  });
});

describe('mergeVpxAlphaLuma', () => {
  it('takes one full-swing luma byte per pixel without video-range conversion', () => {
    const color = Uint8ClampedArray.from([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
    ]);

    mergeVpxAlphaLuma(color, Uint8Array.from([0, 15, 16, 254]));

    expect([...color]).toEqual([10, 20, 30, 0, 40, 50, 60, 15, 70, 80, 90, 16, 100, 110, 120, 254]);
  });

  it('rejects a truncated alpha plane', () => {
    expect(() => mergeVpxAlphaLuma(new Uint8ClampedArray(8), new Uint8Array(1))).toThrow(
      'VPx alpha luma has 1 bytes for 8 RGBA bytes',
    );
  });

  it('unit: aligned Uint32 fast path matches portable byte loop', () => {
    const colorAligned = Uint8ClampedArray.from([
      1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255,
    ]);
    const alpha = Uint8Array.from([10, 20, 30, 40]);
    const backing = new ArrayBuffer(32);
    const unalignedColor = new Uint8ClampedArray(backing, 1, 16);
    unalignedColor.set(colorAligned);
    const unalignedAlpha = Uint8Array.from([10, 20, 30, 40]);
    mergeVpxAlphaLuma(colorAligned, alpha);
    mergeVpxAlphaLuma(unalignedColor, unalignedAlpha);
    expect([...colorAligned]).toEqual([...unalignedColor]);
    expect([...colorAligned]).toEqual([1, 2, 3, 10, 4, 5, 6, 20, 7, 8, 9, 30, 10, 11, 12, 40]);
  });

  it('property: randomized RGB preserved and alpha channel set exactly', () => {
    let seed = 0x1234_5678;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 24) & 0xff;
    };
    for (let trial = 0; trial < 20; trial++) {
      const pixels = 16 + (next() % 64);
      const color = Uint8ClampedArray.from({ length: pixels * 4 }, next);
      const alpha = Uint8Array.from({ length: pixels }, next);
      const expectedAlpha = alpha.slice();
      const expectedRgb = color.slice();
      for (let i = 0; i < pixels; i++) expectedRgb[i * 4 + 3] = expectedAlpha[i] as number;
      mergeVpxAlphaLuma(color, alpha);
      for (let i = 0; i < pixels; i++) {
        expect(color[i * 4]).toBe(expectedRgb[i * 4]);
        expect(color[i * 4 + 1]).toBe(expectedRgb[i * 4 + 1]);
        expect(color[i * 4 + 2]).toBe(expectedRgb[i * 4 + 2]);
        expect(color[i * 4 + 3]).toBe(expectedAlpha[i]);
      }
    }
  });

  it('boundary: handles 0, 1, and large pixel counts', () => {
    const empty = new Uint8ClampedArray(0);
    mergeVpxAlphaLuma(empty, new Uint8Array(0));
    expect(empty.length).toBe(0);
    const one = Uint8ClampedArray.from([9, 9, 9, 255]);
    mergeVpxAlphaLuma(one, Uint8Array.from([7]));
    expect([...one]).toEqual([9, 9, 9, 7]);
    const largePixels = 1024;
    const largeColor = new Uint8ClampedArray(largePixels * 4).fill(128);
    const largeAlpha = new Uint8Array(largePixels).fill(64);
    mergeVpxAlphaLuma(largeColor, largeAlpha);
    for (let i = 0; i < largePixels; i++) expect(largeColor[i * 4 + 3]).toBe(64);
  });

  it('malformed: rejects non-multiple-of-4 color length and short alpha', () => {
    expect(() => mergeVpxAlphaLuma(new Uint8ClampedArray(3), new Uint8Array(1))).toThrow(
      'VPx alpha luma has 1 bytes for 3 RGBA bytes',
    );
    expect(() => mergeVpxAlphaLuma(new Uint8ClampedArray(4), new Uint8Array(0))).toThrow(
      'VPx alpha luma has 0 bytes for 4 RGBA bytes',
    );
    expect(() => mergeVpxAlphaLuma(new Uint8ClampedArray(8), new Uint8Array(1))).toThrow(
      'VPx alpha luma has 1 bytes for 8 RGBA bytes',
    );
  });

  it('randomized: 20 fuzzed merges are byte-exact vs reference loop', () => {
    let state = 0x9e37_79b9;
    const rnd = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state & 0xff;
    };
    for (let t = 0; t < 20; t++) {
      const pixels = 1 + (rnd() % 128);
      const color = Uint8ClampedArray.from({ length: pixels * 4 }, rnd);
      const alpha = Uint8Array.from({ length: pixels }, rnd);
      const ref = color.slice();
      for (let i = 0; i < pixels; i++) ref[i * 4 + 3] = alpha[i] as number;
      mergeVpxAlphaLuma(color, alpha);
      expect([...color]).toEqual([...ref]);
    }
  });
});

describe('vpxAlphaI420FromPackedRgba', () => {
  it('packs alpha bytes into an I420 luma plane with neutral chroma', () => {
    const source = new Uint8Array([
      99, 10, 20, 30, 1, 40, 50, 60, 2, 0, 0, 0, 0, 70, 80, 90, 3, 100, 110, 120, 4,
    ]);
    const split = vpxAlphaI420FromPackedRgba(source, 2, 2, { offset: 1, stride: 12 }, 'RGBA');

    expect(split.layout).toEqual([
      { offset: 0, stride: 2 },
      { offset: 4, stride: 1 },
      { offset: 5, stride: 1 },
    ]);
    expect([...split.data]).toEqual([1, 2, 3, 4, 128, 128]);
  });

  it('accepts BGRA and rejects malformed packed alpha sources with typed errors', () => {
    const bgra = Uint8Array.from([1, 2, 3, 4]);
    const split = vpxAlphaI420FromPackedRgba(bgra, 1, 1, { offset: 0, stride: 4 }, 'BGRA');

    expect([...split.data]).toEqual([4, 128, 128]);
    expect(() => vpxAlphaI420FromPackedRgba(bgra, 0, 1, { offset: 0, stride: 4 }, 'RGBA')).toThrow(
      MediaError,
    );
    expect(() => vpxAlphaI420FromPackedRgba(bgra, 1, 1, { offset: 0, stride: 3 }, 'RGBA')).toThrow(
      MediaError,
    );
    expect(() => vpxAlphaI420FromPackedRgba(bgra, 2, 1, { offset: 0, stride: 8 }, 'RGBA')).toThrow(
      MediaError,
    );
    expect(() =>
      vpxAlphaI420FromPackedRgba(bgra, 1, 1, { offset: 0, stride: 4 }, 'ARGB' as never),
    ).toThrow(MediaError);
  });
});

describe('vpxAlphaI420FromPackedGrayscale', () => {
  it('keeps full-swing grayscale endpoints instead of introducing studio-range 16/235 offsets', () => {
    const rgba = Uint8Array.from([0, 7, 8, 255, 127, 1, 2, 255, 255, 3, 4, 255]);
    const bgra = Uint8Array.from([8, 7, 0, 255, 2, 1, 127, 255, 4, 3, 255, 255]);

    expect([
      ...vpxAlphaI420FromPackedGrayscale(rgba, 3, 1, { offset: 0, stride: 12 }, 'RGBA').data,
    ]).toEqual([0, 127, 255, 128, 128, 128, 128]);
    expect([
      ...vpxAlphaI420FromPackedGrayscale(bgra, 3, 1, { offset: 0, stride: 12 }, 'BGRA').data,
    ]).toEqual([0, 127, 255, 128, 128, 128, 128]);
  });
});

describe('canDeferVpxAlphaFrameRepack', () => {
  it('recognizes deferred display-size scales that need coded-raster repacking', () => {
    const frame = {
      format: 'I420' as const,
      codedWidth: 640,
      codedHeight: 480,
      displayWidth: 320,
      displayHeight: 240,
    };
    expect(canDeferVpxAlphaFrameRepack(frame)).toBe(true);
    expect(
      canDeferVpxAlphaFrameRepack({
        ...frame,
        codedWidth: 320,
        codedHeight: 240,
      }),
    ).toBe(false);
  });
});

describe('vpxAlphaI420FromPlane', () => {
  it('copies a padded full-resolution alpha plane into compact odd-dimension I420', () => {
    const source = Uint8Array.from([0, 0, 11, 12, 13, 0, 0, 21, 22, 23, 0, 0]);
    const split = vpxAlphaI420FromPlane(source, 3, 2, { offset: 2, stride: 5 });

    expect(split.layout).toEqual([
      { offset: 0, stride: 3 },
      { offset: 6, stride: 2 },
      { offset: 8, stride: 2 },
    ]);
    expect([...split.data]).toEqual([11, 12, 13, 21, 22, 23, 128, 128, 128, 128]);
  });

  it('rejects invalid alpha plane geometry with typed errors', () => {
    expect(() => vpxAlphaI420FromPlane(Uint8Array.of(1), 1, 0, { offset: 0, stride: 1 })).toThrow(
      MediaError,
    );
    expect(() => vpxAlphaI420FromPlane(Uint8Array.of(1), 1, 1, { offset: -1, stride: 1 })).toThrow(
      MediaError,
    );
    expect(() => vpxAlphaI420FromPlane(Uint8Array.of(1), 1, 1, { offset: 0, stride: 0 })).toThrow(
      MediaError,
    );
    expect(() => vpxAlphaI420FromPlane(Uint8Array.of(1), 2, 1, { offset: 0, stride: 2 })).toThrow(
      MediaError,
    );
  });
});

describe('encodeVideoFramesWithAlpha frame ownership', () => {
  const rejectingEncoder = (
    _config: VideoEncoderConfig,
    _options?: StageOptions,
  ): TransformStream<RawFrame, EncodedChunk> =>
    new TransformStream<RawFrame, EncodedChunk>(
      {
        transform(frame): void {
          frame.close();
          throw new Error('encoder rejected frame');
        },
      },
      undefined,
      { highWaterMark: 1 },
    );

  const passEncoder = (
    _config: VideoEncoderConfig,
    _options?: StageOptions,
  ): TransformStream<RawFrame, EncodedChunk> =>
    new TransformStream<RawFrame, EncodedChunk>(
      {
        transform(frame, controller): void {
          frame.close();
          controller.enqueue(alphaEncodedChunk(frame.timestamp));
        },
      },
      undefined,
      { highWaterMark: 1 },
    );

  it('closes a constructed fallback color frame when alpha-frame construction fails', async () => {
    const constructed: AlphaLifecycleFrame[] = [];
    const input = new AlphaLifecycleFrame({ timestamp: 100 });

    await withVideoFrameConstructor(alphaVideoFrameConstructor(constructed, 2), async () => {
      const reader = encodeVideoFramesWithAlpha(streamOf([input as unknown as VideoFrame]), {
        config: { codec: 'vp09.02.31.10', width: 2, height: 2 },
        createEncoder: passEncoder,
      }).getReader();

      await expect(reader.read()).rejects.toThrow('derived frame construction failed');
    });

    expect(input.closeCount).toBe(1);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.closeCount).toBe(1);
  });

  it('does not close derived frames again after writer.write transfers them to an encoder', async () => {
    const derived: AlphaLifecycleFrame[] = [];
    const input = new AlphaLifecycleFrame({
      timestamp: 100,
      format: 'RGBA',
      clones: derived,
    });

    await withVideoFrameConstructor(alphaVideoFrameConstructor(derived), async () => {
      const reader = encodeVideoFramesWithAlpha(streamOf([input as unknown as VideoFrame]), {
        config: { codec: 'vp09.00.31.08', width: 2, height: 2 },
        createEncoder: rejectingEncoder,
      }).getReader();

      await expect(reader.read()).rejects.toThrow('encoder rejected frame');
    });

    expect(input.closeCount).toBe(1);
    expect(derived).toHaveLength(2);
    expect(derived.map((frame) => frame.closeCount)).toEqual([1, 1]);
  });
});

describe('encodeVpxAlphaFrameStreams', () => {
  const passEncoder = (
    _config: VideoEncoderConfig,
    _options?: StageOptions,
  ): TransformStream<RawFrame, EncodedChunk> =>
    new TransformStream<RawFrame, EncodedChunk>({
      transform(frame, controller): void {
        const timestamp =
          frame instanceof Object && 'timestamp' in frame
            ? (frame as { readonly timestamp: number }).timestamp
            : -1;
        frame.close();
        controller.enqueue(alphaEncodedChunk(timestamp));
      },
    });

  it('pairs independently resized plane outputs by timestamp and closes each input once', async () => {
    const color = [
      new AlphaLifecycleFrame({ timestamp: 100 }),
      new AlphaLifecycleFrame({ timestamp: 200 }),
    ];
    const alpha = [
      new AlphaLifecycleFrame({ timestamp: 100 }),
      new AlphaLifecycleFrame({ timestamp: 200 }),
    ];
    const reader = encodeVpxAlphaFrameStreams(
      streamOf(color as unknown as VideoFrame[]),
      streamOf(alpha as unknown as VideoFrame[]),
      {
        encodeConfig: { codec: 'vp09.00.31.08', width: 320, height: 240 },
        createEncoder: passEncoder,
      },
    ).getReader();
    const first = await reader.read();
    const second = await reader.read();
    const end = await reader.read();

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(end.done).toBe(true);
    expect(first.value?.chunk.timestamp).toBe(100);
    expect(first.value?.alpha?.timestamp).toBe(100);
    expect(second.value?.chunk.timestamp).toBe(200);
    expect(second.value?.alpha?.timestamp).toBe(200);
    expect(color.map((frame) => frame.closeCount)).toEqual([1, 1]);
    expect(alpha.map((frame) => frame.closeCount)).toEqual([1, 1]);
  });
});

describe('decodeVideoPacketsWithAlpha frame ownership', () => {
  const passDecoder = (): TransformStream<EncodedChunk, RawFrame> =>
    new TransformStream<EncodedChunk, RawFrame>({
      transform(frame, controller): void {
        controller.enqueue(frame as unknown as RawFrame);
      },
    });

  it('cancels the alpha decoder when the color stream reaches EOF', async () => {
    let decoderCount = 0;
    let alphaCancelCount = 0;
    const createDecoder = (): TransformStream<EncodedChunk, RawFrame> => {
      decoderCount++;
      if (decoderCount === 1) return passDecoder();
      return {
        readable: new ReadableStream<RawFrame>({
          cancel(): void {
            alphaCancelCount++;
          },
        }),
        writable: new WritableStream<EncodedChunk>(),
      } as TransformStream<EncodedChunk, RawFrame>;
    };

    const result = await decodeVideoPacketsWithAlpha(streamOf<Packet>([]), createDecoder)
      .getReader()
      .read();

    expect(result.done).toBe(true);
    expect(alphaCancelCount).toBe(1);
  });

  it('closes cached alpha frames and cancels the alpha sibling when color decode fails', async () => {
    const color = new AlphaLifecycleFrame({ timestamp: 100, format: 'RGBA' });
    const futureAlpha = new AlphaLifecycleFrame({
      timestamp: 200,
      format: 'RGBA',
    });
    let decoderCount = 0;
    let alphaCancelCount = 0;
    const createDecoder = (): TransformStream<EncodedChunk, RawFrame> => {
      decoderCount++;
      if (decoderCount === 1) {
        return new TransformStream<EncodedChunk, RawFrame>({
          transform(chunk, controller): void {
            if (chunk.timestamp === 300) throw new Error('color decode failed');
            controller.enqueue(color as unknown as RawFrame);
          },
        });
      }
      return {
        readable: new ReadableStream<RawFrame>({
          start(controller): void {
            controller.enqueue(futureAlpha as unknown as RawFrame);
          },
          cancel(): void {
            alphaCancelCount++;
          },
        }),
        writable: new WritableStream<EncodedChunk>(),
      } as TransformStream<EncodedChunk, RawFrame>;
    };
    const reader = decodeVideoPacketsWithAlpha(
      streamOf([alphaPacket(100, 200), alphaPacket(300)]),
      createDecoder,
    ).getReader();

    const first = await reader.read();
    if (first.done) throw new Error('expected a color frame before decoder failure');
    first.value.close();
    await expect(reader.read()).rejects.toThrow('color decode failed');

    expect(color.closeCount).toBe(1);
    expect(futureAlpha.closeCount).toBe(1);
    expect(alphaCancelCount).toBe(1);
  });

  it('closes cached alpha frames exactly once on downstream cancellation', async () => {
    const color = new AlphaLifecycleFrame({ timestamp: 100, format: 'RGBA' });
    const futureAlpha = new AlphaLifecycleFrame({
      timestamp: 200,
      format: 'RGBA',
    });
    let decoderCount = 0;
    let alphaCancelCount = 0;
    const createDecoder = (): TransformStream<EncodedChunk, RawFrame> => {
      decoderCount++;
      if (decoderCount === 1) {
        return new TransformStream<EncodedChunk, RawFrame>({
          transform(_chunk, controller): void {
            controller.enqueue(color as unknown as RawFrame);
          },
        });
      }
      return {
        readable: new ReadableStream<RawFrame>({
          start(controller): void {
            controller.enqueue(futureAlpha as unknown as RawFrame);
          },
          cancel(): void {
            alphaCancelCount++;
          },
        }),
        writable: new WritableStream<EncodedChunk>(),
      } as TransformStream<EncodedChunk, RawFrame>;
    };
    const reader = decodeVideoPacketsWithAlpha(
      streamOf([alphaPacket(100, 200)]),
      createDecoder,
    ).getReader();

    const first = await reader.read();
    if (first.done) throw new Error('expected a color frame before cancellation');
    first.value.close();
    await reader.cancel('test cancellation');

    expect(color.closeCount).toBe(1);
    expect(futureAlpha.closeCount).toBe(1);
    expect(alphaCancelCount).toBe(1);
  });
});

describe('canUseVpxAlphaPacketTranscode', () => {
  it('allows only unfiltered alpha-preserving packet-plane transcodes', () => {
    const canUse = (
      target: VideoTarget,
      sourceHasAlpha = true,
      sourceCodec = 'vp09.00.31.08',
      targetCodec = 'vp09.00.31.08',
    ): boolean => canUseVpxAlphaPacketTranscode(target, sourceHasAlpha, sourceCodec, targetCodec);

    expect(canUse({ codec: 'vp8', alpha: 'keep' })).toBe(true);
    expect(canUse({ codec: 'vp8', alpha: 'discard' })).toBe(false);
    expect(canUse({ codec: 'vp8', alpha: 'keep' }, false)).toBe(false);
    expect(canUse({ codec: 'vp9', alpha: 'keep', width: 320 })).toBe(false);
    expect(canUse({ codec: 'vp9', alpha: 'keep', fps: 24 })).toBe(false);
    expect(canUse({ codec: 'vp9', alpha: 'keep', rotate: 90 })).toBe(false);
    expect(canUse({ codec: 'vp9', alpha: 'keep', height: 180 })).toBe(false);
    expect(
      canUse({
        codec: 'vp9',
        alpha: 'keep',
        crop: { x: 0, y: 0, width: 16, height: 16 },
      }),
    ).toBe(false);
    expect(canUse({ codec: 'vp9', alpha: 'keep', pad: { width: 640, height: 480 } })).toBe(false);
    expect(canUse({ codec: 'vp9', alpha: 'keep', flip: 'h' })).toBe(false);
    expect(canUse({ codec: 'vp9', alpha: 'keep', colorspace: { to: 'bt709' } })).toBe(false);
    expect(canUse({ codec: 'vp9', alpha: 'keep', tonemap: { to: 'sdr' } })).toBe(false);
    expect(
      canUse({ codec: 'vp9', alpha: 'keep', bitDepth: 12 }, true, 'vp09.02.31.12', 'vp09.02.31.12'),
    ).toBe(true);
    expect(
      canUse({ codec: 'vp9', alpha: 'keep', bitDepth: 10 }, true, 'vp09.02.31.12', 'vp09.02.31.10'),
    ).toBe(false);
    expect(canUse({ codec: 'vp9', alpha: 'keep' }, true, 'vp9', 'vp09.00.31.08')).toBe(false);
  });
});

describe('canCopyAudioTrackToContainer', () => {
  const track = (
    codec: string,
    config: DecoderConfig | undefined = {
      codec,
      sampleRate: 48_000,
      numberOfChannels: 2,
    },
  ): TrackInfo => ({ id: 1, mediaType: 'audio', codec, config });

  it('proves legal configured packet-copy contracts and rejects unsafe guesses', () => {
    expect(canCopyAudioTrackToContainer('webm', track('opus'))).toBe(true);
    expect(canCopyAudioTrackToContainer('mp4', track('mp4a.40.2'))).toBe(true);
    expect(canCopyAudioTrackToContainer('webm', track('aac'))).toBe(true);
    expect(canCopyAudioTrackToContainer('webm', track('pcm-s16'))).toBe(false);
    expect(canCopyAudioTrackToContainer('mp4', track('opus'))).toBe(true);
    expect(
      canCopyAudioTrackToContainer('webm', {
        mediaType: 'audio',
        codec: 'opus',
      }),
    ).toBe(false);
    expect(
      canCopyAudioTrackToContainer('webm', {
        ...track('opus'),
        encrypted: true,
      }),
    ).toBe(false);
    expect(canCopyAudioTrackToContainer('wav', track('opus'))).toBe(false);
  });
});

describe('canUseVpxAlphaGeometryPacketTranscode', () => {
  const source = 'vp09.00.31.08';

  it('allows resize-only alpha routes and rejects transforms with unproven plane semantics', () => {
    expect(
      canUseVpxAlphaGeometryPacketTranscode(
        { codec: 'vp9', width: 320, height: 240, alpha: 'keep' },
        true,
        source,
        source,
      ),
    ).toBe(true);
    expect(
      canUseVpxAlphaGeometryPacketTranscode({ codec: 'vp9', alpha: 'keep' }, true, source, source),
    ).toBe(false);
    expect(
      canUseVpxAlphaGeometryPacketTranscode(
        {
          codec: 'vp9',
          width: 320,
          alpha: 'keep',
          crop: { x: 0, y: 0, width: 320, height: 240 },
        },
        true,
        source,
        source,
      ),
    ).toBe(false);
    expect(
      canUseVpxAlphaGeometryPacketTranscode(
        {
          codec: 'vp9',
          width: 320,
          height: 240,
          alpha: 'keep',
          colorspace: { to: 'bt709' },
        },
        true,
        source,
        source,
      ),
    ).toBe(false);
    expect(
      canUseVpxAlphaGeometryPacketTranscode(
        { codec: 'vp9', width: 320, height: 240, alpha: 'keep' },
        true,
        'vp09.02.31.10',
        source,
      ),
    ).toBe(false);
  });
});

describe('qualifiedVideoSourceCodec', () => {
  it('uses in-band/container qualification rather than a bare VP9 family token', () => {
    expect(
      qualifiedVideoSourceCodec({
        codec: 'vp9',
        config: { codec: 'vp09.00.30.08', codedWidth: 320, codedHeight: 240 },
      }),
    ).toBe('vp09.00.30.08');
    expect(qualifiedVideoSourceCodec({ codec: 'vp9' })).toBe('vp9');
    expect(
      qualifiedVideoSourceCodec({
        codec: 'vp9',
        config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
      }),
    ).toBe('vp9');
  });
});

describe('canCopyVpxAlphaSideData', () => {
  it('copies only implicit same-codec VPx alpha and preserves explicit rate-control semantics', () => {
    expect(canCopyVpxAlphaSideData({}, 'vp09.00.31.08', 'vp09.00.40.08')).toBe(true);
    expect(canCopyVpxAlphaSideData({}, 'vp09.01.31.08', 'vp09.00.40.08')).toBe(false);
    expect(canCopyVpxAlphaSideData({}, 'vp8', 'vp09.00.40.08')).toBe(false);
    expect(canCopyVpxAlphaSideData({ bitrate: 1_000_000 }, 'vp9', 'vp09.00.40.08')).toBe(false);
    expect(canCopyVpxAlphaSideData({ bitrateMode: 'constant' }, 'vp9', 'vp09.00.40.08')).toBe(
      false,
    );
    expect(canCopyVpxAlphaSideData({ crf: 24 }, 'vp9', 'vp09.00.40.08')).toBe(false);
    expect(canCopyVpxAlphaSideData({ twoPass: true }, 'vp9', 'vp09.00.40.08')).toBe(false);
    expect(canCopyVpxAlphaSideData({}, 'VP8', 'vp8')).toBe(true);
    expect(canCopyVpxAlphaSideData({}, 'VP09.00.31.08', 'vp09.00.40.08')).toBe(true);
    expect(canCopyVpxAlphaSideData({}, 'vp9', 'vp9')).toBe(false);
  });
});

describe('transcodeVpxAlphaPackets', () => {
  interface FakeChunk {
    readonly label: string;
    readonly timestamp: number;
  }

  const chunk = (label: string, timestamp: number): EncodedChunk =>
    ({ label, timestamp }) as unknown as EncodedChunk;

  const labels = (packets: readonly Packet[]): readonly (readonly [string, string | undefined])[] =>
    packets.map((packet) => [
      (packet.chunk as unknown as FakeChunk).label,
      packet.alpha === undefined ? undefined : (packet.alpha as unknown as FakeChunk).label,
    ]);

  const passDecoder = (
    _config: DecoderConfig,
    _options?: StageOptions,
  ): TransformStream<EncodedChunk, RawFrame> =>
    new TransformStream<EncodedChunk, RawFrame>({
      transform(value, controller): void {
        controller.enqueue(value as unknown as RawFrame);
      },
    });

  const passEncoder = (
    _config: VideoEncoderConfig,
    _options?: StageOptions,
  ): TransformStream<RawFrame, EncodedChunk> =>
    new TransformStream<RawFrame, EncodedChunk>({
      transform(value, controller): void {
        controller.enqueue(value as unknown as EncodedChunk);
      },
    });

  const packetTranscodeOptions = {
    decodeConfig: { codec: 'vp09.00.10.08' },
    encodeConfig: { codec: 'vp8', width: 2, height: 2 },
    createDecoder: passDecoder,
    createEncoder: passEncoder,
  } satisfies Parameters<typeof transcodeVpxAlphaPackets>[1];

  async function collectPackets(stream: ReadableStream<Packet>): Promise<Packet[]> {
    const reader = stream.getReader();
    const packets: Packet[] = [];
    for (;;) {
      const item = await reader.read();
      if (item.done) return packets;
      packets.push(item.value);
    }
  }

  it('pairs independently re-encoded alpha chunks by timestamp and preserves no-alpha color packets', async () => {
    const out = await collectPackets(
      transcodeVpxAlphaPackets(
        streamOf<Packet>([
          {
            chunk: chunk('c100', 100),
            alpha: chunk('a50', 50) as EncodedVideoChunk,
          },
          { chunk: chunk('c200', 200) },
          {
            chunk: chunk('c300', 300),
            alpha: chunk('a300', 300) as EncodedVideoChunk,
          },
        ]),
        packetTranscodeOptions,
      ),
    );

    expect(labels(out)).toEqual([
      ['c100', undefined],
      ['c200', undefined],
      ['c300', 'a300'],
    ]);
  });

  it('preserves same-codec alpha chunks without sending them through decoder or encoder', async () => {
    let decoded = 0;
    let encoded = 0;
    const countingDecoder = (
      config: DecoderConfig,
      options?: StageOptions,
    ): TransformStream<EncodedChunk, RawFrame> => {
      const stream = passDecoder(config, options);
      const counter = new TransformStream<EncodedChunk, EncodedChunk>({
        transform(value, controller): void {
          decoded++;
          controller.enqueue(value);
        },
      });
      return {
        readable: counter.readable.pipeThrough(stream),
        writable: counter.writable,
      } as TransformStream<EncodedChunk, RawFrame>;
    };
    const countingEncoder = (
      config: VideoEncoderConfig,
      options?: StageOptions,
    ): TransformStream<RawFrame, EncodedChunk> => {
      const stream = passEncoder(config, options);
      const counter = new TransformStream<RawFrame, RawFrame>({
        transform(value, controller): void {
          encoded++;
          controller.enqueue(value);
        },
      });
      return {
        readable: counter.readable.pipeThrough(stream),
        writable: counter.writable,
      } as TransformStream<RawFrame, EncodedChunk>;
    };
    const alpha = chunk('alpha-exact', 100) as EncodedVideoChunk;
    const out = await collectPackets(
      transcodeVpxAlphaPackets(streamOf([{ chunk: chunk('color', 100), alpha }]), {
        ...packetTranscodeOptions,
        createDecoder: countingDecoder,
        createEncoder: countingEncoder,
        copyAlpha: true,
      }),
    );

    expect(decoded).toBe(1);
    expect(encoded).toBe(1);
    expect(out[0]?.alpha).toBe(alpha);
  });

  it('drops cached alpha chunks that are older than the next color timestamp', async () => {
    const out = await collectPackets(
      transcodeVpxAlphaPackets(
        streamOf<Packet>([
          {
            chunk: chunk('c100', 100),
            alpha: chunk('a200', 200) as EncodedVideoChunk,
          },
          { chunk: chunk('c300', 300) },
        ]),
        packetTranscodeOptions,
      ),
    );

    expect(labels(out)).toEqual([
      ['c100', undefined],
      ['c300', undefined],
    ]);
  });

  it('propagates transform errors and cancels the sibling packet branch', async () => {
    const failingDecoder = (): TransformStream<EncodedChunk, RawFrame> =>
      new TransformStream<EncodedChunk, RawFrame>({
        transform(value, controller): void {
          if ((value as unknown as FakeChunk).label === 'c100') {
            throw new Error('decode boom');
          }
          controller.enqueue(value as unknown as RawFrame);
        },
      });

    await expect(
      collectPackets(
        transcodeVpxAlphaPackets(
          streamOf<Packet>([
            {
              chunk: chunk('c100', 100),
              alpha: chunk('a100', 100) as EncodedVideoChunk,
            },
          ]),
          { ...packetTranscodeOptions, createDecoder: failingDecoder },
        ),
      ),
    ).rejects.toThrow('decode boom');
  });

  it('allows downstream cancellation after yielding a packet', async () => {
    const reader = transcodeVpxAlphaPackets(
      streamOf<Packet>([
        {
          chunk: chunk('c100', 100),
          alpha: chunk('a200', 200) as EncodedVideoChunk,
        },
        { chunk: chunk('c300', 300) },
      ]),
      packetTranscodeOptions,
    ).getReader();

    const first = await reader.read();
    if (first.done) throw new Error('expected a packet before cancellation');
    expect((first.value.chunk as unknown as FakeChunk).label).toBe('c100');
    await expect(reader.cancel('test stop')).resolves.toBeUndefined();
  });
});

// ── container choice ───────────────────────────────────────────────────────────────────────────

describe('chooseOutputContainer', () => {
  it('honors an explicit target', () => {
    expect(chooseOutputContainer('webm', 'mp4')).toBe('webm');
    expect(chooseOutputContainer('mp4', undefined)).toBe('mp4');
  });

  it('defaults to the source container when it is itself chunk-muxable', () => {
    expect(chooseOutputContainer(undefined, 'mp4')).toBe('mp4');
    expect(chooseOutputContainer(undefined, 'mov')).toBe('mov');
    expect(chooseOutputContainer(undefined, 'webm')).toBe('webm'); // webm now has a chunk muxer
    expect(chooseOutputContainer(undefined, 'mkv')).toBe('mkv');
    expect(chooseOutputContainer(undefined, 'ogg')).toBe('ogg');
    expect(chooseOutputContainer(undefined, 'ts')).toBe('ts');
  });

  it('defaults to mp4 when the source is not chunk-muxable or unknown', () => {
    expect(chooseOutputContainer(undefined, 'wav')).toBe('mp4'); // PCM source → transformPcm, not the seam
    expect(chooseOutputContainer(undefined, undefined)).toBe('mp4');
    expect(chooseOutputContainer(undefined, 'totally-unknown')).toBe('mp4');
  });

  it('keeps an MP3 source as MP3 now that the MP3 elementary-stream muxer exists', () => {
    // MP3 joined the chunk-muxable set via Mp3Muxer — a same-container remux stays mp3, not mp4.
    expect(chooseOutputContainer(undefined, 'mp3')).toBe('mp3');
  });
});

describe('containerHasChunkMuxer', () => {
  it('is true for the containers with a real EncodedChunk-seam muxer', () => {
    // FLAC via FlacMuxer (ADR-085); MP3 via Mp3Muxer (MPEG-Layer-III frames); ADTS via AdtsMuxer (raw AAC
    // access units in 7-byte ADTS headers); WAV via raw-PCM packet muxing; AVI via RIFF packet muxing.
    for (const c of [
      'mp4',
      'mov',
      'webm',
      'mkv',
      'ogg',
      'ts',
      'm2ts',
      'mts',
      'mpegts',
      'flac',
      'mp3',
      'adts',
      'aac',
      'wav',
      'avi',
    ] as const) {
      expect(containerHasChunkMuxer(c)).toBe(true);
    }
  });
  it('is false for PCM containers without packet muxers', () => {
    // AIFF/CAF author PCM through transformPcm, not the EncodedChunk seam. AAC is the public ADTS alias.
    for (const c of ['aiff', 'caf'] as const) {
      expect(containerHasChunkMuxer(c)).toBe(false);
    }
  });
});

describe('isPcmContainer', () => {
  it('is true for the raw-PCM containers served by the transformPcm audio-dsp path', () => {
    for (const c of ['wav', 'aiff', 'caf'] as const) expect(isPcmContainer(c)).toBe(true);
  });
  it('is false for codec-seam and compressed containers (they route through the codec/mux path)', () => {
    const nonPcm = [
      'mp4',
      'mov',
      'webm',
      'mkv',
      'ogg',
      'mp3',
      'aac',
      'adts',
      'flac',
      'avi',
      'ts',
    ] as const; // prettier-ignore
    for (const c of nonPcm) expect(isPcmContainer(c)).toBe(false);
  });
});

describe('selectTrackInfos', () => {
  const tracks = [
    { mediaType: 'video', label: 'v0' },
    { mediaType: 'audio', label: 'a0' },
    { mediaType: 'audio', label: 'a1' },
    { mediaType: 'video', label: 'v1' },
  ] as const;

  it('detects whether explicit selectors are present', () => {
    expect(hasTrackSelection(undefined)).toBe(false);
    expect(hasTrackSelection([])).toBe(false);
    expect(hasTrackSelection(['audio:0'])).toBe(true);
  });

  it('selects tracks by media type and per-type index, preserving selector order', () => {
    expect(selectTrackInfos(tracks, ['audio:1', 'video:0']).map((t) => t.label)).toEqual([
      'a1',
      'v0',
    ]);
  });

  it('collapses duplicate selectors and accepts the single-source @0 suffix', () => {
    expect(
      selectTrackInfos(tracks, ['audio:0', 'audio:0@0', 'video:1']).map((t) => t.label),
    ).toEqual(['a0', 'v1']);
  });

  it('ignores selectors for non-zero source indexes and rejects an empty final selection', () => {
    expect(selectTrackInfos(tracks, ['audio:0@1', 'audio:0@0']).map((t) => t.label)).toEqual([
      'a0',
    ]);
    expect(() => selectTrackInfos(tracks, ['audio:0@1'])).toThrow(InputError);
  });

  it('rejects malformed selectors with a typed InputError', () => {
    for (const selector of ['audio', 'audio:-1', 'subtitle:0', 'video:x']) {
      expect(() => selectTrackInfos(tracks, [selector])).toThrow(InputError);
    }
  });

  it('resolves one decode track per media type and treats explicit selectors as a whitelist', () => {
    expect(selectDecodeTrackInfo(tracks, 'video', undefined)?.label).toBe('v0');
    expect(selectDecodeTrackInfo(tracks, 'video', ['video:1'])?.label).toBe('v1');
    expect(selectDecodeTrackInfo(tracks, 'audio', ['video:1'])).toBeUndefined();
    expect(() => selectDecodeTrackInfo(tracks, 'video', ['video:0', 'video:1'])).toThrowError(
      InputError,
    );
  });
});

// ── codec-string mapping ─────────────────────────────────────────────────────────────────────────

describe('videoCodecToken / audioCodecToken', () => {
  it('maps WebCodecs/MP4 codec strings back to public tokens', () => {
    expect(videoCodecToken('avc1.42E01E')).toBe('h264');
    expect(videoCodecToken('avc3.640028')).toBe('h264');
    expect(videoCodecToken('hev1.1.6.L93.B0')).toBe('hevc');
    expect(videoCodecToken('hvc1.2.4.L120')).toBe('hevc');
    expect(videoCodecToken('vp8')).toBe('vp8');
    expect(videoCodecToken('vp09.00.10.08')).toBe('vp9');
    expect(videoCodecToken('av01.0.04M.08')).toBe('av1');
    expect(videoCodecToken('mp4a.40.2')).toBeUndefined(); // audio, not video
  });

  it('maps audio codec strings to tokens', () => {
    expect(audioCodecToken('mp4a.40.2')).toBe('aac');
    expect(audioCodecToken('opus')).toBe('opus');
    expect(audioCodecToken('mp4a.6b')).toBe('mp3');
    expect(audioCodecToken('mp4a.69')).toBe('mp3');
    expect(audioCodecToken('flac')).toBe('flac');
    expect(audioCodecToken('vorbis')).toBe('vorbis');
    expect(audioCodecToken('avc1.42E01E')).toBeUndefined();
  });
});

describe('resolveVideoEncoderCodecString — the single public video codec-string resolver (item 4)', () => {
  const src = { width: 1920, height: 1080 };

  it('is the only exported target/source resolver; the legacy doors are private helpers of it', async () => {
    const surface: Record<string, unknown> & {
      resolveVideoEncoderCodecString?: unknown;
    } = await import('./codec-pipeline.ts');
    expect(typeof surface.resolveVideoEncoderCodecString).toBe('function');
    // The two former public doors (videoEncoderCodecString, h264CodecStringForSourceProfile) and the
    // internal plan projection must not be exported: one room, one door.
    expect('videoEncoderCodecString' in surface).toBe(false);
    expect('h264CodecStringForSourceProfile' in surface).toBe(false);
    expect('resolvedVideoEncoderCodecString' in surface).toBe(false);
  });

  it('pins explicit-token strings bit-for-bit against the config builder outputs', () => {
    // Every row equals today's buildVideoEncoderConfig().codec — the resolver projects the SAME plan.
    const rows: readonly [Parameters<typeof resolveVideoEncoderCodecString>, string][] = [
      [[{ codec: 'h264' }, src, undefined], 'avc1.42E028'], // 1080p → L4.0
      [[{ codec: 'h264', width: 320, height: 180 }, src, undefined], 'avc1.42E00D'], // L1.3 spec-correct (no floor)
      [[{ codec: 'hevc' }, src, undefined], 'hvc1.1.6.L93.B0'],
      [[{ codec: 'vp8' }, src, undefined], 'vp8'],
      [[{ codec: 'vp9', width: 1280, height: 720, fps: 30 }, src, undefined], 'vp09.00.40.08'],
      [[{ codec: 'av1', width: 1280, height: 720, fps: 30 }, src, undefined], 'av01.0.08M.08'],
    ];
    for (const [args, expected] of rows) {
      expect(resolveVideoEncoderCodecString(...args)).toBe(expected);
      expect(buildVideoEncoderConfig(...args).codec).toBe(expected);
    }
  });

  it('preserves qualified sources verbatim when target facts are unchanged', () => {
    expect(resolveVideoEncoderCodecString({}, src, 'avc1.640028')).toBe('avc1.640028');
    expect(resolveVideoEncoderCodecString({}, src, 'hvc1.1.6.L150.90')).toBe('hvc1.1.6.L150.90');
    expect(resolveVideoEncoderCodecString({}, src, 'vp09.02.50.10')).toBe('vp09.02.50.10');
  });

  it('uses the out-of-band hvc1 sample-entry promise for HEVC re-encoding', () => {
    const hvc1Source = 'hvc1.1.6.L120.90';
    expect(resolveVideoEncoderCodecString({ bitrate: 8_000_000 }, src, hvc1Source)).toBe(
      'hvc1.1.6.L93.B0',
    );
    expect(buildVideoEncoderConfig({ bitrate: 8_000_000 }, src, hvc1Source).codec).toBe(
      'hvc1.1.6.L93.B0',
    );
    expect(
      resolveVideoEncoderCodecString({ codec: 'hevc', bitrate: 8_000_000 }, src, hvc1Source),
    ).toBe('hvc1.1.6.L93.B0');
  });

  it('retains a source H.264 Main/High profile for an explicit h264 token (private helper path)', () => {
    expect(
      resolveVideoEncoderCodecString(
        { codec: 'h264', bitrate: 2_000_000 },
        { width: 1080, height: 1920, fps: 60 },
        'avc1.64002A',
      ),
    ).toBe('avc1.64002A'); // High (64) retained, level resized to 4.2
    expect(
      resolveVideoEncoderCodecString(
        { codec: 'h264' },
        { width: 1280, height: 720, fps: 30 },
        'avc1.4D401F',
      ),
    ).toBe('avc1.4D001F'); // Main (4D) retained, compat cleared, L3.1
  });

  it('authors HEVC Main10 for a 10-bit request and sizes VP9/AV1 level boundaries', () => {
    expect(resolveVideoEncoderCodecString({ codec: 'hevc', bitDepth: 10 }, src, undefined)).toBe(
      'hvc1.2.4.L120.B0',
    );
    expect(
      resolveVideoEncoderCodecString(
        { codec: 'vp9', width: 1920, height: 1080, fps: 60 },
        src,
        undefined,
      ),
    ).toBe('vp09.00.50.08');
    expect(
      resolveVideoEncoderCodecString(
        { codec: 'vp9', width: 3840, height: 2160, fps: 30 },
        src,
        undefined,
      ),
    ).toBe('vp09.00.52.08');
    expect(
      resolveVideoEncoderCodecString(
        { codec: 'av1', width: 7680, height: 4320, fps: 60 },
        src,
        undefined,
      ),
    ).toBe('av01.0.18M.08');
    // An explicit bitrate promotes the level exactly as the config builder does.
    expect(
      resolveVideoEncoderCodecString(
        {
          codec: 'av1',
          width: 1280,
          height: 720,
          fps: 30,
          bitrate: 50_000_000,
        },
        src,
        undefined,
      ),
    ).toBe('av01.0.14M.08');
  });

  it('throws the same typed misses as the config builder — never a string for an impossible encode', () => {
    expect(() => resolveVideoEncoderCodecString({}, src, undefined)).toThrow(CapabilityError);
    expect(() => resolveVideoEncoderCodecString({}, src, 'mp4a.40.2')).toThrow(CapabilityError);
    expect(resolveVideoEncoderCodecString({}, src, 'hev1.2.4.L93.90')).toBe('hev1.2.4.L93.90');
    expect(() => resolveVideoEncoderCodecString({}, src, 'hev1.3.4.L120.B0')).toThrow(
      CapabilityError,
    );
  });
});

describe('isUnsupportedHevcEncodeProfile', () => {
  it('allows HEVC Main 8-bit codec strings and non-HEVC strings', () => {
    expect(isUnsupportedHevcEncodeProfile('hev1.1.6.L93.B0')).toBe(false);
    expect(isUnsupportedHevcEncodeProfile('hvc1.1.6.L150.90')).toBe(false);
    expect(isUnsupportedHevcEncodeProfile('avc1.640028')).toBe(false);
    expect(isUnsupportedHevcEncodeProfile('vp09.00.10.08')).toBe(false);
  });

  it('allows HEVC Main10 and flags other profiles as an honest encode miss', () => {
    expect(isUnsupportedHevcEncodeProfile('hev1.2.4.L93.90')).toBe(false);
    expect(isUnsupportedHevcEncodeProfile('hvc1.A2.80000000.H120.40.00.80')).toBe(false);
    expect(isUnsupportedHevcEncodeProfile('hev1.3.4.L120.B0')).toBe(true);
  });
});

describe('audioEncoderCodecString', () => {
  it('maps a token to its codec string and preserves source otherwise', () => {
    expect(audioEncoderCodecString('aac', undefined)).toBe('mp4a.40.2');
    expect(audioEncoderCodecString('opus', undefined)).toBe('opus');
    expect(audioEncoderCodecString(undefined, 'mp4a.40.5')).toBe('mp4a.40.5');
  });

  it('rejects PCM targets (they flow through the audio-dsp path, not the WebCodecs encoder)', () => {
    for (const token of ['pcm', 'pcm-u8', 'pcm-s8', 'pcm-s16be'] as const) {
      expect(() => audioEncoderCodecString(token, undefined)).toThrow(CapabilityError);
    }
  });

  it('throws a typed CapabilityError with no token and no recognizable source codec', () => {
    expect(() => audioEncoderCodecString(undefined, undefined)).toThrow(CapabilityError);
  });
});

// ── filter chain ───────────────────────────────────────────────────────────────────────────────

describe('videoFilterSpecs', () => {
  const src = { width: 1920, height: 1080 };

  it('returns no specs when the target requests no filters', () => {
    expect(videoFilterSpecs({}, src)).toEqual([]);
    expect(videoFilterSpecs({ codec: 'h264', bitrate: 1_000_000 }, src)).toEqual([]);
  });

  it('emits crop → resize → pad → rotate → flip → colorspace in order', () => {
    const specs = videoFilterSpecs(
      {
        crop: { x: 10, y: 20, width: 640, height: 480 },
        width: 320,
        height: 240,
        fit: 'cover',
        pad: { width: 400, height: 300 },
        rotate: 90,
        flip: 'h',
        colorspace: { to: 'bt2020' },
      },
      src,
    );
    expect(specs).toEqual<FilterSpec[]>([
      {
        mediaType: 'video',
        type: 'crop',
        x: 10,
        y: 20,
        width: 640,
        height: 480,
      },
      {
        mediaType: 'video',
        type: 'resize',
        width: 320,
        height: 240,
        fit: 'cover',
      },
      {
        mediaType: 'video',
        type: 'pad',
        x: 40,
        y: 30,
        width: 400,
        height: 300,
      },
      { mediaType: 'video', type: 'rotate', degrees: 90 },
      { mediaType: 'video', type: 'flip', axis: 'h' },
      { mediaType: 'video', type: 'colorspace', to: 'bt2020' },
    ]);
  });

  it('rejects simultaneous colorspace conversion and tonemapping', () => {
    expect(() =>
      videoFilterSpecs({ colorspace: { to: 'bt2020' }, tonemap: { to: 'sdr' } }, src),
    ).toThrow(CapabilityError);
  });

  it('fills a missing resize dimension from the known source dims', () => {
    expect(videoFilterSpecs({ width: 1280 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'resize', width: 1280, height: 1080 },
    ]);
    expect(videoFilterSpecs({ height: 720 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'resize', width: 1920, height: 720 },
    ]);
  });

  it('omits a geometry-identical resize but compares against post-crop dimensions', () => {
    expect(videoFilterSpecs({ width: 1920, height: 1080 }, src)).toEqual([]);
    expect(videoFilterSpecs({ width: 1920 }, src)).toEqual([]);
    expect(
      videoFilterSpecs(
        {
          crop: { x: 100, y: 50, width: 1280, height: 720 },
          width: 1280,
          height: 720,
        },
        src,
      ),
    ).toEqual<FilterSpec[]>([
      {
        mediaType: 'video',
        type: 'crop',
        x: 100,
        y: 50,
        width: 1280,
        height: 720,
      },
    ]);
  });

  it('centers padding after resize, permits explicit placement, and omits an exact no-op', () => {
    expect(
      videoFilterSpecs({ width: 320, height: 240, pad: { width: 401, height: 301 } }, src),
    ).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'resize', width: 320, height: 240 },
      {
        mediaType: 'video',
        type: 'pad',
        width: 401,
        height: 301,
        x: 40,
        y: 30,
      },
    ]);
    expect(videoFilterSpecs({ pad: { width: 2048, height: 1200, x: 128, y: 100 } }, src)).toEqual<
      FilterSpec[]
    >([
      {
        mediaType: 'video',
        type: 'pad',
        width: 2048,
        height: 1200,
        x: 128,
        y: 100,
      },
    ]);
    expect(videoFilterSpecs({ pad: { width: 1920, height: 1080 } }, src)).toEqual([]);
  });

  it('omits a no-op rotate(0) but keeps 180', () => {
    expect(videoFilterSpecs({ rotate: 0 }, src)).toEqual([]);
    expect(videoFilterSpecs({ rotate: 180 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'rotate', degrees: 180 },
    ]);
  });

  it('bakes a source display matrix for rotate(0) normalization', () => {
    const rotated = { ...src, rotation: 90 };
    expect(videoPixelRotation({ rotate: 0 }, rotated)).toBe(90);
    expect(videoFilterSpecs({ rotate: 0 }, rotated)).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'rotate', degrees: 90 },
    ]);
    expect(outputVideoRotation({ rotate: 0 }, rotated.rotation)).toBeUndefined();
  });

  it('composes an explicit transform after the source display matrix and clears output metadata', () => {
    const rotated = { ...src, rotation: 90 };
    expect(videoPixelRotation({ rotate: 270 }, rotated)).toBe(0);
    expect(videoFilterSpecs({ rotate: 270 }, rotated)).toEqual([]);
    expect(outputVideoRotation({ rotate: 270 }, rotated.rotation)).toBeUndefined();
    expect(outputVideoRotation({}, rotated.rotation)).toBe(90);
  });

  it('rejects rotate(0) normalization when the source matrix is not a quarter-turn', () => {
    expect(() => videoPixelRotation({ rotate: 0 }, { rotation: 45 })).toThrow(CapabilityError);
  });

  it('rejects a resize with unknown source dims and only one target dim', () => {
    expect(() => videoFilterSpecs({ width: 640 }, { width: undefined, height: undefined })).toThrow(
      InputError,
    );
  });

  it('rejects non-positive crop/resize', () => {
    expect(() => videoFilterSpecs({ crop: { x: 0, y: 0, width: 0, height: 10 } }, src)).toThrow(
      InputError,
    );
    expect(() => videoFilterSpecs({ crop: { x: 0, y: 0, width: 10, height: -1 } }, src)).toThrow(
      InputError,
    );
    expect(() => videoFilterSpecs({ width: -5, height: 5 }, src)).toThrow(InputError);
  });

  it('rejects padding that shrinks, overflows, or lacks resolvable source geometry', () => {
    expect(() => videoFilterSpecs({ pad: { width: 100, height: 100 } }, src)).toThrow(InputError);
    expect(() => videoFilterSpecs({ pad: { width: 2000, height: 1200, x: 100 } }, src)).toThrow(
      InputError,
    );
    expect(() =>
      videoFilterSpecs(
        { pad: { width: 2000, height: 1200 } },
        { width: undefined, height: undefined },
      ),
    ).toThrow(InputError);
  });

  it('rejects malformed colour targets before the browser filter stream is built', () => {
    expect(() => videoFilterSpecs({ colorspace: { to: '  ' } }, src)).toThrow(InputError);
    const badTonemap = { tonemap: { to: 'hdr' } } as unknown as Parameters<
      typeof videoFilterSpecs
    >[0];
    expect(() => videoFilterSpecs(badTonemap, src)).toThrow(InputError);
  });
});

describe('videoFilterRouteCost', () => {
  it('derives source-plus-output pixel work across the estimated frame count', () => {
    expect(videoFilterRouteCost({}, { width: 64, height: 64, fps: 30, durationSec: 1 })).toEqual({
      inputPixels: 4096,
      outputPixels: 4096,
      videoFrames: 30,
      videoPixelWork: 245_760,
      mediaSeconds: 1,
    });
    expect(videoFilterRouteCost({}, { width: 64, height: 64, durationSec: 1 })).toMatchObject({
      videoFrames: 30,
      videoPixelWork: 245_760,
    });
    expect(videoFilterRouteCost({}, { width: 64, height: 64 })).toMatchObject({
      videoFrames: 1,
      videoPixelWork: 8192,
    });
  });

  it('does not classify short 4K or one-frame 360p transforms by duration alone', () => {
    expect(
      videoFilterRouteCost(
        { width: 1920, height: 1080 },
        { width: 3840, height: 2160, fps: 30, durationSec: 0.1 },
      ),
    ).toEqual({
      inputPixels: 8_294_400,
      outputPixels: 2_073_600,
      videoFrames: 3,
      videoPixelWork: 31_104_000,
      mediaSeconds: 0.1,
    });
    expect(
      videoFilterRouteCost(
        { width: 320, height: 180 },
        { width: 640, height: 360, fps: 30, durationSec: 1 / 30 },
      ),
    ).toEqual({
      inputPixels: 230_400,
      outputPixels: 57_600,
      videoFrames: 1,
      videoPixelWork: 288_000,
      mediaSeconds: 1 / 30,
    });
  });

  it('accounts for 1080p/720p geometry and the higher side of an fps conversion', () => {
    expect(
      videoFilterRouteCost(
        { width: 1280, height: 720 },
        { width: 1920, height: 1080, fps: 30, durationSec: 1 },
      ),
    ).toEqual({
      inputPixels: 2_073_600,
      outputPixels: 921_600,
      videoFrames: 30,
      videoPixelWork: 89_856_000,
      mediaSeconds: 1,
    });
    expect(
      videoFilterRouteCost(
        { width: 640, height: 360, fps: 30 },
        { width: 640, height: 360, fps: 15, durationSec: 1 },
      ).videoFrames,
    ).toBe(30);
    expect(
      videoFilterRouteCost(
        { width: 640, height: 360, fps: 15 },
        { width: 640, height: 360, fps: 30, durationSec: 1 },
      ).videoFrames,
    ).toBe(30);
    expect(
      videoFilterRouteCost({}, { width: 640, height: 360, fps: 15, durationSec: 1 }),
    ).toMatchObject({ videoFrames: 15, videoPixelWork: 6_912_000 });
  });

  it('omits unknown or invalid geometry and duration rather than forcing a tiny route', () => {
    expect(
      videoFilterRouteCost(
        {},
        {
          width: undefined,
          height: 1080,
          durationSec: Number.NaN,
        },
      ),
    ).toEqual({});
    expect(videoFilterRouteCost({}, { width: 0, height: 1080, durationSec: -1 })).toEqual({});
    expect(
      videoFilterRouteCost(
        { width: 320, height: 180 },
        { width: undefined, height: undefined, fps: 30, durationSec: 1 / 30 },
      ),
    ).toEqual({ outputPixels: 57_600, mediaSeconds: 1 / 30 });
  });
});

describe('outputDimensions', () => {
  const src = { width: 1920, height: 1080 };

  it('passes the source dims through with no geometry', () => {
    expect(outputDimensions({}, src)).toEqual({ width: 1920, height: 1080 });
  });

  it('takes the crop rect, then resize and pad, then swaps on 90/270', () => {
    expect(outputDimensions({ crop: { x: 0, y: 0, width: 800, height: 600 } }, src)).toEqual({
      width: 800,
      height: 600,
    });
    expect(outputDimensions({ width: 320, height: 240 }, src)).toEqual({
      width: 320,
      height: 240,
    });
    expect(outputDimensions({ width: 320, height: 240, rotate: 90 }, src)).toEqual({
      width: 240,
      height: 320,
    });
    expect(outputDimensions({ rotate: 270 }, src)).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(
      outputDimensions(
        {
          width: 320,
          height: 240,
          pad: { width: 400, height: 300 },
          rotate: 90,
        },
        src,
      ),
    ).toEqual({ width: 300, height: 400 });
    expect(outputDimensions({ rotate: 0 }, { ...src, rotation: 90 })).toEqual({
      width: 1080,
      height: 1920,
    });
  });

  it('keeps the source dimension for an omitted resize axis', () => {
    expect(outputDimensions({ width: 320 }, src)).toEqual({
      width: 320,
      height: 1080,
    });
    expect(outputDimensions({ height: 240 }, src)).toEqual({
      width: 1920,
      height: 240,
    });
  });

  it('flip is dimension-preserving', () => {
    expect(outputDimensions({ flip: 'v' }, src)).toEqual({
      width: 1920,
      height: 1080,
    });
  });
});

// ── video fps retiming (CFR drop/dup plan + close-once stream helper) ───────────────────────────

function cfrTimings(fps: number, frames: number): { timestamp: number; duration: number }[] {
  return Array.from({ length: frames }, (_, index) => {
    const timestamp = Math.round((index * 1_000_000) / fps);
    const next = Math.round(((index + 1) * 1_000_000) / fps);
    return { timestamp, duration: next - timestamp };
  });
}

describe('planCfrFrameRetiming', () => {
  it('duplicates frames for 30→60 and 15→30 CFR targets', () => {
    expect(planCfrFrameRetiming(cfrTimings(30, 3), { fps: 60 }).outputs).toMatchObject([
      { sourceIndex: 0, timestamp: 0, duration: 16667, duplicate: false },
      { sourceIndex: 0, timestamp: 16667, duration: 16666, duplicate: true },
      { sourceIndex: 1, timestamp: 33333, duration: 16667, duplicate: false },
      { sourceIndex: 1, timestamp: 50000, duration: 16667, duplicate: true },
      { sourceIndex: 2, timestamp: 66667, duration: 16666, duplicate: false },
      { sourceIndex: 2, timestamp: 83333, duration: 16667, duplicate: true },
    ]);

    expect(
      planCfrFrameRetiming(cfrTimings(15, 3), { fps: 30 }).outputs.map((o) => o.sourceIndex),
    ).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('drops frames for 30→15 and records the skipped source indexes', () => {
    const plan = planCfrFrameRetiming(cfrTimings(30, 4), { fps: 15 });
    expect(plan.outputs.map((o) => o.sourceIndex)).toEqual([0, 2]);
    expect(plan.droppedSourceIndexes).toEqual([1, 3]);
    expect(plan.outputs.map((o) => o.timestamp)).toEqual([0, 66667]);
  });

  it('handles extreme 1 fps and 240 fps targets without special casing', () => {
    const oneFps = planCfrFrameRetiming(cfrTimings(30, 60), { fps: 1 });
    expect(oneFps.outputs.map((o) => o.sourceIndex)).toEqual([0, 30]);
    expect(oneFps.outputs.map((o) => o.timestamp)).toEqual([0, 1_000_000]);

    const highFps = planCfrFrameRetiming(cfrTimings(30, 2), { fps: 240 });
    expect(highFps.outputs).toHaveLength(16);
    expect(highFps.outputs.slice(0, 8).every((o) => o.sourceIndex === 0)).toBe(true);
    expect(highFps.outputs.slice(8).every((o) => o.sourceIndex === 1)).toBe(true);
  });

  it('converts VFR input to CFR by timestamp ownership, not by source index ratios', () => {
    const vfr = [
      { timestamp: 0, duration: 40_000 },
      { timestamp: 40_000, duration: 20_000 },
      { timestamp: 60_000, duration: 40_000 },
    ];
    const plan = planCfrFrameRetiming(vfr, { fps: 30 });
    expect(plan.outputs.map((o) => o.sourceIndex)).toEqual([0, 0, 2]);
    expect(plan.droppedSourceIndexes).toEqual([1]);
  });

  it('infers missing frame durations from timestamp gaps and rejects an unbounded single frame', () => {
    const gapInferred = planCfrFrameRetiming(
      [{ timestamp: 0 }, { timestamp: 40_000 }, { timestamp: 80_000 }],
      { fps: 25 },
    );
    expect(gapInferred.outputs.map((o) => o.sourceIndex)).toEqual([0, 1, 2]);
    expect(gapInferred.endsAtUs).toBe(120_000);
    expect(() => planCfrFrameRetiming([{ timestamp: 0 }], { fps: 25 })).toThrow(InputError);
  });

  it('rejects invalid fps or non-monotonic source timestamps with typed errors', () => {
    expect(() => planCfrFrameRetiming(cfrTimings(30, 2), { fps: 0 })).toThrow(InputError);
    expect(() =>
      planCfrFrameRetiming([{ timestamp: 10_000 }, { timestamp: 5_000 }], {
        fps: 30,
      }),
    ).toThrow(InputError);
  });

  it('handles empty and explicit-duration plans, and rejects malformed timing arrays', () => {
    expect(planCfrFrameRetiming([], { fps: 30 })).toEqual({
      fps: 30,
      startsAtUs: undefined,
      endsAtUs: undefined,
      outputs: [],
      droppedSourceIndexes: [],
    });
    expect(
      planCfrFrameRetiming([{ timestamp: 10_000 }], {
        fps: 10,
        durationUs: 200_000,
      }),
    ).toEqual({
      fps: 10,
      startsAtUs: 10_000,
      endsAtUs: 210_000,
      outputs: [
        {
          outputIndex: 0,
          sourceIndex: 0,
          timestamp: 10_000,
          duration: 100_000,
          duplicate: false,
        },
        {
          outputIndex: 1,
          sourceIndex: 0,
          timestamp: 110_000,
          duration: 100_000,
          duplicate: true,
        },
      ],
      droppedSourceIndexes: [],
    });
    expect(() => planCfrFrameRetiming([{ timestamp: 0 }], { fps: 30, durationUs: 0 })).toThrow(
      InputError,
    );
    const sparse = new Array(1) as { timestamp: number }[];
    expect(() => planCfrFrameRetiming(sparse, { fps: 30 })).toThrow(InputError);
    expect(() => planCfrFrameRetiming([{ timestamp: Number.NaN }], { fps: 30 })).toThrow(
      InputError,
    );
  });
});

describe('retimeTimedFrameStream', () => {
  class RetimeFakeFrame {
    closed = false;
    readonly parentId: number;

    constructor(
      readonly id: number,
      readonly timestamp: number,
      readonly duration: number | null,
      parentId: number = id,
    ) {
      this.parentId = parentId;
    }

    close(): void {
      if (this.closed) throw new Error(`frame ${this.id} closed twice`);
      this.closed = true;
    }
  }

  async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
    const reader = stream.getReader();
    const out: T[] = [];
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        out.push(read.value);
      }
    } finally {
      reader.releaseLock();
    }
    return out;
  }

  it('restamps duplicate/drop output and closes every consumed input frame exactly once', async () => {
    let nextId = 100;
    const inputs = [new RetimeFakeFrame(0, 0, 33_333), new RetimeFakeFrame(1, 33_333, 33_334)];
    const outputs = await collect(
      retimeTimedFrameStream(streamOf(inputs), {
        fps: 60,
        restamp(frame, timing): RetimeFakeFrame {
          return new RetimeFakeFrame(nextId++, timing.timestamp, timing.duration, frame.id);
        },
      }),
    );
    expect(inputs.map((f) => f.closed)).toEqual([true, true]);
    expect(outputs.map((f) => [f.parentId, f.timestamp, f.duration, f.closed])).toEqual([
      [0, 0, 16667, false],
      [0, 16667, 16666, false],
      [1, 33333, 16667, false],
      [1, 50000, 16667, false],
    ]);
    for (const output of outputs) output.close();
  });

  it('does not prefetch a frame before downstream demand', async () => {
    let pulls = 0;
    const frames = [new RetimeFakeFrame(0, 0, 33_333)];
    const source = new ReadableStream<RetimeFakeFrame>(
      {
        pull(controller): void {
          pulls++;
          const frame = frames.shift();
          if (frame === undefined) controller.close();
          else controller.enqueue(frame);
        },
      },
      { highWaterMark: 0 },
    );

    const retimed = retimeTimedFrameStream(source, {
      fps: 30,
      durationUs: 33_333,
      restamp(frame, timing): RetimeFakeFrame {
        return new RetimeFakeFrame(100, timing.timestamp, timing.duration, frame.id);
      },
    });
    await Promise.resolve();

    expect(pulls).toBe(0);

    const reader = retimed.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(pulls).toBe(2);
    first.value?.close();
    await reader.cancel();
    reader.releaseLock();
  });

  it('closes pending fps duplicates and the lookahead frame when downstream cancels', async () => {
    let nextId = 300;
    const inputs = [new RetimeFakeFrame(0, 0, 33_333), new RetimeFakeFrame(1, 33_333, 33_334)];
    const outputs: RetimeFakeFrame[] = [];
    const reader = retimeTimedFrameStream(streamOf(inputs), {
      fps: 60,
      restamp(frame, timing): RetimeFakeFrame {
        const output = new RetimeFakeFrame(nextId++, timing.timestamp, timing.duration, frame.id);
        outputs.push(output);
        return output;
      },
    }).getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    first.value?.close();
    await reader.cancel('downstream stopped');
    reader.releaseLock();

    expect(inputs.map((frame) => frame.closed)).toEqual([true, true]);
    expect(outputs).toHaveLength(2);
    expect(outputs.map((frame) => frame.closed)).toEqual([true, true]);
  });

  it('rejects same-object restamps while closing the source frame once', async () => {
    const input = new RetimeFakeFrame(0, 0, 33_333);
    const reader = retimeTimedFrameStream(streamOf([input]), {
      fps: 30,
      restamp(frame): RetimeFakeFrame {
        return frame;
      },
    }).getReader();

    await expect(reader.read()).rejects.toThrow(InputError);
    expect(input.closed).toBe(true);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  });

  it('handles empty and single-frame streams, and closes malformed stream input', async () => {
    expect(
      await collect(
        retimeTimedFrameStream(streamOf<RetimeFakeFrame>([]), {
          fps: 30,
          restamp(frame): RetimeFakeFrame {
            return frame;
          },
        }),
      ),
    ).toEqual([]);

    let nextId = 200;
    const single = new RetimeFakeFrame(1, 10_000, null);
    const outputs = await collect(
      retimeTimedFrameStream(streamOf([single]), {
        fps: 10,
        durationUs: 200_000,
        restamp(frame, timing): RetimeFakeFrame {
          return new RetimeFakeFrame(nextId++, timing.timestamp, timing.duration, frame.id);
        },
      }),
    );
    expect(single.closed).toBe(true);
    expect(outputs.map((frame) => [frame.parentId, frame.timestamp, frame.duration])).toEqual([
      [1, 10_000, 100_000],
      [1, 110_000, 100_000],
    ]);
    for (const output of outputs) output.close();

    const bad = new RetimeFakeFrame(2, Number.NaN, 10_000);
    await expect(
      collect(
        retimeTimedFrameStream(streamOf([bad]), {
          fps: 30,
          restamp(frame): RetimeFakeFrame {
            return new RetimeFakeFrame(nextId++, frame.timestamp, 33_333, frame.id);
          },
        }),
      ),
    ).rejects.toThrow(InputError);
    expect(bad.closed).toBe(true);
  });
});

// ── audio filter chain (gain / stereo→mono / resample shaping before the encoder) ─────────────────

describe('audioTargetCanBypassFilterPlanner', () => {
  it('bypasses the lazy planner for codec/bitrate-only audio transcodes', () => {
    expect(audioTargetCanBypassFilterPlanner({})).toBe(true);
    expect(audioTargetCanBypassFilterPlanner({ codec: 'aac', bitrate: 128_000 })).toBe(true);
  });

  it('keeps every declared audio-shaping field on the planner path, even no-ops', () => {
    expect(audioTargetCanBypassFilterPlanner({ gainDb: 0 })).toBe(false);
    expect(audioTargetCanBypassFilterPlanner({ channels: 2 })).toBe(false);
    expect(audioTargetCanBypassFilterPlanner({ sampleRate: 48000 })).toBe(false);
    expect(audioTargetCanBypassFilterPlanner({ fade: {} })).toBe(false);
    expect(audioTargetCanBypassFilterPlanner({ mixMatrix: [[1]] })).toBe(false);
    expect(audioTargetCanBypassFilterPlanner({ biquad: [] })).toBe(false);
    expect(
      audioTargetCanBypassFilterPlanner({
        dynamics: { normalize: { mode: 'peak', targetDbfs: -1 } },
      }),
    ).toBe(false);
  });
});

describe('audioFilterSpecs', () => {
  const src = { sampleRate: 48000, channels: 2 };

  it('emits no filters when gain/channels/rate are unchanged (or unspecified)', () => {
    expect(audioFilterSpecs({}, src)).toEqual([]);
    expect(audioFilterSpecs({ codec: 'aac', bitrate: 128_000 }, src)).toEqual([]);
    expect(audioFilterSpecs({ gainDb: 0, channels: 2, sampleRate: 48000 }, src)).toEqual([]);
  });

  it('rejects a raw-PCM-only explicit matrix on the lossy codec filter seam', () => {
    expect(() => audioFilterSpecs({ mixMatrix: [[0.5, 0.5]], channels: 1 }, src)).toThrow(
      CapabilityError,
    );
  });

  it('emits gain before remix and resample when all three transforms are requested', () => {
    expect(
      audioFilterSpecs({ gainDb: -6.020599913279624, channels: 1, sampleRate: 22050 }, src),
    ).toEqual<FilterSpec[]>([
      { mediaType: 'audio', type: 'gain', db: -6.020599913279624 },
      { mediaType: 'audio', type: 'remix', channels: 1 },
      { mediaType: 'audio', type: 'resample', sampleRate: 22050 },
    ]);
  });

  it('emits a remix when the target channel count differs (stereo → mono downmix)', () => {
    expect(audioFilterSpecs({ channels: 1 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'audio', type: 'remix', channels: 1 },
    ]);
  });

  it('emits a resample when the target sample rate differs', () => {
    expect(audioFilterSpecs({ sampleRate: 44100 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'audio', type: 'resample', sampleRate: 44100 },
    ]);
  });

  it('orders remix before resample when both change (mix on target layout, then rate)', () => {
    expect(audioFilterSpecs({ channels: 1, sampleRate: 22050 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'audio', type: 'remix', channels: 1 },
      { mediaType: 'audio', type: 'resample', sampleRate: 22050 },
    ]);
  });

  it('emits a remix/resample even when the source layout is unknown (headerless re-encode)', () => {
    const unknown = { sampleRate: undefined, channels: undefined };
    expect(audioFilterSpecs({ channels: 1, sampleRate: 48000 }, unknown)).toEqual<FilterSpec[]>([
      { mediaType: 'audio', type: 'remix', channels: 1 },
      { mediaType: 'audio', type: 'resample', sampleRate: 48000 },
    ]);
  });

  it('rejects a non-finite gain or non-positive / non-integer target channel count or rate', () => {
    expect(() => audioFilterSpecs({ gainDb: Number.NaN }, src)).toThrow(InputError);
    expect(() => audioFilterSpecs({ gainDb: Number.POSITIVE_INFINITY }, src)).toThrow(InputError);
    expect(() => audioFilterSpecs({ channels: 0 }, src)).toThrow(InputError);
    expect(() => audioFilterSpecs({ channels: 1.5 }, src)).toThrow(InputError);
    expect(() => audioFilterSpecs({ sampleRate: -1 }, src)).toThrow(InputError);
  });

  it('emits a stream-stateful fade with frame counts resolved against the SOURCE rate (before resample)', () => {
    // 0.5 s in / 0.25 s out @ the 48 kHz source rate → 24000 / 12000 frames; default curve 'linear'.
    expect(audioFilterSpecs({ fade: { inSec: 0.5, outSec: 0.25 } }, src)).toEqual<FilterSpec[]>([
      {
        mediaType: 'audio',
        type: 'fade',
        curve: 'linear',
        inFrames: 24000,
        outFrames: 12000,
      },
    ]);
    // Fade frames are resolved at the source rate even when a resample follows (fade precedes resample),
    // and the resample is emitted after the fade.
    expect(
      audioFilterSpecs({ fade: { outSec: 1, curve: 'equal-power' }, sampleRate: 22050 }, src),
    ).toEqual<FilterSpec[]>([
      {
        mediaType: 'audio',
        type: 'fade',
        curve: 'equal-power',
        inFrames: 0,
        outFrames: 48000,
      },
      { mediaType: 'audio', type: 'resample', sampleRate: 22050 },
    ]);
  });

  it('drops a fade that resolves to zero frames in and out (no-op)', () => {
    expect(audioFilterSpecs({ fade: {} }, src)).toEqual([]);
    expect(audioFilterSpecs({ fade: { inSec: 0, outSec: 0 } }, src)).toEqual([]);
  });

  it('emits one stream-stateful biquad spec per requested filter (array expands in order)', () => {
    expect(
      audioFilterSpecs(
        {
          biquad: [
            { type: 'highpass', frequency: 80, q: 0.7 },
            { type: 'peaking', frequency: 1000, q: 2, gainDb: 6 },
          ],
        },
        src,
      ),
    ).toEqual<FilterSpec[]>([
      {
        mediaType: 'audio',
        type: 'biquad',
        spec: { type: 'highpass', frequency: 80, q: 0.7 },
      },
      {
        mediaType: 'audio',
        type: 'biquad',
        spec: { type: 'peaking', frequency: 1000, q: 2, gainDb: 6 },
      },
    ]);
  });

  it('emits a stream-stateful dynamics spec, filling the limiter defaults (ceiling 0 dBFS, hard)', () => {
    expect(
      audioFilterSpecs(
        {
          dynamics: { normalize: { mode: 'rms', targetDbfs: -14 }, limit: {} },
        },
        src,
      ),
    ).toEqual<FilterSpec[]>([
      {
        mediaType: 'audio',
        type: 'dynamics',
        dynamics: {
          normalize: { mode: 'rms', targetDbfs: -14 },
          limit: { ceilingDbfs: 0, mode: 'hard' },
        },
      },
    ]);
  });

  it('emits the full audio chain in the transformPcm order: gain → fade → remix → resample → biquad → dynamics', () => {
    expect(
      audioFilterSpecs(
        {
          gainDb: -3,
          fade: { inSec: 0.1, curve: 'equal-power' },
          channels: 1,
          sampleRate: 24000,
          biquad: { type: 'lowpass', frequency: 1000, q: Math.SQRT1_2 },
          dynamics: { limit: { ceilingDbfs: -1, mode: 'soft', knee: 0.8 } },
        },
        src,
      ),
    ).toEqual<FilterSpec[]>([
      { mediaType: 'audio', type: 'gain', db: -3 },
      {
        mediaType: 'audio',
        type: 'fade',
        curve: 'equal-power',
        inFrames: 4800,
        outFrames: 0,
      },
      { mediaType: 'audio', type: 'remix', channels: 1 },
      { mediaType: 'audio', type: 'resample', sampleRate: 24000 },
      {
        mediaType: 'audio',
        type: 'biquad',
        spec: { type: 'lowpass', frequency: 1000, q: Math.SQRT1_2 },
      },
      {
        mediaType: 'audio',
        type: 'dynamics',
        dynamics: { limit: { ceilingDbfs: -1, mode: 'soft', knee: 0.8 } },
      },
    ]);
  });

  it('rejects invalid fade / dynamics inputs with a typed InputError', () => {
    expect(() => audioFilterSpecs({ fade: { inSec: -1 } }, src)).toThrow(InputError);
    expect(() => audioFilterSpecs({ fade: { inSec: Number.NaN } }, src)).toThrow(InputError);
    // A fade needs a known source rate to resolve seconds → frames.
    expect(() =>
      audioFilterSpecs({ fade: { outSec: 1 } }, { sampleRate: undefined, channels: 2 }),
    ).toThrow(InputError);
    expect(() =>
      audioFilterSpecs(
        {
          dynamics: {
            normalize: { mode: 'lufs' as unknown as 'peak', targetDbfs: -14 },
          },
        },
        src,
      ),
    ).toThrow(InputError);
    // A dynamics with neither normalize nor limit is empty/meaningless.
    expect(() => audioFilterSpecs({ dynamics: {} }, src)).toThrow(InputError);
  });
});

/**
 * The stereo→mono transcode fix (harness `transcode/av_downmix_stereo_to_mono`): the encoder must be
 * configured for EXACTLY the channel count / rate that the post-`audioFilterSpecs` remix/resample stage
 * produces — otherwise the `AudioEncoder` rejects a buffer whose channelCount ≠ its config. This asserts
 * the two agree: the remix target == the encoder's `numberOfChannels` (and likewise for sample rate).
 */
describe('audio downmix: encoder config matches the post-remix AudioData layout', () => {
  const sourceAudio = { sampleRate: 48000, channels: 2 };

  it('stereo source → mono target: remix=1 and the encoder config is numberOfChannels=1', () => {
    const target = { codec: 'aac', channels: 1 } as const;
    const specs = audioFilterSpecs(target, sourceAudio);
    const remix = specs.find((s) => s.type === 'remix');
    const postRemixChannels = remix && 'channels' in remix ? remix.channels : sourceAudio.channels;
    const config = buildAudioEncoderConfig(target, sourceAudio, 'mp4a.40.2');
    expect(postRemixChannels).toBe(1);
    expect(config.numberOfChannels).toBe(postRemixChannels); // config == fed-buffer layout
    expect(config.sampleRate).toBe(48000); // rate unchanged → no resample, config keeps the source rate
  });

  it('downmix + downsample: config channels/rate both equal the post-filter layout', () => {
    const target = { codec: 'aac', channels: 1, sampleRate: 24000 } as const;
    const specs = audioFilterSpecs(target, sourceAudio);
    const remix = specs.find((s) => s.type === 'remix');
    const resample = specs.find((s) => s.type === 'resample');
    const postChannels = remix && 'channels' in remix ? remix.channels : sourceAudio.channels;
    const postRate =
      resample && 'sampleRate' in resample ? resample.sampleRate : sourceAudio.sampleRate;
    const config = buildAudioEncoderConfig(target, sourceAudio, 'mp4a.40.2');
    expect(config.numberOfChannels).toBe(postChannels);
    expect(config.sampleRate).toBe(postRate);
  });
});

// ── encoder configs ─────────────────────────────────────────────────────────────────────────────

describe('periodicVideoKeyFrameInterval — spend GOP overhead only on fragmented output', () => {
  it('lets the encoder optimize ordinary VOD GOPs even when an fps target is explicit', () => {
    expect(periodicVideoKeyFrameInterval(30, false)).toBeUndefined();
    expect(periodicVideoKeyFrameInterval(undefined, false)).toBeUndefined();
  });

  it('keeps deterministic two-second keyframe boundaries for fragmented output', () => {
    expect(periodicVideoKeyFrameInterval(30, true)).toBe(60);
    expect(periodicVideoKeyFrameInterval(59.94, true)).toBe(120);
    expect(periodicVideoKeyFrameInterval(undefined, true)).toBeUndefined();
  });
});

describe('buildVideoEncoderConfig', () => {
  const src = { width: 1920, height: 1080 };

  it('uses realtime only for qualified ordinary-cadence AV1/VP9 paths', () => {
    expect(videoLatencyMode({}, 'av1', 30.0000003)).toBe('realtime');
    expect(videoLatencyMode({}, 'av1', 30.5)).toBe('realtime');
    expect(videoLatencyMode({}, 'av1', 30.500001)).toBe('quality');
    expect(videoLatencyMode({}, 'av1', undefined)).toBe('quality');
    expect(videoLatencyMode({}, 'av1', 60)).toBe('quality');
    expect(videoLatencyMode({}, 'h264', 30)).toBe('quality');
    expect(videoLatencyMode({}, 'h264', undefined)).toBe('quality');
    expect(videoLatencyMode({}, 'h264', 60)).toBe('quality');
    expect(videoLatencyMode({ bitrate: 2_000_000 }, 'h264', 30)).toBe('quality');
    expect(videoLatencyMode({ bitrateMode: 'constant' }, 'h264', 30)).toBe('quality');
    expect(videoLatencyMode({ crf: 24 }, 'h264', 30)).toBe('quality');
    expect(videoLatencyMode({ twoPass: false }, 'h264', 30)).toBe('quality');
    expect(videoLatencyMode({ twoPass: true }, 'h264', 30)).toBe('quality');
    expect(videoLatencyMode({}, 'hevc', 30)).toBe('quality');
    expect(videoLatencyMode({}, 'vp9', 30)).toBe('quality');
    expect(videoLatencyMode({}, 'vp9', 30, 'av01.0.05M.08')).toBe('realtime');
    expect(videoLatencyMode({}, 'vp9', 60, 'av01.0.05M.08')).toBe('quality');
    expect(videoLatencyMode({}, 'vp9', 30, 'avc1.640028')).toBe('quality');
    expect(videoLatencyMode({ crf: 30 }, 'vp9', 30, 'av01.0.05M.08')).toBe('quality');
    expect(videoLatencyMode({ bitrate: 2_000_000 }, 'av1', 30)).toBe('quality');
    expect(videoLatencyMode({ bitrateMode: 'constant' }, 'av1', 30)).toBe('quality');
    expect(videoLatencyMode({ crf: 24 }, 'av1', 30)).toBe('quality');
    expect(videoLatencyMode({ twoPass: true }, 'av1', 30)).toBe('quality');
  });

  it('builds a config with the resolved codec, post-filter dims, and optional bitrate/fps', () => {
    expect(
      buildVideoEncoderConfig({ codec: 'h264', bitrate: 2_000_000, fps: 30 }, src, undefined),
    ).toEqual({
      // h264 token at 1920×1080@30 → Constrained Baseline level 4.0 (0x28), not the old static L3.0
      codec: 'avc1.42E028',
      width: 1920,
      height: 1080,
      latencyMode: 'quality',
      bitrate: 2_000_000,
      bitrateMode: 'variable',
      framerate: 30,
    });
  });

  it('threads bitrate-mode planning through ordinary bitrate encodes and rejects invalid fps/bitrate', () => {
    expect(
      buildVideoEncoderConfig({ codec: 'h264', bitrate: 2_000_000 }, src, undefined),
    ).toMatchObject({ bitrate: 2_000_000, bitrateMode: 'variable' });
    expect(() => buildVideoEncoderConfig({ codec: 'h264', fps: 0 }, src, undefined)).toThrow(
      InputError,
    );
    expect(() =>
      buildVideoEncoderConfig({ codec: 'h264', bitrate: Number.NaN }, src, undefined),
    ).toThrow(InputError);
  });

  it('preserves an efficient source H.264 profile and known source fps for constrained-rate output', () => {
    expect(
      buildVideoEncoderConfig(
        { codec: 'h264', bitrate: 2_000_000 },
        { width: 1080, height: 1920, fps: 60 },
        'avc1.64002A',
      ),
    ).toMatchObject({
      codec: 'avc1.64002A',
      framerate: 60,
      bitrate: 2_000_000,
    });
  });

  it('uses a resolution-aware default bitrate for offline video encodes', () => {
    expect(
      buildVideoEncoderConfig({ codec: 'vp8', width: 640, height: 360 }, src, undefined),
    ).toMatchObject({
      bitrate: 5_068_800,
      bitrateMode: 'variable',
    });
    expect(
      buildVideoEncoderConfig({ codec: 'h264', width: 1280, height: 720, fps: 30 }, src, undefined),
    ).toMatchObject({
      bitrate: 18_432_000,
      bitrateMode: 'variable',
    });
  });

  it('uses a measured source bitrate for implicit cross-codec output and keeps explicit controls authoritative', () => {
    expect(
      sourceVideoBitrateFromPacketTable(
        [
          {
            trackId: 3,
            sizeBytes: 1_000,
            ptsUs: 0,
            dtsUs: 0,
            durationUs: 1_000_000,
            keyframe: true,
          },
          {
            trackId: 3,
            sizeBytes: 1_000,
            ptsUs: 1_000_000,
            dtsUs: 1_000_000,
            durationUs: 1_000_000,
            keyframe: false,
          },
        ],
        3,
      ),
    ).toBe(8_000);
    expect(
      buildVideoEncoderConfig(
        { codec: 'vp9' },
        { width: 1920, height: 1080, fps: 24, bitrate: 271_201 },
        'av01.0.05M.08',
      ),
    ).toMatchObject({ bitrate: 33_177_600, bitrateMode: 'variable' });
    expect(
      buildVideoEncoderConfig(
        { codec: 'vp9', bitrate: 4_000_000 },
        { width: 1920, height: 1080, fps: 24, bitrate: 271_201 },
        'av01.0.05M.08',
      ),
    ).toMatchObject({ bitrate: 4_000_000, bitrateMode: 'variable' });
  });

  it('builds CRF and the real replay-backed H.264 second pass in quantizer mode', () => {
    expect(buildVideoEncoderConfig({ codec: 'h264', crf: 23 }, src, undefined)).toEqual({
      codec: 'avc1.42E028',
      width: 1920,
      height: 1080,
      latencyMode: 'quality',
      bitrateMode: 'quantizer',
    });
    expect(
      buildVideoEncoderConfig({ codec: 'h264', bitrate: 2_000_000, twoPass: true }, src, undefined),
    ).toMatchObject({
      codec: 'avc1.42E028',
      bitrateMode: 'quantizer',
    });
    expect(
      buildVideoEncoderConfig(
        {
          codec: 'h264',
          bitrate: 2_000_000,
          maxAverageBitrate: 2_600_000,
          quality: { metric: 'ssim-luma-v1', minimumMean: 0.93, samples: 8 },
        },
        src,
        undefined,
      ),
    ).toMatchObject({
      codec: 'avc1.42E028',
      bitrateMode: 'quantizer',
    });
    expect(() =>
      buildVideoEncoderConfig({ codec: 'vp8', bitrate: 2_000_000, twoPass: true }, src, undefined),
    ).toThrow(CapabilityError);
    expect(() => buildVideoEncoderConfig({ codec: 'vp8', crf: 23 }, src, undefined)).toThrow(
      CapabilityError,
    );
  });

  it('sizes the H.264 level to the output dims with spec-correct Annex-A minimum (no floor)', () => {
    // Annex-A correct minimum for 320×180@30 is L1.3 (0x0D); the former L3.0 floor was an overfit to a single Chromium 149 seek bug on tiny outputs.
    expect(
      buildVideoEncoderConfig({ codec: 'h264', width: 320, height: 180 }, src, undefined).codec,
    ).toBe(
      'avc1.42E00D', // level 1.3 spec-correct
    );
    expect(() =>
      buildVideoEncoderConfig({ codec: 'h264', width: 1, height: 1, fps: 30 }, src, undefined),
    ).toThrow(InputError);
    // 720p@30 → L3.1 (0x1F)
    expect(
      buildVideoEncoderConfig({ codec: 'h264', width: 1280, height: 720, fps: 30 }, src, undefined)
        .codec,
    ).toBe('avc1.42E01F');
    // 4K@30 → L5.1 (0x33)
    expect(
      buildVideoEncoderConfig({ codec: 'h264', width: 3840, height: 2160, fps: 30 }, src, undefined)
        .codec,
    ).toBe('avc1.42E033');
  });

  it('preserves qualified sources while sizing explicitly requested codec tokens', () => {
    // preserve-source High profile stays verbatim (we never re-level a pinned profile)
    expect(buildVideoEncoderConfig({}, src, 'avc1.640028').codec).toBe('avc1.640028');
    // preserve-source HEVC Main stays verbatim so hvc1/hev1 sample-entry semantics are not guessed away
    expect(buildVideoEncoderConfig({}, src, 'hvc1.1.6.L150.90').codec).toBe('hvc1.1.6.L150.90');
    // An explicit VP9 token is sized to the output rather than advertising the old L1.0 default.
    expect(
      buildVideoEncoderConfig({ codec: 'vp9', width: 1920, height: 1080, fps: 30 }, src, undefined)
        .codec,
    ).toBe('vp09.00.50.08');
    expect(buildVideoEncoderConfig({ codec: 'hevc' }, src, undefined).codec).toBe(
      'hvc1.1.6.L93.B0',
    );
  });

  it('uses the resized + rotated output dimensions', () => {
    const cfg = buildVideoEncoderConfig(
      { codec: 'vp9', width: 640, height: 360, rotate: 90, fps: 30 },
      src,
      undefined,
    );
    expect(cfg.width).toBe(360);
    expect(cfg.height).toBe(640);
    expect(cfg.codec).toBe('vp09.00.30.08');
  });

  it('selects the minimum VP9 level covering size, display rate, dimensions, and bitrate', () => {
    const codecAt = (width: number, height: number, fps: number): string =>
      buildVideoEncoderConfig({ codec: 'vp9', width, height, fps }, src, undefined).codec;

    expect(codecAt(1280, 720, 30)).toBe('vp09.00.40.08');
    expect(codecAt(1920, 1080, 60)).toBe('vp09.00.50.08');
    expect(codecAt(3840, 2160, 30)).toBe('vp09.00.52.08');
    expect(codecAt(7680, 4320, 60)).toBe('vp09.00.62.08');
  });

  it('selects the minimum AV1 Annex-A level for 720p through 8K60', () => {
    const codecAt = (width: number, height: number, fps: number): string =>
      buildVideoEncoderConfig({ codec: 'av1', width, height, fps }, src, undefined).codec;

    expect(codecAt(1280, 720, 30)).toBe('av01.0.08M.08');
    expect(codecAt(1920, 1080, 60)).toBe('av01.0.13M.08');
    expect(codecAt(3840, 2160, 30)).toBe('av01.0.17M.08');
    expect(codecAt(7680, 4320, 60)).toBe('av01.0.18M.08');
  });

  it('uses post-rotation dimensions and the source cadence for VP9/AV1 level selection', () => {
    const av1 = buildVideoEncoderConfig(
      { codec: 'av1', width: 1920, height: 1080, rotate: 90 },
      { width: 3840, height: 2160, fps: 60 },
      undefined,
    );
    expect(av1).toMatchObject({
      codec: 'av01.0.13M.08',
      width: 1080,
      height: 1920,
      framerate: 60,
    });

    const vp9 = buildVideoEncoderConfig(
      { codec: 'vp9', width: 3840, height: 2160, rotate: 270 },
      { width: 7680, height: 4320, fps: 30 },
      undefined,
    );
    expect(vp9).toMatchObject({
      codec: 'vp09.00.52.08',
      width: 2160,
      height: 3840,
      framerate: 30,
    });
  });

  it('promotes VP9/AV1 levels when an explicit bitrate exceeds a lower level', () => {
    expect(
      buildVideoEncoderConfig(
        {
          codec: 'vp9',
          width: 1280,
          height: 720,
          fps: 30,
          bitrate: 50_000_000,
        },
        src,
        undefined,
      ).codec,
    ).toBe('vp09.00.50.08');
    expect(
      buildVideoEncoderConfig(
        {
          codec: 'av1',
          width: 1280,
          height: 720,
          fps: 30,
          bitrate: 50_000_000,
        },
        src,
        undefined,
      ).codec,
    ).toBe('av01.0.14M.08');
    expect(
      buildVideoEncoderConfig(
        {
          codec: 'av1',
          width: 1280,
          height: 720,
          fps: 30,
          bitrate: 50_000_000,
          bitDepth: 12,
        },
        src,
        undefined,
      ).codec,
    ).toBe('av01.2.09M.12');
  });

  it('sizes VP9/AV1 levels against the effective implicit bitrate', () => {
    expect(
      buildVideoEncoderConfig({ codec: 'vp9', width: 1280, height: 720, fps: 30 }, src, undefined),
    ).toMatchObject({ codec: 'vp09.00.40.08', bitrate: 14_745_600 });
    expect(
      buildVideoEncoderConfig({ codec: 'av1', width: 1280, height: 720, fps: 30 }, src, undefined),
    ).toMatchObject({ codec: 'av01.0.08M.08', bitrate: 11_059_200 });
    expect(
      buildVideoEncoderConfig(
        { codec: 'av1', width: 1280, height: 720, fps: 30.0000003 },
        src,
        undefined,
      ),
    ).toMatchObject({ bitrate: 11_059_200 });
    expect(
      buildVideoEncoderConfig({ codec: 'av1', width: 1280, height: 720, fps: 60 }, src, undefined),
    ).toMatchObject({ bitrate: 15_640_071 });
    expect(
      buildVideoEncoderConfig({ codec: 'av1', width: 1280, height: 720, fps: 240 }, src, undefined),
    ).toMatchObject({ bitrate: 18_432_000 });
  });

  it('uses the highest defined level when output cadence is unknown', () => {
    expect(
      buildVideoEncoderConfig({ codec: 'vp9', width: 1920, height: 1080 }, src, undefined).codec,
    ).toBe('vp09.00.62.08');
    expect(
      buildVideoEncoderConfig({ codec: 'av1', width: 1920, height: 1080 }, src, undefined).codec,
    ).toBe('av01.0.19M.08');
  });

  it('re-levels qualified VP9/AV1 sources when output facts change', () => {
    const source = { width: 1280, height: 720, fps: 30 };
    expect(
      buildVideoEncoderConfig({ width: 3840, height: 2160, fps: 60 }, source, 'vp09.00.31.08')
        .codec,
    ).toBe('vp09.00.52.08');
    expect(
      buildVideoEncoderConfig({ width: 3840, height: 2160, fps: 60 }, source, 'av01.0.05M.08')
        .codec,
    ).toBe('av01.0.18M.08');
  });

  it('authors valid VP9/AV1 profiles for every public depth', () => {
    expect(
      buildVideoEncoderConfig(
        { codec: 'vp9', width: 1280, height: 720, fps: 30, bitDepth: 8 },
        src,
        undefined,
      ).codec,
    ).toBe('vp09.00.40.08');
    expect(
      buildVideoEncoderConfig(
        { codec: 'vp9', width: 1280, height: 720, fps: 30, bitDepth: 10 },
        src,
        undefined,
      ).codec,
    ).toBe('vp09.02.40.10');
    expect(
      buildVideoEncoderConfig(
        { codec: 'vp9', width: 1280, height: 720, fps: 30, bitDepth: 12 },
        src,
        undefined,
      ).codec,
    ).toBe('vp09.02.40.12');
    expect(
      buildVideoEncoderConfig(
        { codec: 'av1', width: 1280, height: 720, fps: 30, bitDepth: 8 },
        src,
        undefined,
      ).codec,
    ).toBe('av01.0.08M.08');
    expect(
      buildVideoEncoderConfig(
        { codec: 'av1', width: 1280, height: 720, fps: 30, bitDepth: 10 },
        src,
        undefined,
      ).codec,
    ).toBe('av01.0.08M.10');
    expect(
      buildVideoEncoderConfig(
        { codec: 'av1', width: 1280, height: 720, fps: 30, bitDepth: 12 },
        src,
        undefined,
      ).codec,
    ).toBe('av01.2.05M.12');
  });

  it('keeps VP9 alpha on a high-depth profile and rejects AV1 alpha as a disjoint capability', () => {
    expect(
      buildVideoEncoderConfig(
        {
          codec: 'vp9',
          width: 1280,
          height: 720,
          fps: 30,
          bitDepth: 12,
          alpha: 'keep',
        },
        src,
        undefined,
      ),
    ).toMatchObject({ codec: 'vp09.02.40.12', alpha: 'keep' });
    expect(() =>
      buildVideoEncoderConfig(
        {
          codec: 'av1',
          width: 1280,
          height: 720,
          fps: 30,
          bitDepth: 12,
          alpha: 'keep',
        },
        src,
        undefined,
      ),
    ).toThrow(CapabilityError);
  });

  it('preserves the source family while changing depth without a codec token', () => {
    expect(
      buildVideoEncoderConfig(
        { width: 1280, height: 720, fps: 30, bitDepth: 12 },
        src,
        'vp09.00.31.08',
      ).codec,
    ).toBe('vp09.02.40.12');
    expect(
      buildVideoEncoderConfig(
        { width: 1280, height: 720, fps: 30, bitDepth: 10 },
        src,
        'av01.0.05M.08',
      ).codec,
    ).toBe('av01.0.08M.10');
    expect(buildVideoEncoderConfig({ bitDepth: 8, fps: 30 }, src, 'vp09.02.50.10').codec).toBe(
      'vp09.00.50.08',
    );
  });

  it('preserves fully-qualified VP9/AV1 strings when no bit-depth change is requested', () => {
    expect(buildVideoEncoderConfig({}, src, 'vp09.02.50.10').codec).toBe('vp09.02.50.10');
    expect(buildVideoEncoderConfig({ bitDepth: 10 }, src, 'vp09.02.50.10').codec).toBe(
      'vp09.02.50.10',
    );
    expect(buildVideoEncoderConfig({}, src, 'av01.2.12M.12').codec).toBe('av01.2.12M.12');
  });

  it('rejects invalid depths, unsupported family/depth pairs, and outputs beyond defined levels', () => {
    expect(() =>
      buildVideoEncoderConfig({ codec: 'vp9', bitDepth: 9 as 8 }, src, undefined),
    ).toThrow(InputError);
    expect(() => buildVideoEncoderConfig({ codec: 'vp8', bitDepth: 10 }, src, undefined)).toThrow(
      CapabilityError,
    );
    expect(() => buildVideoEncoderConfig({ codec: 'h264', bitDepth: 10 }, src, undefined)).toThrow(
      CapabilityError,
    );
    expect(() => buildVideoEncoderConfig({ codec: 'hevc', bitDepth: 12 }, src, undefined)).toThrow(
      CapabilityError,
    );
    expect(() =>
      buildVideoEncoderConfig(
        { codec: 'vp9', width: 20_000, height: 10_000, fps: 120 },
        src,
        undefined,
      ),
    ).toThrow(CapabilityError);
    expect(() =>
      buildVideoEncoderConfig(
        { codec: 'av1', width: 20_000, height: 10_000, fps: 120 },
        src,
        undefined,
      ),
    ).toThrow(CapabilityError);
  });

  it('preserves the source codec when none is requested', () => {
    expect(buildVideoEncoderConfig({}, src, 'avc1.640028').codec).toBe('avc1.640028');
  });

  it('preserves HEVC Main10 and rejects profiles outside Main/Main10', () => {
    expect(buildVideoEncoderConfig({}, src, 'hev1.2.4.L93.90').codec).toBe('hev1.2.4.L93.90');
    expect(() => buildVideoEncoderConfig({}, src, 'hvc1.3.80000000.H120.40.00.80')).toThrow(
      CapabilityError,
    );
  });

  it('honors requested 8-bit output and authors explicit HEVC Main10 output', () => {
    expect(buildVideoEncoderConfig({ codec: 'h264', bitDepth: 8 }, src, undefined).codec).toBe(
      'avc1.42E028',
    );
    expect(buildVideoEncoderConfig({ codec: 'hevc', bitDepth: 10 }, src, undefined)).toMatchObject({
      codec: 'hvc1.2.4.L120.B0',
      width: 1920,
      height: 1080,
      latencyMode: 'quality',
    });
  });

  it('rejects when output dimensions cannot be determined', () => {
    expect(() =>
      buildVideoEncoderConfig(
        { codec: 'h264' },
        { width: undefined, height: undefined },
        undefined,
      ),
    ).toThrow(InputError);
  });
});

describe('webkitVideoTranscodeDeclineReason', () => {
  // Only sub-modes whose behaviour is still unverified are declined. `colorspace`, `rotate:90|180` and
  // fps downsample were declined on a claim that measurement disproved: they completed all along, and
  // their output is correct now that an RGB-sourced encode is muxed with the codec-default colour range.
  it('declines only the sub-modes that remain unverified on WebKit', () => {
    expect(webkitVideoTranscodeDeclineReason({ alpha: 'keep' })).toContain('alpha-preserving');
    expect(webkitVideoTranscodeDeclineReason({ tonemap: { to: 'sdr' } })).toContain('tonemap');
  });

  it('no longer declines the transforms the colour-range fix made correct', () => {
    for (const target of [
      { fps: 15 },
      { fps: 1 },
      { rotate: 90 as const },
      { rotate: 180 as const },
      { colorspace: { to: 'bt2020' } },
      { colorspace: { to: 'bt709' } },
    ]) {
      expect(webkitVideoTranscodeDeclineReason(target), JSON.stringify(target)).toBeUndefined();
    }
  });

  it('leaves every unfiltered target runnable', () => {
    expect(webkitVideoTranscodeDeclineReason({ fps: 30 })).toBeUndefined();
    expect(webkitVideoTranscodeDeclineReason({ fps: 60 })).toBeUndefined();
    expect(webkitVideoTranscodeDeclineReason({ rotate: 270 })).toBeUndefined();
    expect(webkitVideoTranscodeDeclineReason({ width: 1280, height: 720 })).toBeUndefined();
    expect(webkitVideoTranscodeDeclineReason({})).toBeUndefined();
  });
});

describe('webkitCrossCodecH264Config', () => {
  const baseline = {
    codec: 'avc1.42E028',
    width: 1920,
    height: 1080,
  } satisfies VideoEncoderConfig;

  it('uses level-equivalent High profile for known cross-codec input', () => {
    expect(webkitCrossCodecH264Config(baseline, 'hvc1.1.6.L93.B0')).toMatchObject({
      codec: 'avc1.640028',
    });
    expect(webkitCrossCodecH264Config(baseline, 'vp09.00.31.08')).toMatchObject({
      codec: 'avc1.640028',
    });
  });

  it('retains AVC, unrelated targets, and unknown-source configurations', () => {
    expect(webkitCrossCodecH264Config(baseline, 'avc1.42E028')).toBe(baseline);
    expect(webkitCrossCodecH264Config(baseline, undefined)).toBe(baseline);
    const hevc = { ...baseline, codec: 'hvc1.1.6.L93.B0' };
    expect(webkitCrossCodecH264Config(hevc, 'vp09.00.31.08')).toBe(hevc);
  });
});

describe('webkitAdtsAacLeadingSamples', () => {
  it('matches only first-party raw ADTS AAC decode', () => {
    expect(webkitAdtsAacLeadingSamples('adts', 'mp4a.40.2')).toBe(2112);
    expect(webkitAdtsAacLeadingSamples('adts', 'aac')).toBe(2112);
    expect(webkitAdtsAacLeadingSamples('mp4', 'mp4a.40.2')).toBe(0);
    expect(webkitAdtsAacLeadingSamples('adts', 'opus')).toBe(0);
    expect(webkitAdtsAacLeadingSamples(undefined, 'mp4a.40.2')).toBe(0);
  });

  it('subtracts the source-clock lead-in from duration without mutating the track', () => {
    const track: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      durationSec: (861 * 1024) / 44_100,
      config: { codec: 'mp4a.40.2', sampleRate: 44_100, numberOfChannels: 2 },
    };
    const adjusted = audioTrackAfterLeadingSampleTrim(track, 2112);
    expect(adjusted).not.toBe(track);
    expect(adjusted.durationSec).toBeCloseTo((861 * 1024 - 2112) / 44_100, 12);
    expect(track.durationSec).toBe((861 * 1024) / 44_100);
    expect(audioTrackAfterLeadingSampleTrim(track, 0)).toBe(track);
  });

  it('subtracts only decoder-proven MP3 gapless suppression without mutating the source', () => {
    const track: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: 'mp3',
      gapless: {
        basis: 'mp3-xing-lame',
        leadingSamples: 1105,
        trailingSamples: 687,
        totalSamples: 101888,
      },
    };
    const adjusted = audioTrackAfterNativeGaplessSuppression(track, 529);
    expect(adjusted).not.toBe(track);
    expect(adjusted.gapless?.leadingSamples).toBe(576);
    expect(track.gapless?.leadingSamples).toBe(1105);
    expect(audioTrackAfterNativeGaplessSuppression(track, 0)).toBe(track);
    expect(audioTrackAfterNativeGaplessSuppression(track, 1106)).toBe(track);
  });
});

describe('firefoxAdtsAacLeadingSamples', () => {
  it('matches one AAC-LC access unit only for first-party raw ADTS AAC decode', () => {
    expect(FIREFOX_ADTS_AAC_LEADING_SAMPLES).toBe(1024);
    expect(firefoxAdtsAacLeadingSamples('adts', 'mp4a.40.2')).toBe(1024);
    expect(firefoxAdtsAacLeadingSamples('adts', 'aac')).toBe(1024);
    expect(firefoxAdtsAacLeadingSamples('mp4', 'mp4a.40.2')).toBe(0);
    expect(firefoxAdtsAacLeadingSamples('adts', 'opus')).toBe(0);
  });
});

describe('firefoxVideoTranscodeDeclineReason', () => {
  it('declines Firefox VPx alpha-preserving encode subcases', () => {
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9', alpha: 'keep' }, undefined),
    ).toContain('VPx alpha-preserving');
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp8', alpha: 'keep' }, undefined),
    ).toContain('VPx alpha-preserving');
    expect(firefoxVideoTranscodeDeclineReason({ alpha: 'keep' }, 'vp9')).toContain(
      'VPx alpha-preserving',
    );
    expect(firefoxVideoTranscodeDeclineReason({ alpha: 'keep' }, 'vp09.00.10.08')).toContain(
      'VPx alpha-preserving',
    );
  });

  it('does not guess alpha-preserving declines without a known VPx target', () => {
    expect(firefoxVideoTranscodeDeclineReason({ alpha: 'keep' }, undefined)).toBeUndefined();
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9', alpha: 'discard' }, undefined),
    ).toBeUndefined();
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9', width: 320 }, undefined),
    ).toBeUndefined();
  });

  it('no longer declines Firefox VP9 on fixture-size timeout (general cost model)', () => {
    // Former overfit declined 5s 640×360-or-larger (230400 px) and 30s 1920×1080 based on suite fixtures.
    // Now handled by generic videoFilterRouteCost / throughput, not hard 5s/230400 constants.
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9' }, 'avc1.640028', {
        width: 1920,
        height: 1080,
        fps: 30,
        durationSec: 30,
      }),
    ).toBeUndefined();
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9', width: 640, height: 360 }, 'avc1.640028', {
        width: 1280,
        height: 720,
        fps: 30,
        durationSec: 5,
      }),
    ).toBeUndefined();
  });

  it('keeps shorter, smaller, or unknown-duration Firefox VP9 transcodes runnable', () => {
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9' }, 'avc1.640028', {
        width: 1920,
        height: 1080,
        fps: 30,
        durationSec: 4.99,
      }),
    ).toBeUndefined();
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9', width: 320, height: 180 }, 'avc1.640028', {
        width: 1920,
        height: 1080,
        fps: 30,
        durationSec: 30,
      }),
    ).toBeUndefined();
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9' }, 'avc1.640028', {
        width: 1920,
        height: 1080,
        fps: 30,
      }),
    ).toBeUndefined();
  });
});

describe('planVideoRateControl', () => {
  it('plans bitrate, CRF, and two-pass requests distinctly', () => {
    expect(planVideoRateControl({}, undefined)).toEqual({ mode: 'default' });
    expect(planVideoRateControl({ bitrate: 3_000_000 }, 'avc1.42E01E')).toEqual({
      mode: 'bitrate',
      bitrate: 3_000_000,
      bitrateMode: 'variable',
    });
    expect(
      planVideoRateControl({ bitrate: 3_000_000, bitrateMode: 'constant' }, 'avc1.42E01E'),
    ).toEqual({
      mode: 'bitrate',
      bitrate: 3_000_000,
      bitrateMode: 'constant',
    });
    expect(planVideoRateControl({ crf: 23 }, 'avc1.42E01E')).toEqual({
      mode: 'crf',
      crf: 23,
      codec: 'h264',
      bitrateMode: 'quantizer',
      quantizer: 23,
      webCodecsConfigurable: true,
    });
    expect(planVideoRateControl({ crf: 23 }, 'vp8')).toEqual({
      mode: 'crf',
      crf: 23,
      codec: 'vp8',
      bitrateMode: 'quantizer',
      webCodecsConfigurable: false,
    });
    expect(planVideoRateControl({ bitrate: 3_000_000, twoPass: true }, 'avc1.42E01E')).toEqual({
      mode: 'two-pass-bitrate',
      bitrate: 3_000_000,
      passes: 2,
      webCodecsConfigurable: true,
      requiresReplay: true,
      firstPassQuantizer: 28,
    });
    expect(
      planVideoRateControl(
        {
          bitrate: 2_000_000,
          maxAverageBitrate: 2_600_000,
          quality: { metric: 'ssim-luma-v1', minimumMean: 0.93, samples: 8 },
        },
        'avc1.42E01E',
      ),
    ).toEqual({
      mode: 'quality-constrained-bitrate',
      preferredAverageBitrate: 2_000_000,
      maxAverageBitrate: 2_600_000,
      metric: 'ssim-luma-v1',
      minimumMean: 0.93,
      samples: 8,
      webCodecsConfigurable: true,
      requiresReplay: true,
      requiresFiniteSource: true,
      firstPassQuantizer: 28,
      maximumCandidatePasses: 3,
    });
  });

  it('rejects malformed or conflicting rate-control requests with typed errors', () => {
    expect(() => planVideoRateControl({ bitrate: -1 }, 'avc1.42E01E')).toThrow(InputError);
    expect(() => planVideoRateControl({ crf: 52 }, 'avc1.42E01E')).toThrow(InputError);
    expect(() => planVideoRateControl({ crf: 64 }, 'vp09.00.10.08')).toThrow(InputError);
    expect(() => planVideoRateControl({ bitrate: 1_000_000, crf: 23 }, 'avc1.42E01E')).toThrow(
      InputError,
    );
    expect(() => planVideoRateControl({ twoPass: true }, 'avc1.42E01E')).toThrow(InputError);
    expect(() =>
      planVideoRateControl(
        {
          bitrate: 2_000_000,
          maxAverageBitrate: 2_600_000,
          quality: { metric: 'ssim-luma-v1', minimumMean: 0.93 },
        },
        'vp09.00.10.08',
      ),
    ).toThrow(CapabilityError);
    expect(() =>
      planVideoRateControl(
        {
          bitrate: 2_000_000,
          maxAverageBitrate: 2_600_000,
          quality: { metric: 'ssim-luma-v1', minimumMean: 0.93 },
          twoPass: false,
        },
        'avc1.42E01E',
      ),
    ).toThrow(InputError);
  });
});

describe('planVideoBitDepthConversion', () => {
  it('plans supported 10-bit H.264 → 8-bit H.264 down-conversion as a pixel-path requirement', () => {
    expect(
      planVideoBitDepthConversion({
        sourceCodec: 'avc1.6E0033',
        targetCodec: 'avc1.42E028',
      }),
    ).toEqual({
      kind: 'downconvert',
      sourceBitDepth: 10,
      targetBitDepth: 8,
      requiresPixelPath: true,
    });
  });

  it('keeps same-depth transcodes as no-op and plans an explicit Main10 sample-widening path', () => {
    expect(
      planVideoBitDepthConversion({
        sourceCodec: 'avc1.42E01E',
        targetCodec: 'avc1.42E028',
      }),
    ).toEqual({
      kind: 'none',
      sourceBitDepth: 8,
      targetBitDepth: 8,
      requiresPixelPath: false,
    });
    expect(
      planVideoBitDepthConversion({
        sourceCodec: 'avc1.42E028',
        targetCodec: 'hev1.2.4.L120.B0',
      }),
    ).toEqual({
      kind: 'encoder-widen',
      sourceBitDepth: 8,
      targetBitDepth: 10,
      requiresPixelPath: true,
    });
  });

  it('reads bit-depth from explicit values and VPx/AV1 codec strings', () => {
    expect(planVideoBitDepthConversion({ sourceBitDepth: 10, targetBitDepth: 8 })).toEqual({
      kind: 'downconvert',
      sourceBitDepth: 10,
      targetBitDepth: 8,
      requiresPixelPath: true,
    });
    expect(
      planVideoBitDepthConversion({
        sourceCodec: 'vp09.00.10.10',
        targetCodec: 'av01.0.04M.08',
      }),
    ).toEqual({
      kind: 'downconvert',
      sourceBitDepth: 10,
      targetBitDepth: 8,
      requiresPixelPath: true,
    });
    expect(
      planVideoBitDepthConversion({
        sourceCodec: 'vp8',
        targetCodec: 'unknown',
      }),
    ).toEqual({
      kind: 'none',
      sourceBitDepth: 8,
      targetBitDepth: undefined,
      requiresPixelPath: false,
    });
    expect(() => planVideoBitDepthConversion({ sourceBitDepth: 9, targetBitDepth: 8 })).toThrow(
      InputError,
    );
    expect(planVideoBitDepthConversion({ sourceBitDepth: 12, targetBitDepth: 8 })).toEqual({
      kind: 'downconvert',
      sourceBitDepth: 12,
      targetBitDepth: 8,
      requiresPixelPath: true,
    });
  });
});

describe('planH264AbrLadder', () => {
  it('normalizes H.264 ABR rungs into convert options and encoder configs in input order', () => {
    const ladder = planH264AbrLadder(
      [
        { name: '720p', width: 1280, height: 720, bitrate: 3_000_000, fps: 30 },
        { name: '360p', width: 640, height: 360, bitrate: 800_000, fps: 30 },
      ],
      { width: 1920, height: 1080 },
    );
    expect(ladder.map((rung) => rung.name)).toEqual(['720p', '360p']);
    expect(ladder.map((rung) => rung.options)).toEqual([
      {
        to: 'mp4',
        video: {
          codec: 'h264',
          width: 1280,
          height: 720,
          bitrate: 3_000_000,
          fps: 30,
        },
      },
      {
        to: 'mp4',
        video: {
          codec: 'h264',
          width: 640,
          height: 360,
          bitrate: 800_000,
          fps: 30,
        },
      },
    ]);
    expect(ladder.map((rung) => rung.config.codec)).toEqual(['avc1.42E01F', 'avc1.42E01E']);
  });

  it('rejects an empty or malformed ABR ladder before worker fanout', () => {
    expect(() => planH264AbrLadder([], { width: 1920, height: 1080 })).toThrow(InputError);
    expect(() =>
      planH264AbrLadder([{ name: 'bad', width: 0, height: 720, bitrate: 3_000_000 }], {
        width: 1920,
        height: 1080,
      }),
    ).toThrow(InputError);
    expect(() =>
      planH264AbrLadder([{ width: 640, height: 0, bitrate: 800_000 }], {
        width: 1920,
        height: 1080,
      }),
    ).toThrow(InputError);
    expect(() =>
      planH264AbrLadder([{ width: 640, height: 360, bitrate: 0 }], {
        width: 1920,
        height: 1080,
      }),
    ).toThrow(InputError);
    expect(() =>
      planH264AbrLadder([{ width: 640, height: 360, bitrate: 800_000, fps: Number.NaN }], {
        width: 1920,
        height: 1080,
      }),
    ).toThrow(InputError);
  });

  it('fills generated names and omits fps when a rung does not request frame-rate conversion', () => {
    expect(
      planH264AbrLadder([{ width: 640, height: 360, bitrate: 800_000 }], {
        width: 1920,
        height: 1080,
      })[0]?.options,
    ).toEqual({
      to: 'mp4',
      video: { codec: 'h264', width: 640, height: 360, bitrate: 800_000 },
    });
  });
});

// ── H.264 level selection (gap #1) ───────────────────────────────────────────────────────────────

describe('h264LevelIdcForDimensions (Annex A Table A-1, min level satisfying MaxFS + MaxMBPS)', () => {
  it('picks the minimum level whose frame-size AND throughput bounds both hold', () => {
    // 320×180 = 240 MBs @30 = 7200 MBPS → L1.3 (0x0D) is the first to clear 11880 MBPS at ≤396 MaxFS
    expect(h264LevelIdcForDimensions(320, 180, undefined)).toBe(0x0d);
    // 640×480 = 1200 MBs @30 = 36000 → L3.0 (0x1E): MaxFS 1620, MaxMBPS 40500
    expect(h264LevelIdcForDimensions(640, 480, 30)).toBe(0x1e);
    // 1280×720 = 3600 MBs @30 = 108000 → L3.1 (0x1F): exact MaxFS 3600 + MaxMBPS 108000 boundary
    expect(h264LevelIdcForDimensions(1280, 720, 30)).toBe(0x1f);
    // 1920×1080 = 8160 MBs @30 = 244800 → L4.0 (0x28): MaxFS 8192, MaxMBPS 245760
    expect(h264LevelIdcForDimensions(1920, 1080, 30)).toBe(0x28);
    // 1920×1080 @60 = 489600 MBPS → L4.2 (0x2A): L4.0/4.1 cap at 245760
    expect(h264LevelIdcForDimensions(1920, 1080, 60)).toBe(0x2a);
    // 3840×2160 = 32400 MBs @30 = 972000 → L5.1 (0x33): MaxFS 36864, MaxMBPS 983040
    expect(h264LevelIdcForDimensions(3840, 2160, 30)).toBe(0x33);
  });

  it('rounds partial macroblocks up (non-multiple-of-16 dims) before the MaxFS check', () => {
    // 1920×1088 rounds to 120×68 = 8160 MBs (same as 1080, which uses ceil(1080/16)=68 too)
    expect(h264LevelIdcForDimensions(1920, 1088, 30)).toBe(0x28);
    // 17×17 → ceil = 2×2 = 4 MBs → L1.0 (0x0A)
    expect(h264LevelIdcForDimensions(17, 17, 30)).toBe(0x0a);
  });

  it('defaults fps to 30 for the throughput bound when unknown', () => {
    expect(h264LevelIdcForDimensions(1920, 1080, undefined)).toBe(0x28); // == @30
    expect(h264LevelIdcForDimensions(1920, 1080, 0)).toBe(0x28); // 0 fps treated as the default
  });

  it('falls back to the top level (6.2 = 0x3E) for an over-spec resolution rather than throwing', () => {
    expect(h264LevelIdcForDimensions(16384, 16384, 120)).toBe(0x3e);
  });
});

describe('h264CodecStringForDimensions', () => {
  it('emits Constrained-Baseline avc1.42E0<LL> with the two-hex upper-case level byte', () => {
    expect(h264CodecStringForDimensions(320, 180, 30)).toBe('avc1.42E00D');
    expect(h264CodecStringForDimensions(1920, 1080, 30)).toBe('avc1.42E028');
    expect(h264CodecStringForDimensions(3840, 2160, 30)).toBe('avc1.42E033');
  });

  it('tiny H.264 encode configs use spec-correct Annex-A minimum (no browser floor)', () => {
    // Annex-A correct minimum for 320×180@30 is L1.3 (0x0D, 396 fs, 11880 mbps) and for 1×1@30 is L1.0 (0x0A).
    // The former floor to L3.0 (0x1E) was an overfit to a single Chromium 149 seek bug on tiny outputs.
    expect(h264LevelIdcForDimensions(320, 180, undefined)).toBe(0x0d);
    expect(h264CodecStringForDimensions(320, 180, undefined)).toBe('avc1.42E00D');
    expect(h264CodecStringForDimensions(1, 1, 30)).toBe('avc1.42E00A');
  });
});

// ── decoder codec-string normalization (gap #2) ─────────────────────────────────────────────────

describe('normalizeDecoderCodec', () => {
  it('expands bare WebM/Matroska tokens to valid WebCodecs decode strings', () => {
    expect(normalizeDecoderCodec({ codec: 'vp9' })).toBe('vp09.00.10.08');
    expect(normalizeDecoderCodec({ codec: 'av1' })).toBe('av01.0.04M.08');
    expect(normalizeDecoderCodec({ codec: 'VP9' })).toBe('vp09.00.10.08'); // case-insensitive token
    expect(normalizeDecoderCodec({ codec: 'vp8' })).toBe('vp8'); // already a complete VP8 string
  });

  it('passes already-qualified strings through unchanged (mp4/mov configs are untouched)', () => {
    for (const c of [
      'avc1.640028',
      'avc3.42E01E',
      'hev1.1.6.L93.B0',
      'hvc1.2.4.L120',
      'vp09.02.10.10',
      'av01.0.08M.10',
      'opus',
      'mp4a.40.2',
      'flac',
      'vorbis',
    ]) {
      expect(normalizeDecoderCodec({ codec: c })).toBe(c);
    }
  });

  it('derives avc1.PPCCLL from an H.264 description (avcC profile/compat/level bytes)', () => {
    // AVCDecoderConfigurationRecord: [version, profile, compat, level, ...] → High(0x64) compat 0x00 L4.0(0x28)
    const avcC = new Uint8Array([0x01, 0x64, 0x00, 0x28, 0xff, 0xe1]);
    expect(normalizeDecoderCodec({ codec: 'h264', description: avcC })).toBe('avc1.640028');
    // a typed-array view with a non-zero byteOffset must read the right window
    const padded = new Uint8Array([0xaa, 0xbb, 0x01, 0x42, 0xc0, 0x1f]);
    const view = padded.subarray(2);
    expect(normalizeDecoderCodec({ codec: 'h264', description: view })).toBe('avc1.42C01F');
  });

  it('derives hvc1.* from an HEVC description (hvcC profile/compat/tier/level bytes)', () => {
    // A present hvcC description means the parameter sets are out-of-band (the hvc1 sample-entry form),
    // so the expansion uses the hvc1 prefix — mirroring avc1 for an out-of-band avcC and keeping the
    // string maximally decodable (advertising hev1 to an hvc1-style bitstream can yield a 0×0 decode).
    // Real h265.mp4 hvcC bytes: Main, compat 6, low tier, level 60, constraint 0x90.
    const hvcC8Bit = Uint8Array.from([0x01, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x3c]);
    expect(normalizeDecoderCodec({ codec: 'hevc', description: hvcC8Bit })).toBe('hvc1.1.6.L60.90');

    // Real bear-hevc-10bit-hdr10 shape: Main10, compat 4, low tier, level 93, constraint 0x90.
    const hvcC10Bit = Uint8Array.from([0x01, 0x02, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d]);
    expect(normalizeDecoderCodec({ codec: 'h265', description: hvcC10Bit })).toBe(
      'hvc1.2.4.L93.90',
    );
  });

  it('leaves a bare h264/hevc token unchanged when no usable description is available', () => {
    // Without the CodecPrivate the bare token cannot be expanded — honest miss, not a wrong guess.
    expect(normalizeDecoderCodec({ codec: 'h264' })).toBe('h264');
    expect(normalizeDecoderCodec({ codec: 'hevc' })).toBe('hevc');
    // too-short avcC/hvcC → cannot parse → unchanged
    expect(
      normalizeDecoderCodec({
        codec: 'h264',
        description: new Uint8Array([0x01, 0x64]),
      }),
    ).toBe('h264');
    expect(
      normalizeDecoderCodec({
        codec: 'hevc',
        description: new Uint8Array([0x01, 0x02, 0x20]),
      }),
    ).toBe('hevc');
  });
});

describe('buildAudioEncoderConfig', () => {
  const src = { sampleRate: 48000, channels: 2 };

  it('builds a config with codec, sample rate, channels, and optional bitrate', () => {
    expect(buildAudioEncoderConfig({ codec: 'aac', bitrate: 128_000 }, src, undefined)).toEqual({
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
  });

  it('falls back to the source sample rate / channels', () => {
    const cfg = buildAudioEncoderConfig({ codec: 'opus' }, src, undefined);
    expect(cfg.sampleRate).toBe(48000);
    expect(cfg.numberOfChannels).toBe(2);
  });

  it('honors target overrides of sample rate / channels', () => {
    const cfg = buildAudioEncoderConfig(
      { codec: 'aac', sampleRate: 44100, channels: 1 },
      src,
      undefined,
    );
    expect(cfg.sampleRate).toBe(44100);
    expect(cfg.numberOfChannels).toBe(1);
  });

  it('rejects when sample rate / channels are unknown', () => {
    expect(() =>
      buildAudioEncoderConfig(
        { codec: 'aac' },
        { sampleRate: undefined, channels: undefined },
        undefined,
      ),
    ).toThrow(InputError);
  });
});

describe('Opus audio target normalization / Firefox wasm routing', () => {
  it('defaults every implicit Opus output to its fixed 48 kHz presentation rate', () => {
    expect(defaultOpusAudioEncodeTarget({ codec: 'opus', bitrate: 128_000 }, 'mp4a.40.2')).toEqual({
      codec: 'opus',
      bitrate: 128_000,
      sampleRate: 48000,
    });
    expect(defaultOpusAudioEncodeTarget({}, 'opus')).toEqual({ sampleRate: 48000 });

    const explicit = { codec: 'opus', sampleRate: 24_000 } as const;
    expect(defaultOpusAudioEncodeTarget(explicit, 'flac')).toBe(explicit);
    const aac = { codec: 'aac', bitrate: 192_000 } as const;
    expect(defaultOpusAudioEncodeTarget(aac, 'mp3')).toBe(aac);
  });

  it('normalizes explicit Firefox Opus audio targets to the wasm-supported 48 kHz rate', () => {
    expect(firefoxOpusAudioEncodeTarget({ codec: 'opus', bitrate: 128_000 }, 'mp3')).toEqual({
      codec: 'opus',
      bitrate: 128_000,
      sampleRate: 48000,
    });
    expect(firefoxOpusAudioEncodeTarget({ codec: 'opus', sampleRate: 24000 }, 'flac')).toEqual({
      codec: 'opus',
      sampleRate: 48000,
    });
  });

  it('normalizes preserve-source Opus targets and leaves non-Opus targets untouched', () => {
    expect(firefoxOpusAudioEncodeTarget({}, 'opus')).toEqual({
      sampleRate: 48000,
    });
    const aac = { codec: 'aac', bitrate: 192_000 } as const;
    expect(firefoxOpusAudioEncodeTarget(aac, 'mp3')).toBe(aac);
  });

  it('declines only the Firefox MP3-source to Opus-target long-matrix timeout path', () => {
    expect(firefoxAudioTranscodeDeclineReason({ codec: 'opus' }, 'mp3')).toContain('MP3-to-Opus');
    expect(firefoxAudioTranscodeDeclineReason({ codec: 'opus' }, 'mp4a.40.2')).toBeUndefined();
    expect(firefoxAudioTranscodeDeclineReason({ codec: 'opus' }, 'flac')).toBeUndefined();
    expect(firefoxAudioTranscodeDeclineReason({ codec: 'aac' }, 'mp3')).toBeUndefined();
  });

  it('routes only wasm-supported Firefox Opus encoder configs through the wasm tail', () => {
    expect(
      firefoxOpusEncodeUsesWasm({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128_000,
      }),
    ).toBe(true);
    expect(
      firefoxOpusEncodeUsesWasm({
        codec: 'opus',
        sampleRate: 44100,
        numberOfChannels: 2,
      }),
    ).toBe(false);
    expect(
      firefoxOpusEncodeUsesWasm({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 6,
      }),
    ).toBe(false);
    expect(
      firefoxOpusEncodeUsesWasm({
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
      }),
    ).toBe(false);
  });

  it('routes Firefox Vorbis configs through the libvorbisenc wasm tail', () => {
    expect(
      firefoxVorbisEncodeUsesWasm({
        codec: 'vorbis',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128_000,
      }),
    ).toBe(true);
    expect(
      firefoxVorbisEncodeUsesWasm({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
      }),
    ).toBe(false);
  });
});

describe('runtime-aware transcode preflight helpers', () => {
  const firefoxNavigator = {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
    vendor: '',
  };
  const safariNavigator = {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    vendor: 'Apple Computer, Inc.',
  };
  const chromeNavigator = {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    vendor: 'Google Inc.',
  };

  it('applies portable Opus defaults on Chromium and uses the normal encoder config path', async () => {
    await withNavigator(chromeNavigator, async () => {
      const aac = { codec: 'aac', bitrate: 192_000 } as const;
      expect(await resolveAudioEncodeTargetForRuntime(aac, 'mp3')).toBe(aac);
      await expect(
        resolveAudioEncodeTargetForRuntime({ codec: 'opus', bitrate: 128_000 }, 'mp4a.40.2'),
      ).resolves.toEqual({ codec: 'opus', bitrate: 128_000, sampleRate: 48000 });
      const explicitOpus = { codec: 'opus', sampleRate: 24_000 } as const;
      await expect(resolveAudioEncodeTargetForRuntime(explicitOpus, 'flac')).resolves.toBe(
        explicitOpus,
      );
      await expect(
        buildVideoEncoderConfigForRuntime({ codec: 'vp8' }, { width: 320, height: 240 }, 'vp8'),
      ).resolves.toMatchObject({ codec: 'vp8' });
      await expect(
        buildVideoEncoderConfigForRuntime(
          { codec: 'h264' },
          { width: 1920, height: 1080, fps: 30 },
          'hvc1.1.6.L93.B0',
        ),
      ).resolves.toMatchObject({ codec: 'avc1.42E028' });
      expect(
        await audioEncodeNeedsSoftwareRuntime({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      ).toBe(false);
      await expect(
        audioEncodeSoftwareDriverForRuntime({
          codec: 'vorbis',
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      ).resolves.toBeUndefined();
      await expect(
        vpxAlphaDecodeSoftwareDriverForRuntime('webcodecs-video'),
      ).resolves.toBeUndefined();
    });
  });

  it('keeps WebKit video declines typed and scoped to unstable filtered paths', async () => {
    await withNavigator(safariNavigator, async () => {
      await expect(
        audioDecodeLeadingSamplesForRuntime('adts', 'mp4a.40.2', 'webcodecs-audio'),
      ).resolves.toBe(2112);
      await expect(
        audioDecodeLeadingSamplesForRuntime('adts', 'mp4a.40.2', 'wasm-aac'),
      ).resolves.toBe(0);
      const mp3Track: TrackInfo = {
        id: 0,
        mediaType: 'audio',
        codec: 'mp3',
        gapless: { basis: 'mp3-xing-lame', leadingSamples: 1105 },
      };
      await expect(
        audioDecodeNativeGaplessSuppressionForRuntime('mp3', mp3Track, 'webcodecs-audio'),
      ).resolves.toBe(529);
      await expect(
        audioDecodeNativeGaplessSuppressionForRuntime('mp3', mp3Track, 'wasm-mp3'),
      ).resolves.toBe(0);
      await expect(
        buildVideoEncoderConfigForRuntime({ alpha: 'keep' }, { width: 320, height: 240 }, 'vp9'),
      ).rejects.toThrow(CapabilityError);
      await expect(
        buildVideoEncoderConfigForRuntime({ codec: 'vp8' }, { width: 320, height: 240 }, 'vp9'),
      ).resolves.toMatchObject({ codec: 'vp8' });
      await expect(
        buildVideoEncoderConfigForRuntime(
          { codec: 'h264' },
          { width: 1920, height: 1080, fps: 30 },
          'hvc1.1.6.L93.B0',
        ),
      ).resolves.toMatchObject({ codec: 'avc1.640028' });
      expect(
        await audioEncodeNeedsSoftwareRuntime({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 128_000,
        }),
      ).toBe(true);
      expect(
        await audioEncodeNeedsSoftwareRuntime({
          codec: 'mp4a.40.2',
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      ).toBe(false);
      await expect(
        audioEncodeSoftwareDriverForRuntime({
          codec: 'vorbis',
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      ).resolves.toBeUndefined();
      await expect(
        vpxAlphaDecodeSoftwareDriverForRuntime('webcodecs-video'),
      ).resolves.toBeUndefined();
    });
  });

  it('applies Firefox-specific video, Opus, and Vorbis routing evidence', async () => {
    await withNavigator(firefoxNavigator, async () => {
      await expect(
        audioDecodeLeadingSamplesForRuntime('adts', 'mp4a.40.2', 'webcodecs-audio'),
      ).resolves.toBe(1024);
      await expect(
        audioDecodeLeadingSamplesForRuntime('mp4', 'mp4a.40.2', 'webcodecs-audio'),
      ).resolves.toBe(0);
      await expect(
        audioDecodeLeadingSamplesForRuntime('adts', 'mp4a.40.2', 'wasm-aac'),
      ).resolves.toBe(0);
      await expect(
        buildVideoEncoderConfigForRuntime(
          { codec: 'vp9' },
          { width: 640, height: 360, durationSec: 5 },
          'h264',
        ),
      ).resolves.toBeDefined();
      await expect(resolveAudioEncodeTargetForRuntime({ codec: 'opus' }, 'flac')).resolves.toEqual({
        codec: 'opus',
        sampleRate: 48000,
      });
      await expect(resolveAudioEncodeTargetForRuntime({ codec: 'opus' }, 'mp3')).rejects.toThrow(
        CapabilityError,
      );
      expect(
        await audioEncodeNeedsSoftwareRuntime({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      ).toBe(true);
      await expect(
        audioEncodeSoftwareDriverForRuntime({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      ).resolves.toBe('wasm-opus');
      await expect(
        audioEncodeSoftwareDriverForRuntime({
          codec: 'vorbis',
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 128_000,
        }),
      ).resolves.toBe('wasm-vorbis-enc');
      expect(
        await audioEncodeNeedsSoftwareRuntime({
          codec: 'vorbis',
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      ).toBe(true);
      await expect(vpxAlphaDecodeSoftwareDriverForRuntime('webcodecs-video')).resolves.toBe(
        'wasm-vpx',
      );
      await expect(vpxAlphaDecodeSoftwareDriverForRuntime('wasm-vpx')).resolves.toBeUndefined();
    });
  });
});

// ── mux TrackInfo ────────────────────────────────────────────────────────────────────────────────

describe('videoTrackInfoFromDecoderConfig / audioTrackInfoFromDecoderConfig', () => {
  it('carries the encoder-published decoder config (codec + description) into the TrackInfo', () => {
    const description = new Uint8Array([1, 2, 3, 4]);
    const info = videoTrackInfoFromDecoderConfig(
      { codec: 'avc1.42E01E', codedWidth: 640, codedHeight: 480, description },
      30,
      12.5,
    );
    expect(info).toEqual<TrackInfo>({
      id: 0,
      mediaType: 'video',
      codec: 'avc1.42E01E',
      config: {
        codec: 'avc1.42E01E',
        codedWidth: 640,
        codedHeight: 480,
        description,
      },
      fps: 30,
      durationSec: 12.5,
    });
  });

  it('omits fps when undefined (exactOptionalPropertyTypes)', () => {
    const info = videoTrackInfoFromDecoderConfig({ codec: 'vp09.00.10.08' }, undefined);
    expect('fps' in info).toBe(false);
    expect('durationSec' in info).toBe(false);
  });

  it('builds the audio TrackInfo from the AAC decoder config and declared duration', () => {
    const description = new Uint8Array([0x12, 0x10]);
    expect(
      audioTrackInfoFromDecoderConfig(
        {
          codec: 'mp4a.40.2',
          sampleRate: 48000,
          numberOfChannels: 2,
          description,
        },
        9.75,
      ),
    ).toEqual<TrackInfo>({
      id: 0,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      config: {
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
        description,
      },
      durationSec: 9.75,
    });
  });

  it('replaces real MP3 gapless facts with destination-owned 48 kHz Opus timing', async () => {
    const { parseMp3 } = await import('../drivers/mp3/mp3-driver.ts');
    const { loadFixture } = await import('../test-support/corpus.ts');
    const source = parseMp3(await loadFixture('sound_5.mp3'));
    expect(source.gapless).toEqual({
      basis: 'mp3-xing-lame',
      leadingSamples: 1_105,
      trailingSamples: 384,
      totalSamples: 110_255,
      mp3Lame: { encoderDelaySamples: 576, encoderPaddingSamples: 913 },
    });
    if (source.gapless === undefined) throw new Error('expected the real MP3 gapless tuple');
    const output = outputGaplessForAudioEncoder(
      { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 },
      {
        sampleRate: 48_000,
        submittedSamples: source.gapless.totalSamples ?? 0,
        codedSamples: 111_360,
        leadingSamples: 312,
      },
    );
    expect(output).toEqual({
      leadingSamples: 312,
      trailingSamples: 793,
      totalSamples: 110_255,
    });
    expect(output?.leadingSamples).not.toBe(source.gapless.leadingSamples);
    expect(output?.trailingSamples).not.toBe(source.gapless.trailingSamples);
  });
});

// ── stream-copy auto-route ─────────────────────────────────────────────────────────────────────

describe('isPureStreamCopy', () => {
  it('is true when no re-encode is requested for either stream', () => {
    expect(isPureStreamCopy({})).toBe(true);
    expect(isPureStreamCopy({ video: {}, audio: {} })).toBe(true);
    expect(isPureStreamCopy({ video: { twoPass: false } })).toBe(true);
    expect(isPureStreamCopy({ audio: { gainDb: 0 } })).toBe(true);
  });

  it('is false when any re-encode trigger is present', () => {
    expect(isPureStreamCopy({ video: { codec: 'h264' } })).toBe(false);
    expect(isPureStreamCopy({ video: { width: 1280 } })).toBe(false);
    expect(isPureStreamCopy({ video: { fit: 'contain' } })).toBe(false);
    expect(isPureStreamCopy({ video: { bitDepth: 10 } })).toBe(false);
    expect(isPureStreamCopy({ video: { bitrateMode: 'constant' } })).toBe(false);
    expect(isPureStreamCopy({ video: { twoPass: true } })).toBe(false);
    expect(isPureStreamCopy({ video: { alpha: 'discard' } })).toBe(false);
    expect(isPureStreamCopy({ video: { rotate: 90 } })).toBe(false);
    expect(
      isPureStreamCopy({
        video: { crop: { x: 0, y: 0, width: 10, height: 10 } },
      }),
    ).toBe(false);
    expect(isPureStreamCopy({ video: { pad: { width: 1920, height: 1080 } } })).toBe(false);
    expect(isPureStreamCopy({ video: { colorspace: { to: 'bt2020' } } })).toBe(false);
    expect(isPureStreamCopy({ video: { tonemap: { to: 'sdr' } } })).toBe(false);
    expect(isPureStreamCopy({ audio: { codec: 'opus' } })).toBe(false);
    expect(isPureStreamCopy({ audio: { sampleRate: 44100 } })).toBe(false);
    expect(isPureStreamCopy({ audio: { bitrate: 96_000 } })).toBe(false);
    expect(isPureStreamCopy({ audio: { gainDb: -6 } })).toBe(false);
    expect(isPureStreamCopy({ audio: { fade: { inSec: 1 } } })).toBe(false);
    expect(isPureStreamCopy({ audio: { mixMatrix: [[0.5, 0.5]], channels: 1 } })).toBe(false);
    expect(
      isPureStreamCopy({
        audio: { dynamics: { normalize: { mode: 'peak', targetDbfs: -3 } } },
      }),
    ).toBe(false);
    expect(
      isPureStreamCopy({
        audio: { biquad: { type: 'lowpass', frequency: 1000, q: 1 } },
      }),
    ).toBe(false);
  });

  it('is false when a track is dropped (false), since copy keeps every track', () => {
    expect(isPureStreamCopy({ video: false })).toBe(false);
    expect(isPureStreamCopy({ audio: false })).toBe(false);
  });
});

// ── seek control flow ────────────────────────────────────────────────────────────────────────────

describe('frameSatisfiesSeek', () => {
  it('keeps a frame at or after the target, drops one before', () => {
    expect(frameSatisfiesSeek(1000, 1000)).toBe(true);
    expect(frameSatisfiesSeek(1001, 1000)).toBe(true);
    expect(frameSatisfiesSeek(999, 1000)).toBe(false);
  });
});

/** A fake closable frame carrying a presentation timestamp; tracks whether it was closed. */
class FakeFrame {
  closed = false;
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closed = true;
  }
}

function streamOf<T>(items: readonly T[]): ReadableStream<T> {
  let i = 0;
  return new ReadableStream<T>({
    pull(controller): void {
      if (i < items.length) controller.enqueue(items[i++] as T);
      else controller.close();
    },
  });
}

describe('seekFrame (drop-until-target, close-once)', () => {
  it('returns the first frame at/after the target and closes every dropped frame exactly once', async () => {
    const frames = [
      new FakeFrame(0),
      new FakeFrame(1000),
      new FakeFrame(2000),
      new FakeFrame(3000),
    ];
    const got = (await seekFrame(
      streamOf(frames) as unknown as ReadableStream<VideoFrame>,
      2000,
    )) as unknown as FakeFrame;
    expect(got.timestamp).toBe(2000);
    expect(got.closed).toBe(false); // returned frame is owned by the caller, not closed
    expect(frames[0]?.closed).toBe(true); // dropped (before target)
    expect(frames[1]?.closed).toBe(true); // dropped (before target)
    expect(frames[3]?.closed).toBe(false); // never pulled (cancel after target)
  });

  it('returns the target frame immediately when it is the first one', async () => {
    const frames = [new FakeFrame(5000), new FakeFrame(6000)];
    const got = (await seekFrame(
      streamOf(frames) as unknown as ReadableStream<VideoFrame>,
      0,
    )) as unknown as FakeFrame;
    expect(got.timestamp).toBe(5000);
    expect(frames[0]?.closed).toBe(false);
  });

  it('waits for downstream cancellation before returning the target frame', async () => {
    const target = new FakeFrame(5000);
    let resolveCancel: (() => void) | undefined;
    let cancelStarted = false;
    let cancelResolved = false;
    const stream = new ReadableStream<FakeFrame>({
      start(controller): void {
        controller.enqueue(target);
        controller.enqueue(new FakeFrame(6000));
      },
      cancel(): Promise<void> {
        cancelStarted = true;
        return new Promise<void>((resolve) => {
          resolveCancel = () => {
            cancelResolved = true;
            resolve();
          };
        });
      },
    });

    const pending = seekFrame(stream as unknown as ReadableStream<VideoFrame>, 0);
    await Promise.resolve();
    expect(cancelStarted).toBe(true);
    expect(cancelResolved).toBe(false);

    resolveCancel?.();
    const got = (await pending) as unknown as FakeFrame;
    expect(got).toBe(target);
    expect(got.closed).toBe(false);
    expect(cancelResolved).toBe(true);
  });

  it('returns the closest (last) frame when the target is past the final PTS', async () => {
    const frames = [new FakeFrame(0), new FakeFrame(1000), new FakeFrame(2000)];
    const got = (await seekFrame(
      streamOf(frames) as unknown as ReadableStream<VideoFrame>,
      99_999,
    )) as unknown as FakeFrame;
    expect(got.timestamp).toBe(2000); // the closest available frame
    expect(frames[0]?.closed).toBe(true);
    expect(frames[1]?.closed).toBe(true);
    expect(got.closed).toBe(false);
  });

  it('rejects with a typed InputError on an empty frame stream', async () => {
    await expect(
      seekFrame(streamOf<FakeFrame>([]) as unknown as ReadableStream<VideoFrame>, 1000),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('closes the running candidate and rejects if the stream errors mid-scan', async () => {
    const dropped = new FakeFrame(0);
    let pulls = 0;
    const erroring = new ReadableStream<FakeFrame>({
      pull(controller): void {
        pulls++;
        if (pulls === 1) controller.enqueue(dropped);
        else controller.error(new Error('boom'));
      },
    });
    await expect(
      seekFrame(erroring as unknown as ReadableStream<VideoFrame>, 99_999),
    ).rejects.toThrow('boom');
    expect(dropped.closed).toBe(true); // the in-flight candidate was released on error
  });
});

// ── unwrapPackets ────────────────────────────────────────────────────────────────────────────────

describe('unwrapPackets', () => {
  function packet(ordinal: number): Packet {
    return { chunk: { ordinal } as unknown as EncodedChunk };
  }

  it('projects exact chunk identities with one source read per downstream demand and unlocks at EOF', async () => {
    const packets = [packet(1), packet(2), packet(3)];
    let pulls = 0;
    const source = new ReadableStream<Packet>(
      {
        pull(controller): void {
          const value = packets[pulls];
          pulls++;
          if (value === undefined) controller.close();
          else controller.enqueue(value);
        },
      },
      { highWaterMark: 0 },
    );
    const reader = unwrapPackets(source).getReader();
    expect(pulls).toBe(0);
    for (let index = 0; index < packets.length; index++) {
      const result = await reader.read();
      expect(result.done).toBe(false);
      expect(result.value).toBe(packets[index]?.chunk);
      expect(pulls).toBe(index + 1);
    }
    expect((await reader.read()).done).toBe(true);
    expect(pulls).toBe(packets.length + 1);
    expect(source.locked).toBe(false);
    reader.releaseLock();
  });

  it('cancels the source before unlocking and preserves the downstream reason', async () => {
    let cancelledWith: unknown;
    let lockedDuringCancel = false;
    const source = new ReadableStream<Packet>(
      {
        cancel(reason): void {
          cancelledWith = reason;
          lockedDuringCancel = source.locked;
        },
      },
      { highWaterMark: 0 },
    );
    const reader = unwrapPackets(source).getReader();
    await reader.cancel('stop-packet-projection');
    expect(cancelledWith).toBe('stop-packet-projection');
    expect(lockedDuringCancel).toBe(true);
    expect(source.locked).toBe(false);
    reader.releaseLock();
  });

  it('preserves a source read failure and unlocks after teardown', async () => {
    const failure = new MediaError('demux-error', 'packet-source-failed');
    const source = new ReadableStream<Packet>(
      {
        pull(controller): void {
          controller.error(failure);
        },
      },
      { highWaterMark: 0 },
    );
    const reader = unwrapPackets(source).getReader();
    await expect(reader.read()).rejects.toBe(failure);
    expect(source.locked).toBe(false);
    reader.releaseLock();
  });

  it('surfaces an upstream cancellation failure but still releases its lock', async () => {
    const teardownFailure = new Error('packet-cancel-failed');
    const source = new ReadableStream<Packet>(
      {
        cancel(): never {
          throw teardownFailure;
        },
      },
      { highWaterMark: 0 },
    );
    const reader = unwrapPackets(source).getReader();
    await expect(reader.cancel('stop')).rejects.toBe(teardownFailure);
    expect(source.locked).toBe(false);
    reader.releaseLock();
  });
});

// ── drainEncoderToMuxer ─────────────────────────────────────────────────────────────────────────

describe('drainEncoderToMuxer', () => {
  /** A fake muxer recording addTrack/write calls (write receives a {@link Packet}). */
  function fakeMuxer(): {
    addTrack: (info: TrackInfo) => number;
    write: (trackId: number, packet: Packet) => Promise<void>;
    tracks: TrackInfo[];
    writes: { trackId: number; packet: Packet }[];
  } {
    const tracks: TrackInfo[] = [];
    const writes: { trackId: number; packet: Packet }[] = [];
    return {
      tracks,
      writes,
      addTrack(info): number {
        tracks.push(info);
        return tracks.length; // 1-based id
      },
      write(trackId, packet): Promise<void> {
        writes.push({ trackId, packet });
        return Promise.resolve();
      },
    };
  }

  it('allocates the track lazily on the first chunk (after the config is available) and writes each chunk', async () => {
    const muxer = fakeMuxer();
    const chunks = ['a', 'b', 'c'] as unknown as EncodedChunk[];
    let configReads = 0;
    const info: TrackInfo = { id: 0, mediaType: 'video', codec: 'avc1.42E01E' };
    await drainEncoderToMuxer(streamOf(chunks), muxer, () => {
      configReads++;
      return info;
    });
    expect(configReads).toBe(1); // config read exactly once, on the first chunk
    expect(muxer.tracks).toEqual([info]);
    // A bare encoder chunk is normalized to a Packet `{ chunk }` (no dtsUs) before write.
    expect(muxer.writes.map((w) => w.packet.chunk)).toEqual(['a', 'b', 'c']);
    expect(muxer.writes.every((w) => w.packet.dtsUs === undefined)).toBe(true);
    expect(muxer.writes.every((w) => w.trackId === 1)).toBe(true);
  });

  it('allocates no track for an empty encoder stream', async () => {
    const muxer = fakeMuxer();
    await drainEncoderToMuxer(streamOf<EncodedChunk>([]), muxer, () => {
      throw new Error('config should not be read for an empty stream');
    });
    expect(muxer.tracks).toEqual([]);
    expect(muxer.writes).toEqual([]);
  });

  it('validates a known packet track before pulling and cancels an invalid producer', async () => {
    let pulls = 0;
    let cancels = 0;
    const packets = new ReadableStream<EncodedChunk>(
      {
        pull(): void {
          pulls++;
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const muxer = {
      addTrack(): number {
        throw new CapabilityError('illegal track/container pair', {
          op: { kind: 'route', id: 'mux' },
          tried: ['test'],
        });
      },
      write(): Promise<void> {
        throw new Error('write must not run after track validation fails');
      },
    };
    const track: TrackInfo = { id: 7, mediaType: 'audio', codec: 'opus' };

    await expect(drainEncoderToMuxer(packets, muxer, track)).rejects.toBeInstanceOf(
      CapabilityError,
    );
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
  });

  it('cancels its locked producer when mux writing fails', async () => {
    let pulls = 0;
    let cancels = 0;
    const chunk = { timestamp: 0 } as unknown as EncodedChunk;
    const packets = new ReadableStream<EncodedChunk>(
      {
        pull(controller): void {
          pulls++;
          if (pulls === 1) controller.enqueue(chunk);
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const muxer = fakeMuxer();
    muxer.write = (): Promise<void> => Promise.reject(new Error('mux write failed'));

    await expect(
      drainEncoderToMuxer(packets, muxer, () => ({
        id: 1,
        mediaType: 'audio',
        codec: 'opus',
      })),
    ).rejects.toThrow('mux write failed');
    expect(cancels).toBe(1);
  });

  it('cancels a locked drain and rejects when its operation signal aborts during write', async () => {
    let pulls = 0;
    let cancels = 0;
    let releaseWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const chunk = { timestamp: 0 } as unknown as EncodedChunk;
    const packets = new ReadableStream<EncodedChunk>(
      {
        pull(controller): void {
          pulls++;
          if (pulls === 1) controller.enqueue(chunk);
          else controller.close();
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const muxer = fakeMuxer();
    muxer.write = async (): Promise<void> => {
      markWriteStarted?.();
      await writeGate;
    };
    const controller = new AbortController();
    const abortableDrain = drainEncoderToMuxer as (
      chunks: ReadableStream<EncodedChunk>,
      sink: typeof muxer,
      getConfig: () => TrackInfo,
      signal?: AbortSignal,
    ) => Promise<void>;
    const pending = abortableDrain(
      packets,
      muxer,
      () => ({ id: 1, mediaType: 'audio', codec: 'opus' }),
      controller.signal,
    );
    await writeStarted;

    try {
      controller.abort('test abort');
      await Promise.resolve();
      expect(cancels).toBe(1);
    } finally {
      releaseWrite?.();
    }
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('aborts and settles a locked sibling drain when another known track is rejected', async () => {
    let validPulls = 0;
    let validCancels = 0;
    let invalidPulls = 0;
    let invalidCancels = 0;
    const validPackets = new ReadableStream<EncodedChunk>(
      {
        pull(): void {
          validPulls++;
        },
        cancel(): void {
          validCancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const invalidPackets = new ReadableStream<EncodedChunk>(
      {
        pull(): void {
          invalidPulls++;
        },
        cancel(): void {
          invalidCancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const muxer = fakeMuxer();
    const originalAddTrack = muxer.addTrack;
    muxer.addTrack = (track): number => {
      if (track.codec === 'illegal') {
        throw new CapabilityError('illegal sibling track', {
          op: { kind: 'route', id: 'mux' },
          tried: ['test'],
        });
      }
      return originalAddTrack(track);
    };
    const parent = new AbortController();
    const group = createDrainTaskGroup(parent.signal);
    try {
      const tasks = [
        drainEncoderToMuxer(
          validPackets,
          muxer,
          { id: 1, mediaType: 'audio', codec: 'opus' },
          group.signal,
        ),
        drainEncoderToMuxer(
          invalidPackets,
          muxer,
          { id: 2, mediaType: 'audio', codec: 'illegal' },
          group.signal,
        ),
      ];
      await expect(group.run(tasks)).rejects.toBeInstanceOf(CapabilityError);
    } finally {
      group.dispose();
    }
    expect(validPulls).toBe(1);
    expect(validCancels).toBe(1);
    expect(invalidPulls).toBe(0);
    expect(invalidCancels).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// S13 punch-list oracles (docs/architecture/codec-pipeline.md §5) — layering, sidecar, rate goldens,
// frame-lifetime accounting, pairing bounds, capability-miss surfaces, and the VFR/B-frame evidence.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const s13ModuleSource = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

describe('S13 layering: the pure config modules are frame-free and runtime-free (items 2/3)', () => {
  const pureModules = [
    'audio-target-defaults.ts',
    'codec-strings.ts',
    'codec-queries.ts',
    'encoder-config.ts',
    'mux-trackinfo.ts',
    'codec-routing.ts',
  ] as const;
  // Frame construction/lifetime tokens (layer 3 only) + capability/runtime leak tokens (router-only).
  const forbidden = [
    'new VideoFrame(',
    'new AudioData(',
    '.close(',
    'isWebKitRuntime',
    'isFirefoxRuntime',
    'runtime-detect',
    'WebKit',
    'Firefox',
    'wasm-opus',
  ] as const;

  it('pure modules contain none of the frame/runtime tokens', () => {
    for (const module of pureModules) {
      const source = s13ModuleSource(module);
      for (const token of forbidden) {
        expect(source.includes(token), `${module} must not contain "${token}"`).toBe(false);
      }
    }
  });

  it('the facade is re-exports only (no frame construction, no runtime probing)', () => {
    const source = s13ModuleSource('codec-pipeline.ts');
    for (const token of ['new VideoFrame(', 'new AudioData(', '.close(', 'runtime-detect']) {
      expect(source.includes(token), `facade must not contain "${token}"`).toBe(false);
    }
  });

  it('the quirk quarantine is the only S13 module naming a browser runtime', () => {
    const quirks = s13ModuleSource('codec-runtime-quirks.ts');
    expect(quirks).toContain('runtime-detect');
    for (const module of ['vpx-alpha.ts', 'codec-live.ts']) {
      const source = s13ModuleSource(module);
      for (const token of ['isWebKitRuntime', 'isFirefoxRuntime', 'runtime-detect']) {
        expect(source.includes(token), `${module} must not contain "${token}"`).toBe(false);
      }
    }
  });

  it('every S13 module respects the < 600-line budget (item 1)', () => {
    const modules = [
      'audio-target-defaults.ts',
      'codec-pipeline.ts',
      'codec-strings.ts',
      'codec-queries.ts',
      'encoder-config.ts',
      'mux-trackinfo.ts',
      'vpx-alpha.ts',
      'vpx-alpha-geometry.ts',
      'codec-live.ts',
      'codec-runtime-quirks.ts',
      'codec-routing.ts',
    ] as const;
    for (const module of modules) {
      const lines = s13ModuleSource(module).split('\n').length;
      expect(lines, `${module} is ${lines} lines`).toBeLessThan(600);
    }
  });
});

// ── item 5: WeakMap RGBA sidecar (no expando) — split→merge→split stays bit-exact ────────────────

/** Frozen fake VideoFrame with private counters: rejects expandos BY CONSTRUCTION (Object.freeze). */
class SidecarPixelFrame {
  #closeCount = 0;
  #copyToCalls = 0;
  readonly timestamp: number;
  readonly duration: number | null = null;
  readonly format: VideoPixelFormat | null = null;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly #pixels: Uint8ClampedArray;
  readonly #copyToFailure: Error | undefined;

  constructor(
    timestamp: number,
    width: number,
    height: number,
    pixels: Uint8ClampedArray,
    copyToFailure?: Error,
  ) {
    this.timestamp = timestamp;
    this.codedWidth = width;
    this.codedHeight = height;
    this.displayWidth = width;
    this.displayHeight = height;
    this.#pixels = pixels.slice();
    this.#copyToFailure = copyToFailure;
    Object.freeze(this); // a host object that rejects expando properties
  }

  get closeCount(): number {
    return this.#closeCount;
  }
  get copyToCalls(): number {
    return this.#copyToCalls;
  }
  allocationSize(): number {
    return this.#pixels.length;
  }
  copyTo(destination: AllowSharedBufferSource): Promise<PlaneLayout[]> {
    this.#copyToCalls++;
    if (this.#copyToFailure !== undefined) return Promise.reject(this.#copyToFailure);
    const bytes = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    bytes.set(this.#pixels.subarray(0, Math.min(this.#pixels.length, bytes.length)));
    return Promise.resolve([{ offset: 0, stride: this.codedWidth * 4 }]);
  }
  close(): void {
    this.#closeCount++;
  }
}

function sidecarFrameConstructor(
  constructed: { frame: SidecarPixelFrame; data: Uint8ClampedArray }[],
): typeof VideoFrame {
  function FakeVideoFrame(
    data: AllowSharedBufferSource,
    init: VideoFrameBufferInit,
  ): SidecarPixelFrame {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8ClampedArray(data as ArrayBuffer);
    const frame = new SidecarPixelFrame(init.timestamp, init.codedWidth, init.codedHeight, bytes);
    constructed.push({ frame, data: bytes.slice() });
    return frame;
  }
  return FakeVideoFrame as unknown as typeof VideoFrame;
}

describe('vpx-alpha RGBA sidecar is a WeakMap, never a frame expando (item 5)', () => {
  it('the module keeps no expando machinery', () => {
    const source = s13ModuleSource('vpx-alpha.ts');
    expect(source.includes('__aibrushRgbaPixels')).toBe(false);
    expect(source.includes('defineProperty')).toBe(false);
    expect(source).toContain('WeakMap<VideoFrame, RgbaFramePixels>');
  });

  it('merge→split round-trips bit-exactly through frozen frames and reads pixels via the sidecar', async () => {
    const colorRgba = Uint8ClampedArray.from([10, 20, 30, 255, 40, 50, 60, 255]);
    const alphaRgba = Uint8ClampedArray.from([7, 7, 7, 255, 200, 200, 200, 255]);
    const expectedMerged = Uint8ClampedArray.from([10, 20, 30, 7, 40, 50, 60, 200]);
    const expectedSplit = splitRgbaForVpxAlpha({
      data: expectedMerged,
      width: 2,
      height: 1,
    });

    const constructed: { frame: SidecarPixelFrame; data: Uint8ClampedArray }[] = [];
    await withVideoFrameConstructor(sidecarFrameConstructor(constructed), async () => {
      // Decode phase: pair + merge two decoded planes into one RGBA frame.
      const color = new SidecarPixelFrame(100, 2, 1, colorRgba);
      const alpha = new SidecarPixelFrame(100, 2, 1, alphaRgba);
      let decoderCount = 0;
      const createDecoder = (): TransformStream<EncodedChunk, RawFrame> => {
        decoderCount++;
        const plane = decoderCount === 1 ? color : alpha;
        return new TransformStream<EncodedChunk, RawFrame>({
          transform(_chunk, controller): void {
            controller.enqueue(plane as unknown as RawFrame);
          },
        });
      };
      const decodeReader = decodeVideoPacketsWithAlpha(
        streamOf([alphaPacket(100, 100)]),
        createDecoder,
      ).getReader();
      const mergedRead = await decodeReader.read();
      if (mergedRead.done) throw new Error('expected a merged frame');
      expect((await decodeReader.read()).done).toBe(true);
      const merged = mergedRead.value as unknown as SidecarPixelFrame;

      // The merged frame's pixels are bit-exact and its inputs were closed exactly once.
      expect(constructed).toHaveLength(1);
      expect([...(constructed[0]?.data ?? [])]).toEqual([...expectedMerged]);
      expect(color.closeCount).toBe(1);
      expect(alpha.closeCount).toBe(1);

      // Encode phase: split the SAME frozen frame; pixels must come from the WeakMap sidecar.
      const packets: Packet[] = [];
      const encodeReader = encodeVideoFramesWithAlpha(streamOf([merged as unknown as VideoFrame]), {
        config: { codec: 'vp09.00.10.08', width: 2, height: 1 },
        createEncoder: () =>
          new TransformStream<RawFrame, EncodedChunk>({
            transform(frame, controller): void {
              const timestamp = (frame as unknown as { timestamp: number }).timestamp;
              frame.close();
              controller.enqueue(alphaEncodedChunk(timestamp));
            },
          }),
      }).getReader();
      for (;;) {
        const { done, value } = await encodeReader.read();
        if (done) break;
        packets.push(value);
      }

      expect(packets).toHaveLength(1);
      // Sidecar hit: the frozen merged frame was NEVER read back through copyTo.
      expect(merged.copyToCalls).toBe(0);
      expect(merged.closeCount).toBe(1);
      // Derived colour/alpha frames carry the exact split of the merged pixels (bit-for-bit).
      expect(constructed).toHaveLength(3);
      expect([...(constructed[1]?.data ?? [])]).toEqual([...expectedSplit.color.data]);
      expect([...(constructed[2]?.data ?? [])]).toEqual([...expectedSplit.alpha.data]);
      expect(constructed[1]?.frame.closeCount).toBe(1);
      expect(constructed[2]?.frame.closeCount).toBe(1);
    });
  });
});

// ── item 6: the rate model is pinned by a golden {codec × resolution × fps × source} table ───────

describe('defaultVideoBitrate golden table (item 6 — named constants, hand-derived rows)', () => {
  it('pins the documented constants themselves', () => {
    expect(IMPLICIT_VIDEO_BITRATE_FLOOR).toBe(300_000);
    expect(IMPLICIT_BITS_PER_PIXEL_PER_SECOND).toBe(20);
    expect(VIDEO_CODEC_RATE_EFFICIENCY).toEqual({
      h264: 1,
      hevc: 0.7,
      vp8: 1.1,
      vp9: 0.8,
      av1: 0.6,
      unknown: 1,
    });
    expect(HIGH_CADENCE_FPS_THRESHOLD).toBe(30.5);
    expect(CADENCE_BASELINE_FPS).toBe(30);
    expect(EVIDENCE_BITRATE_HEADROOM).toBe(2);
    expect(EVIDENCE_BITRATE_FLOOR).toBe(3_750_000);
  });

  it('planned path: width × height × 20 bpp/s × efficiency (× AV1 cadence), floored and capped', () => {
    const bitrateOf = (
      target: VideoTarget,
      src: { width: number; height: number; fps?: number; bitrate?: number },
      sourceCodec?: string,
    ): number | undefined => buildVideoEncoderConfig(target, src, sourceCodec).bitrate;

    // 1280×720×20×1.0 = 18_432_000 (H.264 baseline budget)
    expect(
      bitrateOf(
        { codec: 'h264', width: 1280, height: 720, fps: 30 },
        { width: 1920, height: 1080 },
      ),
    ).toBe(18_432_000);
    // 1920×1080×20×0.7 = 29_030_400 (HEVC efficiency)
    expect(
      bitrateOf(
        { codec: 'hevc', width: 1920, height: 1080, fps: 30 },
        { width: 1920, height: 1080 },
      ),
    ).toBe(29_030_400);
    // 640×360×20×1.1 = 5_068_800 (VP8, cadence unknown)
    expect(
      bitrateOf({ codec: 'vp8', width: 640, height: 360 }, { width: 1920, height: 1080 }),
    ).toBe(5_068_800);
    // 1280×720×20×0.8 = 14_745_600 (VP9)
    expect(
      bitrateOf({ codec: 'vp9', width: 1280, height: 720, fps: 30 }, { width: 1920, height: 1080 }),
    ).toBe(14_745_600);
    // 1280×720×20×0.6 = 11_059_200 (AV1 @30 — no cadence scale at/below 30.5)
    expect(
      bitrateOf({ codec: 'av1', width: 1280, height: 720, fps: 30 }, { width: 1920, height: 1080 }),
    ).toBe(11_059_200);
    // AV1 @60: 11_059_200 × √(60/30) = 15_640_070.59 → 15_640_071 (ADR-252 cadence row)
    expect(
      bitrateOf({ codec: 'av1', width: 1280, height: 720, fps: 60 }, { width: 1920, height: 1080 }),
    ).toBe(15_640_071);
    // AV1 @240: √(240/30)=2.83 capped at 1/0.6 → 11_059_200 × 1.666… = 18_432_000 (H.264 budget cap)
    expect(
      bitrateOf(
        { codec: 'av1', width: 1280, height: 720, fps: 240 },
        { width: 1920, height: 1080 },
      ),
    ).toBe(18_432_000);
    // Floor: 8×8×20 = 1_280 → 300_000
    expect(
      bitrateOf({ codec: 'h264', width: 8, height: 8, fps: 30 }, { width: 1920, height: 1080 }),
    ).toBe(300_000);
    // Preserve-source cap at the DECLARED level ceiling: 640×360×20×0.8 = 3_686_400 → min(level-2.1 cap 3_600_000)
    const preserved = buildVideoEncoderConfig(
      {},
      { width: 640, height: 360, fps: 30 },
      'vp09.00.21.08',
    );
    expect(preserved.codec).toBe('vp09.00.21.08');
    expect(preserved.bitrate).toBe(3_600_000);

    const preservedWithEvidence = buildVideoEncoderConfig(
      {},
      { width: 640, height: 360, fps: 30, bitrate: 271_201 },
      'vp09.00.21.08',
    );
    expect(preservedWithEvidence.codec).toBe('vp09.00.21.08');
    expect(preservedWithEvidence.bitrate).toBe(3_600_000);
  });

  it('uses the codec-aware planned pixel density as the evidence floor at 960×540', () => {
    const cases = [
      { codec: 'h264', sourceCodec: 'avc1.42E01E', expected: 10_368_000 },
      { codec: 'vp9', sourceCodec: 'vp09.00.31.08', expected: 8_294_400 },
      { codec: 'av1', sourceCodec: 'av01.0.05M.08', expected: 6_220_800 },
    ] as const;

    for (const { codec, sourceCodec, expected } of cases) {
      const target = { codec, width: 960, height: 540, fps: 30 } as const;
      expect(
        buildVideoEncoderConfig(target, { width: 960, height: 540 }, sourceCodec).bitrate,
      ).toBe(expected);
      expect(
        buildVideoEncoderConfig(
          target,
          { width: 960, height: 540, fps: 30, bitrate: 271_201 },
          sourceCodec,
        ).bitrate,
      ).toBe(expected);
    }

    expect(
      buildVideoEncoderConfig(
        { codec: 'av1', width: 1280, height: 720, fps: 60 },
        { width: 1280, height: 720, fps: 60, bitrate: 271_201 },
        'av01.0.08M.08',
      ).bitrate,
    ).toBe(15_640_071);
  });

  it('keeps source-rate projection authoritative above the codec-aware evidence floor', () => {
    // 16_000_000 × (0.8/0.6) × 2 = 42_666_666.67 → 42_666_667, above the VP9 pixel floor.
    expect(
      buildVideoEncoderConfig(
        { codec: 'vp9' },
        { width: 1920, height: 1080, fps: 24, bitrate: 16_000_000 },
        'av01.0.05M.08',
      ).bitrate,
    ).toBe(42_666_667);
    // Spatial ¼ × temporal 2 × same-codec 1 × headroom 2: 10_000_000 × 0.25 × 2 × 2 = 10_000_000
    expect(
      buildVideoEncoderConfig(
        { codec: 'h264', width: 640, height: 360, fps: 30 },
        { width: 1280, height: 720, fps: 15, bitrate: 10_000_000 },
        'avc1.42E01E',
      ).bitrate,
    ).toBe(10_000_000);
    // Ordinary-cadence H.264 uses the same 20 bpp/s floor as the no-evidence quality budget.
    expect(
      buildVideoEncoderConfig(
        { codec: 'h264', width: 1280, height: 720 },
        { width: 960, height: 540, fps: 30, bitrate: 1_639_712 },
        'avc1.42E01E',
      ).bitrate,
    ).toBe(18_432_000);
    // High-cadence source evidence is also floored by output density:
    // 1280×720×20 bpp/s = 18_432_000, above the source-rate projection.
    expect(
      buildVideoEncoderConfig(
        { codec: 'h264', width: 1280, height: 720 },
        { width: 1080, height: 1920, fps: 60, bitrate: 5_723_914 },
        'avc1.42E02A',
      ).bitrate,
    ).toBe(18_432_000);
  });

  it('keeps every explicit rate or quality authority out of the implicit evidence model', () => {
    const evidenceSource = { width: 960, height: 540, fps: 30, bitrate: 271_201 };

    expect(
      buildVideoEncoderConfig({ codec: 'vp9', bitrate: 4_000_000 }, evidenceSource, 'vp09.00.31.08')
        .bitrate,
    ).toBe(4_000_000);
    const crf = buildVideoEncoderConfig({ codec: 'h264', crf: 23 }, evidenceSource, 'avc1.42E01E');
    expect(crf).toMatchObject({ bitrateMode: 'quantizer' });
    expect(crf).not.toHaveProperty('bitrate');

    const twoPass = buildVideoEncoderConfig(
      { codec: 'h264', bitrate: 2_000_000, twoPass: true },
      evidenceSource,
      'avc1.42E01E',
    );
    expect(twoPass).toMatchObject({ bitrateMode: 'quantizer' });
    expect(twoPass).not.toHaveProperty('bitrate');

    const quality = buildVideoEncoderConfig(
      {
        codec: 'h264',
        bitrate: 2_000_000,
        maxAverageBitrate: 2_600_000,
        quality: { metric: 'ssim-luma-v1', minimumMean: 0.93, samples: 8 },
      },
      evidenceSource,
      'avc1.42E01E',
    );
    expect(quality).toMatchObject({ bitrateMode: 'quantizer' });
    expect(quality).not.toHaveProperty('bitrate');
  });
});

// ── item 7: frame lifetime is exactly-once under success, cancel, and injected throws ────────────

/** Pull-based tracked source honouring the decoder contract: cancel closes undelivered frames. */
function trackedFrameSource(frames: readonly AlphaLifecycleFrame[]): ReadableStream<VideoFrame> {
  let next = 0;
  return new ReadableStream<VideoFrame>(
    {
      pull(controller): void {
        const frame = frames[next];
        next++;
        if (frame === undefined) controller.close();
        else controller.enqueue(frame as unknown as VideoFrame);
      },
      cancel(): void {
        for (let i = next; i < frames.length; i++) frames[i]?.close();
      },
    },
    { highWaterMark: 0 },
  );
}

describe('frame-lifetime oracle: closeCount === createCount on every path (item 7)', () => {
  const closingEncoder = (): TransformStream<RawFrame, EncodedChunk> =>
    new TransformStream<RawFrame, EncodedChunk>({
      transform(frame, controller): void {
        const timestamp = (frame as unknown as { timestamp: number }).timestamp;
        frame.close();
        controller.enqueue(alphaEncodedChunk(timestamp));
      },
    });

  async function collectAll(stream: ReadableStream<Packet>): Promise<Packet[]> {
    const reader = stream.getReader();
    const out: Packet[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      out.push(value);
    }
  }

  it('encodeVideoFramesWithAlpha success: every input, clone, and constructed frame closes once', async () => {
    const derived: AlphaLifecycleFrame[] = [];
    const inputs = [100, 200, 300].map(
      (timestamp) => new AlphaLifecycleFrame({ timestamp, clones: derived }),
    );
    await withVideoFrameConstructor(alphaVideoFrameConstructor(derived), async () => {
      const packets = await collectAll(
        encodeVideoFramesWithAlpha(trackedFrameSource(inputs), {
          config: { codec: 'vp09.00.10.08', width: 2, height: 2 },
          createEncoder: closingEncoder,
        }),
      );
      expect(packets.map((p) => p.chunk.timestamp)).toEqual([100, 200, 300]);
      expect(packets.every((p) => p.alpha !== undefined)).toBe(true);
    });
    expect(inputs.map((f) => f.closeCount)).toEqual([1, 1, 1]);
    expect(derived.length).toBe(6); // colour + alpha per input (generic RGBA split path)
    expect(derived.map((f) => f.closeCount)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('encodeVideoFramesWithAlpha mid-stream cancel: delivered AND undelivered frames close once', async () => {
    const derived: AlphaLifecycleFrame[] = [];
    const inputs = [100, 200, 300, 400, 500].map(
      (timestamp) => new AlphaLifecycleFrame({ timestamp, clones: derived }),
    );
    await withVideoFrameConstructor(alphaVideoFrameConstructor(derived), async () => {
      const reader = encodeVideoFramesWithAlpha(trackedFrameSource(inputs), {
        config: { codec: 'vp09.00.10.08', width: 2, height: 2 },
        createEncoder: closingEncoder,
      }).getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      await reader.cancel('consumer stopped');
    });
    for (const [index, frame] of inputs.entries()) {
      expect(frame.closeCount, `input ${index} must close exactly once`).toBe(1);
    }
    for (const [index, frame] of derived.entries()) {
      expect(frame.closeCount, `derived ${index} must close exactly once`).toBe(1);
    }
  });

  it('encodeVideoFramesWithAlpha split failure: cancels upstream so undelivered frames still close', async () => {
    const derived: AlphaLifecycleFrame[] = [];
    const good = new AlphaLifecycleFrame({ timestamp: 100, clones: derived });
    const poisoned = new AlphaLifecycleFrame({
      timestamp: 200,
      clones: derived,
    });
    poisoned.copyTo = (): Promise<readonly PlaneLayout[]> =>
      Promise.reject(new Error('GPU readback failed'));
    const never = new AlphaLifecycleFrame({ timestamp: 300, clones: derived });
    const inputs = [good, poisoned, never];
    await withVideoFrameConstructor(alphaVideoFrameConstructor(derived), async () => {
      const reader = encodeVideoFramesWithAlpha(trackedFrameSource(inputs), {
        config: { codec: 'vp09.00.10.08', width: 2, height: 2 },
        createEncoder: closingEncoder,
      }).getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      await expect(reader.read()).rejects.toThrow('GPU readback failed');
    });
    expect(good.closeCount).toBe(1);
    expect(poisoned.closeCount).toBe(1); // closed by the split's finally
    expect(never.closeCount).toBe(1); // upstream cancelled on failure — no orphaned frame
    expect(derived.map((f) => f.closeCount)).toEqual([1, 1]); // only the first split constructed
  });

  it('decodeVideoPacketsWithAlpha success with merges: planes close once, outputs owned by consumer', async () => {
    const constructed: { frame: SidecarPixelFrame; data: Uint8ClampedArray }[] = [];
    const colors = [
      new SidecarPixelFrame(100, 2, 2, new Uint8ClampedArray(16).fill(9)),
      new SidecarPixelFrame(200, 2, 2, new Uint8ClampedArray(16).fill(5)),
    ];
    const alphas = [
      new SidecarPixelFrame(100, 2, 2, new Uint8ClampedArray(16).fill(255)),
      new SidecarPixelFrame(200, 2, 2, new Uint8ClampedArray(16).fill(128)),
    ];
    await withVideoFrameConstructor(sidecarFrameConstructor(constructed), async () => {
      let decoderCount = 0;
      const createDecoder = (): TransformStream<EncodedChunk, RawFrame> => {
        decoderCount++;
        const planes = decoderCount === 1 ? colors : alphas;
        let i = 0;
        return new TransformStream<EncodedChunk, RawFrame>({
          transform(_chunk, controller): void {
            const plane = planes[i++];
            if (plane !== undefined) controller.enqueue(plane as unknown as RawFrame);
          },
        });
      };
      const reader = decodeVideoPacketsWithAlpha(
        streamOf([alphaPacket(100, 100), alphaPacket(200, 200)]),
        createDecoder,
      ).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        value.close(); // the consumer owns each merged output
      }
    });
    expect(colors.map((f) => f.closeCount)).toEqual([1, 1]);
    expect(alphas.map((f) => f.closeCount)).toEqual([1, 1]);
    expect(constructed).toHaveLength(2);
    expect(constructed.map((c) => c.frame.closeCount)).toEqual([1, 1]);
  });

  it('decodeVideoPacketsWithAlpha merge failure: both in-flight planes close exactly once', async () => {
    const constructed: { frame: SidecarPixelFrame; data: Uint8ClampedArray }[] = [];
    const color = new SidecarPixelFrame(100, 2, 2, new Uint8ClampedArray(16));
    const alpha = new SidecarPixelFrame(
      100,
      2,
      2,
      new Uint8ClampedArray(16),
      new Error('alpha readback failed'),
    );
    await withVideoFrameConstructor(sidecarFrameConstructor(constructed), async () => {
      let decoderCount = 0;
      const createDecoder = (): TransformStream<EncodedChunk, RawFrame> => {
        decoderCount++;
        const plane = decoderCount === 1 ? color : alpha;
        return new TransformStream<EncodedChunk, RawFrame>({
          transform(_chunk, controller): void {
            controller.enqueue(plane as unknown as RawFrame);
          },
        });
      };
      const reader = decodeVideoPacketsWithAlpha(
        streamOf([alphaPacket(100, 100)]),
        createDecoder,
      ).getReader();
      await expect(reader.read()).rejects.toThrow('alpha readback failed');
    });
    expect(color.closeCount).toBe(1);
    expect(alpha.closeCount).toBe(1);
    expect(constructed).toHaveLength(0); // merge never completed — nothing constructed, nothing leaked
  });

  it('seekFrame aggregate accounting: drops close once, the returned frame is the only survivor', async () => {
    const frames = [0, 1000, 2000, 3000, 4000].map((t) => new FakeFrame(t));
    const got = (await seekFrame(
      streamOf(frames) as unknown as ReadableStream<VideoFrame>,
      2500,
    )) as unknown as FakeFrame;
    expect(got.timestamp).toBe(3000);
    expect(frames.map((f) => f.closed)).toEqual([true, true, true, false, false]); // 4000 never pulled
    got.close();
    expect(got.closed).toBe(true);
  });

  it('drainEncoderToMuxer never closes packets (the encoder already owned every RawFrame)', async () => {
    let chunkCloses = 0;
    const chunks = [0, 1].map(
      (timestamp) =>
        ({
          timestamp,
          close: () => {
            chunkCloses++;
          },
        }) as unknown as EncodedChunk,
    );
    const written: Packet[] = [];
    await drainEncoderToMuxer(
      streamOf(chunks),
      {
        addTrack: () => 1,
        write: (_trackId, packet) => {
          written.push(packet);
          return Promise.resolve();
        },
      },
      () => ({ id: 0, mediaType: 'video', codec: 'vp8' }),
    );
    expect(written).toHaveLength(2);
    expect(chunkCloses).toBe(0);
  });
});

// ── item 8: alpha pairing is bounded by the reorder distance and pinned at highWaterMark 0 ───────

describe('alpha pairing bound + backpressure (item 8)', () => {
  function countingEncoder(counter: {
    runs: number;
  }): () => TransformStream<RawFrame, EncodedChunk> {
    return () =>
      new TransformStream<RawFrame, EncodedChunk>({
        transform(frame, controller): void {
          counter.runs++;
          const timestamp = (frame as unknown as { timestamp: number }).timestamp;
          frame.close();
          controller.enqueue(alphaEncodedChunk(timestamp));
        },
      });
  }

  it('encodeVpxAlphaFrameStreams: HWM 0 — no encode work happens before the consumer pulls', async () => {
    const color = { runs: 0 };
    const alpha = { runs: 0 };
    let factoryCalls = 0;
    const clip = 64;
    const colorFrames = Array.from(
      { length: clip },
      (_, i) => new AlphaLifecycleFrame({ timestamp: i }),
    );
    const alphaFrames = Array.from(
      { length: clip },
      (_, i) => new AlphaLifecycleFrame({ timestamp: i }),
    );
    const stream = encodeVpxAlphaFrameStreams(
      trackedFrameSource(colorFrames),
      trackedFrameSource(alphaFrames),
      {
        encodeConfig: { codec: 'vp09.00.10.08', width: 2, height: 2 },
        createEncoder: () => {
          factoryCalls++;
          return countingEncoder(factoryCalls === 1 ? color : alpha)();
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(color.runs).toBe(0); // highWaterMark 0: zero eager encode ahead of demand
    expect(alpha.runs).toBe(0);

    // Slow consumer: after each pull the pairing skew never exceeds a small constant — not clip length.
    const reader = stream.getReader();
    for (let i = 0; i < clip; i++) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      expect(value?.chunk.timestamp).toBe(i);
      expect(value?.alpha?.timestamp).toBe(i);
      expect(color.runs - (i + 1)).toBeLessThanOrEqual(2);
      expect(alpha.runs - (i + 1)).toBeLessThanOrEqual(2);
    }
    expect((await reader.read()).done).toBe(true);
    expect(colorFrames.every((f) => f.closeCount === 1)).toBe(true);
    expect(alphaFrames.every((f) => f.closeCount === 1)).toBe(true);
  });

  it('transcodeVpxAlphaPackets: pathological misalignment fails loudly at the fixed reorder bound', async () => {
    const clip = 64; // ≫ the 16-item bound: the buffer must never scale with clip length
    const packets = Array.from({ length: clip }, (_, i) => alphaPacket(i, 1_000 + i));
    const reader = transcodeVpxAlphaPackets(streamOf(packets), {
      decodeConfig: { codec: 'vp09.00.10.08' },
      encodeConfig: { codec: 'vp8', width: 2, height: 2 },
      createDecoder: () =>
        new TransformStream<EncodedChunk, RawFrame>({
          transform(chunk, controller): void {
            controller.enqueue(chunk as unknown as RawFrame);
          },
        }),
      createEncoder: () =>
        new TransformStream<RawFrame, EncodedChunk>({
          transform(chunk, controller): void {
            controller.enqueue(chunk as unknown as EncodedChunk);
          },
        }),
      copyAlpha: true,
    }).getReader();

    let emitted = 0;
    let failure: unknown;
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        emitted++;
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MediaError);
    expect((failure as MediaError).code).toBe('encode-error');
    expect((failure as MediaError).message).toMatch(/reorder bound/);
    expect(emitted).toBe(16); // exactly the bound — never the clip length
  });

  it('decodeVideoPacketsWithAlpha: misaligned alpha frames hit the bound and every buffered frame closes', async () => {
    const clip = 40;
    const colors = Array.from(
      { length: clip },
      (_, i) => new AlphaLifecycleFrame({ timestamp: i, format: 'RGBA' }),
    );
    const alphas = Array.from(
      { length: clip },
      (_, i) => new AlphaLifecycleFrame({ timestamp: 1_000 + i, format: 'RGBA' }),
    );
    let decoderCount = 0;
    const createDecoder = (): TransformStream<EncodedChunk, RawFrame> => {
      decoderCount++;
      const planes = decoderCount === 1 ? colors : alphas;
      let i = 0;
      return new TransformStream<EncodedChunk, RawFrame>({
        transform(_chunk, controller): void {
          const plane = planes[i++];
          if (plane !== undefined) controller.enqueue(plane as unknown as RawFrame);
        },
      });
    };
    const reader = decodeVideoPacketsWithAlpha(
      streamOf(Array.from({ length: clip }, (_, i) => alphaPacket(i, 1_000 + i))),
      createDecoder,
    ).getReader();

    let emitted = 0;
    let failure: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        emitted++;
        value.close();
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MediaError);
    expect((failure as MediaError).code).toBe('decode-error');
    expect((failure as MediaError).message).toMatch(/reorder bound/);
    expect(emitted).toBe(16);
    // Every buffered ahead-of-target alpha frame was drained and closed exactly once — no leak, no double.
    const touchedAlphas = alphas.slice(0, 17);
    expect(touchedAlphas.map((f) => f.closeCount)).toEqual(Array.from({ length: 17 }, () => 1));
    // Delivered colours were closed by this consumer; the failing colour was closed by the error path.
    expect(colors.slice(0, 17).every((f) => f.closeCount === 1)).toBe(true);
  });

  it('the pairing sources pin { highWaterMark: 0 } in code, matching unwrapPackets', () => {
    const live = s13ModuleSource('codec-live.ts');
    const vpx = s13ModuleSource('vpx-alpha.ts');
    // Three pairing factories in codec-live + unwrap/decode in vpx-alpha all pin HWM 0.
    expect(live.match(/\{ highWaterMark: 0 \}/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(vpx.match(/\{ highWaterMark: 0 \}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(live.includes('new ReadableStream<Packet>(')).toBe(true);
  });
});

// ── item 9: encode-surface limits are explicit typed capability misses ───────────────────────────

describe('encode-surface capability misses carry exact suggestions (item 9)', () => {
  const src = { width: 1920, height: 1080 };

  function captureCapabilityError(run: () => unknown): CapabilityError {
    try {
      run();
    } catch (error) {
      if (error instanceof CapabilityError) return error;
      throw error;
    }
    throw new Error('expected a CapabilityError');
  }

  it('two-pass outside H.264 misses with the exact allocator suggestion', () => {
    const error = captureCapabilityError(() =>
      buildVideoEncoderConfig({ codec: 'av1', bitrate: 2_000_000, twoPass: true }, src, undefined),
    );
    expect(error.code).toBe('capability-miss');
    expect(error.message).toBe(
      'two-pass video encode is currently available only for H.264, not av1',
    );
    expect(error.detail?.suggestion).toBe(
      'target H.264 or add a validated two-pass allocator for the requested codec',
    );
    expect(error.detail?.tried).toEqual(['webcodecs-video']);
  });

  it('CRF on VP8 misses with the exact encoder-tail suggestion', () => {
    const error = captureCapabilityError(() =>
      buildVideoEncoderConfig({ codec: 'vp8', crf: 30 }, src, undefined),
    );
    expect(error.code).toBe('capability-miss');
    expect(error.message).toBe('CRF/quantizer encode unsupported for vp8');
    expect(error.detail?.suggestion).toBe('route to an encoder tail with native CRF support');
  });

  it('HEVC profiles beyond Main/Main10 and impossible bit depths are typed misses', () => {
    const profile = captureCapabilityError(() =>
      buildVideoEncoderConfig({}, src, 'hev1.3.4.L120.B0'),
    );
    expect(profile.message).toBe('bad HEVC profile');
    expect(profile.detail?.suggestion).toBe(
      'use HEVC Main or Main10, or add a proven encoder tail for the requested profile',
    );

    const hevc12 = captureCapabilityError(() =>
      buildVideoEncoderConfig({ codec: 'hevc', bitDepth: 12 }, src, undefined),
    );
    expect(hevc12.message).toBe('video 12-bit output is not available for hevc');
    expect(hevc12.detail?.suggestion).toBe('use HEVC Main or Main10');

    const h26410 = captureCapabilityError(() =>
      buildVideoEncoderConfig({ codec: 'h264', bitDepth: 10 }, src, undefined),
    );
    expect(h26410.detail?.suggestion).toBe(
      'use 8-bit H.264 until a High10 encode+mux path is browser-proven',
    );

    const vp810 = captureCapabilityError(() =>
      buildVideoEncoderConfig({ codec: 'vp8', bitDepth: 10 }, src, undefined),
    );
    expect(vp810.detail?.suggestion).toBe('target VP9 or AV1 for a probed high-bit-depth encode');
  });
});

// ── item 10: bitrate evidence uses the DTS+duration span, never PTS ──────────────────────────────

describe('sourceVideoBitrateFromPacketTable VFR + B-frame golden (item 10)', () => {
  it('VFR: non-uniform durations — bits ÷ (max(dts+dur) − min(dts)) exactly', () => {
    // bytes = 1500+500+2000 = 4000; span = (50_000+50_000) − 0 = 100_000 µs
    // → 4000×8×1e6 / 100_000 = 320_000 b/s exactly.
    const vfr = [
      {
        trackId: 1,
        sizeBytes: 1500,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 33_333,
        keyframe: true,
      },
      {
        trackId: 1,
        sizeBytes: 500,
        ptsUs: 33_333,
        dtsUs: 33_333,
        durationUs: 16_667,
        keyframe: false,
      },
      {
        trackId: 1,
        sizeBytes: 2000,
        ptsUs: 50_000,
        dtsUs: 50_000,
        durationUs: 50_000,
        keyframe: false,
      },
    ];
    expect(sourceVideoBitrateFromPacketTable(vfr, 1)).toBe(320_000);
  });

  it('B-frames: reordered DTS rows with adversarial PTS give the identical hand-derived rate', () => {
    // bytes = 6000; span = (120_000+40_000) − 0 = 160_000 µs → 6000×8×1e6/160_000 = 300_000 b/s.
    const presentationOrder = [
      {
        trackId: 2,
        sizeBytes: 1000,
        ptsUs: 40_000,
        dtsUs: 0,
        durationUs: 40_000,
        keyframe: true,
      },
      {
        trackId: 2,
        sizeBytes: 1500,
        ptsUs: 80_000,
        dtsUs: 80_000,
        durationUs: 40_000,
        keyframe: false,
      },
      {
        trackId: 2,
        sizeBytes: 2000,
        ptsUs: 160_000,
        dtsUs: 40_000,
        durationUs: 40_000,
        keyframe: false,
      },
      {
        trackId: 2,
        sizeBytes: 1500,
        ptsUs: 120_000,
        dtsUs: 120_000,
        durationUs: 40_000,
        keyframe: false,
      },
    ];
    expect(sourceVideoBitrateFromPacketTable(presentationOrder, 2)).toBe(300_000);

    // Insensitive to PTS values AND row order: scramble both; only DTS+duration may matter.
    const scrambled = [
      { ...presentationOrder[3], ptsUs: 999_999 },
      { ...presentationOrder[0], ptsUs: 0 },
      { ...presentationOrder[2], ptsUs: 5 },
      { ...presentationOrder[1], ptsUs: 123_456_789 },
    ] as typeof presentationOrder;
    expect(sourceVideoBitrateFromPacketTable(scrambled, 2)).toBe(300_000);
  });

  it('ignores other tracks and invalid rows rather than polluting the evidence', () => {
    const table = [
      {
        trackId: 1,
        sizeBytes: 4000,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 100_000,
        keyframe: true,
      },
      {
        trackId: 9,
        sizeBytes: 999_999,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 1,
        keyframe: true,
      },
      {
        trackId: 1,
        sizeBytes: -5,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 100_000,
        keyframe: false,
      },
      {
        trackId: 1,
        sizeBytes: 4000,
        ptsUs: 0,
        dtsUs: Number.NaN,
        durationUs: 100_000,
        keyframe: false,
      },
      {
        trackId: 1,
        sizeBytes: 4000,
        ptsUs: 0,
        dtsUs: 100_000,
        durationUs: 0,
        keyframe: false,
      },
    ];
    expect(sourceVideoBitrateFromPacketTable(table, 1)).toBe(320_000);
    expect(sourceVideoBitrateFromPacketTable([], 1)).toBeUndefined();
    expect(sourceVideoBitrateFromPacketTable(undefined, 1)).toBeUndefined();
  });
});

describe('sourceVideoBitrateFromPacketStats', () => {
  it('uses an exact decode pair and otherwise falls back wholly to presentation bounds', () => {
    const base = {
      packetCount: 4,
      totalSizeBytes: 4_000,
      presentationStartUs: 1_000_000,
      presentationEndUs: 1_200_000,
    };
    expect(
      sourceVideoBitrateFromPacketStats({
        ...base,
        decodeStartUs: 900_000,
        decodeEndUs: 1_000_000,
      }),
    ).toBe(320_000);
    expect(sourceVideoBitrateFromPacketStats(base)).toBe(160_000);
    expect(sourceVideoBitrateFromPacketStats({ ...base, decodeStartUs: 900_000 })).toBe(160_000);
  });
});
