import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { encryptCenc, encryptCens } from '../../test-support/cenc-encrypt.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';

const KEY = '000102030405060708090a0b0c0d0e0f';
const KID = '00112233445566778899aabbccddeeff';
const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/** The audio track's per-sample byte arrays (the bit-exact oracle target). */
async function audioSamples(mp4: Uint8Array): Promise<Uint8Array[]> {
  const movie = await readMovie(ra(mp4));
  const tracks = await muxTracksFromMovie(ra(mp4), movie);
  const idx = movie.tracks.findIndex((t) => t.mediaType === 'audio');
  return (tracks[idx]?.samples ?? []).map((s) => s.data);
}
async function blobBytes(
  out: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}
const encSource = (bytes: Uint8Array) => fromBytes(bytes, { mime: 'video/mp4' });

describe('media.decrypt — CENC (cenc / AES-CTR) on real MP4 (ADR-023)', () => {
  it('decrypt(encrypt(movie_5.mp4)) recovers the audio samples bit-exact', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const enc = await encryptCenc(clear, { keyHex: KEY, kidHex: KID });

    const clearAudio = await audioSamples(clear);
    expect(clearAudio.length).toBeGreaterThan(10); // diverse, multi-sample
    // Real encryption happened: the ciphertext samples differ from the cleartext.
    expect(await audioSamples(enc)).not.toEqual(clearAudio);

    const out = await blobBytes(
      await createMedia().decrypt(encSource(enc), { scheme: 'cenc', keys: { [KID]: KEY } }),
    );
    expect(await audioSamples(out)).toEqual(clearAudio);
  });

  it('probe sees through CENC to the original codec (enca → mp4a)', async () => {
    const enc = await encryptCenc(await loadFixture('movie_5.mp4'), { keyHex: KEY, kidHex: KID });
    const info = await createMedia().probe(encSource(enc));
    expect(info.container).toBe('mp4');
    expect(info.tracks.find((t) => t.type === 'audio')?.codec).toMatch(/^mp4a/);
  });

  it('a wrong key does not recover the cleartext', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const enc = await encryptCenc(clear, { keyHex: KEY, kidHex: KID });
    const out = await blobBytes(
      await createMedia().decrypt(encSource(enc), {
        scheme: 'cenc',
        keys: { [KID]: 'ffffffffffffffffffffffffffffffff' },
      }),
    );
    expect(await audioSamples(out)).not.toEqual(await audioSamples(clear));
  });

  it('rejects a missing key for the KID with a typed CapabilityError', async () => {
    const enc = await encryptCenc(await loadFixture('movie_5.mp4'), { keyHex: KEY, kidHex: KID });
    await expect(
      createMedia().decrypt(encSource(enc), { scheme: 'cenc', keys: {} }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('rejects a scheme that contradicts the container (cenc file asked as cbcs) with a MediaError', async () => {
    // `cbcs` and `hls-aes128` are now supported schemes (see cbcs.test.ts); asking for `cbcs` on a file
    // whose `schm` says `cenc` is a scheme mismatch — corrupt/contradictory input, a typed MediaError
    // (NOT a CapabilityError, which is reserved for a genuinely-unsupported capability).
    const enc = await encryptCenc(await loadFixture('movie_5.mp4'), { keyHex: KEY, kidHex: KID });
    const err = await createMedia()
      .decrypt(encSource(enc), { scheme: 'cbcs', keys: { [KID]: KEY } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('cancels an in-flight decrypt via the handle', async () => {
    const enc = await encryptCenc(await loadFixture('movie_5.mp4'), { keyHex: KEY, kidHex: KID });
    const handle = createMedia().decrypt(encSource(enc), { scheme: 'cenc', keys: { [KID]: KEY } });
    handle.cancel();
    await expect(handle).rejects.toBeInstanceOf(MediaError);
  });
});

describe('media.decrypt — CENC cens (AES-CTR pattern) on real MP4', () => {
  it('decrypt(encryptCens(movie_5.mp4)) recovers the audio samples bit-exact', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const enc = await encryptCens(clear, { keyHex: KEY, kidHex: KID });

    const clearAudio = await audioSamples(clear);
    expect(clearAudio.length).toBeGreaterThan(10);
    expect(await audioSamples(enc)).not.toEqual(clearAudio);

    const out = await blobBytes(
      await createMedia().decrypt(encSource(enc), { scheme: 'cens', keys: { [KID]: KEY } }),
    );
    expect(await audioSamples(out)).toEqual(clearAudio);
  });

  it('rejects a scheme that contradicts the container (cens file asked as cenc)', async () => {
    const enc = await encryptCens(await loadFixture('movie_5.mp4'), { keyHex: KEY, kidHex: KID });
    const err = await createMedia()
      .decrypt(encSource(enc), { scheme: 'cenc', keys: { [KID]: KEY } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('a wrong key does not recover the cens cleartext', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const enc = await encryptCens(clear, { keyHex: KEY, kidHex: KID });
    const out = await blobBytes(
      await createMedia().decrypt(encSource(enc), {
        scheme: 'cens',
        keys: { [KID]: 'ffffffffffffffffffffffffffffffff' },
      }),
    );
    expect(await audioSamples(out)).not.toEqual(await audioSamples(clear));
  });
});
