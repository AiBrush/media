/**
 * The MP4 `Muxer` seam (docs/architecture/05 §2, 09 mux) over the validated byte-muxer ({@link writeMp4}).
 *
 * The contract is the WebCodecs `EncodedChunk` boundary: `addTrack` declares a track, `write` buffers
 * one encoded packet (in decode = arrival order), `finalize` serializes the whole MP4 and emits it on
 * `output`. This adapter is on the *encode* path — it has each track's WebCodecs `DecoderConfig`
 * (codec string + `description` + geometry), not a preserved raw codec box — so it synthesizes the
 * sample entry the way {@link writeMp4} does (`avcC`/`esds` from `description`), or carries the raw
 * config box verbatim for codecs whose box this writer does not synthesize.
 *
 * The packet→sample timing (the only non-trivial logic) is a pure, Node-testable helper
 * ({@link buildMuxSamples}); only the `write()` extraction of a *real* `EncodedChunk` (`copyTo`) is
 * browser-only and guarded. Build logic stays pure so the timing + round-trip are validated without
 * WebCodecs (see mux.test.ts).
 */

import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fragmentMp4 } from './fragment.ts';
import type { MuxSampleInput, MuxTrackInput } from './write.ts';
import { type ContainerBrand, writeMp4 } from './write.ts';

/** The MPEG 90 kHz media clock — the default video timescale (divides 24/25/30/50/60 fps exactly). */
const DEFAULT_VIDEO_TIMESCALE = 90_000;
const MICROS_PER_SECOND = 1_000_000;

/**
 * A decoded view of one `EncodedChunk` in container-neutral terms — the pure input to the timing model.
 * `durationUs` is optional because WebCodecs `Encoded*Chunk.duration` is nullable; a missing duration is
 * recovered from the presentation-timeline gaps (see {@link buildMuxSamples}).
 */
export interface ChunkStruct {
  /** Presentation timestamp (µs), from `chunk.timestamp`. */
  timestampUs: number;
  /** Sample duration (µs), from `chunk.duration`; `undefined` when the encoder omitted it. */
  durationUs: number | undefined;
  /** Sync sample? `chunk.type === 'key'`. */
  key: boolean;
  /** The packet bytes (owned copy). */
  data: Uint8Array;
  /**
   * Decode timestamp (µs), from the demuxer's {@link Packet.dtsUs} on a verbatim remux. When **every**
   * chunk carries it, {@link buildMuxSamples} lays the DTS timeline + composition offsets down from it
   * exactly (lossless B-frame preservation); `undefined` ⇒ recover DTS from arrival order/durations.
   */
  dtsUs?: number;
}

/** How a track's codec config is carried into {@link MuxTrackInput} once the sample entry is known. */
type ConfigKind =
  | { kind: 'avcC-from-description' } // video AVC: writeMp4 synthesizes `avcC` from `description`
  | { kind: 'esds-from-description' } // audio AAC: writeMp4 synthesizes `esds` from `description`
  | { kind: 'raw-box'; boxType: string }; // carry the description verbatim as this codec box

/**
 * Map a WebCodecs codec string to its ISO-BMFF sample-entry fourcc and how its config box is emitted.
 * AVC/AAC use {@link writeMp4}'s synthesis from `description`; other codecs carry the `description` as
 * their raw config box (`hvcC`/`av1C`/`vpcC`/`dOps`/`dfLa`) so the output box is correct rather than a
 * wrong `avcC`. An unknown codec is a typed capability miss, never a silently-malformed file.
 */
function mapCodec(
  mediaType: 'video' | 'audio',
  codec: string,
): { sampleEntryType: string; config: ConfigKind } {
  const c = codec.toLowerCase();
  if (mediaType === 'video') {
    if (c.startsWith('avc1') || c.startsWith('avc3')) {
      return { sampleEntryType: 'avc1', config: { kind: 'avcC-from-description' } };
    }
    if (c.startsWith('hev1') || c.startsWith('hvc1')) {
      return {
        sampleEntryType: c.startsWith('hev1') ? 'hev1' : 'hvc1',
        config: { kind: 'raw-box', boxType: 'hvcC' },
      };
    }
    if (c.startsWith('av01')) {
      return { sampleEntryType: 'av01', config: { kind: 'raw-box', boxType: 'av1C' } };
    }
    if (c.startsWith('vp09') || c.startsWith('vp9')) {
      return { sampleEntryType: 'vp09', config: { kind: 'raw-box', boxType: 'vpcC' } };
    }
  } else {
    if (c.startsWith('mp4a')) {
      return { sampleEntryType: 'mp4a', config: { kind: 'esds-from-description' } };
    }
    if (c.startsWith('opus')) {
      return { sampleEntryType: 'Opus', config: { kind: 'raw-box', boxType: 'dOps' } };
    }
    if (c.startsWith('flac')) {
      return { sampleEntryType: 'fLaC', config: { kind: 'raw-box', boxType: 'dfLa' } };
    }
  }
  throw new CapabilityError(
    'capability-miss',
    `the mp4 muxer cannot write ${mediaType} codec '${codec}'`,
    { op: { op: 'mux', mediaType, codec }, tried: ['mp4'] },
  );
}

/** Video timescale: derive a clean clock from the frame rate when known, else the 90 kHz default. */
function videoTimescale(fps: number | undefined): number {
  if (fps !== undefined && Number.isFinite(fps) && fps > 0) {
    // A round fps (24/25/30/…) → an exact integer clock; durations still come from each chunk.
    return Math.round(fps) * 1000;
  }
  return DEFAULT_VIDEO_TIMESCALE;
}

/** Convert a WebCodecs `description` (an `ArrayBuffer`/`SharedArrayBuffer`/view) to an owned `Uint8Array`. */
function toBytes(src: AllowSharedBufferSource): Uint8Array {
  // A view (TypedArray / DataView) → copy its exact window; a raw buffer → copy the whole thing.
  if (ArrayBuffer.isView(src)) {
    return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
  }
  return new Uint8Array(src).slice();
}

function ticks(us: number, timescale: number): number {
  return Math.round((us * timescale) / MICROS_PER_SECOND);
}

/**
 * Recover a per-sample duration (µs, decode order) when the encoder omitted `duration`: sort by
 * presentation time and take each frame's gap to the next presented frame (the last reuses the prior
 * gap). For a single sample the duration is 0. This keeps the DTS timeline contiguous under VFR.
 */
function recoverDurationsUs(chunks: readonly ChunkStruct[]): number[] {
  const n = chunks.length;
  const order = [...chunks.keys()].sort((a, b) => {
    const ca = chunks[a];
    const cb = chunks[b];
    return (ca?.timestampUs ?? 0) - (cb?.timestampUs ?? 0);
  });
  const byDecode = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    const cur = order[k];
    if (cur === undefined) continue;
    const next = order[k + 1];
    const curTs = chunks[cur]?.timestampUs ?? 0;
    const gap = next !== undefined ? (chunks[next]?.timestampUs ?? curTs) - curTs : undefined;
    byDecode[cur] = gap ?? 0;
  }
  // The last-presented frame has no following gap; reuse the previous presented frame's duration.
  if (n >= 2) {
    const last = order[n - 1];
    const prev = order[n - 2];
    if (last !== undefined && prev !== undefined) byDecode[last] = byDecode[prev] ?? 0;
  }
  return byDecode;
}

/**
 * Convert buffered chunk-structs (decode order) into {@link MuxSampleInput}s with correct B-frame timing.
 *
 * The DTS timeline is the cumulative sum of durations in decode order (DTS is contiguous; spacing is each
 * frame's own duration). The composition offset is computed in microseconds first — `ctts = (PTS−base) −
 * DTS` — so a non-reordered stream (PTS already in decode order, PTS gaps == durations) yields exactly
 * `ctts == 0` for every sample at any timescale, while a reordered (B-frame) stream carries the true
 * offset (negative offsets are fine — {@link writeMp4} emits a version-1 `ctts`). PTS is rebased to the
 * minimum so a standalone file starts at t=0. Decode order is preserved (samples are stored as arrived).
 */
export function buildMuxSamples(
  chunks: readonly ChunkStruct[],
  timescale: number,
): MuxSampleInput[] {
  const n = chunks.length;
  if (n === 0) return [];

  const hasAllDurations = chunks.every((c) => c.durationUs !== undefined);
  const recovered = hasAllDurations ? undefined : recoverDurationsUs(chunks);
  const durationsUs = chunks.map((c, i) => c.durationUs ?? recovered?.[i] ?? 0);

  // Verbatim-remux fast path: every packet carries the source's true decode timestamp (the demuxer read
  // it from `stts`). Lay the composition offset down as the exact (PTS − DTS), and derive each sample's
  // duration from the gap to the next DTS so writeMp4's cumulative-sum `stts` reconstructs the source
  // decode timeline 1:1 — preserving the original B-frame/open-GOP structure losslessly (ADR-045). The
  // chunks arrive in decode order, so DTS is monotonic and every gap is ≥ 0.
  if (chunks.every((c) => c.dtsUs !== undefined)) {
    const out: MuxSampleInput[] = [];
    for (let i = 0; i < n; i++) {
      const c = chunks[i];
      if (c === undefined) continue;
      const dts = c.dtsUs ?? 0;
      const next = chunks[i + 1]?.dtsUs;
      const durUs = next !== undefined ? Math.max(0, next - dts) : (durationsUs[i] ?? 0);
      out.push({
        data: c.data,
        durationTicks: ticks(durUs, timescale),
        cttsTicks: ticks(c.timestampUs - dts, timescale),
        keyframe: c.key,
      });
    }
    return out;
  }

  let baseUs = Number.POSITIVE_INFINITY;
  for (const c of chunks) if (c.timestampUs < baseUs) baseUs = c.timestampUs;

  const out: MuxSampleInput[] = [];
  let dtsUs = 0;
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    if (c === undefined) continue;
    const durUs = durationsUs[i] ?? 0;
    const cttsUs = c.timestampUs - baseUs - dtsUs;
    out.push({
      data: c.data,
      durationTicks: ticks(durUs, timescale),
      cttsTicks: ticks(cttsUs, timescale),
      keyframe: c.key,
    });
    dtsUs += durUs;
  }
  return out;
}

/** Per-track recording state, accumulated across `addTrack`/`write` until `finalize`. */
interface TrackState {
  readonly mediaType: 'video' | 'audio';
  readonly sampleEntryType: string;
  readonly config: ConfigKind;
  readonly timescale: number;
  readonly description: Uint8Array | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly sampleRate: number | undefined;
  readonly channels: number | undefined;
  readonly chunks: ChunkStruct[];
}

/** Resolve geometry/config fields from a track's WebCodecs `DecoderConfig` (narrowed by `mediaType`). */
function trackStateFrom(info: TrackInfo): TrackState {
  const { sampleEntryType, config } = mapCodec(info.mediaType, info.codec);
  const decoderConfig = info.config;
  const description =
    decoderConfig?.description !== undefined ? toBytes(decoderConfig.description) : undefined;

  if (info.mediaType === 'video') {
    const vc = decoderConfig as VideoDecoderConfig | undefined;
    return {
      mediaType: 'video',
      sampleEntryType,
      config,
      timescale: videoTimescale(info.fps),
      description,
      width: vc?.codedWidth,
      height: vc?.codedHeight,
      sampleRate: undefined,
      channels: undefined,
      chunks: [],
    };
  }
  const ac = decoderConfig as AudioDecoderConfig | undefined;
  const sampleRate = ac?.sampleRate;
  return {
    mediaType: 'audio',
    sampleEntryType,
    config,
    // Audio clock = sample rate (sample durations map 1:1 to ticks); 48 kHz is a safe default.
    timescale: sampleRate !== undefined && sampleRate > 0 ? sampleRate : 48_000,
    description,
    width: undefined,
    height: undefined,
    sampleRate,
    channels: ac?.numberOfChannels,
    chunks: [],
  };
}

/** Turn a finalized {@link TrackState} into the {@link MuxTrackInput} {@link writeMp4} consumes. */
function toMuxTrack(t: TrackState): MuxTrackInput {
  const samples = buildMuxSamples(t.chunks, t.timescale);
  const base = {
    mediaType: t.mediaType,
    sampleEntryType: t.sampleEntryType,
    timescale: t.timescale,
    samples,
    ...(t.width !== undefined ? { width: t.width } : {}),
    ...(t.height !== undefined ? { height: t.height } : {}),
    ...(t.sampleRate !== undefined ? { sampleRate: t.sampleRate } : {}),
    ...(t.channels !== undefined ? { channels: t.channels } : {}),
  };
  // Config box: AVC/AAC synthesize from `description`; other codecs carry it as their raw box.
  if (t.description === undefined) return base;
  if (t.config.kind === 'raw-box') {
    return { ...base, codecPrivate: { boxType: t.config.boxType, data: t.description } };
  }
  return { ...base, description: t.description };
}

/**
 * `Muxer` over {@link writeMp4}: buffers each track's packets and serializes the whole MP4 on
 * {@link finalize}, emitting it on {@link output}. Single-shot — `addTrack`/`write` after `finalize`,
 * and a second `finalize`, are typed misuse (`mux-error`). `output` carries the finalized bytes (one
 * chunk) and is `error()`d if finalization fails, so failures surface on the reader (doc 05 §3).
 */
export class Mp4Muxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  readonly #tracks = new Map<number, TrackState>();
  readonly #faststart: boolean;
  readonly #fragmented: boolean;
  readonly #brand: ContainerBrand;
  #nextId = 1;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions) {
    // Fragmented/CMAF output (ADR-034): finalize emits an init segment + one media segment per fragment
    // via {@link fragmentMp4}, instead of the single faststart `moov`+`mdat` from {@link writeMp4}.
    this.#fragmented = options?.fragmented === true;
    this.#faststart = options?.faststart ?? true;
    this.#brand = options?.container === 'mov' || options?.container === 'qt' ? 'mov' : 'mp4';
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
  }

  addTrack(info: TrackInfo): number {
    this.#assertOpen();
    const id = this.#nextId++;
    this.#tracks.set(id, trackStateFrom(info));
    return id;
  }

  /**
   * Buffer one encoded packet on its track (decode = arrival order). Extracting the bytes/timing from a
   * real `EncodedVideoChunk`/`EncodedAudioChunk` (`copyTo`) is the only browser-only step (guarded); the
   * resulting struct flows through the pure {@link addChunkStruct}, which the tests drive directly.
   */
  write(trackId: number, packet: Packet): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
    const chunk = packet.chunk;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.addChunkStruct(trackId, {
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? undefined,
      key: chunk.type === 'key',
      data,
      ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
    });
    return Promise.resolve();
    /* v8 ignore stop */
  }

  /**
   * Pure packet ingest: append an already-extracted {@link ChunkStruct} to its track's buffer. Shared by
   * {@link write} (after the browser-only `copyTo`) and the Node tests (which feed plain structs), so the
   * timing + serialization are fully validated without WebCodecs.
   */
  addChunkStruct(trackId: number, chunk: ChunkStruct): void {
    this.#assertOpen();
    const track = this.#tracks.get(trackId);
    if (track === undefined) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    track.chunks.push(chunk);
  }

  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#finalized = true;
    await this.#ready; // the readable's `start` has run → the controller is captured
    const controller = this.#controller;
    if (controller === undefined) {
      // Unreachable: `start` resolves `#ready` and captures the controller before this awaits.
      throw new MediaError('mux-error', 'muxer output stream was not initialized');
    }
    try {
      const tracks = this.#buildTracks();
      if (this.#fragmented) {
        // Stream the init segment then one media segment per fragment (bounded memory, ADR-034).
        for (const segment of fragmentMp4(tracks)) controller.enqueue(segment);
      } else {
        controller.enqueue(writeMp4(tracks, { faststart: this.#faststart, brand: this.#brand }));
      }
      controller.close();
    } catch (err) {
      controller.error(err);
      throw err;
    }
  }

  /** Validate the buffered tracks and project them to {@link writeMp4} inputs (insertion order). */
  #buildTracks(): MuxTrackInput[] {
    if (this.#tracks.size === 0) {
      throw new MediaError('mux-error', 'cannot finalize a muxer with no tracks');
    }
    const out: MuxTrackInput[] = [];
    for (const [id, track] of this.#tracks) {
      if (track.chunks.length === 0) {
        throw new MediaError('mux-error', `track ${id} received no packets`);
      }
      out.push(toMuxTrack(track));
    }
    return out;
  }

  #assertOpen(): void {
    if (this.#finalized) {
      throw new MediaError('mux-error', 'muxer already finalized');
    }
  }
}
