/**
 * Robustness of the MP4 stream-copy (remux/trim) byte path: a sample whose byte range escapes the
 * source — a truncated `mdat`, or a bit-flipped `stco`/`co64`/`stsz` entry that points past EOF — must
 * be rejected with a typed `MediaError`, never read as a clamped short buffer and copied as garbage
 * (graceful-failure, doc 11 §6.3). Structurally-valid input still round-trips. Real corpus media; no
 * browser (the byte path is pure TS).
 *
 * NOTE: corruption confined to the *coded sample payload* (e.g. flipped entropy-coded H.264/AAC bytes
 * with the box tree + sample table left intact) is NOT detectable by a container-level stream-copy —
 * the byte ranges stay in-bounds and the NAL framing still sums — so a lossless copy legitimately
 * passes it through. Catching that needs a full decode, which a keyframe copy-trim does not do.
 */

import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { Mp4Driver } from './mp4-driver.ts';

/** Absolute offset of the first box of `type` (descends container boxes); -1 if absent. */
function findBoxOffset(buf: Uint8Array, type: string): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const rec = (off: number, end: number): number => {
    let p = off;
    while (p + 8 <= end) {
      const size = dv.getUint32(p);
      const t = String.fromCharCode(
        buf[p + 4] ?? 0,
        buf[p + 5] ?? 0,
        buf[p + 6] ?? 0,
        buf[p + 7] ?? 0,
      );
      if (t === type) return p;
      if (containers.has(t)) {
        const found = rec(p + 8, p + size);
        if (found >= 0) return found;
      }
      if (size <= 0) break;
      p += size;
    }
    return -1;
  };
  return rec(0, buf.byteLength);
}

async function streamCopyBytes(bytes: Uint8Array): Promise<number> {
  if (!Mp4Driver.streamCopy) throw new Error('mp4 driver has no streamCopy');
  const stream = await Mp4Driver.streamCopy(fromBytes(bytes, { mime: 'video/mp4' }), {});
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
  }
  return total;
}

/** Set the first `stco` chunk-offset entry to `value` (corrupts where track samples are read from). */
function corruptFirstChunkOffset(bytes: Uint8Array, value: number): Uint8Array {
  const out = bytes.slice();
  const stco = findBoxOffset(out, 'stco');
  expect(stco).toBeGreaterThanOrEqual(0);
  // stco layout: size(4) type(4) version+flags(4) entry_count(4) then 4-byte offsets.
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(stco + 16, value >>> 0);
  return out;
}

describe('MP4 stream-copy robustness — out-of-range sample bytes reject cleanly', () => {
  it('a structurally-valid MP4 round-trips (sanity)', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    expect(await streamCopyBytes(bytes)).toBeGreaterThan(0);
  });

  it('a chunk offset pointing past EOF is rejected with a typed MediaError', async () => {
    const bytes = corruptFirstChunkOffset(await loadFixture('movie_5.mp4'), 900_000_000);
    await expect(streamCopyBytes(bytes)).rejects.toBeInstanceOf(MediaError);
    await expect(streamCopyBytes(bytes)).rejects.toThrow(/outside the source|truncated|corrupt/i);
  });

  it('a source truncated mid-mdat (samples promised past the new EOF) is rejected', async () => {
    const full = await loadFixture('test.mp4');
    // Drop the tail so the later samples the index references no longer exist. test.mp4 is faststart
    // (moov first), so the header still parses but the trailing sample bytes are gone.
    const truncated = full.subarray(0, Math.floor(full.byteLength * 0.6)).slice();
    await expect(streamCopyBytes(truncated)).rejects.toBeInstanceOf(MediaError);
  });

  it('the rejection is the typed error model (demux-error code), not a raw throw', async () => {
    const bytes = corruptFirstChunkOffset(await loadFixture('movie_5.mp4'), 0xffffffff);
    await expect(streamCopyBytes(bytes)).rejects.toMatchObject({ code: 'demux-error' });
  });
});
