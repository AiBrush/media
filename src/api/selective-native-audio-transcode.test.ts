import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebCodecsAudioDriver } from '../codecs/webcodecs-audio.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { adtsPacketInfoFromBytes } from '../drivers/adts/adts-driver.ts';
import { webmPacketPayloadInfoFromBytes } from '../drivers/webm/webm-driver.ts';
import { createMedia } from './create-media.ts';

const FIXTURE = fileURLToPath(new URL('../../fixtures/media/sfx.adts', import.meta.url));
const originalAudioData = globalThis.AudioData;
const originalAudioDecoder = globalThis.AudioDecoder;
const originalAudioEncoder = globalThis.AudioEncoder;
const originalEncodedAudioChunk = globalThis.EncodedAudioChunk;

let source = new Uint8Array();
let frameCloses = 0;

class TestEncodedAudioChunk {
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
    const view = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    view.set(this.#data);
  }
}

class TestAudioData {
  readonly timestamp: number;
  readonly duration: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  #closed = false;

  constructor(init: AudioDataInit) {
    this.timestamp = init.timestamp;
    this.numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.sampleRate = init.sampleRate;
    this.duration = Math.round((init.numberOfFrames * 1_000_000) / init.sampleRate);
  }

  close(): void {
    if (this.#closed) throw new Error('AudioData closed twice');
    this.#closed = true;
    frameCloses++;
  }
}

class TestAudioDecoder extends EventTarget {
  static isConfigSupported(config: AudioDecoderConfig): Promise<AudioDecoderSupport> {
    return Promise.resolve({ supported: true, config });
  }

  readonly #output: (output: AudioData) => void;
  state: CodecState = 'unconfigured';
  decodeQueueSize = 0;
  #config: AudioDecoderConfig | undefined;

  constructor(init: AudioDecoderInit) {
    super();
    this.#output = init.output;
  }

  configure(config: AudioDecoderConfig): void {
    this.#config = config;
    this.state = 'configured';
  }

  decode(chunk: EncodedAudioChunk): void {
    const config = this.#config;
    if (config === undefined) throw new Error('decoder not configured');
    this.#output(
      new TestAudioData({
        format: 'f32-planar',
        sampleRate: config.sampleRate,
        numberOfFrames: 1024,
        numberOfChannels: config.numberOfChannels,
        timestamp: chunk.timestamp,
        data: new ArrayBuffer(1024 * config.numberOfChannels * 4),
      }) as unknown as AudioData,
    );
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.state = 'closed';
  }
}

function opusHead(channels: number, sampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'));
  head[8] = 1;
  head[9] = channels;
  new DataView(head.buffer).setUint32(12, sampleRate, true);
  return head;
}

class TestAudioEncoder extends EventTarget {
  static isConfigSupported(config: AudioEncoderConfig): Promise<AudioEncoderSupport> {
    return Promise.resolve({ supported: true, config });
  }

  readonly #output: (output: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => void;
  state: CodecState = 'unconfigured';
  encodeQueueSize = 0;
  #config: AudioEncoderConfig | undefined;

  constructor(init: AudioEncoderInit) {
    super();
    this.#output = init.output;
  }

  configure(config: AudioEncoderConfig): void {
    this.#config = config;
    this.state = 'configured';
  }

  encode(data: AudioData): void {
    const config = this.#config;
    if (config === undefined) throw new Error('encoder not configured');
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, Math.max(0, Math.round(data.timestamp)), true);
    view.setUint32(4, data.numberOfFrames, true);
    const chunk = new TestEncodedAudioChunk({
      type: 'key',
      timestamp: data.timestamp,
      duration: data.duration,
      data: payload,
    }) as unknown as EncodedAudioChunk;
    this.#output(chunk, {
      decoderConfig: {
        codec: 'opus',
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
        description: opusHead(config.numberOfChannels, config.sampleRate),
      },
    });
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.state = 'closed';
  }
}

function installShims(): void {
  Object.defineProperty(globalThis, 'AudioData', {
    configurable: true,
    value: TestAudioData as unknown as typeof AudioData,
  });
  Object.defineProperty(globalThis, 'AudioDecoder', {
    configurable: true,
    value: TestAudioDecoder as unknown as typeof AudioDecoder,
  });
  Object.defineProperty(globalThis, 'AudioEncoder', {
    configurable: true,
    value: TestAudioEncoder as unknown as typeof AudioEncoder,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    value: TestEncodedAudioChunk as unknown as typeof EncodedAudioChunk,
  });
}

function restoreGlobal<
  K extends 'AudioData' | 'AudioDecoder' | 'AudioEncoder' | 'EncodedAudioChunk',
>(key: K, value: (typeof globalThis)[K] | undefined): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, key);
  else Object.defineProperty(globalThis, key, { configurable: true, value });
}

async function transcode(registerAll: boolean): Promise<{
  readonly bytes: Uint8Array;
  readonly closes: number;
}> {
  frameCloses = 0;
  const media = createMedia({ worker: false });
  if (registerAll) await media.preload('probe');
  const output = await media.convert(new Blob([source], { type: 'audio/aac' }), {
    to: 'webm',
    video: false,
    audio: { codec: 'opus' },
  });
  if (!(output instanceof Blob)) throw new Error('expected Blob output');
  return { bytes: new Uint8Array(await output.arrayBuffer()), closes: frameCloses };
}

beforeAll(async () => {
  source = new Uint8Array(await readFile(FIXTURE));
  installShims();
});

afterAll(() => {
  restoreGlobal('AudioData', originalAudioData);
  restoreGlobal('AudioDecoder', originalAudioDecoder);
  restoreGlobal('AudioEncoder', originalAudioEncoder);
  restoreGlobal('EncodedAudioChunk', originalEncodedAudioChunk);
});

describe('selective native-audio transcode registration', () => {
  it('preserves exact public WebM bytes, packet clocks, and close-once truth versus register-all', async () => {
    const inputPackets = adtsPacketInfoFromBytes(source).packets;
    const selective = await transcode(false);
    const control = await transcode(true);

    expect(selective.bytes).toEqual(control.bytes);
    expect(selective.closes).toBe(inputPackets.length);
    expect(control.closes).toBe(inputPackets.length);

    const output = webmPacketPayloadInfoFromBytes(selective.bytes);
    expect(output.tracks).toHaveLength(1);
    expect(output.tracks[0]).toMatchObject({ mediaType: 'audio', codec: 'opus' });
    expect(output.packets).toHaveLength(inputPackets.length);
    expect(output.packets.map((packet) => packet.ptsUs)).toEqual(
      inputPackets.map((packet) => Math.round(packet.ptsUs / 1000) * 1000),
    );
    for (let index = 0; index < output.packets.length; index++) {
      const actual = output.packets[index]?.durationUs;
      const expected = inputPackets[index]?.durationUs;
      expect(actual).toBeDefined();
      expect(expected).toBeDefined();
      expect(Math.abs((actual ?? 0) - (expected ?? 0))).toBeLessThanOrEqual(1000);
    }
  });

  it('keeps an already-aborted public operation frame-free and typed', async () => {
    frameCloses = 0;
    const controller = new AbortController();
    controller.abort('test abort');
    await expect(
      createMedia({ worker: false }).convert(
        new Blob([source], { type: 'audio/aac' }),
        { to: 'webm', video: false, audio: { codec: 'opus' } },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(frameCloses).toBe(0);
  });

  it('retains caller-registered codec precedence before selective native defaults', async () => {
    let supportCalls = 0;
    const media = createMedia({ worker: false }).use({
      apiVersion: DRIVER_API_VERSION,
      register(registry): void {
        registry.addCodec({
          ...WebCodecsAudioDriver,
          id: 'caller-audio',
          supports(query, options) {
            supportCalls++;
            return WebCodecsAudioDriver.supports(query, options);
          },
        });
      },
    });
    frameCloses = 0;
    const output = await media.convert(new Blob([source], { type: 'audio/aac' }), {
      to: 'webm',
      video: false,
      audio: { codec: 'opus' },
    });
    if (!(output instanceof Blob)) throw new Error('expected Blob output');
    expect(supportCalls).toBe(2);
    expect(frameCloses).toBe(adtsPacketInfoFromBytes(source).packets.length);
    expect(
      webmPacketPayloadInfoFromBytes(new Uint8Array(await output.arrayBuffer())).tracks[0],
    ).toMatchObject({ codec: 'opus' });
  });

  it('supports the exact native codec pin without preloading unrelated defaults', async () => {
    frameCloses = 0;
    const output = await createMedia({ worker: false }).convert(
      new Blob([source], { type: 'audio/aac' }),
      { to: 'webm', video: false, audio: { codec: 'opus' } },
      { strategy: { pinDriver: 'webcodecs-audio' } },
    );
    if (!(output instanceof Blob)) throw new Error('expected Blob output');
    expect(frameCloses).toBe(adtsPacketInfoFromBytes(source).packets.length);
    expect(
      webmPacketPayloadInfoFromBytes(new Uint8Array(await output.arrayBuffer())).tracks[0],
    ).toMatchObject({ codec: 'opus' });
  });
});
