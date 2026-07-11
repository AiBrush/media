import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmRuntimeProfile } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import {
  requireIsolatedWasmProfile,
  resolveWasmAssetUrl,
  wasmInitForProfile,
} from './wasm-loader-runtime.ts';
import { normalizeWasmAssetBaseUrl, resolveWasmRuntimeProfile } from './wasm-runtime.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveWasmRuntimeProfile', () => {
  it('keeps the common path baseline when the page is not cross-origin isolated', () => {
    const profile = resolveWasmRuntimeProfile({
      enableThreads: true,
      crossOriginIsolated: false,
      sharedArrayBuffer: true,
    });

    expect(profile.kind).toBe('baseline');
    expect(profile.threads).toBe(false);
    expect(profile.sharedArrayBuffer).toBe(false);
    expect(profile.reason).toMatch(/crossOriginIsolated/);
  });

  it('does not treat SharedArrayBuffer alone as thread eligibility', () => {
    const profile = resolveWasmRuntimeProfile({
      crossOriginIsolated: false,
      sharedArrayBuffer: true,
    });

    expect(profile.kind).toBe('baseline');
    expect(profile.threads).toBe(false);
  });

  it('selects the isolated SIMD+threads profile only when isolation and SAB are both available', () => {
    const profile = resolveWasmRuntimeProfile({
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
    });

    expect(profile).toEqual({
      kind: 'isolated-simd-threads',
      simd: true,
      threads: true,
      sharedArrayBuffer: true,
    });
  });

  it('falls back to baseline when isolation is present but SharedArrayBuffer is unavailable', () => {
    const profile = resolveWasmRuntimeProfile({
      enableThreads: true,
      crossOriginIsolated: true,
      sharedArrayBuffer: false,
    });

    expect(profile.kind).toBe('baseline');
    expect(profile.threads).toBe(false);
    expect(profile.reason).toMatch(/SharedArrayBuffer/);
  });

  it('can resolve from the current runtime globals when overrides are omitted', () => {
    const profile = resolveWasmRuntimeProfile();

    expect(profile.kind === 'baseline' || profile.kind === 'isolated-simd-threads').toBe(true);
    expect(typeof profile.sharedArrayBuffer).toBe('boolean');
  });

  it('honors an explicit threads-off request even in an isolated page', () => {
    const profile = resolveWasmRuntimeProfile({
      enableThreads: false,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
    });

    expect(profile.kind).toBe('baseline');
    expect(profile.threads).toBe(false);
    expect(profile.reason).toMatch(/disabled/);
  });
});

describe('requireIsolatedWasmProfile', () => {
  it('raises a typed capability miss when a threaded-only wasm core is requested outside isolation', () => {
    expect(() =>
      requireIsolatedWasmProfile({
        enableThreads: true,
        crossOriginIsolated: false,
        sharedArrayBuffer: true,
      }),
    ).toThrow(CapabilityError);
  });

  it('returns the isolated profile when threaded wasm can safely use SharedArrayBuffer', () => {
    const profile = requireIsolatedWasmProfile({
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
    });

    expect(profile.kind).toBe('isolated-simd-threads');
  });
});

describe('wasmInitForProfile', () => {
  it('keeps the wasm-bindgen init shape and does not add eager thread state', () => {
    const url = new URL('file:///tmp/core.wasm');
    const init = wasmInitForProfile(url, {
      kind: 'isolated-simd-threads',
      simd: true,
      threads: true,
      sharedArrayBuffer: true,
    });

    expect(init).toEqual({ module_or_path: url });
  });

  it('raises a typed capability miss for an unknown runtime profile kind', () => {
    const url = new URL('file:///tmp/core.wasm');
    const unknown = {
      kind: 'future-wasm-profile',
      simd: false,
      threads: false,
      sharedArrayBuffer: false,
    } as unknown as WasmRuntimeProfile;

    expect(() => wasmInitForProfile(url, unknown)).toThrow(CapabilityError);
  });
});

describe('WASM asset URL controls', () => {
  it('preserves import.meta-relative resolution byte-for-byte when no override exists', () => {
    const moduleUrl = new URL('https://app.example/assets/driver-abc.js');
    const defaultUrl = new URL('./core_bg.wasm', moduleUrl);
    const resolved = resolveWasmAssetUrl('./core_bg.wasm', defaultUrl);
    expect(resolved).toBe(defaultUrl);
    expect(resolved.href).toBe('https://app.example/assets/core_bg.wasm');
  });

  it('normalizes a same-origin browser override to an absolute directory and resolves assets beneath it', () => {
    vi.stubGlobal('location', new URL('https://app.example/player/index.html'));
    const root = normalizeWasmAssetBaseUrl('../media/cores?stale=1#fragment');

    expect(root).toBe('https://app.example/media/cores/');
    expect(
      resolveWasmAssetUrl(
        './aac_wasm_bg.wasm',
        new URL('https://app.example/chunks/aac_wasm_bg.wasm'),
        root,
      ).href,
    ).toBe('https://app.example/media/cores/aac_wasm_bg.wasm');
  });

  it.each([
    'https://cdn.example/cores/',
    'https://user:secret@app.example/cores/',
    'data:text/plain,not-an-asset-root',
  ])('rejects an unsafe browser asset override before any fetch: %s', (value) => {
    vi.stubGlobal('location', new URL('https://app.example/player/index.html'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(() => normalizeWasmAssetBaseUrl(value)).toThrow(InputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps a non-string JavaScript override to a typed input error', () => {
    expect(() => normalizeWasmAssetBaseUrl(null as unknown as string)).toThrow(InputError);
  });

  it('allows an absolute file directory only in a Node/file context', () => {
    vi.stubGlobal('location', undefined);
    expect(normalizeWasmAssetBaseUrl('file:///tmp/aibrush-cores')).toBe(
      'file:///tmp/aibrush-cores/',
    );
  });
});
