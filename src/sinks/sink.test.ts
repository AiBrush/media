import { readFile, readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Progress } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { toOpfsTarget } from './opfs-target.ts';
import { type Sink, materialize, toBlob, toElement, toFile, toOPFS, toStream } from './sink.ts';
import { toStreamTarget } from './stream-target.ts';

function bytesStream(...arrays: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      for (const a of arrays) c.enqueue(new Uint8Array(a));
      c.close();
    },
  });
}

/** A pull-driven producer that deliberately recycles one backing store between delivered chunks. */
function reusedChunkStream(...arrays: number[][]): ReadableStream<Uint8Array> {
  const storage = new Uint8Array(Math.max(0, ...arrays.map((array) => array.length)));
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        const array = arrays[index];
        if (array === undefined) {
          controller.close();
          return;
        }
        index++;
        storage.fill(0);
        storage.set(array);
        controller.enqueue(storage.subarray(0, array.length));
      },
    },
    { highWaterMark: 0 },
  );
}

/** Stream `bytes` in several chunks so whole-output sinks are exercised with distinct parts. */
function chunkedStream(bytes: Uint8Array, chunk = 4096): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      for (let o = 0; o < bytes.byteLength; o += chunk) {
        c.enqueue(bytes.subarray(o, Math.min(o + chunk, bytes.byteLength)));
      }
      c.close();
    },
  });
}

async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = s.getReader();
  const out: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  const total = out.reduce((n, c) => n + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of out) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return buf;
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  for (let i = 0; i < expected.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`byte mismatch at ${i}: got ${actual[i]}, expected ${expected[i]}`);
    }
  }
}

describe('sink descriptors', () => {
  it('build the expected shapes', () => {
    expect(toBlob()).toEqual({ kind: 'blob' });
    expect(toFile('a.mp4')).toEqual({ kind: 'file', name: 'a.mp4' });
    expect(toStream()).toEqual({ kind: 'stream' });
    expect(toOPFS('/o.mp4')).toEqual({ kind: 'opfs', path: '/o.mp4' });
    const el = {} as HTMLMediaElement;
    expect(toElement(el)).toEqual({ kind: 'element', el, via: 'blob' });
    expect(toElement(el, { via: 'mse' }).via).toBe('mse');
  });
});

describe('materialize', () => {
  it('materializes a multi-chunk Blob with the given mime and exact bytes', async () => {
    const out = await materialize(toBlob(), bytesStream([1, 2], [3]), { mime: 'video/mp4' });
    expect(out).toBeInstanceOf(Blob);
    const blob = out as Blob;
    expect(blob.type).toBe('video/mp4');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('materializes a Blob without forcing an empty mime option', async () => {
    const out = await materialize(toBlob(), bytesStream([7, 8]));
    expect(out).toBeInstanceOf(Blob);
    const blob = out as Blob;
    expect(blob.type).toBe('');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([7, 8]);
  });

  it('materializes a multi-chunk named File with exact bytes', async () => {
    const out = await materialize(toFile('clip.mp4'), bytesStream([9], [8, 7]));
    expect(out).toBeInstanceOf(File);
    expect((out as File).name).toBe('clip.mp4');
    expect([...new Uint8Array(await (out as File).arrayBuffer())]).toEqual([9, 8, 7]);
  });

  it('materializes a named File with an explicit MIME type', async () => {
    const out = await materialize(toFile('clip.mp4'), bytesStream([9]), { mime: 'video/mp4' });
    expect(out).toBeInstanceOf(File);
    expect((out as File).type).toBe('video/mp4');
  });

  it('reports cumulative collect progress for every retained Blob part', async () => {
    const seen: Progress[] = [];
    const out = await materialize(toBlob(), bytesStream([1, 2], [3], [4, 5, 6]), {
      onProgress: (progress) => seen.push(progress),
    });

    expect(out).toBeInstanceOf(Blob);
    expect(seen).toEqual([
      { done: 2, stage: 'collect' },
      { done: 3, stage: 'collect' },
      { done: 6, stage: 'collect' },
    ]);
  });

  it('aborts in-flight Blob part collection and cancels the source', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const seen: Progress[] = [];
    const pending = materialize(toBlob(), source, {
      signal: controller.signal,
      onProgress: (progress) => {
        seen.push(progress);
        controller.abort();
      },
    });

    await expect(pending).rejects.toMatchObject({ name: 'MediaError', code: 'aborted' });
    expect(cancelled).toBe(true);
    expect(seen).toEqual([{ done: 2, stage: 'collect' }]);
  });

  it('maps a File source failure with the supplied error code', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.error(new Error('broken output'));
      },
    });

    await expect(
      materialize(toFile('clip.mp4'), source, { errorCode: 'mux-error' }),
    ).rejects.toMatchObject({
      name: 'MediaError',
      code: 'mux-error',
      message: 'broken output',
    });
  });

  it('returns a stream sink lazily (the same stream)', async () => {
    const stream = bytesStream([1]);
    expect(await materialize(toStream(), stream)).toBe(stream);
  });

  it('rejects an unknown sink kind', async () => {
    const bogus = { kind: 'bogus' } as unknown as Sink;
    await expect(materialize(bogus, bytesStream([1]))).rejects.toBeInstanceOf(InputError);
  });

  it('delegates a stream-target sink to writeToStreamTarget (incremental writes, contiguous positions)', async () => {
    // A streaming destination (doc 09 streaming-output, ADR-034): each produced chunk is written straight
    // to the caller's callback with its running byte offset, never buffering the whole output. materialize
    // returns undefined (the bytes went to the target), matching the OPFS/element sinks.
    const writes: { bytes: number[]; position: number }[] = [];
    const target = toStreamTarget((chunk, position) => {
      writes.push({ bytes: [...chunk], position });
    });
    const out = await materialize(target, bytesStream([1, 2], [3], [4, 5, 6]));
    expect(out).toBeUndefined();
    expect(writes.map((w) => w.bytes)).toEqual([[1, 2], [3], [4, 5, 6]]);
    expect(writes.map((w) => w.position)).toEqual([0, 2, 3]); // contiguous, starting at 0
  });
});

describe('materialize — Blob/File part construction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * A `Blob` stand-in that records the parts it was handed and can flatten a nested part list back to
   * bytes — so a test can assert the produced byte sequence without depending on how many segments the
   * materializer spilled it into.
   */
  class RecordingBlob {
    static readonly calls: { parts: BlobPart[]; options: BlobPropertyBag | undefined }[] = [];
    readonly parts: BlobPart[];
    constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
      this.parts = [...parts];
      RecordingBlob.calls.push({ parts: this.parts, options });
    }
  }

  function flatten(parts: readonly BlobPart[]): number[] {
    const bytes: number[] = [];
    for (const part of parts) {
      if (part instanceof RecordingBlob) bytes.push(...flatten(part.parts));
      else bytes.push(...(part as Uint8Array));
    }
    return bytes;
  }

  function ownedHeapParts(parts: readonly BlobPart[]): Uint8Array[] {
    const owned: Uint8Array[] = [];
    for (const part of parts) {
      if (part instanceof RecordingBlob) owned.push(...ownedHeapParts(part.parts));
      else owned.push(part as Uint8Array);
    }
    return owned;
  }

  it('copies reusable-source chunks and preserves the exact produced byte sequence', async () => {
    RecordingBlob.calls.length = 0;
    vi.stubGlobal('Blob', RecordingBlob);

    const out = await materialize(toBlob(), reusedChunkStream([1, 2], [3], [4, 5, 6]), {
      mime: 'video/mp4',
    });

    expect(out).toBeInstanceOf(RecordingBlob);
    const published = RecordingBlob.calls.at(-1);
    // A producer that recycles ONE backing store must still yield the exact emitted sequence, which is
    // only possible if every delivered chunk was copied before backpressure was released.
    expect(flatten(published?.parts ?? [])).toEqual([1, 2, 3, 4, 5, 6]);
    const owned = ownedHeapParts(published?.parts ?? []);
    expect(owned.map((part) => part.byteLength)).toEqual([2, 1, 3]);
    expect(new Set(owned.map((part) => part.buffer)).size).toBe(3);
    // No total-sized join: nothing handed over is a single buffer holding the whole output.
    expect(owned.some((part) => part.byteLength === 6)).toBe(false);
    expect(published?.options).toEqual({ type: 'video/mp4' });
  });

  it('spills to user-agent blob storage so heap retention stays flat in the output size', async () => {
    RecordingBlob.calls.length = 0;
    vi.stubGlobal('Blob', RecordingBlob);

    // Twenty-four 1 MiB chunks: with an 8 MiB spill segment the materializer must hand the user agent
    // three intermediate segments and hold at most one segment's worth of bytes on the heap at a time.
    const chunkBytes = 1024 * 1024;
    const chunks = Array.from({ length: 24 }, (_unused, index) => {
      const chunk = new Uint8Array(chunkBytes);
      chunk.fill(index & 0xff);
      return chunk;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const out = await materialize(toBlob(), stream, {});
    expect(out).toBeInstanceOf(RecordingBlob);
    const published = RecordingBlob.calls.at(-1);
    const segments = (published?.parts ?? []).filter((part) => part instanceof RecordingBlob);
    expect(segments.length).toBe(3);
    for (const segment of segments) {
      const bytes = ownedHeapParts((segment as RecordingBlob).parts).reduce(
        (total, part) => total + part.byteLength,
        0,
      );
      expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
    // Every byte still reaches the output exactly once, in order.
    const flat = ownedHeapParts(published?.parts ?? []);
    expect(flat.reduce((total, part) => total + part.byteLength, 0)).toBe(24 * chunkBytes);
    expect(flat.map((part) => part[0])).toEqual(chunks.map((_unused, index) => index & 0xff));
  });

  it('passes the spilled parts and metadata to the File constructor without joining', async () => {
    RecordingBlob.calls.length = 0;
    const calls: { parts: BlobPart[]; name: string; options: FilePropertyBag | undefined }[] = [];
    class RecordingFile {
      constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
        calls.push({ parts: [...parts], name, options });
      }
    }
    vi.stubGlobal('Blob', RecordingBlob);
    vi.stubGlobal('File', RecordingFile);

    const out = await materialize(toFile('clip.mp4'), bytesStream([9, 8], [7], [6, 5, 4]), {
      mime: 'video/mp4',
    });

    expect(out).toBeInstanceOf(RecordingFile);
    expect(calls).toHaveLength(1);
    expect(flatten(calls[0]?.parts ?? [])).toEqual([9, 8, 7, 6, 5, 4]);
    expect(ownedHeapParts(calls[0]?.parts ?? []).map((part) => part.byteLength)).toEqual([2, 1, 3]);
    expect(calls[0]?.name).toBe('clip.mp4');
    expect(calls[0]?.options).toEqual({ type: 'video/mp4' });
  });
});

describe('materialize — stubbed environment sinks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes to an OPFS file via a stubbed StorageManager', async () => {
    const written: number[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk): void {
        written.push(...chunk);
      },
    });
    const handle = { createWritable: () => Promise.resolve(writable) };
    const root = {
      getDirectoryHandle: () => Promise.resolve(root),
      getFileHandle: () => Promise.resolve(handle),
    };
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(root) } });

    expect(await materialize(toOPFS('/media/out.mp4'), bytesStream([4, 5, 6]))).toBeUndefined();
    expect(written).toEqual([4, 5, 6]);
  });

  it('rejects an OPFS sink with a typed capability miss when OPFS is unavailable (doc 09 §5 item 6)', async () => {
    // OPFS-absent is a capability miss, not bad input — the basic path must agree with opfs-target.
    vi.stubGlobal('navigator', {});
    const err = await materialize(toOPFS('/x'), bytesStream([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe('capability-miss');
  });

  it('rejects an OPFS path with no file name after normalization', async () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve({}) } });
    await expect(materialize(toOPFS('///'), bytesStream([1]))).rejects.toBeInstanceOf(InputError);
  });

  it('attaches a Blob URL to an event-capable media element (via:blob)', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const el = Object.assign(new EventTarget(), {
      src: '',
      load(): void {},
      removeAttribute(name: string): void {
        if (name === 'src') this.src = '';
      },
    }) as unknown as HTMLMediaElement;
    await materialize(toElement(el), bytesStream([1, 2]));
    expect(el.src).toBe('blob:fake');
  });
});

// Every sink must write **bit-identical** output for a real file's bytes — synthetic streams alone don't
// prove the collect/concat path is byte-faithful at size (BUILD_INSTRUCTIONS §6, ADR-018).
describe('materialize — bit-exact output on a real corpus file', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Blob sink output equals the file byte-for-byte', async () => {
    const truth = await loadFixture('h264.mp4');
    const out = (await materialize(toBlob(), chunkedStream(truth), { mime: 'video/mp4' })) as Blob;
    expect(out).toBeInstanceOf(Blob);
    expect(out.type).toBe('video/mp4');
    expectBytesEqual(new Uint8Array(await out.arrayBuffer()), truth);
  });

  it('File sink output equals the file byte-for-byte (and carries the name)', async () => {
    const truth = await loadFixture('h264.mp4');
    const out = (await materialize(toFile('out.mp4'), chunkedStream(truth))) as File;
    expect(out).toBeInstanceOf(File);
    expect(out.name).toBe('out.mp4');
    expectBytesEqual(new Uint8Array(await out.arrayBuffer()), truth);
  });

  it('Stream sink hands back a lazy readable that yields the exact bytes', async () => {
    const truth = await loadFixture('h264.mp4');
    const out = (await materialize(toStream(), chunkedStream(truth))) as ReadableStream<Uint8Array>;
    expectBytesEqual(await readAll(out), truth);
  });

  it('OPFS sink streams the exact bytes to the writable (stubbed FileSystem)', async () => {
    const truth = await loadFixture('h264.mp4');
    const written: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk): void {
        written.push(chunk.slice());
      },
    });
    const handle = { createWritable: () => Promise.resolve(writable) };
    const root = {
      getDirectoryHandle: () => Promise.resolve(root),
      getFileHandle: () => Promise.resolve(handle),
    };
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(root) } });

    expect(await materialize(toOPFS('/clips/out.mp4'), chunkedStream(truth))).toBeUndefined();
    const total = written.reduce((n, c) => n + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of written) {
      merged.set(c, off);
      off += c.byteLength;
    }
    expectBytesEqual(merged, truth);
  });
});

/**
 * `OpfsTarget` is wired into the public sink path (doc 09 §5 item 1): the union member routes through
 * `materialize` to `writeToOpfsTarget`, and the richer options (`keepExistingData`, `position`) reach
 * the FileSystemWritableFileStream seam — asserted against a recording mock, never a stub that can't fail.
 */
describe('materialize — opfs-target (the rich OPFS streaming sink)', () => {
  afterEach(() => vi.unstubAllGlobals());

  interface RecordingFs {
    root: {
      getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<unknown>;
      getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<unknown>;
    };
    dirs: string[];
    files: string[];
    createWritableOptions: unknown[];
    seeks: number[];
    written: Uint8Array[];
    closed: () => boolean;
  }

  function recordingFs(): RecordingFs {
    const dirs: string[] = [];
    const files: string[] = [];
    const createWritableOptions: unknown[] = [];
    const seeks: number[] = [];
    const written: Uint8Array[] = [];
    let closed = false;
    const writable = Object.assign(
      new WritableStream<Uint8Array>({
        write(chunk): void {
          written.push(chunk.slice());
        },
        close(): void {
          closed = true;
        },
      }),
      {
        seek(position: number): Promise<void> {
          seeks.push(position);
          return Promise.resolve();
        },
      },
    );
    const handle = {
      createWritable(opts?: unknown): Promise<unknown> {
        createWritableOptions.push(opts);
        return Promise.resolve(writable);
      },
    };
    const root = {
      getDirectoryHandle(name: string): Promise<unknown> {
        dirs.push(name);
        return Promise.resolve(root);
      },
      getFileHandle(name: string): Promise<unknown> {
        files.push(name);
        return Promise.resolve(handle);
      },
    };
    return { root, dirs, files, createWritableOptions, seeks, written, closed: () => closed };
  }

  it('routes toOpfsTarget through materialize: createWritable({keepExistingData:true}) and seek(N) run', async () => {
    const fs = recordingFs();
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(fs.root) } });

    const out = await materialize(
      toOpfsTarget('/a/b/out.mp4', { keepExistingData: true, position: 32 }),
      bytesStream([1, 2, 3], [4]),
    );

    expect(out).toBeUndefined();
    expect(fs.dirs).toEqual(['a', 'b']);
    expect(fs.files).toEqual(['out.mp4']);
    expect(fs.createWritableOptions).toEqual([{ keepExistingData: true }]);
    expect(fs.seeks).toEqual([32]); // the patch-write seam actually ran via the public path
    expect(fs.written.map((c) => [...c])).toEqual([[1, 2, 3], [4]]);
    expect(fs.closed()).toBe(true); // the write was committed, not left dangling
  });

  it('defaults to a truncating write at position 0 (no seek)', async () => {
    const fs = recordingFs();
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(fs.root) } });

    await materialize(toOpfsTarget('/out.bin'), bytesStream([7, 8]));
    expect(fs.createWritableOptions).toEqual([{ keepExistingData: false }]);
    expect(fs.seeks).toEqual([]);
    expect(fs.written.map((c) => [...c])).toEqual([[7, 8]]);
  });

  it('agrees with the basic opfs path: OPFS-absent is a CapabilityError capability-miss (item 6)', async () => {
    vi.stubGlobal('navigator', {});
    const viaTarget = await materialize(toOpfsTarget('/x.bin'), bytesStream([1])).catch(
      (e: unknown) => e,
    );
    const viaBasic = await materialize(toOPFS('/x.bin'), bytesStream([1])).catch((e: unknown) => e);
    for (const err of [viaTarget, viaBasic]) {
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).code).toBe('capability-miss');
    }
  });

  it('opfs-target.ts has a non-test importer (the sink is not orphaned)', async () => {
    // Coverage-shaped wiring check (doc 09 §4 "OpfsTarget is ORPHANED"): fails if no non-test module
    // under src/sinks imports the opfs-target module, i.e. if the good implementation is unreachable.
    const dir = new URL('.', import.meta.url).pathname;
    const entries = (await readdir(dir)).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'opfs-target.ts',
    );
    const importers: string[] = [];
    for (const entry of entries) {
      const text = await readFile(`${dir}/${entry}`, 'utf8');
      if (/from '\.\/opfs-target\.ts'/.test(text)) importers.push(entry);
    }
    expect(importers.length).toBeGreaterThan(0);
  });
});
