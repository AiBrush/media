/**
 * The engine (docs/architecture/07) — the developer-facing instance behind `createMedia`. It wires the
 * kernel (Registry → Router → Normalizer → Executor → Worker-bridge) and exposes intent-only ops; the
 * substrate is never named (ADR-003).
 *
 * Phase 0 implements `probe`/`demux` end-to-end (container-routed) plus `from`/`source`/`use`/`preload`.
 * The codec/filter/crypto-dependent ops are declared and, per Prime Directive 6, raise a typed
 * {@link CapabilityError} until their Phase-1 pipelines (WebCodecs/GPU/WASM drivers) land — never a
 * silent or fake result.
 */

import type {
  ContainerDriver,
  ContainerQuery,
  Determinism,
  DriverModule,
  PcmTransform,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { Registry, isApiVersionSupported } from '../kernel/registry.ts';
import { Router } from '../kernel/router.ts';
import { materialize, toBlob } from '../sinks/sink.ts';
import {
  type FromOptions,
  type MediaInput,
  type Source,
  from as normalizeInput,
} from '../sources/source.ts';

const CONTAINER_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  adts: 'audio/aac',
};
import type {
  CallOptions,
  Cancellable,
  ConvertOptions,
  CreateMediaOptions,
  DecryptOptions,
  Demuxed,
  EncodeOptions,
  MediaInfo,
  MediaInfoTrack,
  MediaStreams,
  MuxSpec,
  Output,
  PacketStreams,
  PreloadSpec,
  RemuxOptions,
  TrimOptions,
} from './types.ts';

/** The developer-facing engine surface (ADR-009). */
export interface MediaEngine {
  probe(input: MediaInput, o?: CallOptions): Cancellable<MediaInfo>;
  demux(input: MediaInput, o?: CallOptions): Cancellable<Demuxed>;
  convert(input: MediaInput, opts: ConvertOptions, o?: CallOptions): Cancellable<Output>;
  remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Cancellable<Output>;
  trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Cancellable<Output>;
  decode(input: MediaInput, o?: CallOptions): MediaStreams;
  encode(frames: MediaStreams, opts: EncodeOptions, o?: CallOptions): Cancellable<Output>;
  mux(streams: PacketStreams, opts: MuxSpec, o?: CallOptions): Cancellable<Output>;
  decrypt(input: MediaInput, opts: DecryptOptions, o?: CallOptions): Cancellable<Output>;
  preload(...specs: PreloadSpec[]): Promise<void>;
  /** The universal normalizer, exported for optioned sources (ADR-013). */
  from(input: MediaInput, opts?: FromOptions): Source;
  source(input: MediaInput): Source;
  /** Inject a custom/third-party driver module (ADR-009 hook). Chainable. */
  use(module: DriverModule): MediaEngine;
}

const HEAD_BYTES = 64 * 1024;

export class MediaEngineImpl implements MediaEngine {
  readonly #opts: CreateMediaOptions;
  readonly #registry = new Registry();
  readonly #router = new Router({ registry: this.#registry });
  #defaultsLoaded = false;

  constructor(opts: CreateMediaOptions = {}) {
    this.#opts = opts;
  }

  use(module: DriverModule): MediaEngine {
    if (!isApiVersionSupported(module.apiVersion)) {
      throw new MediaError(
        'driver-incompatible',
        `driver module targets apiVersion ${module.apiVersion}`,
        {
          got: module.apiVersion,
        },
      );
    }
    module.register(this.#registry);
    this.#router.clearCache();
    return this;
  }

  from(input: MediaInput, opts?: FromOptions): Source {
    return normalizeInput(input, opts);
  }

  source(input: MediaInput): Source {
    return normalizeInput(input);
  }

  probe(input: MediaInput, o: CallOptions = {}): Cancellable<MediaInfo> {
    return this.#withCancel(o, async (signal) => {
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      const demuxer = await container.demux(src, this.#stageOptions(signal, o));
      try {
        return toMediaInfo(container, demuxer.tracks, src);
      } finally {
        await demuxer.close();
      }
    });
  }

  demux(input: MediaInput, o: CallOptions = {}): Cancellable<Demuxed> {
    return this.#withCancel(o, async (signal) => {
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      return container.demux(src, this.#stageOptions(signal, o));
    });
  }

  convert(input: MediaInput, opts: ConvertOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      // PCM-native audio path (ADR-022): a raw-PCM target (WAV) whose source container transforms PCM
      // directly — channel up/down-mix etc. in the TS audio-dsp path, no codec seam. Lossy re-encode,
      // video, or cross-codec conversions fall through to the browser codec layer.
      const audio = opts.audio;
      if (opts.to === 'wav' && audio !== false && isPcmCodec(audio?.codec)) {
        const src = normalizeInput(input);
        const container = await this.#routeContainer(src, 'demux');
        const pcmOpts: PcmTransform = {
          ...this.#stageOptions(signal, o),
          ...(audio?.channels !== undefined ? { channels: audio.channels } : {}),
          ...(audio?.sampleRate !== undefined ? { sampleRate: audio.sampleRate } : {}),
        };
        // Same-PCM-container transform (WAV→WAV, ADR-022) or a pure-TS decode (FLAC→WAV, ADR-024).
        const stream =
          container.transformPcm && container.formats.includes('wav')
            ? await container.transformPcm(src, pcmOpts)
            : container.decodePcm
              ? await container.decodePcm(src, pcmOpts)
              : undefined;
        if (stream) return materialize(opts.sink ?? toBlob(), stream, mimeOpts(signal, 'wav'));
      }
      return this.#codecUnavailable('convert', input, opts);
    });
  }

  remux(input: MediaInput, opts: RemuxOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      const stream = await this.#streamCopyOrThrow(container, src, opts.to, 'remux', {
        ...this.#stageOptions(signal, o),
        ...(opts.faststart !== undefined ? { faststart: opts.faststart } : {}),
        ...(opts.fragmented !== undefined ? { fragmented: opts.fragmented } : {}),
      });
      return materialize(opts.sink ?? toBlob(), stream, mimeOpts(signal, opts.to));
    });
  }

  trim(input: MediaInput, opts: TrimOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      if (opts.mode === 'accurate') {
        throw new CapabilityError(
          'capability-miss',
          'frame-accurate trim requires the decode/encode seam (browser codec layer)',
          { op: 'trim', tried: [] },
        );
      }
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      // Validate the requested range against the media's real duration BEFORE any cut, so a malformed
      // range (negative / inverted / zero-length / past-EOF) rejects with a typed `InputError` instead
      // of flowing to the driver and fabricating output (ADR-021, robustness §7). Duration is read the
      // same way `probe` does — demux once, take the longest track — then the demuxer is released.
      const durationSec = await this.#probeDurationSec(container, src, signal, o);
      assertTrimRange(opts.start, opts.end, durationSec);
      const target = container.formats[0] ?? 'mp4';
      const stream = await this.#streamCopyOrThrow(container, src, target, 'trim', {
        ...this.#stageOptions(signal, o),
        trim: { startSec: opts.start, endSec: opts.end },
        faststart: true,
      });
      return materialize(opts.sink ?? toBlob(), stream, mimeOpts(signal, target));
    });
  }

  decode(input: MediaInput, _o: CallOptions = {}): MediaStreams {
    normalizeInput(input); // validate the input shape before reporting the capability gap
    throw new CapabilityError(
      'capability-miss',
      'decode requires codec drivers that are not registered',
      {
        op: 'decode',
        tried: [],
      },
    );
  }

  encode(frames: MediaStreams, opts: EncodeOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, () => this.#codecUnavailable('encode', frames, opts));
  }

  mux(streams: PacketStreams, opts: MuxSpec, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, () => this.#codecUnavailable('mux', streams, opts));
  }

  decrypt(input: MediaInput, opts: DecryptOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      if (!container.decrypt) {
        throw new CapabilityError(
          'capability-miss',
          `decrypt is not supported for the ${container.formats[0]} container`,
          { op: 'decrypt', tried: [container.id] },
        );
      }
      const stream = await container.decrypt(src, {
        ...this.#stageOptions(signal, o),
        scheme: opts.scheme,
        keys: opts.keys,
      });
      return materialize(
        opts.sink ?? toBlob(),
        stream,
        mimeOpts(signal, container.formats[0] ?? 'mp4'),
      );
    });
  }

  async preload(...specs: PreloadSpec[]): Promise<void> {
    // Idempotent, never throws (ADR / doc 07 §5). Phase 0 has no heavy chunks/wasm to warm yet;
    // Phase 1 prefetches op/driver chunks, compiles predicted wasm, and warms capability probes.
    void specs.length;
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────────

  #determinism(o: CallOptions): Determinism {
    return o.strategy?.determinism ?? this.#opts.determinism ?? 'auto';
  }

  #stageOptions(signal: AbortSignal, o: CallOptions): StageOptions {
    return {
      signal,
      determinism: this.#determinism(o),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    };
  }

  async #routeContainer(src: Source, direction: 'demux' | 'mux'): Promise<ContainerDriver> {
    const head = await readHead(src);
    const ext = extensionOf(src.filename);
    const q: ContainerQuery = {
      direction,
      head,
      ...(src.mimeHint !== undefined ? { mime: src.mimeHint } : {}),
      ...(ext !== undefined ? { extension: ext } : {}),
    };
    try {
      return this.#router.pickContainer(q);
    } catch (e) {
      // On a miss, lazily load the first-party drivers and retry once (zero-config, ADR-004). An
      // explicitly `use()`d driver that matches never misses, so it always wins over the defaults.
      if (!(e instanceof CapabilityError) || this.#defaultsLoaded) throw e;
      await this.#ensureDefaultDrivers();
      return this.#router.pickContainer(q);
    }
  }

  /** Lazily import + register the first-party driver bundle (a code-split chunk). One-time. */
  async #ensureDefaultDrivers(): Promise<void> {
    if (this.#defaultsLoaded) return;
    this.#defaultsLoaded = true;
    const { registerDefaultDrivers } = await import('../drivers/defaults.ts');
    registerDefaultDrivers(this.#registry);
    this.#router.clearCache();
  }

  /** The media's duration (longest track), read via a one-shot demux — mirrors {@link probe}. */
  async #probeDurationSec(
    container: ContainerDriver,
    src: Source,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<number> {
    const demuxer = await container.demux(src, this.#stageOptions(signal, o));
    try {
      return demuxer.tracks.reduce((max, t) => Math.max(max, t.durationSec ?? 0), 0);
    } finally {
      await demuxer.close();
    }
  }

  /** Use the container's native stream-copy for same-container remux/trim; else a typed miss (ADR-021). */
  async #streamCopyOrThrow(
    container: ContainerDriver,
    src: Source,
    target: string,
    op: string,
    opts: StreamCopyOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!container.streamCopy || !container.formats.includes(target)) {
      throw new CapabilityError(
        'capability-miss',
        `${op} to '${target}' from a ${container.formats[0]} source needs the codec seam (browser); same-container stream-copy only here`,
        {
          op,
          tried: [container.id],
          suggestion: 'use a same-container target, or run the browser codec layer',
        },
      );
    }
    return container.streamCopy(src, opts);
  }

  #codecUnavailable(op: string, input: unknown, opts: unknown): Promise<never> {
    if (typeof input !== 'object' && typeof input !== 'string') {
      return Promise.reject(new InputError('unsupported-input', `invalid input for ${op}`));
    }
    void opts;
    return Promise.reject(
      new CapabilityError(
        'capability-miss',
        `${op} requires codec/filter/crypto drivers that are not registered in this build`,
        { op, tried: [] },
      ),
    );
  }

  #withCancel<T>(o: CallOptions, exec: (signal: AbortSignal) => Promise<T>): Cancellable<T> {
    const ctrl = new AbortController();
    const caller = o.signal;
    if (caller) {
      if (caller.aborted) ctrl.abort(caller.reason);
      else caller.addEventListener('abort', () => ctrl.abort(caller.reason), { once: true });
    }
    const p = exec(ctrl.signal) as Cancellable<T>;
    p.cancel = (): void => ctrl.abort(new MediaError('aborted', 'operation cancelled'));
    return p;
  }
}

// ── Module helpers ──────────────────────────────────────────────────────────────────────────────

async function readHead(src: Source, n: number = HEAD_BYTES): Promise<Uint8Array> {
  if (src.range) return src.range(0, n);
  if (src.kind === 'stream') {
    throw new InputError(
      'unsupported-input',
      'probe/demux needs a seekable source (bytes, Blob, or URL), not a one-shot stream',
    );
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const head = new Uint8Array(Math.min(total, n));
  let off = 0;
  for (const c of chunks) {
    if (off >= head.length) break;
    head.set(c.subarray(0, head.length - off), off);
    off += c.byteLength;
  }
  return head;
}

/** PCM-family audio target — the only codec the WAV/transformPcm path produces (ADR-022). */
function isPcmCodec(codec: string | undefined): boolean {
  return codec === undefined || codec === 'pcm';
}

/**
 * Slack (seconds) allowed past the probed duration on a trim's `end`, so a legitimate "to EOF" request
 * that rounds up to a whole second past a sub-second-short probed duration still validates. It is far
 * below any genuinely-out-of-range request (e.g. seconds-to-hours past EOF) yet above probe rounding
 * and integer-second clamp slack — the same ~1-GOP order the keyframe-trim oracle tolerates.
 */
const TRIM_END_SLACK_SEC = 1;

/**
 * Reject a malformed trim range with a typed {@link InputError} before any cut is attempted. Valid
 * ranges satisfy `0 ≤ start < end` and, when the media's duration is known (`durationSec > 0`),
 * `start < durationSec` and `end ≤ durationSec + {@link TRIM_END_SLACK_SEC}`. Wording is deliberately
 * plain (no "capability"/"codec"/"browser" vocabulary) so callers and adapters read it as bad input,
 * not a capability gap. Exported for direct unit coverage of every guard branch (incl. the
 * unknown-duration path that real, always-timed corpus media cannot reach through the public op).
 */
export function assertTrimRange(startSec: number, endSec: number, durationSec: number): void {
  const range = `[${startSec}s, ${endSec}s]`;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new InputError('unsupported-input', `trim range ${range} is not a finite interval`);
  }
  if (startSec < 0) {
    throw new InputError('unsupported-input', `trim start ${startSec}s is negative`);
  }
  if (endSec <= startSec) {
    throw new InputError(
      'unsupported-input',
      `trim range ${range} is empty or inverted (end must be greater than start)`,
    );
  }
  // Duration-relative bounds only when a real duration was probed; a 0/unknown duration cannot bound
  // the range without spuriously failing an otherwise well-formed request.
  if (durationSec > 0) {
    if (startSec >= durationSec) {
      throw new InputError(
        'unsupported-input',
        `trim start ${startSec}s is at or past the media duration of ${durationSec}s`,
      );
    }
    if (endSec > durationSec + TRIM_END_SLACK_SEC) {
      throw new InputError(
        'unsupported-input',
        `trim end ${endSec}s is past the media duration of ${durationSec}s`,
      );
    }
  }
}

function extensionOf(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  const dot = filename.lastIndexOf('.');
  return dot >= 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : undefined;
}

/** Materialize options carrying the container's MIME type when known. */
function mimeOpts(signal: AbortSignal, container: string): { signal: AbortSignal; mime?: string } {
  const mime = CONTAINER_MIME[container];
  return mime ? { signal, mime } : { signal };
}

function toMediaInfo(
  container: ContainerDriver,
  tracks: readonly TrackInfo[],
  src: Source,
): MediaInfo {
  const infoTracks = tracks.map(toInfoTrack);
  const durationSec = infoTracks.reduce((max, t) => Math.max(max, t.durationSec ?? 0), 0);
  return {
    container: container.formats[0] ?? 'unknown',
    durationSec,
    ...(src.size !== undefined ? { sizeBytes: src.size } : {}),
    tracks: infoTracks,
  };
}

function toInfoTrack(t: TrackInfo): MediaInfoTrack {
  const base: MediaInfoTrack = { id: t.id, type: t.mediaType, codec: t.codec };
  if (t.durationSec !== undefined) base.durationSec = t.durationSec;
  if (t.fps !== undefined) base.fps = t.fps;
  if (t.rotation !== undefined) base.rotation = t.rotation;
  const config = t.config;
  if (config && 'codedWidth' in config) {
    if (config.codedWidth !== undefined) base.width = config.codedWidth;
    if (config.codedHeight !== undefined) base.height = config.codedHeight;
  }
  if (config && 'sampleRate' in config) {
    base.sampleRate = config.sampleRate;
    base.channels = config.numberOfChannels;
  }
  return base;
}
