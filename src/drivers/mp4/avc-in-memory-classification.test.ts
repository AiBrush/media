import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../contracts/driver.ts';
import { Mp4Driver, readMovie } from './mp4-driver.ts';
import { buildSampleData } from './samples.ts';
import { writeMp4 } from './write.ts';

function accessUnit(nalHeader: number, sliceHeader: number): Uint8Array {
  return Uint8Array.of(0, 0, 0, 2, nalHeader, sliceHeader);
}

function largeAvc(): Uint8Array {
  const sampleCount = 4_097;
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
          cttsTicks: 0,
          keyframe: index === 0,
        })),
      },
    ],
    { faststart: true, brand: 'mp4' },
  );
}

async function firstClassifiedSampleOffset(bytes: Uint8Array): Promise<number> {
  const movie = await readMovie({
    size: bytes.byteLength,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  });
  return buildSampleData(movie.tracks[0] as NonNullable<(typeof movie.tracks)[0]>)[1]?.offset ?? -1;
}

describe('in-memory AVC picture classification', () => {
  it('classifies every access unit through bounded pull windows', async () => {
    const bytes = largeAvc();
    const ranges: Array<{ readonly start: number; readonly end: number }> = [];
    const source: ByteSource & { readonly kind: 'bytes' } = {
      kind: 'bytes',
      size: bytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('in-memory AVC classification must stay range-backed');
      },
      range(start, end): Promise<Uint8Array> {
        ranges.push({ start, end });
        return Promise.resolve(bytes.subarray(start, end));
      },
    };
    const packetInfo = Mp4Driver.packetInfo;
    if (packetInfo === undefined) throw new Error('MP4 packet info is unavailable');

    const table = await packetInfo.call(Mp4Driver, source);

    expect(table.packets).toHaveLength(4_097);
    expect(table.packets.filter((packet) => packet.keyframe)).toHaveLength(2_049);
    expect(ranges.every(({ start, end }) => end - start <= 8 * 1024 * 1024)).toBe(true);
    expect(ranges.some(({ start, end }) => start === 0 && end === bytes.byteLength)).toBe(false);
    expect(ranges.length).toBeLessThan(20);
  });

  it('observes abort at the first pulled AVC payload window', async () => {
    const bytes = largeAvc();
    const sampleOffset = await firstClassifiedSampleOffset(bytes);
    const abort = new AbortController();
    let payloadReads = 0;
    const source: ByteSource & { readonly kind: 'bytes' } = {
      kind: 'bytes',
      size: bytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('in-memory AVC classification must stay range-backed');
      },
      range(start, end): Promise<Uint8Array> {
        if (start <= sampleOffset && end > sampleOffset) {
          payloadReads++;
          abort.abort();
        }
        return Promise.resolve(bytes.subarray(start, end));
      },
    };
    const packetInfo = Mp4Driver.packetInfo;
    if (packetInfo === undefined) throw new Error('MP4 packet info is unavailable');

    await expect(
      packetInfo.call(Mp4Driver, source, { signal: abort.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(payloadReads).toBe(1);
  });

  it('rejects a short pulled AVC window before emitting its batch', async () => {
    const bytes = largeAvc();
    const sampleOffset = await firstClassifiedSampleOffset(bytes);
    const source: ByteSource & { readonly kind: 'bytes' } = {
      kind: 'bytes',
      size: bytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        throw new Error('in-memory AVC classification must stay range-backed');
      },
      range(start, end): Promise<Uint8Array> {
        return Promise.resolve(
          start <= sampleOffset && end > sampleOffset
            ? bytes.subarray(start, end - 1)
            : bytes.subarray(start, end),
        );
      },
    };
    const packetInfo = Mp4Driver.packetInfo;
    if (packetInfo === undefined) throw new Error('MP4 packet info is unavailable');

    await expect(packetInfo.call(Mp4Driver, source)).rejects.toMatchObject({
      code: 'demux-error',
      message: expect.stringContaining('short read'),
    });
  });
});
