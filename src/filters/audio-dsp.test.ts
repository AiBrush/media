import { describe, expect, it } from 'vitest';
import type { FilterSpec } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { biquad } from '../dsp/biquad.ts';
import { limit, normalizePeak } from '../dsp/dynamics.ts';
import { fadeOut } from '../dsp/fade.ts';
import { type PcmAudio, channelAt, sampleAt } from '../dsp/pcm.ts';
import { Registry } from '../kernel/registry.ts';
import {
  AudioDspFilterModule,
  type StatelessAudioSpec,
  applyAudioFilter,
  audioDataToPcm,
  audioDspFilterDriver,
  createStatefulStage,
  isAudioDspSpec,
  isStatefulAudioSpec,
  pcmRangeToPlanarInit,
  pcmToPlanarInit,
} from './audio-dsp.ts';

/**
 * A minimal duck-typed stand-in for a browser `AudioData` with `f32-planar` storage, exposing exactly
 * the read surface {@link audioDataToPcm} uses. Real and can-fail: known per-plane samples must survive
 * the copy-out unchanged. (`AudioData` itself is browser-only and cannot be constructed in Node.)
 */
function fakeAudioData(planes: number[][], sampleRate: number, timestamp = 0): AudioData {
  const numberOfChannels = planes.length;
  const numberOfFrames = planes[0]?.length ?? 0;
  let closed = false;
  const stub = {
    format: 'f32-planar' as const,
    sampleRate,
    numberOfChannels,
    numberOfFrames,
    timestamp,
    duration: numberOfFrames === 0 ? 0 : (numberOfFrames / sampleRate) * 1e6,
    get closedFlag(): boolean {
      return closed;
    },
    allocationSize(options: AudioDataCopyToOptions): number {
      return (planes[options.planeIndex]?.length ?? 0) * 4;
    },
    copyTo(destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void {
      if (options.format !== undefined && options.format !== 'f32-planar') {
        throw new Error(`fakeAudioData only serves f32-planar, got ${options.format}`);
      }
      const src = planes[options.planeIndex] ?? [];
      const view = new Float32Array(
        (destination as ArrayBufferView).buffer,
        (destination as ArrayBufferView).byteOffset,
        src.length,
      );
      view.set(src);
    },
    clone(): AudioData {
      throw new Error('not used');
    },
    close(): void {
      closed = true;
    },
  };
  return stub as unknown as AudioData;
}

const RESAMPLE_48K: StatelessAudioSpec = {
  mediaType: 'audio',
  type: 'resample',
  sampleRate: 48000,
};
const REMIX_STEREO: StatelessAudioSpec = { mediaType: 'audio', type: 'remix', channels: 2 };
const GAIN_HALF: StatelessAudioSpec = { mediaType: 'audio', type: 'gain', db: -6.020599913279624 }; // ×0.5

/** Power at exactly `freq` via a Goertzel-style projection (no FFT dependency). */
function powerAt(x: Float64Array, freq: number, rate: number): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * freq) / rate;
  for (let n = 0; n < x.length; n++) {
    const v = sampleAt(x, n);
    re += v * Math.cos(w * n);
    im += v * Math.sin(w * n);
  }
  return Math.sqrt(re * re + im * im) / (x.length > 0 ? x.length / 2 : 1);
}

const FADE_SPEC: FilterSpec = {
  mediaType: 'audio',
  type: 'fade',
  curve: 'equal-power',
  inFrames: 0,
  outFrames: 200,
};
const BIQUAD_SPEC: FilterSpec = {
  mediaType: 'audio',
  type: 'biquad',
  spec: { type: 'highpass', frequency: 300, q: Math.SQRT1_2 },
};
const DYNAMICS_SPEC: FilterSpec = {
  mediaType: 'audio',
  type: 'dynamics',
  dynamics: {
    normalize: { mode: 'peak', targetDbfs: -3 },
    limit: { ceilingDbfs: -1, mode: 'hard' },
  },
};

/** Drive a stateful stage over one whole buffer and concatenate its emitted chunks (single-chunk path). */
function driveWhole(stage: ReturnType<typeof createStatefulStage>, audio: PcmAudio): PcmAudio {
  const out = [...stage.push(audio), ...stage.flush()];
  const frames = out.reduce((s, c) => s + c.frames, 0);
  const planar = Array.from({ length: audio.channels }, () => new Float64Array(frames));
  let pos = 0;
  for (const c of out) {
    for (let ch = 0; ch < audio.channels; ch++)
      planar[ch]?.set(c.planar[ch] ?? new Float64Array(0), pos);
    pos += c.frames;
  }
  return { sampleRate: audio.sampleRate, channels: audio.channels, frames, planar };
}

describe('audio-dsp filter — spec matching', () => {
  it('isAudioDspSpec accepts every audio spec (stateless and stateful) and rejects video specs', () => {
    expect(isAudioDspSpec(RESAMPLE_48K)).toBe(true);
    expect(isAudioDspSpec(REMIX_STEREO)).toBe(true);
    expect(isAudioDspSpec(GAIN_HALF)).toBe(true);
    expect(isAudioDspSpec(FADE_SPEC)).toBe(true);
    expect(isAudioDspSpec(BIQUAD_SPEC)).toBe(true);
    expect(isAudioDspSpec(DYNAMICS_SPEC)).toBe(true);
    expect(isAudioDspSpec({ mediaType: 'video', type: 'flip', axis: 'h' })).toBe(false);
    expect(isAudioDspSpec({ mediaType: 'video', type: 'resize', width: 2, height: 2 })).toBe(false);
  });

  it('isStatefulAudioSpec classifies fade/biquad/dynamics as stateful and the rest as stateless', () => {
    if (!isAudioDspSpec(FADE_SPEC) || !isAudioDspSpec(GAIN_HALF)) throw new Error('unreachable');
    expect(isStatefulAudioSpec(FADE_SPEC)).toBe(true);
    if (isAudioDspSpec(BIQUAD_SPEC)) expect(isStatefulAudioSpec(BIQUAD_SPEC)).toBe(true);
    if (isAudioDspSpec(DYNAMICS_SPEC)) expect(isStatefulAudioSpec(DYNAMICS_SPEC)).toBe(true);
    expect(isStatefulAudioSpec(GAIN_HALF)).toBe(false);
    if (isAudioDspSpec(RESAMPLE_48K)) expect(isStatefulAudioSpec(RESAMPLE_48K)).toBe(false);
    if (isAudioDspSpec(REMIX_STEREO)) expect(isStatefulAudioSpec(REMIX_STEREO)).toBe(false);
  });
});

describe('audio-dsp filter — createStatefulStage (the staged transform, real & can-fail)', () => {
  const tone = (frames: number): PcmAudio => {
    const ch = new Float64Array(frames);
    for (let n = 0; n < frames; n++) ch[n] = 0.7 * Math.sin((2 * Math.PI * 440 * n) / 48000);
    return { sampleRate: 48000, channels: 1, frames, planar: [ch] };
  };

  it('builds a fade stage that matches the whole-signal fadeOut', () => {
    if (!isAudioDspSpec(FADE_SPEC) || !isStatefulAudioSpec(FADE_SPEC))
      throw new Error('unreachable');
    const sig = tone(1000);
    const got = driveWhole(createStatefulStage(FADE_SPEC, sig.sampleRate), sig);
    const ref = fadeOut(sig, 200, 'equal-power');
    for (let i = 0; i < sig.frames; i++) {
      expect(sampleAt(channelAt(got.planar, 0), i)).toBeCloseTo(
        sampleAt(channelAt(ref.planar, 0), i),
        12,
      );
    }
  });

  it('builds a biquad stage (designed at the live rate) that matches the whole-signal biquad', () => {
    if (!isAudioDspSpec(BIQUAD_SPEC) || !isStatefulAudioSpec(BIQUAD_SPEC))
      throw new Error('unreachable');
    const sig = tone(1000);
    const got = driveWhole(createStatefulStage(BIQUAD_SPEC, sig.sampleRate), sig);
    const ref = biquad(sig, { type: 'highpass', frequency: 300, q: Math.SQRT1_2 });
    for (let i = 0; i < sig.frames; i++) {
      expect(sampleAt(channelAt(got.planar, 0), i)).toBeCloseTo(
        sampleAt(channelAt(ref.planar, 0), i),
        9,
      );
    }
  });

  it('builds a dynamics stage that matches whole-signal normalize→limit', () => {
    if (!isAudioDspSpec(DYNAMICS_SPEC) || !isStatefulAudioSpec(DYNAMICS_SPEC))
      throw new Error('unreachable');
    const sig = tone(1000);
    const got = driveWhole(createStatefulStage(DYNAMICS_SPEC, sig.sampleRate), sig);
    const ref = limit(normalizePeak(sig, -3), -1, 'hard');
    for (let i = 0; i < sig.frames; i++) {
      expect(sampleAt(channelAt(got.planar, 0), i)).toBeCloseTo(
        sampleAt(channelAt(ref.planar, 0), i),
        12,
      );
    }
  });
});

describe('audio-dsp filter — applyAudioFilter (the pure transform, real & can-fail)', () => {
  it('resample changes the sample rate and frame count and keeps the tone', () => {
    const inRate = 44100;
    const frames = Math.round(inRate * 0.1);
    const ch = new Float64Array(frames);
    const w = (2 * Math.PI * 1000) / inRate;
    for (let n = 0; n < frames; n++) ch[n] = 0.5 * Math.sin(w * n);
    const out = applyAudioFilter(
      { sampleRate: inRate, channels: 1, frames, planar: [ch] },
      RESAMPLE_48K,
    );
    expect(out.sampleRate).toBe(48000);
    expect(out.frames).toBe(Math.round((frames * 48000) / inRate));
    expect(powerAt(channelAt(out.planar, 0), 1000, 48000)).toBeGreaterThan(0.45);
  });

  it('remix mono → stereo duplicates the channel', () => {
    const mono = Float64Array.of(0.1, -0.2, 0.3);
    const out = applyAudioFilter(
      { sampleRate: 48000, channels: 1, frames: 3, planar: [mono] },
      REMIX_STEREO,
    );
    expect(out.channels).toBe(2);
    expect(channelAt(out.planar, 0)).toEqual(mono);
    expect(channelAt(out.planar, 1)).toEqual(mono);
  });

  it('gain of -6.0206 dB halves every sample', () => {
    const ch = Float64Array.of(1, 0.5, -0.4, 0.8);
    const out = applyAudioFilter(
      { sampleRate: 48000, channels: 1, frames: 4, planar: [ch] },
      GAIN_HALF,
    );
    const got = channelAt(out.planar, 0);
    for (let i = 0; i < ch.length; i++) {
      expect(sampleAt(got, i)).toBeCloseTo(sampleAt(ch, i) * 0.5, 12);
    }
  });
});

describe('audio-dsp filter — AudioData ↔ PcmAudio framing (pure)', () => {
  it('audioDataToPcm reads every planar channel into the canonical Float64 buffer', () => {
    const data = fakeAudioData(
      [
        [0, 0.25, -0.5, 1],
        [-1, -0.25, 0.5, 0.75],
      ],
      44100,
      1_000_000,
    );
    const pcm = audioDataToPcm(data);
    expect(pcm.sampleRate).toBe(44100);
    expect(pcm.channels).toBe(2);
    expect(pcm.frames).toBe(4);
    expect(Array.from(channelAt(pcm.planar, 0))).toEqual([0, 0.25, -0.5, 1]);
    expect(Array.from(channelAt(pcm.planar, 1))).toEqual([-1, -0.25, 0.5, 0.75]);
  });

  it('pcmToPlanarInit lays out channel-major f32-planar data with the right header', () => {
    const audio = {
      sampleRate: 48000,
      channels: 2,
      frames: 3,
      planar: [Float64Array.of(0.1, 0.2, 0.3), Float64Array.of(-0.1, -0.2, -0.3)],
    };
    const { init, data } = pcmToPlanarInit(audio, 2_000_000);
    expect(init.format).toBe('f32-planar');
    expect(init.sampleRate).toBe(48000);
    expect(init.numberOfChannels).toBe(2);
    expect(init.numberOfFrames).toBe(3);
    expect(init.timestamp).toBe(2_000_000);
    // Channel-major: [ch0 frame0..2, ch1 frame0..2], as f32 (compare via Math.fround).
    expect(data.length).toBe(6);
    expect(Array.from(data)).toEqual([0.1, 0.2, 0.3, -0.1, -0.2, -0.3].map((v) => Math.fround(v)));
    expect(init.data).toBe(data.buffer);
  });

  it('pcmRangeToPlanarInit lays out a bounded frame window for chunked decode output', () => {
    const audio = {
      sampleRate: 48000,
      channels: 2,
      frames: 5,
      planar: [
        Float64Array.of(0.1, 0.2, 0.3, 0.4, 0.5),
        Float64Array.of(-0.1, -0.2, -0.3, -0.4, -0.5),
      ],
    };
    const { init, data } = pcmRangeToPlanarInit(audio, 1, 3, 20_833);
    expect(init.format).toBe('f32-planar');
    expect(init.sampleRate).toBe(48000);
    expect(init.numberOfChannels).toBe(2);
    expect(init.numberOfFrames).toBe(3);
    expect(init.timestamp).toBe(20_833);
    expect(Array.from(data)).toEqual([0.2, 0.3, 0.4, -0.2, -0.3, -0.4].map((v) => Math.fround(v)));
  });

  it('round-trips a known buffer: AudioData → PcmAudio → planar init reproduces the samples', () => {
    const data = fakeAudioData([[0.5, -0.5, 0.25, -0.25]], 16000, 7);
    const pcm = audioDataToPcm(data);
    const { init, data: out } = pcmToPlanarInit(pcm, data.timestamp);
    expect(init.numberOfFrames).toBe(4);
    expect(init.sampleRate).toBe(16000);
    expect(init.timestamp).toBe(7);
    expect(Array.from(out)).toEqual([0.5, -0.5, 0.25, -0.25].map((v) => Math.fround(v)));
  });

  it('end-to-end pure path: gain halves a stub AudioData buffer through the full framing', () => {
    const data = fakeAudioData([[1, 0.5, -0.4]], 48000, 0);
    const transformed = applyAudioFilter(audioDataToPcm(data), GAIN_HALF);
    const { data: out } = pcmToPlanarInit(transformed, data.timestamp);
    expect(Array.from(out)).toEqual([0.5, 0.25, -0.2].map((v) => Math.fround(v)));
  });

  it('handles an empty AudioData (zero frames) without crashing', () => {
    const data = fakeAudioData([[]], 48000, 0);
    const pcm = audioDataToPcm(data);
    expect(pcm.frames).toBe(0);
    const { init, data: out } = pcmToPlanarInit(pcm, 0);
    expect(init.numberOfFrames).toBe(0);
    expect(out.length).toBe(0);
  });
});

describe('audio-dsp filter — driver surface', () => {
  it('declares kind/substrate and matches only the audio specs in supports()', () => {
    expect(audioDspFilterDriver.kind).toBe('filter');
    expect(audioDspFilterDriver.substrate).toBe('native');
    // supports() is also gated on AudioData availability, which is absent in Node → false here.
    const audioDataPresent = typeof AudioData !== 'undefined';
    expect(audioDspFilterDriver.supports(RESAMPLE_48K)).toBe(audioDataPresent);
    expect(audioDspFilterDriver.supports({ mediaType: 'video', type: 'flip', axis: 'v' })).toBe(
      false,
    );
  });

  it('createFilter fails fast with a typed CapabilityError when AudioData is unavailable (Node)', () => {
    if (typeof AudioData !== 'undefined') return; // browser path is validated in the browser harness
    expect(() => audioDspFilterDriver.createFilter(RESAMPLE_48K)).toThrow(CapabilityError);
  });

  it('createFilter rejects a non-audio spec with a typed CapabilityError', () => {
    expect(() =>
      audioDspFilterDriver.createFilter({ mediaType: 'video', type: 'flip', axis: 'h' }),
    ).toThrow(CapabilityError);
  });
});

describe('AudioDspFilterModule — registration', () => {
  it('register() adds the audio-dsp filter driver to a registry', () => {
    const reg = new Registry();
    AudioDspFilterModule.register(reg);
    expect(reg.filters().map((d) => d.id)).toContain(audioDspFilterDriver.id);
  });
});
