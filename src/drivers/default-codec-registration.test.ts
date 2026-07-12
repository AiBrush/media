import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  DecoderConfig,
  EncodedChunk,
  EncoderConfig,
  RawFrame,
} from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { Registry } from '../kernel/registry.ts';
import { Router, type StageSelectOptions } from '../kernel/router.ts';
import {
  pickCodecWithDefaultFallback,
  registerDefaultCodecForQuery,
} from './default-codec-registration.ts';

const aacDecode: CodecQuery = {
  mediaType: 'audio',
  direction: 'decode',
  config: {
    codec: 'mp4a.40.2',
    sampleRate: 48_000,
    numberOfChannels: 2,
    description: new Uint8Array([0x11, 0x90]),
  },
};

const opusEncode: CodecQuery = {
  mediaType: 'audio',
  direction: 'encode',
  config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
};

const originalAudioDecoder = globalThis.AudioDecoder;
const originalAudioEncoder = globalThis.AudioEncoder;

afterEach(() => {
  restoreGlobal('AudioDecoder', originalAudioDecoder);
  restoreGlobal('AudioEncoder', originalAudioEncoder);
});

function restoreGlobal<K extends 'AudioDecoder' | 'AudioEncoder'>(
  key: K,
  value: (typeof globalThis)[K] | undefined,
): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

function stubNativeAudioSupport(
  direction: CodecQuery['direction'],
  answer: 'supported' | 'unsupported' | 'throw',
): ReturnType<typeof vi.fn> {
  const probe = vi.fn(async (config: DecoderConfig | EncoderConfig) => {
    if (answer === 'throw') throw new DOMException('native probe rejected', 'NotSupportedError');
    return { supported: answer === 'supported', config };
  });
  Object.defineProperty(globalThis, direction === 'decode' ? 'AudioDecoder' : 'AudioEncoder', {
    configurable: true,
    writable: true,
    value: { isConfigSupported: probe },
  });
  return probe;
}

function fakeCodec(
  id: string,
  mediaType: CodecQuery['mediaType'] = 'audio',
  support: CodecSupport = { supported: true, hardwareAccelerated: false },
): CodecDriver {
  return {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'wasm',
    supports: (query) =>
      Promise.resolve(query.mediaType === mediaType ? support : { supported: false }),
    createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
}

async function pick(
  query: CodecQuery,
  options: StageSelectOptions,
  registerAll: (registry: Registry) => void,
): Promise<{
  readonly driver: CodecDriver;
  readonly registry: Registry;
  readonly registerAllCalls: number;
}> {
  const registry = new Registry();
  const router = new Router({ registry });
  let registerAllCalls = 0;
  const driver = await pickCodecWithDefaultFallback(registry, router, query, options, async () => {
    registerAllCalls++;
    registerAll(registry);
    router.clearCache();
  });
  return { driver, registry, registerAllCalls };
}

describe('query-selective default native codec registration', () => {
  it.each([
    ['mp4a.40.2', 'decode'],
    ['opus', 'encode'],
    ['mp3', 'decode'],
    ['flac', 'decode'],
    ['vorbis', 'decode'],
  ] as const)('registers only WebCodecs audio for %s %s', async (codec, direction) => {
    const registry = new Registry();
    await expect(
      registerDefaultCodecForQuery(
        registry,
        {
          mediaType: 'audio',
          direction,
          config: { codec, sampleRate: 48_000, numberOfChannels: 2 },
        },
        { determinism: 'auto' },
      ),
    ).resolves.toBe(true);
    expect(registry.codecs().map((driver) => driver.id)).toEqual(['webcodecs-audio']);
    expect(registry.containers()).toHaveLength(0);
    expect(registry.filters()).toHaveLength(0);
    expect(registry.imageOps()).toBeUndefined();
  });

  it('keeps a supported native AAC query off the register-all fallback', async () => {
    const probe = stubNativeAudioSupport('decode', 'supported');
    const result = await pick(aacDecode, { determinism: 'auto' }, (registry) => {
      registry.addCodec(fakeCodec('wasm-aac'));
    });
    expect(result.driver.id).toBe('webcodecs-audio');
    expect(result.registerAllCalls).toBe(0);
    expect(result.registry.codecs().map((driver) => driver.id)).toEqual(['webcodecs-audio']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each(['unsupported', 'throw'] as const)(
    'loads the complete fallback after native support reports %s',
    async (answer) => {
      stubNativeAudioSupport('decode', answer);
      const result = await pick(aacDecode, { determinism: 'auto' }, (registry) => {
        registry.addCodec(fakeCodec('wasm-aac'));
      });
      expect(result.driver.id).toBe('wasm-aac');
      expect(result.registerAllCalls).toBe(1);
      expect(result.registry.codecs().map((driver) => driver.id)).toEqual([
        'webcodecs-audio',
        'wasm-aac',
      ]);
    },
  );

  it('loads the complete software ladder without selectively probing native in force-software', async () => {
    const probe = stubNativeAudioSupport('decode', 'supported');
    const result = await pick(aacDecode, { determinism: 'force-software' }, (registry) => {
      registry.addCodec(fakeCodec('wasm-aac'));
    });
    expect(result.driver.id).toBe('wasm-aac');
    expect(result.registerAllCalls).toBe(1);
    expect(result.registry.codecs().map((driver) => driver.id)).toEqual(['wasm-aac']);
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps an explicit native pin selective and an explicit non-native pin on register-all', async () => {
    stubNativeAudioSupport('decode', 'supported');
    const native = await pick(
      aacDecode,
      { determinism: 'auto', pinDriver: 'webcodecs-audio' },
      (registry) => registry.addCodec(fakeCodec('wasm-aac')),
    );
    expect(native.driver.id).toBe('webcodecs-audio');
    expect(native.registerAllCalls).toBe(0);

    const software = await pick(
      aacDecode,
      { determinism: 'auto', pinDriver: 'wasm-aac' },
      (registry) => registry.addCodec(fakeCodec('wasm-aac')),
    );
    expect(software.driver.id).toBe('wasm-aac');
    expect(software.registerAllCalls).toBe(1);
    expect(software.registry.codecs().map((driver) => driver.id)).toEqual(['wasm-aac']);
  });

  it('declines unknown audio and video queries without a selective registry mutation', async () => {
    for (const query of [
      { ...opusEncode, config: { ...opusEncode.config, codec: 'unknown-audio' } },
      {
        mediaType: 'video' as const,
        direction: 'decode' as const,
        config: { codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 180 },
      },
    ]) {
      const registry = new Registry();
      await expect(
        registerDefaultCodecForQuery(registry, query, { determinism: 'auto' }),
      ).resolves.toBe(false);
      expect(registry.codecs()).toHaveLength(0);
    }
  });

  it('is idempotent across concurrent registration and preserves a later unrelated full fallback', async () => {
    const registry = new Registry();
    const router = new Router({ registry });
    stubNativeAudioSupport('encode', 'supported');
    await Promise.all([
      registerDefaultCodecForQuery(registry, opusEncode, { determinism: 'auto' }),
      registerDefaultCodecForQuery(registry, opusEncode, { determinism: 'auto' }),
      registerDefaultCodecForQuery(registry, opusEncode, { determinism: 'auto' }),
    ]);
    expect(registry.codecs().map((driver) => driver.id)).toEqual(['webcodecs-audio']);

    const videoQuery: CodecQuery = {
      mediaType: 'video',
      direction: 'decode',
      config: { codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 180 },
    };
    let fullLoads = 0;
    const selected = await pickCodecWithDefaultFallback(
      registry,
      router,
      videoQuery,
      { determinism: 'auto' },
      async () => {
        fullLoads++;
        registry.addCodec(fakeCodec('wasm-vpx', 'video'));
        router.clearCache();
      },
    );
    expect(selected.id).toBe('wasm-vpx');
    expect(fullLoads).toBe(1);
    expect(registry.codecs().map((driver) => driver.id)).toEqual(['webcodecs-audio', 'wasm-vpx']);
  });
});
