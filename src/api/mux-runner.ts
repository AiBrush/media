import type { ContainerDriver, MuxOptions, StageOptions } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { materialize, toBlob } from '../sinks/sink.ts';
import type { MaterializeOptions, Output, Sink } from '../sinks/sink.ts';
import { memoizeAsync } from '../util/memoize-async.ts';
import { containerHasChunkMuxer } from './codec-routing.ts';
import { validateReservedFaststart } from './reserved-faststart.ts';
import type { CallOptions, MuxSpec, PacketStream, PacketStreams } from './types.ts';

/** Memoized lazy chunks: one dynamic import per module, not per call. */
const loadCodecPipelineModule = memoizeAsync(() => import('./codec-pipeline.ts'));
const loadFlacMkvMuxModule = memoizeAsync(() => import('./flac-mkv-mux.ts'));
const loadMpegtsPreparedMuxModule = memoizeAsync(() => import('./mpegts-prepared-mux.ts'));
const loadMuxPacketStreamsModule = memoizeAsync(() => import('./mux-packet-streams.ts'));
const loadNativePacketMuxModule = memoizeAsync(() => import('./native-packet-mux.ts'));

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

/** Engine-owned container capabilities used by the lazy explicit-mux implementation. */
export interface MuxRunnerContext {
  readonly muxer: (target: string, pinDriver?: string) => Promise<ContainerDriver>;
  readonly stage: (signal: AbortSignal, options: CallOptions) => StageOptions;
}

/** Execute explicit packet muxing after the eager engine has established its cancellation domain. */
export async function runMux(
  context: MuxRunnerContext,
  streams: PacketStreams,
  opts: MuxSpec,
  options: CallOptions,
  signal: AbortSignal,
): Promise<Output> {
  const target = opts.container;
  validateReservedFaststart('mux', target, opts);
  if (!containerHasChunkMuxer(target)) {
    throw new CapabilityError(`no muxer '${target}'`, {
      op: { kind: 'route', id: 'mux' },
      tried: [target],
    });
  }
  // Reject an illegal codec→container pair before any muxer chunk loads or a packet is read: the
  // eager driver proxy carries the container's track rule when it has one (REQUIREMENTS §5.5).
  const validateMuxTrack = (await context.muxer(target, options.strategy?.pinDriver)).validateMuxTrack;
  if (validateMuxTrack !== undefined) {
    [streams.video, streams.audio, ...(streams.tracks ?? [])]
      .filter((stream): stream is PacketStream => stream !== undefined)
      .forEach((stream, index) => validateMuxTrack(stream.track, index));
  }
  if (
    opts.faststart !== 'reserve' &&
    opts.fragmented !== true &&
    (target === 'mp4' || target === 'mov'
      ? opts.faststart !== false
      : target === 'webm' || target === 'mkv' || target === 'ogg')
  ) {
    if (
      (target === 'mp4' || target === 'mov') &&
      (opts.sink === undefined || opts.sink.kind === 'blob')
    ) {
      const { muxNativeFirstPartyPacketStreams } = await loadNativePacketMuxModule();
      const native = await muxNativeFirstPartyPacketStreams(streams, {
        container: target,
        ...(opts.faststart !== undefined ? { faststart: opts.faststart } : {}),
        signal,
      });
      if (native !== undefined) {
        return materializeOutput(opts.sink ?? toBlob(), native, mimeOptions(signal, target));
      }
    }
    const fastMux = await loadFlacMkvMuxModule();
    const muxPrepared =
      target === 'mp4' || target === 'mov'
        ? fastMux.muxPreparedMp4PacketStreams
        : target === 'ogg'
          ? fastMux.muxSingleTrackOggAudio
          : fastMux.muxPreparedWebmPacketStreams;
    const stream = await muxPrepared(streams, {
      ...context.stage(signal, options),
      container: target,
      ...((target === 'mp4' || target === 'mov') &&
      (opts.sink === undefined || opts.sink.kind === 'blob')
        ? { buffered: true }
        : {}),
    });
    if (stream !== undefined) {
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
    }
  }
  if (
    (target === 'mp4' || target === 'mov') &&
    (opts.sink?.kind === 'stream' || opts.sink?.kind === 'stream-target') &&
    opts.faststart !== 'reserve' &&
    opts.fragmented !== true
  ) {
    const fastMux = await loadFlacMkvMuxModule();
    const stream = await fastMux.muxPreparedMp4PacketStreams(streams, {
      ...context.stage(signal, options),
      container: target,
    });
    if (stream !== undefined) {
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
    }
  }

  if (opts.fragmented !== true && target === 'ts') {
    const { muxPreparedMpegTsPacketStreams } = await loadMpegtsPreparedMuxModule();
    const stream = await muxPreparedMpegTsPacketStreams(streams, {
      ...context.stage(signal, options),
      container: target,
    });
    if (stream !== undefined) {
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target));
    }
  }

  const { muxPacketStreams, readablePacketStreams } = await loadMuxPacketStreamsModule();
  let inputs: ReturnType<typeof muxPacketStreams>;
  try {
    inputs = muxPacketStreams(streams);
  } catch (error) {
    await Promise.all(readablePacketStreams(streams).map((stream) => cancelStream(stream)));
    throw error;
  }

  const openStreams = inputs.map((input) => input.packets as ReadableStream<unknown>);
  let drainsStarted = false;
  try {
    const muxer = (await context.muxer(target, options.strategy?.pinDriver)).createMuxer(
      muxOptions(opts),
    );
    const { createDrainTaskGroup, drainEncoderToMuxer } = await loadCodecPipelineModule();
    const group = createDrainTaskGroup(signal);
    const tasks = inputs.map((input) =>
      drainEncoderToMuxer(input.packets, muxer, input.track, group.signal),
    );
    drainsStarted = true;
    try {
      await group.run(tasks);
      await muxer.finalize();
      return materializeOutput(opts.sink ?? toBlob(), muxer.output, mimeOptions(signal, target));
    } finally {
      group.dispose();
    }
  } catch (error) {
    if (!drainsStarted) {
      await Promise.all(openStreams.map((stream) => cancelStream(stream)));
    }
    throw error;
  }
}

function muxOptions(opts: MuxSpec): MuxOptions & { readonly container: string } {
  return {
    ...(opts.faststart !== undefined ? { faststart: opts.faststart } : {}),
    ...(opts.maximumPacketCount !== undefined
      ? { maximumPacketCount: opts.maximumPacketCount }
      : {}),
    ...(opts.fragmented !== undefined ? { fragmented: opts.fragmented } : {}),
    container: opts.container,
  };
}

async function materializeOutput(
  sink: Sink,
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
): Promise<Output> {
  if (sink.kind === 'stream') return stream;
  return materialize(sink, stream, opts);
}

async function cancelStream(stream: ReadableStream<unknown>): Promise<void> {
  await stream.cancel(new MediaError('aborted', 'stream not consumed')).catch(() => {});
}

function mimeOptions(signal: AbortSignal, container: string): MaterializeOptions {
  const mime = CONTAINER_MIME[container];
  return mime === undefined ? { signal } : { signal, mime };
}
