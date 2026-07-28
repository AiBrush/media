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
import { describe, expect, it, vi } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { channelAt } from '../../dsp/pcm.ts';
import { readCafPcm } from '../caf/caf.ts';
import { readWavPcm, writeWav } from '../wav/pcm.ts';
import {
  AiffDriver,
  AiffModule,
  aiffPacketInfoFromBytes,
  aiffPacketInfoFromUrl,
} from './aiff-driver.ts';
import { trySliceAiffPcm } from './aiff-slice.ts';
import { rewriteAiffPcmToWav } from './aiff-wav-rewrite.ts';
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
const MEDIA_TEST = new URL('../../../../media-test/fixtures/media/', import.meta.url).pathname;

const loadDerived = async (n: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(`${DERIVED}${n}`));
const loadHarness = async (n: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(`${MEDIA_TEST}${n}`));

/** Independent SSND sample-byte locator — the byte-exact oracle must not depend on the code under test. */
function ssndSamples(b: Uint8Array): Uint8Array {
  const range = ssndSampleRange(b);
  return b.subarray(range.offset, range.offset + range.size);
}

function ssndSampleRange(b: Uint8Array): { offset: number; size: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 12; // FORM + size + formType
  while (pos + 8 <= b.byteLength) {
    const id = String.fromCharCode(b[pos] ?? 0, b[pos + 1] ?? 0, b[pos + 2] ?? 0, b[pos + 3] ?? 0);
    const size = dv.getUint32(pos + 4);
    if (id === 'SSND') {
      const offset = dv.getUint32(pos + 8); // alignment bytes before the first sample
      return { offset: pos + 8 + 8 + offset, size: size - 8 - offset };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('no SSND chunk');
}

/** Independent RIFF/WAVE data-chunk locator for the AIFF→WAV byte-swap fast-path oracle. */
function wavDataChunk(b: Uint8Array): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 12; // RIFF + size + WAVE
  while (pos + 8 <= b.byteLength) {
    const id = String.fromCharCode(b[pos] ?? 0, b[pos + 1] ?? 0, b[pos + 2] ?? 0, b[pos + 3] ?? 0);
    const size = dv.getUint32(pos + 4, true);
    if (id === 'data') {
      return b.subarray(pos + 8, pos + 8 + Math.min(size, Math.max(0, b.byteLength - pos - 8)));
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
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

describe('AiffDriver.probe — bounded metadata-only COMM reads', () => {
  it.each([
    'scenarios/probe/pcm_s16be/pcm_s16be.aiff',
    'scenarios/probe/pcm_s16be/01.aiff',
    'scenarios/probe/pcm_s16be/02.aiff',
    'scenarios/probe/pcm_s16be/03.aiff',
  ])('%s matches full-header truth from one 64-byte range', async (id) => {
    const bytes = await loadHarness(id);
    const reads: Array<readonly [number, number]> = [];
    const probe = AiffDriver.probe;
    if (probe === undefined) throw new Error('AiffDriver must expose a metadata-only probe');
    const source = {
      size: bytes.byteLength,
      range(start: number, end: number): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('known-size AIFF probe must not open the payload stream');
      },
    };
    const expected = await AiffDriver.demux(bytesSource(bytes));
    try {
      expect(await probe(source)).toEqual(expected.tracks);
      expect(reads).toEqual([[0, 64]]);
    } finally {
      await expected.close();
    }
  });

  it('preserves typed cancellation before performing a metadata read', async () => {
    const probe = AiffDriver.probe;
    if (probe === undefined) throw new Error('AiffDriver must expose a metadata-only probe');
    let reads = 0;
    await expect(
      probe(
        {
          size: 1024,
          range(): Promise<Uint8Array> {
            reads++;
            return Promise.resolve(new Uint8Array(64));
          },
          stream: () => streamOf(new Uint8Array(0)),
        },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: 'aborted', message: 'operation aborted' });
    expect(reads).toBe(0);
  });

  it('grows once to the bounded metadata window when COMM follows a legal filler chunk', async () => {
    const original = await loadHarness('scenarios/probe/pcm_s16be/pcm_s16be.aiff');
    const filler = new Uint8Array(8 + 256);
    filler.set([0x4a, 0x55, 0x4e, 0x4b], 0);
    new DataView(filler.buffer).setUint32(4, 256, false);
    const bytes = new Uint8Array(original.byteLength + filler.byteLength);
    bytes.set(original.subarray(0, 12), 0);
    bytes.set(filler, 12);
    bytes.set(original.subarray(12), 12 + filler.byteLength);
    new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, false);

    const reads: Array<readonly [number, number]> = [];
    const probe = AiffDriver.probe;
    if (probe === undefined) throw new Error('AiffDriver must expose a metadata-only probe');
    const tracks = await probe({
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable AIFF fallback must remain range-backed');
      },
    });
    const expected = await AiffDriver.demux(bytesSource(original));
    try {
      expect(tracks).toEqual(expected.tracks);
      expect(reads).toEqual([
        [0, 64],
        [0, Math.min(bytes.byteLength, 64 * 1024)],
      ]);
    } finally {
      await expected.close();
    }
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

describe('AiffDriver.packetInfo — metadata-only PCM packet table', () => {
  it('matches FFmpeg byte-oriented packet sizing for real mono s16 and non-byte-aligned s24 AIFF', async () => {
    const s16 = await loadDerived('sfx.aiff');
    const s16Table = aiffPacketInfoFromBytes(s16);
    const s16Range = ssndSampleRange(s16);
    expect(s16Table.packets).toHaveLength(5);
    expect(s16Table.packets[0]).toMatchObject({
      offset: s16Range.offset,
      size: 4096,
      ptsUs: 0,
      durationUs: 42_667,
    });
    expect(s16Table.packets.at(-1)).toMatchObject({
      offset: s16Range.offset + 4 * 4096,
      size: 4096,
      ptsUs: 170_667,
      durationUs: 42_667,
    });

    const s24 = await loadDerived('sfx-s24.aiff');
    const s24Table = aiffPacketInfoFromBytes(s24);
    const s24Range = ssndSampleRange(s24);
    expect(s24Table.packets).toHaveLength(8);
    expect(s24Table.packets[0]).toMatchObject({
      offset: s24Range.offset,
      size: 4095,
      ptsUs: 0,
      durationUs: 28_438,
    });
    expect(s24Table.packets.at(-1)).toMatchObject({
      offset: s24Range.offset + 7 * 4095,
      size: 2055,
      ptsUs: 199_063,
      durationUs: 14_271,
    });
  });

  it('enumerates real big-endian PCM packets from SSND facts without WebCodecs packets', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const table = aiffPacketInfoFromBytes(file);
    const fromDriver = await AiffDriver.packetInfo?.(bytesSource(file));
    const range = ssndSampleRange(file);
    expect(fromDriver).toEqual(table);
    expect(table.tracks).toHaveLength(1);
    expect(table.tracks[0]).toMatchObject({
      mediaType: 'audio',
      codec: 'pcm-s16be',
      durationSec: 5,
      config: { sampleRate: 48000, numberOfChannels: 2 },
    });
    expect(table.packets).toHaveLength(235);
    expect(table.packets[0]).toEqual({
      trackIndex: 0,
      offset: range.offset,
      size: 4096,
      ptsUs: 0,
      dtsUs: 0,
      durationUs: 21333,
      keyframe: true,
    });
    expect(table.packets[1]?.ptsUs).toBe(21333);
    expect(table.packets.at(-1)).toEqual({
      trackIndex: 0,
      offset: range.offset + 234 * 4096,
      size: range.size - 234 * 4096,
      ptsUs: 4_992_000,
      dtsUs: 4_992_000,
      durationUs: 8000,
      keyframe: true,
    });
  });

  it('falls back to a full stream read when a non-seekable first chunk is shorter than COMM/SSND', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const packetInfo = AiffDriver.packetInfo;
    if (!packetInfo) throw new Error('AiffDriver must expose packetInfo');

    const table = await packetInfo({
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(file.subarray(0, 12));
            controller.enqueue(file.subarray(12));
            controller.close();
          },
        }),
    });

    expect(table).toEqual(aiffPacketInfoFromBytes(file));
  });

  it('preserves typed parser errors for malformed sized sources', async () => {
    const packetInfo = AiffDriver.packetInfo;
    if (!packetInfo) throw new Error('AiffDriver must expose packetInfo');

    await expect(packetInfo(bytesSource(new Uint8Array([0])))).rejects.toBeInstanceOf(InputError);
  });

  it('honors an already-aborted packet-info signal', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const packetInfo = AiffDriver.packetInfo;
    if (!packetInfo) throw new Error('AiffDriver must expose packetInfo');
    const abort = new AbortController();
    abort.abort();

    await expect(packetInfo(bytesSource(file), { signal: abort.signal })).rejects.toMatchObject({
      code: 'aborted',
      message: 'operation aborted',
    });
  });

  it('aiffPacketInfoFromUrl uses one bounded range for header-visible SSND chunks', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const server = rangeServer(file);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = server.fetch;
    try {
      const table = await aiffPacketInfoFromUrl('https://fixtures.invalid/pcm_s16be.aiff', {
        mime: 'audio/aiff',
        size: file.byteLength,
      });
      expect(table).toEqual(aiffPacketInfoFromBytes(file));
      await expect(
        aiffPacketInfoFromUrl('https://fixtures.invalid/pcm_s16be.aiff', {
          mime: 'audio/aiff',
          size: file.byteLength,
        }),
      ).resolves.toEqual(table);
      expect(table.packets.reduce((total, packet) => total + packet.size, 0)).toBe(
        ssndSampleRange(file).size,
      );
      expect(server.calls).toEqual([{ method: 'GET', range: 'bytes=0-65535', bytes: 65536 }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aiffPacketInfoFromUrl learns total size from Content-Range when size is omitted', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const server = rangeServer(file);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = server.fetch;
    try {
      const table = await aiffPacketInfoFromUrl(
        'https://fixtures.invalid/unknown-size-pcm_s16be.aiff',
        { mime: 'audio/aiff' },
      );
      expect(table).toEqual(aiffPacketInfoFromBytes(file));
      await expect(
        aiffPacketInfoFromUrl('https://fixtures.invalid/unknown-size-pcm_s16be.aiff', {
          mime: 'audio/aiff',
        }),
      ).resolves.toEqual(table);
      expect(server.calls).toEqual([{ method: 'GET', range: 'bytes=0-65535', bytes: 65536 }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aiffPacketInfoFromUrl falls back to the driver packet-info path for empty AIFF audio', async () => {
    const file = form('AIFF', [chunk('COMM', comm(1, 16, 8000, undefined, 0))]);
    const server = rangeServer(file);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = server.fetch;
    try {
      const table = await aiffPacketInfoFromUrl('https://fixtures.invalid/empty-pcm.aiff', {
        mime: 'audio/aiff',
        size: file.byteLength,
      });
      expect(table).toEqual(aiffPacketInfoFromBytes(file));
      expect(table.packets).toHaveLength(0);
      expect(server.calls).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aiffPacketInfoFromUrl expires cached prefixes and prunes old rows on store', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const server = rangeServer(file);
    const originalFetch = globalThis.fetch;
    const now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    globalThis.fetch = server.fetch;
    try {
      await aiffPacketInfoFromUrl('https://fixtures.invalid/cache-a.aiff', {
        mime: 'audio/aiff',
        size: file.byteLength,
      });
      await aiffPacketInfoFromUrl('https://fixtures.invalid/cache-b.aiff', {
        mime: 'audio/aiff',
        size: file.byteLength,
      });
      expect(server.calls).toHaveLength(2);

      clock.mockReturnValue(now + 60_001);
      await aiffPacketInfoFromUrl('https://fixtures.invalid/cache-a.aiff', {
        mime: 'audio/aiff',
        size: file.byteLength,
      });
      await aiffPacketInfoFromUrl('https://fixtures.invalid/cache-c.aiff', {
        mime: 'audio/aiff',
        size: file.byteLength,
      });
      expect(server.calls).toHaveLength(4);
    } finally {
      clock.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it('aiffPacketInfoFromUrl caps cached prefixes with oldest-entry eviction', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const server = rangeServer(file);
    const originalFetch = globalThis.fetch;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    globalThis.fetch = server.fetch;
    try {
      for (let i = 0; i < 65; i++) {
        await aiffPacketInfoFromUrl(`https://fixtures.invalid/cache-fill-${i}.aiff`, {
          mime: 'audio/aiff',
          size: file.byteLength,
        });
      }
      expect(server.calls).toHaveLength(65);
    } finally {
      clock.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it('aiffPacketInfoFromUrl honors already-aborted signals before range fetch', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const server = rangeServer(file);
    const originalFetch = globalThis.fetch;
    const abort = new AbortController();
    abort.abort();
    globalThis.fetch = server.fetch;
    try {
      await expect(
        aiffPacketInfoFromUrl('https://fixtures.invalid/aborted-pcm_s16be.aiff', {
          mime: 'audio/aiff',
          size: file.byteLength,
          signal: abort.signal,
        }),
      ).rejects.toMatchObject({ code: 'aborted', message: 'operation aborted' });
      expect(server.calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aiffPacketInfoFromUrl reports a typed miss if the driver packet-info hook is absent', async () => {
    const originalPacketInfo = AiffDriver.packetInfo;
    if (originalPacketInfo === undefined) throw new Error('AiffDriver must expose packetInfo');
    Reflect.deleteProperty(AiffDriver, 'packetInfo');
    try {
      await expect(
        aiffPacketInfoFromUrl('https://fixtures.invalid/no-packet-info.aiff', {
          mime: 'audio/aiff',
          size: 128,
        }),
      ).rejects.toMatchObject({
        code: 'capability-miss',
        message: 'AIFF packet-info is not available',
      });
    } finally {
      AiffDriver.packetInfo = originalPacketInfo;
    }
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

describe('rewriteAiffPcmToWav — no-DSP cross-wrapper fast path', () => {
  it('byte-swaps a real big-endian s16 AIFF into canonical WAV while preserving samples', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const source = readAiffPcm(file);
    expect(source.format).toBe('s16');
    expect(source.endian).toBe('be');

    const rewritten = rewriteAiffPcmToWav(file, 's16', 'le', source.channels, source.sampleRate);
    expect(rewritten).toBeDefined();
    const out = rewritten ?? new Uint8Array();
    const wav = readWavPcm(out);
    expect(wav.format).toBe('s16');
    expect(wav.sampleRate).toBe(source.sampleRate);
    expect(wav.channels).toBe(source.channels);
    expect(wav.frames).toBe(source.frames);
    for (let c = 0; c < source.channels; c++) {
      expect(channelAt(wav.planar, c)).toEqual(channelAt(source.planar, c));
    }

    const sourceBytes = ssndSamples(file);
    const wavBytes = wavDataChunk(out);
    expect(wavBytes.byteLength).toBe(sourceBytes.byteLength);
    for (let i = 0; i < Math.min(sourceBytes.byteLength, 512); i += 2) {
      expect(wavBytes[i]).toBe(sourceBytes[i + 1]);
      expect(wavBytes[i + 1]).toBe(sourceBytes[i]);
    }
  });

  it('byte-swaps real big-endian s24 AIFF through the generic fixed-width path', async () => {
    const file = await loadHarness('pcm_s24be.aiff');
    const source = readAiffPcm(file);
    expect(source.format).toBe('s24');
    expect(source.endian).toBe('be');

    const rewritten = rewriteAiffPcmToWav(file, 's24', 'le', source.channels, source.sampleRate);
    expect(rewritten).toBeDefined();
    const out = rewritten ?? new Uint8Array();
    const wav = readWavPcm(out);
    expect(wav.format).toBe('s24');
    expect(wav.sampleRate).toBe(source.sampleRate);
    expect(wav.channels).toBe(source.channels);
    expect(wav.frames).toBe(source.frames);
    for (let c = 0; c < source.channels; c++) {
      expect(channelAt(wav.planar, c)).toEqual(channelAt(source.planar, c));
    }
  });

  it('narrows real big-endian s24 AIFF to canonical s16 WAV exactly like the PCM path', async () => {
    const file = await loadHarness('pcm_s24be.aiff');
    const source = readAiffPcm(file);
    expect(source.format).toBe('s24');
    expect(source.endian).toBe('be');

    const rewritten = rewriteAiffPcmToWav(file, 's16', 'le', source.channels, source.sampleRate);
    expect(rewritten).toBeDefined();
    const out = rewritten ?? new Uint8Array();
    const canonical = writeWav(source, 's16');
    expect(out).toEqual(canonical);

    const wav = readWavPcm(out);
    expect(wav.format).toBe('s16');
    expect(wav.sampleRate).toBe(source.sampleRate);
    expect(wav.channels).toBe(source.channels);
    expect(wav.frames).toBe(source.frames);
  });

  it('narrows exact half-LSB s24 samples with canonical nearest-even rounding', () => {
    const s16HalfCodes = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
    const file = writeAiff(
      {
        sampleRate: 8_000,
        channels: 1,
        frames: s16HalfCodes.length,
        planar: [Float64Array.from(s16HalfCodes, (code) => code / 32_768)],
      },
      's24',
    );
    const rewritten = rewriteAiffPcmToWav(file, 's16', 'le', 1, 8_000);

    expect(rewritten).toEqual(writeWav(readAiffPcm(file), 's16'));
    if (rewritten === undefined) throw new Error('expected direct AIFF s24→WAV s16 narrowing');
    expect(Array.from(new Int16Array(rewritten.buffer, rewritten.byteOffset + 44))).toEqual([
      -2, -2, 0, 0, 2, 2,
    ]);
  });

  it('copies little-endian AIFF-C PCM directly into canonical WAV payload bytes', () => {
    const samples = Uint8Array.of(0x34, 0x12, 0x78, 0x56, 0xbc, 0x9a, 0xf0, 0xde);
    const ssnd = new Uint8Array(8 + samples.byteLength);
    ssnd.set(samples, 8);
    const file = form('AIFC', [chunk('COMM', comm(1, 16, 8000, 'sowt', 4)), chunk('SSND', ssnd)]);

    const rewritten = rewriteAiffPcmToWav(file, 's16', 'le', 1, 8000);
    expect(rewritten).toBeDefined();
    const out = rewritten ?? new Uint8Array();
    const wav = readWavPcm(out);
    expect(wav.format).toBe('s16');
    expect(wav.frames).toBe(4);
    expect(wavDataChunk(out)).toEqual(samples);
  });

  it('authors an empty canonical WAV when AIFF has COMM but no SSND samples', () => {
    const file = form('AIFF', [chunk('COMM', comm(1, 16, 8000, undefined, 0))]);

    const rewritten = rewriteAiffPcmToWav(file, 's16', 'le', 1, 8000);
    expect(rewritten).toBeDefined();
    const out = rewritten ?? new Uint8Array();
    const wav = readWavPcm(out);
    expect(wav.format).toBe('s16');
    expect(wav.frames).toBe(0);
    expect(wavDataChunk(out)).toHaveLength(0);
  });

  it('declines targets that require DSP, value conversion, or non-WAV byte order', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    expect(rewriteAiffPcmToWav(file, 's24')).toBeUndefined();
    expect(rewriteAiffPcmToWav(file, 's16', 'be')).toBeUndefined();
    expect(rewriteAiffPcmToWav(file, 's16', 'le', 1)).toBeUndefined();
    expect(rewriteAiffPcmToWav(file, 's16', 'le', 2, 44_100)).toBeUndefined();

    const samples = Uint8Array.of(0x80, 0x00, 0x7f, 0x40);
    const ssnd = new Uint8Array(8 + samples.byteLength);
    ssnd.set(samples, 8);
    const s8 = form('AIFF', [chunk('COMM', comm(1, 8, 8000)), chunk('SSND', ssnd)]);
    expect(rewriteAiffPcmToWav(s8)).toBeUndefined();
  });
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

  it.each(['pcm_s16be.aiff', 'pcm_s24be.aiff'] as const)(
    'direct-slices real %s AIFF PCM bytes equal to the canonical PCM trim reference',
    async (id) => {
      const file = await loadHarness(id);
      const bounds = { startSec: 1, endSec: 3.5 };
      const direct = trySliceAiffPcm(file, { container: 'aiff', timeBounds: bounds });
      const reference = sliceAiffReference(file, bounds);

      expect(direct).toEqual(reference);
      expect(direct).not.toEqual(file);
      const source = readAiffPcm(file);
      const out = readAiffPcm(direct ?? new Uint8Array());
      expect(out.sampleRate).toBe(source.sampleRate);
      expect(out.channels).toBe(source.channels);
      expect(out.frames).toBe(Math.round((bounds.endSec - bounds.startSec) * source.sampleRate));
    },
  );

  it('routes clean AIFF PCM trims through the direct SSND byte-slice writer', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const bounds = { startSec: 1, endSec: 3.5 };
    const expected = trySliceAiffPcm(file, { container: 'aiff', timeBounds: bounds });
    if (expected === undefined) throw new Error('AIFF PCM trim fast path must be eligible');

    const out = await drain(await transform(file, { container: 'aiff', timeBounds: bounds }));
    expect(out).toEqual(expected);
  });

  it('declines unsupported AIFF byte-slice shapes before the canonical PCM fallback', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    const aifc = await loadDerived('sfx-fl32.aifc');
    const bounds = { startSec: 0, endSec: 0.01 };

    expect(trySliceAiffPcm(file, { container: 'wav', timeBounds: bounds })).toBeUndefined();
    expect(
      trySliceAiffPcm(file, { container: 'aiff', timeBounds: bounds, sampleFormat: 's24' }),
    ).toBeUndefined();
    expect(
      trySliceAiffPcm(file, { container: 'aiff', timeBounds: bounds, endian: 'le' }),
    ).toBeUndefined();
    expect(
      trySliceAiffPcm(file, { container: 'aiff', timeBounds: bounds, channels: 1 }),
    ).toBeUndefined();
    expect(
      trySliceAiffPcm(file, { container: 'aiff', timeBounds: bounds, sampleRate: 44_100 }),
    ).toBeUndefined();
    expect(
      trySliceAiffPcm(file, { container: 'aiff', timeBounds: bounds, gainDb: 0 }),
    ).toBeUndefined();
    expect(trySliceAiffPcm(aifc, { container: 'aiff', timeBounds: bounds })).toBeUndefined();
  });

  it('preserves typed trim errors and aborts on the direct AIFF byte-slice path', async () => {
    const file = await loadHarness('pcm_s16be.aiff');
    expect(() =>
      trySliceAiffPcm(file, { container: 'aiff', timeBounds: { startSec: -1, endSec: 1 } }),
    ).toThrowError(InputError);
    expect(() =>
      trySliceAiffPcm(file, { container: 'aiff', timeBounds: { startSec: 4, endSec: 4 } }),
    ).toThrowError(InputError);
    expect(() =>
      trySliceAiffPcm(file, {
        container: 'aiff',
        timeBounds: { startSec: 1, endSec: 2 },
        signal: AbortSignal.abort(),
      }),
    ).toThrowError(MediaError);
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

describe('AiffDriver.decodePcmAudio — abort handling', () => {
  it('observes an abort that arrives while source bytes are being read', async () => {
    const file = await loadDerived('sfx.aiff');
    const controller = new AbortController();
    const decode = AiffDriver.decodePcmAudio;
    if (decode === undefined) throw new Error('AiffDriver must expose decodePcmAudio');
    const source = {
      stream: () => streamOf(file),
      size: file.byteLength,
      range: (s: number, e: number): Promise<Uint8Array> => {
        controller.abort();
        return Promise.resolve(file.subarray(s, e));
      },
    };

    await expect(decode(source, { signal: controller.signal })).rejects.toThrow(MediaError);
  });
});

describe('AiffDriver.decodePcmInterleavedStream — bounded fused PCM egress', () => {
  it.each(['pcm_s16be.aiff', 'pcm_s24be.aiff'] as const)(
    'decodes real %s range-backed PCM bit-exactly without materializing the payload',
    async (id) => {
      const bytes = await loadHarness(id);
      const canonical = readAiffPcm(bytes);
      const expected = new Float32Array(canonical.frames * canonical.channels);
      for (let frame = 0; frame < canonical.frames; frame++) {
        for (let channel = 0; channel < canonical.channels; channel++) {
          expected[frame * canonical.channels + channel] = canonical.planar[channel]?.[frame] ?? 0;
        }
      }
      const reads: Array<readonly [number, number]> = [];
      const decode = AiffDriver.decodePcmInterleavedStream;
      if (decode === undefined) {
        throw new Error('AiffDriver must expose fused interleaved PCM decode');
      }
      const chunks = await decode({
        size: bytes.byteLength,
        range(start, end): Promise<Uint8Array> {
          reads.push([start, end]);
          return Promise.resolve(bytes.subarray(start, end));
        },
        stream(): ReadableStream<Uint8Array> {
          throw new Error('range-backed AIFF decode must not open the full payload stream');
        },
      });

      const actual = new Uint32Array(expected.length);
      const reader = chunks.getReader();
      let sample = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        expect(next.value.frames).toBeLessThanOrEqual(4096);
        expect(next.value.sampleRate).toBe(canonical.sampleRate);
        expect(next.value.channels).toBe(canonical.channels);
        const bits = new Uint32Array(
          next.value.data.buffer,
          next.value.data.byteOffset,
          next.value.data.length,
        );
        actual.set(bits, sample);
        sample += bits.length;
      }
      reader.releaseLock();

      expect(sample).toBe(expected.length);
      expect(actual).toEqual(new Uint32Array(expected.buffer));
      expect(reads[0]).toEqual([0, 65_536]);
      expect(reads.every(([start, end]) => end - start <= 1024 * 1024)).toBe(true);
      expect(reads.length).toBeLessThanOrEqual(id === 'pcm_s16be.aiff' ? 2 : 3);
    },
  );

  it('uses COMM frame count and ignores legal SSND block-alignment tail bytes', async () => {
    const samples = Uint8Array.of(0x20, 0, 0x40, 0, 0x60, 0, 0x7f, 0xff);
    const sound = new Uint8Array(8 + samples.byteLength);
    new DataView(sound.buffer).setUint32(4, 8);
    sound.set(samples, 8);
    const bytes = form('AIFF', [
      chunk('COMM', comm(1, 16, 8000, undefined, 1)),
      chunk('SSND', sound),
    ]);
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }

    for (const source of [bytesSource(bytes), { stream: () => streamOf(bytes) }]) {
      const reader = (await decode(source)).getReader();
      const first = await reader.read();
      expect(first.value).toMatchObject({ sampleRate: 8000, channels: 1, frames: 1 });
      expect(Array.from(first.value?.data ?? [])).toEqual([0.25]);
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
    }
    expect(readAiffPcm(bytes).frames).toBe(1);
    const rewritten = rewriteAiffPcmToWav(bytes);
    expect(rewritten).toBeDefined();
    expect(readWavPcm(rewritten ?? new Uint8Array()).frames).toBe(1);
    expect(aiffPacketInfoFromBytes(bytes).packets).toHaveLength(1);
    expect(aiffPacketInfoFromBytes(bytes).packets[0]?.size).toBe(2);
  });

  it('rejects missing or short SSND data whenever COMM declares required frames', async () => {
    const oneFrameSound = new Uint8Array(10);
    oneFrameSound.set([0x20, 0], 8);
    const malformed = [
      form('AIFF', [chunk('COMM', comm(1, 16, 8000, undefined, 1))]),
      form('AIFF', [chunk('COMM', comm(1, 16, 8000, undefined, 2)), chunk('SSND', oneFrameSound)]),
    ];
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }

    for (const bytes of malformed) {
      expect(() => readAiffPcm(bytes)).toThrowError(/SSND/);
      expect(() => rewriteAiffPcmToWav(bytes)).toThrowError(/SSND/);
      expect(() =>
        trySliceAiffPcm(bytes, {
          container: 'aiff',
          timeBounds: { startSec: 0, endSec: 1 / 8000 },
        }),
      ).toThrowError(/SSND/);
      expect(() => aiffPacketInfoFromBytes(bytes)).toThrowError(/SSND/);
      await expect(decode(bytesSource(bytes))).rejects.toMatchObject({ code: 'demux-error' });
      await expect(decode({ stream: () => streamOf(bytes) })).rejects.toMatchObject({
        code: 'demux-error',
      });
    }
  });

  it('streams range-less signed-24 PCM with range-path cadence and Float32 bits', async () => {
    const bytes = await loadDerived('sfx-s24.aiff');
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }
    const expectedReader = (
      await decode({
        size: bytes.byteLength,
        range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
        stream(): ReadableStream<Uint8Array> {
          throw new Error('range control must not stream');
        },
      })
    ).getReader();
    const expectedBits: number[] = [];
    const expectedCadence: number[] = [];
    for (;;) {
      const next = await expectedReader.read();
      if (next.done) break;
      expectedCadence.push(next.value.frames);
      expectedBits.push(
        ...new Uint32Array(
          next.value.data.buffer,
          next.value.data.byteOffset,
          next.value.data.length,
        ),
      );
    }
    expectedReader.releaseLock();

    let streamCalls = 0;
    let offset = 0;
    let activePulls = 0;
    let maximumActivePulls = 0;
    const source: ByteSource = {
      size: bytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        streamCalls++;
        offset = 0;
        return new ReadableStream<Uint8Array>(
          {
            async pull(controller): Promise<void> {
              activePulls++;
              maximumActivePulls = Math.max(maximumActivePulls, activePulls);
              await Promise.resolve();
              const length = Math.min(97 + (offset % 131), bytes.byteLength - offset);
              if (length > 0) {
                controller.enqueue(bytes.slice(offset, offset + length));
                offset += length;
              }
              if (offset >= bytes.byteLength) controller.close();
              activePulls--;
            },
          },
          { highWaterMark: 0 },
        );
      },
    };

    const actualReader = (await decode(source)).getReader();
    const actualBits: number[] = [];
    const actualCadence: number[] = [];
    for (;;) {
      const next = await actualReader.read();
      if (next.done) break;
      actualCadence.push(next.value.frames);
      actualBits.push(
        ...new Uint32Array(
          next.value.data.buffer,
          next.value.data.byteOffset,
          next.value.data.length,
        ),
      );
    }
    actualReader.releaseLock();

    expect(streamCalls).toBe(1);
    expect(maximumActivePulls).toBe(1);
    expect(actualCadence).toEqual(expectedCadence);
    expect(actualBits).toEqual(expectedBits);
  });

  it('spools a legal SSND-before-COMM stream in bounded segments and releases its source', async () => {
    const frames = 524_297;
    const samples = new Uint8Array(frames * 2);
    for (let frame = 0; frame < frames; frame++) {
      samples[frame * 2] = frame & 0x7f;
      samples[frame * 2 + 1] = frame & 0xff;
    }
    const sound = new Uint8Array(8 + samples.byteLength);
    sound.set(samples, 8);
    const bytes = form('AIFF', [
      chunk('SSND', sound),
      chunk('COMM', comm(1, 16, 8000, undefined, frames)),
    ]);
    let offset = 0;
    const sourceStream = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          const end = Math.min(bytes.byteLength, offset + 64 * 1024);
          if (end > offset) controller.enqueue(bytes.slice(offset, end));
          offset = end;
          if (offset >= bytes.byteLength) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }

    const chunks = await decode({ stream: () => sourceStream });
    expect(sourceStream.locked).toBe(false);
    const reader = chunks.getReader();
    let decodedFrames = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.frames).toBeLessThanOrEqual(4096);
      decodedFrames += next.value.frames;
    }
    reader.releaseLock();
    expect(decodedFrames).toBe(frames);
  });

  it('rejects chunks outside the sequential FORM boundary and unlocks the source', async () => {
    const bytes = form('AIFF', [
      chunk('COMM', comm(1, 16, 8000, undefined, 1)),
      chunk('SSND', Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0x20, 0)),
    ]);
    new DataView(bytes.buffer).setUint32(4, 4);
    const sourceStream = streamOf(bytes);
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }

    await expect(decode({ stream: () => sourceStream })).rejects.toMatchObject({
      code: 'demux-error',
      message: expect.stringContaining('COMM'),
    });
    expect(sourceStream.locked).toBe(false);
  });

  it('aborts a pending initial range promptly through the ByteSource range signal', async () => {
    let rangeStarted = false;
    let rangeAborted = false;
    const abort = new AbortController();
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }
    const pending = decode(
      {
        size: 1024,
        range(_start, _end, signal): Promise<Uint8Array> {
          rangeStarted = true;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                rangeAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
        stream(): ReadableStream<Uint8Array> {
          throw new Error('range-backed AIFF decode must not stream');
        },
      },
      { signal: abort.signal },
    );
    while (!rangeStarted) await Promise.resolve();

    abort.abort('stop initial AIFF range');

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(rangeAborted).toBe(true);
  });

  it('honors AIFF-C sowt little-endian signed-16 payloads on the bounded path', async () => {
    const samples = Uint8Array.of(0, 0x80, 0xff, 0x7f, 0xff, 0xff, 0, 0);
    const sound = new Uint8Array(8 + samples.byteLength);
    sound.set(samples, 8);
    const bytes = form('AIFC', [chunk('COMM', comm(1, 16, 8000, 'sowt', 4)), chunk('SSND', sound)]);
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }
    const reader = (await decode(bytesSource(bytes))).getReader();
    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ sampleRate: 8000, channels: 1, frames: 4 });
    expect(Array.from(first.value?.data ?? [])).toEqual([-1, 32_767 / 32_768, -1 / 32_768, 0]);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  it('cancels and unlocks a sequential source during a pending payload read', async () => {
    const bytes = await loadHarness('pcm_s16be.aiff');
    const sampleRange = ssndSampleRange(bytes);
    const firstPayloadEnd = sampleRange.offset + 4096 * 2 * 2;
    let pendingPull = false;
    let cancelled = 0;
    const sourceStream = new ReadableStream<Uint8Array>(
      {
        start(controller): void {
          controller.enqueue(bytes.slice(0, firstPayloadEnd));
        },
        pull(): Promise<void> {
          pendingPull = true;
          return new Promise(() => {});
        },
        cancel(): void {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }
    const reader = (await decode({ stream: () => sourceStream })).getReader();
    expect((await reader.read()).value?.frames).toBe(4096);
    const pending = reader.read();
    while (!pendingPull) await Promise.resolve();

    await reader.cancel('consumer stopped');
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(cancelled).toBe(1);
    expect(sourceStream.locked).toBe(false);
  });

  it('aborts a pending bounded range window when the consumer cancels', async () => {
    const bytes = await loadHarness('pcm_s16be.aiff');
    let payloadRangeStarted = false;
    let payloadRangeAborted = false;
    let rangeCalls = 0;
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end, signal): Promise<Uint8Array> {
        expect(this).toBe(source);
        rangeCalls++;
        if (rangeCalls === 1) return Promise.resolve(bytes.subarray(start, end));
        payloadRangeStarted = true;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              payloadRangeAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('range-backed AIFF decode must remain bounded');
      },
    };
    const reader = (await decode(source)).getReader();
    expect((await reader.read()).value?.frames).toBe(4096);
    expect((await reader.read()).value?.frames).toBe(4096);
    expect((await reader.read()).value?.frames).toBe(4096);
    const pending = reader.read();
    while (!payloadRangeStarted) await Promise.resolve();

    const cancelled = reader.cancel('consumer stopped during AIFF range read');

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(cancelled).resolves.toBeUndefined();
    expect(rangeCalls).toBe(2);
    expect(payloadRangeAborted).toBe(true);
    reader.releaseLock();
  });

  it('preserves a sequential producer error as a typed demux failure and unlocks the source', async () => {
    const bytes = await loadHarness('pcm_s16be.aiff');
    const sampleRange = ssndSampleRange(bytes);
    const firstPayloadEnd = sampleRange.offset + 4096 * 2 * 2;
    const sourceFailure = new Error('producer failed after first AIFF PCM chunk');
    const sourceStream = new ReadableStream<Uint8Array>(
      {
        start(controller): void {
          controller.enqueue(bytes.slice(0, firstPayloadEnd));
        },
        pull(controller): void {
          controller.error(sourceFailure);
        },
      },
      { highWaterMark: 0 },
    );
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }
    const reader = (await decode({ stream: () => sourceStream })).getReader();
    expect((await reader.read()).value?.frames).toBe(4096);
    await expect(reader.read()).rejects.toMatchObject({
      code: 'demux-error',
      detail: sourceFailure,
      message: expect.stringContaining('producer failed after first AIFF PCM chunk'),
    });
    reader.releaseLock();
    expect(sourceStream.locked).toBe(false);
  });

  it('rejects a range-less payload that ends before its declared final frame', async () => {
    const bytes = await loadDerived('sfx.aiff');
    const truncated = bytes.slice(0, -2);
    const sourceStream = new ReadableStream<Uint8Array>(
      {
        start(controller): void {
          controller.enqueue(truncated.subarray(0, 83));
          controller.enqueue(truncated.subarray(83));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }
    const reader = (await decode({ stream: () => sourceStream })).getReader();
    await expect(
      (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
        }
      })(),
    ).rejects.toMatchObject({
      code: 'demux-error',
      message: expect.stringContaining('ended before the declared SSND payload'),
    });
    reader.releaseLock();
    expect(sourceStream.locked).toBe(false);
  });

  it('cancels and unlocks a pending sequential header read on abort', async () => {
    const bytes = await loadDerived('sfx.aiff');
    let releasePull: (() => void) | undefined;
    let cancelled = false;
    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes.subarray(0, 12));
      },
      pull(controller): Promise<void> {
        return new Promise((resolve) => {
          releasePull = () => {
            controller.enqueue(bytes.subarray(12));
            controller.close();
            resolve();
          };
        });
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const decode = AiffDriver.decodePcmInterleavedStream;
    if (decode === undefined) {
      throw new Error('AiffDriver must expose fused interleaved PCM decode');
    }
    const abort = new AbortController();
    const outcome = decode({ stream: () => sourceStream }, { signal: abort.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );
    while (releasePull === undefined) await Promise.resolve();

    abort.abort('stop');
    await Promise.resolve();
    await Promise.resolve();
    const wasCancelledPromptly = cancelled;
    if (!cancelled) releasePull();

    expect(wasCancelledPromptly).toBe(true);
    await expect(outcome).resolves.toMatchObject({ code: 'aborted' });
    expect(sourceStream.locked).toBe(false);
  });
});

describe('AiffDriver bounded decode — defensive container branches', () => {
  const maybeDecode = AiffDriver.decodePcmInterleavedStream;
  if (maybeDecode === undefined) {
    throw new Error('AiffDriver must expose fused interleaved PCM decode');
  }
  const decode: NonNullable<typeof AiffDriver.decodePcmInterleavedStream> = maybeDecode;
  const maybeProbe = AiffDriver.probe;
  if (maybeProbe === undefined) throw new Error('AiffDriver must expose probe');
  const probe: NonNullable<typeof AiffDriver.probe> = maybeProbe;
  const maybeDecodeAudio = AiffDriver.decodePcmAudio;
  if (maybeDecodeAudio === undefined) throw new Error('AiffDriver must expose decodePcmAudio');
  const decodeAudio: NonNullable<typeof AiffDriver.decodePcmAudio> = maybeDecodeAudio;

  async function consume(source: ByteSource, signal?: AbortSignal): Promise<number> {
    const reader = (
      await decode(source, signal === undefined ? undefined : { signal })
    ).getReader();
    let frames = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return frames;
        frames += next.value.frames;
      }
    } finally {
      reader.releaseLock();
    }
  }

  function rangeOnly(
    bytes: Uint8Array,
    logicalSize: number | undefined = bytes.byteLength,
  ): ByteSource {
    return {
      ...(logicalSize === undefined ? {} : { size: logicalSize }),
      range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
      stream(): ReadableStream<Uint8Array> {
        throw new Error('bounded AIFF decode must not materialize the source stream');
      },
    };
  }

  it('reports packet metadata for float64, float32, signed-8, and little-endian PCM', () => {
    const cases = [
      {
        bytes: form('AIFC', [
          chunk('COMM', comm(1, 64, 8000, 'fl64', 1)),
          chunk('SSND', new Uint8Array(16)),
        ]),
        codec: 'pcm-f64',
      },
      {
        bytes: form('AIFC', [
          chunk('COMM', comm(1, 32, 8000, 'fl32', 1)),
          chunk('SSND', new Uint8Array(12)),
        ]),
        codec: 'pcm-f32',
      },
      {
        bytes: form('AIFF', [
          chunk('COMM', comm(1, 8, 8000, undefined, 1)),
          chunk('SSND', new Uint8Array(9)),
        ]),
        codec: 'pcm-s8',
      },
      {
        bytes: form('AIFC', [
          chunk('COMM', comm(1, 16, 8000, 'sowt', 1)),
          chunk('SSND', new Uint8Array(10)),
        ]),
        codec: 'pcm-s16',
      },
    ] as const;

    for (const { bytes, codec } of cases) {
      const table = aiffPacketInfoFromBytes(bytes);
      expect(table.tracks[0]?.codec).toBe(codec);
      expect(table.packets).toHaveLength(1);
    }

    const zeroRate = form('AIFF', [chunk('COMM', comm(1, 16, 0, undefined, 0))]);
    expect(aiffPacketInfoFromBytes(zeroRate).tracks[0]?.durationSec).toBe(0);
  });

  it('rejects malformed range-backed FORM, COMM, and SSND structures without a full read', async () => {
    const shortFormEnd = form('AIFF', []);
    new DataView(shortFormEnd.buffer).setUint32(4, 0);

    const truncatedChunkHeader = new Uint8Array(16);
    truncatedChunkHeader.set(new TextEncoder().encode('FORM'), 0);
    new DataView(truncatedChunkHeader.buffer).setUint32(4, 12);
    truncatedChunkHeader.set(new TextEncoder().encode('AIFF'), 8);

    const shortSoundFull = form('AIFF', [
      chunk('COMM', comm(1, 16, 8000, undefined, 1)),
      chunk('SSND', new Uint8Array(8)),
    ]);
    const shortSound = shortSoundFull.subarray(0, shortSoundFull.byteLength - 4);

    const invalidOffset = new Uint8Array(8);
    new DataView(invalidOffset.buffer).setUint32(0, 1);

    const cases: ReadonlyArray<readonly [string, ByteSource]> = [
      ['bad magic', rangeOnly(new Uint8Array(12))],
      ['short FORM extent', rangeOnly(shortFormEnd)],
      ['short chunk header', rangeOnly(truncatedChunkHeader, 20)],
      ['short COMM', rangeOnly(form('AIFF', [chunk('COMM', new Uint8Array(17))]))],
      [
        'short SSND',
        rangeOnly(
          form('AIFF', [
            chunk('COMM', comm(1, 16, 8000, undefined, 1)),
            chunk('SSND', new Uint8Array(7)),
          ]),
        ),
      ],
      ['short SSND prefix', rangeOnly(shortSound, shortSoundFull.byteLength)],
      [
        'invalid SSND offset',
        rangeOnly(
          form('AIFF', [
            chunk('COMM', comm(1, 16, 8000, undefined, 1)),
            chunk('SSND', invalidOffset),
          ]),
        ),
      ],
      ['missing COMM', rangeOnly(form('AIFF', [chunk('SSND', new Uint8Array(8))]))],
    ];

    for (const [label, source] of cases) {
      await expect(consume(source), label).rejects.toBeInstanceOf(MediaError);
    }
  });

  it('grows the bounded metadata window and closes a legal zero-frame range source', async () => {
    const bytes = form('AIFF', [
      chunk('JUNK', new Uint8Array(65_536)),
      chunk('COMM', comm(1, 16, 8000, undefined, 0)),
    ]);
    const reads: Array<readonly [number, number]> = [];
    const source: ByteSource = {
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('bounded AIFF decode must not stream');
      },
    };

    await expect(consume(source)).resolves.toBe(0);
    expect(reads.length).toBeGreaterThan(1);
  });

  it('enforces the range-backed chunk-count safety limit', async () => {
    const emptyChunks = Array.from({ length: 8192 }, () => chunk('JUNK', new Uint8Array(0)));
    const bytes = form('AIFF', emptyChunks);

    await expect(consume(rangeOnly(bytes))).rejects.toMatchObject({
      code: 'demux-error',
      message: expect.stringContaining('safety limit'),
    });
  });

  it('rejects malformed sequential chunk ordering, sizes, padding, and truncation', async () => {
    const invalidOffset = new Uint8Array(8);
    new DataView(invalidOffset.buffer).setUint32(0, 1);

    const oversized = new Uint8Array(28);
    oversized.set(new TextEncoder().encode('FORM'), 0);
    const oversizedSoundSize = 8 + 16 * 1024 * 1024 + 1;
    new DataView(oversized.buffer).setUint32(4, 4 + 8 + oversizedSoundSize + 1);
    oversized.set(new TextEncoder().encode('AIFF'), 8);
    oversized.set(new TextEncoder().encode('SSND'), 12);
    new DataView(oversized.buffer).setUint32(16, oversizedSoundSize);

    const truncatedUnknownFull = form('AIFF', [chunk('JUNK', new Uint8Array(4))]);
    const truncatedUnknown = truncatedUnknownFull.subarray(0, truncatedUnknownFull.byteLength - 2);

    const shortSoundHeaderFull = form('AIFF', [chunk('SSND', new Uint8Array(8))]);
    const shortSoundHeader = shortSoundHeaderFull.subarray(0, shortSoundHeaderFull.byteLength - 4);

    const missingPadFull = form('AIFF', [chunk('SSND', new Uint8Array(9))]);
    const missingPad = missingPadFull.subarray(0, missingPadFull.byteLength - 1);

    const longCommBody = new Uint8Array(20);
    longCommBody.set(comm(1, 16, 8000));
    const shortCommTailFull = form('AIFF', [chunk('COMM', longCommBody)]);
    const shortCommTail = shortCommTailFull.subarray(0, shortCommTailFull.byteLength - 2);

    const duplicateSound = form('AIFF', [
      chunk('SSND', new Uint8Array(8)),
      chunk('SSND', new Uint8Array(8)),
      chunk('COMM', comm(1, 16, 8000, undefined, 0)),
    ]);

    const trailingHeader = form('AIFF', [
      chunk('COMM', comm(1, 16, 8000, undefined, 0)),
      Uint8Array.of(1),
    ]);

    const shortChunkHeader = new Uint8Array(16);
    shortChunkHeader.set(new TextEncoder().encode('FORM'), 0);
    new DataView(shortChunkHeader.buffer).setUint32(4, 12);
    shortChunkHeader.set(new TextEncoder().encode('AIFF'), 8);

    const chunkOutsideForm = new Uint8Array(20);
    chunkOutsideForm.set(new TextEncoder().encode('FORM'), 0);
    new DataView(chunkOutsideForm.buffer).setUint32(4, 12);
    chunkOutsideForm.set(new TextEncoder().encode('AIFFJUNK'), 8);
    new DataView(chunkOutsideForm.buffer).setUint32(16, 4);

    const alignmentBody = new Uint8Array(12);
    new DataView(alignmentBody.buffer).setUint32(0, 4);
    const missingAlignmentFull = form('AIFF', [chunk('SSND', alignmentBody)]);
    const missingAlignment = missingAlignmentFull.subarray(0, missingAlignmentFull.byteLength - 4);

    const shortSpoolBody = new Uint8Array(12);
    const shortSpoolFull = form('AIFF', [chunk('SSND', shortSpoolBody)]);
    const shortSpool = shortSpoolFull.subarray(0, shortSpoolFull.byteLength - 2);

    const cases = [
      form('AIFF', []),
      trailingHeader,
      form('AIFF', [chunk('COMM', new Uint8Array(17))]),
      form('AIFF', [chunk('SSND', new Uint8Array(7))]),
      form('AIFF', [chunk('SSND', invalidOffset)]),
      duplicateSound,
      oversized,
      truncatedUnknown,
      shortSoundHeader,
      missingPad,
      shortCommTail,
      shortChunkHeader,
      chunkOutsideForm,
      missingAlignment,
      shortSpool,
      form(
        'AIFF',
        Array.from({ length: 8192 }, () => chunk('JUNK', new Uint8Array(0))),
      ),
    ];

    for (const bytes of cases) {
      const sourceStream = streamOf(bytes);
      await expect(consume({ stream: () => sourceStream })).rejects.toBeInstanceOf(MediaError);
      expect(sourceStream.locked).toBe(false);
    }
  });

  it('handles empty sequential AIFF and AIFF-C payloads and typed producer failures', async () => {
    for (const [kind, compression] of [
      ['AIFF', undefined],
      ['AIFC', 'sowt'],
    ] as const) {
      const bytes = form(kind, [chunk('COMM', comm(1, 16, 8000, compression, 0))]);
      await expect(consume({ stream: () => streamOf(bytes) })).resolves.toBe(0);
    }

    const sourceError = new MediaError('demux-error', 'typed sequential source failure');
    const broken = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('FORM'));
        controller.error(sourceError);
      },
    });
    await expect(consume({ stream: () => broken })).rejects.toBe(sourceError);
    expect(broken.locked).toBe(false);
  });

  it('threads a live signal through bounded, sequential, head, and whole-source reads', async () => {
    const bytes = form('AIFF', [
      chunk('COMM', comm(1, 16, 8000, undefined, 2)),
      chunk('SSND', Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0x20, 0, 0x40, 0)),
    ]);
    const live = new AbortController();

    await expect(consume(rangeOnly(bytes), live.signal)).resolves.toBe(2);
    await expect(consume({ stream: () => streamOf(bytes) }, live.signal)).resolves.toBe(2);
    await expect(
      probe({ stream: () => streamOf(bytes) }, { signal: live.signal }),
    ).resolves.toHaveLength(1);
    await expect(
      decodeAudio({ stream: () => streamOf(bytes) }, { signal: live.signal }),
    ).resolves.toMatchObject({ frames: 2, channels: 1, sampleRate: 8000 });
  });

  it('preserves empty-head, full-read, and non-Error producer failures', async () => {
    await expect(probe({ stream: () => streamOf(new Uint8Array(0)) })).rejects.toBeInstanceOf(
      InputError,
    );

    const fullReadFailure = new Error('whole AIFF source failed');
    const brokenWholeRead = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.error(fullReadFailure);
      },
    });
    await expect(decodeAudio({ stream: () => brokenWholeRead })).rejects.toBe(fullReadFailure);
    expect(brokenWholeRead.locked).toBe(false);

    const brokenSequential = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('FORM'));
        controller.error('non-Error sequential source failure');
      },
    });
    await expect(consume({ stream: () => brokenSequential })).rejects.toMatchObject({
      code: 'demux-error',
      message: expect.stringContaining('non-Error sequential source failure'),
      detail: 'non-Error sequential source failure',
    });
    expect(brokenSequential.locked).toBe(false);
  });

  it('falls back from a COMM-only packet prefix to a signalled complete range read', async () => {
    const bytes = form('AIFF', [
      chunk('COMM', comm(1, 16, 8000, undefined, 0)),
      chunk('JUNK', new Uint8Array(65_536)),
      chunk('SSND', new Uint8Array(8)),
    ]);
    const reads: Array<readonly [number, number]> = [];
    const live = new AbortController();
    const packetInfo = AiffDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('AiffDriver must expose packetInfo');

    const table = await packetInfo(
      {
        size: bytes.byteLength,
        range(start, end): Promise<Uint8Array> {
          reads.push([start, end]);
          return Promise.resolve(bytes.subarray(start, end));
        },
        stream(): ReadableStream<Uint8Array> {
          throw new Error('sized packet-info must use ranges');
        },
      },
      { signal: live.signal },
    );

    expect(table.packets).toHaveLength(0);
    expect(reads).toEqual([
      [0, 65_536],
      [0, bytes.byteLength],
    ]);
  });

  it('accepts URL objects, default MIME, and a live signal on URL packet-info fallback', async () => {
    const bytes = form('AIFF', [chunk('COMM', comm(1, 16, 8000, undefined, 0))]);
    const server = rangeServer(bytes);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = server.fetch;
    try {
      const live = new AbortController();
      const table = await aiffPacketInfoFromUrl(
        new URL('https://fixtures.invalid/empty-live-signal.aiff'),
        { size: bytes.byteLength, signal: live.signal },
      );
      expect(table.tracks[0]).toMatchObject({
        codec: 'pcm-s16be',
        config: { sampleRate: 8000, numberOfChannels: 1 },
      });
      expect(table.packets).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns an empty stream when COMM precedes an explicitly empty SSND', async () => {
    const bytes = form('AIFF', [
      chunk('COMM', comm(1, 16, 8000, undefined, 0)),
      chunk('SSND', new Uint8Array(8)),
    ]);

    await expect(consume({ stream: () => streamOf(bytes) })).resolves.toBe(0);
  });
});

describe('writeAiff — container-specific PCM legality', () => {
  it('rejects unsigned 8-bit AIFF because AIFF 8-bit PCM is signed', async () => {
    const pcm = readAiffPcm(await loadDerived('sfx.aiff'));
    expect(() => writeAiff(pcm, 'u8')).toThrowError(CapabilityError);
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

function rangeServer(bytes: Uint8Array): {
  readonly fetch: typeof fetch;
  readonly calls: Array<{
    readonly method: string;
    readonly range: string | null;
    readonly bytes: number;
  }>;
} {
  const calls: Array<{ method: string; range: string | null; bytes: number }> = [];
  const total = bytes.byteLength;
  const fetchImpl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers as { Range?: string } | undefined;
    const range = headers?.Range ?? null;
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (match === null) return new Response('bad range', { status: 416 });
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]) + 1, total);
      const slice = bytes.subarray(start, Math.max(start, end));
      calls.push({ method, range, bytes: slice.byteLength });
      return new Response(slice.slice(), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${start + slice.byteLength - 1}/${total}` },
      });
    }
    calls.push({ method, range, bytes: total });
    return new Response(bytes.slice(), {
      status: 200,
      headers: { 'Content-Length': String(total) },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
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

function sliceAiffReference(
  bytes: Uint8Array,
  bounds: { readonly startSec: number; readonly endSec: number },
): Uint8Array {
  const source = readAiffPcm(bytes);
  const start = Math.min(
    source.frames,
    Math.max(0, Math.round(bounds.startSec * source.sampleRate)),
  );
  const end = Math.min(
    source.frames,
    Math.max(start, Math.round(bounds.endSec * source.sampleRate)),
  );
  return writeAiff(
    {
      sampleRate: source.sampleRate,
      channels: source.channels,
      frames: end - start,
      planar: source.planar.map((ch) => ch.subarray(start, end)),
    },
    source.format,
    { kind: source.kind, endian: source.endian },
  );
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
