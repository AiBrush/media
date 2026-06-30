/**
 * Oversize cross-container MP4→WebM/MKV remux is no longer a scale-NA: S8 routes it to the streaming
 * Cluster-on-write muxer (ADR-113), so the old buffer-all memory gate must not fire. Node still cannot
 * execute the browser packet seam because it lacks WebCodecs `EncodedChunk` constructors; that remains a
 * typed capability miss here, while the browser matrix validates the real pass.
 *
 * This is the Node-checkable half of the fix: a `Source` with a real MP4 head but a faked >1 GiB `size`
 * must bypass the memory-limit message and reach the browser-only streaming-remux boundary instead.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import { Mp4Module } from '../drivers/mp4/mp4-driver.ts';
import { WebmModule } from '../drivers/webm/webm-driver.ts';
import { type Source, fromBytes } from '../sources/source.ts';
import { createMedia } from './create-media.ts';

const ROOT = new URL('../../', import.meta.url).pathname;

/**
 * A valid `Source` over real MP4 bytes (so the container router recognizes mp4) but with `size` overridden
 * to model a large file — the scale gate reads `src.size` before the demuxer touches the body, so the
 * actual byte count can stay tiny.
 */
function mp4SourceWithSize(bytes: Uint8Array, size: number): Source {
  const src = fromBytes(bytes, { mime: 'video/mp4' });
  // `size` is an own data property on the fromBytes result; override it to the modeled large value.
  Object.defineProperty(src, 'size', { value: size, configurable: true, enumerable: true });
  return src;
}

async function mp4Bytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${ROOT}fixtures/media/movie_5.mp4`));
}

const GIB = 1024 * 1024 * 1024;

describe('remux scale — oversize mp4→mkv uses the streaming WebM/MKV route', () => {
  it('a >1 GiB mp4→mkv remux no longer raises the buffer-all memory gate', async () => {
    const src = mp4SourceWithSize(await mp4Bytes(), 2 * GIB); // a "2-hour 1080p"-scale source
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const err = await media.remux(src, { to: 'mkv' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err, 'Node reaches the browser-only streaming packet seam').toBeInstanceOf(
      CapabilityError,
    );
    expect((err as CapabilityError).code).toBe('capability-miss');
    expect((err as CapabilityError).message).toMatch(/EncodedChunk constructors/i);
    expect((err as CapabilityError).message).not.toMatch(/buffer|memory|MB/i);
  });

  it('the Node miss is fast and does not attempt the old buffer-all serialize', async () => {
    const src = mp4SourceWithSize(await mp4Bytes(), 4 * GIB);
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const t0 = Date.now();
    await media.remux(src, { to: 'mkv' }).catch(() => undefined);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('the oracle can fail — a normally-sized mp4→mkv remux does NOT hit the scale gate', async () => {
    // A small source (real fixture size, well under the ceiling) must NOT be declined by the scale gate;
    // it proceeds to the seam (which, in Node, reaches the WebCodecs `EncodedChunk` miss — a DIFFERENT,
    // browser-only capability miss, NOT the memory-limit message). So the scale gate is size-specific.
    const bytes = await mp4Bytes();
    const src = mp4SourceWithSize(bytes, bytes.byteLength); // ~32 KB — far below the 1 GiB ceiling
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const err = await media.remux(src, { to: 'mkv' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // It may still be a CapabilityError (the browser-only EncodedChunk miss in Node), but it must NOT be the
    // memory/buffer scale message — proving the scale gate did not fire for a normal-sized file.
    if (err instanceof CapabilityError) {
      expect(err.message).not.toMatch(
        /buffer.*memory|memory.*buffer|exceeding the in-browser buffer-all/i,
      );
    }
  });
});
