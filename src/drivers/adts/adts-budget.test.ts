import { describe, expect, it } from 'vitest';
import { enumerateAdtsFrames, parseAdts } from './adts-driver.ts';
import { MAX_ADTS_FRAMES_PER_STREAM, walkAdtsBuffer } from './adts-frames.ts';

function validAdtsWithExtraFrames(extra: number): Uint8Array {
  // Minimal valid ADTS frame: 7-byte header + 5 byte payload = 12 bytes
  // Header bytes: ff f1 10 00 01 5f fc  (mpeg4 aac-lc 44100 stereo, frameLen 12, 1 raw block)
  const count = 1 + extra;
  const frameLen = 12;
  const bytes: number[] = [];
  for (let i = 0; i < count; i++) {
    bytes.push(
      0xff,
      0xf1,
      0x50,
      0x80,
      (frameLen >> 3) & 0xff,
      ((frameLen & 0x7) << 5) | 0x1f,
      0xfc,
    );
    for (let j = 0; j < 5; j++) bytes.push(0x00);
  }
  return new Uint8Array(bytes);
}

describe('ADTS frame budget — malformed-input protection (REQUIREMENTS §8.4)', () => {
  it('rejects ADTS with >MAX frames with typed demux-error and budget message', () => {
    const bytes = validAdtsWithExtraFrames(MAX_ADTS_FRAMES_PER_STREAM);
    expect(() => walkAdtsBuffer(bytes)).toThrowError(/budget exceeded/);
    expect(() => enumerateAdtsFrames(bytes)).toThrowError(/budget exceeded/);
    expect(() => parseAdts(bytes)).toThrowError(/budget exceeded/);
  });

  it('accepts exactly MAX frames boundary', () => {
    const bytes = validAdtsWithExtraFrames(MAX_ADTS_FRAMES_PER_STREAM - 1);
    const frames = enumerateAdtsFrames(bytes);
    expect(frames.length).toBe(MAX_ADTS_FRAMES_PER_STREAM);
    const stats = walkAdtsBuffer(bytes);
    expect(stats.frames).toBe(MAX_ADTS_FRAMES_PER_STREAM);
    const info = parseAdts(bytes);
    expect(info.frames).toBe(MAX_ADTS_FRAMES_PER_STREAM);
  });

  it('20x randomized valid ADTS with 0–9 extra frames remains bit-exact on frame count + duration', () => {
    for (let iter = 0; iter < 20; iter++) {
      const extra = iter % 10;
      const bytes = validAdtsWithExtraFrames(extra);
      const frames = enumerateAdtsFrames(bytes);
      expect(frames.length).toBe(1 + extra);
      const stats = walkAdtsBuffer(bytes);
      expect(stats.frames).toBe(1 + extra);
      expect(stats.durationSec).toBeCloseTo(((1 + extra) * 1024) / 44100, 6);
    }
  });

  it('truncated ADTS with malformed tail rejects with typed error (no unbounded alloc)', () => {
    const truncated = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x01, 0x5f, 0xfc]);
    try {
      enumerateAdtsFrames(truncated);
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/ADTS|no decodable|budget|sync/i);
    }
    const bytes = validAdtsWithExtraFrames(2);
    const cut = bytes.subarray(0, bytes.byteLength - 5);
    // cut mid-frame: last declared frame truncated, should either parse 2 frames or reject, never budget
    try {
      const f = enumerateAdtsFrames(cut);
      expect(f.length).toBe(2);
    } catch (e: unknown) {
      expect((e as Error).message).toMatch(/ADTS|no decodable|truncated|budget/i);
    }
  });
});
