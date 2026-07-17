import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural acceptance for the job-runner decomposition (execution-runtime §5 item 2): the god-file is
 * split by concern into schema / compile / progress / run modules behind the stable `job-runner.ts`
 * facade, every module stays small, and the module graph is a DAG (no import cycle).
 */

const FAMILY = [
  'job-runner.ts',
  'job-run.ts',
  'job-compile.ts',
  'job-progress.ts',
  'job-schema.ts',
  'job-schema-targets.ts',
  'job-schema-values.ts',
] as const;

const MAX_MODULE_LINES = 350;

const here = dirname(fileURLToPath(import.meta.url));

async function moduleSource(name: string): Promise<string> {
  return readFile(resolve(here, name), 'utf8');
}

function relativeImports(source: string): string[] {
  const imports: string[] = [];
  const pattern = /from\s+'(\.[^']+)'/g;
  for (;;) {
    const match = pattern.exec(source);
    if (match === null) break;
    const specifier = match[1];
    if (specifier !== undefined) imports.push(specifier);
  }
  return imports;
}

describe('job runner decomposition', () => {
  it(`keeps every split module under ${MAX_MODULE_LINES} lines`, async () => {
    const oversized: string[] = [];
    for (const name of FAMILY) {
      const lines = (await moduleSource(name)).split('\n').length;
      if (lines >= MAX_MODULE_LINES) oversized.push(`${name}: ${lines} lines`);
    }
    expect(oversized).toEqual([]);
  });

  it('has no import cycle anywhere in the family module graph', async () => {
    // Build the intra-family dependency graph from real import statements.
    const edges = new Map<string, readonly string[]>();
    for (const name of FAMILY) {
      const source = await moduleSource(name);
      const targets = relativeImports(source)
        .map((specifier) => specifier.replace(/^\.\//, ''))
        .filter((specifier): specifier is (typeof FAMILY)[number] =>
          (FAMILY as readonly string[]).includes(specifier),
        );
      edges.set(name, targets);
    }

    // DFS three-color cycle detection.
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];
    const visit = (node: string, path: readonly string[]): void => {
      if (done.has(node)) return;
      if (visiting.has(node)) {
        cycles.push([...path, node].join(' → '));
        return;
      }
      visiting.add(node);
      for (const next of edges.get(node) ?? []) visit(next, [...path, node]);
      visiting.delete(node);
      done.add(node);
    };
    for (const name of FAMILY) visit(name, []);

    expect(cycles).toEqual([]);
    // Anti-cheat: the facade must genuinely depend on the run module, so the graph is non-trivial.
    expect(edges.get('job-runner.ts')).toContain('job-run.ts');
  });
});
