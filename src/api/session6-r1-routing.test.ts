import { describe, expect, it, vi } from 'vitest';
import { resetVorbisCoreForTest } from '../codecs/wasm-vorbis/wasm-vorbis-driver.ts';
import type {
  ByteSource,
  CodecDriver,
  CodecQuery,
  CodecSupport,
  ContainerDriver,
  ContainerQuery,
  Demuxer,
  DriverModule,
  Registry as DriverRegistry,
  EncodedChunk,
  Muxer,
  Packet,
  RawFrame,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { registerDefaultDrivers } from '../drivers/defaults.ts';
import { demuxWebm } from '../drivers/webm/webm-driver.ts';
import { Registry } from '../kernel/registry.ts';
import { Router } from '../kernel/router.ts';
import { fromBytes } from '../sources/source.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { createMedia } from './create-media.ts';

const SESSION6_FAKE_MIME = 'video/session6-r1';
const SESSION6_FAKE_BYTES = Uint8Array.of(0x52, 0x31);

interface EncodedFrameRecord {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly sourceId: number;
}

interface FakeVideoFrameSeed {
  readonly timestamp: number;
  readonly duration?: number | null;
  readonly sourceId?: number;
}

interface VideoConfigStageOptions extends StageOptions {
  onDecoderConfig?(config: VideoDecoderConfig): void;
}

function isVideoConfigStageOptions(
  options: StageOptions | undefined,
): options is VideoConfigStageOptions {
  return typeof (options as VideoConfigStageOptions | undefined)?.onDecoderConfig === 'function';
}

function copyBufferSource(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  return new Uint8Array(source).slice();
}

class Session6FakeVideoFrame {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly sourceId: number;
  closeCount = 0;

  constructor(source: Session6FakeVideoFrame | FakeVideoFrameSeed, init?: VideoFrameInit) {
    this.timestamp = init?.timestamp ?? source.timestamp;
    const initDuration = init !== undefined && 'duration' in init ? init.duration : undefined;
    this.duration = initDuration ?? source.duration ?? null;
    this.sourceId = source.sourceId ?? -1;
  }

  close(): void {
    this.closeCount++;
    if (this.closeCount > 1) throw new Error(`frame ${this.sourceId} closed twice`);
  }
}

class Session6FakeEncodedVideoChunk {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: EncodedVideoChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = copyBufferSource(init.data);
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const view = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    view.set(this.#data);
  }
}

function installVideoFrameShim(): () => void {
  const original = globalThis.VideoFrame;
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    writable: true,
    value: Session6FakeVideoFrame as unknown as typeof VideoFrame,
  });
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, 'VideoFrame');
      return;
    }
    Object.defineProperty(globalThis, 'VideoFrame', {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

function fakePacket(timestamp: number, duration: number, sourceId: number): Packet {
  return {
    chunk: new Session6FakeEncodedVideoChunk({
      type: 'key',
      timestamp,
      duration,
      data: Uint8Array.of(sourceId),
    }) as unknown as EncodedChunk,
  };
}

class Session6FakeDemuxer implements Demuxer {
  readonly tracks: readonly TrackInfo[] = [
    {
      id: 0,
      mediaType: 'video',
      codec: 'fake-video',
      durationSec: 66_667 / 1_000_000,
      config: { codec: 'fake-video', codedWidth: 16, codedHeight: 16 },
    },
  ];

  packetTable(): readonly [] {
    return [];
  }

  packets(trackId: number): ReadableStream<Packet> {
    if (trackId !== 0)
      return new ReadableStream<Packet>({ start: (controller) => controller.close() });
    const packets = [fakePacket(0, 33_333, 0), fakePacket(33_333, 33_334, 1)];
    return new ReadableStream<Packet>({
      start(controller): void {
        for (const packet of packets) controller.enqueue(packet);
        controller.close();
      },
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class Session6FakeMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;
  readonly #records: EncodedFrameRecord[] = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  constructor() {
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
      },
    });
  }

  addTrack(_info: TrackInfo): number {
    return 0;
  }

  write(_trackId: number, packet: Packet): Promise<void> {
    const data = new Uint8Array(packet.chunk.byteLength);
    packet.chunk.copyTo(data);
    this.#records.push({
      timestamp: packet.chunk.timestamp,
      duration: packet.chunk.duration ?? null,
      sourceId: data[0] ?? -1,
    });
    return Promise.resolve();
  }

  finalize(): Promise<void> {
    this.#controller?.enqueue(new TextEncoder().encode(JSON.stringify(this.#records)));
    this.#controller?.close();
    return Promise.resolve();
  }
}

const Session6FakeContainer: ContainerDriver = {
  id: 'session6-r1-fake-container',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['session6-r1', 'mp4'],
  supports(q: ContainerQuery): boolean {
    if (q.direction === 'demux') return q.mime === SESSION6_FAKE_MIME;
    return q.extension === 'mp4' || q.mime === 'video/mp4';
  },
  demux(_src: ByteSource, _o?: StageOptions): Promise<Demuxer> {
    return Promise.resolve(new Session6FakeDemuxer());
  },
  createMuxer(): Muxer {
    return new Session6FakeMuxer();
  },
};

const Session6FakeCodec: CodecDriver = {
  id: 'session6-r1-fake-codec',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'native',
  supports(q: CodecQuery): Promise<CodecSupport> {
    const codec = q.config.codec.toLowerCase();
    return Promise.resolve({
      supported:
        q.mediaType === 'video' &&
        ((q.direction === 'decode' && codec === 'fake-video') ||
          (q.direction === 'encode' && codec.startsWith('avc1'))),
      hardwareAccelerated: false,
    });
  },
  createDecoder(): TransformStream<EncodedChunk, RawFrame> {
    let sourceId = 0;
    return new TransformStream<EncodedChunk, RawFrame>({
      transform(chunk, controller): void {
        controller.enqueue(
          new Session6FakeVideoFrame({
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            sourceId,
          }) as unknown as RawFrame,
        );
        sourceId++;
      },
    });
  },
  createEncoder(_config, options): TransformStream<RawFrame, EncodedChunk> {
    if (isVideoConfigStageOptions(options)) {
      const onDecoderConfig = options.onDecoderConfig;
      if (onDecoderConfig !== undefined) {
        onDecoderConfig({ codec: 'avc1.42E01E', codedWidth: 16, codedHeight: 16 });
      }
    }
    return new TransformStream<RawFrame, EncodedChunk>({
      transform(frame, controller): void {
        const videoFrame = frame as unknown as Session6FakeVideoFrame;
        try {
          controller.enqueue(
            new Session6FakeEncodedVideoChunk({
              type: 'key',
              timestamp: videoFrame.timestamp,
              ...(videoFrame.duration !== null ? { duration: videoFrame.duration } : {}),
              data: Uint8Array.of(videoFrame.sourceId),
            }) as unknown as EncodedChunk,
          );
        } finally {
          videoFrame.close();
        }
      },
    });
  },
};

const Session6FakeModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: DriverRegistry): void {
    reg.addContainer(Session6FakeContainer);
    reg.addCodec(Session6FakeCodec);
  },
};

async function outputRecords(output: unknown): Promise<readonly EncodedFrameRecord[]> {
  if (!(output instanceof Blob)) throw new Error('expected Blob output');
  const parsed = JSON.parse(await output.text()) as unknown;
  if (!Array.isArray(parsed)) throw new Error('expected record array');
  return parsed.map((record): EncodedFrameRecord => {
    if (
      typeof record !== 'object' ||
      record === null ||
      typeof (record as EncodedFrameRecord).timestamp !== 'number' ||
      !(
        typeof (record as EncodedFrameRecord).duration === 'number' ||
        (record as EncodedFrameRecord).duration === null
      ) ||
      typeof (record as EncodedFrameRecord).sourceId !== 'number'
    ) {
      throw new Error('malformed encoded frame record');
    }
    const typed = record as EncodedFrameRecord;
    return { timestamp: typed.timestamp, duration: typed.duration, sourceId: typed.sourceId };
  });
}

function installAudioRoutingShims(
  isConfigSupported: (config: AudioDecoderConfig) => Promise<AudioDecoderSupport>,
): () => void {
  const originalAudioDecoder = globalThis.AudioDecoder;
  const originalAudioData = globalThis.AudioData;
  const originalEncodedAudioChunk = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'AudioDecoder', {
    configurable: true,
    writable: true,
    value: { isConfigSupported } as unknown as typeof AudioDecoder,
  });
  Object.defineProperty(globalThis, 'AudioData', {
    configurable: true,
    writable: true,
    value: class Session6FakeAudioData {
      close(): void {}
    } as unknown as typeof AudioData,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: class Session6FakeEncodedAudioChunk {} as unknown as typeof EncodedAudioChunk,
  });
  return () => {
    if (originalAudioDecoder === undefined) Reflect.deleteProperty(globalThis, 'AudioDecoder');
    else
      Object.defineProperty(globalThis, 'AudioDecoder', {
        configurable: true,
        writable: true,
        value: originalAudioDecoder,
      });
    if (originalAudioData === undefined) Reflect.deleteProperty(globalThis, 'AudioData');
    else
      Object.defineProperty(globalThis, 'AudioData', {
        configurable: true,
        writable: true,
        value: originalAudioData,
      });
    if (originalEncodedAudioChunk === undefined)
      Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        writable: true,
        value: originalEncodedAudioChunk,
      });
  };
}

describe('Session 6 R1 — fps/retime convert reachability', () => {
  it('inserts the CFR frame retimer before encode when convert(video.fps) is requested', async () => {
    const restoreVideoFrame = installVideoFrameShim();
    try {
      const engine = createMedia({ worker: false }).use(Session6FakeModule);
      const output = await engine.convert(
        fromBytes(SESSION6_FAKE_BYTES, { mime: SESSION6_FAKE_MIME }),
        { to: 'mp4', video: { codec: 'h264', fps: 60 }, audio: false },
      );
      const records = await outputRecords(output);

      expect(records.map((record) => record.timestamp)).toEqual([0, 16_667, 33_333, 50_000]);
      expect(records.map((record) => record.duration)).toEqual([16_667, 16_666, 16_667, 16_667]);
      expect(records.map((record) => record.sourceId)).toEqual([0, 0, 1, 1]);
    } finally {
      restoreVideoFrame();
    }
  });
});

describe('Session 6 R1 — Vorbis decode fallback routing', () => {
  it('selects the default wasm-vorbis decoder after a browser AudioDecoder Vorbis miss', async () => {
    resetVorbisCoreForTest();
    const isConfigSupported = vi.fn(
      async (config: AudioDecoderConfig): Promise<AudioDecoderSupport> => ({
        supported: false,
        config,
      }),
    );
    const restoreAudio = installAudioRoutingShims(isConfigSupported);
    try {
      const bytes = await loadFixture('bear-multitrack.webm');
      const demuxed = demuxWebm(bytes);
      const vorbis = demuxed.info.tracks.find((track) => track.codec === 'vorbis');
      if (vorbis?.description === undefined) throw new Error('expected real Vorbis CodecPrivate');
      const reg = new Registry();
      registerDefaultDrivers(reg);
      const router = new Router({ registry: reg });
      const config: AudioDecoderConfig = {
        codec: 'vorbis',
        sampleRate: vorbis.sampleRate ?? 0,
        numberOfChannels: vorbis.channels ?? 0,
        description: vorbis.description,
      };

      const picked = await router.pickCodec({
        mediaType: 'audio',
        direction: 'decode',
        config,
      });

      expect(isConfigSupported).toHaveBeenCalledWith(config);
      expect(picked.id).toBe('wasm-vorbis');
    } finally {
      restoreAudio();
      resetVorbisCoreForTest();
    }
  });
});
