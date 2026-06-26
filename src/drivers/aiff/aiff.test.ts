/**
 * AIFF / AIFF-C container driver — structural + bit-exact oracle on REAL media (BUILD_INSTRUCTIONS §6.1).
 *
 * Subject media: small **real Apple-native** files produced by macOS `afconvert` from a corpus WAV
 * (`fixtures/media-derived/aiff-caf/`, provenance in that dir's README) spanning AIFF BE int16/int24 and
 * AIFF-C `fl32`/`twos`; plus the larger real harness AIFF assets read by direct path. The oracle is
 * **can-fail**: probe metadata (container/codec token/rate/channels/bit-depth/duration) is checked
 * against `afinfo` ground truth (and the harness `*.meta.json` goldens), and the SSND samples survive a
 * decode→re-encode round-trip **byte-exact**. The SSND locator below is independent of the code under
 * test (anti-cheat), and an AIFF↔CAF cross-endian check confirms both byte orders decode identically.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { channelAt } from '../../dsp/pcm.ts';
import { readCafPcm } from '../caf/caf.ts';
import { AiffDriver, AiffModule } from './aiff-driver.ts';
import {
  type AiffKind,
  aiffCodec,
  parseAiff,
  readAiffPcm,
  readExtendedFloat80,
  writeAiff,
  writeExtendedFloat80,
} from './aiff.ts';

const DERIVED = new URL('../../../fixtures/media-derived/aiff-caf/', import.meta.url).pathname;
// The sibling acceptance corpus holds the larger real AIFFs (not in this project's fetch manifest).
const MEDIA_TEST = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;

const loadDerived = async (n: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(`${DERIVED}${n}`));
const loadHarness = async (n: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(`${MEDIA_TEST}${n}`));

/** Independent SSND sample-byte locator — the byte-exact oracle must not depend on the code under test. */
function ssndSamples(b: Uint8Array): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 12; // FORM + size + formType
  while (pos + 8 <= b.byteLength) {
    const id = String.fromCharCode(b[pos] ?? 0, b[pos + 1] ?? 0, b[pos + 2] ?? 0, b[pos + 3] ?? 0);
    const size = dv.getUint32(pos + 4);
    if (id === 'SSND') {
      const offset = dv.getUint32(pos + 8); // alignment bytes before the first sample
      return b.subarray(pos + 8 + 8 + offset, pos + 8 + size);
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('no SSND chunk');
}

interface AiffGolden {
  id: string;
  load: (n: string) => Promise<Uint8Array>;
  kind: AiffKind;
  codec: string;
  sampleRate: number;
  channels: number;
  sampleSize: number;
  durationSec: number;
}

// afinfo ground truth (`afinfo <file>`): rate/channels/bit-depth/duration for each real file.
const AIFFS: readonly AiffGolden[] = [
  // Apple-native, small (fixtures/media-derived/aiff-caf/) — derived from the corpus sfx-pcm-s16.wav.
  {
    id: 'sfx.aiff',
    load: loadDerived,
    kind: 'aiff',
    codec: 'pcm-s16be',
    sampleRate: 48000,
    channels: 1,
    sampleSize: 16,
    durationSec: 10240 / 48000,
  },
  {
    id: 'sfx-s24.aiff',
    load: loadDerived,
    kind: 'aiff',
    codec: 'pcm-s24be',
    sampleRate: 48000,
    channels: 1,
    sampleSize: 24,
    durationSec: 10240 / 48000,
  },
  {
    id: 'sfx-fl32.aifc',
    load: loadDerived,
    kind: 'aifc',
    codec: 'pcm-f32',
    sampleRate: 48000,
    channels: 1,
    sampleSize: 32,
    durationSec: 10240 / 48000,
  },
  {
    id: 'sfx-twos.aifc',
    load: loadDerived,
    kind: 'aifc',
    codec: 'pcm-s16be',
    sampleRate: 48000,
    channels: 1,
    sampleSize: 16,
    durationSec: 10240 / 48000,
  },
  // Larger real harness AIFFs (stereo, 5 s) — same provenance as the harness *.meta.json goldens.
  {
    id: 'pcm_s16be.aiff',
    load: loadHarness,
    kind: 'aiff',
    codec: 'pcm-s16be',
    sampleRate: 48000,
    channels: 2,
    sampleSize: 16,
    durationSec: 5,
  },
  {
    id: 'pcm_s24be.aiff',
    load: loadHarness,
    kind: 'aiff',
    codec: 'pcm-s24be',
    sampleRate: 48000,
    channels: 2,
    sampleSize: 24,
    durationSec: 5,
  },
];

describe('AiffDriver.supports', () => {
  it('recognizes FORM…AIFF/AIFC magic, mime, and extension; rejects others', async () => {
    const head = (await loadDerived('sfx.aiff')).subarray(0, 16);
    expect(AiffDriver.supports({ direction: 'demux', head })).toBe(true);
    const aifc = (await loadDerived('sfx-fl32.aifc')).subarray(0, 16);
    expect(AiffDriver.supports({ direction: 'demux', head: aifc })).toBe(true);
    expect(AiffDriver.supports({ direction: 'demux', mime: 'audio/aiff' })).toBe(true);
    expect(AiffDriver.supports({ direction: 'demux', extension: 'aifc' })).toBe(true);
    expect(AiffDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(AiffDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('parseAiff — real AIFF/AIFF-C metadata matches afinfo ground truth', () => {
  for (const a of AIFFS) {
    it(`${a.id}: ${a.codec} ${a.channels}ch ${a.sampleRate}Hz ${a.sampleSize}-bit ${a.kind}`, async () => {
      const info = parseAiff(await a.load(a.id));
      expect(info.container).toBe('aiff');
      expect(info.kind).toBe(a.kind);
      expect(info.codec).toBe(a.codec);
      expect(info.sampleRate).toBe(a.sampleRate);
      expect(info.channels).toBe(a.channels);
      expect(info.sampleSize).toBe(a.sampleSize);
      expect(info.durationSec).toBeCloseTo(a.durationSec, 5);
    });
  }
});

describe('AiffDriver.demux — TrackInfo + audio-dsp seam', () => {
  for (const a of AIFFS) {
    it(`${a.id}: one audio track; packets() is the typed audio-dsp gap`, async () => {
      const demuxed = await AiffDriver.demux(bytesSource(await a.load(a.id)));
      expect(demuxed.tracks).toHaveLength(1);
      const t = demuxed.tracks[0];
      expect(t?.mediaType).toBe('audio');
      expect(t?.codec).toBe(a.codec);
      expect(t?.durationSec).toBeCloseTo(a.durationSec, 5);
      expect(t?.config as AudioDecoderConfig).toMatchObject({
        codec: a.codec,
        sampleRate: a.sampleRate,
        numberOfChannels: a.channels,
      });
      expect(() => demuxed.packets(0)).toThrowError(CapabilityError);
      await demuxed.close();
    });
  }

  it('demuxes a non-seekable stream source (no range) — reads the head from the first chunk', async () => {
    const bytes = await loadDerived('sfx.aiff');
    const demuxed = await AiffDriver.demux({ stream: () => streamOf(bytes) });
    expect(demuxed.tracks[0]?.codec).toBe('pcm-s16be');
    expect(demuxed.tracks[0]?.durationSec).toBeCloseTo(10240 / 48000, 5);
  });

  it('createMuxer is a typed mux miss (PCM goes through transformPcm)', () => {
    expect(() => AiffDriver.createMuxer()).toThrowError(MediaError);
  });
});

describe('readAiffPcm / writeAiff — byte-exact SSND round-trip on real AIFF (decoded-audio-pcm oracle)', () => {
  for (const a of AIFFS) {
    it(`${a.id}: re-encoding reproduces the source SSND samples byte-for-byte`, async () => {
      const file = await a.load(a.id);
      const pcm = readAiffPcm(file);
      expect(pcm.channels).toBe(a.channels);
      expect(pcm.frames).toBe(Math.round(a.durationSec * a.sampleRate));
      const re = writeAiff(pcm, pcm.format, { kind: pcm.kind, endian: pcm.endian });
      expect(ssndSamples(re)).toEqual(ssndSamples(file));
      // The file we wrote must re-probe to the same metadata (independent of the original container).
      const reprobe = parseAiff(re);
      expect(reprobe.codec).toBe(a.codec);
      expect(reprobe.sampleRate).toBe(a.sampleRate);
      expect(reprobe.channels).toBe(a.channels);
      expect(reprobe.frames).toBe(pcm.frames);
    });
  }
});

describe('AIFF ↔ CAF cross-endian equivalence (same source, opposite byte order)', () => {
  it('AIFF(BE) sfx.aiff and CAF(LE) sfx.caf decode to identical planar samples', async () => {
    const aiff = readAiffPcm(await loadDerived('sfx.aiff'));
    const caf = readCafPcm(await loadDerived('sfx.caf'));
    expect(aiff.endian).toBe('be');
    expect(caf.endian).toBe('le');
    expect(aiff.frames).toBe(caf.frames);
    expect(aiff.channels).toBe(caf.channels);
    for (let c = 0; c < aiff.channels; c++) {
      expect(channelAt(aiff.planar, c)).toEqual(channelAt(caf.planar, c));
    }
  });
});

describe('AiffDriver.transformPcm — PCM-native audio-dsp path (ADR-022)', () => {
  it('identity transform preserves the SSND samples byte-exact', async () => {
    const file = await loadDerived('sfx.aiff');
    const out = await drain(await transform(file));
    expect(ssndSamples(out)).toEqual(ssndSamples(file));
  });

  it('applies gain in the PCM domain (≈ ×0.5 at -6.02 dB) and stays AIFF', async () => {
    const file = await loadDerived('sfx.aiff');
    const plain = readAiffPcm(await drain(await transform(file)));
    const quieter = readAiffPcm(await drain(await transform(file, { gainDb: -6.020599913279624 })));
    expect(peak(channelAt(quieter.planar, 0))).toBeCloseTo(
      peak(channelAt(plain.planar, 0)) * 0.5,
      2,
    );
    expect(parseAiff(await drain(await transform(file, { gainDb: -6 }))).container).toBe('aiff');
  });

  it('remixes mono → stereo (channel up-mix) and re-serializes valid AIFF', async () => {
    const out = await drain(await transform(await loadDerived('sfx.aiff'), { channels: 2 }));
    const info = parseAiff(out);
    expect(info.channels).toBe(2);
    expect(info.frames).toBe(10240);
  });

  it('resamples 48000 → 24000 Hz in pure TS (ADR-022) — half the frames', async () => {
    const out = await drain(await transform(await loadDerived('sfx.aiff'), { sampleRate: 24000 }));
    const info = parseAiff(out);
    expect(info.sampleRate).toBe(24000);
    expect(info.frames).toBeCloseTo(5120, -1); // 10240 @ 48k → ~5120 @ 24k
  });

  it('honors an already-aborted signal', async () => {
    await expect(
      transform(await loadDerived('sfx.aiff'), { signal: AbortSignal.abort() }),
    ).rejects.toThrowError(/abort/i);
  });

  it('transforms a non-seekable stream source (no range) — buffers chunks then re-serializes', async () => {
    const file = await loadDerived('sfx.aiff');
    const fn = AiffDriver.transformPcm;
    if (!fn) throw new Error('AiffDriver must expose transformPcm');
    const out = await drain(await fn({ stream: () => streamOf(file) }));
    expect(ssndSamples(out)).toEqual(ssndSamples(file)); // identity, byte-exact, via the stream path
  });
});

describe('convert(→ aiff) end-to-end through the engine (CONTAINER_TOKENS + PCM route)', () => {
  it('AIFF → AIFF round-trips: re-probes to the same layout and the SSND samples are bit-exact', async () => {
    const file = await loadDerived('sfx.aiff');
    const media = createMedia();
    const out = await media.convert(media.from(file, { mime: 'audio/aiff' }), { to: 'aiff' });
    const bytes = new Uint8Array(await (out as Blob).arrayBuffer());
    // The engine accepted the 'aiff' target (CONTAINER_TOKENS) and routed PCM through transformPcm.
    const info = await media.probe(media.from(bytes, { mime: 'audio/aiff' }));
    expect(info.container).toBe('aiff');
    expect(info.tracks[0]?.codec).toBe('pcm-s16be');
    expect(info.tracks[0]?.sampleRate).toBe(48000);
    expect(info.tracks[0]?.channels).toBe(1);
    expect(info.durationSec).toBeCloseTo(10240 / 48000, 5);
    // The audio is lossless: the re-serialized SSND samples equal the source's SSND samples byte-for-byte.
    expect(ssndSamples(bytes)).toEqual(ssndSamples(file));
  });

  it('downmix via the PCM route: convert(→ aiff, {channels:2}) up-mixes mono → stereo', async () => {
    const file = await loadDerived('sfx.aiff'); // mono source
    const media = createMedia();
    const out = await media.convert(media.from(file, { mime: 'audio/aiff' }), {
      to: 'aiff',
      audio: { channels: 2 },
    });
    const info = await media.probe(
      media.from(new Uint8Array(await (out as Blob).arrayBuffer()), { mime: 'audio/aiff' }),
    );
    expect(info.container).toBe('aiff');
    expect(info.tracks[0]?.channels).toBe(2);
  });
});

describe('readExtendedFloat80 / writeExtendedFloat80 — the 80-bit IEEE sample-rate field', () => {
  it('round-trips common sample rates exactly', () => {
    for (const rate of [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000, 192000]) {
      const dv = new DataView(writeExtendedFloat80(rate).buffer);
      expect(readExtendedFloat80(dv, 0)).toBe(rate);
    }
  });

  it('decodes the canonical 48000 Hz extended float (400e bb80 0000 0000 0000)', () => {
    const bytes = new Uint8Array([0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0]);
    expect(readExtendedFloat80(new DataView(bytes.buffer), 0)).toBe(48000);
  });

  it('maps 0 and non-finite to the all-zero extended (0.0)', () => {
    expect(Array.from(writeExtendedFloat80(0))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(readExtendedFloat80(new DataView(new ArrayBuffer(10)), 0)).toBe(0);
    expect(Array.from(writeExtendedFloat80(Number.POSITIVE_INFINITY))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]); // prettier-ignore
  });

  it('normalizes an out-of-[2^63,2^64) mantissa in both directions (round-trips 2^70)', () => {
    // A value ≥ 2^64 forces the down-normalize loop; 2^70 is exactly representable.
    const big = 2 ** 70;
    expect(readExtendedFloat80(new DataView(writeExtendedFloat80(big).buffer), 0)).toBe(big);
  });
});

describe('aiffCodec — harness codec-token vocabulary', () => {
  it('big-endian multi-byte ints carry a be suffix; 8-bit and floats do not', () => {
    expect(aiffCodec('s8', 'be')).toBe('pcm-s8');
    expect(aiffCodec('s8', 'le')).toBe('pcm-s8');
    expect(aiffCodec('s16', 'be')).toBe('pcm-s16be');
    expect(aiffCodec('s24', 'be')).toBe('pcm-s24be');
    expect(aiffCodec('s16', 'le')).toBe('pcm-s16'); // AIFF-C sowt
    expect(aiffCodec('f32', 'be')).toBe('pcm-f32');
    expect(aiffCodec('f64', 'be')).toBe('pcm-f64');
  });
});

describe('parseAiff — robustness on real-truncated + crafted-bad inputs (graceful-failure oracle)', () => {
  it('rejects the real truncated AIFF header (COMM cut mid-body) without crashing', async () => {
    // aiff_header_truncated.aiff is FORM…AIFF COMM 0012 then only 4 of 18 COMM bytes.
    const bytes = await loadHarness('aiff_header_truncated.aiff');
    expect(() => parseAiff(bytes)).toThrowError(MediaError);
  });

  it('rejects a non-AIFF file', () => {
    expect(() => parseAiff(new Uint8Array(64))).toThrowError(InputError);
  });

  it('rejects a FORM with no COMM chunk', () => {
    expect(() => parseAiff(form('AIFF', [chunk('SSND', new Uint8Array(16))]))).toThrowError(/COMM/);
  });

  it('rejects an AIFF-C COMM missing its compressionType', () => {
    // A plain-18-byte COMM under an AIFC formType: no room for the 4cc compressionType.
    expect(() => parseAiff(form('AIFC', [chunk('COMM', comm(1, 16, 48000))]))).toThrowError(
      /compressionType/,
    );
  });

  it('reports an honest CapabilityError for a non-PCM AIFF-C compression (e.g. ulaw)', () => {
    expect(() => parseAiff(form('AIFC', [chunk('COMM', comm(1, 16, 8000, 'ulaw'))]))).toThrowError(
      CapabilityError,
    );
  });

  it('parses signed 8-bit AIFF PCM and round-trips SSND bytes exactly', () => {
    const samples = Uint8Array.of(0x80, 0x00, 0x7f, 0x40);
    const ssnd = new Uint8Array(8 + samples.byteLength);
    ssnd.set(samples, 8);
    const file = form('AIFF', [chunk('COMM', comm(1, 8, 8000)), chunk('SSND', ssnd)]);
    const info = parseAiff(file);
    expect(info.codec).toBe('pcm-s8');
    expect(info.sampleSize).toBe(8);
    const pcm = readAiffPcm(file);
    expect(pcm.format).toBe('s8');
    const re = writeAiff(pcm, pcm.format, { kind: pcm.kind, endian: pcm.endian });
    expect(ssndSamples(re)).toEqual(samples);
  });

  it('rejects an unsupported AIFF integer sample size (e.g. 64-bit int)', () => {
    // Plain AIFF (compression NONE) with a 64-bit sampleSize: no integer SampleFormat is that wide.
    expect(() => parseAiff(form('AIFF', [chunk('COMM', comm(1, 64, 48000))]))).toThrowError(
      /sample size/,
    );
  });

  it('parses an AIFF-C fl64 (big-endian float64) COMM', () => {
    const info = parseAiff(form('AIFC', [chunk('COMM', comm(1, 64, 96000, 'fl64'))]));
    expect(info.codec).toBe('pcm-f64');
    expect(info.sampleRate).toBe(96000);
  });

  it('treats a COMM-only AIFF (no SSND) as empty audio', () => {
    const pcm = readAiffPcm(form('AIFF', [chunk('COMM', comm(2, 16, 44100, undefined, 0))]));
    expect(pcm.frames).toBe(0);
    expect(pcm.channels).toBe(2);
  });
});

describe('AIFF-C sowt (byte-swapped, little-endian PCM) — the AIFF-C endianness twist', () => {
  it('decodes sowt as little-endian s16 and round-trips it byte-exact through writeAiff', () => {
    // A 4-sample LE-int16 SSND under AIFF-C 'sowt'. writeAiff must keep it AIFF-C + LE (sowt).
    const samples = new Uint8Array(new Int16Array([0, 1000, -1000, 32767]).buffer); // little-endian
    const ssnd = new Uint8Array(8 + samples.byteLength); // offset(4)+blockSize(4)+data
    ssnd.set(samples, 8);
    const file = form('AIFC', [chunk('COMM', comm(1, 16, 8000, 'sowt', 4)), chunk('SSND', ssnd)]);
    const info = parseAiff(file);
    expect(info.kind).toBe('aifc');
    expect(info.codec).toBe('pcm-s16'); // LE → no `be` suffix
    const pcm = readAiffPcm(file);
    expect(pcm.endian).toBe('le');
    expect(pcm.frames).toBe(4);
    const re = writeAiff(pcm, pcm.format, { kind: pcm.kind, endian: pcm.endian });
    const reInfo = parseAiff(re);
    expect(reInfo.kind).toBe('aifc'); // sowt/LE forces the AIFF-C dialect
    expect(reInfo.codec).toBe('pcm-s16');
    expect(ssndSamples(re)).toEqual(samples);
  });
});

describe('AiffModule', () => {
  it('default-exports a DriverModule that registers the container', () => {
    expect(AiffModule.apiVersion).toBe(AiffDriver.apiVersion);
    let registered: unknown;
    AiffModule.register({
      addContainer: (d) => {
        registered = d;
      },
      addCodec: () => {},
      addFilter: () => {},
    });
    expect(registered).toBe(AiffDriver);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

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
  o?: Parameters<NonNullable<typeof AiffDriver.transformPcm>>[1],
): Promise<ReadableStream<Uint8Array>> {
  const fn = AiffDriver.transformPcm;
  if (!fn) throw new Error('AiffDriver must expose transformPcm');
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

// ── crafted-AIFF builders (test-only; real bytes for the field under test) ─────────────────────────
/**
 * A COMM body: channels, numSampleFrames, sampleSize, 80-bit rate, and (when `compression` is given) an
 * AIFF-C `compressionType` 4cc + empty Pascal name. Plain AIFF omits the compression suffix (18 bytes).
 */
function comm(
  channels: number,
  sampleSize: number,
  sampleRate: number,
  compression?: string,
  numFrames = 4,
): Uint8Array {
  const body = new Uint8Array(compression === undefined ? 18 : 18 + 4 + 2);
  const dv = new DataView(body.buffer);
  dv.setUint16(0, channels);
  dv.setUint32(2, numFrames);
  dv.setUint16(6, sampleSize);
  body.set(writeExtendedFloat80(sampleRate), 8);
  if (compression !== undefined) {
    for (let i = 0; i < 4; i++) dv.setUint8(18 + i, compression.charCodeAt(i));
    // bytes 22 (Pascal len = 0) + 23 (even pad) stay zero.
  }
  return body;
}
function chunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength + (body.byteLength & 1));
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) dv.setUint8(i, id.charCodeAt(i));
  dv.setUint32(4, body.byteLength);
  out.set(body, 8);
  return out;
}
function form(formType: string, parts: Uint8Array[]): Uint8Array {
  const bodyLen = parts.reduce((n, c) => n + c.byteLength, 4);
  const out = new Uint8Array(8 + bodyLen);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) dv.setUint8(i, 'FORM'.charCodeAt(i));
  dv.setUint32(4, bodyLen);
  for (let i = 0; i < 4; i++) dv.setUint8(8 + i, formType.charCodeAt(i));
  let pos = 12;
  for (const c of parts) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}
