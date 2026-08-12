/**
 * General public decode orchestration. The lightweight decode dispatcher loads this module only when the
 * source is not an explicitly hinted raw-PCM container, keeping image sniffing and codec-pipeline setup
 * out of the WAV/AIFF/CAF cold path.
 */

import type { ImageOps } from '../codecs/image/index.ts';
import type { StageOptions } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { type LiveMediaSource, isLiveMediaSource } from '../sources/live-source.ts';
import {
  type MediaInput,
  type NormalizedSource,
  type Source,
  cancelSource,
  from as normalizeInput,
} from '../sources/source.ts';
import { decoderConfigWithRoutedAcceleration } from './codec-route.ts';
import type { DecodeRunner, DecodeRunnerContext } from './decode-runner.ts';
import { memoizeAsync } from './frame-streams.ts';
import { isRawPcmTrack, stageStrategy } from './op-support.ts';
import { readAllSource, sourceMayBeHlsManifest } from './source-io.ts';
import type { DecodeOptions } from './types.ts';

interface ImageDecodeRoute {
  readonly ops: ImageOps;
  readonly bytes: Uint8Array;
}

type ImageDecodeRouteLoader = () => Promise<ImageDecodeRoute | undefined>;

export function createGeneralDecodeRunner(
  context: DecodeRunnerContext,
  input: MediaInput,
  normalized: NormalizedSource,
  options: DecodeOptions,
  signal: AbortSignal,
): DecodeRunner {
  if (isLiveMediaSource(normalized)) {
    return liveDecodeRunner(context, normalized, options, signal);
  }

  const source = context.cacheSource(normalized);
  const stage = context.stage(signal, options);
  const resolvedInputSource = memoizeAsync(async () => {
    if (options.strategy?.pinDriver !== undefined) await context.ensurePin(options);
    return context.resolveHls(input, source, signal);
  });
  const replayableSource = memoizeAsync(async (): Promise<Source> => {
    const resolved = await resolvedInputSource();
    if (resolved.kind !== 'stream') return resolved;
    const bytes = await readAllSource(resolved, signal);
    return normalizeInput(
      bytes,
      resolved.mimeHint === undefined ? {} : { mime: resolved.mimeHint },
    );
  });
  const mime = source.mimeHint?.toLowerCase();
  const imageRoute: ImageDecodeRouteLoader =
    mime === undefined
      ? sourceMayBeHlsManifest(source)
        ? memoizeAsync(() =>
            imageDecodeRoute(context, resolvedInputSource, signal, stage.determinism ?? 'auto'),
          )
        : noImageDecodeRoute
      : !/^(?:audio|video)\//.test(mime)
        ? memoizeAsync(() =>
            imageDecodeRoute(context, resolvedInputSource, signal, stage.determinism ?? 'auto'),
          )
        : noImageDecodeRoute;

  return {
    video: async () => {
      const image = await imageRoute();
      if (image !== undefined) {
        if (!(await selectedImageTrack('video', options.trackSelect))) return undefined;
        return image.ops.decode(image.bytes, stage.signal ? { signal: stage.signal } : {});
      }
      return decodeTrack(context, await replayableSource(), 'video', stage, options.trackSelect);
    },
    audio: async () => {
      if ((await imageRoute()) !== undefined) {
        await selectedImageTrack('audio', options.trackSelect);
        return undefined;
      }
      return decodeTrack(context, await replayableSource(), 'audio', stage, options.trackSelect);
    },
  };
}

function liveDecodeRunner(
  context: DecodeRunnerContext,
  source: LiveMediaSource,
  options: DecodeOptions,
  signal: AbortSignal,
): DecodeRunner {
  const streams = memoizeAsync(async () => {
    if (options.trackSelect !== undefined && options.trackSelect.length > 0) {
      throw new InputError('decode trackSelect is unavailable for a live MediaStream input');
    }
    if (options.strategy?.pinDriver !== undefined) await context.ensurePin(options);
    const { decodeLiveMediaStream } = await import('../sources/live-media.ts');
    return decodeLiveMediaStream(source, { signal });
  });
  return {
    video: async () => (await streams()).video,
    audio: async () => (await streams()).audio,
  };
}

const noImageDecodeRoute: ImageDecodeRouteLoader = () => Promise.resolve(undefined);

async function selectedImageTrack(
  mediaType: 'video' | 'audio',
  selectors: readonly string[] | undefined,
): Promise<boolean> {
  if (selectors === undefined || selectors.length === 0) return mediaType === 'video';
  const { selectDecodeTrackInfo } = await import('./track-select.ts');
  return (
    selectDecodeTrackInfo([{ mediaType: 'video' }] as const, mediaType, selectors) !== undefined
  );
}

async function imageDecodeRoute(
  context: DecodeRunnerContext,
  source: () => Promise<Source>,
  signal: AbortSignal,
  determinism: StageOptions['determinism'],
): Promise<ImageDecodeRoute | undefined> {
  const resolved = await source();
  const ops = await context.imageOps(resolved, signal);
  if (ops === undefined) return undefined;
  if (determinism === 'force-software') {
    const error = new CapabilityError(
      'force-software image decode has no proved software substrate',
      {
        op: { kind: 'route', id: 'decode', facts: { mediaType: 'video', source: 'image' } },
        tried: ['image-decoder'],
      },
    );
    await cancelSource(resolved, error);
    throw error;
  }
  return { ops, bytes: await readAllSource(resolved, signal) };
}

async function applyDisplayRotation(
  context: DecodeRunnerContext,
  frames: ReadableStream<VideoFrame>,
  rotation: number | undefined,
  stage: StageOptions,
): Promise<ReadableStream<VideoFrame>> {
  if (rotation === undefined || rotation === 0) return frames;
  const { applyDecodedDisplayRotation } = await import('./decoded-display-rotation.ts');
  return applyDecodedDisplayRotation(frames, rotation, stage, (spec) =>
    context.routeFilter(spec, { strategy: stageStrategy(stage) }),
  );
}

type RawFrameOf<M extends 'video' | 'audio'> = M extends 'video' ? VideoFrame : AudioData;

async function decodeTrack<M extends 'video' | 'audio'>(
  context: DecodeRunnerContext,
  source: Source,
  mediaType: M,
  stage: StageOptions,
  selectors: readonly string[] | undefined,
): Promise<ReadableStream<RawFrameOf<M>> | undefined> {
  const container = await context.routeContainer(source, stage.signal, stage.pinDriver);
  if (
    (selectors === undefined || selectors.length === 0) &&
    mediaType === 'audio' &&
    (container.decodePcmInterleavedStream !== undefined ||
      container.decodePcmAudioStream !== undefined)
  ) {
    const { interleavedPcmChunksToAudioDataStream, pcmAudioChunksToAudioDataStream } = await import(
      '../dsp/audio-data.ts'
    );
    if (container.decodePcmInterleavedStream !== undefined) {
      const chunks = await container.decodePcmInterleavedStream(source, stage);
      return interleavedPcmChunksToAudioDataStream(chunks, stage, container.id) as ReadableStream<
        RawFrameOf<M>
      >;
    }
    if (container.decodePcmAudioStream !== undefined) {
      const chunks = await container.decodePcmAudioStream(source, stage);
      return pcmAudioChunksToAudioDataStream(chunks, stage, container.id, 'f32') as ReadableStream<
        RawFrameOf<M>
      >;
    }
  }

  const demuxer = await container.demux(source, stage);
  let track: (typeof demuxer.tracks)[number] | undefined;
  try {
    track =
      selectors !== undefined && selectors.length > 0
        ? (await import('./track-select.ts')).selectDecodeTrackInfo(
            demuxer.tracks,
            mediaType,
            selectors,
          )
        : demuxer.tracks.find(
            (candidate) => candidate.mediaType === mediaType && candidate.config !== undefined,
          );
  } catch (error) {
    await demuxer.close();
    throw error;
  }
  if (!track) {
    await demuxer.close();
    return undefined;
  }
  if (track.config === undefined) {
    await demuxer.close();
    throw new MediaError('decode-error', `track ${track.id} has no decoder config`);
  }
  if (track.encrypted === true) {
    await demuxer.close();
    throw new MediaError('decode-error', `protected ${mediaType} needs decrypt()`);
  }
  if (
    mediaType === 'audio' &&
    container.decodePcmAudio &&
    (isRawPcmTrack(track) || track.codec === 'flac')
  ) {
    await demuxer.close();
    const {
      interleavedPcmChunksToAudioDataStream,
      pcmAudioChunksToAudioDataStream,
      pcmAudioToAudioDataStream,
    } = await import('../dsp/audio-data.ts');
    if (container.decodePcmInterleavedStream !== undefined) {
      const chunks = await container.decodePcmInterleavedStream(source, stage);
      return interleavedPcmChunksToAudioDataStream(chunks, stage, track.codec) as ReadableStream<
        RawFrameOf<M>
      >;
    }
    if (container.decodePcmAudioStream !== undefined) {
      const chunks = await container.decodePcmAudioStream(source, stage);
      return pcmAudioChunksToAudioDataStream(chunks, stage, track.codec, 'f32') as ReadableStream<
        RawFrameOf<M>
      >;
    }
    const audio = await container.decodePcmAudio(source, stage);
    return pcmAudioToAudioDataStream(audio, stage, track.codec, 'f32') as ReadableStream<
      RawFrameOf<M>
    >;
  }

  const {
    decodeQueryFor,
    decodeVideoPacketsWithAlpha,
    decodedAudioStreamWithGapless,
    unwrapPackets,
    vpxAlphaDecodeSoftwareDriverForRuntime,
  } = await import('./codec-pipeline.ts');
  const decodeQuery = await decodeQueryFor(track);
  const route = await context.probeCodec(decodeQuery, {
    strategy: stageStrategy(stage),
  });
  const codec = route.driver;
  const config = decoderConfigWithRoutedAcceleration(decodeQuery.config, route.support);
  /* v8 ignore start -- requires a real VideoDecoder/AudioDecoder; browser-harness validated. */
  if (mediaType === 'video' && track.alpha === true) {
    const alphaSoftwareDriver =
      stage.pinDriver === undefined
        ? await vpxAlphaDecodeSoftwareDriverForRuntime(codec.id)
        : undefined;
    const alphaRoute =
      alphaSoftwareDriver === undefined
        ? route
        : await context.probeCodec(decodeQuery, {
            strategy: { ...stageStrategy(stage), pinDriver: alphaSoftwareDriver },
          });
    const alphaCodec = alphaRoute.driver;
    const alphaConfig = decoderConfigWithRoutedAcceleration(decodeQuery.config, alphaRoute.support);
    const alphaStage: StageOptions =
      alphaSoftwareDriver === undefined ? stage : { ...stage, pinDriver: alphaSoftwareDriver };
    const decodedWithAlpha = decodeVideoPacketsWithAlpha(
      demuxer.packets(track.id),
      () => codec.createDecoder(config, stage),
      () => alphaCodec.createDecoder(alphaConfig, alphaStage),
    );
    return (await applyDisplayRotation(
      context,
      decodedWithAlpha,
      track.rotation,
      stage,
    )) as ReadableStream<RawFrameOf<M>>;
  }
  const decoded = unwrapPackets(demuxer.packets(track.id)).pipeThrough(
    codec.createDecoder(config, stage),
  ) as ReadableStream<RawFrameOf<M>>;
  if (mediaType === 'audio') {
    return (await decodedAudioStreamWithGapless(decoded as ReadableStream<AudioData>, track, {
      packets: demuxer.packets(track.id),
      createDecoder: () => codec.createDecoder(config, stage),
      signal: stage.signal,
    })) as ReadableStream<RawFrameOf<M>>;
  }
  return (await applyDisplayRotation(
    context,
    decoded as ReadableStream<VideoFrame>,
    track.rotation,
    stage,
  )) as ReadableStream<RawFrameOf<M>>;
  /* v8 ignore stop */
}
