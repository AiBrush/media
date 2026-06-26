/**
 * FLAC mux FAITHFULNESS verification (baseline NA-flip: MUX_FAITHFUL_TARGETS += 'flac'). Proves the engine's
 * `FlacMuxer` performs a BYTE-LOSSLESS FLAC→FLAC remux — the authored `.flac`'s native audio frames are
 * byte-identical to the source's — so the harness adapter may honestly declare FLAC a faithful mux target.
 *
 * Pure-Node (no WebCodecs seam): parse a real `.flac` into its `fLaC`+metadata prelude
 * ({@link nativeFlacMetadata}) and its native frames ({@link enumerateFlacFrames}), feed them through
 * `FlacMuxer.addChunkStruct` (the exact path `write()` uses after its browser-only `copyTo`), finalize, and
 * assert every output frame's bytes equal the corresponding source frame's bytes. The muxer copies frames
 * verbatim, so a faithful remux reproduces them exactly; a re-encode or dropped frame would diverge → fail.
 *
 * Fixtures (diverse real FLAC): `sfx.flac`, `flac-qlp2.flac` (LPC order 2), `flac-24bit-hires.flac` (24-bit).
 */

import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-support/corpus.ts';
import { FlacMuxer, enumerateFlacFrames, nativeFlacMetadata } from './flac-driver.ts';

/** Drain a muxer's output stream into one buffer. */
async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** FLAC→FLAC remux via FlacMuxer (the Node-drivable path): prelude as description, native frames as chunks. */
async function remuxFlac(bytes: Uint8Array): Promise<Uint8Array> {
  const metadata = nativeFlacMetadata(bytes);
  const frames = enumerateFlacFrames(bytes);
  const muxer = new FlacMuxer();
  const track = muxer.addTrack({
    id: 0,
    mediaType: 'audio',
    codec: 'flac',
    config: { codec: 'flac', sampleRate: 48_000, numberOfChannels: 1, description: metadata },
  });
  for (const f of frames) {
    muxer.addChunkStruct(track, {
      timestampUs: 0,
      durationUs: undefined,
      key: true,
      data: bytes.subarray(f.offset, f.offset + f.size),
    });
  }
  await muxer.finalize();
  return collectBytes(muxer.output);
}

const CASES: readonly string[] = ['sfx.flac', 'flac-qlp2.flac', 'flac-24bit-hires.flac'];

describe('FLAC mux faithfulness — FlacMuxer is a byte-lossless FLAC→FLAC remux (baseline NA-flip)', () => {
  it('reproduces every native FLAC frame byte-identically across ≥3 real files', async () => {
    expect(CASES.length).toBeGreaterThanOrEqual(3);
    for (const id of CASES) {
      const bytes = await loadFixture(id);
      const srcFrames = enumerateFlacFrames(bytes);
      expect(srcFrames.length, `${id}: source has FLAC frames`).toBeGreaterThan(0);

      const out = await remuxFlac(bytes);
      const outFrames = enumerateFlacFrames(out);
      expect(outFrames.length, `${id}: output frame count`).toBe(srcFrames.length);

      for (let i = 0; i < srcFrames.length; i++) {
        const a = bytes.subarray(
          srcFrames[i]?.offset,
          (srcFrames[i]?.offset ?? 0) + (srcFrames[i]?.size ?? 0),
        );
        const b = out.subarray(
          outFrames[i]?.offset,
          (outFrames[i]?.offset ?? 0) + (outFrames[i]?.size ?? 0),
        );
        expect(b.byteLength, `${id} frame ${i} size`).toBe(a.byteLength);
        expect(Buffer.from(b).equals(Buffer.from(a)), `${id} frame ${i} bytes identical`).toBe(
          true,
        );
      }
    }
  }, 60_000);
});
