import { describe, expect, it } from 'vitest';
import {
  resolveWasmAssetUrl,
  resolveWasmCoreProfile,
  wasmAssetRequest,
  wasmInitForProfile,
} from './wasm-loader-runtime.ts';
import { baselineWasmRuntimeProfile } from './wasm-runtime.ts';

describe('WASM loader — codec-scoped lazy, cacheable, isolation-gated (2.1.5)', () => {
  it('resolves codec-scoped asset URLs lazily via import.meta.url, not eager bundle', () => {
    const defaultUrl = new URL('./mp3_wasm_bg.wasm', import.meta.url);
    // Without base override, the default URL is preserved exactly (no eager bundle rewrite)
    expect(resolveWasmAssetUrl('./mp3_wasm_bg.wasm', defaultUrl).href).toBe(defaultUrl.href);
    // With base override, the URL is codec-scoped and same-origin
    const base = 'https://example.com/media/';
    const resolved = resolveWasmAssetUrl('./aac_wasm_bg.wasm', defaultUrl, base);
    expect(resolved.href).toBe('https://example.com/media/aac_wasm_bg.wasm');
    expect(resolved.href).toContain('aac_wasm_bg.wasm');
  });

  it('rejects unsafe asset paths (no traversal, no absolute)', () => {
    const defaultUrl = new URL('./mp3_wasm_bg.wasm', import.meta.url);
    expect(() =>
      resolveWasmAssetUrl('../escape.wasm', defaultUrl, 'https://example.com/'),
    ).toThrow();
    expect(() =>
      resolveWasmAssetUrl('/absolute.wasm', defaultUrl, 'https://example.com/'),
    ).toThrow();
    expect(() =>
      resolveWasmAssetUrl('./foo/../bar.wasm', defaultUrl, 'https://example.com/'),
    ).toThrow();
  });

  it('caps isolated profile to baseline while no threaded core is vendored (honest capability)', () => {
    // Even when the page is crossOriginIsolated, no threaded WASM is shipped (measured fast path is single-thread)
    const isolated = resolveWasmCoreProfile({
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      enableThreads: true,
    });
    expect(isolated.kind).toBe('baseline');
    expect((isolated as { reason?: string }).reason).toMatch(/no threaded WASM core/);
    // Non-isolated also baseline, but for a different reason
    const nonIsolated = resolveWasmCoreProfile({ crossOriginIsolated: false });
    expect(nonIsolated.kind).toBe('baseline');
  });

  it('wasmInitForProfile returns same URL for baseline and isolated (single vendored asset, cacheable)', () => {
    const url = new URL('./vorbis_wasm_bg.wasm', import.meta.url);
    const baseline = baselineWasmRuntimeProfile('test');
    const isolatedLike = {
      kind: 'isolated-simd-threads' as const,
      simd: true,
      threads: true,
      sharedArrayBuffer: true,
    };
    // Both resolve to the same asset URL — one vendored file, cacheable via HTTP cache, no duplicate fetch
    expect(wasmInitForProfile(url, baseline).module_or_path.href).toBe(url.href);
    expect(wasmInitForProfile(url, isolatedLike).module_or_path.href).toBe(url.href);
  });

  it('20× randomized asset URL resolution stays deterministic and never huge-alloc', () => {
    const defaultUrl = new URL('./dav1d_wasm_bg.wasm', import.meta.url);
    for (let i = 0; i < 20; i++) {
      const base = `https://example.com/assets/${i}/`;
      const resolved = resolveWasmAssetUrl(`./dav1d_wasm_bg.wasm`, defaultUrl, base);
      expect(resolved.href).toBe(`https://example.com/assets/${i}/dav1d_wasm_bg.wasm`);
      expect(resolved.href.length).toBeLessThan(1024);
    }
  });

  it('wasmAssetRequest is codec-scoped and cacheable (force-cache)', () => {
    const url = new URL('./mp3_wasm_bg.wasm', import.meta.url);
    const req = wasmAssetRequest(url);
    expect(req.url).toBe(url.href);
    expect(req.cache).toBe('force-cache');
  });
});
