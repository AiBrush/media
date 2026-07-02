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
  type Source,
  fromBytes,
  fromStream,
} from '../sources/source.ts';
import * as sugar from './create-media.ts';
import { createMedia } from './create-media.ts';

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
    supports: (q) => q.mime === 'video/x-delayed',
    async demux() {
      onDemuxStarted();
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

  it('probe shares the seekable prefix across image sniff, container route, and metadata hook', async () => {
    const bytes = loadMedia('bear-vp9-alpha.webm');
    const calls: Array<readonly [number, number]> = [];
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

    const info = await createMedia().use(WebmModule).probe(src);
    expect(calls).toEqual([[0, 4 * 1024]]);
    expect(info.tracks.find((track) => track.type === 'video')?.codec).toBe('vp9');
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
    expect(calls).toEqual([[0, 4 * 1024]]);
    expect(counts.sniff).toBe(0);
    expect(frame.closeCount).toBe(1);
  });

  it('decode consumes the prefix cached by an immediately preceding URL probe', async () => {
    const bytes = new Uint8Array(8192);
    const firstCalls: Array<readonly [number, number]> = [];
    const srcForProbe: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/x-delayed',
      size: bytes.byteLength,
      [SOURCE_CACHE_KEY]: 'url:https://fixtures.test/delayed.mp4',
      range: (start, end) => {
        firstCalls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable probe must not open the full stream');
      },
    };
    const srcForDecode: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/x-delayed',
      size: bytes.byteLength,
      [SOURCE_CACHE_KEY]: 'url:https://fixtures.test/delayed.mp4',
      range: () => {
        throw new Error('decode should use the probe prefix handoff');
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable decode must not open the full stream');
      },
    };
    const frame = new CancelRaceFrame();
    const media = createMedia().use(delayedDecodeFrameModule(frame, Promise.resolve(), () => {}));

    await expect(media.probe(srcForProbe)).resolves.toMatchObject({
      tracks: [{ id: 1, type: 'video', codec: 'fake-video' }],
    });
    const got = await readFirst(media.decode(srcForDecode).video);
    expect(got).toBe(frame);
    frame.close();
    expect(firstCalls).toEqual([[0, 4 * 1024]]);
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
      media.encode({ audio: frameStream<AudioData>() }, { to: 'aac', audio: { codec: 'opus' } }),
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
    const noRange: Source = {
      __media: 'source',
      kind: 'bytes',
      stream: () =>
        new ReadableStream({
          start: (c) => {
            c.enqueue(new Uint8Array([0x66]));
            c.close();
          },
        }),
    };
    const media = createMedia().use(tracksModule());
    const info = await media.probe(noRange);
    expect(info.container).toBe('mp4');
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

  it('rejects probing a non-seekable stream source', async () => {
    const media = createMedia().use(NoopDriverModule);
    const input = fromStream(
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      }),
    );
    await expect(media.probe(input)).rejects.toBeInstanceOf(InputError);
  });

  it('routes a container by file extension', async () => {
    const media = createMedia().use(NoopDriverModule);
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'clip.noop');
    expect((await media.probe(file)).container).toBe('noop');
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
