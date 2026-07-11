import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ByteSource, Packet } from '../../contracts/driver.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { Mp4Driver, readMovie } from './mp4-driver.ts';
import { buildSamples } from './samples.ts';
import { writeMp4 } from './write.ts';

interface RangeRead {
  readonly start: number;
  readonly end: number;
}

type CountingSource = ByteSource & { readonly kind: 'bytes' | 'url' };

function countingSource(
  bytes: Uint8Array,
  reads: RangeRead[],
  kind: CountingSource['kind'],
): CountingSource {
  return {
    kind,
    size: bytes.byteLength,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    range: (start, end) => {
      reads.push({ start, end });
      return Promise.resolve(bytes.subarray(start, end));
    },
  };
}

function firstStcoEntryOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let typeOffset = 4; typeOffset + 16 <= bytes.byteLength; typeOffset++) {
    if (
      bytes[typeOffset] !== 0x73 ||
      bytes[typeOffset + 1] !== 0x74 ||
      bytes[typeOffset + 2] !== 0x63 ||
      bytes[typeOffset + 3] !== 0x6f
    ) {
      continue;
    }
    const boxStart = typeOffset - 4;
    const boxSize = view.getUint32(boxStart);
    const entryCount = view.getUint32(typeOffset + 8);
    if (boxSize >= 20 && boxStart + boxSize <= bytes.byteLength && entryCount > 0) {
      return typeOffset + 12;
    }
  }
  throw new Error('MP4 fixture has no populated stco box');
}

function firstStscSamplesPerChunkOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let typeOffset = 4; typeOffset + 24 <= bytes.byteLength; typeOffset++) {
    if (
      bytes[typeOffset] !== 0x73 ||
      bytes[typeOffset + 1] !== 0x74 ||
      bytes[typeOffset + 2] !== 0x73 ||
      bytes[typeOffset + 3] !== 0x63
    ) {
      continue;
    }
    const boxStart = typeOffset - 4;
    const boxSize = view.getUint32(boxStart);
    const entryCount = view.getUint32(typeOffset + 8);
    if (boxSize >= 28 && boxStart + boxSize <= bytes.byteLength && entryCount > 0) {
      return typeOffset + 16;
    }
  }
  throw new Error('MP4 fixture has no populated stsc box');
}

function withFirstStcoOffset(bytes: Uint8Array, offset: number): Uint8Array {
  const mutated = bytes.slice();
  new DataView(mutated.buffer, mutated.byteOffset, mutated.byteLength).setUint32(
    firstStcoEntryOffset(mutated),
    offset,
  );
  return mutated;
}

function withFirstTwoStcoEntriesSwapped(bytes: Uint8Array): Uint8Array {
  const mutated = bytes.slice();
  const firstEntry = firstStcoEntryOffset(mutated);
  const view = new DataView(mutated.buffer, mutated.byteOffset, mutated.byteLength);
  const first = view.getUint32(firstEntry);
  const second = view.getUint32(firstEntry + 4);
  if (first === second) throw new Error('MP4 fixture needs distinct first stco entries');
  view.setUint32(firstEntry, second);
  view.setUint32(firstEntry + 4, first);
  return mutated;
}

function observeArraySorts<T>(run: () => T): { readonly value: T; readonly calls: number } {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'sort');
  const originalSort = Array.prototype.sort;
  let calls = 0;
  const observedSort = function observedSort(
    this: unknown[],
    compare?: (left: unknown, right: unknown) => number,
  ): unknown[] {
    calls++;
    return originalSort.call(this, compare);
  };
  Object.defineProperty(Array.prototype, 'sort', {
    configurable: true,
    value: observedSort as typeof Array.prototype.sort,
    writable: true,
  });
  try {
    return { value: run(), calls };
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(Array.prototype, 'sort');
    else Object.defineProperty(Array.prototype, 'sort', descriptor);
  }
}

interface FakeChunkInit {
  readonly type?: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration?: number;
  readonly data: AllowSharedBufferSource;
}

class FakeEncodedChunk {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;

  constructor(init: FakeChunkInit) {
    constructedChunks++;
    this.type = init.type ?? 'key';
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.byteLength = init.data.byteLength;
  }
}

let constructedChunks = 0;

interface PacketSnapshot {
  readonly size: number;
  readonly ptsUs: number;
  readonly dtsUs: number;
  readonly durationUs: number | null;
  readonly keyframe: boolean;
}

async function drainPackets(stream: ReadableStream<Packet>): Promise<PacketSnapshot[]> {
  const packets: PacketSnapshot[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return packets;
      const packet = next.value;
      const chunk = packet.chunk as EncodedVideoChunk;
      packets.push({
        size: packet.data?.byteLength ?? chunk.byteLength,
        ptsUs: chunk.timestamp,
        dtsUs: packet.dtsUs ?? chunk.timestamp,
        durationUs: chunk.duration,
        keyframe: chunk.type === 'key',
      });
    }
  } finally {
    reader.releaseLock();
  }
}

interface PullCounts {
  promise: number;
  synchronous: number;
}

async function observePacketPullResults<T>(run: () => Promise<T>): Promise<{
  readonly value: T;
  readonly pulls: PullCounts;
}> {
  const NativeReadableStream = globalThis.ReadableStream;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ReadableStream');
  const pulls: PullCounts = { promise: 0, synchronous: 0 };

  class ObservedReadableStream<R = unknown> extends NativeReadableStream<R> {
    constructor(source: UnderlyingSource<R> = {}, strategy?: QueuingStrategy<R>) {
      const originalPull = source.pull;
      if (originalPull === undefined) {
        super(source, strategy);
        return;
      }
      super(
        {
          ...source,
          pull(controller): void | PromiseLike<void> {
            const result = originalPull.call(source, controller);
            if (result === undefined) pulls.synchronous++;
            else pulls.promise++;
            return result;
          },
        },
        strategy,
      );
    }
  }

  Object.defineProperty(globalThis, 'ReadableStream', {
    configurable: true,
    value: ObservedReadableStream as typeof ReadableStream,
  });
  try {
    return { value: await run(), pulls };
  } finally {
    if (originalDescriptor === undefined) Reflect.deleteProperty(globalThis, 'ReadableStream');
    else Object.defineProperty(globalThis, 'ReadableStream', originalDescriptor);
  }
}

let originalAudioChunk: typeof EncodedAudioChunk | undefined;
let originalVideoChunk: typeof EncodedVideoChunk | undefined;

describe('MP4 demux retained-range and pull allocation bounds', () => {
  beforeAll(() => {
    originalAudioChunk = globalThis.EncodedAudioChunk;
    originalVideoChunk = globalThis.EncodedVideoChunk;
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: FakeEncodedChunk as unknown as typeof EncodedAudioChunk,
    });
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: FakeEncodedChunk as unknown as typeof EncodedVideoChunk,
    });
  });

  afterAll(() => {
    if (originalAudioChunk === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else {
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        value: originalAudioChunk,
      });
    }
    if (originalVideoChunk === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    else {
      Object.defineProperty(globalThis, 'EncodedVideoChunk', {
        configurable: true,
        value: originalVideoChunk,
      });
    }
  });

  it('serves progressive packet windows from the complete retained bytes without another range call', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const reads: RangeRead[] = [];
    const demuxer = await Mp4Driver.demux(countingSource(bytes, reads, 'bytes'));
    try {
      const table = demuxer.packetTable?.();
      expect(table).toBeDefined();
      const readsAfterDemux = reads.length;
      expect(reads).toContainEqual({ start: 0, end: bytes.byteLength });

      let packetCount = 0;
      let packetBytes = 0;
      for (const track of demuxer.tracks) {
        const packets = await drainPackets(demuxer.packets(track.id));
        packetCount += packets.length;
        packetBytes += packets.reduce((total, packet) => total + packet.size, 0);
      }

      expect(packetCount).toBe(table?.length);
      expect(packetBytes).toBe(table?.reduce((total, packet) => total + packet.sizeBytes, 0));
      expect(reads).toHaveLength(readsAfterDemux);
    } finally {
      await demuxer.close();
    }
  });

  it('reuses one complete fragmented-file read for fragment mapping, validation, and packet bytes', async () => {
    const path = fileURLToPath(
      new URL(
        '../../../fixtures/media-derived/mp4-hybrid-fragmented/lc48-stereo.m4a',
        import.meta.url,
      ),
    );
    const bytes = new Uint8Array(await readFile(path));
    const reads: RangeRead[] = [];
    const demuxer = await Mp4Driver.demux(countingSource(bytes, reads, 'url'));
    try {
      const track = demuxer.tracks.find((candidate) => candidate.mediaType === 'audio');
      expect(track).toBeDefined();
      if (track === undefined) return;
      const packets = await drainPackets(demuxer.packets(track.id));
      expect(packets).toHaveLength(580);
      expect(packets.reduce((total, packet) => total + packet.size, 0)).toBeGreaterThan(0);

      const completeReads = reads
        .map((read, index) => ({ ...read, index }))
        .filter((read) => read.start === 0 && read.end === bytes.byteLength);
      expect(completeReads).toHaveLength(1);
      const completeRead = completeReads[0];
      expect(completeRead).toBeDefined();
      expect(reads.slice((completeRead?.index ?? -1) + 1)).toEqual([]);
    } finally {
      await demuxer.close();
    }
  });

  it('returns a Promise only for genuine packet-window misses and preserves B-frame packet truth', async () => {
    const bytes = await loadFixture('test.mp4');
    const reads: RangeRead[] = [];
    const demuxer = await Mp4Driver.demux(countingSource(bytes, reads, 'url'));
    try {
      const track = demuxer.tracks.find((candidate) => candidate.mediaType === 'video');
      expect(track).toBeDefined();
      if (track === undefined) return;
      const expected = demuxer
        .packetTable?.()
        .filter((packet) => packet.trackId === track.id)
        .map(
          (packet): PacketSnapshot => ({
            size: packet.sizeBytes,
            ptsUs: packet.ptsUs,
            dtsUs: packet.dtsUs,
            durationUs: packet.durationUs,
            keyframe: packet.keyframe,
          }),
        );
      expect(expected).toBeDefined();
      expect(expected?.some((packet) => packet.ptsUs !== packet.dtsUs)).toBe(true);
      const readsAfterDemux = reads.length;
      constructedChunks = 0;

      const observed = await observePacketPullResults(() =>
        drainPackets(demuxer.packets(track.id)),
      );
      const packetWindowReads = reads.length - readsAfterDemux;

      expect(observed.value).toEqual(expected);
      expect(packetWindowReads).toBeGreaterThan(0);
      expect(observed.pulls.promise).toBe(packetWindowReads);
      expect(observed.pulls.synchronous).toBeGreaterThan(observed.pulls.promise);
      expect(observed.pulls.promise + observed.pulls.synchronous).toBe((expected?.length ?? 0) + 1);
      expect(constructedChunks).toBe(expected?.length);
    } finally {
      await demuxer.close();
    }
  });

  it('plans ordinary monotonic MP4 packet windows without sorting one object per sample', async () => {
    const bytes = await loadFixture('test.mp4');
    const demuxer = await Mp4Driver.demux(countingSource(bytes, [], 'url'));
    try {
      const track = demuxer.tracks.find((candidate) => candidate.mediaType === 'video');
      expect(track).toBeDefined();
      if (track === undefined) return;

      const observed = observeArraySorts(() => demuxer.packets(track.id));

      expect(observed.calls).toBe(0);
      const packets = await drainPackets(observed.value);
      const packetTable = demuxer.packetTable?.();
      expect(packetTable).toBeDefined();
      if (packetTable === undefined) return;
      expect(packets).toHaveLength(
        packetTable.filter((packet) => packet.trackId === track.id).length,
      );
    } finally {
      await demuxer.close();
    }
  });

  it('falls back to stable offset sorting for a non-monotonic but in-mdat chunk layout', async () => {
    const bytes = withFirstTwoStcoEntriesSwapped(await loadFixture('movie_5.mp4'));
    const movie = await readMovie({
      size: bytes.byteLength,
      read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
    });
    const parsedTrack = movie.tracks.find((track) => {
      const offsets = track.samples.chunkOffsets;
      return offsets.some((offset, index) => index > 0 && offset < (offsets[index - 1] ?? offset));
    });
    expect(parsedTrack).toBeDefined();
    if (parsedTrack === undefined) return;
    const expected = buildSamples(parsedTrack).map(
      (sample): PacketSnapshot => ({
        size: sample.size,
        ptsUs: sample.ptsUs,
        dtsUs: sample.dtsUs,
        durationUs: sample.durationUs,
        keyframe: sample.keyframe,
      }),
    );
    const demuxer = await Mp4Driver.demux(countingSource(bytes, [], 'url'));
    try {
      const observed = observeArraySorts(() => demuxer.packets(parsedTrack.id));

      expect(observed.calls).toBe(1);
      expect(await drainPackets(observed.value)).toEqual(expected);
    } finally {
      await demuxer.close();
    }
  });

  it('does not start another packet read after cancellation', async () => {
    const bytes = await loadFixture('test.mp4');
    const reads: RangeRead[] = [];
    const demuxer = await Mp4Driver.demux(countingSource(bytes, reads, 'url'));
    try {
      const track = demuxer.tracks.find((candidate) => candidate.mediaType === 'video');
      expect(track).toBeDefined();
      if (track === undefined) return;
      const reader = demuxer.packets(track.id).getReader();
      constructedChunks = 0;
      const first = await reader.read();
      expect(first.done).toBe(false);
      await reader.cancel('packet consumer stopped');
      const readsAfterCancel = reads.length;
      const chunksAfterCancel = constructedChunks;
      await Promise.resolve();
      await Promise.resolve();
      expect(reads).toHaveLength(readsAfterCancel);
      expect(constructedChunks).toBe(chunksAfterCancel);
    } finally {
      await demuxer.close();
    }
  });

  it('rejects an abort before a retained-byte pull without reading or constructing a packet', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const reads: RangeRead[] = [];
    const abort = new AbortController();
    const demuxer = await Mp4Driver.demux(countingSource(bytes, reads, 'bytes'), {
      signal: abort.signal,
    });
    try {
      const track = demuxer.tracks[0];
      expect(track).toBeDefined();
      if (track === undefined) return;
      const readsAfterDemux = reads.length;
      constructedChunks = 0;
      abort.abort();

      const reader = demuxer.packets(track.id).getReader();
      await expect(reader.read()).rejects.toMatchObject({ code: 'aborted' });
      reader.releaseLock();
      expect(reads).toHaveLength(readsAfterDemux);
      expect(constructedChunks).toBe(0);
    } finally {
      await demuxer.close();
    }
  });

  it('emits no packet when an abort wins a genuine range miss', async () => {
    const bytes = await loadFixture('test.mp4');
    const reads: RangeRead[] = [];
    const abort = new AbortController();
    let holdPacketRead = false;
    let releasePacketRead: (() => void) | undefined;
    let markPacketReadStarted: (() => void) | undefined;
    const packetReadStarted = new Promise<void>((resolve) => {
      markPacketReadStarted = resolve;
    });
    const source = countingSource(bytes, reads, 'url');
    const ordinaryRange = source.range;
    if (ordinaryRange === undefined) throw new Error('counting source has no range method');
    const heldSource: CountingSource = {
      ...source,
      range(start, end): Promise<Uint8Array> {
        if (!holdPacketRead) return ordinaryRange.call(source, start, end);
        holdPacketRead = false;
        reads.push({ start, end });
        markPacketReadStarted?.();
        return new Promise<Uint8Array>((resolve) => {
          releasePacketRead = (): void => resolve(bytes.subarray(start, end));
        });
      },
    };
    const demuxer = await Mp4Driver.demux(heldSource, { signal: abort.signal });
    try {
      const track = demuxer.tracks.find((candidate) => candidate.mediaType === 'video');
      expect(track).toBeDefined();
      if (track === undefined) return;
      holdPacketRead = true;
      constructedChunks = 0;
      const reader = demuxer.packets(track.id).getReader();
      const pending = reader.read();
      await packetReadStarted;
      abort.abort();
      releasePacketRead?.();

      await expect(pending).rejects.toMatchObject({ code: 'aborted' });
      reader.releaseLock();
      expect(constructedChunks).toBe(0);
    } finally {
      await demuxer.close();
    }
  });

  it('rejects a short genuine range miss before constructing a packet', async () => {
    const bytes = await loadFixture('test.mp4');
    const reads: RangeRead[] = [];
    let shortPacketRead = false;
    const source = countingSource(bytes, reads, 'url');
    const ordinaryRange = source.range;
    if (ordinaryRange === undefined) throw new Error('counting source has no range method');
    const shortSource: CountingSource = {
      ...source,
      range(start, end): Promise<Uint8Array> {
        if (!shortPacketRead) return ordinaryRange.call(source, start, end);
        shortPacketRead = false;
        reads.push({ start, end });
        return Promise.resolve(bytes.subarray(start, Math.max(start, end - 1)));
      },
    };
    const demuxer = await Mp4Driver.demux(shortSource);
    try {
      const track = demuxer.tracks.find((candidate) => candidate.mediaType === 'video');
      expect(track).toBeDefined();
      if (track === undefined) return;
      shortPacketRead = true;
      constructedChunks = 0;
      const reader = demuxer.packets(track.id).getReader();

      await expect(reader.read()).rejects.toThrow(/sample window .* short read/);
      reader.releaseLock();
      expect(constructedChunks).toBe(0);
    } finally {
      await demuxer.close();
    }
  });

  it('accepts a zero-byte sample exactly at an empty mdat payload boundary', async () => {
    const bytes = writeMp4([
      {
        mediaType: 'audio',
        sampleEntryType: 'mp4a',
        timescale: 48_000,
        sampleRate: 48_000,
        channels: 2,
        description: Uint8Array.of(0x11, 0x90),
        samples: [
          {
            data: new Uint8Array(0),
            durationTicks: 1_024,
            cttsTicks: 0,
            keyframe: true,
          },
        ],
      },
    ]);
    const demuxer = await Mp4Driver.demux(countingSource(bytes, [], 'bytes'));
    try {
      const table = demuxer.packetTable?.();
      expect(table).toHaveLength(1);
      expect(table?.[0]?.sizeBytes).toBe(0);
      const track = demuxer.tracks[0];
      expect(track).toBeDefined();
      if (track === undefined) return;
      const packets = await drainPackets(demuxer.packets(track.id));
      expect(packets).toEqual([
        {
          size: 0,
          ptsUs: 0,
          dtsUs: 0,
          durationUs: 21_333,
          keyframe: true,
        },
      ]);
    } finally {
      await demuxer.close();
    }
  });

  it('rejects a progressive sample whose stco offset points inside ftyp instead of mdat', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const corrupted = withFirstStcoOffset(bytes, 8);

    await expect(Mp4Driver.demux(countingSource(corrupted, [], 'bytes'))).rejects.toMatchObject({
      code: 'demux-error',
      message: expect.stringContaining('not inside a declared MP4 mdat'),
    });
  });

  it('rejects a zero-byte sample whose stco offset has no mdat boundary ownership', async () => {
    const bytes = writeMp4([
      {
        mediaType: 'audio',
        sampleEntryType: 'mp4a',
        timescale: 48_000,
        sampleRate: 48_000,
        channels: 2,
        description: Uint8Array.of(0x11, 0x90),
        samples: [
          {
            data: new Uint8Array(0),
            durationTicks: 1_024,
            cttsTicks: 0,
            keyframe: true,
          },
        ],
      },
    ]);
    const corrupted = withFirstStcoOffset(bytes, 0);

    await expect(Mp4Driver.demux(countingSource(corrupted, [], 'bytes'))).rejects.toMatchObject({
      code: 'demux-error',
      message: expect.stringContaining('not inside a declared MP4 mdat'),
    });
  });

  it('rejects declared stsz samples that the stsc/chunk layout cannot place', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const corrupted = bytes.slice();
    new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength).setUint32(
      firstStscSamplesPerChunkOffset(corrupted),
      0,
    );

    await expect(Mp4Driver.demux(countingSource(corrupted, [], 'bytes'))).rejects.toMatchObject({
      code: 'demux-error',
      message: 'track 1 sample table declares 120 samples but its chunk layout places 107',
    });
  });
});
