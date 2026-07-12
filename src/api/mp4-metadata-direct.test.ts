import { describe, expect, it } from 'vitest';
import type { Progress } from '../contracts/driver.ts';
import { muxTracksFromMovie, readMovie } from '../drivers/mp4/mp4-driver.ts';
import { canWriteMp4TagsDirectly, readMp4Tags } from '../metadata/mp4-tags.ts';
import { toBlob } from '../sinks/sink.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { createMedia } from './create-media.ts';
import { planRemuxMetadata, tryRewriteMp4MetadataBlobDirectly } from './remux-metadata.ts';

interface RandomAccess {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

interface TopLevelBox {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

interface BlobRead {
  readonly start: number;
  readonly end: number;
}

class ObservedBlob extends Blob {
  readonly #origin: number;
  readonly #reads: BlobRead[];

  constructor(
    parts: readonly BlobPart[],
    options: BlobPropertyBag,
    reads: BlobRead[] = [],
    origin = 0,
  ) {
    super([...parts], options);
    this.#reads = reads;
    this.#origin = origin;
  }

  get reads(): readonly BlobRead[] {
    return this.#reads;
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    this.#reads.push({ start: this.#origin, end: this.#origin + this.size });
    return super.arrayBuffer();
  }

  override slice(start = 0, end = this.size, contentType = ''): Blob {
    const normalizedStart = Math.min(this.size, Math.max(0, start < 0 ? this.size + start : start));
    const normalizedEnd = Math.min(this.size, Math.max(0, end < 0 ? this.size + end : end));
    const boundedEnd = Math.max(normalizedStart, normalizedEnd);
    return new ObservedBlob(
      [super.slice(normalizedStart, boundedEnd, contentType)],
      { type: contentType },
      this.#reads,
      this.#origin + normalizedStart,
    );
  }
}

const TAGS = {
  title: 'Direct metadata truth',
  artist: 'aibrush-media',
  comment: 'preserve every packet and container clock',
  trackNumber: '11',
};

function ra(bytes: Uint8Array): RandomAccess {
  return {
    size: bytes.byteLength,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function indexOfFourcc(bytes: Uint8Array, type: string): number {
  const values = [...type].map((value) => value.charCodeAt(0));
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset++) {
    if (
      bytes[offset] === values[0] &&
      bytes[offset + 1] === values[1] &&
      bytes[offset + 2] === values[2] &&
      bytes[offset + 3] === values[3]
    ) {
      return offset;
    }
  }
  return -1;
}

function topLevelBoxes(bytes: Uint8Array): readonly TopLevelBox[] {
  const out: TopLevelBox[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size = readU32(bytes, offset);
    const end = size === 0 ? bytes.byteLength : offset + size;
    if (size !== 0 && (size < 8 || end > bytes.byteLength))
      throw new Error('invalid top-level box');
    out.push({
      type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
      start: offset,
      end,
    });
    offset = end;
  }
  if (offset !== bytes.byteLength) throw new Error('trailing bytes after top-level boxes');
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function emptyBox(type: string): Uint8Array {
  if ([...type].length !== 4) throw new Error('box type must be one fourcc');
  return Uint8Array.of(
    0,
    0,
    0,
    8,
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  );
}

function appendMoovChild(bytes: Uint8Array, type: string): Uint8Array {
  const moov = topLevelBoxes(bytes).find((box) => box.type === 'moov');
  if (moov === undefined) throw new Error('missing moov');
  const patchedMoov = concat([bytes.subarray(moov.start, moov.end), emptyBox(type)]);
  writeU32(patchedMoov, 0, patchedMoov.byteLength);
  return concat([bytes.subarray(0, moov.start), patchedMoov, bytes.subarray(moov.end)]);
}

function withoutMoov(bytes: Uint8Array): Uint8Array {
  return concat(
    topLevelBoxes(bytes)
      .filter((box) => box.type !== 'moov')
      .map((box) => bytes.subarray(box.start, box.end)),
  );
}

function withMajorBrand(bytes: Uint8Array, brand: string): Uint8Array {
  const output = bytes.slice();
  const ftyp = topLevelBoxes(output).find((box) => box.type === 'ftyp');
  if (ftyp === undefined || [...brand].length !== 4)
    throw new Error('missing ftyp or invalid brand');
  for (let index = 0; index < 4; index++) {
    output[ftyp.start + 8 + index] = brand.charCodeAt(index);
  }
  return output;
}

async function outputBytes(output: unknown): Promise<Uint8Array> {
  if (!(output instanceof Blob)) throw new Error('expected Blob output');
  return new Uint8Array(await output.arrayBuffer());
}

describe('MP4 metadata-only direct rewrite', () => {
  it('rewrites a default Blob without reading mdat and exactly matches the owned-byte route', async () => {
    const input = await loadFixture('obs-remux-variable-aac.mp4');
    const expected = await outputBytes(await createMedia().remux(input, { to: 'mp4', tags: TAGS }));
    const blob = new ObservedBlob([input], { type: 'video/mp4' });

    const output = await createMedia().remux(blob, { to: 'mp4', tags: TAGS });

    expect(output).toBeInstanceOf(Blob);
    if (!(output instanceof Blob)) return;
    expect(output).not.toBe(blob);
    expect(output.type).toBe('video/mp4');
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(expected);
    expect(blob.reads).not.toContainEqual({ start: 0, end: input.byteLength });
    expect(blob.reads.reduce((total, read) => total + read.end - read.start, 0)).toBeLessThan(
      input.byteLength,
    );
  });

  it.each(['h264.mp4', 'movie_5.mp4', 'test.mp4', '2x2-green.mp4', 'av1.mp4'])(
    'preserves every non-metadata byte and exact sample/config/timing truth: %s',
    async (fixture) => {
      const input = await loadFixture(fixture);
      const expected = await outputBytes(
        await createMedia().remux(input, { to: 'mp4', tags: TAGS }),
      );
      const blob = new ObservedBlob([input], { type: 'video/mp4' });
      const output = await outputBytes(await createMedia().remux(blob, { to: 'mp4', tags: TAGS }));

      expect(output).toEqual(expected);
      expect(blob.reads).not.toContainEqual({ start: 0, end: input.byteLength });

      expect(readMp4Tags(output)).toMatchObject(TAGS);
      expect(withoutMoov(output)).toEqual(withoutMoov(input));

      const beforeMovie = await readMovie(ra(input));
      const afterMovie = await readMovie(ra(output));
      expect({
        brand: afterMovie.brand,
        timescale: afterMovie.timescale,
        durationSec: afterMovie.durationSec,
        otherTracks: afterMovie.otherTracks,
      }).toEqual({
        brand: beforeMovie.brand,
        timescale: beforeMovie.timescale,
        durationSec: beforeMovie.durationSec,
        otherTracks: beforeMovie.otherTracks,
      });
      expect(await muxTracksFromMovie(ra(output), afterMovie)).toEqual(
        await muxTracksFromMovie(ra(input), beforeMovie),
      );
    },
  );

  it('retains the established whole-byte path for an explicit Blob sink', async () => {
    const input = await loadFixture('movie_5.mp4');
    const blob = new ObservedBlob([input], { type: 'video/mp4' });
    const expected = await outputBytes(await createMedia().remux(input, { to: 'mp4', tags: TAGS }));

    const output = await outputBytes(
      await createMedia().remux(blob, { to: 'mp4', tags: TAGS, sink: toBlob() }),
    );

    expect(output).toEqual(expected);
    expect(blob.reads).toContainEqual({ start: 0, end: input.byteLength });
  });

  it('uses the same exact default path for a File input when the runtime exposes File', async () => {
    if (typeof File === 'undefined') return;
    const input = await loadFixture('movie_5.mp4');
    const expected = await outputBytes(await createMedia().remux(input, { to: 'mp4', tags: TAGS }));
    const file = new File([Uint8Array.from(input)], 'movie.mp4', { type: 'video/mp4' });

    const output = await createMedia().remux(file, { to: 'mp4', tags: TAGS });

    expect(output).toBeInstanceOf(Blob);
    if (!(output instanceof Blob)) return;
    expect(output).not.toBe(file);
    expect(output.type).toBe('video/mp4');
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(expected);
  });

  it('keeps direct Blob progress monotonic and rejects a pre-aborted call before reading', async () => {
    const input = await loadFixture('movie_5.mp4');
    const blob = new ObservedBlob([input], { type: 'video/mp4' });
    const progress: Progress[] = [];

    await createMedia().remux(
      blob,
      { to: 'mp4', tags: TAGS },
      { onProgress: (value) => progress.push(value) },
    );

    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({
      done: 1,
      total: 2,
      stage: 'remux:metadata-direct-source',
    });
    expect(progress[1]).toMatchObject({ done: 2, total: 2, stage: 'metadata:metadata' });
    const abortedBlob = new ObservedBlob([input], { type: 'video/mp4' });
    const abort = new AbortController();
    abort.abort('metadata caller stopped');
    await expect(
      createMedia().remux(abortedBlob, { to: 'mp4', tags: TAGS }, { signal: abort.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(abortedBlob.reads).toEqual([]);
  });

  it('declines unsafe, indexed, mixed-layout, and malformed Blob topologies before output', async () => {
    const ordinary = await loadFixture('h264.mp4');
    const fragmented = await loadFixture('bear-av-frag.mp4');
    const variants = [
      withMajorBrand(ordinary, 'qt  '),
      fragmented,
      concat([ordinary, emptyBox('sidx')]),
      concat([ordinary, emptyBox('uuid')]),
      concat([ordinary, emptyBox('mdat')]),
      appendMoovChild(ordinary, 'saio'),
      appendMoovChild(ordinary, 'iloc'),
      ordinary.subarray(0, ordinary.byteLength - 1),
    ];
    const plan = planRemuxMetadata('mp4', TAGS);
    for (const bytes of variants) {
      const blob = new ObservedBlob([Uint8Array.from(bytes)], { type: 'video/mp4' });
      await expect(tryRewriteMp4MetadataBlobDirectly(blob, plan)).resolves.toBeUndefined();
      expect(blob.reads).not.toContainEqual({ start: 0, end: bytes.byteLength });
    }
  });

  it('accepts ordinary real MP4 layouts but declines fragmented, malformed, and qt-to-MP4 shapes', async () => {
    const ordinary = await loadFixture('movie_5.mp4');
    const fragmented = await loadFixture('bear-av-frag.mp4');
    const quickTime = withMajorBrand(ordinary, 'qt  ');

    expect(canWriteMp4TagsDirectly(ordinary, 'mp4')).toBe(true);
    expect(canWriteMp4TagsDirectly(ordinary, 'mov')).toBe(false);
    expect(canWriteMp4TagsDirectly(fragmented, 'mp4')).toBe(false);
    expect(canWriteMp4TagsDirectly(quickTime, 'mp4')).toBe(false);
    expect(canWriteMp4TagsDirectly(quickTime, 'mov')).toBe(true);
    expect(canWriteMp4TagsDirectly(ordinary.subarray(0, ordinary.byteLength - 1), 'mp4')).toBe(
      false,
    );
  });

  it('keeps exact source brand class on direct output and performs cross-brand requests via remux', async () => {
    const ordinary = await loadFixture('movie_5.mp4');
    const quickTime = withMajorBrand(ordinary, 'qt  ');
    const directMp4 = await outputBytes(
      await createMedia().remux(ordinary, { to: 'mp4', tags: TAGS }),
    );
    const directMov = await outputBytes(
      await createMedia().remux(quickTime, { to: 'mov', tags: TAGS }),
    );
    const crossToMov = await outputBytes(
      await createMedia().remux(ordinary, { to: 'mov', tags: TAGS }),
    );
    const crossToMp4 = await outputBytes(
      await createMedia().remux(quickTime, { to: 'mp4', tags: TAGS }),
    );
    const crossBrandBlob = new ObservedBlob([Uint8Array.from(quickTime)], {
      type: 'video/quicktime',
    });
    const crossBlobToMp4 = await outputBytes(
      await createMedia().remux(crossBrandBlob, { to: 'mp4', tags: TAGS }),
    );

    expect(String.fromCharCode(...directMp4.subarray(8, 12))).toBe('isom');
    expect(String.fromCharCode(...directMov.subarray(8, 12))).toBe('qt  ');
    // The established MP4/MOV writer intentionally emits playback-safe ISO branding for authored MOV.
    expect(String.fromCharCode(...crossToMov.subarray(8, 12))).toBe('isom');
    expect(String.fromCharCode(...crossToMp4.subarray(8, 12))).toBe('isom');
    expect(withoutMoov(directMp4)).toEqual(withoutMoov(ordinary));
    expect(withoutMoov(directMov)).toEqual(withoutMoov(quickTime));
    expect(withoutMoov(crossToMov)).not.toEqual(withoutMoov(ordinary));
    expect(withoutMoov(crossToMp4)).not.toEqual(withoutMoov(quickTime));
    expect(crossBlobToMp4).toEqual(crossToMp4);
    expect(crossBrandBlob.reads).toContainEqual({ start: 0, end: quickTime.byteLength });
  });

  it('rejects a chunk whose first complete sample escapes its declared mdat', async () => {
    const input = (await loadFixture('h264.mp4')).slice();
    const mdat = topLevelBoxes(input).find((box) => box.type === 'mdat');
    const stcoTypeOffset = indexOfFourcc(input, 'stco');
    if (mdat === undefined || stcoTypeOffset < 4) throw new Error('fixture lacks mdat/stco');
    // stco = size/type/version+flags/entry_count/entries. Point the first chunk at the final media byte:
    // the scalar offset is inside mdat, but its first declared sample necessarily crosses the box end.
    writeU32(input, stcoTypeOffset + 12, mdat.end - 1);
    expect(canWriteMp4TagsDirectly(input, 'mp4')).toBe(true);

    await expect(createMedia().remux(input, { to: 'mp4', tags: TAGS })).rejects.toMatchObject({
      code: 'demux-error',
    });
    const blob = new ObservedBlob([input], { type: 'video/mp4' });
    await expect(createMedia().remux(blob, { to: 'mp4', tags: TAGS })).rejects.toMatchObject({
      code: 'demux-error',
    });
    expect(blob.reads).not.toContainEqual({ start: 0, end: input.byteLength });
  });

  it('materializes a one-shot declined source once, then replays owned bytes through normal remux', async () => {
    const ordinary = await loadFixture('movie_5.mp4');
    const input = withMajorBrand(ordinary, 'qt  ');
    let emitted = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller): void {
        emitted++;
        controller.enqueue(input);
        controller.close();
      },
    });

    const output = await outputBytes(await createMedia().remux(source, { to: 'mp4', tags: TAGS }));
    expect(emitted).toBe(1);
    expect(readMp4Tags(output)).toMatchObject(TAGS);
    expect(String.fromCharCode(...output.subarray(8, 12))).toBe('isom');

    const beforeMovie = await readMovie(ra(input));
    const afterMovie = await readMovie(ra(output));
    expect(await muxTracksFromMovie(ra(output), afterMovie)).toEqual(
      await muxTracksFromMovie(ra(input), beforeMovie),
    );
  });
});
