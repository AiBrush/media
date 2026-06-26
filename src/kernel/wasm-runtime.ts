import type { WasmRuntimeProfile, WasmRuntimeProfileKind } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';

export interface WasmRuntimeRequest {
  /** `undefined` follows ADR-006: threads are enabled by default only in an isolated page. */
  enableThreads?: boolean;
  /** Testable override for `globalThis.crossOriginIsolated`. */
  crossOriginIsolated?: boolean;
  /** Testable override for `typeof SharedArrayBuffer === 'function'`. */
  sharedArrayBuffer?: boolean;
}

export interface WasmBindgenInit {
  module_or_path: URL;
}

/**
 * Resolve the WASM execution profile without touching any `.wasm` asset. The isolated SIMD+threads profile
 * is available only when both cross-origin isolation and `SharedArrayBuffer` are present; otherwise the
 * common path stays single-threaded and requires no COOP/COEP.
 */
export function resolveWasmRuntimeProfile(req: WasmRuntimeRequest = {}): WasmRuntimeProfile {
  const isolated = req.crossOriginIsolated ?? currentCrossOriginIsolation();
  const enableThreads = req.enableThreads ?? isolated;
  if (!enableThreads) {
    return baselineProfile('threads disabled by request');
  }
  if (!isolated) {
    return baselineProfile('crossOriginIsolated is false');
  }
  const hasSharedArrayBuffer = req.sharedArrayBuffer ?? currentSharedArrayBuffer();
  if (!hasSharedArrayBuffer) {
    return baselineProfile('SharedArrayBuffer is unavailable');
  }
  return {
    kind: 'isolated-simd-threads',
    simd: true,
    threads: true,
    sharedArrayBuffer: true,
  };
}

/**
 * Helper for drivers that ship a threaded-only core. Current first-party cores have baseline fallbacks, so
 * they call {@link resolveWasmRuntimeProfile}; a future threaded-only asset can call this and surface the
 * required isolation as a typed capability miss instead of accidentally touching `SharedArrayBuffer`.
 */
export function requireIsolatedWasmProfile(req: WasmRuntimeRequest = {}): WasmRuntimeProfile {
  const profile = resolveWasmRuntimeProfile(req);
  if (profile.kind === 'isolated-simd-threads') return profile;
  throw new CapabilityError(
    'capability-miss',
    'WASM SIMD+threads requires crossOriginIsolated and SharedArrayBuffer',
    {
      op: 'wasm-runtime',
      tried: [profile.kind],
      suggestion: 'serve the page with COOP/COEP or disable threaded WASM',
    },
  );
}

/**
 * Keep the wasm-bindgen init payload narrow and asset-only. The profile is intentionally resolved before
 * this call, but the current vendored cores use the same baseline artifact unless a driver explicitly
 * ships a second threaded asset; no `SharedArrayBuffer` is allocated here.
 */
export function wasmInitForProfile(
  moduleUrl: URL,
  profile: WasmRuntimeProfile = resolveWasmRuntimeProfile(),
): WasmBindgenInit {
  switch (profile.kind) {
    case 'baseline':
    case 'isolated-simd-threads':
      return { module_or_path: moduleUrl };
    default:
      return exhaustiveProfile(profile.kind);
  }
}

function baselineProfile(reason: string): WasmRuntimeProfile {
  return {
    kind: 'baseline',
    simd: false,
    threads: false,
    sharedArrayBuffer: false,
    reason,
  };
}

function currentCrossOriginIsolation(): boolean {
  const candidate = globalThis as typeof globalThis & { crossOriginIsolated?: unknown };
  return candidate.crossOriginIsolated === true;
}

function currentSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer === 'function';
}

function exhaustiveProfile(kind: never): never {
  throw new CapabilityError('capability-miss', `unknown WASM runtime profile '${kind}'`, {
    op: 'wasm-runtime',
    tried: [kind as WasmRuntimeProfileKind],
  });
}
