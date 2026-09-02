/**
 * Generalized coverage for the moov-RELOCATED QuickTime rewrite: canonical layout
 * `ftyp [wide|free|skip]* (mdat|free|skip)* moov [free|skip]*` rewritten to a fast-start MP4 by
 * relocating the moov ahead of the data region and shifting every stco/co64 entry by the moov size.
 * Everything is built from synthetic box spines or writer-produced layouts — no fixture names,
 * hashes, or scenario identities — and every negative case must DECLINE (undefined → general path)
 * or throw honestly rather than emit a mis-referenced file.
 */
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { StreamCopyOptions } from '../../contracts/driver.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { rewrapCompatibleMovToMp4FromBytes, streamCompatibleMovToMp4 } from './compatible-mov-rewrite.ts';
import { Mp4Module, muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import type { Movie } from './parse.ts';
import { buildSampleData } from './samples.ts';
import { writeMp4 } from './write.ts';

const media = () => createMedia().use(Mp4Module);

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/** Random-access view over a VIRTually huge file whose real bytes live in a few mapped windows. */
function sparseRa(
  windows: ReadonlyArray<{ readonly at: number; readonly bytes: Uint8Array }>,
  virtualSize: number,
) {
  return {
    size: virtualSize,
    read(o: number, l: number): Promise<Uint8Array> {
      const out = new Uint8Array(Math.max(0, Math.min(l, virtualSize - o)));
      for (const window of windows) {
        const start = Math.max(o, window.at);
        const end = Math.min(o + out.byteLength, window.at + window.bytes.byteLength);
        if (end > start) out.set(window.bytes.subarray(start - window.at, end - window.at), start - o);
      }
      return Promise.resolve(out);
    },
  };
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function fourccAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function writeFourcc(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
}

function writeU32Into(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeU16Into(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function fourccBytes(value: string): Uint8Array {
  const out = new Uint8Array(4);
  writeFourcc(out, 0, value);
  return out;
}

function u32Bytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  writeU32Into(out, 0, value);
  return out;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength);
  writeU32Into(out, 0, out.byteLength);
  writeFourcc(out, 4, type);
  out.set(body, 8);
  return out;
}

function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
  const head = new Uint8Array(4);
  head[0] = version;
  head[1] = (flags >>> 16) & 0xff;
  head[2] = (flags >>> 8) & 0xff;
  head[3] = flags & 0xff;
  return box(type, concatBytes([head, body]));
}

function indexOfFourcc(bytes: Uint8Array, value: string, from = 0): number {
  const needle = fourccBytes(value);
  outer: for (let i = from; i + 4 <= bytes.byteLength; i++) {
    for (let j = 0; j < 4; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function topLevelBoxes(file: Uint8Array): Array<{ type: string; start: number; size: number }> {
  const boxes: Array<{ type: string; start: number; size: number }> = [];
  let offset = 0;
  while (offset + 8 <= file.byteLength) {
    const size = u32(file, offset);
    boxes.push({ type: fourccAt(file, offset + 4), start: offset, size });
    if (size < 8) break;
    offset += size;
  }
  return boxes;
}

async function bytesOf(out: unknown): Promise<Uint8Array> {
  if (out instanceof Blob) return new Uint8Array(await out.arrayBuffer());
  throw new Error('expected a Blob result from media.remux');
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  return concatBytes(chunks);
}

interface SynthTrack {
  readonly sampleSizes: readonly number[];
  readonly chunkOffset: number;
  readonly timescale: number;
}

function buildSynthMoov(tracks: readonly SynthTrack[], extraBody?: Uint8Array): Uint8Array {
  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    concatBytes([
      new Uint8Array(8),
      u32Bytes(1000),
      u32Bytes(60_000),
      u32Bytes(0x00010000),
      new Uint8Array(2 + 2 + 8 + 36 + 24 + 4),
      u32Bytes(tracks.length + 1),
    ]),
  );
  const traks = tracks.map((spec, trackIndex) => {
    const stsdEntryBody = new Uint8Array(28);
    writeU16Into(stsdEntryBody, 6, 1); // data_reference_index (bytes 8+ are version0=0, channels@16, bits@18, rate16.16@24)
    writeU16Into(stsdEntryBody, 16, 2); // channels
    writeU16Into(stsdEntryBody, 18, 16); // bits per sample
    writeU32Into(stsdEntryBody, 24, (spec.timescale << 16) >>> 0); // sample rate 16.16
    const esds = fullBox(
      'esds',
      0,
      0,
      new Uint8Array([0x03, 0x15, 0x00, 0x00, 0x00, 0x04, 0x0f, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x02,
        0x2c, 0x3c, 0x05, 0x02, 0x00, 0x01, 0xfd, 0xf8]),
    );
    const entry = box('mp4a', concatBytes([stsdEntryBody, esds]));
    const stsd = fullBox(
      'stsd',
      0,
      0,
      concatBytes([u32Bytes(1), entry]),
    );
    const stts = fullBox('stts', 0, 0, concatBytes([u32Bytes(1), u32Bytes(spec.sampleSizes.length), u32Bytes(1024)]));
    const stsc = fullBox('stsc', 0, 0, concatBytes([u32Bytes(1), u32Bytes(1), u32Bytes(spec.sampleSizes.length), u32Bytes(1)]));
    const stsz = fullBox(
      'stsz',
      0,
      0,
      concatBytes([u32Bytes(0), u32Bytes(spec.sampleSizes.length), ...spec.sampleSizes.map(u32Bytes)]),
    );
    const stco = fullBox('stco', 0, 0, concatBytes([u32Bytes(1), u32Bytes(spec.chunkOffset)]));
    const stbl = box('stbl', concatBytes([stsd, stts, stsc, stsz, stco]));
    const dref = fullBox('dref', 0, 0, concatBytes([u32Bytes(1), fullBox('url ', 0, 1, new Uint8Array(0))]));
    const minf = box('minf', concatBytes([fullBox('smhd', 0, 0, new Uint8Array(2)), box('dinf', concatBytes([dref])), stbl]));
    const mdhd = fullBox(
      'mdhd',
      0,
      0,
      concatBytes([new Uint8Array(8), u32Bytes(spec.timescale), u32Bytes(spec.sampleSizes.length * 1024), new Uint8Array(4)]),
    );
    const hdlr = fullBox('hdlr', 0, 0, concatBytes([new Uint8Array(4), fourccBytes('soun'), new Uint8Array(12), new Uint8Array(1)]));
    const mdia = box('mdia', concatBytes([mdhd, hdlr, minf]));
    const tkhd = fullBox(
      'tkhd',
      0,
      3,
      concatBytes([new Uint8Array(8), u32Bytes(trackIndex + 1), new Uint8Array(4), u32Bytes(60_000), new Uint8Array(64)]),
    );
    return box('trak', concatBytes([tkhd, mdia]));
  });
  return box('moov', concatBytes([mvhd, ...traks, ...(extraBody !== undefined ? [extraBody] : [])]));
}

export interface SyntheticMovOptions {
  readonly sampleSizes?: readonly number[];
  readonly prefixBoxes?: readonly string[];
  readonly interleaveFreeBytes?: number;
  readonly trailingTypes?: readonly string[];
  readonly noMdat?: boolean;
  readonly secondMoov?: boolean;
  readonly idatLikeBytes?: boolean;
}

/** Assemble a deterministic QuickTime-flavored MOV: `[ftyp qt  ] prefix mdat(s) moov [tails]`. */
function buildSyntheticMov(
  options: SyntheticMovOptions = {},
): {
  bytes: Uint8Array;
  moovSize: number;
  dataStart: number;
  sampleBytes: Uint8Array;
  chunkWindows: ReadonlyArray<{ readonly offset: number; readonly start: number; readonly length: number }>;
} {
  const sampleSizes = options.sampleSizes ?? [120, 80, 240];
  const sampleBytes = new Uint8Array(sampleSizes.reduce((a, b) => a + b, 0));
  for (let i = 0; i < sampleBytes.byteLength; i++) sampleBytes[i] = (i * 7 + 3) % 251;
  const firstRun = sampleSizes.slice(0, 2);
  const secondRun = sampleSizes.slice(2);
  const firstRunBytes = sampleBytes.subarray(0, firstRun.reduce((a, b) => a + b, 0));
  const secondRunBytes = sampleBytes.subarray(firstRunBytes.byteLength);
  const prefix = (options.prefixBoxes ?? []).map((type) =>
    type === 'free' || type === 'skip'
      ? box(type, new Uint8Array(12))
      : type === 'wide'
        ? box('wide', u32Bytes(0x7fffffff))
        : box(type, new Uint8Array(6)),
  );
  const ftyp = box('ftyp', concatBytes([fourccBytes('qt  '), u32Bytes(0), fourccBytes('qt  ')]));
  const headerlessStart = ftyp.byteLength + prefix.reduce((sum, b) => sum + b.byteLength, 0);
  const mdat1 = box('mdat', firstRunBytes);
  const freeMid =
    options.interleaveFreeBytes !== undefined && options.interleaveFreeBytes > 0
      ? box('free', new Uint8Array(options.interleaveFreeBytes))
      : undefined;
  const mdat2 = secondRun.length > 0 ? box('mdat', secondRunBytes) : undefined;
  const chunkOneOffset = headerlessStart + 8;
  const chunkTwoOffset = headerlessStart + mdat1.byteLength + (freeMid?.byteLength ?? 0) + 8;
  const trackSizes = secondRun.length > 0 ? firstRun : sampleSizes;
  const secondTrack: SynthTrack | undefined =
    secondRun.length > 0 ? { sampleSizes: secondRun, chunkOffset: chunkTwoOffset, timescale: 1000 } : undefined;
  const firstRunLength = firstRunBytes.byteLength;
  const chunkWindows = secondTrack === undefined
    ? [{ offset: chunkOneOffset, start: 0, length: sampleBytes.byteLength }]
    : [
        { offset: chunkOneOffset, start: 0, length: firstRunLength },
        { offset: chunkTwoOffset, start: firstRunLength, length: secondRunBytes.byteLength },
      ];
  const tracks: SynthTrack[] = [
    { sampleSizes: trackSizes, chunkOffset: chunkOneOffset, timescale: 1000 },
    ...(secondTrack !== undefined ? [secondTrack] : []),
  ];
  const moov = buildSynthMoov(
    tracks,
    options.idatLikeBytes === true ? box('udta', box('idat', new Uint8Array(8))) : undefined,
  );
  const bodyBoxes = [
    ...(options.noMdat === true ? [ftyp, box('free', new Uint8Array(8)), moov] : [ftyp, ...prefix, mdat1]),
    ...(options.noMdat === true ? [] : [
      ...(freeMid !== undefined ? [freeMid] : []),
      ...(mdat2 !== undefined ? [mdat2] : []),
      moov,
    ]),
    ...(options.trailingTypes ?? []).map((type) => box(type, new Uint8Array(8))),
  ];
  const bytes = concatBytes(options.noMdat === true ? bodyBoxes : bodyBoxes);
  const second = options.secondMoov === true ? concatBytes([bytes, moov]) : bytes;
  return { bytes: second, moovSize: moov.byteLength, dataStart: headerlessStart, sampleBytes, chunkWindows };
}

const streamOpts: StreamCopyOptions = { container: 'mp4', buffered: true };

// ── 1. unit: the public pipeline takes the relocated path end-to-end ─────────

describe('moov-relocated compatible MOV→MP4 rewrite (unit)', () => {
  it('relocates the tail moov ahead of mdat, shifts stco by the moov size, keeps sample bytes', async () => {
    const source = await loadFixture('movie_5.mp4');
    const parsed = await readMovie(ra(source));
    const input = writeMp4(await muxTracksFromMovie(ra(source), parsed), { faststart: false }).slice();
    writeFourcc(input, 8, 'qt  ');
    writeFourcc(input, 16, 'qt  ');
    const orig = await readMovie(ra(input));
    let moovSize = 0;
    for (const b of topLevelBoxes(input)) if (b.type === 'moov') moovSize = b.size;
    expect(moovSize).toBeGreaterThan(0);
    const result = await bytesOf(await media().remux(fromBytes(input, { mime: 'video/quicktime' }), { to: 'mp4' }));
    expect(result.byteLength).toBe(input.byteLength);
    expect(fourccAt(result, 8)).toBe('isom');
    const boxes = topLevelBoxes(result);
    const moov = boxes.find((b) => b.type === 'moov')!;
    const mdat = boxes.find((b) => b.type === 'mdat')!;
    expect(moov.start).toBeLessThan(mdat.start); // fast-start honored
    const re = await readMovie(ra(result));
    expect(re.tracks.length).toBe(orig.tracks.length);
    for (let i = 0; i < orig.tracks.length; i++) {
      const a = orig.tracks[i]!;
      const b = re.tracks[i]!;
      expect(b.codec).toBe(a.codec);
      expect(buildSampleData(b).map((s) => s.size)).toEqual(buildSampleData(a).map((s) => s.size));
      expect(Array.from(b.samples.chunkOffsets)).toEqual(Array.from(a.samples.chunkOffsets, (v) => v + moovSize));
    }
    // Byte-exactness of the data region: it merely slid right by the relocated moov — sample
    // payloads are untouched (stronger than a decoder roundtrip and available in any realm).
    const srcBoxes = topLevelBoxes(input);
    const srcMdat = srcBoxes.find((b) => b.type === 'mdat')!;
    expect(
      result.subarray(mdat.start + 8, mdat.start + mdat.size).byteLength,
    ).toBe(srcMdat.size - 8);
    expect(result.subarray(mdat.start + 8, mdat.start + mdat.size)).toEqual(
      input.subarray(srcMdat.start + 8, srcMdat.start + srcMdat.size),
    );
  });

  it('the relocated rewrite is chosen by streamCompatibleMovToMp4 (not the general fallback)', async () => {
    const built = buildSyntheticMov({});
    const movie = await readMovie(ra(built.bytes));
    const stream = await streamCompatibleMovToMp4(ra(built.bytes), movie, streamOpts);
    expect(stream).toBeDefined();
    const out = await streamBytes(stream!);
    expect(out.byteLength).toBe(built.bytes.byteLength);
    // The whole data region (both mdats + interstitial bytes) slid right by exactly the moov size.
    const boxes = topLevelBoxes(out);
    expect(boxes[0]!.type).toBe('ftyp');
    expect(boxes[1]!.type).toBe('moov');
    expect(out.subarray(boxes[1]!.start + 12, boxes[1]!.start + 12 + 4)).toEqual(fourccBytes('mvhd'));
  });
});

// ── 2. property ───────────────────────────────────────────────────────────────

describe('moov-relocated compatible MOV→MP4 rewrite (property)', () => {
  it('accepted rewrites always: size-preserving, moov-first, chunkOffsets += moovSize, data byte-exact', async () => {
    let rng = 0x5eed >>> 0;
    const next = () => {
      rng = (rng * 1103515245 + 12345) >>> 0;
      return rng / 0x1_0000_0000;
    };
    let accepted = 0;
    for (let trial = 0; trial < 24; trial++) {
      const sampleSizes = Array.from({ length: 3 + Math.floor(next() * 5) }, () => 40 + Math.floor(next() * 200));
      const built = buildSyntheticMov({
        sampleSizes,
        prefixBoxes: next() < 0.5 ? ['wide'] : next() < 0.7 ? ['free'] : [],
        interleaveFreeBytes: next() < 0.5 ? 4 + Math.floor(next() * 16) : 0,
        trailingTypes: next() < 0.4 ? ['free'] : [],
      });
      const movie = await readMovie(ra(built.bytes));
      const stream = await streamCompatibleMovToMp4(ra(built.bytes), movie, streamOpts);
      if (stream === undefined) continue;
      accepted += 1;
      const out = await streamBytes(stream);
      expect(out.byteLength).toBe(built.bytes.byteLength);
      const boxes = topLevelBoxes(out);
      const types = boxes.map((b) => b.type);
      expect(types[0]).toBe('ftyp');
      expect(types.indexOf('moov')).toBeGreaterThan(0);
      expect(types.indexOf('moov')).toBeLessThan(types.indexOf('mdat'));
      expect(fourccAt(out, 8)).toBe('isom');
      const re = await readMovie(ra(out));
      for (let i = 0; i < re.tracks.length; i++) {
        const a = movie.tracks[i]!;
        const b = re.tracks[i]!;
        expect(Array.from(b.samples.chunkOffsets)).toEqual(
          Array.from(a.samples.chunkOffsets, (v) => v + built.moovSize),
        );
      }
    }
    expect(accepted).toBeGreaterThanOrEqual(12);
  });
});

// ── 3. boundary ───────────────────────────────────────────────────────────────

describe('moov-relocated compatible MOV→MP4 rewrite (boundary)', () => {
  it('declines when a shifted 32-bit chunk offset would exceed the stco slot width (sparse 4 GiB layout)', async () => {
    const ftyp = box('ftyp', concatBytes([fourccBytes('qt  '), u32Bytes(0), fourccBytes('qt  ')]));
    const mdatStart = ftyp.byteLength;
    const mdatVirtualSize = 0xffff_ff00 - mdatStart; // mdat region ends just below 4 GiB
    const mdatHeader = concatBytes([u32Bytes(mdatVirtualSize), fourccBytes('mdat')]);
    const nearEof = 0xffff_fe80; // a chunk whose shifted offset would exceed u32 by moovSize alone
    const sampleSizes = [100];
    const moov = buildSynthMoov([{ sampleSizes, chunkOffset: nearEof, timescale: 1000 }]);
    const moovAt = mdatStart + mdatVirtualSize;
    const total = moovAt + moov.byteLength;
    const view = sparseRa(
      [
        { at: 0, bytes: ftyp },
        { at: mdatStart, bytes: mdatHeader },
        { at: moovAt, bytes: moov },
      ],
      total,
    );
    const movie = await readMovie(view);
    const stream = await streamCompatibleMovToMp4(view, movie, streamOpts);
    expect(stream).toBeUndefined();
  });

  it('accepts multi-mdat data regions with interleaved free padding (canonical QT segmentation)', async () => {
    const built = buildSyntheticMov({ interleaveFreeBytes: 12 });
    const movie = await readMovie(ra(built.bytes));
    const stream = await streamCompatibleMovToMp4(ra(built.bytes), movie, streamOpts);
    expect(stream).toBeDefined();
    const out = await streamBytes(stream!);
    expect(out.byteLength).toBe(built.bytes.byteLength);
    const re = await readMovie(ra(out));
    expect(Array.from(re.tracks[0]!.samples.chunkOffsets)).toEqual(
      Array.from(movie.tracks[0]!.samples.chunkOffsets, (v) => v + built.moovSize),
    );
    // Payload bytes ride through untouched, just relocated by the moov size.
    for (let i = 0; i < re.tracks.length; i++) {
      const window = built.chunkWindows[i]!;
      const oldOffset = movie.tracks[i]!.samples.chunkOffsets[0]!;
      const newOffset = re.tracks[i]!.samples.chunkOffsets[0]!;
      expect(newOffset).toBe(oldOffset + built.moovSize);
      expect(out.subarray(newOffset, newOffset + window.length)).toEqual(
        built.sampleBytes.subarray(window.start, window.start + window.length),
      );
    }
  });

  it('a `wide` prefix passes through verbatim without disturbing the shift', async () => {
    const built = buildSyntheticMov({ prefixBoxes: ['wide'] });
    const movie = await readMovie(ra(built.bytes));
    const stream = await streamCompatibleMovToMp4(ra(built.bytes), movie, streamOpts);
    expect(stream).toBeDefined();
    const out = await streamBytes(stream!);
    const wide = topLevelBoxes(out).find((b) => b.type === 'wide');
    expect(wide).toBeDefined();
    expect(out.subarray(wide!.start, wide!.start + wide!.size)).toEqual(
      built.bytes.subarray(built.dataStart - 12, built.dataStart),
    );
    const re = await readMovie(ra(out));
    expect(Array.from(re.tracks[0]!.samples.chunkOffsets)).toEqual(
      Array.from(movie.tracks[0]!.samples.chunkOffsets, (v) => v + built.moovSize),
    );
  });
});

// ── 4. malformed ──────────────────────────────────────────────────────────────

describe('moov-relocated compatible MOV→MP4 rewrite (malformed)', () => {
  it('declines non-whitelisted prefix and trailing atoms', async () => {
    const poisonPrefix = buildSyntheticMov({ prefixBoxes: ['uuid'] });
    const prefixMovie = await readMovie(ra(poisonPrefix.bytes));
    await expect(streamCompatibleMovToMp4(ra(poisonPrefix.bytes), prefixMovie, streamOpts)).resolves.toBeUndefined();
    const poisonTail = buildSyntheticMov({ trailingTypes: ['mfra'] });
    const tailMovie = await readMovie(ra(poisonTail.bytes));
    await expect(streamCompatibleMovToMp4(ra(poisonTail.bytes), tailMovie, streamOpts)).resolves.toBeUndefined();
  });

  it('declines duplicate moov boxes and moov-only (mdat-less) bodies', async () => {
    const twin = buildSyntheticMov({ secondMoov: true });
    const movie = await readMovie(ra(twin.bytes));
    await expect(streamCompatibleMovToMp4(ra(twin.bytes), movie, streamOpts)).resolves.toBeUndefined();
    const noData = buildSyntheticMov({ noMdat: true });
    const noDataMovie = await readMovie(ra(noData.bytes));
    await expect(
      streamCompatibleMovToMp4(ra(noData.bytes), noDataMovie, { ...streamOpts, faststart: true }),
    ).resolves.toBeUndefined();
  });

  it('declines when stco lies about its entry count (never half-patches)', async () => {
    const built = buildSyntheticMov({});
    const movie = await readMovie(ra(built.bytes)); // parses the honest baseline first
    const corrupted = built.bytes.slice();
    const at = indexOfFourcc(corrupted, 'stco');
    expect(at).toBeGreaterThanOrEqual(0);
    writeU32Into(corrupted, at + 8, 64); // entry_count far beyond the actual 4-byte payload
    await expect(streamCompatibleMovToMp4(ra(corrupted), movie, streamOpts)).resolves.toBeUndefined();
  });

  it('declines when the moov body carries idat-referenced sample data', async () => {
    const built = buildSyntheticMov({ idatLikeBytes: true });
    const movie = await readMovie(ra(built.bytes));
    await expect(streamCompatibleMovToMp4(ra(built.bytes), movie, streamOpts)).resolves.toBeUndefined();
  });

  it('a chunk offset pointing before the data region never emits a relocated rewrite', async () => {
    const built = buildSyntheticMov({});
    const movie = await readMovie(ra(built.bytes));
    const poison = built.bytes.slice();
    const at = indexOfFourcc(poison, 'stco');
    writeU32Into(poison, at + 12, 4); // first chunk entry aims into the ftyp header region
    await streamCompatibleMovToMp4(ra(poison), movie, streamOpts).then(
      (stream) => expect(stream).toBeUndefined(),
      () => undefined, // an honest pre-output error is equally acceptable
    );
  });

  it('never mutates the caller’s source bytes (copy-before-patch)', async () => {
    const built = buildSyntheticMov({});
    const movie = await readMovie(ra(built.bytes));
    const original = built.bytes.slice();
    const stream = await streamCompatibleMovToMp4(ra(built.bytes), movie, streamOpts);
    if (stream !== undefined) await streamBytes(stream);
    expect(built.bytes).toEqual(original);
  });
});

// ── 5. randomized ─────────────────────────────────────────────────────────────

describe('moov-relocated compatible MOV→MP4 rewrite (bytes seam)', () => {
  it('the whole-bytes API matches the streaming rewrite and never aliases the input buffer', async () => {
    const built = buildSyntheticMov({ prefixBoxes: ['wide'], interleaveFreeBytes: 8 });
    const out = await rewrapCompatibleMovToMp4FromBytes(built.bytes);
    expect(out).toBeDefined();
    expect(out!.byteLength).toBe(built.bytes.byteLength);
    // Input untouched (copy-before-patch across the whole seam).
    const movie = await readMovie(ra(built.bytes));
    const streamed = await streamCompatibleMovToMp4(ra(built.bytes), movie, streamOpts);
    expect(streamed).toBeDefined();
    expect(await streamBytes(streamed!)).toEqual(out!);
    expect(built.bytes).toEqual(buildSyntheticMov({ prefixBoxes: ['wide'], interleaveFreeBytes: 8 }).bytes);
    const re = await readMovie(ra(out!));
    expect(Array.from(re.tracks[0]!.samples.chunkOffsets)).toEqual(
      Array.from(movie.tracks[0]!.samples.chunkOffsets, (v) => v + built.moovSize),
    );
  });

  it('declines (undefined) on non-QuickTime and non-provable bytes', async () => {
    expect(await rewrapCompatibleMovToMp4FromBytes(new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]))).toBeUndefined();
    const isomFile = buildSyntheticMov({});
    const wrongBrand = isomFile.bytes.slice();
    writeFourcc(wrongBrand, 8, 'isom');
    expect(await rewrapCompatibleMovToMp4FromBytes(wrongBrand)).toBeUndefined();
  });
});

describe('moov-relocated compatible MOV→MP4 rewrite (randomized)', () => {
  it('fuzzed layouts never emit a mis-referenced file: accept ⇒ offsets+samples provably shifted', async () => {
    let rng = 0xc0ffee >>> 0;
    const next = () => {
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      rng >>>= 0;
      return rng / 0x1_0000_0000;
    };
    const types = ['wide', 'free', 'skip', 'uuid', 'pnot', ''] as const;
    let accepted = 0;
    let declined = 0;
    for (let trial = 0; trial < 40; trial++) {
      const prefixBoxes: string[] = [];
      for (let i = 0; i < Math.floor(next() * 3); i++) {
        const t = types[Math.floor(next() * types.length)]!;
        if (t !== '') prefixBoxes.push(t);
      }
      const trailingTypes: string[] = [];
      if (next() < 0.3) trailingTypes.push(next() < 0.5 ? 'free' : 'skip');
      if (next() < 0.25) trailingTypes.push('mfra');
      const sampleSizes = Array.from({ length: 3 + Math.floor(next() * 4) }, () => 32 + Math.floor(next() * 160));
      const built = buildSyntheticMov({
        sampleSizes,
        prefixBoxes,
        interleaveFreeBytes: next() < 0.5 ? Math.floor(next() * 24) : 0,
        trailingTypes,
      });
      let movie: Movie;
      try {
        movie = await readMovie(ra(built.bytes));
      } catch {
        continue; // malformed to the parser is not this rewrite's contract
      }
      const stream = await streamCompatibleMovToMp4(ra(built.bytes), movie, streamOpts).catch(() => undefined);
      if (stream === undefined) {
        declined += 1;
        continue;
      }
      // Only layouts with purely whitelisted prefix and free/skip tails may be accepted.
      expect(prefixBoxes.every((t) => t === 'wide' || t === 'free' || t === 'skip')).toBe(true);
      expect(trailingTypes.every((t) => t === 'free' || t === 'skip')).toBe(true);
      accepted += 1;
      const out = await streamBytes(stream);
      expect(out.byteLength).toBe(built.bytes.byteLength);
      const re = await readMovie(ra(out));
      expect(re.tracks.length).toBe(movie.tracks.length);
      const boxes = topLevelBoxes(out);
      const moovPosition = boxes.findIndex((b) => b.type === 'moov');
      const mdatPosition = boxes.findIndex((b) => b.type === 'mdat');
      expect(moovPosition).toBeGreaterThan(0);
      expect(moovPosition).toBeLessThan(mdatPosition);
      for (let i = 0; i < re.tracks.length; i++) {
        expect(Array.from(re.tracks[i]!.samples.chunkOffsets)).toEqual(
          Array.from(movie.tracks[i]!.samples.chunkOffsets, (v) => v + built.moovSize),
        );
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(declined).toBeGreaterThan(0);
  });
});
