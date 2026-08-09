import type {
  ContainerDriver,
  ContainerQuery,
  MuxOptions,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { BUFFER_ALL_MAX_RETAINED_BYTES } from '../internal/buffer-policy.ts';
import { materialize, toBlob } from '../sinks/sink.ts';
import type { MaterializeOptions, Output, Sink } from '../sinks/sink.ts';
import { isLiveMediaSource } from '../sources/live-source.ts';
import { type MediaInput, type Source, from as normalizeInput } from '../sources/source.ts';
import { containerHasChunkMuxer } from './codec-routing.ts';
import { validateReservedFaststart } from './reserved-faststart.ts';
import type { CallOptions, RemuxOptions } from './types.ts';

// The prepared MP4→WebM-family writer deliberately snapshots at most 64 MiB. Route every larger
// source directly to the incremental packet-info writer instead of leaving 64 MiB–1 GiB on the
// generic EncodedChunk + buffered-muxer path, where source, mux state, and output coexist.
const WEBM_STREAMING_MIN_SOURCE_BYTES = 64 * 1024 * 1024;

const CONTAINER_MIME: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  adts: 'audio/aac',
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpegts: 'video/mp2t',
};

/** Engine-owned routing capabilities used by the lazy remux implementation. */
export interface RemuxRunnerContext {
  readonly resolveHls: (input: MediaInput, source: Source, signal: AbortSignal) => Promise<Source>;
  readonly container: (
    source: Source,
    direction: ContainerQuery['direction'],
    signal?: AbortSignal,
    pinDriver?: string,
  ) => Promise<ContainerDriver>;
  readonly muxer: (target: string, pinDriver?: string) => Promise<ContainerDriver>;
  readonly stage: (signal: AbortSignal, options: CallOptions) => StageOptions;
}

/** Execute a lossless remux after the eager engine has established its cancellation domain. */
export async function runRemux(
  context: RemuxRunnerContext,
  input: MediaInput,
  opts: RemuxOptions,
  options: CallOptions,
  signal: AbortSignal,
): Promise<Output> {
  validateReservedFaststart('remux', opts.to, opts);
  // Plan and snapshot caller-owned tags before opening any source. A getter/proxy failure therefore cannot
  // leave a one-shot producer partially consumed, and later caller mutation cannot change the rewrite.
  const tags = opts.tags;
  const metadata =
    tags === undefined
      ? undefined
      : await import('./remux-metadata.ts').then((module) => ({
          module,
          plan: module.planRemuxMetadata(opts.to, tags),
        }));
  const progress = metadata?.module.createRemuxMetadataProgress(options.onProgress);
  const remuxCallOptions: CallOptions =
    progress?.remux === undefined ? options : { ...options, onProgress: progress.remux };
  const finish = async (stream: ReadableStream<Uint8Array>): Promise<Output> => {
    const outputStream =
      metadata === undefined
        ? stream
        : bytesToStream(
            await metadata.module.rewriteRemuxMetadata(stream, metadata.plan, {
              signal,
              ...(progress?.metadata === undefined ? {} : { onProgress: progress.metadata }),
            }),
          );
    return materializeOutput(opts.sink ?? toBlob(), outputStream, mimeOptions(signal, opts.to));
  };

  let source = await context.resolveHls(input, normalizeByteInput(input, 'remux'), signal);
  const container = await context.container(
    source,
    'demux',
    signal,
    remuxCallOptions.strategy?.pinDriver,
  );
  const wantsTrackSelection = opts.trackSelect !== undefined && opts.trackSelect.length > 0;
  const directMetadataTarget =
    metadata !== undefined &&
    opts.faststart === undefined &&
    opts.fragmented === undefined &&
    container.formats.length === 1 &&
    container.formats[0] === opts.to;

  // MP4/MOV share one driver, so the single-format shortcut above cannot identify an ordinary same-family
  // rewrite. Materialize once, prove that relocating only `moov` preserves every media reference, and
  // replay the exact owned bytes through normal remux on any structural decline (ADR-274).
  const directMp4MetadataCandidate =
    metadata !== undefined &&
    !wantsTrackSelection &&
    opts.faststart === undefined &&
    opts.fragmented === undefined &&
    (opts.to === 'mp4' || opts.to === 'mov') &&
    container.formats.includes(opts.to);
  if (directMp4MetadataCandidate && metadata !== undefined) {
    if (opts.sink === undefined && typeof Blob !== 'undefined' && input instanceof Blob) {
      const blobOutput = await metadata.module.tryRewriteMp4MetadataBlobDirectly(
        input,
        metadata.plan,
        signal,
      );
      if (blobOutput !== undefined) {
        // The range-only topology planner proves ADR-274's relocation envelope. The existing ADR-251
        // demux validation still proves every complete stsz/stsc sample lies inside a declared mdat.
        const validationDemuxer = await container.demux(
          source,
          context.stage(signal, remuxCallOptions),
        );
        await validationDemuxer.close();
        throwIfAborted(signal);
        progress?.remux?.({
          done: input.size,
          total: input.size,
          stage: 'metadata-direct-source',
        });
        progress?.metadata?.({
          done: blobOutput.size,
          total: blobOutput.size,
          stage: 'metadata',
        });
        return blobOutput;
      }
    }
    const inputBytes = await readAllSource(source, signal);
    if (await metadata.module.canRewriteMp4MetadataBytesDirectly(inputBytes, metadata.plan)) {
      const replayOptions = source.mimeHint === undefined ? {} : { mime: source.mimeHint };
      // The cheap relocation classifier proves box topology. The container's ADR-251 demux validation
      // additionally walks stsz/stsc/stco/co64 and proves every complete sample lies in a declared mdat.
      const validationDemuxer = await container.demux(
        normalizeInput(inputBytes, replayOptions),
        context.stage(signal, remuxCallOptions),
      );
      await validationDemuxer.close();
      progress?.remux?.({
        done: inputBytes.byteLength,
        total: inputBytes.byteLength,
        stage: 'metadata-direct-source',
      });
      const output = await metadata.module.tryRewriteMp4MetadataBytesDirectly(
        inputBytes,
        metadata.plan,
        {
          signal,
          ...(progress?.metadata === undefined ? {} : { onProgress: progress.metadata }),
        },
      );
      if (output === undefined) {
        throw new MediaError('mux-error', 'validated MP4 metadata rewrite became ineligible');
      }
      return materializeOutput(
        opts.sink ?? toBlob(),
        bytesToStream(output),
        mimeOptions(signal, opts.to),
      );
    }
    source = normalizeInput(
      inputBytes,
      source.mimeHint === undefined ? {} : { mime: source.mimeHint },
    );
  }

  // Metadata rewriting is the complete same-container operation for formats that deliberately expose no
  // EncodedChunk mux seam. Multi-format drivers still reserialize so family changes remain genuine remuxes.
  if (directMetadataTarget && !wantsTrackSelection && metadata !== undefined) {
    return finish(source.stream());
  }
  if (directMetadataTarget && wantsTrackSelection && metadata !== undefined) {
    // Materialize a one-shot producer exactly once, then validate selection against the container's own
    // tracks. The replay remains available if a true subset must continue into the ordinary packet seam.
    const inputBytes = await readAllSource(source, signal);
    const replay = normalizeInput(
      inputBytes,
      source.mimeHint === undefined ? {} : { mime: source.mimeHint },
    );
    const stage = context.stage(signal, remuxCallOptions);
    let tracks: readonly TrackInfo[];
    if (container.probe !== undefined) {
      tracks = await container.probe(replay, stage);
    } else {
      const demuxer = await container.demux(replay, stage);
      try {
        tracks = demuxer.tracks;
      } finally {
        await demuxer.close();
      }
    }
    const { selectTrackInfos } = await import('./track-select.ts');
    const selected = selectTrackInfos(tracks, opts.trackSelect);
    const keepsCompleteOrder =
      selected.length === tracks.length &&
      selected.every((track, index) => track === tracks[index]);
    if (keepsCompleteOrder) {
      progress?.remux?.({
        done: inputBytes.byteLength,
        total: inputBytes.byteLength,
        stage: 'track-selection',
      });
      const bytes = await metadata.module.rewriteRemuxMetadataBytes(inputBytes, metadata.plan, {
        signal,
        ...(progress?.metadata === undefined ? {} : { onProgress: progress.metadata }),
      });
      return materializeOutput(
        opts.sink ?? toBlob(),
        bytesToStream(bytes),
        mimeOptions(signal, opts.to),
      );
    }
    source = replay;
  }

  if (
    !wantsTrackSelection &&
    container.streamCopy !== undefined &&
    (container.formats.includes(opts.to) || container.streamCopyTargets?.includes(opts.to) === true)
  ) {
    const stream = await container.streamCopy(source, {
      ...context.stage(signal, remuxCallOptions),
      container: opts.to,
      ...(opts.faststart !== undefined ? { faststart: opts.faststart } : {}),
      ...(opts.maximumPacketCount !== undefined
        ? { maximumPacketCount: opts.maximumPacketCount }
        : {}),
      ...(opts.fragmented !== undefined ? { fragmented: opts.fragmented } : {}),
      ...(metadata === undefined ? streamCopySinkMode(opts.sink) : { buffered: true }),
    });
    return finish(stream);
  }

  const stream = await remuxViaSeam(context, container, source, opts, signal, remuxCallOptions);
  return finish(stream);
}

async function remuxViaSeam(
  context: RemuxRunnerContext,
  container: ContainerDriver,
  source: Source,
  opts: RemuxOptions,
  signal: AbortSignal,
  options: CallOptions,
): Promise<ReadableStream<Uint8Array>> {
  if (!containerHasChunkMuxer(opts.to)) {
    throw new CapabilityError(`no remux muxer '${opts.to}'`, {
      op: { kind: 'route', id: 'remux' },
      tried: [container.id, opts.to],
    });
  }
  if (
    (opts.to === 'webm' || opts.to === 'mkv') &&
    (opts.fragmented === true ||
      (source.size !== undefined && source.size > WEBM_STREAMING_MIN_SOURCE_BYTES))
  ) {
    const { remuxViaStreamingWebm } = await import('./streaming-webm-remux.ts');
    return remuxViaStreamingWebm(container, source, opts, context.stage(signal, options));
  }
  if (opts.to === 'ts') {
    const { tryRemuxPacketInfoToMpegTs } = await import('./mpegts-packet-info-remux.ts');
    const stream = await tryRemuxPacketInfoToMpegTs(
      container,
      source,
      opts,
      context.stage(signal, options),
    );
    if (stream !== undefined) return stream;
  }
  if (opts.to === 'webm' || opts.to === 'mkv') {
    const { tryRemuxPacketInfoToBufferedWebm } = await import('./webm-packet-info-remux.ts');
    const stream = await tryRemuxPacketInfoToBufferedWebm(
      container,
      source,
      opts,
      context.stage(signal, options),
    );
    if (stream !== undefined) return stream;
  }
  if (source.size !== undefined && source.size > BUFFER_ALL_MAX_RETAINED_BYTES) {
    throw new CapabilityError(`remux '${opts.to}' over buffer limit`, {
      op: { kind: 'route', id: 'remux' },
      tried: [container.id, opts.to],
    });
  }

  const demuxer = await container.demux(source, context.stage(signal, options));
  const muxer = (await context.muxer(opts.to, options.strategy?.pinDriver)).createMuxer(
    remuxMuxOptions(opts),
  );
  const { selectTrackInfos } = await import('./track-select.ts');
  const tracks = selectTrackInfos(
    demuxer.tracks.filter((track) => track.config !== undefined),
    opts.trackSelect,
  );
  if (tracks.length === 0) {
    await demuxer.close();
    throw new CapabilityError('no remux track', {
      op: { kind: 'route', id: 'remux' },
      tried: [container.id],
    });
  }

  /* v8 ignore start -- the verbatim packet copy requires browser EncodedChunk constructors; routing,
     fan-out, cancellation, and finalization are covered with real/fake browser seams. */
  try {
    const { createDrainTaskGroup, drainEncoderToMuxer } = await import('./codec-pipeline.ts');
    const group = createDrainTaskGroup(signal);
    const tasks = tracks.map((track) => {
      const packets = demuxer.packets(track.id);
      return drainEncoderToMuxer(packets, muxer, track, group.signal);
    });
    try {
      await group.run(tasks);
      await muxer.finalize();
      return muxer.output;
    } finally {
      group.dispose();
    }
  } finally {
    await demuxer.close();
  }
  /* v8 ignore stop */
}

function normalizeByteInput(input: MediaInput, op: string): Source {
  const normalized = normalizeInput(input);
  if (!isLiveMediaSource(normalized)) return normalized;
  throw new CapabilityError(
    `${op} requires finite encoded/container bytes and is unavailable for a raw live MediaStream`,
    { op: { kind: 'route', id: op }, tried: ['media-stream/raw-frames'] },
  );
}

async function materializeOutput(
  sink: Sink,
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
): Promise<Output> {
  if (sink.kind === 'stream') return stream;
  return materialize(sink, stream, opts);
}

function streamCopySinkMode(sink: Sink | undefined): { streaming?: true; buffered?: true } {
  return sink?.kind === 'stream-target' || sink?.kind === 'opfs' || sink?.kind === 'opfs-target'
    ? { streaming: true }
    : { buffered: true };
}

function remuxMuxOptions(opts: RemuxOptions): MuxOptions & { readonly container: string } {
  return {
    ...(opts.faststart !== undefined ? { faststart: opts.faststart } : {}),
    ...(opts.maximumPacketCount !== undefined
      ? { maximumPacketCount: opts.maximumPacketCount }
      : {}),
    ...(opts.fragmented !== undefined ? { fragmented: opts.fragmented } : {}),
    container: opts.to,
  };
}

async function readAllSource(source: Source, signal: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (source.range !== undefined && source.size !== undefined) {
    const bytes = await source.range(0, source.size);
    throwIfAborted(signal);
    return bytes;
  }
  const reader = source.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readSourceChunk(reader, signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  throwIfAborted(signal);
  return output;
}

async function readSourceChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  throwIfAborted(signal);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new MediaError('aborted', 'aborted'));
  });
  const onAbort = (): void => rejectAbort?.();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaError('aborted', 'aborted');
}

function mimeOptions(signal: AbortSignal, container: string): MaterializeOptions {
  const mime = CONTAINER_MIME[container];
  return mime === undefined ? { signal } : { signal, mime };
}
