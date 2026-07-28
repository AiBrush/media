import { describe, expect, it, vi } from 'vitest';
import type { ContainerDriver, PacketInfoTable, TrackInfo } from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { demuxWebm } from '../drivers/webm/webm-driver.ts';
import type { Source } from '../sources/source.ts';
import { tryRemuxPacketInfoToBufferedWebm } from './webm-packet-info-remux.ts';

const TRACK: TrackInfo = {
  id: 1,
  mediaType: 'audio',
  codec: 'mp4a.40.2',
  durationSec: 0.066,
  config: {
    codec: 'mp4a.40.2',
    sampleRate: 48_000,
    numberOfChannels: 2,
    description: Uint8Array.of(0x11, 0x90),
  },
};

const TABLE: PacketInfoTable = {
  tracks: [TRACK],
  packets: [
    {
      trackIndex: 0,
      offset: 0,
      size: 3,
      ptsUs: 0,
      dtsUs: 0,
      durationUs: 33_000,
      keyframe: true,
    },
    {
      trackIndex: 0,
      offset: 3,
      size: 3,
      ptsUs: 33_000,
      dtsUs: 33_000,
      durationUs: 33_000,
      keyframe: false,
    },
  ],
};

function container(table: PacketInfoTable = TABLE): ContainerDriver {
  return {
    id: 'mp4',
    kind: 'container',
    apiVersion: DRIVER_API_VERSION,
    formats: ['mp4', 'mov'],
    supports: () => true,
    packetInfo: vi.fn(async () => table),
    demux: vi.fn(() => {
      throw new Error('prepared packet-info remux must not construct payload streams');
    }),
    createMuxer: vi.fn(() => {
      throw new Error('prepared packet-info remux must not construct the generic muxer');
    }),
  };
}

function source(bytes: Uint8Array, overrides: Partial<Source> = {}, includeRange = true): Source {
  return {
    __media: 'source',
    kind: 'bytes',
    size: bytes.byteLength,
    mimeHint: 'video/mp4',
    stream: () => {
      throw new Error('prepared packet-info remux must not drain the source stream');
    },
    ...(includeRange ? { range: vi.fn(async (start, end) => bytes.subarray(start, end)) } : {}),
    ...overrides,
  };
}

async function collect(stream: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array> {
  if (stream === undefined) throw new Error('expected prepared WebM output');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe('tryRemuxPacketInfoToBufferedWebm', () => {
  it('authors one complete Matroska snapshot from packet byte views', async () => {
    const input = Uint8Array.of(1, 2, 3, 4, 5, 6);
    const src = source(input);
    const driver = container();
    const output = await collect(
      await tryRemuxPacketInfoToBufferedWebm(driver, src, { to: 'mkv' }, {}),
    );
    const parsed = demuxWebm(output);

    expect(parsed.info.container).toBe('mkv');
    expect(parsed.info.tracks[0]?.codec).toBe('aac');
    expect(parsed.framesByIndex[0]?.map((frame) => [...frame.data])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(src.range).toHaveBeenCalledTimes(1);
    expect(src.range).toHaveBeenCalledWith(0, input.byteLength, undefined);
    expect(driver.packetInfo).toHaveBeenCalledTimes(1);
    expect(driver.demux).not.toHaveBeenCalled();
    expect(driver.createMuxer).not.toHaveBeenCalled();
  });

  it('serializes MP4 AAC priming as CodecDelay without shifting packet presentation time', async () => {
    const input = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const gaplessTrack: TrackInfo = {
      ...TRACK,
      durationSec: 0.099,
      gapless: {
        basis: 'mp4-edit-list',
        leadingSamples: 2048,
        totalSamples: 4752,
      },
    };
    const output = await collect(
      await tryRemuxPacketInfoToBufferedWebm(
        container({
          tracks: [gaplessTrack],
          packets: [-42_667, -9_667, 23_333].map((ptsUs, index) => ({
            trackIndex: 0,
            offset: index * 3,
            size: 3,
            ptsUs,
            dtsUs: index * 33_000,
            durationUs: 33_000,
            keyframe: true,
          })),
        }),
        source(input),
        { to: 'mkv' },
        {},
      ),
    );
    const parsed = demuxWebm(output);
    const audio = parsed.info.tracks[0];
    expect(audio?.codecDelayNs).toBe(42_666_667);
    expect(parsed.framesByIndex[0]?.map((frame) => frame.timestampUs)).toEqual([
      -43_000, -10_000, 23_000,
    ]);
  });

  it('keeps the declared coded duration for prepared MP3 because MP3 gapless trim is not authored', async () => {
    const input = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    const mp3Track: TrackInfo = {
      id: 1,
      mediaType: 'audio',
      codec: 'mp3',
      durationSec: 0.099,
      gapless: {
        leadingSamples: 1_584,
        trailingSamples: 0,
        totalSamples: 3_168,
      },
      config: {
        codec: 'mp3',
        sampleRate: 48_000,
        numberOfChannels: 2,
      },
    };
    const output = await collect(
      await tryRemuxPacketInfoToBufferedWebm(
        container({
          tracks: [mp3Track],
          packets: [0, 33_000, 66_000].map((ptsUs, index) => ({
            trackIndex: 0,
            offset: index * 3,
            size: 3,
            ptsUs,
            dtsUs: ptsUs,
            durationUs: 33_000,
            keyframe: true,
          })),
        }),
        source(input),
        { to: 'mkv' },
        {},
      ),
    );
    expect(demuxWebm(output).info.durationSec).toBeCloseTo(0.099, 6);
  });

  it('preserves MP4 video colour and rotation facts in the prepared Matroska TrackEntry', async () => {
    const input = Uint8Array.of(1, 2, 3);
    const video: TrackInfo = {
      id: 1,
      mediaType: 'video',
      codec: 'avc1.64002A',
      durationSec: 0.033,
      fps: 30,
      rotation: 90,
      color: {
        matrixCoefficients: 1,
        transferCharacteristics: 1,
        primaries: 1,
        range: 1,
      },
      config: {
        codec: 'avc1.64002A',
        codedWidth: 1080,
        codedHeight: 1920,
        description: Uint8Array.of(1, 0x64, 0, 0x2a, 0xff),
      },
    };
    const output = await collect(
      await tryRemuxPacketInfoToBufferedWebm(
        container({
          tracks: [video],
          packets: [
            {
              trackIndex: 0,
              offset: 0,
              size: input.byteLength,
              ptsUs: 0,
              dtsUs: 0,
              durationUs: 33_000,
              keyframe: true,
            },
          ],
        }),
        source(input),
        { to: 'mkv' },
        {},
      ),
    );
    const parsed = demuxWebm(output).info.tracks[0];
    expect(parsed?.rotation).toBe(90);
    expect(parsed?.color).toEqual(video.color);
  });

  it('retains the incremental seam outside the bounded eligible shape', async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6);
    const driver = container();
    const cases = [
      { driver, src: source(bytes), to: 'mp4' as const },
      { driver, src: source(bytes), to: 'mkv' as const, fragmented: true },
      {
        driver,
        src: source(bytes, { size: 64 * 1024 * 1024 + 1 }),
        to: 'mkv' as const,
      },
      {
        driver: { ...driver, id: 'webm' },
        src: source(bytes),
        to: 'mkv' as const,
      },
      {
        driver,
        src: source(bytes, {}, false),
        to: 'mkv' as const,
      },
    ];

    for (const testCase of cases) {
      await expect(
        tryRemuxPacketInfoToBufferedWebm(
          testCase.driver,
          testCase.src,
          {
            to: testCase.to,
            ...(testCase.fragmented === true ? { fragmented: true } : {}),
          },
          {},
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects codecs outside literal WebM while retaining the broader Matroska packet-copy route', async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6);
    await expect(
      tryRemuxPacketInfoToBufferedWebm(container(), source(bytes), { to: 'webm' }, {}),
    ).rejects.toMatchObject({
      code: 'capability-miss',
      message: expect.stringContaining("audio codec 'mp4a.40.2'"),
    });

    const opusTrack: TrackInfo = {
      ...TRACK,
      codec: 'opus',
      config: {
        codec: 'opus',
        sampleRate: 48_000,
        numberOfChannels: 2,
        description: Uint8Array.of(
          0x4f,
          0x70,
          0x75,
          0x73,
          0x48,
          0x65,
          0x61,
          0x64,
          1,
          2,
          0,
          0,
          0x80,
          0xbb,
          0,
          0,
          0,
          0,
          0,
        ),
      },
    };
    await expect(
      tryRemuxPacketInfoToBufferedWebm(
        container({ ...TABLE, tracks: [opusTrack] }),
        source(bytes),
        { to: 'webm' },
        {},
      ),
    ).resolves.toBeInstanceOf(ReadableStream);
  });

  it('rejects aborts, short snapshots, and invalid packet ranges', async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      tryRemuxPacketInfoToBufferedWebm(
        container(),
        source(bytes),
        { to: 'mkv' },
        {
          signal: aborted.signal,
        },
      ),
    ).rejects.toBeInstanceOf(MediaError);

    await expect(
      tryRemuxPacketInfoToBufferedWebm(
        container(),
        source(bytes, { range: vi.fn(async () => bytes.subarray(0, 2)) }),
        { to: 'mkv' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'demux-error' });

    await expect(
      tryRemuxPacketInfoToBufferedWebm(
        container({
          tracks: [TRACK],
          packets: [
            {
              trackIndex: 0,
              offset: bytes.byteLength,
              size: 3,
              ptsUs: 0,
              dtsUs: 0,
              durationUs: 33_000,
              keyframe: true,
            },
          ],
        }),
        source(bytes),
        { to: 'mkv' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'demux-error' });
  });
});
