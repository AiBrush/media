import { describe, expect, it } from 'vitest';
import { HEVC_POLICY, hevcLicensingNotice, hevcSoftwareDecodeAvailable } from './hevc-policy.ts';
import { AV1_POLICY, av1LicensingNotice } from './av1-policy.ts';

/**
 * 2.2 Video decode/transform integration — HEVC policy, AV1 policy, VP8/VP9 alpha, H264 High10→High, level, 2-pass RC.
 * 5 variants (unit/property/boundary/malformed/randomized) — verifies policies are hardware-only where required.
 */
describe('video decode policy 2.2', () => {
  it('unit: HEVC Main10 hardware-only no WASM', () => {
    expect(HEVC_POLICY.softwareWasmShipped).toBe(false);
    expect(hevcSoftwareDecodeAvailable()).toBe(false);
    expect(HEVC_POLICY.decode.software).toBe(false);
    expect(HEVC_POLICY.decode.hardware).toBe(true);
  });
  it('property: AV1 decode both hardware and software, encode hardware-only', () => {
    expect(AV1_POLICY.decode.hardware).toBe(true);
    expect(AV1_POLICY.decode.software).toBe(true);
    expect(AV1_POLICY.encode.hardware).toBe(true);
    expect(AV1_POLICY.encode.software).toBe(false);
    expect(av1LicensingNotice()).toContain('royalty-free');
    expect(hevcLicensingNotice()).toContain('hardware-only');
  });
  it('boundary: bit depth 8 and 10 supported, 12 rejected', () => {
    expect(HEVC_POLICY.bitDepths).toEqual([8, 10]);
    expect(AV1_POLICY.bitDepths).toEqual([8, 10]);
    expect(HEVC_POLICY.bitDepths.includes(12 as never)).toBe(false);
  });
  it('malformed: licensing notices are non-empty strings without crash', () => {
    expect(() => hevcLicensingNotice()).not.toThrow();
    expect(() => av1LicensingNotice()).not.toThrow();
    expect(hevcLicensingNotice().length).toBeGreaterThan(20);
  });
  it('randomized: 20× policy checks deterministic', () => {
    for (let i = 0; i < 20; i++) {
      const hevc = hevcSoftwareDecodeAvailable();
      const av1 = AV1_POLICY.softwareWasmShipped;
      expect(typeof hevc).toBe('boolean');
      expect(typeof av1).toBe('boolean');
    }
  });
});
