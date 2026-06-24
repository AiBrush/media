/**
 * Frame-lifetime helpers (docs/architecture/06 §3). `VideoFrame`/`AudioData`/`ImageBitmap` are
 * ref-counted handles to GPU/native memory that the GC will not reclaim in time, so each must be
 * `close()`d exactly once by its last consumer. These helpers make teardown paths (abort/error) close
 * in-flight frames safely.
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

/** Close a frame if it is closable; a no-op on anything else. The caller owns close-once discipline. */
export function closeFrame(x: unknown): void {
  if (isClosable(x)) x.close();
}

/** Close every closable in an iterable (used to drain in-flight frames on teardown). */
export function closeFrames(xs: Iterable<unknown>): void {
  for (const x of xs) closeFrame(x);
}
