import { describe, expect, it } from 'vitest';
import {
  be32,
  box,
  bytes,
  cat,
  ftyp,
  moovBox,
  moovBoxLargesize,
  str,
  zeros,
} from '../../test-support/mp4-builder.ts';
import { readMovie } from './mp4-driver.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

describe('readMovie — top-level box layouts', () => {
  it('finds moov immediately after ftyp', async () => {
    const movie = await readMovie(ra(bytes(cat(ftyp('isom'), moovBox()))));
    expect(movie.brand).toBe('isom');
    expect(movie.tracks).toHaveLength(2);
  });

  it('handles a 64-bit largesize moov box', async () => {
    const movie = await readMovie(ra(bytes(cat(ftyp('isom'), moovBoxLargesize()))));
    expect(movie.tracks).toHaveLength(2);
  });

  it('finds moov after mdat (not faststart)', async () => {
    const mdat = box('mdat', zeros(64));
    const movie = await readMovie(ra(bytes(cat(ftyp('qt  '), mdat, moovBox()))));
    expect(movie.brand).toBe('qt  ');
  });

  it('throws when there is no moov (size-0 box runs to EOF)', async () => {
    const freeToEof = cat(be32(0), str('free')); // size 0 → "to end of file"
    const buf = bytes(cat(ftyp('isom'), freeToEof, zeros(20)));
    await expect(readMovie(ra(buf))).rejects.toThrowError(/no moov/);
  });
});
