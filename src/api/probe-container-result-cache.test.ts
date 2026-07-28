import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ContainerDriver,
  DRIVER_API_VERSION,
  type DriverModule,
  type TrackInfo,
} from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { SELECTIVE_CONTAINERS } from '../drivers/default-container-registration.ts';
import {
  SOURCE_CACHE_KEY,
  SOURCE_STREAM_STATE,
  SOURCE_URL_KEY,
  type Source,
  type StreamSourceState,
} from '../sources/source.ts';
import { createMedia } from './create-media.ts';
import type { CallOptions, Cancellable, Container, MediaInfo } from './types.ts';

interface ProbeState {
  calls: number;
  failures: number;
  gate?: Promise<void>;
  readRange?: boolean;
}

const TRACKS: readonly TrackInfo[] = [
  {
    id: 7,
    mediaType: 'audio',
    codec: 'mp3',
    durationSec: 1.25,
    config: { codec: 'mp3', sampleRate: 44100, numberOfChannels: 2 },
  },
];

function probeModule(state: ProbeState): DriverModule {
  const driver: ContainerDriver = {
    id: 'finite-blob-probe',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp3', 'aac'],
    supports: (query) => query.extension === 'mp3' || query.extension === 'aac',
    probe: async (source) => {
      state.calls++;
      if (state.failures > 0) {
        state.failures--;
        throw new Error('intentional probe failure');
      }
      if (state.readRange) await source.range?.(0, 1);
      await state.gate;
      return TRACKS;
    },
    demux: () => {
      throw new Error('probe hook must be used');
    },
    createMuxer: () => {
      throw new Error('unused');
    },
  };
  return {
    apiVersion: DRIVER_API_VERSION,
    register: (registry) => registry.addContainer(driver),
  };
}

interface BlobSourceOptions {
  readonly href?: string;
  readonly size?: number;
  readonly mime?: string;
  readonly filename?: string;
  readonly kind?: Source['kind'];
  readonly cacheKey?: string;
}

function finiteBlobSource(options: BlobSourceOptions = {}): Source {
  const href = options.href ?? 'blob:https://example.test/stable-object';
  const cacheKey = options.cacheKey ?? href;
  const size = options.size ?? 128;
  const mime = options.mime ?? 'audio/mpeg';
  const filename = options.filename ?? 'clip.mp3';
  return {
    __media: 'source',
    kind: options.kind ?? 'url',
    size,
    mimeHint: mime,
    filename,
    [SOURCE_CACHE_KEY]: cacheKey,
    [SOURCE_URL_KEY]: href,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.close();
        },
      }),
    range: (_start, _end, signal) => {
      if (signal?.aborted) return Promise.reject(new MediaError('aborted', 'aborted'));
      return Promise.resolve(new Uint8Array());
    },
  };
}

function withDelayedCleanup(source: Source, onStart: () => void, cleanup: Promise<void>): Source {
  const readable = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.close();
    },
  });
  const state: StreamSourceState = {
    readable,
    consumed: true,
    cursor: {
      peek: () => Promise.resolve(new Uint8Array()),
      open: () => readable,
      cancel: async () => {
        onStart();
        await cleanup;
      },
    },
  };
  return { ...source, [SOURCE_STREAM_STATE]: state } as Source & {
    readonly [SOURCE_STREAM_STATE]: StreamSourceState;
  };
}

function probe(
  media: ReturnType<typeof createMedia>,
  source: Source,
  container: Container = 'mp3',
  options: CallOptions = {},
): Cancellable<MediaInfo> {
  return (
    media as unknown as {
      probeContainer(
        input: Source,
        token: Container,
        callOptions?: CallOptions,
      ): Cancellable<MediaInfo>;
    }
  ).probeContainer(source, container, options);
}

function genericProbe(
  media: ReturnType<typeof createMedia>,
  source: Source,
  options: CallOptions = {},
): Cancellable<MediaInfo> {
  return media.probe(source, options);
}

describe('finite blob probe result cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses one successful result across fresh snapshots within the same engine', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));

    const first = await probe(media, finiteBlobSource());
    const second = await probe(media, finiteBlobSource());

    expect(state.calls).toBe(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.tracks).not.toBe(first.tracks);
  });

  it('reuses generic probe results without aliasing the targeted operation', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));

    await genericProbe(media, finiteBlobSource());
    await genericProbe(media, finiteBlobSource());
    await probe(media, finiteBlobSource());
    await probe(media, finiteBlobSource());

    expect(state.calls).toBe(2);
  });

  it('separates every source and execution fact that can change probe semantics', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    const baseline = finiteBlobSource();
    await probe(media, baseline);

    await probe(media, finiteBlobSource({ href: 'blob:https://example.test/stable-object?rev=2' }));
    await probe(media, finiteBlobSource({ size: 129 }));
    await probe(media, finiteBlobSource({ mime: 'audio/x-mpeg' }));
    await probe(media, finiteBlobSource({ filename: 'renamed.mp3' }));
    await probe(media, finiteBlobSource(), 'aac');
    await probe(media, finiteBlobSource(), 'mp3', {
      strategy: { determinism: 'force-software' },
    });
    await probe(media, finiteBlobSource(), 'mp3', {
      strategy: { pinDriver: 'finite-blob-probe' },
    });
    await probe(media, finiteBlobSource());

    expect(state.calls).toBe(8);
  });

  it('owns the stored snapshot and defensively clones every cache hit', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));

    const first = await probe(media, finiteBlobSource());
    first.container = 'poisoned';
    first.durationSec = 999;
    const firstTrack = first.tracks[0];
    expect(firstTrack).toBeDefined();
    if (firstTrack !== undefined) firstTrack.codec = 'poisoned';
    first.tracks.push({
      id: 99,
      type: 'other',
      codec: 'poisoned',
    });

    const second = await probe(media, finiteBlobSource());
    expect(second).toEqual({
      container: 'mp3',
      durationSec: 1.25,
      sizeBytes: 128,
      tracks: [
        {
          id: 7,
          type: 'audio',
          codec: 'mp3',
          durationSec: 1.25,
          sampleRate: 44100,
          channels: 2,
        },
      ],
    } satisfies MediaInfo);

    const secondTrack = second.tracks[0];
    expect(secondTrack).toBeDefined();
    if (secondTrack !== undefined) secondTrack.codec = 'also-poisoned';
    expect((await probe(media, finiteBlobSource())).tracks[0]?.codec).toBe('mp3');
    expect(state.calls).toBe(1);
  });

  it('expires entries after the bounded absolute lifetime', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    await probe(media, finiteBlobSource());

    vi.advanceTimersByTime(249);
    await probe(media, finiteBlobSource());
    expect(state.calls).toBe(1);

    vi.advanceTimersByTime(1);
    await probe(media, finiteBlobSource());
    expect(state.calls).toBe(2);
  });

  it('rejects an expired hit even when the expiry timer has not run', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    await probe(media, finiteBlobSource());
    expect(vi.getTimerCount()).toBe(1);

    const deadline = Date.now() + 250;
    const now = vi.spyOn(Date, 'now').mockReturnValue(deadline);
    try {
      await probe(media, finiteBlobSource());
    } finally {
      now.mockRestore();
    }

    expect(state.calls).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps at most eight entries and uses recent access as the eviction order', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    const source = (index: number): Source =>
      finiteBlobSource({ href: `blob:https://example.test/object-${index}` });

    for (let index = 0; index < 8; index++) await probe(media, source(index));
    await probe(media, source(0));
    await probe(media, source(8));
    expect(state.calls).toBe(9);

    await probe(media, source(0));
    expect(state.calls).toBe(9);
    await probe(media, source(1));
    expect(state.calls).toBe(10);
  });

  it('never caches failures, but caches the later successful retry', async () => {
    const state = { calls: 0, failures: 1 };
    const media = createMedia().use(probeModule(state));

    await expect(probe(media, finiteBlobSource())).rejects.toThrow('intentional probe failure');
    await expect(probe(media, finiteBlobSource())).resolves.toMatchObject({ container: 'mp3' });
    await expect(probe(media, finiteBlobSource())).resolves.toMatchObject({ container: 'mp3' });
    expect(state.calls).toBe(2);
  });

  it('rejects a pre-aborted cache hit and preserves the Cancellable surface', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    await probe(media, finiteBlobSource());
    const controller = new AbortController();
    controller.abort('stop');

    const hit = probe(media, finiteBlobSource(), 'mp3', { signal: controller.signal });
    expect(typeof hit.cancel).toBe('function');
    await expect(hit).rejects.toMatchObject({ code: 'aborted' });
    hit.cancel();
    expect(state.calls).toBe(1);
  });

  it.each(['generic', 'targeted'] as const)(
    'rejects a %s driver success observed after cancellation and never caches it',
    async (operation) => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state: ProbeState = { calls: 0, failures: 0, gate };
      const media = createMedia().use(probeModule(state));
      const run = (): Cancellable<MediaInfo> =>
        operation === 'generic'
          ? genericProbe(media, finiteBlobSource())
          : probe(media, finiteBlobSource());

      const cancelled = run();
      while (state.calls === 0) await Promise.resolve();
      cancelled.cancel();
      release?.();

      await expect(cancelled).rejects.toMatchObject({ code: 'aborted' });
      expect(vi.getTimerCount()).toBe(0);

      state.gate = Promise.resolve();
      await expect(run()).resolves.toMatchObject({ container: 'mp3' });
      await expect(run()).resolves.toMatchObject({ container: 'mp3' });
      expect(state.calls).toBe(2);
    },
  );

  it.each(['generic', 'targeted'] as const)(
    'lets %s cancellation during delayed source cleanup win before any cache store',
    async (operation) => {
      let signalCleanupStarted: (() => void) | undefined;
      const cleanupStarted = new Promise<void>((resolve) => {
        signalCleanupStarted = resolve;
      });
      let releaseCleanup: (() => void) | undefined;
      const cleanup = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const state: ProbeState = { calls: 0, failures: 0 };
      const media = createMedia().use(probeModule(state));
      const run = (source: Source): Cancellable<MediaInfo> =>
        operation === 'generic' ? genericProbe(media, source) : probe(media, source);

      const cancelled = run(
        withDelayedCleanup(finiteBlobSource(), () => signalCleanupStarted?.(), cleanup),
      );
      await cleanupStarted;
      cancelled.cancel();
      releaseCleanup?.();

      await expect(cancelled).rejects.toMatchObject({ code: 'aborted' });
      expect(vi.getTimerCount()).toBe(0);

      await expect(run(finiteBlobSource())).resolves.toMatchObject({ container: 'mp3' });
      await expect(run(finiteBlobSource())).resolves.toMatchObject({ container: 'mp3' });
      expect(state.calls).toBe(2);
    },
  );

  it('invalidates successful facts whenever use() can change routing', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    await probe(media, finiteBlobSource());
    await probe(media, finiteBlobSource());
    expect(state.calls).toBe(1);

    const unrelated: DriverModule = {
      apiVersion: DRIVER_API_VERSION,
      register: () => {},
    };
    media.use(unrelated);
    await probe(media, finiteBlobSource());
    expect(state.calls).toBe(2);
  });

  it('invalidates user-driver facts when generic probing loads default capabilities', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    const options = { strategy: { pinDriver: 'finite-blob-probe' } } satisfies CallOptions;
    await probe(media, finiteBlobSource(), 'mp3', options);
    await probe(media, finiteBlobSource(), 'mp3', options);
    expect(state.calls).toBe(1);

    await genericProbe(
      media,
      finiteBlobSource({
        href: 'blob:https://example.test/default-registration',
        mime: 'application/octet-stream',
      }),
    );
    const callsAfterDefaults = state.calls;
    await probe(media, finiteBlobSource(), 'mp3', options);

    expect(state.calls).toBe(callsAfterDefaults + 1);
  });

  it('invalidates user-driver facts when positive image magic loads default capabilities', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    const options = { strategy: { pinDriver: 'finite-blob-probe' } } satisfies CallOptions;
    await probe(media, finiteBlobSource(), 'mp3', options);
    await probe(media, finiteBlobSource(), 'mp3', options);
    expect(state.calls).toBe(1);

    const truncatedPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const imageCandidate: Source = {
      ...finiteBlobSource({
        href: 'blob:https://example.test/default-image-registration',
        size: truncatedPng.byteLength,
        mime: 'application/octet-stream',
        filename: 'unhinted',
      }),
      range: (start, end) => Promise.resolve(truncatedPng.subarray(start, end)),
    };
    await expect(genericProbe(media, imageCandidate)).rejects.toThrow();

    await probe(media, finiteBlobSource(), 'mp3', options);
    expect(state.calls).toBe(2);
  });

  it('invalidates user-driver facts before query-selective default registration', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    const options = { strategy: { pinDriver: 'finite-blob-probe' } } satisfies CallOptions;
    await probe(media, finiteBlobSource(), 'mp3', options);
    await probe(media, finiteBlobSource(), 'mp3', options);
    expect(state.calls).toBe(1);

    const truncatedWav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    const wavCandidate: Source = {
      ...finiteBlobSource({
        href: 'blob:https://example.test/selective-wav-registration',
        size: truncatedWav.byteLength,
        mime: 'audio/wav',
        filename: 'truncated.wav',
      }),
      range: (start, end) => Promise.resolve(truncatedWav.subarray(start, end)),
    };
    await expect(probe(media, wavCandidate, 'wav')).rejects.toThrow();

    await probe(media, finiteBlobSource(), 'mp3', options);
    expect(state.calls).toBe(2);
  });

  it('invalidates facts at the selective registration mutation after a delayed load', async () => {
    const wavSpec = SELECTIVE_CONTAINERS.find((candidate) => candidate.id === 'wav');
    expect(wavSpec).toBeDefined();
    if (wavSpec === undefined) throw new Error('missing selective WAV registration');

    let releaseLoad!: () => void;
    let observeLoad!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      observeLoad = resolve;
    });
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const originalLoad = wavSpec.load;
    const loadSpy = vi.spyOn(wavSpec, 'load').mockImplementation(async () => {
      observeLoad();
      await loadGate;
      return originalLoad();
    });

    try {
      const state = { calls: 0, failures: 0 };
      const media = createMedia().use(probeModule(state));
      const options = { strategy: { pinDriver: 'finite-blob-probe' } } satisfies CallOptions;
      await probe(media, finiteBlobSource(), 'mp3', options);
      expect(state.calls).toBe(1);

      const truncatedWav = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      ]);
      const wavCandidate: Source = {
        ...finiteBlobSource({
          href: 'blob:https://example.test/delayed-selective-wav-registration',
          size: truncatedWav.byteLength,
          mime: 'audio/wav',
          filename: 'truncated.wav',
        }),
        range: (start, end) => Promise.resolve(truncatedWav.subarray(start, end)),
      };
      const registering = probe(media, wavCandidate, 'wav');
      await loadStarted;

      await probe(media, finiteBlobSource(), 'mp3', options);
      expect(state.calls).toBe(1);

      releaseLoad();
      await expect(registering).rejects.toThrow();
      await probe(media, finiteBlobSource(), 'mp3', options);
      expect(state.calls).toBe(2);
    } finally {
      releaseLoad();
      loadSpy.mockRestore();
    }
  });

  it('does not let an older in-flight success repopulate after use()', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state: ProbeState = { calls: 0, failures: 0, gate };
    const media = createMedia().use(probeModule(state));
    const pending = probe(media, finiteBlobSource());
    while (state.calls === 0) await Promise.resolve();

    media.use({ apiVersion: DRIVER_API_VERSION, register: () => {} });
    release?.();
    await pending;
    state.gate = Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);

    await probe(media, finiteBlobSource());
    expect(state.calls).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('is engine-local and refuses a cached hit after dispose()', async () => {
    const state = { calls: 0, failures: 0 };
    const first = createMedia().use(probeModule(state));
    const second = createMedia().use(probeModule(state));
    await probe(first, finiteBlobSource());
    await probe(second, finiteBlobSource());
    expect(state.calls).toBe(2);

    await first.dispose();
    expect(vi.getTimerCount()).toBe(1);
    expect(() => probe(first, finiteBlobSource())).toThrow(
      expect.objectContaining({ code: 'aborted', message: 'engine disposed' }),
    );
  });

  it('cancels an ordinary URL prefix timer on dispose', async () => {
    const state: ProbeState = { calls: 0, failures: 0, readRange: true };
    const media = createMedia().use(probeModule(state));
    const href = 'https://example.test/ordinary.mp3';

    await genericProbe(media, finiteBlobSource({ href, cacheKey: href }));
    expect(vi.getTimerCount()).toBe(1);

    await media.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bypasses generic, non-url, unknown-size, HLS-plausible, and progress-observed inputs', async () => {
    const state = { calls: 0, failures: 0 };
    const media = createMedia().use(probeModule(state));
    const twice = async (source: () => Source, options: CallOptions = {}): Promise<void> => {
      await probe(media, source(), 'mp3', options);
      await probe(media, source(), 'mp3', options);
    };

    await twice(() =>
      finiteBlobSource({
        href: 'https://example.test/clip.mp3',
        cacheKey: 'https://example.test/clip.mp3',
      }),
    );
    await twice(() => finiteBlobSource({ kind: 'bytes' }));
    await twice(() => {
      const source = finiteBlobSource();
      const { size: _size, ...unknownSize } = source;
      return unknownSize;
    });
    await twice(() => finiteBlobSource({ mime: 'application/octet-stream', filename: 'manifest' }));
    await twice(() => finiteBlobSource(), { onProgress: () => {} });

    expect(state.calls).toBe(10);
  });

  it('does not retroactively admit a result when that probe learns the source size', async () => {
    let learnedSize: number | undefined;
    const base = finiteBlobSource();
    const { size: _size, ...withoutSize } = base;
    const source: Source = {
      ...withoutSize,
      range: (start, end, signal) => {
        if (signal?.aborted) return Promise.reject(new MediaError('aborted', 'aborted'));
        learnedSize = 128;
        Object.defineProperty(source, 'size', {
          configurable: true,
          enumerable: true,
          value: learnedSize,
        });
        return Promise.resolve(new Uint8Array(Math.max(0, end - start)));
      },
    };
    const state: ProbeState = { calls: 0, failures: 0, readRange: true };
    const media = createMedia().use(probeModule(state));

    await probe(media, source);
    expect(learnedSize).toBe(128);
    await probe(media, source);
    expect(state.calls).toBe(2);

    // The second operation entered with an exact size, so its success may now be reused.
    await probe(media, source);
    expect(state.calls).toBe(2);
  });
});
