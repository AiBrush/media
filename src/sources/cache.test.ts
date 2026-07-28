/**
 * Validation for the caching / preload source layer ({@link cacheSource}) — the proof that it (a) returns
 * **bit-identical** bytes vs the real file for full reads and arbitrary range reads (incl. past-EOF, which
 * must clamp), and (b) serves a second read of an already-fetched region **from cache without re-fetching**
 * (the recording fetch must be called exactly once). The subject is a **real corpus file** read through a
 * mock `fetch` that behaves like a conformant range server backed by the file's actual bytes — never a
 * synthetic oracle (BUILD_INSTRUCTIONS §6, ADR-018).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { cacheSource } from './cache.ts';
import { type Source, fromBlob, fromBytes } from './source.ts';

/** Drain a readable fully into one contiguous array (test util — distinct from the impl's internal copy). */
async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = s.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Byte-equality with a precise first-divergence message (so a failure pinpoints the bad offset). */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  for (let i = 0; i < expected.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`byte mismatch at ${i}: got ${actual[i]}, expected ${expected[i]}`);
    }
  }
}

/**
 * A conformant HTTP range server backed by `bytes`, exposed as a `fetch` stand-in that records every
 * request. Honors `HEAD` (Content-Length), `Range: bytes=a-b` (→ 206 + Content-Range, exact window), and
 * a bare GET (→ 200 full body). `calls` lets a test assert the exact number of round-trips.
 */
function rangeServer(bytes: Uint8Array): {
  fetch: typeof fetch;
  calls: { method: string; range: string | null }[];
} {
  const calls: { method: string; range: string | null }[] = [];
  const total = bytes.byteLength;
  const fetchImpl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const header = init?.headers as { Range?: string } | undefined;
    const range = header?.Range ?? null;
    calls.push({ method, range });

    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Length': String(total) } });
    }
    if (range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!m) return new Response('bad range', { status: 416 });
      const a = Number(m[1]);
      const bInclusive = Number(m[2]);
      // A real server clamps the end to the last byte and returns only what exists.
      const end = Math.min(bInclusive + 1, total);
      const slice = bytes.subarray(a, Math.max(a, end));
      return new Response(toBody(slice), {
        status: 206,
        headers: { 'Content-Range': `bytes ${a}-${a + slice.byteLength - 1}/${total}` },
      });
    }
    return new Response(toBody(bytes), {
      status: 200,
      headers: { 'Content-Length': String(total) },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** Copy a (possibly `subarray`-backed) view into a fresh `ArrayBuffer` so it is a valid `Response` body. */
function toBody(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer;
}

const URL_HREF = 'https://cdn.example/clip.mp4';
// A real, downloaded corpus file (a small faststart H.264 MP4). Bit-exactness is asserted against *these*
// exact bytes, so the test cannot pass on a synthetic or passthrough stand-in.
const FIXTURE = 'h264.mp4';

describe('cacheSource — bit-exact reads over a real corpus file (URL via mock range server)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('full stream() is byte-identical to the file (and re-readable from cache)', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch, calls } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);

    const src = cacheSource(URL_HREF, { eager: true });
    await src.prime(); // eager: one full download warms the whole cache

    expectBytesEqual(await readAll(src.stream()), truth);
    expectBytesEqual(await readAll(src.stream()), truth); // replayed from cache
    expect(src.size).toBe(truth.byteLength);
    // Exactly one body download total (HEAD may add a metadata-only call; never a second body GET).
    expect(calls.filter((c) => c.method === 'GET').length).toBe(1);
  });

  it('accepts URL objects and can stream without a size-only prime first', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch, calls } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);

    const src = cacheSource(new URL(URL_HREF));
    expectBytesEqual(await readAll(src.stream()), truth);
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('range() returns bit-identical windows at arbitrary offsets/lengths', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = cacheSource(URL_HREF);

    const windows: [number, number][] = [
      [0, 16], // header
      [100, 228], // arbitrary mid window
      [truth.byteLength - 64, truth.byteLength], // trailing 64 bytes (the tail-seek case)
      [1, 2], // single byte
    ];
    for (const [lo, hi] of windows) {
      expectBytesEqual(await src.range(lo, hi), truth.subarray(lo, hi));
    }
  });

  it('clamps a past-EOF range to the real end (never invents bytes)', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = cacheSource(URL_HREF);
    await src.prime(); // learns size via HEAD → can clamp before fetching

    const lo = truth.byteLength - 10;
    expectBytesEqual(await src.range(lo, truth.byteLength + 1000), truth.subarray(lo));
    expect((await src.range(truth.byteLength, truth.byteLength + 50)).byteLength).toBe(0); // at EOF
    expect((await src.range(truth.byteLength + 5, truth.byteLength + 9)).byteLength).toBe(0); // past EOF
  });
});

describe('cacheSource — preload serves the second read from cache (no duplicate fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a repeated identical range is served from cache: fetch body called once', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch, calls } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = cacheSource(URL_HREF);

    const first = await src.range(0, 4096);
    const beforeSecond = calls.filter((c) => c.range !== null).length;
    const second = await src.range(0, 4096); // identical window → must hit cache

    expectBytesEqual(first, truth.subarray(0, 4096));
    expectBytesEqual(second, truth.subarray(0, 4096));
    expect(calls.filter((c) => c.range !== null).length).toBe(beforeSecond); // no extra range fetch
    expect(beforeSecond).toBe(1); // and the first read was a single fetch
  });

  it('a sub-window of an already-cached range is served from cache (no fetch)', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch, calls } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = cacheSource(URL_HREF);

    await src.range(0, 8192); // one fetch
    const after = calls.length;
    const sub = await src.range(1000, 5000); // fully inside [0,8192) → cache
    expectBytesEqual(sub, truth.subarray(1000, 5000));
    expect(calls.length).toBe(after); // zero additional requests
  });

  it('coalesces overlapping ranges and serves the union from cache', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch, calls } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = cacheSource(URL_HREF);

    await src.range(0, 3000);
    await src.range(2000, 6000); // overlaps [0,3000) → coalesced into [0,6000)
    const after = calls.length;
    expectBytesEqual(await src.range(500, 5500), truth.subarray(500, 5500)); // spans both → cache
    expect(calls.length).toBe(after);
    expect(src.cachedBytes).toBe(6000); // one contiguous coalesced interval, not 7000
  });

  it('keeps disjoint cached intervals ordered and coalesces when a later range contains one', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch, calls } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = cacheSource(URL_HREF);

    await src.range(2000, 3000);
    const beforeLeadingRead = calls.length;
    expectBytesEqual(await src.range(0, 100), truth.subarray(0, 100));
    expect(calls.length).toBe(beforeLeadingRead + 1);

    await src.range(0, 5000);
    expect(src.cachedBytes).toBe(5000);
    const afterContainingRead = calls.length;
    expectBytesEqual(await src.range(2500, 2600), truth.subarray(2500, 2600));
    expect(calls.length).toBe(afterContainingRead);
  });

  it('de-duplicates concurrent identical range fetches into one request', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch, calls } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = cacheSource(URL_HREF);

    const [a, b] = await Promise.all([src.range(0, 4096), src.range(0, 4096)]);
    expectBytesEqual(a, truth.subarray(0, 4096));
    expectBytesEqual(b, truth.subarray(0, 4096));
    expect(calls.filter((c) => c.range !== null).length).toBe(1); // single in-flight fetch shared
  });
});

describe('cacheSource — bounded ranged-read retention', () => {
  it('keeps a strict byte ceiling and evicts the least-recently-used interval', async () => {
    const truth = Uint8Array.from({ length: 128 }, (_, index) => index);
    const calls: Array<[number, number]> = [];
    const source: Source = {
      ...fromBytes(truth),
      range(start, end): Promise<Uint8Array> {
        calls.push([start, end]);
        return Promise.resolve(truth.slice(start, end));
      },
    };
    const src = cacheSource(source, { maxBytes: 16 });

    expectBytesEqual(await src.range(0, 8), truth.subarray(0, 8));
    expectBytesEqual(await src.range(32, 40), truth.subarray(32, 40));
    expect(src.cachedBytes).toBe(16);

    // Refresh the leading interval, then make a third disjoint window force the middle one out.
    expectBytesEqual(await src.range(0, 4), truth.subarray(0, 4));
    expectBytesEqual(await src.range(64, 72), truth.subarray(64, 72));
    expect(src.cachedBytes).toBe(16);
    expect(calls).toHaveLength(3);

    expectBytesEqual(await src.range(0, 4), truth.subarray(0, 4));
    expect(calls).toHaveLength(3);
    expectBytesEqual(await src.range(32, 40), truth.subarray(32, 40));
    expect(calls).toHaveLength(4);
    expect(src.cachedBytes).toBeLessThanOrEqual(16);
  });

  it('returns an over-cap window exactly without retaining it', async () => {
    const truth = Uint8Array.from({ length: 64 }, (_, index) => index);
    let calls = 0;
    const source: Source = {
      ...fromBytes(truth),
      range(start, end): Promise<Uint8Array> {
        calls++;
        return Promise.resolve(truth.slice(start, end));
      },
    };
    const src = cacheSource(source, { maxBytes: 8 });

    expectBytesEqual(await src.range(0, 16), truth.subarray(0, 16));
    expect(src.cachedBytes).toBe(0);
    expectBytesEqual(await src.range(0, 16), truth.subarray(0, 16));
    expect(calls).toBe(2);
    expect(src.cachedBytes).toBe(0);
  });

  it('rejects unsafe cache capacities synchronously', () => {
    expect(() => cacheSource(fromBytes(new Uint8Array()), { maxBytes: -1 })).toThrow(RangeError);
    expect(() => cacheSource(fromBytes(new Uint8Array()), { maxBytes: 1.5 })).toThrow(RangeError);
    expect(() =>
      cacheSource(fromBytes(new Uint8Array()), { maxBytes: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(RangeError);
  });
});

describe('cacheSource — AbortSignal forwarding and cancellation', () => {
  it('forwards the exact signal through nested caching wrappers', async () => {
    const truth = await loadFixture(FIXTURE);
    const memory = fromBytes(truth);
    const seen: Array<AbortSignal | undefined> = [];
    const source: Source = {
      ...memory,
      range(start, end, signal): Promise<Uint8Array> {
        seen.push(signal);
        return Promise.resolve(truth.subarray(start, end));
      },
    };
    const src = cacheSource(cacheSource(source));
    const controller = new AbortController();

    expectBytesEqual(await src.range(17, 49, controller.signal), truth.subarray(17, 49));
    expect(seen).toEqual([controller.signal]);
  });

  it('rejects an in-flight read even when the wrapped source ignores cancellation', async () => {
    const truth = await loadFixture(FIXTURE);
    const memory = fromBytes(truth);
    let seen: AbortSignal | undefined;
    const source: Source = {
      ...memory,
      range(_start, _end, signal): Promise<Uint8Array> {
        seen = signal;
        return new Promise<Uint8Array>(() => {});
      },
    };
    const src = cacheSource(source);
    const controller = new AbortController();
    const reason = new MediaError('aborted', 'stop cached read');

    const read = src.range(0, 32, controller.signal);
    expect(seen).toBe(controller.signal);
    controller.abort(reason);

    await expect(read).rejects.toBe(reason);
  });

  it('checks an already-aborted signal before returning a cached hit', async () => {
    const truth = await loadFixture(FIXTURE);
    const memory = fromBytes(truth);
    let calls = 0;
    const source: Source = {
      ...memory,
      range(start, end): Promise<Uint8Array> {
        calls++;
        return Promise.resolve(truth.subarray(start, end));
      },
    };
    const src = cacheSource(source);
    await src.range(0, 32);
    const controller = new AbortController();
    controller.abort(new MediaError('aborted', 'pre-aborted cached read'));

    await expect(src.range(0, 32, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(calls).toBe(1);
  });

  it('forwards the signal to an eager cache’s underlying full-range read', async () => {
    const truth = await loadFixture(FIXTURE);
    const memory = fromBytes(truth);
    const calls: Array<{
      start: number;
      end: number;
      signal: AbortSignal | undefined;
    }> = [];
    const source: Source = {
      ...memory,
      range(start, end, signal): Promise<Uint8Array> {
        calls.push({ start, end, signal });
        return Promise.resolve(truth.subarray(start, end));
      },
    };
    const src = cacheSource(source, { eager: true });
    const controller = new AbortController();

    expectBytesEqual(await src.range(17, 49, controller.signal), truth.subarray(17, 49));
    expect(calls).toEqual([{ start: 0, end: truth.byteLength, signal: controller.signal }]);
  });

  it('isolates eager callers with different signals', async () => {
    const truth = await loadFixture(FIXTURE);
    const memory = fromBytes(truth);
    const requests: Array<{
      signal: AbortSignal | undefined;
      resolve: (bytes: Uint8Array) => void;
    }> = [];
    const source: Source = {
      ...memory,
      range(_start, _end, signal): Promise<Uint8Array> {
        return new Promise<Uint8Array>((resolve) => requests.push({ signal, resolve }));
      },
    };
    const src = cacheSource(source, { eager: true });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = src.range(0, 32, firstController.signal);
    const second = src.range(0, 32, secondController.signal);
    expect(requests.map((request) => request.signal)).toEqual([
      firstController.signal,
      secondController.signal,
    ]);

    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: 'aborted' });
    requests[1]?.resolve(truth.subarray(0, 32));
    expectBytesEqual(await second, truth.subarray(0, 32));
  });

  it('aborts a hanging URL size probe during prime()', async () => {
    let fetchSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal('fetch', ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchSignal = init?.signal;
      markFetchStarted?.();
      return new Promise<Response>(() => {});
    }) as typeof fetch);
    try {
      const src = cacheSource('https://example.test/hanging.mp4');
      const controller = new AbortController();
      const prime = src.prime(undefined, controller.signal);
      await fetchStarted;
      expect(fetchSignal).toBe(controller.signal);
      controller.abort(new MediaError('aborted', 'stop prime'));
      await expect(prime).rejects.toMatchObject({ code: 'aborted' });
      expect(src.cachedBytes).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not insert a late eager full read after its caller aborts', async () => {
    const truth = await loadFixture(FIXTURE);
    let resolveRead: ((bytes: Uint8Array) => void) | undefined;
    const source: Source = {
      ...fromBytes(truth),
      range(): Promise<Uint8Array> {
        return new Promise<Uint8Array>((resolve) => {
          resolveRead = resolve;
        });
      },
    };
    const src = cacheSource(source, { eager: true });
    const controller = new AbortController();
    const read = src.range(0, 32, controller.signal);
    controller.abort(new MediaError('aborted', 'stop late eager read'));
    await expect(read).rejects.toMatchObject({ code: 'aborted' });
    resolveRead?.(truth);
    await Promise.resolve();
    await Promise.resolve();
    expect(src.cachedBytes).toBe(0);
  });

  it('cancels a range-less sequential stream when its signalled materialization aborts', async () => {
    let cancels = 0;
    let cancelReason: unknown;
    const source: Source = {
      __media: 'source',
      kind: 'stream',
      stream(): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(Uint8Array.of(1, 2, 3));
          },
          cancel(reason): void {
            cancels++;
            cancelReason = reason;
          },
        });
      },
    };
    const src = cacheSource(source);
    const controller = new AbortController();
    const reason = new MediaError('aborted', 'stop sequential cache read');
    const read = src.range(0, 32, controller.signal);
    await Promise.resolve();
    controller.abort(reason);
    await expect(read).rejects.toBe(reason);
    expect(cancels).toBe(1);
    expect(cancelReason).toBe(reason);
    expect(src.cachedBytes).toBe(0);
  });
});

describe('cacheSource — wrapping non-URL sources (no network)', () => {
  it('caches over an in-memory bytes source and serves ranges + full stream bit-exactly', async () => {
    const truth = await loadFixture(FIXTURE);
    const src = cacheSource(fromBytes(truth));
    expect(src.size).toBe(truth.byteLength); // size known immediately from the bytes source
    expectBytesEqual(await src.range(10, 50), truth.subarray(10, 50));
    expectBytesEqual(await readAll(src.stream()), truth);
  });

  it('preserves known Blob metadata and handles empty eager sources', async () => {
    const truth = await loadFixture(FIXTURE);
    const file = new File([truth], 'clip.mp4', { type: 'video/mp4' });
    const fileSource = cacheSource(fromBlob(file));
    expect(fileSource.mimeHint).toBe('video/mp4');
    expect(fileSource.filename).toBe('clip.mp4');
    await fileSource.prime();
    expectBytesEqual(await fileSource.range(0, 32), truth.subarray(0, 32));

    const empty = cacheSource(fromBytes(new Uint8Array()), { eager: true });
    await empty.prime();
    expect(empty.cachedBytes).toBe(0);
    expect((await empty.range(0, 10)).byteLength).toBe(0);
  });

  it('materializes a range-less stream source once, then serves all ranges + re-reads from cache', async () => {
    const truth = await loadFixture(FIXTURE);
    let consumptions = 0;
    const streamSource = {
      __media: 'source' as const,
      kind: 'stream' as const,
      stream: (): ReadableStream<Uint8Array> => {
        consumptions++;
        return new ReadableStream<Uint8Array>({
          start(c): void {
            // Emit in two chunks to exercise the drain/concat path.
            c.enqueue(truth.subarray(0, truth.byteLength >> 1));
            c.enqueue(truth.subarray(truth.byteLength >> 1));
            c.close();
          },
        });
      },
      // no range() — the cache must materialize via stream() exactly once.
    };
    const src = cacheSource(streamSource);

    expectBytesEqual(await src.range(0, 32), truth.subarray(0, 32));
    expectBytesEqual(await src.range(truth.byteLength - 16, truth.byteLength), truth.subarray(-16));
    expectBytesEqual(await readAll(src.stream()), truth); // replayed from the materialized buffer
    expect(consumptions).toBe(1); // the single-use stream was consumed exactly once
    expect(src.size).toBe(truth.byteLength); // size discovered on materialization
  });

  it('materializes an unknown-length stream once for a past-EOF range and returns no invented bytes', async () => {
    const truth = await loadFixture(FIXTURE);
    let consumptions = 0;
    const src = cacheSource({
      __media: 'source',
      kind: 'stream',
      stream: (): ReadableStream<Uint8Array> => {
        consumptions++;
        return new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(truth);
            c.close();
          },
        });
      },
    });

    expect((await src.range(truth.byteLength + 5, truth.byteLength + 9)).byteLength).toBe(0);
    expect(consumptions).toBe(1);
    expect(src.size).toBe(truth.byteLength);
  });

  it('replays an in-flight full materialization when stream() is requested concurrently', async () => {
    const truth = await loadFixture(FIXTURE);
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let consumptions = 0;
    const src = cacheSource({
      __media: 'source',
      kind: 'stream',
      stream: (): ReadableStream<Uint8Array> => {
        consumptions++;
        return new ReadableStream<Uint8Array>({
          async start(c): Promise<void> {
            await hold;
            c.enqueue(truth);
            c.close();
          },
        });
      },
    });

    const rangeRead = src.range(0, 4);
    const streamed = readAll(src.stream());
    release?.();

    expectBytesEqual(await rangeRead, truth.subarray(0, 4));
    expectBytesEqual(await streamed, truth);
    expect(consumptions).toBe(1);
  });
});
