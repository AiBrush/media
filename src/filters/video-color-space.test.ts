import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_COLOR,
  mapVideoColorSpace,
  sourceColorToVideoColorSpaceInit,
} from './video-color-space.ts';

describe('video color-space metadata helpers', () => {
  it('maps known WebCodecs primaries and transfers into the filter source model', () => {
    expect(mapVideoColorSpace({ primaries: 'bt2020', transfer: 'pq' })).toEqual({
      primaries: 'bt2020',
      transfer: 'pq',
    });
    expect(mapVideoColorSpace({ primaries: 'bt709', transfer: 'hlg' })).toEqual({
      primaries: 'bt709',
      transfer: 'hlg',
    });
    expect(mapVideoColorSpace({ primaries: 'smpte170m', transfer: 'smpte170m' })).toEqual({
      primaries: 'bt601',
      transfer: 'bt709',
    });
    expect(mapVideoColorSpace({ primaries: 'bt470bg', transfer: 'iec61966-2-1' })).toEqual({
      primaries: 'bt601',
      transfer: 'srgb',
    });
  });

  it('defaults absent or unknown source metadata to BT.709 SDR', () => {
    expect(mapVideoColorSpace(null)).toEqual(DEFAULT_SOURCE_COLOR);
    expect(mapVideoColorSpace(undefined)).toEqual(DEFAULT_SOURCE_COLOR);
    expect(mapVideoColorSpace({ primaries: null, transfer: null })).toEqual(DEFAULT_SOURCE_COLOR);
    expect(mapVideoColorSpace({ primaries: 'future-gamut', transfer: 'future-transfer' })).toEqual(
      DEFAULT_SOURCE_COLOR,
    );
  });

  it('builds full-range RGB output tags without losing HDR transfers', () => {
    expect(sourceColorToVideoColorSpaceInit({ primaries: 'bt2020', transfer: 'pq' })).toEqual({
      primaries: 'bt2020',
      transfer: 'pq',
      matrix: 'rgb',
      fullRange: true,
    });
    expect(sourceColorToVideoColorSpaceInit({ primaries: 'bt709', transfer: 'hlg' })).toEqual({
      primaries: 'bt709',
      transfer: 'hlg',
      matrix: 'rgb',
      fullRange: true,
    });
    expect(sourceColorToVideoColorSpaceInit({ primaries: 'srgb', transfer: 'srgb' })).toEqual({
      primaries: 'bt709',
      transfer: 'iec61966-2-1',
      matrix: 'rgb',
      fullRange: true,
    });
    expect(sourceColorToVideoColorSpaceInit({ primaries: 'bt601', transfer: 'bt709' })).toEqual({
      primaries: 'smpte170m',
      transfer: 'bt709',
      matrix: 'rgb',
      fullRange: true,
    });
  });
});
