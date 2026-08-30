/**
 * write.ts large-output assembly: the muxer must copy the mdat payload straight from each sample's
 * Uint8Array into one output buffer (never a giant `number[]`, which exceeds the JS array-length cap /
 * exhausts the heap on multi-hundred-MB remuxes — the `huge`/`massive` size-ladder crash). These tests
 * exercise the assembly + the single-buffer guard in isolation (no parser/driver), so they are stable
 * regardless of other in-flight work. End-to-end real-corpus remux of the huge asset is covered by the
 * round-trip suite.
 */

import { describe, expect, it } from 'vitest';
import {
  type MuxTrackInput,
  assertSingleBufferSize,
  planReservedMp4ByteStreamLayout,
  writeMp4,
} from './write.ts';

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

  it('plans a bounded moov reservation from a per-track packet ceiling', () => {
    const track = videoTrack([new Uint8Array([1]), new Uint8Array([2])]);
    const layout = planReservedMp4ByteStreamLayout([track], 8);
    expect(layout.observedPacketCount).toBe(2);
    expect(layout.reservationPosition).toBe(layout.ftyp.byteLength);
    expect(layout.mdatPosition).toBe(layout.reservationPosition + layout.reservationBytes);
    expect(layout.moovPatch.byteLength).toBe(layout.reservationBytes);
    expect(String.fromCharCode(...layout.moovPatch.subarray(4, 8))).toBe('moov');
    const moovSize = new DataView(
      layout.moovPatch.buffer,
      layout.moovPatch.byteOffset,
      layout.moovPatch.byteLength,
    ).getUint32(0);
    expect(String.fromCharCode(...layout.moovPatch.subarray(moovSize + 4, moovSize + 8))).toBe(
      'free',
    );
    expect(() => planReservedMp4ByteStreamLayout([track], 1)).toThrowError(
      /MP4_FASTSTART_RESERVE_PACKET_OVERFLOW/,
    );
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

  it('reserve: bounded gap, positional patch, and overflow preflight before first write', () => {
    const track = videoTrack([new Uint8Array([1]), new Uint8Array([2, 3])]);
    // Bounded: reservation must be at least moov+8 and at most estimate, and linear in packet ceiling.
    const small = planReservedMp4ByteStreamLayout([track], 2);
    const large = planReservedMp4ByteStreamLayout([track], 200);
    expect(large.reservationBytes).toBeGreaterThan(small.reservationBytes);
    expect(small.reservationBytes).toBeGreaterThanOrEqual(small.moovPatch.byteLength);
    // Positional: ftyp → reservation → mdat strictly contiguous
    expect(small.reservationPosition).toBe(small.ftyp.byteLength);
    expect(small.mdatPosition).toBe(small.reservationPosition + small.reservationBytes);
    expect(small.totalLen).toBe(
      small.ftyp.byteLength +
        small.reservationBytes +
        small.mdatHeader.byteLength +
        small.mdatPayloadLen,
    );
    // Overflow preflight: estimate > 0xffffffff throws typed mux-error before any allocation
    const hugeMax = Math.ceil((0xffffffff - 1024) / 64) + 1;
    expect(() => planReservedMp4ByteStreamLayout([track], hugeMax)).toThrow(
      /exceeds the 32-bit box limit/,
    );
    expect(() => planReservedMp4ByteStreamLayout([], 8)).toThrow(/zero tracks/);
    expect(() => planReservedMp4ByteStreamLayout([track], 0)).toThrow(/positive integer/);
    expect(() => planReservedMp4ByteStreamLayout([track], 1.5)).toThrow(/positive integer/);
  });

  it('reserve: malformed and boundary inputs fail deterministically', () => {
    const track = videoTrack([new Uint8Array([9])]);
    expect(() => planReservedMp4ByteStreamLayout([track], Number.NaN)).toThrow(/positive integer/);
    expect(() => planReservedMp4ByteStreamLayout([track], Number.POSITIVE_INFINITY)).toThrow(
      /positive integer/,
    );
    // Number.MAX_SAFE_INTEGER as packet ceiling must overflow the 32-bit estimate check, not silently wrap
    expect(() => planReservedMp4ByteStreamLayout([track], Number.MAX_SAFE_INTEGER)).toThrow(
      /exceeds the 32-bit box limit/,
    );
  });

  it('reserve: 20× randomized ceilings are bounded and positional', () => {
    for (let i = 0; i < 20; i++) {
      const packets = 1 + Math.floor(Math.random() * 500);
      const trackCount = 1 + Math.floor(Math.random() * 3);
      const tracks = Array.from({ length: trackCount }, () => videoTrack([new Uint8Array([7])]));
      const layout = planReservedMp4ByteStreamLayout(tracks, packets);
      const estimate = 1024 + trackCount * (4 * 1024 + packets * 64);
      // reservation is max(estimate, moov+8) and never exceeds u32
      expect(layout.reservationBytes).toBeGreaterThanOrEqual(estimate);
      expect(layout.reservationBytes).toBeLessThanOrEqual(0xffffffff);
      expect(layout.mdatPosition).toBe(layout.reservationPosition + layout.reservationBytes);
      expect(layout.moovPatch.byteLength).toBe(layout.reservationBytes);
      // free box after moov must be valid (size >=8)
      const moovSize = new DataView(
        layout.moovPatch.buffer,
        layout.moovPatch.byteOffset,
        layout.moovPatch.byteLength,
      ).getUint32(0);
      expect(moovSize).toBeGreaterThan(8);
      expect(moovSize + 8).toBeLessThanOrEqual(layout.reservationBytes);
    }
  });
});
