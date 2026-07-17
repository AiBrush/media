import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TELEMETRY_SEEDED_TIER_THRESHOLDS } from './tier-thresholds-telemetry.ts';
import {
  TINY_AUDIO_FRAMES,
  TINY_INPUT_BYTES,
  TINY_MEDIA_SECONDS,
  TINY_VIDEO_PIXELS,
  TINY_VIDEO_PIXEL_WORK,
} from './tier-thresholds.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const thresholdsPath = fileURLToPath(new URL('./tier-thresholds.ts', import.meta.url));
const telemetryPath = fileURLToPath(new URL('./tier-thresholds-telemetry.ts', import.meta.url));

describe('ADR-020 tier thresholds — single source of truth (R-S01.3)', () => {
  it('pins the exact scalar thresholds the router imports', () => {
    expect(TINY_INPUT_BYTES).toBe(64 * 1024);
    expect(TINY_VIDEO_PIXELS).toBe(64 * 64);
    expect(TINY_MEDIA_SECONDS).toBe(1);
    expect(TINY_AUDIO_FRAMES).toBe(48_000);
    // ADR-199 compound ceiling: identity 64×64 work at the 30 fps planning cadence.
    expect(TINY_VIDEO_PIXEL_WORK).toBe((64 * 64 + 64 * 64) * 30);
  });

  it('builds the telemetry-seeded object from the scalar consts, never a re-hardcoded copy', () => {
    expect(TELEMETRY_SEEDED_TIER_THRESHOLDS.tinyInputBytes).toBe(TINY_INPUT_BYTES);
    expect(TELEMETRY_SEEDED_TIER_THRESHOLDS.tinyVideoPixels).toBe(TINY_VIDEO_PIXELS);
    expect(TELEMETRY_SEEDED_TIER_THRESHOLDS.tinyMediaSeconds).toBe(TINY_MEDIA_SECONDS);
    expect(TELEMETRY_SEEDED_TIER_THRESHOLDS.tinyAudioFrames).toBe(TINY_AUDIO_FRAMES);
    expect(TELEMETRY_SEEDED_TIER_THRESHOLDS.tinyVideoPixelWork).toBe(TINY_VIDEO_PIXEL_WORK);

    // The numbers must exist exactly once (in tier-thresholds.ts). The telemetry module may not carry
    // its own numeric copies that can silently drift from the consts the router routes on.
    const telemetrySource = readFileSync(telemetryPath, 'utf8');
    expect(telemetrySource).not.toMatch(/64\s*\*\s*1024/);
    expect(telemetrySource).not.toMatch(/64\s*\*\s*64/);
    expect(telemetrySource).not.toMatch(/48[_,]?000/);
    expect(telemetrySource).not.toMatch(/\*\s*30\b/);
    expect(telemetrySource).toMatch(/from '\.\/tier-thresholds\.ts'/);
  });

  it('records provenance matching the committed fresh-benchmark baselines bit-exactly', () => {
    expect(TELEMETRY_SEEDED_TIER_THRESHOLDS.provenance.length).toBeGreaterThanOrEqual(3);
    expect(TELEMETRY_SEEDED_TIER_THRESHOLDS.provenance.map((p) => p.path)).toContain(
      'fixtures/golden/bench/containers.json',
    );
    for (const entry of TELEMETRY_SEEDED_TIER_THRESHOLDS.provenance) {
      const baseline = JSON.parse(readFileSync(join(repoRoot, entry.path), 'utf8')) as {
        generatedAt?: unknown;
        runtime?: unknown;
      };
      // Strict oracle on the real committed golden: any regeneration of a baseline without a matching
      // provenance refresh (or vice versa) fails here.
      expect({
        path: entry.path,
        generatedAt: baseline.generatedAt,
        runtime: baseline.runtime,
      }).toEqual({
        path: entry.path,
        generatedAt: entry.generatedAt,
        runtime: entry.runtime,
      });
    }
  });

  it('exports nothing from either threshold module without a non-test importer', () => {
    const consumers = [
      ...tsSourcesUnder(join(repoRoot, 'src')),
      ...tsSourcesUnder(join(repoRoot, 'scripts')),
    ]
      .filter((path) => path !== thresholdsPath && path !== telemetryPath)
      .filter((path) => !path.includes(join('src', 'test-support')))
      .map((path) => readFileSync(path, 'utf8'));

    const cases: readonly { file: string; specifier: RegExp }[] = [
      { file: thresholdsPath, specifier: /from\s+'[^']*\/tier-thresholds\.ts'/ },
      { file: telemetryPath, specifier: /from\s+'[^']*\/tier-thresholds-telemetry\.ts'/ },
    ];
    for (const { file, specifier } of cases) {
      const exported = exportedSymbolsOf(readFileSync(file, 'utf8'));
      expect(exported.length).toBeGreaterThan(0);
      for (const name of exported) {
        const nameRe = new RegExp(`\\b${name}\\b`);
        const consumed = consumers.some((source) => specifier.test(source) && nameRe.test(source));
        expect(consumed, `export '${name}' of ${file} has no non-test importer`).toBe(true);
      }
    }
  });
});

function exportedSymbolsOf(source: string): readonly string[] {
  const names: string[] = [];
  const re = /^export (?:const|interface|type|function|class) ([A-Za-z0-9_]+)/gm;
  for (;;) {
    const match = re.exec(source);
    if (match === null) return names;
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
}

function tsSourcesUnder(root: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsSourcesUnder(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(path);
    }
  }
  return out;
}
