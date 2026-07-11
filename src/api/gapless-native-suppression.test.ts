import { describe, expect, it } from 'vitest';
import type { EncodedChunk, Packet, RawFrame } from '../contracts/driver.ts';
import {
  MP4_GAPLESS_PREFLIGHT_MAX_PACKETS,
  nativeSuppressedMp4EditSamples,
} from './gapless-native-suppression.ts';

class FakeAudioFrame {
  closeCount = 0;

  constructor(readonly numberOfFrames: number) {}

  close(): void {
    this.closeCount++;
  }
}

function fakeChunk(timestamp: number, duration: number): EncodedChunk {
  return { timestamp, duration } as unknown as EncodedChunk;
}

function fakePackets(chunks: readonly EncodedChunk[]): {
  readonly stream: ReadableStream<Packet>;
  readonly pulls: () => number;
  readonly canceled: () => boolean;
} {
  let index = 0;
  let pulls = 0;
  let canceled = false;
  return {
    stream: new ReadableStream<Packet>(
      {
        pull(controller): void {
          pulls++;
          const chunk = chunks[index];
          index++;
          if (chunk === undefined) controller.close();
          else controller.enqueue({ chunk });
        },
        cancel(): void {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    pulls: () => pulls,
    canceled: () => canceled,
  };
}

function fakeDecoder(
  samplesPerPacket: readonly number[],
  frames: FakeAudioFrame[],
): TransformStream<EncodedChunk, RawFrame> {
  let index = 0;
  return new TransformStream<EncodedChunk, RawFrame>({
    transform(_chunk, controller): void {
      const samples = samplesPerPacket[index] ?? 0;
      index++;
      if (samples === 0) return;
      const frame = new FakeAudioFrame(samples);
      frames.push(frame);
      controller.enqueue(frame as unknown as RawFrame);
    },
  });
}

describe('MP4 native gapless suppression preflight', () => {
  it('detects a native decoder that consumes the negative priming packet', async () => {
    const packets = fakePackets([fakeChunk(-23220, 23220), fakeChunk(0, 23220)]);

    const suppressed = await nativeSuppressedMp4EditSamples(
      {
        packets: packets.stream,
        createDecoder: () => fakeDecoder([0], []),
      },
      1024,
      44100,
    );

    expect(suppressed).toBe(1024);
    expect(packets.pulls()).toBe(1);
    expect(packets.canceled()).toBe(true);
  });

  it('keeps explicit engine trimming when every negative-prefix packet is decoded', async () => {
    const packets = fakePackets([
      fakeChunk(-44000, 21333),
      fakeChunk(-22667, 21333),
      fakeChunk(-1333, 21333),
      fakeChunk(20000, 21333),
    ]);
    const frames: FakeAudioFrame[] = [];

    const suppressed = await nativeSuppressedMp4EditSamples(
      {
        packets: packets.stream,
        createDecoder: () => fakeDecoder([1024, 1024, 1024], frames),
      },
      2112,
      48000,
    );

    expect(suppressed).toBe(0);
    expect(packets.pulls()).toBe(3);
    expect(packets.canceled()).toBe(true);
    expect(frames.map((frame) => frame.closeCount)).toEqual([1, 1, 1]);
  });

  it('does not mistake one-sample timestamp rounding for decoder suppression', async () => {
    const packets = fakePackets([fakeChunk(-23220, 23220)]);
    const frames: FakeAudioFrame[] = [];

    const suppressed = await nativeSuppressedMp4EditSamples(
      {
        packets: packets.stream,
        createDecoder: () => fakeDecoder([1023], frames),
      },
      1024,
      44100,
    );

    expect(suppressed).toBe(0);
    expect(frames[0]?.closeCount).toBe(1);
  });

  it('caps malformed long negative prefixes without scanning the complete track', async () => {
    const chunks = Array.from({ length: MP4_GAPLESS_PREFLIGHT_MAX_PACKETS + 2 }, (_, index) =>
      fakeChunk(-1_000_000 + index * 1000, 1000),
    );
    const packets = fakePackets(chunks);

    await nativeSuppressedMp4EditSamples(
      {
        packets: packets.stream,
        createDecoder: () => fakeDecoder([], []),
      },
      100_000,
      48000,
    );

    expect(packets.pulls()).toBe(MP4_GAPLESS_PREFLIGHT_MAX_PACKETS);
    expect(packets.canceled()).toBe(true);
  });
});
