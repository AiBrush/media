import { describe, expect, it } from 'vitest';
import {
  type CodecDriver,
  type CodecSupport,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type EncodedChunk,
  type FilterDriver,
  type RawFrame,
  type Tier,
} from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { Registry, isApiVersionSupported, supportedApiVersions } from './registry.ts';

function codec(id: string, tier: Tier, apiVersion: number = DRIVER_API_VERSION): CodecDriver {
  return {
    id,
    apiVersion,
    kind: 'codec',
    tier,
    supports: async (): Promise<CodecSupport> => ({ supported: true }),
    createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
}

function container(id: string, apiVersion: number = DRIVER_API_VERSION): ContainerDriver {
  return {
    id,
    apiVersion,
    kind: 'container',
    formats: ['mp4'],
    supports: () => true,
    demux: () => Promise.reject(new Error('unused')),
    createMuxer: () => {
      throw new Error('unused');
    },
  };
}

function filter(id: string): FilterDriver {
  return {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'filter',
    substrate: 'webgpu',
    supports: () => true,
    createFilter: () => new TransformStream<VideoFrame, VideoFrame>(),
  };
}

describe('supportedApiVersions / isApiVersionSupported', () => {
  it('accepts the current and previous contract major', () => {
    expect(supportedApiVersions()).toEqual([1, 0]);
    expect(isApiVersionSupported(1)).toBe(true);
    expect(isApiVersionSupported(0)).toBe(true);
    expect(isApiVersionSupported(2)).toBe(false);
  });
});

describe('Registry', () => {
  it('holds drivers by kind and returns them in insertion order', () => {
    const reg = new Registry();
    reg.addCodec(codec('a', 'wasm'));
    reg.addCodec(codec('b', 'hardware'));
    reg.addContainer(container('mp4'));
    reg.addFilter(filter('gpu'));

    expect(reg.codecs().map((d) => d.id)).toEqual(['a', 'b']);
    expect(reg.containers().map((d) => d.id)).toEqual(['mp4']);
    expect(reg.filters().map((d) => d.id)).toEqual(['gpu']);
  });

  it('is idempotent by id — first registration wins, re-import is a no-op', () => {
    const reg = new Registry();
    reg.addCodec(codec('dup', 'hardware'));
    reg.addCodec(codec('dup', 'wasm'));
    const codecs = reg.codecs();
    expect(codecs).toHaveLength(1);
    expect(codecs[0]?.tier).toBe('hardware');
  });

  it('reports registration via has() for every kind', () => {
    const reg = new Registry();
    const c = codec('x', 'native');
    const ct = container('mp4');
    const f = filter('gpu');
    expect(reg.has(c)).toBe(false);
    reg.addCodec(c);
    reg.addContainer(ct);
    reg.addFilter(f);
    expect(reg.has(c)).toBe(true);
    expect(reg.has(ct)).toBe(true);
    expect(reg.has(f)).toBe(true);
  });

  it('refuses a driver targeting an unsupported apiVersion with a typed error', () => {
    const reg = new Registry();
    try {
      reg.addCodec(codec('future', 'hardware', DRIVER_API_VERSION + 1));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MediaError);
      const err = e as MediaError;
      expect(err.code).toBe('driver-incompatible');
      expect(err.detail).toEqual({ got: 2, supported: [1, 0] });
    }
  });

  it('accepts the previous contract major (N-1)', () => {
    const reg = new Registry();
    expect(() => reg.addContainer(container('legacy', DRIVER_API_VERSION - 1))).not.toThrow();
    expect(reg.containers()).toHaveLength(1);
  });

  it('throws on an unknown driver kind queried via has()', () => {
    const reg = new Registry();
    expect(() => reg.has({ id: 'z', apiVersion: 1, kind: 'bogus' })).toThrowError(MediaError);
  });
});
