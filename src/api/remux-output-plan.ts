/**
 * Pre-execution declaration of a remux's output-sink contract (REQUIREMENTS §5.1 "declare before
 * execution whether the selected container route requires seeking, reservation, or finalization" and
 * §5.6 "append-only sinks MUST either receive a valid progressively emitted format or be rejected
 * during planning").
 *
 * A caller that owns the destination — an upload body, a `FileSystemWritableFileStream`, an OPFS file,
 * a benchmark harness measuring peak heap — cannot pick a sink correctly from the request alone: the
 * same `remux(src, { to: 'mp4' })` is an append-only bounded-memory byte stream for one source and a
 * whole-payload rewrite for another, purely because of the route the engine selects. This module makes
 * that selection inspectable *before* any byte is produced, from the same predicates
 * {@link import('./remux-runner.ts').runRemux} executes, so a declaration cannot drift from behaviour.
 *
 * Everything here is pure: the caller-facing engine method resolves the container driver (one sniffing
 * read) and hands the resulting facts in. Node tests therefore cover the whole decision table without a
 * browser codec seam.
 *
 * **Conservatism rule.** Two routes may decline at runtime and continue into a later route (the MP4
 * metadata relocation classifier, the MPEG-TS packet-info writer). Where the outcome is not decidable
 * before execution the declaration reports the *strictest* requirement any reachable route imposes:
 * over-declaring retention or write strictness keeps a caller's sink choice valid, under-declaring
 * would not.
 */

import { STREAMED_WHOLE_PROGRAM_MAX_BYTES } from '../internal/buffer-policy.ts';
import type { Sink } from '../sinks/sink.ts';
import type { Container, RemuxOptions } from './types.ts';

/**
 * The prepared MP4→WebM-family writer deliberately snapshots at most 64 MiB. Every larger source is
 * routed straight to the incremental Cluster-on-write writer instead of leaving 64 MiB–1 GiB on the
 * generic EncodedChunk + buffered-muxer path, where source, mux state, and output coexist.
 */
export const WEBM_STREAMING_MIN_SOURCE_BYTES = 64 * 1024 * 1024;

/**
 * The route family a remux request resolves to. Diagnostic and stable within a package version; it is
 * *not* a routing key callers may pin, and a new route may be added in a minor release.
 */
export type RemuxOutputRoute =
  /** Same-container tag rewrite: the source bytes are replayed/relocated rather than reserialized. */
  | 'metadata-rewrite'
  /** The source driver's `streamCopy`: a lazily pulled, append-only container reserialization. */
  | 'stream-copy'
  /** The Cluster-on-write Matroska/WebM writer, fed by lazily windowed packet-info reads. */
  | 'streaming-webm'
  /** Demux → verbatim `EncodedChunk` → muxer, for targets with no dedicated copy writer. */
  | 'packet-seam';

/** How the selected route addresses output bytes. */
export type RemuxOutputWriteOrder =
  /** Every produced chunk lands at the end of the previous write (file-cursor semantics). */
  | 'append-only'
  /** At least one chunk carries an explicit earlier offset the sink MUST honour. */
  | 'positioned';

/** Peak output-side retention the route imposes for a given sink. */
export type RemuxOutputRetention =
  /** Bounded by active media state (a sample read window plus one produced chunk), not output size. */
  | 'bounded'
  /** The complete payload is retained before the caller can observe the last byte. */
  | 'whole-output';

/**
 * The declared output-sink contract for one remux request. Frozen, structurally comparable, and safe
 * to log: it contains no media bytes and no caller-owned object references.
 */
export interface RemuxOutputPlan {
  readonly schema: 'aibrush-media/remux-output-plan@1';
  /** The container the route will author (`opts.to`). */
  readonly container: Container;
  /** The resolved route family. */
  readonly route: RemuxOutputRoute;
  readonly writeOrder: RemuxOutputWriteOrder;
  /** The sink must be able to write at an arbitrary earlier offset. Implied by `positioned` order. */
  readonly requiresSeek: boolean;
  /** The route reserves a byte region up front and patches it once the payload is written. */
  readonly requiresReservation: boolean;
  /**
   * The byte sequence is a complete program only after the final produced chunk lands. `false` only
   * for fragmented/progressive output, which is a valid program at every segment boundary.
   */
  readonly requiresFinalization: boolean;
  /** The route emits `moof`/Cluster-framed segments rather than one indexed program. */
  readonly fragmented: boolean;
  /** Retention for the sink named in `opts.sink` (the default `toBlob()` sink when omitted). */
  readonly retention: RemuxOutputRetention;
  /** `retention: 'bounded'` is reachable for this route when a streaming/seekable sink is supplied. */
  readonly boundedRetentionAvailable: boolean;
  /** Sink kinds this route accepts. Supplying any other kind is rejected during planning. */
  readonly acceptedSinkKinds: readonly Sink['kind'][];
}

/** Container-driver facts the declaration needs; supplied by the engine after routing the source. */
export interface RemuxOutputRouteFacts {
  /** Formats the resolved source driver both reads and authors. */
  readonly formats: readonly string[];
  /** Whether the resolved source driver exposes a `streamCopy` writer. */
  readonly hasStreamCopy: boolean;
  /** Extra targets that driver's `streamCopy` can author. */
  readonly streamCopyTargets?: readonly string[];
  /** Declared source length in bytes, when known. Size-derived routing only; never identity. */
  readonly sourceSizeBytes?: number;
}

const EVERY_SINK_KIND: readonly Sink['kind'][] = Object.freeze([
  'blob',
  'file',
  'stream',
  'opfs',
  'element',
  'stream-target',
  'opfs-target',
]);

/** Sink kinds that can honour a producer-positioned re-write (mirrors `validateReservedFaststart`). */
const POSITIONED_SINK_KINDS: readonly Sink['kind'][] = Object.freeze([
  'opfs',
  'stream-target',
  'opfs-target',
]);

/** Sink kinds a route can drain incrementally rather than materializing the whole payload first. */
const STREAMING_SINK_KINDS: ReadonlySet<Sink['kind']> = new Set<Sink['kind']>([
  'stream',
  'stream-target',
  'opfs',
  'opfs-target',
]);

/**
 * Large and explicitly fragmented WebM-family outputs belong to the packet-info streaming writer.
 * Keep this check ahead of a source driver's generic `streamCopy`: the WebM driver's legacy copy
 * implementation materializes the complete source before serializing, which defeats a stream sink and
 * can exhaust a browser process on otherwise ordinary large files.
 */
export function requiresStreamingWebmRemux(
  source: { readonly size?: number | undefined },
  opts: Pick<RemuxOptions, 'to' | 'fragmented'>,
): boolean {
  return (
    (opts.to === 'webm' || opts.to === 'mkv') &&
    (opts.fragmented === true ||
      (source.size !== undefined && source.size > WEBM_STREAMING_MIN_SOURCE_BYTES))
  );
}

/**
 * True when the remux hands the finished program to the caller as a materialized `Blob` instead of
 * a pulled `ReadableStream`: a bare `toStream()` consumer of a whole program above
 * {@link STREAMED_WHOLE_PROGRAM_MAX_BYTES} must retain every byte anyway, and the WebM/Matroska
 * family has no fragmented ISO BMFF form that keeps such a program incrementally consumable past
 * that ceiling. Sinks that prove incremental writing (`toStreamTarget()`, OPFS) and containers that
 * can switch to the fragmented layout are untouched; the spill materializer keeps the JS-heap
 * retention flat in output size regardless.
 */
export function publishesWholeProgramBlob(
  source: { readonly size?: number | undefined },
  opts: Pick<RemuxOptions, 'to' | 'sink'>,
): boolean {
  return (
    opts.sink?.kind === 'stream' &&
    (opts.to === 'webm' || opts.to === 'mkv') &&
    source.size !== undefined &&
    source.size > STREAMED_WHOLE_PROGRAM_MAX_BYTES
  );
}

function wantsTrackSelection(opts: RemuxOptions): boolean {
  return opts.trackSelect !== undefined && opts.trackSelect.length > 0;
}

/**
 * The source driver's own container copy writer can author the target. This is the exact predicate the
 * runner branches on, so the declaration and the execution cannot disagree.
 */
export function usesStreamCopyRemux(facts: RemuxOutputRouteFacts, opts: RemuxOptions): boolean {
  return (
    !wantsTrackSelection(opts) &&
    facts.hasStreamCopy &&
    !requiresStreamingWebmRemux({ size: facts.sourceSizeBytes }, opts) &&
    (facts.formats.includes(opts.to) || facts.streamCopyTargets?.includes(opts.to) === true)
  );
}

/**
 * Resolve which route family a remux request takes, mirroring `runRemux`'s branch order.
 *
 * `metadata-rewrite` is the one non-final answer: its relocation classifier may decline a particular
 * box topology at runtime and continue into `stream-copy`/`packet-seam`. Both continuations are
 * append-only and no cheaper in retention, so declaring the rewrite stays conservative.
 */
export function resolveRemuxOutputRoute(
  facts: RemuxOutputRouteFacts,
  opts: RemuxOptions,
): RemuxOutputRoute {
  const shapeUnrequested = opts.faststart === undefined && opts.fragmented === undefined;
  // A single-format driver exposes no EncodedChunk mux seam, so the tag rewrite IS the whole operation.
  const directMetadataTarget =
    opts.tags !== undefined &&
    shapeUnrequested &&
    facts.formats.length === 1 &&
    facts.formats[0] === opts.to;
  // MP4/MOV share one driver, so the single-format shortcut cannot identify a same-family rewrite.
  const directMp4MetadataCandidate =
    opts.tags !== undefined &&
    !wantsTrackSelection(opts) &&
    shapeUnrequested &&
    (opts.to === 'mp4' || opts.to === 'mov') &&
    facts.formats.includes(opts.to);
  if (directMetadataTarget || directMp4MetadataCandidate) return 'metadata-rewrite';
  if (usesStreamCopyRemux(facts, opts)) return 'stream-copy';
  if (requiresStreamingWebmRemux({ size: facts.sourceSizeBytes }, opts)) return 'streaming-webm';
  return 'packet-seam';
}

/**
 * Declare the output-sink contract for a remux request whose source driver has already been routed.
 *
 * The engine method {@link import('./engine.ts').MediaEngine.planRemuxOutput} is the public entry; this
 * function is separated so the whole decision table is Node-testable without opening a source.
 */
export function planRemuxOutput(facts: RemuxOutputRouteFacts, opts: RemuxOptions): RemuxOutputPlan {
  const route = resolveRemuxOutputRoute(facts, opts);
  const reserved = opts.faststart === 'reserve';
  const fragmented = opts.fragmented === true;
  // Only the reserved-index layout tags a chunk with an earlier offset (`positionedChunk`); every other
  // route the engine can select for a remux emits strictly increasing, contiguous byte ranges.
  const writeOrder: RemuxOutputWriteOrder = reserved ? 'positioned' : 'append-only';
  // A post-mux tag rewrite reads the produced program back before it publishes, so no route can stay
  // bounded once `tags` is requested.
  const boundedRetentionAvailable =
    opts.tags === undefined && (route === 'stream-copy' || route === 'streaming-webm');
  const sinkKind = opts.sink?.kind ?? 'blob';
  // The whole-program Blob publication retains every byte before the caller sees the last one, so
  // the declaration must say so even though a stream sink was supplied.
  const wholeProgramBlob = publishesWholeProgramBlob({ size: facts.sourceSizeBytes }, opts);
  return Object.freeze({
    schema: 'aibrush-media/remux-output-plan@1',
    container: opts.to,
    route,
    writeOrder,
    requiresSeek: reserved,
    requiresReservation: reserved,
    // Fragmented output is a complete program at every segment boundary; every other layout needs its
    // trailing index (`moov`, Cues) or its reservation patch before the bytes are readable.
    requiresFinalization: !fragmented,
    fragmented,
    retention:
      boundedRetentionAvailable && STREAMING_SINK_KINDS.has(sinkKind) && !wholeProgramBlob
        ? 'bounded'
        : 'whole-output',
    boundedRetentionAvailable,
    acceptedSinkKinds: reserved ? POSITIONED_SINK_KINDS : EVERY_SINK_KIND,
  });
}
