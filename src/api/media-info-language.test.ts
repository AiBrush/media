import { describe, expect, it } from 'vitest';
import type { ContainerDriver, TrackInfo } from '../contracts/driver.ts';
import { fromBytes } from '../sources/source.ts';
import { toMediaInfo } from './probe-media-info.ts';

describe('toMediaInfo track language', () => {
  it('projects declared and undetermined codes without manufacturing an absent language', () => {
    const container = { formats: ['mp4'] } as unknown as ContainerDriver;
    const tracks: TrackInfo[] = [
      { id: 1, mediaType: 'video', codec: 'avc1.640028', language: 'eng' },
      { id: 2, mediaType: 'audio', codec: 'mp4a.40.2', language: 'und' },
      { id: 3, mediaType: 'audio', codec: 'mp4a.40.2' },
    ];

    const info = toMediaInfo(container, tracks, fromBytes(new Uint8Array(12)));

    expect(info.tracks).toEqual([
      { id: 1, type: 'video', codec: 'avc1.640028', language: 'eng' },
      { id: 2, type: 'audio', codec: 'mp4a.40.2', language: 'und' },
      { id: 3, type: 'audio', codec: 'mp4a.40.2' },
    ]);
  });
});
