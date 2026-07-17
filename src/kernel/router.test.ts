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
  it('pins the exact codec id without probing or falling through to another codec', async () => {
    const hardware = makeCodec('hardware', 'hardware', true);
    const pinned = makeCodec('pinned-wasm', 'wasm', false);
    const fallback = makeCodec('fallback-wasm', 'wasm', true);
    const { router, ensureLoaded } = routerWith((reg) => {
      reg.addCodec(hardware.driver);
      reg.addCodec(pinned.driver);
      reg.addCodec(fallback.driver);
    });

    await expect(router.pickCodec(decodeQuery, { pinDriver: 'pinned-wasm' })).rejects.toMatchObject(
      {
        name: 'CapabilityError',
        code: 'capability-miss',
        message: expect.stringContaining('pinned-wasm'),
        detail: { tried: ['pinned-wasm'] },
      },
    );
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
    expect(ensureLoaded).toHaveBeenCalledWith(pinned.driver);
    expect(pinned.supports).toHaveBeenCalledTimes(1);
    expect(hardware.supports).not.toHaveBeenCalled();
    expect(fallback.supports).not.toHaveBeenCalled();
  });

  it('does not let an unpinned positive cache bypass a later exact codec pin', async () => {
    const hardware = makeCodec('hardware', 'hardware', true);
    const pinned = makeCodec('pinned-wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec(hardware.driver);
      reg.addCodec(pinned.driver);
    });

    expect((await router.pickCodec(decodeQuery)).id).toBe('hardware');
    expect((await router.pickCodec(decodeQuery, { pinDriver: 'pinned-wasm' })).id).toBe(
      'pinned-wasm',
    );
  });

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

  it('admits a hardware-tier WebCodecs driver only after an explicit software verdict', async () => {
    const softwareSupports = vi.fn(async (...args: readonly unknown[]): Promise<CodecSupport> => {
      const options = args[1] as { readonly determinism?: string } | undefined;
      return options?.determinism === 'force-software'
        ? { supported: true, hardwareAccelerated: false }
        : { supported: true, hardwareAccelerated: true };
    });
    const hardware = makeCodec('webcodecs', 'hardware', true).driver;
    const fallback = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec({ ...hardware, supports: softwareSupports as CodecDriver['supports'] });
      reg.addCodec(fallback.driver);
    });

    expect((await router.pickCodec(decodeQuery, { determinism: 'force-software' })).id).toBe(
      'webcodecs',
    );
    expect(softwareSupports).toHaveBeenCalledWith(decodeQuery, {
      determinism: 'force-software',
    });
    expect(fallback.supports).not.toHaveBeenCalled();
  });

  it('rejects a hardware-tier force-software verdict unless it proves non-hardware execution', async () => {
    for (const verdict of [
      { supported: true },
      { supported: true, hardwareAccelerated: true },
    ] satisfies readonly CodecSupport[]) {
      const hardware = makeCodec('hardware-only', 'hardware', true).driver;
      const fallback = makeCodec('wasm', 'wasm', true);
      const { router } = routerWith((reg) => {
        reg.addCodec({ ...hardware, supports: () => Promise.resolve(verdict) });
        reg.addCodec(fallback.driver);
      });
      expect((await router.pickCodec(decodeQuery, { determinism: 'force-software' })).id).toBe(
        'wasm',
      );
    }
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
      detail: { op: { kind: 'codec', query: decodeQuery }, tried: ['hw', 'wasm'] },
    });
    await expect(router.pickCodec(decodeQuery)).rejects.toBeInstanceOf(CapabilityError);
  });

  it('every routed miss carries the discriminated op descriptor and names what was probed', async () => {
    // R-S04.4: `detail.op` is the typed OperationDescriptor union and `tried` is never empty when
    // candidates were actually probed.
    const { router } = routerWith((reg) => {
      reg.addCodec(makeCodec('hw', 'hardware', false).driver);
      reg.addContainer(makeContainer('mp4', false).driver);
      reg.addFilter(makeFilter('gpu', 'webgpu', false).driver);
    });

    const codecMiss = await router.pickCodec(decodeQuery).then(
      () => undefined,
      (e: unknown) => e as CapabilityError,
    );
    expect(codecMiss?.detail?.op).toEqual({ kind: 'codec', query: decodeQuery });
    expect(codecMiss?.detail?.tried.length).toBeGreaterThan(0);

    const containerQuery = { direction: 'demux', extension: 'mp4' } as const;
    let containerMiss: CapabilityError | undefined;
    try {
      router.pickContainer(containerQuery);
    } catch (e) {
      containerMiss = e as CapabilityError;
    }
    expect(containerMiss?.detail?.op).toEqual({ kind: 'container', query: containerQuery });
    expect(containerMiss?.detail?.tried.length).toBeGreaterThan(0);

    let filterMiss: CapabilityError | undefined;
    try {
      router.pickFilter(resizeSpec);
    } catch (e) {
      filterMiss = e as CapabilityError;
    }
    expect(filterMiss?.detail?.op).toEqual({ kind: 'filter', spec: resizeSpec });
    expect(filterMiss?.detail?.tried.length).toBeGreaterThan(0);
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
  it('pins the exact container id and scopes a codec-only pin away from container routing', () => {
    const first = makeContainer('first', true);
    const pinned = makeContainer('pinned-container', true);
    const codec = makeCodec('codec-only', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addContainer(first.driver);
      reg.addContainer(pinned.driver);
      reg.addCodec(codec.driver);
    });

    expect(router.pickContainer(demuxQuery, { pinDriver: 'pinned-container' }).id).toBe(
      'pinned-container',
    );
    expect(first.supports).not.toHaveBeenCalled();
    expect(router.pickContainer(demuxQuery, { pinDriver: 'codec-only' }).id).toBe('first');
  });

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
  it('pins the exact filter id and reports only that id when its probe declines', () => {
    const gpu = makeFilter('gpu', 'webgpu', true);
    const pinned = makeFilter('pinned-filter', 'native', false);
    const fallback = makeFilter('fallback', 'native', true);
    const { router } = routerWith((reg) => {
      reg.addFilter(gpu.driver);
      reg.addFilter(pinned.driver);
      reg.addFilter(fallback.driver);
    });

    let caught: unknown;
    try {
      router.pickFilter(resizeSpec, { pinDriver: 'pinned-filter' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: 'CapabilityError',
      message: expect.stringContaining('pinned-filter'),
      detail: { tried: ['pinned-filter'] },
    });
    expect(pinned.supports).toHaveBeenCalledTimes(1);
    expect(gpu.supports).not.toHaveBeenCalled();
    expect(fallback.supports).not.toHaveBeenCalled();
  });

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
      reg.addFilter(makeFilter('native', 'native', true).driver);
    });
    expect(
      router.pickFilter(resizeSpec, {
        determinism: 'force-software',
        cost: {
          videoPixelWork: (1920 * 1080 + 1280 * 720) * 30,
        },
      }).id,
    ).toBe('native');
  });

  it('does not treat Canvas2D as deterministic software when it is the only filter substrate', () => {
    const { router } = routerWith((reg) =>
      reg.addFilter(makeFilter('canvas', 'canvas2d', true).driver),
    );
    expect(() => router.pickFilter(resizeSpec, { determinism: 'force-software' })).toThrowError(
      CapabilityError,
    );
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

describe('Router.probeCodec surfaces the capability verdict (R-S01.2, ADR-203)', () => {
  it('carries hardwareAccelerated === true with exactly one probe per exact config', async () => {
    const supports = vi.fn(
      async (): Promise<CodecSupport> => ({ supported: true, hardwareAccelerated: true }),
    );
    const { router } = routerWith((reg) =>
      reg.addCodec({ ...makeCodec('hw', 'hardware', true).driver, supports }),
    );

    const first = await router.probeCodec(decodeQuery);
    expect(first.driver.id).toBe('hw');
    expect(first.support).toEqual({ supported: true, hardwareAccelerated: true });

    // The cached verdict is served without a second supports()/isConfigSupported-style probe.
    const second = await router.probeCodec(decodeQuery);
    expect(second.driver).toBe(first.driver);
    expect(second.support.hardwareAccelerated).toBe(true);
    expect(supports).toHaveBeenCalledTimes(1);
  });

  it('shares one verdict cache with pickCodec in both directions', async () => {
    const supports = vi.fn(
      async (): Promise<CodecSupport> => ({ supported: true, hardwareAccelerated: false }),
    );
    const { router } = routerWith((reg) =>
      reg.addCodec({ ...makeCodec('hw', 'hardware', true).driver, supports }),
    );

    expect((await router.pickCodec(decodeQuery)).id).toBe('hw');
    const route = await router.probeCodec(decodeQuery);
    expect(route.support.hardwareAccelerated).toBe(false);
    expect((await router.pickCodec(decodeQuery)).id).toBe('hw');
    expect(supports).toHaveBeenCalledTimes(1);
  });

  it('freezes the surfaced snapshot so no caller or driver can corrupt a cached verdict', async () => {
    const verdict: CodecSupport = { supported: true, hardwareAccelerated: true, reason: 'dGPU' };
    const supports = vi.fn(async (): Promise<CodecSupport> => verdict);
    const { router } = routerWith((reg) =>
      reg.addCodec({ ...makeCodec('hw', 'hardware', true).driver, supports }),
    );

    const first = await router.probeCodec(decodeQuery);
    expect(Object.isFrozen(first.support)).toBe(true);
    expect(first.support).not.toBe(verdict);

    // A driver mutating the object it returned must not rewrite the already-cached verdict.
    verdict.hardwareAccelerated = false;
    const second = await router.probeCodec(decodeQuery);
    expect(second.support).toEqual({ supported: true, hardwareAccelerated: true, reason: 'dGPU' });
  });

  it('surfaces the verdict of the driver that actually won the walk', async () => {
    const { router } = routerWith((reg) => {
      reg.addCodec(makeCodec('hw', 'hardware', false).driver);
      reg.addCodec(makeCodec('wasm', 'wasm', true).driver);
    });
    const route = await router.probeCodec(decodeQuery);
    expect(route.driver.id).toBe('wasm');
    expect(route.support.supported).toBe(true);
  });
});

describe('Router.evictCodec on an execution-time capability miss (R-S01.1, ADR-284)', () => {
  /** A hardware driver whose probe lies `true` but whose decoder throws on the first coded packet. */
  function makeRuntimeLiar(id: string) {
    const supports = vi.fn(
      async (): Promise<CodecSupport> => ({ supported: true, hardwareAccelerated: true }),
    );
    const driver: CodecDriver = {
      id,
      apiVersion: DRIVER_API_VERSION,
      kind: 'codec',
      tier: 'hardware',
      supports,
      createDecoder: () =>
        new TransformStream<EncodedChunk, RawFrame>({
          transform(): void {
            throw new CapabilityError(`'${id}' failed on the first coded packets`, {
              op: { kind: 'codec', query: decodeQuery },
              tried: [id],
            });
          },
        }),
      createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
    };
    return { driver, supports };
  }

  /** A wasm driver that decodes each chunk into a close-counted fake frame. */
  function makeCountingWasmDecoder(id: string) {
    const supports = vi.fn(async (): Promise<CodecSupport> => ({ supported: true }));
    const closeCounts = new Map<number, number>();
    const driver: CodecDriver = {
      id,
      apiVersion: DRIVER_API_VERSION,
      kind: 'codec',
      tier: 'wasm',
      supports,
      createDecoder: () =>
        new TransformStream<EncodedChunk, RawFrame>({
          transform(chunk, controller): void {
            const timestamp = (chunk as { timestamp?: number }).timestamp ?? -1;
            closeCounts.set(timestamp, 0);
            const frame = {
              timestamp,
              close(): void {
                closeCounts.set(timestamp, (closeCounts.get(timestamp) ?? 0) + 1);
              },
            };
            controller.enqueue(frame as unknown as RawFrame);
          },
        }),
      createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
    };
    return { driver, supports, closeCounts };
  }

  function chunk(timestamp: number): EncodedChunk {
    return { timestamp, byteLength: 64 } as unknown as EncodedChunk;
  }

  async function decodeAll(
    decoder: TransformStream<EncodedChunk, RawFrame>,
    chunks: readonly EncodedChunk[],
  ): Promise<readonly number[]> {
    const writer = decoder.writable.getWriter();
    const reader = decoder.readable.getReader();
    const writing = (async () => {
      for (const c of chunks) await writer.write(c);
      await writer.close();
    })();
    const timestamps: number[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      timestamps.push(result.value.timestamp ?? -1);
      result.value.close();
    }
    await writing;
    return timestamps;
  }

  it('re-routes the exact config to the wasm tail and produces output, closing frames exactly once', async () => {
    const liar = makeRuntimeLiar('hw');
    const wasm = makeCountingWasmDecoder('wasm');
    const { router } = routerWith((reg) => {
      reg.addCodec(liar.driver);
      reg.addCodec(wasm.driver);
    });

    // 1) Selection accepts the lying probe (this is exactly what ADR-284 measured in browsers).
    const picked = await router.pickCodec(decodeQuery);
    expect(picked.id).toBe('hw');

    // 2) The first coded packet raises the typed runtime miss. A reader must pull first: a fresh
    // TransformStream exerts backpressure (readable HWM 0) until read demand arrives.
    const failing = picked.createDecoder(decodeQuery.config);
    const failingReader = failing.readable.getReader();
    const pendingRead = failingReader.read().then(
      () => undefined,
      (error: unknown) => error,
    );
    const failingWriter = failing.writable.getWriter();
    const runtimeError = await failingWriter.write(chunk(0)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(runtimeError).toBeInstanceOf(CapabilityError);
    expect(await pendingRead).toBeInstanceOf(CapabilityError);

    // 3) The executor evicts the verdict and re-routes the *same* config to the next rung.
    expect(router.evictCodec(decodeQuery, picked.id)).toBe(true);
    const rerouted = await router.pickCodec(decodeQuery);
    expect(rerouted.id).toBe('wasm');

    // 4) The wasm rung genuinely decodes: exact timestamp sequence out, every frame closed once.
    const chunks = [chunk(0), chunk(33_333), chunk(66_666)];
    const timestamps = await decodeAll(rerouted.createDecoder(decodeQuery.config), chunks);
    expect(timestamps).toEqual([0, 33_333, 66_666]);
    expect([...wasm.closeCounts.entries()]).toEqual([
      [0, 1],
      [33_333, 1],
      [66_666, 1],
    ]);

    // 5) The failed driver stays evicted for this exact config: never re-probed, never re-returned.
    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');
    expect(liar.supports).toHaveBeenCalledTimes(1);
  });

  it('never caches a fallback verdict under an evicted ladder head (recovery stays possible)', async () => {
    const liar = makeRuntimeLiar('hw');
    const wasm = makeCountingWasmDecoder('wasm');
    const { router } = routerWith((reg) => {
      reg.addCodec(liar.driver);
      reg.addCodec(wasm.driver);
    });

    await router.pickCodec(decodeQuery);
    router.evictCodec(decodeQuery, 'hw');
    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');
    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');
    // The wasm verdict is re-probed per pick (ADR-207: cached fallbacks would mask later recovery)…
    expect(wasm.supports).toHaveBeenCalledTimes(2);
    // …and nothing was cached for the evicted-head key.
    expect(router.cacheSnapshot().codec).toEqual([]);
  });

  it('scopes the eviction to the exact selection context (config bytes, tiny regime)', async () => {
    const liar = makeRuntimeLiar('hw');
    const wasm = makeCountingWasmDecoder('wasm');
    const { router } = routerWith((reg) => {
      reg.addCodec(liar.driver);
      reg.addCodec(wasm.driver);
    });

    await router.pickCodec(decodeQuery);
    router.evictCodec(decodeQuery, 'hw');

    // Same codec string, different config bytes → different selection context → hardware still wins.
    const widerQuery: CodecQuery = {
      ...decodeQuery,
      config: { codec: decodeQuery.config.codec, codedWidth: 1920, codedHeight: 1080 },
    };
    expect((await router.pickCodec(widerQuery)).id).toBe('hw');

    // Same config under the tiny regime is a different exact verdict key as well.
    expect((await router.pickCodec(decodeQuery, { cost: { inputBytes: 64 } })).id).toBe('hw');

    // The evicted context itself keeps routing to the tail.
    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');
  });

  it('survives clearCache so a registration retry cannot resurrect the liar mid-fallback', async () => {
    const liar = makeRuntimeLiar('hw');
    const wasm = makeCountingWasmDecoder('wasm');
    const { router } = routerWith((reg) => {
      reg.addCodec(liar.driver);
      reg.addCodec(wasm.driver);
    });

    await router.pickCodec(decodeQuery);
    router.evictCodec(decodeQuery, 'hw');
    // The engine clears verdict caches on every driver registration; the runtime-miss record is an
    // execution-time fact about the driver, not a registry-composition verdict, and must survive.
    router.clearCache();
    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');
    expect(liar.supports).toHaveBeenCalledTimes(1);
  });

  it('reports an evicted pinned driver as a typed miss naming the runtime eviction, probing nothing', async () => {
    const liar = makeRuntimeLiar('pinned-hw');
    const wasm = makeCountingWasmDecoder('wasm');
    const { router } = routerWith((reg) => {
      reg.addCodec(liar.driver);
      reg.addCodec(wasm.driver);
    });

    expect((await router.pickCodec(decodeQuery, { pinDriver: 'pinned-hw' })).id).toBe('pinned-hw');
    expect(router.evictCodec(decodeQuery, 'pinned-hw', { pinDriver: 'pinned-hw' })).toBe(true);

    const miss = await router.pickCodec(decodeQuery, { pinDriver: 'pinned-hw' }).then(
      () => undefined,
      (error: unknown) => error as CapabilityError,
    );
    expect(miss).toBeInstanceOf(CapabilityError);
    expect(miss?.detail?.tried).toEqual([]);
    expect(miss?.detail?.suggestion).toContain('pinned-hw');
    expect(liar.supports).toHaveBeenCalledTimes(1);
  });

  it('declines to record an eviction for a config that has no exact byte identity', async () => {
    const liar = makeRuntimeLiar('hw');
    const { router } = routerWith((reg) => reg.addCodec(liar.driver));
    const hostile: CodecQuery = {
      ...decodeQuery,
      config: new Proxy(
        { codec: 'avc1.42001f' },
        {
          ownKeys(): never {
            throw new TypeError('hostile ownKeys');
          },
        },
      ) as VideoDecoderConfig,
    };
    expect((await router.pickCodec(hostile)).id).toBe('hw');
    expect(router.evictCodec(hostile, 'hw')).toBe(false);
  });

  it('is idempotent per (config, driver) and evicts independently per driver id', async () => {
    const liar = makeRuntimeLiar('hw');
    const wasm = makeCountingWasmDecoder('wasm');
    const { router } = routerWith((reg) => {
      reg.addCodec(liar.driver);
      reg.addCodec(wasm.driver);
    });

    await router.pickCodec(decodeQuery);
    expect(router.evictCodec(decodeQuery, 'hw')).toBe(true);
    expect(router.evictCodec(decodeQuery, 'hw')).toBe(true);
    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');

    // Evicting the tail too exhausts the ladder with the typed miss naming what was runtime-tried.
    expect(router.evictCodec(decodeQuery, 'wasm')).toBe(true);
    const miss = await router.pickCodec(decodeQuery).then(
      () => undefined,
      (error: unknown) => error as CapabilityError,
    );
    expect(miss).toBeInstanceOf(CapabilityError);
    expect(miss?.detail?.tried).toEqual([]);
    expect(miss?.detail?.suggestion).toMatch(/hw.*wasm|wasm.*hw/);
  });
});

describe('tier ladder golden rank order (R-S01.6)', () => {
  function loggingCodec(id: string, tier: Tier, log: string[]) {
    const supports = vi.fn(async (): Promise<CodecSupport> => {
      log.push(id);
      return { supported: false };
    });
    return { ...makeCodec(id, tier, false).driver, supports };
  }

  function loggingFilter(id: string, substrate: FilterSubstrate, log: string[]) {
    const supports = vi.fn((_f: FilterSpec): boolean => {
      log.push(id);
      return false;
    });
    return { ...makeFilter(id, substrate, false).driver, supports };
  }

  it('probes codecs hardware → gpu → native → wasm when work is not tiny', async () => {
    const log: string[] = [];
    const { router } = routerWith((reg) => {
      // Deliberately registered worst-first: rank, not registration order, must decide.
      reg.addCodec(loggingCodec('wasm', 'wasm', log));
      reg.addCodec(loggingCodec('native', 'native', log));
      reg.addCodec(loggingCodec('gpu', 'gpu', log));
      reg.addCodec(loggingCodec('hw', 'hardware', log));
    });
    const miss = await router.pickCodec(decodeQuery).then(
      () => undefined,
      (error: unknown) => error as CapabilityError,
    );
    expect(miss?.detail?.tried).toEqual(['hw', 'gpu', 'native', 'wasm']);
    expect(log).toEqual(['hw', 'gpu', 'native', 'wasm']);
  });

  it('inverts native ↔ gpu below the ADR-020 thresholds (tiny regime)', async () => {
    const log: string[] = [];
    const { router } = routerWith((reg) => {
      reg.addCodec(loggingCodec('wasm', 'wasm', log));
      reg.addCodec(loggingCodec('gpu', 'gpu', log));
      reg.addCodec(loggingCodec('native', 'native', log));
      reg.addCodec(loggingCodec('hw', 'hardware', log));
    });
    const miss = await router.pickCodec(decodeQuery, { cost: { inputBytes: 64 } }).then(
      () => undefined,
      (error: unknown) => error as CapabilityError,
    );
    expect(miss?.detail?.tried).toEqual(['hw', 'native', 'gpu', 'wasm']);
    expect(log).toEqual(['hw', 'native', 'gpu', 'wasm']);
  });

  it('keeps registration order among equal codec ranks (stable sort)', async () => {
    const log: string[] = [];
    const { router } = routerWith((reg) => {
      reg.addCodec(loggingCodec('hw-b', 'hardware', log));
      reg.addCodec(loggingCodec('hw-a', 'hardware', log));
      reg.addCodec(loggingCodec('wasm-b', 'wasm', log));
      reg.addCodec(loggingCodec('wasm-a', 'wasm', log));
    });
    const miss = await router.pickCodec(decodeQuery).then(
      () => undefined,
      (error: unknown) => error as CapabilityError,
    );
    expect(miss?.detail?.tried).toEqual(['hw-b', 'hw-a', 'wasm-b', 'wasm-a']);
  });

  it('ranks filter substrates webgpu → webgl → canvas2d → native → wasm when not tiny', () => {
    const log: string[] = [];
    const { router } = routerWith((reg) => {
      reg.addFilter(loggingFilter('wasm', 'wasm', log));
      reg.addFilter(loggingFilter('native', 'native', log));
      reg.addFilter(loggingFilter('canvas', 'canvas2d', log));
      reg.addFilter(loggingFilter('gl', 'webgl', log));
      reg.addFilter(loggingFilter('gpu', 'webgpu', log));
    });
    let miss: CapabilityError | undefined;
    try {
      router.pickFilter(resizeSpec, { cost: { videoPixelWork: TINY_VIDEO_PIXEL_WORK + 1 } });
    } catch (error) {
      miss = error as CapabilityError;
    }
    expect(miss?.detail?.tried).toEqual(['gpu', 'gl', 'canvas', 'native', 'wasm']);
    expect(log).toEqual(['gpu', 'gl', 'canvas', 'native', 'wasm']);
  });

  it('re-ranks filters native → canvas2d → webgpu → webgl → wasm for tiny work', () => {
    const log: string[] = [];
    const { router } = routerWith((reg) => {
      reg.addFilter(loggingFilter('wasm', 'wasm', log));
      reg.addFilter(loggingFilter('gl', 'webgl', log));
      reg.addFilter(loggingFilter('gpu', 'webgpu', log));
      reg.addFilter(loggingFilter('canvas', 'canvas2d', log));
      reg.addFilter(loggingFilter('native', 'native', log));
    });
    let miss: CapabilityError | undefined;
    try {
      router.pickFilter(resizeSpec, { cost: { videoPixelWork: TINY_VIDEO_PIXEL_WORK } });
    } catch (error) {
      miss = error as CapabilityError;
    }
    expect(miss?.detail?.tried).toEqual(['native', 'canvas', 'gpu', 'gl', 'wasm']);
    expect(log).toEqual(['native', 'canvas', 'gpu', 'gl', 'wasm']);
  });
});

describe('exact codec cache key vs JSON.stringify memos (R-S01.7)', () => {
  it('keys same-codec configs with different avcC bytes distinctly where JSON.stringify collides', async () => {
    const avcC = (profile: number): VideoDecoderConfig => ({
      codec: 'avc1.42001f',
      codedWidth: 640,
      codedHeight: 360,
      description: Uint8Array.from([0x01, profile, 0x00, 0x1f, 0xff]).buffer as ArrayBuffer,
    });
    const configA = avcC(0x42);
    const configB = avcC(0x64);
    // The mediabunny-style memo key cannot tell these apart: ArrayBuffers stringify as `{}`.
    expect(JSON.stringify(configA)).toBe(JSON.stringify(configB));

    const hardwareSupports = vi.fn(async (q: CodecQuery): Promise<CodecSupport> => {
      const description = (q.config as VideoDecoderConfig).description;
      const bytes =
        description instanceof ArrayBuffer ? new Uint8Array(description) : new Uint8Array(0);
      return { supported: bytes[1] === 0x42 };
    });
    const fallback = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec({ ...makeCodec('hw', 'hardware', false).driver, supports: hardwareSupports });
      reg.addCodec(fallback.driver);
    });

    expect((await router.pickCodec({ ...decodeQuery, config: configA })).id).toBe('hw');
    expect((await router.pickCodec({ ...decodeQuery, config: configB })).id).toBe('wasm');
    // Distinct keys: the second pick of configA is a cache hit, no re-probe.
    expect((await router.pickCodec({ ...decodeQuery, config: configA })).id).toBe('hw');
    expect(hardwareSupports).toHaveBeenCalledTimes(2);
  });

  it('re-probes an accessor-carrying config without ever invoking the getter', async () => {
    const getter = vi.fn(() => 640);
    const config: VideoDecoderConfig = { codec: 'avc1.42001f' };
    Object.defineProperty(config, 'codedWidth', {
      get: getter,
      enumerable: true,
      configurable: true,
    });
    const codec = makeCodec('hw', 'hardware', true);
    const { router } = routerWith((reg) => reg.addCodec(codec.driver));

    expect((await router.pickCodec({ ...decodeQuery, config })).id).toBe('hw');
    expect((await router.pickCodec({ ...decodeQuery, config })).id).toBe('hw');
    expect(codec.supports).toHaveBeenCalledTimes(2); // never cached → re-probed
    expect(getter).not.toHaveBeenCalled(); // the keyer must not execute caller accessors
  });

  it('re-probes a hostile Proxy config and never throws out of pickCodec', async () => {
    const codec = makeCodec('hw', 'hardware', true);
    const { router } = routerWith((reg) => reg.addCodec(codec.driver));
    const config = new Proxy(
      { codec: 'avc1.42001f' },
      {
        getOwnPropertyDescriptor(): never {
          throw new TypeError('hostile descriptor trap');
        },
      },
    ) as VideoDecoderConfig;

    expect((await router.pickCodec({ ...decodeQuery, config })).id).toBe('hw');
    expect((await router.pickCodec({ ...decodeQuery, config })).id).toBe('hw');
    expect(codec.supports).toHaveBeenCalledTimes(2);
  });

  it('re-probes a cyclic config and never throws out of pickCodec', async () => {
    interface CyclicConfig extends VideoDecoderConfig {
      self?: unknown;
    }
    const config: CyclicConfig = { codec: 'avc1.42001f' };
    config.self = config;
    const codec = makeCodec('hw', 'hardware', true);
    const { router } = routerWith((reg) => reg.addCodec(codec.driver));

    expect((await router.pickCodec({ ...decodeQuery, config })).id).toBe('hw');
    expect((await router.pickCodec({ ...decodeQuery, config })).id).toBe('hw');
    expect(codec.supports).toHaveBeenCalledTimes(2);
  });

  it('routes a bigint-carrying config that would explode a JSON.stringify memo', async () => {
    const config = {
      codec: 'avc1.42001f',
      hostileTag: 1n,
    } as unknown as VideoDecoderConfig;
    expect(() => JSON.stringify(config)).toThrow(TypeError);

    const codec = makeCodec('hw', 'hardware', true);
    const { router } = routerWith((reg) => reg.addCodec(codec.driver));
    expect((await router.pickCodec({ ...decodeQuery, config })).id).toBe('hw');
    expect((await router.pickCodec({ ...decodeQuery, config })).id).toBe('hw');
    expect(codec.supports).toHaveBeenCalledTimes(2);
  });
});

describe('bounded LRU caches (R-S01.5)', () => {
  const BOUND = 64;

  it('bounds the container cache, evicting the least-recently-used key first', () => {
    const { driver, supports } = makeContainer('all-mimes', true);
    const { router } = routerWith((reg) => reg.addContainer(driver));
    const mimeQuery = (index: number): ContainerQuery => ({
      direction: 'demux',
      mime: `video/format-${index}`,
    });

    router.pickContainer(mimeQuery(0));
    const [oldestKey] = router.cacheSnapshot().container;
    expect(oldestKey).toBeDefined();
    for (let index = 1; index <= BOUND; index++) router.pickContainer(mimeQuery(index));

    const snapshot = router.cacheSnapshot().container;
    expect(snapshot.length).toBe(BOUND);
    expect(snapshot).not.toContain(oldestKey ?? '');
    expect(supports).toHaveBeenCalledTimes(BOUND + 1);

    // The evicted oldest key re-probes; a resident recent key is served from cache.
    router.pickContainer(mimeQuery(BOUND));
    expect(supports).toHaveBeenCalledTimes(BOUND + 1);
    router.pickContainer(mimeQuery(0));
    expect(supports).toHaveBeenCalledTimes(BOUND + 2);
  });

  it('refreshes container recency on a hit so hot routes survive churn', () => {
    const { driver, supports } = makeContainer('all-mimes', true);
    const { router } = routerWith((reg) => reg.addContainer(driver));
    const mimeQuery = (index: number): ContainerQuery => ({
      direction: 'demux',
      mime: `video/format-${index}`,
    });

    for (let index = 0; index < BOUND; index++) router.pickContainer(mimeQuery(index));
    router.pickContainer(mimeQuery(0)); // hit → most-recently-used
    router.pickContainer(mimeQuery(BOUND)); // evicts key 1, not the refreshed key 0

    const probesBefore = supports.mock.calls.length;
    router.pickContainer(mimeQuery(0));
    expect(supports.mock.calls.length).toBe(probesBefore); // still cached
    router.pickContainer(mimeQuery(1));
    expect(supports.mock.calls.length).toBe(probesBefore + 1); // evicted → re-probed
  });

  it('bounds the filter cache with the same LRU discipline (insertion-order probe)', () => {
    const { router } = routerWith((reg) => {
      for (let index = 0; index <= BOUND + 4; index++) {
        reg.addFilter(makeFilter(`f${index}`, 'native', true).driver);
      }
    });

    router.pickFilter(resizeSpec, { pinDriver: 'f0' });
    const [oldestKey] = router.cacheSnapshot().filter;
    expect(oldestKey).toBeDefined();
    router.pickFilter(resizeSpec, { pinDriver: 'f1' });
    const secondKey = router.cacheSnapshot().filter[1];
    expect(secondKey).toBeDefined();

    for (let index = 2; index < BOUND; index++) {
      router.pickFilter(resizeSpec, { pinDriver: `f${index}` });
    }
    const full = router.cacheSnapshot().filter;
    expect(full.length).toBe(BOUND);
    expect(full[0]).toBe(oldestKey ?? '');

    router.pickFilter(resizeSpec, { pinDriver: `f${BOUND}` });
    const evicted = router.cacheSnapshot().filter;
    expect(evicted.length).toBe(BOUND);
    expect(evicted).not.toContain(oldestKey ?? '');
    expect(evicted[0]).toBe(secondKey ?? '');
  });

  it('bounds the codec verdict cache (existing LRU law holds through the route cache)', async () => {
    const codec = makeCodec('hw', 'hardware', true);
    const { router } = routerWith((reg) => reg.addCodec(codec.driver));
    for (let codedWidth = 1; codedWidth <= BOUND + 1; codedWidth++) {
      await router.pickCodec({
        ...decodeQuery,
        config: { codec: decodeQuery.config.codec, codedWidth, codedHeight: 1 },
      });
    }
    expect(router.cacheSnapshot().codec.length).toBe(BOUND);
  });

  it('bounds the runtime-miss record map alongside the verdict caches', async () => {
    const codec = makeCodec('hw', 'hardware', true);
    const { router } = routerWith((reg) => reg.addCodec(codec.driver));
    for (let codedWidth = 1; codedWidth <= BOUND + 8; codedWidth++) {
      const query: CodecQuery = {
        ...decodeQuery,
        config: { codec: decodeQuery.config.codec, codedWidth, codedHeight: 1 },
      };
      expect(router.evictCodec(query, 'hw')).toBe(true);
    }
    expect(router.cacheSnapshot().runtimeMisses.length).toBe(BOUND);
  });
});

describe('ensureLoaded embedder seam (R-S01.4)', () => {
  it('awaits the hook once per probed candidate, in ladder order, before that candidate probes', async () => {
    const log: string[] = [];
    const hw = makeCodec('hw', 'hardware', false);
    hw.supports.mockImplementation(async (): Promise<CodecSupport> => {
      log.push('probe:hw');
      return { supported: false };
    });
    const wasm = makeCodec('wasm', 'wasm', true);
    wasm.supports.mockImplementation(async (): Promise<CodecSupport> => {
      log.push('probe:wasm');
      return { supported: true };
    });
    const registry = new Registry();
    registry.addCodec(wasm.driver);
    registry.addCodec(hw.driver);
    const router = new Router({
      registry,
      ensureLoaded: (driver) => {
        log.push(`load:${driver.id}`);
      },
    });

    expect((await router.pickCodec(decodeQuery)).id).toBe('wasm');
    expect(log).toEqual(['load:hw', 'probe:hw', 'load:wasm', 'probe:wasm']);
  });

  it('never loads drivers ranked below the accepted candidate, and skips the hook on a cache hit', async () => {
    const loader = vi.fn();
    const hw = makeCodec('hw', 'hardware', true);
    const wasm = makeCodec('wasm', 'wasm', true);
    const { router } = routerWith((reg) => {
      reg.addCodec(wasm.driver);
      reg.addCodec(hw.driver);
    }, loader);

    expect((await router.pickCodec(decodeQuery)).id).toBe('hw');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(hw.driver);
    expect(wasm.supports).not.toHaveBeenCalled();

    expect((await router.pickCodec(decodeQuery)).id).toBe('hw');
    expect(loader).toHaveBeenCalledTimes(1); // cached verdict → no loading work at all
  });
});

describe('container first-match cache + clearCache-on-registration invariant (R-S01.8)', () => {
  it('serves the stale first-match until clearCache, then routes to the superseding registration', () => {
    const baseline = makeContainer('mp4', true);
    const supersedingSupports = vi.fn((_q: ContainerQuery): boolean => true);
    const superseding: ContainerDriver = {
      ...baseline.driver,
      supports: supersedingSupports,
      // A strictly wider capability surface (optional `probe`) supersedes the same id in place.
      probe: () => Promise.resolve([]),
      capabilities: ['probe'],
    };
    const registry = new Registry();
    registry.addContainer(baseline.driver);
    const router = new Router({ registry });

    expect(router.pickContainer(demuxQuery)).toBe(baseline.driver); // cached first match

    registry.addContainer(superseding);
    // Without clearCache the stale verdict keeps winning — this is why every registration path in the
    // engine (`use()`, default-bundle loads) must call clearCache().
    expect(router.pickContainer(demuxQuery)).toBe(baseline.driver);

    router.clearCache();
    expect(router.pickContainer(demuxQuery)).toBe(superseding); // the new route wins
    expect(supersedingSupports).toHaveBeenCalledTimes(1);
  });
});
