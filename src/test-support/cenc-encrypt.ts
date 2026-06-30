/**
 * Test-only CENC (`cenc`/AES-CTR and `cens`/patterned AES-CTR) encryptors — produce a real encrypted MP4
 * from a clear one so the decrypt op can be validated end-to-end on real media (the inverse of
 * {@link Mp4Driver.decrypt}). Not shipped (test-support only). Encrypt one media type's samples with a
 * deterministic per-sample IV and re-mux via {@link writeMp4} as a protected (`enca`/`encv` + `tenc` +
 * `senc`) track.
 */

import { AES_BLOCK, aesCtr, hexToBytes } from '../crypto/aes.ts';
import { muxTracksFromMovie, readMovie } from '../drivers/mp4/mp4-driver.ts';
import { type MuxTrackInput, writeMp4 } from '../drivers/mp4/write.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/** 16-byte counter from an 8-byte IV (IV high, 64-bit block counter low = 0). */
function counter(iv: Uint8Array): Uint8Array<ArrayBuffer> {
  const c = new Uint8Array(16);
  c.set(iv, 0);
  return c;
}
/** A distinct, non-zero 8-byte IV per sample index. */
function ivFor(i: number): Uint8Array {
  const iv = new Uint8Array(8);
  new DataView(iv.buffer).setUint32(4, i + 1);
  return iv;
}

export interface EncryptCencOptions {
  keyHex: string;
  kidHex: string;
  mediaType?: 'audio' | 'video';
}

export interface CensPattern {
  cryptByteBlock: number;
  skipByteBlock: number;
}

export interface EncryptCensOptions extends EncryptCencOptions {
  pattern?: CensPattern;
}

function cryptBlockOffsets(protectedLen: number, pattern: CensPattern): number[] {
  const wholeBlocks = Math.floor(protectedLen / AES_BLOCK);
  const cycle = pattern.cryptByteBlock + pattern.skipByteBlock;
  const offsets: number[] = [];
  for (let b = 0; b < wholeBlocks; b++) {
    const phase = cycle === 0 ? 0 : b % cycle;
    if (cycle === 0 || phase < pattern.cryptByteBlock) offsets.push(b * AES_BLOCK);
  }
  return offsets;
}

async function encryptCensSample(
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array,
  data: Uint8Array,
  pattern: CensPattern,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = data.slice();
  const offsets = cryptBlockOffsets(data.byteLength, pattern);
  if (offsets.length === 0) return out;
  const gathered = new Uint8Array(offsets.length * AES_BLOCK);
  offsets.forEach((off, i) => gathered.set(data.subarray(off, off + AES_BLOCK), i * AES_BLOCK));
  const cipher = await aesCtr(key, counter(iv), gathered, 64);
  offsets.forEach((off, i) =>
    out.set(cipher.subarray(i * AES_BLOCK, i * AES_BLOCK + AES_BLOCK), off),
  );
  return out;
}

/** Encrypt the chosen track type of a clear MP4 with CENC `cenc` (AES-CTR), returning encrypted MP4 bytes. */
export async function encryptCenc(
  clearMp4: Uint8Array,
  opts: EncryptCencOptions,
): Promise<Uint8Array> {
  const movie = await readMovie(ra(clearMp4));
  const tracks = await muxTracksFromMovie(ra(clearMp4), movie);
  const key = hexToBytes(opts.keyHex);
  const kid = hexToBytes(opts.kidHex);
  const target = opts.mediaType ?? 'audio';

  const out: MuxTrackInput[] = [];
  for (const [i, parsed] of movie.tracks.entries()) {
    const track = tracks[i];
    if (!track) continue;
    if (parsed.mediaType !== target) {
      out.push(track);
      continue;
    }
    const ivs = track.samples.map((_, j) => ivFor(j));
    const cipher = await Promise.all(
      track.samples.map((s, j) => aesCtr(key, counter(ivs[j] ?? ivFor(j)), s.data.slice(), 64)),
    );
    out.push({
      ...track,
      encryption: { schemeType: 'cenc', kid, perSampleIvSize: 8, ivs },
      samples: track.samples.map((s, j) => ({ ...s, data: cipher[j] ?? s.data })),
    });
  }
  return writeMp4(out, { faststart: true });
}

/** Encrypt the chosen track type of a clear MP4 with CENC `cens` (patterned AES-CTR). */
export async function encryptCens(
  clearMp4: Uint8Array,
  opts: EncryptCensOptions,
): Promise<Uint8Array> {
  const movie = await readMovie(ra(clearMp4));
  const tracks = await muxTracksFromMovie(ra(clearMp4), movie);
  const key = hexToBytes(opts.keyHex);
  const kid = hexToBytes(opts.kidHex);
  const target = opts.mediaType ?? 'audio';
  const pattern = opts.pattern ?? { cryptByteBlock: 1, skipByteBlock: 1 };

  const out: MuxTrackInput[] = [];
  for (const [i, parsed] of movie.tracks.entries()) {
    const track = tracks[i];
    if (!track) continue;
    if (parsed.mediaType !== target) {
      out.push(track);
      continue;
    }
    const ivs = track.samples.map((_, j) => ivFor(j));
    const cipher = await Promise.all(
      track.samples.map((s, j) => encryptCensSample(key, ivs[j] ?? ivFor(j), s.data, pattern)),
    );
    out.push({
      ...track,
      encryption: { schemeType: 'cens', kid, perSampleIvSize: 8, ivs, pattern },
      samples: track.samples.map((s, j) => ({ ...s, data: cipher[j] ?? s.data })),
    });
  }
  return writeMp4(out, { faststart: true });
}
