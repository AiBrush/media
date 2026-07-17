/**
 * Source read-contract conformance (docs/architecture/sources.md §3.1 + §5 items 1/2/6/8/11):
 * the learned `rangesHonored` fact, `AbortSignal` threading through `range()`/`readAll()`,
 * the "range never short-reads before EOF" contract across every constructor, the owned
 * `readAll` fast paths that bypass stream readers entirely, and initial-fetch teardown when a
 * URL stream is cancelled before its first chunk. Oracles are bit-exact against a real fixture.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputError, MediaError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import {
  type Source,
  fromBlob,
  fromBytes,
  fromElement,
  fromOPFS,
  fromURL,
  peekSourceHead,
} from './source.ts';

const HREF = 'https://cdn.test/clip.mp4';
const FIXTURE = 'h264.mp4';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Copy a (possibly `subarray`-backed) view into a fresh `ArrayBuffer` for a `Response` body. */
function toBody(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer;
}

function rangeOf(
  src: Source,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const range = src.range;
  if (range === undefined) throw new Error('expected source to support range()');
  return range.call(src, start, end, signal);
}

/** Independent oracle drain (deliberately not the library's own helper). */
async function drainLocal(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Byte-equality with a precise first-divergence message. */
function expectBytesEqual(actual: Uint8Array | undefined, expected: Uint8Array): void {
  if (actual === undefined) throw new Error('expected bytes, got undefined');
  expect(actual.byteLength).toBe(expected.byteLength);
  for (let i = 0; i < expected.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`byte mismatch at ${i}: got ${actual[i]}, expected ${expected[i]}`);
    }
  }
}

interface RecordedCall {
  readonly method: string;
  readonly range: string | null;
  readonly init: RequestInit | undefined;
}

/** RFC 9110-conformant range server over real bytes (206 window / clamped end / 416 past EOF). */
function conformantServer(bytes: Uint8Array): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const total = bytes.byteLength;
  const fetchImpl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const header = init?.headers as { Range?: string } | undefined;
    const range = header?.Range ?? null;
    calls.push({ method, range, init });
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Length': String(total) } });
    }
    if (range !== null) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!m) return new Response('bad range', { status: 416 });
      const a = Number(m[1]);
      if (a >= total) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }
      const end = Math.min(Number(m[2]) + 1, total); // a real server clamps the end to EOF
      const slice = bytes.subarray(a, end);
      return new Response(toBody(slice), {
        status: 206,
        headers: { 'Content-Range': `bytes ${a}-${end - 1}/${total}` },
      });
    }
    return new Response(toBody(bytes), {
      status: 200,
      headers: { 'Content-Length': String(total) },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** A server that ignores `Range` entirely and always answers `200` with the whole body. */
function rangeIgnoringServer(bytes: Uint8Array): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const header = init?.headers as { Range?: string } | undefined;
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      range: header?.Range ?? null,
      init,
    });
    return new Response(toBody(bytes), {
      status: 200,
      headers: { 'Content-Length': String(bytes.byteLength) },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** A fetch that never settles on its own but records the init it was handed. */
function hangingFetch(): { fetch: typeof fetch; inits: (RequestInit | undefined)[] } {
  const inits: (RequestInit | undefined)[] = [];
  const fetchImpl = ((_input: unknown, init?: RequestInit): Promise<Response> => {
    inits.push(init);
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  return { fetch: fetchImpl, inits };
}

afterEach(() => vi.unstubAllGlobals());

// ── Item 1: the learned range-compliance fact ────────────────────────────────────────────────────

describe('rangesHonored — learned range-compliance fact (RFC 9110 §14)', () => {
  it('still returns the exact window and reports rangesHonored=false on a 200-to-Range server', async () => {
    const truth = Uint8Array.from({ length: 32 }, (_v, i) => i * 3);
    const { fetch } = rangeIgnoringServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);

    expect(src.rangesHonored).toBeUndefined(); // no transport evidence before the first read
    expectBytesEqual(await rangeOf(src, 4, 8), truth.subarray(4, 8)); // graceful local slice
    expect(src.rangesHonored).toBe(false);
    expect(src.size).toBe(truth.byteLength); // learned from the full body
  });

  it('reports rangesHonored=true on a compliant 206 server (real fixture)', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch } = conformantServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);

    expectBytesEqual(await rangeOf(src, 0, 16), truth.subarray(0, 16));
    expect(src.rangesHonored).toBe(true);
  });

  it('is sticky: one ignored Range disqualifies range planning even after a later 206', async () => {
    const truth = Uint8Array.from({ length: 64 }, (_v, i) => i);
    const honoring = conformantServer(truth).fetch;
    const ignoring = rangeIgnoringServer(truth).fetch;
    let active = honoring;
    vi.stubGlobal('fetch', ((input: unknown, init?: RequestInit) =>
      active(input as string, init)) as typeof fetch);
    const src = fromURL(HREF);

    expectBytesEqual(await rangeOf(src, 0, 8), truth.subarray(0, 8));
    expect(src.rangesHonored).toBe(true);
    active = ignoring;
    expectBytesEqual(await rangeOf(src, 8, 16), truth.subarray(8, 16));
    expect(src.rangesHonored).toBe(false);
    active = honoring;
    expectBytesEqual(await rangeOf(src, 16, 24), truth.subarray(16, 24));
    expect(src.rangesHonored).toBe(false); // never trusted again
  });
});

// ── Item 2: AbortSignal threading through range()/readAll() ─────────────────────────────────────

describe('range(start, end, signal) — cancellation is threaded into the transport', () => {
  it('rejects an in-flight URL range read with a typed MediaError and hands fetch the caller signal', async () => {
    const { fetch, inits } = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);
    const controller = new AbortController();

    const read = rangeOf(src, 0, 16, controller.signal);
    controller.abort();
    await expect(read).rejects.toBeInstanceOf(MediaError);
    await expect(read).rejects.toMatchObject({ code: 'aborted' });
    expect(inits[0]?.signal).toBe(controller.signal); // the transport got the exact caller signal
  });

  it('rejects immediately on an already-aborted signal without issuing a fetch', async () => {
    const { fetch, inits } = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);
    const controller = new AbortController();
    controller.abort(new MediaError('aborted', 'pre-aborted'));

    await expect(rangeOf(src, 0, 16, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(inits).toHaveLength(0);
  });

  it('bytes and blob ranges honor an aborted signal with a typed error', async () => {
    const controller = new AbortController();
    controller.abort();
    const five = Uint8Array.of(0, 1, 2, 3, 4);

    await expect(rangeOf(fromBytes(five), 0, 2, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    await expect(
      rangeOf(fromBlob(new Blob([five])), 0, 2, controller.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
    expectBytesEqual(
      await rangeOf(fromBytes(five), 1, 3, new AbortController().signal),
      five.subarray(1, 3),
    );
  });

  it('peekSourceHead forwards its signal into the underlying ranged fetch', async () => {
    const { fetch, inits } = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);
    const controller = new AbortController();

    const peek = peekSourceHead(src, 16, controller.signal);
    controller.abort();
    await expect(peek).rejects.toMatchObject({ code: 'aborted' });
    expect(inits[0]?.signal).toBe(controller.signal);
  });

  it('rejects an in-flight URL readAll with a typed MediaError on abort', async () => {
    const { fetch } = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);
    const controller = new AbortController();

    const read = src.readAll?.(controller.signal);
    controller.abort();
    await expect(read).rejects.toBeInstanceOf(MediaError);
    await expect(read).rejects.toMatchObject({ code: 'aborted' });
  });
});

// ── Item 6: owned readAll fast paths for bytes/blob/opfs ────────────────────────────────────────

describe('readAll — owned one-buffer reads that never construct a stream reader', () => {
  it('fromBlob(b).readAll() returns exactly b’s bytes without any stream reader (real fixture)', async () => {
    const truth = await loadFixture(FIXTURE);
    const blob = new Blob([truth]);
    const streamSpy = vi.spyOn(blob, 'stream');
    const getReaderSpy = vi.spyOn(ReadableStream.prototype, 'getReader');
    try {
      const src = fromBlob(blob);
      const readAll = src.readAll;
      if (readAll === undefined) throw new Error('blob source must expose readAll()');
      const bytes = await readAll.call(src);
      expect(streamSpy).not.toHaveBeenCalled();
      expect(getReaderSpy).not.toHaveBeenCalled();
      expectBytesEqual(bytes, truth);
      expect(sha256(bytes)).toBe(sha256(truth));
    } finally {
      getReaderSpy.mockRestore();
      streamSpy.mockRestore();
    }
    // Checksum matches an independent stream-drain baseline of the same blob.
    const baseline = await drainLocal(fromBlob(new Blob([truth])).stream());
    expect(sha256(baseline)).toBe(sha256(truth));
  });

  it('fromBytes readAll returns the owned buffer in one call (no copy, abort-aware)', async () => {
    const truth = await loadFixture(FIXTURE);
    const src = fromBytes(truth);
    const readAll = src.readAll;
    if (readAll === undefined) throw new Error('bytes source must expose readAll()');
    const first = await readAll.call(src);
    const second = await readAll.call(src);
    expect(first).toBe(second); // the one owned buffer, not a fresh concatenation
    expectBytesEqual(first, truth);

    const controller = new AbortController();
    controller.abort();
    await expect(readAll.call(src, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
  });

  it('fromOPFS inherits the blob readAll fast path', async () => {
    const truth = await loadFixture(FIXTURE);
    const file = new File([truth], 'clip.mp4');
    const fileHandle = { getFile: () => Promise.resolve(file) };
    const root = { getFileHandle: () => Promise.resolve(fileHandle) };
    const storage = { getDirectory: () => Promise.resolve(root) } as unknown as StorageManager;
    vi.stubGlobal('navigator', { storage });

    const src = await fromOPFS('clip.mp4');
    const readAll = src.readAll;
    if (readAll === undefined) throw new Error('opfs source must expose readAll()');
    const getReaderSpy = vi.spyOn(ReadableStream.prototype, 'getReader');
    try {
      const bytes = await readAll.call(src);
      expect(getReaderSpy).not.toHaveBeenCalled();
      expect(sha256(bytes)).toBe(sha256(truth));
    } finally {
      getReaderSpy.mockRestore();
    }
  });
});

// ── Item 8: range never short-reads before EOF (every constructor) ──────────────────────────────

describe('range(a, b) EOF contract — returns exactly min(b, size) − a bytes', () => {
  const constructors: ReadonlyArray<
    readonly [string, (truth: Uint8Array<ArrayBuffer>) => Promise<Source>]
  > = [
    ['bytes', (truth) => Promise.resolve(fromBytes(truth))],
    ['blob', (truth) => Promise.resolve(fromBlob(new Blob([truth])))],
    [
      'url',
      (truth) => {
        vi.stubGlobal('fetch', conformantServer(truth).fetch);
        return Promise.resolve(fromURL(HREF));
      },
    ],
    [
      'element',
      (truth) => {
        vi.stubGlobal('fetch', conformantServer(truth).fetch);
        return Promise.resolve(
          fromElement({ currentSrc: HREF, src: '' } as unknown as HTMLMediaElement),
        );
      },
    ],
    [
      'opfs',
      async (truth) => {
        const file = new File([truth], 'clip.mp4');
        const fileHandle = { getFile: () => Promise.resolve(file) };
        const root = { getFileHandle: () => Promise.resolve(fileHandle) };
        vi.stubGlobal('navigator', {
          storage: { getDirectory: () => Promise.resolve(root) } as unknown as StorageManager,
        });
        return fromOPFS('clip.mp4');
      },
    ],
  ];

  it.each(constructors)(
    '%s: past-EOF requests clamp, never short-read, never throw',
    async (_name, make) => {
      const truth = await loadFixture(FIXTURE);
      const src = await make(truth);
      const size = truth.byteLength;

      const tail = await rangeOf(src, size - 100, size + 4096);
      expectBytesEqual(tail, truth.subarray(size - 100)); // exactly size − a bytes, bit-identical
      expect((await rangeOf(src, size - 1, size)).byteLength).toBe(1);
      expect((await rangeOf(src, size, size + 10)).byteLength).toBe(0); // at EOF ⇒ empty, not an error
    },
  );

  it('url: a 416 with an unsatisfied-range total is a clamped empty read that learns EOF', async () => {
    const truth = Uint8Array.from({ length: 256 }, (_v, i) => i % 251);
    const { fetch } = conformantServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF); // size unknown — the transport must discover EOF from the 416

    expect((await rangeOf(src, truth.byteLength + 5, truth.byteLength + 10)).byteLength).toBe(0);
    expect(src.size).toBe(truth.byteLength);
  });

  it('url: a bare 416 without a total stays a typed InputError', async () => {
    vi.stubGlobal('fetch', ((_input: unknown, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 416 }))) as typeof fetch);
    const src = fromURL(HREF);

    await expect(rangeOf(src, 10, 20)).rejects.toBeInstanceOf(InputError);
  });
});

// ── Item 11: cancelling a URL stream before the first chunk aborts the fetch itself ─────────────

describe('fetchStream — the initial request is bound to the stream lifetime', () => {
  it('cancel before the first chunk aborts the in-flight fetch (signal spy)', async () => {
    let init: RequestInit | undefined;
    let transportAborted = false;
    vi.stubGlobal('fetch', ((_input: unknown, requestInit?: RequestInit) => {
      init = requestInit;
      return new Promise<Response>((_resolve, reject) => {
        requestInit?.signal?.addEventListener(
          'abort',
          () => {
            transportAborted = true;
            reject(requestInit?.signal?.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
    }) as typeof fetch);

    const stream = fromURL(HREF).stream();
    const reader = stream.getReader();
    const firstRead = reader.read();
    await vi.waitFor(() => {
      if (init === undefined) throw new Error('fetch not started yet');
    });

    await reader.cancel(new MediaError('aborted', 'consumer cancelled'));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(true);
    expect(transportAborted).toBe(true); // the network request was genuinely torn down
    await expect(firstRead).resolves.toMatchObject({ done: true });
  });
});
