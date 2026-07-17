/**
 * Frame-lifetime helpers (docs/architecture/06 §3). `VideoFrame`/`AudioData`/`ImageBitmap` are
 * ref-counted handles to accelerator/native memory that the GC will not reclaim in time, so each must
 * be `close()`d exactly once by its last consumer. These helpers make teardown paths (abort/error)
 * close in-flight frames safely.
 */

/** A ref-counted media handle that must be explicitly released. */
export interface Closable {
  close(): void;
}

/** True when `x` exposes a `close()` method (a `VideoFrame`/`AudioData`/`ImageBitmap`). */
export function isClosable(x: unknown): x is Closable {
  return (
    typeof x === 'object' && x !== null && typeof (x as { close?: unknown }).close === 'function'
  );
}

/**
 * Close a frame if it is closable; a no-op on anything else. This is the engine's **single**
 * frame-close helper and it owns the error policy (execution-runtime §5 item 4): a `close()` throw is
 * **swallowed**, because `closeFrame` runs on teardown paths (abort, stage error, a lost enqueue race)
 * where the primary failure must never be masked by a secondary release failure. Per the platform
 * frame contract `close()` does not throw on an already-closed handle, so nothing real is hidden.
 * Close-*once* discipline stays with the caller and is enforced by counting oracles, not here.
 */
export function closeFrame(x: unknown): void {
  if (!isClosable(x)) return;
  try {
    x.close();
  } catch {
    // Swallowed by policy (documented above): teardown release must not mask the primary failure.
  }
}

/**
 * Close every closable in an iterable — the teardown drain for a cancelled/aborted composed graph's
 * in-flight items (consumed by the executor's batched packet drain on abort and lost enqueue races).
 */
export function closeFrames(xs: Iterable<unknown>): void {
  for (const x of xs) closeFrame(x);
}
