import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { MAX_WAV_CHUNKS_PER_FILE, parseWav, parseWavHeader } from './wav-probe.ts';

function wavWithJunk(junkCount: number): Uint8Array {
  const fmtBody = new Uint8Array(16);
  const dv = new DataView(fmtBody.buffer);
  dv.setUint16(0, 1, true); // PCM
  dv.setUint16(2, 1, true); // mono
  dv.setUint32(4, 48000, true);
  dv.setUint32(8, 48000 * 2, true); // byteRate
  dv.setUint16(12, 2, true); // blockAlign
  dv.setUint16(14, 16, true);
  const fmtChunk = new Uint8Array(8 + fmtBody.byteLength);
  fmtChunk.set([0x66, 0x6d, 0x74, 0x20], 0); // fmt
  new DataView(fmtChunk.buffer).setUint32(4, fmtBody.byteLength, true);
  fmtChunk.set(fmtBody, 8);

  const dataPayload = new Uint8Array(4);
  const dataChunk = new Uint8Array(8 + dataPayload.byteLength);
  dataChunk.set([0x64, 0x61, 0x74, 0x61], 0); // data
  new DataView(dataChunk.buffer).setUint32(4, dataPayload.byteLength, true);
  dataChunk.set(dataPayload, 8);

  const junkPayload = new Uint8Array(4);
  const junkChunk = new Uint8Array(8 + junkPayload.byteLength);
  junkChunk.set([0x4a, 0x55, 0x4e, 0x4b], 0);
  new DataView(junkChunk.buffer).setUint32(4, junkPayload.byteLength, true);
  junkChunk.set(junkPayload, 8);

  const total = 12 + fmtChunk.byteLength + junkCount * junkChunk.byteLength + dataChunk.byteLength;
  const out = new Uint8Array(total);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(out.buffer).setUint32(4, total - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  let off = 12;
  out.set(fmtChunk, off);
  off += fmtChunk.byteLength;
  for (let i = 0; i < junkCount; i++) {
    out.set(junkChunk, off);
    off += junkChunk.byteLength;
  }
  out.set(dataChunk, off);
  return out;
}

describe('WAV chunk-count budget', () => {
  it('rejects >MAX chunks with typed demux-error and budget message', () => {
    const bytes = wavWithJunk(MAX_WAV_CHUNKS_PER_FILE - 1); // fmt + (MAX-1) junk + data = MAX+1
    expect(() => parseWav(bytes)).toThrow(MediaError);
    try {
      parseWav(bytes);
    } catch (e) {
      expect((e as MediaError).code).toBe('demux-error');
      expect((e as Error).message).toMatch(/budget exceeded/);
    }
    expect(() => parseWavHeader(bytes, bytes.byteLength)).toThrow(MediaError);
  });

  it('accepts exactly MAX chunks at the boundary', () => {
    const bytes = wavWithJunk(MAX_WAV_CHUNKS_PER_FILE - 2); // fmt + (MAX-2) junk + data = MAX
    const info = parseWav(bytes);
    expect(info.codec).toBe('pcm-s16');
    const header = parseWavHeader(bytes, bytes.byteLength);
    expect(header.dataFound).toBe(true);
  });

  it('20× randomized 0–9 JUNK chunks stay bit-exact on duration', () => {
    let seed = 0x12345678;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let iter = 0; iter < 20; iter++) {
      const n = next() % 10;
      const bytes = wavWithJunk(n);
      const info = parseWav(bytes);
      expect(info.durationSec).toBeCloseTo(4 / (48000 * 2), 6);
      expect(info.channels).toBe(1);
    }
  });

  it('rejects truncated/malformed without OOM', () => {
    const valid = wavWithJunk(1);
    const truncated = valid.subarray(0, 10);
    expect(() => parseWav(truncated)).toThrow(MediaError);
    expect(() => parseWav(new Uint8Array([0, 1, 2, 3]))).toThrow(MediaError);
  });
});
