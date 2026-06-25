/**
 * `OpfsTarget` — a streaming output sink that writes into the **Origin Private File System** (OPFS), the
 * browser's same-origin, sandboxed file storage (doc 07 §4 sinks, doc 09 streaming-output, ADR-013).
 *
 * Like {@link import('./stream-target.ts').StreamTarget}, this is a *streaming* sink: it pipes the
 * produced byte stream straight into a `FileSystemWritableFileStream` as chunks arrive, so peak memory
 * stays at one chunk no matter how large the output (a long recording, a fragmented MP4) — never the
 * whole-file buffering the Blob/File sink does. OPFS is the natural durable target for that: it is
 * origin-private (no picker, no user prompt), fast, and writable incrementally.
 *
 * The work splits cleanly into a **pure core** and a **browser seam**:
 *  - pure (Node-tested, can-fail): {@link parseOpfsPath} normalizes a `'/a/b/out.mp4'` path into the
 *    ordered parent directories + the leaf filename, rejecting empty/`.`/`..`/trailing-slash paths; and
 *    {@link planOpfsWrite} turns the sink + options into a {@link OpfsWritePlan} (the dirs to create, the
 *    filename, the `createWritable` options, the start position) — the exact instructions the seam runs.
 *  - seam (browser-only, guarded + `/* v8 ignore *​/`): {@link writeToOpfsTarget} feature-detects
 *    `navigator.storage.getDirectory` (absent ⇒ typed {@link CapabilityError}), walks/creates the parent
 *    directories, opens the file, and streams the input into it with native backpressure; an abort or a
 *    write failure aborts the writable (so a half-written file is not left as if complete) and surfaces a
 *    typed {@link MediaError}.
 */

import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import type { ExecuteOptions } from '../kernel/executor.ts';

/** Options for an {@link OpfsTarget} write. */
export interface OpfsTargetOptions {
  /**
   * Keep the file's existing bytes instead of truncating to empty before writing (maps to
   * `createWritable({ keepExistingData })`). Default `false` — a fresh write replaces the file, which is
   * the right default for "produce this output to that path". Combine with {@link OpfsTargetOptions.position}
   * to patch a region of an existing file.
   */
  keepExistingData?: boolean;
  /**
   * Byte offset at which the first chunk is written (subsequent chunks follow contiguously). Default 0.
   * Only meaningful with {@link OpfsTargetOptions.keepExistingData} (otherwise the file was truncated).
   */
  position?: number;
}

/** The OPFS streaming sink descriptor (a sink-union member, parallel to the basic `opfs` kind). */
export interface OpfsTarget {
  readonly kind: 'opfs-target';
  readonly path: string;
  readonly options: OpfsTargetOptions;
}

/**
 * Build an {@link OpfsTarget} that streams the output into the OPFS file at `path` (e.g. `'/clips/out.mp4'`).
 * Parent directories are created as needed. The path is validated lazily (at write time, by
 * {@link parseOpfsPath}) so constructing the descriptor never throws.
 */
export function toOpfsTarget(path: string, options: OpfsTargetOptions = {}): OpfsTarget {
  return { kind: 'opfs-target', path, options };
}

/** The normalized parts of an OPFS path: the parent directories (root→leaf) and the file's own name. */
export interface OpfsPath {
  /** Directory segments from the OPFS root down to (but excluding) the file. Empty ⇒ file is at the root. */
  readonly dirs: readonly string[];
  /** The file (leaf) name. */
  readonly name: string;
}

/**
 * Normalize an OPFS path into its parent directories + leaf filename, rejecting paths that cannot name a
 * single output file. OPFS has no concept of `.`/`..`/drive roots, so those are invalid here rather than
 * silently resolved. Leading and duplicate slashes are tolerated (`'//a//b.mp4'` ⇒ `['a'], 'b.mp4'`); a
 * trailing slash (a directory, not a file) is rejected.
 *
 * @throws InputError (`unsupported-input`) on an empty path, a path with no filename (root / trailing
 *   slash), or a `.`/`..` segment.
 */
export function parseOpfsPath(path: string): OpfsPath {
  if (typeof path !== 'string' || path.length === 0) {
    throw new InputError('unsupported-input', 'OPFS path must be a non-empty string');
  }
  if (path.endsWith('/')) {
    throw new InputError(
      'unsupported-input',
      `OPFS path '${path}' names a directory (trailing '/'), not a file`,
    );
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  for (const s of segments) {
    if (s === '.' || s === '..') {
      throw new InputError(
        'unsupported-input',
        `OPFS path '${path}' may not contain '.' or '..' segments`,
      );
    }
  }
  // The empty-string and trailing-slash guards above reject every "no filename" input ('', '/', '//',
  // '/dir/'), so any path reaching here has at least one non-slash trailing segment — `segments` is
  // non-empty and its last element is the filename, the rest its parent directories.
  const name = segments[segments.length - 1] as string;
  return { dirs: segments.slice(0, -1), name };
}

/** The fully-resolved instructions the browser seam executes — pure data, derived without any DOM API. */
export interface OpfsWritePlan {
  /** Directories to open/create in order from the OPFS root. */
  readonly dirs: readonly string[];
  /** The file to create/open in the deepest directory. */
  readonly name: string;
  /** Whether to preserve the file's existing bytes (`createWritable({ keepExistingData })`). */
  readonly keepExistingData: boolean;
  /** Byte offset for the first chunk. */
  readonly startPosition: number;
}

/**
 * Resolve an {@link OpfsTarget} (path + options) into an {@link OpfsWritePlan}. Pure — this is what the
 * Node tests assert against, so the path/option handling is validated without a browser. A negative or
 * non-finite `position` is rejected as bad input (a write can't start before byte 0).
 */
export function planOpfsWrite(target: OpfsTarget): OpfsWritePlan {
  const { dirs, name } = parseOpfsPath(target.path);
  const position = target.options.position ?? 0;
  if (!Number.isFinite(position) || position < 0 || !Number.isInteger(position)) {
    throw new InputError(
      'unsupported-input',
      `OPFS write position must be a non-negative integer, got ${String(target.options.position)}`,
    );
  }
  return {
    dirs,
    name,
    keepExistingData: target.options.keepExistingData ?? false,
    startPosition: position,
  };
}

/** The OPFS storage entry point (`navigator.storage.getDirectory`), or `undefined` if unavailable here. */
function opfsRootProvider(): StorageManager | undefined {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage;
  if (!storage || typeof storage.getDirectory !== 'function') return undefined;
  return storage;
}

/**
 * Whether OPFS is usable in this environment. Exposed so a sink registry / capability probe can report it
 * honestly (it returns `false` in Node, where there is no `navigator.storage.getDirectory`).
 */
export function isOpfsAvailable(): boolean {
  return opfsRootProvider() !== undefined;
}

/**
 * Stream a produced byte stream into the {@link OpfsTarget}'s OPFS file incrementally (one chunk at a
 * time, with backpressure). Returns `undefined` — the bytes went to the file, not back to the caller.
 *
 * The {@link OpfsWritePlan} (pure) decides the directories/filename/options; this function only performs
 * the DOM I/O. OPFS unavailable ⇒ {@link CapabilityError}; an abort or any write failure aborts the
 * writable (discarding a partial file rather than leaving it as if complete) and rejects with a typed
 * {@link MediaError}.
 */
export async function writeToOpfsTarget(
  target: OpfsTarget,
  stream: ReadableStream<Uint8Array>,
  opts: ExecuteOptions = {},
): Promise<undefined> {
  const plan = planOpfsWrite(target); // pure validation first (throws InputError on a bad path/position)
  const storage = opfsRootProvider();
  if (storage === undefined) {
    throw new CapabilityError(
      'capability-miss',
      'OPFS is unavailable in this environment (navigator.storage.getDirectory missing)',
      { op: 'opfs-write', tried: [] },
    );
  }
  const { signal } = opts;
  if (signal?.aborted) {
    await stream.cancel(new MediaError('aborted', 'operation aborted')).catch(() => undefined);
    throw new MediaError('aborted', 'operation aborted');
  }
  /* v8 ignore start -- requires a real OPFS (FileSystemWritableFileStream); browser-validated (ADR-025) */
  let writable: FileSystemWritableFileStream | undefined;
  try {
    let dir = await storage.getDirectory();
    for (const segment of plan.dirs) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    const handle = await dir.getFileHandle(plan.name, { create: true });
    writable = await handle.createWritable({ keepExistingData: plan.keepExistingData });
    if (plan.startPosition > 0) await writable.seek(plan.startPosition);

    // Pipe with native backpressure; `signal` aborts the pipe, which rejects here and triggers the catch.
    await stream.pipeTo(writable, signal ? { signal } : {});
    return undefined;
  } catch (err) {
    // Abort the writable so a half-written file is discarded rather than left looking complete.
    if (writable) await writable.abort().catch(() => undefined);
    throw mapOpfsError(err, signal);
  }
  /* v8 ignore stop */
}

/* v8 ignore start -- only reachable from the browser-only seam above */
/** Map a thrown value from the OPFS seam to the typed model (abort → `aborted`, else `mux-error`). */
function mapOpfsError(err: unknown, signal: AbortSignal | undefined): MediaError {
  if (signal?.aborted) return new MediaError('aborted', 'operation aborted');
  if (err instanceof MediaError) return err;
  const isAbort =
    (typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      (err.name === 'AbortError' || err.name === 'NotAllowedError')) ||
    (err instanceof Error && err.name === 'AbortError');
  if (isAbort) return new MediaError('aborted', 'operation aborted');
  return new MediaError('mux-error', err instanceof Error ? err.message : String(err), err);
}
/* v8 ignore stop */
