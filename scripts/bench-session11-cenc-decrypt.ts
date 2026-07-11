#!/usr/bin/env bun
/**
 * Session-11 CENC fixed-overhead benchmark (ADR-201). Builds encrypted variants from three distinct real
 * MP4 corpus files outside the timed region, validates every decrypted access unit against its clear
 * source, then reports warmup-discarded median wall time/throughput over nine samples. The first case is
 * also the committed ffmpeg-encrypted external twin; generated cases broaden size/sample-count coverage.
 *
 *   bun scripts/bench-session11-cenc-decrypt.ts
 */

import { readFile } from 'node:fs/promises';
import { decryptCencFile } from '../src/drivers/mp4/cenc.ts';
import { muxTracksFromMovie, readMovie } from '../src/drivers/mp4/mp4-driver.ts';
import { encryptCbcs } from '../src/test-support/cbcs-encrypt.ts';
import { encryptCenc } from '../src/test-support/cenc-encrypt.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const KEY = '000102030405060708090a0b0c0d0e0f';
const KID = '00112233445566778899aabbccddeeff';
const WARMUP = 3;
const ITERS = 9;

interface Asset {
  name: string;
  scheme: 'cenc' | 'cbcs';
  clear: Uint8Array;
  encrypted: Uint8Array;
}

interface CryptoCounts {
  imports: number;
  active: number;
  peak: number;
}

const randomAccess = (bytes: Uint8Array) => ({
  read: (offset: number, length: number) =>
    Promise.resolve(bytes.subarray(offset, offset + length)),
  size: bytes.byteLength,
});

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

function checksum(bytes: Uint8Array): number {
  let value = 0;
  for (let i = 0; i < bytes.byteLength; i += 4093) value = (value * 33 + (bytes[i] ?? 0)) | 0;
  return value;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Assert every track's coded samples are present, ordered, and byte-exact after decrypt. */
async function assertSamplesEqual(actual: Uint8Array, expected: Uint8Array): Promise<void> {
  const actualMovie = await readMovie(randomAccess(actual));
  const expectedMovie = await readMovie(randomAccess(expected));
  const actualTracks = await muxTracksFromMovie(randomAccess(actual), actualMovie);
  const expectedTracks = await muxTracksFromMovie(randomAccess(expected), expectedMovie);
  if (actualTracks.length !== expectedTracks.length)
    throw new Error('decrypted track count changed');
  for (let ti = 0; ti < expectedTracks.length; ti++) {
    const got = actualTracks[ti]?.samples ?? [];
    const want = expectedTracks[ti]?.samples ?? [];
    if (got.length !== want.length) throw new Error(`track ${ti} sample count changed`);
    for (let si = 0; si < want.length; si++) {
      const gotBytes = got[si]?.data;
      const wantBytes = want[si]?.data;
      if (!gotBytes || !wantBytes || !equalBytes(gotBytes, wantBytes)) {
        throw new Error(`track ${ti} sample ${si} differs after decrypt`);
      }
    }
  }
}

/** Count real native WebCrypto overlap for one untimed audit invocation. */
async function cryptoCounts(operation: () => Promise<Uint8Array>): Promise<CryptoCounts> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const nativeCrypto = globalThis.crypto;
  const counts: CryptoCounts = { imports: 0, active: 0, peak: 0 };
  const measuredSubtle = new Proxy(nativeCrypto.subtle, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'importKey') {
        return (...args: unknown[]) => {
          counts.imports += 1;
          return Reflect.apply(value, target, args);
        };
      }
      if (property === 'encrypt' || property === 'decrypt') {
        return (...args: unknown[]) => {
          counts.active += 1;
          counts.peak = Math.max(counts.peak, counts.active);
          return Promise.resolve(Reflect.apply(value, target, args)).finally(() => {
            counts.active -= 1;
          });
        };
      }
      return value.bind(target);
    },
  });
  Object.defineProperty(globalThis, 'crypto', {
    value: new Proxy(nativeCrypto, {
      get(target, property) {
        if (property === 'subtle') return measuredSubtle;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    configurable: true,
    enumerable: saved?.enumerable ?? true,
    writable: true,
  });
  try {
    await operation();
    return counts;
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
}

async function main(): Promise<void> {
  const ids = ['movie_5.mp4', 'test.mp4', 'bear-1280x720.mp4'] as const;
  const clear = await Promise.all(
    ids.map((id) =>
      readFile(`${ROOT}/fixtures/media/${id}`).then((bytes) => new Uint8Array(bytes)),
    ),
  );
  const ffmpegTwin = new Uint8Array(
    await readFile(`${ROOT}/fixtures/golden/decrypt/movie_5.mp4.cenc.mp4`),
  );
  const movie5 = clear[0];
  if (!movie5) throw new Error('movie_5.mp4 benchmark fixture is missing');
  const assets: Asset[] = [
    { name: 'ffmpeg cenc movie_5', scheme: 'cenc', clear: movie5, encrypted: ffmpegTwin },
  ];
  for (let i = 1; i < ids.length; i++) {
    const bytes = clear[i];
    if (!bytes) continue;
    assets.push({
      name: `cenc ${ids[i]}`,
      scheme: 'cenc',
      clear: bytes,
      encrypted: await encryptCenc(bytes, { keyHex: KEY, kidHex: KID }),
    });
  }
  for (let i = 0; i < ids.length; i++) {
    const bytes = clear[i];
    if (!bytes) continue;
    assets.push({
      name: `cbcs ${ids[i]}`,
      scheme: 'cbcs',
      clear: bytes,
      encrypted: await encryptCbcs(bytes, {
        keyHex: KEY,
        kidHex: KID,
        cryptByteBlock: 1,
        skipByteBlock: 9,
      }),
    });
  }

  let sink = 0;
  console.info(`CENC/CBCS whole-file decrypt — median ${ITERS}, warmup ${WARMUP}:`);
  for (const asset of assets) {
    const decrypt = () =>
      decryptCencFile(asset.encrypted, { scheme: asset.scheme, keys: { [KID]: KEY } });
    const first = await decrypt();
    await assertSamplesEqual(first, asset.clear);
    const counts = await cryptoCounts(decrypt);
    for (let i = 0; i < WARMUP; i++) sink = (sink + checksum(await decrypt())) | 0;
    const times: number[] = [];
    const rssBefore = process.memoryUsage().rss;
    let peakRss = rssBefore;
    for (let i = 0; i < ITERS; i++) {
      const start = Bun.nanoseconds();
      sink = (sink + checksum(await decrypt())) | 0;
      times.push((Bun.nanoseconds() - start) / 1e6);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const wallMs = median(times);
    const mbps = asset.encrypted.byteLength / 1e6 / (wallMs / 1_000);
    console.info(
      `  ${asset.name.padEnd(27)} ${wallMs.toFixed(3).padStart(8)} ms  ${mbps.toFixed(1).padStart(7)} MB/s` +
        `  imports ${counts.imports}  in-flight ${counts.peak}` +
        `  rss+ ${((peakRss - rssBefore) / 1024 / 1024).toFixed(2)} MiB`,
    );
  }
  console.info(`checksum ${sink}`);
}

await main();
