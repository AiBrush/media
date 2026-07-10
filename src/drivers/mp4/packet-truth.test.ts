import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fromBytes } from '../../sources/source.ts';
import { Mp4Driver, mp4PacketInfoTable, readMovie } from './mp4-driver.ts';

const DERIVED_DIR = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;

describe('MP4/MOV packet truth', () => {
  it('enumerates the real tmcd packet alongside every AV packet in declared track order', async () => {
    const bytes = new Uint8Array(await readFile(`${DERIVED_DIR}mov-tmcd-copy.mov`));
    const packetInfo = Mp4Driver.packetInfo;
    expect(packetInfo).toBeDefined();
    if (packetInfo === undefined) throw new Error('MP4 packetInfo capability is missing');
    const table = await packetInfo(fromBytes(bytes, { mime: 'video/quicktime' }));

    expect(table.tracks).toHaveLength(3);
    expect(table.tracks.map((track) => track.nonMedia === true)).toEqual([false, false, true]);
    expect(table.packets).toHaveLength(232); // ffprobe: 120 video + 111 audio + 1 tmcd

    const timecodePackets = table.packets.filter((packet) => packet.trackIndex === 2);
    expect(timecodePackets).toEqual([
      {
        trackIndex: 2,
        offset: 36,
        size: 4,
        ptsUs: 0,
        dtsUs: 0,
        durationUs: 5_000_000,
        keyframe: true,
      },
    ]);
  });

  it('does not expose internal sample offsets when packet-info selects large-file mode', async () => {
    const bytes = new Uint8Array(await readFile(`${DERIVED_DIR}mov-tmcd-copy.mov`));
    const movie = await readMovie({
      size: bytes.byteLength,
      inMemory: true,
      read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
    });

    expect(mp4PacketInfoTable(movie).packets.every((packet) => packet.offset === undefined)).toBe(
      true,
    );
    expect(
      mp4PacketInfoTable(movie, bytes.byteLength).packets.every(
        (packet) => packet.offset !== undefined,
      ),
    ).toBe(true);
  });
});
