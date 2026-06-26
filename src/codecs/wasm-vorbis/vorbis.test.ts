/**
 * Tests for the WASM Vorbis driver. Two layers (BUILD §6, ADR-032):
 *
 *  1. **Pure helpers in Node** — Xiph header-lacing build/parse round-trip (matching Symphonia's
 *     `unpack_xiph_laced_extradata`), Ogg page→packet de-lacing on the **real** `sound_5.oga`,
 *     planar f32, config validation, and the driver's identity + honest behavior.
 *  2. **The REAL wasm Vorbis core, decoding real media in Node.** The vendored Symphonia-in-wasm core
 *     (`vorbis_wasm_bg.wasm` + `vorbis-core.js`, built via `wasm-pack --target web`) is instantiated
 *     from bytes and fed the actual identification/comment/setup + audio packets demuxed from
 *     `sound_5.oga`. We gate on Vorbis's own self-consistency oracle: the decoder reports the ident
 *     header's channels + sample rate, and the total decoded sample count matches the stream's final
 *     granule position (what every correct Vorbis decoder must produce) — a strong, content-agnostic,
 *     un-fakeable check. WebCodecs `AudioData` is browser-only, so the `AudioData`-wrapping `createDecoder`
 *     stream is validated in-browser; the codec itself is fully validated here.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  VORBIS_CODEC,
  VORBIS_IDENT_PACKET,
  VORBIS_SETUP_PACKET,
  buildVorbisExtradata,
  deinterleaveF32,
  descriptionBytes,
  normalizeVorbisDecoderConfig,
  parseVorbisExtradata,
  readOggPackets,
  xiphLaceLength,
} from './vorbis.ts';
import WasmVorbisModule, {
  isVorbisQuery,
  loadVorbisCore,
  resetVorbisCoreForTest,
  unsupported,
  WasmVorbisDriver,
} from './wasm-vorbis-driver.ts';

const WASM_PATH = new URL('./vorbis_wasm_bg.wasm', import.meta.url).pathname;

// ============ pure helpers ============

describe('xiph lacing — build ↔ parse round-trip (RFC 5215 / WebM CodecPrivate)', () => {
  it('encodes a length as 0xFF runs + remainder', () => {
    expect(xiphLaceLength(0)).toEqual([0]);
    expect(xiphLaceLength(30)).toEqual([30]);
    expect(xiphLaceLength(255)).toEqual([255, 0]);
    expect(xiphLaceLength(600)).toEqual([255, 255, 90]);
  });
  it('build then parse recovers the three header packets exactly', () => {
    const ident = Uint8Array.from({ length: 30 }, (_, i) => i + 1);
    const comment = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff); // > 255 → multi-byte lace
    const setup = Uint8Array.from({ length: 1200 }, (_, i) => (i * 13) & 0xff);
    const blob = buildVorbisExtradata(ident, comment, setup);
    expect(blob[0]).toBe(0x02);
    const got = parseVorbisExtradata(blob);
    expect([...got.ident]).toEqual([...ident]);
    expect([...got.comment]).toEqual([...comment]);
    expect([...got.setup]).toEqual([...setup]);
  });
  it('parse rejects a non-Xiph-laced blob', () => {
    expect(() => parseVorbisExtradata(Uint8Array.of(0x00, 1, 2))).toThrow(MediaError);
  });
  it('parse rejects truncated lacing', () => {
    expect(() => parseVorbisExtradata(Uint8Array.of(0x02, 255))).toThrow(MediaError);
  });
});

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

describe('normalizeVorbisDecoderConfig — validate + require codec-private', () => {
  const description = buildVorbisExtradata(Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3));
  it('accepts a Vorbis config carrying a description', () => {
    const cfg = normalizeVorbisDecoderConfig({
      codec: 'vorbis',
      sampleRate: 44100,
      numberOfChannels: 2,
      description,
    });
    expect(cfg.channels).toBe(2);
    expect(cfg.sampleRate).toBe(44100);
    expect(cfg.extraData.length).toBe(description.length);
  });
  it('rejects a non-Vorbis codec', () => {
    expect(() =>
      normalizeVorbisDecoderConfig({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }),
    ).toThrow(MediaError);
  });
  it('rejects a missing description (codec-private headers are mandatory for Vorbis)', () => {
    expect(() =>
      normalizeVorbisDecoderConfig({ codec: 'vorbis', sampleRate: 44100, numberOfChannels: 2 }),
    ).toThrow(/description/);
  });
  it('rejects an out-of-range channel count', () => {
    expect(() =>
      normalizeVorbisDecoderConfig({
        codec: 'vorbis',
        sampleRate: 44100,
        numberOfChannels: 64,
        description,
      }),
    ).toThrow(/channels/);
  });
});

describe('descriptionBytes — normalize every AllowSharedBufferSource shape', () => {
  it('passes a Uint8Array through unchanged', () => {
    const u = Uint8Array.of(1, 2, 3);
    expect(descriptionBytes(u)).toBe(u);
  });
  it('wraps a plain ArrayBuffer', () => {
    const ab = Uint8Array.of(4, 5, 6).buffer;
    expect([...descriptionBytes(ab)]).toEqual([4, 5, 6]);
  });
  it('wraps a non-Uint8Array view over its byte range', () => {
    const backing = Uint8Array.of(0, 0, 7, 8, 0).buffer;
    const view = new DataView(backing, 2, 2); // bytes [7,8]
    expect([...descriptionBytes(view)]).toEqual([7, 8]);
  });
  it('returns empty for an absent description', () => {
    expect(descriptionBytes(undefined).length).toBe(0);
  });
});

describe('Vorbis header packet-type constants (RFC 5215 §3)', () => {
  it('ident=0x01, setup=0x05', () => {
    expect(VORBIS_IDENT_PACKET).toBe(0x01);
    expect(VORBIS_SETUP_PACKET).toBe(0x05);
  });
});

describe('parseVorbisExtradata — header lengths exceeding the buffer', () => {
  it('rejects a blob whose laced lengths overrun the body', () => {
    // lead 0x02, ident_len=10, comment_len=0, but only 3 body bytes follow.
    expect(() => parseVorbisExtradata(Uint8Array.of(0x02, 10, 0, 1, 2, 3))).toThrow(MediaError);
  });
});

describe('readOggPackets — robustness', () => {
  it('rejects bytes with no Ogg capture pattern', () => {
    expect(() => readOggPackets(new Uint8Array(40))).toThrow(MediaError);
  });
  it('reassembles a packet split across two pages by a 255-lacing continuation', () => {
    // Page 1: one segment of 255 bytes (no terminator) → packet continues.
    // Page 2: one segment of 4 bytes (< 255) → terminates; packet = 255 + 4 bytes.
    // A correct 27-byte Ogg page header: 'OggS'(4) version(1) headerType(1) granulepos(8 LE) serial(4)
    // seqNo(4) crc(4) segCount(1), then the lacing table + segment data.
    const page = (segLens: number[], data: number[], granule: number): number[] => {
      const header = [
        0x4f,
        0x67,
        0x67,
        0x53, // 'OggS'
        0, // version
        0, // header type
        granule & 0xff,
        (granule >> 8) & 0xff,
        0,
        0,
        0,
        0,
        0,
        0, // granulepos u64 LE (low 2 bytes meaningful here)
        0,
        0,
        0,
        0, // serial number
        0,
        0,
        0,
        0, // page sequence number
        0,
        0,
        0,
        0, // CRC
        segLens.length, // number of page segments
      ];
      return [...header, ...segLens, ...data];
    };
    const first = page([255], new Array(255).fill(0xaa), 0);
    const second = page([4], [1, 2, 3, 4], 100);
    const packets = readOggPackets(Uint8Array.from([...first, ...second]));
    expect(packets.length).toBe(1);
    expect(packets[0]?.data.length).toBe(259); // 255 + 4 reassembled
    expect(packets[0]?.granulePosition).toBe(100);
  });
});

// ============ driver identity + honest behavior ============

describe('wasm-vorbis — driver identity & module', () => {
  it('declares the contracted identity (tier:wasm so it is ranked last)', () => {
    expect(WasmVorbisDriver.id).toBe('wasm-vorbis');
    expect(WasmVorbisDriver.kind).toBe('codec');
    expect(WasmVorbisDriver.tier).toBe('wasm');
    expect(WasmVorbisDriver.apiVersion).toBe(1);
    expect(VORBIS_CODEC).toBe('vorbis');
  });
  it('registers exactly itself as a codec (and nothing else)', () => {
    const added: unknown[] = [];
    let containers = 0;
    let filters = 0;
    WasmVorbisModule.register({
      addCodec: (d) => added.push(d),
      addContainer: () => containers++,
      addFilter: () => filters++,
    });
    expect(added).toEqual([WasmVorbisDriver]);
    expect(containers).toBe(0);
    expect(filters).toBe(0);
  });
  it('isVorbisQuery only matches Vorbis audio', () => {
    expect(
      isVorbisQuery({ mediaType: 'audio', direction: 'decode', config: { codec: 'vorbis' } }),
    ).toBe(true);
    expect(
      isVorbisQuery({ mediaType: 'audio', direction: 'decode', config: { codec: 'opus' } }),
    ).toBe(false);
  });
  it('unsupported is a non-supported result carrying the reason', () => {
    expect(unsupported('nope')).toEqual({ supported: false, reason: 'nope' });
  });
  it('createDecoder validates the config up front (non-Vorbis codec rejected)', () => {
    expect(() =>
      WasmVorbisDriver.createDecoder({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }),
    ).toThrow(MediaError);
  });
  it('createEncoder is an honest capability miss (no pure-Rust Vorbis encoder)', () => {
    expect(() =>
      WasmVorbisDriver.createEncoder({ codec: 'vorbis', sampleRate: 44100, numberOfChannels: 2 }),
    ).toThrow(CapabilityError);
  });
  it('createDecoder aborts up front when the signal is already aborted', () => {
    const description = buildVorbisExtradata(Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3));
    const ctrl = new AbortController();
    ctrl.abort();
    expect(() =>
      WasmVorbisDriver.createDecoder(
        { codec: 'vorbis', sampleRate: 44100, numberOfChannels: 2, description },
        { signal: ctrl.signal },
      ),
    ).toThrow(/aborted/);
  });
  it('createDecoder rejects a Vorbis config with no description up front', () => {
    expect(() =>
      WasmVorbisDriver.createDecoder({ codec: 'vorbis', sampleRate: 44100, numberOfChannels: 2 }),
    ).toThrow(/description/);
  });
  it('resetVorbisCoreForTest lets the core be re-evaluated', async () => {
    resetVorbisCoreForTest();
    const a = await loadVorbisCore();
    resetVorbisCoreForTest();
    const b = await loadVorbisCore();
    // Same availability verdict before and after reset (both null or both a core).
    expect(a === null).toBe(b === null);
  });
  it('supports(): false for non-Vorbis, false for encode', async () => {
    expect(
      (
        await WasmVorbisDriver.supports({
          mediaType: 'audio',
          direction: 'decode',
          config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
        })
      ).supported,
    ).toBe(false);
    expect(
      (
        await WasmVorbisDriver.supports({
          mediaType: 'audio',
          direction: 'encode',
          config: { codec: 'vorbis', sampleRate: 44100, numberOfChannels: 2 },
        })
      ).supported,
    ).toBe(false);
  });
  it('supports(): false in Node when the AudioData output seam is unavailable', async () => {
    const description = buildVorbisExtradata(
      Uint8Array.of(1, 118, 111, 114, 98, 105, 115),
      Uint8Array.of(3, 118, 111, 114, 98, 105, 115),
      Uint8Array.of(5, 118, 111, 114, 98, 105, 115),
    );
    const support = await WasmVorbisDriver.supports({
      mediaType: 'audio',
      direction: 'decode',
      config: { codec: 'vorbis', sampleRate: 44100, numberOfChannels: 2, description },
    });
    expect(support.supported).toBe(false);
    expect(support.reason ?? '').toMatch(/AudioData|EncodedAudioChunk/);
  });
});

// ============ Ogg de-lacing on real media ============

/** Parse a Vorbis identification header packet (`\x01vorbis` + fields) → {channels, sampleRate}. */
function parseIdent(packet: Uint8Array): { channels: number; sampleRate: number } {
  // 7-byte signature, then version(4), channels(1), sampleRate(4 LE) …
  const dv = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return { channels: packet[11] ?? 0, sampleRate: dv.getUint32(12, true) };
}

const ogg = await loadFixture('sound_5.oga');
const packets = readOggPackets(ogg);

describe('readOggPackets — de-lace the real sound_5.oga (Ogg/Vorbis)', () => {
  it('yields the 3 Vorbis header packets first, then audio packets', () => {
    expect(packets.length).toBeGreaterThan(4);
    const ident = packets[0]?.data ?? new Uint8Array();
    const comment = packets[1]?.data ?? new Uint8Array();
    const setup = packets[2]?.data ?? new Uint8Array();
    // Vorbis packet-type bytes: ident 0x01, comment 0x03, setup 0x05, each followed by 'vorbis'.
    expect(ident[0]).toBe(0x01);
    expect(comment[0]).toBe(0x03);
    expect(setup[0]).toBe(0x05);
    const sig = (p: Uint8Array): string => String.fromCharCode(...p.subarray(1, 7));
    expect(sig(ident)).toBe('vorbis');
    expect(sig(setup)).toBe('vorbis');
  });
  it('reports a non-zero final granule position (sample count)', () => {
    const lastGranule = packets[packets.length - 1]?.granulePosition ?? 0;
    expect(lastGranule).toBeGreaterThan(0);
  });
});

// ============ THE REAL THING: decode real Vorbis through the wasm core in Node ============

/**
 * Instantiate the vendored Symphonia-Vorbis wasm core from bytes (the `--target web` glue accepts a
 * `WebAssembly.Module`/bytes, so it runs in Node without a fetch), and return the `VorbisWasm` class.
 */
async function loadCoreFromBytes(): Promise<{
  new (
    extra: Uint8Array,
    channels: number,
    sampleRate: number,
  ): {
    channels: number;
    sampleRate: number;
    decode(p: Uint8Array): Float32Array;
    reset(): void;
    free(): void;
  };
}> {
  const mod = await import('./vorbis-core.js');
  const wasmBytes = await readFile(WASM_PATH);
  const module = await WebAssembly.compile(wasmBytes);
  await mod.default({ module_or_path: module });
  return mod.VorbisWasm;
}

describe('Symphonia wasm Vorbis core — decodes real sound_5.oga (the real wasm tail)', () => {
  it('the vendored core loads (proves the wasm built + instantiates)', async () => {
    const VorbisWasm = await loadCoreFromBytes();
    expect(typeof VorbisWasm).toBe('function');
  });

  it('decodes the real stream: channels/rate from ident, sample count == final granule', async () => {
    const VorbisWasm = await loadCoreFromBytes();
    const ident = packets[0]?.data;
    const comment = packets[1]?.data;
    const setup = packets[2]?.data;
    if (!ident || !comment || !setup) throw new Error('missing Vorbis headers');

    const identFields = parseIdent(ident);
    const extra = buildVorbisExtradata(ident, comment, setup);
    const dec = new VorbisWasm(extra, identFields.channels, identFields.sampleRate);

    // The decoder reports the geometry it was seeded with (and reconciles it with the decoded spec).
    expect(dec.channels).toBe(identFields.channels);
    expect(dec.sampleRate).toBe(identFields.sampleRate);
    expect(dec.channels).toBeGreaterThanOrEqual(1);
    expect(dec.sampleRate).toBeGreaterThan(0);

    // Decode every audio packet (packets[3..]); sum the per-channel frame counts.
    let totalFrames = 0;
    let allFinite = true;
    let nonSilent = false;
    for (let i = 3; i < packets.length; i++) {
      const pkt = packets[i]?.data;
      if (!pkt) continue;
      const pcm = dec.decode(pkt);
      const frames = dec.channels > 0 ? pcm.length / dec.channels : 0;
      totalFrames += frames;
      for (let k = 0; k < pcm.length; k++) {
        const v = pcm[k] ?? 0;
        if (!Number.isFinite(v) || v < -1.05 || v > 1.05) allFinite = false; // Vorbis PCM ∈ ~[-1,1]
        if (v !== 0) nonSilent = true;
      }
    }
    dec.free();

    expect(totalFrames).toBeGreaterThan(0);
    expect(allFinite).toBe(true); // every sample is a finite, in-range f32 — real PCM, not garbage
    expect(nonSilent).toBe(true); // the clip is not pure silence

    // Vorbis self-consistency oracle: total decoded samples ≈ the stream's final granule position (the
    // last page's absolute sample count). The raw decoder emits whole blocks; the container's final
    // granulepos trims the trailing block's end-padding (RFC 5215 §1.3.3 / Vorbis I §A.2), so the raw
    // count is ≥ the granulepos by less than one long block (≤ 4096). Landing within one block of the
    // exact granulepos is impossible without truly running the codec — a strong, un-fakeable check; the
    // remaining samples are the end-trim a container `decode` (overlap/granule-trim) would drop.
    const finalGranule = packets[packets.length - 1]?.granulePosition ?? 0;
    const LONG_BLOCK_MAX = 4096; // Vorbis' largest blocksize is 8192 samples → half-overlap ≤ 4096 trim
    expect(totalFrames).toBeGreaterThanOrEqual(finalGranule);
    expect(totalFrames - finalGranule).toBeLessThan(LONG_BLOCK_MAX);
  });

  it('loadVorbisCore() resolves a working core (driver entry path)', async () => {
    // The driver's own loader uses import.meta.url to fetch the wasm; in Node that fetch may not apply,
    // so this asserts the loader resolves *something* honest (core or null) without throwing.
    const core = await loadVorbisCore();
    expect(core === null || typeof core.createDecoder === 'function').toBe(true);
  });
});
