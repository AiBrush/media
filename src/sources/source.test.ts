import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import type { LiveMediaSource } from './live-source.ts';
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
  peekSourceHead,
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

  it('prefers a File webkitRelativePath when directory upload metadata is present', () => {
    const file = new File([FIVE], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'media/clips/clip.mp4' });
    expect(fromBlob(file).filename).toBe('media/clips/clip.mp4');
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

  it('preserves universal-normalizer MIME and size hints', () => {
    const src = from(fromBytes(FIVE).stream(), {
      mime: 'audio/wav; codecs=1',
      size: FIVE.byteLength,
    });
    expect(src.kind).toBe('stream');
    expect(src.mimeHint).toBe('audio/wav; codecs=1');
    expect(src.size).toBe(FIVE.byteLength);
  });

  it('replays increasing routing peeks byte-exactly through one backpressured consumer', async () => {
    const chunks = [Uint8Array.of(0, 1), Uint8Array.of(2), Uint8Array.of(3, 4)];
    let pulls = 0;
    const src = fromStream(
      new ReadableStream<Uint8Array>(
        {
          pull(controller): void {
            const chunk = chunks[pulls++];
            if (chunk === undefined) controller.close();
            else controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 },
      ),
    );

    expect([...(await peekSourceHead(src, 3))]).toEqual([0, 1, 2]);
    expect(pulls).toBe(2);
    expect([...(await peekSourceHead(src, 5))]).toEqual([0, 1, 2, 3, 4]);
    expect(pulls).toBe(3);

    const reader = src.stream().getReader();
    expect(await reader.read()).toEqual({ done: false, value: chunks[0] });
    expect(pulls).toBe(3);
    expect(await reader.read()).toEqual({ done: false, value: chunks[1] });
    expect(pulls).toBe(3);
    expect(await reader.read()).toEqual({ done: false, value: chunks[2] });
    expect(pulls).toBe(3);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(pulls).toBe(4);
    expect(() => src.stream()).toThrowError(InputError);
  });

  it('cancels one pending prefix reader on abort and rejects later ownership transfer', async () => {
    let cancels = 0;
    let markPullStarted: (() => void) | undefined;
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve;
    });
    const src = fromStream(
      new ReadableStream<Uint8Array>({
        pull(): void {
          markPullStarted?.();
        },
        cancel(): void {
          cancels++;
        },
      }),
    );
    const ctrl = new AbortController();
    const peek = peekSourceHead(src, 4, ctrl.signal);
    await pullStarted;
    ctrl.abort('stop');

    await expect(peek).rejects.toMatchObject({ code: 'aborted' });
    expect(cancels).toBe(1);
    expect(() => src.stream()).toThrowError(InputError);
  });

  it('rejects an already-locked caller stream with a typed input error', () => {
    const input = fromBytes(FIVE).stream();
    const reader = input.getReader();
    expect(() => fromStream(input)).toThrowError(InputError);
    reader.releaseLock();
  });
});

describe('fromURL', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams bytes from a (data:) URL', async () => {
    const src = fromURL(DATA_URL);
    expect(src.kind).toBe('url');
    expect([...(await readAll(src.stream()))]).toEqual([0, 1, 2, 3, 4]);
  });

  it('ranges over a URL (falling back to a local slice when the server ignores Range)', async () => {
    const src = fromURL(new URL(DATA_URL));
    expect([...(await rangeOf(src, 1, 3))]).toEqual([1, 2]);
  });

  it('materializes an owned complete response directly and honors cancellation', async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', ((_input: unknown, init?: RequestInit) => {
      requests.push(init ?? {});
      return Promise.resolve(
        new Response(toBody(FIVE), {
          status: 200,
          // Fetch exposes decoded bytes; a transport Content-Length may describe a compressed body.
          headers: { 'Content-Length': '999' },
        }),
      );
    }) as typeof fetch);
    const src = fromURL('https://cdn.test/complete.webm');
    const readAll = src.readAll;
    if (readAll === undefined) throw new Error('URL source must expose readAll()');
    const controller = new AbortController();

    expect(await readAll.call(src, controller.signal)).toEqual(FIVE);
    expect(src.size).toBe(FIVE.byteLength);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal).toBe(controller.signal);
  });

  it('omits range() when rangeRequests is disabled', () => {
    expect(fromURL(DATA_URL, { rangeRequests: false }).range).toBeUndefined();
  });

  it('uses a caller-provided size without a network size probe', () => {
    const src = fromURL(DATA_URL, { size: FIVE.byteLength });
    expect(src.size).toBe(FIVE.byteLength);
  });

  it('carries a caller-provided MIME hint', () => {
    const src = fromURL(DATA_URL, { mime: 'video/mp4' });
    expect(src.mimeHint).toBe('video/mp4');
  });

  it('retains a query/hash-free URL filename for extension routing', () => {
    expect(fromURL('https://cdn.test/live/index.m3u8?token=abc#variant').filename).toBe(
      'index.m3u8',
    );
    expect(fromURL('relative/clip.mp4?download=1').filename).toBe('clip.mp4');
    expect(fromURL(DATA_URL).filename).toBeUndefined();
    expect(fromURL('mailto:media@example.test').filename).toBeUndefined();
  });
});

describe('fromElement', () => {
  it('reads currentSrc as a bytes source', async () => {
    const el = { currentSrc: DATA_URL, src: '' } as unknown as HTMLMediaElement;
    const src = fromElement(el);
    expect(src.kind).toBe('element');
    expect([...(await readAll(src.stream()))]).toEqual([0, 1, 2, 3, 4]);

    const named = fromElement({
      currentSrc: 'https://cdn.test/media/clip.webm?token=one',
      src: '',
    } as unknown as HTMLMediaElement);
    expect(named.filename).toBe('clip.webm');
  });

  it('uses captureStream only in explicit capture mode and rejects a missing byte src', () => {
    const mediaStream = {
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const el = {
      currentSrc: DATA_URL,
      src: '',
      captureStream: () => mediaStream,
    } as unknown as HTMLMediaElement;
    const captured = fromElement(el, { mode: 'capture' });
    expect(captured.kind).toBe('media-stream');
    expect(captured.mediaStream).toBe(mediaStream);
    expect(from(captured)).toBe(captured);
    expect(() => fromElement({} as HTMLMediaElement, { mode: 'capture' })).toThrowError(
      CapabilityError,
    );
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
  it('keeps byte, default-element, capture-element, and live overloads distinct', () => {
    const element = {} as HTMLMediaElement;
    const stream = {
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const assertTypes = (): void => {
      expectTypeOf(from(FIVE)).toEqualTypeOf<Source>();
      expectTypeOf(from(element)).toEqualTypeOf<Source>();
      expectTypeOf(from(element, { mode: 'bytes' })).toEqualTypeOf<Source>();
      expectTypeOf(from(element, { mode: 'capture' })).toEqualTypeOf<LiveMediaSource>();
      expectTypeOf(from(stream)).toEqualTypeOf<LiveMediaSource>();
    };
    expectTypeOf(assertTypes).toBeFunction();
  });

  it('routes each input kind to the right source', async () => {
    expect(from(FIVE).kind).toBe('bytes');
    expect(from(FIVE.buffer).kind).toBe('bytes');
    expect(from(new Int16Array([1, 2])).kind).toBe('bytes');
    expect(from(new Blob([FIVE])).kind).toBe('blob');
    expect(from(fromBytes(FIVE).stream()).kind).toBe('stream');
    expect(from(new URL(DATA_URL)).kind).toBe('url');
    expect(from(DATA_URL).kind).toBe('url');
    expect(from(new URL(DATA_URL), { mime: 'video/mp4' }).mimeHint).toBe('video/mp4');
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
    const src = fromURL('https://x/y.mp4');
    await expect(readAll(src.stream())).rejects.toBeInstanceOf(InputError);
    await expect(src.readAll?.()).rejects.toBeInstanceOf(InputError);
  });

  it('returns a 206 range body verbatim and rejects a failed range fetch', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(new Uint8Array([9, 9]), { status: 206 })),
    );
    expect([...(await rangeOf(fromURL('https://x/y.mp4'), 0, 2))]).toEqual([9, 9]);

    vi.stubGlobal('fetch', () => Promise.resolve(new Response('err', { status: 500 })));
    await expect(rangeOf(fromURL('https://x/y.mp4'), 0, 2)).rejects.toBeInstanceOf(InputError);
  });

  it('routes a stubbed HTMLMediaElement and brands a structural MediaStream', () => {
    class FakeEl {
      currentSrc = DATA_URL;
      src = '';
    }
    vi.stubGlobal('HTMLMediaElement', FakeEl);
    expect(from(new FakeEl() as unknown as MediaInput).kind).toBe('element');

    class FakeStream {
      getTracks(): MediaStreamTrack[] {
        return [];
      }

      getVideoTracks(): MediaStreamTrack[] {
        return [];
      }

      getAudioTracks(): MediaStreamTrack[] {
        return [];
      }
    }
    vi.stubGlobal('MediaStream', FakeStream);
    expect(from(new FakeStream() as unknown as MediaStream).kind).toBe('media-stream');
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

  it('falls back when HEAD has a malformed Content-Length', async () => {
    vi.stubGlobal('fetch', ((_i: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') {
        return Promise.resolve(
          new Response(null, { status: 200, headers: { 'Content-Length': 'x' } }),
        );
      }
      return Promise.resolve(
        new Response(new Uint8Array([0]), {
          status: 206,
          headers: { 'Content-Range': `bytes 0-0/${FIVE.byteLength}` },
        }),
      );
    }) as typeof fetch);
    expect(await probeUrlSize(HREF)).toBe(FIVE.byteLength);
  });

  it('returns undefined for an unknown-length resource (no headers)', async () => {
    vi.stubGlobal('fetch', ((_i: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(new Uint8Array([0]), { status: 200 }));
    }) as typeof fetch);
    expect(await probeUrlSize(HREF)).toBeUndefined();
  });

  it('falls back after a throwing HEAD and accepts an unknown Content-Range total', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', ((_i: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      methods.push(method);
      if (method === 'HEAD') return Promise.reject(new Error('HEAD refused'));
      return Promise.resolve(
        new Response(new Uint8Array([0]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-0/*' },
        }),
      );
    }) as typeof fetch);

    expect(await probeUrlSize(new URL(HREF))).toBeUndefined();
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it('returns undefined when the ranged size probe omits the Content-Range total', async () => {
    vi.stubGlobal('fetch', ((_i: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(
        new Response(new Uint8Array([0]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-0' },
        }),
      );
    }) as typeof fetch);

    expect(await probeUrlSize(HREF)).toBeUndefined();
  });

  it('returns undefined for empty Content-Range totals after ignoring a negative HEAD length', async () => {
    vi.stubGlobal('fetch', ((_i: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') {
        return Promise.resolve(
          new Response(null, { status: 200, headers: { 'Content-Length': '-1' } }),
        );
      }
      return Promise.resolve(
        new Response(new Uint8Array([0]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-0/' },
        }),
      );
    }) as typeof fetch);

    expect(await probeUrlSize(HREF)).toBeUndefined();
  });

  it('returns undefined for missing or negative Content-Range totals', async () => {
    for (const value of [null, 'bytes 0-0/-1'] as const) {
      vi.unstubAllGlobals();
      vi.stubGlobal('fetch', ((_i: unknown, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }));
        return Promise.resolve(
          new Response(new Uint8Array([0]), {
            status: 206,
            ...(value !== null ? { headers: { 'Content-Range': value } } : {}),
          }),
        );
      }) as typeof fetch);

      expect(await probeUrlSize(HREF)).toBeUndefined();
    }
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

  it('marks latency-critical sparse range reads high priority without changing the window', async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal('fetch', ((_input: unknown, init?: RequestInit) => {
      request = init;
      return Promise.resolve(
        new Response(toBody(FIVE.subarray(1, 3)), {
          status: 206,
          headers: { 'Content-Range': `bytes 1-2/${FIVE.byteLength}` },
        }),
      );
    }) as typeof fetch);

    expectBytesEqual(await fromURL(HREF).range?.(1, 3), FIVE.subarray(1, 3));
    expect(request).toMatchObject({
      headers: { Range: 'bytes=1-2' },
      priority: 'high',
    });
  });

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

  it('leaves size unknown when a 206 range response lacks a Content-Range total', async () => {
    vi.stubGlobal('fetch', ((_i: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(toBody(FIVE.subarray(0, 2)), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-1' },
        }),
      )) as typeof fetch);
    const src = fromURL(HREF);

    expectBytesEqual(await src.range?.(0, 2), FIVE.subarray(0, 2));
    expect(src.size).toBeUndefined();
  });

  it('trims an over-returning 206 range body to the requested window', async () => {
    vi.stubGlobal('fetch', ((_i: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(toBody(FIVE), {
          status: 206,
          headers: { 'Content-Range': `bytes 0-1/${FIVE.byteLength}` },
        }),
      )) as typeof fetch);
    const src = fromURL(HREF);

    expectBytesEqual(await src.range?.(0, 2), FIVE.subarray(0, 2));
    expect(src.size).toBe(FIVE.byteLength);
  });

  it('leaves size unknown for malformed URL length headers', async () => {
    vi.stubGlobal('fetch', ((_i: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(toBody(FIVE), { headers: { 'Content-Length': 'x' } }),
      )) as typeof fetch);
    const streamed = fromURL(HREF);
    expectBytesEqual(await readAll(streamed.stream()), FIVE);
    expect(streamed.size).toBeUndefined();

    for (const value of ['bytes 0-1/*', 'bytes 0-1/', 'bytes 0-1/x']) {
      vi.stubGlobal('fetch', ((_i: unknown, _init?: RequestInit) =>
        Promise.resolve(
          new Response(toBody(FIVE.subarray(0, 2)), {
            status: 206,
            headers: { 'Content-Range': value },
          }),
        )) as typeof fetch);
      const ranged = fromURL(HREF);
      expectBytesEqual(await ranged.range?.(0, 2), FIVE.subarray(0, 2));
      expect(ranged.size).toBeUndefined();
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

  it('preserves high-priority Range semantics for a tiny known-size full window', async () => {
    const { fetch, calls } = rangeServer(FIVE);
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF, { size: FIVE.byteLength });

    expectBytesEqual(await src.range?.(0, FIVE.byteLength), FIVE);

    expect(calls).toEqual([{ method: 'GET', range: 'bytes=0-4' }]);
  });

  it('keeps the known size when a server ignores a tiny full-window Range without Content-Length', async () => {
    const calls: { method: string; range: string | null }[] = [];
    vi.stubGlobal('fetch', ((_input: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = init?.headers as { Range?: string } | undefined;
      calls.push({ method, range: headers?.Range ?? null });
      return Promise.resolve(new Response(toBody(FIVE), { status: 200 }));
    }) as typeof fetch);
    const src = fromURL(HREF, { size: FIVE.byteLength });

    expectBytesEqual(await src.range?.(0, FIVE.byteLength), FIVE);

    expect(src.size).toBe(FIVE.byteLength);
    expect(calls).toEqual([{ method: 'GET', range: 'bytes=0-4' }]);
  });

  it('rejects a failed tiny full-window Range with a typed InputError', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('err', { status: 503 })));
    const src = fromURL(HREF, { size: FIVE.byteLength });

    await expect(src.range?.(0, FIVE.byteLength)).rejects.toBeInstanceOf(InputError);
  });

  it('learns size from a full stream() Content-Length', async () => {
    const truth = await loadFixture(FIXTURE);
    const { fetch } = rangeServer(truth);
    vi.stubGlobal('fetch', fetch);
    const src = fromURL(HREF);
    await readAll(src.stream());
    expect(src.size).toBe(truth.byteLength);
  });

  it('cancels URL streams before and after the response reader exists', async () => {
    let responseCancels = 0;
    vi.stubGlobal('fetch', ((_i: unknown, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(FIVE);
            },
            cancel(): void {
              responseCancels++;
            },
          }),
        ),
      )) as typeof fetch);

    const src = fromURL(HREF);
    await src.stream().cancel('unused');
    expect(responseCancels).toBe(0);

    const reader = src.stream().getReader();
    const first = await reader.read();
    expect(first.value).toEqual(FIVE);
    await reader.cancel('stop');
    expect(responseCancels).toBe(1);
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
