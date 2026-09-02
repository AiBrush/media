/**
 * Streamed whole-program ceiling routing (REQUIREMENTS §5.6, ADR-013 sink contract).
 *
 * A lazy streamed ISO→ISO copy whose projected program crosses
 * {@link STREAMED_WHOLE_PROGRAM_MAX_BYTES} must be authored as a valid fragmented program
 * (`ftyp` + `moov`/`mvex` init, then `moof`+`mdat` segments) — the append-only layout that stays
 * complete and range-publishable without any seek-back. Every declined shape (at/below the
 * ceiling, unknown size, explicit fragmented request already routed upstream, non-`mp4` brand
 * targets, protected movies, fragmented source movies, empty sample tables) keeps the exact
 * pre-existing progressive behavior. The decision is parameterized by reported bytes, container
 * capability, and movie shape — never by source identity.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { StreamCopyOptions } from '../../contracts/driver.ts';
import { STREAMED_WHOLE_PROGRAM_MAX_BYTES } from '../../internal/buffer-policy.ts';
import { fromBytes } from '../../sources/source.ts';
import type { Movie, ParsedTrack, TrackProtection } from './parse.ts';
import {
  Mp4Driver,
  readMovie,
  shouldFragmentBufferedIsoProgram,
  shouldFragmentStreamedIsoProgram,
} from './mp4-driver.ts';
import { buildSampleData } from './samples.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const CEIL = STREAMED_WHOLE_PROGRAM_MAX_BYTES;

const STREAMING_MP4: StreamCopyOptions = { streaming: true, container: 'mp4' };
const BUFFERED_MP4: StreamCopyOptions = { buffered: true, container: 'mp4' };

function randomAccessOf(bytes: Uint8Array) {
  return {
    read: (offset: number, length: number) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
    size: bytes.byteLength,
  };
}

/** A `Source` over real MP4 bytes with `size` overridden to model a program crossing the ceiling. */
function mp4SourceWithSize(bytes: Uint8Array, size: number | undefined): ReturnType<typeof fromBytes> {
  const src = fromBytes(bytes, { mime: 'video/mp4' });
  if (size === undefined) {
    Object.defineProperty(src, 'size', { value: undefined, configurable: true, enumerable: true });
    return src;
  }
  Object.defineProperty(src, 'size', { value: size, configurable: true, enumerable: true });
  return src;
}

async function mp4Bytes(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await readFile(`${ROOT}fixtures/media/movie_5.mp4`));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface TopBox {
  readonly type: string;
  readonly start: number;
  readonly size: number;
}

function topLevelBoxes(bytes: Uint8Array): TopBox[] {
  const boxes: TopBox[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    let size = dv.getUint32(offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    if (size === 1) {
      size = Number(dv.getBigUint64(offset + 8));
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }
    boxes.push({ type, start: offset, size });
    offset += size;
  }
  return boxes;
}

function containsFourcc(bytes: Uint8Array, start: number, end: number, fourcc: string): boolean {
  const target = [fourcc.charCodeAt(0), fourcc.charCodeAt(1), fourcc.charCodeAt(2), fourcc.charCodeAt(3)];
  for (let i = start; i + 4 <= end; i++) {
    if (bytes[i] === target[0] && bytes[i + 1] === target[1] && bytes[i + 2] === target[2] && bytes[i + 3] === target[3]) {
      return true;
    }
  }
  return false;
}

/** mfhd sequence_number of a `moof` box (moof → mfhd is its first child). */
function moofSequence(bytes: Uint8Array, moof: TopBox): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(moof.start + 8 + 8 + 4);
}

function sampleBytesTotal(movie: Movie): number {
  return movie.tracks.reduce(
    (total, track) => total + buildSampleData(track).reduce((sum, s) => sum + s.size, 0),
    0,
  );
}

describe('streamed ISO copy — whole-program ceiling fragments the layout', () => {
  it('unit: a copy above the ceiling authors init + moof/mdat segments with verbatim payloads', async () => {
    const bytes = await mp4Bytes();
    const sourceMovie = await readMovie(randomAccessOf(bytes));
    const output = await collect(
      await Mp4Driver.streamCopy!(mp4SourceWithSize(bytes, CEIL + 1), STREAMING_MP4),
    );
    const boxes = topLevelBoxes(output);
    expect(boxes[0]?.type).toBe('ftyp');
    expect(boxes[1]?.type).toBe('moov');
    const fragments = boxes.filter((box) => box.type === 'moof');
    expect(fragments.length).toBeGreaterThan(0);
    // Every fragment is immediately followed by its media data; trailing payload closes the file.
    const mdats = boxes.filter((box) => box.type === 'mdat');
    expect(mdats.length).toBe(fragments.length);
    for (const [index, moof] of fragments.entries()) {
      const mdat = mdats[index];
      expect(mdat?.start).toBe(moof.start + moof.size);
    }
    expect(boxes[boxes.length - 1]!.start + boxes[boxes.length - 1]!.size).toBe(output.byteLength);
    // The init `moov` declares the fragment defaults.
    const initMoov = boxes[1]!;
    expect(containsFourcc(output, initMoov.start, initMoov.start + initMoov.size, 'mvex')).toBe(true);
    // Sequence numbers strictly increase from 1.
    expect(fragments.map((moof) => moofSequence(output, moof))).toEqual(
      fragments.map((_, index) => index + 1),
    );
    // Strict copy: every coded byte is retained, nothing added or dropped.
    const payloadBytes = mdats.reduce((total, mdat) => total + mdat.size - 8, 0);
    expect(payloadBytes).toBe(sampleBytesTotal(sourceMovie));
  });

  it('unit: a copy at the real (below-ceiling) size keeps the progressive moov layout', async () => {
    const bytes = await mp4Bytes();
    const output = await collect(await Mp4Driver.streamCopy!(fromBytes(bytes, { mime: 'video/mp4' }), STREAMING_MP4));
    const boxes = topLevelBoxes(output);
    expect(boxes.some((box) => box.type === 'moof')).toBe(false);
    expect(boxes.some((box) => box.type === 'moov')).toBe(true);
    expect(boxes.some((box) => box.type === 'mdat')).toBe(true);
  });

  it('boundary: exactly the ceiling stays progressive, ceiling + 1 fragments, unknown size stays progressive', async () => {
    const bytes = await mp4Bytes();
    const exact = await collect(await Mp4Driver.streamCopy!(mp4SourceWithSize(bytes, CEIL), STREAMING_MP4));
    expect(topLevelBoxes(exact).some((box) => box.type === 'moof')).toBe(false);
    const over = await collect(await Mp4Driver.streamCopy!(mp4SourceWithSize(bytes, CEIL + 1), STREAMING_MP4));
    expect(topLevelBoxes(over).some((box) => box.type === 'moof')).toBe(true);
    const unknown = await collect(
      await Mp4Driver.streamCopy!(mp4SourceWithSize(bytes, undefined), STREAMING_MP4),
    );
    expect(topLevelBoxes(unknown).some((box) => box.type === 'moof')).toBe(false);
  });

  it('malformed: declined shapes never fragment and never throw at the decision point', async () => {
    const bytes = await mp4Bytes();
    const plain = await readMovie(randomAccessOf(bytes));
    const encrypt = (movie: Movie): Movie => ({
      ...movie,
      tracks: movie.tracks.map(
        (track) =>
          ({ ...track, encryption: {} as unknown as TrackProtection }) as unknown as ParsedTrack,
      ),
    });
    const emptyTable = (movie: Movie): Movie => ({
      ...movie,
      tracks: movie.tracks.map(
        (track) =>
          ({
            ...track,
            samples: { ...track.samples, sampleSizes: [] as unknown as Uint32Array },
          }) as unknown as ParsedTrack,
      ),
    });
    // Every case below carries an above-ceiling size — the shape/container/flag must be what
    // declines the fragmented layout, not the byte threshold.
    const cases: ReadonlyArray<readonly [string, Movie, StreamCopyOptions | undefined]> = [
      ['protected movie', encrypt(plain), STREAMING_MP4],
      ['empty sample table', emptyTable(plain), STREAMING_MP4],
      ['no tracks', { ...plain, tracks: [] }, STREAMING_MP4],
      ['mov brand target', plain, { ...STREAMING_MP4, container: 'mov' }],
      ['ts target', plain, { ...STREAMING_MP4, container: 'ts' }],
      ['explicit fragmented request routed upstream', plain, { ...STREAMING_MP4, fragmented: true }],
      ["faststart:'reserve' positioned contract", plain, { ...STREAMING_MP4, faststart: 'reserve' }],
      ['buffered (whole-buffer) copy shape', plain, { container: 'mp4', buffered: true }],
    ] as const;
    for (const [label, movie, opts] of cases) {
      expect(shouldFragmentStreamedIsoProgram(CEIL + 1, movie, opts), label).toBe(false);
    }
    // A fragmented source movie declines regardless of size (whole-file recovery budget is below).
    const fragmentedMovie = {
      ...plain,
      hasFragments: true,
    } as Movie;
    expect(shouldFragmentStreamedIsoProgram(CEIL + 1, fragmentedMovie, STREAMING_MP4)).toBe(false);
    // The only shape that fragments: plain unfragmented mp4-brand movie above the ceiling.
    expect(shouldFragmentStreamedIsoProgram(CEIL + 1, plain, STREAMING_MP4)).toBe(true);
  });

  it('randomized: the decision is exactly (size above ceiling) ∧ (plain unfragmented mp4-brand shape)', async () => {
    const bytes = await mp4Bytes();
    const plain = await readMovie(randomAccessOf(bytes));
    let seed = 0x9e3779b9;
    const rand = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let i = 0; i < 200; i++) {
      const base = CEIL + Math.floor((rand() - 0.5) * 4 * 1024 * 1024);
      const size = rand() < 0.1 ? undefined : base;
      const container = pick(rand, ['mp4', 'mov', 'qt', 'ts', undefined]);
      const fragmented = rand() < 0.15;
      const protectedTrack = rand() < 0.15;
      const movie = {
        ...plain,
        ...(fragmented ? { hasFragments: true } : {}),
        tracks: protectedTrack
          ? plain.tracks.map(
              (track) =>
                ({ ...track, encryption: {} as unknown as TrackProtection }) as unknown as ParsedTrack,
            )
          : plain.tracks,
      } as unknown as Movie;
      const opts: StreamCopyOptions = { streaming: true, ...(container ? { container } : {}) };
      const expected =
        size !== undefined &&
        size > CEIL &&
        (container ?? 'mp4') === 'mp4' &&
        !fragmented &&
        !protectedTrack &&
        plain.tracks.length > 0;
      expect(shouldFragmentStreamedIsoProgram(size, movie, opts)).toBe(expected);
    }
  });
});

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)] as T;
}

describe('buffered ISO copy — whole-program ceiling fragments the layout', () => {
  it('unit: a buffered copy above the ceiling authors init + moof/mdat segments (range-artifact completeness)', async () => {
    const bytes = await mp4Bytes();
    const sourceMovie = await readMovie(randomAccessOf(bytes));
    const output = await collect(await Mp4Driver.streamCopy!(mp4SourceWithSize(bytes, CEIL + 1), BUFFERED_MP4));
    const boxes = topLevelBoxes(output);
    expect(boxes[0]?.type).toBe('ftyp');
    expect(boxes[1]?.type).toBe('moov');
    const fragments = boxes.filter((box) => box.type === 'moof');
    expect(fragments.length).toBeGreaterThan(0);
    const mdats = boxes.filter((box) => box.type === 'mdat');
    expect(mdats.length).toBe(fragments.length);
    expect(fragments.map((moof) => moofSequence(output, moof))).toEqual(fragments.map((_, i) => i + 1));
    const payloadBytes = mdats.reduce((t, m) => t + m.size - 8, 0);
    expect(payloadBytes).toBe(sampleBytesTotal(sourceMovie));
  });

  it('property: buffered fragmented decision is idempotent across repeated calls', async () => {
    const bytes = await mp4Bytes();
    const plain = await readMovie(randomAccessOf(bytes));
    const a = shouldFragmentBufferedIsoProgram(CEIL + 1, plain, BUFFERED_MP4);
    const b = shouldFragmentBufferedIsoProgram(CEIL + 1, plain, BUFFERED_MP4);
    expect(a).toBe(true);
    expect(b).toBe(a);
    expect(shouldFragmentBufferedIsoProgram(CEIL, plain, BUFFERED_MP4)).toBe(false);
  });

  it('boundary: exactly the ceiling stays progressive, ceiling + 1 fragments for buffered', async () => {
    const bytes = await mp4Bytes();
    const exact = await collect(await Mp4Driver.streamCopy!(mp4SourceWithSize(bytes, CEIL), BUFFERED_MP4));
    expect(topLevelBoxes(exact).some((b) => b.type === 'moof')).toBe(false);
    const over = await collect(await Mp4Driver.streamCopy!(mp4SourceWithSize(bytes, CEIL + 1), BUFFERED_MP4));
    expect(topLevelBoxes(over).some((b) => b.type === 'moof')).toBe(true);
  });

  it('malformed: declined buffered shapes never fragment (protected/empty/mov/reserve)', async () => {
    const bytes = await mp4Bytes();
    const plain = await readMovie(randomAccessOf(bytes));
    const encrypt = (movie: Movie): Movie => ({
      ...movie,
      tracks: movie.tracks.map(
        (track) => ({ ...track, encryption: {} as unknown as TrackProtection }) as unknown as ParsedTrack,
      ),
    });
    const cases: ReadonlyArray<readonly [string, Movie, StreamCopyOptions | undefined]> = [
      ['protected', encrypt(plain), BUFFERED_MP4],
      ['no tracks', { ...plain, tracks: [] }, BUFFERED_MP4],
      ['mov brand', plain, { ...BUFFERED_MP4, container: 'mov' }],
      ['fragmented flag', plain, { ...BUFFERED_MP4, fragmented: true }],
      ["reserve", plain, { ...BUFFERED_MP4, faststart: 'reserve' }],
    ] as const;
    for (const [label, movie, opts] of cases) {
      expect(shouldFragmentBufferedIsoProgram(CEIL + 1, movie, opts), label).toBe(false);
    }
    expect(shouldFragmentBufferedIsoProgram(CEIL + 1, { ...plain, hasFragments: true } as Movie, BUFFERED_MP4)).toBe(false);
    expect(shouldFragmentBufferedIsoProgram(CEIL + 1, plain, BUFFERED_MP4)).toBe(true);
  });

  it('randomized: buffered decision is exactly (size above ceiling) ∧ (plain mp4 shape)', async () => {
    const bytes = await mp4Bytes();
    const plain = await readMovie(randomAccessOf(bytes));
    let seed = 0x12345678;
    const rand = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let i = 0; i < 200; i++) {
      const base = CEIL + Math.floor((rand() - 0.5) * 4 * 1024 * 1024);
      const size = rand() < 0.1 ? undefined : base;
      const container = pick(rand, ['mp4', 'mov', 'qt', 'ts', undefined]);
      const protectedTrack = rand() < 0.15;
      const movie = {
        ...plain,
        ...(rand() < 0.1 ? { hasFragments: true } : {}),
        tracks: protectedTrack
          ? plain.tracks.map((t) => ({ ...t, encryption: {} as unknown as TrackProtection }) as unknown as ParsedTrack)
          : plain.tracks,
      } as unknown as Movie;
      const opts: StreamCopyOptions = { buffered: true, ...(container ? { container } : {}) };
      const expected =
        size !== undefined &&
        size > CEIL &&
        (container ?? 'mp4') === 'mp4' &&
        !protectedTrack &&
        plain.tracks.length > 0 &&
        !(movie as Movie).hasFragments;
      expect(shouldFragmentBufferedIsoProgram(size, movie as Movie, opts)).toBe(expected);
    }
  });
});
