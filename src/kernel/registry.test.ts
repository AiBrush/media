import { describe, expect, it } from 'vitest';
import { imageOps } from '../codecs/image/image-driver.ts';
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
  it('accepts only real contract majors — never the phantom major 0', () => {
    expect(supportedApiVersions()).toEqual([1]);
    expect(isApiVersionSupported(1)).toBe(true);
    expect(isApiVersionSupported(0)).toBe(false);
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

  it('holds image ops idempotently outside the container/codec/filter driver maps', () => {
    const reg = new Registry();
    expect(reg.imageOps()).toBeUndefined();
    reg.addImageOps(imageOps);
    reg.addImageOps({
      ...imageOps,
      formats: ['png'] as const,
    });
    expect(reg.imageOps()).toBe(imageOps);
    expect(reg.codecs()).toEqual([]);
    expect(reg.containers()).toEqual([]);
    expect(reg.filters()).toEqual([]);
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
      expect(err.detail).toEqual({ got: 2, supported: [1] });
    }
  });

  it('refuses the phantom previous major 0 (no real contract ever carried it)', () => {
    const reg = new Registry();
    expect(() => reg.addContainer(container('legacy', DRIVER_API_VERSION - 1))).toThrowError(
      MediaError,
    );
    expect(reg.containers()).toHaveLength(0);
  });

  it('throws on an unknown driver kind queried via has()', () => {
    const reg = new Registry();
    expect(() => reg.has({ id: 'z', apiVersion: 1, kind: 'bogus' })).toThrowError(MediaError);
  });

  it('refuses a driver advertising a capability its surface does not implement', () => {
    const reg = new Registry();
    const dishonest: ContainerDriver = {
      ...container('mp4'),
      capabilities: ['streamCopy'],
    };
    try {
      reg.addContainer(dishonest);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MediaError);
      expect((e as MediaError).code).toBe('driver-incompatible');
    }
    expect(reg.containers()).toHaveLength(0);
  });

  it('accepts an honest capabilities advertisement (methods and boolean flags)', () => {
    const reg = new Registry();
    const honest: ContainerDriver = {
      ...container('mp4'),
      capabilities: ['streamCopy', 'validatesStreamCopyTrim'],
      streamCopy: () => Promise.reject(new Error('unused')),
      validatesStreamCopyTrim: true,
    };
    reg.addContainer(honest);
    expect(reg.containers().map((d) => d.id)).toEqual(['mp4']);
  });

  it('replaces a registered container when a same-id driver is strictly more capable', () => {
    const reg = new Registry();
    const muxOnly = container('mp4');
    const full: ContainerDriver = {
      ...container('mp4'),
      probe: () => Promise.resolve([]),
      packetInfo: () => Promise.reject(new Error('unused')),
      streamCopy: () => Promise.reject(new Error('unused')),
    };
    reg.addContainer(muxOnly);
    reg.addContainer(full);
    const survivor = reg.containers();
    expect(survivor).toHaveLength(1);
    expect(survivor[0]).toBe(full);
    expect(typeof survivor[0]?.probe).toBe('function');
  });

  it('keeps the wider surface when a narrower same-id driver registers second', () => {
    const reg = new Registry();
    const full: ContainerDriver = {
      ...container('mp4'),
      probe: () => Promise.resolve([]),
      streamCopy: () => Promise.reject(new Error('unused')),
    };
    const muxOnly = container('mp4');
    reg.addContainer(full);
    reg.addContainer(muxOnly);
    const survivor = reg.containers();
    expect(survivor).toHaveLength(1);
    expect(survivor[0]).toBe(full);
  });

  it('keeps first-wins for a same-id driver whose surface is merely different, not wider', () => {
    const reg = new Registry();
    const probeOnly: ContainerDriver = { ...container('mp4'), probe: () => Promise.resolve([]) };
    const copyOnly: ContainerDriver = {
      ...container('mp4'),
      streamCopy: () => Promise.reject(new Error('unused')),
    };
    reg.addContainer(probeOnly);
    reg.addContainer(copyOnly);
    expect(reg.containers()[0]).toBe(probeOnly);
  });

  it('never loses demux across the real mux-only/full MP4 module pair', async () => {
    const [{ default: muxOnlyModule }, { Mp4Module }] = await Promise.all([
      import('../drivers/mp4/mp4-mux-driver.ts'),
      import('../drivers/mp4/mp4-driver.ts'),
    ]);
    const reg = new Registry();
    muxOnlyModule.register(reg);
    Mp4Module.register(reg);
    const demuxQuery = {
      direction: 'demux',
      head: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    } as const;
    const demuxCapable = reg.containers().find((d) => d.supports(demuxQuery));
    expect(demuxCapable?.id).toBe('mp4');
  });
});
