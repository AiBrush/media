// Standalone real-decode harness for the vendored Symphonia AAC wasm core (ADR-037).
//
// Run as a child process by `aac.test.ts`: it instantiates the actual `aac_wasm_bg.wasm`, de-frames a
// real ADTS/AAC-LC fixture, decodes every frame, and prints a JSON summary the test asserts on. This runs
// in a clean Node runtime — the wasm-bindgen glue's heap-object table is corrupted by Vitest's V8
// coverage instrumentation when the same wasm is driven inside the Vitest worker, so the *codec* is
// validated here (real bytes, real decode, the AAC-LC 1024-samples/frame oracle) while the Vitest file
// keeps the pure-helper + driver-contract assertions. Not shipped (a `.mjs` test harness, excluded from
// the build/tsconfig).
//
//   node decode-fixture.mjs <path-to-adts-fixture>

import { readFile } from 'node:fs/promises';

const here = new URL('.', import.meta.url);
const wasmPath = new URL('./aac_wasm_bg.wasm', here);
const gluePath = new URL('./aac-core.js', here);

const MPEG4_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Minimal ADTS de-framer: yields raw AAC payloads + the first frame's geometry (mirrors aac.ts). */
function readAdts(bytes) {
  let off = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    off =
      10 +
      (((bytes[6] & 0x7f) << 21) |
        ((bytes[7] & 0x7f) << 14) |
        ((bytes[8] & 0x7f) << 7) |
        (bytes[9] & 0x7f));
  }
  const frames = [];
  let sampleRate = 0;
  let channels = 0;
  let objectType = 0;
  while (off + 7 <= bytes.length) {
    const sync = (bytes[off] << 4) | (bytes[off + 1] >> 4);
    if (sync !== 0xfff) throw new Error(`lost ADTS sync at ${off}`);
    const protAbsent = bytes[off + 1] & 0x01;
    const b2 = bytes[off + 2];
    const b3 = bytes[off + 3];
    const profile = (b2 >> 6) & 0x03;
    const freqIndex = (b2 >> 2) & 0x0f;
    const chanCfg = ((b2 & 0x01) << 2) | (b3 >> 6);
    const frameLen = ((b3 & 0x03) << 11) | (bytes[off + 4] << 3) | (bytes[off + 5] >> 5);
    const headerLen = protAbsent === 1 ? 7 : 9;
    if (frames.length === 0) {
      sampleRate = MPEG4_RATES[freqIndex] ?? 0;
      channels = chanCfg;
      objectType = profile + 1;
    }
    frames.push(bytes.subarray(off + headerLen, off + frameLen));
    off += frameLen;
  }
  return { frames, sampleRate, channels, objectType };
}

async function main() {
  const fixture = process.argv[2];
  if (!fixture) throw new Error('usage: node decode-fixture.mjs <adts-fixture>');
  const mod = await import(gluePath.href);
  await mod.default({ module_or_path: await WebAssembly.compile(await readFile(wasmPath)) });

  const bytes = new Uint8Array(await readFile(fixture));
  const { frames, sampleRate, channels, objectType } = readAdts(bytes);

  const dec = new mod.AacWasm(new Uint8Array(0), channels, sampleRate);
  // Read the geometry getters ONCE, before decoding: the stream geometry is fixed, and the wasm-bindgen
  // glue prefers a single round-trip per handle (repeated getter calls interleaved with decode round-trips
  // can corrupt the heap-object table on some runtimes).
  const decChannels = dec.channels;
  const decSampleRate = dec.sampleRate;
  let decodedFrames = 0;
  let totalSamples = 0;
  let everyFrame1024 = true;
  let allFinite = true;
  let nonSilent = false;

  for (const payload of frames) {
    const pcm = dec.decode(payload);
    const n = decChannels > 0 ? pcm.length / decChannels : 0;
    if (n === 0) continue;
    decodedFrames++;
    totalSamples += n;
    if (n !== 1024) everyFrame1024 = false;
    for (let k = 0; k < pcm.length; k++) {
      const v = pcm[k];
      if (!Number.isFinite(v) || v < -1.05 || v > 1.05) allFinite = false;
      if (v !== 0) nonSilent = true;
    }
  }
  dec.free();

  process.stdout.write(
    JSON.stringify({
      adtsObjectType: objectType,
      adtsSampleRate: sampleRate,
      adtsChannels: channels,
      reportedChannels: decChannels,
      reportedSampleRate: decSampleRate,
      nFrames: frames.length,
      decodedFrames,
      totalSamples,
      everyFrame1024,
      allFinite,
      nonSilent,
    }),
  );
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});
