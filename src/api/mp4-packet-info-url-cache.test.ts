import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PacketInfoTable } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import {
  Mp4PacketInfoUrlCache,
  mp4PacketInfoUrlCacheIdentity,
} from './mp4-packet-info-url-cache.ts';

const PROVIDER_A = {};
const PROVIDER_B = {};

function table(packetCount = 1): PacketInfoTable {
  return {
    tracks: [
      {
        id: 1,
        mediaType: 'video',
        codec: 'avc1.64001f',
        durationSec: 1,
        language: 'eng',
        config: {
          codec: 'avc1.64001f',
          codedWidth: 16,
          codedHeight: 16,
          description: Uint8Array.of(1, 100, 0, 31),
          colorSpace: { fullRange: false },
        },
        color: { primaries: 1, transferCharacteristics: 1 },
        gapless: { totalSamples: 48_000 },
      },
    ],
    packets: Array.from({ length: packetCount }, (_, index) => ({
      trackIndex: 0,
      offset: 1_024 + index * 8,
      size: 8,
      ptsUs: index * 33_333,
      dtsUs: index * 33_333,
      durationUs: 33_333,
      keyframe: index === 0,
    })),
  };
}

function identity(
  suffix: string,
  provider: object = PROVIDER_A,
  overrides: { readonly mime?: string; readonly size?: number } = {},
) {
  const result = mp4PacketInfoUrlCacheIdentity(
    `blob:https://example.test/${suffix}`,
    {
      mime: overrides.mime ?? 'video/mp4',
      size: overrides.size ?? 128,
    },
    provider,
  );
  if (result === undefined) throw new Error('expected cacheable finite blob identity');
  return result;
}

describe('finite blob MP4 packet-info URL cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits only exact finite blob snapshots and includes every semantic option', () => {
    expect(
      mp4PacketInfoUrlCacheIdentity(
        'https://example.test/movie.mp4',
        { mime: 'video/mp4', size: 128 },
        PROVIDER_A,
      ),
    ).toBeUndefined();
    expect(
      mp4PacketInfoUrlCacheIdentity(
        'blob:https://example.test/movie',
        { mime: 'video/mp4' },
        PROVIDER_A,
      ),
    ).toBeUndefined();
    for (const size of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        mp4PacketInfoUrlCacheIdentity(
          'blob:https://example.test/movie',
          { mime: 'video/mp4', size },
          PROVIDER_A,
        ),
      ).toBeUndefined();
    }
    expect(
      mp4PacketInfoUrlCacheIdentity(
        'blob:https://example.test/movie',
        { mime: 'video/mp4', size: 128, futureSemanticOption: true } as {
          readonly mime: string;
          readonly size: number;
        },
        PROVIDER_A,
      ),
    ).toBeUndefined();

    expect(identity('movie').key).toBe(identity('movie', PROVIDER_A, { mime: 'video/mp4' }).key);
    expect(identity('movie').key).not.toBe(
      identity('movie', PROVIDER_A, { mime: 'video/quicktime' }).key,
    );
    expect(identity('movie').key).not.toBe(identity('movie', PROVIDER_A, { size: 129 }).key);
    expect(identity('movie').key).not.toBe(identity('other').key);
  });

  it('owns stored facts and defensively snapshots every hit', () => {
    const cache = new Mp4PacketInfoUrlCache({ ttlMs: 1_000, maxEntries: 2, maxRows: 16 });
    const source = table(2);
    cache.store(identity('owned'), source);

    const storedDescription = source.tracks[0]?.config?.description;
    if (!ArrayBuffer.isView(storedDescription)) throw new Error('expected description view');
    new Uint8Array(
      storedDescription.buffer,
      storedDescription.byteOffset,
      storedDescription.byteLength,
    )[0] = 255;
    const sourceTrack = source.tracks[0];
    if (sourceTrack === undefined || sourceTrack.color === undefined) {
      throw new Error('expected source track color');
    }
    sourceTrack.codec = 'poisoned';
    sourceTrack.color.primaries = 99;
    (source.packets[0] as { size: number }).size = 99;

    const first = cache.hit(identity('owned'));
    expect(first?.tracks[0]?.codec).toBe('avc1.64001f');
    expect(first?.tracks[0]?.color?.primaries).toBe(1);
    expect(first?.packets[0]?.size).toBe(8);
    const firstDescription = first?.tracks[0]?.config?.description;
    if (!ArrayBuffer.isView(firstDescription)) throw new Error('expected cached description view');
    expect(
      new Uint8Array(
        firstDescription.buffer,
        firstDescription.byteOffset,
        firstDescription.byteLength,
      )[0],
    ).toBe(1);

    const firstTrack = first?.tracks[0];
    const firstPacket = first?.packets[0];
    if (firstTrack === undefined || firstPacket === undefined) {
      throw new Error('expected cached track and packet');
    }
    firstTrack.codec = 'also-poisoned';
    (firstPacket as { size: number }).size = 77;
    expect(cache.hit(identity('owned'))?.tracks[0]?.codec).toBe('avc1.64001f');
    expect(cache.hit(identity('owned'))?.packets[0]?.size).toBe(8);
    cache.clear();
  });

  it('honors aborts on hits and stores without publishing an aborted snapshot', () => {
    const cache = new Mp4PacketInfoUrlCache({ ttlMs: 1_000, maxEntries: 2, maxRows: 16 });
    cache.store(identity('abort-hit'), table());
    const hitController = new AbortController();
    hitController.abort();
    expect(() => cache.hit(identity('abort-hit'), hitController.signal)).toThrow(MediaError);

    const storeController = new AbortController();
    storeController.abort();
    expect(() => cache.store(identity('abort-store'), table(), storeController.signal)).toThrow(
      MediaError,
    );
    expect(cache.hit(identity('abort-store'))).toBeUndefined();
    cache.clear();
  });

  it('separates packet-info provider registrations and clears its lifecycle deterministically', () => {
    const cache = new Mp4PacketInfoUrlCache({ ttlMs: 1_000, maxEntries: 2, maxRows: 16 });
    cache.store(identity('registry'), table());
    expect(cache.hit(identity('registry', PROVIDER_B))).toBeUndefined();
    expect(cache.hit(identity('registry'))).toBeUndefined();

    cache.store(identity('registry'), table());
    expect(cache.entryCount).toBe(1);
    cache.clear();
    expect(cache.entryCount).toBe(0);
    expect(cache.rowCount).toBe(0);
    expect(cache.hit(identity('registry'))).toBeUndefined();
  });

  it('expires absolutely, bounds LRU entries, and enforces the aggregate row budget', () => {
    const cache = new Mp4PacketInfoUrlCache({ ttlMs: 100, maxEntries: 2, maxRows: 6 });
    cache.store(identity('a'), table(1)); // two rows: one track + one packet
    cache.store(identity('b'), table(1));
    expect(cache.hit(identity('a'))).toBeDefined(); // a is now most recent
    cache.store(identity('c'), table(1)); // evicts b by entry count
    expect(cache.hit(identity('b'))).toBeUndefined();
    expect(cache.hit(identity('a'))).toBeDefined();

    cache.store(identity('d'), table(3)); // four rows; evicts c to stay at six total
    expect(cache.hit(identity('c'))).toBeUndefined();
    expect(cache.hit(identity('a'))).toBeDefined();
    expect(cache.hit(identity('d'))).toBeDefined();
    expect(cache.rowCount).toBe(6);

    cache.store(identity('oversize'), table(6)); // seven rows cannot enter a six-row cache
    expect(cache.hit(identity('oversize'))).toBeUndefined();
    expect(cache.rowCount).toBe(6);

    vi.advanceTimersByTime(100);
    expect(cache.hit(identity('a'))).toBeUndefined();
    expect(cache.hit(identity('d'))).toBeUndefined();
    expect(cache.entryCount).toBe(0);
    expect(cache.rowCount).toBe(0);
    cache.clear();
  });
});
