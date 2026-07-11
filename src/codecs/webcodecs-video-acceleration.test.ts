/**
 * Exact-config handoff tests for WebCodecs video acceleration selection. Pure selection uses injected
 * probes; startup tests install a control-queue-only VideoDecoder double (no coded bytes or fake pixels)
 * to prove configure-barrier, fallback, and cancellation ordering. Real decoding remains browser-owned.
 */

import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { EncodedChunk } from '../contracts/driver.ts';
import {
  WebcodecsVideoDriver,
  createVideoDecoderAccelerationCache,
  forgetVideoDecoderAcceleration,
  immediateVideoDecoderAcceleration,
  recallVideoDecoderAcceleration,
  rememberVideoDecoderAcceleration,
  resolveVideoDecoderAcceleration,
  videoDecoderCapabilityKey,
} from './webcodecs-video.ts';

function vp9Config(
  description: AllowSharedBufferSource = new Uint8Array([1, 2, 3, 4]),
): VideoDecoderConfig {
  return {
    codec: 'vp09.00.10.08',
    codedWidth: 640,
    codedHeight: 360,
    displayAspectWidth: 640,
    displayAspectHeight: 360,
    description,
    colorSpace: {
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
      fullRange: false,
    },
  };
}

describe('videoDecoderCapabilityKey — exact structural capability identity', () => {
  it('matches independently allocated equal configs, including equal description bytes', () => {
    expect(videoDecoderCapabilityKey(vp9Config())).toBe(videoDecoderCapabilityKey(vp9Config()));
  });

  it('separates description, geometry, colour, and effective alpha changes', () => {
    const base = vp9Config();
    expect(videoDecoderCapabilityKey(vp9Config(new Uint8Array([1, 2, 3, 5])))).not.toBe(
      videoDecoderCapabilityKey(base),
    );
    expect(videoDecoderCapabilityKey({ ...base, codedWidth: 1280 })).not.toBe(
      videoDecoderCapabilityKey(base),
    );
    expect(
      videoDecoderCapabilityKey({
        ...base,
        colorSpace: { ...base.colorSpace, fullRange: true },
      }),
    ).not.toBe(videoDecoderCapabilityKey(base));
    expect(videoDecoderCapabilityKey(base, 'discard')).not.toBe(
      videoDecoderCapabilityKey(base, 'keep'),
    );
  });

  it('ignores only the acceleration hint and never mutates the caller config or description', () => {
    const description = new Uint8Array([9, 8, 7, 6]);
    const config = vp9Config(description);
    const before = [...description];
    const noPreference = videoDecoderCapabilityKey({
      ...config,
      hardwareAcceleration: 'no-preference',
    });
    const hardware = videoDecoderCapabilityKey({
      ...config,
      hardwareAcceleration: 'prefer-hardware',
    });
    expect(hardware).toBe(noPreference);
    expect(config.hardwareAcceleration).toBeUndefined();
    expect([...description]).toEqual(before);
  });

  it('reuses a verdict for a later equal config after a router-level driver cache hit', () => {
    const cache = createVideoDecoderAccelerationCache(2);
    cache.set(vp9Config(), undefined, 'prefer-hardware');
    expect(cache.get(vp9Config(), undefined)).toBe('prefer-hardware');
    expect(cache.get(vp9Config(new Uint8Array([1, 2, 3, 5])), undefined)).toBeUndefined();
  });

  it('byte-distinguishes direct SharedArrayBuffer descriptions', () => {
    const first = new SharedArrayBuffer(4);
    const second = new SharedArrayBuffer(4);
    new Uint8Array(first).set([1, 2, 3, 4]);
    new Uint8Array(second).set([1, 2, 3, 5]);

    expect(videoDecoderCapabilityKey(vp9Config(first))).not.toBe(
      videoDecoderCapabilityKey(vp9Config(second)),
    );
  });

  it('byte-distinguishes direct cross-realm ArrayBuffer descriptions', () => {
    const first = runInNewContext('Uint8Array.from([1, 2, 3, 4]).buffer') as ArrayBuffer;
    const second = runInNewContext('Uint8Array.from([1, 2, 3, 5]).buffer') as ArrayBuffer;
    expect(first instanceof ArrayBuffer).toBe(false);

    expect(videoDecoderCapabilityKey(vp9Config(first))).not.toBe(
      videoDecoderCapabilityKey(vp9Config(second)),
    );
  });

  it('treats an unsupported vendor object as uncacheable instead of collapsing its identity', () => {
    const cache = createVideoDecoderAccelerationCache();
    const config = vp9Config() as VideoDecoderConfig & { extension?: unknown };
    config.extension = new Date(0);

    expect(rememberVideoDecoderAcceleration(cache, config, undefined, 'prefer-hardware')).toBe(
      false,
    );
    expect(recallVideoDecoderAcceleration(cache, config, undefined)).toBeUndefined();
  });

  it('treats an invalid cyclic extension as an uncacheable miss, then runs the exact probe', async () => {
    const cache = createVideoDecoderAccelerationCache();
    const config = vp9Config() as VideoDecoderConfig & { extension?: unknown };
    config.extension = config;
    expect(() =>
      rememberVideoDecoderAcceleration(cache, config, undefined, 'prefer-hardware'),
    ).not.toThrow();
    expect(rememberVideoDecoderAcceleration(cache, config, undefined, 'prefer-hardware')).toBe(
      false,
    );
    expect(recallVideoDecoderAcceleration(cache, config, undefined)).toBeUndefined();
    expect(() => forgetVideoDecoderAcceleration(cache, config, undefined)).not.toThrow();
    const probe = vi.fn(async (acceleration: HardwareAcceleration) => ({
      supported: true,
      acceptedAcceleration: acceleration,
    }));
    await expect(
      resolveVideoDecoderAcceleration(
        'auto',
        recallVideoDecoderAcceleration(cache, config, undefined),
        probe,
      ),
    ).resolves.toBe('prefer-hardware');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('resolveVideoDecoderAcceleration — hardware-first with an honest software fallback', () => {
  it('uses the accepted hardware config and stops after the first successful probe', async () => {
    const probe = vi.fn(async (acceleration: HardwareAcceleration) => ({
      supported: true,
      acceptedAcceleration: acceleration,
    }));
    await expect(resolveVideoDecoderAcceleration('auto', undefined, probe)).resolves.toBe(
      'prefer-hardware',
    );
    expect(probe.mock.calls.map(([acceleration]) => acceleration)).toEqual(['prefer-hardware']);
  });

  it('falls back to the accepted no-preference config when hardware is rejected', async () => {
    const probe = vi.fn(async (acceleration: HardwareAcceleration) => ({
      supported: acceleration === 'no-preference',
      acceptedAcceleration: acceleration,
    }));
    await expect(resolveVideoDecoderAcceleration('auto', undefined, probe)).resolves.toBe(
      'no-preference',
    );
    expect(probe.mock.calls.map(([acceleration]) => acceleration)).toEqual([
      'prefer-hardware',
      'no-preference',
    ]);
  });

  it('continues to no-preference after a hardware capability rejection', async () => {
    const probe = vi.fn(async (acceleration: HardwareAcceleration) => {
      if (acceleration === 'prefer-hardware')
        throw new DOMException('rejected', 'NotSupportedError');
      return { supported: true, acceptedAcceleration: acceleration };
    });
    await expect(resolveVideoDecoderAcceleration('auto', undefined, probe)).resolves.toBe(
      'no-preference',
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('honours the UA-returned accepted hint instead of assuming the requested hint won', async () => {
    const probe = vi.fn(async () => ({
      supported: true,
      acceptedAcceleration: 'no-preference' as const,
    }));
    await expect(resolveVideoDecoderAcceleration('auto', undefined, probe)).resolves.toBe(
      'no-preference',
    );
  });

  it('reuses an exact-config verdict synchronously and force-software overrides cached hardware', async () => {
    const probe = vi.fn(async () => ({ supported: false }));
    expect(immediateVideoDecoderAcceleration('auto', 'prefer-hardware')).toBe('prefer-hardware');
    expect(immediateVideoDecoderAcceleration('force-software', 'prefer-hardware')).toBe(
      'prefer-software',
    );
    await expect(resolveVideoDecoderAcceleration('auto', 'prefer-hardware', probe)).resolves.toBe(
      'prefer-hardware',
    );
    await expect(
      resolveVideoDecoderAcceleration('force-software', 'prefer-hardware', probe),
    ).resolves.toBe('prefer-software');
    expect(probe).not.toHaveBeenCalled();
  });

  it('returns no selection when both exact capability probes reject support', async () => {
    const probe = vi.fn(async () => ({ supported: false }));
    await expect(
      resolveVideoDecoderAcceleration('auto', undefined, probe),
    ).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not launch the software probe after cancellation settles a rejected hardware probe', async () => {
    let release = (): void => {
      throw new Error('probe gate was not initialized');
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let live = true;
    const probe = vi.fn(async () => {
      await gate;
      throw new DOMException('hardware probe rejected', 'NotSupportedError');
    });
    const pending = resolveVideoDecoderAcceleration('auto', undefined, probe, () => live);
    live = false;
    release();
    await expect(pending).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not configure after abort wins a supported capability-probe race', async () => {
    let release = (): void => {
      throw new Error('probe gate was not initialized');
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let live = true;
    let configured = 0;
    const pending = resolveVideoDecoderAcceleration(
      'auto',
      undefined,
      async () => {
        await gate;
        return { supported: true, acceptedAcceleration: 'prefer-hardware' };
      },
      () => live,
    );
    live = false;
    release();
    const acceleration = await pending;
    if (live && acceleration !== undefined) configured++;
    expect(acceleration).toBe('prefer-hardware');
    expect(configured).toBe(0);
  });
});

function restoreGlobalProperty(
  key: 'VideoDecoder' | 'EncodedVideoChunk',
  prior: PropertyDescriptor | undefined,
): void {
  if (prior === undefined) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }
  Object.defineProperty(globalThis, key, prior);
}

describe('WebCodecs decoder startup — configuration is proven before packet submission', () => {
  it('falls back from a stale cached hardware decoder through an empty-flush barrier before decode()', async () => {
    const priorDecoder = Object.getOwnPropertyDescriptor(globalThis, 'VideoDecoder');
    const priorChunk = Object.getOwnPropertyDescriptor(globalThis, 'EncodedVideoChunk');
    const configureAccelerations: HardwareAcceleration[] = [];
    const decodedAccelerations: HardwareAcceleration[] = [];
    let hardwareSupported = true;
    let probeCalls = 0;

    class TestEncodedVideoChunk {}
    class BarrierVideoDecoder extends EventTarget {
      static isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
        probeCalls++;
        const supported = config.hardwareAcceleration !== 'prefer-hardware' || hardwareSupported;
        return Promise.resolve({ supported, config });
      }

      readonly #init: VideoDecoderInit;
      #acceleration: HardwareAcceleration = 'no-preference';
      state: CodecState = 'unconfigured';
      decodeQueueSize = 0;

      constructor(init: VideoDecoderInit) {
        super();
        this.#init = init;
      }

      configure(config: VideoDecoderConfig): void {
        this.state = 'configured';
        this.#acceleration = config.hardwareAcceleration ?? 'no-preference';
        configureAccelerations.push(this.#acceleration);
      }

      decode(_chunk: EncodedVideoChunk): void {
        decodedAccelerations.push(this.#acceleration);
      }

      flush(): Promise<void> {
        if (this.#acceleration !== 'prefer-hardware' || hardwareSupported) {
          return Promise.resolve();
        }
        return Promise.resolve().then(() => {
          const error = new DOMException('stale hardware decoder', 'NotSupportedError');
          this.state = 'closed';
          this.#init.error(error);
          throw error;
        });
      }

      close(): void {
        this.state = 'closed';
      }
    }

    Object.defineProperty(globalThis, 'VideoDecoder', {
      configurable: true,
      value: BarrierVideoDecoder as unknown as typeof VideoDecoder,
    });
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: TestEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
    });
    try {
      const config: VideoDecoderConfig = {
        codec: 'avc1.42001e',
        codedWidth: 16,
        codedHeight: 16,
        description: new Uint8Array([203, 1, 2, 3]),
      };
      await expect(
        WebcodecsVideoDriver.supports({ mediaType: 'video', direction: 'decode', config }),
      ).resolves.toMatchObject({ supported: true, hardwareAccelerated: true });
      hardwareSupported = false;

      const stream = WebcodecsVideoDriver.createDecoder(config);
      const writer = stream.writable.getWriter();
      await writer.write(new TestEncodedVideoChunk() as unknown as EncodedVideoChunk);
      await writer.close();
      await expect(stream.readable.getReader().read()).resolves.toEqual({
        done: true,
        value: undefined,
      });

      expect(probeCalls).toBe(2);
      expect(configureAccelerations).toEqual(['prefer-hardware', 'no-preference']);
      expect(decodedAccelerations).toEqual(['no-preference']);
    } finally {
      restoreGlobalProperty('EncodedVideoChunk', priorChunk);
      restoreGlobalProperty('VideoDecoder', priorDecoder);
    }
  });
});

type StartupCancellationMode = 'readable-cancel' | 'external-abort';

async function expectPromptStartupCancellation(mode: StartupCancellationMode): Promise<void> {
  const priorDecoder = Object.getOwnPropertyDescriptor(globalThis, 'VideoDecoder');
  const priorChunk = Object.getOwnPropertyDescriptor(globalThis, 'EncodedVideoChunk');
  const abort = new AbortController();
  let configureCalls = 0;
  let releaseProbe = (): void => {
    throw new Error('startup probe did not begin');
  };
  let markProbeStarted = (): void => {
    throw new Error('startup probe start gate was not initialized');
  };
  const probeStarted = new Promise<void>((resolve) => {
    markProbeStarted = resolve;
  });

  class TestEncodedVideoChunk {}
  class PendingProbeVideoDecoder extends EventTarget {
    static isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
      markProbeStarted();
      return new Promise<VideoDecoderSupport>((resolve) => {
        releaseProbe = () => resolve({ supported: true, config });
      });
    }

    state: CodecState = 'unconfigured';
    decodeQueueSize = 0;

    constructor(_init: VideoDecoderInit) {
      super();
    }

    configure(_config: VideoDecoderConfig): void {
      configureCalls++;
      this.state = 'configured';
    }

    decode(_chunk: EncodedVideoChunk): void {}

    flush(): Promise<void> {
      return Promise.resolve();
    }

    close(): void {
      this.state = 'closed';
    }
  }

  Object.defineProperty(globalThis, 'VideoDecoder', {
    configurable: true,
    value: PendingProbeVideoDecoder as unknown as typeof VideoDecoder,
  });
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: TestEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
  });
  let writer: WritableStreamDefaultWriter<EncodedChunk> | undefined;
  try {
    const config: VideoDecoderConfig = {
      codec: 'avc1.42001e',
      codedWidth: 17,
      codedHeight: 16,
      description: new Uint8Array([mode === 'readable-cancel' ? 204 : 205, 1, 2, 3]),
    };
    const stream = WebcodecsVideoDriver.createDecoder(config, {
      ...(mode === 'external-abort' ? { signal: abort.signal } : {}),
    });
    writer = stream.writable.getWriter();
    const write = writer.write(new TestEncodedVideoChunk() as unknown as EncodedVideoChunk);
    await probeStarted;
    const reason = new Error(`cancel ${mode}`);
    if (mode === 'external-abort') {
      abort.abort(reason);
    } else {
      await stream.readable.cancel(reason);
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      write.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), 100);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    expect(outcome).toBe('rejected');
    expect(configureCalls).toBe(0);

    releaseProbe();
    await Promise.resolve();
    await Promise.resolve();
    expect(configureCalls).toBe(0);
  } finally {
    releaseProbe();
    await writer?.abort().catch(() => undefined);
    restoreGlobalProperty('EncodedVideoChunk', priorChunk);
    restoreGlobalProperty('VideoDecoder', priorDecoder);
  }
}

describe('WebCodecs decoder startup — cancellation races probes promptly', () => {
  it('settles a pending start on readable cancellation and ignores the late probe', async () => {
    await expectPromptStartupCancellation('readable-cancel');
  });

  it('settles a pending start on external abort and ignores the late probe', async () => {
    await expectPromptStartupCancellation('external-abort');
  });
});
