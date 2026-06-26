/**
 * PCM-native keyframe trim (BUILD §2/§6; ADR-021/ADR-022) — proves `trim` on a raw-PCM container
 * (WAV/AIFF/CAF) performs a **sample-accurate, lossless cut** through the container's `transformPcm` path,
 * with NO codec seam (it runs entirely in pure TS, validated in Node). PCM has no inter-frame dependency, so
 * a "keyframe" trim is just a sample slice — and the strong oracle is **bit-exactness**: the trimmed output,
 * decoded back to planar PCM, must equal the corresponding `[startSec, endSec)` slice of the SOURCE's planar
 * samples, sample for sample. A loose "did it produce bytes" gate is forbidden (directive 6); this compares
 * every kept sample and is shown to fail if the cut window is wrong.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { type AiffPcm, readAiffPcm } from '../drivers/aiff/aiff.ts';
import { type CafPcm, readCafPcm } from '../drivers/caf/caf.ts';
import { type WavPcm, readWavPcm } from '../drivers/wav/pcm.ts';
import type { PcmAudio } from '../dsp/pcm.ts';
import { fromBytes } from '../sources/source.ts';
import { MediaEngineImpl } from './engine.ts';

const MEDIA = new URL('../../fixtures/media/', import.meta.url);
const DERIVED = new URL('../../fixtures/media-derived/aiff-caf/', import.meta.url);

function media(): MediaEngineImpl {
  return new MediaEngineImpl({ worker: false });
}

async function bytes(dir: URL, id: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(id, dir)));
}

async function blobBytes(out: unknown): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob result from trim');
  return new Uint8Array(await out.arrayBuffer());
}

/** Frame index of `sec` in `rate` (the engine's own rounding — `Math.round(sec*rate)`). */
function frameAt(sec: number, rate: number): number {
  return Math.round(sec * rate);
}

/** Assert the trimmed planar PCM equals the source's `[startSec, endSec)` slice, sample for sample. */
function expectSliceExact(
  source: PcmAudio,
  trimmed: PcmAudio,
  startSec: number,
  endSec: number,
): void {
  const rate = source.sampleRate;
  const start = Math.min(source.frames, Math.max(0, frameAt(startSec, rate)));
  const end = Math.min(source.frames, Math.max(start, frameAt(endSec, rate)));
  expect(trimmed.sampleRate).toBe(rate);
  expect(trimmed.channels).toBe(source.channels);
  expect(trimmed.frames).toBe(end - start); // frame-exact window
  for (let ch = 0; ch < source.channels; ch++) {
    const src = source.planar[ch];
    const cut = trimmed.planar[ch];
    if (src === undefined || cut === undefined) throw new Error('missing channel');
    // Compare the whole kept window bit-exactly (Float64 canonical samples — the decode is lossless PCM↔PCM).
    for (let i = 0; i < cut.length; i++) {
      if (cut[i] !== src[start + i]) {
        throw new Error(
          `sample mismatch ch${ch} frame${i}: got ${cut[i]} expected ${src[start + i]}`,
        );
      }
    }
  }
}

describe('PCM-native trim (WAV) — sample-exact lossless cut', () => {
  const WAVS = [
    'speech.wav',
    'sfx-pcm-s16.wav',
    'sfx-pcm-s24.wav',
    'sfx-pcm-f32.wav',
    'stereo-48000.wav',
  ];

  for (const id of WAVS) {
    it(`trims ${id} to a bit-exact sample window`, async () => {
      const raw = await bytes(MEDIA, id);
      const source: WavPcm = readWavPcm(raw);
      // A mid-file window comfortably inside the duration (every fixture is ≥ ~0.2s).
      const durationSec = source.frames / source.sampleRate;
      const startSec = durationSec * 0.25;
      const endSec = durationSec * 0.6;
      const out = await blobBytes(
        await media().trim(fromBytes(raw), { start: startSec, end: endSec }),
      );
      expectSliceExact(source, readWavPcm(out), startSec, endSec);
    });
  }

  it('a "to EOF" window keeps exactly the tail (clamps past-end without error)', async () => {
    const raw = await bytes(MEDIA, 'speech.wav');
    const source = readWavPcm(raw);
    const durationSec = source.frames / source.sampleRate;
    const startSec = durationSec * 0.8;
    // end exactly at duration (the engine's range-validator allows up to +1s slack).
    const out = await blobBytes(
      await media().trim(fromBytes(raw), { start: startSec, end: durationSec }),
    );
    expectSliceExact(source, readWavPcm(out), startSec, durationSec);
  });
});

describe('PCM-native trim (AIFF) — sample-exact lossless cut', () => {
  const AIFFS = ['sfx.aiff', 'sfx-s24.aiff'];
  for (const id of AIFFS) {
    it(`trims ${id} to a bit-exact sample window`, async () => {
      const raw = await bytes(DERIVED, id);
      const source: AiffPcm = readAiffPcm(raw);
      const durationSec = source.frames / source.sampleRate;
      const startSec = durationSec * 0.3;
      const endSec = durationSec * 0.7;
      const out = await blobBytes(
        await media().trim(fromBytes(raw), { start: startSec, end: endSec }),
      );
      // The AIFF driver's transformPcm re-serializes AIFF; decode the output back to planar and compare.
      expectSliceExact(source, readAiffPcm(out), startSec, endSec);
    });
  }
});

describe('PCM-native trim (CAF) — sample-exact lossless cut', () => {
  const CAFS = ['sfx-be.caf', 'sfx-f32.caf', 'sfx-u8.caf'];
  for (const id of CAFS) {
    it(`trims ${id} to a bit-exact sample window`, async () => {
      const raw = await bytes(DERIVED, id);
      const source: CafPcm = readCafPcm(raw);
      const durationSec = source.frames / source.sampleRate;
      const startSec = durationSec * 0.2;
      const endSec = durationSec * 0.65;
      const out = await blobBytes(
        await media().trim(fromBytes(raw), { start: startSec, end: endSec }),
      );
      expectSliceExact(source, readCafPcm(out), startSec, endSec);
    });
  }
});

describe('PCM trim still rejects a malformed range (before any cut)', () => {
  it('rejects an inverted range with a typed InputError', async () => {
    const raw = await bytes(MEDIA, 'speech.wav');
    await expect(media().trim(fromBytes(raw), { start: 1.0, end: 0.5 })).rejects.toMatchObject({
      name: 'InputError',
    });
  });
});
