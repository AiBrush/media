import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { toBlob } from '../sinks/sink.ts';
import { createMedia } from './create-media.ts';

/**
 * Baked golden for the documented `trim 0–0.1s → wav pcm-s16` job on `sfx-pcm-s16.wav`, produced by the
 * staged reference path (`trim → Blob → convert`) on the pure-TS tier. The fused single-pipe runner must
 * reproduce it bit-exactly.
 */
const TRIM_WAV_SHA256 = '210de71b0c07a557db5c229f0af69f628126cdf7c05ac312573745c309289cc1';
const TRIM_WAV_BYTES = 9_644;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface WavDataChunk {
  readonly offset: number;
  readonly size: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function wavDataChunk(bytes: Uint8Array): WavDataChunk {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('job integration output is not RIFF/WAVE');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > bytes.byteLength) throw new Error(`WAV ${id} chunk exceeds file bounds`);
    if (id === 'data') return { offset: payload, size };
    offset = payload + size + (size & 1);
  }
  throw new Error('job integration output has no WAV data chunk');
}

describe('declarative job runner — real engine', () => {
  it('trims real mono PCM through a Blob boundary and preserves the exact selected samples', async () => {
    const source = new Uint8Array(
      await readFile(new URL('../../fixtures/media/sfx-pcm-s16.wav', import.meta.url)),
    );
    const engine = createMedia();
    const output = await engine.run({
      input: source,
      ops: [{ op: 'trim', start: 0, end: 0.1 }],
      output: { container: 'wav', video: false, audio: { codec: 'pcm-s16' } },
    });

    const outputBytes = new Uint8Array(await output.arrayBuffer());
    const sourceData = wavDataChunk(source);
    const outputData = wavDataChunk(outputBytes);
    const expectedDataBytes = 4_800 * 1 * 2;
    expect(outputData.size).toBe(expectedDataBytes);
    expect(outputBytes.subarray(outputData.offset, outputData.offset + outputData.size)).toEqual(
      source.subarray(sourceData.offset, sourceData.offset + expectedDataBytes),
    );

    const info = await engine.probe(output);
    expect(info).toMatchObject({
      container: 'wav',
      sizeBytes: output.size,
      tracks: [
        {
          type: 'audio',
          codec: 'pcm-s16',
          sampleRate: 48_000,
          channels: 1,
        },
      ],
    });
    expect(info.durationSec).toBeCloseTo(0.1, 12);
    expect(info.tracks[0]?.durationSec).toBeCloseTo(0.1, 12);
  });

  it('fused single-pipe job output ≡ staged two-op output, byte-for-byte, matching the baked golden', async () => {
    const source = new Uint8Array(
      await readFile(new URL('../../fixtures/media/sfx-pcm-s16.wav', import.meta.url)),
    );
    const engine = createMedia();

    // Fused: the declarative runner executes trim → convert as one pipe (lazy stream boundary,
    // source opened once, nothing materialized between the operations).
    const fused = await engine.run({
      input: source,
      ops: [{ op: 'trim', start: 0, end: 0.1 }],
      output: { container: 'wav', video: false, audio: { codec: 'pcm-s16' } },
    });
    const fusedBytes = new Uint8Array(await fused.arrayBuffer());

    // Staged reference: the same two flat operations with an explicit Blob materialization boundary —
    // the metamorphic oracle: changing the boundary must not change one output byte.
    const trimmed = await engine.trim(source, { start: 0, end: 0.1, sink: toBlob() });
    expect(trimmed).toBeInstanceOf(Blob);
    const staged = await engine.convert(trimmed as Blob, {
      to: 'wav',
      video: false,
      audio: { codec: 'pcm-s16' },
    });
    expect(staged).toBeInstanceOf(Blob);
    const stagedBytes = new Uint8Array(await (staged as Blob).arrayBuffer());

    expect(fusedBytes.byteLength).toBe(TRIM_WAV_BYTES);
    expect(fusedBytes).toEqual(stagedBytes);
    expect(sha256(fusedBytes)).toBe(TRIM_WAV_SHA256);
    expect(sha256(stagedBytes)).toBe(TRIM_WAV_SHA256);
  });

  it('fused ≡ staged holds on a real video container too (mp4 keyframe trim → mp4)', async () => {
    const source = new Uint8Array(
      await readFile(new URL('../../fixtures/media/bear-1280x720.mp4', import.meta.url)),
    );
    const engine = createMedia();

    const fused = await engine.run({
      input: source,
      ops: [{ op: 'trim', start: 0, end: 1 }],
      output: { container: 'mp4' },
    });
    const fusedBytes = new Uint8Array(await fused.arrayBuffer());

    const trimmed = await engine.trim(source, { start: 0, end: 1, sink: toBlob() });
    expect(trimmed).toBeInstanceOf(Blob);
    const staged = await engine.convert(trimmed as Blob, { to: 'mp4' });
    expect(staged).toBeInstanceOf(Blob);
    const stagedBytes = new Uint8Array(await (staged as Blob).arrayBuffer());

    // Metamorphic only (no baked hash): the mp4 muxer may legitimately evolve in its own family, but
    // moving the op boundary from a Blob to the fused lazy pipe must never change one output byte.
    expect(fusedBytes.byteLength).toBeGreaterThan(0);
    expect(sha256(fusedBytes)).toBe(sha256(stagedBytes));
    expect(fusedBytes).toEqual(stagedBytes);
  });
});
