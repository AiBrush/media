import { describe, expect, it, vi } from 'vitest';
import {
  type CodecDriver,
  type CodecQuery,
  type CodecSupport,
  type ContainerDriver,
  type ContainerQuery,
  DRIVER_API_VERSION,
  type EncodedChunk,
  type FilterDriver,
  type FilterSpec,
  type FilterSubstrate,
  type RawFrame,
  type Tier,
} from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { Registry } from './registry.ts';
import { Router } from './router.ts';

const decodeQuery: CodecQuery = {
  mediaType: 'video',
  direction: 'decode',
  config: { codec: 'avc1.42001f' },
};
const demuxQuery: ContainerQuery = { direction: 'demux', mime: 'video/mp4' };
const resizeSpec: FilterSpec = { mediaType: 'video', type: 'resize', width: 1280, height: 720 };

function makeCodec(id: string, tier: Tier, supported: boolean) {
  const supports = vi.fn(async (): Promise<CodecSupport> => ({ supported }));
  const driver: CodecDriver = {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier,
    supports,
    createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
  return { driver, supports };
}

function makeContainer(id: string, supported: boolean) {
  const supports = vi.fn((_q: ContainerQuery): boolean => supported);
  const driver: ContainerDriver = {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports,
    demux: () => Promise.reject(new Error('unused')),
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  return { driver, supports };
}

function makeFilter(id: string, substrate: FilterSubstrate, supported: boolean) {
  const supports = vi.fn((_f: FilterSpec): boolean => supported);
  const driver: FilterDriver = {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'filter',
    substrate,
    supports,
    createFilter: () => new TransformStream<VideoFrame, VideoFrame>(),
  };
  return { driver, supports };
}

function routerWith(register: (reg: Registry) => void, ensureLoaded = vi.fn()) {
  const reg = new Registry();
  register(reg);
  return { router: new Router({ registry: reg, ensureLoaded }), ensureLoaded };
}

describe('Router.pickCodec', () => {
  it('walks the tier ladder best-first (hardware over wasm)', async () => {
    const { router, ensureLoaded } = routerWith((reg) => {
      reg.addCodec(makeCodec('wasm', 'wasm', true).driver);
      reg.addCodec(makeCodec('hw', 'hardware', true).driver);
    });
    const picked = await router.pickCodec(decodeQuery);
    expect(picked.id).toBe('hw');
    // ensureLoaded ran for the chosen driver before it was built.
    expect(ensureLoaded).toHaveBeenCalledWith(picked);
  });

  it('drops hardware/gpu under force-software', async () => {
    const { router } = routerWith((reg) => {
      reg.addCodec(makeCodec('hw', 'hardware', true).driver);
      reg.addCodec(makeCodec('wasm', 'wasm', true).driver);
    });
    expect((await router.pickCodec(decodeQuery, { determinism: 'force-software' })).id).toBe(
      'wasm',
    );
  });

  it('skips a driver that reports unsupported', async () => {
    const { router } = routerWith((reg) => {
      reg.addCodec(makeCodec('hw', 'hardware', false).driver);
      reg.addCodec(makeCodec('wasm', 'wasm', true).driver);
    });
    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');
  });

  it('throws a typed CapabilityError naming what was tried on a miss', async () => {
    const { router } = routerWith((reg) => {
      reg.addCodec(makeCodec('hw', 'hardware', false).driver);
      reg.addCodec(makeCodec('wasm', 'wasm', false).driver);
    });
    await expect(router.pickCodec(decodeQuery)).rejects.toMatchObject({
      name: 'CapabilityError',
      code: 'capability-miss',
      detail: { tried: ['hw', 'wasm'] },
    });
    await expect(router.pickCodec(decodeQuery)).rejects.toBeInstanceOf(CapabilityError);
  });

  it('caches a positive verdict and re-probes only on a different determinism key', async () => {
    const { driver, supports } = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => reg.addCodec(driver));

    await router.pickCodec(decodeQuery);
    await router.pickCodec(decodeQuery);
    expect(supports).toHaveBeenCalledTimes(1); // second call served from cache

    await router.pickCodec(decodeQuery, { determinism: 'force-software' });
    expect(supports).toHaveBeenCalledTimes(2); // distinct key → re-probe

    router.clearCache();
    await router.pickCodec(decodeQuery);
    expect(supports).toHaveBeenCalledTimes(3); // cache cleared → re-probe
  });
});

describe('Router.pickContainer', () => {
  it('selects the first registered driver that supports the query', () => {
    const { router } = routerWith((reg) => {
      reg.addContainer(makeContainer('no', false).driver);
      reg.addContainer(makeContainer('yes', true).driver);
    });
    expect(router.pickContainer(demuxQuery).id).toBe('yes');
  });

  it('caches when a mime/extension is present', () => {
    const { driver, supports } = makeContainer('mp4', true);
    const { router } = routerWith((reg) => reg.addContainer(driver));
    router.pickContainer(demuxQuery);
    router.pickContainer(demuxQuery);
    expect(supports).toHaveBeenCalledTimes(1);
  });

  it('does not cache a head-only (magic) probe', () => {
    const { driver, supports } = makeContainer('mp4', true);
    const { router } = routerWith((reg) => reg.addContainer(driver));
    const headOnly: ContainerQuery = { direction: 'demux', head: new Uint8Array([0, 0, 0, 0]) };
    router.pickContainer(headOnly);
    router.pickContainer(headOnly);
    expect(supports).toHaveBeenCalledTimes(2);
  });

  it('throws CapabilityError on a miss', () => {
    const { router } = routerWith((reg) => reg.addContainer(makeContainer('no', false).driver));
    expect(() => router.pickContainer(demuxQuery)).toThrowError(CapabilityError);
  });
});

describe('Router.pickFilter', () => {
  it('ranks substrates WebGPU → WebGL → Canvas2D → native → WASM', () => {
    const { router } = routerWith((reg) => {
      reg.addFilter(makeFilter('wasm', 'wasm', true).driver);
      reg.addFilter(makeFilter('native', 'native', true).driver);
      reg.addFilter(makeFilter('canvas', 'canvas2d', true).driver);
      reg.addFilter(makeFilter('gpu', 'webgpu', true).driver);
      reg.addFilter(makeFilter('gl', 'webgl', true).driver);
    });
    expect(router.pickFilter(resizeSpec).id).toBe('gpu');
  });

  it('prefers native CPU filters over a WASM filter tail', () => {
    const { router } = routerWith((reg) => {
      reg.addFilter(makeFilter('wasm', 'wasm', true).driver);
      reg.addFilter(makeFilter('native', 'native', true).driver);
    });
    expect(router.pickFilter(resizeSpec).id).toBe('native');
  });

  it('uses telemetry-seeded tiny-input thresholds to prefer native over GPU setup', () => {
    const tinyResize: FilterSpec = {
      mediaType: 'video',
      type: 'resize',
      width: 32,
      height: 32,
    };
    const { router } = routerWith((reg) => {
      reg.addFilter(makeFilter('gpu', 'webgpu', true).driver);
      reg.addFilter(makeFilter('native', 'native', true).driver);
    });

    expect(router.pickFilter(tinyResize).id).toBe('native');
    expect(router.pickFilter(resizeSpec).id).toBe('gpu');
  });

  it('keeps separate cached filter verdicts for tiny and normal work', () => {
    const tinyResize: FilterSpec = {
      mediaType: 'video',
      type: 'resize',
      width: 32,
      height: 32,
    };
    const gpu = makeFilter('gpu', 'webgpu', true);
    const native = makeFilter('native', 'native', true);
    const { router } = routerWith((reg) => {
      reg.addFilter(gpu.driver);
      reg.addFilter(native.driver);
    });

    expect(router.pickFilter(resizeSpec).id).toBe('gpu');
    expect(router.pickFilter(tinyResize).id).toBe('native');
  });

  it('drops GPU substrates under force-software', () => {
    const { router } = routerWith((reg) => {
      reg.addFilter(makeFilter('gpu', 'webgpu', true).driver);
      reg.addFilter(makeFilter('canvas', 'canvas2d', true).driver);
    });
    expect(router.pickFilter(resizeSpec, { determinism: 'force-software' }).id).toBe('canvas');
  });

  it('keeps native and wasm filter substrates under force-software', () => {
    const { router } = routerWith((reg) => {
      reg.addFilter(makeFilter('gpu', 'webgpu', true).driver);
      reg.addFilter(makeFilter('wasm', 'wasm', true).driver);
      reg.addFilter(makeFilter('native', 'native', true).driver);
    });
    expect(router.pickFilter(resizeSpec, { determinism: 'force-software' }).id).toBe('native');
  });

  it('misses when only GPU substrates exist under force-software', () => {
    const { router } = routerWith((reg) => reg.addFilter(makeFilter('gpu', 'webgpu', true).driver));
    expect(() => router.pickFilter(resizeSpec, { determinism: 'force-software' })).toThrowError(
      CapabilityError,
    );
  });

  it('caches a positive verdict', () => {
    const { driver, supports } = makeFilter('gpu', 'webgpu', true);
    const { router } = routerWith((reg) => reg.addFilter(driver));
    router.pickFilter(resizeSpec);
    router.pickFilter(resizeSpec);
    expect(supports).toHaveBeenCalledTimes(1);
  });
});

describe('Router with the default (no-op) ensureLoaded', () => {
  it('selects a codec without a custom loader hook', async () => {
    const reg = new Registry();
    reg.addCodec(makeCodec('wasm', 'wasm', true).driver);
    const router = new Router({ registry: reg });
    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');
  });
});
