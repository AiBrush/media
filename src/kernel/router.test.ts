import { runInNewContext } from 'node:vm';
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
import { TINY_VIDEO_PIXEL_WORK } from './tier-thresholds.ts';

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

  it('re-probes an exact config when a previously unavailable higher tier recovers', async () => {
    let hardwareAvailable = false;
    const hardwareSupports = vi.fn(
      async (): Promise<CodecSupport> => ({ supported: hardwareAvailable }),
    );
    const hardware = makeCodec('hw', 'hardware', false).driver;
    const fallback = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec({ ...hardware, supports: hardwareSupports });
      reg.addCodec(fallback.driver);
    });

    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');
    hardwareAvailable = true;
    expect((await router.pickCodec(decodeQuery)).id).toBe('hw');

    expect(hardwareSupports).toHaveBeenCalledTimes(2);
    expect(fallback.supports).toHaveBeenCalledTimes(1);
  });

  it('keeps geometry-dependent codec support independent of operation order', async () => {
    async function picksFor(widths: readonly number[]): Promise<readonly string[]> {
      const hardwareSupports = vi.fn(
        async (q: CodecQuery): Promise<CodecSupport> => ({
          supported:
            q.mediaType === 'video' &&
            'codedWidth' in q.config &&
            q.config.codedWidth === 640 &&
            q.config.codedHeight === 360,
        }),
      );
      const hardware = makeCodec('hw', 'hardware', false).driver;
      const fallback = makeCodec('wasm', 'wasm', true);
      const { router } = routerWith((reg) => {
        reg.addCodec({ ...hardware, supports: hardwareSupports });
        reg.addCodec(fallback.driver);
      });
      const picked: string[] = [];

      for (const codedWidth of widths) {
        picked.push(
          (
            await router.pickCodec({
              ...decodeQuery,
              config: { codec: decodeQuery.config.codec, codedWidth, codedHeight: 360 },
            })
          ).id,
        );
      }

      expect(hardwareSupports).toHaveBeenCalledTimes(2);
      return picked;
    }

    expect(await picksFor([640, 1920])).toEqual(['hw', 'wasm']);
    expect(await picksFor([1920, 640])).toEqual(['wasm', 'hw']);
  });

  it('never lets a config toJSON hook collapse distinct capability facts', async () => {
    const hardwareSupports = vi.fn(
      async (q: CodecQuery): Promise<CodecSupport> => ({
        supported:
          q.mediaType === 'video' && 'codedWidth' in q.config && q.config.codedWidth === 640,
      }),
    );
    const hardware = makeCodec('hw', 'hardware', false).driver;
    const fallback = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec({ ...hardware, supports: hardwareSupports });
      reg.addCodec(fallback.driver);
    });
    const config = (codedWidth: number): VideoDecoderConfig =>
      ({
        codec: 'avc1.42001f',
        codedWidth,
        codedHeight: 360,
        // Web IDL ignores unrelated dictionary members. A cache serializer must not execute this hook.
        toJSON: () => ({ codec: 'avc1.42001f' }),
      }) as VideoDecoderConfig;

    expect((await router.pickCodec({ ...decodeQuery, config: config(640) })).id).toBe('hw');
    expect((await router.pickCodec({ ...decodeQuery, config: config(1920) })).id).toBe('wasm');
    expect(hardwareSupports).toHaveBeenCalledTimes(2);
    expect(fallback.supports).toHaveBeenCalledTimes(1);
  });

  it('re-probes cross-realm description buffers instead of assigning them a colliding identity', async () => {
    const hardwareSupports = vi.fn(
      async (q: CodecQuery): Promise<CodecSupport> => ({
        supported: firstDescriptionByte(q.config) === 1,
      }),
    );
    const hardware = makeCodec('hw', 'hardware', false).driver;
    const fallback = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec({ ...hardware, supports: hardwareSupports });
      reg.addCodec(fallback.driver);
    });
    const description = (first: number): ArrayBuffer =>
      runInNewContext(`Uint8Array.from([${first}, 2, 3]).buffer`) as ArrayBuffer;
    const query = (first: number): CodecQuery => ({
      ...decodeQuery,
      config: {
        codec: decodeQuery.config.codec,
        codedWidth: 640,
        codedHeight: 360,
        description: description(first),
      },
    });

    expect((await router.pickCodec(query(1))).id).toBe('hw');
    expect((await router.pickCodec(query(0))).id).toBe('wasm');
    expect(hardwareSupports).toHaveBeenCalledTimes(2);
    expect(fallback.supports).toHaveBeenCalledTimes(1);
  });

  it('keeps VPx alpha support independent of operation order', async () => {
    async function picksFor(alphas: readonly AlphaOption[]): Promise<readonly string[]> {
      const supports = vi.fn(
        async (q: CodecQuery): Promise<CodecSupport> => ({
          supported: 'alpha' in q.config && q.config.alpha === 'discard',
        }),
      );
      const codec = makeCodec('vpx', 'hardware', false).driver;
      const { router } = routerWith((reg) => reg.addCodec({ ...codec, supports }));
      const outcomes: string[] = [];

      for (const alpha of alphas) {
        try {
          outcomes.push(
            (
              await router.pickCodec({
                mediaType: 'video',
                direction: 'decode',
                config: {
                  codec: 'vp09.00.10.08',
                  codedWidth: 640,
                  codedHeight: 360,
                  alpha,
                } as VideoDecoderConfig & { readonly alpha: AlphaOption },
              })
            ).id,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(CapabilityError);
          outcomes.push('miss');
        }
      }

      expect(supports).toHaveBeenCalledTimes(2);
      return outcomes;
    }

    expect(await picksFor(['keep', 'discard'])).toEqual(['miss', 'vpx']);
    expect(await picksFor(['discard', 'keep'])).toEqual(['vpx', 'miss']);
  });

  it('keys codec support by the exact description view bytes', async () => {
    const hardwareSupports = vi.fn(
      async (q: CodecQuery): Promise<CodecSupport> => ({
        supported: firstDescriptionByte(q.config) === 1,
      }),
    );
    const hardware = makeCodec('hw', 'hardware', false).driver;
    const fallback = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec({ ...hardware, supports: hardwareSupports });
      reg.addCodec(fallback.driver);
    });
    const backing = new Uint8Array([99, 1, 2, 3, 88]);
    const description = backing.subarray(1, 4);
    const query: CodecQuery = {
      ...decodeQuery,
      config: { codec: decodeQuery.config.codec, codedWidth: 640, codedHeight: 360, description },
    };

    expect((await router.pickCodec(query)).id).toBe('hw');
    description[0] = 0;
    expect((await router.pickCodec(query)).id).toBe('wasm');
    description[0] = 1;
    expect((await router.pickCodec(query)).id).toBe('hw');

    expect(hardwareSupports).toHaveBeenCalledTimes(2);
    expect(fallback.supports).toHaveBeenCalledTimes(1);
  });

  it('re-probes a mutable SharedArrayBuffer description instead of caching an unsafe snapshot', async () => {
    const hardwareSupports = vi.fn(
      async (q: CodecQuery): Promise<CodecSupport> => ({
        supported: firstDescriptionByte(q.config) === 1,
      }),
    );
    const hardware = makeCodec('hw', 'hardware', false).driver;
    const fallback = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec({ ...hardware, supports: hardwareSupports });
      reg.addCodec(fallback.driver);
    });
    const description = new SharedArrayBuffer(2);
    const bytes = new Uint8Array(description);
    bytes[0] = 1;
    const query: CodecQuery = {
      ...decodeQuery,
      config: { codec: decodeQuery.config.codec, codedWidth: 640, codedHeight: 360, description },
    };

    expect((await router.pickCodec(query)).id).toBe('hw');
    bytes[0] = 0;
    expect((await router.pickCodec(query)).id).toBe('wasm');

    expect(hardwareSupports).toHaveBeenCalledTimes(2);
    expect(fallback.supports).toHaveBeenCalledTimes(1);
  });

  it('does not assign an asynchronous verdict to a config mutated during the probe', async () => {
    const started = deferred();
    const resume = deferred();
    const hardwareSupports = vi.fn(async (q: CodecQuery): Promise<CodecSupport> => {
      started.resolve();
      await resume.promise;
      return {
        supported:
          q.mediaType === 'video' && 'codedWidth' in q.config && q.config.codedWidth === 1920,
      };
    });
    const hardware = makeCodec('hw', 'hardware', false).driver;
    const fallback = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec({ ...hardware, supports: hardwareSupports });
      reg.addCodec(fallback.driver);
    });
    const config: VideoDecoderConfig = {
      codec: decodeQuery.config.codec,
      codedWidth: 640,
      codedHeight: 360,
    };

    const firstPick = router.pickCodec({ ...decodeQuery, config });
    await started.promise;
    config.codedWidth = 1920;
    resume.resolve();
    expect((await firstPick).id).toBe('hw');

    config.codedWidth = 640;
    expect((await router.pickCodec({ ...decodeQuery, config })).id).toBe('wasm');
    expect(hardwareSupports).toHaveBeenCalledTimes(2);
  });

  it('bounds exact codec verdicts and evicts the least-recently-used configuration', async () => {
    const codec = makeCodec('hw', 'hardware', true);
    const { router } = routerWith((reg) => reg.addCodec(codec.driver));

    for (let codedWidth = 1; codedWidth <= 65; codedWidth++) {
      await router.pickCodec({
        ...decodeQuery,
        config: { codec: decodeQuery.config.codec, codedWidth, codedHeight: 1 },
      });
    }
    await router.pickCodec({
      ...decodeQuery,
      config: { codec: decodeQuery.config.codec, codedWidth: 1, codedHeight: 1 },
    });

    expect(codec.supports).toHaveBeenCalledTimes(66);
  });

  it('uses explicit tiny-cost telemetry to rank native codec work ahead of GPU startup', async () => {
    const native = makeCodec('native', 'native', true);
    const gpu = makeCodec('gpu', 'gpu', true);
    const { router } = routerWith((reg) => {
      reg.addCodec(gpu.driver);
      reg.addCodec(native.driver);
    });

    const tinyCosts = [
      { inputBytes: 64 },
      { inputBytes: 10_000_000, outputPixels: 32 * 32 },
      { inputBytes: 10_000_000, outputPixels: 1920 * 1080, mediaSeconds: 0.1 },
      {
        inputBytes: 10_000_000,
        outputPixels: 1920 * 1080,
        mediaSeconds: 60,
        audioFrames: 128,
      },
    ] as const;

    let caseIndex = 0;
    for (const cost of tinyCosts) {
      expect(
        (
          await router.pickCodec(
            { ...decodeQuery, config: { codec: `vp09.00.10.08.${caseIndex}` } },
            { cost },
          )
        ).id,
      ).toBe('native');
      caseIndex++;
    }

    expect(
      (
        await router.pickCodec(
          { ...decodeQuery, config: { codec: 'vp09.00.10.08.large' } },
          {
            cost: {
              inputBytes: 100_000_000,
              outputPixels: 1920 * 1080,
              mediaSeconds: 60,
              audioFrames: 48_001,
            },
          },
        )
      ).id,
    ).toBe('gpu');
  });
});

function firstDescriptionByte(config: CodecQuery['config']): number | undefined {
  if (!('description' in config) || config.description === undefined) return undefined;
  const description = config.description;
  if (ArrayBuffer.isView(description)) {
    return new Uint8Array(description.buffer, description.byteOffset, description.byteLength)[0];
  }
  return new Uint8Array(description)[0];
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {
    throw new Error('deferred promise was not initialized');
  };
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

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

  it('uses total video pixel work, never duration alone, for dimensionless colour filters', () => {
    const tonemap: FilterSpec = { mediaType: 'video', type: 'tonemap', to: 'sdr' };
    const { router } = routerWith((reg) => {
      reg.addFilter(makeFilter('gpu', 'webgpu', true).driver);
      reg.addFilter(makeFilter('native', 'native', true).driver);
    });

    expect(router.pickFilter(tonemap, { cost: { mediaSeconds: 0.5 } }).id).toBe('gpu');
    expect(router.pickFilter(tonemap, { cost: { videoPixelWork: TINY_VIDEO_PIXEL_WORK } }).id).toBe(
      'native',
    );
    expect(
      router.pickFilter(tonemap, { cost: { videoPixelWork: TINY_VIDEO_PIXEL_WORK + 1 } }).id,
    ).toBe('gpu');
  });

  it('keeps short 4K, one-frame 360p, and 720p/1080p video work on the GPU route', () => {
    const tonemap: FilterSpec = { mediaType: 'video', type: 'tonemap', to: 'sdr' };
    const gpu = makeFilter('gpu', 'webgpu', true);
    const native = makeFilter('native', 'native', true);
    const { router } = routerWith((reg) => {
      reg.addFilter(gpu.driver);
      reg.addFilter(native.driver);
    });
    const costs = [
      {
        inputPixels: 3840 * 2160,
        outputPixels: 1920 * 1080,
        videoFrames: 3,
        videoPixelWork: (3840 * 2160 + 1920 * 1080) * 3,
        mediaSeconds: 0.1,
      },
      {
        inputPixels: 640 * 360,
        outputPixels: 320 * 180,
        videoFrames: 1,
        videoPixelWork: 640 * 360 + 320 * 180,
        mediaSeconds: 1 / 30,
      },
      {
        inputPixels: 1920 * 1080,
        outputPixels: 1280 * 720,
        videoFrames: 30,
        videoPixelWork: (1920 * 1080 + 1280 * 720) * 30,
        mediaSeconds: 1,
      },
      {
        inputPixels: 1280 * 720,
        outputPixels: 1920 * 1080,
        videoFrames: 30,
        videoPixelWork: (1280 * 720 + 1920 * 1080) * 30,
        mediaSeconds: 1,
      },
    ] as const;

    for (const cost of costs) {
      expect(router.pickFilter(tonemap, { cost }).id).toBe('gpu');
      expect(router.pickFilter(tonemap, { cost }).id).toBe('gpu');
    }
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

  it('keys target-dependent filter support exactly in either operation order', () => {
    function picksFor(targets: readonly string[]): readonly string[] {
      const canvas = makeFilter('canvas', 'canvas2d', false).driver;
      const cpu = makeFilter('cpu', 'native', true).driver;
      const canvasSupports = vi.fn(
        (spec: FilterSpec): boolean => spec.type === 'colorspace' && spec.to === 'srgb',
      );
      const { router } = routerWith((reg) => {
        reg.addFilter({ ...canvas, supports: canvasSupports });
        reg.addFilter(cpu);
      });
      const picked = targets.map(
        (to) =>
          router.pickFilter(
            { mediaType: 'video', type: 'colorspace', to },
            {
              determinism: 'force-software',
              cost: { videoPixelWork: TINY_VIDEO_PIXEL_WORK + 1 },
            },
          ).id,
      );
      expect(canvasSupports).toHaveBeenCalledTimes(2);
      return picked;
    }

    expect(picksFor(['srgb', 'bt2020'])).toEqual(['canvas', 'cpu']);
    expect(picksFor(['bt2020', 'srgb'])).toEqual(['cpu', 'canvas']);
  });

  it('drops GPU substrates under force-software', () => {
    const { router } = routerWith((reg) => {
      reg.addFilter(makeFilter('gpu', 'webgpu', true).driver);
      reg.addFilter(makeFilter('canvas', 'canvas2d', true).driver);
    });
    expect(
      router.pickFilter(resizeSpec, {
        determinism: 'force-software',
        cost: {
          videoPixelWork: (1920 * 1080 + 1280 * 720) * 30,
        },
      }).id,
    ).toBe('canvas');
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

  it('revalidates a cached top-rung filter against the current exact spec', () => {
    const { driver, supports } = makeFilter('gpu', 'webgpu', true);
    const { router } = routerWith((reg) => reg.addFilter(driver));
    router.pickFilter(resizeSpec);
    router.pickFilter(resizeSpec);
    expect(supports).toHaveBeenCalledTimes(2);
  });

  it('treats audio-only filter specs as non-tiny and keeps the GPU setup ranking irrelevant', () => {
    const native = makeFilter('native', 'native', true);
    const wasm = makeFilter('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addFilter(wasm.driver);
      reg.addFilter(native.driver);
    });

    const audioSpecs: readonly FilterSpec[] = [
      { mediaType: 'audio', type: 'resample', sampleRate: 16_000 },
      { mediaType: 'audio', type: 'remix', channels: 1 },
      { mediaType: 'audio', type: 'gain', db: -6 },
      { mediaType: 'audio', type: 'fade', curve: 'linear', inFrames: 10, outFrames: 20 },
      { mediaType: 'audio', type: 'biquad', spec: { type: 'lowpass', frequency: 4000, q: 1 } },
      {
        mediaType: 'audio',
        type: 'dynamics',
        dynamics: { limit: { ceilingDbfs: -1, mode: 'hard' } },
      },
    ];

    for (const spec of audioSpecs) expect(router.pickFilter(spec).id).toBe('native');
  });

  it('preserves audio-frame cost routing independently of video pixel work', () => {
    const gain: FilterSpec = { mediaType: 'audio', type: 'gain', db: -6 };
    const { router } = routerWith((reg) => {
      reg.addFilter(makeFilter('gpu', 'webgpu', true).driver);
      reg.addFilter(makeFilter('native', 'native', true).driver);
    });

    expect(router.pickFilter(gain, { cost: { audioFrames: 128 } }).id).toBe('native');
    expect(router.pickFilter(gain, { cost: { audioFrames: 48_001 } }).id).toBe('gpu');
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
