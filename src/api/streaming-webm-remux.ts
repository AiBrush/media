import type {
  ContainerDriver,
  Demuxer,
  Packet,
  PacketMetadata,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { WebmStreamingMuxer } from '../drivers/webm/ebml-write.ts';
import type { Source } from '../sources/source.ts';
import { selectTrackInfos } from './codec-routing.ts';
import type { RemuxOptions } from './types.ts';

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

  const demuxer = await container.demux(src, stage);
  try {
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
