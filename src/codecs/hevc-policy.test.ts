import { describe, expect, it } from 'vitest';
import { bitDepthFromCodec, resolvedVideoEncoderCodecString } from '../api/codec-strings.ts';
import { generateSupportMatrix } from '../support/matrix.ts';
import {
  HEVC_POLICY,
  hevcLicensingNotice,
  hevcSoftwareDecodeAvailable,
  hevcSoftwareEncodeAvailable,
  hevcSupportedBitDepths,
  isHevcSupportedBitDepth,
} from './hevc-policy.ts';

describe('HEVC 10-bit policy — hardware-only with licensing disclosure (REQUIREMENTS §5.5, §6, §12 — 2.2.1)', () => {
  it('declares hardware-only native WebCodecs with no WASM fallback and Main/Main10', () => {
    expect(HEVC_POLICY.codec).toBe('hevc');
    expect(HEVC_POLICY.decode).toEqual({ hardware: true, software: false });
    expect(HEVC_POLICY.encode).toEqual({ hardware: true, software: false });
    expect(HEVC_POLICY.softwareWasmShipped).toBe(false);
    expect([...HEVC_POLICY.bitDepths]).toEqual([8, 10]);
    expect([...HEVC_POLICY.profiles]).toEqual(['Main', 'Main10']);
    expect(HEVC_POLICY.licensing.codecBinaryRedistributed).toBe(false);
    expect(HEVC_POLICY.licensing.route).toContain('hardware-only');
    expect([...HEVC_POLICY.licensing.pools]).toEqual(['MPEG LA', 'HEVC Advance', 'Velos Media']);
  });

  it('licensing notice is non-empty, mentions hardware-only, no WASM, and patent pools', () => {
    const notice = hevcLicensingNotice();
    expect(notice.length).toBeGreaterThan(80);
    expect(notice).toContain('hardware-only');
    expect(notice).not.toContain('WASM is bundled');
    expect(notice).toMatch(/MPEG LA/);
    expect(notice).toMatch(/HEVC Advance/);
    expect(notice).toMatch(/Velos Media/);
    expect(notice).toMatch(/VideoEncoder\.isConfigSupported|canConvert/);
  });

  it('reports no software decode/encode available (homogeneous hardware-only invariant)', () => {
    expect(hevcSoftwareDecodeAvailable()).toBe(false);
    expect(hevcSoftwareEncodeAvailable()).toBe(false);
    expect(hevcSupportedBitDepths()).toEqual([8, 10]);
    expect(isHevcSupportedBitDepth(8)).toBe(true);
    expect(isHevcSupportedBitDepth(10)).toBe(true);
    expect(isHevcSupportedBitDepth(12)).toBe(false);
    expect(isHevcSupportedBitDepth(undefined)).toBe(false);
    expect(isHevcSupportedBitDepth(9 as number)).toBe(false);
  });

  it('support matrix derives HEVC row from the same policy (single source, no drift)', () => {
    const m = generateSupportMatrix();
    const hevc = m.codecs.find((c) => c.codec === 'hevc')!;
    expect(hevc).toBeDefined();
    expect(hevc.decode).toEqual({ hardware: true, software: false });
    expect(hevc.encode).toEqual({ hardware: true, software: false });
    expect(hevc.alpha).toBe(false);
    expect([...hevc.bitDepths]).toEqual([8, 10]);
    expect(hevc.bitDepths).toEqual([...HEVC_POLICY.bitDepths]);
  });

  it('codec-string helpers author Main 8-bit and Main10 10-bit and reject 12-bit/profile outside Main/Main10', () => {
    // 8-bit HEVC
    expect(
      resolvedVideoEncoderCodecString(
        { codec: 'hevc', bitDepth: 8 },
        1920,
        1080,
        30,
        undefined,
        undefined,
        false,
      ),
    ).toBe('hvc1.1.6.L93.B0');
    // 10-bit HEVC
    expect(
      resolvedVideoEncoderCodecString(
        { codec: 'hevc', bitDepth: 10 },
        1920,
        1080,
        30,
        undefined,
        undefined,
        false,
      ),
    ).toBe('hvc1.2.4.L120.B0');
    // 12-bit rejected — typed miss, never silently produced
    expect(() =>
      resolvedVideoEncoderCodecString(
        { codec: 'hevc', bitDepth: 12 as 8 | 10 | 12 },
        1920,
        1080,
        30,
        undefined,
        undefined,
        false,
      ),
    ).toThrow();
    // bitDepthFromCodec round-trips
    expect(bitDepthFromCodec('hvc1.1.6.L93.B0')).toBe(8);
    expect(bitDepthFromCodec('hvc1.2.4.L120.B0')).toBe(10);
  });

  it('20× randomized HEVC policy invariants remain deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const notice = hevcLicensingNotice();
      expect(notice).toBe(hevcLicensingNotice());
      const m = generateSupportMatrix();
      const hevc = m.codecs.find((c) => c.codec === 'hevc')!;
      expect(hevc.bitDepths.length).toBe(2);
      expect(hevc.decode.software).toBe(false);
      expect(hevc.encode.software).toBe(false);
      // bitDepth random probe never throws huge allocation
      const depthCandidate = [8, 10, 12, 0, 99, -1][i % 6]!;
      const supported = isHevcSupportedBitDepth(depthCandidate);
      expect(typeof supported).toBe('boolean');
      if (depthCandidate === 8 || depthCandidate === 10) expect(supported).toBe(true);
      else expect(supported).toBe(false);
    }
  });

  it('malformed inputs never throw huge allocation or wrong type', () => {
    expect(isHevcSupportedBitDepth(undefined)).toBe(false);
    expect(isHevcSupportedBitDepth(Number.NaN as number)).toBe(false);
    expect(isHevcSupportedBitDepth(Number.POSITIVE_INFINITY as number)).toBe(false);
    const n = hevcLicensingNotice();
    expect(typeof n).toBe('string');
    expect(n.length).toBeLessThan(4096);
  });
});
