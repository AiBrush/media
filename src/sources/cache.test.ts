/**
 * Validation for the caching / preload source layer ({@link cacheSource}) — the proof that it (a) returns
 * **bit-identical** bytes vs the real file for full reads and arbitrary range reads (incl. past-EOF, which
 * must clamp), and (b) serves a second read of an already-fetched region **from cache without re-fetching**
 * (the recording fetch must be called exactly once). The subject is a **real corpus file** read through a
 * mock `fetch` that behaves like a conformant range server backed by the file's actual bytes — never a
 * synthetic oracle (BUILD_INSTRUCTIONS §6, ADR-018).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadFixture } from '../test-support/corpus.ts';
import { cacheSource } from './cache.ts';
import { fromBytes } from './source.ts';

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

describe('cacheSource — wrapping non-URL sources (no network)', () => {
  it('caches over an in-memory bytes source and serves ranges + full stream bit-exactly', async () => {
    const truth = await loadFixture(FIXTURE);
    const src = cacheSource(fromBytes(truth));
    expect(src.size).toBe(truth.byteLength); // size known immediately from the bytes source
    expectBytesEqual(await src.range(10, 50), truth.subarray(10, 50));
    expectBytesEqual(await readAll(src.stream()), truth);
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
});
