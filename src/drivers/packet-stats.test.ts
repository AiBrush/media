import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ContainerDriver, PacketMetadata, PacketMetadataStats } from '../contracts/driver.ts';
import { packetStatsFromRows } from '../internal/packet-stats.ts';
import { fromBytes } from '../sources/source.ts';
import { fixtureSource } from '../test-support/corpus.ts';
import { AdtsDriver } from './adts/adts-driver.ts';
import { FlacDriver } from './flac/flac-driver.ts';
import { Mp4Driver } from './mp4/mp4-driver.ts';
import { OggDriver } from './ogg/ogg-driver.ts';
import { WebmDriver } from './webm/webm-driver.ts';

function summarizeRows(
  rows: readonly {
    readonly sizeBytes: number;
    readonly ptsUs: number;
    readonly dtsUs: number;
    readonly durationUs: number;
  }[],
): PacketMetadataStats | undefined {
  if (rows.length === 0) return undefined;
  return {
    packetCount: rows.length,
    totalSizeBytes: rows.reduce((total, row) => total + row.sizeBytes, 0),
    decodeStartUs: Math.min(...rows.map((row) => row.dtsUs)),
    decodeEndUs: Math.max(...rows.map((row) => row.dtsUs + row.durationUs)),
    presentationStartUs: Math.min(...rows.map((row) => row.ptsUs)),
    presentationEndUs: Math.max(...rows.map((row) => row.ptsUs + row.durationUs)),
  };
}

describe('constant-sized demux packet statistics', () => {
  it('fails closed for empty, malformed, and overflowing row summaries', () => {
    expect(packetStatsFromRows([])).toBeUndefined();
    expect(packetStatsFromRows([{ size: 1, ptsUs: 0, dtsUs: 0 }])).toBeUndefined();
    expect(
      packetStatsFromRows([
        { size: Number.MAX_SAFE_INTEGER, ptsUs: 0, durationUs: 1 },
        { size: Number.MAX_SAFE_INTEGER, ptsUs: 1, durationUs: 1 },
      ]),
    ).toBeUndefined();
  });

  it('matches every legacy packet table for first-party row-backed demuxers', async () => {
    const cases: Array<readonly [string, ContainerDriver]> = [
      ['sfx.adts', AdtsDriver],
      ['sfx.flac', FlacDriver],
      ['sfx-opus.ogg', OggDriver],
      ['movie_5.webm', WebmDriver],
    ];

    for (const [fixture, driver] of cases) {
      const demuxer = await driver.demux(await fixtureSource(fixture));
      try {
        const table = demuxer.packetTable?.();
        expect(table, `${fixture}: packet table`).toBeDefined();
        for (const track of demuxer.tracks) {
          const rows = (table ?? []).filter((row) => row.trackId === track.id);
          expect(demuxer.packetStats?.(track.id), `${fixture}: track ${track.id}`).toEqual(
            summarizeRows(rows),
          );
        }
      } finally {
        await demuxer.close();
      }
    }
  });

  it('matches progressive MP4 packet rows across edit-list and B-frame timing', async () => {
    const demuxer = await Mp4Driver.demux(await fixtureSource('test.mp4'));
    try {
      const table = demuxer.packetTable?.();
      if (table === undefined) throw new Error('progressive MP4 must expose packetTable');
      expect(table.some((row) => row.dtsUs !== row.ptsUs)).toBe(true);
      expect(table.some((row) => row.dtsUs < 0)).toBe(true);
      for (const track of demuxer.tracks) {
        expect(demuxer.packetStats?.(track.id)).toEqual(
          summarizeRows(table.filter((row) => row.trackId === track.id)),
        );
      }
    } finally {
      await demuxer.close();
    }
  });

  it('matches fragmented MP4 packet-info rows without copying the retained sample array', async () => {
    const source = await fixtureSource('bear-open-gop-frag.mp4');
    const demuxer = await Mp4Driver.demux(source);
    const packetInfo = Mp4Driver.packetInfo;
    if (packetInfo === undefined) throw new Error('MP4 packetInfo must be registered');
    try {
      expect(demuxer.packetTable).toBeUndefined();
      const table = await packetInfo.call(Mp4Driver, source);
      expect(table.packets.some((row) => row.dtsUs !== row.ptsUs)).toBe(true);
      for (let trackIndex = 0; trackIndex < table.tracks.length; trackIndex++) {
        const track = table.tracks[trackIndex];
        if (track === undefined) continue;
        const rows = table.packets
          .filter((row) => row.trackIndex === trackIndex && row.durationUs !== undefined)
          .map((row) => ({
            sizeBytes: row.size,
            ptsUs: row.ptsUs,
            dtsUs: row.dtsUs,
            durationUs: row.durationUs as number,
          }));
        expect(demuxer.packetStats?.(track.id)).toEqual(summarizeRows(rows));
      }
    } finally {
      await demuxer.close();
    }
  });

  it('keeps exact WebM presentation evidence but omits unbounded reordered decode bounds', async () => {
    const path = new URL(
      '../../../media-test/fixtures/media/scenarios/demux/h264_in_mkv/01.mkv',
      import.meta.url,
    );
    const bytes = new Uint8Array(await readFile(path));
    const demuxer = await WebmDriver.demux(fromBytes(bytes, { mime: 'video/x-matroska' }));
    try {
      const table = demuxer.packetTable?.();
      const track = demuxer.tracks.find((candidate) => candidate.mediaType === 'video');
      if (table === undefined || track === undefined)
        throw new Error('expected reordered video rows');
      const rows = table.filter((row: PacketMetadata) => row.trackId === track.id);
      expect(rows.some((row) => row.dtsUs !== row.ptsUs)).toBe(true);
      const expected = summarizeRows(rows);
      const actual = demuxer.packetStats?.(track.id);
      expect(actual).toMatchObject({
        packetCount: expected?.packetCount,
        totalSizeBytes: expected?.totalSizeBytes,
        presentationStartUs: expected?.presentationStartUs,
        presentationEndUs: expected?.presentationEndUs,
      });
      expect(actual?.decodeStartUs).toBeUndefined();
      expect(actual?.decodeEndUs).toBeUndefined();
    } finally {
      await demuxer.close();
    }
  });
});
