/**
 * Fragmented audio metadata may be complete in the initialization `moov`: some DASH files retain an
 * authoritative positive `mvhd`/`mdhd` duration even though their sample tables are empty. Probe may
 * trust that bounded init metadata only for the narrow audio-only/no-edit shape; every shape whose
 * presentation depends on fragment timing must still inspect every top-level timing box.
 */

import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../contracts/driver.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { fragmentMp4 } from './fragment.ts';
import { Mp4Driver, muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import type { MuxTrackInput } from './write.ts';

const PROBE_PREFIX_BYTES = 32 * 1024;
const REAL_PREFIX_LIMIT_BYTES = 1024 * 1024;
const PREFIX_REQUIRED_ERROR = 'probe requires bytes beyond the retained initialization prefix';
const LONGFORM_DIR = fileURLToPath(
  new URL(
    '../../../../media-test/fixtures/media/scenarios/probe/longform_1h_audio/',
    import.meta.url,
  ),
);

interface RangeRead {
  readonly start: number;
  readonly end: number;
}

interface PrefixSource {
  readonly source: ByteSource;
  readonly reads: RangeRead[];
}

type VideoHintedUrlByteSource = ByteSource & {
  readonly kind: 'url';
  readonly mimeHint: 'video/mp4';
};

interface LongformTruth {
  readonly file: string;
  readonly size: number;
  readonly durationSec: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly prefixBytes: number;
  readonly prefixSha256: string;
}

const LONGFORM: readonly LongformTruth[] = [
  {
    file: '01.mp4',
    size: 65_765_571,
    durationSec: 4063.584943,
    sampleRate: 44_100,
    channels: 2,
    prefixBytes: PROBE_PREFIX_BYTES,
    prefixSha256: 'd7ce54d084aa860fcffa0b60a6f9231d01e1117dc3525265b1ecdd43a68d5cdb',
  },
  {
    file: '02.mp4',
    size: 58_145_485,
    durationSec: 3592.753923,
    sampleRate: 44_100,
    channels: 2,
    prefixBytes: PROBE_PREFIX_BYTES,
    prefixSha256: 'db697111f94079eaf6522c5c10ffdf9e936a5d2cbd820201827f5e7d1bf5d22c',
  },
  {
    file: '03.mp4',
    size: 59_301_639,
    durationSec: 3664.178503,
    sampleRate: 44_100,
    channels: 2,
    prefixBytes: PROBE_PREFIX_BYTES,
    prefixSha256: 'c0fb2d41431ccf97cb02a92b74dc6a005492961d608ab23038d84570a94967c5',
  },
  {
    file: 'longform_1h_audio.m4a',
    size: 29_659_705,
    durationSec: 3600,
    sampleRate: 48_000,
    channels: 1,
    prefixBytes: REAL_PREFIX_LIMIT_BYTES,
    prefixSha256: '73fb4dafabc401afb293c8874ce950afc52b7e59277ecf1071d75ebf8f65a3e6',
  },
];

function prefixOnlySource(prefix: Uint8Array, size: number): PrefixSource {
  const reads: RangeRead[] = [];
  return {
    reads,
    source: {
      size,
      async range(start, end): Promise<Uint8Array> {
        reads.push({ start, end });
        if (start < 0 || end < start || end > prefix.byteLength) {
          throw new Error(PREFIX_REQUIRED_ERROR);
        }
        return prefix.subarray(start, end);
      },
      stream(): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.error(new Error(PREFIX_REQUIRED_ERROR));
          },
        });
      },
    },
  };
}

function probeMp4(source: ByteSource): ReturnType<NonNullable<typeof Mp4Driver.probe>> {
  const probe = Mp4Driver.probe;
  if (probe === undefined) throw new Error('MP4 driver has no metadata probe');
  return probe(source);
}

async function realPrefixSource(truth: LongformTruth): Promise<PrefixSource> {
  const path = `${LONGFORM_DIR}${truth.file}`;
  const fileStat = await stat(path);
  expect(fileStat.size).toBe(truth.size);
  const prefixLength = Math.min(truth.prefixBytes, fileStat.size);
  const prefix = new Uint8Array(prefixLength);
  const handle = await open(path, 'r');
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefixLength, 0);
    expect(bytesRead).toBe(prefixLength);
  } finally {
    await handle.close();
  }
  expect(createHash('sha256').update(prefix).digest('hex')).toBe(truth.prefixSha256);
  return prefixOnlySource(prefix, fileStat.size);
}

async function realVideoHintedUrlPrefixSource(truth: LongformTruth): Promise<PrefixSource> {
  const path = `${LONGFORM_DIR}${truth.file}`;
  const fileStat = await stat(path);
  expect(fileStat.size).toBe(truth.size);
  const prefixLength = Math.min(128 * 1024, fileStat.size);
  const prefix = new Uint8Array(prefixLength);
  const handle = await open(path, 'r');
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefixLength, 0);
    expect(bytesRead).toBe(prefixLength);
  } finally {
    await handle.close();
  }
  const { source, reads } = prefixOnlySource(prefix, fileStat.size);
  return {
    reads,
    source: {
      ...source,
      kind: 'url',
      mimeHint: 'video/mp4',
    } as VideoHintedUrlByteSource,
  };
}

function memoryRandomAccess(bytes: Uint8Array): {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
} {
  return {
    size: bytes.byteLength,
    read: (offset, length) =>
      Promise.resolve(bytes.subarray(offset, Math.min(bytes.byteLength, offset + length))),
  };
}

function concat(chunks: Iterable<Uint8Array>): Uint8Array {
  const list = [...chunks];
  const out = new Uint8Array(list.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of list) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface BoxSpan {
  readonly payloadStart: number;
  readonly end: number;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function findBox(bytes: Uint8Array, start: number, end: number, type: string): BoxSpan {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > end) break;
    if (fourcc(bytes, offset + 4) === type) {
      return { payloadStart: offset + 8, end: offset + size };
    }
    offset += size;
  }
  throw new Error(`missing ${type} box`);
}

function patchVersionZeroDuration(
  bytes: Uint8Array,
  box: BoxSpan,
  durationOffset: number,
  duration: number,
): void {
  if ((bytes[box.payloadStart] ?? 0) !== 0) throw new Error('expected a version-0 duration box');
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    box.payloadStart + durationOffset,
    duration,
  );
}

function addPositiveInitDurations(
  bytes: Uint8Array,
  trackDurationTicks: number,
  trackTimescale: number,
): Uint8Array {
  const out = bytes.slice();
  const moov = findBox(out, 0, out.byteLength, 'moov');
  const mvhd = findBox(out, moov.payloadStart, moov.end, 'mvhd');
  const trak = findBox(out, moov.payloadStart, moov.end, 'trak');
  const tkhd = findBox(out, trak.payloadStart, trak.end, 'tkhd');
  const mdia = findBox(out, trak.payloadStart, trak.end, 'mdia');
  const mdhd = findBox(out, mdia.payloadStart, mdia.end, 'mdhd');
  const movieDurationTicks = Math.round((trackDurationTicks * 1000) / trackTimescale);
  patchVersionZeroDuration(out, mvhd, 16, movieDurationTicks);
  patchVersionZeroDuration(out, tkhd, 20, movieDurationTicks);
  patchVersionZeroDuration(out, mdhd, 16, trackDurationTicks);
  return out;
}

function ensureProbeLargerThanPrefix(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > PROBE_PREFIX_BYTES) return bytes;
  const freeSize = PROBE_PREFIX_BYTES + 1 - bytes.byteLength;
  const boxSize = Math.max(8, freeSize);
  const out = new Uint8Array(bytes.byteLength + boxSize);
  out.set(bytes);
  const view = new DataView(out.buffer);
  view.setUint32(bytes.byteLength, boxSize);
  out.set([0x66, 0x72, 0x65, 0x65], bytes.byteLength + 4); // `free`
  return out;
}

let realAudioFragmentsPromise:
  | Promise<{ readonly zeroDuration: Uint8Array; readonly edited: Uint8Array }>
  | undefined;

function realAudioFragments(): Promise<{
  readonly zeroDuration: Uint8Array;
  readonly edited: Uint8Array;
}> {
  realAudioFragmentsPromise ??= (async () => {
    const input = await loadFixture('bear-av-frag.mp4');
    const ra = memoryRandomAccess(input);
    const movie = await readMovie(ra);
    const audio = (await muxTracksFromMovie(ra, movie)).find(
      (track) => track.mediaType === 'audio',
    );
    if (audio === undefined) throw new Error('real fragmented fixture has no audio track');
    const { edit: _edit, ...withoutEdit } = audio;
    const zeroDuration = ensureProbeLargerThanPrefix(concat(fragmentMp4([withoutEdit])));
    const trackDurationTicks = withoutEdit.samples.reduce(
      (total, sample) => total + sample.durationTicks,
      0,
    );
    const leadingTicks = Math.min(1024, Math.max(0, trackDurationTicks - 1));
    const editedTrack: MuxTrackInput = {
      ...withoutEdit,
      edit: {
        mediaTimeTicks: leadingTicks,
        durationTicks: trackDurationTicks - leadingTicks,
      },
    };
    const edited = ensureProbeLargerThanPrefix(
      addPositiveInitDurations(
        concat(fragmentMp4([editedTrack])),
        trackDurationTicks,
        withoutEdit.timescale,
      ),
    );
    return { zeroDuration, edited };
  })();
  return realAudioFragmentsPromise;
}

async function expectFragmentTimingInspection(
  bytes: Uint8Array,
  expectedReadPolicy: 'sparse' | 'bounded-prefix' | 'exact-fallback',
): Promise<void> {
  const reads: RangeRead[] = [];
  const source: ByteSource = {
    size: bytes.byteLength,
    range(start, end): Promise<Uint8Array> {
      reads.push({ start, end });
      return Promise.resolve(bytes.subarray(start, end));
    },
    stream(): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.error(new Error('fragment metadata probe must stay range-backed'));
        },
      });
    },
  };
  const tracks = await probeMp4(source);
  const demuxer = await Mp4Driver.demux(fromBytes(bytes, { mime: 'audio/mp4' }));
  try {
    expect(tracks).toEqual(demuxer.tracks);
  } finally {
    await demuxer.close();
  }
  expect(reads.length).toBeGreaterThan(0);
  const wholeRead = reads.some((read) => read.start === 0 && read.end === bytes.byteLength);
  if (expectedReadPolicy === 'sparse') {
    expect(wholeRead).toBe(false);
    expect(reads.reduce((total, read) => total + read.end - read.start, 0)).toBeLessThan(
      bytes.byteLength / 2,
    );
  } else if (expectedReadPolicy === 'bounded-prefix') {
    // These compact generated fixtures place every timing box in the ordinary prefix. Requiring no
    // exact whole read still proves the historical fallback scan is gone; a half-file ratio would be
    // meaningless because the parser's fixed 32 KiB prefetch is almost the entire 32 KiB fixture.
    expect(wholeRead).toBe(false);
    expect(reads.reduce((total, read) => total + read.end - read.start, 0)).toBeLessThanOrEqual(
      PROBE_PREFIX_BYTES,
    );
  } else {
    // Inputs whose timing metadata density or range count exceeds the sparse budget prove the
    // conservative exact parser remains reachable without weakening the payload-skip proof above.
    expect(wholeRead).toBe(true);
  }
}

describe('fragmented audio init-duration probe — four real fair-corpus rotations', () => {
  for (const truth of LONGFORM) {
    it(`${truth.file}: matches ffprobe from at most the initialization prefix`, async () => {
      const { source, reads } = await realPrefixSource(truth);
      const tracks = await probeMp4(source);
      expect(tracks).toHaveLength(1);
      const audio = tracks[0];
      expect(audio?.mediaType).toBe('audio');
      expect(audio?.codec).toMatch(/^mp4a/);
      // AAC's one-access-unit edit/priming representation may leave the raw mdhd span one 1024-sample
      // packet longer than ffprobe's presented duration. The existing probe contract exposes that raw
      // span alongside `gapless`; keep the independent truth within exactly one AAC packet.
      expect(Math.abs((audio?.durationSec ?? 0) - truth.durationSec)).toBeLessThanOrEqual(
        1024 / truth.sampleRate,
      );
      const config = audio?.config as AudioDecoderConfig | undefined;
      expect(config?.sampleRate).toBe(truth.sampleRate);
      expect(config?.numberOfChannels).toBe(truth.channels);
      expect(reads.every((read) => read.end <= REAL_PREFIX_LIMIT_BYTES)).toBe(true);
      expect(reads.some((read) => read.end === truth.size)).toBe(false);
    });
  }

  it('accepts complete audio-only init metadata on a generic .mp4 URL without reparsing its prefix', async () => {
    // Served `.mp4` files normally carry `video/mp4` even when the canonical moov proves they contain
    // only AAC. The video-oriented bounded parser has already parsed that complete moov, so routing the
    // same bytes through the generic metadata parser again is redundant.
    const truth = LONGFORM[0];
    if (truth === undefined) throw new Error('expected a longform audio fixture');
    const { source, reads } = await realVideoHintedUrlPrefixSource(truth);
    const tracks = await probeMp4(source);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      mediaType: 'audio',
      codec: 'mp4a.40.2',
    });
    expect(tracks[0]?.durationSec).toBeCloseTo(truth.durationSec, 5);
    expect(reads).toEqual([{ start: 0, end: 128 * 1024 }]);
  });
});

describe('fragmented audio init-duration probe — conservative fragment timing', () => {
  it('keeps a real video-bearing fragmented MP4 on the fragment timing path', async () => {
    await expectFragmentTimingInspection(await loadFixture('bear-av-frag.mp4'), 'sparse');
  });

  it('scans audio-only fragmented media with zero init duration', async () => {
    await expectFragmentTimingInspection(
      (await realAudioFragments()).zeroDuration,
      'bounded-prefix',
    );
  });

  it('scans positive-duration edited/gapless audio instead of trusting its init duration', async () => {
    await expectFragmentTimingInspection((await realAudioFragments()).edited, 'bounded-prefix');
  });

  it('scans a real hybrid stbl-plus-trun AAC file', async () => {
    const path = fileURLToPath(
      new URL(
        '../../../fixtures/media-derived/mp4-hybrid-fragmented/lc48-mono-long.m4a',
        import.meta.url,
      ),
    );
    await expectFragmentTimingInspection(new Uint8Array(await readFile(path)), 'exact-fallback');
  });

  it('still returns complete metadata when the fallback receives the whole real source', async () => {
    const bytes = (await realAudioFragments()).edited;
    const tracks = await probeMp4(fromBytes(bytes, { mime: 'audio/mp4' }));
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.durationSec ?? 0).toBeGreaterThan(0);
    expect(tracks[0]?.gapless).toBeDefined();
  });
});
