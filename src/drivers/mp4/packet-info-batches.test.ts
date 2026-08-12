import { describe, expect, it } from 'vitest';
import type { ByteSource, PacketInfoMetadata } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { sha256Hex } from '../../util/digest.ts';
import { Mp4Driver } from './mp4-driver.ts';
import { writeMp4 } from './write.ts';

function audioMp4(sampleCount: number): Uint8Array {
  const data = Uint8Array.of(0xaa);
  return writeMp4([
    {
      mediaType: 'audio',
      sampleEntryType: 'mp4a',
      timescale: 48_000,
      sampleRate: 48_000,
      channels: 2,
      description: Uint8Array.of(0x11, 0x90),
      samples: Array.from({ length: sampleCount }, () => ({
        data,
        durationTicks: 1_024,
        cttsTicks: 0,
        keyframe: true,
      })),
    },
  ]);
}

function accessUnit(nalHeader: number, sliceHeader: number): Uint8Array {
  return Uint8Array.of(0, 0, 0, 2, nalHeader, sliceHeader);
}

function avcMp4(sampleCount: number): Uint8Array {
  return writeMp4(
    [
      {
        mediaType: 'video',
        sampleEntryType: 'avc1',
        timescale: 90_000,
        width: 16,
        height: 16,
        description: Uint8Array.of(1, 100, 0, 31, 255, 225, 0, 1, 103, 1, 0, 1, 104),
        samples: Array.from({ length: sampleCount }, (_, index) => ({
          data:
            index === 0
              ? accessUnit(0x65, 0xc0)
              : index % 2 === 1
                ? accessUnit(0x41, 0xb0)
                : accessUnit(0x41, 0xc0),
          durationTicks: 3_000,
          cttsTicks: index % 3 === 0 ? 1_500 : 0,
          keyframe: index === 0,
        })),
      },
    ],
    { faststart: true, brand: 'mp4' },
  );
}

function rangeSource(
  bytes: Uint8Array,
  ranges: Array<{ readonly start: number; readonly end: number }>,
  rangeOverride?: (
    start: number,
    end: number,
    signal: AbortSignal | undefined,
  ) => Promise<Uint8Array>,
): ByteSource {
  return {
    size: bytes.byteLength,
    stream(): ReadableStream<Uint8Array> {
      throw new Error('packet-info batches must stay range-backed');
    },
    range(start, end, signal): Promise<Uint8Array> {
      ranges.push({ start, end });
      return (
        rangeOverride?.(start, end, signal) ??
        Promise.resolve(bytes.subarray(start, Math.min(end, bytes.byteLength)))
      );
    },
  };
}

interface OwnedRangeSource {
  readonly source: ByteSource;
  readonly outstanding: ReadonlySet<Uint8Array>;
  readonly reads: () => number;
  readonly releases: () => number;
  readonly shortenNextRead: () => void;
}

function ownedRangeSource(bytes: Uint8Array): OwnedRangeSource {
  const outstanding = new Set<Uint8Array>();
  let reads = 0;
  let releases = 0;
  let shortenNextRead = false;
  return {
    source: {
      size: bytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('packet-info batches must stay range-backed');
      },
      range(start, end): Promise<Uint8Array> {
        reads++;
        const boundedEnd = Math.min(end, bytes.byteLength);
        const actualEnd = shortenNextRead ? Math.max(start, boundedEnd - 1) : boundedEnd;
        shortenNextRead = false;
        const view = bytes.slice(start, actualEnd);
        outstanding.add(view);
        return Promise.resolve(view);
      },
      releaseRange(view): void {
        if (!outstanding.delete(view)) {
          throw new Error('packet-info batches released a foreign or already-released range');
        }
        releases++;
        const buffer = view.buffer as ArrayBuffer;
        structuredClone(buffer, { transfer: [buffer] });
      },
    },
    outstanding,
    reads: () => reads,
    releases: () => releases,
    shortenNextRead: () => {
      shortenNextRead = true;
    },
  };
}

describe('MP4 packet-info batches', () => {
  it('releases every exact source range after a full AVC batch drain', async () => {
    const owned = ownedRangeSource(avcMp4(4_097));
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
    const stream = await packetInfoBatches.call(Mp4Driver, owned.source, { batchSize: 257 });
    expect(owned.outstanding.size).toBeGreaterThan(0);
    const rows: PacketInfoMetadata[] = [];
    for await (const batch of stream) rows.push(...batch);

    expect(rows).toHaveLength(4_097);
    expect(rows.filter((row) => row.keyframe)).toHaveLength(2_049);
    const description = stream.tracks[0]?.config?.description;
    expect(description).toBeInstanceOf(Uint8Array);
    expect((description as Uint8Array).byteLength).toBeGreaterThan(0);
    expect(owned.reads()).toBeGreaterThan(1);
    expect(owned.releases()).toBe(owned.reads());
    expect(owned.outstanding.size).toBe(0);
  });

  it('releases every exact source range on early cancel without invalidating emitted metadata', async () => {
    const owned = ownedRangeSource(avcMp4(4_097));
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
    const stream = await packetInfoBatches.call(Mp4Driver, owned.source, { batchSize: 257 });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('expected an AVC packet-info batch');
    expect(first.value).toHaveLength(257);
    expect(owned.outstanding.size).toBeGreaterThan(0);

    await stream.cancel('stop');

    const releasesAfterCancel = owned.releases();
    expect(releasesAfterCancel).toBe(owned.reads());
    expect(owned.outstanding.size).toBe(0);
    expect(first.value[0]?.size).toBeGreaterThan(0);
    const description = stream.tracks[0]?.config?.description;
    expect(description).toBeInstanceOf(Uint8Array);
    expect((description as Uint8Array).byteLength).toBeGreaterThan(0);
    await iterator.return?.();
    expect(owned.releases()).toBe(releasesAfterCancel);
  });

  it('releases a non-cooperative range that fulfills after cancel and preserves the abort reason', async () => {
    const bytes = avcMp4(4_097);
    const outstanding = new Set<Uint8Array>();
    let reads = 0;
    let releases = 0;
    let deferNextRead = false;
    let lateView: Uint8Array | undefined;
    let fulfillLate: (() => void) | undefined;
    let announceLateStart: (() => void) | undefined;
    let announceLateRelease: (() => void) | undefined;
    const lateStarted = new Promise<void>((resolve) => {
      announceLateStart = resolve;
    });
    const lateReleased = new Promise<void>((resolve) => {
      announceLateRelease = resolve;
    });
    const source: ByteSource = {
      size: bytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('packet-info batches must stay range-backed');
      },
      range(start, end): Promise<Uint8Array> {
        reads++;
        const view = bytes.slice(start, Math.min(end, bytes.byteLength));
        if (deferNextRead) {
          deferNextRead = false;
          lateView = view;
          announceLateStart?.();
          return new Promise<Uint8Array>((resolve) => {
            fulfillLate = () => {
              outstanding.add(view);
              resolve(view);
            };
          });
        }
        outstanding.add(view);
        return Promise.resolve(view);
      },
      releaseRange(view): void {
        if (!outstanding.delete(view)) {
          throw new Error('packet-info batches released a foreign or already-released range');
        }
        releases++;
        const wasLate = view === lateView;
        const buffer = view.buffer as ArrayBuffer;
        structuredClone(buffer, { transfer: [buffer] });
        if (wasLate) announceLateRelease?.();
      },
    };
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
    const stream = await packetInfoBatches.call(Mp4Driver, source, { batchSize: 257 });
    deferNextRead = true;
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await lateStarted;
    const abortReason = new MediaError('aborted', 'late range cancellation');

    await stream.cancel(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(releases).toBe(reads - 1);
    expect(outstanding.size).toBe(0);
    const completeLate = fulfillLate;
    if (completeLate === undefined) throw new Error('late range was not captured');
    completeLate();
    await lateReleased;
    expect(lateView?.byteLength).toBe(0);
    expect(releases).toBe(reads);
    expect(outstanding.size).toBe(0);
    await stream.cancel();
    expect(releases).toBe(reads);
  });

  it('releases setup ranges when packet-info parsing rejects before returning a stream', async () => {
    const owned = ownedRangeSource(Uint8Array.of(0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70));
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');

    await expect(packetInfoBatches.call(Mp4Driver, owned.source)).rejects.toThrow(
      /no moov box found/,
    );

    expect(owned.reads()).toBeGreaterThan(0);
    expect(owned.releases()).toBe(owned.reads());
    expect(owned.outstanding.size).toBe(0);
  });

  it('releases every exact source range when an AVC batch pull rejects', async () => {
    const owned = ownedRangeSource(avcMp4(4_097));
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
    const stream = await packetInfoBatches.call(Mp4Driver, owned.source, { batchSize: 257 });
    owned.shortenNextRead();

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/short read/);

    expect(owned.reads()).toBeGreaterThan(1);
    expect(owned.releases()).toBe(owned.reads());
    expect(owned.outstanding.size).toBe(0);
    const releasesAfterError = owned.releases();
    await stream.cancel();
    expect(owned.releases()).toBe(releasesAfterError);
  });

  it('concatenates to exact compatibility rows while respecting the requested batch ceiling', async () => {
    const bytes = avcMp4(257);
    const packetInfo = Mp4Driver.packetInfo;
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfo === undefined || packetInfoBatches === undefined) {
      throw new Error('MP4 packet-info capabilities are unavailable');
    }
    const expected = await packetInfo.call(Mp4Driver, rangeSource(bytes, []));
    const stream = await packetInfoBatches.call(Mp4Driver, rangeSource(bytes, []), {
      batchSize: 17,
    });
    expect(expected.tracks[0]?.defaultDisposition).toBe(true);
    expect(stream.tracks[0]?.defaultDisposition).toBe(true);
    const batches: Array<readonly PacketInfoMetadata[]> = [];
    for await (const batch of stream) batches.push(batch);
    expect(batches.every((batch) => batch.length > 0 && batch.length <= 17)).toBe(true);
    expect(new Set(batches).size).toBe(batches.length);
    expect(batches.flat()).toEqual(expected.packets);
    expect(expected.packets.filter((packet) => packet.keyframe)).toHaveLength(129);
  });

  it('optionally hashes exact packet payloads without retaining their byte views', async () => {
    const bytes = avcMp4(9);
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
    const stream = await packetInfoBatches.call(Mp4Driver, rangeSource(bytes, []), {
      batchSize: 3,
      includePayloadDigests: true,
    });
    const rows: PacketInfoMetadata[] = [];
    for await (const batch of stream) rows.push(...batch);

    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.offset).toBeTypeOf('number');
      const offset = row.offset as number;
      expect(row.payloadDigest).toBe(
        await sha256Hex(Uint8Array.from(bytes.subarray(offset, offset + row.size))),
      );
      expect((row as PacketInfoMetadata & { payload?: Uint8Array }).payload).toBeUndefined();
    }
  });

  it('hashes a progressive source larger than 64 MiB without exposing offsets or draining it', async () => {
    const bytes = avcMp4(9);
    const expectedPacketInfo = Mp4Driver.packetInfo;
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (expectedPacketInfo === undefined || packetInfoBatches === undefined) {
      throw new Error('MP4 packet-info capabilities are unavailable');
    }
    const expected = await expectedPacketInfo.call(Mp4Driver, rangeSource(bytes, []));
    const ranges: Array<{ readonly start: number; readonly end: number }> = [];
    const source: ByteSource = {
      size: 64 * 1024 * 1024 + 1,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('large progressive packet-info digests must stay range-backed');
      },
      range(start, end): Promise<Uint8Array> {
        ranges.push({ start, end });
        return Promise.resolve(bytes.subarray(start, Math.min(end, bytes.byteLength)));
      },
    };
    const stream = await packetInfoBatches.call(Mp4Driver, source, {
      batchSize: 3,
      includePayloadDigests: true,
    });
    const rows: PacketInfoMetadata[] = [];
    for await (const batch of stream) rows.push(...batch);

    expect(rows).toHaveLength(expected.packets.length);
    expect(rows.every((row) => row.offset === undefined)).toBe(true);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const truth = expected.packets[index];
      if (row === undefined || truth?.offset === undefined) {
        throw new Error('expected a physical source packet');
      }
      expect(row.payloadDigest).toBe(
        await sha256Hex(Uint8Array.from(bytes.subarray(truth.offset, truth.offset + truth.size))),
      );
    }
    expect(ranges.length).toBeGreaterThan(1);
    expect(Math.max(...ranges.map(({ start, end }) => end - start))).toBeLessThanOrEqual(64 * 1024);
  });

  it('reads and classifies only the first requested AVC batch, then honors backpressure', async () => {
    const bytes = avcMp4(257);
    const ranges: Array<{ readonly start: number; readonly end: number }> = [];
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
    const stream = await packetInfoBatches.call(Mp4Driver, rangeSource(bytes, ranges), {
      batchSize: 11,
    });
    const setupReads = ranges.length;
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toHaveLength(11);
    const afterFirstPull = ranges.length;
    expect(afterFirstPull).toBeGreaterThan(setupReads);
    await Promise.resolve();
    expect(ranges).toHaveLength(afterFirstPull);
    await iterator.return?.();
  });

  it('cancels an ignored hanging payload transport during an in-flight pull', async () => {
    const bytes = avcMp4(65);
    const probeRanges: Array<{ readonly start: number; readonly end: number }> = [];
    const ordinary = rangeSource(bytes, probeRanges);
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
    const probe = await packetInfoBatches.call(Mp4Driver, ordinary, { batchSize: 2 });
    const probeIterator = probe[Symbol.asyncIterator]();
    await probeIterator.next();
    const payloadRange = probeRanges.at(-1);
    await probeIterator.return?.();
    if (payloadRange === undefined) throw new Error('expected an AVC payload range');

    let hangingReads = 0;
    const ranges: Array<{ readonly start: number; readonly end: number }> = [];
    const source = rangeSource(bytes, ranges, (start, end) => {
      if (start === payloadRange.start && end === payloadRange.end) {
        hangingReads++;
        return new Promise<Uint8Array>(() => {});
      }
      return Promise.resolve(bytes.subarray(start, end));
    });
    const stream = await packetInfoBatches.call(Mp4Driver, source, { batchSize: 2 });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    await stream.cancel('stop');
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(hangingReads).toBe(1);
  });

  it('yields a bounded first batch from a 500k-row synthetic table and can stop immediately', async () => {
    const bytes = audioMp4(500_001);
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
    const stream = await packetInfoBatches.call(Mp4Driver, rangeSource(bytes, []), {
      batchSize: 257,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toHaveLength(257);
    expect(first.value?.[0]?.dtsUs).toBe(0);
    expect(first.value?.at(-1)?.dtsUs).toBe(Math.round((256 * 1_024 * 1_000_000) / 48_000));
    await iterator.return?.();
  });

  it.each([0, -1, 1.5, 65_537])(
    'rejects invalid batch size %s before source I/O',
    async (batchSize) => {
      const packetInfoBatches = Mp4Driver.packetInfoBatches;
      if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
      let reads = 0;
      const source: ByteSource = {
        stream: () => {
          reads++;
          return new ReadableStream<Uint8Array>();
        },
        range: () => {
          reads++;
          return Promise.resolve(new Uint8Array());
        },
      };
      await expect(packetInfoBatches.call(Mp4Driver, source, { batchSize })).rejects.toMatchObject({
        code: 'unsupported-input',
      });
      expect(reads).toBe(0);
    },
  );
});
