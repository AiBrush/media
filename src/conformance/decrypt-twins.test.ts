/**
 * `decrypt` against cleartext twins produced by INDEPENDENT tools (doc 11 §1: decrypt-bitexact; §3.F).
 *
 * The existing decrypt tests (`src/drivers/mp4/cenc-ops.test.ts`, `cbcs.test.ts`, `src/crypto/hls-aes.test.ts`)
 * round-trip through our *own* encryptor — strong, but our-encrypt→our-decrypt is not a fully external
 * oracle. THIS file closes that gap with twins encrypted by tools we did not write:
 *
 *   - **HLS AES-128**: the ciphertext was produced by the `openssl` CLI (`openssl enc -aes-128-cbc`) and is
 *     committed under `fixtures/golden/decrypt/`. `decryptHlsAes128` recovering the committed plaintext
 *     sha256 is a true external oracle (the only way to pass is to correctly invert openssl's AES-128-CBC).
 *   - **CENC (cenc-aes-ctr)**: the encrypted MP4 was produced by `ffmpeg -encryption_scheme cenc-aes-ctr`
 *     and is committed; `media.decrypt({scheme:'cenc'})` must recover audio samples whose sha256 list equals
 *     the CLEAR original's (the twin). ffmpeg wrote the `tenc`/`senc`/`pssh` protection boxes, so this
 *     exercises our real CENC parser + AES-CTR sample decryptor against a foreign encoder.
 *
 * Both twins + the committed cipher files are checksum-pinned (the golden carries `cipherSha256`), so the
 * test reads the verified local cache (no network, no runtime shell-out) — the same discipline as the
 * media corpus (BUILD_INSTRUCTIONS §6.1). ADR-085.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../api/create-media.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { hexToBytes } from '../crypto/aes.ts';
import { decryptHlsAes128 } from '../crypto/hls-aes.ts';
import { muxTracksFromMovie, readMovie } from '../drivers/mp4/mp4-driver.ts';
import { fromBytes } from '../sources/source.ts';
import { sha256Hex } from '../util/digest.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const DECRYPT_DIR = `${ROOT}fixtures/golden/decrypt`;

interface HlsTwin {
  scheme: 'hls-aes128';
  tool: string;
  plaintextId: string;
  keyHex: string;
  ivHex: string;
  cipherFile: string;
  cipherSha256: string;
  plaintextBytes: number;
  plaintextSha256: string;
}
interface CencTwin {
  scheme: 'cenc';
  tool: string;
  clearId: string;
  keyHex: string;
  kidHex: string;
  cipherFile: string;
  cipherSha256: string;
  audioSampleCount: number;
  clearAudioSampleSha256: string[];
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(`${DECRYPT_DIR}/${name}`, 'utf8')) as T;
}
/** Read a golden binary into a fresh `Uint8Array<ArrayBuffer>` (satisfies `BufferSource` for WebCrypto). */
async function readBin(name: string): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await readFile(`${DECRYPT_DIR}/${name}`);
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number): Promise<Uint8Array> => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});
/** Copy a byte view into a fresh `Uint8Array<ArrayBuffer>` (so it satisfies `BufferSource` for WebCrypto). */
function asBufferSource(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(view.byteLength));
  out.set(view);
  return out;
}
async function mp4AudioSampleShas(mp4: Uint8Array): Promise<string[]> {
  const movie = await readMovie(ra(mp4));
  const tracks = await muxTracksFromMovie(ra(mp4), movie);
  const idx = movie.tracks.findIndex((t) => t.mediaType === 'audio');
  const samples = tracks[idx]?.samples ?? [];
  return Promise.all(samples.map((s) => sha256Hex(asBufferSource(s.data))));
}

describe('decrypt twin — HLS AES-128 ciphertext produced by the openssl CLI', () => {
  it('the committed ciphertext is byte-identical to its pinned sha256 (verified cache, no shell-out)', async () => {
    const twin = await readJson<HlsTwin>('hls-aes128.json');
    const cipher = await readBin(twin.cipherFile);
    expect(await sha256Hex(cipher)).toBe(twin.cipherSha256);
    // PKCS#7 padding ⇒ ciphertext is a whole number of 16-byte blocks and strictly larger than plaintext.
    expect(cipher.byteLength % 16).toBe(0);
    expect(cipher.byteLength).toBeGreaterThan(twin.plaintextBytes);
  });

  it('decryptHlsAes128 recovers the exact original plaintext from openssl ciphertext (external oracle)', async () => {
    const twin = await readJson<HlsTwin>('hls-aes128.json');
    const cipher = await readBin(twin.cipherFile);
    const recovered = await decryptHlsAes128(
      cipher,
      hexToBytes(twin.keyHex),
      hexToBytes(twin.ivHex),
    );
    expect(recovered.byteLength).toBe(twin.plaintextBytes);
    expect(await sha256Hex(recovered)).toBe(twin.plaintextSha256); // bit-exact recovery
  });

  it('the oracle can fail — a wrong key does not recover the committed plaintext', async () => {
    const twin = await readJson<HlsTwin>('hls-aes128.json');
    const cipher = await readBin(twin.cipherFile);
    const wrong = hexToBytes('ffffffffffffffffffffffffffffffff');
    // AES-128-CBC + PKCS#7 with a wrong key almost always throws on the pad check; if it doesn't, the bytes
    // must differ. Either way it must NOT reproduce the plaintext digest.
    const recovered = await decryptHlsAes128(cipher, wrong, hexToBytes(twin.ivHex)).catch(
      () => undefined,
    );
    if (recovered) expect(await sha256Hex(recovered)).not.toBe(twin.plaintextSha256);
  });
});

describe('decrypt twin — CENC (cenc-aes-ctr) MP4 produced by ffmpeg', () => {
  it('the committed encrypted MP4 is byte-identical to its pinned sha256', async () => {
    const twin = await readJson<CencTwin>('cenc-aes-ctr.json');
    expect(await sha256Hex(await readBin(twin.cipherFile))).toBe(twin.cipherSha256);
  });

  it('media.decrypt(cenc) recovers ffmpeg-encrypted audio samples matching the clear twin (external oracle)', async () => {
    const twin = await readJson<CencTwin>('cenc-aes-ctr.json');
    const enc = await readBin(twin.cipherFile);
    const out = await createMedia().decrypt(fromBytes(enc, { mime: 'video/mp4' }), {
      scheme: 'cenc',
      keys: { [twin.kidHex]: twin.keyHex },
    });
    expect(out).toBeInstanceOf(Blob);
    const dec = new Uint8Array(await (out as Blob).arrayBuffer());
    const shas = await mp4AudioSampleShas(dec);
    expect(shas.length).toBe(twin.audioSampleCount);
    expect(shas).toEqual(twin.clearAudioSampleSha256); // every audio sample byte-exact vs the clear twin
  });

  it('the twin is non-degenerate (real multi-sample audio track)', async () => {
    const twin = await readJson<CencTwin>('cenc-aes-ctr.json');
    expect(twin.audioSampleCount).toBeGreaterThan(10);
    expect(new Set(twin.clearAudioSampleSha256).size).toBeGreaterThan(10); // distinct samples (not a constant)
  });

  it('the oracle can fail — a wrong key does not recover the clear audio twin', async () => {
    const twin = await readJson<CencTwin>('cenc-aes-ctr.json');
    const enc = await readBin(twin.cipherFile);
    const out = await createMedia().decrypt(fromBytes(enc, { mime: 'video/mp4' }), {
      scheme: 'cenc',
      keys: { [twin.kidHex]: 'ffffffffffffffffffffffffffffffff' },
    });
    const shas = await mp4AudioSampleShas(new Uint8Array(await (out as Blob).arrayBuffer()));
    expect(shas).not.toEqual(twin.clearAudioSampleSha256);
  });

  it('the oracle can fail — a missing key for the KID is a typed CapabilityError', async () => {
    const twin = await readJson<CencTwin>('cenc-aes-ctr.json');
    const enc = await readBin(twin.cipherFile);
    await expect(
      createMedia().decrypt(fromBytes(enc, { mime: 'video/mp4' }), { scheme: 'cenc', keys: {} }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('the oracle can fail — a contradictory scheme (cenc file asked as cbcs) is a typed MediaError', async () => {
    const twin = await readJson<CencTwin>('cenc-aes-ctr.json');
    const enc = await readBin(twin.cipherFile);
    const err = await createMedia()
      .decrypt(fromBytes(enc, { mime: 'video/mp4' }), {
        scheme: 'cbcs',
        keys: { [twin.kidHex]: twin.keyHex },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });
});
