import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../contracts/driver.ts';
import { Mp4Driver } from './mp4-driver.ts';
import { writeMp4 } from './write.ts';

interface OwnedRangeSource {
  readonly source: ByteSource & { readonly kind: 'url'; readonly mimeHint: 'video/mp4' };
  readonly outstanding: ReadonlySet<Uint8Array>;
  readonly reads: () => number;
  readonly releases: () => number;
}

function ownedRangeSource(bytes: Uint8Array): OwnedRangeSource {
  const outstanding = new Set<Uint8Array>();
  let reads = 0;
  let releases = 0;
  return {
    source: {
      kind: 'url',
      mimeHint: 'video/mp4',
      size: bytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable MP4 probe must stay range-backed');
      },
      range(start, end): Promise<Uint8Array> {
        reads++;
        const view = bytes.slice(start, Math.min(end, bytes.byteLength));
        outstanding.add(view);
        return Promise.resolve(view);
      },
      releaseRange(view): void {
        if (!outstanding.delete(view)) {
          throw new Error('MP4 probe released a foreign or already-released range');
        }
        releases++;
        const buffer = view.buffer as ArrayBuffer;
        structuredClone(buffer, { transfer: [buffer] });
      },
    },
    outstanding,
    reads: () => reads,
    releases: () => releases,
  };
}

function faststartAvc(): Uint8Array {
  return writeMp4(
    [
      {
        mediaType: 'video',
        sampleEntryType: 'avc1',
        timescale: 90_000,
        width: 16,
        height: 16,
        description: Uint8Array.of(1, 100, 0, 31, 255, 225, 0, 1, 103, 1, 0, 1, 104),
        samples: [
          {
            data: Uint8Array.of(0, 0, 0, 2, 0x65, 0xc0),
            durationTicks: 3_000,
            cttsTicks: 0,
            keyframe: true,
          },
        ],
      },
    ],
    { faststart: true, brand: 'mp4' },
  );
}

describe('MP4 probe range ownership', () => {
  it('releases every exact range response after a successful metadata probe', async () => {
    const owned = ownedRangeSource(faststartAvc());
    const probe = Mp4Driver.probe;
    if (probe === undefined) throw new Error('MP4 probe is unavailable');

    const tracks = await probe.call(Mp4Driver, owned.source);

    expect(tracks).toEqual([
      expect.objectContaining({ mediaType: 'video', codec: expect.stringMatching(/^avc1\./) }),
    ]);
    const description = tracks[0]?.config?.description;
    expect(description).toBeInstanceOf(Uint8Array);
    expect((description as Uint8Array).byteLength).toBeGreaterThan(0);
    expect(owned.reads()).toBeGreaterThan(0);
    expect(owned.releases()).toBe(owned.reads());
    expect(owned.outstanding.size).toBe(0);
  });

  it('releases every exact range response when metadata parsing rejects', async () => {
    const ftypOnly = Uint8Array.of(0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70);
    const owned = ownedRangeSource(ftypOnly);
    const probe = Mp4Driver.probe;
    if (probe === undefined) throw new Error('MP4 probe is unavailable');

    await expect(probe.call(Mp4Driver, owned.source)).rejects.toThrow(/no moov box found/);

    expect(owned.reads()).toBeGreaterThan(0);
    expect(owned.releases()).toBe(owned.reads());
    expect(owned.outstanding.size).toBe(0);
  });
});
