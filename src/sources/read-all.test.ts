/**
 * `readAllBytes` — the one canonical whole-object read (docs/architecture/sources.md §5 item 5).
 * Strict oracle: all three capability paths (owned `readAll` → full `range(0, size)` → generic
 * abort-aware stream drain) must produce bit-identical bytes (sha-256) on a real fixture, the fast
 * paths must provably never open a stream, and aborts reject typed and cancel the reader.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MediaError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { type WholeReadable, drainStream, readAllBytes } from './read-all.ts';
import { fromBytes } from './source.ts';

const FIXTURE = 'h264.mp4';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function chunkedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const next = Math.min(offset + chunkSize, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, next));
        offset = next;
      },
    },
    { highWaterMark: 0 },
  );
}

describe('readAllBytes — one canonical whole-object read', () => {
  it('prefers the owned readAll fast path and provably never opens a stream', async () => {
    const truth = await loadFixture(FIXTURE);
    let readAllCalls = 0;
    const src: WholeReadable = {
      size: truth.byteLength,
      readAll: () => {
        readAllCalls++;
        return Promise.resolve(truth);
      },
      range: () => {
        throw new Error('range() must not be used when readAll exists');
      },
      stream: () => {
        throw new Error('stream() must not be called on the readAll fast path');
      },
    };

    const bytes = await readAllBytes(src);
    expect(readAllCalls).toBe(1);
    expect(bytes.byteLength).toBe(truth.byteLength);
    expect(sha256(bytes)).toBe(sha256(truth));
  });

  it('falls back to exactly one full range(0, size) read when no readAll exists', async () => {
    const truth = await loadFixture(FIXTURE);
    const windows: Array<readonly [number, number]> = [];
    const src: WholeReadable = {
      size: truth.byteLength,
      range: (start, end) => {
        windows.push([start, end]);
        return Promise.resolve(truth.subarray(start, Math.min(end, truth.byteLength)));
      },
      stream: () => {
        throw new Error('stream() must not be called when range + size exist');
      },
    };

    const bytes = await readAllBytes(src);
    expect(windows).toEqual([[0, truth.byteLength]]);
    expect(sha256(bytes)).toBe(sha256(truth));
  });

  it('drains a pure multi-chunk stream through the generic path, bit-identically', async () => {
    const truth = await loadFixture(FIXTURE);
    const src: WholeReadable = { stream: () => chunkedStream(truth, 64 * 1024) };

    const bytes = await readAllBytes(src);
    expect(bytes.byteLength).toBe(truth.byteLength);
    expect(sha256(bytes)).toBe(sha256(truth)); // all capability paths agree on the same real bytes
  });

  it('rejects typed before starting when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const read = readAllBytes(fromBytes(Uint8Array.of(1, 2, 3)), controller.signal);
    await expect(read).rejects.toBeInstanceOf(MediaError);
    await expect(read).rejects.toMatchObject({ code: 'aborted' });
  });

  it('aborts a mid-flight drain with a typed error and cancels the underlying reader', async () => {
    let pulls = 0;
    let cancelledWith: unknown;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          pulls++;
          if (pulls === 1) controller.enqueue(Uint8Array.of(7, 7, 7));
          // Later pulls never produce: the drain blocks awaiting the next chunk.
        },
        cancel(reason): void {
          cancelledWith = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();

    const draining = drainStream(stream, controller.signal);
    await Promise.resolve(); // let the first chunk flow and the second read start
    controller.abort(new MediaError('aborted', 'stop'));
    await expect(draining).rejects.toMatchObject({ code: 'aborted' });
    expect(cancelledWith).toBeInstanceOf(MediaError); // resources released exactly once
  });

  it('propagates a mid-stream failure unchanged (no silent partial buffers)', async () => {
    const failure = new Error('transport failed');
    const stream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        controller.enqueue(Uint8Array.of(1));
        controller.error(failure);
      },
    });

    await expect(drainStream(stream)).rejects.toBe(failure);
  });
});
