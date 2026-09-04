/**
 * `convert()` copies coded video packets when the request asks for nothing beyond the source's own codec
 * family and the target container carries it (mirrors the audio rule). No encoder is touched, so the
 * conversion works where WebCodecs is absent, and a request that does transform video still routes to
 * an encoder.
 */

import { describe, expect, it } from 'vitest';
import { createMedia } from './create-media.ts';
import { fromBytes } from '../sources/source.ts';
import { loadFixture } from '../test-support/corpus.ts';

/** Node has no WebCodecs; the packet-copy path only needs the chunk constructors' data contract. */
class TestEncodedChunk {
  readonly type: string;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;
  constructor(init: { type: string; timestamp: number; duration?: number | null; data: BufferSource }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    const d = init.data;
    this.#data = ArrayBuffer.isView(d)
      ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
      : new Uint8Array((d as ArrayBuffer).slice(0));
    this.byteLength = this.#data.byteLength;
  }
  copyTo(destination: ArrayBuffer | ArrayBufferView): void {
    const view = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    view.set(this.#data);
  }
}

function installEncodedChunkShims(): () => void {
  const previous = {
    video: (globalThis as { EncodedVideoChunk?: unknown }).EncodedVideoChunk,
    audio: (globalThis as { EncodedAudioChunk?: unknown }).EncodedAudioChunk,
  };
  Object.defineProperty(globalThis, 'EncodedVideoChunk', { configurable: true, writable: true, value: TestEncodedChunk });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', { configurable: true, writable: true, value: TestEncodedChunk });
  return () => {
    for (const [key, value] of [['EncodedVideoChunk', previous.video], ['EncodedAudioChunk', previous.audio]] as const) {
      if (value === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
  };
}

async function bytesOf(output: unknown): Promise<Uint8Array> {
  const out = output as { blob?: () => Promise<Blob> } | Blob;
  const blob = out instanceof Blob ? out : await (out as { blob: () => Promise<Blob> }).blob();
  return new Uint8Array(await blob.arrayBuffer());
}

describe('convert copies same-family video packets', () => {
  it('MPEG-TS H.264 + AAC into MP4 with a codec-only video target keeps the coded streams', async () => {
    const restore = installEncodedChunkShims();
    const media = createMedia();
    try {
      const source = await loadFixture('bear-1280x720.ts');
      const sourceInfo = await media.probe(fromBytes(source, { mime: 'video/mp2t' }));
      const out = await bytesOf(
        await media.convert(fromBytes(source, { mime: 'video/mp2t' }), {
          to: 'mp4',
          video: { codec: 'h264' },
        }),
      );
      const info = await media.probe(fromBytes(out, { mime: 'video/mp4' }));
      expect(info.container).toBe('mp4');
      const video = info.tracks.find((track) => track.type === 'video');
      const audio = info.tracks.find((track) => track.type === 'audio');
      // The TS probe names the family, the MP4 probe the exact sample entry: same H.264 stream either way.
      expect(video?.codec.startsWith('avc1')).toBe(true);
      expect(video?.width).toBe(1280);
      expect(audio?.codec.startsWith('mp4a')).toBe(true);
      expect(info.durationSec).toBeCloseTo(sourceInfo.durationSec, 1);
    } finally {
      await media.dispose();
      restore();
    }
  });

  it('MP4 H.264 into MKV with no video target copies the packets', async () => {
    const restore = installEncodedChunkShims();
    const media = createMedia();
    try {
      const source = await loadFixture('bear-1280x720.mp4');
      const out = await bytesOf(
        await media.convert(fromBytes(source, { mime: 'video/mp4' }), { to: 'mkv' }),
      );
      const info = await media.probe(fromBytes(out, { mime: 'video/x-matroska' }));
      const codec = info.tracks.find((track) => track.type === 'video')?.codec ?? '';
      expect(codec === 'h264' || codec.startsWith('avc1')).toBe(true);
    } finally {
      await media.dispose();
      restore();
    }
  });

  it('a video target that transforms still needs an encoder (typed miss without WebCodecs)', async () => {
    const media = createMedia();
    try {
      const source = await loadFixture('bear-1280x720.mp4');
      await expect(
        media.convert(fromBytes(source, { mime: 'video/mp4' }), {
          to: 'mp4',
          video: { codec: 'h264', width: 640 },
        }),
      ).rejects.toMatchObject({ name: 'CapabilityError' });
    } finally {
      await media.dispose();
    }
  });
});
