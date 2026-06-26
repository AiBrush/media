/**
 * Metamorphic / property tests (doc 11 §4.4, BUILD_INSTRUCTIONS §6.2; task §3.F) — invariants that hold
 * across an operation without needing a golden, exercised on the **Node-feasible** (pure-TS) paths:
 *
 *   1. `decode(mux(x)) == decode(x)` — the round-trippable instance: FLAC `decode(author(decode(x)))` equals
 *      `decode(x)` bit-for-bit for lossless-integer FLAC (the authoring seam re-encodes verbatim, so the PCM
 *      survives). This is the pure-TS stand-in for the WebCodecs mux→decode invariant (which the browser
 *      harness covers for H.264/AAC).
 *   2. `resize-idempotence` — resizing to the same dimensions is the identity, and `resize∘resize == resize`,
 *      on the CPU video filter's pure pixel kernel ({@link geometryToRgba}). The filter *stream* needs
 *      `VideoFrame` (browser), but the kernel is pure and Node-tested here.
 *   3. `trim-additivity` — `trim[a,b] ++ trim[b,c] == trim[a,c]` on a keyframe stream-copy: the audio
 *      packet-size sequence of two adjacent trims stitches (with the single shared boundary sample) into the
 *      full-range trim. MP4 keyframe trim is a pure byte stream-copy, so this runs in Node. (Video carries a
 *      GOP-snap + DTS-rebasing that makes naive PTS additivity ill-posed; the audio track — every sample an
 *      independent sync sample — gives the clean, re-basing-invariant additivity, asserted on sizes.)
 *
 * Each property includes a can-fail arm (a deliberately-wrong comparison the assertion rejects), so the
 * invariant is a live oracle, not a tautology (doc 11 §5).
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeFlac, interleavedPcmBytes } from '../codecs/flac/decode.ts';
import type { ByteSource } from '../contracts/driver.ts';
import { authorFlacFromPcm } from '../drivers/flac/flac-driver.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import type { PcmAudio, SampleFormat } from '../dsp/pcm.ts';
import { type RgbaImage, geometryToRgba, planCpuGeometry } from '../filters/cpu-video.ts';
import { sha256Hex } from '../util/digest.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;

async function loadBytes(id: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_DIR}/${id}`));
}

// ── 1) decode(mux(x)) == decode(x) — FLAC author→decode round-trip (lossless integer) ───────────────

/** Map a FLAC decode result to canonical planar PCM + its native sample format (mirrors the driver). */
const DEPTH_FORMAT: Record<number, SampleFormat> = {
  8: 's8',
  12: 's16',
  16: 's16',
  24: 's24',
  32: 's32',
};
const FORMAT_DIVISOR: Record<string, number> = {
  s8: 128,
  s16: 32768,
  s24: 8388608,
  s32: 2147483648,
};

function flacToPcmAudio(d: ReturnType<typeof decodeFlac>): {
  audio: PcmAudio;
  format: SampleFormat;
} {
  const format = DEPTH_FORMAT[d.bitsPerSample] ?? 's32';
  const divisor = FORMAT_DIVISOR[format] ?? 2147483648;
  const planar = d.samples.map((ch) => {
    const out = new Float64Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = (ch[i] ?? 0) / divisor;
    return out;
  });
  return {
    audio: { sampleRate: d.sampleRate, channels: d.channels, frames: d.totalSamples, planar },
    format,
  };
}

describe('metamorphic: decode(mux(x)) == decode(x) — FLAC author→decode (lossless integer)', () => {
  // 8-bit + 16-bit, mono + stereo + 5.1 — the lossless-integer depths that survive a verbatim re-encode.
  const FIXTURES = ['sfx.flac', 'flac-08bit.flac', 'flac-5_1ch.flac'] as const;

  it.each(FIXTURES)(
    '%s: re-encoding decoded PCM and decoding again reproduces the PCM bit-exactly',
    async (id) => {
      const x = await loadBytes(id);
      const dx = decodeFlac(x);
      const { audio, format } = flacToPcmAudio(dx);
      const reauthored = authorFlacFromPcm(audio, format); // mux: encode the decoded PCM to a fresh FLAC
      const dmux = decodeFlac(reauthored); // decode(mux(x))
      expect(await sha256Hex(interleavedPcmBytes(dmux))).toBe(
        await sha256Hex(interleavedPcmBytes(dx)),
      );
    },
  );

  it('the property can fail — decoded PCM of a DIFFERENT file does not match (no trivial pass)', async () => {
    const a = decodeFlac(await loadBytes('sfx.flac'));
    const b = decodeFlac(await loadBytes('flac-5_1ch.flac'));
    expect(await sha256Hex(interleavedPcmBytes(a))).not.toBe(
      await sha256Hex(interleavedPcmBytes(b)),
    );
  });
});

// ── 2) resize-idempotence — the CPU video filter's pure pixel kernel ────────────────────────────────

/** A deterministic synthetic RGBA image (the subject is the resize MATH, which needs no real frame). */
function syntheticRgba(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 37 + y * 11) & 0xff;
      data[i + 1] = (x * 5 + y * 53) & 0xff;
      data[i + 2] = (x * 97 + y * 3) & 0xff;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function resize(src: RgbaImage, width: number, height: number): RgbaImage {
  return geometryToRgba(
    planCpuGeometry(
      { mediaType: 'video', type: 'resize', width, height, fit: 'fill' },
      src.width,
      src.height,
    ),
    src,
  );
}
function imageBytes(img: RgbaImage): string {
  return `${img.width}x${img.height}:${[...img.data].join(',')}`;
}

describe('metamorphic: resize-idempotence (CPU video filter pure kernel)', () => {
  const SIZES: ReadonlyArray<readonly [number, number]> = [
    [16, 16],
    [33, 20],
    [1, 1],
  ];

  it.each(SIZES)('resizing %ix%i to the same dimensions is the identity', (w, h) => {
    const src = syntheticRgba(w, h);
    const out = resize(src, w, h);
    expect(out.width).toBe(w);
    expect(out.height).toBe(h);
    expect(imageBytes(out)).toBe(imageBytes(src)); // pixel-identical
  });

  it('resize∘resize == resize (a same-size resize after a resize is idempotent)', () => {
    const src = syntheticRgba(40, 24);
    const once = resize(src, 20, 12);
    const twice = resize(once, 20, 12); // resizing the result to its own size must not change it
    expect(imageBytes(twice)).toBe(imageBytes(once));
  });

  it('the property can fail — a genuine downscale is NOT the identity (the kernel really resamples)', () => {
    const src = syntheticRgba(40, 24);
    const down = resize(src, 20, 12);
    expect(down.width).toBe(20);
    expect(imageBytes(down)).not.toBe(imageBytes(src)); // resizing to a different size changes the pixels
  });
});

// ── 3) trim-additivity — keyframe stream-copy (audio track, re-basing-invariant on sizes) ────────────

function source(bytes: Uint8Array): ByteSource {
  return {
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.enqueue(bytes);
          c.close();
        },
      }),
    size: bytes.byteLength,
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** The MP4 driver always provides `streamCopy` (a documented invariant); narrow the optional method once. */
function mp4StreamCopy(): NonNullable<typeof Mp4Driver.streamCopy> {
  const fn = Mp4Driver.streamCopy;
  if (!fn) throw new Error('the MP4 driver must provide streamCopy');
  return fn.bind(Mp4Driver);
}

/** The audio track's packet-size sequence of a keyframe trim [a, c] (re-basing-invariant). */
async function audioTrimSizes(bytes: Uint8Array, a: number, c: number): Promise<number[]> {
  const trimmed = await collect(
    await mp4StreamCopy()(source(bytes), { trim: { startSec: a, endSec: c } }),
  );
  const demuxer = await Mp4Driver.demux(source(trimmed));
  try {
    const audioTrack = demuxer.tracks.find((t) => t.mediaType === 'audio');
    if (!audioTrack) return [];
    const table = demuxer.packetTable?.() ?? [];
    return table.filter((p) => p.trackId === audioTrack.id).map((p) => p.sizeBytes);
  } finally {
    await demuxer.close();
  }
}

async function fullDurationSec(bytes: Uint8Array): Promise<number> {
  const demuxer = await Mp4Driver.demux(source(bytes));
  try {
    const table = demuxer.packetTable?.() ?? [];
    return Math.max(...table.map((p) => (p.ptsUs + p.durationUs) / 1e6));
  } finally {
    await demuxer.close();
  }
}

describe('metamorphic: trim-additivity — trim[a,b] ++ trim[b,c] == trim[a,c] (audio, keyframe copy)', () => {
  const CASES: ReadonlyArray<readonly [string, number]> = [
    ['movie_5.mp4', 2.0],
    ['test.mp4', 3.0],
  ];

  it.each(CASES)(
    '%s: stitching two adjacent audio trims at b=%is reconstructs the full-range trim',
    async (id, b) => {
      const bytes = await loadBytes(id);
      const dur = (await fullDurationSec(bytes)) + 0.5;
      const full = await audioTrimSizes(bytes, 0, dur);
      const left = await audioTrimSizes(bytes, 0, b);
      const right = await audioTrimSizes(bytes, b, dur);
      expect(left.length).toBeGreaterThan(0);
      expect(right.length).toBeGreaterThan(0);
      // The boundary sample (overlapping b) is the last of `left` and the first of `right`, and is identical.
      expect(left.at(-1)).toBe(right[0]);
      // Drop that single shared boundary sample → the two trims partition the full audio packet sequence.
      expect([...left, ...right.slice(1)]).toEqual(full);
    },
  );

  it('the property can fail — a mismatched boundary does NOT stitch to the full sequence', async () => {
    const bytes = await loadBytes('movie_5.mp4');
    const dur = (await fullDurationSec(bytes)) + 0.5;
    const full = await audioTrimSizes(bytes, 0, dur);
    const left = await audioTrimSizes(bytes, 0, 2.0);
    const right = await audioTrimSizes(bytes, 2.0, dur);
    // Stitching WITHOUT removing the boundary overlap yields a too-long sequence (≠ full): the assertion is live.
    expect([...left, ...right]).not.toEqual(full);
  });
});
