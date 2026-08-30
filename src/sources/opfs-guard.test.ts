import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OPFS_SPILL_STRATEGY,
  assertOpfsSyncHandleScope,
  isOpfsSyncHandleAllowed,
} from './opfs-guard.ts';

describe('opfs-guard — OPFS spill + sync handle only in dedicated worker (1.1.5)', () => {
  it('allows sync handle inside dedicated-worker scopes', () => {
    expect(isOpfsSyncHandleAllowed('dedicated-worker')).toBe(true);
    expect(isOpfsSyncHandleAllowed('src/kernel/worker.ts')).toBe(true);
    expect(isOpfsSyncHandleAllowed('src/kernel/worker-main.ts')).toBe(true);
    expect(isOpfsSyncHandleAllowed('src/kernel/worker-entry.ts')).toBe(true);
    expect(() => assertOpfsSyncHandleScope('dedicated-worker')).not.toThrow();
    expect(() => assertOpfsSyncHandleScope('src/kernel/worker.ts')).not.toThrow();
  });

  it('rejects sync handle on the main thread / outside worker bundle', () => {
    expect(isOpfsSyncHandleAllowed('src/sinks/materialize.ts')).toBe(false);
    expect(isOpfsSyncHandleAllowed('src/sources/opfs.ts')).toBe(false);
    expect(isOpfsSyncHandleAllowed('src/index.ts')).toBe(false);
    expect(() => assertOpfsSyncHandleScope('src/sinks/materialize.ts')).toThrow(
      /only allowed inside a dedicated worker/,
    );
    const err = (() => {
      try {
        assertOpfsSyncHandleScope('src/index.ts');
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err?.message).toMatch(/REQUIREMENTS §7\.3/);
  });

  it('boundary: empty / malformed caller is rejected (no silent allow)', () => {
    expect(isOpfsSyncHandleAllowed('')).toBe(false);
    expect(isOpfsSyncHandleAllowed(' ')).toBe(false);
    expect(() => assertOpfsSyncHandleScope('')).toThrow();
    expect(isOpfsSyncHandleAllowed('worker.ts.bak')).toBe(false);
    expect(() => assertOpfsSyncHandleScope('worker.ts.bak')).toThrow();
  });

  it('spill strategy documents async OPFS + Blob segments (no sync handle)', () => {
    expect(OPFS_SPILL_STRATEGY).toMatch(/async OPFS/);
    expect(OPFS_SPILL_STRATEGY).toMatch(/Blob segments/);
    expect(OPFS_SPILL_STRATEGY).toMatch(/only in dedicated worker/);
  });

  it('source scan: no SyncAccessHandle/createSyncAccessHandle outside kernel/worker* (generalized invariant)', () => {
    const srcRoot = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === 'node_modules' || entry === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
        // Allowed worker files may reference sync handles (none do today, but permitted).
        if (full.includes('src/kernel/worker')) continue;
        if (full.endsWith('opfs-guard.ts')) continue;
        const text = readFileSync(full, 'utf8');
        if (/SyncAccessHandle|createSyncAccessHandle/.test(text)) offenders.push(full);
      }
    };
    walk(srcRoot);
    expect(
      offenders,
      `OPFS sync handle found outside worker bundle: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('20× randomized caller paths are classified bit-exact vs worker-prefix check', () => {
    const cases: Array<[string, boolean]> = [
      ['src/kernel/worker.ts', true],
      ['src/kernel/worker-main.ts', true],
      ['dedicated-worker', true],
      ['src/api/engine.ts', false],
      ['src/sinks/opfs-target.ts', false],
    ];
    // Expand with randomized suffixes/prefixes.
    for (let i = 0; i < 20; i++) {
      const r = `src/${Math.random().toString(36).slice(2, 6)}/file${i}.ts`;
      const expected = r.includes('src/kernel/worker');
      expect(isOpfsSyncHandleAllowed(r)).toBe(expected);
      // Throw parity.
      const didThrow = (() => {
        try {
          assertOpfsSyncHandleScope(r);
          return false;
        } catch {
          return true;
        }
      })();
      expect(didThrow).toBe(!expected);
    }
    for (const [path, expected] of cases) expect(isOpfsSyncHandleAllowed(path)).toBe(expected);
  });
});
