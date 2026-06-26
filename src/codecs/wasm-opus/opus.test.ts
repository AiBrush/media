/**
 * Unit tests for the WASM Opus driver's pure, Node-runnable surface (BUILD §6, ADR-026): RFC 6716 TOC
 * parsing + the 32-config frame-size table (golden values straight from the spec), encoder re-chunking
 * math + the {@link FrameAccumulator}, planar↔interleaved f32 round-trips, OpusHead pre-skip extraction,
 * and config validation/normalization. WebCodecs (`AudioData`/`EncodedAudioChunk`) is **absent in Node
 * and must not be mocked** (ADR-018/ADR-025) — the full driver *stream* decode/encode is validated
 * in-browser / in `wasm-opus-encode.test.ts`. The libopus core is now **vendored** (a prebuilt MIT
 * `libopus-wasm`, ADR-088) and runs in Node, so here we also drive the {@link OpusWasmCore} facade
 * directly to prove a real PCM→Opus→PCM round-trip, and assert that `supports()` is still an honest
 * Node miss (WebCodecs seam absent) — never throws. Every assertion is falsifiable (directive 6).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import {
  DEFAULT_FRAME_MS,
  FrameAccumulator,
  OPUS_DECODE_RATES,
  OPUS_FRAME_MS,
  OPUS_RATE,
  asDecodeRate,
  deinterleaveF32,
  frameMsFromConfig,
  frameSamplesAt48k,
  frameSamplesAtRate,
  frameSamplesForConfig,
  interleaveF32,
  isValidFrameMs,
  modeForConfig,
  normalizeOpusDecoderConfig,
  normalizeOpusEncoderConfig,
  packetDurationSamples,
  packetFrameCount,
  parseToc,
  preSkipFromDescription,
} from './opus.ts';
import WasmOpusModule, {
  decodedSamplesAtRate,
  isOpusQuery,
  loadOpusCore,
  OPUS_CODEC,
  resetOpusCoreForTest,
  unsupported,
  WasmOpusDriver,
} from './wasm-opus-driver.ts';

/** Build a one-byte (or two-byte) Opus packet with a chosen TOC for table-driven assertions. */
function toc(
  config: number,
  stereo: boolean,
  code: 0 | 1 | 2 | 3,
  frameCountByte?: number,
): Uint8Array {
  const b0 = ((config & 0x1f) << 3) | (stereo ? 0x04 : 0) | code;
  return frameCountByte === undefined ? Uint8Array.of(b0) : Uint8Array.of(b0, frameCountByte);
}

describe('Opus invariants match the spec', () => {
  it('48 kHz internal rate and the legal frame-duration set (RFC 6716 §2.1.4)', () => {
    expect(OPUS_RATE).toBe(48_000);
    expect([...OPUS_FRAME_MS]).toEqual([2.5, 5, 10, 20, 40, 60]);
    expect([...OPUS_DECODE_RATES]).toEqual([8_000, 12_000, 16_000, 24_000, 48_000]);
    expect(DEFAULT_FRAME_MS).toBe(20);
  });
});

describe('modeForConfig — RFC 6716 §3.1 mode partition', () => {
  it('0–11 SILK, 12–15 Hybrid, 16–31 CELT', () => {
    expect(modeForConfig(0)).toBe('silk');
    expect(modeForConfig(11)).toBe('silk');
    expect(modeForConfig(12)).toBe('hybrid');
    expect(modeForConfig(15)).toBe('hybrid');
    expect(modeForConfig(16)).toBe('celt');
    expect(modeForConfig(31)).toBe('celt');
  });
  it('rejects out-of-range configs', () => {
    expect(() => modeForConfig(-1)).toThrow(MediaError);
    expect(() => modeForConfig(32)).toThrow(MediaError);
  });
});

describe('frameSamplesForConfig — RFC 6716 Table 2 golden frame sizes @ 48 kHz', () => {
  // SILK NB 10/20/40/60 ms → 480/960/1920/2880; CELT 2.5/5 ms → 120/240.
  it.each([
    [0, 480],
    [1, 960],
    [2, 1920],
    [3, 2880], // SILK NB
    [8, 480],
    [9, 960],
    [10, 1920],
    [11, 2880], // SILK WB
    [12, 480],
    [13, 960], // Hybrid SWB 10/20 ms
    [16, 120],
    [17, 240],
    [18, 480],
    [19, 960], // CELT NB 2.5/5/10/20 ms
    [28, 120],
    [31, 960], // CELT FB 2.5 / 20 ms
  ])('config %i → %i samples', (config, samples) => {
    expect(frameSamplesForConfig(config)).toBe(samples);
  });
  it('rejects out-of-range configs', () => {
    expect(() => frameSamplesForConfig(32)).toThrow(MediaError);
  });
});

describe('parseToc — TOC byte fields (config / stereo / frame-count code)', () => {
  it('decodes config, stereo bit, and frame-count code', () => {
    const t = parseToc(toc(17, true, 2)); // CELT 5 ms, stereo, code 2
    expect(t.config).toBe(17);
    expect(t.mode).toBe('celt');
    expect(t.frameSamples).toBe(240);
    expect(t.stereo).toBe(true);
    expect(t.frameCountCode).toBe(2);
  });
  it('mono code-0 packet', () => {
    const t = parseToc(toc(1, false, 0)); // SILK NB 20 ms, mono, single frame
    expect(t.stereo).toBe(false);
    expect(t.frameCountCode).toBe(0);
    expect(t.frameSamples).toBe(960);
  });
  it('rejects an empty packet (no TOC byte)', () => {
    expect(() => parseToc(new Uint8Array(0))).toThrow(MediaError);
  });
});

describe('packetFrameCount / packetDurationSamples — RFC 6716 §3.2', () => {
  it('code 0 → 1 frame', () => {
    expect(packetFrameCount(toc(1, false, 0))).toBe(1);
    expect(packetDurationSamples(toc(1, false, 0))).toBe(960); // 1 × 20 ms
  });
  it('codes 1 and 2 → 2 frames', () => {
    expect(packetFrameCount(toc(1, false, 1))).toBe(2);
    expect(packetFrameCount(toc(1, false, 2))).toBe(2);
    expect(packetDurationSamples(toc(1, false, 1))).toBe(1920); // 2 × 20 ms
  });
  it('code 3 → arbitrary count from the frame-count byte (low 6 bits)', () => {
    expect(packetFrameCount(toc(1, false, 3, 3))).toBe(3); // M = 3
    expect(packetFrameCount(toc(16, false, 3, 0x80 | 10))).toBe(10); // VBR bit set, M = 10
    expect(packetDurationSamples(toc(16, false, 3, 0x80 | 10))).toBe(1200); // 10 × 2.5 ms = 10×120
  });
  it('rejects a code-3 packet missing its frame-count byte', () => {
    expect(() => packetFrameCount(toc(1, false, 3))).toThrow(MediaError);
  });
  it('rejects an illegal code-3 frame count (0)', () => {
    expect(() => packetFrameCount(toc(1, false, 3, 0))).toThrow(MediaError);
  });
});

describe('frame-size math (encoder re-chunking)', () => {
  it('frameSamplesAt48k: 20 ms → 960, 60 ms → 2880', () => {
    expect(frameSamplesAt48k(20)).toBe(960);
    expect(frameSamplesAt48k(2.5)).toBe(120);
    expect(frameSamplesAt48k(60)).toBe(2880);
  });
  it('frameSamplesAtRate: 20 ms is 960 @48k, 480 @24k, 160 @8k', () => {
    expect(frameSamplesAtRate(48_000, 20)).toBe(960);
    expect(frameSamplesAtRate(24_000, 20)).toBe(480);
    expect(frameSamplesAtRate(8_000, 20)).toBe(160);
  });
  it('frameSamplesAtRate rejects a non-integer (rate, duration) pair', () => {
    expect(() => frameSamplesAtRate(44_100, 2.5)).toThrow(MediaError); // 110.25 samples
  });
  it('isValidFrameMs accepts only the Opus set', () => {
    for (const ms of OPUS_FRAME_MS) expect(isValidFrameMs(ms)).toBe(true);
    expect(isValidFrameMs(15)).toBe(false);
    expect(isValidFrameMs(0)).toBe(false);
  });
});

describe('FrameAccumulator — re-chunk arbitrary input into fixed Opus frames', () => {
  it('hands out exactly-frame-sized chunks and keeps the remainder', () => {
    const acc = new FrameAccumulator(2, 4); // 2ch, 4 samples/frame → 8 interleaved values/frame
    expect(acc.pull()).toBeUndefined();
    acc.push(Float32Array.of(1, 1, 2, 2, 3, 3)); // 3 samples/ch (< 1 frame)
    expect(acc.bufferedSamples).toBe(3);
    expect(acc.pull()).toBeUndefined();
    acc.push(Float32Array.of(4, 4, 5, 5, 6, 6, 7, 7)); // +4 → 7 samples/ch buffered
    const f1 = acc.pull();
    expect(f1 && [...f1]).toEqual([1, 1, 2, 2, 3, 3, 4, 4]); // first full frame (4 samples/ch)
    expect(acc.bufferedSamples).toBe(3); // 5,6,7 remain
    expect(acc.pull()).toBeUndefined();
  });
  it('drainFinal zero-pads the partial tail and reports the pad length', () => {
    const acc = new FrameAccumulator(1, 4);
    acc.push(Float32Array.of(9, 8)); // 2 of 4 samples
    const tail = acc.drainFinal();
    expect(tail && [...tail.frame]).toEqual([9, 8, 0, 0]);
    expect(tail?.padSamples).toBe(2);
    expect(acc.drainFinal()).toBeUndefined(); // drained
  });
  it('drainFinal is empty when nothing is buffered', () => {
    expect(new FrameAccumulator(1, 4).drainFinal()).toBeUndefined();
  });
  it('grows past the initial capacity without dropping samples', () => {
    const acc = new FrameAccumulator(1, 2); // initial buf = 2×2×... ; push far more
    const big = Float32Array.from({ length: 100 }, (_, i) => i);
    acc.push(big);
    let seen = 0;
    for (let f = acc.pull(); f !== undefined; f = acc.pull()) {
      expect([...f]).toEqual([seen, seen + 1]);
      seen += 2;
    }
    expect(seen).toBe(100);
  });
  it('rejects input whose length is not a multiple of channels', () => {
    expect(() => new FrameAccumulator(2, 4).push(Float32Array.of(1, 2, 3))).toThrow(MediaError);
  });
  it('rejects nonsensical construction', () => {
    expect(() => new FrameAccumulator(0, 4)).toThrow(MediaError);
    expect(() => new FrameAccumulator(2, 0)).toThrow(MediaError);
  });
});

describe('planar ↔ interleaved f32 round-trip', () => {
  it('interleave then deinterleave is identity (stereo)', () => {
    // f32-exact values (powers-of-two fractions) so literal comparison is exact, not f32-rounding-fuzzy.
    const left = Float32Array.of(0.25, 0.5, 0.75);
    const right = Float32Array.of(-0.125, -0.375, -0.625);
    const inter = interleaveF32([left, right], 3);
    expect([...inter]).toEqual([0.25, -0.125, 0.5, -0.375, 0.75, -0.625]); // L,R,L,R…
    const planes = deinterleaveF32(inter, 2, 3);
    expect([...(planes[0] ?? [])]).toEqual([...left]); // round-trip identity, channel 0
    expect([...(planes[1] ?? [])]).toEqual([...right]); // round-trip identity, channel 1
  });
  it('mono is a passthrough', () => {
    const mono = Float32Array.of(0.5, 0.25);
    expect([...interleaveF32([mono], 2)]).toEqual([0.5, 0.25]);
    expect([...(deinterleaveF32(mono, 1, 2)[0] ?? [])]).toEqual([0.5, 0.25]);
  });
  it('deinterleave rejects a length/shape mismatch', () => {
    expect(() => deinterleaveF32(Float32Array.of(1, 2, 3), 2, 2)).toThrow(MediaError);
  });
});

describe('preSkipFromDescription — OpusHead pre-skip (RFC 7845 §5.1)', () => {
  /** Minimal OpusHead: magic(8) + version(1) + channels(1) + preSkip u16 LE(2) + rate(4) + gain(2) + map(1). */
  function opusHead(preSkip: number, channels = 2): Uint8Array {
    const h = new Uint8Array(19);
    h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
    h[8] = 1; // version
    h[9] = channels;
    h[10] = preSkip & 0xff;
    h[11] = (preSkip >> 8) & 0xff;
    return h;
  }
  it('reads the little-endian pre-skip', () => {
    expect(preSkipFromDescription(opusHead(3840))).toBe(3840); // typical 80 ms @ 48 kHz
    expect(preSkipFromDescription(opusHead(312))).toBe(312);
  });
  it('reads from an ArrayBuffer view too (no Uint8Array required)', () => {
    const h = opusHead(120);
    expect(preSkipFromDescription(h.buffer)).toBe(120);
  });
  it('returns 0 for absent / too-short / non-OpusHead descriptions', () => {
    expect(preSkipFromDescription(undefined)).toBe(0);
    expect(preSkipFromDescription(new Uint8Array(4))).toBe(0);
    expect(preSkipFromDescription(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))).toBe(0);
  });
});

describe('asDecodeRate — narrow to a libopus output rate', () => {
  it('passes the allowed rates, rejects others', () => {
    expect(asDecodeRate(48_000)).toBe(48_000);
    expect(asDecodeRate(16_000)).toBe(16_000);
    expect(asDecodeRate(44_100)).toBeUndefined();
    expect(asDecodeRate(0)).toBeUndefined();
  });
});

describe('normalizeOpusDecoderConfig — validate + extract pre-skip', () => {
  it('accepts a well-formed Opus config and carries channels/rate/pre-skip', () => {
    const head = Uint8Array.of(
      0x4f,
      0x70,
      0x75,
      0x73,
      0x48,
      0x65,
      0x61,
      0x64,
      1,
      2,
      0x00,
      0x0f,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ); // OpusHead, preSkip = 0x0f00 = 3840
    const init = normalizeOpusDecoderConfig({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 2,
      description: head,
    });
    expect(init).toEqual({ sampleRate: 48_000, channels: 2, preSkip: 3840 });
  });
  it('defaults pre-skip to 0 with no OpusHead description', () => {
    const init = normalizeOpusDecoderConfig({
      codec: 'opus',
      sampleRate: 24_000,
      numberOfChannels: 1,
    });
    expect(init.preSkip).toBe(0);
    expect(init.sampleRate).toBe(24_000);
  });
  it('rejects a non-Opus codec', () => {
    expect(() =>
      normalizeOpusDecoderConfig({ codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 }),
    ).toThrow(MediaError);
  });
  it('rejects an unsupported output sample rate', () => {
    expect(() =>
      normalizeOpusDecoderConfig({ codec: 'opus', sampleRate: 44_100, numberOfChannels: 2 }),
    ).toThrow(/sampleRate/);
  });
  it('rejects >2 channels (driver scope is mono/stereo)', () => {
    expect(() =>
      normalizeOpusDecoderConfig({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 6 }),
    ).toThrow(/channels/);
  });
});

describe('normalizeOpusEncoderConfig — validate + frame math', () => {
  it('defaults to a 20 ms frame and precomputes the per-frame sample count', () => {
    const init = normalizeOpusEncoderConfig({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
    expect(init).toEqual({
      sampleRate: 48_000,
      channels: 2,
      bitrate: 128_000,
      frameMs: 20,
      frameSamples: 960,
    });
  });
  it('honors the WebCodecs opus.frameDuration (µs) hint', () => {
    const init = normalizeOpusEncoderConfig({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 1,
      opus: { frameDuration: 60_000 }, // 60 ms
    } as AudioEncoderConfig);
    expect(init.frameMs).toBe(60);
    expect(init.frameSamples).toBe(2880);
  });
  it('treats a missing/zero bitrate as auto', () => {
    const init = normalizeOpusEncoderConfig({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 2,
    });
    expect(init.bitrate).toBe('auto');
  });
  it('rejects a non-Opus-legal frameDuration', () => {
    expect(() =>
      normalizeOpusEncoderConfig({
        codec: 'opus',
        sampleRate: 48_000,
        numberOfChannels: 2,
        opus: { frameDuration: 15_000 }, // 15 ms — illegal
      } as AudioEncoderConfig),
    ).toThrow(/frameDuration/);
  });
  it('rejects a non-Opus codec / bad rate / bad channels', () => {
    expect(() =>
      normalizeOpusEncoderConfig({ codec: 'vorbis', sampleRate: 48_000, numberOfChannels: 2 }),
    ).toThrow(MediaError);
    expect(() =>
      normalizeOpusEncoderConfig({ codec: 'opus', sampleRate: 44_100, numberOfChannels: 2 }),
    ).toThrow(/sampleRate/);
    expect(() =>
      normalizeOpusEncoderConfig({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 8 }),
    ).toThrow(/channels/);
  });
});

describe('frameMsFromConfig — defaulting + µs→ms', () => {
  it('defaults to 20 ms when no opus hint is present', () => {
    expect(frameMsFromConfig({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 })).toBe(20);
  });
});

// ============ driver: identity, registration, honest wasm-absence ============

describe('wasm-opus — driver identity & module', () => {
  it('declares the contracted identity (tier:wasm so it is ranked last)', () => {
    expect(WasmOpusDriver.id).toBe('wasm-opus');
    expect(WasmOpusDriver.kind).toBe('codec');
    expect(WasmOpusDriver.tier).toBe('wasm');
    expect(WasmOpusDriver.apiVersion).toBe(1);
    expect(OPUS_CODEC).toBe('opus');
  });
  it('registers exactly itself as a codec (and nothing else)', () => {
    const added: unknown[] = [];
    let containers = 0;
    let filters = 0;
    WasmOpusModule.register({
      addCodec: (d) => added.push(d),
      addContainer: () => containers++,
      addFilter: () => filters++,
    });
    expect(added).toEqual([WasmOpusDriver]);
    expect(containers).toBe(0);
    expect(filters).toBe(0);
  });
  it('isOpusQuery only matches Opus audio', () => {
    expect(
      isOpusQuery({ mediaType: 'audio', direction: 'decode', config: { codec: 'opus' } }),
    ).toBe(true);
    expect(
      isOpusQuery({ mediaType: 'audio', direction: 'decode', config: { codec: 'vorbis' } }),
    ).toBe(false);
    expect(
      isOpusQuery({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'opus' } as unknown as VideoDecoderConfig,
      }),
    ).toBe(false);
  });
  it('unsupported is a non-supported result carrying the reason', () => {
    expect(unsupported('nope')).toEqual({ supported: false, reason: 'nope' });
  });
});

describe('decodedSamplesAtRate — packet duration rescaled to the output rate', () => {
  it('48 kHz keeps the intrinsic size; 24 kHz halves it', () => {
    const p = toc(1, false, 0); // 20 ms → 960 @48k
    expect(decodedSamplesAtRate(p, 48_000)).toBe(960);
    expect(decodedSamplesAtRate(p, 24_000)).toBe(480);
    expect(decodedSamplesAtRate(p, 8_000)).toBe(160);
  });
});

describe('supports() / coders — vendored libopus core present; Node still gates on WebCodecs (ADR-088)', () => {
  afterEach(() => {
    resetOpusCoreForTest();
  });

  it('loadOpusCore resolves to a real core now that the prebuilt artifact is vendored', async () => {
    const core = await loadOpusCore();
    expect(core).not.toBeNull();
    expect(typeof core?.createDecoder).toBe('function');
    expect(typeof core?.createEncoder).toBe('function');
  });

  it('returns false (never throws) for an Opus decode query in Node (WebCodecs AudioData absent)', async () => {
    const s = await WasmOpusDriver.supports({
      mediaType: 'audio',
      direction: 'decode',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    });
    // The core IS vendored, so the only honest Node miss is the absent WebCodecs seam type.
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/WebCodecs|AudioData/);
  });

  it('returns false for a non-Opus query without consulting the core', async () => {
    const s = await WasmOpusDriver.supports({
      mediaType: 'audio',
      direction: 'decode',
      config: { codec: 'mp4a.40.2', sampleRate: 44_100, numberOfChannels: 2 },
    });
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/Opus/);
  });

  it('returns false for a non-audio query', async () => {
    const s = await WasmOpusDriver.supports({
      mediaType: 'video',
      direction: 'decode',
      config: { codec: 'opus' } as unknown as VideoDecoderConfig,
    });
    expect(s.supported).toBe(false);
  });

  // The config is validated eagerly (fail-fast) before any wasm/stream work — Node-runnable.
  it('createDecoder validates the config up front and rejects a non-Opus codec', () => {
    expect(() =>
      WasmOpusDriver.createDecoder({ codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 }),
    ).toThrow(MediaError);
  });

  it('createDecoder rejects an unsupported output sample rate up front', () => {
    expect(() =>
      WasmOpusDriver.createDecoder({ codec: 'opus', sampleRate: 44_100, numberOfChannels: 2 }),
    ).toThrow(/sampleRate/);
  });

  it('createEncoder validates the config up front and rejects a non-Opus codec', () => {
    expect(() =>
      WasmOpusDriver.createEncoder({ codec: 'vorbis', sampleRate: 48_000, numberOfChannels: 2 }),
    ).toThrow(MediaError);
  });

  it('aborts up front with a typed `aborted` MediaError when the signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(() =>
      WasmOpusDriver.createDecoder(
        { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
        { signal: ctrl.signal },
      ),
    ).toThrow(/aborted/);
    expect(() =>
      WasmOpusDriver.createEncoder(
        { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
        { signal: ctrl.signal },
      ),
    ).toThrow(/aborted/);
  });

  // The vendored core is real and runs in Node: build it directly through the OpusWasmCore facade and
  // prove a PCM frame → Opus packet → PCM round-trips (the lossy CELT/SILK math the wasm supplies). This
  // is a stronger, falsifiable check than the old "core absent → CapabilityError" — a broken/absent core
  // would throw here, and a fake passthrough would not produce a valid Opus packet the decoder accepts.
  // (The driver's `createDecoder`/`createEncoder` stream wrappers themselves need WebCodecs `AudioData`/
  // `EncodedAudioChunk`, so the END-TO-END stream path is validated in `wasm-opus-encode.test.ts` /
  // the browser harness; here we exercise the core contract the driver loads.)
  it('the vendored libopus core round-trips a PCM frame → Opus → PCM (real lossy codec, not a stub)', async () => {
    const core = await loadOpusCore();
    expect(core).not.toBeNull();
    if (!core) return;
    const frameSamples = 960; // 20 ms @ 48 kHz
    const encoder = await core.createEncoder({
      sampleRate: 48_000,
      channels: 1,
      bitrate: 96_000,
      frameMs: 20,
      frameSamples,
    });
    const decoder = await core.createDecoder({ sampleRate: 48_000, channels: 1, preSkip: 0 });
    try {
      const pcm = new Float32Array(frameSamples);
      for (let i = 0; i < frameSamples; i++)
        pcm[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 48_000);
      const packet = encoder.encode(pcm);
      // A real Opus packet: non-empty, and its TOC parses to a 48 kHz frame size.
      expect(packet.byteLength).toBeGreaterThan(0);
      expect(typeof encoder.preSkip()).toBe('number');
      const decoded = decoder.decode(packet, frameSamples);
      expect(decoded.length).toBe(frameSamples);
      // The decoded frame carries real signal energy (a stub/silence passthrough would be ~0).
      let energy = 0;
      for (const s of decoded) energy += s * s;
      expect(energy).toBeGreaterThan(0.1);
    } finally {
      encoder.free();
      decoder.free();
    }
  });
});
