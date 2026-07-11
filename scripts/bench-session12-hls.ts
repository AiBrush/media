import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveHlsSource } from '../src/drivers/hls/hls-source.ts';

const fixtureRoot = new URL(
  '../../media-test/fixtures/media/scenarios/probe/hls_aes128/',
  import.meta.url,
);
const playlistUrl = new URL('hls_aes128.m3u8', fixtureRoot);
const playlistText = await readFile(fileURLToPath(playlistUrl), 'utf8');
const warmup = 2;
const sampleCount = 5;

async function fetchLocalFile(uri: string): Promise<Uint8Array> {
  const url = new URL(uri);
  if (url.protocol !== 'file:') throw new Error(`benchmark attempted non-file fetch: ${uri}`);
  return new Uint8Array(await readFile(fileURLToPath(url)));
}

async function resolveAndDigest(): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const source = await resolveHlsSource(playlistText, {
    baseUrl: pathToFileURL(fileURLToPath(playlistUrl)).href,
    fetchResource: fetchLocalFile,
  });
  const reader = source.stream().getReader();
  const hash = createHash('sha256');
  let bytes = 0;
  let firstByte: number | undefined;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (firstByte === undefined) firstByte = next.value[0];
      bytes += next.value.byteLength;
      hash.update(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (firstByte !== 0x47)
    throw new Error(`stitched HLS output has sync byte ${firstByte ?? 'none'}`);
  if (bytes <= 188) throw new Error(`stitched HLS output is too small: ${bytes} bytes`);
  return { bytes, sha256: hash.digest('hex') };
}

for (let index = 0; index < warmup; index += 1) await resolveAndDigest();
const samples: number[] = [];
const hashes: string[] = [];
let outputBytes = 0;
for (let index = 0; index < sampleCount; index += 1) {
  const start = performance.now();
  const result = await resolveAndDigest();
  samples.push(performance.now() - start);
  hashes.push(result.sha256);
  outputBytes = result.bytes;
}
if (new Set(hashes).size !== 1) throw new Error('HLS stitched outputs are not byte-deterministic');
const sorted = [...samples].sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      fixture: fileURLToPath(playlistUrl),
      warmup,
      samplesMs: samples,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      outputBytes,
      sha256: hashes[0],
    },
    null,
    2,
  ),
);
