import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputError } from '../contracts/errors.ts';
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
} from './source.ts';

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
