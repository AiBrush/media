import { describe, expect, it } from 'vitest';
import type { ByteSource, PacketInfoMetadata } from '../../contracts/driver.ts';
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

describe('MP4 packet-info batches', () => {
  it('releases explicitly-owned AVC classification windows after their final consumer', async () => {
    const bytes = avcMp4(257);
    const released: Uint8Array[] = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('packet-info batches must stay range-backed');
      },
      range(start, end): Promise<Uint8Array> {
        return Promise.resolve(bytes.slice(start, Math.min(end, bytes.byteLength)));
      },
      releaseRange(view): void {
        released.push(view);
        const buffer = view.buffer as ArrayBuffer & {
          transfer?: (newByteLength?: number) => ArrayBuffer;
        };
        buffer.transfer?.(0);
      },
    };
    const packetInfoBatches = Mp4Driver.packetInfoBatches;
    if (packetInfoBatches === undefined) throw new Error('MP4 packet-info batches unavailable');
    const stream = await packetInfoBatches.call(Mp4Driver, source, { batchSize: 17 });
    const rows: PacketInfoMetadata[] = [];
    for await (const batch of stream) rows.push(...batch);

    expect(rows).toHaveLength(257);
    expect(rows.filter((row) => row.keyframe)).toHaveLength(129);
    expect(released.length).toBeGreaterThan(0);
    expect(released.every((view) => view.byteLength === 0)).toBe(true);
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
