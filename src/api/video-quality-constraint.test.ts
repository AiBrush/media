import { describe, expect, it, vi } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import type { Source, SourceKind } from '../sources/source.ts';
import type { VideoTarget } from './types.ts';
import {
  H264_QUALITY_MAX_IN_MEMORY_AGGREGATE_CANDIDATE_BYTES,
  H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES,
  H264_QUALITY_MAX_OBJECTIVE_AUDIT_PIXELS,
  type TightRgbaImage,
  assertH264QualityCandidateMemoryLimit,
  assertH264QualityConstraintPreflight,
  assertH264QualityObjectiveAuditPixelLimit,
  averageBitrateByteBudget,
  collectBoundedCandidateChunks,
  ssimLumaV1,
  uniformQualitySampleTimestamps,
} from './video-quality-constraint.ts';

const QUALITY = { metric: 'ssim-luma-v1', minimumMean: 0.93 } as const;
const QUALITY_TARGET: VideoTarget = {
  codec: 'h264',
  bitrate: 2_000_000,
  maxAverageBitrate: 2_600_000,
  quality: QUALITY,
};

function replayableSource(
  options: {
    readonly kind?: SourceKind;
    readonly size?: number;
    readonly onRead?: () => void;
  } = {},
): Source {
  return {
    __media: 'source',
    kind: options.kind ?? 'bytes',
    ...(options.size === undefined ? { size: 1 } : { size: options.size }),
    stream: () => {
      options.onRead?.();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      });
    },
  };
}

function solidRgba(
  width: number,
  height: number,
  red: number,
  green: number,
  blue: number,
  alpha = 255,
): TightRgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
    data[offset + 3] = alpha;
  }
  return { data, width, height };
}

describe('H.264 quality-constraint preflight', () => {
  it('normalizes the atomic request and defaults samples to eight without reading the Source', () => {
    let reads = 0;
    const result = assertH264QualityConstraintPreflight(
      QUALITY_TARGET,
      replayableSource({ onRead: () => reads++ }),
    );

    expect(result).toEqual({
      bitrate: 2_000_000,
      maxAverageBitrate: 2_600_000,
      quality: { metric: 'ssim-luma-v1', minimumMean: 0.93, samples: 8 },
    });
    expect(reads).toBe(0);
  });

  it('preserves an explicit validated sample count', () => {
    expect(
      assertH264QualityConstraintPreflight(
        { ...QUALITY_TARGET, quality: { ...QUALITY, samples: 17 } },
        replayableSource(),
      )?.quality.samples,
    ).toBe(17);
  });

  it('returns undefined for an ordinary target without inspecting the Source', () => {
    const source = {} as Source;
    Object.defineProperty(source, '__media', {
      get() {
        throw new Error('ordinary target must not inspect source metadata');
      },
    });
    expect(assertH264QualityConstraintPreflight({ bitrate: 2_000_000 }, source)).toBeUndefined();
  });

  it.each([
    null,
    { codec: 'h264', bitrate: 2_000_000, maxAverageBitrate: 2_600_000 },
    { codec: 'h264', bitrate: 2_000_000, quality: QUALITY },
    {
      codec: 'h264',
      bitrate: 2_000_000,
      maxAverageBitrate: 1_999_999,
      quality: QUALITY,
    },
    {
      codec: 'h264',
      bitrate: 2_000_000.5,
      maxAverageBitrate: 2_600_000,
      quality: QUALITY,
    },
    {
      codec: 'h264',
      bitrate: 2_000_000,
      maxAverageBitrate: Number.POSITIVE_INFINITY,
      quality: QUALITY,
    },
    {
      codec: 'h264',
      bitrate: 2_000_000,
      maxAverageBitrate: 2_600_000,
      quality: { ...QUALITY, metric: 'ssim' },
    },
    {
      codec: 'h264',
      bitrate: 2_000_000,
      maxAverageBitrate: 2_600_000,
      quality: { ...QUALITY, minimumMean: Number.NaN },
    },
    {
      codec: 'h264',
      bitrate: 2_000_000,
      maxAverageBitrate: 2_600_000,
      quality: { ...QUALITY, samples: 257 },
    },
  ])('rejects malformed direct quality target %#', (target) => {
    expect(() =>
      assertH264QualityConstraintPreflight(target as VideoTarget, replayableSource()),
    ).toThrow(InputError);
  });

  it('rejects an omitted codec as malformed', () => {
    expect(() =>
      assertH264QualityConstraintPreflight(
        { ...QUALITY_TARGET, codec: undefined } as unknown as VideoTarget,
        replayableSource(),
      ),
    ).toThrow(/explicit codec h264/);
  });

  it('classifies an explicit non-H264 codec as a structured capability miss', () => {
    expect(() =>
      assertH264QualityConstraintPreflight({ ...QUALITY_TARGET, codec: 'vp9' }, replayableSource()),
    ).toThrowError(
      expect.objectContaining({
        name: 'CapabilityError',
        code: 'capability-miss',
        detail: expect.objectContaining({
          op: { kind: 'route', id: 'quality-constrained-video', facts: { codec: 'vp9' } },
          tried: [],
        }),
      }),
    );
  });

  it.each([
    ['crf', undefined],
    ['bitrateMode', undefined],
    ['twoPass', false],
  ] as const)('rejects conflicting own field %s before source inspection', (field, value) => {
    let metadataReads = 0;
    const source = replayableSource();
    Object.defineProperty(source, 'kind', {
      get() {
        metadataReads++;
        return 'bytes';
      },
    });
    expect(() =>
      assertH264QualityConstraintPreflight(
        { ...QUALITY_TARGET, [field]: value } as VideoTarget,
        source,
      ),
    ).toThrow(new RegExp(`quality cannot combine with ${field}`));
    expect(metadataReads).toBe(0);
  });

  it('rejects accessor-backed targets without invoking their getters', () => {
    let reads = 0;
    const target: Record<string, unknown> = {};
    Object.defineProperty(target, 'quality', {
      enumerable: true,
      get() {
        reads++;
        return QUALITY;
      },
    });
    expect(() =>
      assertH264QualityConstraintPreflight(target as VideoTarget, replayableSource()),
    ).toThrow(InputError);
    expect(reads).toBe(0);
  });

  it('classifies a one-shot stream Source as a structured capability miss before reading', () => {
    let reads = 0;
    let error: unknown;
    try {
      assertH264QualityConstraintPreflight(
        QUALITY_TARGET,
        replayableSource({ kind: 'stream', onRead: () => reads++ }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({
      code: 'capability-miss',
      detail: {
        op: {
          kind: 'route',
          id: 'quality-constrained-h264',
          facts: { sourceKind: 'stream', replayable: false },
        },
        tried: [],
      },
    });
    expect(reads).toBe(0);
  });

  it('classifies an unknown Source size as a structured capability miss before reading', () => {
    let reads = 0;
    const source = replayableSource({ onRead: () => reads++ });
    Object.defineProperty(source, 'size', { enumerable: true, value: undefined });
    expect(() => assertH264QualityConstraintPreflight(QUALITY_TARGET, source)).toThrowError(
      expect.objectContaining({
        code: 'capability-miss',
        detail: expect.objectContaining({
          op: {
            kind: 'route',
            id: 'quality-constrained-h264',
            facts: { sourceKind: 'bytes', knownSize: false },
          },
        }),
      }),
    );
    expect(reads).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects malformed/nonempty Source size %s before invoking stream()',
    (size) => {
      let reads = 0;
      const source = replayableSource({ size: 1, onRead: () => reads++ });
      Object.defineProperty(source, 'size', { enumerable: true, value: size });
      expect(() => assertH264QualityConstraintPreflight(QUALITY_TARGET, source)).toThrow(
        /known finite nonempty Source size/,
      );
      expect(reads).toBe(0);
    },
  );

  it('rejects an unbranded source before reading', () => {
    let reads = 0;
    const source = {
      kind: 'bytes',
      size: 1,
      stream: () => {
        reads++;
        return new ReadableStream<Uint8Array>();
      },
    } as unknown as Source;
    expect(() => assertH264QualityConstraintPreflight(QUALITY_TARGET, source)).toThrow(
      /normalized Source/,
    );
    expect(reads).toBe(0);
  });
});

describe('average bitrate byte budget', () => {
  it('uses an exact integer floor for the measured presentation duration', () => {
    expect(averageBitrateByteBudget(2_000_000, 10_433_333)).toBe(2_608_333);
    expect(averageBitrateByteBudget(1, 7_999_999)).toBe(0);
    expect(averageBitrateByteBudget(1, 8_000_000)).toBe(1);
  });

  it('keeps a representable large product exact and rejects an overflowing result', () => {
    expect(averageBitrateByteBudget(Number.MAX_SAFE_INTEGER, 8_000_000)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => averageBitrateByteBudget(Number.MAX_SAFE_INTEGER, 8_000_001)).toThrow(
      /exceeds safe integer accounting/,
    );
  });

  it.each([
    [0, 1],
    [-1, 1],
    [1.5, 1],
    [Number.NaN, 1],
    [Number.MAX_SAFE_INTEGER + 1, 1],
    [1, 0],
    [1, 1.5],
    [1, Number.POSITIVE_INFINITY],
  ])('rejects unsafe rate/duration pair %s/%s', (rate, durationUs) => {
    expect(() => averageBitrateByteBudget(rate, durationUs)).toThrow(InputError);
  });
});

describe('quality candidate operational memory limit', () => {
  it('bounds the complete closed-loop compressed working set to one fallback plus one candidate', () => {
    expect(H264_QUALITY_MAX_IN_MEMORY_AGGREGATE_CANDIDATE_BYTES).toBe(
      2 * H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES,
    );
  });

  it('accepts the exact fixed ceiling and reports a structured capability miss one byte above it', () => {
    expect(() =>
      assertH264QualityCandidateMemoryLimit(H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES),
    ).not.toThrow();
    expect(() =>
      assertH264QualityCandidateMemoryLimit(H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES + 1),
    ).toThrowError(
      expect.objectContaining({
        name: 'CapabilityError',
        code: 'capability-miss',
        detail: expect.objectContaining({
          op: {
            kind: 'route',
            id: 'h264-quality-candidate-spool',
            facts: {
              candidateByteCap: H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES + 1,
              maximumCandidateBytes: H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES,
            },
          },
        }),
      }),
    );
  });
});

describe('objective-quality picture operational memory limit', () => {
  it('admits canonical 1080p in either orientation and the exact general pixel ceiling', () => {
    expect(() => assertH264QualityObjectiveAuditPixelLimit(1920, 1080)).not.toThrow();
    expect(() => assertH264QualityObjectiveAuditPixelLimit(1080, 1920)).not.toThrow();
    expect(() =>
      assertH264QualityObjectiveAuditPixelLimit(H264_QUALITY_MAX_OBJECTIVE_AUDIT_PIXELS, 1),
    ).not.toThrow();
  });

  it('returns a structured capability miss before an over-limit picture allocation', () => {
    expect(() =>
      assertH264QualityObjectiveAuditPixelLimit(H264_QUALITY_MAX_OBJECTIVE_AUDIT_PIXELS + 1, 1),
    ).toThrowError(
      expect.objectContaining({
        name: 'CapabilityError',
        code: 'capability-miss',
        detail: expect.objectContaining({
          op: {
            kind: 'route',
            id: 'h264-quality-objective-audit',
            facts: {
              width: H264_QUALITY_MAX_OBJECTIVE_AUDIT_PIXELS + 1,
              height: 1,
              pixelCount: H264_QUALITY_MAX_OBJECTIVE_AUDIT_PIXELS + 1,
              maximumPixelCount: H264_QUALITY_MAX_OBJECTIVE_AUDIT_PIXELS,
            },
          },
        }),
      }),
    );
  });

  it.each([
    [0, 1],
    [1, 0],
    [1.5, 1],
    [1, Number.POSITIVE_INFINITY],
  ])('rejects malformed picture dimensions %s×%s', (width, height) => {
    expect(() => assertH264QualityObjectiveAuditPixelLimit(width, height)).toThrow(InputError);
  });
});

describe('uniform quality sampling', () => {
  it('sorts and deduplicates real timestamps, then chooses presentation-uniform endpoints', () => {
    expect(uniformQualitySampleTimestamps([100, 50, 0, 75, 50, 25], 3)).toEqual([0, 50, 100]);
    expect(uniformQualitySampleTimestamps(new Float64Array([100, 0, 25, 50, 75]), 5)).toEqual([
      0, 25, 50, 75, 100,
    ]);
  });

  it('chooses the nearest real midpoint for one sample and breaks ties earlier', () => {
    expect(uniformQualitySampleTimestamps([0, 40, 60, 100], 1)).toEqual([40]);
    expect(uniformQualitySampleTimestamps([0, 60, 100], 1)).toEqual([60]);
  });

  it('always includes both endpoints and keeps every selected timestamp unique', () => {
    const result = uniformQualitySampleTimestamps([0, 1, 2, 3, 100], 4);
    expect(result).toEqual([0, 2, 3, 100]);
    expect(new Set(result).size).toBe(result.length);
  });

  it('returns every unique timestamp when fewer exist than requested, and handles empty input', () => {
    expect(uniformQualitySampleTimestamps([9, 3, 9], 8)).toEqual([3, 9]);
    expect(uniformQualitySampleTimestamps([], 8)).toEqual([]);
  });

  it.each([
    [[0], 0],
    [[0], 257],
    [[-1, 0], 1],
    [[0, 1.5], 1],
    [[0, Number.NaN], 1],
    [new Array(1), 1],
  ] as const)('rejects malformed timestamps/sample request %#', (timestamps, samples) => {
    expect(() => uniformQualitySampleTimestamps(timestamps, samples)).toThrow(InputError);
  });
});

describe('ssim-luma-v1', () => {
  it('returns one for identical pixels and ignores alpha', () => {
    const first = solidRgba(8, 8, 23, 117, 211, 0);
    const second = solidRgba(8, 8, 23, 117, 211, 255);
    expect(ssimLumaV1(first, second)).toBe(1);
  });

  it('uses Rec.601 luma and the media-test SSIM constants', () => {
    const c1 = (0.01 * 255) ** 2;
    const redLuma = 0.299 * 255;
    const greenLuma = 0.587 * 255;
    const expected =
      (2 * redLuma * greenLuma + c1) / (redLuma * redLuma + greenLuma * greenLuma + c1);
    expect(ssimLumaV1(solidRgba(8, 8, 255, 0, 0), solidRgba(8, 8, 0, 255, 0))).toBeCloseTo(
      expected,
      14,
    );
  });

  it('averages non-overlapping 8x8 windows and falls back globally for smaller images', () => {
    const black = solidRgba(16, 8, 0, 0, 0);
    const halfWhite = solidRgba(16, 8, 0, 0, 0);
    for (let y = 0; y < 8; y++) {
      for (let x = 8; x < 16; x++) {
        const offset = (y * 16 + x) * 4;
        halfWhite.data[offset] = 255;
        halfWhite.data[offset + 1] = 255;
        halfWhite.data[offset + 2] = 255;
      }
    }
    const c1 = (0.01 * 255) ** 2;
    const blackWhite = c1 / (255 * 255 + c1);
    expect(ssimLumaV1(black, halfWhite)).toBeCloseTo((1 + blackWhite) / 2, 14);
    expect(ssimLumaV1(solidRgba(1, 1, 0, 0, 0), solidRgba(1, 1, 255, 255, 255))).toBeCloseTo(
      blackWhite,
      14,
    );
  });

  it('matches media-test size-mismatch area penalization', () => {
    expect(ssimLumaV1(solidRgba(8, 8, 0, 0, 0), solidRgba(16, 8, 0, 0, 0))).toBe(0.5);
  });

  it.each([
    null,
    { data: new Uint8Array(), width: 0, height: 1 },
    { data: new Uint8Array(4), width: 1.5, height: 1 },
    { data: new Uint8Array(3), width: 1, height: 1 },
    { data: new Uint16Array(4), width: 1, height: 1 },
    { data: new Uint8Array(), width: Number.MAX_SAFE_INTEGER, height: 2 },
  ])('rejects malformed tight RGBA image %#', (image) => {
    expect(() => ssimLumaV1(image as TightRgbaImage, solidRgba(1, 1, 0, 0, 0))).toThrow(InputError);
  });
});

describe('bounded candidate chunk collection', () => {
  interface Chunk {
    readonly id: number;
    readonly byteLength: number;
  }

  it('retains original chunks at or below the cap and reports exact bytes', async () => {
    const chunks: Chunk[] = [
      { id: 1, byteLength: 2 },
      { id: 2, byteLength: 3 },
    ];
    const stream = new ReadableStream<Chunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const result = await collectBoundedCandidateChunks(stream, 5);
    expect(result).toEqual({ byteLength: 5, chunks });
    expect(result.chunks?.[0]).toBe(chunks[0]);
  });

  it('clears retained chunks permanently on overflow but drains for the exact total', async () => {
    const input: Chunk[] = [
      { id: 1, byteLength: 2 },
      { id: 2, byteLength: 3 },
      { id: 3, byteLength: 7 },
    ];
    let index = 0;
    let pulls = 0;
    let cancelReason: unknown;
    const stream = new ReadableStream<Chunk>(
      {
        pull(controller) {
          pulls++;
          const chunk = input[index++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
        cancel(reason) {
          cancelReason = reason;
        },
      },
      { highWaterMark: 0 },
    );

    await expect(collectBoundedCandidateChunks(stream, 4)).resolves.toEqual({
      byteLength: 12,
      chunks: undefined,
    });
    expect(pulls).toBe(4);
    expect(cancelReason).toBeUndefined();
  });

  it('cancels without pulling when the signal is already aborted', async () => {
    let pulls = 0;
    let cancelReason: unknown;
    const stream = new ReadableStream<Chunk>(
      {
        pull() {
          pulls++;
        },
        cancel(reason) {
          cancelReason = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const abort = new AbortController();
    abort.abort('stop');

    await expect(collectBoundedCandidateChunks(stream, 10, abort.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(pulls).toBe(0);
    expect(cancelReason).toMatchObject({ code: 'aborted' });
  });

  it('interrupts a pending read and cancels with the typed abort error', async () => {
    let pulls = 0;
    let cancelReason: unknown;
    let releasePendingPull = (): void => undefined;
    const stream = new ReadableStream<Chunk>(
      {
        pull(controller) {
          pulls++;
          if (pulls === 1) {
            controller.enqueue({ id: 1, byteLength: 2 });
            return;
          }
          return new Promise<void>((resolve) => {
            releasePendingPull = resolve;
          });
        },
        cancel(reason) {
          cancelReason = reason;
          releasePendingPull();
        },
      },
      { highWaterMark: 0 },
    );
    const abort = new AbortController();
    const collected = collectBoundedCandidateChunks(stream, 10, abort.signal);
    await vi.waitFor(() => expect(pulls).toBe(2));
    abort.abort('stop pending read');

    await expect(collected).rejects.toMatchObject({ code: 'aborted' });
    expect(cancelReason).toMatchObject({ code: 'aborted' });
  });

  it('cancels with the primary error when chunk inspection fails', async () => {
    const primary = new Error('bad byteLength getter');
    let cancelReason: unknown;
    const badChunk = { id: 1 } as Chunk;
    Object.defineProperty(badChunk, 'byteLength', {
      get() {
        throw primary;
      },
    });
    const stream = new ReadableStream<Chunk>({
      start(controller) {
        controller.enqueue(badChunk);
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });

    await expect(collectBoundedCandidateChunks(stream, 10)).rejects.toBe(primary);
    expect(cancelReason).toBe(primary);
  });

  it('cancels when aggregate byte accounting ceases to be safe', async () => {
    let cancelReason: unknown;
    const stream = new ReadableStream<Chunk>({
      start(controller) {
        controller.enqueue({ id: 1, byteLength: Number.MAX_SAFE_INTEGER });
        controller.enqueue({ id: 2, byteLength: 1 });
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });

    await expect(
      collectBoundedCandidateChunks(stream, H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES),
    ).rejects.toThrow(/candidate byte total exceeds safe integer accounting/);
    expect(cancelReason).toBeInstanceOf(InputError);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid byte cap %s before locking the stream',
    async (maxBytes) => {
      const stream = new ReadableStream<Chunk>();
      await expect(collectBoundedCandidateChunks(stream, maxBytes)).rejects.toBeInstanceOf(
        InputError,
      );
      expect(stream.locked).toBe(false);
    },
  );

  it('rejects an operationally unbounded cap before locking the stream', async () => {
    const stream = new ReadableStream<Chunk>();
    await expect(
      collectBoundedCandidateChunks(stream, H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES + 1),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(stream.locked).toBe(false);
  });
});
