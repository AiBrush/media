import type {
  ContainerDriver,
  Demuxer,
  Packet,
  PacketInfoMetadata,
  PacketInfoTable,
  PacketMetadata,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { WebmStreamingMuxer } from '../drivers/webm/ebml-write.ts';
import type { Source } from '../sources/source.ts';
import { selectTrackInfos } from './track-select.ts';
import type { RemuxOptions } from './types.ts';

const PACKET_INFO_REMUX_WINDOW_BYTES = 8 * 1024 * 1024;
const PACKET_INFO_REMUX_GAP_BYTES = 256 * 1024;

interface StreamingWebmReaderState {
  readonly order: number;
  readonly muxTrackId: number;
  readonly reader: ReadableStreamDefaultReader<Packet>;
  current: Packet | undefined;
}

interface StreamingWebmMuxerSink {
  readonly output: ReadableStream<Uint8Array>;
  write(trackId: number, packet: Packet): Promise<void>;
  finalize(): Promise<void>;
  fail(error: unknown): void;
}

interface PacketInfoReadWindow {
  start: number;
  end: number;
}

interface PacketInfoRemuxRow {
  readonly order: number;
  readonly muxTrackId: number;
  readonly packet: PacketInfoMetadata;
  readonly offset: number;
  window: PacketInfoReadWindow | undefined;
}

interface PacketInfoRemuxState {
  readonly rows: readonly PacketInfoRemuxRow[];
  index: number;
}

interface DemuxerWithPacketInfoTable extends Demuxer {
  packetInfoTable?: () => readonly PacketInfoMetadata[];
}

function packetDecodeTimeUs(packet: Packet): number {
  return packet.dtsUs ?? packet.chunk.timestamp;
}

function streamingWebmTimelineBaseUs(
  tracks: readonly TrackInfo[],
  packetTable: readonly PacketMetadata[] | undefined,
): number | undefined {
  if (packetTable === undefined || packetTable.length === 0) return undefined;
  const selectedTrackIds = new Set(tracks.map((track) => track.id));
  const hasDeclaredDuration = tracks.some(
    (track) =>
      track.durationSec !== undefined &&
      Number.isFinite(track.durationSec) &&
      track.durationSec > 0,
  );
  let baseUs = Number.POSITIVE_INFINITY;
  let hasNonNegativeTimestamp = false;
  for (const packet of packetTable) {
    if (!selectedTrackIds.has(packet.trackId)) continue;
    if (packet.ptsUs < baseUs) baseUs = packet.ptsUs;
    if (packet.ptsUs >= 0) hasNonNegativeTimestamp = true;
  }
  if (!Number.isFinite(baseUs)) return undefined;
  if (hasDeclaredDuration && hasNonNegativeTimestamp && baseUs < 0) return 0;
  return baseUs;
}

function packetInfoTimelineBaseUs(
  tracks: readonly TrackInfo[],
  selectedTrackIndexes: ReadonlySet<number>,
  packets: readonly PacketInfoMetadata[],
): number | undefined {
  if (packets.length === 0) return undefined;
  const hasDeclaredDuration = tracks.some(
    (track) =>
      track.durationSec !== undefined &&
      Number.isFinite(track.durationSec) &&
      track.durationSec > 0,
  );
  let baseUs = Number.POSITIVE_INFINITY;
  let hasNonNegativeTimestamp = false;
  for (const packet of packets) {
    if (!selectedTrackIndexes.has(packet.trackIndex)) continue;
    if (packet.ptsUs < baseUs) baseUs = packet.ptsUs;
    if (packet.ptsUs >= 0) hasNonNegativeTimestamp = true;
  }
  if (!Number.isFinite(baseUs)) return undefined;
  if (hasDeclaredDuration && hasNonNegativeTimestamp && baseUs < 0) return 0;
  return baseUs;
}

async function readNextStreamingWebmPacket(state: StreamingWebmReaderState): Promise<void> {
  const next = await state.reader.read();
  state.current = next.done ? undefined : next.value;
}

function nextStreamingWebmPacketState(
  states: readonly StreamingWebmReaderState[],
): StreamingWebmReaderState | undefined {
  let best: StreamingWebmReaderState | undefined;
  for (const state of states) {
    const packet = state.current;
    if (packet === undefined) continue;
    const bestPacket = best?.current;
    if (
      best === undefined ||
      bestPacket === undefined ||
      packetDecodeTimeUs(packet) < packetDecodeTimeUs(bestPacket) ||
      (packetDecodeTimeUs(packet) === packetDecodeTimeUs(bestPacket) && state.order < best.order)
    ) {
      best = state;
    }
  }
  return best;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

function packetEnd(row: PacketInfoRemuxRow): number {
  return row.offset + row.packet.size;
}

function validatePacketInfoRow(row: PacketInfoRemuxRow): void {
  const end = packetEnd(row);
  if (row.offset < 0 || row.packet.size < 0 || end < row.offset) {
    throw new MediaError(
      'demux-error',
      `packet-info remux row has invalid byte range [${row.offset}, ${end})`,
    );
  }
}

function assignPacketInfoWindows(rows: readonly PacketInfoRemuxRow[]): void {
  const byOffset = [...rows].sort((a, b) => a.offset - b.offset || a.order - b.order);
  let current: PacketInfoReadWindow | undefined;
  for (const row of byOffset) {
    validatePacketInfoRow(row);
    const end = packetEnd(row);
    if (current === undefined) {
      current = { start: row.offset, end };
      row.window = current;
      continue;
    }
    const gap = row.offset - current.end;
    const combinedSpan = end - current.start;
    if (gap <= PACKET_INFO_REMUX_GAP_BYTES && combinedSpan <= PACKET_INFO_REMUX_WINDOW_BYTES) {
      current.end = Math.max(current.end, end);
      row.window = current;
      continue;
    }
    current = { start: row.offset, end };
    row.window = current;
  }
}

function nextPacketInfoRemuxState(
  states: readonly PacketInfoRemuxState[],
): PacketInfoRemuxState | undefined {
  let best: PacketInfoRemuxState | undefined;
  for (const state of states) {
    const row = state.rows[state.index];
    if (row === undefined) continue;
    const bestRow = best?.rows[best.index];
    if (
      best === undefined ||
      bestRow === undefined ||
      row.packet.dtsUs < bestRow.packet.dtsUs ||
      (row.packet.dtsUs === bestRow.packet.dtsUs && row.order < bestRow.order)
    ) {
      best = state;
    }
  }
  return best;
}

class PacketInfoWindowReader {
  readonly #source: Source;
  #currentWindow: PacketInfoReadWindow | undefined;
  #currentBytes: Uint8Array | undefined;

  constructor(source: Source) {
    this.#source = source;
  }

  bytesFor(
    row: PacketInfoRemuxRow,
    signal: AbortSignal | undefined,
  ): Uint8Array | Promise<Uint8Array> {
    const range = this.#source.range;
    if (range === undefined) {
      throw new CapabilityError('capability-miss', 'packet-info remux needs range reads', {
        op: 'remux',
        tried: ['packet-info'],
      });
    }
    const window = row.window;
    if (window === undefined) {
      throw new MediaError('demux-error', 'packet-info remux row has no read window');
    }
    if (window !== this.#currentWindow) {
      return this.#loadBytesFor(row, window, range, signal);
    }
    return this.#sliceLoadedBytes(row, window);
  }

  async #loadBytesFor(
    row: PacketInfoRemuxRow,
    window: PacketInfoReadWindow,
    range: NonNullable<Source['range']>,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const bytes = await range.call(this.#source, window.start, window.end);
    throwIfAborted(signal);
    const expected = window.end - window.start;
    if (bytes.byteLength !== expected) {
      throw new MediaError(
        'demux-error',
        `packet-info window [${window.start}, ${window.end}) short read: got ${bytes.byteLength} of ${expected} bytes`,
      );
    }
    this.#currentWindow = window;
    this.#currentBytes = bytes;
    return this.#sliceLoadedBytes(row, window);
  }

  #sliceLoadedBytes(row: PacketInfoRemuxRow, window: PacketInfoReadWindow): Uint8Array {
    const bytes = this.#currentBytes;
    if (bytes === undefined) {
      throw new MediaError('demux-error', 'packet-info window bytes are missing');
    }
    const rel = row.offset - window.start;
    return bytes.subarray(rel, rel + row.packet.size);
  }
}

async function tryRemuxPacketInfoToStreamingWebm(
  container: ContainerDriver,
  src: Source,
  opts: RemuxOptions,
  stage: StageOptions,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (container.packetInfo === undefined || src.range === undefined) return undefined;
  const table = await container.packetInfo(src, stage);
  throwIfAborted(stage.signal);
  return tryCreatePacketInfoStreamingWebm(table, src, opts, stage, container.id);
}

function tryCreatePacketInfoStreamingWebm(
  table: PacketInfoTable,
  src: Source,
  opts: RemuxOptions,
  stage: StageOptions,
  containerId: string,
  close?: () => Promise<void>,
): ReadableStream<Uint8Array> | undefined {
  if (src.range === undefined) return undefined;
  const tracks = selectTrackInfos(
    table.tracks.filter((track) => track.config !== undefined),
    opts.trackSelect,
  );
  if (tracks.length === 0) {
    throw new CapabilityError('capability-miss', 'remux found no copyable track in the source', {
      op: 'remux',
      tried: [containerId],
    });
  }

  const selectedIds = new Set(tracks.map((track) => track.id));
  const selectedTrackIndexes = new Set<number>();
  for (let i = 0; i < table.tracks.length; i++) {
    const track = table.tracks[i];
    if (track !== undefined && selectedIds.has(track.id)) selectedTrackIndexes.add(i);
  }
  const timelineBaseUs = packetInfoTimelineBaseUs(tracks, selectedTrackIndexes, table.packets);
  const muxer = new WebmStreamingMuxer(
    {
      container: opts.to,
      ...(timelineBaseUs === undefined ? {} : { timelineBaseUs }),
    },
    opts.to === 'mkv' ? 'matroska' : 'webm',
  );
  const muxTrackByIndex = new Map<number, number>();
  for (let i = 0; i < table.tracks.length; i++) {
    const track = table.tracks[i];
    if (track === undefined || !selectedIds.has(track.id)) continue;
    muxTrackByIndex.set(i, muxer.addTrack(track));
  }

  const rowsByTrack = new Map<number, PacketInfoRemuxRow[]>();
  const allRows: PacketInfoRemuxRow[] = [];
  let order = 0;
  for (const packet of table.packets) {
    const muxTrackId = muxTrackByIndex.get(packet.trackIndex);
    if (muxTrackId === undefined) continue;
    if (packet.offset === undefined) return undefined;
    const row: PacketInfoRemuxRow = {
      order,
      muxTrackId,
      packet,
      offset: packet.offset,
      window: undefined,
    };
    order++;
    allRows.push(row);
    const rows = rowsByTrack.get(packet.trackIndex);
    if (rows === undefined) rowsByTrack.set(packet.trackIndex, [row]);
    else rows.push(row);
  }
  if (allRows.length === 0) return undefined;
  assignPacketInfoWindows(allRows);
  const states: PacketInfoRemuxState[] = [];
  for (const rows of rowsByTrack.values()) {
    rows.sort((a, b) => a.packet.dtsUs - b.packet.dtsUs || a.order - b.order);
    states.push({ rows, index: 0 });
  }
  void pumpPacketInfoWebmRemux(src, states, muxer, stage.signal, close);
  return muxer.output;
}

async function pumpPacketInfoWebmRemux(
  src: Source,
  states: readonly PacketInfoRemuxState[],
  muxer: WebmStreamingMuxer,
  signal: AbortSignal | undefined,
  close: (() => Promise<void>) | undefined,
): Promise<void> {
  const reader = new PacketInfoWindowReader(src);
  let failed = false;
  try {
    await muxer.start();
    for (;;) {
      throwIfAborted(signal);
      const state = nextPacketInfoRemuxState(states);
      if (state === undefined) break;
      const row = state.rows[state.index];
      if (row === undefined) break;
      state.index++;
      const dataResult = reader.bytesFor(row, signal);
      const data = dataResult instanceof Uint8Array ? dataResult : await dataResult;
      const pendingFlush = muxer.addChunkStructStarted(row.muxTrackId, {
        timestampUs: row.packet.ptsUs,
        durationUs: row.packet.durationUs,
        key: row.packet.keyframe,
        data,
        dtsUs: row.packet.dtsUs,
      });
      if (pendingFlush !== undefined) await pendingFlush;
    }
    await muxer.finalize();
  } catch (error) {
    failed = true;
    muxer.fail(error);
  } finally {
    await close?.().catch((error: unknown) => {
      if (!failed) muxer.fail(error);
    });
  }
}

export async function remuxViaStreamingWebm(
  container: ContainerDriver,
  src: Source,
  opts: RemuxOptions,
  stage: StageOptions,
): Promise<ReadableStream<Uint8Array>> {
  if (typeof EncodedVideoChunk === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'streaming WebM/MKV remux requires browser EncodedChunk constructors',
      { op: 'remux', tried: [container.id, opts.to] },
    );
  }

  const packetInfoStream = await tryRemuxPacketInfoToStreamingWebm(container, src, opts, stage);
  if (packetInfoStream !== undefined) return packetInfoStream;

  const demuxer = await container.demux(src, stage);
  try {
    const demuxerPacketInfo = (demuxer as DemuxerWithPacketInfoTable).packetInfoTable?.();
    if (demuxerPacketInfo !== undefined) {
      const packetInfoStream = tryCreatePacketInfoStreamingWebm(
        { tracks: demuxer.tracks, packets: demuxerPacketInfo },
        src,
        opts,
        stage,
        container.id,
        () => demuxer.close(),
      );
      if (packetInfoStream !== undefined) return packetInfoStream;
    }

    const tracks = selectTrackInfos(
      demuxer.tracks.filter((track) => track.config !== undefined),
      opts.trackSelect,
    );
    if (tracks.length === 0) {
      throw new CapabilityError('capability-miss', 'remux found no copyable track in the source', {
        op: 'remux',
        tried: [container.id],
      });
    }

    const timelineBaseUs = streamingWebmTimelineBaseUs(tracks, demuxer.packetTable?.());
    const muxer = new WebmStreamingMuxer(
      {
        container: opts.to,
        ...(timelineBaseUs !== undefined ? { timelineBaseUs } : {}),
      },
      opts.to === 'mkv' ? 'matroska' : 'webm',
    );
    const states = tracks.map((track, order): StreamingWebmReaderState => {
      const muxTrackId = muxer.addTrack(track);
      return {
        order,
        muxTrackId,
        reader: demuxer.packets(track.id).getReader(),
        current: undefined,
      };
    });
    void pumpStreamingWebmRemux(demuxer, states, muxer);
    return muxer.output;
  } catch (error) {
    await demuxer.close();
    throw error;
  }
}

async function pumpStreamingWebmRemux(
  demuxer: Demuxer,
  states: readonly StreamingWebmReaderState[],
  muxer: StreamingWebmMuxerSink,
): Promise<void> {
  let failed = false;
  try {
    await Promise.all(states.map(readNextStreamingWebmPacket));
    for (;;) {
      const next = nextStreamingWebmPacketState(states);
      if (next === undefined) break;
      const packet = next.current;
      if (packet === undefined) break;
      await muxer.write(next.muxTrackId, packet);
      await readNextStreamingWebmPacket(next);
    }
    await muxer.finalize();
  } catch (error) {
    failed = true;
    await Promise.all(states.map((state) => state.reader.cancel(error).catch(() => undefined)));
    muxer.fail(error);
  } finally {
    for (const state of states) {
      try {
        state.reader.releaseLock();
      } catch {
        // A pending cancel/read may still own the lock; cleanup is best effort after failure.
      }
    }
    await demuxer.close().catch((error: unknown) => {
      if (!failed) muxer.fail(error);
    });
  }
}
