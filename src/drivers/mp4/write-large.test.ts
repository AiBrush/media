/**
 * write.ts large-output assembly: the muxer must copy the mdat payload straight from each sample's
 * Uint8Array into one output buffer (never a giant `number[]`, which exceeds the JS array-length cap /
 * exhausts the heap on multi-hundred-MB remuxes — the `huge`/`massive` size-ladder crash). These tests
 * exercise the assembly + the single-buffer guard in isolation (no parser/driver), so they are stable
 * regardless of other in-flight work. End-to-end real-corpus remux of the huge asset is covered by the
 * round-trip suite.
 */

import { describe, expect, it } from 'vitest';
import { type MuxTrackInput, assertSingleBufferSize, writeMp4 } from './write.ts';

function videoTrack(samples: Uint8Array[]): MuxTrackInput {
  return {
    mediaType: 'video',
    sampleEntryType: 'avc1',
    timescale: 600,
    description: new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00]),
    width: 16,
    height: 16,
    samples: samples.map((data, i) => ({
      data,
      durationTicks: 300,
      cttsTicks: 0,
      keyframe: i === 0,
    })),
  };
}

describe('writeMp4 — large-output assembly (Uint8Array, not number[])', () => {
  it('faststart: mdat tail is exactly the concatenated sample bytes', () => {
    const s1 = new Uint8Array([1, 2, 3, 4, 5]);
    const s2 = new Uint8Array([6, 7, 8]);
    const out = writeMp4([videoTrack([s1, s2])]);
    expect(out).toBeInstanceOf(Uint8Array);
    // faststart layout ends with the mdat payload (samples), so the tail is the concatenation.
    const tail = out.subarray(out.length - (s1.length + s2.length));
    expect([...tail]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('assembles a multi-MB mdat without overflow (huge/massive remux resistance)', () => {
    const big = new Uint8Array(4_000_000).fill(0xab); // 4 MB sample — a giant number[] path would choke
    const out = writeMp4([videoTrack([big])]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThan(big.length);
    const tail = out.subarray(out.length - big.length);
    expect(tail.length).toBe(big.length);
    expect(tail[0]).toBe(0xab);
    expect(tail[big.length - 1]).toBe(0xab);
  });

  it('non-faststart still round-trips the same sample bytes (mdat precedes moov)', () => {
    const s1 = new Uint8Array([10, 20, 30]);
    const out = writeMp4([videoTrack([s1])], { faststart: false });
    expect(out).toBeInstanceOf(Uint8Array);
    // mdat is right after ftyp here, so the samples are NOT at the tail; assert they appear contiguously.
    const hay = [...out];
    const idx = hay.findIndex((_, i) => hay[i] === 10 && hay[i + 1] === 20 && hay[i + 2] === 30);
    expect(idx).toBeGreaterThan(0);
  });

  it('assertSingleBufferSize: accepts ≤ the 4.29 GB cap, throws above it', () => {
    expect(() => assertSingleBufferSize(0xffffffff)).not.toThrow();
    expect(() => assertSingleBufferSize(0xffffffff + 1)).toThrow(/single-buffer limit/);
  });

  it('builds a 200k-sample moov without a stack overflow (massive size-ladder rung)', () => {
    // stsz/stss become 200k-entry tables. The old `cat(u32(n), ...vals.map(u32))` passed one argument
    // per entry → "Maximum call stack size exceeded"; the push-based builder handles any count.
    const n = 200_000;
    const samples = Array.from({ length: n }, () => new Uint8Array([7]));
    const out = writeMp4([videoTrack(samples)]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThan(n); // ftyp + moov(tables) + mdat(n×1 byte)
    // mdat tail is the n sample bytes (all 0x07).
    expect(out[out.length - 1]).toBe(7);
    expect(out[out.length - n]).toBe(7);
  });
});
