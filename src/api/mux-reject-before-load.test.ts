/**
 * Illegal codec→container mux requests are rejected before any muxer chunk loads or a packet is read
 * (REQUIREMENTS §5.5 "reject before expensive work"): the eager driver proxy carries the container's
 * track rule, so the runner never touches the packet streams of a request it cannot honour.
 */

import { describe, expect, it } from 'vitest';
import type { Packet, TrackInfo } from '../contracts/driver.ts';
import { createMedia } from './create-media.ts';

function h264Track(): TrackInfo {
  return {
    id: 0,
    mediaType: 'video',
    codec: 'avc1.42E01E',
    durationSec: 0.02,
    config: {
      codec: 'avc1.42E01E',
      codedWidth: 16,
      codedHeight: 16,
      description: new Uint8Array([1, 100, 0, 30]),
    },
  };
}

function untouchedPackets(): { stream: ReadableStream<Packet>; pulled: () => boolean } {
  let pulled = false;
  // highWaterMark 0: the stream pulls only when a consumer reads, so `pulled` means "a reader ran".
  const stream = new ReadableStream<Packet>(
    {
      pull(controller): void {
        pulled = true;
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled };
}

describe('mux rejects an illegal codec→container pair before any work', () => {
  for (const container of ['ogg', 'wav', 'adts', 'mp3'] as const) {
    it(`H.264 video into '${container}' is a typed CapabilityError and the packets are never read`, async () => {
      const media = createMedia();
      const packets = untouchedPackets();
      try {
        await expect(
          media.mux({ video: { track: h264Track(), packets: packets.stream } }, { container }),
        ).rejects.toMatchObject({ name: 'CapabilityError' });
        expect(packets.pulled()).toBe(false);
      } finally {
        await media.dispose();
      }
    });
  }

  it('a second track into a single-stream container is rejected the same way', async () => {
    const media = createMedia();
    const packets = untouchedPackets();
    const opus: TrackInfo = {
      id: 1,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    };
    try {
      await expect(
        media.mux(
          { tracks: [{ track: opus, packets: packets.stream }, { track: opus, packets: packets.stream }] },
          { container: 'ogg' },
        ),
      ).rejects.toMatchObject({ name: 'CapabilityError' });
      expect(packets.pulled()).toBe(false);
    } finally {
      await media.dispose();
    }
  });
});
