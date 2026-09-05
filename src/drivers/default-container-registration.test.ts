import { describe, expect, it, vi } from 'vitest';
import { createMedia } from '../api/create-media.ts';
import { toMediaInfo } from '../api/probe-media-info.ts';
import { Registry } from '../kernel/registry.ts';
import { Router } from '../kernel/router.ts';
import { fromBytes } from '../sources/source.ts';
import { loadFixture } from '../test-support/corpus.ts';
import {
  SELECTIVE_CONTAINERS,
  registerDefaultContainerForQuery,
} from './default-container-registration.ts';
import { Mp4Driver } from './mp4/mp4-driver.ts';
import { MP4_LAZY_CONTAINER_SPEC } from './mp4/mp4-lazy-driver.ts';
import { WAV_LAZY_CONTAINER_SPEC } from './wav/wav-lazy-driver.ts';

describe('query-selective default container registration', () => {
  it.each([
    ['audio/wav', 'wav'],
    ['audio/x-wav; codecs=1', 'wav'],
    ['audio/ogg', 'ogg'],
    ['audio/opus', 'ogg'],
    ['audio/mpeg', 'mp3'],
    ['audio/aac', 'adts'],
    ['audio/aiff', 'aiff'],
    ['audio/x-caf', 'caf'],
  ] as const)('registers only the exact hinted family for %s', async (mime, id) => {
    const registry = new Registry();
    await expect(
      registerDefaultContainerForQuery(registry, { direction: 'demux', mime }),
    ).resolves.toBe(true);
    expect(registry.containers().map((driver) => driver.id)).toEqual([id]);
    expect(registry.codecs()).toHaveLength(0);
    expect(registry.filters()).toHaveLength(0);
    expect(registry.imageOps()).toBeUndefined();
  });

  it.each([
    ['WAVE', 'wav'],
    ['oga', 'ogg'],
    ['MP3', 'mp3'],
    ['adts', 'adts'],
    ['aifc', 'aiff'],
    ['caff', 'caf'],
  ] as const)('registers only the exact extension family for %s', async (extension, id) => {
    const registry = new Registry();
    expect(await registerDefaultContainerForQuery(registry, { direction: 'mux', extension })).toBe(
      true,
    );
    expect(registry.containers().map((driver) => driver.id)).toEqual([id]);
  });

  it.each([
    ['mp4', 'mp4-mux'],
    ['MOV', 'mp4-mux'],
    ['webm', 'webm-mux'],
    ['MKV', 'webm-mux'],
    ['mka', 'webm-mux'],
  ] as const)('registers only the definite mux family for %s', async (extension, id) => {
    const registry = new Registry();
    await expect(
      registerDefaultContainerForQuery(registry, { direction: 'mux', extension }),
    ).resolves.toBe(true);
    expect(registry.containers().map((driver) => driver.id)).toEqual([id]);
    expect(registry.codecs()).toHaveLength(0);
    expect(registry.filters()).toHaveLength(0);
    expect(registry.imageOps()).toBeUndefined();
  });

  it.each([
    ['mp4', 'mp4'],
    ['mov', 'mp4'],
    ['m4a', 'mp4'],
    ['webm', 'webm'],
    ['mkv', 'webm'],
    ['mka', 'webm'],
  ] as const)(
    'selects the %s demux module without loading the full fallback',
    async (extension, id) => {
      const registry = new Registry();
      await expect(
        registerDefaultContainerForQuery(registry, { direction: 'demux', extension }),
      ).resolves.toBe(true);
      expect(registry.containers().map((driver) => driver.id)).toEqual([id]);
      expect(registry.codecs()).toHaveLength(0);
      expect(registry.filters()).toHaveLength(0);
      expect(registry.imageOps()).toBeUndefined();
    },
  );

  it('declines ambiguous and unknown queries without mutating the registry', async () => {
    for (const query of [
      { direction: 'demux' as const },
      { direction: 'demux' as const, mime: 'application/octet-stream' },
      { direction: 'mux' as const, extension: 'unknown' },
      { direction: 'demux' as const, head: new Uint8Array([1, 2, 3, 4]) },
    ]) {
      const registry = new Registry();
      expect(await registerDefaultContainerForQuery(registry, query)).toBe(false);
      expect(registry.containers()).toHaveLength(0);
    }
  });

  it('honors a known first-party pin and declines an unknown pin', async () => {
    const pinned = new Registry();
    expect(
      await registerDefaultContainerForQuery(
        pinned,
        { direction: 'demux', mime: 'audio/ogg' },
        'wav',
      ),
    ).toBe(true);
    expect(pinned.containers().map((driver) => driver.id)).toEqual(['wav']);

    const unknown = new Registry();
    expect(
      await registerDefaultContainerForQuery(
        unknown,
        { direction: 'demux', mime: 'audio/wav' },
        'third-party',
      ),
    ).toBe(false);
    expect(unknown.containers()).toHaveLength(0);
  });

  it('every selective spec id equals the id its load() actually registers (pin truth)', async () => {
    for (const spec of SELECTIVE_CONTAINERS) {
      const registry = new Registry();
      (await spec.load()).register(registry);
      expect(registry.containers().map((driver) => driver.id)).toContain(spec.id);
    }
  });

  it('resolves a pin on the real mux driver id through selective registration', async () => {
    const registry = new Registry();
    const query = { direction: 'mux', extension: 'mp4' } as const;
    await expect(registerDefaultContainerForQuery(registry, query, 'mp4-mux')).resolves.toBe(true);
    expect(registry.containers().map((driver) => driver.id)).toEqual(['mp4-mux']);
    const picked = new Router({ registry }).pickContainer(query, { pinDriver: 'mp4-mux' });
    expect(picked.id).toBe('mp4-mux');
  });

  it('keeps selective output-container pins scoped to their query direction', async () => {
    const mux = new Registry();
    await expect(
      registerDefaultContainerForQuery(mux, { direction: 'mux', extension: 'webm' }, 'webm-mux'),
    ).resolves.toBe(true);
    expect(mux.containers().map((driver) => driver.id)).toEqual(['webm-mux']);

    // A pin naming the full driver on a mux query declines the mux-only module (their ids differ
    // now); the caller falls back to the complete defaults, where the full driver satisfies the pin.
    const fullPinOnMux = new Registry();
    await expect(
      registerDefaultContainerForQuery(
        fullPinOnMux,
        { direction: 'mux', extension: 'webm' },
        'webm',
      ),
    ).resolves.toBe(false);
    expect(fullPinOnMux.containers()).toHaveLength(0);

    const demux = new Registry();
    await expect(
      registerDefaultContainerForQuery(demux, { direction: 'demux', extension: 'webm' }, 'webm'),
    ).resolves.toBe(true);
    expect(demux.containers().map((driver) => driver.id)).toEqual(['webm']);
  });

  it('is idempotent for repeated and concurrent registration', async () => {
    const registry = new Registry();
    const query = { direction: 'demux' as const, mime: 'audio/wav' };
    await Promise.all([
      registerDefaultContainerForQuery(registry, query),
      registerDefaultContainerForQuery(registry, query),
      registerDefaultContainerForQuery(registry, query),
    ]);
    expect(registry.containers().map((driver) => driver.id)).toEqual(['wav']);
  });

  it('selective WAV registration probes without resolving the full driver', async () => {
    const fullLoad = vi.spyOn(WAV_LAZY_CONTAINER_SPEC, 'load');
    try {
      const registry = new Registry();
      await expect(
        registerDefaultContainerForQuery(registry, {
          direction: 'demux',
          mime: 'audio/wav',
        }),
      ).resolves.toBe(true);
      const driver = registry.containers()[0];
      const probe = driver?.probe;
      if (driver === undefined || probe === undefined) {
        throw new Error('selective WAV registration must expose a probe-capable driver');
      }
      const bytes = await loadFixture('speech.wav');
      await expect(
        probe.call(driver, fromBytes(bytes, { mime: 'audio/wav' })),
      ).resolves.toMatchObject([{ mediaType: 'audio', codec: 'pcm-s16' }]);
      expect(fullLoad).not.toHaveBeenCalled();
    } finally {
      fullLoad.mockRestore();
    }
  });

  it('keeps public typed-Blob MP4 probe on the selective light path and loads once on decline', async () => {
    const fullLoad = vi.spyOn(MP4_LAZY_CONTAINER_SPEC, 'load');
    const media = createMedia();
    try {
      const bytes = await loadFixture('movie_5.mp4');
      const source = fromBytes(bytes, { mime: 'video/mp4' });
      const expectedTracks = await Mp4Driver.probe?.(source);
      const expected = toMediaInfo(Mp4Driver, expectedTracks ?? [], source);
      const actual = await media.probe(new Blob([bytes.slice().buffer], { type: 'video/mp4' }));
      expect(actual).toEqual(expected);
      expect(fullLoad).not.toHaveBeenCalled();

      const quickTime = await loadFixture('bear-rotate-90.mp4');
      await expect(
        media.probe(new Blob([quickTime.slice().buffer], { type: 'video/quicktime' })),
      ).resolves.toMatchObject({ container: 'mp4' });
      expect(fullLoad).toHaveBeenCalledTimes(1);
    } finally {
      fullLoad.mockRestore();
      await media.dispose();
    }
  });
});
