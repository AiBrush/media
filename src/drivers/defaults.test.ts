import { describe, expect, it } from 'vitest';
import { Registry } from '../kernel/registry.ts';
import { registerDefaultDrivers } from './defaults.ts';

describe('registerDefaultDrivers', () => {
  it('registers image support on the default registry host', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const images = reg.imageOps();
    expect(images).toBeDefined();
    expect(images?.sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'png',
    );
  });

  it('registers the real software video-decode wasm tails (AV1/VPx) now that their cores are vendored', () => {
    // AV1 (dav1d, ADR-093) and VP8/VP9 (ogv.js libvpx, ADR-094) ship vendored prebuilt cores and are
    // registered as miss-only fallbacks — they are no longer core-less scaffolds. They still `supports()`
    // →false in Node (no WebCodecs `VideoFrame` seam); registration just makes the tail available so a
    // browser WebCodecs miss can lazy-load the wasm.
    const reg = new Registry();
    registerDefaultDrivers(reg);

    const ids = reg.codecs().map((d) => d.id);
    expect(ids).toContain('wasm-av1');
    expect(ids).toContain('wasm-vpx');
  });
});
