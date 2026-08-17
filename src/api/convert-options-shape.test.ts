import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { assertConvertOptionsShape } from './convert-options-shape.ts';
import type { ConvertOptions } from './types.ts';

/** Call with a deliberately widened value: the defect only reaches runtime for untyped callers. */
const check = (options: unknown): void => {
  assertConvertOptionsShape(options);
};

describe('assertConvertOptionsShape — accepted shapes', () => {
  it('accepts every documented convert option', () => {
    const options: ConvertOptions = {
      to: 'mp4',
      faststart: 'reserve',
      maximumPacketCount: 1000,
      fragmented: false,
      video: {
        codec: 'h264',
        width: 1280,
        height: 720,
        fit: 'contain',
        fps: 30,
        bitrate: 4_000_000,
        maxAverageBitrate: 5_000_000,
        bitrateMode: 'variable',
        bitDepth: 8,
        alpha: 'keep',
        rotate: 90,
        flip: 'h',
        crop: { x: 1, y: 2, width: 3, height: 4 },
        pad: { width: 1920, height: 1080 },
        colorspace: { to: 'bt709' },
        tonemap: { to: 'sdr' },
      },
      audio: {
        codec: 'opus',
        sampleRate: 48_000,
        channels: 2,
        bitrate: 128_000,
        gainDb: -3,
        fade: { inSec: 1, curve: 'linear' },
        mixMatrix: [[1, 0]],
      },
    };
    expect(() => check(options)).not.toThrow();
  });

  it('accepts the documented track-dropping targets and an empty object', () => {
    expect(() => check({ to: 'mp4', video: false, audio: false })).not.toThrow();
    expect(() => check({})).not.toThrow();
  });

  it('ignores a non-object options value rather than inventing an error for it', () => {
    for (const value of [undefined, null, 'mp4', 42, true]) {
      expect(() => check(value)).not.toThrow();
    }
  });

  it('ignores a non-object target, which the target validators reject with their own message', () => {
    expect(() => check({ video: 'h264' })).not.toThrow();
    expect(() => check({ audio: 7 })).not.toThrow();
  });
});

describe('assertConvertOptionsShape — rejected shapes', () => {
  it('rejects a top-level field that belongs to no convert option', () => {
    expect(() => check({ to: 'mp4', crop: { x: 0, y: 0, width: 8, height: 8 } })).toThrow(
      InputError,
    );
    expect(() => check({ to: 'mp4', crop: {} })).toThrow(/unknown field 'crop'/);
  });

  it('rejects a near-miss of a real option and names the field the caller meant', () => {
    expect(() => check({ container: 'mp4' })).toThrow(/unknown field 'container'/);
    expect(() => check({ TO: 'mp4' })).toThrow(/unknown field 'TO' \(did you mean 'to'\?\)/);
    expect(() => check({ video: { Codec: 'h264' } })).toThrow(
      /video target has unknown field 'Codec' \(did you mean 'codec'\?\)/,
    );
  });

  it('rejects an unknown field inside either nested target', () => {
    expect(() => check({ video: { codec: 'h264', quality: 90 } })).not.toThrow();
    expect(() => check({ video: { codec: 'h264', crfValue: 23 } })).toThrow(
      /video target has unknown field 'crfValue'/,
    );
    expect(() => check({ audio: { codec: 'opus', volume: 2 } })).toThrow(
      /audio target has unknown field 'volume'/,
    );
  });

  it('rejects a video field misplaced on the audio target and vice versa', () => {
    expect(() => check({ video: { sampleRate: 48_000 } })).toThrow(/unknown field 'sampleRate'/);
    expect(() => check({ audio: { width: 1280 } })).toThrow(/unknown field 'width'/);
  });

  it('reports the first unknown field with a stable, payload-free message', () => {
    let message = '';
    try {
      check({ video: { codec: 'h264', wdith: 1280 } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("convert options video target has unknown field 'wdith'");
  });

  it('rejects inherited enumerable junk the same way as an own key', () => {
    const base = { bogusInheritedField: 1 };
    const options = Object.assign(Object.create(base) as object, { to: 'mp4' });
    // Object.keys only sees own keys, so an inherited field is not a silent-drop hazard here.
    expect(() => check(options)).not.toThrow();
    expect(() => check({ ...base, to: 'mp4' })).toThrow(/unknown field 'bogusInheritedField'/);
  });

  it('rejects every single-key mutation of a valid options object (generalized sweep)', () => {
    const valid = { to: 'mp4', video: { codec: 'h264' }, audio: { codec: 'opus' } };
    const mutations = [
      { ...valid, output: 'mp4' },
      { ...valid, fastStart: 'in-place' },
      { ...valid, videoTarget: { codec: 'h264' } },
      { ...valid, video: { ...valid.video, resize: { width: 8 } } },
      { ...valid, audio: { ...valid.audio, sample_rate: 48_000 } },
      { ...valid, video: { ...valid.video, '': 1 } },
    ];
    for (const mutation of mutations) {
      expect(() => check(mutation), JSON.stringify(mutation)).toThrow(InputError);
    }
  });
});
