import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type {
  CodecDriver,
  ContainerDriver,
  FilterDriver,
  FilterSpec,
  Packet,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { Registry } from '../kernel/registry.ts';
import { fromBytes } from '../sources/source.ts';
import { fixtureSource } from '../test-support/corpus.ts';
import { registerDefaultDrivers } from './defaults.ts';

const DERIVED = new URL('../../fixtures/media-derived/', import.meta.url).pathname;

function findContainer(reg: Registry, id: string): ContainerDriver {
  const driver = reg.containers().find((d) => d.id === id);
  if (driver === undefined) throw new Error(`missing container driver '${id}'`);
  return driver;
}

function findCodec(reg: Registry, id: string): CodecDriver {
  const driver = reg.codecs().find((d) => d.id === id);
  if (driver === undefined) throw new Error(`missing codec driver '${id}'`);
  return driver;
}

function findFilter(reg: Registry, id: string): FilterDriver {
  const driver = reg.filters().find((d) => d.id === id);
  if (driver === undefined) throw new Error(`missing filter driver '${id}'`);
  return driver;
}

function defineGlobal(key: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  };
}

async function closeEmptyFilterStream(
  stream: TransformStream<VideoFrame, VideoFrame> | TransformStream<AudioData, AudioData>,
): Promise<void> {
  const generic = stream as TransformStream<unknown, unknown>;
  const writer = generic.writable.getWriter();
  const reader = generic.readable.getReader();
  try {
    await writer.close();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  } finally {
    reader.releaseLock();
  }
}

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

function fakeEncodedAudioChunk(bytes: Uint8Array): EncodedAudioChunk {
  const chunk = {
    byteLength: bytes.byteLength,
    timestamp: 0,
    duration: 1024,
    type: 'key',
    copyTo(destination: AllowSharedBufferSource): void {
      const out = ArrayBuffer.isView(destination)
        ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
        : new Uint8Array(destination);
      out.set(bytes);
    },
  };
  return chunk as unknown as EncodedAudioChunk;
}

async function derivedBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${DERIVED}${name}`));
}

function flacTrackInfo(description: Uint8Array): TrackInfo {
  return {
    id: 7,
    mediaType: 'audio',
    codec: 'flac',
    config: {
      codec: 'flac',
      sampleRate: 48_000,
      numberOfChannels: 1,
      description,
    },
  };
}

describe('registerDefaultDrivers', () => {
  it('registers image support on the default registry host', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const images = reg.imageOps();
    expect(images).toBeDefined();
    expect(images?.formats).toEqual(['gif', 'png', 'jpeg', 'webp', 'avif']);
    expect(images?.sniff(await derivedBytes('img/anim2.gif'))).toBe('gif');
    expect(images?.sniff(await derivedBytes('img/test.png'))).toBe('png');
    expect(images?.sniff(await derivedBytes('img/test.jpeg'))).toBe('jpeg');
    expect(images?.sniff(await derivedBytes('img/test.webp'))).toBe('webp');
    expect(images?.sniff(await derivedBytes('img/test.avif'))).toBe('avif');
    expect(images?.sniff(new TextEncoder().encode('GIF87a'))).toBe('gif');
    expect(images?.sniff(new TextEncoder().encode('GIF89a'))).toBe('gif');
    expect(images?.sniff(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41]))).toBe(
      undefined,
    );
    expect(
      images?.sniff(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]),
      ),
    ).toBe(undefined);
    expect(
      images?.sniff(
        new Uint8Array([
          0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00,
          0x00, 0x61, 0x76, 0x69, 0x66,
        ]),
      ),
    ).toBe('avif');
    expect(
      images?.sniff(
        new Uint8Array([
          0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00,
          0x00, 0x61, 0x76, 0x69, 0x73,
        ]),
      ),
    ).toBe('avif');
    expect(
      images?.sniff(
        new Uint8Array([
          0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00,
          0x00, 0x6d, 0x70, 0x34, 0x32,
        ]),
      ),
    ).toBe(undefined);
  });

  it('lazy-loads image probe while keeping decode as a typed Node miss', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const images = reg.imageOps();
    if (images === undefined) throw new Error('default drivers must register image ops');

    await expect(images.probe(await derivedBytes('img/anim2.gif'))).resolves.toMatchObject({
      format: 'gif',
      width: 480,
      height: 360,
      frameCount: 36,
      animated: true,
    });
    expect(images.canDecode()).toBe(false);

    const still = await derivedBytes('img/test.png');
    await expect(images.decode(still).getReader().read()).rejects.toBeInstanceOf(CapabilityError);
    await expect(
      (async () => {
        for await (const frame of images.decodeFrames(still)) frame.close();
      })(),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('registers the real software video-decode wasm tails (AV1/VPx) now that their cores are vendored', () => {
    // AV1 (dav1d, ADR-093) and VP8/VP9 (ogv.js libvpx, ADR-094) ship vendored prebuilt cores and are
    // registered as miss-only fallbacks — they are no longer core-less scaffolds. They still `supports()`
    // →false in Node (no WebCodecs `VideoFrame` seam); registration just makes the tail available so a
    // browser WebCodecs miss can lazy-load the wasm.
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const ids = reg.codecs().map((d) => d.id);
    expect(ids).toContain('wasm-av1');
    expect(ids).toContain('wasm-vpx');
  });

  it('registers exact lightweight proxies for every long-tail audio container', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const wav = findContainer(reg, 'wav');
    const mp3 = findContainer(reg, 'mp3');
    const ogg = findContainer(reg, 'ogg');
    const adts = findContainer(reg, 'adts');
    const aiff = findContainer(reg, 'aiff');
    const caf = findContainer(reg, 'caf');

    expect(wav.supports({ direction: 'demux', extension: 'WAVE' })).toBe(true);
    expect(
      wav.supports({
        direction: 'demux',
        head: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
      }),
    ).toBe(true);
    expect(mp3.supports({ direction: 'demux', head: new Uint8Array([0xff, 0xfb, 0x90]) })).toBe(
      true,
    );
    expect(
      adts.supports({ direction: 'demux', head: new Uint8Array([0xff, 0xf1, 0, 0, 0, 0, 0]) }),
    ).toBe(true);
    expect(mp3.supports({ direction: 'demux', head: new Uint8Array([0xff, 0xf1, 0]) })).toBe(false);
    expect(
      adts.supports({ direction: 'demux', head: new Uint8Array([0xff, 0xfb, 0, 0, 0, 0, 0]) }),
    ).toBe(false);
    expect(ogg.supports({ direction: 'demux', head: new TextEncoder().encode('OggS') })).toBe(true);
    expect(
      aiff.supports({ direction: 'demux', head: new TextEncoder().encode('FORM0000AIFF') }),
    ).toBe(true);
    expect(caf.supports({ direction: 'demux', head: new TextEncoder().encode('caff') })).toBe(true);
    expect(caf.supports({ direction: 'demux', extension: 'mp4' })).toBe(false);

    expect(wav).toMatchObject({ validatesPcmTrim: true });
    expect(ogg).toMatchObject({ validatesStreamCopyTrim: true });
    expect(adts).toMatchObject({ validatesStreamCopyTrim: true });
    expect(typeof wav.probe).toBe('function');
    expect(typeof wav.packetInfo).toBe('function');
    expect(typeof wav.transformPcm).toBe('function');
    expect(typeof wav.decodePcmAudio).toBe('function');
    expect(typeof adts.decodePcm).toBe('function');
    expect(aiff.probe).toBeUndefined();
    expect(caf.packetInfo).toBeUndefined();
  });

  it('loads each long-tail audio implementation only after its proxy is selected', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const probeCases = [
      ['wav', 'speech.wav', 'pcm-s16'],
      ['mp3', 'sound_5.mp3', 'mp3'],
      ['ogg', 'sound_5.oga', 'vorbis'],
      ['adts', 'sfx.adts', 'mp4a.40.2'],
    ] as const;
    for (const [id, fixture, codec] of probeCases) {
      const probe = findContainer(reg, id).probe;
      if (probe === undefined) throw new Error(`${id} proxy must preserve probe`);
      await expect(probe(await fixtureSource(fixture))).resolves.toMatchObject([{ codec }]);
    }

    for (const [id, fixture, codec] of [
      ['aiff', 'aiff-caf/sfx.aiff', 'pcm-s16be'],
      ['caf', 'aiff-caf/sfx.caf', 'pcm-s16'],
    ] as const) {
      const demuxer = await findContainer(reg, id).demux(fromBytes(await derivedBytes(fixture)));
      expect(demuxer.tracks[0]?.codec).toBe(codec);
      await demuxer.close();
    }
  });

  it('preserves synchronous mux option, track, and single-track validation before lazy load', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    for (const id of ['wav', 'mp3', 'ogg', 'adts'] as const) {
      expect(() => findContainer(reg, id).createMuxer({ fragmented: true })).toThrowError(
        CapabilityError,
      );
    }

    const cases: ReadonlyArray<readonly [string, TrackInfo, TrackInfo]> = [
      [
        'wav',
        {
          id: 0,
          mediaType: 'audio',
          codec: 'pcm-s16',
          config: { codec: 'pcm-s16', sampleRate: 48_000, numberOfChannels: 2 },
        },
        { id: 1, mediaType: 'video', codec: 'h264' },
      ],
      [
        'mp3',
        { id: 0, mediaType: 'audio', codec: 'mp3' },
        { id: 1, mediaType: 'audio', codec: 'aac' },
      ],
      [
        'ogg',
        {
          id: 0,
          mediaType: 'audio',
          codec: 'opus',
          config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
        },
        { id: 1, mediaType: 'video', codec: 'vp9' },
      ],
      [
        'adts',
        {
          id: 0,
          mediaType: 'audio',
          codec: 'mp4a.40.2',
          config: {
            codec: 'mp4a.40.2',
            sampleRate: 48_000,
            numberOfChannels: 2,
            description: new Uint8Array([0x11, 0x90]),
          },
        },
        { id: 1, mediaType: 'audio', codec: 'mp3' },
      ],
    ];
    for (const [id, valid, invalid] of cases) {
      expect(() => findContainer(reg, id).createMuxer().addTrack(invalid)).toThrowError(
        CapabilityError,
      );
      const muxer = findContainer(reg, id).createMuxer();
      expect(muxer.addTrack(valid)).toBe(0);
      expect(() => muxer.addTrack(valid)).toThrowError(CapabilityError);
    }

    expect(() => findContainer(reg, 'aiff').createMuxer()).toThrowError(MediaError);
    expect(() => findContainer(reg, 'caf').createMuxer()).toThrowError(MediaError);
  });

  it('registers FLAC as a lazy container proxy with cheap support checks', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const flac = findContainer(reg, 'flac');
    expect(flac.formats).toEqual(['flac']);
    expect(
      flac.supports({ direction: 'demux', head: new Uint8Array([0x66, 0x4c, 0x61, 0x43]) }),
    ).toBe(true);
    expect(flac.supports({ direction: 'demux', mime: 'audio/flac' })).toBe(true);
    expect(flac.supports({ direction: 'demux', extension: 'flac' })).toBe(true);
    expect(flac.supports({ direction: 'demux', extension: 'mp3' })).toBe(false);
  });

  it('registers MPEG-TS as a lazy container proxy with cheap support checks', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const ts = findContainer(reg, 'mpegts');
    expect(ts.formats).toEqual(['ts', 'm2ts', 'mts']);
    expect(ts.supports({ direction: 'demux', mime: 'video/mp2t' })).toBe(true);
    expect(ts.supports({ direction: 'demux', mime: 'audio/mp2t' })).toBe(true);
    expect(ts.supports({ direction: 'demux', extension: 'M2TS' })).toBe(true);
    const head = new Uint8Array(189);
    head[0] = 0x47;
    head[188] = 0x47;
    expect(ts.supports({ direction: 'demux', head })).toBe(true);
    expect(ts.supports({ direction: 'demux', head: head.slice(0, 188) })).toBe(false);
    head[188] = 0x00;
    expect(ts.supports({ direction: 'demux', head })).toBe(false);
  });

  it('lazy-loads the FLAC container only when demux or PCM helpers are invoked', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const flac = findContainer(reg, 'flac');
    if (
      flac.decodePcm === undefined ||
      flac.decodePcmAudio === undefined ||
      flac.transformPcm === undefined
    ) {
      throw new Error('lazy FLAC proxy must expose the PCM helper surface');
    }

    const src = await fixtureSource('flac-08bit.flac');
    const demuxer = await flac.demux(src);
    expect(demuxer.tracks).toHaveLength(1);
    expect(demuxer.tracks[0]?.codec).toBe('flac');
    await demuxer.close();

    const audio = await flac.decodePcmAudio(src);
    expect(audio.sampleRate).toBeGreaterThan(0);
    expect(audio.channels).toBeGreaterThan(0);
    expect(audio.planar[0]?.length).toBeGreaterThan(0);

    const wav = await collectBytes(await flac.decodePcm(src, { container: 'wav' }));
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');

    const transformed = await collectBytes(
      await flac.transformPcm(src, { container: 'wav', gainDb: -1 }),
    );
    expect(new TextDecoder().decode(transformed.slice(0, 4))).toBe('RIFF');
  });

  it('routes the lazy FLAC muxer through the real muxer and preserves typed misuse errors', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const flac = findContainer(reg, 'flac');
    const description = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x00]);
    const frame = new Uint8Array([0xff, 0xf8, 0x69, 0x00]);

    const muxer = flac.createMuxer();
    expect(muxer.addTrack(flacTrackInfo(description))).toBe(0);
    const output = collectBytes(muxer.output);
    await muxer.write(0, { chunk: fakeEncodedAudioChunk(frame) } satisfies Packet);
    await muxer.finalize();
    const bytes = await output;
    expect([...bytes.slice(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect([...bytes.slice(-frame.byteLength)]).toEqual([...frame]);

    const invalid = flac.createMuxer();
    expect(() => invalid.addTrack({ id: 1, mediaType: 'video', codec: 'vp9' })).toThrowError(
      CapabilityError,
    );

    const duplicate = flac.createMuxer();
    expect(duplicate.addTrack(flacTrackInfo(description))).toBe(0);
    expect(() => duplicate.addTrack(flacTrackInfo(description))).toThrowError(CapabilityError);

    await expect(flac.createMuxer().finalize()).rejects.toThrowError(MediaError);
    await expect(
      flac.createMuxer().write(9, { chunk: fakeEncodedAudioChunk(new Uint8Array([0xff, 0xf8])) }),
    ).rejects.toThrowError(MediaError);
    await expect(flac.createMuxer({ fragmented: true }).finalize()).rejects.toThrowError(
      CapabilityError,
    );
  });

  it('registers AVI as a lazy container proxy with cheap support checks', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const avi = findContainer(reg, 'avi');
    expect(avi.formats).toEqual(['avi']);
    expect(
      avi.supports({
        direction: 'demux',
        head: new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
        ]),
      }),
    ).toBe(true);
    expect(avi.supports({ direction: 'demux', mime: 'video/x-msvideo' })).toBe(true);
    expect(avi.supports({ direction: 'demux', extension: 'AVI' })).toBe(true);
    expect(
      avi.supports({
        direction: 'demux',
        head: new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
        ]),
      }),
    ).toBe(false);
    expect(avi.supports({ direction: 'demux', extension: 'wav' })).toBe(false);
  });

  it('lazy-loads the AVI container for demux and mux while preserving typed proxy errors', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const avi = findContainer(reg, 'avi');

    const demuxer = await avi.demux(
      fromBytes(await derivedBytes('mjpeg_pcm_160p.avi'), { mime: 'video/x-msvideo' }),
    );
    expect(demuxer.tracks.map((track) => track.codec)).toEqual(['mjpeg', 'pcm']);
    await demuxer.close();

    const muxer = avi.createMuxer();
    const trackId = muxer.addTrack({
      id: 0,
      mediaType: 'audio',
      codec: 'pcm-u8',
      config: { codec: 'pcm-u8', sampleRate: 8000, numberOfChannels: 1 },
    });
    const output = collectBytes(muxer.output);
    await muxer.write(trackId, {
      chunk: fakeEncodedAudioChunk(new Uint8Array([0x80, 0x81, 0x82, 0x83])),
    });
    await muxer.finalize();
    const bytes = await output;
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('AVI ');

    const invalid = avi.createMuxer();
    invalid.addTrack({ id: 1, mediaType: 'video', codec: 'unknown-video' });
    await expect(invalid.finalize()).rejects.toThrowError(CapabilityError);

    await expect(
      avi.createMuxer().write(9, { chunk: fakeEncodedAudioChunk(new Uint8Array([0])) }),
    ).rejects.toThrowError(MediaError);
  });

  it('registers tracks added after a lazy muxer has loaded', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const ts = findContainer(reg, 'mpegts');
    const muxer = ts.createMuxer();
    const audioTrack = (id: number): TrackInfo => ({
      id,
      mediaType: 'audio',
      codec: 'aac',
      config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2 },
    });

    const firstId = muxer.addTrack(audioTrack(10));
    await muxer.write(firstId, {
      chunk: fakeEncodedAudioChunk(new Uint8Array([0x21, 0x10])),
    });

    const lateId = muxer.addTrack(audioTrack(20));
    await expect(
      muxer.write(lateId, {
        chunk: fakeEncodedAudioChunk(new Uint8Array([0x21, 0x10])),
      }),
    ).resolves.toBeUndefined();
  });

  it('registers lazy filter proxies with cheap Node misses', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    expect(reg.filters().map((driver) => driver.id)).toEqual([
      'webgpu-video-filter',
      'canvas2d-video-filter',
      'audio-dsp-filter',
      'cpu-video-filter',
    ]);

    const audioGain = { mediaType: 'audio', type: 'gain', db: 0 } as const;
    const videoResize = {
      mediaType: 'video',
      type: 'resize',
      width: 16,
      height: 16,
    } as const;
    for (const filter of reg.filters()) {
      const spec = filter.id === 'audio-dsp-filter' ? audioGain : videoResize;
      expect(filter.supports(spec)).toBe(false);
      expect(() => filter.createFilter(spec)).toThrowError(CapabilityError);
    }
  });

  it('keeps lazy filter support predicates cheap under browser-like globals', async () => {
    const restores = [
      defineGlobal('navigator', { userAgent: 'Chrome/149', gpu: {} }),
      defineGlobal('OffscreenCanvas', class FakeOffscreenCanvas {}),
      defineGlobal(
        'VideoFrame',
        class FakeVideoFrame {
          close(): void {}
        },
      ),
      defineGlobal(
        'AudioData',
        class FakeAudioData {
          close(): void {}
        },
      ),
    ];
    try {
      const reg = new Registry();
      registerDefaultDrivers(reg);
      const resize: FilterSpec = { mediaType: 'video', type: 'resize', width: 16, height: 16 };
      const displayColor: FilterSpec = { mediaType: 'video', type: 'colorspace', to: 'BT.709' };
      const wideColor: FilterSpec = { mediaType: 'video', type: 'colorspace', to: 'display-p3' };
      const tonemap: FilterSpec = { mediaType: 'video', type: 'tonemap', to: 'sdr' };
      const gain: FilterSpec = { mediaType: 'audio', type: 'gain', db: 0 };

      const webgpu = findFilter(reg, 'webgpu-video-filter');
      const canvas = findFilter(reg, 'canvas2d-video-filter');
      const audio = findFilter(reg, 'audio-dsp-filter');
      const cpu = findFilter(reg, 'cpu-video-filter');

      expect(webgpu.supports(resize)).toBe(true);
      expect(webgpu.supports(tonemap)).toBe(false);
      expect(webgpu.supports(gain)).toBe(false);
      expect(canvas.supports(resize)).toBe(true);
      expect(canvas.supports(displayColor)).toBe(true);
      expect(canvas.supports(wideColor)).toBe(false);
      expect(canvas.supports(tonemap)).toBe(true);
      expect(audio.supports(gain)).toBe(true);
      expect(audio.supports(resize)).toBe(false);
      expect(cpu.supports(resize)).toBe(true);
      expect(cpu.supports(tonemap)).toBe(true);
      expect(cpu.supports(gain)).toBe(false);

      await closeEmptyFilterStream(webgpu.createFilter(resize));
    } finally {
      for (const restore of restores.reverse()) restore();
    }

    const restoreFirefox = defineGlobal('navigator', { userAgent: 'Firefox/149', gpu: {} });
    const restoreCanvas = defineGlobal('OffscreenCanvas', class FakeOffscreenCanvas {});
    const restoreFrame = defineGlobal(
      'VideoFrame',
      class FakeVideoFrame {
        close(): void {}
      },
    );
    try {
      const reg = new Registry();
      registerDefaultDrivers(reg);
      const resize: FilterSpec = { mediaType: 'video', type: 'resize', width: 16, height: 16 };
      const tonemap: FilterSpec = { mediaType: 'video', type: 'tonemap', to: 'sdr' };
      expect(findFilter(reg, 'webgpu-video-filter').supports(resize)).toBe(false);
      expect(findFilter(reg, 'canvas2d-video-filter').supports(resize)).toBe(true);
      expect(findFilter(reg, 'canvas2d-video-filter').supports(tonemap)).toBe(false);
      expect(findFilter(reg, 'cpu-video-filter').supports(tonemap)).toBe(true);
    } finally {
      restoreFrame();
      restoreCanvas();
      restoreFirefox();
    }
  });

  it('registers lazy codec proxies that load only after a matching support query', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const flacEncode = findCodec(reg, 'flac-encode');
    expect(flacEncode.tier).toBe('native');
    expect(() =>
      flacEncode.createEncoder({ codec: 'flac', sampleRate: 48_000, numberOfChannels: 1 }),
    ).toThrowError(CapabilityError);
    await expect(
      flacEncode.supports({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'flac', sampleRate: 48_000, numberOfChannels: 1 },
      }),
    ).resolves.toMatchObject({ supported: false });
    await expect(
      flacEncode.supports({
        mediaType: 'audio',
        direction: 'encode',
        config: { codec: 'flac', sampleRate: 48_000, numberOfChannels: 1 },
      }),
    ).resolves.toMatchObject({ supported: false });
    expect(() =>
      flacEncode.createEncoder({ codec: 'flac', sampleRate: 0, numberOfChannels: 1 }),
    ).toThrowError(MediaError);
    expect(() =>
      flacEncode.createDecoder({ codec: 'flac', sampleRate: 48_000, numberOfChannels: 1 }),
    ).toThrowError(MediaError);

    const vpx = findCodec(reg, 'wasm-vpx');
    await expect(
      vpx.supports({
        mediaType: 'audio',
        direction: 'decode',
        config: { codec: 'vp09.00.10.08', sampleRate: 48_000, numberOfChannels: 2 },
      }),
    ).resolves.toMatchObject({ supported: false, reason: 'wasm-vpx does not match' });
    expect(() =>
      vpx.createDecoder({ codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 }),
    ).toThrowError(CapabilityError);
  });

  it('exercises default lazy codec match predicates without running codec streams', async () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const cases: Array<{
      readonly id: string;
      readonly query: Parameters<CodecDriver['supports']>[0];
    }> = [
      {
        id: 'flac-encode',
        query: {
          mediaType: 'audio',
          direction: 'encode',
          config: { codec: 'flac.16', sampleRate: 48_000, numberOfChannels: 1 },
        },
      },
      {
        id: 'wasm-vorbis-enc',
        query: {
          mediaType: 'audio',
          direction: 'encode',
          config: { codec: 'vorbis', sampleRate: 48_000, numberOfChannels: 2 },
        },
      },
      {
        id: 'wasm-vorbis',
        query: {
          mediaType: 'audio',
          direction: 'decode',
          config: { codec: 'vorbis', sampleRate: 48_000, numberOfChannels: 2 },
        },
      },
      {
        id: 'wasm-aac',
        query: {
          mediaType: 'audio',
          direction: 'decode',
          config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
        },
      },
      {
        id: 'wasm-aac',
        query: {
          mediaType: 'audio',
          direction: 'decode',
          config: { codec: 'aac', sampleRate: 48_000, numberOfChannels: 2 },
        },
      },
      {
        id: 'wasm-mp3',
        query: {
          mediaType: 'audio',
          direction: 'decode',
          config: { codec: 'mp4a.6b', sampleRate: 48_000, numberOfChannels: 2 },
        },
      },
      {
        id: 'wasm-mp3',
        query: {
          mediaType: 'audio',
          direction: 'decode',
          config: { codec: 'mp3', sampleRate: 48_000, numberOfChannels: 2 },
        },
      },
      {
        id: 'wasm-mp3',
        query: {
          mediaType: 'audio',
          direction: 'decode',
          config: { codec: 'mp4a.69', sampleRate: 48_000, numberOfChannels: 2 },
        },
      },
      {
        id: 'wasm-opus',
        query: {
          mediaType: 'audio',
          direction: 'decode',
          config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
        },
      },
      {
        id: 'wasm-av1',
        query: {
          mediaType: 'video',
          direction: 'decode',
          config: { codec: 'av01.0.04M.08', codedWidth: 16, codedHeight: 16 },
        },
      },
      {
        id: 'wasm-av1',
        query: {
          mediaType: 'video',
          direction: 'decode',
          config: { codec: 'av1', codedWidth: 16, codedHeight: 16 },
        },
      },
      {
        id: 'wasm-vpx',
        query: {
          mediaType: 'video',
          direction: 'decode',
          config: { codec: 'vp8', codedWidth: 16, codedHeight: 16 },
        },
      },
      {
        id: 'wasm-vpx',
        query: {
          mediaType: 'video',
          direction: 'decode',
          config: { codec: 'vp9', codedWidth: 16, codedHeight: 16 },
        },
      },
      {
        id: 'wasm-vpx',
        query: {
          mediaType: 'video',
          direction: 'decode',
          config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
        },
      },
    ];

    for (const testCase of cases) {
      await expect(findCodec(reg, testCase.id).supports(testCase.query)).resolves.toHaveProperty(
        'supported',
      );
    }

    await expect(
      findCodec(reg, 'wasm-opus').supports({
        mediaType: 'video',
        direction: 'decode',
        config: { codec: 'opus', codedWidth: 16, codedHeight: 16 },
      }),
    ).resolves.toMatchObject({ supported: false, reason: 'wasm-opus does not match' });
  });
});
