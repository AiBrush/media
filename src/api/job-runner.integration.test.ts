import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from './create-media.ts';

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
});
