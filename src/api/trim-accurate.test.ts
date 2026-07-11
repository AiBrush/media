import { describe, expect, it } from 'vitest';
import type { Packet, PacketInfoMetadata, TrackInfo } from '../contracts/driver.ts';
import {
  type TimedFrameForTrim,
  estimateTrackBitrateFromPacketInfo,
  planSeekVideoPacketInfoRows,
  planTrimAudioPacketInfoRows,
  planTrimVideoPacketInfoRows,
  trimAudioPacketInfoStream,
  trimAudioPacketInfoTrack,
  trimAudioPacketStream,
  trimTimedFrameStream,
  trimVideoEncodeTarget,
  trimVideoPacketInfoChunkStream,
} from './trim-streams.ts';

class FakeFrame implements TimedFrameForTrim {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null,
    readonly label: string = String(timestamp),
  ) {}

  close(): void {
    this.closeCount++;
  }
}

interface FakeStream {
  readonly stream: ReadableStream<FakeFrame>;
  readonly canceled: () => boolean;
}

function fakeFrameStream(frames: readonly FakeFrame[]): FakeStream {
  let index = 0;
  let canceled = false;
  return {
    stream: new ReadableStream<FakeFrame>({
      pull(controller): void {
        const frame = frames[index];
        index++;
        if (frame === undefined) {
          controller.close();
        } else {
          controller.enqueue(frame);
        }
      },
      cancel(): void {
        canceled = true;
      },
    }),
    canceled: () => canceled,
  };
}

async function collect(stream: ReadableStream<FakeFrame>): Promise<FakeFrame[]> {
  const reader = stream.getReader();
  const out: FakeFrame[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

async function collectPackets(stream: ReadableStream<Packet>): Promise<Packet[]> {
  const reader = stream.getReader();
  const out: Packet[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

async function collectVideoChunks(
  stream: ReadableStream<EncodedVideoChunk>,
): Promise<EncodedVideoChunk[]> {
  const reader = stream.getReader();
  const out: EncodedVideoChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

class TestEncodedAudioChunk {
  readonly type: EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: EncodedAudioChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    const source = init.data;
    const view = ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer as ArrayBufferLike, source.byteOffset, source.byteLength)
      : new Uint8Array(source as ArrayBufferLike);
    this.#data = view.slice();
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: Uint8Array): void {
    destination.set(this.#data);
  }
}

class TestEncodedVideoChunk {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: EncodedVideoChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    const source = init.data;
    const view = ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer as ArrayBufferLike, source.byteOffset, source.byteLength)
      : new Uint8Array(source as ArrayBufferLike);
    this.#data = view.slice();
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: Uint8Array): void {
    destination.set(this.#data);
  }
}

function audioPacket(
  timestamp: number,
  duration: number | null,
  data: readonly number[],
  extra: Partial<Pick<Packet, 'dtsUs' | 'sizeBytes'>> = {},
): Packet {
  return {
    chunk: new TestEncodedAudioChunk({
      type: 'key',
      timestamp,
      ...(duration !== null ? { duration } : {}),
      data: new Uint8Array(data),
    }) as unknown as EncodedAudioChunk,
    ...extra,
  };
}

function restampFake(frame: FakeFrame, timestamp: number, duration: number | null): FakeFrame {
  if (frame.timestamp === timestamp && frame.duration === duration) return frame;
  return new FakeFrame(timestamp, duration, `rebased:${frame.label}`);
}

function baseLabel(frame: FakeFrame): string {
  let label = frame.label;
  while (label.startsWith('rebased:')) label = label.slice('rebased:'.length);
  return label;
}

function restampPreservingLabel(
  frame: FakeFrame,
  timestamp: number,
  duration: number | null,
): FakeFrame {
  if (frame.timestamp === timestamp && frame.duration === duration) return frame;
  return new FakeFrame(timestamp, duration, baseLabel(frame));
}

async function trimLabelsAndTimings(
  frames: readonly FakeFrame[],
  startUs: number,
  endUs: number,
): Promise<readonly [label: string, timestamp: number, duration: number | null][]> {
  const out = await collect(
    trimTimedFrameStream(
      fakeFrameStream(frames).stream,
      { startUs, endUs },
      restampPreservingLabel,
    ),
  );
  const summary = out.map((frame): [string, number, number | null] => [
    baseLabel(frame),
    frame.timestamp,
    frame.duration,
  ]);
  for (const frame of out) frame.close();
  return summary;
}

describe('trimTimedFrameStream — accurate trim frame-window core', () => {
  it('chooses a high-quality VBR target for accurate video trim composition', () => {
    const sourceTrack: TrackInfo = {
      id: 1,
      mediaType: 'video',
      codec: 'avc1.640028',
      fps: 30,
      config: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 },
    };
    expect(trimVideoEncodeTarget(sourceTrack)).toEqual({
      bitrate: 27_993_600,
      bitrateMode: 'variable',
    });
    expect(trimVideoEncodeTarget(sourceTrack, 5_836_579)).toEqual({
      bitrate: 8_754_869,
      bitrateMode: 'variable',
    });
    expect(trimVideoEncodeTarget(sourceTrack, 40_000_000)).toEqual({
      bitrate: 27_993_600,
      bitrateMode: 'variable',
    });
  });

  it('falls back and clamps the accurate video trim bitrate from real geometry', () => {
    expect(
      trimVideoEncodeTarget({
        id: 1,
        mediaType: 'video',
        codec: 'avc1.640028',
        config: { codec: 'avc1.640028' },
      }),
    ).toEqual({ bitrate: 20_000_000, bitrateMode: 'variable' });
    expect(
      trimVideoEncodeTarget({
        id: 2,
        mediaType: 'video',
        codec: 'avc1.640028',
        config: { codec: 'avc1.640028', codedWidth: 2, codedHeight: 2 },
      }),
    ).toEqual({ bitrate: 4_000_000, bitrateMode: 'variable' });
    expect(
      trimVideoEncodeTarget({
        id: 3,
        mediaType: 'video',
        codec: 'avc1.640028',
        fps: 120,
        config: { codec: 'avc1.640028', codedWidth: 8192, codedHeight: 4320 },
      }),
    ).toEqual({ bitrate: 50_000_000, bitrateMode: 'variable' });
  });

  it('packet-copy trims audio packets by overlap and preserves packet metadata', async () => {
    const originalEncodedAudioChunk = globalThis.EncodedAudioChunk;
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: TestEncodedAudioChunk as unknown as typeof EncodedAudioChunk,
    });
    try {
      const packets = [
        audioPacket(0, 10, [0]),
        audioPacket(12, null, [1, 2]),
        audioPacket(20, 5, [3], { dtsUs: 18.4, sizeBytes: 1 }),
        audioPacket(40, 5, [4]),
      ];
      const source = new ReadableStream<Packet>({
        start(controller): void {
          for (const packet of packets) controller.enqueue(packet);
          controller.close();
        },
      });

      const out = await collectPackets(trimAudioPacketStream(source, { startUs: 10, endUs: 30 }));

      expect(out).toHaveLength(2);
      expect(out.map((packet) => packet.chunk.timestamp)).toEqual([0, 8]);
      expect(out.map((packet) => packet.chunk.duration)).toEqual([null, 5]);
      expect(out[0]?.dtsUs).toBeUndefined();
      expect(out[0]?.sizeBytes).toBeUndefined();
      expect(out[1]?.dtsUs).toBe(6);
      expect(out[1]?.sizeBytes).toBe(1);
    } finally {
      if (originalEncodedAudioChunk === undefined) {
        Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
      } else {
        Object.defineProperty(globalThis, 'EncodedAudioChunk', {
          configurable: true,
          value: originalEncodedAudioChunk,
        });
      }
    }
  });

  it('plans packet-info audio trim rows with validated byte ranges and rebased timing', () => {
    const packets: PacketInfoMetadata[] = [
      {
        trackIndex: 0,
        offset: 1_000,
        size: 10,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 1,
        offset: 2_000,
        size: 20,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 1,
        offset: 2_020,
        size: 20,
        ptsUs: 10,
        dtsUs: 9,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 1,
        offset: 2_040,
        size: 20,
        ptsUs: 20,
        dtsUs: 19,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 1,
        offset: 2_060,
        size: 20,
        ptsUs: 40,
        dtsUs: 39,
        durationUs: 10,
        keyframe: true,
      },
    ];

    const rows = planTrimAudioPacketInfoRows(packets, 1, { startUs: 15, endUs: 30 });

    expect(rows?.map((row) => [row.offset, row.size, row.timestampUs, row.dtsUs])).toEqual([
      [2_020, 20, 0, 0],
      [2_040, 20, 10, 9],
    ]);
    expect(rows?.map((row) => row.window)).toEqual([
      { start: 2_020, end: 2_060 },
      { start: 2_020, end: 2_060 },
    ]);
  });

  it('estimates source track bitrate from packet-info rows', () => {
    const packets: PacketInfoMetadata[] = [
      {
        trackIndex: 0,
        offset: 100,
        size: 1_000,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 500_000,
        keyframe: true,
      },
      {
        trackIndex: 1,
        offset: 10_000,
        size: 99_000,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 1_000_000,
        keyframe: true,
      },
      {
        trackIndex: 0,
        offset: 1_100,
        size: 2_000,
        ptsUs: 500_000,
        dtsUs: 500_000,
        durationUs: 500_000,
        keyframe: false,
      },
    ];

    expect(estimateTrackBitrateFromPacketInfo(packets, 0)).toBe(24_000);
    expect(estimateTrackBitrateFromPacketInfo(packets, 2)).toBeUndefined();
  });

  it('plans packet-info video trim rows from seek keyframe through the next end keyframe', () => {
    const packets: PacketInfoMetadata[] = [
      {
        trackIndex: 0,
        offset: 100,
        size: 10,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 0,
        offset: 110,
        size: 10,
        ptsUs: 20,
        dtsUs: 10,
        durationUs: 10,
        keyframe: false,
      },
      {
        trackIndex: 0,
        offset: 120,
        size: 10,
        ptsUs: 50,
        dtsUs: 20,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 0,
        offset: 130,
        size: 10,
        ptsUs: 60,
        dtsUs: 30,
        durationUs: 10,
        keyframe: false,
      },
      {
        trackIndex: 0,
        offset: 140,
        size: 10,
        ptsUs: 65,
        dtsUs: 40,
        durationUs: 10,
        keyframe: false,
      },
      {
        trackIndex: 0,
        offset: 150,
        size: 10,
        ptsUs: 68,
        dtsUs: 50,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 1,
        offset: 10_000,
        size: 10,
        ptsUs: 60,
        dtsUs: 60,
        durationUs: 10,
        keyframe: true,
      },
    ];

    const rows = planTrimVideoPacketInfoRows(packets, 0, { startUs: 60, endUs: 66 });

    expect(rows?.map((row) => [row.timestampUs, row.dtsUs, row.keyframe])).toEqual([
      [50, 20, true],
      [60, 30, false],
      [65, 40, false],
      [68, 50, true],
    ]);
    expect(rows?.map((row) => row.window)).toEqual([
      { start: 120, end: 160 },
      { start: 120, end: 160 },
      { start: 120, end: 160 },
      { start: 120, end: 160 },
    ]);
  });

  it('plans packet-info seek rows from the target GOP, including past EOF', () => {
    const packets: PacketInfoMetadata[] = [
      {
        trackIndex: 0,
        offset: 100,
        size: 10,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 0,
        offset: 110,
        size: 10,
        ptsUs: 20,
        dtsUs: 10,
        durationUs: 10,
        keyframe: false,
      },
      {
        trackIndex: 0,
        offset: 120,
        size: 10,
        ptsUs: 50,
        dtsUs: 20,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 0,
        offset: 130,
        size: 10,
        ptsUs: 60,
        dtsUs: 30,
        durationUs: 10,
        keyframe: false,
      },
      {
        trackIndex: 0,
        offset: 140,
        size: 10,
        ptsUs: 68,
        dtsUs: 40,
        durationUs: 10,
        keyframe: true,
      },
      {
        trackIndex: 0,
        offset: 150,
        size: 10,
        ptsUs: 80,
        dtsUs: 50,
        durationUs: 10,
        keyframe: false,
      },
      {
        trackIndex: 1,
        offset: 10_000,
        size: 10,
        ptsUs: 80,
        dtsUs: 80,
        durationUs: 10,
        keyframe: true,
      },
    ];

    expect(planSeekVideoPacketInfoRows(packets, 0, 60)?.map((row) => row.timestampUs)).toEqual([
      50, 60, 68,
    ]);
    expect(planSeekVideoPacketInfoRows(packets, 0, 300)?.map((row) => row.timestampUs)).toEqual([
      68, 80,
    ]);
  });

  it('streams packet-info video chunks from coalesced source ranges', async () => {
    const originalEncodedVideoChunk = globalThis.EncodedVideoChunk;
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: TestEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
    });
    try {
      const rows = planTrimVideoPacketInfoRows(
        [
          {
            trackIndex: 0,
            offset: 20,
            size: 2,
            ptsUs: 100,
            dtsUs: 100,
            durationUs: 10,
            keyframe: true,
          },
          {
            trackIndex: 0,
            offset: 24,
            size: 1,
            ptsUs: 110,
            dtsUs: 108,
            durationUs: 10,
            keyframe: false,
          },
        ],
        0,
        { startUs: 100, endUs: 110 },
      );
      expect(rows).toBeDefined();
      const calls: Array<readonly [start: number, end: number]> = [];
      const source = {
        async range(start: number, end: number): Promise<Uint8Array> {
          calls.push([start, end]);
          return Uint8Array.from({ length: end - start }, (_value, index) => start + index);
        },
      };

      const out = await collectVideoChunks(
        trimVideoPacketInfoChunkStream(source, rows ?? [], undefined),
      );
      const copied = out.map((chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        return [...bytes];
      });

      expect(calls).toEqual([[20, 25]]);
      expect(out.map((chunk) => chunk.type)).toEqual(['key', 'delta']);
      expect(out.map((chunk) => chunk.timestamp)).toEqual([100, 110]);
      expect(out.map((chunk) => chunk.duration)).toEqual([10, 10]);
      expect(copied).toEqual([[20, 21], [24]]);
    } finally {
      if (originalEncodedVideoChunk === undefined) {
        Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
      } else {
        Object.defineProperty(globalThis, 'EncodedVideoChunk', {
          configurable: true,
          value: originalEncodedVideoChunk,
        });
      }
    }
  });

  it('declines packet-info audio trim when selected rows lack exact range or duration facts', () => {
    expect(
      planTrimAudioPacketInfoRows(
        [
          {
            trackIndex: 0,
            size: 10,
            ptsUs: 10,
            dtsUs: 10,
            durationUs: 10,
            keyframe: true,
          },
        ],
        0,
        { startUs: 10, endUs: 20 },
      ),
    ).toBeUndefined();
    expect(
      planTrimAudioPacketInfoRows(
        [
          {
            trackIndex: 0,
            offset: 10,
            size: 10,
            ptsUs: 10,
            dtsUs: 10,
            keyframe: true,
          },
        ],
        0,
        { startUs: 10, endUs: 20 },
      ),
    ).toBeUndefined();
  });

  it('streams packet-info audio trim rows from coalesced source ranges', async () => {
    const originalEncodedAudioChunk = globalThis.EncodedAudioChunk;
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: TestEncodedAudioChunk as unknown as typeof EncodedAudioChunk,
    });
    try {
      const rows = planTrimAudioPacketInfoRows(
        [
          {
            trackIndex: 0,
            offset: 10,
            size: 2,
            ptsUs: 100,
            dtsUs: 100,
            durationUs: 10,
            keyframe: true,
          },
          {
            trackIndex: 0,
            offset: 14,
            size: 1,
            ptsUs: 110,
            dtsUs: 108,
            durationUs: 10,
            keyframe: true,
          },
        ],
        0,
        { startUs: 100, endUs: 130 },
      );
      expect(rows).toBeDefined();
      const calls: Array<readonly [start: number, end: number]> = [];
      const source = {
        async range(start: number, end: number): Promise<Uint8Array> {
          calls.push([start, end]);
          return Uint8Array.from({ length: end - start }, (_value, index) => start + index);
        },
      };

      const out = await collectPackets(trimAudioPacketInfoStream(source, rows ?? [], undefined));

      expect(calls).toEqual([[10, 15]]);
      expect(out.map((packet) => packet.chunk.timestamp)).toEqual([0, 10]);
      expect(out.map((packet) => packet.chunk.duration)).toEqual([10, 10]);
      expect(out.map((packet) => packet.dtsUs)).toEqual([0, 8]);
      expect(out.map((packet) => [...(packet.data ?? [])])).toEqual([[10, 11], [14]]);
      expect(out.map((packet) => packet.sizeBytes)).toEqual([2, 1]);
    } finally {
      if (originalEncodedAudioChunk === undefined) {
        Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
      } else {
        Object.defineProperty(globalThis, 'EncodedAudioChunk', {
          configurable: true,
          value: originalEncodedAudioChunk,
        });
      }
    }
  });

  it('strips source gapless metadata from packet-info audio subclips', () => {
    const sourceTrack: TrackInfo = {
      id: 1,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      durationSec: 120,
      config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
      gapless: { leadingSamples: 1024, trailingSamples: 0, totalSamples: 5_760_000 },
    };

    expect(
      trimAudioPacketInfoTrack(sourceTrack, { startUs: 60_000_000, endUs: 66_000_000 }),
    ).toEqual({
      id: 1,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      durationSec: 6,
      config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
    });
  });

  it('closes preroll/end-boundary source frames, stops at end, and rebases kept frames', async () => {
    const input = [0, 33_333, 66_666, 100_000, 133_333, 166_666].map(
      (timestamp) => new FakeFrame(timestamp, 33_333),
    );
    const source = fakeFrameStream(input);

    const out = await collect(
      trimTimedFrameStream(source.stream, { startUs: 50_000, endUs: 120_000 }, restampFake),
    );

    expect(out.map((frame) => frame.timestamp)).toEqual([0, 33_334]);
    expect(out.map((frame) => frame.duration)).toEqual([33_333, 20_000]);
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(out.map((frame) => frame.closeCount)).toEqual([0, 0]);

    for (const frame of out) frame.close();
    expect(out.map((frame) => frame.closeCount)).toEqual([1, 1]);
  });

  it('does not prefetch a native frame before a downstream reader asks', async () => {
    let pulls = 0;
    const input = [new FakeFrame(0, 40), new FakeFrame(40, 40)];
    const source = new ReadableStream<FakeFrame>(
      {
        pull(controller): void {
          pulls++;
          const frame = input.shift();
          if (frame === undefined) controller.close();
          else controller.enqueue(frame);
        },
      },
      { highWaterMark: 0 },
    );

    const trimmed = trimTimedFrameStream(source, { startUs: 0, endUs: 100 }, restampFake);
    await Promise.resolve();

    expect(pulls).toBe(0);

    const reader = trimmed.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(pulls).toBe(1);
    first.value?.close();
    await reader.cancel();
  });

  it('keeps a frame exactly at start and excludes a frame exactly at end', async () => {
    const input = [100, 200, 300, 400].map((timestamp) => new FakeFrame(timestamp, 50));
    const source = fakeFrameStream(input);

    const out = await collect(
      trimTimedFrameStream(source.stream, { startUs: 200, endUs: 300 }, restampFake),
    );

    expect(out.map((frame) => frame.timestamp)).toEqual([0]);
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1, 1, 0]);
  });

  it('clips a kept VFR frame duration at the exclusive end boundary', async () => {
    const input = [
      new FakeFrame(1_000_000, 100_000),
      new FakeFrame(3_999_999, 100_000),
      new FakeFrame(4_099_999, 100_000),
    ];
    const source = fakeFrameStream(input);

    const out = await collect(
      trimTimedFrameStream(source.stream, { startUs: 1_000_000, endUs: 4_000_000 }, restampFake),
    );

    expect(out.map((frame) => [frame.timestamp, frame.duration])).toEqual([
      [0, 100_000],
      [2_999_999, 1],
    ]);
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1, 1]);

    for (const frame of out) frame.close();
  });

  it('is additive across adjacent windows without duplicating the boundary frame', async () => {
    const direct = await collect(
      trimTimedFrameStream(
        fakeFrameStream([100, 200, 300, 400].map((timestamp) => new FakeFrame(timestamp, 50)))
          .stream,
        { startUs: 100, endUs: 500 },
        restampFake,
      ),
    );
    const left = await collect(
      trimTimedFrameStream(
        fakeFrameStream([100, 200, 300, 400].map((timestamp) => new FakeFrame(timestamp, 50)))
          .stream,
        { startUs: 100, endUs: 300 },
        restampFake,
      ),
    );
    const right = await collect(
      trimTimedFrameStream(
        fakeFrameStream([100, 200, 300, 400].map((timestamp) => new FakeFrame(timestamp, 50)))
          .stream,
        { startUs: 300, endUs: 500 },
        restampFake,
      ),
    );

    expect(left.map((frame) => frame.label)).toEqual(['rebased:100', 'rebased:200']);
    expect(right.map((frame) => frame.label)).toEqual(['rebased:300', 'rebased:400']);
    expect([...left, ...right].map((frame) => frame.label)).toEqual(
      direct.map((frame) => frame.label),
    );
  });

  it('satisfies trim composition identity over a VFR-like frame timeline', async () => {
    const source = [
      new FakeFrame(1_000, 1_000, 'a'),
      new FakeFrame(2_000, 1_500, 'b'),
      new FakeFrame(3_500, 1_500, 'c'),
      new FakeFrame(5_000, 1_000, 'd'),
    ];

    const direct = await trimLabelsAndTimings(
      source.map((frame) => new FakeFrame(frame.timestamp, frame.duration, frame.label)),
      2_000,
      5_000,
    );
    const outer = await collect(
      trimTimedFrameStream(
        fakeFrameStream(
          source.map((frame) => new FakeFrame(frame.timestamp, frame.duration, frame.label)),
        ).stream,
        { startUs: 1_000, endUs: 5_000 },
        restampPreservingLabel,
      ),
    );
    const composed = await trimLabelsAndTimings(outer, 1_000, 4_000);

    expect(composed).toEqual(direct);
  });

  it('satisfies adjacent trim concatenation when the right window is offset by the left span', async () => {
    const makeSource = (): FakeFrame[] => [
      new FakeFrame(0, 1_000, 'a'),
      new FakeFrame(1_000, 1_000, 'b'),
      new FakeFrame(2_000, 1_500, 'c'),
      new FakeFrame(3_500, 1_500, 'd'),
      new FakeFrame(5_000, 1_000, 'e'),
    ];

    const leftStart = 1_000;
    const split = 3_500;
    const rightEnd = 5_000;
    const leftSpan = split - leftStart;
    const direct = await trimLabelsAndTimings(makeSource(), leftStart, rightEnd);
    const left = await trimLabelsAndTimings(makeSource(), leftStart, split);
    const right = await trimLabelsAndTimings(makeSource(), split, rightEnd);
    const concatenated = [
      ...left,
      ...right.map(([label, timestamp, duration]): [string, number, number | null] => [
        label,
        timestamp + leftSpan,
        duration,
      ]),
    ];

    expect(concatenated).toEqual(direct);
  });

  it('leaves unchanged kept frames open for the downstream encoder to close', async () => {
    const input = [new FakeFrame(0, 40), new FakeFrame(40, 40)];
    const source = fakeFrameStream(input);

    const out = await collect(
      trimTimedFrameStream(source.stream, { startUs: 0, endUs: 100 }, restampFake),
    );

    expect(out).toEqual(input);
    expect(input.map((frame) => frame.closeCount)).toEqual([0, 0]);
    expect(source.canceled()).toBe(false);

    for (const frame of out) frame.close();
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1]);
  });

  it('reads through source EOF, preserves null durations, and closes only downstream-owned frames', async () => {
    const input = [new FakeFrame(0, null), new FakeFrame(40, 40)];
    const source = fakeFrameStream(input);

    const out = await collect(
      trimTimedFrameStream(source.stream, { startUs: 0, endUs: 100 }, restampFake),
    );

    expect(out.map((frame) => [frame.timestamp, frame.duration])).toEqual([
      [0, null],
      [40, 40],
    ]);
    expect(source.canceled()).toBe(false);
    expect(input.map((frame) => frame.closeCount)).toEqual([0, 0]);

    for (const frame of out) frame.close();
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1]);
  });

  it('closes the source frame and cancels upstream if restamping fails', async () => {
    const input = [new FakeFrame(10, 5), new FakeFrame(20, 5)];
    const source = fakeFrameStream(input);
    const boom = new Error('rebasing failed');
    const trimmed = trimTimedFrameStream(source.stream, { startUs: 0, endUs: 30 }, () => {
      throw boom;
    });

    await expect(trimmed.getReader().read()).rejects.toThrow('rebasing failed');
    expect(input[0]?.closeCount).toBe(1);
    expect(input[1]?.closeCount).toBe(0);
    expect(source.canceled()).toBe(true);
  });
});
