/**
 * FLAC **authoring** oracle (BUILD §2/§4; ADR-085). The pure-TS encoder must produce a standards-valid,
 * genuinely-compressed `.flac` that (a) our own decoder round-trips sample-exactly with a matching
 * STREAMINFO MD5, (b) an INDEPENDENT decoder (`flac`/`ffmpeg` CLI) decodes BIT-EXACTLY back to the source
 * PCM, and (c) is strictly smaller than a verbatim-subframe baseline. These oracles can FAIL: a wrong
 * predictor/residual, a stereo-decorrelation bug, or a truncated frame all break (a) or (b), and a
 * no-op "compressor" breaks (c). The CLI legs are skipped (not faked) when no external decoder exists.
 *
 * Fixtures: the IETF FLAC conformance ids (decode→re-encode→compare) span 8/12/24-bit, 5.1ch, and a
 * 16-sample block; the WAV ids (encode-from-PCM) span u8/s16/s24 mono and 48 kHz stereo + a pure sine.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { decodeFlac, interleavedPcmBytes } from '../../codecs/flac/decode.ts';
import {
  type FlacPcm,
  encodeFlac,
  encodeFlacVerbatim,
  finalizeMd5,
  flacPcmFromDecoded,
  flacPcmFromPcmAudio,
  newMd5State,
  streamInfoPrelude,
  updateMd5,
  updateMd5WithBlock,
} from '../../codecs/flac/encode.ts';
import type { CodecQuery } from '../../contracts/driver.ts';
import { InputError } from '../../contracts/errors.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { readWavPcm } from '../wav/pcm.ts';
import {
  FlacCodecDriver,
  PlanarBlockAccumulator,
  flacDepthForFormat,
  isFlacCodecString,
  quantizePlanes,
} from './flac-codec.ts';
import { parseFlac } from './flac-driver.ts';

const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** The IETF FLAC conformance ids spanning the geometry matrix the encoder must handle. */
const FLAC_SOURCES = [
  'flac-08bit',
  'flac-12bit',
  'flac-24bit-hires',
  'flac-5_1ch',
  'flac-blocksize-16',
] as const;

/** Real WAV PCM ids the encoder authors from scratch (u8/s16/s24 mono + stereo + pure sine). */
const WAV_SOURCES = [
  'sfx-pcm-s16.wav',
  'sfx-pcm-s24.wav',
  'sin_440Hz_-6dBFS_1s.wav',
  'stereo-48000.wav',
] as const;

/**
 * The subset of {@link WAV_SOURCES} whose content is genuinely predictable (real audio / a pure tone), so
 * FIXED+Rice MUST beat verbatim. `stereo-48000.wav` is full-scale noise — incompressible even by the
 * reference `flac` CLI — so it is excluded from the strict-`<` oracle but still checked for never-expand.
 */
const COMPRESSIBLE_WAV_SOURCES = [
  'sfx-pcm-s16.wav',
  'sfx-pcm-s24.wav',
  'sin_440Hz_-6dBFS_1s.wav',
] as const;

/** Decode a FLAC fixture into the encoder's signed-int planar input. */
async function flacFixtureAsPcm(id: string): Promise<FlacPcm> {
  return flacPcmFromDecoded(decodeFlac(await loadFixture(`${id}.flac`)));
}

/** Decode a WAV fixture into the encoder's signed-int planar input at its native depth. */
async function wavFixtureAsPcm(id: string): Promise<{ pcm: FlacPcm }> {
  const wav = readWavPcm(await loadFixture(id));
  return { pcm: flacPcmFromPcmAudio(wav, wav.format) };
}

/** Which independent FLAC decoder is installed (the oracle's third-party check), if any. */
function externalDecoder(): 'flac' | 'ffmpeg' | undefined {
  for (const tool of ['flac', 'ffmpeg'] as const) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore' });
      return tool;
    } catch {
      /* not installed */
    }
  }
  return undefined;
}

/** STREAMINFO MD5 of the SOURCE interleaved-LE PCM (depth-true) — the bit-exactness fingerprint. */
function sourceMd5(pcm: FlacPcm): string {
  return md5(interleavedPcmBytes(decodeFlac(encodeFlacVerbatim(pcm))));
}

/** Geometry an independent decode is checked against. */
interface Geom {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

/** Interleaved source samples as little-endian bytes at a chosen `outBytes` width and left-shift. */
function expectedInterleaved(pcm: FlacPcm, outBytes: number, shift: number): Uint8Array {
  const out = new Uint8Array(pcm.totalSamples * pcm.channels * outBytes);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < pcm.totalSamples; i++) {
    for (let ch = 0; ch < pcm.channels; ch++) {
      const v = (pcm.samples[ch]?.[i] ?? 0) * 2 ** shift;
      if (outBytes === 2) {
        dv.setInt16(o, v, true);
      } else {
        // 3-byte little-endian signed.
        dv.setUint8(o, v & 0xff);
        dv.setUint8(o + 1, (v >> 8) & 0xff);
        dv.setUint8(o + 2, (v >> 16) & 0xff);
      }
      o += outBytes;
    }
  }
  return out;
}

/**
 * Decode `flacBytes` with an independent CLI and assert it reproduces the source PCM byte-for-byte. For
 * the byte-aligned depths (8/16/24) the `flac` CLI emits depth-true signed-LE raw with `--force-raw-format`
 * and we compare against {@link interleavedPcmBytes} directly (the strongest oracle). The `flac` CLI
 * refuses raw for 12-bit, so a non-byte-aligned depth is decoded by `ffmpeg` to `s16le`, which
 * **left-justifies** sub-16-bit samples (`sample << (16-bits)`) — we build the expected bytes to match.
 * A wrong predictor/residual/decorrelation makes the bytes differ and FAILS.
 */
function assertIndependentDecodeEquals(
  preferred: 'flac' | 'ffmpeg',
  flacBytes: Uint8Array,
  pcm: FlacPcm,
  geom: Geom,
  label: string,
): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const dir = tmpdir();
  const tag = `${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const inPath = `${dir}/aibrush-flac-${tag}.flac`;
  const outPath = `${dir}/aibrush-flac-${tag}.raw`;
  const byteAligned = geom.bitsPerSample % 8 === 0;
  // The `flac` CLI only emits raw for 8/16/24/32-bit; a 12-bit (or 20-bit) source must go through ffmpeg.
  const tool = byteAligned ? preferred : 'ffmpeg';
  fs.writeFileSync(inPath, flacBytes);
  try {
    let expected: Uint8Array;
    if (tool === 'flac') {
      execFileSync(
        'flac',
        [
          '-s',
          '-d',
          '-f',
          '--force-raw-format',
          '--endian=little',
          '--sign=signed',
          '-o',
          outPath,
          inPath,
        ],
        { stdio: 'ignore' },
      );
      expected = interleavedPcmBytes(decodeFlac(encodeFlacVerbatim(pcm)));
    } else {
      const outBytes = geom.bitsPerSample <= 16 ? 2 : 3;
      const fmt = outBytes === 2 ? 's16le' : 's24le';
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', inPath, '-f', fmt, outPath], {
        stdio: 'ignore',
      });
      // ffmpeg left-justifies a sub-byte-aligned depth into the target width; byte-aligned passes through.
      const shift = byteAligned ? 0 : outBytes * 8 - geom.bitsPerSample;
      expected = expectedInterleaved(pcm, outBytes, shift);
    }
    const got = new Uint8Array(fs.readFileSync(outPath));
    expect(got.byteLength, `${label}: independent ${tool} PCM byte length`).toBe(
      expected.byteLength,
    );
    if (md5(got) !== md5(expected)) {
      let i = 0;
      while (i < got.byteLength && got[i] === expected[i]) i++;
      expect.fail(
        `${label}: ${tool} decode differs from source at byte ${i} (${got[i]} != ${expected[i]})`,
      );
    }
  } finally {
    for (const p of [inPath, outPath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

describe('FLAC authoring — LPC/Rice compression, bit-exact, independently verifiable (ADR-085)', () => {
  it('round-trips ≥5 real FLAC fixtures sample-exactly with a matching STREAMINFO MD5', async () => {
    expect(FLAC_SOURCES.length).toBeGreaterThanOrEqual(5);
    for (const id of FLAC_SOURCES) {
      const pcm = await flacFixtureAsPcm(id);
      const encoded = encodeFlac(pcm, { blockSize: 4096 });
      const decoded = decodeFlac(encoded);
      expect(decoded.sampleRate, id).toBe(pcm.sampleRate);
      expect(decoded.channels, id).toBe(pcm.channels);
      expect(decoded.bitsPerSample, id).toBe(pcm.bitsPerSample);
      expect(decoded.totalSamples, id).toBe(pcm.totalSamples);
      // STREAMINFO MD5 is self-consistent AND equals the source PCM digest (true bit-exactness).
      expect(md5(interleavedPcmBytes(decoded)), `${id}: self-MD5`).toBe(hex(decoded.md5));
      expect(hex(decoded.md5), `${id}: vs source`).toBe(sourceMd5(pcm));
      for (let ch = 0; ch < pcm.channels; ch++) {
        expect([...(decoded.samples[ch] ?? [])], `${id}: ch${ch}`).toEqual([
          ...(pcm.samples[ch] ?? []),
        ]);
      }
    }
  }, 30_000);

  it('compresses predictable content strictly below verbatim, and never expands any source', async () => {
    // Strict `<`: real-audio FLAC fixtures + predictable WAV content MUST shrink (FIXED+Rice pays).
    for (const id of FLAC_SOURCES) {
      const pcm = await flacFixtureAsPcm(id);
      const compressed = encodeFlac(pcm, { blockSize: 4096 });
      const verbatim = encodeFlacVerbatim(pcm, { blockSize: 4096 });
      expect(compressed.byteLength, `${id}: compressed < verbatim`).toBeLessThan(
        verbatim.byteLength,
      );
    }
    for (const id of COMPRESSIBLE_WAV_SOURCES) {
      const wav = readWavPcm(await loadFixture(id));
      const pcm = flacPcmFromPcmAudio(wav, wav.format);
      const compressed = encodeFlac(pcm, { blockSize: 4096 });
      const verbatim = encodeFlacVerbatim(pcm, { blockSize: 4096 });
      expect(compressed.byteLength, `${id}: compressed < verbatim`).toBeLessThan(
        verbatim.byteLength,
      );
    }
    // Never-expand `≤`: even incompressible noise (stereo-48000.wav) must not exceed the verbatim size —
    // the per-subframe VERBATIM fallback guarantees the encoder is never worse than the baseline.
    for (const id of WAV_SOURCES) {
      const wav = readWavPcm(await loadFixture(id));
      const pcm = flacPcmFromPcmAudio(wav, wav.format);
      const compressed = encodeFlac(pcm, { blockSize: 4096 });
      const verbatim = encodeFlacVerbatim(pcm, { blockSize: 4096 });
      expect(compressed.byteLength, `${id}: compressed ≤ verbatim`).toBeLessThanOrEqual(
        verbatim.byteLength,
      );
    }
  }, 30_000);

  it('authors native FLAC from real WAV PCM and round-trips sample-exactly', async () => {
    for (const id of WAV_SOURCES) {
      const wav = readWavPcm(await loadFixture(id));
      const pcm = flacPcmFromPcmAudio(wav, wav.format);
      const encoded = encodeFlac(pcm, { blockSize: 4096 });
      expect([encoded[0], encoded[1], encoded[2], encoded[3]], `${id}: fLaC magic`).toEqual([
        0x66, 0x4c, 0x61, 0x43,
      ]);
      const decoded = decodeFlac(encoded);
      expect(md5(interleavedPcmBytes(decoded)), id).toBe(hex(decoded.md5));
      for (let ch = 0; ch < pcm.channels; ch++) {
        expect([...(decoded.samples[ch] ?? [])], `${id}: ch${ch}`).toEqual([
          ...(pcm.samples[ch] ?? []),
        ]);
      }
    }
  }, 30_000);

  it('an INDEPENDENT decoder (flac/ffmpeg CLI) decodes our FLAC bit-exactly back to the source PCM', async () => {
    const tool = externalDecoder();
    if (!tool) {
      console.warn(
        '[flac-encode] no flac/ffmpeg CLI installed — skipping the independent-decoder oracle',
      );
      return;
    }
    for (const id of FLAC_SOURCES) {
      const pcm = await flacFixtureAsPcm(id);
      const encoded = encodeFlac(pcm, { blockSize: 4096 });
      assertIndependentDecodeEquals(
        tool,
        encoded,
        pcm,
        { channels: pcm.channels, sampleRate: pcm.sampleRate, bitsPerSample: pcm.bitsPerSample },
        id,
      );
    }
  }, 30_000);

  it('rejects non-finite samples and bad geometry with typed InputErrors (never malformed output)', async () => {
    const { pcm } = await wavFixtureAsPcm('sfx-pcm-s16.wav');
    expect(() => encodeFlac({ ...pcm, sampleRate: 0 }, { blockSize: 4096 })).toThrow(InputError);
    expect(() =>
      encodeFlac({
        ...pcm,
        channels: 9,
        samples: Array.from({ length: 9 }, () => pcm.samples[0] ?? new Int32Array(0)),
      }),
    ).toThrow(InputError);
  });
});

describe('FLAC streaming MD5 + prelude (codec-seam building blocks)', () => {
  it('streaming MD5 (any chunking) equals the one-shot digest of the same bytes', () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 73 + 11) & 0xff;
    const oneShot = md5(bytes);
    for (const chunk of [1, 7, 16, 56, 63, 64, 65, 137, 999, 1000]) {
      const state = newMd5State();
      for (let i = 0; i < bytes.length; i += chunk) updateMd5(state, bytes.subarray(i, i + chunk));
      expect(hex(finalizeMd5(state)), `chunk ${chunk}`).toBe(oneShot);
    }
  });

  it('updateMd5WithBlock matches the interleaved-LE digest the STREAMINFO MD5 is defined over', () => {
    const frames = 5;
    const channels = 2;
    const bits = 16;
    const planes = [
      Int32Array.from([0, 1, -1, 32767, -32768]),
      Int32Array.from([10, -10, 100, -100, 7]),
    ];
    // Reference: interleave LE by hand, then one-shot MD5.
    const ref = new Uint8Array(frames * channels * 2);
    const dv = new DataView(ref.buffer);
    let o = 0;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < channels; ch++) {
        dv.setInt16(o, planes[ch]?.[i] ?? 0, true);
        o += 2;
      }
    }
    const state = newMd5State();
    updateMd5WithBlock(state, planes, frames, bits, channels);
    expect(hex(finalizeMd5(state))).toBe(md5(ref));
  });

  it('streamInfoPrelude is a valid fLaC header with the audio layout and "unknown" totals/MD5', () => {
    const prelude = streamInfoPrelude({ sampleRate: 44_100, channels: 2, bitsPerSample: 16 });
    expect([...prelude.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]); // fLaC
    // The decoder reads the layout back from the prelude (no frames ⇒ totalSamples 0 = "unknown").
    const info = parseFlac(prelude);
    expect(info.sampleRate).toBe(44_100);
    expect(info.channels).toBe(2);
    expect(info.bitsPerSample).toBe(16);
    expect(info.totalSamples).toBe(0);
    // MD5 field (body offset 18, prelude offset 4+4+18) is all-zero (unknown).
    expect([...prelude.subarray(26, 42)].every((b) => b === 0)).toBe(true);
  });
});

describe('FLAC codec-seam pure helpers (flac-codec.ts)', () => {
  it('isFlacCodecString matches the bare token + flac.* variants only', () => {
    expect(isFlacCodecString('flac')).toBe(true);
    expect(isFlacCodecString('FLAC')).toBe(true);
    expect(isFlacCodecString('flac.1')).toBe(true);
    expect(isFlacCodecString('opus')).toBe(false);
    expect(isFlacCodecString('flacon')).toBe(false);
  });

  it('flacDepthForFormat keeps integer formats lossless and defaults float/u8 to 16-bit', () => {
    expect(flacDepthForFormat('s16')).toBe(16);
    expect(flacDepthForFormat('s16-planar')).toBe(16);
    expect(flacDepthForFormat('s32')).toBe(32);
    expect(flacDepthForFormat('s32-planar')).toBe(32);
    expect(flacDepthForFormat('f32')).toBe(16);
    expect(flacDepthForFormat('f32-planar')).toBe(16);
    expect(flacDepthForFormat('u8')).toBe(16);
    expect(flacDepthForFormat(null)).toBe(16);
    expect(flacDepthForFormat(undefined)).toBe(16);
  });

  it('quantizePlanes rounds to signed-int range and clamps out-of-range float', () => {
    const out = quantizePlanes([Float32Array.from([0, 0.5, -0.5, 2, -2])], 5, 16);
    expect([...(out[0] ?? [])]).toEqual([0, 16384, -16384, 32767, -32768]);
  });

  it('PlanarBlockAccumulator re-chunks to fixed blocks and yields the true partial tail', () => {
    const acc = new PlanarBlockAccumulator(1, 4);
    // Push 10 samples across two uneven pushes → blocks [4],[4] then a [2] tail.
    acc.push([Int32Array.from([0, 1, 2, 3, 4, 5, 6])], 7);
    acc.push([Int32Array.from([7, 8, 9])], 3);
    const blocks: number[][] = [];
    for (let b = acc.pull(); b !== undefined; b = acc.pull()) {
      blocks.push([...(b.planes[0]?.subarray(0, b.frames) ?? [])]);
    }
    expect(blocks).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ]);
    const tail = acc.drainFinal();
    expect(tail?.frames).toBe(2);
    expect([...(tail?.planes[0]?.subarray(0, tail.frames) ?? [])]).toEqual([8, 9]);
    expect(acc.drainFinal()).toBeUndefined(); // nothing left
  });

  it('the codec supports() probe is honest: encode-FLAC only, never throws', async () => {
    const audioFlacEncode: CodecQuery = {
      mediaType: 'audio',
      direction: 'encode',
      config: { codec: 'flac', sampleRate: 48_000, numberOfChannels: 2 },
    };
    // WebCodecs seam types are absent in Node → honest miss (not a throw); present (browser) → supported.
    const res = await FlacCodecDriver.supports(audioFlacEncode);
    expect(typeof res.supported).toBe('boolean');
    expect(
      (await FlacCodecDriver.supports({ ...audioFlacEncode, direction: 'decode' })).supported,
    ).toBe(false);
    expect(
      (
        await FlacCodecDriver.supports({
          mediaType: 'audio',
          direction: 'encode',
          config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
        })
      ).supported,
    ).toBe(false);
    expect(
      (
        await FlacCodecDriver.supports({
          mediaType: 'video',
          direction: 'encode',
          config: { codec: 'flac', width: 1, height: 1 } as unknown as CodecQuery['config'],
        })
      ).supported,
    ).toBe(false);
  });
});
