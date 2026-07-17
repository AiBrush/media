import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmRuntimeProfile } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import {
  requireIsolatedWasmProfile,
  resolveWasmAssetUrl,
  resolveWasmCoreProfile,
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

describe('resolveWasmCoreProfile — no core ever resolves to isolated-simd-threads (punch-list 3b)', () => {
  it('caps a fully-isolated environment verdict at baseline while no threaded core is vendored', () => {
    // The ENVIRONMENT honestly supports threads… (resolveWasmRuntimeProfile says so)
    const env = resolveWasmRuntimeProfile({
      enableThreads: true,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
    });
    expect(env.kind).toBe('isolated-simd-threads');
    // …but the CORE resolution never claims it: exactly one single-thread core build is vendored per
    // codec, so advertising a threaded capability would be a fake (Prime Directive 6).
    const core = resolveWasmCoreProfile({
      enableThreads: true,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
    });
    expect(core.kind).toBe('baseline');
    expect(core.threads).toBe(false);
    expect(core.simd).toBe(false);
    expect(core.reason).toMatch(/no threaded WASM core/i);
  });

  it('passes a non-isolated verdict through untouched (reason preserved)', () => {
    const core = resolveWasmCoreProfile({
      enableThreads: true,
      crossOriginIsolated: false,
      sharedArrayBuffer: true,
    });
    expect(core.kind).toBe('baseline');
    expect(core.reason).toMatch(/crossOriginIsolated/);
  });

  it('drives wasmInitForProfile by default: an isolated page still loads the baseline asset honestly', () => {
    // Pin an isolated-looking global environment; the DEFAULT profile of wasmInitForProfile must be the
    // capped core resolution, so no registered core is ever initialized under a threaded claim.
    vi.stubGlobal('crossOriginIsolated', true);
    const url = new URL('file:///tmp/core.wasm');
    expect(wasmInitForProfile(url)).toEqual({ module_or_path: url });
    expect(resolveWasmCoreProfile().kind).toBe('baseline');
  });

  it('a future threaded-only core declines with a typed CapabilityError, never a silent wrong claim', () => {
    // The one sanctioned path to a threaded profile is requireIsolatedWasmProfile — outside isolation it
    // raises the typed miss (already covered above); WITH isolation it resolves, and the loader still
    // serves the single vendored asset for BOTH kinds (no distinct `*.threads.wasm` sibling exists).
    const isolated = requireIsolatedWasmProfile({
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
    });
    const url = new URL('file:///tmp/core.wasm');
    const viaIsolated = wasmInitForProfile(url, isolated);
    const viaBaseline = wasmInitForProfile(url, resolveWasmCoreProfile());
    expect(viaIsolated.module_or_path.href).toBe(viaBaseline.module_or_path.href);
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
