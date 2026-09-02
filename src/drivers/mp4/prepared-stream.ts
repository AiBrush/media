import type { MuxOptions, TrackInfo } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import {
  type ChunkStruct,
  type Mp4PacketTrackInput,
  toMuxTrack,
  trackPresentationDelayUs,
  trackStateFrom,
} from './mux.ts';
import type { MuxTrackInput } from './write.ts';
import { type ContainerBrand, planMp4ByteStreamLayout, writeMp4 } from './write.ts';

interface PayloadCursor {
  trackIndex: number;
  sampleIndex: number;
}

export function writeMp4PacketTrack(
  info: TrackInfo,
  chunks: readonly ChunkStruct[],
  options?: MuxOptions,
): Uint8Array {
  return writeMp4PacketTracks([{ track: info, chunks }], options);
}

export function writeMp4PacketTracks(
  inputs: readonly Mp4PacketTrackInput[],
  options?: MuxOptions,
): Uint8Array {
  return writeMp4(mp4PacketMuxTracks(inputs), writeOptionsFromMuxOptions(options));
}

export function streamMp4PacketTracks(
  inputs: readonly Mp4PacketTrackInput[],
  options?: MuxOptions,
): ReadableStream<Uint8Array> {
  const tracks = mp4PacketMuxTracks(inputs);
  const layout = planMp4ByteStreamLayout(tracks, writeOptionsFromMuxOptions(options));
  const leading = layout.mdatBeforeMoov
    ? [layout.ftyp, layout.mdatHeader]
    : [layout.ftyp, layout.moov, layout.mdatHeader];
  const cursor: PayloadCursor = { trackIndex: 0, sampleIndex: 0 };
  let leadingIndex = 0;
  let emittedTrailingMoov = !layout.mdatBeforeMoov;

  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      const leadingChunk = leading[leadingIndex];
      if (leadingChunk !== undefined) {
        leadingIndex++;
        controller.enqueue(leadingChunk);
        return;
      }

      const payload = nextPayloadChunk(tracks, cursor);
      if (payload !== undefined) {
        controller.enqueue(payload);
        return;
      }

      if (!emittedTrailingMoov) {
        emittedTrailingMoov = true;
        controller.enqueue(layout.moov);
        return;
      }

      controller.close();
    },
  });
}

function writeOptionsFromMuxOptions(options?: MuxOptions): {
  readonly faststart?: boolean;
  readonly brand: ContainerBrand;
} {
  if (options?.faststart === 'reserve') {
    throw new MediaError(
      'mux-error',
      "prepared MP4 byte streams do not implement faststart:'reserve'; use Mp4Muxer",
    );
  }
  const brand: ContainerBrand =
    options?.container === 'mov' || options?.container === 'qt' ? 'mov' : 'mp4';
  return {
    faststart: options?.faststart ?? true,
    brand,
  };
}

export function mp4PacketMuxTracks(inputs: readonly Mp4PacketTrackInput[]): MuxTrackInput[] {
  if (inputs.length === 0) {
    throw new MediaError('mux-error', 'MP4 mux received no tracks');
  }
  const states: Array<ReturnType<typeof trackStateFrom>> = [];
  for (const [index, input] of inputs.entries()) {
    const state = trackStateFrom(input.track);
    for (const chunk of input.chunks) state.chunks.push(chunk);
    if (state.chunks.length === 0) {
      throw new MediaError('mux-error', `MP4 mux track ${index + 1} received no packets`);
    }
    states.push(state);
  }
  // Match Mp4Muxer's presentation-origin projection exactly. Complete source-timed arrays can have one
  // track start after another (typically encoder-delay AAC beside video); the later track needs a leading
  // empty edit or the prepared route would author a different timeline than the ordinary packet seam.
  const sourceTimed = states.every((state) =>
    state.chunks.every((chunk) => chunk.dtsUs !== undefined),
  );
  let globalPresentationOriginUs = Number.POSITIVE_INFINITY;
  if (sourceTimed) {
    for (const state of states) {
      const presentationDelayUs = trackPresentationDelayUs(state);
      for (const chunk of state.chunks) {
        globalPresentationOriginUs = Math.min(
          globalPresentationOriginUs,
          chunk.timestampUs + presentationDelayUs,
        );
      }
    }
  }
  return states.map((state) => {
    const firstDtsUs = state.chunks[0]?.dtsUs;
    const leadingEmptyUs =
      sourceTimed && firstDtsUs !== undefined && Number.isFinite(globalPresentationOriginUs)
        ? Math.max(0, firstDtsUs - globalPresentationOriginUs)
        : 0;
    return toMuxTrack(state, leadingEmptyUs);
  });
}

const STREAM_PAYLOAD_CHUNK_TARGET_BYTES = 256 * 1024;

function nextPayloadChunk(
  tracks: readonly MuxTrackInput[],
  cursor: PayloadCursor,
): Uint8Array | undefined {
  const parts: Uint8Array[] = [];
  let total = 0;

  while (cursor.trackIndex < tracks.length) {
    const track = tracks[cursor.trackIndex];
    if (track === undefined) break;
    const sample = track.samples[cursor.sampleIndex];
    if (sample === undefined) {
      cursor.trackIndex++;
      cursor.sampleIndex = 0;
      continue;
    }

    cursor.sampleIndex++;
    const data = sample.data;
    if (data.byteLength === 0) continue;
    if (total === 0 && data.byteLength >= STREAM_PAYLOAD_CHUNK_TARGET_BYTES) {
      return data;
    }
    if (total > 0 && total + data.byteLength > STREAM_PAYLOAD_CHUNK_TARGET_BYTES) {
      cursor.sampleIndex--;
      break;
    }
    parts.push(data);
    total += data.byteLength;
  }

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0] as Uint8Array;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
