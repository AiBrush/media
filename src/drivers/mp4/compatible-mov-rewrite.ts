import type { StreamCopyOptions } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import type { Movie, ParsedTrack } from './parse.ts';
import { parseMovie } from './parse.ts';
import { type SampleToChunkCursor, samplesPerChunkFor } from './samples.ts';

interface RandomAccessView {
  readonly size?: number | undefined;
  read(offset: number, length: number): Promise<Uint8Array>;
}

interface SizedRandomAccessView extends RandomAccessView {
  readonly size: number;
}

interface TopLevelBox {
  readonly type: string;
  readonly size: number;
  readonly headerSize: number;
  readonly payloadStart: number;
  readonly end: number;
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) * 0x1_000000 +
    ((bytes[offset + 1] as number) << 16) +
    ((bytes[offset + 2] as number) << 8) +
    (bytes[offset + 3] as number)
  );
}

function u64(bytes: Uint8Array, offset: number): number {
  return u32(bytes, offset) * 0x1_0000_0000 + u32(bytes, offset + 4);
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] as number,
    bytes[offset + 1] as number,
    bytes[offset + 2] as number,
    bytes[offset + 3] as number,
  );
}

async function readTopLevelBox(
  ra: SizedRandomAccessView,
  offset: number,
): Promise<TopLevelBox | undefined> {
  if (offset < 0 || offset + 8 > ra.size) return undefined;
  // Loop-collect the box header so a chunked range transport (≤1 B per read)
  // cannot truncate it: collect up to 16 bytes, then interpret.
  let header: Uint8Array | undefined;
  {
    const need = Math.min(16, ra.size - offset);
    const chunks: Uint8Array[] = [];
    let collected = 0;
    let at = offset;
    let remaining = need;
    while (remaining > 0) {
      const chunk = await ra.read(at, remaining);
      if (chunk.byteLength === 0) break;
      chunks.push(chunk);
      at += chunk.byteLength;
      collected += chunk.byteLength;
      remaining -= chunk.byteLength;
      // Header size is unknown until we have 8 bytes; stop early if we cannot get 8.
      if (collected >= 8) {
        const probe =
          chunks.length === 1 ? (chunks[0] as Uint8Array) : concatChunks(chunks, collected);
        const probeSize = u32(probe, 0);
        const probeNeed = probeSize === 1 ? 16 : 8;
        if (collected >= probeNeed || collected >= need) break;
      }
    }
    if (collected < 8) return undefined;
    header = chunks.length === 1 ? (chunks[0] as Uint8Array) : concatChunks(chunks, collected);
  }
  if (header.byteLength < 8) return undefined;
  let size = u32(header, 0);
  const type = fourcc(header, 4);
  let headerSize = 8;
  if (size === 1) {
    if (header.byteLength < 16) return undefined;
    size = u64(header, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = ra.size - offset;
  }
  if (!Number.isFinite(size) || size < headerSize || offset + size > ra.size) {
    return undefined;
  }
  return { type, size, headerSize, payloadStart: offset + headerSize, end: offset + size };
}

function isSized(ra: RandomAccessView): ra is SizedRandomAccessView {
  return ra.size !== undefined;
}

function writeFourcc(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isCompatibleTrack(track: ParsedTrack): boolean {
  if (track.encryption !== undefined || track.samples.sampleSizes.length === 0) return false;
  if (track.mediaType === 'video') {
    return (
      (track.sampleEntryType === 'avc1' || track.sampleEntryType === 'avc3') &&
      track.codecPrivate?.boxType === 'avcC'
    );
  }
  return (
    track.mediaType === 'audio' &&
    track.sampleEntryType === 'mp4a' &&
    track.codecPrivate?.boxType === 'esds'
  );
}

function shouldRewrite(movie: Movie, o: StreamCopyOptions | undefined): boolean {
  if ((o?.container ?? 'mp4') !== 'mp4') return false;
  if (o?.trim !== undefined || o?.fragmented === true || o?.streaming === true) return false;
  if (o?.buffered !== true || o?.faststart === false) return false;
  return movie.brand === 'qt  ' && movie.tracks.length > 0 && movie.tracks.every(isCompatibleTrack);
}

/**
 * Upper bound for the relocated-moov rewrite. The moov is materialized to patch chunk offsets, so
 * an oversized moov declines the fast path (bounded memory) and the general re-layout handles it.
 */
const COMPATIBLE_REWRITE_MAX_MOOV_BYTES = 8 * 1024 * 1024;

/** Cap on top-level box entries scanned before declining the fast path. */
const COMPATIBLE_REWRITE_MAX_BOX_SCANS = 4096;

interface ChunkOffsetPatch {
  /** Number of stco/co64 boxes rewritten (must equal the compatible track count). */
  patchedBoxes: number;
  /** Total chunk-offset entries shifted. */
  patchedEntries: number;
}

/**
 * Shift every `stco`/`co64` entry inside a materialized moov by `delta`, in place. Only the
 * trak→mdia→minf→stbl spine is recursed (everything else is skipped opaquely by box size, so
 * QuickTime item boxes like `meta`/`udta` never enter the walk). Returns undefined when any box
 * is structurally unsound, any offset would leave its slot width after the shift, or a sample
 * table is encountered outside the trusted spine.
 */
function shiftChunkOffsetsInMoov(
  moov: Uint8Array,
  delta: number,
  dataStart: number,
  dataEnd: number,
): ChunkOffsetPatch | undefined {
  const patch: ChunkOffsetPatch = { patchedBoxes: 0, patchedEntries: 0 };
  const walk = (start: number, end: number, path: string): boolean => {
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) return false;
      let size = u32(moov, offset);
      const type = fourcc(moov, offset + 4);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) return false;
        const wide = u64(moov, offset + 8);
        if (!Number.isSafeInteger(wide)) return false;
        size = wide;
        headerSize = 16;
      }
      if (size < headerSize || offset + size > end) return false;
      const body = offset + headerSize;
      const boxEnd = offset + size;
      if (type === 'stco' || type === 'co64') {
        if (path !== 'moov.trak.mdia.minf.stbl') return false;
        const entryWidth = type === 'stco' ? 4 : 8;
        // Fullbox version/flags (4) + entry_count (4), then exactly entry_count entries.
        if (size - headerSize < 8) return false;
        const count = u32(moov, body + 4);
        if (size - headerSize !== 8 + count * entryWidth) return false;
        patch.patchedBoxes += 1;
        for (let index = 0; index < count; index++) {
          const at = body + 8 + index * entryWidth;
          const value = entryWidth === 4 ? u32(moov, at) : u64(moov, at);
          // Re-prove region membership from the RAW table bytes (not the parser's view), so a
          // table that references anything outside the sliding data region can never be patched
          // into a mis-referenced file.
          if (value < dataStart || value >= dataEnd) return false;
          const shifted = value + delta;
          if (!Number.isSafeInteger(shifted) || shifted < 0) return false;
          if (entryWidth === 4 && shifted > 0xff_ff_ff_ff) return false;
          if (entryWidth === 4) {
            writeU32(moov, at, shifted);
          } else {
            const high = Math.floor(shifted / 0x1_0000_0000);
            const low = shifted % 0x1_0000_0000;
            writeU32(moov, at, high);
            writeU32(moov, at + 4, low);
          }
          patch.patchedEntries += 1;
        }
      } else if (
        (type === 'moov' && path === '') ||
        (type === 'trak' && path === 'moov') ||
        (type === 'mdia' && path === 'moov.trak') ||
        (type === 'minf' && path === 'moov.trak.mdia') ||
        (type === 'stbl' && path === 'moov.trak.mdia.minf')
      ) {
        // All five spine boxes (moov/trak/mdia/minf/stbl) are plain ISO containers: children begin
        // immediately after the 8-byte box header. Full boxes (mvhd, stco…) are handled as leaves.
        if (!walk(body, boxEnd, path === '' ? 'moov' : `${path}.${type}`)) return false;
      }
      offset = boxEnd;
    }
    return true;
  };
  return walk(0, moov.byteLength, '') ? patch : undefined;
}

function validateSampleRange(
  index: number,
  offset: number,
  size: number,
  sourceSize: number,
): void {
  if (offset >= 0 && size >= 0 && offset + size <= sourceSize) return;
  throw new MediaError(
    'demux-error',
    `sample ${index} byte range [${offset}, ${offset + size}) is outside the source size ${sourceSize} (truncated or corrupt MP4)`,
  );
}

function validateTrackRanges(track: ParsedTrack, sourceSize: number): void {
  const table = track.samples;
  const sizes = table.sampleSizes;
  let sampleIndex = 0;
  const stscCursor: SampleToChunkCursor = { index: 0, value: 0 };

  for (
    let chunkIndex = 0;
    chunkIndex < table.chunkOffsets.length && sampleIndex < sizes.length;
    chunkIndex++
  ) {
    const chunkOffset = table.chunkOffsets[chunkIndex];
    if (chunkOffset === undefined) break;
    const samplesPerChunk = samplesPerChunkFor(table.sampleToChunk, chunkIndex + 1, stscCursor);
    let offset = chunkOffset;
    for (
      let sampleInChunk = 0;
      sampleInChunk < samplesPerChunk && sampleIndex < sizes.length;
      sampleInChunk++
    ) {
      const size = sizes[sampleIndex] ?? 0;
      validateSampleRange(sampleIndex, offset, size, sourceSize);
      offset += size;
      sampleIndex++;
    }
  }

  if (sampleIndex === sizes.length) return;
  throw new MediaError(
    'demux-error',
    `sample table mapped ${sampleIndex} of ${sizes.length} samples for compatible MOV->MP4 rewrite`,
  );
}

/**
 * Bytes per verbatim source window in the streamed compatible-brand rewrite. The operation patches
 * exactly twelve bytes inside `ftyp`; everything after that box is byte-identical source payload, so it
 * streams through in bounded windows and peak memory stays flat in the file size instead of holding two
 * whole-file copies on the heap (REQUIREMENTS §7.3).
 */
const COMPATIBLE_REWRITE_WINDOW_BYTES = 8 * 1024 * 1024;

/** Read a whole byte range by looping reads so a chunked transport cannot truncate it. */
async function readRange(
  ra: SizedRandomAccessView,
  start: number,
  length: number,
): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let offset = start;
  let remaining = length;
  while (remaining > 0) {
    const chunk = await ra.read(offset, remaining);
    if (chunk.byteLength === 0) return undefined;
    chunks.push(chunk);
    offset += chunk.byteLength;
    remaining -= chunk.byteLength;
  }
  if (chunks.length === 1) return (chunks[0] as Uint8Array).slice();
  return concatChunks(chunks, length);
}

function containsFourcc(bytes: Uint8Array, value: string): boolean {
  const a = value.charCodeAt(0);
  const b = value.charCodeAt(1);
  const c = value.charCodeAt(2);
  const d = value.charCodeAt(3);
  for (let i = 0; i + 4 <= bytes.byteLength; i++) {
    if (
      bytes[i] === a &&
      bytes[i + 1] === b &&
      bytes[i + 2] === c &&
      bytes[i + 3] === d
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Like `validateTrackRanges`, additionally prove every sample byte of the track lives inside the
 * contiguous data region `[dataStart, dataEnd)` that will shift as a unit under moov relocation.
 */
function validateTrackRegion(track: ParsedTrack, dataStart: number, dataEnd: number): void {
  const table = track.samples;
  const sizes = table.sampleSizes;
  let sampleIndex = 0;
  const stscCursor: SampleToChunkCursor = { index: 0, value: 0 };
  for (let chunkIndex = 0; chunkIndex < table.chunkOffsets.length && sampleIndex < sizes.length; chunkIndex++) {
    const chunkOffset = table.chunkOffsets[chunkIndex];
    if (chunkOffset === undefined) break;
    if (chunkOffset < dataStart || chunkOffset >= dataEnd) {
      throw new MediaError('demux-error', 'compatible MOV rewrite found a chunk offset outside the relocatable data region');
    }
    const samplesPerChunk = samplesPerChunkFor(table.sampleToChunk, chunkIndex + 1, stscCursor);
    let offset = chunkOffset;
    for (let sampleInChunk = 0; sampleInChunk < samplesPerChunk && sampleIndex < sizes.length; sampleInChunk++) {
      const size = sizes[sampleIndex] ?? 0;
      validateSampleRange(sampleIndex, offset, size, dataEnd);
      offset += size;
      sampleIndex++;
    }
  }
}

interface RelocatedMoovPlan {
  /** Patched (isom-brand) ftyp box bytes. */
  readonly ftypBytes: Uint8Array;
  /** Patched (chunk-offset-shifted) full moov box bytes. */
  readonly moovBytes: Uint8Array;
  /** Start of the contiguous mdat-bearing region in source coordinates. */
  readonly dataStart: number;
  /** Start of the source moov box (end of the data region). */
  readonly moovStart: number;
  /** End of the source moov box. */
  readonly moovEnd: number;
  readonly total: number;
}

/**
 * Plan a moov-last QuickTime rewrite: validate the canonical layout
 * `ftyp [wide|free|skip]* (mdat|free|skip)* moov [free|skip]*`, shift every stco/co64 entry by the
 * moov size (the whole data region slides right by exactly the relocated moov), and stitch output
 * regions so no sample byte is ever re-buffered beyond the bounded stream window.
 */
async function planRelocatedMoovRewrite(
  ra: SizedRandomAccessView,
  movie: Movie,
  ftyp: TopLevelBox,
): Promise<RelocatedMoovPlan | undefined> {
  const boxes: TopLevelBox[] = [];
  let scan = 0;
  while (scan < ra.size) {
    if (boxes.length >= COMPATIBLE_REWRITE_MAX_BOX_SCANS) return undefined;
    const box = await readTopLevelBox(ra, scan);
    if (box === undefined) return undefined;
    boxes.push(box);
    scan = box.end;
  }
  if (boxes.length < 3) return undefined;
  const moovEntries = boxes.map((box, index) => ({ box, index })).filter((entry) => entry.box.type === 'moov');
  const moovEntry = moovEntries[0];
  if (moovEntries.length !== 1 || moovEntry === undefined) return undefined;
  const moovIndex = moovEntry.index;
  const moov = moovEntry.box;
  // Trailing boxes after the moov must be inert padding.
  for (let index = moovIndex + 1; index < boxes.length; index++) {
    const type = boxes[index]?.type;
    if (type !== 'free' && type !== 'skip') return undefined;
  }
  // The data region: first mdat up to the moov; only mdat/free/skip in between.
  let firstData = -1;
  for (let index = 1; index < moovIndex; index++) {
    if (boxes[index]?.type === 'mdat') {
      firstData = index;
      break;
    }
  }
  if (firstData < 1) return undefined;
  for (let index = firstData; index < moovIndex; index++) {
    const type = boxes[index]?.type;
    if (type !== 'mdat' && type !== 'free' && type !== 'skip') return undefined;
  }
  // The prefix between ftyp and the first mdat: QuickTime `wide` plus inert padding only.
  for (let index = 1; index < firstData; index++) {
    const type = boxes[index]?.type;
    if (type !== 'wide' && type !== 'free' && type !== 'skip') return undefined;
  }
  if (moov.size > COMPATIBLE_REWRITE_MAX_MOOV_BYTES) return undefined;
  const dataBox = boxes[firstData];
  if (dataBox === undefined) return undefined;
  const moovBoxStart = moov.payloadStart - moov.headerSize;
  const dataStart = dataBox.payloadStart - dataBox.headerSize;
  const moovBytes = await readRange(ra, moovBoxStart, moov.size);
  if (moovBytes === undefined || moovBytes.byteLength !== moov.size) return undefined;
  // `idat` carries sample bytes inside the moov itself — that region must not slide under this plan.
  if (containsFourcc(moovBytes, 'idat')) return undefined;
  for (const track of movie.tracks) validateTrackRegion(track, dataStart, moovBoxStart);
  const shifted = shiftChunkOffsetsInMoov(moovBytes, moov.size, dataStart, moovBoxStart);
  if (shifted === undefined || shifted.patchedBoxes !== movie.tracks.length) return undefined;
  const ftypBytes = await readRange(ra, 0, ftyp.size);
  if (ftypBytes === undefined) return undefined;
  writeFourcc(ftypBytes, ftyp.headerSize, 'isom');
  writeU32(ftypBytes, ftyp.headerSize + 4, 0x200);
  writeFourcc(ftypBytes, ftyp.headerSize + 8, 'mp42');
  return {
    ftypBytes,
    moovBytes,
    dataStart,
    moovStart: moovBoxStart,
    moovEnd: moovBoxStart + moov.size,
    total: ra.size,
  };
}

/**
 * Stream a QuickTime-branded (`qt  `) MOV as an MP4-compatible container. Two byte-exact layouts
 * are recognized; anything else declines and the caller falls through to the general re-layout:
 *
 * 1. `ftyp moov …` — rewrite only the 12-byte `ftyp` brand payload and forward every remaining
 *    source byte verbatim (chunk offsets stay valid because nothing moves).
 * 2. `ftyp [wide|free]* (mdat|free)* moov [free]*` — the canonical QuickTime ordering. Relocate
 *    the moov in front of the data region (honoring fast-start) and shift each stco/co64 entry by
 *    the moov's size; sample bytes stream through untouched in bounded windows, so peak memory
 *    stays flat in the file size instead of holding two whole-file copies on the heap
 *    (REQUIREMENTS §7.3).
 */
export async function streamCompatibleMovToMp4(
  ra: RandomAccessView,
  movie: Movie,
  o: StreamCopyOptions | undefined,
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (!shouldRewrite(movie, o) || !isSized(ra)) return undefined;

  const ftyp = await readTopLevelBox(ra, 0);
  if (ftyp === undefined || ftyp.type !== 'ftyp' || ftyp.size < ftyp.headerSize + 12) {
    return undefined;
  }
  const next = await readTopLevelBox(ra, ftyp.end);
  if (next === undefined) return undefined;

  if (next.type === 'moov') {
    for (const track of movie.tracks) validateTrackRanges(track, ra.size);

    // Copy before patching: for in-memory sources `ra.read` returns a view over the caller's bytes, and
    // this operation must never mutate its input. Loop until `ftyp.size` bytes are collected so a
    // short transport read (chunked range response) does not truncate the header.
    let ftypBytes: Uint8Array | undefined;
    {
      const chunks: Uint8Array[] = [];
      let remaining = ftyp.size;
      let offset = 0;
      while (remaining > 0) {
        const chunk = await ra.read(offset, remaining);
        if (chunk.byteLength === 0) break;
        chunks.push(chunk);
        offset += chunk.byteLength;
        remaining -= chunk.byteLength;
      }
      if (remaining !== 0) {
        throw new MediaError(
          'demux-error',
          `MP4 compatible MOV ftyp read was short: got ${ftyp.size - remaining} of ${ftyp.size} bytes`,
        );
      }
      const collected =
        chunks.length === 1 ? (chunks[0] as Uint8Array) : concatChunks(chunks, ftyp.size);
      ftypBytes = collected.slice();
    }
    writeFourcc(ftypBytes, ftyp.headerSize, 'isom');
    writeU32(ftypBytes, ftyp.headerSize + 4, 0x200);
    writeFourcc(ftypBytes, ftyp.headerSize + 8, 'mp42');

    const total = ra.size;
    let cursor = ftyp.end;
    let emittedHeader = false;
    return new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        if (!emittedHeader) {
          emittedHeader = true;
          controller.enqueue(ftypBytes as Uint8Array);
          return;
        }
        if (cursor >= total) {
          controller.close();
          return;
        }
        const length = Math.min(COMPATIBLE_REWRITE_WINDOW_BYTES, total - cursor);
        const chunk = await ra.read(cursor, length);
        if (chunk.byteLength === 0) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        cursor += chunk.byteLength;
      },
    });
  }

  // Canonical QuickTime ordering: the moov sits at the tail and must be relocated in front of the
  // data region. Decline (general path) on any structural surprise instead of guessing.
  const plan = await planRelocatedMoovRewrite(ra, movie, ftyp);
  if (plan === undefined) return undefined;

  // Emission order: ftyp', source prefix padding, relocated moov', data region, inert trailing pad.
  const order: (Uint8Array | { readonly start: number; readonly end: number })[] = [
    plan.ftypBytes,
    { start: ftyp.end, end: plan.dataStart },
    plan.moovBytes,
    { start: plan.dataStart, end: plan.moovStart },
    { start: plan.moovEnd, end: plan.total },
  ];
  let at = 0;
  let cursor = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      for (;;) {
        if (at >= order.length) {
          controller.close();
          return;
        }
        const entry = order[at] as Uint8Array | { start: number; end: number };
        if (entry instanceof Uint8Array) {
          at += 1;
          if (entry.byteLength > 0) controller.enqueue(entry);
          continue;
        }
        if (cursor < entry.start) cursor = entry.start;
        if (cursor >= entry.end) {
          at += 1;
          continue;
        }
        const length = Math.min(COMPATIBLE_REWRITE_WINDOW_BYTES, entry.end - cursor);
        const chunk = await ra.read(cursor, length);
        if (chunk.byteLength === 0) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        cursor += chunk.byteLength;
        return;
      }
    },
  });
}

/**
 * Whole-bytes form of the compatible MOV→MP4 rewrite for buffered consumers (prepared remux routes
 * that already hold the source in memory): rewrap or decline, with no transport machinery between
 * the audit and the output. Returns `undefined` exactly when the streaming rewrite declines, so
 * callers fall through to the general path. Output is always a freshly allocated buffer — views
 * into the caller's bytes are never handed back.
 */
export async function rewrapCompatibleMovToMp4FromBytes(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  const view: SizedRandomAccessView = {
    size: bytes.byteLength,
    read: (offset: number, length: number): Promise<Uint8Array> =>
      Promise.resolve(bytes.subarray(Math.max(0, offset), Math.min(bytes.byteLength, offset + length))),
  };
  const ftyp = await readTopLevelBox(view, 0);
  if (ftyp === undefined || ftyp.type !== 'ftyp' || ftyp.size < ftyp.headerSize + 12) return undefined;
  const brand = fourcc(bytes, ftyp.headerSize);
  let offset = 0;
  let moovBytes: Uint8Array | undefined;
  let moovBody: Uint8Array | undefined;
  let scans = 0;
  while (offset < bytes.byteLength) {
    if (scans++ >= COMPATIBLE_REWRITE_MAX_BOX_SCANS) return undefined;
    const box = await readTopLevelBox(view, offset);
    if (box === undefined) return undefined;
    if (box.type === 'moov') {
      if (moovBytes !== undefined) return undefined;
      const boxStart = box.payloadStart - box.headerSize;
      moovBytes = bytes.slice(boxStart, boxStart + box.size);
      moovBody = bytes.subarray(box.payloadStart, box.payloadStart + (box.size - box.headerSize));
    }
    offset = box.end;
  }
  if (moovBytes === undefined || moovBody === undefined) return undefined;
  const movie = parseMovie(brand, moovBody);
  const stream = await streamCompatibleMovToMp4(view, movie, { container: 'mp4', buffered: true });
  if (stream === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  if (total !== bytes.byteLength) return undefined; // transport surprise → decline; the general path decides
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
