import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
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

/** Stream `bytes` in several chunks so the sink's collect/concat path is exercised (not one buffer). */
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
  it('collects into a Blob with the given mime', async () => {
    const out = await materialize(toBlob(), bytesStream([1, 2], [3]), { mime: 'video/mp4' });
    expect(out).toBeInstanceOf(Blob);
    const blob = out as Blob;
    expect(blob.type).toBe('video/mp4');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('collects into a named File', async () => {
    const out = await materialize(toFile('clip.mp4'), bytesStream([9]));
    expect(out).toBeInstanceOf(File);
    expect((out as File).name).toBe('clip.mp4');
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

  it('rejects an OPFS sink when OPFS is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    await expect(materialize(toOPFS('/x'), bytesStream([1]))).rejects.toBeInstanceOf(InputError);
  });

  it('attaches a Blob URL to an element (via:blob) and rejects other vias', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const el = { src: '' } as HTMLMediaElement;
    await materialize(toElement(el), bytesStream([1, 2]));
    expect(el.src).toBe('blob:fake');

    await expect(
      materialize(toElement(el, { via: 'mse' }), bytesStream([1])),
    ).rejects.toBeInstanceOf(InputError);
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
