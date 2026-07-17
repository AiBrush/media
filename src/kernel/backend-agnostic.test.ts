import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The execution & runtime layer is deliberately backend-agnostic (execution-runtime §3.3): it carries
 * opaque codec/container tokens and must never name a tier, substrate, or implementation. This test
 * encodes that invariant — a future capability leak into any file of this family fails CI here.
 */

const OWNED_FILES = [
  // The seven owned files…
  'src/kernel/executor.ts',
  'src/kernel/planner.ts',
  'src/kernel/frames.ts',
  'src/api/job.ts',
  'src/api/job-runner.ts',
  'src/api/chain.ts',
  'src/api/chain-runner.ts',
  // …plus the job runner's split modules (the same layer, the same invariant).
  'src/api/job-run.ts',
  'src/api/job-compile.ts',
  'src/api/job-progress.ts',
  'src/api/job-schema.ts',
  'src/api/job-schema-targets.ts',
  'src/api/job-schema-values.ts',
] as const;

const FORBIDDEN = /webcodecs|wasm|\bgpu\b|dav1d|libvpx|libopus/i;

describe('execution-runtime backend agnosticism', () => {
  it('names no backend, tier, or codec implementation in any owned file', async () => {
    const root = new URL('../../', import.meta.url);
    const offenders: string[] = [];
    for (const file of OWNED_FILES) {
      const source = await readFile(fileURLToPath(new URL(file, root)), 'utf8');
      const lines = source.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line !== undefined && FORBIDDEN.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('cannot pass vacuously: the probe pattern must match a real leak', () => {
    // Anti-cheat: prove the oracle can fail by matching a representative leak line.
    expect(FORBIDDEN.test('route to the webcodecs tier')).toBe(true);
    expect(FORBIDDEN.test('const useGpu = true; // gpu path')).toBe(true);
    expect(FORBIDDEN.test('opaque codec token')).toBe(false);
  });
});
