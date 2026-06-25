/**
 * Unit tests for the codec-tier pipeline helpers (`./codec-pipeline.ts`) — the pure routing + config
 * normalization that turns public convert/encode options into concrete WebCodecs `EncoderConfig`s,
 * `FilterSpec` chains, mux `TrackInfo`s, container choices, and the seek control flow. These are real,
 * can-fail oracles (exact expected values, not smoke) and run with NO WebCodecs — the live frame
 * round-trips are validated in the browser harness. Frame/chunk-touching functions (`seekFrame`,
 * `drainEncoderToMuxer`) are exercised with fake closable items so close-once and ordering are pinned.
 */

import { describe, expect, it } from 'vitest';
import type { EncodedChunk, FilterSpec, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import {
  audioCodecToken,
  audioEncoderCodecString,
  audioFilterSpecs,
  audioTrackInfoFromDecoderConfig,
  buildAudioEncoderConfig,
  buildVideoEncoderConfig,
  chooseOutputContainer,
  containerHasChunkMuxer,
  drainEncoderToMuxer,
  frameSatisfiesSeek,
  h264CodecStringForDimensions,
  h264LevelIdcForDimensions,
  isPcmContainer,
  isPureStreamCopy,
  normalizeDecoderCodec,
  outputDimensions,
  seekFrame,
  videoCodecToken,
  videoEncoderCodecString,
  videoFilterSpecs,
  videoTrackInfoFromDecoderConfig,
} from './codec-pipeline.ts';

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
  });

  it('defaults to mp4 when the source is not chunk-muxable or unknown', () => {
    expect(chooseOutputContainer(undefined, 'wav')).toBe('mp4'); // PCM source → transformPcm, not the seam
    expect(chooseOutputContainer(undefined, 'mp3')).toBe('mp4'); // no mp3 chunk muxer in this build
    expect(chooseOutputContainer(undefined, undefined)).toBe('mp4');
    expect(chooseOutputContainer(undefined, 'totally-unknown')).toBe('mp4');
  });
});

describe('containerHasChunkMuxer', () => {
  it('is true for the containers with a real EncodedChunk-seam muxer (mp4/mov, webm/mkv, ogg)', () => {
    for (const c of ['mp4', 'mov', 'webm', 'mkv', 'ogg'] as const) {
      expect(containerHasChunkMuxer(c)).toBe(true);
    }
  });
  it('is false for PCM (transformPcm path) and the not-yet-muxable elementary/TS containers', () => {
    // wav/aiff/caf author PCM via transformPcm (not the chunk seam); mp3/aac/adts/flac/ts muxers are
    // a typed miss for now — declaring them here would over-claim (the muxer still self-rejects too).
    for (const c of ['wav', 'aiff', 'caf', 'mp3', 'aac', 'adts', 'flac', 'ts'] as const) {
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
    expect(audioCodecToken('flac')).toBe('flac');
    expect(audioCodecToken('vorbis')).toBe('vorbis');
    expect(audioCodecToken('avc1.42E01E')).toBeUndefined();
  });
});

describe('videoEncoderCodecString', () => {
  it('maps a token to its default profile string', () => {
    expect(videoEncoderCodecString('h264', undefined)).toBe('avc1.42E01E');
    expect(videoEncoderCodecString('vp9', undefined)).toBe('vp09.00.10.08');
    expect(videoEncoderCodecString('av1', undefined)).toBe('av01.0.04M.08');
  });

  it('preserves the source codec string when no token is given (same-codec transcode)', () => {
    expect(videoEncoderCodecString(undefined, 'avc1.640028')).toBe('avc1.640028');
    expect(videoEncoderCodecString(undefined, 'vp09.00.10.08')).toBe('vp09.00.10.08');
  });

  it('throws a typed CapabilityError when neither a token nor a recognizable source codec is available', () => {
    expect(() => videoEncoderCodecString(undefined, undefined)).toThrow(CapabilityError);
    expect(() => videoEncoderCodecString(undefined, 'mp4a.40.2')).toThrow(CapabilityError); // audio source
  });
});

describe('audioEncoderCodecString', () => {
  it('maps a token to its codec string and preserves source otherwise', () => {
    expect(audioEncoderCodecString('aac', undefined)).toBe('mp4a.40.2');
    expect(audioEncoderCodecString('opus', undefined)).toBe('opus');
    expect(audioEncoderCodecString(undefined, 'mp4a.40.5')).toBe('mp4a.40.5');
  });

  it('rejects a PCM target (it flows through the audio-dsp path, not the WebCodecs encoder)', () => {
    expect(() => audioEncoderCodecString('pcm', undefined)).toThrow(CapabilityError);
  });

  it('throws a typed CapabilityError with no token and no recognizable source codec', () => {
    expect(() => audioEncoderCodecString(undefined, undefined)).toThrow(CapabilityError);
  });
});

// ── filter chain ───────────────────────────────────────────────────────────────────────────────

describe('videoFilterSpecs', () => {
  const src = { width: 1920, height: 1080 };

  it('returns no specs when the target requests no geometry', () => {
    expect(videoFilterSpecs({}, src)).toEqual([]);
    expect(videoFilterSpecs({ codec: 'h264', bitrate: 1_000_000 }, src)).toEqual([]);
  });

  it('emits crop → resize → rotate → flip in order', () => {
    const specs = videoFilterSpecs(
      {
        crop: { x: 10, y: 20, width: 640, height: 480 },
        width: 320,
        height: 240,
        fit: 'cover',
        rotate: 90,
        flip: 'h',
      },
      src,
    );
    expect(specs).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'crop', x: 10, y: 20, width: 640, height: 480 },
      { mediaType: 'video', type: 'resize', width: 320, height: 240, fit: 'cover' },
      { mediaType: 'video', type: 'rotate', degrees: 90 },
      { mediaType: 'video', type: 'flip', axis: 'h' },
    ]);
  });

  it('fills a missing resize dimension from the known source dims', () => {
    expect(videoFilterSpecs({ width: 1280 }, src)).toEqual<FilterSpec[]>([
      { mediaType: 'video', type: 'resize', width: 1280, height: 1080 },
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
    expect(() => videoFilterSpecs({ width: -5, height: 5 }, src)).toThrow(InputError);
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

  it('flip is dimension-preserving', () => {
    expect(outputDimensions({ flip: 'v' }, src)).toEqual({ width: 1920, height: 1080 });
  });
});

// ── audio filter chain (the stereo→mono / resample shaping before the encoder) ────────────────────

describe('audioFilterSpecs', () => {
  const src = { sampleRate: 48000, channels: 2 };

  it('emits no filters when channels/rate are unchanged (or unspecified)', () => {
    expect(audioFilterSpecs({}, src)).toEqual([]);
    expect(audioFilterSpecs({ codec: 'aac', bitrate: 128_000 }, src)).toEqual([]);
    expect(audioFilterSpecs({ channels: 2, sampleRate: 48000 }, src)).toEqual([]);
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

  it('rejects a non-positive / non-integer target channel count or rate', () => {
    expect(() => audioFilterSpecs({ channels: 0 }, src)).toThrow(InputError);
    expect(() => audioFilterSpecs({ channels: 1.5 }, src)).toThrow(InputError);
    expect(() => audioFilterSpecs({ sampleRate: -1 }, src)).toThrow(InputError);
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
      framerate: 30,
    });
  });

  it('sizes the H.264 level to the OUTPUT dims (the gap-#1 fix): low dims → low level, 4K → L5.1', () => {
    // tiny 320×180 → a level ≤ 3.0 (the encoder accepts it; old code over-claimed L3.0 for everything)
    expect(
      buildVideoEncoderConfig({ codec: 'h264', width: 320, height: 180 }, src, undefined).codec,
    ).toBe(
      'avc1.42E00D', // level 1.3
    );
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
    // a non-h264 token uses its own default string regardless of dims
    expect(
      buildVideoEncoderConfig({ codec: 'vp9', width: 1920, height: 1080 }, src, undefined).codec,
    ).toBe('vp09.00.10.08');
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

  it('leaves a bare h264/hevc token unchanged when no description is available (demuxer-side gap)', () => {
    // Without the CodecPrivate the bare token cannot be expanded — honest miss, not a wrong guess.
    expect(normalizeDecoderCodec({ codec: 'h264' })).toBe('h264');
    expect(normalizeDecoderCodec({ codec: 'hevc' })).toBe('hevc');
    // too-short avcC → cannot parse → unchanged
    expect(
      normalizeDecoderCodec({ codec: 'h264', description: new Uint8Array([0x01, 0x64]) }),
    ).toBe('h264');
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

// ── mux TrackInfo ────────────────────────────────────────────────────────────────────────────────

describe('videoTrackInfoFromDecoderConfig / audioTrackInfoFromDecoderConfig', () => {
  it('carries the encoder-published decoder config (codec + description) into the TrackInfo', () => {
    const description = new Uint8Array([1, 2, 3, 4]);
    const info = videoTrackInfoFromDecoderConfig(
      { codec: 'avc1.42E01E', codedWidth: 640, codedHeight: 480, description },
      30,
    );
    expect(info).toEqual<TrackInfo>({
      id: 0,
      mediaType: 'video',
      codec: 'avc1.42E01E',
      config: { codec: 'avc1.42E01E', codedWidth: 640, codedHeight: 480, description },
      fps: 30,
    });
  });

  it('omits fps when undefined (exactOptionalPropertyTypes)', () => {
    const info = videoTrackInfoFromDecoderConfig({ codec: 'vp09.00.10.08' }, undefined);
    expect('fps' in info).toBe(false);
  });

  it('builds the audio TrackInfo from the AAC decoder config', () => {
    const description = new Uint8Array([0x12, 0x10]);
    expect(
      audioTrackInfoFromDecoderConfig({
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
        description,
      }),
    ).toEqual<TrackInfo>({
      id: 0,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description },
    });
  });
});

// ── stream-copy auto-route ─────────────────────────────────────────────────────────────────────

describe('isPureStreamCopy', () => {
  it('is true when no re-encode is requested for either stream', () => {
    expect(isPureStreamCopy({})).toBe(true);
    expect(isPureStreamCopy({ video: {}, audio: {} })).toBe(true);
  });

  it('is false when any re-encode trigger is present', () => {
    expect(isPureStreamCopy({ video: { codec: 'h264' } })).toBe(false);
    expect(isPureStreamCopy({ video: { width: 1280 } })).toBe(false);
    expect(isPureStreamCopy({ video: { rotate: 90 } })).toBe(false);
    expect(isPureStreamCopy({ video: { crop: { x: 0, y: 0, width: 10, height: 10 } } })).toBe(
      false,
    );
    expect(isPureStreamCopy({ audio: { codec: 'opus' } })).toBe(false);
    expect(isPureStreamCopy({ audio: { sampleRate: 44100 } })).toBe(false);
    expect(isPureStreamCopy({ audio: { bitrate: 96_000 } })).toBe(false);
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
  /** A fake muxer recording addTrack/write calls. */
  function fakeMuxer(): {
    addTrack: (info: TrackInfo) => number;
    write: (trackId: number, chunk: EncodedChunk) => Promise<void>;
    tracks: TrackInfo[];
    writes: { trackId: number; chunk: unknown }[];
  } {
    const tracks: TrackInfo[] = [];
    const writes: { trackId: number; chunk: unknown }[] = [];
    return {
      tracks,
      writes,
      addTrack(info): number {
        tracks.push(info);
        return tracks.length; // 1-based id
      },
      write(trackId, chunk): Promise<void> {
        writes.push({ trackId, chunk });
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
    expect(muxer.writes.map((w) => w.chunk)).toEqual(['a', 'b', 'c']);
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
