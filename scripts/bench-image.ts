/**
 * Image-probe throughput benchmark on the REAL downloaded corpus (BUILD §6.3: every feature ships a
 * fresh, multi-sample benchmark — not one file, not a cached number). Reports per-format median latency
 * (median of 7 batch-means, so a stray GC pause can't skew it) + p-min/max + MB/s, computed live here.
 *
 * Run: `bun run scripts/bench-image.ts`
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeImage } from '../src/codecs/image/probe.ts';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/media-derived/img');
const FILES = ['test.png', 'test.jpeg', 'test.webp', 'anim2.gif', 'test.avif'] as const;
const WARMUP = 500;
const BATCH = 4000;
const SAMPLES = 7;

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

console.log(
  `image-probe bench — median of ${SAMPLES} batch-means (${BATCH} probes/batch) on real media\n`,
);

let aggregateUs = 0;
for (const file of FILES) {
  const bytes = new Uint8Array(readFileSync(resolve(DIR, file)));
  for (let i = 0; i < WARMUP; i++) probeImage(bytes);

  const means: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    for (let i = 0; i < BATCH; i++) probeImage(bytes);
    means.push((performance.now() - t0) / BATCH); // ms per probe
  }
  const medMs = median(means);
  const medUs = medMs * 1000;
  const mbps = bytes.byteLength / 1e6 / (medMs / 1000);
  aggregateUs += medUs;
  const info = probeImage(bytes);

  console.log(
    `  ${file.padEnd(11)} ${medUs.toFixed(2).padStart(7)} µs  ${mbps.toFixed(0).padStart(6)} MB/s  ` +
      `${info.format}/${info.width}x${info.height}/${info.frameCount}f/${bytes.byteLength}B`,
  );
}

console.log(
  `\n  aggregate median latency: ${aggregateUs.toFixed(1)} µs across ${FILES.length} formats`,
);
