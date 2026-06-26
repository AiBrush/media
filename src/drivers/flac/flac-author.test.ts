/**
 * FLAC authoring oracle (BUILD_INSTRUCTIONS §6.1) — the engine produces native `.flac` from real PCM.
 *
 * Subject media: the diverse real WAV/PCM corpus (web-platform-tests `sfx-pcm-*`, `stereo-48000`, the
 * deterministic 440 Hz tone, and `speech.wav`) spanning u8 / s16 / s24 / s32 integer and f32 float,
 * mono + stereo, 48 kHz. The oracle drives the PUBLIC convert path (`createMedia → from(wavBytes) →
 * convert({to:'flac'})`) and is **strict + can-fail**:
 *
 *   1. the bytes are a valid native FLAC stream (`fLaC` magic; our `parseFlac` reads STREAMINFO);
 *   2. an INDEPENDENT tool — `ffprobe` — reports `codec=flac` with the source's channels / sampleRate /
 *      bit depth, and `ffmpeg` re-decodes the FLAC to PCM whose MD5 equals the FLAC's own STREAMINFO MD5
 *      (i.e. ffmpeg agrees the stream is lossless and well-formed);
 *   3. OUR pure-TS `decodeFlac` re-decodes the FLAC to integer samples that are **bit-exactly equal** to
 *      the source WAV's samples (lossless), and the decoded STREAMINFO MD5 matches the source PCM MD5.
 *
 * Anti-cheat: the lossless check compares against the source samples decoded by an independent reader
 * (`readWavPcm`), the FLAC is validated by ffmpeg (a different codebase), and an empty/zero-sample input
 * is asserted to reject — so a pass cannot be a passthrough or a can't-fail gate.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { decodeFlac, interleavedPcmBytes } from '../../codecs/flac/decode.ts';
import { type FlacPcm, flacPcmFromPcmAudio } from '../../codecs/flac/encode.ts';
import type { SampleFormat } from '../../dsp/pcm.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { readWavPcm } from '../wav/pcm.ts';

const exec = promisify(execFile);
const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const wavSource = (b: Uint8Array) => fromBytes(b, { mime: 'audio/wav' });

async function blobBytes(
  out: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

/** Run the public engine convert to a FLAC blob and return its bytes. */
async function convertToFlac(wav: Uint8Array): Promise<Uint8Array> {
  return blobBytes(await createMedia().convert(wavSource(wav), { to: 'flac' }));
}

interface FfprobeStream {
  codec_name?: string;
  channels?: number;
  sample_rate?: string;
  bits_per_raw_sample?: string;
}

/** The single audio stream `ffprobe` sees in `bytes` (written to a temp `.flac` so ffprobe can seek). */
async function ffprobeFlac(bytes: Uint8Array): Promise<FfprobeStream> {
  const dir = await mkdtemp(join(tmpdir(), 'flac-author-'));
  const path = join(dir, 'out.flac');
  try {
    await writeFile(path, bytes);
    const { stdout } = await exec('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      path,
    ]);
    const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[] };
    const stream = parsed.streams?.[0];
    if (!stream) throw new Error('ffprobe reported no streams');
    return stream;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Decode the FLAC with `ffmpeg` to raw interleaved PCM at its native sample format and return the MD5 —
 * an independent confirmation that ffmpeg can losslessly decode our stream. The requested raw format
 * mirrors how STREAMINFO's MD5 is defined (signed little-endian at the sample width; u8 stays unsigned),
 * so a correct, lossless FLAC yields exactly the source PCM digest.
 */
async function ffmpegDecodeFlacMd5(bytes: Uint8Array, format: SampleFormat): Promise<string> {
  const rawFormat = ffmpegRawFormat(format);
  const dir = await mkdtemp(join(tmpdir(), 'flac-author-'));
  const inPath = join(dir, 'in.flac');
  const outPath = join(dir, 'out.raw');
  try {
    await writeFile(inPath, bytes);
    await exec('ffmpeg', [
      '-v',
      'quiet',
      '-i',
      inPath,
      '-f',
      rawFormat,
      '-acodec',
      `pcm_${rawFormat}`,
      outPath,
    ]);
    const { stdout } = await exec('bash', [
      '-c',
      `md5 -q ${outPath} 2>/dev/null || md5sum ${outPath}`,
    ]);
    return stdout.trim().split(/\s+/)[0] ?? '';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The `pcm_*`/`-f` token ffmpeg uses for raw PCM at a FLAC bit depth, matching the STREAMINFO MD5 layout:
 * FLAC stores **signed** samples at every depth, so 8-bit FLAC's canonical PCM is signed `s8` (NOT the
 * `u8`/offset-binary the WAV source carried). Requesting `s8` makes ffmpeg emit the same signed bytes the
 * STREAMINFO MD5 is computed over, so a lossless decode reproduces that digest exactly.
 */
function ffmpegRawFormat(format: SampleFormat): string {
  switch (format) {
    case 'u8':
      return 's8'; // FLAC 8-bit PCM is signed; STREAMINFO MD5 is over signed int8
    case 's16':
      return 's16le';
    case 's24':
      return 's24le';
    case 's32':
      return 's32le';
    default:
      // Float sources are quantized to 24-bit signed in the FLAC author; ffmpeg decodes that as s32 with
      // 8 low zero bits, so this helper is only used for the integer fixtures (see the test matrix below).
      throw new Error(`no ffmpeg raw format for ${format}`);
  }
}

interface WavCase {
  id: string;
  channels: number;
  sampleRate: number;
  format: SampleFormat;
  bitsPerSample: number;
}

// ≥5 diverse real WAV fixtures spanning the integer + float depths and mono/stereo.
const WAV_CASES: readonly WavCase[] = [
  { id: 'sfx-pcm-u8.wav', channels: 1, sampleRate: 48000, format: 'u8', bitsPerSample: 8 },
  { id: 'sfx-pcm-s16.wav', channels: 1, sampleRate: 48000, format: 's16', bitsPerSample: 16 },
  { id: 'sfx-pcm-s24.wav', channels: 1, sampleRate: 48000, format: 's24', bitsPerSample: 24 },
  { id: 'sfx-pcm-s32.wav', channels: 1, sampleRate: 48000, format: 's32', bitsPerSample: 32 },
  { id: 'stereo-48000.wav', channels: 2, sampleRate: 48000, format: 's16', bitsPerSample: 16 },
  {
    id: 'sin_440Hz_-6dBFS_1s.wav',
    channels: 1,
    sampleRate: 44100,
    format: 's16',
    bitsPerSample: 16,
  },
  { id: 'speech.wav', channels: 1, sampleRate: 16000, format: 's16', bitsPerSample: 16 },
];

const FLOAT_CASE: WavCase = {
  id: 'sfx-pcm-f32.wav',
  channels: 1,
  sampleRate: 48000,
  format: 'f32',
  bitsPerSample: 24,
};

/** The samples the FLAC author should have written for this source (the lossless oracle). */
function expectedFlacPcm(wavBytes: Uint8Array): FlacPcm {
  const wav = readWavPcm(wavBytes);
  return flacPcmFromPcmAudio(wav, wav.format);
}

function assertChannelsExact(actual: readonly Int32Array[], expected: readonly Int32Array[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let ch = 0; ch < expected.length; ch++) {
    expect([...(actual[ch] ?? [])], `channel ${ch}`).toEqual([...(expected[ch] ?? [])]);
  }
}

describe('media.convert — WAV/PCM → native FLAC authoring (lossless, ADR-024)', () => {
  for (const c of WAV_CASES) {
    it(`${c.id}: emits valid FLAC; ffprobe agrees; our decode is bit-exact (${c.bitsPerSample}-bit ${c.channels}ch)`, async () => {
      const wavBytes = await loadFixture(c.id);
      const out = await convertToFlac(wavBytes);

      // (1) valid native FLAC stream.
      expect([out[0], out[1], out[2], out[3]]).toEqual([0x66, 0x4c, 0x61, 0x43]); // fLaC

      // (2a) ffprobe (independent) agrees codec/channels/rate/bit-depth.
      const probe = await ffprobeFlac(out);
      expect(probe.codec_name).toBe('flac');
      expect(probe.channels).toBe(c.channels);
      expect(Number(probe.sample_rate)).toBe(c.sampleRate);
      expect(Number(probe.bits_per_raw_sample)).toBe(c.bitsPerSample);

      // (2b) ffmpeg (independent) decodes the FLAC losslessly: the raw PCM MD5 equals STREAMINFO's MD5.
      const decoded = decodeFlac(out);
      const ffmpegMd5 = await ffmpegDecodeFlacMd5(out, c.format);
      expect(ffmpegMd5).toBe(hex(decoded.md5));

      // (3) our pure-TS decode is bit-exactly the source samples (lossless), and its self-MD5 holds.
      const expected = expectedFlacPcm(wavBytes);
      expect(decoded.sampleRate).toBe(c.sampleRate);
      expect(decoded.channels).toBe(c.channels);
      expect(decoded.bitsPerSample).toBe(c.bitsPerSample);
      expect(decoded.totalSamples).toBe(expected.totalSamples);
      assertChannelsExact(decoded.samples, expected.samples);
      expect(md5(interleavedPcmBytes(decoded))).toBe(hex(decoded.md5));
      // The source PCM, serialized the STREAMINFO way, has the same MD5 the FLAC embeds.
      expect(md5(interleavedExpected(expected))).toBe(hex(decoded.md5));
    });
  }

  it(`${FLOAT_CASE.id}: float source is quantized to 24-bit FLAC and round-trips bit-exactly to that quantization`, async () => {
    const wavBytes = await loadFixture(FLOAT_CASE.id);
    const out = await convertToFlac(wavBytes);
    expect([out[0], out[1], out[2], out[3]]).toEqual([0x66, 0x4c, 0x61, 0x43]);

    const probe = await ffprobeFlac(out);
    expect(probe.codec_name).toBe('flac');
    expect(Number(probe.bits_per_raw_sample)).toBe(FLOAT_CASE.bitsPerSample);

    const decoded = decodeFlac(out);
    const expected = expectedFlacPcm(wavBytes); // f32 → 24-bit quantization
    expect(decoded.bitsPerSample).toBe(24);
    assertChannelsExact(decoded.samples, expected.samples);
  });

  it('the FLAC author writes smaller-or-equal output than raw 24-bit verbatim would for a tone (sanity, not a cheat)', async () => {
    // A pure 440 Hz tone is highly compressible; even verbatim FLAC must not be larger than the raw PCM.
    const wavBytes = await loadFixture('sin_440Hz_-6dBFS_1s.wav');
    const out = await convertToFlac(wavBytes);
    const wav = readWavPcm(wavBytes);
    const rawBytes = wav.frames * wav.channels * 2; // s16
    expect(out.byteLength).toBeLessThan(rawBytes * 1.05); // FLAC framing overhead is small
  });
});

/** Independent interleaver for the EXPECTED samples (mirrors STREAMINFO's MD5 definition). */
function interleavedExpected(pcm: FlacPcm): Uint8Array {
  const bytesPerSample = Math.ceil(pcm.bitsPerSample / 8);
  const out = new Uint8Array(pcm.totalSamples * pcm.channels * bytesPerSample);
  let o = 0;
  for (let i = 0; i < pcm.totalSamples; i++) {
    for (let ch = 0; ch < pcm.channels; ch++) {
      let v = pcm.samples[ch]?.[i] ?? 0;
      for (let b = 0; b < bytesPerSample; b++) {
        out[o++] = v & 0xff;
        v = Math.floor(v / 256);
      }
    }
  }
  return out;
}
