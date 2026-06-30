import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerDriver,
  Demuxer,
  Packet,
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
): Demuxer & { close: ReturnType<typeof vi.fn> } {
  return {
    tracks,
    packets: (id: number) => (id === trackId ? failingPacketStream(error) : packetStream([])),
    close: vi.fn(async () => undefined),
  };
}

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
});
