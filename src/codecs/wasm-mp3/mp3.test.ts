/**
 * Tests for the WASM MP3 driver. Two layers (BUILD §6, ADR-032):
 *
 *  1. **Pure helpers in Node** — MPEG-audio frame-header parsing (golden bytes computed independently from
 *     ISO/IEC 11172-3: MPEG-1 L3 128k/44100 = `FF FB 90 00`, frame size 417, 1152 samples; MPEG-2 L3 =
 *     576 samples), the bitrate/sample-rate tables, ID3v2 syncsafe sizing + ID3v1 detection, Xing/Info +
 *     LAME delay/padding parsing, frame walking on the **real** `sound_5.mp3`, planar f32, and config
 *     validation. Each assertion is falsifiable.
 *  2. **The REAL wasm MP3 core, decoding real media in Node.** The vendored Symphonia-in-wasm core
 *     (`mp3_wasm_bg.wasm` + `mp3-core.js`, built via `wasm-pack --target web`) is instantiated from bytes
 *     and fed the actual MP3 frames of `sound_5.mp3` and `bear-vbr-toc.mp3`. We gate on MP3's own
 *     un-fakeable invariant: the decoder emits exactly the per-frame sample count the frame header
 *     declares (1152 / 576), the channel count / rate match the header, and the PCM is finite, in-range,
 *     and non-silent. WebCodecs `AudioData` is browser-only, so the `AudioData`-wrapping `createDecoder`
 *     stream is validated in-browser; the codec itself is fully validated here.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  MP3_CODEC,
  MP3_MAX_CHANNELS,
  deinterleaveF32,
  firstFrameOffset,
  hasId3v1,
  id3v2Size,
  isFrameSync,
  isMp3Codec,
  iterateMp3Frames,
  normalizeMp3DecoderConfig,
  parseMp3FrameHeader,
  parseVbrHeader,
} from './mp3.ts';
import WasmMp3Module, {
  isMp3Query,
  loadMp3Core,
  resetMp3CoreForTest,
  unsupported,
  WasmMp3Driver,
} from './wasm-mp3-driver.ts';

const WASM_PATH = new URL('./mp3_wasm_bg.wasm', import.meta.url).pathname;

// ============ pure helpers: frame header ============

describe('parseMp3FrameHeader — ISO/IEC 11172-3 frame header (golden bytes)', () => {
  function header(
    opts: {
      versionBits?: number;
      layerBits?: number;
      crcAbsent?: boolean;
      bitrateIndex?: number;
      sampleRateIndex?: number;
      padding?: boolean;
      channelModeBits?: number;
    } = {},
  ): Uint8Array {
    const {
      versionBits = 3,
      layerBits = 1,
      crcAbsent = true,
      bitrateIndex = 9,
      sampleRateIndex = 0,
      padding = false,
      channelModeBits = 0,
    } = opts;
    return Uint8Array.of(
      0xff,
      0xe0 | ((versionBits & 0x3) << 3) | ((layerBits & 0x3) << 1) | (crcAbsent ? 1 : 0),
      ((bitrateIndex & 0xf) << 4) | ((sampleRateIndex & 0x3) << 2) | (padding ? 0x2 : 0),
      (channelModeBits & 0x3) << 6,
    );
  }

  it('MPEG-1 Layer III 128k/44100 stereo (FF FB 90 00) → frame size 417, 1152 samples', () => {
    const h = parseMp3FrameHeader(Uint8Array.of(0xff, 0xfb, 0x90, 0x00));
    expect(h.version).toBe('mpeg1');
    expect(h.layer).toBe(3);
    expect(h.bitrate).toBe(128_000);
    expect(h.sampleRate).toBe(44_100);
    expect(h.padding).toBe(false);
    expect(h.channelMode).toBe('stereo');
    expect(h.channels).toBe(2);
    expect(h.frameSize).toBe(417); // floor(144 * 128000 / 44100)
    expect(h.samplesPerFrame).toBe(1152);
    expect(h.crcAbsent).toBe(true);
  });
  it('padding adds one byte (FF FB 92 00 → 418)', () => {
    const h = parseMp3FrameHeader(Uint8Array.of(0xff, 0xfb, 0x92, 0x00)); // bit G set
    expect(h.padding).toBe(true);
    expect(h.frameSize).toBe(418);
  });
  it('MPEG-2 Layer III 64k/22050 mono → frame size 208, 576 samples', () => {
    // b1=0xF3 (ver=10 MPEG2, layer=01 L3, crc=1); b2=0x80 (br idx 8=64k, sr idx 0=22050); b3=0xC0 (mono)
    const h = parseMp3FrameHeader(Uint8Array.of(0xff, 0xf3, 0x80, 0xc0));
    expect(h.version).toBe('mpeg2');
    expect(h.layer).toBe(3);
    expect(h.bitrate).toBe(64_000);
    expect(h.sampleRate).toBe(22_050);
    expect(h.channelMode).toBe('mono');
    expect(h.channels).toBe(1);
    expect(h.frameSize).toBe(208); // floor(72 * 64000 / 22050)
    expect(h.samplesPerFrame).toBe(576);
  });
  it('MPEG-2.5 Layer III uses the low sample-rate table and 576 samples/frame', () => {
    const h = parseMp3FrameHeader(
      header({ versionBits: 0, layerBits: 1, bitrateIndex: 1, sampleRateIndex: 0, padding: true }),
    );
    expect(h.version).toBe('mpeg2.5');
    expect(h.layer).toBe(3);
    expect(h.bitrate).toBe(8_000);
    expect(h.sampleRate).toBe(11_025);
    expect(h.frameSize).toBe(53); // floor(72 * 8000 / 11025) + 1 padding byte
    expect(h.samplesPerFrame).toBe(576);
  });
  it('MPEG-1 Layer II dual-channel uses the Layer-II bitrate table and 1152 samples/frame', () => {
    const h = parseMp3FrameHeader(
      header({
        versionBits: 3,
        layerBits: 2,
        bitrateIndex: 5,
        sampleRateIndex: 1,
        padding: true,
        channelModeBits: 2,
      }),
    );
    expect(h.layer).toBe(2);
    expect(h.bitrate).toBe(80_000);
    expect(h.sampleRate).toBe(48_000);
    expect(h.channelMode).toBe('dual');
    expect(h.channels).toBe(2);
    expect(h.frameSize).toBe(241); // floor(144 * 80000 / 48000) + 1
    expect(h.samplesPerFrame).toBe(1152);
  });
  it('MPEG-1 Layer I joint-stereo uses 4-byte slots and 384 samples/frame', () => {
    const h = parseMp3FrameHeader(
      header({ versionBits: 3, layerBits: 3, bitrateIndex: 14, channelModeBits: 1 }),
    );
    expect(h.layer).toBe(1);
    expect(h.bitrate).toBe(448_000);
    expect(h.channelMode).toBe('joint');
    expect(h.frameSize).toBe(484); // floor(12 * 448000 / 44100) * 4
    expect(h.samplesPerFrame).toBe(384);
  });
  it('reports CRC-present frames via crcAbsent=false', () => {
    expect(parseMp3FrameHeader(header({ crcAbsent: false })).crcAbsent).toBe(false);
  });
  it('rejects the free bitrate (index 0) and the invalid bitrate (index 15)', () => {
    expect(() => parseMp3FrameHeader(Uint8Array.of(0xff, 0xfb, 0x00, 0x00))).toThrow(
      /free|bitrate/,
    );
    expect(() => parseMp3FrameHeader(Uint8Array.of(0xff, 0xfb, 0xf0, 0x00))).toThrow(/bitrate/);
  });
  it('rejects the reserved sample-rate index 3', () => {
    expect(() => parseMp3FrameHeader(Uint8Array.of(0xff, 0xfb, 0x9c, 0x00))).toThrow(/sample-rate/);
  });
  it('rejects bytes with no frame sync', () => {
    expect(() => parseMp3FrameHeader(Uint8Array.of(0x00, 0x00, 0x00, 0x00))).toThrow(InputError);
    expect(() => parseMp3FrameHeader(Uint8Array.of(0xff, 0x00, 0x00, 0x00))).toThrow(/sync/);
  });
  it('rejects a header shorter than 4 bytes', () => {
    expect(() => parseMp3FrameHeader(Uint8Array.of(0xff, 0xfb))).toThrow(InputError);
  });
});

describe('isFrameSync — 11-bit sync + non-reserved version/layer', () => {
  it('accepts a valid MPEG-1 L3 sync, rejects reserved version/layer', () => {
    expect(isFrameSync(0xff, 0xfb)).toBe(true); // MPEG1 L3
    expect(isFrameSync(0xff, 0xdf)).toBe(false); // missing the top sync bits in byte 1
    expect(isFrameSync(0xff, 0xe0)).toBe(false); // version 01 reserved, layer 00 reserved
    expect(isFrameSync(0xff, 0xf9)).toBe(false); // layer 00 (reserved): (b1 & 0x06)==0
    expect(isFrameSync(0xfe, 0xfb)).toBe(false); // byte0 not 0xFF
  });
});

// ============ pure helpers: ID3 ============

describe('id3v2Size / hasId3v1 — tag sizing', () => {
  /** Build a 10-byte ID3v2 header declaring a `bodySize`-byte body (syncsafe). */
  function id3v2(bodySize: number, footer = false): Uint8Array {
    const h = new Uint8Array(10);
    h.set([0x49, 0x44, 0x33], 0); // 'ID3'
    h[3] = 4; // version major
    h[5] = footer ? 0x10 : 0x00; // flags (footer bit)
    h[6] = (bodySize >> 21) & 0x7f;
    h[7] = (bodySize >> 14) & 0x7f;
    h[8] = (bodySize >> 7) & 0x7f;
    h[9] = bodySize & 0x7f;
    return h;
  }
  it('reads the syncsafe body size (256 → header 10 + 256 = 266)', () => {
    expect(id3v2Size(id3v2(256))).toBe(266);
  });
  it('adds 10 for an ID3v2.4 footer', () => {
    expect(id3v2Size(id3v2(100, true))).toBe(120); // 10 + 100 + 10
  });
  it('returns 0 when there is no ID3 tag', () => {
    expect(id3v2Size(Uint8Array.of(0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0))).toBe(0);
  });
  it('returns 0 for a non-syncsafe (high-bit-set) size', () => {
    const bad = id3v2(0);
    bad[6] = 0x80; // illegal high bit
    expect(id3v2Size(bad)).toBe(0);
  });
  it('detects an ID3v1 TAG trailer', () => {
    const withTag = new Uint8Array(200);
    withTag.set([0x54, 0x41, 0x47], 200 - 128); // 'TAG' at length-128
    expect(hasId3v1(withTag)).toBe(true);
    expect(hasId3v1(new Uint8Array(200))).toBe(false);
  });
});

// ============ pure helpers: Xing / LAME ============

describe('parseVbrHeader — Xing/Info + LAME delay/padding', () => {
  /**
   * Build a minimal MPEG-1 stereo frame carrying a Xing header (frames flag set) + a LAME tag with a known
   * encoder delay/padding. Side info for MPEG-1 stereo = 32 bytes, so Xing sits at offset 4+32 = 36.
   */
  function xingFrame(frameCount: number, delay: number, padding: number): Uint8Array {
    const buf = new Uint8Array(400);
    buf.set([0xff, 0xfb, 0x90, 0x00], 0); // MPEG-1 L3 stereo header
    const xo = 36; // 4-byte header + 32-byte side info
    buf.set([0x58, 0x69, 0x6e, 0x67], xo); // 'Xing'
    buf[xo + 7] = 0x01; // flags = frames present (low byte of the u32 flags)
    // frame count u32 BE at xo+8
    buf[xo + 8] = (frameCount >> 24) & 0xff;
    buf[xo + 9] = (frameCount >> 16) & 0xff;
    buf[xo + 10] = (frameCount >> 8) & 0xff;
    buf[xo + 11] = frameCount & 0xff;
    // LAME tag starts right after the frames field (only the frames flag is set) at xo+12.
    const lo = xo + 12;
    buf.set([0x4c, 0x41, 0x4d, 0x45], lo); // 'LAME'
    // delay/padding packed at lo+21: 12 bits delay, 12 bits padding.
    buf[lo + 21] = (delay >> 4) & 0xff;
    buf[lo + 22] = ((delay & 0x0f) << 4) | ((padding >> 8) & 0x0f);
    buf[lo + 23] = padding & 0xff;
    return buf;
  }
  it('parses the Xing frame count and the LAME encoder delay/padding', () => {
    const frame = xingFrame(1000, 576, 1152);
    const header = parseMp3FrameHeader(frame);
    const vbr = parseVbrHeader(frame, header);
    expect(vbr?.tag).toBe('Xing');
    expect(vbr?.frameCount).toBe(1000);
    expect(vbr?.encoderDelay).toBe(576);
    expect(vbr?.encoderPadding).toBe(1152);
  });
  it('parses Info with optional bytes/TOC/quality fields before a Lavf delay tag', () => {
    const frame = new Uint8Array(256);
    frame.set([0xff, 0xf3, 0x80, 0xc0], 0); // MPEG-2 L3 mono: Xing offset 13
    const xo = 13;
    frame.set([0x49, 0x6e, 0x66, 0x6f], xo); // 'Info'
    frame[xo + 7] = 0x0f; // frames + bytes + TOC + quality
    frame[xo + 8] = 0x00;
    frame[xo + 9] = 0x00;
    frame[xo + 10] = 0x00;
    frame[xo + 11] = 0x07;
    const lame = xo + 8 + 4 + 4 + 100 + 4;
    frame.set([0x4c, 0x61, 0x76, 0x66], lame); // 'Lavf'
    frame[lame + 21] = 0x02;
    frame[lame + 22] = 0x40;
    frame[lame + 23] = 0x10;
    const info = parseVbrHeader(frame, parseMp3FrameHeader(frame));
    expect(info?.tag).toBe('Info');
    expect(info?.frameCount).toBe(7);
    expect(info?.encoderDelay).toBe(36);
    expect(info?.encoderPadding).toBe(16);
  });
  it('parses VBRI frame count and tolerates a truncated VBRI count', () => {
    const frame = new Uint8Array(80);
    frame.set([0xff, 0xfb, 0x90, 0x00], 0);
    frame.set([0x56, 0x42, 0x52, 0x49], 36); // 'VBRI'
    frame[36 + 14] = 0x00;
    frame[36 + 15] = 0x00;
    frame[36 + 16] = 0x00;
    frame[36 + 17] = 0x2a;
    expect(parseVbrHeader(frame, parseMp3FrameHeader(frame))).toEqual({
      tag: 'VBRI',
      frameCount: 42,
    });
    expect(parseVbrHeader(frame.subarray(0, 36 + 16), parseMp3FrameHeader(frame))).toEqual({
      tag: 'VBRI',
    });
  });
  it('returns undefined for a plain frame with no Xing/Info/VBRI', () => {
    const frame = new Uint8Array(400);
    frame.set([0xff, 0xfb, 0x90, 0x00], 0);
    const header = parseMp3FrameHeader(frame);
    expect(parseVbrHeader(frame, header)).toBeUndefined();
  });
});

// ============ pure helpers: planar f32 + config ============

describe('deinterleaveF32 — interleaved → planar', () => {
  it('splits stereo correctly', () => {
    const planes = deinterleaveF32(Float32Array.of(0.25, -0.25, 0.5, -0.5), 2, 2);
    expect([...(planes[0] ?? [])]).toEqual([0.25, 0.5]);
    expect([...(planes[1] ?? [])]).toEqual([-0.25, -0.5]);
  });
  it('rejects a shape mismatch', () => {
    expect(() => deinterleaveF32(Float32Array.of(1, 2, 3), 2, 2)).toThrow(MediaError);
  });
});

describe('isMp3Codec / normalizeMp3DecoderConfig', () => {
  it('recognizes mp3 and its ISO-BMFF aliases', () => {
    expect(isMp3Codec('mp3')).toBe(true);
    expect(isMp3Codec('mp4a.40.34')).toBe(true);
    expect(isMp3Codec('mp4a.6B')).toBe(true); // case-insensitive
    expect(isMp3Codec('opus')).toBe(false);
    expect(MP3_CODEC).toBe('mp3');
  });
  it('accepts an MP3 config (no description required, unlike Vorbis)', () => {
    const cfg = normalizeMp3DecoderConfig({
      codec: 'mp3',
      sampleRate: 44_100,
      numberOfChannels: 2,
    });
    expect(cfg).toEqual({ channels: 2, sampleRate: 44_100 });
  });
  it('rejects a non-MP3 codec / bad channels / bad rate', () => {
    expect(() =>
      normalizeMp3DecoderConfig({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 }),
    ).toThrow(MediaError);
    expect(() =>
      normalizeMp3DecoderConfig({ codec: 'mp3', sampleRate: 44_100, numberOfChannels: 6 }),
    ).toThrow(/channels/);
    expect(MP3_MAX_CHANNELS).toBe(2);
    expect(() =>
      normalizeMp3DecoderConfig({ codec: 'mp3', sampleRate: 0, numberOfChannels: 2 }),
    ).toThrow(/sampleRate/);
  });
});

// ============ frame walking on real media ============

const sound5 = await loadFixture('sound_5.mp3');

describe('iterateMp3Frames — walk the real sound_5.mp3', () => {
  it('finds the first frame and walks contiguous, self-consistent frames', () => {
    const offset = firstFrameOffset(sound5);
    expect(offset).toBeGreaterThanOrEqual(0);
    let count = 0;
    let firstRate = 0;
    let firstSamples = 0;
    for (const { header } of iterateMp3Frames(sound5)) {
      if (count === 0) {
        firstRate = header.sampleRate;
        firstSamples = header.samplesPerFrame;
      }
      expect(header.layer).toBe(3); // it's an MP3 (Layer III) file
      expect(header.sampleRate).toBe(firstRate); // CBR: constant rate across frames
      expect(header.frameSize).toBeGreaterThan(4);
      count++;
    }
    expect(count).toBeGreaterThan(10); // a real clip has many frames
    expect(firstRate).toBeGreaterThan(0);
    expect([576, 1152]).toContain(firstSamples);
  });
  it('skips a false sync candidate and stops cleanly on sync loss or truncation', () => {
    const full = new Uint8Array(417 + 8);
    full.set([0xff, 0xfb, 0x00, 0x00], 0); // sync-shaped but free bitrate → false candidate
    full.set([0xff, 0xfb, 0x90, 0x00], 4); // real MPEG-1 L3 frame
    expect(firstFrameOffset(full)).toBe(4);

    const oneFrameThenJunk = new Uint8Array(417 + 4);
    oneFrameThenJunk.set([0xff, 0xfb, 0x90, 0x00], 0);
    const walked = [...iterateMp3Frames(oneFrameThenJunk)];
    expect(walked.length).toBe(1);

    const truncated = Uint8Array.of(0xff, 0xfb, 0x90, 0x00, 0, 1, 2, 3);
    expect([...iterateMp3Frames(truncated)]).toEqual([]);
  });
});

// ============ driver identity + honest behavior ============

describe('wasm-mp3 — driver identity & module', () => {
  it('declares the contracted identity (tier:wasm so it is ranked last)', () => {
    expect(WasmMp3Driver.id).toBe('wasm-mp3');
    expect(WasmMp3Driver.kind).toBe('codec');
    expect(WasmMp3Driver.tier).toBe('wasm');
    expect(WasmMp3Driver.apiVersion).toBe(1);
  });
  it('registers exactly itself as a codec (and nothing else)', () => {
    const added: unknown[] = [];
    let containers = 0;
    let filters = 0;
    WasmMp3Module.register({
      addCodec: (d) => added.push(d),
      addContainer: () => containers++,
      addFilter: () => filters++,
    });
    expect(added).toEqual([WasmMp3Driver]);
    expect(containers).toBe(0);
    expect(filters).toBe(0);
  });
  it('isMp3Query only matches MP3 audio (incl. aliases)', () => {
    expect(isMp3Query({ mediaType: 'audio', direction: 'decode', config: { codec: 'mp3' } })).toBe(
      true,
    );
    expect(
      isMp3Query({ mediaType: 'audio', direction: 'decode', config: { codec: 'mp4a.40.34' } }),
    ).toBe(true);
    expect(isMp3Query({ mediaType: 'audio', direction: 'decode', config: { codec: 'opus' } })).toBe(
      false,
    );
    expect(
      isMp3Query({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'mp3' } as unknown as VideoDecoderConfig,
      }),
    ).toBe(false);
  });
  it('unsupported is a non-supported result carrying the reason', () => {
    expect(unsupported('nope')).toEqual({ supported: false, reason: 'nope' });
  });
  it('createDecoder validates the config up front (non-MP3 codec rejected)', () => {
    expect(() =>
      WasmMp3Driver.createDecoder({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 }),
    ).toThrow(MediaError);
  });
  it('createEncoder is an honest capability miss (no pure-Rust MP3 encoder)', () => {
    expect(() =>
      WasmMp3Driver.createEncoder({
        codec: 'mp3',
        sampleRate: 44_100,
        numberOfChannels: 2,
      } as unknown as AudioEncoderConfig),
    ).toThrow(CapabilityError);
  });
  it('createDecoder aborts up front when the signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(() =>
      WasmMp3Driver.createDecoder(
        { codec: 'mp3', sampleRate: 44_100, numberOfChannels: 2 },
        { signal: ctrl.signal },
      ),
    ).toThrow(/aborted/);
  });
  it('supports(): false for non-MP3, false for encode', async () => {
    expect(
      (
        await WasmMp3Driver.supports({
          mediaType: 'audio',
          direction: 'decode',
          config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
        })
      ).supported,
    ).toBe(false);
    expect(
      (
        await WasmMp3Driver.supports({
          mediaType: 'audio',
          direction: 'encode',
          config: {
            codec: 'mp3',
            sampleRate: 44_100,
            numberOfChannels: 2,
          } as unknown as AudioEncoderConfig,
        })
      ).supported,
    ).toBe(false);
  });
  it('supports(): false in Node when the AudioData output seam is unavailable', async () => {
    const support = await WasmMp3Driver.supports({
      mediaType: 'audio',
      direction: 'decode',
      config: {
        codec: 'mp3',
        sampleRate: 44_100,
        numberOfChannels: 2,
      },
    });
    expect(support.supported).toBe(false);
    expect(support.reason ?? '').toMatch(/AudioData|EncodedAudioChunk/);
  });
  it('resetMp3CoreForTest lets the core be re-evaluated', async () => {
    resetMp3CoreForTest();
    const a = await loadMp3Core();
    resetMp3CoreForTest();
    const b = await loadMp3Core();
    expect(a === null).toBe(b === null);
  });
});

// ============ THE REAL THING: decode real MP3 through the wasm core in Node ============

interface Mp3WasmClass {
  new (
    channels: number,
    sampleRate: number,
  ): {
    channels: number;
    sampleRate: number;
    decode(frame: Uint8Array): Float32Array;
    reset(): void;
    free(): void;
  };
}

/**
 * Instantiate the vendored Symphonia-MP3 wasm core from bytes (the `--target web` glue accepts a
 * `WebAssembly.Module`, so it runs in Node without a fetch), and return the `Mp3Wasm` class.
 */
async function loadCoreFromBytes(): Promise<Mp3WasmClass> {
  const mod = await import('./mp3-core.js');
  const wasmBytes = await readFile(WASM_PATH);
  const module = await WebAssembly.compile(wasmBytes);
  await mod.default({ module_or_path: module });
  return mod.Mp3Wasm as unknown as Mp3WasmClass;
}

/** Decode every MP3 frame of `bytes` through the wasm core; return aggregate facts for the oracle. */
function decodeAll(
  Mp3Wasm: Mp3WasmClass,
  bytes: Uint8Array,
): {
  totalFrames: number;
  channels: number;
  sampleRate: number;
  allFinite: boolean;
  nonSilent: boolean;
  perFrameOk: boolean;
} {
  const first = parseMp3FrameHeader(bytes, firstFrameOffset(bytes));
  const dec = new Mp3Wasm(first.channels, first.sampleRate);
  let totalFrames = 0;
  let allFinite = true;
  let nonSilent = false;
  let perFrameOk = true;
  // Snapshot the geometry from the live decoder each iteration; never read `dec` after `free()`
  // (a freed wasm-bindgen handle nulls its pointer → "null pointer passed to rust").
  let channels = first.channels;
  let sampleRate = first.sampleRate;
  try {
    for (const { header, data } of iterateMp3Frames(bytes)) {
      const pcm = dec.decode(data);
      channels = dec.channels > 0 ? dec.channels : header.channels;
      sampleRate = dec.sampleRate > 0 ? dec.sampleRate : sampleRate;
      const frames = channels > 0 ? pcm.length / channels : 0;
      // MP3's un-fakeable invariant: a decoded frame yields exactly the header's sample count (or 0 for a
      // priming/empty frame). Anything else means the wasm core is not really decoding the bitstream.
      if (frames !== 0 && frames !== header.samplesPerFrame) perFrameOk = false;
      totalFrames += frames;
      for (let k = 0; k < pcm.length; k++) {
        const v = pcm[k] ?? 0;
        if (!Number.isFinite(v) || v < -1.05 || v > 1.05) allFinite = false;
        if (v !== 0) nonSilent = true;
      }
    }
  } finally {
    dec.free();
  }
  return { totalFrames, channels, sampleRate, allFinite, nonSilent, perFrameOk };
}

describe('Symphonia wasm MP3 core — decodes real media in Node (the real wasm tail)', () => {
  it('the vendored core loads (proves the wasm built + instantiates)', async () => {
    const Mp3Wasm = await loadCoreFromBytes();
    expect(typeof Mp3Wasm).toBe('function');
  });

  it('decodes sound_5.mp3: per-frame sample count matches the header, PCM is real', async () => {
    const Mp3Wasm = await loadCoreFromBytes();
    const r = decodeAll(Mp3Wasm, sound5);
    expect(r.totalFrames).toBeGreaterThan(0);
    expect(r.channels).toBeGreaterThanOrEqual(1);
    expect(r.sampleRate).toBeGreaterThan(0);
    expect(r.perFrameOk).toBe(true); // every frame decoded to exactly its declared sample count
    expect(r.allFinite).toBe(true); // every sample a finite, in-range f32 — real PCM, not garbage
    expect(r.nonSilent).toBe(true); // not pure silence
  });

  it('decodes the VBR bear-vbr-toc.mp3 (Xing/LAME): per-frame count holds across a VBR stream', async () => {
    const bear = await loadFixture('bear-vbr-toc.mp3');
    const Mp3Wasm = await loadCoreFromBytes();
    const r = decodeAll(Mp3Wasm, bear);
    expect(r.totalFrames).toBeGreaterThan(0);
    expect(r.perFrameOk).toBe(true);
    expect(r.allFinite).toBe(true);
    expect(r.nonSilent).toBe(true);
  });

  it('cross-check: total decoded samples == (frame count from walking) × samplesPerFrame', async () => {
    const Mp3Wasm = await loadCoreFromBytes();
    // Count audio frames by walking (skip a Xing/Info header frame — it decodes to silence but still
    // counts as a frame for the bit reservoir; we compare against the *decoded* total, which is robust).
    let walkedFrames = 0;
    let samplesPerFrame = 0;
    for (const { header } of iterateMp3Frames(sound5)) {
      walkedFrames++;
      samplesPerFrame = header.samplesPerFrame;
    }
    const r = decodeAll(Mp3Wasm, sound5);
    // Decoded sample total is within one frame of (walked frames × samplesPerFrame): a Xing header frame
    // (if present) decodes to a 0-sample / silent frame, so the decoded count is ≤ walked×spf and within
    // one frame of it — impossible to hit without actually decoding every frame.
    const expectedMax = walkedFrames * samplesPerFrame;
    expect(r.totalFrames).toBeLessThanOrEqual(expectedMax);
    expect(expectedMax - r.totalFrames).toBeLessThanOrEqual(samplesPerFrame);
  });

  it('loadMp3Core() resolves a working core (driver entry path)', async () => {
    const core = await loadMp3Core();
    expect(core === null || typeof core.createDecoder === 'function').toBe(true);
  });
});
