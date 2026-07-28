/**
 * Public frame-encode orchestration, kept behind encode's lazy operation edge.
 */

import type { ContainerDriver, Muxer, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { toBlob } from '../sinks/sink.ts';
import { chooseOutputContainer, containerHasChunkMuxer } from './codec-routing.ts';
import { mimeOpts } from './container-mime.ts';
import { allOrCancel, cancelStream } from './frame-streams.ts';
import { materializeOutput, muxOptionsFrom } from './op-support.ts';
import type {
  AudioTarget,
  CallOptions,
  EncodeOptions,
  MediaStreams,
  Output,
  VideoTarget,
} from './types.ts';

export interface EncodeRunnerContext {
  muxer(target: string, pinDriver: string | undefined): Promise<ContainerDriver>;
  encodeVideo(
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
  ): Promise<void>;
  encodeAudio(
    frames: ReadableStream<AudioData>,
    target: AudioTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    options: CallOptions,
  ): Promise<void>;
}

export async function runEncode(
  context: EncodeRunnerContext,
  frames: MediaStreams,
  opts: EncodeOptions,
  options: CallOptions,
  signal: AbortSignal,
): Promise<Output> {
  const target = chooseOutputContainer(opts.to, undefined);
  if (target === 'wav') {
    const { encodeWavFrames } = await import('./wav-frame-encode.ts');
    const stream = await encodeWavFrames(
      {
        createMuxer: async () =>
          (await context.muxer(target, options.strategy?.pinDriver)).createMuxer(
            muxOptionsFrom(opts, target),
          ),
      },
      frames,
      opts,
      signal,
      options,
    );
    return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, target));
  }
  if (!containerHasChunkMuxer(target)) {
    throw new CapabilityError(`no muxer '${target}'`, {
      op: { kind: 'route', id: 'encode' },
      tried: [target],
    });
  }
  if (!frames.video && !frames.audio) {
    throw new InputError('encode needs streams');
  }
  if (frames.video && !opts.video) {
    await cancelStream(frames.video);
    throw new InputError('video target missing');
  }
  if (frames.audio && !opts.audio) {
    await cancelStream(frames.audio);
    throw new InputError('audio target missing');
  }
  const muxer = (await context.muxer(target, options.strategy?.pinDriver)).createMuxer(
    muxOptionsFrom(opts, target),
  );
  const tasks: Promise<void>[] = [];
  if (frames.video && opts.video) {
    tasks.push(context.encodeVideo(frames.video, opts.video, undefined, muxer, signal, options));
  }
  if (frames.audio && opts.audio) {
    tasks.push(context.encodeAudio(frames.audio, opts.audio, undefined, muxer, signal, options));
  }
  await allOrCancel(tasks, frames);
  await muxer.finalize();
  return materializeOutput(opts.sink ?? toBlob(), muxer.output, mimeOpts(signal, target));
}
