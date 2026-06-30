/**
 * Unit tests for the codec-tier pipeline helpers (`./codec-pipeline.ts`) — the pure routing + config
 * normalization that turns public convert/encode options into concrete WebCodecs `EncoderConfig`s,
 * `FilterSpec` chains, mux `TrackInfo`s, container choices, and the seek control flow. These are real,
 * can-fail oracles (exact expected values, not smoke) and run with NO WebCodecs — the live frame
 * round-trips are validated in the browser harness. Frame/chunk-touching functions (`seekFrame`,
 * `drainEncoderToMuxer`) are exercised with fake closable items so close-once and ordering are pinned.
 */

import { describe, expect, it } from 'vitest';
import type { EncodedChunk, FilterSpec, Packet, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { audioFilterSpecs } from './audio-stream-plan.ts';
import {
  audioCodecToken,
  audioEncodeNeedsSoftwareRuntime,
  audioEncoderCodecString,
  audioTrackInfoFromDecoderConfig,
  buildAudioEncoderConfig,
  buildVideoEncoderConfig,
  buildVideoEncoderConfigForRuntime,
  chooseOutputContainer,
  containerHasChunkMuxer,
  drainEncoderToMuxer,
  firefoxAudioTranscodeDeclineReason,
  firefoxOpusAudioEncodeTarget,
  firefoxOpusEncodeUsesWasm,
  firefoxVideoTranscodeDeclineReason,
  frameSatisfiesSeek,
  h264CodecStringForDimensions,
  h264LevelIdcForDimensions,
  hasTrackSelection,
  isPcmContainer,
  isPureStreamCopy,
  isUnsupportedHevcEncodeProfile,
  normalizeDecoderCodec,
  outputDimensions,
  resolveAudioEncodeTargetForRuntime,
  seekFrame,
  selectTrackInfos,
  splitRgbaForVpxAlpha,
  videoCodecToken,
  videoEncoderCodecString,
  videoTrackInfoFromDecoderConfig,
  webkitVideoTranscodeDeclineReason,
} from './codec-pipeline.ts';
import {
  planCfrFrameRetiming,
  planH264AbrLadder,
  planVideoBitDepthConversion,
  planVideoRateControl,
  retimeTimedFrameStream,
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
      'flac',
      'mp3',
      'adts',
      'wav',
      'avi',
    ] as const) {
      expect(containerHasChunkMuxer(c)).toBe(true);
    }
  });
  it('is false for PCM containers without packet muxers and not-yet-muxable elementary containers', () => {
    // aiff/caf author PCM via transformPcm (not the chunk seam); the bare 'aac' token has no muxer (ADTS is
    // the AAC elementary-stream target) — declaring them would over-claim.
    for (const c of ['aiff', 'caf', 'aac'] as const) {
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

describe('videoEncoderCodecString', () => {
  it('maps a token to its default profile string', () => {
    expect(videoEncoderCodecString('h264', undefined)).toBe('avc1.42E01E');
    expect(videoEncoderCodecString('hevc', undefined)).toBe('hev1.1.6.L93.B0');
    expect(videoEncoderCodecString('vp9', undefined)).toBe('vp09.00.10.08');
    expect(videoEncoderCodecString('av1', undefined)).toBe('av01.0.04M.08');
  });

  it('preserves the source codec string when no token is given (same-codec transcode)', () => {
    expect(videoEncoderCodecString(undefined, 'avc1.640028')).toBe('avc1.640028');
    expect(videoEncoderCodecString(undefined, 'hvc1.1.6.L150.90')).toBe('hvc1.1.6.L150.90');
    expect(videoEncoderCodecString(undefined, 'vp09.00.10.08')).toBe('vp09.00.10.08');
  });

  it('throws a typed CapabilityError when neither a token nor a recognizable source codec is available', () => {
    expect(() => videoEncoderCodecString(undefined, undefined)).toThrow(CapabilityError);
    expect(() => videoEncoderCodecString(undefined, 'mp4a.40.2')).toThrow(CapabilityError); // audio source
  });

  it('throws a typed CapabilityError rather than preserving HEVC Main10/non-Main encode strings', () => {
    expect(() => videoEncoderCodecString(undefined, 'hev1.2.4.L93.90')).toThrow(CapabilityError);
  });
});

describe('isUnsupportedHevcEncodeProfile', () => {
  it('allows HEVC Main 8-bit codec strings and non-HEVC strings', () => {
    expect(isUnsupportedHevcEncodeProfile('hev1.1.6.L93.B0')).toBe(false);
    expect(isUnsupportedHevcEncodeProfile('hvc1.1.6.L150.90')).toBe(false);
    expect(isUnsupportedHevcEncodeProfile('avc1.640028')).toBe(false);
    expect(isUnsupportedHevcEncodeProfile('vp09.00.10.08')).toBe(false);
  });

  it('flags HEVC Main10/non-Main profiles as an honest encode miss without a software tail', () => {
    expect(isUnsupportedHevcEncodeProfile('hev1.2.4.L93.90')).toBe(true);
    expect(isUnsupportedHevcEncodeProfile('hvc1.A2.80000000.H120.40.00.80')).toBe(true);
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

  it('emits crop → resize → rotate → flip → colorspace → tonemap in order', () => {
    const specs = videoFilterSpecs(
      {
        crop: { x: 10, y: 20, width: 640, height: 480 },
        width: 320,
        height: 240,
        fit: 'cover',
        rotate: 90,
        flip: 'h',
        colorspace: { to: 'bt2020' },
        tonemap: { to: 'sdr' },
      },
      src,
    );
    expect(specs).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'crop', x: 10, y: 20, width: 640, height: 480 },
      { mediaType: 'video', type: 'resize', width: 320, height: 240, fit: 'cover' },
      { mediaType: 'video', type: 'rotate', degrees: 90 },
      { mediaType: 'video', type: 'flip', axis: 'h' },
      { mediaType: 'video', type: 'colorspace', to: 'bt2020' },
      { mediaType: 'video', type: 'tonemap', to: 'sdr' },
    ]);
  });

  it('fills a missing resize dimension from the known source dims', () => {
    expect(videoFilterSpecs({ width: 1280 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'resize', width: 1280, height: 1080 },
    ]);
    expect(videoFilterSpecs({ height: 720 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'resize', width: 1920, height: 720 },
    ]);
  });

  it('omits a no-op rotate(0) but keeps 180', () => {
    expect(videoFilterSpecs({ rotate: 0 }, src)).toEqual([]);
    expect(videoFilterSpecs({ rotate: 180 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'rotate', degrees: 180 },
    ]);
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

  it('rejects malformed colour targets before the browser filter stream is built', () => {
    expect(() => videoFilterSpecs({ colorspace: { to: '  ' } }, src)).toThrow(InputError);
    const badTonemap = { tonemap: { to: 'hdr' } } as unknown as Parameters<
      typeof videoFilterSpecs
    >[0];
    expect(() => videoFilterSpecs(badTonemap, src)).toThrow(InputError);
  });
});

describe('outputDimensions', () => {
  const src = { width: 1920, height: 1080 };

  it('passes the source dims through with no geometry', () => {
    expect(outputDimensions({}, src)).toEqual({ width: 1920, height: 1080 });
  });

  it('takes the crop rect, then the resize, then swaps on 90/270', () => {
    expect(outputDimensions({ crop: { x: 0, y: 0, width: 800, height: 600 } }, src)).toEqual({
      width: 800,
      height: 600,
    });
    expect(outputDimensions({ width: 320, height: 240 }, src)).toEqual({ width: 320, height: 240 });
    expect(outputDimensions({ width: 320, height: 240, rotate: 90 }, src)).toEqual({
      width: 240,
      height: 320,
    });
    expect(outputDimensions({ rotate: 270 }, src)).toEqual({ width: 1080, height: 1920 });
  });

  it('keeps the source dimension for an omitted resize axis', () => {
    expect(outputDimensions({ width: 320 }, src)).toEqual({ width: 320, height: 1080 });
    expect(outputDimensions({ height: 240 }, src)).toEqual({ width: 1920, height: 240 });
  });

  it('flip is dimension-preserving', () => {
    expect(outputDimensions({ flip: 'v' }, src)).toEqual({ width: 1920, height: 1080 });
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
      planCfrFrameRetiming([{ timestamp: 10_000 }, { timestamp: 5_000 }], { fps: 30 }),
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
    expect(planCfrFrameRetiming([{ timestamp: 10_000 }], { fps: 10, durationUs: 200_000 })).toEqual(
      {
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
      },
    );
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

describe('audioFilterSpecs', () => {
  const src = { sampleRate: 48000, channels: 2 };

  it('emits no filters when gain/channels/rate are unchanged (or unspecified)', () => {
    expect(audioFilterSpecs({}, src)).toEqual([]);
    expect(audioFilterSpecs({ codec: 'aac', bitrate: 128_000 }, src)).toEqual([]);
    expect(audioFilterSpecs({ gainDb: 0, channels: 2, sampleRate: 48000 }, src)).toEqual([]);
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
      { mediaType: 'audio', type: 'fade', curve: 'linear', inFrames: 24000, outFrames: 12000 },
    ]);
    // Fade frames are resolved at the source rate even when a resample follows (fade precedes resample),
    // and the resample is emitted after the fade.
    expect(
      audioFilterSpecs({ fade: { outSec: 1, curve: 'equal-power' }, sampleRate: 22050 }, src),
    ).toEqual<FilterSpec[]>([
      { mediaType: 'audio', type: 'fade', curve: 'equal-power', inFrames: 0, outFrames: 48000 },
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
      { mediaType: 'audio', type: 'biquad', spec: { type: 'highpass', frequency: 80, q: 0.7 } },
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
        { dynamics: { normalize: { mode: 'rms', targetDbfs: -14 }, limit: {} } },
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
      { mediaType: 'audio', type: 'fade', curve: 'equal-power', inFrames: 4800, outFrames: 0 },
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
        { dynamics: { normalize: { mode: 'lufs' as unknown as 'peak', targetDbfs: -14 } } },
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

describe('buildVideoEncoderConfig', () => {
  const src = { width: 1920, height: 1080 };

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

  it('uses a resolution-aware default bitrate for offline video encodes', () => {
    expect(
      buildVideoEncoderConfig({ codec: 'vp8', width: 640, height: 360 }, src, undefined),
    ).toMatchObject({
      bitrate: 2_534_400,
      bitrateMode: 'variable',
    });
  });

  it('builds CRF as WebCodecs quantizer mode but keeps two-pass as an honest miss', () => {
    expect(buildVideoEncoderConfig({ codec: 'h264', crf: 23 }, src, undefined)).toEqual({
      codec: 'avc1.42E028',
      width: 1920,
      height: 1080,
      latencyMode: 'quality',
      bitrateMode: 'quantizer',
    });
    expect(() =>
      buildVideoEncoderConfig({ codec: 'h264', bitrate: 2_000_000, twoPass: true }, src, undefined),
    ).toThrow(CapabilityError);
    expect(() => buildVideoEncoderConfig({ codec: 'vp8', crf: 23 }, src, undefined)).toThrow(
      CapabilityError,
    );
  });

  it('sizes the H.264 level to the output dims while flooring tiny browser encodes at L3.0', () => {
    // tiny 320×180 is Annex-A-valid at L1.3, but Chromium 149 produced MP4s that its platform
    // <video> seek path could not decode when the WebCodecs encoder was configured below L3.0.
    // Keep the browser-facing encode string at the common SD floor (L3.0), which is still a truthful
    // upper-bound declaration for this stream.
    expect(
      buildVideoEncoderConfig({ codec: 'h264', width: 320, height: 180 }, src, undefined).codec,
    ).toBe(
      'avc1.42E01E', // level 3.0 browser-seek-stable floor
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

  it('does NOT rewrite a preserved-source or non-h264-token codec string', () => {
    // preserve-source High profile stays verbatim (we never re-level a pinned profile)
    expect(buildVideoEncoderConfig({}, src, 'avc1.640028').codec).toBe('avc1.640028');
    // preserve-source HEVC Main stays verbatim so hvc1/hev1 sample-entry semantics are not guessed away
    expect(buildVideoEncoderConfig({}, src, 'hvc1.1.6.L150.90').codec).toBe('hvc1.1.6.L150.90');
    // a non-h264 token uses its own default string regardless of dims
    expect(
      buildVideoEncoderConfig({ codec: 'vp9', width: 1920, height: 1080 }, src, undefined).codec,
    ).toBe('vp09.00.10.08');
    expect(buildVideoEncoderConfig({ codec: 'hevc' }, src, undefined).codec).toBe(
      'hev1.1.6.L93.B0',
    );
  });

  it('uses the resized + rotated output dimensions', () => {
    const cfg = buildVideoEncoderConfig(
      { codec: 'vp9', width: 640, height: 360, rotate: 90 },
      src,
      undefined,
    );
    expect(cfg.width).toBe(360);
    expect(cfg.height).toBe(640);
    expect(cfg.codec).toBe('vp09.00.10.08');
  });

  it('preserves the source codec when none is requested', () => {
    expect(buildVideoEncoderConfig({}, src, 'avc1.640028').codec).toBe('avc1.640028');
  });

  it('rejects preserved HEVC Main10/non-Main encode profiles as a typed miss', () => {
    expect(() => buildVideoEncoderConfig({}, src, 'hev1.2.4.L93.90')).toThrow(CapabilityError);
    expect(() => buildVideoEncoderConfig({}, src, 'hvc1.A2.80000000.H120.40.00.80')).toThrow(
      CapabilityError,
    );
  });

  it('honors requested 8-bit output and rejects unsupported 10-bit output requests', () => {
    expect(buildVideoEncoderConfig({ codec: 'h264', bitDepth: 8 }, src, undefined).codec).toBe(
      'avc1.42E028',
    );
    expect(() => buildVideoEncoderConfig({ codec: 'hevc', bitDepth: 10 }, src, undefined)).toThrow(
      CapabilityError,
    );
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
  const src = { width: 1920, height: 1080, fps: 30 };

  it('declines the WebKit sub-modes that the browser harness proves unstable for this package', () => {
    expect(webkitVideoTranscodeDeclineReason({ fps: 15 }, src)).toContain('fps downsample');
    expect(webkitVideoTranscodeDeclineReason({ fps: 1 }, src)).toContain('fps downsample');
    expect(webkitVideoTranscodeDeclineReason({ rotate: 90 }, src)).toContain('rotate 90');
    expect(webkitVideoTranscodeDeclineReason({ rotate: 180 }, src)).toContain('rotate 180');
    expect(webkitVideoTranscodeDeclineReason({ colorspace: { to: 'bt2020' } }, src)).toContain(
      'colorspace',
    );
    expect(webkitVideoTranscodeDeclineReason({ tonemap: { to: 'sdr' } }, src)).toContain('tonemap');
    expect(webkitVideoTranscodeDeclineReason({ alpha: 'keep' }, src)).toContain('alpha-preserving');
  });

  it('keeps WebKit sub-modes runnable when focused evidence shows they pass', () => {
    expect(webkitVideoTranscodeDeclineReason({ fps: 30 }, src)).toBeUndefined();
    expect(webkitVideoTranscodeDeclineReason({ fps: 60 }, src)).toBeUndefined();
    expect(webkitVideoTranscodeDeclineReason({ rotate: 270 }, src)).toBeUndefined();
    expect(webkitVideoTranscodeDeclineReason({ width: 1280, height: 720 }, src)).toBeUndefined();
  });

  it('does not guess a WebKit fps downsample decline without a finite source fps', () => {
    expect(
      webkitVideoTranscodeDeclineReason({ fps: 15 }, { width: 1920, height: 1080 }),
    ).toBeUndefined();
    expect(
      webkitVideoTranscodeDeclineReason(
        { fps: 15 },
        { width: 1920, height: 1080, fps: Number.NaN },
      ),
    ).toBeUndefined();
    expect(webkitVideoTranscodeDeclineReason({}, src)).toBeUndefined();
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

  it('declines Firefox known-timeout VP9 output before opening frame streams', () => {
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9' }, 'avc1.640028', {
        width: 1920,
        height: 1080,
        fps: 30,
        durationSec: 30,
      }),
    ).toContain('VP9 video transcode');
    expect(
      firefoxVideoTranscodeDeclineReason({ codec: 'vp9', width: 640, height: 360 }, 'avc1.640028', {
        width: 1280,
        height: 720,
        fps: 30,
        durationSec: 5,
      }),
    ).toContain('VP9 video transcode');
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
      webCodecsConfigurable: false,
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

  it('keeps same-depth transcodes as no-op and rejects unsupported up-conversion/Main10 output', () => {
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
    expect(() =>
      planVideoBitDepthConversion({
        sourceCodec: 'avc1.42E028',
        targetCodec: 'hev1.2.4.L93.90',
      }),
    ).toThrow(CapabilityError);
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
    expect(planVideoBitDepthConversion({ sourceCodec: 'vp8', targetCodec: 'unknown' })).toEqual({
      kind: 'none',
      sourceBitDepth: 8,
      targetBitDepth: undefined,
      requiresPixelPath: false,
    });
    expect(() => planVideoBitDepthConversion({ sourceBitDepth: 9, targetBitDepth: 8 })).toThrow(
      InputError,
    );
    expect(() => planVideoBitDepthConversion({ sourceBitDepth: 12, targetBitDepth: 8 })).toThrow(
      CapabilityError,
    );
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
        video: { codec: 'h264', width: 1280, height: 720, bitrate: 3_000_000, fps: 30 },
      },
      { to: 'mp4', video: { codec: 'h264', width: 640, height: 360, bitrate: 800_000, fps: 30 } },
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
    expect(h264CodecStringForDimensions(320, 180, 30)).toBe('avc1.42E01E');
    expect(h264CodecStringForDimensions(1920, 1080, 30)).toBe('avc1.42E028');
    expect(h264CodecStringForDimensions(3840, 2160, 30)).toBe('avc1.42E033');
  });

  it('floors tiny H.264 encode configs at L3.0 for Chromium platform seek compatibility', () => {
    // Reproduces the Node-visible half of the failing browser scenarios:
    // transcode/ladder_tiny_h264_360p_resize_180p and
    // transcode/ladder_tiny_vp9_360p_to_h264_180p both target H.264 MP4 at 320×180 with no fps override.
    // The pre-fix string was avc1.42E00D; Chromium 149 accepted the encode but later failed to seek-decode
    // the produced MP4 via <video>. A higher level is a legal capability upper bound, not a bitrate/dim lie.
    expect(h264LevelIdcForDimensions(320, 180, undefined)).toBe(0x0d);
    expect(h264CodecStringForDimensions(320, 180, undefined)).toBe('avc1.42E01E');
    expect(h264CodecStringForDimensions(1, 1, 30)).toBe('avc1.42E01E');
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

  it('derives hev1.* from an HEVC description (hvcC profile/compat/tier/level bytes)', () => {
    // Real h265.mp4 hvcC bytes: Main, compat 6, low tier, level 60, constraint 0x90.
    const hvcC8Bit = Uint8Array.from([0x01, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x3c]);
    expect(normalizeDecoderCodec({ codec: 'hevc', description: hvcC8Bit })).toBe('hev1.1.6.L60.90');

    // Real bear-hevc-10bit-hdr10 shape: Main10, compat 4, low tier, level 93, constraint 0x90.
    const hvcC10Bit = Uint8Array.from([0x01, 0x02, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d]);
    expect(normalizeDecoderCodec({ codec: 'h265', description: hvcC10Bit })).toBe(
      'hev1.2.4.L93.90',
    );
  });

  it('leaves a bare h264/hevc token unchanged when no usable description is available', () => {
    // Without the CodecPrivate the bare token cannot be expanded — honest miss, not a wrong guess.
    expect(normalizeDecoderCodec({ codec: 'h264' })).toBe('h264');
    expect(normalizeDecoderCodec({ codec: 'hevc' })).toBe('hevc');
    // too-short avcC/hvcC → cannot parse → unchanged
    expect(
      normalizeDecoderCodec({ codec: 'h264', description: new Uint8Array([0x01, 0x64]) }),
    ).toBe('h264');
    expect(
      normalizeDecoderCodec({ codec: 'hevc', description: new Uint8Array([0x01, 0x02, 0x20]) }),
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

describe('firefoxOpusAudioEncodeTarget / firefoxOpusEncodeUsesWasm', () => {
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
    expect(firefoxOpusAudioEncodeTarget({}, 'opus')).toEqual({ sampleRate: 48000 });
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
      firefoxOpusEncodeUsesWasm({ codec: 'opus', sampleRate: 44100, numberOfChannels: 2 }),
    ).toBe(false);
    expect(
      firefoxOpusEncodeUsesWasm({ codec: 'opus', sampleRate: 48000, numberOfChannels: 6 }),
    ).toBe(false);
    expect(
      firefoxOpusEncodeUsesWasm({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }),
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

  it('keeps non-Firefox audio targets untouched and uses the normal encoder config path', async () => {
    await withNavigator(chromeNavigator, async () => {
      const aac = { codec: 'aac', bitrate: 192_000 } as const;
      expect(await resolveAudioEncodeTargetForRuntime(aac, 'mp3')).toBe(aac);
      await expect(
        buildVideoEncoderConfigForRuntime({ codec: 'vp8' }, { width: 320, height: 240 }, 'vp8'),
      ).resolves.toMatchObject({ codec: 'vp8' });
      expect(
        await audioEncodeNeedsSoftwareRuntime({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      ).toBe(false);
    });
  });

  it('keeps WebKit video declines typed and scoped to unstable filtered paths', async () => {
    await withNavigator(safariNavigator, async () => {
      await expect(
        buildVideoEncoderConfigForRuntime({ alpha: 'keep' }, { width: 320, height: 240 }, 'vp9'),
      ).rejects.toThrow(CapabilityError);
      await expect(
        buildVideoEncoderConfigForRuntime({ codec: 'vp8' }, { width: 320, height: 240 }, 'vp9'),
      ).resolves.toMatchObject({ codec: 'vp8' });
    });
  });

  it('applies Firefox-specific video and Opus audio routing evidence', async () => {
    await withNavigator(firefoxNavigator, async () => {
      await expect(
        buildVideoEncoderConfigForRuntime(
          { codec: 'vp9' },
          { width: 640, height: 360, durationSec: 5 },
          'h264',
        ),
      ).rejects.toThrow(CapabilityError);
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
      config: { codec: 'avc1.42E01E', codedWidth: 640, codedHeight: 480, description },
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
      config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description },
      durationSec: 9.75,
    });
  });
});

// ── stream-copy auto-route ─────────────────────────────────────────────────────────────────────

describe('isPureStreamCopy', () => {
  it('is true when no re-encode is requested for either stream', () => {
    expect(isPureStreamCopy({})).toBe(true);
    expect(isPureStreamCopy({ video: {}, audio: {} })).toBe(true);
    expect(isPureStreamCopy({ audio: { gainDb: 0 } })).toBe(true);
  });

  it('is false when any re-encode trigger is present', () => {
    expect(isPureStreamCopy({ video: { codec: 'h264' } })).toBe(false);
    expect(isPureStreamCopy({ video: { width: 1280 } })).toBe(false);
    expect(isPureStreamCopy({ video: { rotate: 90 } })).toBe(false);
    expect(isPureStreamCopy({ video: { crop: { x: 0, y: 0, width: 10, height: 10 } } })).toBe(
      false,
    );
    expect(isPureStreamCopy({ video: { colorspace: { to: 'bt2020' } } })).toBe(false);
    expect(isPureStreamCopy({ video: { tonemap: { to: 'sdr' } } })).toBe(false);
    expect(isPureStreamCopy({ audio: { codec: 'opus' } })).toBe(false);
    expect(isPureStreamCopy({ audio: { sampleRate: 44100 } })).toBe(false);
    expect(isPureStreamCopy({ audio: { bitrate: 96_000 } })).toBe(false);
    expect(isPureStreamCopy({ audio: { gainDb: -6 } })).toBe(false);
    expect(isPureStreamCopy({ audio: { fade: { inSec: 1 } } })).toBe(false);
    expect(
      isPureStreamCopy({ audio: { dynamics: { normalize: { mode: 'peak', targetDbfs: -3 } } } }),
    ).toBe(false);
    expect(
      isPureStreamCopy({ audio: { biquad: { type: 'lowpass', frequency: 1000, q: 1 } } }),
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
});
