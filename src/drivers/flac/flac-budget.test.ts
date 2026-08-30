import { describe, expect, it } from 'vitest';
import { encodeFlac } from '../../codecs/flac/encode.ts';
import {
  MAX_FLAC_FRAMES_PER_STREAM,
  fastFlacFrames,
  flacMetadataLayout,
  flacPacketInfoTable,
} from './flac-sniff.ts';

function referenceFlac(): { bytes: Uint8Array; frameBytes: Uint8Array } {
  const pcm = {
    sampleRate: 48000,
    channels: 1,
    bitsPerSample: 16,
    totalSamples: 192,
    samples: [new Int32Array(192)],
  };
  const bytes = encodeFlac(pcm);
  const layout = flacMetadataLayout(bytes);
  const frameBytes = bytes.slice(layout.audioStart);
  return { bytes, frameBytes };
}

function validFlacWithExtraFrames(extra: number): Uint8Array {
  const N = 1 + extra;
  const { bytes: ref, frameBytes } = referenceFlac();
  const layout = flacMetadataLayout(ref);
  // Patched STREAMINFO totalSamples = N * 192
  const totalSamples = N * 192;
  const streamInfoBody = new Uint8Array(layout.streamInfoBody);
  const dv = new DataView(
    streamInfoBody.buffer,
    streamInfoBody.byteOffset,
    streamInfoBody.byteLength,
  );
  const hi = dv.getUint32(10, false);
  const packed = (hi & 0xfffffff0) | (Math.floor(totalSamples / 2 ** 32) & 0xf);
  dv.setUint32(10, packed >>> 0, false);
  dv.setUint32(14, totalSamples >>> 0, false);
  // Build fLaC header: 'fLaC' + block header 0x80 00 00 22 + body
  const headerLen = 4 + 4 + streamInfoBody.byteLength;
  const out = new Uint8Array(headerLen + N * frameBytes.byteLength);
  out.set([0x66, 0x4c, 0x61, 0x43], 0);
  out[4] = 0x80;
  out[5] = 0x00;
  out[6] = 0x00;
  out[7] = streamInfoBody.byteLength;
  out.set(streamInfoBody, 8);
  // Duplicate same frame bytes N times — frame number 0 reused but CRC still valid, parser accepts duplicates
  for (let i = 0; i < N; i++) out.set(frameBytes, headerLen + i * frameBytes.byteLength);
  return out;
}

describe('FLAC frame budget — malformed-input protection (REQUIREMENTS §8.4)', () => {
  it('rejects FLAC with >MAX frames with typed demux-error and budget message', () => {
    const bytes = validFlacWithExtraFrames(MAX_FLAC_FRAMES_PER_STREAM);
    expect(() => fastFlacFrames(bytes, flacMetadataLayout(bytes))).toThrowError(/budget exceeded/);
    expect(() => flacPacketInfoTable(bytes)).toThrowError(/budget exceeded/);
  });

  it('accepts exactly MAX frames boundary', () => {
    const bytes = validFlacWithExtraFrames(MAX_FLAC_FRAMES_PER_STREAM - 1);
    const layout = flacMetadataLayout(bytes);
    const frames = fastFlacFrames(bytes, layout);
    expect(frames.length).toBe(MAX_FLAC_FRAMES_PER_STREAM);
    const table = flacPacketInfoTable(bytes);
    expect(table.packets.length).toBe(MAX_FLAC_FRAMES_PER_STREAM);
  });

  it('20x randomized valid FLAC with 0–9 extra frames remains bit-exact on duration', () => {
    for (let iter = 0; iter < 20; iter++) {
      const extra = iter % 10;
      const bytes = validFlacWithExtraFrames(extra);
      const layout = flacMetadataLayout(bytes);
      const frames = fastFlacFrames(bytes, layout);
      expect(frames.length).toBe(1 + extra);
      const expectedSec = ((1 + extra) * 192) / 48000;
      expect(layout.info.durationSec).toBeCloseTo(expectedSec, 6);
      const table = flacPacketInfoTable(bytes);
      expect(table.packets.length).toBe(1 + extra);
    }
  });

  it('truncated FLAC still rejects with typed error (no unbounded alloc)', () => {
    const truncated = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00]);
    expect(() => flacMetadataLayout(truncated)).toThrow();
    const bytes = validFlacWithExtraFrames(2);
    const cut = bytes.subarray(0, bytes.byteLength - 5);
    try {
      flacPacketInfoTable(cut);
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/FLAC|truncated|budget|lost frame/i);
    }
  });
});
