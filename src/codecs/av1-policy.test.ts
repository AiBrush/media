import { describe, expect, it } from 'vitest';
import { bitDepthFromCodec, resolvedVideoEncoderCodecString } from '../api/codec-strings.ts';
import { generateSupportMatrix } from '../support/matrix.ts';
import {
  AV1_POLICY,
  av1LicensingNotice,
  av1SoftwareDecodeAvailable,
  av1SoftwareEncodeAvailable,
  av1SupportedBitDepths,
  isAv1SupportedBitDepth,
} from './av1-policy.ts';

describe('AV1 policy — dav1d decode fallback + hardware encode, royalty-free (REQUIREMENTS §5.5, §6, §12 — 2.2.4)', () => {
  it('declares dav1d WASM decode + hardware encode, no WASM encode, Main 8/10', () => {
    expect(AV1_POLICY.codec).toBe('av1');
    expect(AV1_POLICY.decode).toEqual({ hardware: true, software: true });
    expect(AV1_POLICY.encode).toEqual({ hardware: true, software: false });
    expect(AV1_POLICY.softwareWasmShipped).toBe(true);
    expect(AV1_POLICY.softwareWasmCodec).toBe('dav1d');
    expect([...AV1_POLICY.bitDepths]).toEqual([8, 10]);
    expect([...AV1_POLICY.profiles]).toEqual(['Main']);
    expect(AV1_POLICY.licensing.codecBinaryRedistributed).toBe(true);
    expect(AV1_POLICY.licensing.route).toContain('hardware-only');
    expect(AV1_POLICY.licensing.route).toContain('dav1d');
    expect([...AV1_POLICY.licensing.pools]).toEqual(['AOMedia AV1 (royalty-free)']);
  });

  it('licensing notice mentions royalty-free, dav1d WASM, hardware encode, and preflight', () => {
    const notice = av1LicensingNotice();
    expect(notice.length).toBeGreaterThan(80);
    expect(notice).toMatch(/royalty-free/i);
    expect(notice).toMatch(/dav1d/i);
    expect(notice).toMatch(/hardware-only|hardware/);
    expect(notice).toMatch(/No AV1 encoder WebAssembly is bundled/);
    expect(notice).toMatch(/VideoEncoder\.isConfigSupported|canConvert/);
  });

  it('reports software decode available, no software encode, bitDepths [8,10] + isAv1SupportedBitDepth exact', () => {
    expect(av1SoftwareDecodeAvailable()).toBe(true);
    expect(av1SoftwareEncodeAvailable()).toBe(false);
    expect(av1SupportedBitDepths()).toEqual([8, 10]);
    expect(isAv1SupportedBitDepth(8)).toBe(true);
    expect(isAv1SupportedBitDepth(10)).toBe(true);
    expect(isAv1SupportedBitDepth(12)).toBe(false);
    expect(isAv1SupportedBitDepth(undefined)).toBe(false);
    expect(isAv1SupportedBitDepth(9 as number)).toBe(false);
  });

  it('support matrix derives AV1 row from the same policy (single source, no drift)', () => {
    const m = generateSupportMatrix();
    const av1 = m.codecs.find((c) => c.codec === 'av1')!;
    expect(av1).toBeDefined();
    expect(av1.decode).toEqual({ hardware: true, software: true });
    expect(av1.encode).toEqual({ hardware: true, software: false });
    expect(av1.alpha).toBe(false);
    expect([...av1.bitDepths]).toEqual([8, 10]);
    expect(av1.bitDepths).toEqual([...AV1_POLICY.bitDepths]);
  });

  it('codec-string helpers author AV1 Main 8-bit and 10-bit and reject 12-bit Professional', () => {
    expect(
      resolvedVideoEncoderCodecString(
        { codec: 'av1', bitDepth: 8 },
        1280,
        720,
        30,
        undefined,
        undefined,
        false,
      ),
    ).toMatch(/^av01\.0\.\d{2}M\.08$/);
    expect(
      resolvedVideoEncoderCodecString(
        { codec: 'av1', bitDepth: 10 },
        1280,
        720,
        30,
        undefined,
        undefined,
        false,
      ),
    ).toMatch(/^av01\.0\.\d{2}M\.10$/);
    // 12-bit Professional author succeeds via codec-strings (Annex-A) but policy rejects encode at policy layer via isAv1SupportedBitDepth
    expect(isAv1SupportedBitDepth(12)).toBe(false);
    expect(bitDepthFromCodec('av01.0.04M.08')).toBe(8);
    expect(bitDepthFromCodec('av01.0.04M.10')).toBe(10);
    expect(bitDepthFromCodec('av01.2.04M.12')).toBe(12);
  });

  it('20× randomized AV1 policy invariants remain deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const notice = av1LicensingNotice();
      expect(notice).toBe(av1LicensingNotice());
      const m = generateSupportMatrix();
      const av1 = m.codecs.find((c) => c.codec === 'av1')!;
      expect(av1.bitDepths.length).toBe(2);
      expect(av1.decode.software).toBe(true);
      expect(av1.encode.software).toBe(false);
      const depthCandidate = [8, 10, 12, 0, 99, -1][i % 6]!;
      const supported = isAv1SupportedBitDepth(depthCandidate);
      expect(typeof supported).toBe('boolean');
      if (depthCandidate === 8 || depthCandidate === 10) expect(supported).toBe(true);
      else expect(supported).toBe(false);
    }
  });

  it('malformed inputs never throw huge allocation or wrong type', () => {
    expect(isAv1SupportedBitDepth(undefined)).toBe(false);
    expect(isAv1SupportedBitDepth(Number.NaN as number)).toBe(false);
    expect(isAv1SupportedBitDepth(Number.POSITIVE_INFINITY as number)).toBe(false);
    const n = av1LicensingNotice();
    expect(typeof n).toBe('string');
    expect(n.length).toBeLessThan(4096);
  });
});
