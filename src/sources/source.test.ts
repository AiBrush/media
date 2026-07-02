import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import {
  type MediaInput,
  type Source,
  from,
  fromBlob,
  fromBytes,
  fromElement,
  fromOPFS,
  fromStream,
  fromURL,
  isSource,
  probeUrlSize,
} from './source.ts';

/** A conformant HTTP range server backed by `bytes` (HEAD→Content-Length, Range→206, GET→200). */
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
      const end = Math.min(Number(m[2]) + 1, total); // a real server clamps the end to EOF
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

function rangeOf(src: Source, start: number, end: number): Promise<Uint8Array> {
  if (!src.range) throw new Error('expected source to support range()');
  return src.range(start, end);
}

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

const FIVE = new Uint8Array([0, 1, 2, 3, 4]);
// data: URL carrying the same five bytes (base64 of 0x00..0x04).
const DATA_URL = 'data:application/octet-stream;base64,AAECAwQ=';

describe('isSource', () => {
  it('recognizes a normalized source and rejects others', () => {
    expect(isSource(fromBytes(FIVE))).toBe(true);
    expect(isSource(null)).toBe(false);
    expect(isSource({})).toBe(false);
    expect(isSource(FIVE)).toBe(false);
  });
});

describe('fromBytes', () => {
  it('streams the bytes, reports size, and re-streams fresh each call', async () => {
    const src = fromBytes(FIVE, { mime: 'application/octet-stream' });
    expect(src.kind).toBe('bytes');
    expect(src.size).toBe(5);
    expect(src.mimeHint).toBe('application/octet-stream');
    expect([...(await readAll(src.stream()))]).toEqual([0, 1, 2, 3, 4]);
    expect([...(await readAll(src.stream()))]).toEqual([0, 1, 2, 3, 4]); // fresh stream, re-readable
  });

  it('supports half-open range reads with clamping', async () => {
    const src = fromBytes(FIVE);
    expect([...(await rangeOf(src, 1, 3))]).toEqual([1, 2]);
    expect([...(await rangeOf(src, -5, 2))]).toEqual([0, 1]); // start clamped to 0
    expect([...(await rangeOf(src, 3, 100))]).toEqual([3, 4]); // end clamped to size
  });

  it('accepts an ArrayBuffer and an ArrayBufferView', async () => {
    expect((await readAll(fromBytes(FIVE.buffer).stream())).byteLength).toBe(5);
    const view = new DataView(FIVE.buffer);
    expect(fromBytes(view).size).toBe(5);
  });
});

describe('fromBlob', () => {
  it('streams a Blob, reports size and mime', async () => {
    const blob = new Blob([FIVE], { type: 'video/mp4' });
    const src = fromBlob(blob);
    expect(src.kind).toBe('blob');
    expect(src.size).toBe(5);
    expect(src.mimeHint).toBe('video/mp4');
    expect([...(await readAll(src.stream()))]).toEqual([0, 1, 2, 3, 4]);
    expect([...(await rangeOf(src, 1, 4))]).toEqual([1, 2, 3]);
  });

  it('captures a File name as filename', () => {
    const file = new File([FIVE], 'clip.mp4', { type: 'video/mp4' });
    expect(fromBlob(file).filename).toBe('clip.mp4');
  });
});

describe('fromStream', () => {
  it('hands back the underlying stream once and rejects a second consumption', async () => {
    const src = fromStream(fromBytes(FIVE).stream());
    expect(src.kind).toBe('stream');
    expect(src.size).toBeUndefined();
    expect(src.range).toBeUndefined();
    expect((await readAll(src.stream())).byteLength).toBe(5);
    expect(() => src.stream()).toThrowError(InputError);
  });
});

describe('fromURL', () => {
  it('streams bytes from a (data:) URL', async () => {
    const src = fromURL(DATA_URL);
    expect(src.kind).toBe('url');
    expect([...(await readAll(src.stream()))]).toEqual([0, 1, 2, 3, 4]);
  });

  it('ranges over a URL (falling back to a local slice when the server ignores Range)', async () => {
    const src = fromURL(new URL(DATA_URL));
    expect([...(await rangeOf(src, 1, 3))]).toEqual([1, 2]);
  });

  it('omits range() when rangeRequests is disabled', () => {
    expect(fromURL(DATA_URL, { rangeRequests: false }).range).toBeUndefined();
  });

  it('uses a caller-provided size without a network size probe', () => {
    const src = fromURL(DATA_URL, { size: FIVE.byteLength });
    expect(src.size).toBe(FIVE.byteLength);
  });
});

describe('fromElement', () => {
  it('reads currentSrc as a bytes source', async () => {
    const el = { currentSrc: DATA_URL, src: '' } as unknown as HTMLMediaElement;
    const src = fromElement(el);
    expect(src.kind).toBe('element');
    expect([...(await readAll(src.stream()))]).toEqual([0, 1, 2, 3, 4]);
  });

  it('throws on capture mode (Phase 1) and on a missing src', () => {
    const el = { currentSrc: DATA_URL, src: '' } as unknown as HTMLMediaElement;
    expect(() => fromElement(el, { mode: 'capture' })).toThrowError(InputError);
    const empty = { currentSrc: '', src: '' } as unknown as HTMLMediaElement;
    expect(() => fromElement(empty)).toThrowError(InputError);
  });
});

describe('fromOPFS', () => {
  it('rejects when OPFS is unavailable', async () => {
    await expect(fromOPFS('/clip.mp4')).rejects.toBeInstanceOf(InputError);
  });
});

describe('from (universal dispatch)', () => {
  it('routes each input kind to the right source', async () => {
    expect(from(FIVE).kind).toBe('bytes');
    expect(from(FIVE.buffer).kind).toBe('bytes');
    expect(from(new Int16Array([1, 2])).kind).toBe('bytes');
    expect(from(new Blob([FIVE])).kind).toBe('blob');
    expect(from(fromBytes(FIVE).stream()).kind).toBe('stream');
    expect(from(new URL(DATA_URL)).kind).toBe('url');
    expect(from(DATA_URL).kind).toBe('url');
  });

  it('returns an existing source unchanged (idempotent)', () => {
    const src = fromBytes(FIVE);
    expect(from(src)).toBe(src);
  });

  it('rejects an unnormalizable input with a typed InputError', () => {
    expect(() => from(123 as unknown as MediaInput)).toThrowError(InputError);
    expect(() => from({} as unknown as MediaInput)).toThrowError(InputError);
    expect(() => from(null as unknown as MediaInput)).toThrowError(InputError);
  });
});

describe('stubbed-environment paths', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads an OPFS file through a stubbed StorageManager (nested + root)', async () => {
    const file = new File([FIVE], 'clip.mp4');
    const fileHandle = { getFile: () => Promise.resolve(file) };
    const subdir = { getFileHandle: () => Promise.resolve(fileHandle) };
    const root = {
      getDirectoryHandle: () => Promise.resolve(subdir),
      getFileHandle: () => Promise.resolve(fileHandle),
    };
    const storage = { getDirectory: () => Promise.resolve(root) } as unknown as StorageManager;
    vi.stubGlobal('navigator', { storage });

    const nested = await fromOPFS('/media/clip.mp4');
    expect(nested.kind).toBe('opfs');
    expect((await readAll(nested.stream())).byteLength).toBe(5);

    const flat = await fromOPFS('clip.mp4');
    expect((await readAll(flat.stream())).byteLength).toBe(5);

    await expect(fromOPFS('/')).rejects.toBeInstanceOf(InputError); // no filename component
  });

  it('errors the stream when a fetch is not ok', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 404 })));
    await expect(readAll(fromURL('https://x/y.mp4').stream())).rejects.toBeInstanceOf(InputError);
  });

  it('returns a 206 range body verbatim and rejects a failed range fetch', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(new Uint8Array([9, 9]), { status: 206 })),
    );
    expect([...(await rangeOf(fromURL('https://x/y.mp4'), 0, 2))]).toEqual([9, 9]);

    vi.stubGlobal('fetch', () => Promise.resolve(new Response('err', { status: 500 })));
    await expect(rangeOf(fromURL('https://x/y.mp4'), 0, 2)).rejects.toBeInstanceOf(InputError);
  });

  it('routes a stubbed HTMLMediaElement and rejects a stubbed MediaStream', () => {
    class FakeEl {
      currentSrc = DATA_URL;
      src = '';
    }
    vi.stubGlobal('HTMLMediaElement', FakeEl);
    expect(from(new FakeEl() as unknown as MediaInput).kind).toBe('element');

    class FakeStream {}
    vi.stubGlobal('MediaStream', FakeStream);
    expect(() => from(new FakeStream() as unknown as MediaInput)).toThrowError(InputError);
  });
});

// ── URL size detection + past-EOF clamping (against a conformant range server backed by real bytes) ──

const HREF = 'https://cdn.example/clip.mp4';
const FIXTURE = 'h264.mp4'; // a real downloaded MP4 — bit-exactness is asserted vs its actual bytes

describe('probeUrlSize — body-free size detection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads Content-Length from a HEAD', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch, calls } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    expect(await probeUrlSize(HREF)).toBe(truth.byteLength);
    expect(calls[0]?.method).toBe('HEAD'); // tried HEAD first
  });

  it('falls back to a ranged GET (Content-Range total) when HEAD lacks a length', async () => {
    const truth = await loadFixture(FIXTURE);
    // A server that answers HEAD with no Content-Length, but honors a bytes=0-0 probe.
    vi.stubGlobal('fetch', ((_i: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(
        new Response(truth.subarray(0, 1), {
          status: 206,
          headers: { 'Content-Range': `bytes 0-0/${truth.byteLength}` },
        }),
      );
    }) as typeof fetch);
    expect(await probeUrlSize(HREF)).toBe(truth.byteLength);
  });

  it('returns undefined for an unknown-length resource (no headers)', async () => {
    vi.stubGlobal('fetch', ((_i: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(new Uint8Array([0]), { status: 200 }));
    }) as typeof fetch);
    expect(await probeUrlSize(HREF)).toBeUndefined();
  });

  it('rejects a failed size probe with a typed InputError', async () => {
    // Both HEAD and the ranged-GET fallback 404 → a typed InputError (never a leaked raw fetch error).
    vi.stubGlobal('fetch', ((_i: unknown, _init?: RequestInit) =>
      Promise.resolve(new Response('no', { status: 404 }))) as typeof fetch);
    await expect(probeUrlSize(HREF)).rejects.toBeInstanceOf(InputError);
  });
});

describe('fromURL — learns size from a range read and clamps past-EOF', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('memoizes the total length from the first range read (Content-Range)', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);
    expect(src.size).toBeUndefined(); // not known before any read (honest: a URL has no sync length)
    expectBytesEqual(await src.range?.(0, 16), truth.subarray(0, 16));
    expect(src.size).toBe(truth.byteLength); // learned from `Content-Range`
  });

  it('range reads are bit-identical to the file at arbitrary offsets', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);
    for (const [lo, hi] of [
      [0, 32],
      [777, 1801],
      [truth.byteLength - 100, truth.byteLength],
    ] as [number, number][]) {
      expectBytesEqual(await src.range?.(lo, hi), truth.subarray(lo, hi));
    }
  });

  it('clamps a past-EOF range once size is known (returns only real bytes, empty at/after EOF)', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);
    await src.range?.(0, 8); // learns size first

    const lo = truth.byteLength - 5;
    expectBytesEqual(await src.range?.(lo, truth.byteLength + 9999), truth.subarray(lo));
    expect((await src.range?.(truth.byteLength, truth.byteLength + 10))?.byteLength).toBe(0);
  });

  it('seeds size from the option without any round-trip', () => {
    const src = fromURL(HREF, { size: 12345 });
    expect(src.size).toBe(12345);
  });

  it('learns size from a full stream() Content-Length', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);
    await readAll(src.stream());
    expect(src.size).toBe(truth.byteLength);
  });
});

/** Byte-equality with a precise first-divergence message (asserts a defined Uint8Array). */
function expectBytesEqual(actual: Uint8Array | undefined, expected: Uint8Array): void {
  if (actual === undefined) throw new Error('expected bytes, got undefined (range() missing)');
  expect(actual.byteLength).toBe(expected.byteLength);
  for (let i = 0; i < expected.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`byte mismatch at ${i}: got ${actual[i]}, expected ${expected[i]}`);
    }
  }
}
