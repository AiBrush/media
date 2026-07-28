/**
 * Transform-only WAV dependency boundary. Keeping this graph behind one dynamic import prevents raw
 * decode/probe from instantiating the general DSP, AIFF/CAF writers, and specialized rewrite paths.
 */

export { resolvePcmSampleFormat, writePcmContainer } from '../pcm-output.ts';
export { applyPcmTransform } from '../pcm-transform.ts';
export { tryRewriteWavPcmToAiffBe } from './aiff-rewrite.ts';
export { tryConvertWavPcmFormatToWav } from './format-convert.ts';
export { readWavPcm } from './pcm.ts';
