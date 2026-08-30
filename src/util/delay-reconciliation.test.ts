import { describe, expect, it } from 'vitest';
import {
  delaySamplesToTicks,
  delayTicksToSamples,
  reconcileAudioDelay,
} from './delay-reconciliation.ts';

describe('delay-reconciliation — container ↔ codec authoritative timeline (REQUIREMENTS §7.4, 1.2.7)', () => {
  it('mp4-aac: container edit-list authoritative over codec priming 2112', () => {
    const r = reconcileAudioDelay({
      container: 'mp4',
      codec: 'aac',
      sampleRate: 48000,
      containerLeadingSamples: 1024,
      containerTrailingSamples: 0,
      containerTotalSamples: 240000,
      codecPrimingSamples: 2112,
    });
    expect(r.presentationLeadingSamples).toBe(1024);
    expect(r.presentationTrailingSamples).toBe(0);
    expect(r.presentationTotalSamples).toBe(240000);
    // tick round-trip exact
    expect(delayTicksToSamples(delaySamplesToTicks(1024, 48000, 48000), 48000, 48000)).toBe(1024);
  });

  it('ogg-opus: OpusHead pre-skip 312 authoritative for opus', () => {
    const r = reconcileAudioDelay({
      container: 'ogg',
      codec: 'opus',
      sampleRate: 48000,
      containerLeadingSamples: 312,
      codecPrimingSamples: 312,
    });
    expect(r.presentationLeadingSamples).toBe(312);
    // trailing from container when present
    const r2 = reconcileAudioDelay({
      container: 'webm',
      codec: 'opus',
      sampleRate: 48000,
      containerLeadingSamples: 312,
      containerTrailingSamples: 100,
      codecTrailingPaddingSamples: 0,
    });
    expect(r2.presentationLeadingSamples).toBe(312);
    expect(r2.presentationTrailingSamples).toBe(100);
  });

  it('mp3: LAME delay 1105 authoritative over synthesis 528', () => {
    const r = reconcileAudioDelay({
      container: 'mp3',
      codec: 'mp3',
      sampleRate: 44100,
      containerLeadingSamples: 1105,
      containerTrailingSamples: 500,
      codecPrimingSamples: 528,
    });
    expect(r.presentationLeadingSamples).toBe(1105);
    expect(r.presentationTrailingSamples).toBe(500);
  });

  it('empty/boundary: zero and undefined stay zero without float', () => {
    const r = reconcileAudioDelay({ container: 'wav', codec: 'pcm', sampleRate: 44100 });
    expect(r.presentationLeadingSamples).toBe(0);
    expect(r.presentationTrailingSamples).toBe(0);
    expect(r.presentationTotalSamples).toBeUndefined();
    const r2 = reconcileAudioDelay({
      container: 'adts',
      codec: 'aac',
      sampleRate: 44100,
      containerLeadingSamples: 0,
      containerTrailingSamples: 0,
    });
    expect(r2.presentationLeadingSamples).toBe(0);
    // tick zero
    expect(delaySamplesToTicks(0, 1000, 48000)).toBe(0);
  });

  it('malformed: negative/NaN/non-safe throws RangeError', () => {
    expect(() =>
      reconcileAudioDelay({
        container: 'mp4',
        codec: 'aac',
        sampleRate: 48000,
        containerLeadingSamples: -1,
      } as never),
    ).toThrow(RangeError);
    expect(() =>
      reconcileAudioDelay({
        container: 'mp4',
        codec: 'aac',
        sampleRate: Number.NaN,
      } as never),
    ).toThrow(RangeError);
    expect(() =>
      reconcileAudioDelay({ container: 'mp4', codec: 'aac', sampleRate: 0 } as never),
    ).toThrow(RangeError);
    expect(() => delaySamplesToTicks(-1, 1000, 48000)).toThrow(RangeError);
    expect(() => delayTicksToSamples(-1, 1000, 48000)).toThrow(RangeError);
  });

  it('20× randomized ticks round-trip monotonic + bitexact', () => {
    for (let i = 0; i < 20; i++) {
      const rate = [8000, 22050, 44100, 48000, 96000][i % 5]!;
      const leading = Math.floor(Math.random() * 5000);
      const timescale = [1000, 44100, 48000, 90000][i % 4]!;
      const ticks = delaySamplesToTicks(leading, timescale, rate);
      const back = delayTicksToSamples(ticks, timescale, rate);
      // half-up double rounding: error bounded by rate/timescale
      const tolerance = Math.ceil(rate / timescale) + 1;
      expect(Math.abs(back - leading)).toBeLessThanOrEqual(tolerance);
      // monotonic
      const ticks2 = delaySamplesToTicks(leading + 1, timescale, rate);
      expect(ticks2).toBeGreaterThanOrEqual(ticks);
    }
  });

  it('adts fallback: no container gapless falls back to codec priming', () => {
    const r = reconcileAudioDelay({
      container: 'adts',
      codec: 'aac',
      sampleRate: 44100,
      codecPrimingSamples: 2112,
    });
    expect(r.presentationLeadingSamples).toBe(2112);
  });
});
