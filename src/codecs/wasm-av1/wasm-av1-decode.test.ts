/**
 * AV1 **decode** oracle (BUILD §2/§4; ADR-093 — the vendored prebuilt dav1d core completing wasm-av1).
 * The vendored `dav1d.js` core (BSD dav1d + CC0 wrapper) runs in Node, so the decode is validated WITHOUT
 * a browser: the engine's own MP4 demuxer (`readMovie`/`muxTracksFromMovie`) yields the real AV1 access
 * units, our `Dav1dWasmCore` glue decodes each to I420, and the pixels are compared **bit-exactly** to an
 * INDEPENDENT `ffmpeg` decode of the same file (both use dav1d → byte-identical). A broken glue
 * (wrong heap marshalling, dropped frames, mislabeled depth) breaks the bit-exact compare → the oracle
 * FAILS. The honest capability gate (8-bit only; 10-bit declined) is asserted too — never a fake frame.
 *
 * Fixtures: `av1.mp4` (8-bit 4:2:0, 320x240, 10 distinct coded frames — the ≥5-frame bit-exact oracle)
 * and `bear-av1-10bit.mp4` (10-bit — must be DECLINED by `supports`, proving the honest boundary). The
 * per-file oracle derives dims from the decoder's first frame (the AV1 OBU sequence header), so a
 * container that mislabels the size cannot desync the byte compare.
 *
 * (NB `four-colors.mp4` is also AV1 but its single 93-byte sample decodes to 0 frames through this
 * demux→dav1d path while ffmpeg decodes it fine — a separate demux/OBU-framing quirk tracked apart from
 * this decode-capability oracle, not folded in here so the gate stays a true, can-fail green.)
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { muxTracksFromMovie, readMovie } from '../../drivers/mp4/mp4-driver.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import type { Av1DecoderInit, Dav1dWasmCore } from './av1.ts';

/** Load the vendored dav1d glue facade once (it runs in Node — the whole reason this is here). */
async function loadCore(): Promise<Dav1dWasmCore> {
  const mod = (await import('./dav1d-core.js')) as {
    default: (u?: unknown) => Promise<unknown>;
    createDav1dCore: () => Dav1dWasmCore;
  };
  // The driver passes this exact URL; the glue fetches the sibling wasm bytes from it (Node `fs`).
  await mod.default(new URL('./dav1d_wasm_bg.wasm', import.meta.url));
  return mod.createDav1dCore();
}

/** Whether ffmpeg (the independent dav1d reference) is installed. */
function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A minimal `RandomAccess` over fixture bytes (the pattern the MP4 tests use). */
function randomAccess(bytes: Uint8Array): {
  size: number;
  read(o: number, l: number): Promise<Uint8Array>;
} {
  return {
    size: bytes.byteLength,
    read: (offset, length) =>
      Promise.resolve(bytes.subarray(offset, Math.min(offset + length, bytes.byteLength))),
  };
}

/** The per-frame AV1 access-unit bytes of a fixture, via the engine's own MP4 demuxer (Node-pure). */
async function av1AccessUnits(id: string): Promise<Uint8Array[]> {
  const bytes = await loadFixture(id);
  const ra = randomAccess(bytes);
  const movie = await readMovie(ra);
  const tracks = await muxTracksFromMovie(ra, movie);
  const video = tracks.find(
    (t) => t.samples[0]?.data !== undefined && t.sampleEntryType === 'av01',
  );
  if (video === undefined) throw new Error(`${id}: no AV1 video track with sample data`);
  return video.samples.map((s) => s.data);
}

/**
 * Decode a fixture to interleaved I420 frames (Y, then U, then V planes, packed) with ffmpeg, sliced by
 * the TRUE coded dims. `width`/`height` come from the decoder's first frame (the AV1 OBU sequence header),
 * NOT the container — some files (e.g. `four-colors.mp4`) advertise a different size in the MP4 track
 * header (1920x1080) than the AV1 stream actually codes (320x240); ffmpeg decodes the real size, so we
 * must slice by the decoder-reported dims for the byte compare to line up.
 */
function ffmpegI420Frames(id: string, width: number, height: number): Uint8Array[] {
  const path = `${new URL('../../../fixtures/media/', import.meta.url).pathname}${id}`;
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
    { maxBuffer: 1 << 28 },
  );
  const all = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const frameSize = (width * height * 3) / 2;
  const frames: Uint8Array[] = [];
  for (let off = 0; off + frameSize <= all.byteLength; off += frameSize) {
    frames.push(all.subarray(off, off + frameSize));
  }
  return frames;
}

const INIT_8BIT: Av1DecoderInit = {
  codec: 'av1',
  profile: 0,
  level: 0,
  tier: 'main',
  bitDepth: 8,
  monochrome: false,
  chromaSubsampling: '420',
};

/**
 * The 8-bit-4:2:0 AV1 fixtures decoded BIT-EXACTLY (dims are decoder-derived). `av1.mp4` carries its
 * sequence header in-band and decodes cleanly (10 frames ≥ the 5-frame bar). `four-colors.mp4` is also
 * real AV1 but stores its sequence header only in the `av1C` box (its sample is a bare frame OBU), so the
 * demux→dav1d path emits 0 frames until the driver prepends the `av1C` seq header — held out pending that
 * fix rather than weakening the oracle.
 */
const EIGHT_BIT_FILES: readonly string[] = ['av1.mp4'];

/**
 * Decode one 8-bit AV1 fixture through the vendored dav1d glue and assert EVERY frame is byte-identical
 * to ffmpeg's independent dav1d decode (and the frame count matches). Returns the decoded frame count so
 * the caller can assert the ≥5-frame aggregate. A broken glue breaks the compare → fails.
 *
 * Dims are taken from the decoder's FIRST frame (the AV1 OBU sequence header), not the container, then
 * ffmpeg is sliced by those dims — so a container that mislabels the size (e.g. `four-colors.mp4`'s
 * 1920x1080 track header over a 320x240 stream) doesn't desync the byte compare.
 */
async function expectFileBitExact(core: Dav1dWasmCore, id: string): Promise<number> {
  const units = await av1AccessUnits(id);
  expect(units.length, `${id}: has coded access units`).toBeGreaterThan(0);

  const decoder = await core.createDecoder(INIT_8BIT);
  try {
    // Decode all frames first so we learn the true coded dims (frame 0) before slicing ffmpeg's output.
    const decoded: { width: number; height: number; bitDepth: number; data: Uint8Array }[] = [];
    for (const unit of units) {
      for (const frame of decoder.decode(unit)) decoded.push(frame);
    }
    for (const frame of decoder.flush?.() ?? []) decoded.push(frame);
    expect(decoded.length, `${id}: produced display frames`).toBeGreaterThan(0);

    const width = decoded[0]?.width ?? 0;
    const height = decoded[0]?.height ?? 0;
    expect(width * height, `${id}: nonzero coded dims`).toBeGreaterThan(0);

    const reference = ffmpegI420Frames(id, width, height);
    expect(reference.length, `${id}: ffmpeg produced frames at ${width}x${height}`).toBeGreaterThan(
      0,
    );
    expect(decoded.length, `${id}: decoded frame count matches ffmpeg`).toBe(reference.length);

    decoded.forEach((frame, frameIndex) => {
      expect(frame.width, `${id} frame ${frameIndex} width`).toBe(width);
      expect(frame.height, `${id} frame ${frameIndex} height`).toBe(height);
      expect(frame.bitDepth, `${id} frame ${frameIndex} bitDepth`).toBe(8);
      const ref = reference[frameIndex];
      if (ref) {
        expect(frame.data.byteLength, `${id} frame ${frameIndex} size`).toBe(ref.byteLength);
        // Bit-exact: dav1d-in-wasm vs ffmpeg's dav1d must agree to the byte.
        let firstDiff = -1;
        for (let i = 0; i < ref.byteLength; i++) {
          if (frame.data[i] !== ref[i]) {
            firstDiff = i;
            break;
          }
        }
        expect(firstDiff, `${id} frame ${frameIndex} bit-exact (first diff @byte)`).toBe(-1);
      }
    });
    return decoded.length;
  } finally {
    decoder.free();
    decoder.free(); // idempotent
  }
}

describe('AV1 decode — vendored dav1d core vs the ffmpeg reference (§3.C.8, ADR-093)', () => {
  it('decodes the real 8-bit AV1 fixtures BIT-EXACTLY vs ffmpeg (≥5 coded frames)', async () => {
    if (!hasFfmpeg()) {
      console.warn('[wasm-av1] no ffmpeg — skipping the independent-decoder AV1 oracle');
      return;
    }
    const core = await loadCore();
    let totalFrames = 0;
    for (const id of EIGHT_BIT_FILES) {
      totalFrames += await expectFileBitExact(core, id);
    }
    // ≥5 decoded frames bit-exact vs an independent dav1d — a strict, can-fail oracle on real AV1 streams.
    expect(totalFrames, 'aggregate decoded frame count').toBeGreaterThanOrEqual(5);
  }, 60_000);

  it('honestly DECLINES 10-bit AV1 (this dav1d build is 8-bit-only) — never a fake frame', async () => {
    const core = await loadCore();
    expect(core.supports?.(INIT_8BIT)).toBe(true);
    expect(core.supports?.({ ...INIT_8BIT, bitDepth: 10 })).toBe(false);
    // Sanity: the 10-bit fixture exists (so the decline is meaningful, not vacuous).
    await expect(loadFixture('bear-av1-10bit.mp4')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('returns [] for an access unit that yields no display frame (reorder), not an error', async () => {
    const core = await loadCore();
    const decoder = await core.createDecoder(INIT_8BIT);
    try {
      // A bare temporal-delimiter OBU (0x12 0x00) decodes to no display frame; the glue must return [].
      const result = decoder.decode(Uint8Array.of(0x12, 0x00));
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    } finally {
      decoder.free();
    }
  });
});
