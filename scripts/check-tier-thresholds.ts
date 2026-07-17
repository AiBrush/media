#!/usr/bin/env bun

/**
 * ADR-020 threshold provenance gate — the production consumer of the telemetry-seeded thresholds
 * (`src/kernel/tier-thresholds-telemetry.ts`, R-S01.3).
 *
 * Verifies, with exit-code-1 on any drift:
 *   1. the telemetry-seeded object mirrors the scalar consts the router routes on (the numbers must
 *      exist exactly once, in `tier-thresholds.ts`);
 *   2. every recorded provenance entry names a committed fresh-benchmark baseline under
 *      `fixtures/golden/bench/` whose `generatedAt`/`runtime` match bit-exactly — so a regenerated
 *      baseline can never ride silently under stale threshold provenance (this exact drift occurred:
 *      containers.json was regenerated 2026-06-30 while the provenance still said 2026-06-26).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TELEMETRY_SEEDED_TIER_THRESHOLDS,
  type TelemetrySeededTierThresholds,
  type ThresholdProvenance,
} from '../src/kernel/tier-thresholds-telemetry.ts';
import {
  TINY_AUDIO_FRAMES,
  TINY_INPUT_BYTES,
  TINY_MEDIA_SECONDS,
  TINY_VIDEO_PIXELS,
  TINY_VIDEO_PIXEL_WORK,
} from '../src/kernel/tier-thresholds.ts';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) return;
  failures += 1;
  console.error(`DRIFT ${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function checkBaseline(entry: ThresholdProvenance): void {
  const path = fileURLToPath(new URL(`../${entry.path}`, import.meta.url));
  let baseline: { generatedAt?: unknown; runtime?: unknown };
  try {
    baseline = JSON.parse(readFileSync(path, 'utf8')) as {
      generatedAt?: unknown;
      runtime?: unknown;
    };
  } catch (error) {
    failures += 1;
    console.error(`DRIFT ${entry.path}: unreadable committed baseline (${String(error)})`);
    return;
  }
  check(`${entry.path} generatedAt`, baseline.generatedAt, entry.generatedAt);
  check(`${entry.path} runtime`, baseline.runtime, entry.runtime);
}

const thresholds: TelemetrySeededTierThresholds = TELEMETRY_SEEDED_TIER_THRESHOLDS;
check('tinyInputBytes', thresholds.tinyInputBytes, TINY_INPUT_BYTES);
check('tinyVideoPixels', thresholds.tinyVideoPixels, TINY_VIDEO_PIXELS);
check('tinyMediaSeconds', thresholds.tinyMediaSeconds, TINY_MEDIA_SECONDS);
check('tinyAudioFrames', thresholds.tinyAudioFrames, TINY_AUDIO_FRAMES);
check('tinyVideoPixelWork', thresholds.tinyVideoPixelWork, TINY_VIDEO_PIXEL_WORK);

if (thresholds.provenance.length < 3) {
  failures += 1;
  console.error(
    `DRIFT provenance: expected >= 3 committed baselines, got ${thresholds.provenance.length}`,
  );
}
for (const entry of thresholds.provenance) checkBaseline(entry);

if (failures > 0) {
  console.error(`tier-thresholds: ${failures} drift(s) — refresh the provenance or the baselines.`);
  process.exit(1);
}
console.log(
  `tier-thresholds: single-sourced scalars verified; ${thresholds.provenance.length} committed baselines match bit-exactly.`,
);
