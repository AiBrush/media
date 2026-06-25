/**
 * Audio-dsp public surface — pure-TS PCM transforms (doc 09 §audio-dsp). Format/endianness conversion,
 * gain, BS.775 channel mix, band-limited windowed-sinc resample, fade/cross-fade,
 * normalize/limiter dynamics, and RBJ-cookbook biquad/parametric-EQ run here in kilobytes of TS; only
 * lossy encode arrives on the WASM tail. The browser `AudioData` filter seam wraps these kernels.
 */

export {
  type Endianness,
  type PcmAudio,
  type SampleFormat,
  bytesPerSample,
  channelAt,
  decodePcm,
  encodePcm,
  sampleAt,
} from './pcm.ts';
export { dbToLinear, gain } from './gain.ts';
export { remix } from './mix.ts';
export { resample } from './resample.ts';
export { type FadeShape, crossfade, fadeIn, fadeOut } from './fade.ts';
export { type LimitMode, limit, normalizePeak, normalizeRms } from './dynamics.ts';
export {
  type BiquadCoeffs,
  type BiquadSpec,
  type BiquadType,
  biquad,
  designBiquad,
  magnitudeResponse,
  polesInsideUnitCircle,
} from './biquad.ts';
