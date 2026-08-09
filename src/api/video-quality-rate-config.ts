/** Pure eager projection of the objective-quality rate tuple into WebCodecs quantizer mode. */

import { CapabilityError, InputError } from '../contracts/errors.ts';
import type { VideoCodec, VideoTarget } from './types.ts';

type QualityRateTarget = Pick<
  VideoTarget,
  'bitrate' | 'maxAverageBitrate' | 'quality' | 'bitrateMode' | 'crf' | 'twoPass'
>;

function positiveSafeRate(value: number | undefined, label: string): asserts value is number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new InputError(`${label} must be a positive safe integer`);
  }
}

export function qualityConstrainedEncoderRateConfig(
  target: QualityRateTarget,
  codec: VideoCodec | 'unknown',
): { readonly bitrateMode: 'quantizer' } | undefined {
  if (target.quality === undefined && target.maxAverageBitrate === undefined) return undefined;
  positiveSafeRate(target.bitrate, 'quality-constrained bitrate');
  positiveSafeRate(target.maxAverageBitrate, 'maxAverageBitrate');
  if (target.quality === undefined) {
    throw new InputError('quality-constrained video encode needs an objective quality constraint');
  }
  if (target.maxAverageBitrate < target.bitrate) {
    throw new InputError('maxAverageBitrate must be at least bitrate');
  }
  if (
    target.crf !== undefined ||
    target.bitrateMode !== undefined ||
    target.twoPass !== undefined
  ) {
    throw new InputError('quality-constrained bitrate conflicts with other rate-control modes');
  }
  if (codec !== 'h264') {
    throw new CapabilityError(
      `quality-constrained video encode is currently available only for H.264, not ${codec}`,
      { op: { kind: 'route', id: 'encode' }, tried: ['webcodecs-video'] },
    );
  }
  return { bitrateMode: 'quantizer' };
}
