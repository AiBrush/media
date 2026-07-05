import type {
  ContainerDriver,
  PacketInfoMetadata,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { MpegTsMuxer } from '../drivers/mpegts/ts-write.ts';
import type { Source } from '../sources/source.ts';
import { selectTrackInfos } from './codec-routing.ts';
import type { RemuxOptions } from './types.ts';

const MPEGTS_PACKET_INFO_MAX_SOURCE_BYTES = 64 * 1024 * 1024;

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

function validatePacketRow(row: PacketInfoMetadata, sourceSize: number): number {
  const offset = row.offset;
  if (offset === undefined) {
    throw new MediaError('demux-error', 'MP4 packet-info to MPEG-TS needs byte offsets');
  }
  const end = offset + row.size;
  if (offset < 0 || row.size <= 0 || end > sourceSize) {
    throw new MediaError('demux-error', 'invalid MP4 packet byte range for MPEG-TS remux', {
      offset,
      size: row.size,
      sourceSize,
    });
  }
  return end;
}

function packetTrackIndexes(
  tracks: readonly TrackInfo[],
  selected: readonly TrackInfo[],
): ReadonlyMap<number, TrackInfo> {
  const selectedSet = new Set(selected);
  const out = new Map<number, TrackInfo>();
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (track !== undefined && selectedSet.has(track)) out.set(index, track);
  }
  return out;
}

export async function tryRemuxPacketInfoToMpegTs(
  container: ContainerDriver,
  src: Source,
  opts: RemuxOptions,
  stage: StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (opts.to !== 'ts' || opts.fragmented === true || container.id !== 'mp4') return undefined;
  if (container.packetInfo === undefined || src.range === undefined || src.size === undefined) {
    return undefined;
  }
  if (src.size > MPEGTS_PACKET_INFO_MAX_SOURCE_BYTES) return undefined;

  assertNotAborted(stage.signal);
  const table = await container.packetInfo(src, stage);
  const describedTracks = table.tracks.filter((track) => track.config !== undefined);
  const selected = selectTrackInfos(describedTracks, opts.trackSelect);
  if (selected.length === 0) {
    throw new CapabilityError('capability-miss', 'no packet-info MPEG-TS remux track', {
      op: 'remux',
      tried: [container.id, opts.to],
    });
  }
  const selectedByIndex = packetTrackIndexes(table.tracks, selected);

  const sourceBytes = await src.range(0, src.size);
  assertNotAborted(stage.signal);
  if (sourceBytes.byteLength !== src.size) {
    throw new MediaError('demux-error', 'short MP4 source read for MPEG-TS packet-info remux', {
      expected: src.size,
      actual: sourceBytes.byteLength,
    });
  }

  const muxer = new MpegTsMuxer();
  const muxTrackByIndex = new Map<number, number>();
  for (const [trackIndex, track] of selectedByIndex) {
    muxTrackByIndex.set(trackIndex, muxer.addTrack(track));
  }

  let packetCount = 0;
  for (const row of table.packets) {
    const muxTrackId = muxTrackByIndex.get(row.trackIndex);
    if (muxTrackId === undefined) continue;
    const end = validatePacketRow(row, sourceBytes.byteLength);
    muxer.addChunkStruct(muxTrackId, {
      data: sourceBytes.subarray(row.offset, end),
      timestampUs: row.ptsUs,
      dtsUs: row.dtsUs,
      key: row.keyframe,
      ...(row.durationUs !== undefined ? { durationUs: row.durationUs } : {}),
    });
    packetCount += 1;
  }
  if (packetCount === 0) {
    throw new MediaError('mux-error', 'MP4 packet-info MPEG-TS remux selected no packets');
  }
  assertNotAborted(stage.signal);
  await muxer.finalize();
  return muxer.output;
}
