/** Lazy composition of a completed remux stream with its target-native metadata writer. */

import type { ContainerDriver, Progress, StageOptions } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { collect } from '../kernel/executor.ts';
import { rewriteMetadataTags } from '../metadata/metadata-rewrite.ts';
import type { Mp4MetadataBox } from '../metadata/mp4-tags.ts';
import type { Source } from '../sources/source.ts';
import type { Container, ConvertOptions } from './types.ts';

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
    throw new CapabilityError('metadata tag rewrite is not available', {
      op: { kind: 'route', id: 'remux' },
      tried: [target],
    });
  }
  return { target, tags: snapshotTagRecord(tags) };
}

function snapshotTagRecord(tags: Record<string, string>): Readonly<Record<string, string>> {
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
    throw new InputError('remux tags must be a string record');
  }
  try {
    const prototype = Object.getPrototypeOf(tags);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InputError('remux tags must be a plain string record');
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
        throw new InputError('remux tags must contain only enumerable string data fields');
      }
      entries.push([key, descriptor.value]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('remux tags could not be read', error);
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

/**
 * Rewrite a complete ordinary MP4/MOV directly when relocating `moov` is structurally sufficient.
 * Returns `undefined` for shapes that must retain the ordinary demux/mux path.
 */
export async function tryRewriteMp4MetadataBytesDirectly(
  bytes: Uint8Array,
  plan: RemuxMetadataPlan,
  options: RemuxMetadataOptions = {},
): Promise<Uint8Array | undefined> {
  if (plan.target !== 'mp4' && plan.target !== 'mov') return undefined;
  const { signal } = options;
  assertNotAborted(signal);
  const module = await import('../metadata/mp4-tags.ts');
  assertNotAborted(signal);
  if (!module.canWriteMp4TagsDirectly(bytes, plan.target)) return undefined;
  const output = module.writeMp4Tags(bytes, plan.tags);
  assertNotAborted(signal);
  options.onProgress?.({ done: output.byteLength, total: output.byteLength, stage: 'metadata' });
  return output;
}

/** Cheap complete-file qualification before the MP4 driver's full sample-storage validation. */
export async function canRewriteMp4MetadataBytesDirectly(
  bytes: Uint8Array,
  plan: RemuxMetadataPlan,
): Promise<boolean> {
  if (plan.target !== 'mp4' && plan.target !== 'mov') return false;
  const module = await import('../metadata/mp4-tags.ts');
  return module.canWriteMp4TagsDirectly(bytes, plan.target);
}

/**
 * Rewrite an ordinary same-brand MP4/MOV default Blob from immutable source slices plus one owned moov.
 * Structural declines return undefined so the caller can retain the established whole-byte replay path.
 */
export async function tryRewriteMp4MetadataBlobDirectly(
  blob: Blob,
  plan: RemuxMetadataPlan,
  signal?: AbortSignal,
): Promise<Blob | undefined> {
  if (plan.target !== 'mp4' && plan.target !== 'mov') return undefined;
  assertNotAborted(signal);
  const top = await scanBlobTopLevel(blob, signal);
  if (top === undefined) return undefined;
  const ftyp = top.find((box) => box.type === 'ftyp');
  const moov = top.find((box) => box.type === 'moov');
  if (ftyp === undefined || moov === undefined) return undefined;
  const [ftypPrefix, moovBytes] = await Promise.all([
    readBlobRange(blob, ftyp.start, Math.min(ftyp.end, ftyp.payloadStart + 8), signal),
    readBlobRange(blob, moov.start, moov.end, signal),
  ]);
  assertNotAborted(signal);
  const module = await import('../metadata/mp4-tags.ts');
  const rewrite = module.planMp4TagsDirectRewrite(
    top,
    blob.size,
    ftypPrefix,
    moovBytes,
    plan.target,
    plan.tags,
  );
  if (rewrite === undefined) return undefined;
  assertNotAborted(signal);
  const output = new Blob(
    [blob.slice(0, rewrite.moovStart), rewrite.patchedMoov, blob.slice(rewrite.moovEnd)],
    { type: plan.target === 'mov' ? 'video/quicktime' : 'video/mp4' },
  );
  assertNotAborted(signal);
  return output;
}

/**
 * Compose a target-typed Blob over an immutable ordinary same-brand MP4/MOV source. Eligibility proves
 * only box/offset topology; the caller must additionally run the container's full sample validation.
 */
export async function tryReuseMp4SemanticBlobDirectly(
  blob: Blob,
  target: Container,
  signal?: AbortSignal,
): Promise<Blob | undefined> {
  if (target !== 'mp4' && target !== 'mov') return undefined;
  assertNotAborted(signal);
  const top = await scanBlobTopLevel(blob, signal);
  if (top === undefined) return undefined;
  const ftyp = top.find((box) => box.type === 'ftyp');
  const moov = top.find((box) => box.type === 'moov');
  if (ftyp === undefined || moov === undefined) return undefined;
  const [ftypPrefix, moovBytes] = await Promise.all([
    readBlobRange(blob, ftyp.start, Math.min(ftyp.end, ftyp.payloadStart + 8), signal),
    readBlobRange(blob, moov.start, moov.end, signal),
  ]);
  assertNotAborted(signal);
  const module = await import('../metadata/mp4-tags.ts');
  if (!module.canReuseMp4BlobDirectly(top, blob.size, ftypPrefix, moovBytes, target)) {
    return undefined;
  }
  assertNotAborted(signal);
  return new Blob([blob], { type: target === 'mov' ? 'video/quicktime' : 'video/mp4' });
}

/** Complete lazy API-route proof: option envelope, MP4 topology, then full driver sample validation. */
export async function tryReuseSemanticMp4Blob(
  blob: Blob,
  container: ContainerDriver,
  source: Source,
  stage: StageOptions,
  opts: ConvertOptions,
): Promise<Blob | undefined> {
  const target = opts.to;
  if (
    opts.sink !== undefined ||
    opts.faststart !== undefined ||
    opts.fragmented !== undefined ||
    (target !== 'mp4' && target !== 'mov')
  ) {
    return undefined;
  }
  const signal = stage.signal;
  const direct = await tryReuseMp4SemanticBlobDirectly(blob, target, signal);
  if (direct === undefined) return undefined;
  const validationDemuxer = await container.demux(source, stage);
  await validationDemuxer.close();
  assertNotAborted(signal);
  stage.onProgress?.({ done: direct.size, total: direct.size, stage: 'semantic-copy' });
  return direct;
}

async function scanBlobTopLevel(
  blob: Blob,
  signal: AbortSignal | undefined,
): Promise<readonly Mp4MetadataBox[] | undefined> {
  const out: Mp4MetadataBox[] = [];
  let offset = 0;
  while (offset < blob.size) {
    if (blob.size - offset < 8) return undefined;
    const header = await readBlobRange(blob, offset, Math.min(blob.size, offset + 16), signal);
    if (header.byteLength < 8) return undefined;
    const size32 = readU32(header, 0);
    if (size32 === undefined) return undefined;
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      const large = readU64(header, 8);
      if (large === undefined) return undefined;
      size = large;
      headerSize = 16;
    } else if (size32 === 0) {
      size = blob.size - offset;
    }
    const end = offset + size;
    if (
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(end) ||
      size < headerSize ||
      end <= offset ||
      end > blob.size
    ) {
      return undefined;
    }
    out.push({
      type: fourcc(header, 4),
      start: offset,
      headerSize,
      payloadStart: offset + headerSize,
      end,
    });
    offset = end;
  }
  return offset === blob.size ? out : undefined;
}

async function readBlobRange(
  blob: Blob,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  assertNotAborted(signal);
  const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
  assertNotAborted(signal);
  return bytes;
}

function readU32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function readU64(bytes: Uint8Array, offset: number): number | undefined {
  const high = readU32(bytes, offset);
  const low = readU32(bytes, offset + 4);
  if (high === undefined || low === undefined) return undefined;
  const big = (BigInt(high) << 32n) | BigInt(low);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(big);
}

function fourcc(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.byteLength) return '';
  return String.fromCharCode(
    bytes[offset] as number,
    bytes[offset + 1] as number,
    bytes[offset + 2] as number,
    bytes[offset + 3] as number,
  );
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
