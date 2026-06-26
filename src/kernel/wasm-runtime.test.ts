import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import {
  requireIsolatedWasmProfile,
  resolveWasmRuntimeProfile,
  wasmInitForProfile,
} from './wasm-runtime.ts';

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
});
