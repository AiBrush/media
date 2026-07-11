/** Lazy composition of a completed remux stream with its target-native metadata writer. */

import type { Progress } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { collect } from '../kernel/executor.ts';
import { rewriteMetadataTags } from '../metadata/metadata-rewrite.ts';
import type { Container } from './types.ts';

const METADATA_TARGETS = new Set<Container>([
  'mp4',
  'mov',
  'webm',
  'mkv',
  'ogg',
  'wav',
  'mp3',
  'flac',
  'aiff',
  'caf',
]);

export interface RemuxMetadataPlan {
  readonly target: Container;
  readonly tags: Readonly<Record<string, string>>;
}

export interface RemuxMetadataOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Progress) => void;
}

export interface RemuxMetadataProgress {
  readonly remux?: (progress: Progress) => void;
  readonly metadata?: (progress: Progress) => void;
}

/** Project two differently-scaled implementations onto one stable, monotonic public timeline. */
export function createRemuxMetadataProgress(
  emit: ((progress: Progress) => void) | undefined,
): RemuxMetadataProgress {
  if (emit === undefined) return {};
  let last = -1;
  let lastPhase = -1;
  const phase =
    (index: 0 | 1, prefix: 'remux' | 'metadata') =>
    (progress: Progress): void => {
      if (index < lastPhase) return;
      const ratio =
        Number.isFinite(progress.done) &&
        progress.done >= 0 &&
        progress.total !== undefined &&
        Number.isFinite(progress.total) &&
        progress.total > 0
          ? clamp(progress.done / progress.total, 0, 1)
          : 0;
      const done = Math.max(last, index + ratio);
      if (done === last && index === lastPhase) return;
      last = done;
      lastPhase = index;
      emit({ done, total: 2, stage: `${prefix}:${progress.stage}` });
    };
  return { remux: phase(0, 'remux'), metadata: phase(1, 'metadata') };
}

/** Validate tag capability and snapshot caller-owned tag data before any source byte is consumed. */
export function planRemuxMetadata(
  target: Container,
  tags: Record<string, string>,
): RemuxMetadataPlan {
  if (!METADATA_TARGETS.has(target)) {
    throw new CapabilityError('capability-miss', 'metadata tag rewrite is not available', {
      op: 'remux',
      tried: [target],
    });
  }
  return { target, tags: snapshotTagRecord(tags) };
}

function snapshotTagRecord(tags: Record<string, string>): Readonly<Record<string, string>> {
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
    throw new InputError('unsupported-input', 'remux tags must be a string record');
  }
  try {
    const prototype = Object.getPrototypeOf(tags);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InputError('unsupported-input', 'remux tags must be a plain string record');
    }
    const entries: [string, string][] = [];
    for (const key of Reflect.ownKeys(tags)) {
      const descriptor = Object.getOwnPropertyDescriptor(tags, key);
      if (
        typeof key !== 'string' ||
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string'
      ) {
        throw new InputError(
          'unsupported-input',
          'remux tags must contain only enumerable string data fields',
        );
      }
      entries.push([key, descriptor.value]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('unsupported-input', 'remux tags could not be read', error);
  }
}

/** Buffer the selected target bytes once, then rewrite only that target's metadata structure. */
export async function rewriteRemuxMetadata(
  stream: ReadableStream<Uint8Array>,
  plan: RemuxMetadataPlan,
  options: RemuxMetadataOptions = {},
): Promise<Uint8Array> {
  const { signal } = options;
  if (signal?.aborted) {
    const error = abortedError();
    await stream.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = await collect(stream, {
    ...(signal !== undefined ? { signal } : {}),
    ...(options.onProgress !== undefined
      ? {
          onProgress: (progress: Progress): void =>
            options.onProgress?.({ ...progress, stage: 'metadata-buffer' }),
        }
      : {}),
    errorCode: 'mux-error',
  });
  return rewriteRemuxMetadataBytes(bytes, plan, options);
}

/** Rewrite an already-owned completed target without collecting/copying it through a second stream. */
export async function rewriteRemuxMetadataBytes(
  bytes: Uint8Array,
  plan: RemuxMetadataPlan,
  options: RemuxMetadataOptions = {},
): Promise<Uint8Array> {
  const { signal } = options;
  assertNotAborted(signal);
  const output = await rewriteMetadataTags(bytes, plan.target, plan.tags);
  assertNotAborted(signal);
  options.onProgress?.({ done: output.byteLength, total: output.byteLength, stage: 'metadata' });
  return output;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

function abortedError(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
