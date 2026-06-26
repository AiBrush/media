/**
 * `decoded-frames-bitexact` oracle for the **pure-TS decode paths** (doc 11 §1: strongest oracle, sha256 of
 * decoded samples in force-software; task §3.F).
 *
 * Gates the from-scratch TS FLAC decoder and the WAV/PCM decoder against committed, sha256-pinned decoded
 * PCM for real fixtures. Each golden was baked AND cross-checked byte-exactly against an independent
 * **ffmpeg** decode at bake time (`ffmpegCrossChecked`), so it is not a self-confirming round-trip — a
 * regression that drifts from ffmpeg's independent decoder fails here (doc 11 §5, ADR-085). FLAC + PCM are
 * lossless, so a correct decoder MUST agree with ffmpeg bit-for-bit (the one documented exception is 12-bit
 * FLAC, where ffmpeg scales to s16 full-scale; that golden is self-validated by FLAC's STREAMINFO MD5,
 * checked inside the decoder, and flagged `ffmpegCrossChecked:false`).
 *
 * Pure TS ⇒ runs identically in Node and the browser, so this bit-exact gate is the force-software half of
 * the decode oracle for these codecs (doc 11 §6); the hardware/WebCodecs tiers are tolerance-banded in the
 * browser harness.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  type DecodeGolden,
  flacDecodeGolden,
  wavDecodeGolden,
} from '../test-support/decode-goldens.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const GOLDEN_DIR = `${ROOT}fixtures/golden/decoded`;

const FLAC_FIXTURES = [
  'sfx.flac',
  'flac-08bit.flac',
  'flac-24bit-hires.flac',
  'flac-5_1ch.flac',
  'flac-192khz.flac',
  'flac-12bit.flac',
] as const;
const WAV_FIXTURES = [
  'sfx-pcm-u8.wav',
  'sfx-pcm-s16.wav',
  'sfx-pcm-s24.wav',
  'sfx-pcm-s32.wav',
  'sfx-pcm-f32.wav',
  'stereo-48000.wav',
] as const;

async function loadGolden(id: string): Promise<DecodeGolden> {
  return JSON.parse(await readFile(`${GOLDEN_DIR}/${id}.json`, 'utf8')) as DecodeGolden;
}
async function loadBytes(id: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_DIR}/${id}`));
}

describe('decoded-frames-bitexact — pure-TS FLAC decode reproduces the committed PCM digest', () => {
  it.each(FLAC_FIXTURES)('%s decodes to the sha256-pinned interleaved PCM', async (id) => {
    const golden = await loadGolden(id);
    const actual = await flacDecodeGolden(await loadBytes(id));
    expect(actual.sampleRate).toBe(golden.sampleRate);
    expect(actual.channels).toBe(golden.channels);
    expect(actual.bitsPerSample).toBe(golden.bitsPerSample);
    expect(actual.frames).toBe(golden.frames);
    expect(actual.bytes).toBe(golden.bytes);
    expect(actual.sha256).toBe(golden.sha256); // the bit-exact gate
  });

  it('the FLAC corpus is diverse (≥5 files spanning 8/16/24-bit, mono/stereo/multichannel, hi-res)', async () => {
    const depths = new Set<number>();
    const channels = new Set<number>();
    let crossChecked = 0;
    for (const id of FLAC_FIXTURES) {
      const g = await loadGolden(id);
      depths.add(g.bitsPerSample);
      channels.add(g.channels);
      if (g.ffmpegCrossChecked) crossChecked++;
    }
    expect(FLAC_FIXTURES.length).toBeGreaterThanOrEqual(5);
    expect([...depths].sort()).toEqual(expect.arrayContaining([8, 16, 24]));
    expect(channels.has(1) && channels.has(2) && channels.has(6)).toBe(true); // mono + stereo + 5.1
    expect(crossChecked, 'most FLAC goldens are ffmpeg-corroborated').toBeGreaterThanOrEqual(5);
  });
});

describe('decoded-audio-pcm — WAV/PCM decode reproduces the committed PCM digest', () => {
  it.each(WAV_FIXTURES)('%s decodes to the sha256-pinned PCM (ffmpeg-corroborated)', async (id) => {
    const golden = await loadGolden(id);
    const actual = await wavDecodeGolden(await loadBytes(id));
    expect(actual.bitsPerSample).toBe(golden.bitsPerSample);
    expect(actual.channels).toBe(golden.channels);
    expect(actual.sha256).toBe(golden.sha256);
    expect(actual.ffmpegCrossChecked).toBe(true);
  });

  it('the WAV corpus spans every PCM sample format (u8/s16/s24/s32/f32) + stereo', async () => {
    const depths = new Set<number>();
    for (const id of WAV_FIXTURES) depths.add((await loadGolden(id)).bitsPerSample);
    expect([...depths].sort((a, b) => a - b)).toEqual([8, 16, 24, 32]); // f32 shares 32-bit width
  });
});

describe('decoded-frames-bitexact — the oracle can fail (mutation self-check, doc 11 §5)', () => {
  it('a corrupted FLAC payload does NOT reproduce the golden digest', async () => {
    const golden = await loadGolden('sfx.flac');
    const bytes = await loadBytes('sfx.flac');
    // Flip a 64-byte run deep in the audio payload (80%): enough coded bits change that the decoded PCM
    // must differ (a single isolated bitflip can land in a CRC/padding byte the decoder tolerates, which is
    // why we corrupt a whole run — the mutation must be guaranteed to perturb the output to be a real gate).
    const tampered = bytes.slice();
    const from = Math.floor(tampered.length * 0.8);
    for (let i = from; i < from + 64 && i < tampered.length; i++)
      tampered[i] = (tampered[i] ?? 0) ^ 0xff;
    const out = await flacDecodeGolden(tampered).catch(() => undefined);
    // Either the decoder rejects the corrupt stream (typed throw), or it decodes to DIFFERENT PCM — never
    // silently back to the golden digest (that would be a non-failable oracle).
    if (out) expect(out.sha256).not.toBe(golden.sha256);
    // …and the pristine input still matches, proving the gate is live.
    expect((await flacDecodeGolden(bytes)).sha256).toBe(golden.sha256);
  });

  it('a truncated FLAC stream is rejected or yields a different digest (never the golden)', async () => {
    const golden = await loadGolden('sfx.flac');
    const bytes = await loadBytes('sfx.flac');
    const truncated = bytes.slice(0, Math.floor(bytes.length * 0.6));
    const out = await flacDecodeGolden(truncated).catch(() => undefined);
    if (out) expect(out.sha256).not.toBe(golden.sha256);
  });

  it('a different fixtures PCM does not collide with another golden (no per-asset hardcoding)', async () => {
    const a = await loadGolden('sfx-pcm-s16.wav');
    const b = await wavDecodeGolden(await loadBytes('stereo-48000.wav'));
    expect(b.sha256).not.toBe(a.sha256);
  });
});
