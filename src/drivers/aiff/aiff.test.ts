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
