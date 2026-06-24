/**
 * Audio-dsp public surface — pure-TS PCM transforms (doc 09 §audio-dsp). Format/endianness conversion,
 * gain, and BS.775 channel mix run here in kilobytes of TS; true resample + lossy encode arrive on the
 * WASM tail (Phase 2). The browser `AudioData` filter seam wraps these kernels (Phase 1 browser layer).
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
