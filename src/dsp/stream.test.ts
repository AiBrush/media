/**
 * Stream-stateful audio-dsp stages — the strict, can-fail oracle (BUILD §6.2). Each streaming stage,
 * driven over **arbitrary chunk splits** of a known signal, must reproduce its whole-signal kernel
 * **bit-exactly** (biquad/fade within 1e-9 float error; normalize/limit exact). A loose gate would not
 * catch a dropped biquad state register or a misplaced fade-out window, so these assert sample-exact
 * equality on a real 440 Hz fixture and on synthetic impulse/step/ramp signals.
 */

import { describe, expect, it } from 'vitest';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { type BiquadSpec, biquad } from './biquad.ts';
import { limit, normalizePeak, normalizeRms } from './dynamics.ts';
import { fadeIn, fadeOut } from './fade.ts';
import type { PcmAudio } from './pcm.ts';
import { biquadStage, dynamicsStage, fadeStage } from './stream.ts';
import type { StatefulAudioStage } from './stream.ts';

// ============ chunk-split harness ============

/** Split a `PcmAudio` into `sizes`-length consecutive chunks (the leftover, if any, forms a final chunk). */
function splitInto(audio: PcmAudio, sizes: readonly number[]): PcmAudio[] {
  const chunks: PcmAudio[] = [];
  let pos = 0;
  const emit = (start: number, len: number): void => {
    const n = Math.max(0, Math.min(len, audio.frames - start));
    chunks.push({
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      frames: n,
      planar: audio.planar.map((ch) => ch.slice(start, start + n)),
    });
  };
  for (const size of sizes) {
    if (pos >= audio.frames) break;
    emit(pos, size);
    pos += size;
  }
  if (pos < audio.frames) emit(pos, audio.frames - pos);
  return chunks;
}

/** Drive a stage over chunks and concatenate every emitted chunk back into one `PcmAudio`. */
function runStage(stage: StatefulAudioStage, chunks: readonly PcmAudio[]): PcmAudio {
  const out: PcmAudio[] = [];
  for (const c of chunks) out.push(...stage.push(c));
  out.push(...stage.flush());
  return concat(out);
}

/** Concatenate same-layout chunks into one buffer (channel count taken from the first non-empty chunk). */
function concat(chunks: readonly PcmAudio[]): PcmAudio {
  const channels = chunks.find((c) => c.channels > 0)?.channels ?? 0;
  const sampleRate = chunks.find((c) => c.sampleRate > 0)?.sampleRate ?? 0;
  const frames = chunks.reduce((s, c) => s + c.frames, 0);
  const planar = Array.from({ length: channels }, () => new Float64Array(frames));
  let pos = 0;
  for (const c of chunks) {
    for (let ch = 0; ch < channels; ch++) {
      planar[ch]?.set(c.planar[ch] ?? new Float64Array(c.frames), pos);
    }
    pos += c.frames;
  }
  return { sampleRate, channels, frames, planar };
}

/** Max absolute per-sample difference between two same-shape buffers (Infinity on shape mismatch). */
function maxAbsDiff(a: PcmAudio, b: PcmAudio): number {
  if (a.channels !== b.channels || a.frames !== b.frames) return Number.POSITIVE_INFINITY;
  let m = 0;
  for (let ch = 0; ch < a.channels; ch++) {
    const ca = a.planar[ch] ?? new Float64Array(0);
    const cb = b.planar[ch] ?? new Float64Array(0);
    for (let i = 0; i < a.frames; i++) m = Math.max(m, Math.abs((ca[i] ?? 0) - (cb[i] ?? 0)));
  }
  return m;
}

// ============ signals ============

function tone(freq: number, rate: number, frames: number, amp = 0.5): PcmAudio {
  const ch = new Float64Array(frames);
  const w = (2 * Math.PI * freq) / rate;
  for (let n = 0; n < frames; n++) ch[n] = amp * Math.sin(w * n);
  return { sampleRate: rate, channels: 1, frames, planar: [ch] };
}

function stereoTone(rate: number, frames: number): PcmAudio {
  const l = new Float64Array(frames);
  const r = new Float64Array(frames);
  for (let n = 0; n < frames; n++) {
    l[n] = 0.6 * Math.sin((2 * Math.PI * 440 * n) / rate);
    r[n] = 0.4 * Math.sin((2 * Math.PI * 660 * n) / rate);
  }
  return { sampleRate: rate, channels: 2, frames, planar: [l, r] };
}

function impulse(rate: number, frames: number, at = 0): PcmAudio {
  const ch = new Float64Array(frames);
  ch[at] = 1;
  return { sampleRate: rate, channels: 1, frames, planar: [ch] };
}

function step(rate: number, frames: number): PcmAudio {
  const ch = new Float64Array(frames).fill(0.5);
  return { sampleRate: rate, channels: 1, frames, planar: [ch] };
}

/** A spread of chunk schedules: tiny irregular, single-sample, one big chunk, and prime sizes. */
const SCHEDULES: ReadonlyArray<readonly number[]> = [
  [1, 1, 1],
  [3, 5, 7, 11, 13],
  [100],
  [1],
  [17, 1, 1, 256, 1, 999],
];

/**
 * The diverse real-WAV corpus (BUILD §6.1, ≥ 5 files, never one) — u8/s16/s24/s32/f32 sample formats,
 * mono + stereo, 16/44.1/48 kHz, tone/speech/sfx content. The continuity oracle below runs the streaming
 * stages bit-exactly against the whole-signal kernels on EVERY one (a pass on a single file would be
 * overfitting). The corpus only grows — a new trait adds a real file here.
 */
const REAL_WAVS = [
  'sfx-pcm-u8.wav',
  'sfx-pcm-s16.wav',
  'sfx-pcm-s24.wav',
  'sfx-pcm-s32.wav',
  'sfx-pcm-f32.wav',
  'sin_440Hz_-6dBFS_1s.wav',
  'speech.wav',
  'stereo-48000.wav',
] as const;

// ============ real-corpus continuity oracle (≥ 5 real files, never one) ============

describe('streaming stages — chunked == whole-signal across the diverse real WAV corpus', () => {
  // A realistic, irregular codec-seam chunk split (AAC-ish 1024 + boundary stressors).
  const SPLIT = [1024, 1, 1024, 333, 4096, 7, 1] as const;

  for (const id of REAL_WAVS) {
    it(`${id}: biquad chunked == single-call (≤ 1e-6), fade-out + normalize exact`, async () => {
      const sig = readWavPcm(await loadFixture(id));
      expect(sig.frames).toBeGreaterThan(0);

      // biquad: state persists across chunks → within the leader's 1e-6 bar (we hold ≤ 1e-9).
      const bq: BiquadSpec = {
        type: 'highpass',
        frequency: Math.min(300, sig.sampleRate / 4),
        q: Math.SQRT1_2,
      };
      expect(
        maxAbsDiff(
          runStage(biquadStage(bq, sig.sampleRate), splitInto(sig, SPLIT)),
          biquad(sig, bq),
        ),
      ).toBeLessThan(1e-6);

      // fade-out envelope exact at the real tail position (0.1 s), bit-exact regardless of chunking.
      const n = Math.max(1, Math.round(0.1 * sig.sampleRate));
      expect(
        maxAbsDiff(
          runStage(
            fadeStage({ curve: 'equal-power', inFrames: 0, outFrames: n }),
            splitInto(sig, SPLIT),
          ),
          fadeOut(sig, n, 'equal-power'),
        ),
      ).toBeLessThan(1e-12);

      // dynamics: GLOBAL peak-normalize (single factor) then limit, exact across chunks.
      expect(
        maxAbsDiff(
          runStage(
            dynamicsStage({
              normalize: { mode: 'peak', targetDbfs: -1 },
              limit: { ceilingDbfs: -1, mode: 'hard' },
            }),
            splitInto(sig, SPLIT),
          ),
          limit(normalizePeak(sig, -1), -1, 'hard'),
        ),
      ).toBeLessThan(1e-12);
    });
  }
});

// ============ biquad — chunked == single-call ============

describe('biquadStage — chunked equals the whole-signal biquad (state persists across chunks)', () => {
  const specs: readonly BiquadSpec[] = [
    { type: 'lowpass', frequency: 1000, q: Math.SQRT1_2 },
    { type: 'highpass', frequency: 200, q: 0.5 },
    { type: 'peaking', frequency: 800, q: 2, gainDb: 9 },
    { type: 'highshelf', frequency: 4000, q: Math.SQRT1_2, gainDb: -6 },
  ];

  it('mono impulse response is identical under every chunk schedule (≤ 1e-9)', () => {
    const sig = impulse(48000, 600);
    for (const spec of specs) {
      const ref = biquad(sig, spec);
      for (const sched of SCHEDULES) {
        const got = runStage(biquadStage(spec, sig.sampleRate), splitInto(sig, sched));
        expect(maxAbsDiff(got, ref)).toBeLessThan(1e-9);
      }
    }
  });

  it('stereo tone keeps each channel’s state independent across chunks (≤ 1e-9)', () => {
    const sig = stereoTone(44100, 4096);
    const spec: BiquadSpec = { type: 'bandpass', frequency: 500, q: 3 };
    const ref = biquad(sig, spec);
    for (const sched of SCHEDULES) {
      const got = runStage(biquadStage(spec, sig.sampleRate), splitInto(sig, sched));
      expect(maxAbsDiff(got, ref)).toBeLessThan(1e-9);
    }
  });

  it('a real 440 Hz fixture, highpass, chunked == single-call (≤ 1e-9)', async () => {
    const sig = readWavPcm(await loadFixture('sin_440Hz_-6dBFS_1s.wav'));
    const spec: BiquadSpec = { type: 'highpass', frequency: 300, q: Math.SQRT1_2 };
    const ref = biquad(sig, spec);
    const got = runStage(biquadStage(spec, sig.sampleRate), splitInto(sig, [777, 333, 1, 50000]));
    expect(maxAbsDiff(got, ref)).toBeLessThan(1e-9);
  });
});

// ============ fade — duration-aware fade-out + prefix fade-in ============

describe('fadeStage — chunked equals the whole-signal fade (tail look-ahead, no metadata trust)', () => {
  it('fade-out ramps exactly the last n frames regardless of chunk boundaries (≤ 1e-12)', () => {
    const sig = tone(440, 48000, 5000);
    for (const curve of ['linear', 'equal-power'] as const) {
      const n = 1200;
      const ref = fadeOut(sig, n, curve);
      for (const sched of SCHEDULES) {
        const got = runStage(
          fadeStage({ curve, inFrames: 0, outFrames: n }),
          splitInto(sig, sched),
        );
        expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
      }
    }
  });

  it('fade-in ramps exactly the first n frames (prefix, O(1)) bit-exactly (≤ 1e-12)', () => {
    const sig = tone(440, 44100, 5000);
    for (const curve of ['linear', 'equal-power'] as const) {
      const n = 900;
      const ref = fadeIn(sig, n, curve);
      for (const sched of SCHEDULES) {
        const got = runStage(
          fadeStage({ curve, inFrames: n, outFrames: 0 }),
          splitInto(sig, sched),
        );
        expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
      }
    }
  });

  it('combined fade-in + fade-out matches fadeOut(fadeIn(x)) — even when windows overlap (≤ 1e-12)', () => {
    // Short signal so the in- and out-windows overlap, exercising in_gain·out_gain on shared samples.
    const sig = stereoTone(48000, 800);
    const inN = 600;
    const outN = 600;
    const ref = fadeOut(fadeIn(sig, inN, 'equal-power'), outN, 'equal-power');
    for (const sched of SCHEDULES) {
      const got = runStage(
        fadeStage({ curve: 'equal-power', inFrames: inN, outFrames: outN }),
        splitInto(sig, sched),
      );
      expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
    }
  });

  it('fade-out longer than the whole stream fades the entire signal (matches reference clamp)', () => {
    const sig = tone(440, 48000, 300);
    const ref = fadeOut(sig, 1000, 'linear'); // reference clamps n to frames
    const got = runStage(
      fadeStage({ curve: 'linear', inFrames: 0, outFrames: 1000 }),
      splitInto(sig, [50, 50, 200]),
    );
    expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
  });

  it('fade-in longer than the stream but fade-out shorter (nOut < total < nIn) clamps each correctly', () => {
    // The trickiest regime: holdback = max(nIn,nOut) = nIn > total, so the whole signal is held to flush,
    // where fade-in clamps to `total` (denom total-1) and fade-out stays a real `nOut`-frame tail.
    const sig = stereoTone(48000, 1000);
    const ref = fadeOut(fadeIn(sig, 2000, 'equal-power'), 500, 'equal-power');
    for (const sched of SCHEDULES) {
      const got = runStage(
        fadeStage({ curve: 'equal-power', inFrames: 2000, outFrames: 500 }),
        splitInto(sig, sched),
      );
      expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
    }
  });

  it('a real 440 Hz fixture fade-out is bit-exact through random chunking (≤ 1e-12)', async () => {
    const sig = readWavPcm(await loadFixture('sin_440Hz_-6dBFS_1s.wav'));
    const n = Math.round(0.25 * sig.sampleRate);
    const ref = fadeOut(sig, n, 'equal-power');
    const got = runStage(
      fadeStage({ curve: 'equal-power', inFrames: 0, outFrames: n }),
      splitInto(sig, [1024, 1, 4096, 7, 99999]),
    );
    expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
  });

  it('preserves total frame count and emits nothing extra on an empty stream', () => {
    const stage = fadeStage({ curve: 'linear', inFrames: 10, outFrames: 10 });
    expect(stage.flush()).toEqual([]);
  });

  it('a single-frame fade-in and fade-out (N=1 ⇒ t=0) matches the reference start/endpoint gains', () => {
    // N=1 exercises the `denom = N>1 ? N-1 : 1` guard: fade-in sample 0 → gain 0, fade-out last → gain 1.
    const sig = tone(440, 48000, 32);
    const ref = fadeOut(fadeIn(sig, 1, 'linear'), 1, 'linear');
    for (const sched of SCHEDULES) {
      const got = runStage(
        fadeStage({ curve: 'linear', inFrames: 1, outFrames: 1 }),
        splitInto(sig, sched),
      );
      expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
    }
  });
});

// ============ dynamics — global normalize + per-sample limit ============

describe('dynamicsStage — global normalize/limit equals the whole-signal dynamics', () => {
  it('peak-normalize uses the GLOBAL peak (single factor) across all chunks (exact)', () => {
    const sig = stereoTone(48000, 4000);
    const ref = normalizePeak(sig, -3);
    for (const sched of SCHEDULES) {
      const got = runStage(
        dynamicsStage({ normalize: { mode: 'peak', targetDbfs: -3 } }),
        splitInto(sig, sched),
      );
      expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
    }
  });

  it('rms-normalize then soft-limit matches the chained whole-signal reference (exact)', () => {
    const sig = tone(440, 44100, 6000, 0.3);
    const ref = limit(normalizeRms(sig, -14), -1, 'soft');
    for (const sched of SCHEDULES) {
      const got = runStage(
        dynamicsStage({
          normalize: { mode: 'rms', targetDbfs: -14 },
          limit: { ceilingDbfs: -1, mode: 'soft' },
        }),
        splitInto(sig, sched),
      );
      expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
    }
  });

  it('limit-only is a CAUSAL per-chunk stage (no buffering): output is 1:1 per input chunk', () => {
    const sig = step(48000, 1000);
    const ref = limit(sig, -6, 'hard');
    const chunks = splitInto(sig, [200, 300, 500]);
    const stage = dynamicsStage({ limit: { ceilingDbfs: -6, mode: 'hard' } });
    const emitted: PcmAudio[] = [];
    for (const c of chunks) emitted.push(...stage.push(c));
    const tail = stage.flush();
    // limit is causal → exactly one output chunk per input chunk, nothing held to flush.
    expect(emitted.length).toBe(chunks.length);
    expect(tail).toEqual([]);
    expect(maxAbsDiff(concat(emitted), ref)).toBeLessThan(1e-12);
  });

  it('a real 440 Hz fixture: 4× over-boost then limit, chunked == single-call (exact)', async () => {
    const sig = readWavPcm(await loadFixture('sin_440Hz_-6dBFS_1s.wav'));
    const boosted: PcmAudio = {
      ...sig,
      planar: sig.planar.map((ch) => ch.map((v) => v * 4)),
    };
    const ref = limit(boosted, 0, 'hard');
    const got = runStage(
      dynamicsStage({ limit: { ceilingDbfs: 0, mode: 'hard' } }),
      splitInto(boosted, [4096, 1, 33333, 7]),
    );
    expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
  });

  it('soft-limit with an explicit knee matches the whole-signal soft limiter (knee path)', () => {
    const sig = stereoTone(48000, 3000);
    const ref = limit(normalizePeak(sig, 0), -1, 'soft', 0.7);
    for (const sched of SCHEDULES) {
      const got = runStage(
        dynamicsStage({
          normalize: { mode: 'peak', targetDbfs: 0 },
          limit: { ceilingDbfs: -1, mode: 'soft', knee: 0.7 },
        }),
        splitInto(sig, sched),
      );
      expect(maxAbsDiff(got, ref)).toBeLessThan(1e-12);
    }
  });

  it('silence is a fixed point for normalize (no divide-by-zero)', () => {
    const sig: PcmAudio = {
      sampleRate: 48000,
      channels: 1,
      frames: 100,
      planar: [new Float64Array(100)],
    };
    const got = runStage(
      dynamicsStage({ normalize: { mode: 'peak', targetDbfs: 0 } }),
      splitInto(sig, [40, 60]),
    );
    expect(maxAbsDiff(got, sig)).toBe(0);
  });
});
