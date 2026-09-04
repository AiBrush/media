/**
 * Codec-route verdict wiring (R-S01.2 / ADR-203, R-S01.4 Option A / ADR-320, R-S05.2).
 *
 * Strict oracles:
 *  - exactly ONE `supports()` probe per exact config — the decoder is configured with the *accepted*
 *    `hardwareAcceleration` rung from the routing verdict, never a second probe;
 *  - the engine wires a NON-noop router `ensureLoaded` that reaches a candidate's own lazy-chunk hook,
 *    in ladder order, before that candidate's probe;
 *  - the seek path pools a warm decoder strictly by the driver's advertised *capability*
 *    (`supportsWarmDecoderReuse`), proven with a fake non-first-party driver — never by a driver id;
 *  - every fake frame is `close()`d exactly once (counting frames, audited).
 */

import { describe, expect, it, vi } from 'vitest';
import type { WarmVideoDecoderPool } from '../codecs/webcodecs-video.ts';
import {
  type CodecDriver,
  type CodecQuery,
  type CodecSupport,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DriverModule,
  type EncodedChunk,
  type Packet,
  type RawFrame,
  type TrackInfo,
} from '../contracts/driver.ts';
import { fromBytes } from '../sources/source.ts';
import { decoderConfigWithRoutedAcceleration, supportsWarmDecoderReuse } from './codec-route.ts';
import { createMedia } from './create-media.ts';

/** Hoisted fake warm-pool state so the module mock and the tests share one observable record. */
const poolState = vi.hoisted(() => {
  interface CountingFrame {
    timestamp: number;
    closeCount: number;
    close(): void;
  }
  const state = {
    created: 0,
    disposeCount: 0,
    borrowConfigs: [] as unknown[],
    frames: [] as CountingFrame[],
    makeFrame(): CountingFrame {
      const frame: CountingFrame = {
        timestamp: 0,
        closeCount: 0,
        close(): void {
          frame.closeCount += 1;
        },
      };
      state.frames.push(frame);
      return frame;
    },
  };
  return state;
});

vi.mock('../codecs/webcodecs-video.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../codecs/webcodecs-video.ts')>();
  const createWarmVideoDecoderPool = (): WarmVideoDecoderPool => {
    poolState.created += 1;
    return {
      borrow(config): TransformStream<EncodedChunk, RawFrame> {
        poolState.borrowConfigs.push(config);
        return new TransformStream<EncodedChunk, RawFrame>({
          transform(_chunk, controller): void {
            controller.enqueue(poolState.makeFrame() as unknown as RawFrame);
          },
        });
      },
      dispose(): void {
        poolState.disposeCount += 1;
      },
    };
  };
  return { ...original, createWarmVideoDecoderPool };
});

class CountingFrame {
  readonly timestamp = 0;
  readonly duration = 1_000;
  closeCount = 0;
  close(): void {
    this.closeCount++;
  }
}

function fakeKeyPacket(): Packet {
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
  };
  return { chunk: chunk as unknown as EncodedChunk };
}

function fakeContainer(id: string, mime: string, codec: string): ContainerDriver {
  const track: TrackInfo = {
    id: 1,
    mediaType: 'video',
    codec,
    config: { codec, codedWidth: 16, codedHeight: 16 },
  };
  return {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: (q) => q.mime === mime,
    demux: () =>
      Promise.resolve({
        tracks: [track],
        packets: () =>
          new ReadableStream<Packet>({
            start(controller): void {
              controller.enqueue(fakeKeyPacket());
              controller.close();
            },
          }),
        close: () => Promise.resolve(),
      }),
    createMuxer: () => {
      throw new Error('unused');
    },
  };
}

interface FakeCodecOptions {
  readonly codec: string;
  readonly hardwareAccelerated?: boolean;
  readonly warmReuse?: boolean;
  readonly ensureLoaded?: () => void;
  readonly frames?: CountingFrame[];
}

interface FakeCodec {
  readonly driver: CodecDriver;
  readonly supports: ReturnType<typeof vi.fn>;
  readonly decoderConfigs: unknown[];
}

function fakeCodec(id: string, opts: FakeCodecOptions): FakeCodec {
  const decoderConfigs: unknown[] = [];
  const supports = vi.fn(
    (q: CodecQuery): Promise<CodecSupport> =>
      Promise.resolve({
        supported: q.direction === 'decode' && q.config.codec === opts.codec,
        ...(opts.hardwareAccelerated !== undefined
          ? { hardwareAccelerated: opts.hardwareAccelerated }
          : {}),
      }),
  );
  const driver: CodecDriver & {
    readonly ensureLoaded?: () => void;
    readonly supportsWarmDecoderReuse?: boolean;
  } = {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'hardware',
    ...(opts.warmReuse === true ? { supportsWarmDecoderReuse: true } : {}),
    ...(opts.ensureLoaded !== undefined ? { ensureLoaded: opts.ensureLoaded } : {}),
    supports,
    createDecoder: (config) => {
      decoderConfigs.push(config);
      return new TransformStream<EncodedChunk, RawFrame>({
        transform(_chunk, controller): void {
          const frame = new CountingFrame();
          opts.frames?.push(frame);
          controller.enqueue(frame as unknown as RawFrame);
        },
      });
    },
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
  return { driver, supports, decoderConfigs };
}

function moduleOf(container: ContainerDriver, codec: CodecDriver): DriverModule {
  return {
    apiVersion: DRIVER_API_VERSION,
    register(reg): void {
      reg.addContainer(container);
      reg.addCodec(codec);
    },
  };
}

/** Pull the first item from a frame stream (forces the lazy decode route to run). */
async function readFirst<T>(stream: ReadableStream<T> | undefined): Promise<T | undefined> {
  if (!stream) return undefined;
  const reader = stream.getReader();
  try {
    return (await reader.read()).value;
  } finally {
    reader.releaseLock();
  }
}

const BYTES = new Uint8Array([0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);

describe('routed acceleration verdict (R-S01.2 / ADR-203)', () => {
  it('leaves a hardware-capable verdict to the browser with exactly 1 probe per exact config', async () => {
    const frames: CountingFrame[] = [];
    const codec = fakeCodec('accel-codec', {
      codec: 'fake-accel',
      hardwareAccelerated: true,
      frames,
    });
    const media = createMedia().use(
      moduleOf(fakeContainer('accel-mp4', 'video/x-accel', 'fake-accel'), codec.driver),
    );

    const first = await readFirst(media.decode(fromBytes(BYTES, { mime: 'video/x-accel' })).video);
    expect(first).toBeInstanceOf(CountingFrame);
    (first as unknown as CountingFrame).close();
    expect(codec.supports).toHaveBeenCalledTimes(1);
    expect(codec.decoderConfigs).toHaveLength(1);
    // A hardware-capable verdict is not pinned onto the decoder: forcing `prefer-hardware` costs a
    // ~2.5 ms session per decoder on small pictures, and the browser still picks hardware for
    // sustained decodes under its own default.
    expect(codec.decoderConfigs[0]).toMatchObject({ codec: 'fake-accel' });
    expect(codec.decoderConfigs[0]).not.toHaveProperty('hardwareAcceleration');

    // Same exact config again on the same engine: the cached CodecRoute serves the verdict — still
    // exactly ONE probe in total, and the decoder still gets the exact accepted rung.
    const second = await readFirst(media.decode(fromBytes(BYTES, { mime: 'video/x-accel' })).video);
    (second as unknown as CountingFrame).close();
    expect(codec.supports).toHaveBeenCalledTimes(1);
    expect(codec.decoderConfigs).toHaveLength(2);
    expect(codec.decoderConfigs[1]).not.toHaveProperty('hardwareAcceleration');

    // Frame-lifetime audit: every decoded frame was closed exactly once (by its owning consumer).
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(frame.closeCount).toBe(1);
  });

  it('pins prefer-software when the accepted verdict is explicitly non-accelerated', async () => {
    const codec = fakeCodec('sw-codec', { codec: 'fake-sw', hardwareAccelerated: false });
    const media = createMedia().use(
      moduleOf(fakeContainer('sw-mp4', 'video/x-sw', 'fake-sw'), codec.driver),
    );
    const frame = await readFirst(media.decode(fromBytes(BYTES, { mime: 'video/x-sw' })).video);
    (frame as unknown as CountingFrame).close();
    expect(codec.supports).toHaveBeenCalledTimes(1);
    expect(codec.decoderConfigs[0]).toMatchObject({ hardwareAcceleration: 'prefer-software' });
  });

  it('leaves the config untouched when the verdict carries no acceleration fact', async () => {
    const codec = fakeCodec('plain-codec', { codec: 'fake-plain' });
    const media = createMedia().use(
      moduleOf(fakeContainer('plain-mp4', 'video/x-plain', 'fake-plain'), codec.driver),
    );
    const frame = await readFirst(media.decode(fromBytes(BYTES, { mime: 'video/x-plain' })).video);
    (frame as unknown as CountingFrame).close();
    expect(
      (codec.decoderConfigs[0] as { hardwareAcceleration?: unknown }).hardwareAcceleration,
    ).toBeUndefined();
  });

  it('decoderConfigWithRoutedAcceleration never mutates the routed config (cache-key stability)', () => {
    const config = { codec: 'vp8', codedWidth: 16, codedHeight: 16 } as const;
    const routed = decoderConfigWithRoutedAcceleration(config, {
      supported: true,
      hardwareAccelerated: false,
    });
    expect(routed).not.toBe(config);
    expect(routed).toMatchObject({ codec: 'vp8', hardwareAcceleration: 'prefer-software' });
    expect('hardwareAcceleration' in config).toBe(false);
    // A hardware-capable verdict and a verdict without an acceleration fact both pass the routed
    // config through untouched (same object, cache keys stay byte-stable).
    expect(
      decoderConfigWithRoutedAcceleration(config, { supported: true, hardwareAccelerated: true }),
    ).toBe(config);
    expect(decoderConfigWithRoutedAcceleration(config, { supported: true })).toBe(config);
  });
});

describe('engine-wired router ensureLoaded (R-S01.4 Option A / ADR-320)', () => {
  it('awaits a candidate driver lazy-chunk hook before its probe — a non-noop hook end to end', async () => {
    const log: string[] = [];
    const codec = fakeCodec('lazy-codec', {
      codec: 'fake-lazy',
      ensureLoaded: () => {
        log.push('load:lazy-codec');
      },
    });
    codec.supports.mockImplementation((q: CodecQuery): Promise<CodecSupport> => {
      log.push('probe:lazy-codec');
      return Promise.resolve({ supported: q.config.codec === 'fake-lazy' });
    });
    const media = createMedia().use(
      moduleOf(fakeContainer('lazy-mp4', 'video/x-lazy', 'fake-lazy'), codec.driver),
    );

    const frame = await readFirst(media.decode(fromBytes(BYTES, { mime: 'video/x-lazy' })).video);
    (frame as unknown as CountingFrame).close();
    expect(log).toEqual(['load:lazy-codec', 'probe:lazy-codec']);

    // A cached verdict skips the whole walk: no re-load, no re-probe.
    const again = await readFirst(media.decode(fromBytes(BYTES, { mime: 'video/x-lazy' })).video);
    (again as unknown as CountingFrame).close();
    expect(log).toEqual(['load:lazy-codec', 'probe:lazy-codec']);
  });

  it('drivers without the hook route unchanged (the forwarding hook is optional per candidate)', async () => {
    const codec = fakeCodec('eager-codec', { codec: 'fake-eager' });
    const media = createMedia().use(
      moduleOf(fakeContainer('eager-mp4', 'video/x-eager', 'fake-eager'), codec.driver),
    );
    const frame = await readFirst(media.decode(fromBytes(BYTES, { mime: 'video/x-eager' })).video);
    expect(frame).toBeInstanceOf(CountingFrame);
    (frame as unknown as CountingFrame).close();
  });
});

describe('warm decoder pool is capability-driven (R-S05.2)', () => {
  it('seek pools a fake non-first-party driver that advertises supportsWarmDecoderReuse', async () => {
    const codec = fakeCodec('third-party-reuse', {
      codec: 'fake-pool',
      hardwareAccelerated: true,
      warmReuse: true,
    });
    const media = createMedia().use(
      moduleOf(fakeContainer('pool-mp4', 'video/x-pool', 'fake-pool'), codec.driver),
    );

    const borrowsBefore = poolState.borrowConfigs.length;
    const framesBefore = poolState.frames.length;
    const frame = await media.seek(fromBytes(BYTES, { mime: 'video/x-pool' }), 0);

    // The frame came from the warm pool's borrowed decoder, not a fresh driver decoder.
    expect(poolState.borrowConfigs.length).toBe(borrowsBefore + 1);
    expect(codec.decoderConfigs).toHaveLength(0);
    expect(poolState.frames).toHaveLength(framesBefore + 1);
    expect(frame).toBe(poolState.frames[framesBefore] as unknown as VideoFrame);
    // The borrowed decoder was configured with the exact accepted acceleration rung — no re-probe.
    expect(poolState.borrowConfigs[borrowsBefore]).toMatchObject({
      codec: 'fake-pool',
    });
    expect(codec.supports).toHaveBeenCalledTimes(1);

    frame.close();
    expect((frame as unknown as { closeCount: number }).closeCount).toBe(1);

    // dispose() tears the warm pool down (R-S05.4): its hardware session is freed exactly once.
    const disposesBefore = poolState.disposeCount;
    await media.dispose();
    expect(poolState.disposeCount).toBe(disposesBefore + 1);
  });

  it('a driver without the capability seeks through its own fresh decoder — the pool is never consulted', async () => {
    const frames: CountingFrame[] = [];
    const codec = fakeCodec('third-party-fresh', { codec: 'fake-fresh', frames });
    const media = createMedia().use(
      moduleOf(fakeContainer('fresh-mp4', 'video/x-fresh', 'fake-fresh'), codec.driver),
    );

    const borrowsBefore = poolState.borrowConfigs.length;
    const frame = await media.seek(fromBytes(BYTES, { mime: 'video/x-fresh' }), 0);
    expect(poolState.borrowConfigs.length).toBe(borrowsBefore);
    expect(codec.decoderConfigs).toHaveLength(1);
    frame.close();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.closeCount).toBe(1);
  });

  it('supportsWarmDecoderReuse reads only the advertised capability flag', () => {
    const flagged = fakeCodec('flagged', { codec: 'x', warmReuse: true }).driver;
    const bare = fakeCodec('bare', { codec: 'x' }).driver;
    expect(supportsWarmDecoderReuse(flagged)).toBe(true);
    expect(supportsWarmDecoderReuse(bare)).toBe(false);
  });
});
