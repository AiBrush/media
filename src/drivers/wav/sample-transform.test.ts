import { describe, expect, it } from 'vitest';
import type { PcmTransform } from '../../contracts/driver.ts';
import { applyPcmTransform } from '../pcm-transform.ts';
import { readWavPcm, writeWav } from './pcm.ts';
import { tryTransformWavSamplesToWav } from './sample-transform.ts';

function audio(
  channels: number,
  frames: number,
  sampleRate = 48_000,
): {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  readonly planar: readonly Float64Array[];
} {
  return {
    sampleRate,
    channels,
    frames,
    planar: Array.from({ length: channels }, (_, channel) =>
      Float64Array.from({ length: frames }, (__, frame) => {
        const carrier = Math.sin((frame + channel * 13) * 0.071);
        return carrier * (0.18 + channel * 0.025);
      }),
    ),
  };
}

function canonical(bytes: Uint8Array, opts: PcmTransform): Uint8Array {
  const source = readWavPcm(bytes);
  return writeWav(applyPcmTransform(source, opts), source.format, opts.endian ?? 'le');
}

function misaligned(bytes: Uint8Array): Uint8Array {
  const storage = new Uint8Array(bytes.byteLength + 1);
  storage.set(bytes, 1);
  return storage.subarray(1);
}

const DEFAULT_REMIXES = [
  [1, 2],
  [2, 1],
  [2, 6],
  [6, 1],
  [6, 2],
] as const;

describe('fused WAV sample transform', () => {
  it('is byte-exact with the canonical s16 stereo-to-mono path', () => {
    const input = writeWav(audio(2, 8_193), 's16');
    const opts = { container: 'wav', sampleFormat: 's16', channels: 1 } as const;
    expect(tryTransformWavSamplesToWav(input, opts)).toEqual(canonical(input, opts));
  });

  it('matches canonical nearest-even rounding for exact-half s16 stereo averages', () => {
    const left = [-3, -2, -1, 0, 1, 2];
    const right = [-2, -1, 0, 1, 2, 3];
    const input = writeWav(
      {
        sampleRate: 48_000,
        channels: 2,
        frames: left.length,
        planar: [
          Float64Array.from(left, (sample) => sample / 32_768),
          Float64Array.from(right, (sample) => sample / 32_768),
        ],
      },
      's16',
    );
    const opts = { container: 'wav', sampleFormat: 's16', channels: 1 } as const;
    const direct = tryTransformWavSamplesToWav(input, opts);

    expect(direct).toEqual(canonical(input, opts));
    if (direct === undefined) throw new Error('expected fused s16 remix');
    expect(Array.from(new Int16Array(direct.buffer, direct.byteOffset + 44, left.length))).toEqual([
      -2, -2, 0, 0, 2, 2,
    ]);
  });

  it('is byte-exact with the canonical s16 5.1-to-stereo path', () => {
    const input = writeWav(audio(6, 4_113), 's16');
    const opts = { container: 'wav', sampleFormat: 's16', channels: 2 } as const;
    expect(tryTransformWavSamplesToWav(input, opts)).toEqual(canonical(input, opts));
  });

  it.each(['s16', 'f32'] as const)(
    'matches every supported default %s remix, with and without an envelope',
    (format) => {
      for (const [inputChannels, outputChannels] of DEFAULT_REMIXES) {
        const input = writeWav(audio(inputChannels, 17, 16), format);
        const plain = {
          container: 'wav',
          sampleFormat: format,
          channels: outputChannels,
        } as const;
        const enveloped = {
          ...plain,
          gainDb: -1.5,
          fade: { inSec: 1 / 16, outSec: 1 / 16, curve: 'equal-power' },
        } as const;
        expect(tryTransformWavSamplesToWav(input, plain)).toEqual(canonical(input, plain));
        expect(tryTransformWavSamplesToWav(input, enveloped)).toEqual(canonical(input, enveloped));
      }
    },
  );

  it('is byte-exact with canonical gain and overlapping linear fades', () => {
    const input = writeWav(audio(2, 12_007), 's16');
    const opts = {
      container: 'wav',
      sampleFormat: 's16',
      gainDb: -3.25,
      fade: { inSec: 0.2, outSec: 0.2, curve: 'linear' },
    } as const;
    expect(tryTransformWavSamplesToWav(input, opts)).toEqual(canonical(input, opts));
  });

  it('is byte-exact with the canonical f32 equal-power fade path', () => {
    const input = writeWav(audio(2, 12_007), 'f32');
    const opts = {
      container: 'wav',
      sampleFormat: 'f32',
      fade: { inSec: 0.2, outSec: 0.2, curve: 'equal-power' },
    } as const;
    expect(tryTransformWavSamplesToWav(input, opts)).toEqual(canonical(input, opts));
  });

  it.each([
    ['s16', 'equal-power'],
    ['f32', 'linear'],
  ] as const)('handles one-frame %s %s fade denominators', (format, curve) => {
    const input = writeWav(
      {
        sampleRate: 4,
        channels: 2,
        frames: 3,
        planar: [Float64Array.of(0.5, 0.5, 0.5), Float64Array.of(-0.25, -0.25, -0.25)],
      },
      format,
    );
    const opts = {
      container: 'wav',
      sampleFormat: format,
      fade: { inSec: 0.25, outSec: 0.25, curve },
    } as const;
    const direct = tryTransformWavSamplesToWav(input, opts);

    expect(direct).toEqual(canonical(input, opts));
    if (direct === undefined) throw new Error('expected fused one-frame fade');
    const transformed = readWavPcm(direct);
    expect(transformed.planar[0]?.[0]).toBe(0);
    expect(transformed.planar[0]?.[2]).toBeCloseTo(0.5, 4);
  });

  it.each(['s16', 'f32'] as const)(
    'applies arbitrary finite %s matrices without an envelope',
    (format) => {
      const input = writeWav(audio(2, 4_097), format);
      const opts = {
        container: 'wav',
        sampleFormat: format,
        channels: 6,
        mixMatrix: [
          [1, 0],
          [0, 1],
          [Math.SQRT1_2, Math.SQRT1_2],
          [0, 0],
          [Math.SQRT1_2, 0],
          [0, Math.SQRT1_2],
        ],
      } as const;
      expect(tryTransformWavSamplesToWav(input, opts)).toEqual(canonical(input, opts));
    },
  );

  it.each(['s16', 'f32'] as const)(
    'keeps compiled sparse %s matrices exact when gain and fades share the same transform',
    (format) => {
      const input = writeWav(audio(3, 8_197), format);
      const opts = {
        container: 'wav',
        sampleFormat: format,
        channels: 2,
        gainDb: -2.25,
        fade: { inSec: 0.08, outSec: 0.11, curve: 'linear' },
        mixMatrix: [
          [0.75, 0, -0.125],
          [0, 0.5, 0.25],
        ],
      } as const;
      expect(tryTransformWavSamplesToWav(input, opts)).toEqual(canonical(input, opts));
    },
  );

  it('saturates both raw and enveloped s16 remixes exactly like the canonical path', () => {
    const surround = writeWav(
      {
        sampleRate: 48_000,
        channels: 6,
        frames: 2,
        planar: Array.from({ length: 6 }, () => Float64Array.of(30_000 / 32_768, -30_000 / 32_768)),
      },
      's16',
    );
    const mono = writeWav(
      {
        sampleRate: 48_000,
        channels: 1,
        frames: 2,
        planar: [Float64Array.of(0.9, -0.9)],
      },
      's16',
    );
    const cases = [
      [surround, { channels: 2 }],
      [mono, { channels: 2, gainDb: 12 }],
    ] as const;

    for (const [input, opts] of cases) {
      const direct = tryTransformWavSamplesToWav(input, opts);
      expect(direct).toEqual(canonical(input, opts));
      if (direct === undefined) throw new Error('expected fused saturating remix');
      expect(Array.from(new Int16Array(direct.buffer, direct.byteOffset + 44))).toEqual([
        32_767, 32_767, -32_768, -32_768,
      ]);
    }
  });

  it('uses aligned and unaligned f32 gain/fade readers without changing the result', () => {
    const aligned = writeWav(audio(1, 5), 'f32');
    const unaligned = misaligned(aligned);
    for (const opts of [
      { gainDb: -2 },
      { fade: { inSec: 2 / 48_000, outSec: 2 / 48_000, curve: 'linear' as const } },
    ]) {
      expect(tryTransformWavSamplesToWav(aligned, opts)).toEqual(canonical(aligned, opts));
      expect(tryTransformWavSamplesToWav(unaligned, opts)).toEqual(canonical(unaligned, opts));
    }
  });

  it('rejects malformed matrices and fade plans', () => {
    const input = writeWav(audio(2, 32), 's16');
    expect(() =>
      tryTransformWavSamplesToWav(input, {
        channels: 1,
        mixMatrix: [[1]],
      }),
    ).toThrow('expected 2');
    expect(() =>
      tryTransformWavSamplesToWav(input, {
        channels: 1,
        mixMatrix: [
          [1, 0],
          [0, 1],
        ],
      }),
    ).toThrow('2 output row(s)');
    expect(() =>
      tryTransformWavSamplesToWav(input, {
        mixMatrix: [undefined] as unknown as readonly (readonly number[])[],
      }),
    ).toThrow('row 0');
    expect(() =>
      tryTransformWavSamplesToWav(input, {
        mixMatrix: [[1, Number.NaN]],
      }),
    ).toThrow('must be finite');
    expect(() =>
      tryTransformWavSamplesToWav(input, {
        fade: null as unknown as NonNullable<PcmTransform['fade']>,
      }),
    ).toThrow('must be an object');
    expect(() =>
      tryTransformWavSamplesToWav(input, {
        fade: { curve: 'logarithmic' } as unknown as NonNullable<PcmTransform['fade']>,
      }),
    ).toThrow('unsupported audio fade curve');
    for (const inSec of [-1, Number.NaN, Number.MAX_VALUE]) {
      expect(() =>
        tryTransformWavSamplesToWav(input, {
          fade: { inSec },
        }),
      ).toThrow();
    }
  });

  it('declines unsupported layouts, formats, no-ops, and general DSP work', () => {
    const input = writeWav(audio(2, 32), 's16');
    const unsupportedFormat = writeWav(audio(2, 32), 's24');
    const badChannels = input.slice();
    const badSampleRate = input.slice();
    new DataView(badChannels.buffer).setUint16(22, 0, true);
    new DataView(badSampleRate.buffer).setUint32(24, 0, true);

    expect(tryTransformWavSamplesToWav(input, {})).toBeUndefined();
    expect(tryTransformWavSamplesToWav(input, { container: 'aiff' })).toBeUndefined();
    expect(tryTransformWavSamplesToWav(unsupportedFormat, { gainDb: -1 })).toBeUndefined();
    expect(tryTransformWavSamplesToWav(input, { sampleFormat: 'f32' })).toBeUndefined();
    expect(tryTransformWavSamplesToWav(badChannels, { gainDb: -1 })).toBeUndefined();
    expect(tryTransformWavSamplesToWav(badSampleRate, { gainDb: -1 })).toBeUndefined();
    expect(
      tryTransformWavSamplesToWav(input, {
        sampleRate: 44_100,
        channels: 1,
      }),
    ).toBeUndefined();
    expect(
      tryTransformWavSamplesToWav(input, {
        channels: 1,
        biquad: { type: 'lowpass', frequency: 1_000, q: Math.SQRT1_2 },
      }),
    ).toBeUndefined();
    expect(
      tryTransformWavSamplesToWav(input, {
        dynamics: { normalize: { mode: 'peak', targetDbfs: -1 } },
      }),
    ).toBeUndefined();
    expect(
      tryTransformWavSamplesToWav(input, {
        timeBounds: { startSec: 0, endSec: 0.001 },
      }),
    ).toBeUndefined();
    expect(tryTransformWavSamplesToWav(input, { endian: 'be' })).toBeUndefined();
    expect(
      tryTransformWavSamplesToWav(writeWav(audio(3, 32), 's16'), { channels: 2 }),
    ).toBeUndefined();
    expect(
      tryTransformWavSamplesToWav(input, { gainDb: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
    expect(tryTransformWavSamplesToWav(misaligned(input), { channels: 1 })).toBeUndefined();
    expect(
      tryTransformWavSamplesToWav(misaligned(writeWav(audio(2, 32), 'f32')), { channels: 1 }),
    ).toBeUndefined();
    for (const channels of [0, 1.5]) {
      expect(() => tryTransformWavSamplesToWav(input, { channels })).toThrow(
        'invalid target channel count',
      );
    }
  });

  it('propagates a pre-aborted transform signal', () => {
    const input = writeWav(audio(2, 32), 's16');
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      tryTransformWavSamplesToWav(input, {
        channels: 1,
        signal: controller.signal,
      }),
    ).toThrow('operation aborted');
  });
});
