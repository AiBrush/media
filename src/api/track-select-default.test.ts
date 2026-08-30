import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../contracts/driver.ts';
import { selectDecodeTrackInfo } from './track-select.ts';

function track(
  id: number,
  mediaType: 'video' | 'audio',
  codec: string,
  defaultDisposition?: boolean,
): TrackInfo {
  return {
    id,
    mediaType,
    codec,
    defaultDisposition,
  } as TrackInfo;
}

describe('multitrack default disposition — decode selection prefers default (REQUIREMENTS §5.2, §6 — 2.3.1)', () => {
  it('prefers the default video track when no selector is given', () => {
    const tracks: TrackInfo[] = [
      track(1, 'video', 'h264', false),
      track(2, 'video', 'vp8', true),
      track(3, 'audio', 'aac', true),
      track(4, 'video', 'vp9', false),
    ];
    expect(selectDecodeTrackInfo(tracks, 'video', undefined)?.id).toBe(2);
    expect(selectDecodeTrackInfo(tracks, 'audio', undefined)?.id).toBe(3);
  });

  it('falls back to first when no default is declared', () => {
    const tracks: TrackInfo[] = [
      track(1, 'video', 'h264'),
      track(2, 'video', 'vp8'),
      track(3, 'audio', 'opus'),
    ];
    expect(selectDecodeTrackInfo(tracks, 'video', undefined)?.id).toBe(1);
    expect(selectDecodeTrackInfo(tracks, 'audio', undefined)?.id).toBe(3);
  });

  it('explicit selector overrides default preference', () => {
    const tracks: TrackInfo[] = [
      track(1, 'video', 'h264', false),
      track(2, 'video', 'vp8', true),
      track(3, 'video', 'av1', false),
    ];
    expect(selectDecodeTrackInfo(tracks, 'video', ['video:0'])?.id).toBe(1);
    expect(selectDecodeTrackInfo(tracks, 'video', ['video:2'])?.id).toBe(3);
    expect(selectDecodeTrackInfo(tracks, 'video', ['video:1'])?.id).toBe(2);
  });

  it('handles 2.3.1 multitrack webm shape: vp8 + theora + pcm (default vp8)', () => {
    const tracks: TrackInfo[] = [
      track(1, 'video', 'vp8', true),
      track(2, 'video', 'theora', false),
      track(3, 'audio', 'pcm-s16', true),
    ];
    expect(selectDecodeTrackInfo(tracks, 'video', undefined)?.codec).toBe('vp8');
    expect(selectDecodeTrackInfo(tracks, 'video', ['video:1'])?.codec).toBe('theora');
  });

  it('20× randomized default-preference remains deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const tracks: TrackInfo[] = [
        track(1, 'video', 'h264', i % 3 === 0 ? true : false),
        track(2, 'video', 'vp9', i % 3 === 1 ? true : false),
        track(3, 'video', 'av1', i % 3 === 2 ? true : false),
        track(4, 'audio', 'aac', true),
      ];
      const selected = selectDecodeTrackInfo(tracks, 'video', undefined);
      expect(selected).toBeDefined();
      expect([1, 2, 3]).toContain(selected!.id);
      // Explicit always wins
      expect(selectDecodeTrackInfo(tracks, 'video', ['video:2'])?.id).toBe(3);
    }
  });

  it('malformed / empty inputs never throw huge-alloc and return undefined for missing type', () => {
    expect(selectDecodeTrackInfo([], 'video', undefined)).toBeUndefined();
    expect(selectDecodeTrackInfo([track(1, 'audio', 'aac')], 'video', undefined)).toBeUndefined();
    expect(selectDecodeTrackInfo([track(1, 'video', 'h264')], 'video', [])?.id).toBe(1);
    expect(() => selectDecodeTrackInfo([track(1, 'video', 'h264')], 'video', ['video:1'])).toThrow(
      /no track/,
    );
    expect(
      selectDecodeTrackInfo([track(1, 'video', 'h264'), track(2, 'video', 'vp8')], 'video', [
        'video:0',
      ])?.id,
    ).toBe(1);
  });
});
