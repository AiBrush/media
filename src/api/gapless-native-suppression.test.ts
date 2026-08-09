import { describe, expect, it } from 'vitest';
import type { EncodedChunk, Packet, RawFrame, TrackInfo } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { decodedAudioStreamWithGapless } from './codec-live.ts';
import {
  MP4_GAPLESS_PREFLIGHT_MAX_PACKETS,
  nativeSuppressedGaplessSamples,
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
  it('detects an Ogg-mode Opus decoder consuming the 312-sample OpusHead pre-skip', async () => {
    const packets = fakePackets([fakeChunk(0, 60000), fakeChunk(60000, 60000)]);
    const frames: FakeAudioFrame[] = [];

    const suppressed = await nativeSuppressedGaplessSamples(
      {
        packets: packets.stream,
        createDecoder: () => fakeDecoder([2568], frames),
      },
      312,
      48000,
      { probeFromFirstPacket: true },
    );

    expect(suppressed).toBe(312);
    expect(packets.pulls()).toBe(1);
    expect(packets.canceled()).toBe(true);
    expect(frames[0]?.closeCount).toBe(1);
  });

  it('runs the same first-packet native pre-skip probe for WebM CodecDelay tracks', async () => {
    const packets = fakePackets([fakeChunk(0, 60_000), fakeChunk(60_000, 60_000)]);
    const track: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
      gapless: {
        basis: 'webm-opus-codec-delay',
        leadingSamples: 312,
      },
    };
    const decoded = await decodedAudioStreamWithGapless(
      new ReadableStream<AudioData>({
        start(controller): void {
          controller.close();
        },
      }),
      track,
      {
        packets: packets.stream,
        createDecoder: () => fakeDecoder([2568], []),
      },
    );

    expect((await decoded.getReader().read()).done).toBe(true);
    expect(packets.pulls()).toBe(1);
    expect(packets.canceled()).toBe(true);
  });

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

  it('handles an early packet-stream EOF while collecting the prefix', async () => {
    const packets = fakePackets([fakeChunk(-23220, 23220)]);

    const suppressed = await nativeSuppressedMp4EditSamples(
      {
        packets: packets.stream,
        createDecoder: () => fakeDecoder([0], []),
      },
      100_000,
      44100,
    );

    expect(suppressed).toBe(1024);
    expect(packets.pulls()).toBe(2);
  });

  it('ignores a negative-prefix packet with an invalid duration', async () => {
    const packets = fakePackets([fakeChunk(-1, Number.NaN)]);

    const suppressed = await nativeSuppressedMp4EditSamples(
      {
        packets: packets.stream,
        createDecoder: () => fakeDecoder([0], []),
      },
      1024,
      44100,
    );

    expect(suppressed).toBe(0);
    expect(packets.pulls()).toBe(2);
  });

  it('stops before a non-negative first packet', async () => {
    const packets = fakePackets([fakeChunk(0, 23220)]);

    const suppressed = await nativeSuppressedMp4EditSamples(
      {
        packets: packets.stream,
        createDecoder: () => fakeDecoder([0], []),
      },
      1024,
      44100,
    );

    expect(suppressed).toBe(0);
    expect(packets.pulls()).toBe(1);
  });

  it('rejects a decoder that emits a video-shaped frame', async () => {
    const packets = fakePackets([fakeChunk(-23220, 23220)]);

    const suppressed = await nativeSuppressedMp4EditSamples(
      {
        packets: packets.stream,
        createDecoder: () =>
          new TransformStream<EncodedChunk, RawFrame>({
            transform(_chunk, controller): void {
              controller.enqueue({ close(): void {} } as unknown as RawFrame);
            },
          }),
      },
      1024,
      44100,
    );

    expect(suppressed).toBe(0);
    expect(packets.canceled()).toBe(true);
  });

  it('propagates an underlying packet-read rejection', async () => {
    const packets = new ReadableStream<Packet>({
      pull(controller): void {
        controller.error(new Error('packet source failed'));
      },
    });
    const controller = new AbortController();

    await expect(
      nativeSuppressedMp4EditSamples(
        {
          packets,
          createDecoder: () => fakeDecoder([0], []),
          signal: controller.signal,
        },
        1024,
        44100,
      ),
    ).rejects.toThrow('packet source failed');
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

  it('returns zero for invalid preflight bounds', async () => {
    const packets = fakePackets([fakeChunk(-23220, 23220)]);

    await expect(
      nativeSuppressedMp4EditSamples(
        {
          packets: packets.stream,
          createDecoder: () => fakeDecoder([0], []),
        },
        0,
        44100,
      ),
    ).resolves.toBe(0);
    expect(packets.pulls()).toBe(0);
  });

  it('keeps a decoder capability error conservative', async () => {
    const packets = fakePackets([fakeChunk(-23220, 23220)]);

    const suppressed = await nativeSuppressedMp4EditSamples(
      {
        packets: packets.stream,
        createDecoder: () =>
          new TransformStream<EncodedChunk, RawFrame>({
            transform(_chunk, controller): void {
              controller.error(new Error('prefix decode unsupported'));
            },
          }),
      },
      1024,
      44100,
    );

    expect(suppressed).toBe(0);
    expect(packets.canceled()).toBe(true);
  });

  it('propagates a typed decoder abort instead of converting it to zero', async () => {
    const packets = fakePackets([fakeChunk(-23220, 23220)]);

    await expect(
      nativeSuppressedMp4EditSamples(
        {
          packets: packets.stream,
          createDecoder: () =>
            new TransformStream<EncodedChunk, RawFrame>({
              transform(_chunk, controller): void {
                controller.error(new MediaError('aborted', 'decoder aborted'));
              },
            }),
        },
        1024,
        44100,
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(packets.canceled()).toBe(true);
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

  it('propagates an already-aborted signal without pulling a packet', async () => {
    const controller = new AbortController();
    controller.abort();
    const packets = fakePackets([fakeChunk(-23220, 23220)]);

    await expect(
      nativeSuppressedMp4EditSamples(
        {
          packets: packets.stream,
          createDecoder: () => fakeDecoder([0], []),
          signal: controller.signal,
        },
        1024,
        44100,
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(packets.pulls()).toBe(0);
    expect(packets.canceled()).toBe(false);
  });

  it('cancels an in-flight bounded packet read when the signal aborts', async () => {
    let canceled = false;
    const packets = new ReadableStream<Packet>(
      {
        pull(): Promise<void> {
          return new Promise<void>(() => undefined);
        },
        cancel(): void {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const pending = nativeSuppressedMp4EditSamples(
      {
        packets,
        createDecoder: () => fakeDecoder([0], []),
        signal: controller.signal,
      },
      1024,
      44100,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(canceled).toBe(true);
  });
});
