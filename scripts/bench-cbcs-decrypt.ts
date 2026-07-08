#!/usr/bin/env bun
/**
 * scripts/bench-cbcs-decrypt.ts — fresh, multi-sample wall-time + throughput benchmark for the whole-file
 * CENC `cbcs` decrypt engine ({@link decryptCencFile}). It builds REAL cbcs-encrypted MP4s from a clear
 * fixture (per-sample-IV `1:9` video-style pattern, full-block `1:0`, and constant-IV `0:0` full-sample
 * audio-style) and decrypts each end to end: locate protected samples, AES-CBC-pattern decrypt in place,
 * neutralize the protection signalling. Reports the median of N runs (warmup discarded) and MB/s over the
 * whole-file byte volume, with a checksum so the AES work cannot be elided. Guards the engine against
 * per-op / per-sample overhead and whole-file re-scan regressions (the two Session-9 speed root causes).
 *
 *   bun scripts/bench-cbcs-decrypt.ts
 */

import { decryptCencFile } from '../src/drivers/mp4/cenc.ts';
import { encryptCbcs } from '../src/test-support/cbcs-encrypt.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const KEY = '000102030405060708090a0b0c0d0e0f';
const KID = '00112233445566778899aabbccddeeff';
const CONST_IV = '101112131415161718191a1b1c1d1e1f';
const WARMUP = 2;
const ITERS = 9;

let sink = 0;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** A sparse byte checksum of the decrypted output so the engine's work cannot be optimized away. */
function checksum(bytes: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < bytes.byteLength; i += 4096) acc = (acc + (bytes[i] ?? 0)) | 0;
  return acc;
}

async function main(): Promise<void> {
  const clear = new Uint8Array(await Bun.file(`${ROOT}fixtures/media/movie_5.mp4`).arrayBuffer());
  const assets = [
    {
      name: 'cbcs 1:9 per-sample-IV (audio)',
      bytes: await encryptCbcs(clear, {
        keyHex: KEY,
        kidHex: KID,
        cryptByteBlock: 1,
        skipByteBlock: 9,
      }),
    },
    {
      name: 'cbcs 1:0 full-block (audio)',
      bytes: await encryptCbcs(clear, {
        keyHex: KEY,
        kidHex: KID,
        cryptByteBlock: 1,
        skipByteBlock: 0,
      }),
    },
    {
      name: 'cbcs 0:0 constant-IV full-sample',
      bytes: await encryptCbcs(clear, {
        keyHex: KEY,
        kidHex: KID,
        cryptByteBlock: 0,
        skipByteBlock: 0,
        constantIvHex: CONST_IV,
      }),
    },
  ];

  console.info(`cbcs decryptCencFile wall time — median of ${ITERS} runs, warmup ${WARMUP}:`);
  const decrypt = (bytes: Uint8Array) =>
    decryptCencFile(bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
  for (const asset of assets) {
    const first = await decrypt(asset.bytes);
    if (first.byteLength !== asset.bytes.byteLength) {
      throw new Error(`length changed: ${first.byteLength} != ${asset.bytes.byteLength}`);
    }
    for (let i = 0; i < WARMUP; i++) sink = (sink + checksum(await decrypt(asset.bytes))) | 0;
    const times: number[] = [];
    for (let i = 0; i < ITERS; i++) {
      const t0 = Bun.nanoseconds();
      sink = (sink + checksum(await decrypt(asset.bytes))) | 0;
      times.push(Bun.nanoseconds() - t0);
    }
    const ns = median(times);
    const msPerOp = ns / 1e6;
    const mbPerSec = asset.bytes.byteLength / (ns / 1e9) / 1e6;
    console.info(
      `  ${asset.name.padEnd(34)} ${msPerOp.toFixed(3).padStart(9)} ms  ${mbPerSec.toFixed(0).padStart(6)} MB/s  (${(asset.bytes.byteLength / 1024).toFixed(0)} KiB)`,
    );
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
