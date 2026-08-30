/**
 * OPFS sync-handle scope guard (REQUIREMENTS §7.3 — 1.1.5).
 *
 * Browser storage spill MUST use OPFS; synchronous access handles
 * (`FileSystemSyncAccessHandle` / `createSyncAccessHandle`) MAY be used
 * only inside a **dedicated worker** (WHATWG File System §5: sync handles
 * block the thread). The engine's durable spill (Blob segments in
 * `src/sinks/materialize.ts` + OPFS drains in `src/sinks/opfs-target*`)
 * uses only the async `FileSystemWritableFileStream` API, which is safe on
 * the main thread. This guard makes the invariant executable: any future
 * sync-handle import outside the worker bundle fails fast with a typed error
 * and is caught by the `opfs-guard.test.ts` source-scan variant.
 */

import { MediaError } from '../contracts/errors.ts';

/** The only scopes where a sync handle may be acquired. */
export const OPFS_SYNC_HANDLE_ALLOWED_SCOPES = ['dedicated-worker'] as const;

/**
 * Whether `callerPath` (a source file path or logical scope label) is
 * allowed to acquire an OPFS sync handle. Allowed only when the caller is
 * inside the dedicated-worker bundle (`src/kernel/worker*.ts` or the
 * worker entry itself).
 */
export function isOpfsSyncHandleAllowed(callerPath: string): boolean {
  if (callerPath.length === 0) return false;
  if (callerPath === 'dedicated-worker') return true;
  if (callerPath.includes('src/kernel/worker')) return true;
  // Exact worker entry file names (no extension tricks like worker.ts.bak).
  if (
    callerPath === 'worker.ts' ||
    callerPath.endsWith('/worker.ts') ||
    callerPath === 'worker-main.ts' ||
    callerPath.endsWith('/worker-main.ts') ||
    callerPath === 'worker-entry.ts' ||
    callerPath.endsWith('/worker-entry.ts')
  )
    return true;
  return false;
}

/**
 * Throw a typed `CapabilityError`-class `MediaError` if `callerPath` is
 * not allowed to use OPFS sync handles. Call this at the top of any
 * code path that would call `createSyncAccessHandle`.
 */
export function assertOpfsSyncHandleScope(callerPath: string): void {
  if (!isOpfsSyncHandleAllowed(callerPath)) {
    throw new MediaError(
      'capability-miss',
      `OPFS sync handle is only allowed inside a dedicated worker — blocked for '${callerPath}' (REQUIREMENTS §7.3)`,
    );
  }
}

/** Human-readable spill note: durable spill uses async OPFS or Blob segments, not sync handles. */
export const OPFS_SPILL_STRATEGY =
  'spill to Blob segments (UA storage) or async OPFS FileSystemWritableFileStream; sync handles only in dedicated worker' as const;
