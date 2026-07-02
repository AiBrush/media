import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { SOURCE_CACHE_KEY } from '../../sources/source.ts';
import { fixtureSource, loadFixture } from '../../test-support/corpus.ts';
import { Mp4Driver, Mp4Module, readMovie, readMovieMetadata } from './mp4-driver.ts';
import { buildSamples } from './samples.ts';
import { type MuxTrackInput, writeMp4 } from './write.ts';

type CacheKeyedByteSource = ByteSource & { readonly [SOURCE_CACHE_KEY]: string };
type MimeHintedByteSource = ByteSource & { readonly mimeHint: string };

function makeRA(bytes: Uint8Array) {
  return {
    read: (o: number, l: number) => Promise.resolve(bytes.subarray(o, o + l)),
    size: bytes.byteLength,
  };
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function byteSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    stream: () => streamBytes(bytes),
    range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
  };
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = joinBytes(payload);
  const out = new Uint8Array(8 + body.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  out.set(ascii(type), 4);
  out.set(body, 8);
  return out;
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payload: Uint8Array[]
): Uint8Array {
  return box(
    type,
    new Uint8Array([version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]),
    ...payload,
  );
}

function mvhd(): Uint8Array {
  return fullBox('mvhd', 0, 0, zeros(8), u32(1000), u32(1000));
}

function tkhd(): Uint8Array {
  return fullBox('tkhd', 0, 0, zeros(8), u32(1));
}

function mdhd(): Uint8Array {
  return fullBox('mdhd', 0, 0, zeros(8), u32(44100), u32(4410));
}

function hdlr(handlerType: string): Uint8Array {
  return fullBox('hdlr', 0, 0, zeros(4), ascii(handlerType));
}

function stsd(...entries: Uint8Array[]): Uint8Array {
  return fullBox('stsd', 0, 0, u32(entries.length), ...entries);
}

function audioEntry(type: string, ...children: Uint8Array[]): Uint8Array {
  return box(
    type,
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 16, 0, 0, 0, 0]),
    u32(44100 * 65536),
    ...children,
  );
}

function smallH264Track(overrides: Partial<MuxTrackInput> = {}): MuxTrackInput {
  return {
    mediaType: 'video',
    sampleEntryType: 'avc1',
    timescale: 600,
    description: new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00]),
    width: 64,
    height: 36,
    samples: [
      { data: new Uint8Array([1, 2, 3]), durationTicks: 300, cttsTicks: 0, keyframe: true },
      { data: new Uint8Array([4, 5]), durationTicks: 300, cttsTicks: 300, keyframe: false },
    ],
    ...overrides,
  };
}

function smallAacTrack(overrides: Partial<MuxTrackInput> = {}): MuxTrackInput {
  return {
    mediaType: 'audio',
    sampleEntryType: 'mp4a',
    timescale: 48000,
    description: new Uint8Array([0x12, 0x10]),
    sampleRate: 48000,
    channels: 2,
    samples: [
      { data: new Uint8Array([9, 8]), durationTicks: 1024, cttsTicks: 0, keyframe: true },
      { data: new Uint8Array([7]), durationTicks: 1024, cttsTicks: 0, keyframe: true },
    ],
    ...overrides,
  };
}

async function blobBytes(
  out: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

describe('Mp4Driver.supports', () => {
  it('recognizes mp4 by ftyp magic, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('movie_5.mp4')).subarray(0, 16);
    expect(Mp4Driver.supports({ direction: 'demux', head })).toBe(true);
    expect(Mp4Driver.supports({ direction: 'demux', mime: 'video/mp4' })).toBe(true);
    expect(Mp4Driver.supports({ direction: 'demux', extension: 'mov' })).toBe(true);
    const webmHead = (await loadFixture('movie_5.webm')).subarray(0, 16);
    expect(Mp4Driver.supports({ direction: 'demux', head: webmHead })).toBe(false);
    expect(Mp4Driver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(Mp4Driver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe (golden-metadata invariants) across the real MP4 corpus', () => {
  it('metadata-only probe returns the same track facts as demux without reading packet streams', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const src = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      size: bytes.byteLength,
      range: (start: number, end: number) => Promise.resolve(bytes.subarray(start, end)),
    };
    const tracks = await Mp4Driver.probe?.(src);
    const demuxer = await Mp4Driver.demux(src);
    try {
      expect(tracks).toEqual(demuxer.tracks);
    } finally {
      await demuxer.close();
    }
  });

  it('metadata-only parser preserves track facts without materializing sample-size tables', async () => {
    const bytes = await loadFixture('test.mp4');
    const metadata = await readMovieMetadata(makeRA(bytes));
    const full = await readMovie(makeRA(bytes));
    expect(metadata.tracks).toHaveLength(full.tracks.length);

    for (const track of metadata.tracks) {
      expect(track.samples.sampleSizes).toHaveLength(0);
      expect(track.samples.sampleToChunk).toHaveLength(0);
      expect(track.samples.chunkOffsets).toHaveLength(0);

      const fullTrack = full.tracks.find((candidate) => candidate.id === track.id);
      expect(fullTrack).toBeDefined();
      if (!fullTrack) continue;
      if (fullTrack.samples.sampleSizes.length > 0) {
        expect(track.samples.timeToSample.length).toBeGreaterThan(0);
      }
      expect({
        id: track.id,
        mediaType: track.mediaType,
        codec: track.codec,
        durationSec: track.durationSec,
        fps: track.fps,
        width: track.width,
        height: track.height,
        rotation: track.rotation,
        sampleRate: track.sampleRate,
        channels: track.channels,
        encrypted: track.encryption !== undefined,
        config: track.config,
      }).toEqual({
        id: fullTrack.id,
        mediaType: fullTrack.mediaType,
        codec: fullTrack.codec,
        durationSec: fullTrack.durationSec,
        fps: fullTrack.fps,
        width: fullTrack.width,
        height: fullTrack.height,
        rotation: fullTrack.rotation,
        sampleRate: fullTrack.sampleRate,
        channels: fullTrack.channels,
        encrypted: fullTrack.encryption !== undefined,
        config: fullTrack.config,
      });
    }
  });

  it('metadata-only probe accepts a range source whose total size is not known yet', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const reads: Array<[number, number]> = [];
    const src: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };
    const tracks = await Mp4Driver.probe?.(src);
    expect(tracks?.length).toBeGreaterThan(0);
    expect(tracks?.some((track) => track.mediaType === 'video')).toBe(true);
    expect(reads).toEqual([[0, 32 * 1024]]);
  });

  it('metadata-only probe clamps faststart prefetch to known tiny source size', async () => {
    const bytes = await loadFixture('2x2-green.mp4');
    expect(bytes.byteLength).toBeLessThan(32 * 1024);
    const reads: Array<[number, number]> = [];
    const src: ByteSource = {
      size: bytes.byteLength,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };

    const tracks = await Mp4Driver.probe?.(src);

    expect(tracks?.length).toBeGreaterThan(0);
    expect(reads[0]).toEqual([0, bytes.byteLength]);
  });

  it('metadata-only probe uses the tiny M4A audio fast path only when the source is known audio', async () => {
    const bytes = writeMp4(
      [
        {
          mediaType: 'audio',
          sampleEntryType: 'mp4a',
          timescale: 44100,
          sampleRate: 44100,
          channels: 1,
          description: new Uint8Array([0x12, 0x08]),
          edit: { mediaTimeTicks: 1024, durationTicks: 4410 },
          samples: [
            { data: new Uint8Array([0x21]), durationTicks: 5434, cttsTicks: 0, keyframe: true },
          ],
        },
      ],
      { faststart: true },
    );
    expect(bytes.byteLength).toBeLessThan(16 * 1024);
    const baselineSource: ByteSource = {
      size: bytes.byteLength,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
    };
    const expected = await Mp4Driver.probe?.(baselineSource);
    const reads: Array<readonly [number, number]> = [];
    const fastSource: CacheKeyedByteSource = {
      ...baselineSource,
      [SOURCE_CACHE_KEY]: 'url:https://fixtures.test/tiny.m4a',
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };

    const tracks = await Mp4Driver.probe?.(fastSource);

    expect(reads).toEqual([[0, bytes.byteLength]]);
    expect(tracks).toEqual(expected);
    expect(tracks?.[0]?.gapless).toEqual({
      leadingSamples: 1024,
      trailingSamples: 0,
      totalSamples: 4410,
    });
  });

  it('metadata-only probe uses an audio MIME hint for tiny M4A and omits gapless without edit timing', async () => {
    const bytes = writeMp4(
      [
        {
          mediaType: 'audio',
          sampleEntryType: 'mp4a',
          timescale: 44100,
          sampleRate: 44100,
          channels: 1,
          description: new Uint8Array([0x12, 0x08]),
          samples: [
            { data: new Uint8Array([0x21]), durationTicks: 4410, cttsTicks: 0, keyframe: true },
          ],
        },
      ],
      { faststart: true },
    );
    const reads: Array<readonly [number, number]> = [];
    const src: MimeHintedByteSource = {
      ...byteSource(bytes),
      mimeHint: 'audio/mp4',
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };

    const tracks = await Mp4Driver.probe?.(src);

    expect(reads).toEqual([[0, bytes.byteLength]]);
    expect(tracks).toHaveLength(1);
    expect(tracks?.[0]?.mediaType).toBe('audio');
    expect(tracks?.[0]?.gapless).toBeUndefined();
  });

  it('metadata-only probe uses a single small faststart read for tiny video MP4 metadata', async () => {
    const bytes = writeMp4([smallH264Track(), smallAacTrack()], { faststart: true });
    expect(bytes.byteLength).toBeLessThan(8 * 1024);
    const expected = await Mp4Driver.probe?.({
      stream: () => streamBytes(bytes),
      range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
    });
    const reads: Array<readonly [number, number]> = [];
    const src: MimeHintedByteSource = {
      ...byteSource(bytes),
      mimeHint: 'video/mp4',
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };

    const tracks = await Mp4Driver.probe?.(src);

    expect(reads).toEqual([[0, bytes.byteLength]]);
    expect(tracks).toEqual(expected);
    expect(tracks?.map((track) => track.mediaType)).toEqual(['video', 'audio']);
  });

  it('metadata-only video faststart probe honors source-key hints and hands cached moov to demux', async () => {
    const bytes = writeMp4([smallH264Track(), smallAacTrack()], { faststart: true });
    const expected = await Mp4Driver.probe?.({
      stream: () => streamBytes(bytes),
      range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
    });
    const cacheKey = 'url:https://fixtures.test/tiny.m4v?download=1';
    const reads: Array<readonly [number, number]> = [];
    const probeSource: CacheKeyedByteSource = {
      ...byteSource(bytes),
      [SOURCE_CACHE_KEY]: cacheKey,
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };

    const tracks = await Mp4Driver.probe?.(probeSource);

    expect(reads).toEqual([[0, bytes.byteLength]]);
    expect(tracks).toEqual(expected);

    const demuxSource: CacheKeyedByteSource = {
      ...byteSource(bytes),
      [SOURCE_CACHE_KEY]: cacheKey,
      range: () => {
        throw new Error('demux should consume the cached faststart moov before reading ranges');
      },
    };
    const demuxer = await Mp4Driver.demux(demuxSource);
    try {
      expect(demuxer.tracks).toEqual(tracks);
    } finally {
      await demuxer.close();
    }
  });

  it('metadata-only video faststart probe also accepts the application/mp4 MIME hint', async () => {
    const bytes = writeMp4([smallH264Track()], { faststart: true });
    const reads: Array<readonly [number, number]> = [];
    const src: MimeHintedByteSource = {
      ...byteSource(bytes),
      mimeHint: 'application/mp4',
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };

    const tracks = await Mp4Driver.probe?.(src);

    expect(reads).toEqual([[0, bytes.byteLength]]);
    expect(tracks).toHaveLength(1);
    expect(tracks?.[0]?.mediaType).toBe('video');
  });

  it('metadata-only probe falls back when the small video faststart parser cannot prove the track shape', async () => {
    const bytes = writeMp4([smallH264Track({ sampleEntryType: 'xxxx' })], { faststart: true });
    const reads: Array<readonly [number, number]> = [];
    const src: MimeHintedByteSource = {
      ...byteSource(bytes),
      mimeHint: 'video/mp4',
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };

    const tracks = await Mp4Driver.probe?.(src);

    expect(reads).toEqual([
      [0, bytes.byteLength],
      [0, bytes.byteLength],
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks?.[0]?.codec).toBe('xxxx');
  });

  it('metadata-only video faststart probe falls back for valid MP4s outside the simple video shape', async () => {
    const smallVideo = writeMp4([smallH264Track()], { faststart: true });
    const oversized = new Uint8Array(256 * 1024 + 64);
    oversized.set(smallVideo);
    const fallbackCases: Array<readonly [string, Uint8Array, string]> = [
      ['audio-only', writeMp4([smallAacTrack()], { faststart: true }), 'audio'],
      [
        'empty-video-sample-table',
        writeMp4([smallH264Track({ samples: [] })], { faststart: true }),
        'video',
      ],
      ['oversized-known-source', oversized, 'video'],
    ];

    for (const [label, bytes, mediaType] of fallbackCases) {
      const reads: Array<readonly [number, number]> = [];
      const src: MimeHintedByteSource = {
        ...byteSource(bytes),
        mimeHint: 'video/mp4',
        range: (start, end) => {
          reads.push([start, end]);
          return Promise.resolve(bytes.subarray(start, end));
        },
      };

      const tracks = await Mp4Driver.probe?.(src);

      expect(tracks?.[0]?.mediaType, label).toBe(mediaType);
      expect(reads.length, label).toBeGreaterThan(0);
      expect(reads[0]?.[0], label).toBe(0);
    }
  });

  it('metadata-only video faststart probe rejects malformed candidates through typed fallback errors', async () => {
    const malformedCases: Array<readonly [string, Uint8Array]> = [
      ['short-header', new Uint8Array([0, 0, 0, 1])],
      ['zero-size-top-box', joinBytes([u32(0), ascii('free')])],
      ['ftyp-only', box('ftyp', ascii('isom'))],
      ['truncated-moov', joinBytes([u32(100), ascii('moov')])],
      ['empty-moov', box('moov')],
      ['mvhd-no-trak', box('moov', mvhd())],
      ['empty-trak', box('moov', mvhd(), box('trak'))],
      ['trak-missing-mdhd-hdlr', box('moov', mvhd(), box('trak', tkhd(), box('mdia')))],
      [
        'video-no-stbl',
        box('moov', mvhd(), box('trak', tkhd(), box('mdia', mdhd(), hdlr('vide')))),
      ],
      [
        'video-empty-stsd',
        box(
          'moov',
          mvhd(),
          box('trak', tkhd(), box('mdia', mdhd(), hdlr('vide'), box('minf', box('stbl', stsd())))),
        ),
      ],
    ];

    for (const [label, bytes] of malformedCases) {
      const reads: Array<readonly [number, number]> = [];
      const src: MimeHintedByteSource = {
        ...byteSource(bytes),
        mimeHint: 'video/mp4',
        range: (start, end) => {
          reads.push([start, end]);
          return Promise.resolve(bytes.subarray(start, end));
        },
      };

      await expect(Mp4Driver.probe?.(src), label).rejects.toBeInstanceOf(MediaError);
      expect(reads[0], label).toEqual([0, bytes.byteLength]);
    }
  });

  it('metadata-only probe rejects malformed tiny M4A candidates through typed fallback errors', async () => {
    const malformedCases: Array<readonly [string, Uint8Array]> = [
      ['short-header', new Uint8Array([0, 0, 0, 1])],
      ['zero-size-top-box', joinBytes([u32(0), ascii('free')])],
      ['ftyp-only', box('ftyp', ascii('isom'))],
      ['truncated-moov', joinBytes([u32(100), ascii('moov')])],
      ['empty-moov', box('moov')],
      ['mvhd-no-trak', box('moov', mvhd())],
      ['empty-trak', box('moov', mvhd(), box('trak'))],
      ['trak-missing-mdhd-hdlr', box('moov', mvhd(), box('trak', tkhd(), box('mdia')))],
      [
        'video-handler',
        box('moov', mvhd(), box('trak', tkhd(), box('mdia', mdhd(), hdlr('vide')))),
      ],
      [
        'audio-no-stbl',
        box('moov', mvhd(), box('trak', tkhd(), box('mdia', mdhd(), hdlr('soun')))),
      ],
      [
        'stsd-entry-count-zero',
        box(
          'moov',
          mvhd(),
          box('trak', tkhd(), box('mdia', mdhd(), hdlr('soun'), box('minf', box('stbl', stsd())))),
        ),
      ],
    ];

    for (const [label, bytes] of malformedCases) {
      const reads: Array<readonly [number, number]> = [];
      const src: CacheKeyedByteSource = {
        ...byteSource(bytes),
        [SOURCE_CACHE_KEY]: `url:https://fixtures.test/${label}.m4a`,
        range: (start, end) => {
          reads.push([start, end]);
          return Promise.resolve(bytes.subarray(start, end));
        },
      };

      await expect(Mp4Driver.probe?.(src), label).rejects.toBeInstanceOf(MediaError);
      expect(reads[0], label).toEqual([0, bytes.byteLength]);
    }
  });

  it('metadata-only probe defers tiny M4A misses to the full parser when the file is otherwise valid', async () => {
    const fallbackCases: Array<readonly [string, Uint8Array, string]> = [
      [
        'non-mp4a-audio-entry',
        box(
          'moov',
          mvhd(),
          box(
            'trak',
            tkhd(),
            box('mdia', mdhd(), hdlr('soun'), box('minf', box('stbl', stsd(audioEntry('alac'))))),
          ),
        ),
        'alac',
      ],
      [
        'mp4a-without-esds',
        box(
          'moov',
          mvhd(),
          box(
            'trak',
            tkhd(),
            box('mdia', mdhd(), hdlr('soun'), box('minf', box('stbl', stsd(audioEntry('mp4a'))))),
          ),
        ),
        'mp4a',
      ],
    ];

    for (const [label, bytes, codec] of fallbackCases) {
      const reads: Array<readonly [number, number]> = [];
      const src: CacheKeyedByteSource = {
        ...byteSource(bytes),
        [SOURCE_CACHE_KEY]: `url:https://fixtures.test/${label}.m4a`,
        range: (start, end) => {
          reads.push([start, end]);
          return Promise.resolve(bytes.subarray(start, end));
        },
      };

      const tracks = await Mp4Driver.probe?.(src);

      expect(reads[0], label).toEqual([0, bytes.byteLength]);
      expect(tracks).toHaveLength(1);
      expect(tracks?.[0]?.codec).toBe(codec);
    }
  });

  it('hands a small parsed movie from probe to an immediately following demux', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const firstReads: Array<readonly [number, number]> = [];
    const cacheKey = 'url:https://fixtures.test/movie_5.mp4';
    const probeSource: CacheKeyedByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      size: bytes.byteLength,
      [SOURCE_CACHE_KEY]: cacheKey,
      range: (start, end) => {
        firstReads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };
    const demuxSource: CacheKeyedByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      size: bytes.byteLength,
      [SOURCE_CACHE_KEY]: cacheKey,
      range: () => {
        throw new Error('demux should consume the parsed movie handoff before reading ranges');
      },
    };

    const tracks = await Mp4Driver.probe?.(probeSource);
    const demuxer = await Mp4Driver.demux(demuxSource);
    try {
      expect(demuxer.tracks).toEqual(tracks);
      expect(firstReads.length).toBeGreaterThan(0);
    } finally {
      await demuxer.close();
    }
  });

  it('metadata-only probe honors cancellation before and after the metadata read', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const source = (range: (start: number, end: number) => Promise<Uint8Array>): ByteSource => ({
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      size: bytes.byteLength,
      range,
    });
    await expect(
      Mp4Driver.probe?.(
        source((start, end) => Promise.resolve(bytes.subarray(start, end))),
        {
          signal: AbortSignal.abort(),
        },
      ),
    ).rejects.toThrow(MediaError);

    const controller = new AbortController();
    let reads = 0;
    await expect(
      Mp4Driver.probe?.(
        source((start, end) => {
          reads++;
          const out = bytes.subarray(start, end);
          controller.abort();
          return Promise.resolve(out);
        }),
        { signal: controller.signal },
      ),
    ).rejects.toThrow(MediaError);
    expect(reads).toBe(1);
  });

  it('omits packetTable for fragmented MP4s whose init sample tables are empty', async () => {
    const bytes = await blobBytes(
      await createMedia()
        .use(Mp4Module)
        .remux(await fixtureSource('movie_5.mp4'), { to: 'mp4', fragmented: true }),
    );
    const src: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      size: bytes.byteLength,
      range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
    };
    const demuxer = await Mp4Driver.demux(src);
    try {
      expect(demuxer.tracks.length).toBeGreaterThan(0);
      expect(demuxer.packetTable).toBeUndefined();
    } finally {
      await demuxer.close();
    }
  });

  it('2x2-green.mp4 — tiny h264 video (exact 2×2) + mp3-in-mp4 audio', async () => {
    const info = await createMedia()
      .use(Mp4Module)
      .probe(await fixtureSource('2x2-green.mp4'));
    expect(info.container).toBe('mp4');
    expect(info.durationSec).toBeGreaterThan(0);
    const video = info.tracks.filter((t) => t.type === 'video');
    expect(video).toHaveLength(1);
    expect(video[0]?.codec.startsWith('avc1.')).toBe(true);
    expect(video[0]?.width).toBe(2);
    expect(video[0]?.height).toBe(2);
    // It also carries an mp3 audio track (oti 0x6b) — preserved verbatim on remux.
    expect(info.tracks.find((t) => t.type === 'audio')?.codec).toBe('mp4a.6b');
  });

  it.each(['movie_5.mp4', 'test.mp4'])(
    '%s — h264 video + aac audio with sane params',
    async (id) => {
      const info = await createMedia()
        .use(Mp4Module)
        .probe(await fixtureSource(id));
      expect(info.container).toBe('mp4');
      expect(info.durationSec).toBeGreaterThan(0.1);

      const video = info.tracks.find((t) => t.type === 'video');
      expect(video?.codec.startsWith('avc1.')).toBe(true);
      expect(video?.width).toBeGreaterThan(0);
      expect(video?.height).toBeGreaterThan(0);

      const audio = info.tracks.find((t) => t.type === 'audio');
      expect(audio?.codec).toBe('mp4a.40.2');
      expect([44100, 48000, 32000, 22050, 24000, 16000]).toContain(audio?.sampleRate);
      expect(audio?.channels).toBeGreaterThanOrEqual(1);
    },
  );
});

describe('demux sample tables (golden-packets invariants)', () => {
  it.each(['2x2-green.mp4', 'movie_5.mp4', 'test.mp4'])(
    '%s — samples reference real in-bounds bytes with monotonic DTS and a leading keyframe',
    async (id) => {
      const bytes = await loadFixture(id);
      const movie = await readMovie(makeRA(bytes));
      expect(movie.brand.length).toBe(4);

      for (const track of movie.tracks) {
        const samples = buildSamples(track);
        expect(samples.length).toBe(track.samples.sampleSizes.length);
        expect(samples.length).toBeGreaterThan(0);

        // Every sample points at real, in-bounds file bytes.
        for (const s of samples) {
          expect(s.offset).toBeGreaterThanOrEqual(0);
          expect(s.offset + s.size).toBeLessThanOrEqual(bytes.byteLength);
        }
        // DTS is monotonically non-decreasing.
        for (let i = 1; i < samples.length; i++) {
          expect(samples[i]?.dtsUs).toBeGreaterThanOrEqual(samples[i - 1]?.dtsUs ?? 0);
        }
        // Video must begin on a keyframe; audio frames are all sync.
        expect(samples[0]?.keyframe).toBe(true);
        // Sizes sum to the stsz total (no samples dropped/duplicated).
        const sumSizes = samples.reduce((a, s) => a + s.size, 0);
        const stszTotal = track.samples.sampleSizes.reduce((a, n) => a + n, 0);
        expect(sumSizes).toBe(stszTotal);
      }
    },
  );

  it('preserves B-frame reordering: some PTS differs from DTS when ctts is present', async () => {
    const bytes = await loadFixture('test.mp4');
    const movie = await readMovie(makeRA(bytes));
    const video = movie.tracks.find((t) => t.mediaType === 'video');
    expect(video).toBeDefined();
    if (video && video.samples.compositionOffsets.length > 0) {
      const samples = buildSamples(video);
      expect(samples.some((s) => s.ptsUs !== s.dtsUs)).toBe(true);
    }
  });
});

describe('demux over a non-seekable source + browser-only seam', () => {
  it('buffers a range-less source and still demuxes tracks', async () => {
    const bytes = await loadFixture('2x2-green.mp4');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxer = await Mp4Driver.demux(streamSource);
    expect(demuxer.tracks.length).toBeGreaterThan(0);
    const firstId = demuxer.tracks[0]?.id ?? 0;

    // In node (no WebCodecs) the packet seam raises a typed CapabilityError, not a crash.
    expect(() => demuxer.packets(firstId)).toThrowError(CapabilityError);
    // An unknown track id is a typed demux error.
    expect(() => demuxer.packets(9999)).toThrowError(MediaError);
    await demuxer.close();
  });

  it('createMuxer returns a Muxer over the byte-muxer (round-trip covered in mux.test.ts)', () => {
    const muxer = Mp4Driver.createMuxer({ faststart: true });
    expect(muxer.output).toBeInstanceOf(ReadableStream);
    expect(typeof muxer.addTrack).toBe('function');
    expect(typeof muxer.write).toBe('function');
    expect(typeof muxer.finalize).toBe('function');
    // addTrack allocates a positive track id (write()'s real-EncodedChunk path is browser-only).
    const id = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      config: { codec: 'avc1.42C01E', codedWidth: 4, codedHeight: 4 },
    });
    expect(id).toBeGreaterThan(0);
  });

  it('createMuxer accepts a fragmented mux (CMAF output, ADR-034)', () => {
    // Fragmented/CMAF mux is now supported: the muxer constructs (it emits init + moof segments on
    // finalize). The full fragmented round-trip is validated in mux.test.ts; here we only assert that
    // requesting it no longer raises a capability miss.
    expect(() => Mp4Driver.createMuxer({ fragmented: true })).not.toThrow();
  });
});
