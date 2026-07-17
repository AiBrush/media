/**
 * Guards for the eager-kernel routing seam (S13 items 11/12, docs/architecture/codec-pipeline.md §5):
 * the `chooseOutputContainer` default is pinned against non-chunk-muxable sources, a genuinely
 * non-muxable explicit target surfaces the container router's typed `CapabilityError` (never a broken
 * output), and the eager-kernel boundary — heavy codec-pipeline layers reachable only via dynamic
 * `import()` — is enforced by a static-import-closure walk instead of a prose comment.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import { fixtureSource } from '../test-support/corpus.ts';
import { chooseOutputContainer, containerHasChunkMuxer, isPcmContainer } from './codec-routing.ts';
import { createMedia } from './create-media.ts';

describe('chooseOutputContainer guard (item 11)', () => {
  it('defaults to mp4 for every source container without a chunk muxer', () => {
    // PCM containers author through transformPcm, not the EncodedChunk seam — never a default target.
    for (const source of ['aiff', 'caf', 'wav'] as const) {
      expect(chooseOutputContainer(undefined, source)).toBe('mp4');
    }
    // Unknown/probe-only tokens and absent source facts also land on the universal default.
    expect(chooseOutputContainer(undefined, 'gif')).toBe('mp4');
    expect(chooseOutputContainer(undefined, undefined)).toBe('mp4');
  });

  it('returns an explicit non-muxable target unchanged — the container router owns the reject', () => {
    expect(containerHasChunkMuxer('aiff')).toBe(false);
    expect(isPcmContainer('aiff')).toBe(true);
    expect(chooseOutputContainer('aiff', 'mp4')).toBe('aiff');
  });

  it('surfaces the container router typed miss for a genuinely non-muxable video target', async () => {
    // A video track cannot ride the PCM path, and AIFF has no EncodedChunk muxer: the route must be
    // an honest typed capability miss — never a silently broken output file.
    const media = createMedia();
    let failure: unknown;
    try {
      await media.convert(await fixtureSource('movie_5.mp4'), { to: 'aiff' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CapabilityError);
    const miss = failure as CapabilityError;
    expect(miss.code).toBe('capability-miss');
    expect(miss.message).toContain('aiff');
    expect(miss.message).toContain('no muxer');
    expect(miss.detail?.tried).toContain('aiff');
  });
});

// ── item 12 (+ item 1 probe-only closure): the eager-kernel boundary is a test, not a comment ────

const SRC_ROOT = new URL('../', import.meta.url);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Static (bundled) import/re-export specifiers of one module; type-only and dynamic edges excluded. */
function staticImportSpecifiers(source: string): string[] {
  const stripped = stripComments(source);
  const specifiers: string[] = [];
  for (const match of stripped.matchAll(
    /(?:^|\n)\s*(import|export)\s([^;'"]*?)from\s*['"]([^'"]+)['"]/g,
  )) {
    const clause = `${match[1] ?? ''} ${match[2] ?? ''}`;
    if (/^(?:import|export)\s+type\b/.test(clause.trim())) continue; // erased at compile time
    if (match[3] !== undefined) specifiers.push(match[3]);
  }
  for (const match of stripped.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

/** Walk the STATIC import closure from an entry module; dynamic `import()` edges are not followed. */
function staticImportClosure(entry: URL): Set<string> {
  const visited = new Set<string>();
  const queue: URL[] = [entry];
  while (queue.length > 0) {
    const moduleUrl = queue.pop();
    if (moduleUrl === undefined) continue;
    const path = fileURLToPath(moduleUrl);
    if (visited.has(path)) continue;
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue; // non-file specifier (package import) — not part of the kernel source closure
    }
    visited.add(path);
    for (const specifier of staticImportSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      queue.push(new URL(specifier, moduleUrl));
    }
  }
  return visited;
}

describe('eager-kernel boundary (item 12 + item 1 probe-only closure)', () => {
  const closure = staticImportClosure(new URL('index.ts', SRC_ROOT));
  const closureHas = (suffix: string): boolean =>
    [...closure].some((path) => path.endsWith(suffix));

  it('the walker genuinely reaches the kernel (sanity: cheap routing + engine are in the closure)', () => {
    // The eager kernel is deliberately tiny (~19 modules: entry, engine, kernel/*, sources, sinks,
    // contracts, codec-routing). A closure under 15 means the walker broke; far larger means the
    // kernel grew heavy edges.
    expect(closure.size).toBeGreaterThanOrEqual(15);
    expect(closure.size).toBeLessThan(40);
    expect(closureHas('src/api/engine.ts')).toBe(true);
    expect(closureHas('src/api/codec-routing.ts')).toBe(true);
    expect(closureHas('src/kernel/router.ts')).toBe(true);
  });

  it('no heavy S13 layer module is statically reachable from the eager default entry', () => {
    const heavyModules = [
      'src/api/codec-pipeline.ts',
      'src/api/codec-strings.ts',
      'src/api/codec-queries.ts',
      'src/api/encoder-config.ts',
      'src/api/mux-trackinfo.ts',
      'src/api/vpx-alpha.ts',
      'src/api/codec-live.ts',
      'src/api/codec-runtime-quirks.ts',
    ] as const;
    for (const module of heavyModules) {
      expect(closureHas(module), `${module} must stay behind a dynamic import()`).toBe(false);
    }
  });

  it('the engine reaches the codec pipeline exclusively through a dynamic import()', () => {
    const engine = readFileSync(fileURLToPath(new URL('api/engine.ts', SRC_ROOT)), 'utf8');
    expect(engine).toContain("import('./codec-pipeline.ts')");
    expect(staticImportSpecifiers(engine)).not.toContain('./codec-pipeline.ts');
  });
});
