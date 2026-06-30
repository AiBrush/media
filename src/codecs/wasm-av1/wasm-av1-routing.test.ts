import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDefaultDrivers } from '../../drivers/defaults.ts';
import { Registry } from '../../kernel/registry.ts';
import { Router } from '../../kernel/router.ts';
import { resetAv1CoreForTest } from './wasm-av1-driver.ts';

const AV1_DECODE_QUERY = {
  mediaType: 'video',
  direction: 'decode',
  config: { codec: 'av01.0.04M.08', codedWidth: 320, codedHeight: 240 },
} as const;

interface InstalledBrowserVideoSeam {
  readonly isConfigSupported: ReturnType<typeof vi.fn>;
  restore(): void;
}

function setGlobal<K extends keyof typeof globalThis>(key: K, value: (typeof globalThis)[K]): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobal<K extends keyof typeof globalThis>(
  key: K,
  value: (typeof globalThis)[K] | undefined,
): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }
  setGlobal(key, value);
}

function installBrowserVideoSeam(webCodecsSupportsAv1: boolean): InstalledBrowserVideoSeam {
  const originalVideoDecoder = globalThis.VideoDecoder;
  const originalVideoFrame = globalThis.VideoFrame;
  const originalEncodedVideoChunk = globalThis.EncodedVideoChunk;

  const isConfigSupported = vi.fn(
    async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
      supported: webCodecsSupportsAv1,
      config,
    }),
  );

  const Session8FakeVideoDecoder = Object.assign(function Session8FakeVideoDecoder(): void {}, {
    isConfigSupported,
  });
  class Session8FakeVideoFrame {
    close(): void {}
  }
  class Session8FakeEncodedVideoChunk {}

  setGlobal('VideoDecoder', Session8FakeVideoDecoder as unknown as typeof VideoDecoder);
  setGlobal('VideoFrame', Session8FakeVideoFrame as unknown as typeof VideoFrame);
  setGlobal(
    'EncodedVideoChunk',
    Session8FakeEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
  );

  return {
    isConfigSupported,
    restore(): void {
      restoreGlobal('VideoDecoder', originalVideoDecoder);
      restoreGlobal('VideoFrame', originalVideoFrame);
      restoreGlobal('EncodedVideoChunk', originalEncodedVideoChunk);
    },
  };
}

function installNoWasmInstantiationTrap(): {
  readonly fetch: ReturnType<typeof vi.fn>;
  restore(): void;
} {
  const originalFetch = globalThis.fetch;
  const fetch = vi.fn(async (): Promise<Response> => {
    throw new Error('AV1 support probing must not fetch the dav1d wasm');
  });
  const instantiate = vi.spyOn(WebAssembly, 'instantiate');
  instantiate.mockImplementation((() => {
    throw new Error('AV1 support probing must not instantiate the dav1d wasm');
  }) as typeof WebAssembly.instantiate);

  setGlobal('fetch', fetch as unknown as typeof globalThis.fetch);

  return {
    fetch,
    restore(): void {
      restoreGlobal('fetch', originalFetch);
      instantiate.mockRestore();
    },
  };
}

function defaultCodecRouter(): Router {
  const registry = new Registry();
  registerDefaultDrivers(registry);
  return new Router({ registry });
}

describe('wasm-av1 default routing', () => {
  afterEach(() => {
    resetAv1CoreForTest();
    vi.restoreAllMocks();
  });

  it('keeps dav1d miss-only when WebCodecs accepts the exact AV1 decode config', async () => {
    const browser = installBrowserVideoSeam(true);
    const wasmTrap = installNoWasmInstantiationTrap();
    try {
      const picked = await defaultCodecRouter().pickCodec(AV1_DECODE_QUERY);

      expect(picked.id).toBe('webcodecs-video');
      expect(browser.isConfigSupported).toHaveBeenCalledTimes(1);
      expect(wasmTrap.fetch).not.toHaveBeenCalled();
      expect(WebAssembly.instantiate).not.toHaveBeenCalled();
    } finally {
      wasmTrap.restore();
      browser.restore();
    }
  });

  it('falls through to dav1d when WebCodecs lacks AV1 without instantiating wasm during support probing', async () => {
    const browser = installBrowserVideoSeam(false);
    const wasmTrap = installNoWasmInstantiationTrap();
    try {
      const picked = await defaultCodecRouter().pickCodec(AV1_DECODE_QUERY);

      expect(picked.id).toBe('wasm-av1');
      expect(browser.isConfigSupported).toHaveBeenCalledTimes(2);
      expect(wasmTrap.fetch).not.toHaveBeenCalled();
      expect(WebAssembly.instantiate).not.toHaveBeenCalled();
    } finally {
      wasmTrap.restore();
      browser.restore();
    }
  });

  it('routes force-software AV1 decode directly to dav1d and still performs probe-only zero wasm', async () => {
    const browser = installBrowserVideoSeam(true);
    const wasmTrap = installNoWasmInstantiationTrap();
    try {
      const picked = await defaultCodecRouter().pickCodec(AV1_DECODE_QUERY, {
        determinism: 'force-software',
      });

      expect(picked.id).toBe('wasm-av1');
      expect(browser.isConfigSupported).not.toHaveBeenCalled();
      expect(wasmTrap.fetch).not.toHaveBeenCalled();
      expect(WebAssembly.instantiate).not.toHaveBeenCalled();
    } finally {
      wasmTrap.restore();
      browser.restore();
    }
  });
});
