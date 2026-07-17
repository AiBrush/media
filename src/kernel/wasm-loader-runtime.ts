import type { WasmRuntimeProfile, WasmRuntimeProfileKind } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import {
  type WasmRuntimeRequest,
  baselineWasmRuntimeProfile,
  resolveWasmRuntimeProfile,
} from './wasm-runtime.ts';

export interface WasmBindgenInit {
  module_or_path: URL;
}

/**
 * Resolve the profile a WASM **core asset** is actually instantiated under (doc 06 §3.2, punch-list 3,
 * option b). `resolveWasmRuntimeProfile` answers the *environment* question (may this page use
 * SAB-backed threads?); this caps that verdict at what is **vendored**: no threaded sibling core
 * (`*.threads.wasm`) exists — every shipped core is the single-thread build, the measured fast path (no
 * benchmark winner anywhere used WASM threads) — so an isolated environment still loads, honestly, as
 * `baseline`. The engine therefore never *advertises* a threaded capability it cannot run (Prime
 * Directive 6); a future threaded-only core gates on {@link requireIsolatedWasmProfile} instead. When a
 * threaded core is vendored, this function is the single seam that starts returning the isolated profile.
 */
export function resolveWasmCoreProfile(req: WasmRuntimeRequest = {}): WasmRuntimeProfile {
  const profile = resolveWasmRuntimeProfile(req);
  return profile.kind === 'isolated-simd-threads'
    ? baselineWasmRuntimeProfile('no threaded WASM core is vendored (single-thread cores are the measured fast path)')
    : profile;
}

/** Resolve one statically named core. With no override this preserves the import-meta URL object exactly. */
export function resolveWasmAssetUrl(
  assetPath: string,
  defaultUrl: URL,
  normalizedBaseUrl?: string,
): URL {
  if (normalizedBaseUrl === undefined) return defaultUrl;
  const relative = assetPath.startsWith('./') ? assetPath.slice(2) : assetPath;
  if (relative === '' || relative.startsWith('/') || relative.split('/').includes('..')) {
    throw new InputError(`unsafe WASM asset path '${assetPath}'`, {
      field: 'assetBaseUrl',
    });
  }
  return new URL(relative, normalizedBaseUrl);
}

/** Raise a typed miss for a future threaded-only core when isolation is unavailable. */
export function requireIsolatedWasmProfile(req: WasmRuntimeRequest = {}): WasmRuntimeProfile {
  const profile = resolveWasmRuntimeProfile(req);
  if (profile.kind === 'isolated-simd-threads') return profile;
  throw new CapabilityError(
    'WASM SIMD+threads requires crossOriginIsolated and SharedArrayBuffer',
    {
      op: { kind: 'route', id: 'wasm-runtime' },
      tried: [profile.kind],
      suggestion: 'serve the page with COOP/COEP or disable threaded WASM',
    },
  );
}

/**
 * Build the narrow wasm-bindgen init payload after the runtime profile and asset URL are resolved. The
 * default profile is the **core** resolution ({@link resolveWasmCoreProfile}) — capped at the vendored
 * single-thread asset, so an isolated page never claims a threaded load that does not exist. An
 * explicitly passed `isolated-simd-threads` profile (a caller that resolved the raw environment) is
 * served the same single vendored asset: exactly one core build exists per codec, and pretending a
 * distinct threaded asset would be a fake (punch-list 3b).
 */
export function wasmInitForProfile(
  moduleUrl: URL,
  profile: WasmRuntimeProfile = resolveWasmCoreProfile(),
): WasmBindgenInit {
  switch (profile.kind) {
    case 'baseline':
    case 'isolated-simd-threads':
      return { module_or_path: moduleUrl };
    default:
      return exhaustiveProfile(profile.kind);
  }
}

function exhaustiveProfile(kind: never): never {
  throw new CapabilityError(`unknown WASM runtime profile '${kind}'`, {
    op: { kind: 'route', id: 'wasm-runtime' },
    tried: [kind as WasmRuntimeProfileKind],
  });
}
