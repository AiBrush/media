/** Nested objective-video-quality validation shared by the public declarative-job target schema. */

import { InputError } from '../contracts/errors.ts';
import {
  allowedKeys,
  finiteNumber,
  optionalEnum,
  plainRecord,
  positiveInteger,
} from './job-schema-values.ts';

const MAX_VIDEO_QUALITY_SAMPLES = 256;

export function validateVideoQualityConstraint(value: unknown, label: string): void {
  const quality = plainRecord(value, label);
  allowedKeys(quality, ['metric', 'minimumMean', 'samples'], label);
  optionalEnum(quality.metric, ['ssim-luma-v1'], `${label}.metric`, false);
  const minimumMean = finiteNumber(quality.minimumMean, `${label}.minimumMean`);
  if (minimumMean < 0 || minimumMean > 1) {
    throw new InputError(`${label}.minimumMean must be in [0, 1]`);
  }
  if (quality.samples !== undefined) {
    const samples = positiveInteger(quality.samples, `${label}.samples`);
    if (samples > MAX_VIDEO_QUALITY_SAMPLES) {
      throw new InputError(`${label}.samples must be in [1, ${MAX_VIDEO_QUALITY_SAMPLES}]`);
    }
  }
}
