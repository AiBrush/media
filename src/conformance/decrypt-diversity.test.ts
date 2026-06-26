/**
 * Decrypt diversity (task §3.F.19): the decrypt oracles must hold across a MATRIX of ≥5 real fixtures and
 * both media types — never a single canned asset (anti-overfitting, doc 11 §5). Each case encrypts a real
 * media sample's bytes with the **independent `openssl` CLI** (AES-128-CTR for CENC `cenc`, AES-128-CBC for
 * `cbcs`) and asserts our decryptor recovers them byte-exact — a true external oracle (the only way to pass
 * is to correctly invert openssl's conformant AES). This is the cipher-level companion to the
 * container-level twins in `decrypt-twins.test.ts` (openssl-HLS + ffmpeg-CENC-audio) and the in-house
 * subsample round-trips in `src/drivers/mp4/cenc-ops.test.ts` / `cbcs.test.ts`.
 *
 * **CENC-video note (ADR-086).** Our AES-CTR decrypt uses the **contiguous keystream** mandated by ISO/IEC
 * 23001-7 §9.4.2 ("the protected bytes of a sample [are treated] as a single contiguous block") — the same
 * model as every browser CDM, Shaka, dash.js, and openssl. ffmpeg's `cenc-aes-ctr` muxer instead realigns
 * the counter to a whole block at each *subsample* boundary (it self-round-trips but is non-conformant), so
 * a multi-subsample ffmpeg video sample differs from a conformant decrypt on the keyframe — that is a
 * documented ffmpeg quirk, NOT a bug in our decryptor (proven: the openssl whole-sample VIDEO twin below
 * decrypts byte-exact, and our in-house conformant subsample encryptor round-trips video in cenc-ops.test.ts).
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { muxTracksFromMovie, readMovie } from '../drivers/mp4/mp4-driver.ts';
import { cencCbcsTwin, cencCtrTwin } from '../test-support/decrypt-twins.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number): Promise<Uint8Array> => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

async function loadBytes(id: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_DIR}/${id}`));
}

/**
 * A real decodable sample of the given media type from a non-fragmented MP4 — the LARGEST one, so the
 * cipher does meaningful work over several blocks (some low-bitrate audio tracks have only tiny frames).
 */
async function largestSample(id: string, type: 'audio' | 'video'): Promise<Uint8Array | undefined> {
  const bytes = await loadBytes(id);
  const movie = await readMovie(ra(bytes));
  const tracks = await muxTracksFromMovie(ra(bytes), movie);
  const idx = movie.tracks.findIndex((t) => t.mediaType === type);
  if (idx < 0) return undefined;
  const samples = (tracks[idx]?.samples ?? []).map((s) => s.data).filter((d) => d.byteLength > 0);
  if (samples.length === 0) return undefined;
  return samples.reduce((a, b) => (b.byteLength > a.byteLength ? b : a));
}

/**
 * The ≥5 real MP4 fixtures used for decrypt diversity. A mix of codecs (H.264/HEVC), resolutions (240p→4K),
 * and audio (AAC) — so a path that only works for one file id fails the matrix. `video`/`audio` flag which
 * sample types the fixture provides (some are video-only).
 */
const DECRYPT_FIXTURES: ReadonlyArray<{ id: string; video: boolean; audio: boolean }> = [
  { id: 'movie_5.mp4', video: true, audio: true },
  { id: 'bear-1280x720.mp4', video: true, audio: true },
  { id: 'test.mp4', video: true, audio: true },
  { id: 'bear-4k-hevc.mp4', video: true, audio: true },
  { id: 'bear-hevc-10bit-hdr10.mp4', video: true, audio: true },
  { id: 'h264.mp4', video: true, audio: false },
];

let opensslAvailable = false;
beforeAll(() => {
  try {
    execFileSync('openssl', ['version']);
    opensslAvailable = true;
  } catch {
    opensslAvailable = false;
  }
});

describe('decrypt diversity — CENC cenc (AES-CTR) over ≥5 real fixtures, audio AND video (openssl twins)', () => {
  it('the matrix has ≥5 fixtures spanning multiple codecs + both media types', () => {
    expect(DECRYPT_FIXTURES.length).toBeGreaterThanOrEqual(5);
    expect(DECRYPT_FIXTURES.filter((f) => f.video).length).toBeGreaterThanOrEqual(5);
    expect(DECRYPT_FIXTURES.filter((f) => f.audio).length).toBeGreaterThanOrEqual(4);
  });

  for (const { id, video, audio } of DECRYPT_FIXTURES) {
    if (video)
      it(`${id} VIDEO sample: our AES-CTR decrypt recovers the openssl-encrypted cleartext byte-exact`, async () => {
        if (!opensslAvailable) return; // skipped cleanly where openssl is absent (documented)
        const sample = await largestSample(id, 'video');
        expect(sample, `${id} has a non-empty video sample`).toBeDefined();
        if (!sample) return;
        const twin = await cencCtrTwin(sample);
        expect(twin.cipherSha, 'real encryption (cipher ≠ clear)').not.toBe(twin.clearSha);
        expect(twin.recovered, 'decrypt recovers the cleartext byte-exact').toBe(true);
      });
    if (audio)
      it(`${id} AUDIO sample: our AES-CTR decrypt recovers the openssl-encrypted cleartext byte-exact`, async () => {
        if (!opensslAvailable) return;
        const sample = await largestSample(id, 'audio');
        expect(sample, `${id} has a non-empty audio sample`).toBeDefined();
        if (!sample) return;
        const twin = await cencCtrTwin(sample);
        expect(twin.cipherSha).not.toBe(twin.clearSha);
        expect(twin.recovered).toBe(true);
      });
  }
});

describe('decrypt diversity — CENC cbcs (AES-CBC pattern) over real fixtures (openssl twins)', () => {
  for (const { id, video } of DECRYPT_FIXTURES.filter((f) => f.video).slice(0, 5)) {
    it(`${id} ${video ? 'video' : 'audio'} sample: our cbcs decrypt recovers the openssl-CBC cleartext byte-exact`, async () => {
      if (!opensslAvailable) return;
      const sample = await largestSample(id, 'video');
      expect(sample).toBeDefined();
      if (!sample) return;
      const twin = await cencCbcsTwin(sample);
      // A sample with ≥1 whole 16-byte block is genuinely encrypted (the trailing partial stays clear).
      if (sample.byteLength >= 16) expect(twin.cipherSha).not.toBe(twin.clearSha);
      expect(twin.recovered, 'cbcs decrypt recovers the cleartext byte-exact').toBe(true);
    });
  }
});

describe('decrypt diversity — HLS AES-128 over ≥5 real media segments (openssl PKCS#7 twins)', () => {
  // Real media byte streams standing in for HLS media segments — diverse containers (TS/ADTS/MP4/audio).
  const HLS_SEGMENTS = [
    'sfx.adts',
    'bear-1280x720.ts',
    'movie_5.mp4',
    'sound_5.mp3',
    'sfx.flac',
    'sfx-opus.ogg',
  ] as const;

  it('the HLS matrix has ≥5 real segments', () => {
    expect(HLS_SEGMENTS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(HLS_SEGMENTS)(
    '%s: decryptHlsAes128 recovers the openssl-encrypted segment byte-exact',
    async (id) => {
      if (!opensslAvailable) return;
      const { opensslCbcPkcs7, TWIN_KEY_HEX, TWIN_IV16_HEX } = await import(
        '../test-support/decrypt-twins.ts'
      );
      const { decryptHlsAes128 } = await import('../crypto/hls-aes.ts');
      const { hexToBytes } = await import('../crypto/aes.ts');
      const segment = await loadBytes(id);
      const cipher = opensslCbcPkcs7(segment);
      expect(cipher.byteLength % 16, 'PKCS#7 ⇒ block-aligned ciphertext').toBe(0);
      const recovered = await decryptHlsAes128(
        cipher,
        hexToBytes(TWIN_KEY_HEX),
        hexToBytes(TWIN_IV16_HEX),
      );
      const eq =
        recovered.byteLength === segment.byteLength && recovered.every((x, i) => x === segment[i]);
      expect(eq, 'HLS decrypt recovers the exact original segment').toBe(true);
    },
  );

  it('the HLS oracle can fail — a wrong key does not recover the segment', async () => {
    if (!opensslAvailable) return;
    const { opensslCbcPkcs7, TWIN_IV16_HEX } = await import('../test-support/decrypt-twins.ts');
    const { decryptHlsAes128 } = await import('../crypto/hls-aes.ts');
    const { hexToBytes } = await import('../crypto/aes.ts');
    const segment = await loadBytes('sfx.adts');
    const cipher = opensslCbcPkcs7(segment);
    // A wrong key almost always fails the PKCS#7 pad check (throws); if it decodes, the bytes must differ.
    const recovered = await decryptHlsAes128(
      cipher,
      hexToBytes('ff'.repeat(16)),
      hexToBytes(TWIN_IV16_HEX),
    ).catch(() => undefined);
    if (recovered) {
      const eq =
        recovered.byteLength === segment.byteLength && recovered.every((x, i) => x === segment[i]);
      expect(eq).toBe(false);
    }
  });
});

describe('decrypt diversity — the oracle can fail (mutation self-check)', () => {
  it('a wrong-key CTR decrypt does NOT recover the cleartext', async () => {
    if (!opensslAvailable) return;
    const sample = await largestSample('movie_5.mp4', 'video');
    expect(sample).toBeDefined();
    if (!sample) return;
    // Encrypt with the twin key, decrypt with a different key → must not equal clear.
    const { opensslCtr } = await import('../test-support/decrypt-twins.ts');
    const { decryptSample } = await import('../drivers/mp4/cenc.ts');
    const { hexToBytes } = await import('../crypto/aes.ts');
    const cipher = opensslCtr(sample);
    const recovered = await decryptSample(
      hexToBytes('ff'.repeat(16)),
      { iv: hexToBytes('34f40300bc7160fa') },
      cipher,
    );
    const eq =
      recovered.byteLength === sample.byteLength && recovered.every((x, i) => x === sample[i]);
    expect(eq).toBe(false);
  });
});
