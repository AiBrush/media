import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'gen-deficits.mjs');

const metric = (median) => ({
  n: 5,
  warmup: 1,
  metric: 'wall',
  median,
  p95: median,
  mad: 0,
  unit: 'ms',
  samples: [median, median, median, median, median],
});

const result = ({ engineId, file, isBaked, median, candidateCount = 2, scenario = 'probe/x' }) => ({
  engineId,
  browser: 'chromium',
  scenarioId: scenario,
  family: 'probe',
  selection: { file, isBaked, candidateCount, sha256: `${file}-sha` },
  status: 'PASS',
  bench: { wall: metric(median) },
});

const writeExport = (root, name, generatedAtIso, results) => {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify({ generatedAtIso, results }));
  return path;
};

const withWorkspace = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'aibrush-deficits-'));
  mkdirSync(join(root, 'docs/perf'), { recursive: true });
  writeFileSync(join(root, 'docs/perf/performance-parity-exemptions.json'), '[]\n');
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const run = (root, paths) =>
  spawnSync(process.execPath, [script, ...paths], {
    cwd: root,
    encoding: 'utf8',
  });

test('preserves rotations and compares only identical same-export work', () => {
  withWorkspace((root) => {
    const first = writeExport(root, 'first.json', '2026-07-11T00:00:00.000Z', [
      result({ engineId: 'aibrush-media@dev', file: 'base.mp4', isBaked: true, median: 10 }),
      result({ engineId: 'rival@1', file: 'base.mp4', isBaked: true, median: 5 }),
    ]);
    const second = writeExport(root, 'second.json', '2026-07-11T01:00:00.000Z', [
      result({ engineId: 'aibrush-media@dev', file: '01.mp4', isBaked: false, median: 8 }),
      result({ engineId: 'rival@1', file: '01.mp4', isBaked: false, median: 9 }),
    ]);

    const completed = run(root, [first, second]);
    assert.equal(completed.status, 1, 'the real wall loss must keep the gate red');
    const data = JSON.parse(readFileSync(join(root, 'docs/perf/_deficit-data.json'), 'utf8'));
    assert.equal(data.rotationGaps.length, 0);
    assert.equal(data.metricRotationGaps.length, 0);
    assert.equal(data.contested.wall, 2);
    assert.equal(data.wallLossCount, 1);
    assert.match(data.losses[0].rotation, /^baked:base\.mp4@/);
  });
});

test('never splices our result and a rival result from separate exports', () => {
  withWorkspace((root) => {
    const ours = writeExport(root, 'ours.json', '2026-07-11T00:00:00.000Z', [
      result({
        engineId: 'aibrush-media@dev',
        file: 'base.mp4',
        isBaked: true,
        median: 10,
        candidateCount: 1,
      }),
    ]);
    const rival = writeExport(root, 'rival.json', '2026-07-11T00:01:00.000Z', [
      result({
        engineId: 'rival@1',
        file: 'base.mp4',
        isBaked: true,
        median: 5,
        candidateCount: 1,
      }),
    ]);

    const completed = run(root, [ours, rival]);
    assert.equal(completed.status, 1, 'missing same-export evidence must keep the gate red');
    const data = JSON.parse(readFileSync(join(root, 'docs/perf/_deficit-data.json'), 'utf8'));
    assert.equal(data.contested.wall, 0);
    assert.equal(data.wallLossCount, 0);
    assert.equal(data.comparisonEvidenceMissing, true);
  });
});

test('a fresh partial export cannot inherit stale correctness coverage', () => {
  withWorkspace((root) => {
    const stale = writeExport(root, 'stale.json', '2026-07-01T00:00:00.000Z', [
      result({
        engineId: 'aibrush-media@dev',
        file: 'old.mp4',
        isBaked: true,
        median: 1,
        candidateCount: 1,
        scenario: 'probe/old',
      }),
      result({
        engineId: 'rival@1',
        file: 'old.mp4',
        isBaked: true,
        median: 2,
        candidateCount: 1,
        scenario: 'probe/old',
      }),
    ]);
    const fresh = writeExport(root, 'fresh.json', '2026-07-11T00:00:00.000Z', [
      result({
        engineId: 'aibrush-media@dev',
        file: 'new.mp4',
        isBaked: true,
        median: 1,
        candidateCount: 1,
        scenario: 'probe/new',
      }),
      result({
        engineId: 'rival@1',
        file: 'new.mp4',
        isBaked: true,
        median: 2,
        candidateCount: 1,
        scenario: 'probe/new',
      }),
    ]);

    const completed = run(root, [stale, fresh]);
    assert.equal(completed.status, 1);
    const data = JSON.parse(readFileSync(join(root, 'docs/perf/_deficit-data.json'), 'utf8'));
    assert.deepEqual(data.staleSources, ['stale.json']);
    assert.deepEqual(
      data.rotationGaps.map((gap) => gap.scenario),
      ['probe/old'],
    );
  });
});

test('a newer corpus digest supersedes the old bytes in the same rotation slot', () => {
  withWorkspace((root) => {
    const oldResult = result({
      engineId: 'aibrush-media@dev',
      file: '01.mp4',
      isBaked: false,
      median: 10,
      candidateCount: 1,
    });
    oldResult.selection.sha256 = 'old-sha';
    oldResult.status = 'FAIL';
    oldResult.reason = 'old corpus bytes failed';
    const old = writeExport(root, 'old.json', '2026-07-11T00:00:00.000Z', [oldResult]);

    const repaired = result({
      engineId: 'aibrush-media@dev',
      file: '01.mp4',
      isBaked: false,
      median: 9,
      candidateCount: 1,
    });
    repaired.selection.sha256 = 'repaired-sha';
    const rival = result({
      engineId: 'rival@1',
      file: '01.mp4',
      isBaked: false,
      median: 10,
      candidateCount: 1,
    });
    rival.selection.sha256 = 'repaired-sha';
    const fresh = writeExport(root, 'fresh.json', '2026-07-11T01:00:00.000Z', [repaired, rival]);

    const completed = run(root, [old, fresh]);
    assert.equal(completed.status, 0);
    const data = JSON.parse(readFileSync(join(root, 'docs/perf/_deficit-data.json'), 'utf8'));
    assert.equal(data.functionalReds.length, 0);
    assert.equal(data.rotationGaps.length, 0);
  });
});

test('gates single-sample wall and treats zero-sample memory as unmeasured', () => {
  withWorkspace((root) => {
    const ours = result({
      engineId: 'aibrush-media@dev',
      file: 'base.mp4',
      isBaked: true,
      median: 5,
      candidateCount: 1,
    });
    const rival = result({
      engineId: 'rival@1',
      file: 'base.mp4',
      isBaked: true,
      median: 6,
      candidateCount: 1,
    });
    for (const row of [ours, rival]) {
      row.bench.wall.n = 1;
      row.bench.wall.samples = [row.bench.wall.median];
      row.bench.peakMemory = {
        n: 0,
        warmup: 1,
        metric: 'peakMemory',
        median: 0,
        p95: 0,
        mad: 0,
        unit: 'bytes',
        samples: [],
      };
    }
    const source = writeExport(root, 'single.json', '2026-07-11T00:00:00.000Z', [ours, rival]);

    const completed = run(root, [source]);
    assert.equal(completed.status, 1);
    const data = JSON.parse(readFileSync(join(root, 'docs/perf/_deficit-data.json'), 'utf8'));
    assert.equal(data.sampleGaps.length, 2);
    assert.equal(data.contested.wall, 1);
    assert.equal(data.contested.peakMemory, 0);
    assert.equal(data.peakMemoryLossCount, 0);
  });
});

test('gates an engine NA when a rival passes the same rotation', () => {
  withWorkspace((root) => {
    const ours = result({
      engineId: 'aibrush-media@dev',
      file: 'base.mp4',
      isBaked: true,
      median: 5,
      candidateCount: 1,
    });
    ours.status = 'NA_ENGINE';
    ours.bench = undefined;
    const rival = result({
      engineId: 'rival@1',
      file: 'base.mp4',
      isBaked: true,
      median: 6,
      candidateCount: 1,
    });
    const source = writeExport(root, 'coverage.json', '2026-07-11T00:00:00.000Z', [ours, rival]);

    const completed = run(root, [source]);
    assert.equal(completed.status, 1);
    const data = JSON.parse(readFileSync(join(root, 'docs/perf/_deficit-data.json'), 'utf8'));
    assert.equal(data.coverageGaps.length, 1);
    assert.equal(data.coverageGaps[0].s, 'probe/x');
    assert.equal(data.exemptCoverageGaps.length, 0);
  });
});
