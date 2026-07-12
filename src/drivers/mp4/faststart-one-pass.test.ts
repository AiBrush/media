import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mp4PacketInfoFromBytes, muxPreparedMp4PacketTracks } from '../../api/mp4-prepared-mux.ts';
import type { EncodedChunk, Packet, PacketInfoMetadata } from '../../contracts/driver.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { writeMp4 } from './write.ts';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writableBytes(destination: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(destination)
    ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
    : new Uint8Array(destination);
}

function packet(row: PacketInfoMetadata, source: Uint8Array): Packet {
  if (row.offset === undefined) throw new Error('faststart golden needs packet offsets');
  const data = source.slice(row.offset, row.offset + row.size);
  const chunk = {
    byteLength: data.byteLength,
    timestamp: row.ptsUs,
    duration: row.durationUs ?? null,
    type: row.keyframe ? 'key' : 'delta',
    copyTo(destination: AllowSharedBufferSource): void {
      writableBytes(destination).set(data);
    },
  } as EncodedChunk;
  return { chunk, data, dtsUs: row.dtsUs, sizeBytes: row.size };
}

async function preparedOutput(
  fixture: string,
  container: 'mp4' | 'mov',
): Promise<{
  readonly sourceTable: Awaited<ReturnType<typeof mp4PacketInfoFromBytes>>;
  readonly output: Uint8Array;
}> {
  const source = await loadFixture(fixture);
  const sourceTable = await mp4PacketInfoFromBytes(source, { includeOffsets: true });
  const tracks = sourceTable.tracks.map((track, trackIndex) => ({
    track,
    packets: sourceTable.packets
      .filter((row) => row.trackIndex === trackIndex)
      .map((row) => packet(row, source)),
  }));
  return {
    sourceTable,
    output: muxPreparedMp4PacketTracks({ tracks, container, faststart: true }),
  };
}

function trackShape(track: Awaited<ReturnType<typeof mp4PacketInfoFromBytes>>['tracks'][number]): {
  readonly mediaType: string;
  readonly codec: string;
  readonly rotation: number | undefined;
} {
  return { mediaType: track.mediaType, codec: track.codec, rotation: track.rotation };
}

function expectPacketTruth(
  actual: readonly PacketInfoMetadata[],
  expected: readonly PacketInfoMetadata[],
): void {
  expect(actual).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index++) {
    const actualRow = actual[index];
    const expectedRow = expected[index];
    expect(actualRow).toBeDefined();
    expect(expectedRow).toBeDefined();
    if (actualRow === undefined || expectedRow === undefined) continue;
    expect({
      trackIndex: actualRow.trackIndex,
      size: actualRow.size,
      durationUs: actualRow.durationUs,
      keyframe: actualRow.keyframe,
    }).toEqual({
      trackIndex: expectedRow.trackIndex,
      size: expectedRow.size,
      durationUs: expectedRow.durationUs,
      keyframe: expectedRow.keyframe,
    });
    expect(
      Math.abs(actualRow.ptsUs - actualRow.dtsUs - (expectedRow.ptsUs - expectedRow.dtsUs)),
    ).toBeLessThanOrEqual(1);
  }
}

describe('one-pass faststart moov offset patch', () => {
  it.each([
    {
      fixture: 'obs-remux-variable-aac.mp4',
      container: 'mov',
      sha: '78444151c8fa8563cc17f3045f0a6b94977eabfa110015ec7f884ef0b1d42243',
    },
    {
      fixture: 'bear-rotate-90.mp4',
      container: 'mp4',
      sha: 'fe5e8b5f9d17b6fe2bb44ccb2210e75c04c1d5a29abca92df9faa0def939bf90',
    },
    {
      fixture: 'movie_5.mp4',
      container: 'mov',
      sha: '957f4009ab8cd5bae5bc36fa30f1d49a968afbe98b21adaa68789a03aebe783b',
    },
  ] as const)(
    'keeps the retained pre-change $fixture output byte-identical',
    async ({ fixture, container, sha }) => {
      const { sourceTable, output } = await preparedOutput(fixture, container);
      const reparsed = await mp4PacketInfoFromBytes(output);

      expect(sha256(output)).toBe(sha);
      expect(reparsed.tracks.map(trackShape)).toEqual(sourceTable.tracks.map(trackShape));
      expectPacketTruth(reparsed.packets, sourceTable.packets);
    },
  );

  it('keeps explicit multichunk offsets, an empty track, edit, rotation, and signed ctts byte-identical', () => {
    const output = writeMp4(
      [
        {
          mediaType: 'video',
          sampleEntryType: 'avc1',
          timescale: 1_000,
          width: 2,
          height: 2,
          rotation: 90,
          description: Uint8Array.of(1, 66, 0, 30, 255, 225, 0, 1, 103, 1, 0, 1, 104),
          samples: [
            { data: Uint8Array.of(1, 2), durationTicks: 40, cttsTicks: 10, keyframe: true },
            { data: Uint8Array.of(3), durationTicks: 60, cttsTicks: -10, keyframe: false },
          ],
          sampleChunks: [
            { firstSample: 0, sampleCount: 1, payloadOffset: 0 },
            { firstSample: 1, sampleCount: 1, payloadOffset: 2 },
          ],
          edit: { mediaTimeTicks: 10, durationTicks: 90 },
        },
        {
          mediaType: 'audio',
          sampleEntryType: 'mp4a',
          timescale: 48_000,
          sampleRate: 48_000,
          channels: 2,
          description: Uint8Array.of(0x11, 0x90),
          samples: [],
          sampleChunks: [],
        },
      ],
      { faststart: true, brand: 'mov' },
    );

    expect(sha256(output)).toBe('d7b012e0c8867939d447dce74122ed5e4e9768a17bc9c62e0eaf56609b979228');
  });
});
