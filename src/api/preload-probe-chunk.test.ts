import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('./probe-runner.ts');
  vi.resetModules();
});

describe('probe operation preload', () => {
  it('loads the lazy probe runner before the first visible probe', async () => {
    let moduleLoads = 0;
    const runProbe = vi.fn(async () => ({
      container: 'preloaded-probe',
      durationSec: 0,
      tracks: [],
    }));
    vi.resetModules();
    vi.doMock('./probe-runner.ts', () => {
      moduleLoads++;
      return { runProbe, runProbeContainer: runProbe };
    });
    const { createMedia } = await import('./create-media.ts');
    const media = createMedia();
    try {
      expect(moduleLoads).toBe(0);
      await media.preload({ op: 'probe', container: 'wav', level: 'chunks' });
      expect(moduleLoads).toBe(1);

      await expect(media.probe(new Uint8Array([1]))).resolves.toEqual({
        container: 'preloaded-probe',
        durationSec: 0,
        tracks: [],
      });
      expect(moduleLoads).toBe(1);
      expect(runProbe).toHaveBeenCalledTimes(1);
    } finally {
      await media.dispose();
    }
  });
});
