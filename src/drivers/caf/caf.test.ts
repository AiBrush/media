/**
 * CAF (Apple Core Audio Format) container driver — structural + bit-exact oracle on REAL media
 * (BUILD_INSTRUCTIONS §6.1).
 *
 * Subject media: small **real Apple-native** CAFs produced by macOS `afconvert` from a corpus WAV
 * (`fixtures/media-derived/aiff-caf/`, provenance in that dir's README) covering both little-endian
 * (Apple default) and big-endian `lpcm`; plus the larger real harness CAF (`pcm_s16.caf`) read by direct
 * path, whose `*.meta.json` golden is the independent ground truth. The oracle is **can-fail**: probe
 * metadata (container/codec token/rate/channels/bit-depth/duration) is checked against `afinfo`/golden,
 * and the `data` samples survive a decode→re-encode round-trip **byte-exact**. The `data` locator below
 * is independent of the code under test (anti-cheat).
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { channelAt } from '../../dsp/pcm.ts';
import { CafDriver, CafModule } from './caf-driver.ts';
import { cafCodec, parseCaf, readCafPcm, writeCaf } from './caf.ts';

const DERIVED = new URL('../../../fixtures/media-derived/aiff-caf/', import.meta.url).pathname;
const MEDIA_TEST = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;

const loadDerived = async (n: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(`${DERIVED}${n}`));
const loadHarness = async (n: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(`${MEDIA_TEST}${n}`));

/** Independent CAF `data`-chunk sample locator — the byte-exact oracle must not use the code under test. */
function cafDataSamples(b: Uint8Array): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8; // caff + version + flags
  while (pos + 12 <= b.byteLength) {
    const id = String.fromCharCode(b[pos] ?? 0, b[pos + 1] ?? 0, b[pos + 2] ?? 0, b[pos + 3] ?? 0);
    const size = Number(dv.getBigInt64(pos + 4));
    if (id === 'data') {
      const start = pos + 12 + 4; // mEditCount (u32)
      const end = size < 0 ? b.byteLength : pos + 12 + size;
      return b.subarray(start, end);
    }
    if (size < 0) break;
    pos += 12 + size;
  }
  throw new Error('no data chunk');
}

interface CafGolden {
  id: string;
  load: (n: string) => Promise<Uint8Array>;
  codec: string;
  endian: 'le' | 'be';
  sampleRate: number;
  channels: number;
  bitsPerChannel: number;
  durationSec: number;
}

// afinfo / harness *.meta.json ground truth for each real file.
const CAFS: readonly CafGolden[] = [
  {
    id: 'sfx.caf',
    load: loadDerived,
    codec: 'pcm-s16',
    endian: 'le',
    sampleRate: 48000,
    channels: 1,
    bitsPerChannel: 16,
    durationSec: 10240 / 48000,
  },
  {
    id: 'sfx-be.caf',
    load: loadDerived,
    codec: 'pcm-s16be',
    endian: 'be',
    sampleRate: 48000,
    channels: 1,
    bitsPerChannel: 16,
    durationSec: 10240 / 48000,
  },
  {
    id: 'sfx-f32.caf',
    load: loadDerived,
    codec: 'pcm-f32',
    endian: 'le',
    sampleRate: 48000,
    channels: 1,
    bitsPerChannel: 32,
    durationSec: 10240 / 48000,
  },
  // Larger real harness CAF (stereo, 5 s) — same provenance as pcm_s16.caf.meta.json (codec pcm-s16).
  {
    id: 'pcm_s16.caf',
    load: loadHarness,
    codec: 'pcm-s16',
    endian: 'le',
    sampleRate: 48000,
    channels: 2,
    bitsPerChannel: 16,
    durationSec: 5,
  },
];

describe('CafDriver.supports', () => {
  it('recognizes caff magic, mime, and extension; rejects others', async () => {
    const head = (await loadDerived('sfx.caf')).subarray(0, 16);
    expect(CafDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(CafDriver.supports({ direction: 'demux', mime: 'audio/x-caf' })).toBe(true);
    expect(CafDriver.supports({ direction: 'demux', extension: 'caf' })).toBe(true);
    expect(CafDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(CafDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('parseCaf — real CAF metadata matches afinfo/meta-golden ground truth', () => {
  for (const c of CAFS) {
    it(`${c.id}: ${c.codec} ${c.channels}ch ${c.sampleRate}Hz ${c.bitsPerChannel}-bit (${c.endian})`, async () => {
      const info = parseCaf(await c.load(c.id));
      expect(info.container).toBe('caf');
      expect(info.codec).toBe(c.codec);
      expect(info.sampleRate).toBe(c.sampleRate);
      expect(info.channels).toBe(c.channels);
      expect(info.bitsPerChannel).toBe(c.bitsPerChannel);
      expect(info.durationSec).toBeCloseTo(c.durationSec, 5);
    });
  }
});

describe('CafDriver.demux — TrackInfo + audio-dsp seam', () => {
  for (const c of CAFS) {
    it(`${c.id}: one audio track; packets() is the typed audio-dsp gap`, async () => {
      const demuxed = await CafDriver.demux(bytesSource(await c.load(c.id)));
      expect(demuxed.tracks).toHaveLength(1);
      const t = demuxed.tracks[0];
      expect(t?.mediaType).toBe('audio');
      expect(t?.codec).toBe(c.codec);
      expect(t?.durationSec).toBeCloseTo(c.durationSec, 5);
      expect(t?.config as AudioDecoderConfig).toMatchObject({
        codec: c.codec,
        sampleRate: c.sampleRate,
        numberOfChannels: c.channels,
      });
      expect(() => demuxed.packets(0)).toThrowError(CapabilityError);
      await demuxed.close();
    });
  }

  it('demuxes a non-seekable stream source (no range) by reading to EOF', async () => {
    const bytes = await loadDerived('sfx.caf');
    const demuxed = await CafDriver.demux({ stream: () => streamOf(bytes) });
    expect(demuxed.tracks[0]?.codec).toBe('pcm-s16');
    expect(demuxed.tracks[0]?.durationSec).toBeCloseTo(10240 / 48000, 5);
  });

  it('createMuxer is a typed mux miss (PCM goes through transformPcm)', () => {
    expect(() => CafDriver.createMuxer()).toThrowError(MediaError);
  });
});

describe('readCafPcm / writeCaf — byte-exact data round-trip on real CAF (decoded-audio-pcm oracle)', () => {
  for (const c of CAFS) {
    it(`${c.id}: re-encoding reproduces the source data samples byte-for-byte`, async () => {
      const file = await c.load(c.id);
      const pcm = readCafPcm(file);
      expect(pcm.endian).toBe(c.endian);
      expect(pcm.channels).toBe(c.channels);
      expect(pcm.frames).toBe(Math.round(c.durationSec * c.sampleRate));
      const re = writeCaf(pcm, pcm.format, pcm.endian);
      expect(cafDataSamples(re)).toEqual(cafDataSamples(file));
      const reprobe = parseCaf(re);
      expect(reprobe.codec).toBe(c.codec);
      expect(reprobe.sampleRate).toBe(c.sampleRate);
      expect(reprobe.channels).toBe(c.channels);
      expect(reprobe.frames).toBe(pcm.frames);
    });
  }

  it('a -1 ("to EOF") data size is read as the rest of the file', () => {
    // Build a CAF whose data chunk declares size -1 (legal for the final chunk).
    const pcm = readCafPcmFromValues([0.0, 0.5, -0.5, 0.25], 8000);
    const file = writeCaf(pcm, 's16', 'le');
    const dv = new DataView(file.buffer);
    // Find the data chunk and overwrite its size with -1.
    let pos = 8;
    while (pos + 12 <= file.byteLength) {
      const id = String.fromCharCode(
        file[pos] ?? 0,
        file[pos + 1] ?? 0,
        file[pos + 2] ?? 0,
        file[pos + 3] ?? 0,
      );
      const size = Number(dv.getBigInt64(pos + 4));
      if (id === 'data') {
        dv.setBigInt64(pos + 4, -1n);
        break;
      }
      pos += 12 + size;
    }
    const info = parseCaf(file);
    expect(info.frames).toBe(4);
  });
});

describe('CafDriver.transformPcm — PCM-native audio-dsp path (ADR-022)', () => {
  it('identity transform preserves the data samples byte-exact', async () => {
    const file = await loadDerived('sfx.caf');
    const out = await drain(await transform(file));
    expect(cafDataSamples(out)).toEqual(cafDataSamples(file));
  });

  it('applies gain in the PCM domain (≈ ×0.5 at -6.02 dB) and stays CAF/LE', async () => {
    const file = await loadDerived('sfx.caf');
    const plain = readCafPcm(await drain(await transform(file)));
    const quieter = readCafPcm(await drain(await transform(file, { gainDb: -6.020599913279624 })));
    expect(peak(channelAt(quieter.planar, 0))).toBeCloseTo(
      peak(channelAt(plain.planar, 0)) * 0.5,
      2,
    );
    const re = parseCaf(await drain(await transform(file, { gainDb: -6 })));
    expect(re.container).toBe('caf');
    expect(re.codec).toBe('pcm-s16'); // endianness preserved (LE)
  });

  it('remixes mono → stereo and re-serializes valid CAF', async () => {
    const out = await drain(await transform(await loadDerived('sfx.caf'), { channels: 2 }));
    const info = parseCaf(out);
    expect(info.channels).toBe(2);
    expect(info.frames).toBe(10240);
  });

  it('resamples 48000 → 24000 Hz in pure TS (ADR-022) — half the frames', async () => {
    const out = await drain(await transform(await loadDerived('sfx.caf'), { sampleRate: 24000 }));
    const info = parseCaf(out);
    expect(info.sampleRate).toBe(24000);
    expect(info.frames).toBeCloseTo(5120, -1);
  });

  it('honors an already-aborted signal', async () => {
    await expect(
      transform(await loadDerived('sfx.caf'), { signal: AbortSignal.abort() }),
    ).rejects.toThrowError(/abort/i);
  });
});

describe('convert(→ caf) end-to-end through the engine (CONTAINER_TOKENS + PCM route)', () => {
  it('CAF → CAF round-trips: re-probes to the same layout and the data samples are bit-exact', async () => {
    const file = await loadDerived('sfx.caf');
    const media = createMedia();
    const out = await media.convert(media.from(file, { mime: 'audio/x-caf' }), { to: 'caf' });
    const bytes = new Uint8Array(await (out as Blob).arrayBuffer());
    const info = await media.probe(media.from(bytes, { mime: 'audio/x-caf' }));
    expect(info.container).toBe('caf');
    expect(info.tracks[0]?.codec).toBe('pcm-s16'); // little-endian preserved (no `be` suffix)
    expect(info.tracks[0]?.sampleRate).toBe(48000);
    expect(info.tracks[0]?.channels).toBe(1);
    expect(info.durationSec).toBeCloseTo(10240 / 48000, 5);
    expect(cafDataSamples(bytes)).toEqual(cafDataSamples(file));
  });

  it('downmix via the PCM route: convert(→ caf, {channels:2}) up-mixes mono → stereo', async () => {
    const file = await loadDerived('sfx.caf'); // mono source
    const media = createMedia();
    const out = await media.convert(media.from(file, { mime: 'audio/x-caf' }), {
      to: 'caf',
      audio: { channels: 2 },
    });
    const info = await media.probe(
      media.from(new Uint8Array(await (out as Blob).arrayBuffer()), { mime: 'audio/x-caf' }),
    );
    expect(info.container).toBe('caf');
    expect(info.tracks[0]?.channels).toBe(2);
  });
});

describe('cafCodec — harness codec-token vocabulary', () => {
  it('little-endian ints have no suffix; big-endian ints carry be; floats are pcm-fN', () => {
    expect(cafCodec('s16', 'le')).toBe('pcm-s16');
    expect(cafCodec('s24', 'le')).toBe('pcm-s24');
    expect(cafCodec('s16', 'be')).toBe('pcm-s16be');
    expect(cafCodec('u8', 'le')).toBe('pcm-u8');
    expect(cafCodec('f32', 'le')).toBe('pcm-f32');
    expect(cafCodec('f64', 'be')).toBe('pcm-f64');
  });
});

describe('parseCaf — robustness on crafted-bad inputs (graceful-failure oracle)', () => {
  it('rejects a non-CAF file', () => {
    expect(() => parseCaf(new Uint8Array(64))).toThrowError(InputError);
  });

  it('rejects a caff with no desc chunk', () => {
    const file = caff([cafChunk('data', new Uint8Array(8))]);
    expect(() => parseCaf(file)).toThrowError(/desc/);
  });

  it('rejects a truncated desc chunk', () => {
    const file = caff([cafChunk('desc', new Uint8Array(16))]); // ASBD needs 32 bytes
    expect(() => parseCaf(file)).toThrowError(/desc/);
  });

  it('reports an honest CapabilityError for a non-PCM format id (e.g. aac )', () => {
    const file = caff([
      cafChunk('desc', desc('aac ', 0, 16, 2)),
      cafChunk('data', new Uint8Array(8)),
    ]); // prettier-ignore
    expect(() => parseCaf(file)).toThrowError(CapabilityError);
  });

  it('reports an honest CapabilityError for real signed 8-bit CAF (afconvert I8) PCM', async () => {
    // sfx-u8.caf is a genuine Apple-native 8-bit lpcm CAF; its samples are signed (afinfo: "8-bit signed
    // integer"), which the offset-binary `u8` cannot represent — so it is a typed miss, never a wrong
    // (128-off) decode. Round-tripping it as `u8` would silently corrupt the waveform.
    await expect(
      CafDriver.demux(bytesSource(await loadDerived('sfx-u8.caf'))),
    ).rejects.toThrowError(CapabilityError);
  });

  it('decodes lpcm at 24-bit and 32-bit integer depths', () => {
    for (const bits of [24, 32]) {
      const frame = new Uint8Array(bits / 8);
      const file = caff([
        cafChunk('desc', desc('lpcm', 0x2, bits, 1)),
        cafChunk('data', new Uint8Array([0, 0, 0, 0, ...frame])),
      ]); // prettier-ignore
      const info = parseCaf(file);
      expect(info.bitsPerChannel).toBe(bits);
      expect(info.codec).toBe(bits === 24 ? 'pcm-s24' : 'pcm-s32');
    }
  });

  it('rejects an unsupported lpcm integer depth (e.g. 20-bit) and a bad float depth', () => {
    const i20 = caff([
      cafChunk('desc', desc('lpcm', 0x2, 20, 1)),
      cafChunk('data', new Uint8Array(8)),
    ]); // prettier-ignore
    expect(() => parseCaf(i20)).toThrowError(/depth/);
    const f16 = caff([
      cafChunk('desc', desc('lpcm', 0x3, 16, 1)),
      cafChunk('data', new Uint8Array(8)),
    ]); // float flag + 16-bit // prettier-ignore
    expect(() => parseCaf(f16)).toThrowError(/float depth/);
  });
});

describe('CafModule', () => {
  it('default-exports a DriverModule that registers the container', () => {
    expect(CafModule.apiVersion).toBe(CafDriver.apiVersion);
    let registered: unknown;
    CafModule.register({
      addContainer: (d) => {
        registered = d;
      },
      addCodec: () => {},
      addFilter: () => {},
    });
    expect(registered).toBe(CafDriver);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

function readCafPcmFromValues(values: number[], sampleRate: number) {
  return {
    sampleRate,
    channels: 1,
    frames: values.length,
    planar: [Float64Array.from(values)],
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function bytesSource(bytes: Uint8Array): {
  stream: () => ReadableStream<Uint8Array>;
  size: number;
  range: (s: number, e: number) => Promise<Uint8Array>;
} {
  return {
    stream: () => streamOf(bytes),
    size: bytes.byteLength,
    range: (s, e) => Promise.resolve(bytes.subarray(s, e)),
  };
}

async function transform(
  bytes: Uint8Array,
  o?: Parameters<NonNullable<typeof CafDriver.transformPcm>>[1],
): Promise<ReadableStream<Uint8Array>> {
  const fn = CafDriver.transformPcm;
  if (!fn) throw new Error('CafDriver must expose transformPcm');
  return fn(bytesSource(bytes), o);
}

async function drain(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = s.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of parts) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function peak(ch: Float64Array): number {
  let m = 0;
  for (const s of ch) m = Math.max(m, Math.abs(s));
  return m;
}

// ── crafted-CAF builders (test-only) ───────────────────────────────────────────────────────────────
/** A 32-byte ASBD `desc` body with the given format id, flags, bit depth, and channel count. */
function desc(formatId: string, flags: number, bits: number, channels: number): Uint8Array {
  const body = new Uint8Array(32);
  const dv = new DataView(body.buffer);
  dv.setFloat64(0, 48000);
  for (let i = 0; i < 4; i++) dv.setUint8(8 + i, formatId.charCodeAt(i));
  dv.setUint32(12, flags);
  dv.setUint32(16, channels * (bits >> 3)); // bytesPerPacket
  dv.setUint32(20, 1); // framesPerPacket
  dv.setUint32(24, channels);
  dv.setUint32(28, bits);
  return body;
}
function cafChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) dv.setUint8(i, type.charCodeAt(i));
  dv.setBigInt64(4, BigInt(body.byteLength));
  out.set(body, 12);
  return out;
}
function caff(chunks: Uint8Array[]): Uint8Array {
  const bodyLen = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(8 + bodyLen);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) dv.setUint8(i, 'caff'.charCodeAt(i));
  dv.setUint16(4, 1); // version
  dv.setUint16(6, 0); // flags
  let pos = 8;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}
