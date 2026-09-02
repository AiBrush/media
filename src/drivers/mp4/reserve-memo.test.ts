import { describe, it, expect } from 'vitest';
import { planReservedMp4ByteStreamLayout } from './write.ts';
import type { MuxTrackLayoutInput } from './write.ts';

function mkTrack(samples: number, opts: Partial<MuxTrackLayoutInput> = {}): MuxTrackLayoutInput {
  return {
    mediaType: 'video',
    sampleEntryType: 'avc1',
    timescale: 90000,
    samples: Array.from({ length: samples }, (_, i) => ({
      data: new Uint8Array([1, 2, 3]),
      durationTicks: 3000,
      cttsTicks: 0,
      keyframe: i === 0,
    })),
    width: 640,
    height: 360,
    ...opts,
  } as unknown as MuxTrackLayoutInput;
}

describe('reserve layout planning (purity)', () => {
  it('unit: identical shape AND content produce byte-identical layouts (deterministic)', () => {
    const t = [mkTrack(4), mkTrack(4, { mediaType: 'audio', sampleEntryType: 'mp4a', timescale: 48000 })];
    const a = planReservedMp4ByteStreamLayout(t as never, 4096);
    const b = planReservedMp4ByteStreamLayout(t as never, 4096);
    expect(a.ftyp).toEqual(b.ftyp);
    expect(a.moovPatch).toEqual(b.moovPatch); // equal BYTES for equal inputs — never reference-identity
    expect(a.reservationBytes).toBe(b.reservationBytes);
    expect(a.totalLen).toBe(b.totalLen);
  });

  it('property: same sample COUNTS but different sizes/keyframes/edits must never share a moovPatch', () => {
    // Regression guard: a shape-keyed layout memo (counts+codecs+timescale) returned the FIRST
    // plan's moovPatch for later same-shape plans. stsz/stss/elst carry per-sample facts, so any
    // content delta with an identical shape silently corrupted the sample table (observed as
    // `progressive output unexpectedly contains moof fragments` on adjacent-equal-size trim rows).
    const t1 = [mkTrack(2)];
    (t1[0]!.samples[0] as { data: Uint8Array }).data = new Uint8Array(100);
    (t1[0]!.samples[1] as { data: Uint8Array }).data = new Uint8Array(200);
    const t2 = [mkTrack(2)];
    (t2[0]!.samples[0] as { data: Uint8Array }).data = new Uint8Array(10);
    (t2[0]!.samples[1] as { data: Uint8Array }).data = new Uint8Array(10);
    const a = planReservedMp4ByteStreamLayout(t1 as never, 8);
    const b = planReservedMp4ByteStreamLayout(t2 as never, 8);
    expect(a.moovPatch).not.toBe(b.moovPatch);
    expect(a.moovPatch).not.toEqual(b.moovPatch); // sizes differ ⇒ stsz must differ
    expect(a.mdatPayloadLen).toBe(300);
    expect(b.mdatPayloadLen).toBe(20);
    // Same sizes, different keyframe flags ⇒ stss differs ⇒ distinct patch.
    const t3 = [mkTrack(2, {})];
    (t3[0]!.samples[0] as { keyframe: boolean }).keyframe = false;
    (t3[0]!.samples[1] as { keyframe: boolean }).keyframe = true;
    const c = planReservedMp4ByteStreamLayout(t3 as never, 8);
    expect(c.moovPatch).not.toEqual(a.moovPatch);
    // Distinct payload lengths must be observable end-to-byte: a re-read of each layout total.
    for (const plan of [a, b, c]) {
      expect(plan.totalLen).toBe(plan.ftyp.length + plan.reservationBytes + plan.mdatHeader.length + plan.mdatPayloadLen);
    }
  });

  it('boundary: maximumPacketCount limits', () => {
    const t = [mkTrack(1)];
    expect(() => planReservedMp4ByteStreamLayout(t as any, 1)).not.toThrow();
    expect(() => planReservedMp4ByteStreamLayout(t as any, 0)).toThrow();
    expect(() => planReservedMp4ByteStreamLayout(t as any, 4096)).not.toThrow();
    const many = [mkTrack(4096)];
    expect(() => planReservedMp4ByteStreamLayout(many as any, 4096)).not.toThrow();
    expect(() => planReservedMp4ByteStreamLayout(many as any, 4095)).toThrow(/exceeding/);
  });

  it('malformed: zero tracks and invalid inputs', () => {
    expect(() => planReservedMp4ByteStreamLayout([] as any, 4)).toThrow(/zero tracks/);
    expect(() => planReservedMp4ByteStreamLayout([mkTrack(1)] as any, NaN)).toThrow();
    expect(() => planReservedMp4ByteStreamLayout([mkTrack(1)] as any, 1.5 as any)).toThrow();
  });

  it('randomized: random payloads preserve invariants', () => {
    for (let r = 0; r < 20; r++) {
      const n = 1 + Math.floor(Math.random() * 8);
      const t = [mkTrack(n)];
      for (let i = 0; i < n; i++) {
        const sz = 1 + Math.floor(Math.random() * 500);
        (t[0]!.samples[i] as any).data = new Uint8Array(sz).fill(r);
      }
      const out = planReservedMp4ByteStreamLayout(t as any, 32);
      expect(out.reservationBytes).toBeGreaterThan(0);
      expect(out.mdatPayloadLen).toBe(t[0]!.samples.reduce((s, x: any) => s + x.data.byteLength, 0));
      expect(out.totalLen).toBe(out.ftyp.length + out.reservationBytes + out.mdatHeader.length + out.mdatPayloadLen);
    }
  });
});
