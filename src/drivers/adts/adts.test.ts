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
  adtsAacPcmRuntimePolicy,
  adtsPacketInfoFromBytes,
  adtsTrimFromBytes,
  adtsTrimFromUrl,
  concatPcmChunks,
  dropLeadingPcmFrames,
  enumerateAdtsFrames,
  parseAdts,
  pcmFromInterleavedF32,
} from './adts-driver.ts';
import { canUseAdtsWasmDirectS16Wav, writeInterleavedF32S16le } from './adts-pcm-direct.ts';

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

  it('packetInfo enumerates ADTS frame facts without constructing packet chunks', async () => {
    if (AdtsDriver.packetInfo === undefined) throw new Error('expected ADTS packetInfo');
    const bytes = await loadFixture('sfx.adts');
    const table = await AdtsDriver.packetInfo(fromBytes(bytes, { mime: 'audio/aac' }));
    expect(adtsPacketInfoFromBytes(bytes)).toEqual(table);
    const frames = enumerateAdtsFrames(bytes);

    expect(table.tracks[0]?.codec).toBe('mp4a.40.2');
    expect(table.tracks[0]?.config?.description).toBeInstanceOf(Uint8Array);
    expect(table.packets).toHaveLength(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const row = table.packets[i];
      const frame = frames[i];
      if (row === undefined || frame === undefined) throw new Error(`missing packet row ${i}`);
      expect(row).toEqual({
        trackIndex: 0,
        offset: frame.offset,
        size: frame.size,
        ptsUs: frame.ptsUs,
        dtsUs: frame.ptsUs,
        durationUs: frame.durationUs,
        keyframe: true,
      });
    }
  });

  it('demux exposes the exact real-corpus ADTS packet metadata without WebCodecs chunks', async () => {
    const bytes = await loadFixture('sfx.adts');
    const demuxed = await AdtsDriver.demux(fromBytes(bytes, { mime: 'audio/aac' }));
    try {
      const table = demuxed.packetTable?.();
      const expected = adtsPacketInfoFromBytes(bytes).packets.map((packet) => ({
        trackId: packet.trackIndex,
        sizeBytes: packet.size,
        ptsUs: packet.ptsUs,
        dtsUs: packet.dtsUs,
        durationUs: packet.durationUs,
        keyframe: packet.keyframe,
      }));
      expect(table).toEqual(expected);
    } finally {
      await demuxed.close();
    }
  });

  it('demux reuses its validated real-file layout for exact raw AAC packet emission', async () => {
    const bytes = await loadFixture('sfx.adts');
    const frames = enumerateAdtsFrames(bytes);
    const original = globalThis.EncodedAudioChunk;
    class FakeEncodedAudioChunk {
      readonly type: EncodedAudioChunkType;
      readonly timestamp: number;
      readonly duration: number | null;
      readonly byteLength: number;
      readonly #data: Uint8Array;

      constructor(init: EncodedAudioChunkInit) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.duration = init.duration ?? null;
        this.#data = ArrayBuffer.isView(init.data)
          ? new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength).slice()
          : new Uint8Array(init.data).slice();
        this.byteLength = this.#data.byteLength;
      }

      copyTo(destination: AllowSharedBufferSource): void {
        new Uint8Array(
          ArrayBuffer.isView(destination) ? destination.buffer : destination,
          ArrayBuffer.isView(destination) ? destination.byteOffset : 0,
          ArrayBuffer.isView(destination) ? destination.byteLength : destination.byteLength,
        ).set(this.#data);
      }
    }
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: FakeEncodedAudioChunk as unknown as typeof EncodedAudioChunk,
    });
    try {
      const demuxed = await AdtsDriver.demux(fromBytes(bytes, { mime: 'audio/aac' }));
      const reader = demuxed.packets(0).getReader();
      try {
        for (const frame of frames) {
          const result = await reader.read();
          expect(result.done).toBe(false);
          const packet = result.value;
          if (packet === undefined) throw new Error('missing emitted AAC packet');
          const data = new Uint8Array(packet.chunk.byteLength);
          packet.chunk.copyTo(data);
          expect(data).toEqual(
            bytes.subarray(frame.offset + frame.headerBytes, frame.offset + frame.size),
          );
          expect(packet.chunk.timestamp).toBe(frame.ptsUs);
          expect(packet.chunk.duration).toBe(frame.durationUs);
          expect(packet.sizeBytes).toBe(frame.size);
        }
        expect((await reader.read()).done).toBe(true);
      } finally {
        reader.releaseLock();
        await demuxed.close();
      }
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
      else
        Object.defineProperty(globalThis, 'EncodedAudioChunk', {
          configurable: true,
          value: original,
        });
    }
  });

  it('streamCopy trim emits the original complete ADTS frames overlapping the requested range', async () => {
    if (AdtsDriver.streamCopy === undefined) throw new Error('expected ADTS streamCopy');
    expect(AdtsDriver.validatesStreamCopyTrim).toBe(true);
    const bytes = await loadFixture('sfx.adts');
    const frames = enumerateAdtsFrames(bytes);
    const startSec = 0.04;
    const endSec = 0.16;
    const selected = frames.filter(
      (frame) =>
        frame.ptsUs + frame.durationUs > Math.round(startSec * 1_000_000) &&
        frame.ptsUs < Math.round(endSec * 1_000_000),
    );

    let total = 0;
    for (const frame of selected) total += frame.size;
    const expected = new Uint8Array(total);
    let offset = 0;
    for (const frame of selected) {
      const packet = bytes.subarray(frame.offset, frame.offset + frame.size);
      expected.set(packet, offset);
      offset += packet.byteLength;
    }

    const out = await collectBytes(
      await AdtsDriver.streamCopy(fromBytes(bytes, { mime: 'audio/aac' }), {
        trim: { startSec, endSec },
      }),
    );
    expect(out).toEqual(expected);
    expect(enumerateAdtsFrames(out)).toHaveLength(selected.length);
  });

  it('streamCopy trim keeps invalid ranges typed before emitting bytes', async () => {
    if (AdtsDriver.streamCopy === undefined) throw new Error('expected ADTS streamCopy');
    await expect(
      AdtsDriver.streamCopy(await fixtureSource('sfx.adts'), {
        trim: { startSec: 0.1, endSec: 0.1 },
      }),
    ).rejects.toThrowError(InputError);
  });

  it('adtsTrimFromUrl fetches source bytes once and re-emits a fresh exact frame trim', async () => {
    const bytes = await loadFixture('sfx.adts');
    const server = rangeServer(bytes);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = server.fetch;
    try {
      const trim = { startSec: 0.04, endSec: 0.16 };
      const expected = adtsTrimFromBytes(bytes, trim);
      const first = await adtsTrimFromUrl('https://fixtures.invalid/sfx.adts', {
        ...trim,
        mime: 'audio/aac',
        size: bytes.byteLength,
      });
      const second = await adtsTrimFromUrl('https://fixtures.invalid/sfx.adts', {
        ...trim,
        mime: 'audio/aac',
        size: bytes.byteLength,
      });
      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
      expect(second).not.toBe(first);
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]).toMatchObject({ method: 'GET', bytes: bytes.byteLength });
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it('NEVER extrapolates: duration is exactly the walked frames, whatever totalSize claims', () => {
    const head = buildAdts({ count: 2, payload: 20 }); // 2 complete frames present...
    const fullSize = head.byteLength * 5; // ...and a 5×-larger claimed file changes NOTHING
    const partial = parseAdts(head);
    const withClaim = parseAdts(head, fullSize); // deprecated arg is inert (exact walk)
    expect(partial.frames).toBe(2);
    expect(partial.durationSec).toBe((2 * 1024) / 44_100);
    expect(withClaim).toEqual(partial);
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

  it('carries exact decoded sample counts per ADTS frame for direct PCM sizing', async () => {
    const frames = enumerateAdtsFrames(await loadFixture('sfx.adts'));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.samples === 1024)).toBe(true);
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

  it('suppresses WebKit native ADTS AAC presentation lead-in without changing codec routing', () => {
    expect(adtsAacPcmRuntimePolicy(false, false)).toEqual({
      wasmOnly: false,
      nativeLeadingSamples: 0,
    });
    expect(adtsAacPcmRuntimePolicy(true, false)).toEqual({
      wasmOnly: true,
      nativeLeadingSamples: 0,
    });
    expect(adtsAacPcmRuntimePolicy(false, true)).toEqual({
      wasmOnly: false,
      nativeLeadingSamples: 2112,
    });
  });

  it('drops a native decoder lead-in from every PCM plane without mutating the source', () => {
    const source = {
      sampleRate: 48_000,
      channels: 2,
      frames: 4,
      planar: [new Float64Array([1, 2, 3, 4]), new Float64Array([5, 6, 7, 8])],
    };
    expect(dropLeadingPcmFrames(source, 2)).toEqual({
      sampleRate: 48_000,
      channels: 2,
      frames: 2,
      planar: [new Float64Array([3, 4]), new Float64Array([7, 8])],
    });
    expect(Array.from(source.planar[0] ?? [])).toEqual([1, 2, 3, 4]);
    expect(dropLeadingPcmFrames(source, 9).frames).toBe(0);
    expect(() => dropLeadingPcmFrames(source, -1)).toThrowError(MediaError);
  });

  it('uses the direct wasm-s16 WAV route only on wasm-only or force-software runtimes', () => {
    expect(
      canUseAdtsWasmDirectS16Wav(
        163_811,
        48_000,
        2,
        { container: 'wav', sampleFormat: 's16' },
        false,
      ),
    ).toBe(false);
    expect(
      canUseAdtsWasmDirectS16Wav(
        300_000,
        48_000,
        2,
        { container: 'wav', sampleFormat: 's16' },
        false,
      ),
    ).toBe(false);
    expect(
      canUseAdtsWasmDirectS16Wav(
        300_000,
        48_000,
        2,
        { container: 'wav', sampleFormat: 's16' },
        true,
      ),
    ).toBe(true);
    expect(
      canUseAdtsWasmDirectS16Wav(
        163_811,
        48_000,
        2,
        { container: 'wav', sampleFormat: 's16', determinism: 'force-software' },
        false,
      ),
    ).toBe(true);
    expect(canUseAdtsWasmDirectS16Wav(163_811, 48_000, 2, { sampleRate: 44_100 }, false)).toBe(
      false,
    );
    expect(canUseAdtsWasmDirectS16Wav(163_811, 48_000, 2, { channels: 1 }, false)).toBe(false);
    expect(canUseAdtsWasmDirectS16Wav(163_811, 48_000, 2, { gainDb: -3 }, false)).toBe(false);
    expect(canUseAdtsWasmDirectS16Wav(163_811, 48_000, 2, { sampleFormat: 'f32' }, false)).toBe(
      false,
    );
  });

  it('writes direct interleaved f32 samples with the canonical s16 clamp and rounding rule', () => {
    const out = new Uint8Array(14);
    const dv = new DataView(out.buffer);
    const end = writeInterleavedF32S16le(
      dv,
      0,
      new Float32Array([-1.25, -1, -0.5, 0, 0.5, 1, 1.25]),
    );
    expect(end).toBe(out.byteLength);
    expect(Array.from({ length: 7 }, (_, index) => dv.getInt16(index * 2, true))).toEqual([
      -32768, -32768, -16384, 0, 16384, 32767, 32767,
    ]);
  });

  it('uses nearest-even for exact positive and negative half-LSB direct s16 writes', () => {
    const codes = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
    const out = new Uint8Array(codes.length * 2);
    writeInterleavedF32S16le(
      new DataView(out.buffer),
      0,
      Float32Array.from(codes, (code) => code / 32_768),
    );

    expect(Array.from(new Int16Array(out.buffer))).toEqual([-2, -2, 0, 0, 2, 2]);
  });

  it('writes direct s16 samples correctly when the destination is not Int16Array-aligned', () => {
    const out = new Uint8Array(7);
    const dv = new DataView(out.buffer);
    const end = writeInterleavedF32S16le(dv, 1, new Float32Array([-0.25, 0.25, 1.25]));
    expect(end).toBe(out.byteLength);
    expect(Array.from(out)).toEqual([0, 0, 224, 0, 32, 255, 127]);
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
