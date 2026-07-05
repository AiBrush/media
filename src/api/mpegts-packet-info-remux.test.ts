import { describe, expect, it } from 'vitest';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import type {
  ContainerDriver,
  Demuxer,
  Muxer,
  PacketInfoMetadata,
  PacketInfoTable,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { parseTs } from '../drivers/mpegts/ts-parse.ts';
import type { Source } from '../sources/source.ts';
import { tryRemuxPacketInfoToMpegTs } from './mpegts-packet-info-remux.ts';
import type { RemuxOptions } from './types.ts';

const AAC_TRACK: TrackInfo = {
  id: 1,
  mediaType: 'audio',
  codec: 'mp4a.40.2',
  config: {
    codec: 'mp4a.40.2',
    sampleRate: 48_000,
    numberOfChannels: 2,
    description: new Uint8Array([0x11, 0x90]),
  },
};

const VIDEO_TRACK: TrackInfo = {
  id: 2,
  mediaType: 'video',
  codec: 'h264',
  config: {
    codec: 'avc1.42E01E',
    codedWidth: 16,
    codedHeight: 16,
  },
};

const UNDESCRIBED_TRACK: TrackInfo = {
  id: 3,
  mediaType: 'audio',
  codec: 'mp4a.40.2',
};

type PacketOverrides = Omit<Partial<PacketInfoMetadata>, 'durationUs'> & {
  readonly durationUs?: number;
  readonly withDuration?: boolean;
};

function packet(options: PacketOverrides = {}): PacketInfoMetadata {
  const { durationUs, withDuration = true, ...overrides } = options;
  return {
    trackIndex: 0,
    offset: 0,
    size: 4,
    ptsUs: 0,
    dtsUs: 0,
    keyframe: true,
    ...(withDuration ? { durationUs: durationUs ?? 21_333 } : {}),
    ...overrides,
  };
}

function packetInfoContainer(
  table: PacketInfoTable,
  options: {
    readonly id?: string;
    readonly formats?: readonly string[];
    readonly includePacketInfo?: boolean;
  } = {},
): ContainerDriver {
  const base: ContainerDriver = {
    id: options.id ?? 'mp4',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: options.formats ?? ['mp4'],
    supports: () => true,
    demux: async (): Promise<Demuxer> => {
      throw new Error('demux should not run in packet-info remux tests');
    },
    createMuxer: (): Muxer => {
      throw new Error('createMuxer should not run in packet-info remux tests');
    },
  };
  if (options.includePacketInfo === false) return base;
  return { ...base, packetInfo: async () => table };
}

function source(
  bytes: Uint8Array,
  options: {
    readonly includeRange?: boolean;
    readonly includeSize?: boolean;
    readonly size?: number;
    readonly range?: Source['range'];
  } = {},
): Source {
  const includeRange = options.includeRange ?? true;
  const includeSize = options.includeSize ?? true;
  const base: Source = {
    __media: 'source',
    kind: 'bytes',
    stream: (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  };
  return {
    ...base,
    ...(includeSize ? { size: options.size ?? bytes.byteLength } : {}),
    ...(includeRange
      ? { range: options.range ?? (async (start, end) => bytes.subarray(start, end)) }
      : {}),
  };
}

function packetWithoutOffset(): PacketInfoMetadata {
  return {
    trackIndex: 0,
    size: 4,
    ptsUs: 0,
    dtsUs: 0,
    durationUs: 21_333,
    keyframe: true,
  };
}

async function collect(stream: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array> {
  if (stream === undefined) throw new Error('expected byte stream');
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

describe('tryRemuxPacketInfoToMpegTs', () => {
  const bytes = new Uint8Array([0x21, 0x10, 0x04, 0x60, 0xaa, 0xbb, 0xcc, 0xdd]);
  const table: PacketInfoTable = {
    tracks: [AAC_TRACK, VIDEO_TRACK],
    packets: [packet(), packet({ trackIndex: 1, offset: 4, withDuration: false })],
  };

  it('authors MPEG-TS directly from selected MP4 packet-info byte offsets', async () => {
    const out = await collect(
      await tryRemuxPacketInfoToMpegTs(
        packetInfoContainer(table),
        source(bytes),
        { to: 'ts', trackSelect: ['audio:0'] },
        {},
      ),
    );

    expect(out.byteLength).toBeGreaterThan(0);
    expect(out.byteLength % 188).toBe(0);
    const parsed = parseTs(out);
    expect(parsed.tracks.map((track) => track.stream.codec)).toEqual(['aac']);
    expect(parsed.tracks[0]?.units.length).toBe(1);
  });

  it('authors selected packet-info rows without optional packet durations', async () => {
    const out = await collect(
      await tryRemuxPacketInfoToMpegTs(
        packetInfoContainer({
          tracks: [AAC_TRACK],
          packets: [packet({ withDuration: false })],
        }),
        source(bytes),
        { to: 'ts' },
        {},
      ),
    );

    expect(out.byteLength).toBeGreaterThan(0);
    expect(out.byteLength % 188).toBe(0);
    const parsed = parseTs(out);
    expect(parsed.tracks.map((track) => track.stream.codec)).toEqual(['aac']);
    expect(parsed.tracks[0]?.units.length).toBe(1);
  });

  it('returns undefined before output for ineligible remux shapes', async () => {
    const goodContainer = packetInfoContainer(table);
    const goodSource = source(bytes);
    const cases: Array<{
      readonly container: ContainerDriver;
      readonly src: Source;
      readonly opts: RemuxOptions;
    }> = [
      { container: goodContainer, src: goodSource, opts: { to: 'mp4' } },
      { container: goodContainer, src: goodSource, opts: { to: 'ts', fragmented: true } },
      {
        container: packetInfoContainer(table, { id: 'webm', formats: ['webm'] }),
        src: goodSource,
        opts: { to: 'ts' },
      },
      {
        container: packetInfoContainer(table, { includePacketInfo: false }),
        src: goodSource,
        opts: { to: 'ts' },
      },
      {
        container: goodContainer,
        src: source(bytes, { includeRange: false }),
        opts: { to: 'ts' },
      },
      {
        container: goodContainer,
        src: source(bytes, { includeSize: false }),
        opts: { to: 'ts' },
      },
      {
        container: goodContainer,
        src: source(bytes, { size: 64 * 1024 * 1024 + 1 }),
        opts: { to: 'ts' },
      },
    ];

    for (const testCase of cases) {
      await expect(
        tryRemuxPacketInfoToMpegTs(testCase.container, testCase.src, testCase.opts, {}),
      ).resolves.toBeUndefined();
    }
  });

  it('keeps typed exits for aborts and invalid packet-info proofs', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      tryRemuxPacketInfoToMpegTs(
        packetInfoContainer(table),
        source(bytes),
        { to: 'ts' },
        {
          signal: aborted.signal,
        },
      ),
    ).rejects.toBeInstanceOf(MediaError);

    await expect(
      tryRemuxPacketInfoToMpegTs(
        packetInfoContainer({ tracks: [UNDESCRIBED_TRACK], packets: [] }),
        source(bytes),
        { to: 'ts' },
        {},
      ),
    ).rejects.toBeInstanceOf(CapabilityError);

    await expect(
      tryRemuxPacketInfoToMpegTs(
        packetInfoContainer(table),
        source(bytes),
        { to: 'ts', trackSelect: ['video:1'] },
        {},
      ),
    ).rejects.toBeInstanceOf(InputError);

    await expect(
      tryRemuxPacketInfoToMpegTs(
        packetInfoContainer(table),
        source(bytes, { range: async () => bytes.subarray(0, 2) }),
        { to: 'ts' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'demux-error' });

    await expect(
      tryRemuxPacketInfoToMpegTs(
        packetInfoContainer({ tracks: [AAC_TRACK], packets: [packetWithoutOffset()] }),
        source(bytes),
        { to: 'ts' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'demux-error' });

    await expect(
      tryRemuxPacketInfoToMpegTs(
        packetInfoContainer({ tracks: [AAC_TRACK], packets: [packet({ size: 0 })] }),
        source(bytes),
        { to: 'ts' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'demux-error' });

    await expect(
      tryRemuxPacketInfoToMpegTs(
        packetInfoContainer({ tracks: [AAC_TRACK], packets: [] }),
        source(bytes),
        { to: 'ts' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'mux-error' });
  });
});
