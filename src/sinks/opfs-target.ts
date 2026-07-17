/**
 * `OpfsTarget` — a streaming output sink that writes into the **Origin Private File System** (OPFS), the
 * browser's same-origin, sandboxed file storage (doc 07 §4 sinks, doc 09 streaming-output, ADR-013).
 *
 * Like {@link import('./stream-target.ts').StreamTarget}, this is a *streaming* sink: it pumps the
 * produced byte stream straight into a `FileSystemWritableFileStream` as chunks arrive, so peak memory
 * stays at one chunk no matter how large the output (a long recording, a fragmented MP4) — never the
 * whole-file buffering the Blob/File sink does. OPFS is the natural durable target for that: it is
 * origin-private (no picker, no user prompt), fast, and writable incrementally. Being random-access, it
 * also honors producer-positioned re-writes ({@link import('./stream-target.ts').positionedChunk}) —
 * the patch-a-region seek case (doc 09 §3.3 seek).
 *
 * The module follows the same two-file descriptor+seam convention as `stream-target.ts` /
 * `stream-target-materialize.ts` (doc 09 §5 item 9):
 *  - **this file (public, pure, Node-tested):** the descriptor + constructor; {@link parseOpfsPath}
 *    normalizes a `'/a/b/out.mp4'` path into ordered parent directories + the leaf filename, rejecting
 *    empty/`.`/`..`/trailing-slash paths; {@link planOpfsWrite} turns the sink + options into an
 *    {@link OpfsWritePlan} (the dirs to create, the filename, the `createWritable` options, the start
 *    position) — the exact instructions the seam runs; {@link isOpfsAvailable} probes the capability;
 *    and {@link writeToOpfsTarget} guards (typed {@link CapabilityError} when OPFS is absent — a
 *    capability miss, never an input error, doc 09 §5 item 6) then lazily loads the seam.
 *  - **`opfs-target-materialize.ts` (the seam, lazily imported):** walks/creates the directories, opens
 *    the file, seeks to the start position, and drives the shared positioned pump with native
 *    backpressure; an abort or a write failure aborts the writable (so a half-written file is discarded
 *    rather than left as if complete) and surfaces a typed {@link MediaError}.
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

/** The OPFS streaming sink descriptor (a member of the public sink union, next to the basic `opfs`). */
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
    throw new InputError('OPFS path must be a non-empty string');
  }
  if (path.endsWith('/')) {
    throw new InputError(`OPFS path '${path}' names a directory (trailing '/'), not a file`);
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  for (const s of segments) {
    if (s === '.' || s === '..') {
      throw new InputError(`OPFS path '${path}' may not contain '.' or '..' segments`);
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
  /** Byte offset for the first chunk (and the base for producer-positioned re-writes). */
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
 * The {@link OpfsWritePlan} (pure) decides the directories/filename/options; the lazily-loaded seam
 * performs the DOM I/O. OPFS unavailable ⇒ typed {@link CapabilityError} (`capability-miss`, agreeing
 * with the basic `opfs` sink — doc 09 §5 item 6); any failure cancels the unlocked source stream and
 * rejects with a typed {@link MediaError}, mirroring the `stream-target` lazy wrapper.
 */
export async function writeToOpfsTarget(
  target: OpfsTarget,
  stream: ReadableStream<Uint8Array>,
  opts: ExecuteOptions = {},
): Promise<undefined> {
  try {
    const plan = planOpfsWrite(target); // pure validation first (throws InputError on a bad path/position)
    const storage = opfsRootProvider();
    if (storage === undefined) {
      throw new CapabilityError(
        'OPFS is unavailable in this environment (navigator.storage.getDirectory missing)',
        { op: { kind: 'route', id: 'opfs-write' }, tried: [] },
      );
    }
    if (opts.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    const seam = await import('./opfs-target-materialize.ts');
    return await seam.writeToOpfsFile(storage, plan, stream, opts);
  } catch (error) {
    if (!stream.locked) await stream.cancel(error).catch(() => undefined);
    if (error instanceof MediaError) throw error;
    throw new MediaError('mux-error', 'opfs-target materializer failed', error);
  }
}
