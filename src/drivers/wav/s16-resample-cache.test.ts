import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { writeWav } from './pcm.ts';
import { BoundedFastBankCache, tryResampleWavS16ToS16Wav } from './s16-resample.ts';

describe('bounded WAV s16 resample-bank cache', () => {
  it('evicts the least-recently-used entry at its entry bound', () => {
    const cache = new BoundedFastBankCache<{ readonly id: string }>(2, 100);
    expect(cache.set('a', { id: 'a' }, 30)).toBe(true);
    expect(cache.set('b', { id: 'b' }, 30)).toBe(true);
    expect(cache.get('a')).toEqual({ id: 'a' });

    expect(cache.set('c', { id: 'c' }, 30)).toBe(true);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual({ id: 'a' });
    expect(cache.get('c')).toEqual({ id: 'c' });
    expect(cache.size).toBe(2);
    expect(cache.byteSize).toBe(60);
  });

  it('enforces the byte budget and does not displace entries for an oversized value', () => {
    const cache = new BoundedFastBankCache<{ readonly id: string }>(4, 50);
    expect(cache.set('a', { id: 'a' }, 30)).toBe(true);
    expect(cache.set('b', { id: 'b' }, 25)).toBe(true);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toEqual({ id: 'b' });
    expect(cache.byteSize).toBe(25);

    expect(cache.set('oversized', { id: 'oversized' }, 51)).toBe(false);
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.get('b')).toEqual({ id: 'b' });
    expect(cache.size).toBe(1);
    expect(cache.byteSize).toBe(25);
  });

  it('falls through before allocating a pathological downsampling kernel', () => {
    const input = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 24_000,
        planar: [new Float64Array(24_000).fill(0.25)],
      },
      's16',
    );

    expect(
      tryResampleWavS16ToS16Wav(input, {
        container: 'wav',
        sampleFormat: 's16',
        sampleRate: 1,
      }),
    ).toBeUndefined();
  });

  it('falls through before allocating an oversized aggregate polyphase bank', () => {
    const input = writeWav(
      {
        sampleRate: 204_801,
        channels: 1,
        frames: 26,
        planar: [new Float64Array(26).fill(0.25)],
      },
      's16',
    );

    expect(
      tryResampleWavS16ToS16Wav(input, {
        container: 'wav',
        sampleFormat: 's16',
        sampleRate: 4_096,
      }),
    ).toBeUndefined();
  });

  it('throws for an already-aborted operation before resolving an unavailable bank', () => {
    const input = writeWav(
      {
        sampleRate: 204_801,
        channels: 1,
        frames: 1,
        planar: [Float64Array.of(0.25)],
      },
      's16',
    );
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      tryResampleWavS16ToS16Wav(input, {
        container: 'wav',
        sampleFormat: 's16',
        sampleRate: 4_096,
        signal: controller.signal,
      }),
    ).toThrow(MediaError);
  });

  it('emits an empty WAV before resolving an unavailable bank when output has zero frames', () => {
    const input = writeWav(
      {
        sampleRate: 204_801,
        channels: 1,
        frames: 0,
        planar: [new Float64Array(0)],
      },
      's16',
    );

    const output = tryResampleWavS16ToS16Wav(input, {
      container: 'wav',
      sampleFormat: 's16',
      sampleRate: 4_096,
    });

    expect(output).toBeDefined();
    if (output === undefined) throw new Error('expected the zero-frame direct path to emit a WAV');
    expect(output.byteLength).toBe(44);
    const header = new DataView(output.buffer, output.byteOffset, output.byteLength);
    expect(header.getUint32(24, true)).toBe(4_096);
    expect(header.getUint32(40, true)).toBe(0);
  });
});
