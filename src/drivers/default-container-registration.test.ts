import { describe, expect, it } from 'vitest';
import { Registry } from '../kernel/registry.ts';
import { registerDefaultContainerForQuery } from './default-container-registration.ts';

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

  it('keeps selective output-container pins scoped to their query direction', async () => {
    const mux = new Registry();
    await expect(
      registerDefaultContainerForQuery(mux, { direction: 'mux', extension: 'webm' }, 'webm'),
    ).resolves.toBe(true);
    expect(mux.containers().map((driver) => driver.id)).toEqual(['webm-mux']);

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
});
