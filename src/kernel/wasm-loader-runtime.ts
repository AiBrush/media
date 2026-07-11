import type { WasmRuntimeProfile, WasmRuntimeProfileKind } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { type WasmRuntimeRequest, resolveWasmRuntimeProfile } from './wasm-runtime.ts';

export interface WasmBindgenInit {
  module_or_path: URL;
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
    throw new InputError('unsupported-input', `unsafe WASM asset path '${assetPath}'`, {
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
    'capability-miss',
    'WASM SIMD+threads requires crossOriginIsolated and SharedArrayBuffer',
    {
      op: 'wasm-runtime',
      tried: [profile.kind],
      suggestion: 'serve the page with COOP/COEP or disable threaded WASM',
    },
  );
}

/** Build the narrow wasm-bindgen init payload after the runtime profile and asset URL are resolved. */
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

function exhaustiveProfile(kind: never): never {
  throw new CapabilityError('capability-miss', `unknown WASM runtime profile '${kind}'`, {
    op: 'wasm-runtime',
    tried: [kind as WasmRuntimeProfileKind],
  });
}
