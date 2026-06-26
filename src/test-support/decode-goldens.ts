/**
 * Shared definition of the `decoded-frames-bitexact` baked oracle for the **pure-TS decode paths** (doc 11
 * §1: "decoded-frames-bitexact (sha256 of decoded samples in force-software)"), used by both
 * `scripts/bake-goldens.ts` (writer) and `src/conformance/decoded-bitexact.test.ts` (asserter) so they
 * can never drift (the same pattern as `dsp-goldens.ts`/`packet-goldens.ts`).
 *
 * The pure-TS decoders run identically in Node and the browser (no WebCodecs), so their decoded PCM is
 * cross-machine-reproducible and pinned by sha256 — the strongest oracle (doc 11 §1, bit-exact). Two paths
 * qualify today:
 *   - **FLAC decode** ({@link decodeFlac}) — a from-scratch TS FLAC decoder; the decoded interleaved PCM is
 *     hashed at the stream's native bit depth ({@link interleavedPcmBytes}).
 *   - **WAV/PCM decode** ({@link readWavPcm}) — re-encoded to its native format ({@link encodePcm}) and hashed.
 *
 * **Independent corroboration (anti-self-confirmation).** A sha256 of our own decoder's output, baked by
 * our own code, is a round-trip — it cannot catch a *consistent* decode bug. So the bake script ALSO decodes
 * each fixture with **ffmpeg** to raw interleaved PCM in the matching wire format and asserts our bytes are
 * byte-identical to ffmpeg's before committing (FLAC + integer/float PCM are lossless, so a correct decoder
 * must agree with ffmpeg's independent one). The committed golden records ffmpeg's sha256 too, so a future
 * change that drifts from ffmpeg fails the test. The lone exception is 12-bit FLAC, where ffmpeg scales the
 * sample to s16 full-scale while we keep the literal 12-bit value (a representation choice, not a decode
 * error) — that fixture is self-MD5-validated (FLAC STREAMINFO MD5, checked inside the decoder) and marked
 * `ffmpegCrossChecked:false`. ADR-085.
 */

import { decodeFlac, interleavedPcmBytes } from '../codecs/flac/decode.ts';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { encodePcm } from '../dsp/pcm.ts';
import { sha256Hex } from '../util/digest.ts';

/** A committed decoded-frames-bitexact reference for one fixture. */
export interface DecodeGolden {
  readonly path: 'flac' | 'wav';
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly frames: number;
  /** Decoded interleaved-PCM byte length (the hashed buffer's size). */
  readonly bytes: number;
  /** sha256 of the decoded interleaved PCM (the bit-exact oracle target). */
  readonly sha256: string;
  /** Whether an independent ffmpeg decode produced byte-identical PCM at bake time (see file header). */
  readonly ffmpegCrossChecked: boolean;
}

/** Decode a FLAC fixture and compute its committed-golden digest. The FLAC decoder self-checks STREAMINFO MD5. */
export async function flacDecodeGolden(flac: Uint8Array): Promise<DecodeGolden> {
  const d = decodeFlac(flac);
  const pcm = interleavedPcmBytes(d);
  return {
    path: 'flac',
    sampleRate: d.sampleRate,
    channels: d.channels,
    bitsPerSample: d.bitsPerSample,
    frames: d.totalSamples,
    bytes: pcm.byteLength,
    sha256: await sha256Hex(pcm),
    // 12-bit FLAC diverges from ffmpeg only by full-scale shift; everything else is ffmpeg-corroborated.
    ffmpegCrossChecked: d.bitsPerSample !== 12,
  };
}

/** Decode a WAV/PCM fixture and compute its committed-golden digest (re-encoded to its native format). */
export async function wavDecodeGolden(wav: Uint8Array): Promise<DecodeGolden> {
  const a = readWavPcm(wav);
  const pcm = encodePcm(a, a.format);
  return {
    path: 'wav',
    sampleRate: a.sampleRate,
    channels: a.channels,
    bitsPerSample: bytesOf(a.format) * 8,
    frames: a.frames,
    bytes: pcm.byteLength,
    sha256: await sha256Hex(pcm),
    ffmpegCrossChecked: true,
  };
}

/** Bytes per sample of a canonical sample format (for the golden's `bitsPerSample` field). */
function bytesOf(format: string): number {
  switch (format) {
    case 'u8':
    case 's8':
      return 1;
    case 's16':
      return 2;
    case 's24':
      return 3;
    case 's32':
    case 'f32':
      return 4;
    case 'f64':
      return 8;
    default:
      return 0;
  }
}
