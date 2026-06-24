/**
 * Test-only CENC (`cenc`/AES-CTR) encryptor — produces a real encrypted MP4 from a clear one so the
 * decrypt op can be validated end-to-end on real media (the inverse of {@link Mp4Driver.decrypt}). Not
 * shipped (test-support only). Encrypts one media type's samples with a deterministic per-sample IV and
 * re-muxes via {@link writeMp4} as a protected (`enca`/`encv` + `tenc` + `senc`) track.
 */

import { aesCtr, hexToBytes } from '../crypto/aes.ts';
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
