/**
 * Seekable MPEG-TS metadata probing.
 *
 * A transport stream has no global index. For a known-size random-access source, parse independent
 * packet-aligned head and tail windows: the head supplies PAT/PMT, first codec configuration, and local
 * cadence; the tail starts with fresh PES/codec state and supplies independently timed terminal units.
 * Only metadata is merged—parser state and payload bytes never cross the omitted range. Windows grow
 * geometrically and any incomplete, discontinuous, sampled-config conflict, or cadence-inconsistent
 * sample falls back to the exact full parser.
 *
 * Endpoint duration/fps are estimates for the sampled CFR epoch: no sparse algorithm can prove that an
 * omitted legal TS region contains no reset or VFR phase. This path is deliberately source-, PID-, and
 * fixture-agnostic; callers needing packet-exact middle-of-stream evidence still use demux/full parse.
 */

import type { ByteSource } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { raceAbort, throwIfSourceAborted } from '../../sources/abort.ts';
import { readAllBytes } from '../../sources/read-all.ts';
import {
  TS_CLOCK_HZ,
  type TsParse,
  type TsStream,
  type TsTrack,
  detectFraming,
  parseTs,
} from './ts-parse.ts';

const MIN_INITIAL_WINDOW_BYTES = 32 * 1024;
const MAX_INITIAL_WINDOW_BYTES = 128 * 1024;
const MAX_SPARSE_WINDOW_BYTES = 1024 * 1024;
const MIN_VIDEO_UNITS = 8;
const MIN_ADTS_UNITS = 6;
const MIN_OTHER_UNITS = 4;
const MIN_TAIL_UNITS = 2;
const CADENCE_TOLERANCE_TICKS = 1;

type EvidenceState = 'accept' | 'grow' | 'fatal';

function fullParse(src: ByteSource, signal: AbortSignal | undefined): Promise<TsParse> {
  return raceAbort(readAllBytes(src, signal), signal).then(parseTs);
}

function trackUnitFloor(track: TsTrack): number {
  if (track.stream.streamType === 0x0f) return MIN_ADTS_UNITS;
  return track.stream.mediaType === 'video' ? MIN_VIDEO_UNITS : MIN_OTHER_UNITS;
}

function hasPromisedConfig(track: TsTrack): boolean {
  if (track.stream.codec === 'h264') {
    const config = track.config as VideoDecoderConfig;
    return (config.codedWidth ?? 0) > 0 && (config.codedHeight ?? 0) > 0;
  }
  if (track.stream.streamType === 0x0f) {
    const config = track.config as AudioDecoderConfig;
    return (config.sampleRate ?? 0) > 0 && (config.numberOfChannels ?? 0) > 0;
  }
  return true;
}

function hasMonotonicDecodeTimeline(track: TsTrack): boolean {
  for (let index = 1; index < track.units.length; index += 1) {
    const previous = track.units[index - 1];
    const current = track.units[index];
    if (previous !== undefined && current !== undefined && current.dtsUs < previous.dtsUs) {
      return false;
    }
  }
  return true;
}

function hasStableLocalCadence(track: TsTrack): boolean {
  const timing = track.timing;
  return (
    timing !== undefined &&
    Number.isFinite(timing.firstPtsTicks) &&
    Number.isFinite(timing.lastPtsTicks) &&
    timing.lastPtsTicks > timing.firstPtsTicks &&
    Number.isFinite(timing.medianGapTicks) &&
    timing.medianGapTicks > 0 &&
    timing.gapCount > 0 &&
    timing.dominantGapCount / timing.gapCount >= 0.8
  );
}

function sameStream(left: TsStream, right: TsStream): boolean {
  return (
    left.pid === right.pid &&
    left.streamType === right.streamType &&
    left.mediaType === right.mediaType &&
    left.codec === right.codec
  );
}

function sameStreamSet(left: readonly TsStream[], right: readonly TsStream[]): boolean {
  return (
    left.length === right.length &&
    left.every((stream) => right.some((candidate) => sameStream(stream, candidate)))
  );
}

/**
 * A seeded endpoint keeps its seed map solely for payload routing, but records every PMT it samples.
 * Any declaration set that differs from that routed baseline makes sparse metadata unsafe, including
 * A→B→A changes whose final PMT happens to match the head again.
 */
function hasSampledPmtConflict(parsed: TsParse): boolean {
  const routedStreams = parsed.tracks.map((track) => track.stream);
  return parsed.observedPmtStreamSets.some(
    (sampledStreams) => !sameStreamSet(routedStreams, sampledStreams),
  );
}

function classifyHeadEvidence(parsed: TsParse | undefined): EvidenceState {
  if (parsed === undefined || parsed.tracks.length === 0) return 'grow';
  if (parsed.observedDiscontinuity || hasSampledPmtConflict(parsed)) return 'fatal';
  for (const track of parsed.tracks) {
    if (!hasMonotonicDecodeTimeline(track)) return 'fatal';
    if (
      !hasPromisedConfig(track) ||
      track.units.length < trackUnitFloor(track) ||
      track.timing === undefined
    ) {
      return 'grow';
    }
    if (!hasStableLocalCadence(track)) return 'fatal';
  }
  return 'accept';
}

function configsConflict(head: TsTrack, tail: TsTrack): boolean {
  if (head.stream.codec === 'h264') {
    const first = head.config as VideoDecoderConfig;
    const later = tail.config as VideoDecoderConfig;
    const laterHasConfig = (later.codedWidth ?? 0) > 0 && (later.codedHeight ?? 0) > 0;
    return (
      laterHasConfig &&
      (later.codedWidth !== first.codedWidth || later.codedHeight !== first.codedHeight)
    );
  }
  if (head.stream.streamType === 0x0f) {
    const first = head.config as AudioDecoderConfig;
    const later = tail.config as AudioDecoderConfig;
    const laterHasConfig = (later.sampleRate ?? 0) > 0 && (later.numberOfChannels ?? 0) > 0;
    return (
      laterHasConfig &&
      (later.sampleRate !== first.sampleRate || later.numberOfChannels !== first.numberOfChannels)
    );
  }
  return false;
}

function windowsHaveCompatibleCadence(head: TsTrack, tail: TsTrack): boolean {
  const first = head.timing;
  const later = tail.timing;
  return (
    first !== undefined &&
    later !== undefined &&
    hasStableLocalCadence(head) &&
    hasStableLocalCadence(tail) &&
    Math.abs(first.medianGapTicks - later.medianGapTicks) <= CADENCE_TOLERANCE_TICKS
  );
}

function mergeSparseMetadata(
  head: TsParse,
  tail: TsParse,
): { readonly state: EvidenceState; readonly parsed?: TsParse } {
  if (
    head.observedDiscontinuity ||
    tail.observedDiscontinuity ||
    hasSampledPmtConflict(head) ||
    hasSampledPmtConflict(tail) ||
    head.tracks.length === 0 ||
    tail.tracks.length !== head.tracks.length
  ) {
    return { state: 'fatal' };
  }

  const pairs: { head: TsTrack; tail: TsTrack }[] = [];
  for (const headTrack of head.tracks) {
    const tailTrack = tail.tracks.find(
      (candidate) => candidate.stream.pid === headTrack.stream.pid,
    );
    if (tailTrack === undefined || !sameStream(headTrack.stream, tailTrack.stream)) {
      return { state: 'fatal' };
    }
    if (!hasMonotonicDecodeTimeline(tailTrack) || configsConflict(headTrack, tailTrack)) {
      return { state: 'fatal' };
    }
    if (tailTrack.units.length < MIN_TAIL_UNITS || tailTrack.timing === undefined) {
      return { state: 'grow' };
    }
    if (!hasStableLocalCadence(tailTrack) || !windowsHaveCompatibleCadence(headTrack, tailTrack)) {
      return { state: 'fatal' };
    }
    const headLast = headTrack.units.at(-1);
    const tailFirst = tailTrack.units[0];
    if (headLast === undefined || tailFirst === undefined || tailFirst.dtsUs <= headLast.dtsUs) {
      // A backward/equal DTS epoch can be a reset, repeated segment, or 33-bit wrap. The exact parser
      // remains the safe authority until a wrap-aware whole-timeline probe is available.
      return { state: 'fatal' };
    }
    pairs.push({ head: headTrack, tail: tailTrack });
  }

  const headTimings = pairs.map((pair) => pair.head.timing);
  const tailTimings = pairs.map((pair) => pair.tail.timing);
  if (
    headTimings.some((timing) => timing === undefined) ||
    tailTimings.some((timing) => timing === undefined)
  ) {
    return { state: 'grow' };
  }
  const firstPtsTicks = Math.min(
    ...headTimings.map((timing) => timing?.firstPtsTicks ?? Number.POSITIVE_INFINITY),
  );
  const lastPtsTicks = Math.max(
    ...tailTimings.map((timing) => timing?.lastPtsTicks ?? Number.NEGATIVE_INFINITY),
  );
  const finestGapTicks = Math.min(
    ...headTimings.map((timing) => timing?.medianGapTicks ?? Number.POSITIVE_INFINITY),
  );
  const durationSec = (lastPtsTicks - firstPtsTicks + finestGapTicks) / TS_CLOCK_HZ;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { state: 'fatal' };

  return {
    state: 'accept',
    parsed: {
      observedDiscontinuity: false,
      observedPmtStreamSets: [...head.observedPmtStreamSets, ...tail.observedPmtStreamSets],
      ...(head.selectedPmtPid !== undefined ? { selectedPmtPid: head.selectedPmtPid } : {}),
      tracks: pairs.map(({ head: headTrack, tail: tailTrack }) => {
        const first = headTrack.timing;
        const later = tailTrack.timing;
        if (first === undefined || later === undefined) {
          throw new MediaError('demux-error', 'MPEG-TS sparse timing evidence disappeared');
        }
        return {
          stream: headTrack.stream,
          units: [...headTrack.units, ...tailTrack.units],
          durationSec,
          ...(headTrack.fps !== undefined ? { fps: headTrack.fps } : {}),
          config: headTrack.config,
          timing: {
            firstPtsTicks: first.firstPtsTicks,
            lastPtsTicks: later.lastPtsTicks,
            medianGapTicks: first.medianGapTicks,
            minGapTicks: Math.min(first.minGapTicks, later.minGapTicks),
            maxGapTicks: Math.max(first.maxGapTicks, later.maxGapTicks),
            gapCount: first.gapCount + later.gapCount,
            dominantGapCount: first.dominantGapCount + later.dominantGapCount,
          },
        };
      }),
    },
  };
}

function alignedPrefixEnd(
  requested: number,
  sourceSize: number,
  framing: NonNullable<ReturnType<typeof detectFraming>>,
): number {
  const bounded = Math.min(requested, sourceSize);
  const packetCount = Math.floor((bounded - framing.start) / framing.packetSize);
  return Math.max(
    framing.start + framing.packetSize,
    framing.start + packetCount * framing.packetSize,
  );
}

function alignedTailStart(
  requestedBytes: number,
  sourceSize: number,
  framing: NonNullable<ReturnType<typeof detectFraming>>,
): number {
  const approximate = Math.max(framing.start, sourceSize - requestedBytes);
  const packetCount = Math.floor((approximate - framing.start) / framing.packetSize);
  return framing.start + Math.max(0, packetCount) * framing.packetSize;
}

function tryParse(
  bytes: Uint8Array,
  seedStreams?: readonly TsTrack['stream'][],
  seedPmtPid?: number,
): TsParse | undefined {
  try {
    return parseTs(bytes, {
      collectPmtEvidence: true,
      ...(seedStreams !== undefined ? { seedStreams } : {}),
      ...(seedPmtPid !== undefined ? { seedPmtPid } : {}),
    });
  } catch (error) {
    if (error instanceof MediaError && error.code === 'aborted') throw error;
    return undefined;
  }
}

function growWindow(current: number, limit: number): number {
  return Math.min(limit, current * 2);
}

function initialWindowBytes(sourceSize: number): number {
  // Keep the normal two-endpoint read at or below 25% of the source, while retaining enough packets
  // for codec/cadence evidence. Power-of-two tiers also avoid arbitrary per-container or fixture sizes.
  const perEndpointBudget = Math.floor(sourceSize / 8);
  if (perEndpointBudget >= MAX_INITIAL_WINDOW_BYTES) return MAX_INITIAL_WINDOW_BYTES;
  if (perEndpointBudget >= 2 * MIN_INITIAL_WINDOW_BYTES) return 2 * MIN_INITIAL_WINDOW_BYTES;
  return MIN_INITIAL_WINDOW_BYTES;
}

/**
 * Parse probe-facing track metadata. Seekable known-size sources use independently parsed bounded
 * endpoint ranges; streams, malformed layouts, late configuration, low cadence, sampled VFR/config
 * changes, and discontinuities retain the exact full-parse fallback.
 */
export async function probeTs(src: ByteSource, signal: AbortSignal | undefined): Promise<TsParse> {
  throwIfSourceAborted(signal);
  const sourceSize = src.size;
  if (
    src.range === undefined ||
    sourceSize === undefined ||
    !Number.isSafeInteger(sourceSize) ||
    sourceSize <= 0
  ) {
    return fullParse(src, signal);
  }

  const sparseLimit = Math.min(MAX_SPARSE_WINDOW_BYTES, Math.ceil(sourceSize / 2));
  if (sourceSize < 8 * MIN_INITIAL_WINDOW_BYTES) return fullParse(src, signal);
  const initialWindow = initialWindowBytes(sourceSize);
  let requestedHead = Math.min(initialWindow, sourceSize);
  if (requestedHead > sparseLimit) return fullParse(src, signal);

  let headBytes = await raceAbort(src.range(0, requestedHead, signal), signal);
  throwIfSourceAborted(signal);
  const framing = detectFraming(headBytes);
  if (framing === undefined) return fullParse(src, signal);

  let head: TsParse | undefined;
  let headEnd = 0;
  for (;;) {
    throwIfSourceAborted(signal);
    headEnd = alignedPrefixEnd(requestedHead, sourceSize, framing);
    if (headBytes.byteLength < headEnd) {
      headBytes = await raceAbort(src.range(0, headEnd, signal), signal);
      throwIfSourceAborted(signal);
    }
    const candidate = tryParse(headBytes.subarray(0, headEnd));
    const evidence = classifyHeadEvidence(candidate);
    if (evidence === 'accept' && candidate !== undefined) {
      head = candidate;
      break;
    }
    if (evidence === 'fatal') return fullParse(src, signal);
    if (requestedHead === sparseLimit) break;
    requestedHead = growWindow(requestedHead, sparseLimit);
  }
  if (head === undefined) return fullParse(src, signal);

  const seedStreams = head.tracks.map((track) => track.stream);
  let requestedTail = Math.min(initialWindow, sparseLimit);
  for (;;) {
    throwIfSourceAborted(signal);
    const tailStart = alignedTailStart(requestedTail, sourceSize, framing);
    if (tailStart <= headEnd) return fullParse(src, signal);
    const tailBytes = await raceAbort(src.range(tailStart, sourceSize, signal), signal);
    throwIfSourceAborted(signal);
    const tail = tryParse(tailBytes, seedStreams, head.selectedPmtPid);
    if (tail !== undefined) {
      const merged = mergeSparseMetadata(head, tail);
      if (merged.state === 'accept' && merged.parsed !== undefined) return merged.parsed;
      if (merged.state === 'fatal') return fullParse(src, signal);
    }
    if (requestedTail === sparseLimit) break;
    requestedTail = growWindow(requestedTail, sparseLimit);
  }

  return fullParse(src, signal);
}
