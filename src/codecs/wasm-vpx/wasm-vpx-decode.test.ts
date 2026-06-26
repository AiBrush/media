/**
 * VP8/VP9 **decode** oracle (BUILD §2/§4; ADR-094 — the vendored prebuilt ogv.js libvpx cores completing
 * wasm-vpx). The ogv.js cores run in Node, so decode is validated WITHOUT a browser: the engine's own WebM
 * demuxer yields the real VP8/VP9 access units, our `VpxWasmCore` glue decodes each (de-striding libvpx's
 * aligned planes into packed I420), and the pixels are compared **bit-exactly** to an INDEPENDENT `ffmpeg`
 * decode of the same file (both are libvpx → byte-identical). A broken glue (wrong de-stride, dropped/extra
 * frames, mislabeled dims) breaks the compare → the oracle FAILS. The honest 4:2:0 gate (4:4:4 declined) is
 * asserted too — never wrong-colour fake frames.
 *
 * Fixtures (≥5 real): VP8 `2x2-green.webm`, `bear-multitrack.webm`, `white.webm`; VP9 `movie_5.webm`;
 * plus VP9 4:4:4 `bear-vp9-alpha.webm` (must be DECLINED — the honest boundary).
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { demuxWebm } from '../../drivers/webm/webm-driver.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import type { VpxCodec, VpxWasmCore } from './vpx.ts';

/** Load the vendored ogv.js VP8/VP9 glue facade once (it runs in Node — the whole reason this is here). */
async function loadCore(): Promise<VpxWasmCore> {
  const mod = (await import('./vpx-core.js')) as {
    default: (u?: unknown) => Promise<unknown>;
    createVpxCore: () => VpxWasmCore;
  };
  await mod.default(new URL('./vpx.wasm', import.meta.url));
  return mod.createVpxCore();
}

/** Whether ffmpeg (the independent libvpx reference) is installed. */
function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The audio/video track index for `codec` in a demuxed WebM, plus its per-frame access units. */
async function vpxAccessUnits(id: string, codec: VpxCodec): Promise<Uint8Array[]> {
  const demux = demuxWebm(await loadFixture(id));
  const index = demux.info.tracks.findIndex(
    (t) => t.mediaType === 'video' && (t.codec ?? '').includes(codec),
  );
  if (index < 0) throw new Error(`${id}: no ${codec} video track`);
  return (demux.framesByIndex[index] ?? []).map((f) => f.data);
}

/** Decode a fixture to packed I420 frames with ffmpeg (the independent reference). */
function ffmpegI420Frames(id: string, width: number, height: number): Uint8Array[] {
  const path = `${new URL('../../../fixtures/media/', import.meta.url).pathname}${id}`;
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
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

interface Case {
  id: string;
  codec: VpxCodec;
  width: number;
  height: number;
}

// Clean, well-formed real streams (the degenerate headerless MediaRecorder fragment is excluded).
const CASES: readonly Case[] = [
  { id: '2x2-green.webm', codec: 'vp8', width: 2, height: 2 },
  { id: 'bear-multitrack.webm', codec: 'vp8', width: 320, height: 240 },
  { id: 'white.webm', codec: 'vp8', width: 320, height: 240 },
  { id: 'movie_5.webm', codec: 'vp9', width: 320, height: 240 },
];

describe('VP8/VP9 decode — vendored ogv.js libvpx cores vs the ffmpeg reference (§3.C.9, ADR-094)', () => {
  it('decodes ≥4 real VP8/VP9 files BIT-EXACTLY vs ffmpeg (de-strided to packed I420)', async () => {
    if (!hasFfmpeg()) {
      console.warn('[wasm-vpx] no ffmpeg — skipping the independent-decoder VPx oracle');
      return;
    }
    expect(CASES.length).toBeGreaterThanOrEqual(4);
    const core = await loadCore();
    for (const { id, codec, width, height } of CASES) {
      const units = await vpxAccessUnits(id, codec);
      expect(units.length, `${id}: has coded frames`).toBeGreaterThan(0);
      const reference = ffmpegI420Frames(id, width, height);

      const decoder = await core.createDecoder({
        codec,
        profile: 0,
        bitDepth: 8,
        codedWidth: width,
        codedHeight: height,
      });
      try {
        let frameIndex = 0;
        for (const unit of units) {
          for (const frame of decoder.decode(unit)) {
            expect(frame.bitDepth, `${id} bitDepth`).toBe(8);
            const ref = reference[frameIndex];
            expect(ref, `${id}: ffmpeg has frame ${frameIndex}`).not.toBeUndefined();
            if (ref) {
              expect(frame.data.byteLength, `${id} frame ${frameIndex} size`).toBe(ref.byteLength);
              let firstDiff = -1;
              for (let i = 0; i < ref.byteLength; i++) {
                if (frame.data[i] !== ref[i]) {
                  firstDiff = i;
                  break;
                }
              }
              expect(firstDiff, `${id} frame ${frameIndex} bit-exact (first diff @byte)`).toBe(-1);
            }
            frameIndex++;
          }
        }
        expect(frameIndex, `${id}: decoded frame count matches ffmpeg`).toBe(reference.length);
      } finally {
        decoder.free();
        decoder.free(); // idempotent
      }
    }
  }, 60_000);

  it('honestly DECLINES 4:4:4 VP9 (bear-vp9-alpha) — never a wrong-colour fake frame', async () => {
    const core = await loadCore();
    const units = await vpxAccessUnits('bear-vp9-alpha.webm', 'vp9');
    const decoder = await core.createDecoder({
      codec: 'vp9',
      profile: 0,
      bitDepth: 8,
      codedWidth: 320,
      codedHeight: 240,
    });
    try {
      // The 4:4:4 chroma layout cannot be represented as packed I420, so the glue throws (→ the driver
      // surfaces a clean capability-miss) rather than cropping full-res chroma into a 4:2:0 buffer.
      expect(() => decoder.decode(units[0] ?? new Uint8Array(0))).toThrow(/4:2:0/);
    } finally {
      decoder.free();
    }
  }, 30_000);
});
