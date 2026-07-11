import type { WasmRuntimeProfile } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';

export interface WasmRuntimeRequest {
  /** `undefined` follows ADR-006: threads are enabled by default only in an isolated page. */
  enableThreads?: boolean;
  /** Testable override for `globalThis.crossOriginIsolated`. */
  crossOriginIsolated?: boolean;
  /** Testable override for `typeof SharedArrayBuffer === 'function'`. */
  sharedArrayBuffer?: boolean;
}

/**
 * Normalize the public asset override once, before a pipeline or worker can consume media. Browser roots
 * are same-origin HTTP(S) directories with no embedded credentials; `file:` is accepted only in Node or
 * an actual file-page context for deterministic local tests. Query/hash components cannot safely apply to
 * multiple sibling assets and are removed. The returned string is structured-clone safe for workers.
 */
export function normalizeWasmAssetBaseUrl(value: string): string {
  if (typeof value !== 'string') throw invalidAssetBase('assetBaseUrl must be a string');
  const raw = value.trim();
  if (raw === '') throw invalidAssetBase('assetBaseUrl must not be empty');
  const locationUrl = currentLocationUrl();
  const base = currentDocumentBaseUrl() ?? locationUrl ?? new URL(import.meta.url);
  let resolved: URL;
  try {
    resolved = new URL(raw, base);
  } catch {
    throw invalidAssetBase(`assetBaseUrl '${value}' is not a valid URL`);
  }
  if (resolved.username !== '' || resolved.password !== '') {
    throw invalidAssetBase('assetBaseUrl must not contain URL credentials');
  }

  if (locationUrl !== undefined) {
    if (locationUrl.protocol === 'http:' || locationUrl.protocol === 'https:') {
      if (
        (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
        resolved.origin !== locationUrl.origin
      ) {
        throw invalidAssetBase('assetBaseUrl must be same-origin HTTP(S)');
      }
    } else if (locationUrl.protocol === 'file:') {
      if (resolved.protocol !== 'file:') {
        throw invalidAssetBase('a file-page assetBaseUrl must use file:');
      }
    } else {
      throw invalidAssetBase(`assetBaseUrl is unavailable from a ${locationUrl.protocol} page`);
    }
  } else if (
    resolved.protocol !== 'file:' &&
    resolved.protocol !== 'http:' &&
    resolved.protocol !== 'https:'
  ) {
    throw invalidAssetBase('assetBaseUrl must use file:, http:, or https: in this runtime');
  }

  if (!resolved.pathname.endsWith('/')) resolved.pathname += '/';
  resolved.search = '';
  resolved.hash = '';
  return resolved.href;
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

function currentLocationUrl(): URL | undefined {
  const candidate = globalThis as typeof globalThis & { location?: { href?: unknown } };
  return parseRuntimeUrl(candidate.location?.href);
}

function currentDocumentBaseUrl(): URL | undefined {
  const candidate = globalThis as typeof globalThis & { document?: { baseURI?: unknown } };
  return parseRuntimeUrl(candidate.document?.baseURI);
}

function parseRuntimeUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function invalidAssetBase(message: string): InputError {
  return new InputError('unsupported-input', message, { field: 'assetBaseUrl' });
}
