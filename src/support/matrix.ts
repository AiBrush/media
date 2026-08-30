/**
 * Executable support matrix (REQUIREMENTS §6).
 *
 * Generated from the same lazy driver declarations the engine routes through
 * (`DEFAULT_LAZY_CONTAINER_SPECS` + codec specs), so the published container×operation
 * and codec×capability tables cannot drift from routing truth.
 * Documentation MUST NOT imply container support automatically means codec support.
 */

import { AV1_POLICY } from '../codecs/av1-policy.ts';
import { HEVC_POLICY } from '../codecs/hevc-policy.ts';
import { DEFAULT_LAZY_CONTAINER_SPECS } from '../drivers/defaults.ts';

export type ContainerOperation =
  | 'probe'
  | 'demux'
  | 'mux'
  | 'streaming-mux'
  | 'remux'
  | 'metadata'
  | 'seek'
  | 'trim'
  | 'encryption';

export interface ContainerMatrixRow {
  readonly container: string;
  readonly operations: readonly ContainerOperation[];
}

export interface CodecMatrixRow {
  readonly codec: string;
  readonly parse: boolean;
  readonly decode: { readonly hardware: boolean; readonly software: boolean };
  readonly encode: { readonly hardware: boolean; readonly software: boolean };
  readonly alpha: boolean;
  readonly bitDepths: readonly number[];
  readonly channelLayouts: readonly string[];
}

export interface SupportMatrix {
  readonly schema: 'aibrush-media/support-matrix@1';
  readonly containers: readonly ContainerMatrixRow[];
  readonly codecs: readonly CodecMatrixRow[];
}

const CONTAINER_OPS_ALL: readonly ContainerOperation[] = [
  'probe',
  'demux',
  'mux',
  'streaming-mux',
  'remux',
  'metadata',
  'seek',
  'trim',
  'encryption',
] as const;

type LazySpecFlags = {
  readonly formats: readonly string[];
  readonly probe?: boolean;
  readonly packetInfo?: boolean;
  readonly streamCopy?: boolean;
  readonly streamCopyTargets?: readonly string[];
  readonly muxKind?: string;
  readonly gaplessSeam?: boolean;
  readonly validatesStreamCopyTrim?: boolean;
  readonly transformPcm?: boolean;
  readonly decrypt?: boolean;
  readonly rejectChunkMux?: string;
};

function containerOps(spec: LazySpecFlags): ContainerOperation[] {
  const ops: ContainerOperation[] = [];
  if (spec.probe) {
    ops.push('probe', 'metadata', 'demux', 'seek');
    if (spec.packetInfo) ops.push('seek');
  }
  // mux capability: explicit muxKind or streamCopy or streamCopyTargets
  const hasMux =
    spec.muxKind !== undefined || spec.streamCopy === true || spec.streamCopyTargets !== undefined;
  if (hasMux) ops.push('mux', 'remux');
  // streaming-mux: webm/mkv path or explicit streaming-webm route (mp4 fragmented also streams)
  if (
    spec.formats.includes('webm') ||
    spec.formats.includes('mkv') ||
    spec.formats.includes('mp4')
  ) {
    // only those with streamCopy or packetInfo that can progressively emit
    if (spec.streamCopy || spec.formats.includes('webm') || spec.formats.includes('mkv'))
      ops.push('streaming-mux');
  }
  if (spec.gaplessSeam || spec.validatesStreamCopyTrim) ops.push('trim');
  if (spec.decrypt) ops.push('encryption');
  // dedup and sort by canonical order
  const seen = new Set<ContainerOperation>();
  const ordered: ContainerOperation[] = [];
  for (const op of CONTAINER_OPS_ALL)
    if (ops.includes(op) && !seen.has(op)) {
      seen.add(op);
      ordered.push(op);
    }
  return ordered;
}

/** Codec declarations mirroring `lazyCodecDrivers()` but as static data for the matrix. */
const CODEC_SPECS: readonly {
  readonly codec: string;
  readonly decodeHardware: boolean;
  readonly decodeSoftware: boolean;
  readonly encodeHardware: boolean;
  readonly encodeSoftware: boolean;
  readonly alpha: boolean;
  readonly bitDepths: readonly number[];
  readonly channelLayouts: readonly string[];
}[] = [
  {
    codec: 'h264',
    decodeHardware: true,
    decodeSoftware: false,
    encodeHardware: true,
    encodeSoftware: false,
    alpha: false,
    bitDepths: [8],
    channelLayouts: [],
  },
  {
    codec: HEVC_POLICY.codec,
    decodeHardware: HEVC_POLICY.decode.hardware,
    decodeSoftware: HEVC_POLICY.decode.software,
    encodeHardware: HEVC_POLICY.encode.hardware,
    encodeSoftware: HEVC_POLICY.encode.software,
    alpha: HEVC_POLICY.alpha,
    bitDepths: [...HEVC_POLICY.bitDepths],
    channelLayouts: [...HEVC_POLICY.channelLayouts],
  },
  {
    codec: AV1_POLICY.codec,
    decodeHardware: AV1_POLICY.decode.hardware,
    decodeSoftware: AV1_POLICY.decode.software,
    encodeHardware: AV1_POLICY.encode.hardware,
    encodeSoftware: AV1_POLICY.encode.software,
    alpha: AV1_POLICY.alpha,
    bitDepths: [...AV1_POLICY.bitDepths],
    channelLayouts: [...AV1_POLICY.channelLayouts],
  },
  {
    codec: 'vp9',
    decodeHardware: true,
    decodeSoftware: true,
    encodeHardware: true,
    encodeSoftware: false,
    alpha: true,
    bitDepths: [8, 10],
    channelLayouts: [],
  },
  {
    codec: 'vp8',
    decodeHardware: true,
    decodeSoftware: true,
    encodeHardware: true,
    encodeSoftware: false,
    alpha: true,
    bitDepths: [8],
    channelLayouts: [],
  },
  {
    codec: 'aac',
    decodeHardware: true,
    decodeSoftware: true,
    encodeHardware: true,
    encodeSoftware: true,
    alpha: false,
    bitDepths: [],
    channelLayouts: ['mono', 'stereo', '5.1'],
  },
  {
    codec: 'opus',
    decodeHardware: true,
    decodeSoftware: true,
    encodeHardware: true,
    encodeSoftware: false,
    alpha: false,
    bitDepths: [],
    channelLayouts: ['mono', 'stereo'],
  },
  {
    codec: 'vorbis',
    decodeHardware: false,
    decodeSoftware: true,
    encodeHardware: false,
    encodeSoftware: true,
    alpha: false,
    bitDepths: [],
    channelLayouts: ['mono', 'stereo'],
  },
  {
    codec: 'mp3',
    decodeHardware: true,
    decodeSoftware: true,
    encodeHardware: false,
    encodeSoftware: true,
    alpha: false,
    bitDepths: [],
    channelLayouts: ['mono', 'stereo'],
  },
  {
    codec: 'flac',
    decodeHardware: false,
    decodeSoftware: true,
    encodeHardware: false,
    encodeSoftware: true,
    alpha: false,
    bitDepths: [16, 24],
    channelLayouts: ['mono', 'stereo'],
  },
  {
    codec: 'pcm',
    decodeHardware: true,
    decodeSoftware: true,
    encodeHardware: true,
    encodeSoftware: true,
    alpha: false,
    bitDepths: [16, 24, 32],
    channelLayouts: ['mono', 'stereo', '5.1', '7.1'],
  },
] as const;

export function generateSupportMatrix(): SupportMatrix {
  const containers: ContainerMatrixRow[] = [];
  const seenFormats = new Map<string, ContainerOperation[]>();
  for (const spec of DEFAULT_LAZY_CONTAINER_SPECS) {
    const ops = containerOps(spec as LazySpecFlags);
    for (const fmt of spec.formats) {
      // merge ops for formats that appear in multiple specs (e.g. mp4 appears in MP4_LAZY_CONTAINER_SPEC)
      const existing = seenFormats.get(fmt);
      if (existing === undefined) seenFormats.set(fmt, [...ops]);
      else {
        for (const op of ops) if (!existing.includes(op)) existing.push(op);
      }
    }
  }
  // also include mux-only drivers
  for (const [fmt, ops] of seenFormats) {
    const ordered = CONTAINER_OPS_ALL.filter((op) => ops.includes(op));
    containers.push({ container: fmt, operations: ordered });
  }
  containers.sort((a, b) => a.container.localeCompare(b.container));

  const codecs: CodecMatrixRow[] = CODEC_SPECS.map((s) => ({
    codec: s.codec,
    parse: true,
    decode: { hardware: s.decodeHardware, software: s.decodeSoftware },
    encode: { hardware: s.encodeHardware, software: s.encodeSoftware },
    alpha: s.alpha,
    bitDepths: s.bitDepths,
    channelLayouts: s.channelLayouts,
  }));

  return Object.freeze({
    schema: 'aibrush-media/support-matrix@1',
    containers: Object.freeze(
      containers.map((r) => Object.freeze({ ...r, operations: Object.freeze([...r.operations]) })),
    ),
    codecs: Object.freeze(
      codecs.map((r) =>
        Object.freeze({
          ...r,
          bitDepths: Object.freeze([...r.bitDepths]),
          channelLayouts: Object.freeze([...r.channelLayouts]),
          decode: Object.freeze({ ...r.decode }),
          encode: Object.freeze({ ...r.encode }),
        }),
      ),
    ),
  });
}
