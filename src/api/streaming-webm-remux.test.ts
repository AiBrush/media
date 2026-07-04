import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerDriver,
  Demuxer,
  Packet,
  PacketInfoMetadata,
  PacketInfoTable,
  PacketMetadata,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { parseWebm } from '../drivers/webm/webm-driver.ts';
import { type Source, fromBytes } from '../sources/source.ts';
import { remuxViaStreamingWebm } from './streaming-webm-remux.ts';

const source = fromBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));

function installChunkConstructors(): () => void {
  const originalVideo = globalThis.EncodedVideoChunk;
  const originalAudio = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: function EncodedVideoChunk(): void {},
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    value: function EncodedAudioChunk(): void {},
  });
  return (): void => {
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: originalVideo,
    });
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: originalAudio,
    });
  };
}

function removeChunkConstructors(): () => void {
  const originalVideo = globalThis.EncodedVideoChunk;
  const originalAudio = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', { configurable: true, value: undefined });
  return (): void => {
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: originalVideo,
    });
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: originalAudio,
    });
  };
}

function removeOnlyAudioChunkConstructor(): () => void {
  const originalVideo = globalThis.EncodedVideoChunk;
  const originalAudio = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: function EncodedVideoChunk(): void {},
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', { configurable: true, value: undefined });
  return (): void => {
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: originalVideo,
    });
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: originalAudio,
    });
  };
}

function fakeChunk(init: {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration?: number;
  readonly data: readonly number[];
}): EncodedVideoChunk {
  const bytes = Uint8Array.from(init.data);
  return {
    type: init.type,
    timestamp: init.timestamp,
    duration: init.duration,
    byteLength: bytes.byteLength,
    copyTo(destination: AllowSharedBufferSource): void {
      const out = ArrayBuffer.isView(destination)
        ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
        : new Uint8Array(destination);
      out.set(bytes);
    },
  } as EncodedVideoChunk;
}

function packet(
  type: EncodedVideoChunkType,
  timestamp: number,
  data: readonly number[],
  dtsUs = timestamp,
): Packet {
  return {
    chunk: fakeChunk({ type, timestamp, duration: 33_000, data }),
    dtsUs,
  };
}

function packetStream(packets: readonly Packet[]): ReadableStream<Packet> {
  return new ReadableStream<Packet>({
    start(controller): void {
      for (const pkt of packets) controller.enqueue(pkt);
      controller.close();
    },
  });
}

function failingPacketStream(error: Error): ReadableStream<Packet> {
  return new ReadableStream<Packet>({
    pull(controller): void {
      controller.error(error);
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function containerWith(demuxer: Demuxer): ContainerDriver {
  return {
    id: 'fake-mp4',
    apiVersion: 1,
    kind: 'container',
    formats: ['mp4'],
    supports: () => true,
    demux: vi.fn(async () => demuxer),
    createMuxer: () => {
      throw new Error('not used');
    },
  };
}

function containerWithPacketInfo(table: PacketInfoTable): ContainerDriver {
  return {
    id: 'fake-mp4-packet-info',
    apiVersion: 1,
    kind: 'container',
    formats: ['mp4'],
    supports: () => true,
    packetInfo: vi.fn(async () => table),
    demux: vi.fn(async () => {
      throw new Error('packet-info remux path must not demux packet streams');
    }),
    createMuxer: () => {
      throw new Error('not used');
    },
  };
}

function demuxerWith(
  tracks: readonly TrackInfo[],
  packets: readonly Packet[] = [],
  packetTable?: readonly PacketMetadata[],
): Demuxer & { close: ReturnType<typeof vi.fn> } {
  return {
    tracks,
    ...(packetTable !== undefined ? { packetTable: () => packetTable } : {}),
    packets: () => packetStream(packets),
    close: vi.fn(async () => undefined),
  };
}

function demuxerWithTrackPackets(
  tracks: readonly TrackInfo[],
  packetsByTrack: ReadonlyMap<number, readonly Packet[]>,
  packetTable?: readonly PacketMetadata[],
): Demuxer & { close: ReturnType<typeof vi.fn> } {
  return {
    tracks,
    ...(packetTable !== undefined ? { packetTable: () => packetTable } : {}),
    packets: (trackId: number) => packetStream(packetsByTrack.get(trackId) ?? []),
    close: vi.fn(async () => undefined),
  };
}

function erroredDemuxer(
  tracks: readonly TrackInfo[],
  trackId: number,
  error: Error,
  closeError?: Error,
): Demuxer & { close: ReturnType<typeof vi.fn> } {
  return {
    tracks,
    packets: (id: number) => (id === trackId ? failingPacketStream(error) : packetStream([])),
    close: vi.fn(async () => {
      if (closeError !== undefined) throw closeError;
    }),
  };
}

type PacketInfoDemuxer = Demuxer & {
  readonly packetInfoTable: () => readonly PacketInfoMetadata[];
  readonly packets: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
};

describe('remuxViaStreamingWebm', () => {
  it('raises a typed miss before demuxing when EncodedChunk constructors are unavailable', async () => {
    const restore = removeChunkConstructors();
    const demuxer = demuxerWith([]);
    const container = containerWith(demuxer);
    try {
      await expect(remuxViaStreamingWebm(container, source, { to: 'mkv' }, {})).rejects.toThrow(
        CapabilityError,
      );
      expect(container.demux).not.toHaveBeenCalled();
      expect(demuxer.close).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('requires both video and audio EncodedChunk constructors before demuxing', async () => {
    const restore = removeOnlyAudioChunkConstructor();
    const demuxer = demuxerWith([]);
    const container = containerWith(demuxer);
    try {
      await expect(remuxViaStreamingWebm(container, source, { to: 'webm' }, {})).rejects.toThrow(
        CapabilityError,
      );
      expect(container.demux).not.toHaveBeenCalled();
      expect(demuxer.close).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('closes the demuxer when no selected track has codec config', async () => {
    const restore = installChunkConstructors();
    const demuxer = demuxerWith([{ id: 1, mediaType: 'video', codec: 'vp9' }]);
    try {
      await expect(
        remuxViaStreamingWebm(containerWith(demuxer), source, { to: 'webm' }, {}),
      ).rejects.toThrow(CapabilityError);
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('streams fake EncodedChunks into a parseable MKV without buffering the packet table', async () => {
    const restore = installChunkConstructors();
    const track: TrackInfo = {
      id: 7,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      durationSec: 0.099,
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const packets = [
      packet('key', 0, [1, 2, 3]),
      packet('delta', 33_000, [4, 5]),
      packet('key', 66_000, [6, 7, 8, 9]),
    ];
    const table: PacketMetadata[] = packets.map((pkt) => ({
      trackId: track.id,
      sizeBytes: pkt.chunk.byteLength,
      ptsUs: pkt.chunk.timestamp,
      dtsUs: pkt.dtsUs ?? pkt.chunk.timestamp,
      durationUs: pkt.chunk.duration ?? 0,
      keyframe: pkt.chunk.type === 'key',
    }));
    const demuxer = demuxerWith([track], packets, table);
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        source as Source,
        { to: 'mkv' },
        {},
      );
      const bytes = await collect(stream);
      const parsed = parseWebm(bytes);
      expect(parsed.container).toBe('mkv');
      expect(parsed.tracks[0]?.codec).toBe('vp9');
      expect(parsed.tracks[0]?.width).toBe(2);
      expect(parsed.tracks[0]?.height).toBe(2);
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('remuxes packet-info offsets directly from source ranges without demuxing packet streams', async () => {
    const restore = installChunkConstructors();
    const mediaBytes = Uint8Array.from([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    const rangeCalls: Array<readonly [number, number]> = [];
    const range = vi.fn(async (start: number, end: number): Promise<Uint8Array> => {
      rangeCalls.push([start, end]);
      return mediaBytes.subarray(start, end);
    });
    const rangedSource: Source = {
      __media: 'source',
      kind: 'bytes',
      size: mediaBytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('packet-info remux path must not stream the full source');
      },
      range,
    };
    const track: TrackInfo = {
      id: 5,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      durationSec: 0.099,
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const table: PacketInfoTable = {
      tracks: [track],
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
          size: 2,
          ptsUs: 33_000,
          dtsUs: 33_000,
          durationUs: 33_000,
          keyframe: false,
        },
        {
          trackIndex: 0,
          offset: 5,
          size: 4,
          ptsUs: 66_000,
          dtsUs: 66_000,
          durationUs: 33_000,
          keyframe: true,
        },
      ],
    };
    const container = containerWithPacketInfo(table);
    try {
      const stream = await remuxViaStreamingWebm(container, rangedSource, { to: 'mkv' }, {});
      const bytes = await collect(stream);
      const parsed = parseWebm(bytes);
      expect(parsed.container).toBe('mkv');
      expect(parsed.tracks[0]?.codec).toBe('vp9');
      expect(parsed.tracks[0]?.width).toBe(2);
      expect(parsed.tracks[0]?.height).toBe(2);
      expect(container.packetInfo).toHaveBeenCalledTimes(1);
      expect(container.demux).not.toHaveBeenCalled();
      expect(rangeCalls).toEqual([[0, mediaBytes.byteLength]]);
    } finally {
      restore();
    }
  });

  it('raises a typed packet-info miss before demuxing when no track has codec config', async () => {
    const restore = installChunkConstructors();
    const table: PacketInfoTable = {
      tracks: [{ id: 13, mediaType: 'video', codec: 'vp09.00.10.08' }],
      packets: [],
    };
    const container = containerWithPacketInfo(table);
    try {
      await expect(remuxViaStreamingWebm(container, source, { to: 'mkv' }, {})).rejects.toThrow(
        CapabilityError,
      );
      expect(container.packetInfo).toHaveBeenCalledTimes(1);
      expect(container.demux).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('rejects invalid packet-info byte ranges before reading source payloads', async () => {
    const restore = installChunkConstructors();
    const rangedSource: Source = {
      __media: 'source',
      kind: 'bytes',
      size: 4,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('invalid packet-info range path must not stream the full source');
      },
      range: vi.fn(async () => Uint8Array.from([1, 2, 3, 4])),
    };
    const track: TrackInfo = {
      id: 14,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const badRanges: ReadonlyArray<{ readonly offset: number; readonly size: number }> = [
      { offset: -1, size: 2 },
      { offset: 0, size: -1 },
    ];
    try {
      for (const badRange of badRanges) {
        const table: PacketInfoTable = {
          tracks: [track],
          packets: [
            {
              trackIndex: 0,
              offset: badRange.offset,
              size: badRange.size,
              ptsUs: 0,
              dtsUs: 0,
              durationUs: 33_000,
              keyframe: true,
            },
          ],
        };
        const container = containerWithPacketInfo(table);
        await expect(
          remuxViaStreamingWebm(container, rangedSource, { to: 'mkv' }, {}),
        ).rejects.toThrow('invalid byte range');
        expect(container.demux).not.toHaveBeenCalled();
      }
      expect(rangedSource.range).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('keeps distant packet-info payloads in separate range windows', async () => {
    const restore = installChunkConstructors();
    const secondOffset = 9 * 1024 * 1024;
    const rangeCalls: Array<readonly [number, number]> = [];
    const rangedSource: Source = {
      __media: 'source',
      kind: 'bytes',
      size: secondOffset + 1,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('separate packet-info range path must not stream the full source');
      },
      range: vi.fn(async (start: number, end: number): Promise<Uint8Array> => {
        rangeCalls.push([start, end]);
        return Uint8Array.of(start === 0 ? 1 : 2);
      }),
    };
    const track: TrackInfo = {
      id: 18,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      durationSec: 0.066,
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const table: PacketInfoTable = {
      tracks: [track],
      packets: [
        {
          trackIndex: 0,
          offset: 0,
          size: 1,
          ptsUs: 0,
          dtsUs: 0,
          durationUs: 33_000,
          keyframe: true,
        },
        {
          trackIndex: 0,
          offset: secondOffset,
          size: 1,
          ptsUs: 33_000,
          dtsUs: 33_000,
          durationUs: 33_000,
          keyframe: false,
        },
      ],
    };
    const container = containerWithPacketInfo(table);
    try {
      const stream = await remuxViaStreamingWebm(container, rangedSource, { to: 'mkv' }, {});
      const bytes = await collect(stream);
      expect(parseWebm(bytes).tracks[0]?.codec).toBe('vp9');
      expect(rangeCalls).toEqual([
        [0, 1],
        [secondOffset, secondOffset + 1],
      ]);
      expect(container.demux).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('uses a demuxer packet-info table with offsets for direct range remux and closes the demuxer', async () => {
    const restore = installChunkConstructors();
    const mediaBytes = Uint8Array.from([20, 21, 22, 23, 24, 25, 26]);
    const rangeCalls: Array<readonly [number, number]> = [];
    const rangedSource: Source = {
      __media: 'source',
      kind: 'bytes',
      size: mediaBytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('packet-info demuxer path must not stream the full source');
      },
      range: vi.fn(async (start: number, end: number): Promise<Uint8Array> => {
        rangeCalls.push([start, end]);
        return mediaBytes.subarray(start, end);
      }),
    };
    const track: TrackInfo = {
      id: 7,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      durationSec: 0.066,
      config: { codec: 'vp09.00.10.08', codedWidth: 4, codedHeight: 4 },
    };
    const demuxer: PacketInfoDemuxer = {
      tracks: [track],
      packetInfoTable: () => [
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
          size: 4,
          ptsUs: 33_000,
          dtsUs: 33_000,
          durationUs: 33_000,
          keyframe: false,
        },
      ],
      packets: vi.fn(() => {
        throw new Error('packet-info demuxer path must not open packet streams');
      }),
      close: vi.fn(async () => undefined),
    };
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        rangedSource,
        { to: 'mkv' },
        {},
      );
      const bytes = await collect(stream);
      const parsed = parseWebm(bytes);
      expect(parsed.container).toBe('mkv');
      expect(parsed.tracks[0]?.codec).toBe('vp9');
      expect(demuxer.packets).not.toHaveBeenCalled();
      expect(demuxer.close).toHaveBeenCalledTimes(1);
      expect(rangeCalls).toEqual([[0, mediaBytes.byteLength]]);
    } finally {
      restore();
    }
  });

  it('surfaces a typed miss when a range-readable source disappears before packet-info payload reads', async () => {
    const restore = installChunkConstructors();
    let rangeLookups = 0;
    const intermittentSource: Source = {
      __media: 'source',
      kind: 'bytes',
      size: 1,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('intermittent packet-info range path must not stream the full source');
      },
      range: async () => Uint8Array.of(1),
    };
    Object.defineProperty(intermittentSource, 'range', {
      configurable: true,
      get(): Source['range'] {
        rangeLookups++;
        return rangeLookups === 1 ? async () => Uint8Array.of(1) : undefined;
      },
    });
    const track: TrackInfo = {
      id: 20,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const demuxer: PacketInfoDemuxer = {
      tracks: [track],
      packetInfoTable: vi.fn(() => [
        {
          trackIndex: 0,
          offset: 0,
          size: 1,
          ptsUs: 0,
          dtsUs: 0,
          durationUs: 33_000,
          keyframe: true,
        },
      ]),
      packets: vi.fn(() => {
        throw new Error('intermittent packet-info range path must not open packet streams');
      }),
      close: vi.fn(async () => undefined),
    };
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        intermittentSource,
        { to: 'mkv' },
        {},
      );
      await expect(collect(stream)).rejects.toThrow('packet-info remux needs range reads');
      expect(demuxer.packets).not.toHaveBeenCalled();
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('falls back to packet streams when demuxer packet-info exists but the source is not range-readable', async () => {
    const restore = installChunkConstructors();
    const noRangeSource: Source = {
      __media: 'source',
      kind: 'stream',
      stream: () => source.stream(),
    };
    const track: TrackInfo = {
      id: 15,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      durationSec: 0.033,
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const demuxer: PacketInfoDemuxer = {
      tracks: [track],
      packetInfoTable: vi.fn(() => [
        {
          trackIndex: 0,
          offset: 0,
          size: 3,
          ptsUs: 0,
          dtsUs: 0,
          durationUs: 33_000,
          keyframe: true,
        },
      ]),
      packets: vi.fn(() => packetStream([packet('key', 0, [1, 2, 3])])),
      close: vi.fn(async () => undefined),
    };
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        noRangeSource,
        { to: 'mkv' },
        {},
      );
      const bytes = await collect(stream);
      expect(parseWebm(bytes).tracks[0]?.codec).toBe('vp9');
      expect(demuxer.packetInfoTable).toHaveBeenCalledTimes(1);
      expect(demuxer.packets).toHaveBeenCalledWith(track.id);
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('falls back when the selected packet-info track has no rows', async () => {
    const restore = installChunkConstructors();
    const videoTrack: TrackInfo = {
      id: 16,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      durationSec: 0.033,
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const audioTrack: TrackInfo = {
      id: 17,
      mediaType: 'audio',
      codec: 'opus',
      durationSec: 0.033,
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const demuxer: PacketInfoDemuxer = {
      tracks: [videoTrack, audioTrack],
      packetInfoTable: vi.fn(() => [
        {
          trackIndex: 1,
          offset: 0,
          size: 2,
          ptsUs: 0,
          dtsUs: 0,
          durationUs: 33_000,
          keyframe: true,
        },
      ]),
      packets: vi.fn((trackId: number) =>
        packetStream(trackId === videoTrack.id ? [packet('key', 0, [8, 9, 10])] : []),
      ),
      close: vi.fn(async () => undefined),
    };
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        source,
        { to: 'mkv', trackSelect: ['video:0'] },
        {},
      );
      const bytes = await collect(stream);
      const parsed = parseWebm(bytes);
      expect(parsed.tracks).toHaveLength(1);
      expect(parsed.tracks[0]?.codec).toBe('vp9');
      expect(demuxer.packetInfoTable).toHaveBeenCalledTimes(1);
      expect(demuxer.packets).toHaveBeenCalledWith(videoTrack.id);
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('falls back to packet streams when packet-info rows do not expose source offsets', async () => {
    const restore = installChunkConstructors();
    const track: TrackInfo = {
      id: 10,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      durationSec: 0.033,
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const table: PacketInfoTable = {
      tracks: [track],
      packets: [
        {
          trackIndex: 0,
          size: 3,
          ptsUs: 0,
          dtsUs: 0,
          durationUs: 33_000,
          keyframe: true,
        },
      ],
    };
    const demuxer = demuxerWith([track], [packet('key', 0, [1, 2, 3])]);
    const container: ContainerDriver = {
      id: 'offsetless-packet-info',
      apiVersion: 1,
      kind: 'container',
      formats: ['mp4'],
      supports: () => true,
      packetInfo: vi.fn(async () => table),
      demux: vi.fn(async () => demuxer),
      createMuxer: () => {
        throw new Error('not used');
      },
    };
    try {
      const stream = await remuxViaStreamingWebm(container, source as Source, { to: 'mkv' }, {});
      const bytes = await collect(stream);
      expect(parseWebm(bytes).tracks[0]?.codec).toBe('vp9');
      expect(container.packetInfo).toHaveBeenCalledTimes(1);
      expect(container.demux).toHaveBeenCalledTimes(1);
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('surfaces packet-info range short reads and still closes the demuxer once', async () => {
    const restore = installChunkConstructors();
    const rangedSource: Source = {
      __media: 'source',
      kind: 'bytes',
      size: 4,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('packet-info short-read path must not stream the full source');
      },
      range: vi.fn(async () => Uint8Array.from([1, 2])),
    };
    const track: TrackInfo = {
      id: 11,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const closeError = new Error('synthetic close failure after short read');
    const demuxer: PacketInfoDemuxer = {
      tracks: [track],
      packetInfoTable: () => [
        {
          trackIndex: 0,
          offset: 0,
          size: 4,
          ptsUs: 0,
          dtsUs: 0,
          durationUs: 33_000,
          keyframe: true,
        },
      ],
      packets: vi.fn(() => {
        throw new Error('packet-info short-read path must not open packet streams');
      }),
      close: vi.fn(async () => {
        throw closeError;
      }),
    };
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        rangedSource,
        { to: 'mkv' },
        {},
      );
      await expect(collect(stream)).rejects.toThrow('short read');
      expect(demuxer.packets).not.toHaveBeenCalled();
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('streams WebM with no packet table and keeps DTS tie ordering across tracks', async () => {
    const restore = installChunkConstructors();
    const videoTrack: TrackInfo = {
      id: 1,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 4, codedHeight: 4 },
    };
    const audioTrack: TrackInfo = {
      id: 2,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const demuxer = demuxerWithTrackPackets(
      [videoTrack, audioTrack],
      new Map<number, readonly Packet[]>([
        [videoTrack.id, [packet('key', 40_000, [1, 2, 3], 0)]],
        [audioTrack.id, [packet('key', 0, [4, 5], 0), packet('key', 20_000, [6], 20_000)]],
      ]),
    );
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        source as Source,
        { to: 'webm' },
        {},
      );
      const bytes = await collect(stream);
      const parsed = parseWebm(bytes);
      expect(parsed.container).toBe('webm');
      expect(parsed.tracks.map((track) => track.codec)).toEqual(['vp9', 'opus']);
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('rebases negative packet-table timestamps to zero when declared duration makes the offset explicit', async () => {
    const restore = installChunkConstructors();
    const track: TrackInfo = {
      id: 9,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      durationSec: 0.066,
      config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
    };
    const packets = [packet('key', 0, [1, 2]), packet('delta', 33_000, [3, 4])];
    const demuxer = demuxerWithTrackPackets(
      [track],
      new Map<number, readonly Packet[]>([[track.id, packets]]),
      [
        {
          trackId: track.id,
          sizeBytes: 2,
          ptsUs: -1_000,
          dtsUs: -1_000,
          durationUs: 1_000,
          keyframe: true,
        },
        {
          trackId: track.id,
          sizeBytes: 2,
          ptsUs: 0,
          dtsUs: 0,
          durationUs: 33_000,
          keyframe: false,
        },
      ],
    );
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        source as Source,
        { to: 'mkv' },
        {},
      );
      const bytes = await collect(stream);
      expect(parseWebm(bytes).tracks[0]?.codec).toBe('vp9');
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('propagates packet-stream failures through the output and closes the demuxer once', async () => {
    const restore = installChunkConstructors();
    const track: TrackInfo = {
      id: 4,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const packetError = new MediaError('demux-error', 'synthetic stream read failure');
    const demuxer = erroredDemuxer([track], track.id, packetError);
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        source as Source,
        { to: 'mkv' },
        {},
      );
      await expect(collect(stream)).rejects.toThrow('synthetic stream read failure');
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('keeps the primary packet-stream failure when demuxer close also fails', async () => {
    const restore = installChunkConstructors();
    const track: TrackInfo = {
      id: 12,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const packetError = new MediaError('demux-error', 'synthetic primary packet failure');
    const closeError = new Error('synthetic secondary close failure');
    const demuxer = erroredDemuxer([track], track.id, packetError, closeError);
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        source as Source,
        { to: 'mkv' },
        {},
      );
      await expect(collect(stream)).rejects.toThrow('synthetic primary packet failure');
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('keeps packet-stream failures even when reader lock cleanup throws', async () => {
    const restore = installChunkConstructors();
    const track: TrackInfo = {
      id: 19,
      mediaType: 'video',
      codec: 'vp09.00.10.08',
      config: { codec: 'vp09.00.10.08', codedWidth: 2, codedHeight: 2 },
    };
    const packetError = new MediaError('demux-error', 'synthetic reader failure');
    const reader = {
      read: vi.fn(async (): Promise<ReadableStreamReadResult<Packet>> => {
        throw packetError;
      }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(() => {
        throw new TypeError('synthetic releaseLock failure');
      }),
    };
    const demuxer: Demuxer & { close: ReturnType<typeof vi.fn> } = {
      tracks: [track],
      packets: vi.fn(
        () =>
          ({
            getReader: () => reader as unknown as ReadableStreamDefaultReader<Packet>,
          }) as unknown as ReadableStream<Packet>,
      ),
      close: vi.fn(async () => undefined),
    };
    try {
      const stream = await remuxViaStreamingWebm(
        containerWith(demuxer),
        source as Source,
        { to: 'mkv' },
        {},
      );
      await expect(collect(stream)).rejects.toThrow('synthetic reader failure');
      expect(reader.cancel).toHaveBeenCalledWith(packetError);
      expect(reader.releaseLock).toHaveBeenCalledTimes(1);
      expect(demuxer.close).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
