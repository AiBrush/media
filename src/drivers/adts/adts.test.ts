import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { Mp3Driver } from '../mp3/mp3-driver.ts';
import {
  AdtsDriver,
  adtsAacPcmDecodePlan,
  concatPcmChunks,
  enumerateAdtsFrames,
  parseAdts,
  pcmFromInterleavedF32,
} from './adts-driver.ts';

/** Build a crafted ADTS stream of `count` AAC frames (7-byte headers + zero payload). */
function buildAdts(
  opts: {
    count?: number;
    freqIndex?: number;
    channelConfig?: number;
    profile?: number;
    payload?: number;
    id3?: boolean;
  } = {},
): Uint8Array {
  const {
    count = 3,
    freqIndex = 4,
    channelConfig = 2,
    profile = 1,
    payload = 5,
    id3 = false,
  } = opts;
  const frameLen = 7 + payload;
  const bytes: number[] = [];
  if (id3) bytes.push(0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const b2 = ((profile & 0x3) << 6) | ((freqIndex & 0xf) << 2) | ((channelConfig >> 2) & 0x1);
    const b3 = ((channelConfig & 0x3) << 6) | ((frameLen >> 11) & 0x3);
    bytes.push(0xff, 0xf1, b2, b3, (frameLen >> 3) & 0xff, ((frameLen & 0x7) << 5) | 0x1f, 0xfc);
    for (let j = 0; j < payload; j++) bytes.push(0);
  }
  return new Uint8Array(bytes);
}

describe('AdtsDriver.supports — incl. MP3 disambiguation', () => {
  it('recognizes the syncword, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('sfx.adts')).subarray(0, 16);
    expect(AdtsDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(AdtsDriver.supports({ direction: 'demux', mime: 'audio/aac' })).toBe(true);
    expect(AdtsDriver.supports({ direction: 'demux', extension: 'aac' })).toBe(true);
    expect(AdtsDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
  });

  it('ADTS and MP3 are mutually exclusive by the layer bits', async () => {
    const adtsHead = (await loadFixture('sfx.adts')).subarray(0, 8);
    const mp3Head = (await loadFixture('sound_5.mp3')).subarray(0, 8);
    expect(AdtsDriver.supports({ direction: 'demux', head: adtsHead })).toBe(true);
    expect(Mp3Driver.supports({ direction: 'demux', head: adtsHead })).toBe(false); // not MP3
    expect(AdtsDriver.supports({ direction: 'demux', head: mp3Head })).toBe(false); // not ADTS
  });
});

describe('probe ADTS — real corpus', () => {
  it('sfx.adts — AAC-LC, 48 kHz mono, ~0.213 s (invariants)', async () => {
    const info = await createMedia().probe(await fixtureSource('sfx.adts'));
    expect(info.container).toBe('adts');
    expect(info.tracks[0]?.codec).toBe('mp4a.40.2');
    expect(info.tracks[0]?.sampleRate).toBe(48000);
    expect(info.tracks[0]?.channels).toBe(1);
    expect(info.durationSec).toBeCloseTo(10240 / 48000, 5);
  });

  it('sfx.adts probe matches its committed golden exactly', async () => {
    expect(await createMedia().probe(await fixtureSource('sfx.adts'))).toEqual(
      await loadGoldenMetadata('sfx.adts'),
    );
  });

  it('parseAdts walks the real frames (10 × 1024 samples)', async () => {
    const info = parseAdts(await loadFixture('sfx.adts'));
    expect(info.frames).toBe(10);
    expect(info.sampleRate).toBe(48000);
    expect(info.channels).toBe(1);
  });

  it('routes by magic alone (no mime hint) without MP3 stealing it', async () => {
    const adts = await createMedia().probe(fromBytes(await loadFixture('sfx.adts')));
    expect(adts.container).toBe('adts');
    const mp3 = await createMedia().probe(fromBytes(await loadFixture('sound_5.mp3')));
    expect(mp3.container).toBe('mp3');
  });

  it('the packet seam is browser-gated (EncodedAudioChunk absent in node → typed CapabilityError)', async () => {
    const demuxed = await AdtsDriver.demux(await fixtureSource('sfx.adts'));
    // In node WebCodecs' EncodedAudioChunk is undefined → the same typed miss the mpegts driver raises.
    expect(() => demuxed.packets(0)).toThrowError(CapabilityError);
    expect(() => demuxed.packets(1)).toThrowError(MediaError); // unknown track id
    await demuxed.close();
  });

  it('attaches a synthesized 2-byte AudioSpecificConfig to the track config', async () => {
    const demuxed = await AdtsDriver.demux(await fixtureSource('sfx.adts'));
    const config = demuxed.tracks[0]?.config as AudioDecoderConfig | undefined;
    // AOT=2 (LC), freqIdx=3 (48 kHz), chCfg=1 (mono): byte0=(2<<3)|(3>>1)=0x11, byte1=((3&1)<<7)|(1<<3)=0x88.
    expect(config?.description).toBeInstanceOf(Uint8Array);
    expect(Array.from(config?.description as Uint8Array)).toEqual([0x11, 0x88]);
    await demuxed.close();
  });

  it('createMuxer returns a real ADTS muxer (AAC access units → 7-byte ADTS frames)', () => {
    const muxer = AdtsDriver.createMuxer();
    // A non-AAC track is rejected; the AdtsMuxer round-trip is verified in adts-remux.test.ts.
    expect(() => muxer.addTrack({ id: 0, mediaType: 'audio', codec: 'opus' })).toThrowError(/AAC/);
  });

  it('demuxes a non-seekable stream source (reads the header from the first chunk)', async () => {
    const bytes = await loadFixture('sfx.adts');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxed = await AdtsDriver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('mp4a.40.2');
  });
});

describe('parseAdts — variants + robustness', () => {
  it('parses a crafted stereo / 44.1 kHz stream and counts frames', () => {
    const info = parseAdts(buildAdts({ count: 4, freqIndex: 4, channelConfig: 2 }));
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
    expect(info.frames).toBe(4);
    expect(info.durationSec).toBeCloseTo((4 * 1024) / 44100, 6);
  });

  it('extrapolates duration when only a head of a larger file is seen', () => {
    const head = buildAdts({ count: 2, payload: 20 }); // 2 frames present...
    const fullSize = head.byteLength * 5; // ...but the file is ~5× longer
    const partial = parseAdts(head);
    const extrapolated = parseAdts(head, fullSize);
    expect(extrapolated.durationSec).toBeGreaterThan(partial.durationSec * 4);
  });

  it('skips an ID3v2 prefix before the first frame', () => {
    expect(parseAdts(buildAdts({ id3: true, freqIndex: 3 })).sampleRate).toBe(48000);
  });

  it('rejects a non-ADTS stream', () => {
    expect(() => parseAdts(new Uint8Array(8))).toThrowError(InputError);
  });

  it('rejects a reserved sampling-frequency index', () => {
    expect(() => parseAdts(buildAdts({ freqIndex: 13 }))).toThrowError(/sampling-frequency/);
  });
});

describe('enumerateAdtsFrames — strict can-fail oracle vs ffprobe (sfx.adts)', () => {
  // INDEPENDENT ground truth — baked, NOT shelled out at run time (the repo golden pattern). Recorded with:
  //   ffprobe -v error -show_packets -select_streams a:0 -of csv=p=0 \
  //           -show_entries packet=pts_time,size fixtures/media/sfx.adts
  // ffprobe's ADTS `size` is the FULL frame (7-byte header + payload; this stream has no CRC). PTS advances
  // by exactly 1024/48000 s = 21333.33µs per frame. All 10 frames consume the whole 2078-byte file.
  const FFPROBE: ReadonlyArray<{ ptsSec: number; size: number }> = [
    { ptsSec: 0.0, size: 248 },
    { ptsSec: 0.021333, size: 280 },
    { ptsSec: 0.042667, size: 258 },
    { ptsSec: 0.064, size: 125 },
    { ptsSec: 0.085333, size: 230 },
    { ptsSec: 0.106667, size: 148 },
    { ptsSec: 0.128, size: 224 },
    { ptsSec: 0.149333, size: 166 },
    { ptsSec: 0.170667, size: 216 },
    { ptsSec: 0.192, size: 183 },
  ];

  it('reproduces the packet COUNT, every full-frame SIZE, and every PTS within ±1µs', async () => {
    const frames = enumerateAdtsFrames(await loadFixture('sfx.adts'));
    expect(frames.length).toBe(FFPROBE.length); // 10 frames — count must match exactly
    for (let i = 0; i < FFPROBE.length; i++) {
      const f = frames[i];
      const g = FFPROBE[i];
      if (!f || !g) throw new Error(`missing frame ${i}`);
      expect(f.size).toBe(g.size); // byte-exact full-frame length == ffprobe size (can fail if mis-framed)
      expect(Math.abs(f.ptsUs - Math.round(g.ptsSec * 1_000_000))).toBeLessThanOrEqual(1);
    }
  });

  it('frames tile the file: offsets are contiguous and the last frame ends at EOF', async () => {
    const bytes = await loadFixture('sfx.adts');
    const frames = enumerateAdtsFrames(bytes);
    let expected = 0; // ID3-free fixture, so the first frame is at offset 0
    for (const f of frames) {
      expect(f.offset).toBe(expected);
      expect(f.headerBytes).toBe(7); // protection_absent==1 → no CRC
      expect(f.durationUs).toBe(21333); // round(1024*1e6/48000)
      expected += f.size;
    }
    expect(expected).toBe(bytes.byteLength); // every byte accounted for — no gaps, no overrun
  });

  it('the raw access unit (header stripped) is size − 7 bytes and starts past the syncword', async () => {
    const bytes = await loadFixture('sfx.adts');
    const frames = enumerateAdtsFrames(bytes);
    const f = frames[0];
    if (!f) throw new Error('no frames');
    const au = bytes.subarray(f.offset + f.headerBytes, f.offset + f.size);
    expect(au.byteLength).toBe(f.size - 7);
    expect(bytes[f.offset]).toBe(0xff); // the stripped header began with the syncword
  });

  it('rejects truncated / garbage input (the oracle can fail on bad bytes)', () => {
    expect(() => enumerateAdtsFrames(new Uint8Array(6))).toThrowError(InputError); // too short
    expect(() =>
      enumerateAdtsFrames(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])),
    ).toThrowError(InputError); // no syncword
  });

  it('stops cleanly when the declared frame_length overruns a truncated tail', () => {
    // A single header claiming frameLen 248 but only 100 bytes present: no full frame ⇒ honest reject.
    const truncated = buildAdts({ count: 1, payload: 241 }).subarray(0, 100);
    expect(() => enumerateAdtsFrames(truncated)).toThrowError(InputError);
  });
});

describe('AdtsDriver.decodePcm — ADTS AAC to WAV PCM bridge', () => {
  const decodePcm = AdtsDriver.decodePcm;
  if (!decodePcm) throw new Error('AdtsDriver must expose decodePcm');

  it('plans Firefox and force-software AAC PCM extraction through the wasm AAC tail', () => {
    expect(adtsAacPcmDecodePlan(false)).toEqual(['webcodecs-audio', 'wasm-aac']);
    expect(adtsAacPcmDecodePlan(false, 'auto')).toEqual(['webcodecs-audio', 'wasm-aac']);
    expect(adtsAacPcmDecodePlan(true)).toEqual(['wasm-aac']);
    expect(adtsAacPcmDecodePlan(false, 'force-software')).toEqual(['wasm-aac']);
    expect(adtsAacPcmDecodePlan(true, 'force-software')).toEqual(['wasm-aac']);
  });

  it('converts interleaved f32 decoder output into canonical planar PCM', () => {
    const pcm = pcmFromInterleavedF32(new Float32Array([0.25, -0.25, 0.5, -0.5]), 2, 48_000);
    expect(pcm.sampleRate).toBe(48_000);
    expect(pcm.channels).toBe(2);
    expect(pcm.frames).toBe(2);
    expect(Array.from(pcm.planar[0] ?? [])).toEqual([0.25, 0.5]);
    expect(Array.from(pcm.planar[1] ?? [])).toEqual([-0.25, -0.5]);
  });

  it('rejects impossible decoded PCM geometry', () => {
    expect(() => pcmFromInterleavedF32(new Float32Array([1, 2, 3]), 2, 48_000)).toThrowError(
      MediaError,
    );
    expect(() => concatPcmChunks([], 48_000, 0)).toThrowError(MediaError);
  });

  it('concatenates sequential decoded chunks and rejects geometry drift', () => {
    const a = pcmFromInterleavedF32(new Float32Array([0.1, 0.2]), 1, 48_000);
    const b = pcmFromInterleavedF32(new Float32Array([0.3, 0.4, 0.5]), 1, 48_000);
    const merged = concatPcmChunks([a, b], 48_000, 1);
    expect(merged.frames).toBe(5);
    expect(Array.from(merged.planar[0] ?? [])).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
      expect.closeTo(0.4),
      expect.closeTo(0.5),
    ]);

    const wrongRate = pcmFromInterleavedF32(new Float32Array([0.6]), 1, 44_100);
    expect(() => concatPcmChunks([a, wrongRate], 48_000, 1)).toThrowError(MediaError);
  });

  it('honors an already-aborted signal before acquiring a browser or wasm decoder', async () => {
    await expect(
      decodePcm(await fixtureSource('sfx.adts'), { signal: AbortSignal.abort() }),
    ).rejects.toThrowError(/abort/i);
  });
});
