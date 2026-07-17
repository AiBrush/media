/**
 * Validation for the {@link OpfsTarget} streaming sink. The DOM I/O seam (FileSystemWritableFileStream)
 * is browser-only and excluded from coverage, so these tests gate the **pure** parts that decide what the
 * seam does — path normalization ({@link parseOpfsPath}), the write plan ({@link planOpfsWrite}), the
 * availability probe, and the Node-reachable guards of {@link writeToOpfsTarget} (capability miss when
 * OPFS is absent; the already-aborted fast path; bad-path/position rejection before any I/O).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import {
  type OpfsTarget,
  isOpfsAvailable,
  parseOpfsPath,
  planOpfsWrite,
  toOpfsTarget,
  writeToOpfsTarget,
} from './opfs-target.ts';
import { positionedChunk } from './stream-target.ts';

function bytesStream(...arrays: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      for (const a of arrays) c.enqueue(new Uint8Array(a));
      c.close();
    },
  });
}

describe('toOpfsTarget — descriptor', () => {
  it('builds an opfs-target descriptor with defaulted options', () => {
    expect(toOpfsTarget('/out.mp4')).toEqual({
      kind: 'opfs-target',
      path: '/out.mp4',
      options: {},
    });
  });

  it('carries through options', () => {
    const t = toOpfsTarget('/a/out.mp4', { keepExistingData: true, position: 16 });
    expect(t.options).toEqual({ keepExistingData: true, position: 16 });
  });

  it('never throws on construction, even for an invalid path (validated lazily at write time)', () => {
    expect(() => toOpfsTarget('')).not.toThrow();
    expect(() => toOpfsTarget('/dir/')).not.toThrow();
  });
});

describe('parseOpfsPath — normalization (pure)', () => {
  it('splits a nested path into parent dirs + filename', () => {
    expect(parseOpfsPath('/media/clips/out.mp4')).toEqual({
      dirs: ['media', 'clips'],
      name: 'out.mp4',
    });
  });

  it('a bare filename has no parent dirs (file at the OPFS root)', () => {
    expect(parseOpfsPath('out.mp4')).toEqual({ dirs: [], name: 'out.mp4' });
    expect(parseOpfsPath('/out.mp4')).toEqual({ dirs: [], name: 'out.mp4' });
  });

  it('tolerates leading and duplicate slashes', () => {
    expect(parseOpfsPath('//media//out.mp4')).toEqual({ dirs: ['media'], name: 'out.mp4' });
  });

  it('rejects an empty path', () => {
    expect(() => parseOpfsPath('')).toThrowError(InputError);
    expect(() => parseOpfsPath('')).toThrowError(/non-empty/);
  });

  it('rejects a directory path (trailing slash)', () => {
    expect(() => parseOpfsPath('/media/')).toThrowError(InputError);
    expect(() => parseOpfsPath('/media/')).toThrowError(/directory/);
  });

  it('rejects a root-only path (no filename)', () => {
    expect(() => parseOpfsPath('/')).toThrowError(InputError);
  });

  it("rejects '.' or '..' segments (OPFS has no relative navigation)", () => {
    expect(() => parseOpfsPath('/a/../b.mp4')).toThrowError(/'\.' or '\.\.'/);
    expect(() => parseOpfsPath('./b.mp4')).toThrowError(/'\.' or '\.\.'/);
    expect(() => parseOpfsPath('/a/./b.mp4')).toThrowError(InputError);
  });
});

describe('planOpfsWrite — the resolved write instructions (pure)', () => {
  it('resolves dirs/name + defaults (replace, position 0)', () => {
    expect(planOpfsWrite(toOpfsTarget('/clips/out.mp4'))).toEqual({
      dirs: ['clips'],
      name: 'out.mp4',
      keepExistingData: false,
      startPosition: 0,
    });
  });

  it('reflects keepExistingData + position options', () => {
    const plan = planOpfsWrite(
      toOpfsTarget('/out.mp4', { keepExistingData: true, position: 1024 }),
    );
    expect(plan).toEqual({
      dirs: [],
      name: 'out.mp4',
      keepExistingData: true,
      startPosition: 1024,
    });
  });

  it('propagates a path rejection', () => {
    expect(() => planOpfsWrite(toOpfsTarget('/bad/'))).toThrowError(InputError);
  });

  it('rejects a negative / non-integer / non-finite position', () => {
    expect(() => planOpfsWrite(toOpfsTarget('/o.mp4', { position: -1 }))).toThrowError(/position/);
    expect(() => planOpfsWrite(toOpfsTarget('/o.mp4', { position: 1.5 }))).toThrowError(InputError);
    expect(() =>
      planOpfsWrite(toOpfsTarget('/o.mp4', { position: Number.POSITIVE_INFINITY })),
    ).toThrowError(InputError);
  });
});

describe('isOpfsAvailable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is false in Node (no navigator.storage.getDirectory)', () => {
    expect(isOpfsAvailable()).toBe(false);
  });

  it('is true when navigator.storage.getDirectory exists', () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    expect(isOpfsAvailable()).toBe(true);
  });

  it('is false when navigator exists but storage is missing', () => {
    vi.stubGlobal('navigator', {});
    expect(isOpfsAvailable()).toBe(false);
  });
});

describe('writeToOpfsTarget — Node-reachable guards (the DOM seam is browser-only)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects with CapabilityError when OPFS is unavailable', async () => {
    const err = await writeToOpfsTarget(toOpfsTarget('/out.mp4'), bytesStream([1, 2, 3])).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe('capability-miss');
  });

  it('rejects a bad path with InputError before touching storage', async () => {
    // OPFS present, but the path is invalid → planOpfsWrite throws InputError before any I/O.
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    const err = await writeToOpfsTarget(toOpfsTarget('/dir/'), bytesStream([1])).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InputError);
  });

  it('rejects a bad position with InputError before touching storage', async () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    const err = await writeToOpfsTarget(
      toOpfsTarget('/o.mp4', { position: -5 }),
      bytesStream([1]),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
  });

  it('an already-aborted signal cancels the source stream and rejects with aborted (OPFS present)', async () => {
    // Stub OPFS present so we get past the capability guard and hit the abort fast-path; the source must
    // be cancelled (so its bytes/resources are released) and the rejection must be the typed `aborted`.
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new Uint8Array([1]));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const ac = new AbortController();
    ac.abort();
    const err = await writeToOpfsTarget(toOpfsTarget('/out.mp4'), stream, {
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('aborted');
    expect(cancelled).toBe(true);
  });

  it('cancels an unlocked source stream when the capability guard misses', async () => {
    // Failure before the drain locks the stream must still release the producer (wrapper parity with
    // the stream-target lazy wrapper — doc 09 §5 item 9, one convention for both streaming sinks).
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new Uint8Array([1]));
      },
      cancel(reason): void {
        cancelled = reason;
      },
    });
    const err = await writeToOpfsTarget(toOpfsTarget('/out.mp4'), stream).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(cancelled).toBe(err);
  });
});

/**
 * The DOM seam, exercised end-to-end against recording FileSystem doubles (the shapes the WHATWG File
 * System spec defines): directory walk, createWritable options, seek, positioned writes, commit-close,
 * and abort-on-failure so a half-written file is never left looking complete.
 */
describe('writeToOpfsTarget — seam behaviors (recording FileSystem doubles)', () => {
  afterEach(() => vi.unstubAllGlobals());

  interface SeamFs {
    stub(): void;
    seeks: number[];
    written: { data: Uint8Array; position: number | undefined }[];
    closed: () => boolean;
    abortedWith: () => unknown;
    failNextWrite: (error: unknown) => void;
  }

  function seamFs(): SeamFs {
    const seeks: number[] = [];
    const written: { data: Uint8Array; position: number | undefined }[] = [];
    let closed = false;
    let abortedWith: unknown;
    let writeFailure: unknown;
    const writable = Object.assign(
      new WritableStream<
        | Uint8Array
        | { readonly type: 'write'; readonly position: number; readonly data: Uint8Array }
      >({
        write(chunk): void {
          if (writeFailure !== undefined) throw writeFailure;
          if (chunk instanceof Uint8Array)
            written.push({ data: chunk.slice(), position: undefined });
          else written.push({ data: chunk.data.slice(), position: chunk.position });
        },
        close(): void {
          closed = true;
        },
        abort(reason): void {
          abortedWith = reason;
        },
      }),
      {
        seek(position: number): Promise<void> {
          seeks.push(position);
          return Promise.resolve();
        },
      },
    );
    const handle = { createWritable: () => Promise.resolve(writable) };
    const root = {
      getDirectoryHandle: () => Promise.resolve(root),
      getFileHandle: () => Promise.resolve(handle),
    };
    return {
      stub(): void {
        vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(root) } });
      },
      seeks,
      written,
      closed: () => closed,
      abortedWith: () => abortedWith,
      failNextWrite(error: unknown): void {
        writeFailure = error;
      },
    };
  }

  function streamOf(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(c): void {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    });
  }

  it('streams, commits (close), and never aborts on success', async () => {
    const fs = seamFs();
    fs.stub();
    await writeToOpfsTarget(
      toOpfsTarget('/ok.bin'),
      streamOf(new Uint8Array([1]), new Uint8Array([2, 3])),
    );
    expect(fs.written.map((w) => [...w.data])).toEqual([[1], [2, 3]]);
    expect(fs.closed()).toBe(true);
    expect(fs.abortedWith()).toBeUndefined();
  });

  it('honors producer-positioned chunks relative to the startPosition base (positioned patch)', async () => {
    // startPosition 100 + a producer re-write tagged at output offset 0 ⇒ absolute file offset 100.
    const fs = seamFs();
    fs.stub();
    await writeToOpfsTarget(
      toOpfsTarget('/patch.bin', { keepExistingData: true, position: 100 }),
      streamOf(
        new Uint8Array([9, 9]), // cursor-append at 100 (after the seek)
        positionedChunk(new Uint8Array([1, 2]), 0), // re-write output offset 0 ⇒ file offset 100
      ),
    );
    expect(fs.seeks).toEqual([100]);
    expect(fs.written).toHaveLength(2);
    expect(fs.written[0]?.position).toBeUndefined(); // contiguous ⇒ plain cursor write
    expect(fs.written[1]?.position).toBe(100); // discontinuity ⇒ explicit WriteParams position
    expect([...(fs.written[1]?.data ?? [])]).toEqual([1, 2]);
    expect(fs.closed()).toBe(true);
  });

  it('aborts the writable and surfaces a typed mux-error when a write fails (no fake-complete file)', async () => {
    const fs = seamFs();
    fs.stub();
    const failure = new Error('disk full');
    fs.failNextWrite(failure);
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new Uint8Array([1]));
      },
      cancel(reason): void {
        cancelled = reason;
      },
    });
    const err = await writeToOpfsTarget(toOpfsTarget('/fail.bin'), stream).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('mux-error');
    // The failed write errored the writable itself, so the file was never committed: close() must not
    // have run, and per the Streams spec aborting an already-errored stream skips the abort hook.
    expect(fs.closed()).toBe(false);
    expect(cancelled).toBeDefined(); // upstream released
  });

  it('maps a failing directory walk to a typed mux-error', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: () => Promise.reject(new Error('storage exploded')),
      },
    });
    const err = await writeToOpfsTarget(
      toOpfsTarget('/x.bin'),
      streamOf(new Uint8Array([1])),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('mux-error');
    expect((err as MediaError).message).toContain('storage exploded');
  });

  it('a mid-stream abort rejects aborted and aborts the writable', async () => {
    const fs = seamFs();
    fs.stub();
    const ac = new AbortController();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c): void {
          c.enqueue(new Uint8Array([1]));
          ac.abort();
        },
      },
      { highWaterMark: 0 },
    );
    const err = await writeToOpfsTarget(toOpfsTarget('/aborted.bin'), stream, {
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('aborted');
    expect(fs.closed()).toBe(false);
    expect(fs.abortedWith()).toBeDefined();
  });
});
