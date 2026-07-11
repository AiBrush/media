/**
 * CENC fixed-overhead guards (ADR-201). A whole-file decrypt must prepare one non-extractable WebCrypto
 * key per KID, run independent samples through a bounded native-crypto window, and still recover every
 * real-media access unit in container order. The CTR fixture is the committed ffmpeg-encrypted twin; the
 * CBCS case is independently encrypted before instrumentation so encryptor setup cannot pollute metrics.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { hexToBytes } from '../../crypto/aes.ts';
import { encryptCbcs } from '../../test-support/cbcs-encrypt.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { CENC_DECRYPT_MAX_IN_FLIGHT, decryptCencFile, decryptSamples } from './cenc.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import { buildSampleData } from './samples.ts';

const KEY = '000102030405060708090a0b0c0d0e0f';
const KID = '00112233445566778899aabbccddeeff';
const CENC_TWIN = new URL('../../../fixtures/golden/decrypt/movie_5.mp4.cenc.mp4', import.meta.url)
  .pathname;

interface CryptoImport {
  extractable: unknown;
  usages: string[];
}

interface CryptoMetrics {
  imports: CryptoImport[];
  transforms: number;
  completedTransforms: number;
  inFlight: number;
  peakInFlight: number;
}

function cryptoMetrics(): CryptoMetrics {
  return { imports: [], transforms: 0, completedTransforms: 0, inFlight: 0, peakInFlight: 0 };
}

/** Install a transparent SubtleCrypto meter for one operation, then restore the exact global descriptor. */
async function withCryptoMetrics<T>(
  metrics: CryptoMetrics,
  operation: () => Promise<T>,
): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const nativeCrypto = globalThis.crypto;
  const measuredSubtle = new Proxy(nativeCrypto.subtle, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'importKey') {
        return (...args: unknown[]) => {
          const rawUsages = args[4];
          metrics.imports.push({
            extractable: args[3],
            usages: Array.isArray(rawUsages)
              ? rawUsages.filter((usage): usage is string => typeof usage === 'string')
              : [],
          });
          return Reflect.apply(value, target, args);
        };
      }
      if (property === 'encrypt' || property === 'decrypt') {
        return async (...args: unknown[]) => {
          metrics.transforms += 1;
          metrics.inFlight += 1;
          metrics.peakInFlight = Math.max(metrics.peakInFlight, metrics.inFlight);
          try {
            // Make overlapping submissions observable without replacing the real AES primitive.
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
            return await Reflect.apply(value, target, args);
          } finally {
            metrics.inFlight -= 1;
            metrics.completedTransforms += 1;
          }
        };
      }
      return value.bind(target);
    },
  });
  const measuredCrypto = new Proxy(nativeCrypto, {
    get(target, property) {
      if (property === 'subtle') return measuredSubtle;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.defineProperty(globalThis, 'crypto', {
    value: measuredCrypto,
    configurable: true,
    enumerable: saved?.enumerable ?? true,
    writable: true,
  });
  try {
    return await operation();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
}

const randomAccess = (bytes: Uint8Array) => ({
  read: (offset: number, length: number) =>
    Promise.resolve(bytes.subarray(offset, offset + length)),
  size: bytes.byteLength,
});

/** The real audio access units in container order (the bit-exact oracle). */
async function audioSamples(mp4: Uint8Array): Promise<Uint8Array[]> {
  const movie = await readMovie(randomAccess(mp4));
  const tracks = await muxTracksFromMovie(randomAccess(mp4), movie);
  const index = movie.tracks.findIndex((track) => track.mediaType === 'audio');
  return (tracks[index]?.samples ?? []).map((sample) => sample.data);
}

describe('decryptCencFile — prepared keys and bounded sample parallelism (ADR-201)', () => {
  it('imports one CTR key, overlaps within the bound, and preserves every ordered real AAC sample', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const encrypted = new Uint8Array(await readFile(CENC_TWIN));
    const metrics = cryptoMetrics();
    const result = await withCryptoMetrics(metrics, () =>
      decryptCencFile(encrypted, { scheme: 'cenc', keys: { [KID]: KEY } }),
    );

    expect(metrics.imports).toEqual([{ extractable: false, usages: ['encrypt'] }]);
    expect(metrics.transforms).toBeGreaterThan(10);
    expect(metrics.peakInFlight).toBeGreaterThan(1);
    expect(metrics.peakInFlight).toBeLessThanOrEqual(CENC_DECRYPT_MAX_IN_FLIGHT);
    expect(metrics.completedTransforms).toBe(metrics.transforms);
    expect(metrics.inFlight).toBe(0);
    expect(await audioSamples(result)).toEqual(await audioSamples(clear));
  });

  it('imports one usage-minimal CBC key and preserves CBCS pattern/subsample sample order', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const encrypted = await encryptCbcs(clear, {
      keyHex: KEY,
      kidHex: KID,
      cryptByteBlock: 1,
      skipByteBlock: 9,
    });
    const metrics = cryptoMetrics();
    const result = await withCryptoMetrics(metrics, () =>
      decryptCencFile(encrypted, { scheme: 'cbcs', keys: { [KID]: KEY } }),
    );

    // CBC no-padding decryption needs decrypt plus one encrypt for its synthetic PKCS#7 tail block.
    expect(metrics.imports).toEqual([{ extractable: false, usages: ['encrypt', 'decrypt'] }]);
    expect(metrics.transforms).toBeGreaterThan(10);
    expect(metrics.peakInFlight).toBeGreaterThan(1);
    expect(metrics.peakInFlight).toBeLessThanOrEqual(CENC_DECRYPT_MAX_IN_FLIGHT);
    expect(await audioSamples(result)).toEqual(await audioSamples(clear));
  });

  it('waits for admitted crypto after a lowest-index malformed sample, then rejects without output', async () => {
    const encrypted = new Uint8Array(await readFile(CENC_TWIN));
    const movie = await readMovie(randomAccess(encrypted));
    const protectedTrack = movie.tracks.find(
      (track) =>
        track.encryption !== undefined && track.samples.sampleSizes.some((size) => size >= 16),
    );
    expect(protectedTrack).toBeDefined();
    if (!protectedTrack) return;
    const first = buildSampleData(protectedTrack)[0];
    expect(first).toBeDefined();
    if (!first) return;
    const malformed = encrypted.slice();
    malformed.fill(0, first.offset, first.offset + first.size);

    const metrics = cryptoMetrics();
    let output: Uint8Array | undefined;
    const error = await withCryptoMetrics(metrics, () =>
      decryptCencFile(malformed, { scheme: 'cenc', keys: { [KID]: KEY } }),
    ).then(
      (value) => {
        output = value;
        return undefined;
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(MediaError);
    expect(output).toBeUndefined();
    expect(metrics.transforms).toBeGreaterThan(0);
    expect(metrics.completedTransforms).toBe(metrics.transforms);
    expect(metrics.inFlight).toBe(0);
    expect(metrics.peakInFlight).toBeLessThanOrEqual(CENC_DECRYPT_MAX_IN_FLIGHT);
  });

  it('keeps empty batch semantics and does not import a key when there is no sample work', async () => {
    const metrics = cryptoMetrics();
    const result = await withCryptoMetrics(metrics, () => decryptSamples(hexToBytes(KEY), [], []));
    expect(result).toEqual([]);
    expect(metrics.imports).toEqual([]);
    expect(metrics.transforms).toBe(0);
  });

  it('rejects a sparse sample batch instead of returning a partially populated output', async () => {
    const sparse = new Array<Uint8Array>(2);
    sparse[0] = Uint8Array.of(1, 2, 3);
    await expect(decryptSamples(hexToBytes(KEY), sparse, [])).rejects.toBeInstanceOf(MediaError);
  });
});
