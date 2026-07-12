import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImageOps } from '../codecs/image/index.ts';
import { NoopDriverModule } from '../conformance/noop-driver.ts';
import {
  type CodecDriver,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DriverModule,
  type EncodedChunk,
  type FilterDriver,
  type Packet,
  type RawFrame,
  type TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { WebmModule } from '../drivers/webm/webm-driver.ts';
import { toStreamTarget } from '../sinks/stream-target.ts';
import {
  type MediaInput,
  SOURCE_CACHE_KEY,
  SOURCE_URL_KEY,
  type Source,
  fromBytes,
} from '../sources/source.ts';
import * as sugar from './create-media.ts';
import { createMedia } from './create-media.ts';
import type { MediaInfo } from './types.ts';

/** A container driver that reports real tracks, to exercise MediaInfo mapping. */
function tracksModule(): DriverModule {
  const tracks: TrackInfo[] = [
    {
      id: 0,
      mediaType: 'video',
      codec: 'avc1.42001f',
      durationSec: 10,
      config: { codec: 'avc1.42001f', codedWidth: 1920, codedHeight: 1080 },
    },
    {
      id: 1,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      durationSec: 9.5,
      config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
    },
  ];
  const driver: ContainerDriver = {
    id: 'fake-mp4',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: (q) => q.mime === 'video/mp4' || q.head?.[0] === 0x66,
    demux: () =>
      Promise.resolve({
        tracks,
        packets: () => new ReadableStream({ start: (c) => c.close() }),
        close: () => Promise.resolve(),
      }),
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  return { apiVersion: DRIVER_API_VERSION, register: (reg) => reg.addContainer(driver) };
}

interface WarmupProbeCounts {
  container: number;
  codec: number;
  filter: number;
}

function warmableModule(counts: WarmupProbeCounts): DriverModule {
  const container: ContainerDriver = {
    id: 'warm-container',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['warm'],
    supports: (q) => {
      counts.container++;
      return q.extension === 'warm' || q.mime === 'application/x-warm';
    },
    demux: () =>
      Promise.resolve({
        tracks: [],
        packets: () => new ReadableStream({ start: (c) => c.close() }),
        close: () => Promise.resolve(),
      }),
    createMuxer: () => {
      let nextTrack = 0;
      return {
        output: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        addTrack: () => nextTrack++,
        write: () => Promise.resolve(),
        finalize: () => Promise.resolve(),
      };
    },
  };
  const codec: CodecDriver = {
    id: 'warm-codec',
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'wasm',
    supports: (q) => {
      counts.codec++;
      return Promise.resolve({ supported: q.config.codec === 'warm' });
    },
    createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
  const filter: FilterDriver = {
    id: 'warm-filter',
    apiVersion: DRIVER_API_VERSION,
    kind: 'filter',
    substrate: 'wasm',
    supports: (f) => {
      counts.filter++;
      return f.mediaType === 'audio' && f.type === 'gain';
    },
    createFilter: () => new TransformStream<AudioData, AudioData>(),
  };
  return {
    apiVersion: DRIVER_API_VERSION,
    register(reg): void {
      reg.addContainer(container);
      reg.addCodec(codec);
      reg.addFilter(filter);
    },
  };
}

function throwingWarmupModule(): DriverModule {
  const container: ContainerDriver = {
    id: 'throw-container',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['throw'],
    supports: () => {
      throw new Error('container probe boom');
    },
    demux: () =>
      Promise.resolve({
        tracks: [],
        packets: () => new ReadableStream({ start: (c) => c.close() }),
        close: () => Promise.resolve(),
      }),
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  const codec: CodecDriver = {
    id: 'throw-codec',
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'wasm',
    supports: () => {
      throw new Error('codec probe boom');
    },
    createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
  return {
    apiVersion: DRIVER_API_VERSION,
    register(reg): void {
      reg.addContainer(container);
      reg.addCodec(codec);
    },
  };
}

function imageSniffCounterModule(counts: { sniff: number }): DriverModule {
  const ops: ImageOps = {
    formats: ['png'],
    sniff: () => {
      counts.sniff++;
      return undefined;
    },
    probe: () => {
      throw new Error('unused');
    },
    canDecode: () => false,
    decode: () => {
      throw new Error('unused');
    },
    decodeFrames(): AsyncGenerator<VideoFrame, void, undefined> {
      throw new Error('unused');
    },
  };
  return {
    apiVersion: DRIVER_API_VERSION,
    register(reg): void {
      (reg as { addImageOps?: (imageOps: ImageOps) => void }).addImageOps?.(ops);
    },
  };
}

class CancelRaceFrame {
  readonly timestamp = 0;
  readonly duration = 1_000;
  closeCount = 0;
  readonly closed: Promise<void>;
  #resolveClosed: (() => void) | undefined;

  constructor() {
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  close(): void {
    this.closeCount++;
    this.#resolveClosed?.();
  }
}

function fakeVideoPacket(): Packet {
  const chunk = {
    type: 'key',
    timestamp: 0,
    duration: 1_000,
    byteLength: 1,
    copyTo(destination: AllowSharedBufferSource): void {
      const view = ArrayBuffer.isView(destination)
        ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
        : new Uint8Array(destination);
      view[0] = 0;
    },
  } satisfies {
    readonly type: EncodedVideoChunkType;
    readonly timestamp: number;
    readonly duration: number;
    readonly byteLength: number;
    copyTo(destination: AllowSharedBufferSource): void;
  };
  return { chunk: chunk as unknown as EncodedChunk };
}

function delayedDecodeFrameModule(
  frame: CancelRaceFrame,
  waitForDemux: Promise<void>,
  onDemuxStarted: () => void,
  onDemuxSource: (src: {
    readonly size?: number;
    readonly [SOURCE_URL_KEY]?: string;
  }) => void = () => {},
): DriverModule {
  const track: TrackInfo = {
    id: 1,
    mediaType: 'video',
    codec: 'fake-video',
    config: { codec: 'fake-video', codedWidth: 16, codedHeight: 16 },
  };
  const container: ContainerDriver = {
    id: 'delayed-video',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: (q) => q.mime === 'video/x-delayed' || q.extension === 'mp4',
    async demux(src) {
      onDemuxStarted();
      onDemuxSource(src);
      await waitForDemux;
      return {
        tracks: [track],
        packets: () =>
          new ReadableStream<Packet>({
            start(controller): void {
              controller.enqueue(fakeVideoPacket());
              controller.close();
            },
          }),
        close: () => Promise.resolve(),
      };
    },
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  const codec: CodecDriver = {
    id: 'delayed-video-codec',
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'wasm',
    supports: (q) =>
      Promise.resolve({
        supported:
          q.mediaType === 'video' && q.direction === 'decode' && q.config.codec === 'fake-video',
      }),
    createDecoder: () =>
      new TransformStream<EncodedChunk, RawFrame>({
        transform(_chunk, controller): void {
          controller.enqueue(frame as unknown as RawFrame);
        },
      }),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
  return {
    apiVersion: DRIVER_API_VERSION,
    register(reg): void {
      reg.addContainer(container);
      reg.addCodec(codec);
    },
  };
}

function dualTrackStreamDecodeModule(
  expectedBytes: Uint8Array,
  videoFrame: CancelRaceFrame,
  audioFrame: CancelRaceFrame,
  onDemux: () => void,
): DriverModule {
  const tracks: readonly TrackInfo[] = [
    {
      id: 1,
      mediaType: 'video',
      codec: 'fake-video',
      config: { codec: 'fake-video', codedWidth: 16, codedHeight: 16 },
    },
    {
      id: 2,
      mediaType: 'audio',
      codec: 'fake-audio',
      config: { codec: 'fake-audio', sampleRate: 48_000, numberOfChannels: 2 },
    },
  ];
  const container: ContainerDriver = {
    id: 'dual-track-stream',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: (query) => query.mime === 'video/x-dual-track',
    async demux(src) {
      onDemux();
      const reader = src.stream().getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      expect(bytes).toEqual(expectedBytes);
      return {
        tracks,
        packets: () =>
          new ReadableStream<Packet>({
            start(controller): void {
              controller.enqueue(fakeVideoPacket());
              controller.close();
            },
          }),
        close: () => Promise.resolve(),
      };
    },
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  const codec: CodecDriver = {
    id: 'dual-track-codec',
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'wasm',
    supports: (query) =>
      Promise.resolve({
        supported:
          query.direction === 'decode' &&
          (query.config.codec === 'fake-video' || query.config.codec === 'fake-audio'),
      }),
    createDecoder: (config) =>
      new TransformStream<EncodedChunk, RawFrame>({
        transform(_chunk, controller): void {
          controller.enqueue(
            (config.codec === 'fake-video' ? videoFrame : audioFrame) as unknown as RawFrame,
          );
        },
      }),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
  return {
    apiVersion: DRIVER_API_VERSION,
    register(registry): void {
      registry.addContainer(container);
      registry.addCodec(codec);
    },
  };
}

const NOOP_BYTES = fromBytes(new Uint8Array([1, 2, 3, 4]), { mime: 'application/x-noop' });
const MEDIA = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media');
const IMG = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media-derived/img');
const loadMedia = (name: string): Uint8Array => Uint8Array.from(readFileSync(resolve(MEDIA, name)));
const loadImage = (name: string): Uint8Array => Uint8Array.from(readFileSync(resolve(IMG, name)));
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function frameStream<T>(): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller): void {
      controller.close();
    },
  });
}

function streamCopyModule(calls: Array<unknown>): DriverModule {
  const tracks: TrackInfo[] = [
    {
      id: 1,
      mediaType: 'video',
      codec: 'noop',
      durationSec: 2,
      config: { codec: 'noop', codedWidth: 16, codedHeight: 16 },
    },
  ];
  const driver: ContainerDriver = {
    id: 'copy-mp4',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: (q) => q.mime === 'video/x-copy-mp4',
    probe: () => Promise.resolve(tracks),
    demux: () =>
      Promise.resolve({
        tracks,
        packets: () => new ReadableStream({ start: (c) => c.close() }),
        close: () => Promise.resolve(),
      }),
    streamCopy: (_src, o) => {
      calls.push(o);
      return Promise.resolve(byteStream(new Uint8Array([7, 8, 9])));
    },
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  return { apiVersion: DRIVER_API_VERSION, register: (reg) => reg.addContainer(driver) };
}

function crossTargetStreamCopyModule(calls: Array<unknown>): DriverModule {
  const driver: ContainerDriver = {
    id: 'copy-flac',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['flac'],
    streamCopyTargets: ['ogg'],
    supports: (q) => q.mime === 'audio/x-copy-flac',
    demux: () => {
      throw new Error('streamCopyTargets remux should not open the generic packet seam');
    },
    streamCopy: (_src, o) => {
      calls.push(o);
      return Promise.resolve(byteStream(new Uint8Array([0x4f, 0x67, 0x67, 0x53])));
    },
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  return { apiVersion: DRIVER_API_VERSION, register: (reg) => reg.addContainer(driver) };
}

function packetInfoModule(): DriverModule {
  const driver: ContainerDriver = {
    id: 'packet-info-mp4',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: (q) => q.mime === 'video/x-packet-info',
    packetInfo: () => Promise.resolve({ tracks: [], packets: [] }),
    demux: () =>
      Promise.resolve({
        tracks: [],
        packets: () => new ReadableStream({ start: (c) => c.close() }),
        close: () => Promise.resolve(),
      }),
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  return { apiVersion: DRIVER_API_VERSION, register: (reg) => reg.addContainer(driver) };
}

/** Pull the first item from a frame stream (forces a lazy `decode` to run its demux/codec route). */
async function readFirst<T>(stream: ReadableStream<T> | undefined): Promise<T | undefined> {
  if (!stream) return undefined;
  const reader = stream.getReader();
  try {
    return (await reader.read()).value;
  } finally {
    reader.releaseLock();
  }
}

describe('createMedia', () => {
  it('instantiates an engine exposing the public surface', () => {
    const media = createMedia();
    for (const m of [
      'probe',
      'convert',
      'remux',
      'trim',
      'decode',
      'encode',
      'demux',
      'h264AbrLadder',
      'mux',
      'decrypt',
      'preload',
      'load',
      'from',
      'source',
      'use',
    ]) {
      expect(typeof (media as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it('normalizes inputs through from()/source()', () => {
    const media = createMedia();
    expect(media.from(new Uint8Array([1])).kind).toBe('bytes');
    expect(media.source('https://x/y.mp4').kind).toBe('url');
  });

  it('probe routes to a registered container driver and returns MediaInfo', async () => {
    const media = createMedia().use(NoopDriverModule);
    const info = await media.probe(NOOP_BYTES);
    expect(info).toEqual({ container: 'noop', durationSec: 0, sizeBytes: 4, tracks: [] });
  });

  it('probe raises a typed CapabilityError when no container driver is registered', async () => {
    await expect(createMedia().probe(NOOP_BYTES)).rejects.toBeInstanceOf(CapabilityError);
  });

  it('demux routes to a registered container driver and exposes packet streams', async () => {
    const media = createMedia().use(NoopDriverModule);
    const demuxed = await media.demux(NOOP_BYTES);
    expect(demuxed.tracks).toEqual([]);
    const reader = demuxed.packets(0).getReader();
    expect((await reader.read()).done).toBe(true);
    await demuxed.close();
  });

  it('packetInfo routes to the fast metadata hook and rejects drivers without one', async () => {
    const withPacketInfo = createMedia().use(packetInfoModule()) as unknown as {
      packetInfo(input: MediaInput): Promise<{ readonly tracks: readonly TrackInfo[] }>;
    };
    await expect(
      withPacketInfo.packetInfo(fromBytes(new Uint8Array([1]), { mime: 'video/x-packet-info' })),
    ).resolves.toEqual({ tracks: [], packets: [] });

    const withoutPacketInfo = createMedia().use(NoopDriverModule) as unknown as {
      packetInfo(input: MediaInput): Promise<unknown>;
    };
    await expect(withoutPacketInfo.packetInfo(NOOP_BYTES)).rejects.toBeInstanceOf(CapabilityError);
  });

  it('probe maps demuxer tracks into MediaInfo (dims + audio params + duration)', async () => {
    const media = createMedia().use(tracksModule());
    const info = await media.probe(fromBytes(new Uint8Array([1]), { mime: 'video/mp4' }));
    expect(info.container).toBe('mp4');
    expect(info.durationSec).toBe(10);
    expect(info.tracks).toEqual([
      { id: 0, type: 'video', codec: 'avc1.42001f', durationSec: 10, width: 1920, height: 1080 },
      {
        id: 1,
        type: 'audio',
        codec: 'mp4a.40.2',
        durationSec: 9.5,
        sampleRate: 48000,
        channels: 2,
      },
    ]);
  });

  it('probe uses a container metadata hook without constructing a demux session', async () => {
    const calls = { probe: 0, demux: 0 };
    const tracks: TrackInfo[] = [
      {
        id: 7,
        mediaType: 'audio',
        codec: 'mp4a.40.2',
        durationSec: 3600,
        config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
      },
    ];
    const driver: ContainerDriver = {
      id: 'probe-fast-mp4',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp4'],
      supports: (q) => q.mime === 'audio/mp4',
      probe: () => {
        calls.probe++;
        return Promise.resolve(tracks);
      },
      demux: () => {
        calls.demux++;
        throw new Error('metadata probe must not construct a demuxer when probe() is available');
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const media = createMedia().use({
      apiVersion: DRIVER_API_VERSION,
      register: (reg) => reg.addContainer(driver),
    });
    const info = await media.probe(fromBytes(new Uint8Array([1]), { mime: 'audio/mp4' }));
    expect(calls).toEqual({ probe: 1, demux: 0 });
    expect(info).toEqual({
      container: 'mp4',
      durationSec: 3600,
      sizeBytes: 1,
      tracks: [
        {
          id: 7,
          type: 'audio',
          codec: 'mp4a.40.2',
          durationSec: 3600,
          sampleRate: 48000,
          channels: 2,
        },
      ],
    });
  });

  it('probe sends a concrete seekable video MIME directly to its container metadata hook', async () => {
    const bytes = loadMedia('bear-vp9-alpha.webm');
    const calls: Array<readonly [number, number]> = [];
    const counts = { sniff: 0 };
    const src: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/webm',
      size: bytes.byteLength,
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable metadata probe must not open the full stream');
      },
    };

    const info = await createMedia()
      .use(imageSniffCounterModule(counts))
      .use(WebmModule)
      .probe(src);
    expect(calls).toEqual([[0, 8 * 1024]]);
    expect(counts.sniff).toBe(0);
    expect(info.tracks.find((track) => track.type === 'video')?.codec).toBe('vp9');
  });

  it('probe reuses the first WebM prefix when exact cadence requires a terminal scan', async () => {
    const bytes = Uint8Array.from(
      readFileSync(
        resolve(MEDIA, '../../../media-test/fixtures/media/scenarios/probe/vp9_alpha/01.webm'),
      ),
    );
    const calls: Array<readonly [number, number]> = [];
    const source: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/webm',
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('known-size terminal-timeline probe must remain range-backed');
      },
    };

    const info = await createMedia().use(WebmModule).probe(source);
    expect(info).toMatchObject({
      container: 'webm',
      durationSec: 2.7,
      sizeBytes: bytes.byteLength,
      tracks: [{ type: 'video', codec: 'vp9', fps: 30, width: 320, height: 240 }],
    });
    expect(calls).toEqual([
      [0, 8 * 1024],
      [8 * 1024, bytes.byteLength],
    ]);
  });

  it('probe preserves a typed hinted-container error when the deferred image fallback misses', async () => {
    const failure = new InputError('unsupported-input', 'exact container rejection');
    const counts = { sniff: 0 };
    const calls: Array<readonly [number, number]> = [];
    const driver: ContainerDriver = {
      id: 'rejecting-hinted-video',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['rejecting'],
      supports: (query) => query.mime?.startsWith('video/x-rejecting;') === true,
      probe: () => Promise.reject(failure),
      demux: () => Promise.reject(new Error('probe hook must be preferred')),
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const source: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/x-rejecting; codecs=vp9',
      size: 8,
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(new Uint8Array(Math.max(0, Math.min(8, end) - start)));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable hinted probe must not open a stream');
      },
    };
    const media = createMedia()
      .use(imageSniffCounterModule(counts))
      .use({
        apiVersion: DRIVER_API_VERSION,
        register: (registry) => registry.addContainer(driver),
      });

    const error = await media.probe(source).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBe(failure);
    expect(counts.sniff).toBe(1);
    expect(calls).toEqual([[0, 4 * 1024]]);
  });

  it('probe never converts an aborted hinted-container result into an image fallback', async () => {
    const failure = new MediaError('aborted', 'driver aborted');
    const counts = { sniff: 0 };
    const driver: ContainerDriver = {
      id: 'aborted-hinted-video',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['aborted'],
      supports: (query) => query.mime === 'video/x-aborted',
      probe: () => Promise.reject(failure),
      demux: () => Promise.reject(new Error('probe hook must be preferred')),
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const source: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/x-aborted',
      size: 8,
      range: () => Promise.reject(new Error('aborted path must not sniff image bytes')),
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable hinted probe must not open a stream');
      },
    };
    const media = createMedia()
      .use(imageSniffCounterModule(counts))
      .use({
        apiVersion: DRIVER_API_VERSION,
        register: (registry) => registry.addContainer(driver),
      });

    const error = await media.probe(source).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBe(failure);
    expect(counts.sniff).toBe(0);
  });

  it.each(['video/', 'audio/   ', 'video/foo bar'])(
    'probe keeps malformed MIME %j on the image-first path',
    async (mimeHint) => {
      const counts = { sniff: 0 };
      const calls: Array<readonly [number, number]> = [];
      const driver: ContainerDriver = {
        id: 'malformed-mime-container',
        apiVersion: DRIVER_API_VERSION,
        kind: 'container',
        formats: ['malformed'],
        supports: (query) => query.mime === mimeHint,
        probe: () =>
          Promise.resolve([
            {
              id: 0,
              mediaType: 'audio',
              codec: 'test-audio',
              durationSec: 1,
            },
          ]),
        demux: () => Promise.reject(new Error('probe hook must be preferred')),
        createMuxer: () => {
          throw new Error('unused');
        },
      };
      const source: Source = {
        __media: 'source',
        kind: 'url',
        mimeHint,
        size: 8,
        range: (start, end) => {
          calls.push([start, end]);
          return Promise.resolve(new Uint8Array(Math.max(0, Math.min(8, end) - start)));
        },
        stream(): ReadableStream<Uint8Array> {
          throw new Error('seekable malformed-MIME probe must not open a stream');
        },
      };
      const media = createMedia()
        .use(imageSniffCounterModule(counts))
        .use({
          apiVersion: DRIVER_API_VERSION,
          register: (registry) => registry.addContainer(driver),
        });

      await expect(media.probe(source)).resolves.toMatchObject({ container: 'malformed' });
      expect(counts.sniff).toBe(1);
      expect(calls).toEqual([[0, 4 * 1024]]);
    },
  );

  it('probe reuses bounded source prefixes across repeated public probes', async () => {
    const calls: Array<readonly [number, number]> = [];
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
    const tracks: TrackInfo[] = [
      {
        id: 1,
        mediaType: 'audio',
        codec: 'mp3',
        durationSec: 1,
        config: { codec: 'mp3', sampleRate: 44100, numberOfChannels: 2 },
      },
    ];
    const driver: ContainerDriver = {
      id: 'cached-public-mp3',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp3'],
      supports: (q) => q.mime === 'audio/mpeg' || q.head?.[0] === 0xff,
      probe: async (src) => {
        const head = await src.range?.(0, bytes.byteLength);
        expect(head).toEqual(bytes);
        return tracks;
      },
      demux: () => {
        throw new Error('public probe must not demux when probe() is available');
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const src: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'audio/mpeg',
      size: bytes.byteLength,
      [SOURCE_CACHE_KEY]: 'https://example.test/tiny.mp3',
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('repeated public probe must not stream');
      },
    };
    const media = createMedia().use({
      apiVersion: DRIVER_API_VERSION,
      register: (reg) => reg.addContainer(driver),
    });

    await media.probe(src);
    await media.probe(src);

    expect(calls).toEqual([[0, bytes.byteLength]]);
  });

  it('probe never reuses a URL prefix across distinct source snapshots with the same href', async () => {
    const original = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
    const mutated = new Uint8Array(original.byteLength);
    const calls = { original: 0, mutated: 0 };
    const tracks: TrackInfo[] = [
      {
        id: 1,
        mediaType: 'audio',
        codec: 'mp3',
        durationSec: 1,
        config: { codec: 'mp3', sampleRate: 44100, numberOfChannels: 2 },
      },
    ];
    const driver: ContainerDriver = {
      id: 'snapshot-safe-mp3',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp3'],
      supports: (q) => q.mime === 'audio/mpeg',
      probe: async (src) => {
        const head = await src.range?.(0, original.byteLength);
        if (head?.[0] !== 0xff) throw new InputError('unsupported-input', 'mutated header');
        return tracks;
      },
      demux: () => {
        throw new Error('snapshot-safety probe must not demux');
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const source = (bytes: Uint8Array, kind: keyof typeof calls): Source => ({
      __media: 'source',
      kind: 'url',
      mimeHint: 'audio/mpeg',
      size: bytes.byteLength,
      [SOURCE_CACHE_KEY]: 'https://example.test/mutable.mp3',
      range: (start, end) => {
        calls[kind]++;
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('snapshot-safety probe must not stream');
      },
    });
    const media = createMedia().use({
      apiVersion: DRIVER_API_VERSION,
      register: (reg) => reg.addContainer(driver),
    });

    await expect(media.probe(source(original, 'original'))).resolves.toBeDefined();
    await expect(media.probe(source(mutated, 'mutated'))).rejects.toMatchObject({
      code: 'unsupported-input',
      message: 'mutated header',
    });
    expect(calls).toEqual({ original: 1, mutated: 1 });
  });

  it('probeContainer routes by known container token without sniffing source bytes', async () => {
    const calls = { range: 0, stream: 0 };
    const tracks: TrackInfo[] = [
      {
        id: 1,
        mediaType: 'video',
        codec: 'vp9',
        durationSec: 12,
        config: { codec: 'vp09.00.10.08', codedWidth: 640, codedHeight: 360 },
      },
    ];
    const driver: ContainerDriver = {
      id: 'known-mp4',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp4'],
      supports: (q) => q.extension === 'mp4' && q.head === undefined,
      probe: () => Promise.resolve(tracks),
      demux: () => {
        throw new Error('known-container probe must not demux when probe() is available');
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const src: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/mp4',
      filename: 'fixture.mp4',
      size: 123,
      range: (start, end) => {
        calls.range++;
        return Promise.resolve(new Uint8Array(Math.max(0, end - start)));
      },
      stream(): ReadableStream<Uint8Array> {
        calls.stream++;
        return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
      },
    };
    const media = createMedia().use({
      apiVersion: DRIVER_API_VERSION,
      register: (reg) => reg.addContainer(driver),
    }) as unknown as {
      probeContainer(
        input: MediaInput,
        container: 'mp4',
      ): Promise<{
        readonly container: string;
        readonly durationSec: number;
        readonly sizeBytes?: number;
        readonly tracks: readonly { readonly codec: string }[];
      }>;
    };

    const info = await media.probeContainer(src, 'mp4');
    expect(calls).toEqual({ range: 0, stream: 0 });
    expect(info).toEqual({
      container: 'mp4',
      durationSec: 12,
      sizeBytes: 123,
      tracks: [{ id: 1, type: 'video', codec: 'vp9', durationSec: 12, width: 640, height: 360 }],
    });
  });

  it('probeContainer reuses bounded source prefixes across repeated known-container probes', async () => {
    const calls: Array<readonly [number, number]> = [];
    const bytes = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
    const tracks: TrackInfo[] = [
      {
        id: 1,
        mediaType: 'video',
        codec: 'avc1.42001f',
        durationSec: 1,
        config: { codec: 'avc1.42001f', codedWidth: 2, codedHeight: 2 },
      },
    ];
    const driver: ContainerDriver = {
      id: 'known-mp4',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp4'],
      supports: () => true,
      probe: async (src) => {
        const head = await src.range?.(0, bytes.byteLength);
        expect(head).toEqual(bytes);
        return tracks;
      },
      demux: () => {
        throw new Error('known-container probe must not demux when probe() is available');
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const src: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/mp4',
      size: bytes.byteLength,
      [SOURCE_CACHE_KEY]: 'https://example.test/tiny.mp4',
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('repeated known-container probe must not stream');
      },
    };
    const media = createMedia().use({
      apiVersion: DRIVER_API_VERSION,
      register: (reg) => reg.addContainer(driver),
    }) as unknown as {
      probeContainer(input: MediaInput, container: 'mp4'): Promise<unknown>;
    };

    await media.probeContainer(src, 'mp4');
    await media.probeContainer(src, 'mp4');

    expect(calls).toEqual([[0, bytes.byteLength]]);
  });

  it('probeContainer reuses bounded disjoint metadata intervals on the exact source', async () => {
    const bytes = new Uint8Array(512);
    bytes.set([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
    for (let index = 128; index < 192; index++) bytes[index] = index & 0xff;
    const calls: Array<readonly [number, number]> = [];
    const tracks: TrackInfo[] = [
      {
        id: 1,
        mediaType: 'video',
        codec: 'hevc',
        durationSec: 1,
        config: { codec: 'hev1.1.6.L93.B0', codedWidth: 1920, codedHeight: 1080 },
      },
    ];
    const driver: ContainerDriver = {
      id: 'disjoint-metadata',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp4'],
      supports: () => true,
      probe: async (src) => {
        expect(await src.range?.(128, 144)).toEqual(bytes.subarray(128, 144));
        expect(await src.range?.(128, 192)).toEqual(bytes.subarray(128, 192));
        return tracks;
      },
      demux: () => {
        throw new Error('known-container probe must not demux when probe() is available');
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const src: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/mp4',
      size: bytes.byteLength,
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('repeated disjoint metadata probe must not stream');
      },
    };
    const media = createMedia().use({
      apiVersion: DRIVER_API_VERSION,
      register: (reg) => reg.addContainer(driver),
    }) as unknown as {
      probeContainer(input: MediaInput, container: 'mp4'): Promise<MediaInfo>;
    };

    await media.probeContainer(src, 'mp4');
    await media.probeContainer(src, 'mp4');

    expect(calls).toEqual([
      [128, 144],
      [144, 192],
    ]);
  });

  it('repeats real tail, VFR, fragmented, and rotated MP4 probes without new range I/O', async () => {
    const fixtures = [
      'bear-4k-hevc.mp4',
      'obs-remux-variable-aac.mp4',
      'bear-hevc-10bit-hdr10.mp4',
      'bear-open-gop-frag.mp4',
      'bear-rotate-90.mp4',
    ] as const;
    for (const fixture of fixtures) {
      const bytes = loadMedia(fixture);
      let rangeCalls = 0;
      const src: Source = {
        __media: 'source',
        kind: 'url',
        mimeHint: 'video/mp4',
        filename: fixture,
        size: bytes.byteLength,
        [SOURCE_CACHE_KEY]: `https://example.test/${fixture}`,
        range: (start, end) => {
          rangeCalls++;
          return Promise.resolve(bytes.subarray(start, end));
        },
        stream(): ReadableStream<Uint8Array> {
          throw new Error('seekable repeated probe must not open the full stream');
        },
      };
      const media = createMedia();
      const first = await media.probe(src);
      const coldRangeCalls = rangeCalls;
      expect(coldRangeCalls).toBeGreaterThan(0);
      const second = await media.probe(src);
      expect(second).toEqual(first);
      expect(rangeCalls).toBe(coldRangeCalls);
    }
  });

  it('probe routes still images through the registered image capability', async () => {
    const info = await createMedia().probe(
      fromBytes(loadImage('test.jpeg'), { mime: 'image/jpeg' }),
    );
    expect(info).toEqual({
      container: 'jpeg',
      durationSec: 0.04,
      sizeBytes: loadImage('test.jpeg').byteLength,
      tracks: [
        {
          id: 0,
          type: 'video',
          codec: 'mjpeg',
          durationSec: 0.04,
          width: 239,
          height: 178,
          fps: 25,
        },
      ],
    });
  });

  it('probe lets image magic beat misleading MP4 mime and extension', async () => {
    const bytes = loadImage('test.jpeg');
    const info = await createMedia().probe(
      new File([toArrayBuffer(bytes)], 'still.mp4', { type: 'video/mp4' }),
    );
    expect(info.container).toBe('jpeg');
    expect(info.tracks[0]?.codec).toBe('mjpeg');
  });

  it('probe reports exact animated-image duration when header frame delays are available', async () => {
    const bytes = loadImage('anim2.gif');
    const info = await createMedia().probe(fromBytes(bytes, { mime: 'image/gif' }));
    expect(info.container).toBe('gif');
    expect(info.durationSec).toBeCloseTo(0.82, 6);
    expect(info.tracks).toHaveLength(1);
    const track = info.tracks[0];
    expect(track?.durationSec).toBeCloseTo(0.82, 6);
    expect(track?.fps).toBeCloseTo(36 / 0.82, 6);
  });

  it('decode exposes images as video frames, with a typed browser-only miss in Node and no audio stream', async () => {
    const streams = createMedia().decode(fromBytes(loadImage('test.png'), { mime: 'image/png' }));
    await expect(readFirst(streams.video)).rejects.toBeInstanceOf(CapabilityError);
    await expect(readFirst(streams.audio)).resolves.toBeUndefined();
  });

  it('force-software image decode rejects after a bounded sniff and cancels one-shot input', async () => {
    const head = new Uint8Array(4096);
    head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tail = new Uint8Array(4096).fill(0x5a);
    const chunks = [head, tail] as const;
    let pulls = 0;
    let cancels = 0;
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          const chunk = chunks[pulls++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const media = createMedia();
    const streams = media.decode(media.from(input, { mime: 'image/png' }), {
      strategy: { determinism: 'force-software' },
    });

    await expect(readFirst(streams.video)).rejects.toMatchObject({
      code: 'capability-miss',
      message: expect.stringMatching(/software.*image|image.*software/i),
    });
    await expect(readFirst(streams.audio)).rejects.toMatchObject({ code: 'capability-miss' });
    expect(pulls).toBe(1);
    expect(cancels).toBe(1);
  });

  it('decode skips image sniffing for definite video MIME sources', async () => {
    const bytes = new Uint8Array(8192);
    const calls: Array<readonly [number, number]> = [];
    const src: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/x-delayed',
      size: bytes.byteLength,
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable decode must not open the full stream');
      },
    };
    const frame = new CancelRaceFrame();
    const counts = { sniff: 0 };
    const media = createMedia()
      .use(imageSniffCounterModule(counts))
      .use(delayedDecodeFrameModule(frame, Promise.resolve(), () => {}));

    const got = await readFirst(media.decode(src).video);
    expect(got).toBe(frame);
    frame.close();
    expect(calls).toEqual([]);
    expect(counts.sniff).toBe(0);
    expect(frame.closeCount).toBe(1);
  });

  it('decode skips image sniffing for definite container extension sources', async () => {
    const bytes = new Uint8Array(8192);
    const calls: Array<readonly [number, number]> = [];
    const src: Source = {
      __media: 'source',
      kind: 'url',
      filename: 'delayed.mp4',
      size: bytes.byteLength,
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable decode must not open the full stream');
      },
    };
    const frame = new CancelRaceFrame();
    const counts = { sniff: 0 };
    const media = createMedia()
      .use(imageSniffCounterModule(counts))
      .use(delayedDecodeFrameModule(frame, Promise.resolve(), () => {}));

    const got = await readFirst(media.decode(src).video);
    expect(got).toBe(frame);
    frame.close();
    expect(calls).toEqual([]);
    expect(counts.sniff).toBe(0);
    expect(frame.closeCount).toBe(1);
  });

  it('decode consumes a probe prefix with its learned URL size and needs no second range read', async () => {
    const bytes = new Uint8Array(8192);
    const firstCalls: Array<readonly [number, number]> = [];
    let probeSize: number | undefined;
    let probeEffectiveUrl = 'https://fixtures.test/delayed.mp4';
    const srcForProbe: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/x-delayed',
      [SOURCE_CACHE_KEY]: 'url:https://fixtures.test/delayed.mp4',
      get [SOURCE_URL_KEY](): string {
        return probeEffectiveUrl;
      },
      range: (start, end) => {
        firstCalls.push([start, end]);
        probeSize = bytes.byteLength;
        probeEffectiveUrl = 'https://cdn.fixtures.test/final/delayed.mp4';
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable probe must not open the full stream');
      },
    };
    Object.defineProperty(srcForProbe, 'size', {
      configurable: true,
      enumerable: true,
      get: () => probeSize,
    });
    let decodeEffectiveUrl = 'https://fixtures.test/delayed.mp4';
    const srcForDecode: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/x-delayed',
      [SOURCE_CACHE_KEY]: 'url:https://fixtures.test/delayed.mp4',
      get [SOURCE_URL_KEY](): string {
        return decodeEffectiveUrl;
      },
      range: () => {
        decodeEffectiveUrl = 'https://should-not-be-read.test/delayed.mp4';
        throw new Error('decode should use the probe prefix handoff');
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable decode must not open the full stream');
      },
    };
    const frame = new CancelRaceFrame();
    const demuxFacts: Array<{
      readonly size: number | undefined;
      readonly url: string | undefined;
    }> = [];
    const media = createMedia().use(
      delayedDecodeFrameModule(
        frame,
        Promise.resolve(),
        () => {},
        (src) => {
          demuxFacts.push({ size: src.size, url: src[SOURCE_URL_KEY] });
        },
      ),
    );

    await expect(media.probe(srcForProbe)).resolves.toMatchObject({
      tracks: [{ id: 1, type: 'video', codec: 'fake-video' }],
    });
    const got = await readFirst(media.decode(srcForDecode).video);
    expect(got).toBe(frame);
    frame.close();
    expect(firstCalls).toEqual([[0, 4 * 1024]]);
    expect(demuxFacts).toEqual([
      { size: bytes.byteLength, url: 'https://cdn.fixtures.test/final/delayed.mp4' },
      { size: bytes.byteLength, url: 'https://fixtures.test/delayed.mp4' },
    ]);
    expect(decodeEffectiveUrl).toBe('https://fixtures.test/delayed.mp4');
    expect(frame.closeCount).toBe(1);
  });

  it('decode closes a late frame when the lazy public stream is cancelled first', async () => {
    let releaseDemux: (() => void) | undefined;
    const demuxGate = new Promise<void>((resolve) => {
      releaseDemux = resolve;
    });
    let markDemuxStarted: (() => void) | undefined;
    const demuxStarted = new Promise<void>((resolve) => {
      markDemuxStarted = resolve;
    });
    const frame = new CancelRaceFrame();
    const media = createMedia().use(
      delayedDecodeFrameModule(frame, demuxGate, () => {
        markDemuxStarted?.();
      }),
    );
    const stream = media.decode(fromBytes(new Uint8Array([0]), { mime: 'video/x-delayed' })).video;
    if (stream === undefined) throw new Error('expected a video stream');
    const reader = stream.getReader();
    const read = reader.read().catch((e: unknown) => e);
    await demuxStarted;
    const cancel = reader.cancel('stop-before-demux-resolves');
    releaseDemux?.();
    await cancel;
    await read;
    await frame.closed;
    expect(frame.closeCount).toBe(1);
  });

  it('materializes a one-shot input once so dual-track decode is pull-order safe', async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6);
    let inputPulls = 0;
    let demuxes = 0;
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          const start = inputPulls++ * 2;
          if (start >= bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(start, start + 2));
        },
      },
      { highWaterMark: 0 },
    );
    const videoFrame = new CancelRaceFrame();
    const audioFrame = new CancelRaceFrame();
    const media = createMedia().use(
      dualTrackStreamDecodeModule(bytes, videoFrame, audioFrame, () => {
        demuxes++;
      }),
    );
    const decoded = media.decode(media.from(input, { mime: 'video/x-dual-track' }));

    const audio = await readFirst(decoded.audio);
    const video = await readFirst(decoded.video);
    expect(audio).toBe(audioFrame);
    expect(video).toBe(videoFrame);
    expect(inputPulls).toBe(4);
    expect(demuxes).toBe(2);
    audioFrame.close();
    videoFrame.close();
    expect(audioFrame.closeCount).toBe(1);
    expect(videoFrame.closeCount).toBe(1);
  });

  it('codec/container-dependent ops raise a typed CapabilityError when nothing can serve them', async () => {
    // With no driver matching the NOOP container (and WebCodecs absent in Node), each op must surface a
    // typed CapabilityError. `convert`/`remux`/`trim`/`decrypt` reject at the container route;
    // `decode` returns frame streams synchronously (its
    // contract) whose rejection surfaces when the stream is first pulled (the demux/codec route runs lazily).
    const media = createMedia();
    await expect(media.convert(NOOP_BYTES, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(media.remux(NOOP_BYTES, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(media.trim(NOOP_BYTES, { start: 0, end: 1 })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(media.mux({}, { container: 'mp4' })).rejects.toBeInstanceOf(InputError);
    await expect(media.decrypt(NOOP_BYTES, { scheme: 'cenc', keys: {} })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    // `encode`/`mux` with no streams are input errors (nothing to encode/mux).
    await expect(media.encode({}, { to: 'mp4' })).rejects.toBeInstanceOf(InputError);
    await expect(media.h264AbrLadder(NOOP_BYTES, [])).rejects.toBeInstanceOf(InputError);
    await expect(readFirst(media.decode(NOOP_BYTES).video)).rejects.toBeInstanceOf(CapabilityError);
  });

  it('same-container remux and trim pass streaming options to stream-target sinks', async () => {
    const calls: Array<unknown> = [];
    const chunks: Array<readonly [number, Uint8Array]> = [];
    const media = createMedia().use(streamCopyModule(calls));
    const input = fromBytes(new Uint8Array([1]), { mime: 'video/x-copy-mp4' });
    const sink = toStreamTarget((chunk, position) => {
      chunks.push([position, chunk.slice()]);
    });

    await expect(media.remux(input, { to: 'mp4', sink })).resolves.toBeUndefined();
    await expect(media.trim(input, { start: 0, end: 2, sink })).resolves.toBeUndefined();

    expect(chunks).toEqual([
      [0, new Uint8Array([7, 8, 9])],
      [0, new Uint8Array([7, 8, 9])],
    ]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({ streaming: true });
      expect(call).not.toMatchObject({ buffered: true });
    }
  });

  it('accurate whole-source trim returns original re-readable source bytes after duration validation', async () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const calls: string[] = [];
    const tracks: TrackInfo[] = [
      {
        id: 1,
        mediaType: 'audio',
        codec: 'mp4a.40.2',
        durationSec: 2.04,
        gapless: { leadingSamples: 1024, trailingSamples: 571, totalSamples: 88_200 },
        config: { codec: 'mp4a.40.2', sampleRate: 44_100, numberOfChannels: 2 },
      },
    ];
    const driver: ContainerDriver = {
      id: 'identity-trim-mp4',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['mp4'],
      supports: (q) => q.mime === 'video/x-identity-trim-mp4',
      probe: () => {
        calls.push('probe');
        return Promise.resolve(tracks);
      },
      demux: () => {
        throw new Error('identity trim must not open a demuxer when probe() is available');
      },
      createMuxer: () => {
        throw new Error('identity trim must not create a muxer');
      },
    };
    const media = createMedia().use({
      apiVersion: DRIVER_API_VERSION,
      register: (reg) => reg.addContainer(driver),
    });

    const out = await media.trim(fromBytes(bytes, { mime: 'video/x-identity-trim-mp4' }), {
      start: 0,
      end: 2.0004,
      mode: 'accurate',
    });

    expect(out).toBeInstanceOf(Blob);
    if (!(out instanceof Blob)) throw new Error('expected trim to materialize a Blob');
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(bytes);
    expect(calls).toEqual(['probe']);
  });

  it('cross-target remux uses a driver-declared streamCopy target before the generic packet seam', async () => {
    const calls: Array<unknown> = [];
    const media = createMedia().use(crossTargetStreamCopyModule(calls));
    const input = fromBytes(new Uint8Array([1]), { mime: 'audio/x-copy-flac' });

    const out = await media.remux(input, { to: 'ogg' });

    if (!(out instanceof Blob)) throw new Error('expected Blob output');
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(
      new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ container: 'ogg' });
  });

  it('encode validates unsupported targets and missing stream targets before opening codecs', async () => {
    const media = createMedia().use(NoopDriverModule);
    await expect(
      media.encode({ audio: frameStream<AudioData>() }, { to: 'wav', audio: { codec: 'opus' } }),
    ).rejects.toBeInstanceOf(CapabilityError);
    await expect(
      media.encode(
        { audio: frameStream<AudioData>() },
        { to: 'aac', audio: { codec: 'opus', sampleRate: 48_000, channels: 2 } },
      ),
    ).rejects.toBeInstanceOf(CapabilityError);
    await expect(
      media.encode({ video: frameStream<VideoFrame>() }, { to: 'mp4' }),
    ).rejects.toBeInstanceOf(InputError);
    await expect(
      media.encode({ audio: frameStream<AudioData>() }, { to: 'mp4' }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('decrypt rejects a routed container that has no decrypt capability', async () => {
    const media = createMedia().use(NoopDriverModule);
    await expect(
      media.decrypt(NOOP_BYTES, {
        scheme: 'cenc',
        keys: { '00112233445566778899aabbccddeeff': '000102030405060708090a0b0c0d0e0f' },
      }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('reads the head of a non-seekable custom source, then routes', async () => {
    let opens = 0;
    const noRange: Source = {
      __media: 'source',
      kind: 'bytes',
      stream: () => {
        opens++;
        return new ReadableStream({
          start: (c) => {
            c.enqueue(new Uint8Array([0x66]));
            c.close();
          },
        });
      },
    };
    const media = createMedia().use(tracksModule());
    const info = await media.probe(noRange);
    expect(info.container).toBe('mp4');
    expect(opens).toBeGreaterThanOrEqual(2);
  });

  it('honors a pre-aborted signal path without crashing', async () => {
    const media = createMedia().use(NoopDriverModule);
    await media.probe(NOOP_BYTES, { signal: AbortSignal.abort() }).catch(() => undefined);
  });

  it('honors a per-call determinism strategy override', async () => {
    const media = createMedia().use(NoopDriverModule);
    const info = await media.probe(NOOP_BYTES, { strategy: { determinism: 'force-software' } });
    expect(info.container).toBe('noop');
  });

  it('runs with a live (not-yet-aborted) signal', async () => {
    const media = createMedia().use(NoopDriverModule);
    const info = await media.probe(NOOP_BYTES, { signal: new AbortController().signal });
    expect(info.container).toBe('noop');
  });

  it('probes a direct one-shot real-media stream after bounded routing peeks', async () => {
    const bytes = loadMedia('bear-vp9-alpha.webm');
    let offset = 0;
    let cancels = 0;
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 1021, bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );

    const info = await createMedia().use(WebmModule).probe(input);
    expect(info.container).toBe('webm');
    expect(info.tracks.find((track) => track.type === 'video')?.codec).toBe('vp9');
    expect(offset).toBe(bytes.byteLength);
    expect(cancels).toBe(0);
  });

  it('demuxes a direct one-shot real-media stream after replaying its route prefix', async () => {
    const bytes = loadMedia('bear-vp9-alpha.webm');
    let offset = 0;
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 4093, bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      },
      { highWaterMark: 0 },
    );

    const demuxed = await createMedia().use(WebmModule).demux(input);
    try {
      expect(demuxed.tracks.find((track) => track.mediaType === 'video')?.codec).toBe('vp9');
      expect(offset).toBe(bytes.byteLength);
    } finally {
      await demuxed.close();
    }
  });

  it('routes a container by file extension', async () => {
    const media = createMedia().use(NoopDriverModule);
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'clip.noop');
    expect((await media.probe(file)).container).toBe('noop');
  });

  it('trim routes a hinted PCM container without a separate source-head read', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const calls: Array<readonly [number, number]> = [];
    const src: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'audio/wav',
      size: bytes.byteLength,
      range: (start, end) => {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('hinted trim should use the transform range read only');
      },
    };
    const driver: ContainerDriver = {
      id: 'hinted-wav',
      apiVersion: DRIVER_API_VERSION,
      kind: 'container',
      formats: ['wav'],
      supports: (q) => q.mime === 'audio/wav' && q.head === undefined,
      validatesPcmTrim: true,
      transformPcm: async (source) => {
        if (source.range === undefined) throw new Error('expected a seekable source');
        return byteStream(await source.range(0, source.size ?? 0));
      },
      demux: () => {
        throw new Error('validated PCM trim should not demux');
      },
      createMuxer: () => {
        throw new Error('unused');
      },
    };
    const media = createMedia().use({
      apiVersion: DRIVER_API_VERSION,
      register: (reg) => reg.addContainer(driver),
    });

    const out = await media.trim(src, { start: 0, end: 1 });
    expect(out).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (out as Blob).arrayBuffer())).toEqual(bytes);
    expect(calls).toEqual([[0, bytes.byteLength]]);
  });

  it('codec ops reject an invalid input shape with InputError', async () => {
    await expect(
      createMedia().convert(123 as unknown as MediaInput, { to: 'mp4' }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('op handles expose .cancel()', () => {
    const handle = createMedia().probe(NOOP_BYTES);
    expect(typeof handle.cancel).toBe('function');
    handle.cancel();
    return expect(handle).rejects.toBeInstanceOf(MediaError);
  });

  it('releases the caller AbortSignal listener after a cancellable task settles', async () => {
    let adds = 0;
    let removes = 0;
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const signal = {
      aborted: false,
      reason: undefined,
      onabort: null,
      throwIfAborted(): void {},
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type !== 'abort') return;
        adds++;
        listeners.add(listener);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (type !== 'abort') return;
        removes++;
        listeners.delete(listener);
      },
      dispatchEvent(): boolean {
        return true;
      },
    } as AbortSignal;

    await expect(
      createMedia().use(NoopDriverModule).probe(NOOP_BYTES, { signal }),
    ).resolves.toMatchObject({ container: 'noop' });
    expect(adds).toBe(1);
    expect(removes).toBe(1);
    expect(listeners.size).toBe(0);

    await expect(createMedia().probe(NOOP_BYTES, { signal })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    expect(adds).toBe(2);
    expect(removes).toBe(2);
    expect(listeners.size).toBe(0);
  });

  it('use() validates the driver module apiVersion', () => {
    const media = createMedia();
    expect(() => media.use({ apiVersion: 999, register: () => {} })).toThrowError(MediaError);
  });

  it('preload is idempotent and never throws', async () => {
    await expect(
      createMedia().preload('probe', { op: 'convert', container: 'mp4' }),
    ).resolves.toBeUndefined();
  });

  it('preload warms registered container, codec, and filter capability probes once', async () => {
    const counts = { container: 0, codec: 0, filter: 0 };
    const media = createMedia().use(warmableModule(counts));

    await expect(
      media.preload({
        op: 'convert',
        container: 'warm',
        video: 'warm',
        audio: 'warm',
        level: 'ready',
      }),
    ).resolves.toBeUndefined();

    expect(counts.container).toBeGreaterThan(0);
    expect(counts.codec).toBeGreaterThan(0);
    expect(counts.filter).toBeGreaterThan(0);
    const afterFirst = { ...counts };

    await expect(
      media.preload({
        op: 'convert',
        container: 'warm',
        video: 'warm',
        audio: 'warm',
        level: 'ready',
      }),
    ).resolves.toBeUndefined();

    expect(counts).toEqual(afterFirst);
  });

  it('preload swallows warmup probe failures from drivers', async () => {
    await expect(
      createMedia().use(throwingWarmupModule()).preload({
        op: 'convert',
        container: 'throw',
        video: 'throw',
        level: 'ready',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('bare-function sugar', () => {
  it('delegates every verb to a shared default instance', async () => {
    expect(sugar.transcode).toBe(sugar.convert);
    await expect(sugar.probe(NOOP_BYTES)).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.demux(NOOP_BYTES)).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.convert(NOOP_BYTES, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.h264AbrLadder(NOOP_BYTES, [])).rejects.toBeInstanceOf(InputError);
    await expect(sugar.remux(NOOP_BYTES, { to: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.trim(NOOP_BYTES, { start: 0, end: 1 })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(sugar.encode({}, { to: 'mp4' })).rejects.toBeInstanceOf(InputError);
    await expect(sugar.mux({}, { container: 'mp4' })).rejects.toBeInstanceOf(InputError);
    await expect(sugar.decrypt(NOOP_BYTES, { scheme: 'cenc', keys: {} })).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(readFirst(sugar.decode(NOOP_BYTES).video)).rejects.toBeInstanceOf(CapabilityError);
    await expect(sugar.preload('probe')).resolves.toBeUndefined();
    expect(typeof sugar.load(NOOP_BYTES).convert).toBe('function');
  });
});
