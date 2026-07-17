/**
 * The lazy FLAC container proxy (`flac-lazy-driver.ts`): native probe/packetInfo/demux fast paths
 * that never load the full driver chunk, exact multi-chunk byte-stream truth, and the shared
 * `LazyMuxer` routing with FLAC's single-audio-stream `validateTrack` constraint.
 */

import { describe, expect, it } from 'vitest';
import type { ByteSource, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fixtureSource, loadFixture } from '../../test-support/corpus.ts';
import { FlacDriver } from './flac-driver.ts';
import { lazyFlacContainerDriver } from './flac-lazy-driver.ts';
import { flacPacketInfoTable } from './flac-sniff.ts';

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function fakeEncodedAudioChunk(bytes: Uint8Array): EncodedAudioChunk {
  const chunk = {
    byteLength: bytes.byteLength,
    timestamp: 0,
    duration: 1024,
    type: 'key',
    copyTo(destination: AllowSharedBufferSource): void {
      const out = ArrayBuffer.isView(destination)
        ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
        : new Uint8Array(destination);
      out.set(bytes);
    },
  };
  return chunk as unknown as EncodedAudioChunk;
}

function flacTrackInfo(description: Uint8Array): TrackInfo {
  return {
    id: 7,
    mediaType: 'audio',
    codec: 'flac',
    config: {
      codec: 'flac',
      sampleRate: 48_000,
      numberOfChannels: 1,
      description,
    },
  };
}

describe('lazyFlacContainerDriver', () => {
  it('advertises cheap support checks and the driver capability surface without loading', () => {
    const flac = lazyFlacContainerDriver();
    expect(flac.formats).toEqual(['flac']);
    expect(flac.streamCopyTargets).toEqual(FlacDriver.streamCopyTargets);
    expect(
      flac.supports({ direction: 'demux', head: new Uint8Array([0x66, 0x4c, 0x61, 0x43]) }),
    ).toBe(true);
    expect(flac.supports({ direction: 'demux', mime: 'audio/flac' })).toBe(true);
    expect(flac.supports({ direction: 'demux', extension: 'flac' })).toBe(true);
    expect(flac.supports({ direction: 'demux', extension: 'mp3' })).toBe(false);
  });

  it('lazy-loads the FLAC container only when demux or PCM helpers are invoked', async () => {
    const flac = lazyFlacContainerDriver();
    if (
      flac.decodePcm === undefined ||
      flac.decodePcmAudio === undefined ||
      flac.transformPcm === undefined
    ) {
      throw new Error('lazy FLAC proxy must expose the PCM helper surface');
    }

    const src = await fixtureSource('flac-08bit.flac');
    const demuxer = await flac.demux(src);
    expect(demuxer.tracks).toHaveLength(1);
    expect(demuxer.tracks[0]?.codec).toBe('flac');
    await demuxer.close();

    const audio = await flac.decodePcmAudio(src);
    expect(audio.sampleRate).toBeGreaterThan(0);
    expect(audio.channels).toBeGreaterThan(0);
    expect(audio.planar[0]?.length).toBeGreaterThan(0);

    const wav = await collectBytes(await flac.decodePcm(src, { container: 'wav' }));
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');

    const transformed = await collectBytes(
      await flac.transformPcm(src, { container: 'wav', gainDb: -1 }),
    );
    expect(new TextDecoder().decode(transformed.slice(0, 4))).toBe('RIFF');
  });

  it('the lazy FLAC packet reader preserves multi-chunk truth and releases terminal readers', async () => {
    const bytes = await loadFixture('sfx.flac');
    const flac = lazyFlacContainerDriver();
    const packetInfo = flac.packetInfo;
    if (packetInfo === undefined) throw new Error('lazy FLAC packetInfo unavailable');
    const firstEnd = Math.floor(bytes.byteLength / 3);
    const secondEnd = Math.floor((bytes.byteLength * 2) / 3);
    let readable: ReadableStream<Uint8Array> | undefined;
    const source: ByteSource = {
      size: bytes.byteLength,
      stream: () => {
        readable = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes.subarray(0, firstEnd));
            controller.enqueue(bytes.subarray(firstEnd, secondEnd));
            controller.enqueue(bytes.subarray(secondEnd));
            controller.close();
          },
        });
        return readable;
      },
    };

    expect(await packetInfo.call(flac, source)).toEqual(flacPacketInfoTable(bytes));
    expect(readable?.locked).toBe(false);

    let singleChunkStream: ReadableStream<Uint8Array> | undefined;
    const singleChunk: ByteSource = {
      size: bytes.byteLength,
      stream: () => {
        singleChunkStream = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        return singleChunkStream;
      },
    };
    expect(await packetInfo.call(flac, singleChunk)).toEqual(flacPacketInfoTable(bytes));
    expect(singleChunkStream?.locked).toBe(false);

    let emptyStream: ReadableStream<Uint8Array> | undefined;
    const empty: ByteSource = {
      size: 0,
      stream: () => {
        emptyStream = new ReadableStream<Uint8Array>({
          start: (controller) => controller.close(),
        });
        return emptyStream;
      },
    };
    await expect(packetInfo.call(flac, empty)).rejects.toMatchObject({ code: 'unsupported-input' });
    expect(emptyStream?.locked).toBe(false);

    const failure = new Error('lazy FLAC producer failed');
    let reads = 0;
    let cancels = 0;
    let releases = 0;
    const reader = {
      read(): Promise<ReadableStreamReadResult<Uint8Array>> {
        if (reads++ === 0) return Promise.resolve({ done: false, value: bytes.subarray(0, 16) });
        return Promise.reject(failure);
      },
      cancel(reason: unknown): Promise<void> {
        expect(reason).toBe(failure);
        cancels++;
        return Promise.reject(new Error('lazy FLAC teardown also failed'));
      },
      releaseLock(): void {
        releases++;
      },
    };
    const failing: ByteSource = {
      size: bytes.byteLength,
      stream: () =>
        ({ getReader: (): typeof reader => reader }) as unknown as ReadableStream<Uint8Array>,
    };

    await expect(packetInfo.call(flac, failing)).rejects.toBe(failure);
    expect(cancels).toBe(1);
    expect(releases).toBe(1);
  });

  it('routes the lazy FLAC muxer through the real muxer and preserves typed misuse errors', async () => {
    const flac = lazyFlacContainerDriver();
    const description = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x00]);
    const frame = new Uint8Array([0xff, 0xf8, 0x69, 0x00]);

    const muxer = flac.createMuxer();
    expect(muxer.addTrack(flacTrackInfo(description))).toBe(0);
    const output = collectBytes(muxer.output);
    await muxer.write(0, { chunk: fakeEncodedAudioChunk(frame) } satisfies Packet);
    await muxer.finalize();
    const bytes = await output;
    expect([...bytes.slice(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect([...bytes.slice(-frame.byteLength)]).toEqual([...frame]);

    const invalid = flac.createMuxer();
    expect(() => invalid.addTrack({ id: 1, mediaType: 'video', codec: 'vp9' })).toThrowError(
      CapabilityError,
    );

    const duplicate = flac.createMuxer();
    expect(duplicate.addTrack(flacTrackInfo(description))).toBe(0);
    expect(() => duplicate.addTrack(flacTrackInfo(description))).toThrowError(CapabilityError);

    await expect(flac.createMuxer().finalize()).rejects.toThrowError(MediaError);
    await expect(
      flac.createMuxer().write(9, { chunk: fakeEncodedAudioChunk(new Uint8Array([0xff, 0xf8])) }),
    ).rejects.toThrowError(MediaError);
    await expect(flac.createMuxer({ fragmented: true }).finalize()).rejects.toThrowError(
      CapabilityError,
    );
  });

  it('the FLAC muxer does not advertise the raw-PCM seam its real muxer lacks', () => {
    expect(lazyFlacContainerDriver().createMuxer().writePcm).toBeUndefined();
  });
});
