import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import { SAFE_SINGLE_ARRAY_BUFFER_BYTES } from '../internal/buffer-policy.ts';
import {
  BUFFERED_MP4_CONVERT_MAX_PROJECTED_PAYLOAD_BYTES,
  assertBufferedMp4ConvertProjection,
  isBuiltInBufferedMp4MuxDriverId,
  packetTablePresentationSpanSec,
  projectedBufferedMp4OutputBytes,
} from './buffered-mp4-convert.ts';

describe('buffer-all MP4/MOV convert projection', () => {
  it('rejects the 03 long-form plan without excluding the previously passing 02 plan', () => {
    const plannedBitrates = [18_432_000, 128_000];
    const passing02 = projectedBufferedMp4OutputBytes(610.248, plannedBitrates);
    const failing03 = projectedBufferedMp4OutputBytes(1697.261, plannedBitrates);

    expect(passing02).toBe(1_482_884_224);
    expect(passing02 as number).toBeLessThan(SAFE_SINGLE_ARRAY_BUFFER_BYTES);
    expect(() =>
      assertBufferedMp4ConvertProjection('mp4', 'mp4', 610.248, plannedBitrates),
    ).not.toThrow();
    expect(failing03).toBe(4_004_754_384);
    expect(failing03 as number).toBeGreaterThan(SAFE_SINGLE_ARRAY_BUFFER_BYTES);
    expect(() =>
      assertBufferedMp4ConvertProjection('mp4', 'mp4', 1697.261, plannedBitrates),
    ).toThrowError(CapabilityError);
  });

  it('accepts the exact structural boundary and rejects one projected byte beyond it', () => {
    const oneBytePerSecondBitrate = 8;
    expect(
      projectedBufferedMp4OutputBytes(BUFFERED_MP4_CONVERT_MAX_PROJECTED_PAYLOAD_BYTES, [
        oneBytePerSecondBitrate,
      ]),
    ).toBe(SAFE_SINGLE_ARRAY_BUFFER_BYTES);
    expect(() =>
      assertBufferedMp4ConvertProjection(
        'mov',
        'mp4',
        BUFFERED_MP4_CONVERT_MAX_PROJECTED_PAYLOAD_BYTES,
        [oneBytePerSecondBitrate],
      ),
    ).not.toThrow();

    let failure: unknown;
    try {
      assertBufferedMp4ConvertProjection(
        'mov',
        'mp4',
        BUFFERED_MP4_CONVERT_MAX_PROJECTED_PAYLOAD_BYTES + 1,
        [oneBytePerSecondBitrate],
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CapabilityError);
    expect(failure).toMatchObject({
      code: 'capability-miss',
      detail: {
        op: {
          kind: 'route',
          id: 'buffered-mp4-convert-projection',
          facts: { maximumProjectedOutputBytes: SAFE_SINGLE_ARRAY_BUFFER_BYTES },
        },
      },
    });
  });

  it('leaves unknown duration/rate evidence to the authoritative runtime retention cap', () => {
    expect(projectedBufferedMp4OutputBytes(undefined, [18_432_000])).toBeUndefined();
    expect(projectedBufferedMp4OutputBytes(1697.261, [])).toBeUndefined();
    expect(() =>
      assertBufferedMp4ConvertProjection('mp4', 'mp4', undefined, [18_432_000]),
    ).not.toThrow();
  });

  it('recognizes both exact first-party buffered MP4 driver ids without guessing by format', () => {
    expect(isBuiltInBufferedMp4MuxDriverId('mp4')).toBe(true);
    expect(isBuiltInBufferedMp4MuxDriverId('mp4-mux')).toBe(true);
    expect(isBuiltInBufferedMp4MuxDriverId('custom-mp4')).toBe(false);
  });

  it('turns a finite planned-bitrate sum overflow into a rejecting projection', () => {
    expect(projectedBufferedMp4OutputBytes(1, [Number.MAX_VALUE, Number.MAX_VALUE])).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(() =>
      assertBufferedMp4ConvertProjection('mp4', 'mp4-mux', 1, [Number.MAX_VALUE, Number.MAX_VALUE]),
    ).toThrowError(CapabilityError);
  });

  it('uses selected packet presentation span independently of a huge common timestamp origin', () => {
    const packets = [
      {
        trackId: 3,
        sizeBytes: 100,
        ptsUs: 2_243_657_254_000,
        dtsUs: 2_243_657_254_000,
        durationUs: 33_000,
        keyframe: true,
      },
      {
        trackId: 4,
        sizeBytes: 20,
        ptsUs: 2_243_657_244_000,
        dtsUs: 2_243_657_244_000,
        durationUs: 23_000,
        keyframe: true,
      },
      {
        trackId: 3,
        sizeBytes: 100,
        ptsUs: 2_243_664_987_000,
        dtsUs: 2_243_664_987_000,
        durationUs: 33_000,
        keyframe: false,
      },
      {
        trackId: 4,
        sizeBytes: 20,
        ptsUs: 2_243_664_849_000,
        dtsUs: 2_243_664_849_000,
        durationUs: 23_000,
        keyframe: false,
      },
    ];
    expect(packetTablePresentationSpanSec(packets, [3, 4])).toBe(7.776);

    const shifted = packets.map((packet) => ({
      ...packet,
      ptsUs: packet.ptsUs - 2_243_657_244_000,
      dtsUs: packet.dtsUs - 2_243_657_244_000,
    }));
    expect(packetTablePresentationSpanSec(shifted, [3, 4])).toBe(7.776);
  });

  it('retains real inter-track offsets and falls back when one selected track has no valid packet', () => {
    const packets = [
      {
        trackId: 1,
        sizeBytes: 10,
        ptsUs: 10_000_000,
        dtsUs: 10_000_000,
        durationUs: 1_000_000,
        keyframe: true,
      },
      {
        trackId: 2,
        sizeBytes: 10,
        ptsUs: 12_000_000,
        dtsUs: 12_000_000,
        durationUs: 2_000_000,
        keyframe: true,
      },
    ];
    expect(packetTablePresentationSpanSec(packets, [1, 2])).toBe(4);
    expect(packetTablePresentationSpanSec(packets, [1, 3])).toBeUndefined();
    expect(packetTablePresentationSpanSec(undefined, [1])).toBeUndefined();
    expect(packetTablePresentationSpanSec(packets, [])).toBeUndefined();
  });
});
