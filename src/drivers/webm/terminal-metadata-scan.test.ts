/**
 * Scale + honesty invariants for the WebM terminal metadata scan. A WebM that declares neither
 * `Segment>Info>Duration` nor `TrackEntry>DefaultDuration` (every MediaRecorder capture, many
 * stream-copied files) can only be dated from the end of the file — which is an index read, not a
 * body read. These tests pin both halves of that: probe reads a bounded number of bytes near the two
 * ends of a long file, and the timeline it reports is byte-identical to a whole-file parse. A faster
 * probe that reports a slightly different duration would be a failure, so every case here compares
 * against the same file probed through a stream-only source (which reads and parses it whole).
 */

import { describe, expect, it } from 'vitest';
import type { ByteSource, TrackInfo } from '../../contracts/driver.ts';
import { WEBM_METADATA_TAIL_BYTES, WebmDriver, parseWebm } from './webm-driver.ts';

// ── EBML builders (same shape as webm.test.ts) ───────────────────────────────────────────────────
const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
/** A size vint, minimal width by default; `width` pins it (an 8-byte size is legal and common). */
function sizeVint(n: number, width?: number): number[] {
  const w = width ?? (n < 0x7f ? 1 : n < 0x3fff ? 2 : n < 0x1fffff ? 3 : n < 0xfffffff ? 4 : 5);
  const out: number[] = [];
  for (let i = w - 1; i >= 0; i--) out.push(Math.floor(n / 256 ** i) & 0xff);
  out[0] = (out[0] ?? 0) | (0x80 >> (w - 1));
  return out;
}
function uintN(value: number, len: number): number[] {
  const out: number[] = [];
  for (let i = len - 1; i >= 0; i--) out.push(Math.floor(value / 256 ** i) & 0xff);
  return out;
}
function f64(value: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, false);
  return [...b];
}
const el = (id: readonly number[], data: readonly number[]): number[] => [
  ...id,
  ...sizeVint(data.length),
  ...data,
];
function join(parts: readonly (readonly number[] | Uint8Array)[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part instanceof Uint8Array ? part : Uint8Array.from(part), offset);
    offset += part.length;
  }
  return out;
}

const E = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  SeekHead: [0x11, 0x4d, 0x9b, 0x74],
  Seek: [0x4d, 0xbb],
  SeekID: [0x53, 0xab],
  SeekPosition: [0x53, 0xac],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  Duration: [0x44, 0x89],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackType: [0x83],
  CodecID: [0x86],
  DefaultDuration: [0x23, 0xe3, 0x83],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Audio: [0xe1],
  SamplingFrequency: [0xb5],
  Channels: [0x9f],
  BitDepth: [0x62, 0x64],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7],
  SimpleBlock: [0xa3],
  BlockGroup: [0xa0],
  Block: [0xa1],
  BlockDuration: [0x9b],
  Void: [0xec],
  Attachments: [0x19, 0x41, 0xa4, 0x69],
  AttachedFile: [0x61, 0xa7],
  FileName: [0x46, 0x6e],
  FileMimeType: [0x46, 0x60],
  FileData: [0x46, 0x5c],
  Cues: [0x1c, 0x53, 0xbb, 0x6b],
  CuePoint: [0xbb],
  CueTime: [0xb3],
  CueTrackPositions: [0xb7],
  CueTrack: [0xf7],
  CueClusterPosition: [0xf1],
} as const;

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

interface LongWebmOptions {
  readonly seconds: number;
  readonly fps: number;
  /** Payload bytes per video block — what makes the file long relative to its metadata. */
  readonly blockBytes: number;
  readonly clusterSeconds?: number;
  /** The index: absent, at either end, or one of the ways writers/transports break it. */
  readonly cues?: 'trailing' | 'leading' | 'truncated' | 'past-eof' | 'misaligned';
  /**
   * Head SeekHead: absent, pointing at Cues, at a byte offset that is not Cues, at a zero-filled
   * (reserved but never written) region, or at a second SeekHead beside the trailing index — the
   * mkvmerge shape.
   */
  readonly seekHead?: 'cues' | 'bogus' | 'nested' | 'zeroed';
  /** An Attachments element after the Clusters — a public stream no bounded head parse can see. */
  readonly attachment?: boolean;
  readonly declareDuration?: boolean;
  readonly defaultDuration?: boolean;
  /** MediaRecorder shape: Clusters with an all-ones (unknown) size vint. */
  readonly unknownSizeClusters?: boolean;
  /** MediaRecorder shape: a Segment whose length is not known when its header is written. */
  readonly unknownSizeSegment?: boolean;
  /** Wrap each video block in a BlockGroup + BlockDuration instead of a SimpleBlock. */
  readonly blockGroups?: boolean;
  /**
   * Writer reality inside SeekHead/Cues: Void padding, a Seek entry a writer reserved but never
   * filled in, and one whose SeekPosition declares more bytes than its parent element holds.
   */
  readonly voidPadding?: boolean;
  /** Info: complete, present without TimecodeScale (the 1 ms default), or absent entirely. */
  readonly info?: 'bare' | 'omit';
  /** Jitter block spacing so no constant cadence exists to recover. */
  readonly variableFrameRate?: boolean;
  /** Interleave a second (audio) track's blocks. */
  readonly audio?: boolean;
  /**
   * Payload decoys: the bare Cluster id, or a complete fake Cluster header with a Timestamp — the
   * shape that survives a cheap plausibility filter and must be rejected by the chain walk itself.
   */
  readonly decoys?: 'cluster-id' | 'cluster-header';
  /** Put a block for an undeclared TrackNumber in the final Cluster. */
  readonly strayTrackBlock?: boolean;
  /** Send the final Cluster's Timestamp backwards. */
  readonly nonMonotonicTail?: boolean;
  /** Stamp every Cluster and block at zero — a timeline that never advances. */
  readonly zeroTimestamps?: boolean;
  readonly timecodeScaleNs?: number;
}

/** Deterministic jitter/noise — a test that generates megabytes must not generate them randomly. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function simpleBlock(track: number, relativeTicks: number, payload: Uint8Array): Uint8Array {
  const header = [0x80 | track, (relativeTicks >> 8) & 0xff, relativeTicks & 0xff, 0x80];
  return join([[...E.SimpleBlock, ...sizeVint(header.length + payload.length)], header, payload]);
}

/** The same frame as a BlockGroup + Block + BlockDuration (the pre-SimpleBlock Matroska shape). */
function blockGroup(
  track: number,
  relativeTicks: number,
  durationTicks: number,
  payload: Uint8Array,
): Uint8Array {
  const header = [0x80 | track, (relativeTicks >> 8) & 0xff, relativeTicks & 0xff, 0x00];
  const block = join([[...E.Block, ...sizeVint(header.length + payload.length)], header, payload]);
  const duration = el(E.BlockDuration, uintN(Math.max(1, durationTicks), 2));
  return join([
    [...E.BlockGroup, ...sizeVint(block.byteLength + duration.length, 4)],
    block,
    duration,
  ]);
}

/**
 * A long WebM in the shape real writers produce: metadata at the head, Clusters in the body, and
 * (optionally) a Cues index at the tail. Every offset the index declares is computed from the encoded
 * bytes, so the fixture is self-consistent unless a case deliberately breaks it.
 */
function buildLongWebm(options: LongWebmOptions): Uint8Array {
  const scale = options.timecodeScaleNs ?? 1_000_000;
  const ticksPerSecond = 1e9 / scale;
  const jitter = lcg(0x5eed);
  const payload = new Uint8Array(options.blockBytes);
  payload.fill(0x42);
  if (options.decoys !== undefined) {
    // 'cluster-header' decoys carry a Timestamp and a size that overruns whatever follows: they pass
    // any cheap "does this open a Cluster" filter, so only the chain walk can throw them out.
    const decoy =
      options.decoys === 'cluster-id'
        ? [...E.Cluster]
        : [...E.Cluster, ...sizeVint(1 << 24, 4), ...el(E.Timecode, uintN(7, 2))];
    for (let at = 0; at + decoy.length <= payload.byteLength; at += 64) payload.set(decoy, at);
  }
  const audioPayload = new Uint8Array(64).fill(0x17);

  const header = el(E.EBML, [
    ...el(E.EBMLVersion, [1]),
    ...el(E.EBMLReadVersion, [1]),
    ...el(E.EBMLMaxIDLength, [4]),
    ...el(E.EBMLMaxSizeLength, [8]),
    ...el(E.DocType, str('webm')),
    ...el(E.DocTypeVersion, [2]),
    ...el(E.DocTypeReadVersion, [2]),
  ]);
  const info =
    options.info === 'omit'
      ? []
      : el(E.Info, [
          ...(options.info === 'bare' ? [] : el(E.TimecodeScale, uintN(scale, 3))),
          ...(options.declareDuration ? el(E.Duration, f64(options.seconds * ticksPerSecond)) : []),
        ]);
  const tracks = el(E.Tracks, [
    ...el(E.TrackEntry, [
      ...el(E.TrackNumber, [VIDEO_TRACK]),
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP8')),
      ...(options.defaultDuration
        ? el(E.DefaultDuration, uintN(Math.round(1e9 / options.fps), 4))
        : []),
      ...el(E.Video, [...el(E.PixelWidth, uintN(640, 2)), ...el(E.PixelHeight, uintN(360, 2))]),
    ]),
    ...(options.audio
      ? el(E.TrackEntry, [
          ...el(E.TrackNumber, [AUDIO_TRACK]),
          ...el(E.TrackType, [2]),
          ...el(E.CodecID, str('A_PCM/INT/LIT')),
          ...el(E.Audio, [
            ...el(E.SamplingFrequency, f64(48_000)),
            ...el(E.Channels, [2]),
            ...el(E.BitDepth, [16]),
          ]),
        ])
      : []),
  ]);

  // Video block times: exact cadence unless the case asks for jitter.
  const totalBlocks = Math.round(options.seconds * options.fps);
  const blockTicks = (index: number): number => {
    if (options.zeroTimestamps) return 0;
    const nominal = (index / options.fps) * ticksPerSecond;
    return Math.round(options.variableFrameRate ? nominal + (jitter() - 0.5) * 12 : nominal);
  };
  const blocksPerCluster = Math.max(1, Math.round(options.fps * (options.clusterSeconds ?? 1)));

  const clusterBodies: Uint8Array[] = [];
  const blockInterval = Math.round(ticksPerSecond / options.fps);
  for (let start = 0; start < totalBlocks; start += blocksPerCluster) {
    const last = start + blocksPerCluster >= totalBlocks;
    const clusterTicks = blockTicks(start);
    const parts: (readonly number[] | Uint8Array)[] = [
      el(E.Timecode, uintN(last && options.nonMonotonicTail ? 0 : clusterTicks, 4)),
    ];
    for (let index = start; index < Math.min(totalBlocks, start + blocksPerCluster); index++) {
      const relative = blockTicks(index) - clusterTicks;
      parts.push(
        options.blockGroups
          ? blockGroup(VIDEO_TRACK, relative, blockInterval, payload)
          : simpleBlock(VIDEO_TRACK, relative, payload),
      );
      if (options.audio) parts.push(simpleBlock(AUDIO_TRACK, relative, audioPayload));
    }
    // An undeclared TrackNumber makes the Cluster unrecognizable to the terminal walk.
    if (last && options.strayTrackBlock) {
      parts.push(
        options.blockGroups
          ? blockGroup(7, 0, blockInterval, audioPayload)
          : simpleBlock(7, 0, audioPayload),
      );
    }
    clusterBodies.push(join(parts));
  }

  // Encode the Clusters first: their byte lengths are what the Cues offsets are made of.
  const clusterChunks = clusterBodies.map((body) =>
    join([
      [
        ...E.Cluster,
        ...(options.unknownSizeClusters
          ? [0xff]
          : sizeVint(body.byteLength, body.byteLength < 0x1fffff ? 3 : 4)),
      ],
      body,
    ]),
  );

  const attachments = options.attachment
    ? el(E.Attachments, [
        ...el(E.AttachedFile, [
          ...el(E.FileName, str('notes.txt')),
          ...el(E.FileMimeType, str('text/plain')),
          ...el(E.FileData, str('attached after the Clusters')),
        ]),
      ])
    : [];

  // Every declared offset is fixed-width, so one dry run pins each element's length before the real
  // positions are known — the standard two-pass layout a Matroska writer performs.
  const padding = options.voidPadding ? el(E.Void, [0, 0, 0, 0]) : [];
  const seek = (target: readonly number[], position: number): number[] => [
    ...padding,
    // A Seek entry a writer reserved but never filled in: an id with no position; and one whose
    // SeekPosition escapes its own Seek element.
    ...(options.voidPadding
      ? [
          ...el(E.Seek, el(E.SeekID, E.Tracks)),
          ...el(E.Seek, [...el(E.SeekID, E.Info), ...E.SeekPosition, 0x86, 0x00]),
        ]
      : []),
    ...el(E.Seek, [...el(E.SeekID, target), ...el(E.SeekPosition, uintN(position, 6))]),
  ];
  const headSeekHead = (position: number, attachmentsPosition: number): number[] =>
    options.seekHead === undefined
      ? []
      : el(E.SeekHead, [
          ...seek(options.seekHead === 'nested' ? E.SeekHead : E.Cues, position),
          // A writer that indexes its attachments announces them from the head, exactly as it does
          // for Cues — which is how a bounded parse learns that streams live behind the prefix.
          ...(options.attachment
            ? el(E.Seek, [
                ...el(E.SeekID, E.Attachments),
                ...el(E.SeekPosition, uintN(attachmentsPosition, 6)),
              ])
            : []),
        ]);
  const tailSeekHead = (position: number): number[] =>
    options.seekHead === 'nested' ? el(E.SeekHead, seek(E.Cues, position)) : [];
  const cueBodyOf = (positions: readonly number[]): number[] =>
    padding
      .concat(
        // A CuePoint whose track has no CueClusterPosition names no Cluster.
        options.voidPadding
          ? el(E.CuePoint, [
              ...el(E.CueTime, uintN(0, 4)),
              ...el(E.CueTrackPositions, el(E.CueTrack, [AUDIO_TRACK])),
            ])
          : [],
      )
      .concat(
        positions.flatMap((start, index) =>
          el(E.CuePoint, [
            ...el(E.CueTime, uintN(blockTicks(index * blocksPerCluster), 4)),
            ...el(E.CueTrackPositions, [
              ...el(E.CueTrack, [VIDEO_TRACK]),
              // 'misaligned': the index points a few bytes into the Cluster header, not at it.
              ...el(
                E.CueClusterPosition,
                uintN(options.cues === 'misaligned' ? start + 3 : start, 5),
              ),
            ]),
          ]),
        ),
      );
  const cuesOf = (positions: readonly number[]): number[] => {
    if (options.cues === undefined) return [];
    const body = cueBodyOf(positions);
    if (options.cues === 'past-eof') return [...E.Cues, ...sizeVint(body.length * 4, 8), ...body];
    const complete = el(E.Cues, body);
    return options.cues === 'truncated'
      ? complete.slice(0, Math.floor(complete.length / 2))
      : complete;
  };

  const zeroPositions = clusterChunks.map(() => 0);
  const leading = options.cues === 'leading';
  const reserved = options.seekHead === 'zeroed' ? el(E.Void, [0, 0, 0, 0, 0, 0, 0, 0]) : [];
  const headLength =
    headSeekHead(0, 0).length +
    info.length +
    tracks.length +
    (leading ? cuesOf(zeroPositions).length : 0);
  let cursor = headLength;
  const clusterStarts = clusterChunks.map((chunk) => {
    const start = cursor;
    cursor += chunk.byteLength;
    return start;
  });
  const attachmentsPosition = cursor;
  const tailSeekHeadPosition = cursor + attachments.length;
  const cuesPosition = leading
    ? headSeekHead(0, 0).length + info.length + tracks.length
    : tailSeekHeadPosition + tailSeekHead(0).length;
  const cues = cuesOf(clusterStarts);
  // 'zeroed' aims the index at the payload of a reserved Void element: bytes a writer allocated and
  // never filled in.
  const reservedPosition = leading ? cuesPosition + cues.length : cuesPosition + cues.length + 2;
  const seekHead = headSeekHead(
    options.seekHead === 'bogus'
      ? cuesPosition + 4096
      : options.seekHead === 'zeroed'
        ? reservedPosition
        : options.seekHead === 'nested'
          ? tailSeekHeadPosition
          : cuesPosition,
    attachmentsPosition,
  );
  const nested = tailSeekHead(cuesPosition);
  const body = leading
    ? [seekHead, info, tracks, cues, ...clusterChunks, attachments, nested, reserved]
    : [seekHead, info, tracks, ...clusterChunks, attachments, nested, cues, reserved];
  const segmentBody = body.reduce((total, part) => total + part.length, 0);
  return join([
    header,
    [...E.Segment, ...(options.unknownSizeSegment ? [0xff] : sizeVint(segmentBody, 8))],
    ...body,
  ]);
}

/**
 * A seekable source that records what probe actually pulled off the wire, and that offers the
 * ephemeral-buffer handshake so the scan's ownership discipline is exercised too.
 */
function countingSource(file: Uint8Array): ByteSource & {
  bytesRead: number;
  released: number;
  readonly reads: Array<readonly [number, number]>;
} {
  const source = {
    kind: 'file' as const,
    size: file.byteLength,
    bytesRead: 0,
    released: 0,
    reads: [] as Array<readonly [number, number]>,
    range: (start: number, end: number): Promise<Uint8Array> => {
      const bounded = file.subarray(Math.max(0, start), Math.min(file.byteLength, end));
      source.bytesRead += bounded.byteLength;
      source.reads.push([start, end]);
      return Promise.resolve(bounded);
    },
    releaseRange: (): void => {
      source.released += 1;
    },
    stream: (): ReadableStream<Uint8Array> => {
      throw new Error('a seekable WebM metadata probe must not open the stream facade');
    },
  };
  return source;
}

async function probeBounded(file: Uint8Array): Promise<{
  readonly tracks: readonly TrackInfo[];
  readonly bytesRead: number;
  readonly released: number;
}> {
  if (WebmDriver.probe === undefined) throw new Error('WebmDriver.probe is not registered');
  const source = countingSource(file);
  const tracks = await WebmDriver.probe(source);
  return { tracks, bytesRead: source.bytesRead, released: source.released };
}

/** The reference answer: the same probe over a source with no `range`, which reads the file whole. */
async function probeWhole(file: Uint8Array): Promise<readonly TrackInfo[]> {
  if (WebmDriver.probe === undefined) throw new Error('WebmDriver.probe is not registered');
  const owned = file.slice(); // never widen a subarray back to its whole backing buffer
  return WebmDriver.probe({
    size: owned.byteLength,
    stream: () => new Blob([owned.buffer as ArrayBuffer]).stream(),
  });
}

describe('WebM probe — an undated long movie is answered from the file ends', () => {
  it('reads a Cues-indexed 5 min WebM from its index, not its Clusters', async () => {
    // No Duration and no DefaultDuration: the head cannot date this file, which is exactly the case
    // that used to read all of it. The index names the final Clusters, so the answer costs an index.
    const file = buildLongWebm({
      seconds: 300,
      fps: 30,
      blockBytes: 2048,
      cues: 'trailing',
      seekHead: 'cues',
      audio: true,
    });
    expect(file.byteLength).toBeGreaterThan(16 * 1024 * 1024);

    const { tracks, bytesRead } = await probeBounded(file);
    expect(tracks).toEqual(await probeWhole(file));
    expect(tracks[0]?.durationSec).toBe(parseWebm(file).durationSec);
    expect(tracks[0]?.fps).toBe(30);
    // Scales with the index, not the movie: two Clusters plus Cues, never the body.
    expect(bytesRead).toBeLessThan(file.byteLength / 16);
    expect(bytesRead).toBeLessThan(WEBM_METADATA_TAIL_BYTES);
  });

  it('reads an unindexed long WebM from a bounded tail window', async () => {
    const file = buildLongWebm({ seconds: 300, fps: 30, blockBytes: 2048 });
    const { tracks, bytesRead } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    expect(tracks[0]?.durationSec).toBe(parseWebm(file).durationSec);
    // One head prefix plus one tail window — the body between them is never transferred.
    expect(bytesRead).toBeLessThan(WEBM_METADATA_TAIL_BYTES + 64 * 1024);
    expect(bytesRead).toBeLessThan(file.byteLength / 3);
  });

  it('dates MediaRecorder-shaped unknown-size Clusters from the tail', async () => {
    // The live-capture shape end to end: neither the Segment nor its Clusters know their own length.
    const file = buildLongWebm({
      seconds: 240,
      fps: 25,
      blockBytes: 4096,
      unknownSizeClusters: true,
      unknownSizeSegment: true,
    });
    const { tracks, bytesRead } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    expect(tracks[0]?.fps).toBe(25);
    expect(bytesRead).toBeLessThan(WEBM_METADATA_TAIL_BYTES + 64 * 1024);
  });

  it('keeps the exact declared duration when only cadence is missing', async () => {
    const file = buildLongWebm({
      seconds: 300,
      fps: 30,
      blockBytes: 2048,
      cues: 'trailing',
      seekHead: 'cues',
      declareDuration: true,
    });
    const { tracks, bytesRead } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    expect(tracks[0]?.durationSec).toBe(300);
    expect(bytesRead).toBeLessThan(file.byteLength / 16);
  });

  it('keeps the exact declared cadence when only the date is missing', async () => {
    const file = buildLongWebm({
      seconds: 300,
      fps: 30,
      blockBytes: 2048,
      cues: 'trailing',
      seekHead: 'cues',
      defaultDuration: true,
    });
    const { tracks, bytesRead } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    expect(tracks[0]?.fps).toBe(parseWebm(file).tracks[0]?.fps);
    expect(bytesRead).toBeLessThan(file.byteLength / 16);
  });

  it('releases every ephemeral terminal buffer it borrowed', async () => {
    const file = buildLongWebm({
      seconds: 300,
      fps: 30,
      blockBytes: 2048,
      cues: 'trailing',
      seekHead: 'cues',
    });
    const { tracks, released } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    // The Cues read and the terminal window are both handed back; only the head prefix is retained.
    expect(released).toBeGreaterThanOrEqual(2);
  });

  it('reads BlockGroup-framed Clusters as readily as SimpleBlocks', async () => {
    const file = buildLongWebm({
      seconds: 240,
      fps: 25,
      blockBytes: 4096,
      blockGroups: true,
      cues: 'trailing',
      seekHead: 'cues',
    });
    const { tracks, bytesRead } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    expect(tracks[0]?.fps).toBe(25);
    expect(bytesRead).toBeLessThan(file.byteLength / 16);
  });

  it('reads past the Void padding and reserved Seek entries a writer left behind', async () => {
    const file = buildLongWebm({
      seconds: 300,
      fps: 30,
      blockBytes: 2048,
      cues: 'trailing',
      seekHead: 'cues',
      voidPadding: true,
    });
    const { tracks, bytesRead } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    expect(bytesRead).toBeLessThan(file.byteLength / 16);
  });

  it('widens the window when the final Cluster is too thin to date the cadence', async () => {
    // One block per Cluster and a 300 KB payload: the indexed window holds a single block, which
    // cannot express an interval. The next rung is a wider window over the same tail, not the file.
    const file = buildLongWebm({
      seconds: 30,
      fps: 2,
      blockBytes: 300_000,
      clusterSeconds: 0.5,
      cues: 'trailing',
      seekHead: 'cues',
    });
    const { tracks, bytesRead } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    expect(tracks[0]?.fps).toBe(2);
    expect(bytesRead).toBeLessThan(file.byteLength / 2);
  });

  it('re-anchors on a Cues-declared Cluster that starts before the tail window', async () => {
    // 30 s Clusters of 1080p-scale payload run past the tail window; only the index says where the
    // final one opens, and re-anchoring there keeps the read to one Cluster instead of the movie.
    const file = buildLongWebm({
      seconds: 90,
      fps: 30,
      blockBytes: 8192,
      clusterSeconds: 30,
      cues: 'trailing',
      seekHead: 'cues',
    });
    const { tracks, bytesRead } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    expect(bytesRead).toBeGreaterThan(WEBM_METADATA_TAIL_BYTES); // one Cluster is bigger than a window
    expect(bytesRead).toBeLessThan(file.byteLength / 2);
  });

  it('follows a SeekHead that points at a second SeekHead beside the index', async () => {
    // mkvmerge's layout: a fixed stub at the head names a SeekHead written next to the trailing Cues.
    const file = buildLongWebm({
      seconds: 300,
      fps: 30,
      blockBytes: 2048,
      cues: 'trailing',
      seekHead: 'nested',
    });
    const { tracks, bytesRead } = await probeBounded(file);

    expect(tracks).toEqual(await probeWhole(file));
    expect(bytesRead).toBeLessThan(file.byteLength / 16);
  });

  it('reads a front-loaded Cues out of the head prefix it already holds', async () => {
    const file = buildLongWebm({ seconds: 300, fps: 30, blockBytes: 2048, cues: 'leading' });
    const source = countingSource(file);
    const tracks = await WebmDriver.probe?.(source);

    expect(tracks).toEqual(await probeWhole(file));
    // The index is inside the metadata prefix, so the only terminal cost is the final Cluster.
    // One head prefix and one terminal window: the index cost no read of its own.
    expect(source.reads).toHaveLength(2);
    expect(source.reads[0]?.[0]).toBe(0);
    expect(source.bytesRead).toBeLessThan(file.byteLength / 16);
  });

  it('reads the file whole rather than dropping an Attachments stream behind the prefix', async () => {
    // Attachments after the Clusters are public streams. No bounded head read can see them, so the
    // scan declines: fewer tracks would be a wrong answer, and a slow answer is not.
    const file = buildLongWebm({
      seconds: 120,
      fps: 30,
      blockBytes: 2048,
      cues: 'trailing',
      seekHead: 'cues',
      attachment: true,
    });
    const { tracks, bytesRead } = await probeBounded(file);
    const whole = await probeWhole(file);

    expect(tracks).toEqual(whole);
    expect(parseWebm(file).tracks).toHaveLength(2); // video + the attached file
    expect(bytesRead).toBeGreaterThanOrEqual(file.byteLength); // it declined, and read the file
  });

  it('rechecks cancellation during the terminal scan', async () => {
    const file = buildLongWebm({ seconds: 300, fps: 30, blockBytes: 2048 });
    const controller = new AbortController();
    let reads = 0;
    const source: ByteSource = {
      size: file.byteLength,
      range: (start, end): Promise<Uint8Array> => {
        reads += 1;
        if (start > 0) controller.abort('cancel the WebM terminal scan');
        return Promise.resolve(file.subarray(start, Math.min(file.byteLength, end)));
      },
      stream: (): ReadableStream<Uint8Array> => {
        throw new Error('a cancelled terminal scan must stay range-backed');
      },
    };

    await expect(WebmDriver.probe?.(source, { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(reads).toBeGreaterThan(1);
  });

  it('falls back rather than guessing when the cadence is genuinely variable', async () => {
    // Nothing bounded can reproduce a whole-file block count here, so the whole-file read is the only
    // honest answer. The contract this pins is the *result*, not the strategy that produced it.
    const file = buildLongWebm({
      seconds: 120,
      fps: 30,
      blockBytes: 4096,
      variableFrameRate: true,
    });
    const { tracks } = await probeBounded(file);
    expect(tracks).toEqual(await probeWhole(file));
    expect(tracks[0]?.fps).toBe(parseWebm(file).tracks[0]?.fps);
  });
});

describe('WebM terminal scan — malformed indexes fall back, they never lie', () => {
  /**
   * `bounded: false` marks a case where the whole-file read is the intended, honest outcome;
   * `dated: false` one where the file genuinely carries no timeline to report.
   */
  const malformed: ReadonlyArray<
    readonly [string, LongWebmOptions & { readonly bounded?: false; readonly dated?: false }]
  > = [
    [
      'a Cues element truncated by the writer',
      { seconds: 90, fps: 30, blockBytes: 4096, cues: 'truncated', seekHead: 'cues' },
    ],
    [
      'a Cues element that declares more bytes than the file holds',
      { seconds: 90, fps: 30, blockBytes: 4096, cues: 'past-eof', seekHead: 'cues' },
    ],
    [
      'a SeekHead whose Cues offset points at payload',
      { seconds: 90, fps: 30, blockBytes: 4096, cues: 'trailing', seekHead: 'bogus' },
    ],
    [
      'a Cues whose Cluster positions land mid-header',
      { seconds: 90, fps: 30, blockBytes: 4096, cues: 'misaligned', seekHead: 'cues' },
    ],
    [
      'a tail window that lands mid-element inside a decoy-filled body',
      { seconds: 90, fps: 30, blockBytes: 4096, decoys: 'cluster-id' },
    ],
    [
      // Nothing in the window opens a Cluster, so there is no chain to prove: read the file.
      'an unindexed final Cluster larger than the tail window',
      { seconds: 90, fps: 30, blockBytes: 8192, clusterSeconds: 30, bounded: false },
    ],
    [
      'payload decoys that mimic a complete Cluster header',
      { seconds: 90, fps: 30, blockBytes: 4096, decoys: 'cluster-header', bounded: false },
    ],
    [
      'a final Cluster carrying a block for an undeclared track',
      { seconds: 90, fps: 30, blockBytes: 4096, strayTrackBlock: true, bounded: false },
    ],
    [
      'a final Cluster whose Timestamp runs backwards',
      { seconds: 90, fps: 30, blockBytes: 4096, nonMonotonicTail: true, bounded: false },
    ],
    [
      // Every Timestamp is zero, so there is no cadence to measure and no date to report. Probe must
      // agree with the whole-file parse that the file says nothing, rather than inventing a span.
      'a timeline where every Timestamp is zero',
      {
        seconds: 120,
        fps: 30,
        blockBytes: 2048,
        zeroTimestamps: true,
        bounded: false,
        dated: false,
      },
    ],
    [
      'a zero timeline whose cadence is nonetheless declared',
      {
        seconds: 120,
        fps: 30,
        blockBytes: 2048,
        zeroTimestamps: true,
        defaultDuration: true,
        bounded: false,
        dated: false,
      },
    ],
    [
      'a SeekHead entry pointing at reserved, never-written bytes',
      { seconds: 90, fps: 30, blockBytes: 4096, cues: 'trailing', seekHead: 'zeroed' },
    ],
    [
      'BlockGroup framing around a block for an undeclared track',
      {
        seconds: 90,
        fps: 30,
        blockBytes: 4096,
        blockGroups: true,
        strayTrackBlock: true,
        bounded: false,
      },
    ],
    [
      // 16 MiB+ Clusters: the index names one, but reading from it is not a bounded read.
      'an indexed final Cluster further back than a bounded read',
      {
        seconds: 90,
        fps: 30,
        blockBytes: 20_000,
        clusterSeconds: 30,
        cues: 'trailing',
        seekHead: 'cues',
        bounded: false,
      },
    ],
  ];

  it.each(malformed)('survives %s', async (_name, options) => {
    const file = buildLongWebm(options);
    const { tracks, bytesRead } = await probeBounded(file);
    const whole = await probeWhole(file);

    expect(tracks).toEqual(whole);
    expect(tracks[0]?.durationSec).toBe(parseWebm(file).durationSec);
    if (options.dated !== false) expect(tracks[0]?.durationSec).toBeGreaterThan(0);
    if (options.bounded !== false) {
      // A broken index costs a retry, never the file: the tail window still proves the chain.
      expect(bytesRead).toBeLessThan(WEBM_METADATA_TAIL_BYTES);
      expect(bytesRead).toBeLessThan(file.byteLength / 8);
    }
  });

  it('never reports a timeline the file does not carry when the tail is padded away', async () => {
    // The Segment declares Clusters that the file no longer holds (an interrupted transfer). Probe
    // must agree with the whole-file parse — including on the fact that the tail is unusable.
    const complete = buildLongWebm({ seconds: 90, fps: 30, blockBytes: 4096, cues: 'trailing' });
    const cut = complete.subarray(0, complete.byteLength - 1024 * 1024);
    const { tracks } = await probeBounded(cut);
    expect(tracks).toEqual(await probeWhole(cut));
  });
});

describe('WebM terminal scan — bounded probe equals whole-file parse', () => {
  /** `bounded: false` marks the one shape no bounded scan can answer: genuinely variable cadence. */
  const matrix: ReadonlyArray<readonly [string, LongWebmOptions & { readonly bounded?: false }]> = [
    [
      'indexed 30 fps',
      { seconds: 180, fps: 30, blockBytes: 2048, cues: 'trailing', seekHead: 'cues' },
    ],
    ['indexed 25 fps, exact ticks', { seconds: 180, fps: 25, blockBytes: 2048, cues: 'trailing' }],
    ['unindexed 30 fps', { seconds: 180, fps: 30, blockBytes: 2048 }],
    ['unindexed 12.5 fps', { seconds: 240, fps: 12.5, blockBytes: 4096 }],
    [
      'unindexed 60 fps, short Clusters',
      { seconds: 120, fps: 60, blockBytes: 2048, clusterSeconds: 0.25 },
    ],
    [
      'multitrack, indexed',
      {
        seconds: 180,
        fps: 30,
        blockBytes: 2048,
        cues: 'trailing',
        seekHead: 'cues',
        audio: true,
      },
    ],
    [
      'unknown-size Clusters',
      { seconds: 180, fps: 30, blockBytes: 2048, unknownSizeClusters: true },
    ],
    [
      'microsecond TimecodeScale, one block per Cluster',
      {
        seconds: 180,
        fps: 30,
        blockBytes: 2048,
        timecodeScaleNs: 1_000,
        clusterSeconds: 1 / 30,
        cues: 'trailing',
        seekHead: 'cues',
      },
    ],
    ['declared duration only', { seconds: 180, fps: 30, blockBytes: 2048, declareDuration: true }],
    [
      'Info without TimecodeScale (the 1 ms default)',
      { seconds: 180, fps: 30, blockBytes: 2048, info: 'bare' },
    ],
    ['no Info element at all', { seconds: 180, fps: 30, blockBytes: 2048, info: 'omit' }],
    [
      'unknown-size Segment and Clusters',
      {
        seconds: 180,
        fps: 30,
        blockBytes: 2048,
        unknownSizeSegment: true,
        unknownSizeClusters: true,
      },
    ],
    [
      'BlockGroup framing with an index',
      {
        seconds: 180,
        fps: 30,
        blockBytes: 2048,
        blockGroups: true,
        cues: 'trailing',
        seekHead: 'cues',
      },
    ],
    ['declared cadence only', { seconds: 180, fps: 30, blockBytes: 2048, defaultDuration: true }],
    [
      'variable cadence',
      { seconds: 90, fps: 30, blockBytes: 4096, variableFrameRate: true, bounded: false },
    ],
  ];

  it.each(matrix)('%s probes to the same tracks as a whole-file read', async (_name, options) => {
    const file = buildLongWebm(options);
    const { tracks, bytesRead } = await probeBounded(file);
    const whole = await probeWhole(file);
    const reference = parseWebm(file);

    expect(tracks).toEqual(whole);
    // Byte-identical timeline, not merely a close one.
    expect(tracks[0]?.durationSec).toBe(reference.durationSec);
    expect(tracks[0]?.fps).toBe(reference.tracks[0]?.fps);
    if (options.bounded !== false) expect(bytesRead).toBeLessThan(file.byteLength / 8);
  });
});
