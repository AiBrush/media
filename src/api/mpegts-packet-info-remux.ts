import type {
  ContainerDriver,
  PacketInfoMetadata,
  PacketInfoTable,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import {
  type MpegTsChunk,
  type MpegTsPacketTrackInput,
  writeMpegTsPacketTracks,
} from '../drivers/mpegts/ts-write.ts';
import type { Source } from '../sources/source.ts';
import { fromBytes } from '../sources/source.ts';
import { selectTrackInfos } from './track-select.ts';
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
  const sourceBytes = await src.range(0, src.size);
  assertNotAborted(stage.signal);
  if (sourceBytes.byteLength !== src.size) {
    throw new MediaError('demux-error', 'short MP4 source read for MPEG-TS packet-info remux', {
      expected: src.size,
      actual: sourceBytes.byteLength,
    });
  }

  const table = await packetInfoFromBytes(container, sourceBytes, stage);
  const describedTracks = table.tracks.filter((track) => track.config !== undefined);
  const selected = selectTrackInfos(describedTracks, opts.trackSelect);
  if (selected.length === 0) {
    throw new CapabilityError('capability-miss', 'no packet-info MPEG-TS remux track', {
      op: 'remux',
      tried: [container.id, opts.to],
    });
  }
  const selectedByIndex = packetTrackIndexes(table.tracks, selected);

  const chunksByIndex = new Map<number, MpegTsChunk[]>();
  for (const trackIndex of selectedByIndex.keys()) {
    chunksByIndex.set(trackIndex, []);
  }

  let packetCount = 0;
  for (const row of table.packets) {
    const chunks = chunksByIndex.get(row.trackIndex);
    if (chunks === undefined) continue;
    const end = validatePacketRow(row, sourceBytes.byteLength);
    chunks.push({
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
  const tracks = packetTracksFromSelected(selectedByIndex, chunksByIndex);
  return streamFromBytes(writeMpegTsPacketTracks(tracks));
}

async function packetInfoFromBytes(
  container: ContainerDriver,
  sourceBytes: Uint8Array,
  stage: StageOptions,
): Promise<PacketInfoTable> {
  if (container.packetInfo === undefined) {
    throw new CapabilityError('capability-miss', 'MP4 packet-info is not available', {
      op: 'remux',
      tried: [container.id, 'ts'],
    });
  }
  return container.packetInfo(fromBytes(sourceBytes, { mime: 'video/mp4' }), stage);
}

function packetTracksFromSelected(
  selectedByIndex: ReadonlyMap<number, TrackInfo>,
  chunksByIndex: ReadonlyMap<number, readonly MpegTsChunk[]>,
): MpegTsPacketTrackInput[] {
  const tracks: MpegTsPacketTrackInput[] = [];
  for (const [trackIndex, track] of selectedByIndex) {
    const chunks = chunksByIndex.get(trackIndex);
    if (chunks !== undefined) tracks.push({ track, chunks });
  }
  return tracks;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
