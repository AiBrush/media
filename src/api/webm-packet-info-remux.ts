import type {
  ContainerDriver,
  PacketInfoMetadata,
  PacketInfoTable,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import type { Source } from '../sources/source.ts';
import { fromBytes } from '../sources/source.ts';
import { type PreparedWebmChunk, muxPreparedWebmChunkTracks } from './flac-mkv-mux.ts';
import { selectTrackInfos } from './track-select.ts';
import type { RemuxOptions } from './types.ts';
import { assertWebmRemuxTracksLegal } from './webm-remux-legality.ts';

/**
 * A complete buffered output transiently owns source bytes plus one output allocation. Keep that
 * deliberate speed/memory trade bounded; larger inputs retain the incremental packet seam.
 */
const WEBM_PACKET_INFO_MAX_SOURCE_BYTES = 64 * 1024 * 1024;

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

function packetRange(
  row: PacketInfoMetadata,
  sourceSize: number,
): { readonly offset: number; readonly end: number } {
  const offset = row.offset;
  if (offset === undefined) {
    throw new MediaError('demux-error', 'packet-info WebM remux needs source byte offsets');
  }
  const end = offset + row.size;
  if (offset < 0 || row.size <= 0 || end < offset || end > sourceSize) {
    throw new MediaError('demux-error', 'invalid packet byte range for WebM remux', {
      offset,
      size: row.size,
      sourceSize,
    });
  }
  return { offset, end };
}

function selectedTrackIndexes(
  tracks: readonly TrackInfo[],
  selected: readonly TrackInfo[],
): ReadonlyMap<number, TrackInfo> {
  const selectedSet = new Set(selected);
  const out = new Map<number, TrackInfo>();
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index];
    if (track !== undefined && selectedSet.has(track)) out.set(index, track);
  }
  return out;
}

/**
 * Small/medium MP4→WebM-family stream copy without one host `EncodedChunk`, stream pull, and mux write
 * per packet. Packet metadata still comes from the source driver; payloads are immutable subarray views
 * into one bounded source snapshot, and the prepared writer copies each view exactly once into output.
 */
export async function tryRemuxPacketInfoToBufferedWebm(
  container: ContainerDriver,
  src: Source,
  opts: RemuxOptions,
  stage: StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (
    (opts.to !== 'webm' && opts.to !== 'mkv') ||
    opts.fragmented === true ||
    container.id !== 'mp4'
  ) {
    return undefined;
  }
  if (container.packetInfo === undefined || src.range === undefined || src.size === undefined) {
    return undefined;
  }
  if (src.size > WEBM_PACKET_INFO_MAX_SOURCE_BYTES) return undefined;

  assertNotAborted(stage.signal);
  const sourceBytes = await src.range(0, src.size, stage.signal);
  assertNotAborted(stage.signal);
  if (sourceBytes.byteLength !== src.size) {
    throw new MediaError('demux-error', 'short source read for packet-info WebM remux', {
      expected: src.size,
      actual: sourceBytes.byteLength,
    });
  }

  const table = await packetInfoFromBytes(container, sourceBytes, src.mimeHint, stage);
  // Matroska has no representation for ISO common-encryption sample metadata. Preserve the generic
  // path's typed handling instead of accidentally copying ciphertext as ordinary coded media.
  if (table.tracks.some((track) => track.encrypted === true)) return undefined;
  const describedTracks = table.tracks.filter((track) => track.config !== undefined);
  const selected = selectTrackInfos(describedTracks, opts.trackSelect);
  if (selected.length === 0) {
    throw new CapabilityError('no packet-info WebM remux track', {
      op: { kind: 'route', id: 'remux' },
      tried: [container.id, opts.to],
    });
  }
  assertWebmRemuxTracksLegal(opts.to, selected);
  const selectedByIndex = selectedTrackIndexes(table.tracks, selected);
  const chunksByIndex = new Map<number, PreparedWebmChunk[]>();
  for (const trackIndex of selectedByIndex.keys()) chunksByIndex.set(trackIndex, []);

  let packetCount = 0;
  for (const row of table.packets) {
    const chunks = chunksByIndex.get(row.trackIndex);
    if (chunks === undefined) continue;
    const { offset, end } = packetRange(row, sourceBytes.byteLength);
    chunks.push({
      timestampUs: row.ptsUs,
      key: row.keyframe,
      data: sourceBytes.subarray(offset, end),
      dtsUs: row.dtsUs,
      ...(row.durationUs !== undefined ? { durationUs: row.durationUs } : {}),
    });
    packetCount++;
  }
  if (packetCount === 0) {
    throw new MediaError('mux-error', 'packet-info WebM remux selected no packets');
  }

  const tracks = [...selectedByIndex].map(([trackIndex, track]) => ({
    track,
    chunks: chunksByIndex.get(trackIndex) ?? [],
  }));
  assertNotAborted(stage.signal);
  return streamFromBytes(muxPreparedWebmChunkTracks({ tracks, container: opts.to }));
}

async function packetInfoFromBytes(
  container: ContainerDriver,
  sourceBytes: Uint8Array,
  mime: string | undefined,
  stage: StageOptions,
): Promise<PacketInfoTable> {
  if (container.packetInfo === undefined) {
    throw new CapabilityError('MP4 packet-info is not available', {
      op: { kind: 'route', id: 'remux' },
      tried: [container.id, 'webm'],
    });
  }
  return container.packetInfo(
    fromBytes(sourceBytes, mime === undefined ? undefined : { mime }),
    stage,
  );
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
