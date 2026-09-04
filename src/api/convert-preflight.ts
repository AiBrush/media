/**
 * Target-only convert capability preflight, lazy because it is not part of conversion's hot path.
 */

import type { CodecQuery, ContainerDriver } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { isPcmContainer } from './codec-routing.ts';
import { isFlacAuthorCodec, isPcmCodec } from './op-support.ts';
import type { ConvertOptions, VideoTarget } from './types.ts';

export interface ConvertPreflightContext {
  muxer(target: string): Promise<ContainerDriver>;
  probeCodec(query: CodecQuery): Promise<void>;
}

export async function preflightConvert(
  context: ConvertPreflightContext,
  opts: ConvertOptions,
): Promise<void> {
  const audio = opts.audio;
  const video = opts.video;
  const wantsVideo = video !== undefined && video !== false;
  const pcmFamilyTarget =
    opts.to !== undefined &&
    audio !== false &&
    ((opts.to === 'flac' && isFlacAuthorCodec(audio?.codec)) ||
      (isPcmContainer(opts.to) && isPcmCodec(audio?.codec)));
  if (pcmFamilyTarget) {
    if (!wantsVideo) return;
    throw new CapabilityError(`no video track fits '${opts.to}'`, {
      op: { kind: 'route', id: 'convert' },
      tried: [opts.to as string],
    });
  }
  if (audio !== undefined && audio !== false && audio.mixMatrix !== undefined) {
    throw new CapabilityError(
      'audio mixMatrix requires an explicit PCM-native WAV/AIFF/CAF/FLAC target',
      { op: { kind: 'route', id: 'convert' }, tried: opts.to === undefined ? [] : [opts.to] },
    );
  }
  if (opts.to !== undefined) {
    await context.muxer(opts.to);
  }
  // A codec-only video target may be satisfied by copying the source's own packets (the runner decides
  // once it has demuxed), so an encoder is probed here only when the request also transforms video.
  if (wantsVideo && video.codec !== undefined && videoTargetTransforms(video)) {
    const { preflightVideoEncodeQuery } = await import('./preload.ts');
    await context.probeCodec(preflightVideoEncodeQuery(video.codec));
  }
  if (audio !== undefined && audio !== false && audio.codec !== undefined) {
    const { preflightAudioEncodeQuery } = await import('./preload.ts');
    await context.probeCodec(preflightAudioEncodeQuery(audio.codec));
  }
}

export async function canConvert(
  context: ConvertPreflightContext,
  opts: ConvertOptions,
): Promise<boolean> {
  try {
    await preflightConvert(context, opts);
    return true;
  } catch (error) {
    if (error instanceof MediaError) return false;
    throw error;
  }
}

const VIDEO_TRANSFORM_KEYS = [
  'width', 'height', 'fit', 'fps', 'bitrate', 'maxAverageBitrate', 'quality', 'bitrateMode', 'crf',
  'twoPass', 'bitDepth', 'alpha', 'rotate', 'flip', 'crop', 'pad', 'colorspace', 'tonemap',
] as const;

function videoTargetTransforms(target: VideoTarget): boolean {
  return VIDEO_TRANSFORM_KEYS.some((key) => target[key] !== undefined);
}
