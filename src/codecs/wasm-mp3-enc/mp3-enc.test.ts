/**
 * Tests for the WASM MP3 **encoder** tail. Two layers (BUILD §6, and the same shape as `wasm-mp3`'s):
 *
 *  1. **Pure helpers in Node** — the MPEG output-rate/bitrate legality tables, config normalisation, the
 *     20-byte `enc_init` parameter block, planar validation, sample→µs timing, and the frame splitter.
 *     Each assertion is falsifiable against ISO/IEC 11172-3 / 13818-3 or against the measured behaviour of
 *     the vendored core (BUILD.md "Measured legality"), and the splitter is fuzzed with randomised run
 *     boundaries so it cannot be right only for the shapes LAME happens to emit today.
 *  2. **The REAL vendored LAME core, encoding real PCM in Node.** The inlined `mp3-enc-wasm.js` carrier is instantiated
 *     from bytes via `WebAssembly.compile` and fed synthetic tones and the real WAV fixtures. We gate on
 *     MP3's own un-fakeable invariants: every emitted chunk begins with a valid MPEG sync word, the parsed
 *     header's sample rate / layer / channel mode match what was requested, the frame count matches the
 *     input duration, and the total byte count matches the requested bitrate. Then the bitstream is
 *     **decoded back** by the independent `wasm-mp3` Symphonia core and the PCM is checked for length,
 *     finiteness, range, and non-silence — a round trip neither half can fake alone.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { CodecDriver, Registry } from '../../contracts/driver.ts';
import { MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES } from '../../drivers/mp3/mp3-gapless.ts';
import { readWavPcm } from '../../drivers/wav/pcm.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  firstFrameOffset,
  isFrameSync,
  iterateMp3Frames,
  parseMp3FrameHeader,
} from '../wasm-mp3/mp3.ts';
import type { Mp3EncWasmCore, Mp3EncoderInit } from './mp3-enc.ts';
import {
  MP3_CODEC,
  MP3_DEFAULT_VBR_QUALITY,
  MP3_ENCODER_LEAD_IN_SAMPLES,
  MP3_ENC_PARAMS_BYTES,
  MP3_SAMPLE_RATES,
  MP3_VBR_QUALITY_MAX,
  Mp3FrameSplitter,
  buildMp3EncoderParams,
  errMessage,
  isMp3SampleRate,
  mp3CbrBitratesKbps,
  mp3SamplesPerFrame,
  normalizeMp3EncoderConfig,
  samplesToMicros,
  snapMp3BitrateKbps,
  validateMp3Planes,
} from './mp3-enc.ts';
import WasmMp3EncoderModule, {
  WasmMp3EncoderDriver,
  isMp3EncodeQuery,
  loadMp3EncCore,
  resetMp3EncCoreForTest,
  unsupported,
} from './wasm-mp3-enc-driver.ts';

const ENC_WASM_PATH = new URL('./mp3_enc_wasm_bg.wasm', import.meta.url).pathname;
const ENC_WASM_PATH_FOR_FALLBACK = new URL('./mp3_enc_wasm_bg.wasm', import.meta.url).pathname;
const DEC_WASM_PATH = new URL('../wasm-mp3/mp3_wasm_bg.wasm', import.meta.url).pathname;

/** A tiny deterministic PRNG so the randomised sweeps below are reproducible on failure. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function cfg(over: Partial<AudioEncoderConfig> = {}): AudioEncoderConfig {
  return { codec: MP3_CODEC, sampleRate: 44100, numberOfChannels: 2, ...over };
}

// ============ pure helpers: output legality tables ============

describe('MPEG Layer III output legality', () => {
  it('accepts exactly the nine frame-header sample rates', () => {
    expect([...MP3_SAMPLE_RATES]).toEqual([
      8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000,
    ]);
    for (const rate of MP3_SAMPLE_RATES) expect(isMp3SampleRate(rate)).toBe(true);
    const legal = new Set(MP3_SAMPLE_RATES);
    const random = rng(0x5eed);
    for (let i = 0; i < 2000; i++) {
      const candidate = Math.floor(random() * 96_001);
      expect(isMp3SampleRate(candidate)).toBe(legal.has(candidate));
    }
    for (const bogus of [
      0,
      -44100,
      1,
      44_099,
      44_101,
      96_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(isMp3SampleRate(bogus)).toBe(false);
  });

  it('reports 1152 samples per MPEG-1 frame and 576 per MPEG-2/2.5 frame', () => {
    for (const rate of [32_000, 44_100, 48_000]) expect(mp3SamplesPerFrame(rate)).toBe(1152);
    for (const rate of [8000, 11_025, 12_000, 16_000, 22_050, 24_000])
      expect(mp3SamplesPerFrame(rate)).toBe(576);
  });

  it('exposes the measured per-version constant-bitrate tables', () => {
    for (const rate of [32_000, 44_100, 48_000]) {
      expect([...mp3CbrBitratesKbps(rate)]).toEqual([
        32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
      ]);
    }
    for (const rate of [16_000, 22_050, 24_000]) {
      expect([...mp3CbrBitratesKbps(rate)]).toEqual([
        8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
      ]);
    }
    for (const rate of [8000, 11_025, 12_000]) {
      expect([...mp3CbrBitratesKbps(rate)]).toEqual([8, 16, 24, 32, 40, 48, 56, 64]);
    }
    expect([...mp3CbrBitratesKbps(4000)]).toEqual([]);
  });
});

describe('snapMp3BitrateKbps', () => {
  it('is the identity on every legal bitrate at every legal rate', () => {
    for (const rate of MP3_SAMPLE_RATES) {
      for (const kbps of mp3CbrBitratesKbps(rate)) {
        expect(snapMp3BitrateKbps(kbps * 1000, rate)).toBe(kbps);
      }
    }
  });

  it('clamps beyond both ends of the per-version table', () => {
    expect(snapMp3BitrateKbps(1, 44_100)).toBe(32);
    expect(snapMp3BitrateKbps(10_000_000, 44_100)).toBe(320);
    expect(snapMp3BitrateKbps(1, 22_050)).toBe(8);
    expect(snapMp3BitrateKbps(10_000_000, 22_050)).toBe(160);
    expect(snapMp3BitrateKbps(10_000_000, 8000)).toBe(64);
  });

  it('picks the nearest legal value and breaks exact ties upward', () => {
    expect(snapMp3BitrateKbps(130_000, 44_100)).toBe(128);
    expect(snapMp3BitrateKbps(150_000, 44_100)).toBe(160);
    expect(snapMp3BitrateKbps(143_000, 44_100)).toBe(128);
    expect(snapMp3BitrateKbps(145_000, 44_100)).toBe(160);
    // 144 kbps is MPEG-2-only, so at 44.1 kHz it is the exact midpoint of 128/160 — the tie goes up.
    expect(snapMp3BitrateKbps(144_000, 44_100)).toBe(160);
    expect(snapMp3BitrateKbps(144_000, 22_050)).toBe(144); // …and is itself legal for MPEG-2
    expect(snapMp3BitrateKbps(36_000, 44_100)).toBe(40); // exact midpoint of 32/40 → upward
  });

  it('always returns a table member that is the nearest one (randomised)', () => {
    const random = rng(0xc0ffee);
    for (const rate of MP3_SAMPLE_RATES) {
      const table = mp3CbrBitratesKbps(rate);
      for (let i = 0; i < 400; i++) {
        const bps = random() * 400_000;
        const snapped = snapMp3BitrateKbps(bps, rate);
        expect(table).toContain(snapped);
        const best = Math.min(...table.map((k) => Math.abs(k - bps / 1000)));
        expect(Math.abs(snapped - bps / 1000)).toBeCloseTo(best, 9);
      }
    }
  });

  it('refuses a sample rate with no bitrate table', () => {
    expect(() => snapMp3BitrateKbps(128_000, 4000)).toThrow(/no constant bitrate table/);
  });
});

// ============ pure helpers: config normalisation ============

describe('normalizeMp3EncoderConfig', () => {
  it('selects CBR from a bitrate hint and pins the output sample rate', () => {
    expect(normalizeMp3EncoderConfig(cfg({ bitrate: 128_000 }))).toEqual({
      channels: 2,
      sampleRate: 44_100,
      cbrBitrateKbps: 128,
      vbrQuality: -1,
      outputSampleRate: 44_100,
    });
    // A hint LAME would otherwise honour by silently downsampling is snapped, not resampled.
    expect(normalizeMp3EncoderConfig(cfg({ bitrate: 56_000 }))).toEqual({
      channels: 2,
      sampleRate: 44_100,
      cbrBitrateKbps: 56,
      vbrQuality: -1,
      outputSampleRate: 44_100,
    });
  });

  it('selects VBR at LAME defaults when no usable bitrate is given', () => {
    for (const bitrate of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const config = { ...cfg(), ...(bitrate === undefined ? {} : { bitrate }) };
      expect(normalizeMp3EncoderConfig(config)).toEqual({
        channels: 2,
        sampleRate: 44_100,
        cbrBitrateKbps: 0,
        vbrQuality: MP3_DEFAULT_VBR_QUALITY,
        outputSampleRate: 44_100,
      });
    }
  });

  it('honours an in-range mp3.vbrQuality and falls back outside it', () => {
    const withQuality = (vbrQuality: unknown): number =>
      normalizeMp3EncoderConfig({ ...cfg(), mp3: { vbrQuality } } as AudioEncoderConfig).vbrQuality;
    for (const q of [0, 0.5, 2, 4, 7, 9, 9.999]) expect(withQuality(q)).toBe(q);
    for (const q of [-0.1, MP3_VBR_QUALITY_MAX, 10.5, Number.NaN, undefined])
      expect(withQuality(q)).toBe(MP3_DEFAULT_VBR_QUALITY);
    // A bitrate always wins: VBR quality is only consulted when no CBR was requested.
    expect(
      normalizeMp3EncoderConfig({
        ...cfg({ bitrate: 192_000 }),
        mp3: { vbrQuality: 0 },
      } as AudioEncoderConfig).vbrQuality,
    ).toBe(-1);
  });

  it('accepts every MP3 codec alias and rejects other codecs', () => {
    for (const codec of ['mp3', 'MP3', 'mp4a.6b', 'mp4a.69', 'mp4a.40.34'])
      expect(normalizeMp3EncoderConfig(cfg({ codec })).sampleRate).toBe(44_100);
    for (const codec of ['opus', 'vorbis', 'mp4a.40.2', 'flac', ''])
      expect(() => normalizeMp3EncoderConfig(cfg({ codec }))).toThrow(/cannot encode codec/);
  });

  it('rejects a sample rate MPEG Layer III cannot encode', () => {
    for (const sampleRate of [0, -44_100, 1, 44_099, 96_000, Number.NaN])
      expect(() => normalizeMp3EncoderConfig(cfg({ sampleRate }))).toThrow(
        /no MPEG Layer III representation/,
      );
    for (const sampleRate of MP3_SAMPLE_RATES)
      expect(normalizeMp3EncoderConfig(cfg({ sampleRate })).outputSampleRate).toBe(sampleRate);
  });

  it('rejects a channel count MP3 cannot carry', () => {
    for (const numberOfChannels of [0, -1, 3, 6, 1.5, Number.NaN])
      expect(() => normalizeMp3EncoderConfig(cfg({ numberOfChannels }))).toThrow(
        /supports 1-2 channels/,
      );
    for (const numberOfChannels of [1, 2])
      expect(normalizeMp3EncoderConfig(cfg({ numberOfChannels })).channels).toBe(numberOfChannels);
  });
});

// ============ pure helpers: the enc_init parameter block ============

describe('buildMp3EncoderParams', () => {
  function read(init: Mp3EncoderInit): readonly number[] {
    const bytes = buildMp3EncoderParams(init);
    expect(bytes.byteLength).toBe(MP3_ENC_PARAMS_BYTES);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return [
      view.getInt32(0, true),
      view.getInt32(4, true),
      view.getInt32(8, true),
      view.getFloat32(12, true),
      view.getInt32(16, true),
    ];
  }

  it('lays the five fields out little-endian with vbrQuality as a float32', () => {
    expect(read(normalizeMp3EncoderConfig(cfg({ bitrate: 192_000 })))).toEqual([
      2, 44_100, 192, -1, 44_100,
    ]);
    expect(
      read(normalizeMp3EncoderConfig(cfg({ sampleRate: 22_050, numberOfChannels: 1 }))),
    ).toEqual([1, 22_050, 0, MP3_DEFAULT_VBR_QUALITY, 22_050]);
    // The float32 slot is a genuine float, not a truncated int (0.5 would vanish under setInt32).
    const half = { ...normalizeMp3EncoderConfig(cfg()), vbrQuality: 6.5 };
    expect(read(half)[3]).toBe(6.5);
  });

  it('encodes the exact golden bytes for the canonical 44.1 kHz stereo 128 kbps CBR init', () => {
    const bytes = buildMp3EncoderParams(normalizeMp3EncoderConfig(cfg({ bitrate: 128_000 })));
    expect([...bytes]).toEqual([
      0x02,
      0,
      0,
      0, // channels = 2
      0x44,
      0xac,
      0,
      0, // sampleRate = 44100
      0x80,
      0,
      0,
      0, // cbrBitrateKbps = 128
      0,
      0,
      0x80,
      0xbf, // vbrQuality = -1.0f
      0x44,
      0xac,
      0,
      0, // outputSampleRate = 44100
    ]);
  });

  it('round-trips every normalised config in the legality matrix', () => {
    for (const sampleRate of MP3_SAMPLE_RATES) {
      for (const channels of [1, 2]) {
        for (const kbps of mp3CbrBitratesKbps(sampleRate)) {
          const init = normalizeMp3EncoderConfig(
            cfg({ sampleRate, numberOfChannels: channels, bitrate: kbps * 1000 }),
          );
          expect(read(init)).toEqual([channels, sampleRate, kbps, -1, sampleRate]);
        }
      }
    }
  });
});

// ============ pure helpers: planar input, timing, error messages ============

describe('validateMp3Planes / samplesToMicros / errMessage', () => {
  it('accepts exactly channels × frames planar buffers', () => {
    expect(() => validateMp3Planes([new Float32Array(4), new Float32Array(4)], 4, 2)).not.toThrow();
    expect(() => validateMp3Planes([], 0, 0)).not.toThrow();
  });

  it('rejects a wrong plane count, a wrong plane length, or a bogus frame count', () => {
    expect(() => validateMp3Planes([new Float32Array(4)], 4, 2)).toThrow(/expected 2 planar/);
    expect(() => validateMp3Planes([new Float32Array(4), new Float32Array(3)], 4, 2)).toThrow(
      /plane 1 is not 4 frames/,
    );
    expect(() => validateMp3Planes([new Float32Array(4)], -1, 1)).toThrow(/invalid frame count/);
    expect(() => validateMp3Planes([new Float32Array(4)], 1.5, 1)).toThrow(/invalid frame count/);
  });

  it('converts sample offsets to microseconds', () => {
    expect(samplesToMicros(0, 44_100)).toBe(0);
    expect(samplesToMicros(44_100, 44_100)).toBe(1_000_000);
    expect(samplesToMicros(1152, 44_100)).toBe(26_122);
    expect(samplesToMicros(576, 22_050)).toBe(26_122);
  });

  it('extracts a message from anything thrown', () => {
    expect(errMessage('plain')).toBe('plain');
    expect(errMessage(new Error('wrapped'))).toBe('wrapped');
    expect(errMessage({ cause: 'opaque' })).toBe('unknown error');
  });
});

// ============ pure helpers: the frame splitter ============

/** Build a syntactically valid MPEG-1 Layer III frame header + filler of the declared size. */
function syntheticFrame(bitrateIndex: number, fill: number): Uint8Array {
  const header = Uint8Array.of(0xff, 0xfb, (bitrateIndex << 4) | 0x00, 0xc4); // MPEG-1 L3, 44100, mono
  const size = parseMp3FrameHeader(header).frameSize;
  const frame = new Uint8Array(size).fill(fill);
  frame.set(header, 0);
  return frame;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('Mp3FrameSplitter', () => {
  const frames = [3, 9, 5, 14, 1].map((index, i) => syntheticFrame(index, 0x40 + i));

  it('re-frames a stream fed in one run', () => {
    const splitter = new Mp3FrameSplitter();
    const out = splitter.push(concat(frames));
    expect(out.map((f) => f.length)).toEqual(frames.map((f) => f.length));
    for (const [i, frame] of out.entries())
      expect([...frame]).toEqual([...(frames[i] as Uint8Array)]);
    expect(splitter.pendingBytes).toBe(0);
    expect(splitter.finish().length).toBe(0);
  });

  it('re-frames identically for any run boundary, including byte-at-a-time (randomised)', () => {
    const stream = concat(frames);
    const random = rng(0xf00d);
    for (let trial = 0; trial < 60; trial++) {
      const splitter = new Mp3FrameSplitter();
      const collected: Uint8Array[] = [];
      let offset = 0;
      while (offset < stream.length) {
        const size = trial === 0 ? 1 : 1 + Math.floor(random() * 700);
        collected.push(...splitter.push(stream.subarray(offset, offset + size)));
        offset += size;
      }
      expect(splitter.pendingBytes, `trial ${trial} left a partial frame`).toBe(0);
      expect(collected.length, `trial ${trial} frame count`).toBe(frames.length);
      expect(concat(collected)).toEqual(stream);
    }
  });

  it('resynchronises past leading garbage and past a false sync word', () => {
    const splitter = new Mp3FrameSplitter();
    // 0xFF 0xE8 has the 11 sync bits but the reserved layer `00`; 0xFF 0xFB 0xFC has bitrate index 15.
    const garbage = Uint8Array.of(0x00, 0x11, 0xff, 0xe8, 0x00, 0x00, 0xff, 0xfb, 0xfc, 0x00);
    const out = splitter.push(concat([garbage, frames[0] as Uint8Array]));
    expect(out.length).toBe(1);
    expect([...(out[0] as Uint8Array)]).toEqual([...(frames[0] as Uint8Array)]);
    expect(splitter.pendingBytes).toBe(0);
  });

  it('holds a truncated final frame back and surfaces it from finish()', () => {
    const splitter = new Mp3FrameSplitter();
    const whole = frames[0] as Uint8Array;
    expect(splitter.push(whole.subarray(0, whole.length - 3)).length).toBe(0);
    expect(splitter.pendingBytes).toBe(whole.length - 3);
    const leftover = splitter.finish();
    expect(leftover.length).toBe(whole.length - 3);
    expect(splitter.pendingBytes).toBe(0);
  });

  it('buffers a run too short to hold a header', () => {
    const splitter = new Mp3FrameSplitter();
    expect(splitter.push(Uint8Array.of(0xff, 0xfb)).length).toBe(0);
    expect(splitter.push(new Uint8Array(0)).length).toBe(0);
    expect(splitter.pendingBytes).toBe(2);
  });
});

// ============ driver surface (Node-checkable) ============

describe('wasm-mp3-enc driver surface', () => {
  it('identifies MP3 encode queries only', () => {
    expect(isMp3EncodeQuery({ mediaType: 'audio', direction: 'encode', config: cfg() })).toBe(true);
    expect(isMp3EncodeQuery({ mediaType: 'audio', direction: 'decode', config: cfg() })).toBe(
      false,
    );
    expect(isMp3EncodeQuery({ mediaType: 'video', direction: 'encode', config: cfg() })).toBe(
      false,
    );
    expect(
      isMp3EncodeQuery({
        mediaType: 'audio',
        direction: 'encode',
        config: cfg({ codec: 'opus' }),
      }),
    ).toBe(false);
  });

  it('reports an honest, non-throwing reason for everything it cannot serve', async () => {
    expect(unsupported('why')).toEqual({ supported: false, reason: 'why' });
    const reasons = await Promise.all(
      [
        { mediaType: 'video' as const, direction: 'encode' as const, config: cfg() },
        {
          mediaType: 'audio' as const,
          direction: 'encode' as const,
          config: cfg({ codec: 'aac' }),
        },
        { mediaType: 'audio' as const, direction: 'decode' as const, config: cfg() },
        {
          mediaType: 'audio' as const,
          direction: 'encode' as const,
          config: cfg({ sampleRate: 96_000 }),
        },
      ].map((q) => WasmMp3EncoderDriver.supports(q)),
    );
    for (const support of reasons) {
      expect(support.supported).toBe(false);
      expect(typeof support.reason).toBe('string');
    }
    expect(reasons[1]?.reason).toContain('MP3 only');
    expect(reasons[2]?.reason).toContain('encodes only');
    expect(reasons[3]?.reason).toContain('no MPEG Layer III representation');
    // Node has no AudioData/EncodedAudioChunk, so even a well-formed query is honestly unsupported.
    const wellFormed = await WasmMp3EncoderDriver.supports({
      mediaType: 'audio',
      direction: 'encode',
      config: cfg(),
    });
    expect(wellFormed.supported).toBe(false);
    expect(wellFormed.reason).toContain('WebCodecs');
  });

  it('is an encode-only wasm-tier driver that refuses decode', () => {
    expect(WasmMp3EncoderDriver.id).toBe('wasm-mp3-enc');
    expect(WasmMp3EncoderDriver.tier).toBe('wasm');
    expect(() =>
      WasmMp3EncoderDriver.createDecoder({
        codec: MP3_CODEC,
        sampleRate: 44_100,
        numberOfChannels: 2,
      }),
    ).toThrow(/encode-only/);
  });

  it('rejects an unencodable config before touching wasm', () => {
    expect(() => WasmMp3EncoderDriver.createEncoder(cfg({ sampleRate: 96_000 }))).toThrow(
      /no MPEG Layer III representation/,
    );
    expect(() =>
      WasmMp3EncoderDriver.createEncoder(cfg(), {
        signal: AbortSignal.abort(),
      }),
    ).toThrow(/aborted/);
  });

  it('registers itself into a registry through its module', () => {
    const added: string[] = [];
    WasmMp3EncoderModule.register({
      addCodec: (d: CodecDriver) => added.push(d.id),
      addContainer: () => {},
      addFilter: () => {},
    } as unknown as Registry);
    expect(added).toEqual(['wasm-mp3-enc']);
  });

  it('memoizes loadMp3EncCore() and resolves a working core', async () => {
    resetMp3EncCoreForTest();
    const [a, b] = await Promise.all([loadMp3EncCore(), loadMp3EncCore()]);
    expect(a).toBe(b);
    expect(a === null || typeof a.createEncoder === 'function').toBe(true);
  });
});

// ============ the real vendored LAME core ============

/**
 * Instantiate the vendored LAME core from bytes. The browser resolves the sibling
 * `mp3_enc_wasm_bg.wasm` through `new URL(..., import.meta.url)` and fetches it; Node has no fetch for a
 * `file:` URL, so the test compiles the very same committed artifact and hands the glue the resulting
 * `WebAssembly.Module` — the other init shape the loader supports. Same bytes, same ABI.
 */
async function loadEncoderCore(): Promise<Mp3EncWasmCore> {
  const mod = await import('./mp3-enc-core.js');
  await mod.default({ module_or_path: await WebAssembly.compile(await readFile(ENC_WASM_PATH)) });
  return mod.createMp3EncCore();
}

interface Mp3WasmDecoderClass {
  new (
    channels: number,
    sampleRate: number,
  ): { channels: number; sampleRate: number; decode(f: Uint8Array): Float32Array; free(): void };
}

/** Instantiate the independent Symphonia MP3 **decoder** core — the round-trip oracle. */
async function loadDecoderCore(): Promise<Mp3WasmDecoderClass> {
  const mod = await import('../wasm-mp3/mp3-core.js');
  await mod.default({ module_or_path: await WebAssembly.compile(await readFile(DEC_WASM_PATH)) });
  return mod.Mp3Wasm as unknown as Mp3WasmDecoderClass;
}

interface Pcm {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  readonly planes: readonly Float32Array[];
}

function tone(sampleRate: number, channels: number, seconds: number): Pcm {
  const frames = Math.round(sampleRate * seconds);
  const planes = Array.from({ length: channels }, (_unused, c) => {
    const plane = new Float32Array(frames);
    const f = 440 + 110 * c;
    for (let i = 0; i < frames; i++) {
      const t = (2 * Math.PI * i) / sampleRate;
      plane[i] = 0.35 * Math.sin(f * t) + 0.18 * Math.sin(2 * f * t) + 0.09 * Math.sin(3 * f * t);
    }
    return plane;
  });
  return { sampleRate, channels, frames, planes };
}

async function wavPcm(id: string, maxChannels = 2): Promise<Pcm> {
  const wav = readWavPcm(await loadFixture(id));
  const channels = Math.min(wav.channels, maxChannels);
  const planes = Array.from({ length: channels }, (_unused, c) => {
    const plane = new Float32Array(wav.frames);
    plane.set((wav.planar[c] ?? new Float32Array(wav.frames)).subarray(0, wav.frames));
    return plane;
  });
  return { sampleRate: wav.sampleRate, channels, frames: wav.frames, planes };
}

interface EncodeResult {
  readonly frames: readonly Uint8Array[];
  readonly bytes: Uint8Array;
  readonly pending: number;
}

/**
 * Encode `pcm` with the real core through the same pure seam the driver uses: normalise the config, build
 * the parameter block, feed planar blocks, flush, and re-frame with {@link Mp3FrameSplitter}.
 */
function encode(core: Mp3EncWasmCore, pcm: Pcm, config: AudioEncoderConfig): EncodeResult {
  const init = normalizeMp3EncoderConfig(config);
  const encoder = core.createEncoder(buildMp3EncoderParams(init), init.channels);
  const splitter = new Mp3FrameSplitter();
  const frames: Uint8Array[] = [];
  const BLOCK = 1152;
  try {
    for (let offset = 0; offset < pcm.frames; offset += BLOCK) {
      const count = Math.min(BLOCK, pcm.frames - offset);
      const block = pcm.planes.map((plane) => plane.subarray(offset, offset + count));
      validateMp3Planes(block, count, init.channels);
      frames.push(...splitter.push(encoder.encode(block, count)));
    }
    frames.push(...splitter.push(encoder.finish()));
  } finally {
    encoder.free();
  }
  return { frames, bytes: concat(frames), pending: splitter.finish().length };
}

/** Decode a whole MP3 bitstream with the independent Symphonia core. */
function decodeAll(
  Mp3Wasm: Mp3WasmDecoderClass,
  bytes: Uint8Array,
): { samples: number; channels: number; sampleRate: number; finite: boolean; peak: number } {
  const first = parseMp3FrameHeader(bytes, firstFrameOffset(bytes));
  const decoder = new Mp3Wasm(first.channels, first.sampleRate);
  let samples = 0;
  let finite = true;
  let peak = 0;
  let channels = first.channels;
  let sampleRate = first.sampleRate;
  try {
    for (const { data } of iterateMp3Frames(bytes)) {
      const pcm = decoder.decode(data);
      channels = decoder.channels > 0 ? decoder.channels : channels;
      sampleRate = decoder.sampleRate > 0 ? decoder.sampleRate : sampleRate;
      samples += channels > 0 ? pcm.length / channels : 0;
      for (const value of pcm) {
        if (!Number.isFinite(value)) finite = false;
        peak = Math.max(peak, Math.abs(value));
      }
    }
  } finally {
    decoder.free();
  }
  return { samples, channels, sampleRate, finite, peak };
}

const CBR_MATRIX = [
  { sampleRate: 44_100, channels: 2, kbps: 128 },
  { sampleRate: 48_000, channels: 2, kbps: 192 },
  { sampleRate: 32_000, channels: 1, kbps: 64 },
  { sampleRate: 22_050, channels: 2, kbps: 64 },
  { sampleRate: 16_000, channels: 1, kbps: 48 },
  { sampleRate: 8000, channels: 1, kbps: 32 },
] as const;

describe('MP3 authoring — the vendored LAME core encoding real PCM', () => {
  it('reports the MP3 MIME type and the pinned upstream version', async () => {
    const core = await loadEncoderCore();
    expect(core.mimeType).toBe('audio/mpeg');
    expect(core.version).toBe('wasm-media-encoders-0.7.0');
  });

  it('emits well-formed CBR frames whose headers match the request', async () => {
    const core = await loadEncoderCore();
    for (const { sampleRate, channels, kbps } of CBR_MATRIX) {
      const label = `${sampleRate}/${channels}ch/${kbps}k`;
      const pcm = tone(sampleRate, channels, 1);
      const out = encode(core, pcm, {
        codec: MP3_CODEC,
        sampleRate,
        numberOfChannels: channels,
        bitrate: kbps * 1000,
      });
      expect(out.pending, `${label} left un-framed bytes`).toBe(0);
      expect(out.frames.length, `${label} produced no frames`).toBeGreaterThan(0);

      for (const [i, frame] of out.frames.entries()) {
        expect(
          isFrameSync(frame[0] as number, frame[1] as number),
          `${label} frame ${i} sync`,
        ).toBe(true);
        const header = parseMp3FrameHeader(frame);
        expect(frame.length, `${label} frame ${i} size`).toBe(header.frameSize);
        expect(header.layer, `${label} frame ${i} layer`).toBe(3);
        expect(header.sampleRate, `${label} frame ${i} rate`).toBe(sampleRate);
        expect(header.bitrate, `${label} frame ${i} bitrate`).toBe(kbps * 1000);
        expect(header.channels, `${label} frame ${i} channels`).toBe(channels);
        expect(header.channelMode === 'mono', `${label} frame ${i} mode`).toBe(channels === 1);
        expect(header.samplesPerFrame, `${label} frame ${i} spf`).toBe(
          mp3SamplesPerFrame(sampleRate),
        );
      }

      // Frame count matches the input duration: LAME's lead-in/flush add at most a couple of frames.
      const expectedFrames = pcm.frames / mp3SamplesPerFrame(sampleRate);
      expect(out.frames.length, `${label} frame count`).toBeGreaterThanOrEqual(
        Math.floor(expectedFrames),
      );
      expect(out.frames.length, `${label} frame count`).toBeLessThanOrEqual(
        Math.ceil(expectedFrames) + 3,
      );

      // Total size matches the requested constant bitrate. The slack is expressed in whole frames (the
      // only unit MP3 can be off by): LAME's lead-in plus the flush add a couple of frames, which is a
      // few percent at 44.1 kHz but ~14% at 8 kHz, where one frame is 1/14th of a second.
      const expectedBytes = (kbps * 1000 * (pcm.frames / sampleRate)) / 8;
      const frameBytes = (kbps * 1000 * mp3SamplesPerFrame(sampleRate)) / sampleRate / 8;
      expect(
        Math.abs(out.bytes.length - expectedBytes),
        `${label} byte budget (${out.bytes.length} vs ${expectedBytes})`,
      ).toBeLessThanOrEqual(3 * frameBytes + 1);
    }
  }, 60_000);

  it('emits a genuinely variable bitstream in VBR mode, smaller at worse quality', async () => {
    const core = await loadEncoderCore();
    const pcm = tone(44_100, 2, 1);
    const sizes = [0, 4, 9].map(
      (vbrQuality) =>
        encode(core, pcm, {
          codec: MP3_CODEC,
          sampleRate: 44_100,
          numberOfChannels: 2,
          mp3: { vbrQuality },
        } as AudioEncoderConfig).bytes.length,
    );
    expect(sizes[0]).toBeGreaterThan(sizes[1] as number);
    expect(sizes[1]).toBeGreaterThan(sizes[2] as number);

    const vbr = encode(core, pcm, {
      codec: MP3_CODEC,
      sampleRate: 44_100,
      numberOfChannels: 2,
    });
    const bitrates = new Set(vbr.frames.map((f) => parseMp3FrameHeader(f).bitrate));
    expect(bitrates.size, 'VBR must not emit a single constant bitrate').toBeGreaterThan(1);
    for (const frame of vbr.frames) expect(parseMp3FrameHeader(frame).sampleRate).toBe(44_100);
  }, 60_000);

  it('round-trips real WAV fixtures through the independent Symphonia decoder', async () => {
    const core = await loadEncoderCore();
    const Mp3Wasm = await loadDecoderCore();
    for (const id of ['sfx-pcm-s16.wav', 'sfx-pcm-f32.wav', 'sfx-pcm-u8.wav', 'stereo-48000.wav']) {
      const pcm = await wavPcm(id);
      const out = encode(core, pcm, {
        codec: MP3_CODEC,
        sampleRate: pcm.sampleRate,
        numberOfChannels: pcm.channels,
        bitrate: 128_000,
      });
      expect(out.pending, `${id} left un-framed bytes`).toBe(0);
      // A real lossy encode is far smaller than the 16-bit PCM it came from.
      expect(out.bytes.length, `${id} compression`).toBeLessThan(pcm.frames * pcm.channels * 2);

      const decoded = decodeAll(Mp3Wasm, out.bytes);
      expect(decoded.sampleRate, `${id} decoded rate`).toBe(pcm.sampleRate);
      expect(decoded.channels, `${id} decoded channels`).toBe(pcm.channels);
      expect(decoded.finite, `${id} decoded PCM is finite`).toBe(true);
      expect(decoded.peak, `${id} decoded PCM is not silent`).toBeGreaterThan(0.01);
      // Layer-III reconstruction legitimately overshoots the source's full scale on broadband content
      // (`stereo-48000.wav` is uniform noise peaking at 0.80 and decodes to ~1.48 at 128 kbps), so ±1.0
      // is not a valid bound for decoded MP3. +6 dB of headroom still catches a genuinely broken decode.
      expect(decoded.peak, `${id} decoded PCM stays within lossy headroom`).toBeLessThanOrEqual(2);
      // The decoded length covers the source, plus LAME's encoder delay rounded up to whole frames.
      const spf = mp3SamplesPerFrame(pcm.sampleRate);
      expect(decoded.samples, `${id} decoded length`).toBeGreaterThanOrEqual(pcm.frames);
      expect(decoded.samples - pcm.frames, `${id} decoded overhang`).toBeLessThanOrEqual(4 * spf);
      expect(decoded.samples % spf, `${id} decoded whole frames`).toBe(0);
    }
  }, 120_000);

  it('encodes mono and stereo tones that decode back to the requested geometry', async () => {
    const core = await loadEncoderCore();
    const Mp3Wasm = await loadDecoderCore();
    for (const channels of [1, 2] as const) {
      const pcm = tone(44_100, channels, 0.5);
      const out = encode(core, pcm, {
        codec: MP3_CODEC,
        sampleRate: 44_100,
        numberOfChannels: channels,
        bitrate: 160_000,
      });
      const decoded = decodeAll(Mp3Wasm, out.bytes);
      expect(decoded.channels, `${channels}ch decoded channels`).toBe(channels);
      expect(decoded.sampleRate).toBe(44_100);
      expect(decoded.finite).toBe(true);
      expect(decoded.peak).toBeGreaterThan(0.05);
    }
  }, 60_000);

  it('surfaces core misuse as errors rather than corrupt output', async () => {
    const core = await loadEncoderCore();
    const init = normalizeMp3EncoderConfig(cfg({ bitrate: 128_000 }));
    const encoder = core.createEncoder(buildMp3EncoderParams(init), init.channels);
    expect(() => encoder.encode([new Float32Array(1152)], 1152)).toThrow(/expected 2 planar/);
    encoder.finish();
    expect(() => encoder.encode([new Float32Array(1152), new Float32Array(1152)], 1152)).toThrow(
      /already flushed/,
    );
    expect(encoder.finish().length).toBe(0); // a second flush is a no-op, not a fault
    encoder.free();
    encoder.free(); // idempotent
    expect(() => encoder.finish()).toThrow(/already freed/);
  });

  it('refuses parameters LAME rejects', async () => {
    const core = await loadEncoderCore();
    const bogus = buildMp3EncoderParams({
      channels: 3, // MP3 carries at most 2 — the pure normaliser blocks this; the core is the backstop
      sampleRate: 44_100,
      cbrBitrateKbps: 128,
      vbrQuality: -1,
      outputSampleRate: 44_100,
    });
    expect(() => core.createEncoder(bogus, 3)).toThrow(/rejected the encoder parameters/);
  });
});

// ============ destination gapless timing ============

/**
 * The Xing/Info metadata frame a `lame` CLI stream carries, if present: the four ASCII bytes sit
 * immediately after the frame header and its side-information block. Detecting one is what decides
 * whether {@link MP3_ENCODER_LEAD_IN_SAMPLES} may be read out of the bitstream or must be measured.
 */
function infoFrameTag(frame: Uint8Array): string | undefined {
  const header = parseMp3FrameHeader(frame, 0);
  const sideInfoBytes =
    header.version === 'mpeg1' ? (header.channels === 1 ? 17 : 32) : header.channels === 1 ? 9 : 17;
  const at = 4 + sideInfoBytes;
  if (at + 4 > frame.length) return undefined;
  let tag = '';
  for (let i = 0; i < 4; i++) tag += String.fromCharCode(frame[at + i] as number);
  return tag === 'Xing' || tag === 'Info' ? tag : undefined;
}

/** Decode a whole bitstream and return channel 0's PCM — the signal the lag measurement runs on. */
function decodePlane0(Mp3Wasm: Mp3WasmDecoderClass, bytes: Uint8Array): Float32Array {
  const first = parseMp3FrameHeader(bytes, firstFrameOffset(bytes));
  const decoder = new Mp3Wasm(first.channels, first.sampleRate);
  const runs: Float32Array[] = [];
  let channels = first.channels;
  let total = 0;
  try {
    for (const { data } of iterateMp3Frames(bytes)) {
      const pcm = decoder.decode(data);
      channels = decoder.channels > 0 ? decoder.channels : channels;
      runs.push(pcm);
      total += pcm.length / channels;
    }
  } finally {
    decoder.free();
  }
  const plane = new Float32Array(total);
  let at = 0;
  for (const run of runs) {
    const frames = run.length / channels;
    for (let i = 0; i < frames; i++) plane[at + i] = run[i * channels] as number;
    at += frames;
  }
  return plane;
}

/**
 * The lag (in samples) at which the decoded PCM best matches the encoder's input — i.e. how much
 * lead-in a decoder emits before the program. Scored by normalised cross-correlation over a window
 * well inside the program, so neither the encoder's ramp-in nor its terminal padding can bias it.
 */
function measureLeadIn(source: Float32Array, decoded: Float32Array, maxLag: number): number {
  const window = Math.min(8192, source.length);
  let bestLag = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let lag = 0; lag <= maxLag; lag++) {
    let cross = 0;
    let power = 0;
    for (let i = 0; i < window; i++) {
      const value = decoded[i + lag] ?? 0;
      cross += (source[i] as number) * value;
      power += value * value;
    }
    const score = power > 0 ? cross / Math.sqrt(power) : Number.NEGATIVE_INFINITY;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

/** Broadband, lightly smoothed noise: rich enough that the correlation peak above is unambiguous. */
function noise(channels: number, frames: number, seed = 20_260_819): Float32Array[] {
  const random = rng(seed);
  return Array.from({ length: channels }, () => {
    const plane = new Float32Array(frames);
    let previous = 0;
    for (let i = 0; i < frames; i++) {
      previous = 0.6 * previous + 0.4 * (random() * 2 - 1);
      plane[i] = 0.5 * previous;
    }
    return plane;
  });
}

/**
 * The destination gapless tuple the driver publishes, recomputed here from first principles so the
 * assertions below are about the encode, not about the driver repeating itself.
 */
function gaplessOf(
  pcm: Pcm,
  out: EncodeResult,
): {
  leading: number;
  total: number;
  trailing: number;
  coded: number;
} {
  const coded = out.frames.length * mp3SamplesPerFrame(pcm.sampleRate);
  return {
    leading: MP3_ENCODER_LEAD_IN_SAMPLES,
    total: pcm.frames,
    trailing: coded - MP3_ENCODER_LEAD_IN_SAMPLES - pcm.frames,
    coded,
  };
}

const GAPLESS_MATRIX = [
  {
    label: '48k stereo CBR, exact frame multiple',
    sampleRate: 48_000,
    channels: 2,
    frames: 1152 * 40,
    bitrate: 192_000,
  },
  {
    label: '48k stereo CBR, not a frame multiple',
    sampleRate: 48_000,
    channels: 2,
    frames: 240_000,
    bitrate: 192_000,
  },
  { label: '48k mono CBR', sampleRate: 48_000, channels: 1, frames: 96_000, bitrate: 128_000 },
  { label: '48k stereo VBR', sampleRate: 48_000, channels: 2, frames: 100_000 },
  { label: '44.1k stereo CBR', sampleRate: 44_100, channels: 2, frames: 44_100, bitrate: 128_000 },
  { label: '44.1k mono VBR', sampleRate: 44_100, channels: 1, frames: 44_100 },
  {
    label: '44.1k stereo CBR, exact frame multiple',
    sampleRate: 44_100,
    channels: 2,
    frames: 1152 * 31,
    bitrate: 320_000,
  },
  // MPEG-2 and MPEG-2.5 halve the frame geometry to 576 samples; the lead-in must not follow it.
  {
    label: '22.05k mono CBR (MPEG-2)',
    sampleRate: 22_050,
    channels: 1,
    frames: 22_050,
    bitrate: 64_000,
  },
  {
    label: '11.025k mono CBR (MPEG-2.5)',
    sampleRate: 11_025,
    channels: 1,
    frames: 12_288,
    bitrate: 64_000,
  },
] as const;

describe('MP3 authoring — destination gapless timing', () => {
  it('carries no Xing/LAME info frame, so the delay cannot be read out of the bitstream', async () => {
    const core = await loadEncoderCore();
    for (const { sampleRate, channels, kbps } of CBR_MATRIX) {
      const out = encode(core, tone(sampleRate, channels, 0.5), {
        codec: MP3_CODEC,
        sampleRate,
        numberOfChannels: channels,
        bitrate: kbps * 1000,
      });
      const label = `${sampleRate}/${channels}ch`;
      expect(out.frames.length, `${label} produced no frames`).toBeGreaterThan(0);
      for (const [index, frame] of out.frames.entries()) {
        expect(infoFrameTag(frame), `${label} frame ${index} is a metadata frame`).toBeUndefined();
      }
    }
  });

  it('primes the decode by exactly MP3_ENCODER_LEAD_IN_SAMPLES at every version, mode and rate mode', async () => {
    const core = await loadEncoderCore();
    const Mp3Wasm = await loadDecoderCore();
    for (const entry of GAPLESS_MATRIX) {
      const { label, sampleRate, channels, frames } = entry;
      const bitrate = (entry as { bitrate?: number }).bitrate;
      const planes = noise(channels, frames);
      const pcm: Pcm = { sampleRate, channels, frames, planes };
      const out = encode(core, pcm, {
        codec: MP3_CODEC,
        sampleRate,
        numberOfChannels: channels,
        ...(bitrate === undefined ? {} : { bitrate }),
      });
      const decoded = decodePlane0(Mp3Wasm, out.bytes);
      // Search well past the answer: a wrong constant shows up as a different peak, not a clamp.
      const lag = measureLeadIn(planes[0] as Float32Array, decoded, 4 * 1152);
      expect(lag, `${label} decoder lead-in`).toBe(MP3_ENCODER_LEAD_IN_SAMPLES);
    }
  });

  it('splits every encode into priming + program + terminal padding with nothing left over', async () => {
    const core = await loadEncoderCore();
    const Mp3Wasm = await loadDecoderCore();
    for (const entry of GAPLESS_MATRIX) {
      const { label, sampleRate, channels, frames } = entry;
      const bitrate = (entry as { bitrate?: number }).bitrate;
      const pcm: Pcm = { sampleRate, channels, frames, planes: noise(channels, frames) };
      const out = encode(core, pcm, {
        codec: MP3_CODEC,
        sampleRate,
        numberOfChannels: channels,
        ...(bitrate === undefined ? {} : { bitrate }),
      });
      const { leading, total, trailing, coded } = gaplessOf(pcm, out);
      // The decoder is the authority on the coded capacity: whatever it emits is what the window
      // must partition, or the trim we author would run off the end of the real stream.
      expect(decodeAll(Mp3Wasm, out.bytes).samples, `${label} coded capacity`).toBe(coded);
      expect(trailing, `${label} terminal padding is not negative`).toBeGreaterThanOrEqual(0);
      expect(leading + total + trailing, `${label} window partitions the coded stream`).toBe(coded);
      // The Xing/LAME tag's delay/padding fields are 12 bits each; a window that cannot be signalled
      // in a raw `.mp3` is not a window this encoder may produce.
      expect(leading - MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES, `${label} LAME delay field`).toBe(
        576,
      );
      expect(
        trailing + MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES,
        `${label} LAME padding field`,
      ).toBeLessThanOrEqual(0xfff);
    }
  });

  it('keeps the window valid for inputs shorter than a single MPEG frame', async () => {
    const core = await loadEncoderCore();
    const Mp3Wasm = await loadDecoderCore();
    for (const frames of [1, 100, 500, 1151]) {
      const pcm: Pcm = { sampleRate: 48_000, channels: 2, frames, planes: noise(2, frames) };
      const out = encode(core, pcm, {
        codec: MP3_CODEC,
        sampleRate: 48_000,
        numberOfChannels: 2,
        bitrate: 192_000,
      });
      const { leading, total, trailing, coded } = gaplessOf(pcm, out);
      expect(decodeAll(Mp3Wasm, out.bytes).samples, `${frames}-frame coded capacity`).toBe(coded);
      expect(trailing, `${frames}-frame terminal padding`).toBeGreaterThanOrEqual(0);
      expect(leading + total + trailing, `${frames}-frame window`).toBe(coded);
      expect(trailing + MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES).toBeLessThanOrEqual(0xfff);
    }
  });
});

describe('core loading — the inlined fallback', () => {
  it('carries bytes identical to the vendored sibling artifact', async () => {
    const { default: fallbackBytes } = await import('./mp3-enc-wasm-fallback.js');
    const vendored = new Uint8Array(await readFile(ENC_WASM_PATH_FOR_FALLBACK));
    const inlined = fallbackBytes();
    expect(inlined.byteLength).toBe(vendored.byteLength);
    expect(Buffer.from(inlined).equals(Buffer.from(vendored))).toBe(true);
  });

  it('decodes to a module the runtime accepts, so the fallback is usable and not just present', async () => {
    const { default: fallbackBytes } = await import('./mp3-enc-wasm-fallback.js');
    const module = await WebAssembly.compile(fallbackBytes());
    const exported = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
    for (const name of ['enc_init', 'enc_encode', 'enc_flush', 'enc_get_pcm', 'enc_get_out_buf']) {
      expect(exported.has(name)).toBe(true);
    }
  });

  it('memoizes the decode rather than re-decoding per call', async () => {
    const { default: fallbackBytes } = await import('./mp3-enc-wasm-fallback.js');
    expect(fallbackBytes()).toBe(fallbackBytes());
  });
});
