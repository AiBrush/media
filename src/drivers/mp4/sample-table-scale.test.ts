/**
 * Scale + shape invariants for the parsed MP4 sample tables. A long movie's `stbl` is the largest
 * structure an ISO-BMFF parser ever materializes (a 2 h 30 fps track declares 216,000 samples), so
 * these are memory contracts, not formatting preferences: every column stays a typed array whose
 * footprint is a fixed number of bytes per entry, and no declared entry count can reserve memory
 * the box does not actually carry.
 */

import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { be16, be32, box, full, str, zeros } from '../../test-support/mp4-builder.ts';
import { Mp4Driver } from './mp4-driver.ts';
import { type SampleTable, parseMovie } from './parse.ts';

/** Assemble byte parts (small hand-written boxes as `number[]`, big tables as `Uint8Array`). */
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

/**
 * A full box whose payload is `count` fixed-width entries written straight into one buffer — the
 * only way to build a 200k-entry table in a test without allocating the boxed rows under test.
 */
function tableBox(
  type: string,
  bytesPerEntry: number,
  count: number,
  write: (view: DataView, offset: number, index: number) => void,
  extraHeaderWords: readonly number[] = [],
): Uint8Array {
  const headerBytes = 12 + 4 * extraHeaderWords.length + 4;
  const out = new Uint8Array(headerBytes + bytesPerEntry * count);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength);
  out.set(Uint8Array.from(str(type)), 4);
  let cursor = 12;
  for (const word of extraHeaderWords) {
    view.setUint32(cursor, word);
    cursor += 4;
  }
  view.setUint32(cursor, count);
  cursor += 4;
  for (let index = 0; index < count; index++) {
    write(view, cursor + index * bytesPerEntry, index);
  }
  return out;
}

const AVC_C = box('avcC', [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x00]);
const VISUAL_ENTRY = box('avc1', [
  ...zeros(6),
  ...be16(1),
  ...zeros(16),
  ...be16(1920),
  ...be16(1080),
  ...zeros(50),
  ...AVC_C,
]);

interface LongMovieOptions {
  readonly sampleCount: number;
  /** Samples per chunk; 1 makes `stco` as long as `stsz`, the shape ffmpeg writes for long files. */
  readonly samplesPerChunk?: number;
  readonly timescale?: number;
  readonly delta?: number;
  readonly mdatBytes?: number;
  /**
   * Emit an `stbl` holding nothing but `stsd`, the shape a fragmented movie's initialization
   * segment carries. Distinct from `sampleCount: 0`, which still declares one-entry `stts`/`stsc`
   * runs describing zero samples.
   */
  readonly omitTables?: boolean;
}

/** A faststart `ftyp` + `moov` + `mdat` movie with a realistically long single-video sample table. */
function longMovie(options: LongMovieOptions): { file: Uint8Array; moovPayload: Uint8Array } {
  const samples = options.sampleCount;
  const perChunk = options.samplesPerChunk ?? 1;
  const timescale = options.timescale ?? 30_000;
  const delta = options.delta ?? 1000;
  const chunks = Math.ceil(samples / perChunk);
  const sampleBytes = 64;
  const mdatBytes = options.mdatBytes ?? sampleBytes * samples + 8;
  const mediaTicks = samples * delta;

  const stsd = full('stsd', 0, [...be32(1), ...VISUAL_ENTRY]);
  const stbl =
    options.omitTables === true
      ? join([stsd])
      : join([
          stsd,
          tableBox('stts', 8, 1, (view, offset) => {
            view.setUint32(offset, samples);
            view.setUint32(offset + 4, delta);
          }),
          tableBox('stsz', 4, samples, (view, offset) => view.setUint32(offset, sampleBytes), [0]),
          tableBox('stsc', 12, 1, (view, offset) => {
            view.setUint32(offset, 1);
            view.setUint32(offset + 4, perChunk);
            view.setUint32(offset + 8, 1);
          }),
          tableBox('stco', 4, chunks, (view, offset, index) =>
            view.setUint32(offset, 4096 + index * sampleBytes * perChunk),
          ),
          tableBox('stss', 4, Math.ceil(samples / 60), (view, offset, index) =>
            view.setUint32(offset, 1 + index * 60),
          ),
        ]);
  const trak = join([
    [...be32(0), ...str('trak')], // patched below
    full('tkhd', 0, [
      ...zeros(8),
      ...be32(1),
      ...zeros(4),
      ...be32(mediaTicks),
      ...zeros(8 + 2 + 2 + 2 + 2),
      ...be32(0x0001_0000),
      ...be32(0),
      ...zeros(4),
      ...be32(0),
      ...be32(0x0001_0000),
      ...zeros(16),
      ...zeros(8),
    ]),
    join([
      [...be32(0), ...str('mdia')],
      full('mdhd', 0, [...zeros(8), ...be32(timescale), ...be32(mediaTicks), ...zeros(4)]),
      full('hdlr', 0, [...zeros(4), ...str('vide'), ...zeros(12)]),
      join([[...be32(0), ...str('minf')], join([[...be32(0), ...str('stbl')], stbl])]),
    ]),
  ]);
  // Patch the container sizes bottom-up: every wrapper above was written with a placeholder.
  const patch = (bytes: Uint8Array, starts: readonly number[]): void => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const start of starts) view.setUint32(start, bytes.byteLength - start);
  };
  const stblStart = trak.byteLength - stbl.byteLength - 8;
  const minfStart = stblStart - 8;
  const mdiaStart = trak.byteLength - (trak.byteLength - 8 - 0) + 8; // resolved below
  void mdiaStart;
  patch(trak, [0]);
  const view = new DataView(trak.buffer, trak.byteOffset, trak.byteLength);
  // mdia starts right after trak header + tkhd.
  const tkhdSize = view.getUint32(8);
  const mdiaOffset = 8 + tkhdSize;
  view.setUint32(mdiaOffset, trak.byteLength - mdiaOffset);
  view.setUint32(minfStart, trak.byteLength - minfStart);
  view.setUint32(stblStart, trak.byteLength - stblStart);

  const moovPayload = join([
    full('mvhd', 0, [...zeros(8), ...be32(1000), ...be32(1000), ...zeros(4)]),
    trak,
  ]);
  const moov = join([[...be32(8 + moovPayload.byteLength), ...str('moov')], moovPayload]);
  const ftyp = join([box('ftyp', [...str('isom'), ...be32(512), ...str('isom'), ...str('mp42')])]);
  const mdat = join([
    [...be32(mdatBytes), ...str('mdat')],
    new Uint8Array(Math.max(0, mdatBytes - 8)),
  ]);
  return { file: join([ftyp, moov, mdat]), moovPayload };
}

function columns(table: SampleTable): readonly (readonly [string, ArrayBufferView])[] {
  return [
    ['stts.counts', table.timeToSample.counts],
    ['stts.deltas', table.timeToSample.deltas],
    ['ctts.counts', table.compositionOffsets.counts],
    ['ctts.offsets', table.compositionOffsets.offsets],
    ['stsz', table.sampleSizes],
    ['stsc.firstChunk', table.sampleToChunk.firstChunk],
    ['stsc.samplesPerChunk', table.sampleToChunk.samplesPerChunk],
    ['stsc.descIndex', table.sampleToChunk.descIndex],
    ['stco', table.chunkOffsets],
    ['stss', table.syncSamples],
    ['sdtp', table.sampleDependencies],
  ];
}

function tableBytes(table: SampleTable): number {
  return columns(table).reduce((total, [, column]) => total + column.byteLength, 0);
}

describe('MP4 sample tables — typed-column representation', () => {
  it('parses every column as a typed array, never a boxed JS array', () => {
    const { moovPayload } = longMovie({ sampleCount: 64 });
    const movie = parseMovie('isom', moovPayload);
    const track = movie.tracks[0];
    expect(track).toBeDefined();
    if (!track) return;
    for (const [name, column] of columns(track.samples)) {
      expect(`${name}:${ArrayBuffer.isView(column)}`).toBe(`${name}:true`);
      expect(`${name}:${Array.isArray(column)}`).toBe(`${name}:false`);
    }
  });

  it('keeps an empty table typed rather than switching representation', () => {
    // A fragmented/initialization `stbl` carries no tables at all; the columns must still be views
    // so every consumer reads one shape.
    const movie = parseMovie('isom', longMovie({ sampleCount: 0, omitTables: true }).moovPayload);
    const track = movie.tracks[0];
    expect(track).toBeDefined();
    if (!track) return;
    for (const [name, column] of columns(track.samples)) {
      expect(`${name}:${ArrayBuffer.isView(column)}`).toBe(`${name}:true`);
      expect(`${name}:${column.byteLength}`).toBe(`${name}:0`);
    }
  });

  it('declares zero samples without allocating a run for them', () => {
    // `sampleCount: 0` still writes one-entry `stts`/`stsc` runs, so the columns are present but
    // describe nothing. The per-sample columns must stay empty rather than reserving the declared run.
    const movie = parseMovie('isom', longMovie({ sampleCount: 0 }).moovPayload);
    const track = movie.tracks[0];
    expect(track).toBeDefined();
    if (!track) return;
    expect(track.samples.sampleSizes.length).toBe(0);
    expect(track.samples.chunkOffsets.length).toBe(0);
    expect(track.samples.syncSamples.length).toBe(0);
    expect(track.samples.timeToSample.counts.length).toBe(1);
    expect(track.samples.timeToSample.counts[0]).toBe(0);
  });
});

describe('MP4 sample tables — bounded allocation at long-movie scale', () => {
  // 216,000 samples is a 2 h 30 fps track; 40,000 keeps the test fast while staying far past the
  // point where a per-entry object representation would dominate.
  const SAMPLES = 40_000;

  it('retains a fixed number of bytes per sample, independent of sample count', () => {
    const small = parseMovie('isom', longMovie({ sampleCount: SAMPLES / 4 }).moovPayload);
    const large = parseMovie('isom', longMovie({ sampleCount: SAMPLES }).moovPayload);
    const smallTrack = small.tracks[0];
    const largeTrack = large.tracks[0];
    expect(smallTrack).toBeDefined();
    expect(largeTrack).toBeDefined();
    if (!smallTrack || !largeTrack) return;

    // stsz (4 B) + stco (8 B, one chunk per sample) + stss (4 B per 60th sample) = ~12.07 B/sample.
    // A `{count, delta}`-style boxed representation costs ~48 B per entry plus an 8 B pointer, so
    // this bound is the whole point: it fails the moment any column becomes an array of objects.
    const perSample = tableBytes(largeTrack.samples) / SAMPLES;
    expect(perSample).toBeLessThanOrEqual(16);

    // Growth must be exactly linear in the sample count — no per-entry overhead hiding in the slope.
    const slope =
      (tableBytes(largeTrack.samples) - tableBytes(smallTrack.samples)) / (SAMPLES - SAMPLES / 4);
    expect(slope).toBeLessThanOrEqual(16);
  });

  it('never exceeds the on-wire table bytes by more than the co64-width column', () => {
    const { moovPayload } = longMovie({ sampleCount: SAMPLES });
    const movie = parseMovie('isom', moovPayload);
    const track = movie.tracks[0];
    expect(track).toBeDefined();
    if (!track) return;
    // Only `chunkOffsets` widens (32-bit `stco` entries are held as exact 64-bit floats so `co64`
    // shares one column type); everything else is at most its declared byte width.
    expect(tableBytes(track.samples)).toBeLessThanOrEqual(moovPayload.byteLength + 4 * SAMPLES);
  });
});

describe('MP4 sample tables — malformed declarations allocate nothing', () => {
  /** Replace a table box's entry-count field with `count`, leaving the payload bytes as they are. */
  function withDeclaredEntryCount(moov: Uint8Array, type: string, count: number): Uint8Array {
    const out = moov.slice();
    const view = new DataView(out.buffer);
    const codes = [...type].map((character) => character.charCodeAt(0));
    for (let index = 4; index + 12 <= out.byteLength; index++) {
      if (!codes.every((code, relative) => out[index + relative] === code)) continue;
      const countOffset = type === 'stsz' ? index + 12 : index + 8;
      view.setUint32(countOffset, count);
      return out;
    }
    throw new Error(`no ${type} box`);
  }

  it.each(['stts', 'stsc', 'stco', 'stss'])(
    'rejects a %s entry count larger than the box payload instead of reserving it',
    (type) => {
      const { moovPayload } = longMovie({ sampleCount: 32 });
      const hostile = withDeclaredEntryCount(moovPayload, type, 0xffff_ffff);
      const started = performance.now();
      expect(() => parseMovie('isom', hostile)).toThrow(MediaError);
      // A reserved-then-thrown 4-billion-entry column would not return in single-digit milliseconds.
      expect(performance.now() - started).toBeLessThan(1000);
    },
  );

  it('rejects a per-sample stsz that declares one entry more than it carries', () => {
    const { moovPayload } = longMovie({ sampleCount: 32 });
    const view = new DataView(moovPayload.buffer, moovPayload.byteOffset, moovPayload.byteLength);
    const stszIndex = (() => {
      const codes = [...'stsz'].map((character) => character.charCodeAt(0));
      for (let index = 4; index + 16 <= moovPayload.byteLength; index++) {
        if (codes.every((code, relative) => moovPayload[index + relative] === code)) return index;
      }
      throw new Error('no stsz box');
    })();
    expect(view.getUint32(stszIndex + 12)).toBe(32); // boundary: the exact count still parses
    expect(() => parseMovie('isom', moovPayload)).not.toThrow();

    const oneTooMany = moovPayload.slice();
    new DataView(oneTooMany.buffer).setUint32(stszIndex + 12, 33);
    expect(() => parseMovie('isom', oneTooMany)).toThrow(MediaError);
  });

  it('rejects an implausible constant-size stsz sample_count instead of materializing it', () => {
    // A constant-size `stsz` carries no per-sample bytes, so only a structural bound can stop
    // `sample_count` from reserving 16 GB of column.
    const { moovPayload } = longMovie({ sampleCount: 32 });
    const constant = moovPayload.slice();
    const view = new DataView(constant.buffer);
    const codes = [...'stsz'].map((character) => character.charCodeAt(0));
    let stszIndex = -1;
    for (let index = 4; index + 16 <= constant.byteLength; index++) {
      if (codes.every((code, relative) => constant[index + relative] === code)) {
        stszIndex = index;
        break;
      }
    }
    expect(stszIndex).toBeGreaterThan(0);
    view.setUint32(stszIndex + 8, 1024); // constant sample_size
    view.setUint32(stszIndex + 12, 0xffff_ffff); // implausible sample_count
    const started = performance.now();
    expect(() => parseMovie('isom', constant)).toThrow(/implausible sample_count/);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('MP4 probe — a long movie is metadata, not a sample table', () => {
  function countingSource(file: Uint8Array): ByteSource & { bytesRead: number } {
    const source = {
      kind: 'url' as const,
      mimeHint: 'video/mp4',
      size: file.byteLength,
      bytesRead: 0,
      stream: (): ReadableStream<Uint8Array> => new ReadableStream(),
      range: (start: number, end: number): Promise<Uint8Array> => {
        const bounded = file.slice(Math.max(0, start), Math.min(file.byteLength, end));
        source.bytesRead += bounded.byteLength;
        return Promise.resolve(bounded);
      },
    };
    return source;
  }

  it('probes a 216k-sample movie by reading its moov, never its media payload', async () => {
    // ISO-BMFF stores the tables inline in `moov`, so a probe of a 2 h movie must read them — what it
    // must never do is touch `mdat`, which is the whole point of the format's index/payload split.
    // Here `mdat` is 64 MB against a ~1.8 MB `moov`; a probe that reads payload fails this outright.
    const mdatBytes = 64 * 1024 * 1024;
    const { file, moovPayload } = longMovie({ sampleCount: 216_000, mdatBytes });
    const source = countingSource(file);
    const tracks = await Mp4Driver.probe?.(source);

    expect(tracks).toHaveLength(1);
    expect(tracks?.[0]?.mediaType).toBe('video');
    const config = tracks?.[0]?.config;
    if (config === undefined || !('codedWidth' in config)) {
      throw new Error('expected the probed track to carry a video decoder config');
    }
    expect(config.codedWidth).toBe(1920);
    expect(config.codedHeight).toBe(1080);
    // Scales with the index, not the movie: comfortably over `moov`, far under `mdat`.
    expect(source.bytesRead).toBeLessThan(moovPayload.byteLength + 256 * 1024);
    expect(source.bytesRead).toBeLessThan(mdatBytes / 8);
  });
});
