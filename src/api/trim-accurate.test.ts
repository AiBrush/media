import { describe, expect, it } from 'vitest';
import type { Packet } from '../contracts/driver.ts';
import {
  type TimedFrameForTrim,
  trimAudioPacketStream,
  trimTimedFrameStream,
  trimVideoEncodeTarget,
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
    expect(
      trimVideoEncodeTarget({
        id: 1,
        mediaType: 'video',
        codec: 'avc1.640028',
        fps: 30,
        config: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 },
      }),
    ).toEqual({ bitrate: 27_993_600, bitrateMode: 'variable' });
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

  it('closes preroll/end-boundary source frames, stops at end, and rebases kept frames', async () => {
    const input = [0, 33_333, 66_666, 100_000, 133_333, 166_666].map(
      (timestamp) => new FakeFrame(timestamp, 33_333),
    );
    const source = fakeFrameStream(input);

    const out = await collect(
      trimTimedFrameStream(source.stream, { startUs: 50_000, endUs: 120_000 }, restampFake),
    );

    expect(out.map((frame) => frame.timestamp)).toEqual([0, 33_334]);
    expect(out.map((frame) => frame.duration)).toEqual([33_333, 33_333]);
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
