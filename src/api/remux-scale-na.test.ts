/**
 * Oversize cross-container remux is an honest, typed scale-NA — NOT a 30s hang / OOM (conf-killer #3,
 * ADR-094). The MP4/WebM EncodedChunk-seam muxers buffer every packet and serialize the whole file at
 * `finalize()`, so a multi-GB remux (e.g. 2h 1080p mp4→mkv) would exhaust an in-browser tab's memory.
 * The engine now declines such a remux UP FRONT — from the known source size, before demuxing — with a
 * typed {@link CapabilityError}, instead of attempting the buffer-all serialize and timing out.
 *
 * This is the Node-checkable half of the fix: the gate fires in `#remuxViaSeam` before any packet is read,
 * so a `Source` with a real MP4 head (for container routing) but a faked >1 GiB `size` triggers it without
 * needing real gigabytes or WebCodecs. The graceful-failure oracle (doc 11 §5) accepts a typed reject here;
 * the streaming-Cluster mux that lifts the ceiling is the sequenced SOTA follow-up (ADR-094).
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

describe('remux scale-NA — an oversize cross-container remux declines up front with a typed CapabilityError', () => {
  it('a >1 GiB mp4→mkv remux raises CapabilityError BEFORE attempting the buffer-all serialize', async () => {
    const src = mp4SourceWithSize(await mp4Bytes(), 2 * GIB); // a "2-hour 1080p"-scale source
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const err = await media.remux(src, { to: 'mkv' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err, 'oversize remux rejects').toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe('capability-miss');
    // The message names the real resource limit (memory / MB), not a fake "unsupported codec".
    expect((err as CapabilityError).message).toMatch(/buffer|memory|MB/i);
  });

  it('the reject is fast (the gate runs before demux — no hang / no whole-file read)', async () => {
    const src = mp4SourceWithSize(await mp4Bytes(), 4 * GIB);
    const media = createMedia().use(Mp4Module).use(WebmModule);
    const t0 = Date.now();
    await media.remux(src, { to: 'mkv' }).catch(() => undefined);
    // Up-front gate ⇒ well under a second (the 30s harness timeout is what this prevents).
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
