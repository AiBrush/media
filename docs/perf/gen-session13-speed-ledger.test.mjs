import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'gen-session13-speed-ledger.mjs');
const roster = [
  'aibrush-media@dev',
  'ffmpeg.wasm@0.12.15',
  'mediabunny@1.48.0',
  'mp4box@2.3.0',
  'remotion-media-parser@4.0.479',
  'remotion-webcodecs@4.0.479',
  'web-demuxer@4.0.0',
];

const samplesAround = (value, spread) => [
  value - spread,
  value,
  value + spread,
  value - spread,
  value + spread,
];

const metric = (name, value, spread = 0) => ({
  n: 5,
  warmup: 1,
  metric: name,
  median: value,
  p95: value + spread,
  mad: spread,
  unit: name === 'wall' ? 'ms' : 'bytes',
  samples: samplesAround(value, spread),
});

const singleMemoryMetric = (value) => ({
  n: 1,
  warmup: 1,
  metric: 'peakMemory',
  median: value,
  p95: value,
  mad: 0,
  unit: 'bytes',
  samples: [value],
});

const sha = (file) => Buffer.from(file).toString('hex').padEnd(64, '0').slice(0, 64);

const cohort = ({
  file,
  candidateCount = 2,
  scenario = 'probe/x',
  ourWall = 5,
  ourMad = 0.2,
  rivalWall = 8,
  rivalMad = 0.2,
  ourMemory = 100,
  rivalMemory = 120,
  runSeed = `seed-${file}`,
}) =>
  roster.map((engineId, index) => ({
    engineId,
    browser: 'chromium',
    scenarioId: scenario,
    family: scenario.split('/')[0],
    env: {
      suiteVersion: '0.1.0',
      browserVersion: '149.0.0.0',
      corpusChecksum: 'corpus',
    },
    selection: {
      file,
      sha256: sha(file),
      isBaked: false,
      runSeed,
      candidateCount,
    },
    status: 'PASS',
    oracleOutcomes: [{ oracle: 'golden-metadata', pass: true }],
    bench: {
      wall:
        engineId === 'aibrush-media@dev'
          ? metric('wall', ourWall, ourMad)
          : metric('wall', rivalWall + index, rivalMad),
      peakMemory:
        engineId === 'aibrush-media@dev'
          ? metric('peakMemory', ourMemory)
          : metric('peakMemory', rivalMemory + index),
    },
  }));

const writeExport = (root, name, generatedAtIso, results, overrides = {}) => {
  const path = join(root, name);
  const scenarios = [...new Set(results.map((result) => result.scenarioId))].sort();
  const value = {
    schema: 'media-browser-test/results@1',
    generatedAtIso,
    env: {
      browser: 'chromium',
      userAgent: 'test-agent',
      version: '149.0.0.0',
      gpu: 'test-gpu',
    },
    support: { measureMemory: true },
    launcher: {
      playwrightBrowser: 'chromium',
      playwrightVersion: '149.0.0.0',
      pillar: 'all',
      filter: {
        browser: 'chromium',
        pillar: 'all',
        reuseSuccessful: false,
        scenarioIds: scenarios,
        warmup: 1,
        iters: 5,
      },
    },
    results,
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(value));
  return path;
};

const withWorkspace = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'aibrush-session13-ledger-'));
  mkdirSync(join(root, 'docs/perf'), { recursive: true });
  writeFileSync(join(root, 'docs/perf/performance-parity-exemptions.json'), '[]\n');
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const run = (root, paths) =>
  spawnSync(process.execPath, [script, '--now=2026-07-12T01:00:00.000Z', ...paths], {
    cwd: root,
    encoding: 'utf8',
  });

const data = (root) =>
  JSON.parse(readFileSync(join(root, 'docs/perf/_session13-speed-ledger-data.json'), 'utf8'));

test('requires every rotation and retains the worst pairwise sum-MAD result', () => {
  withWorkspace((root) => {
    const first = writeExport(
      root,
      'first.json',
      '2026-07-12T00:00:00.000Z',
      cohort({ file: '01.mp4', ourWall: 5, rivalWall: 8 }),
    );
    const second = writeExport(
      root,
      'second.json',
      '2026-07-12T00:10:00.000Z',
      cohort({ file: '02.mp4', ourWall: 8.7, ourMad: 0.2, rivalWall: 8, rivalMad: 0.2 }),
    );
    const completed = run(root, [first, second]);
    assert.equal(completed.status, 1, 'a within-noise rotation must keep the ledger red');
    const row = data(root).rows[0];
    assert.equal(row.status, 'PARITY');
    assert.match(row.worstRotation, /02\.mp4/);
    assert.equal(row.measuredRotations, 2);
    assert.equal(row.coverageComplete, true);
  });
});

test('chooses the worst rotation across every passing rival, not only the fastest median', () => {
  withWorkspace((root) => {
    const noisySlowerRival = cohort({
      file: '01.mp4',
      ourWall: 5,
      ourMad: 0,
      rivalWall: 8,
      rivalMad: 0,
    });
    const webDemuxer = noisySlowerRival.find((result) => result.engineId === 'web-demuxer@4.0.0');
    webDemuxer.bench.wall = metric('wall', 20, 16);
    const first = writeExport(root, 'first.json', '2026-07-12T00:00:00.000Z', noisySlowerRival);
    const second = writeExport(
      root,
      'second.json',
      '2026-07-12T00:10:00.000Z',
      cohort({ file: '02.mp4', ourWall: 5, rivalWall: 4.2 }),
    );

    const completed = run(root, [first, second]);
    assert.equal(completed.status, 1);
    const row = data(root).rows[0];
    assert.equal(row.status, 'PARITY');
    assert.match(row.worstRotation, /01\.mp4/);
    assert.equal(row.rotations[0].wall.worstWallPair.engineId, 'web-demuxer@4.0.0');
  });
});

test('marks a complete durable wall and memory sweep LEAD', () => {
  withWorkspace((root) => {
    const first = writeExport(
      root,
      'first.json',
      '2026-07-12T00:00:00.000Z',
      cohort({ file: '01.mp4' }),
    );
    const second = writeExport(
      root,
      'second.json',
      '2026-07-12T00:10:00.000Z',
      cohort({ file: '02.mp4', ourWall: 5.5, rivalWall: 8.5 }),
    );
    const completed = run(root, [first, second]);
    assert.equal(completed.status, 0, completed.stderr);
    const output = data(root);
    assert.equal(output.qualified, true);
    assert.equal(output.rows[0].status, 'LEAD');
    assert.equal(output.rows[0].memoryStatus, 'QUALIFIED');
  });
});

test('reports a durable rival lead and a memory exceedance as BEHIND', () => {
  withWorkspace((root) => {
    const first = writeExport(
      root,
      'first.json',
      '2026-07-12T00:00:00.000Z',
      cohort({ file: '01.mp4', candidateCount: 1, ourWall: 10, rivalWall: 6, ourMemory: 200 }),
    );
    const completed = run(root, [first]);
    assert.equal(completed.status, 1);
    const row = data(root).rows[0];
    assert.equal(row.status, 'BEHIND');
    assert.equal(row.memoryStatus, 'BEHIND');
  });
});

test('gates zero-sample memory instead of manufacturing a win', () => {
  withWorkspace((root) => {
    const results = cohort({ file: '01.mp4', candidateCount: 1 });
    for (const result of results) {
      result.bench.peakMemory = {
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
    const source = writeExport(root, 'memory.json', '2026-07-12T00:00:00.000Z', results);
    const completed = run(root, [source]);
    assert.equal(completed.status, 1);
    const row = data(root).rows[0];
    assert.equal(row.status, 'PARITY');
    assert.equal(row.memoryStatus, 'UNQUALIFIED');
    assert.ok(row.gaps.some((gap) => /peakMemory\.n must be >=1/.test(gap)));
  });
});

test('accepts one positive post-warmup memory sample while retaining the n>=5 wall gate', () => {
  withWorkspace((root) => {
    const results = cohort({ file: '01.mp4', candidateCount: 1 });
    for (const [index, result] of results.entries()) {
      result.bench.peakMemory = singleMemoryMetric(index === 0 ? 100 : 120 + index);
    }
    const source = writeExport(root, 'memory.json', '2026-07-12T00:00:00.000Z', results);
    const completed = run(root, [source]);
    assert.equal(completed.status, 0, completed.stderr);
    const row = data(root).rows[0];
    assert.equal(row.status, 'LEAD');
    assert.equal(row.memoryStatus, 'QUALIFIED');
  });
});

test('an ADR-backed metric exemption cannot hide missing samples', () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, 'docs/perf/performance-parity-exemptions.json'),
      JSON.stringify([
        {
          scenario: 'probe/x',
          reason: 'A documented physical browser allocation floor.',
          adr: 'ADR-999',
          metrics: ['peakMemory'],
        },
      ]),
    );
    const results = cohort({ file: '01.mp4', candidateCount: 1, ourMemory: 200 });
    for (const result of results) {
      result.bench.peakMemory = {
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
    const source = writeExport(root, 'exempt.json', '2026-07-12T00:00:00.000Z', results);
    const completed = run(root, [source]);
    assert.equal(completed.status, 1);
    assert.equal(data(root).rows[0].status, 'PARITY');
  });
});

test('a measured ADR-backed memory exceedance is explicitly EXEMPT', () => {
  withWorkspace((root) => {
    writeFileSync(
      join(root, 'docs/perf/performance-parity-exemptions.json'),
      JSON.stringify([
        {
          scenario: 'probe/x',
          reason: 'A documented physical browser allocation floor.',
          adr: 'ADR-999',
          metrics: ['peakMemory'],
        },
      ]),
    );
    const results = cohort({ file: '01.mp4', candidateCount: 1, ourMemory: 200, rivalMemory: 120 });
    const source = writeExport(root, 'exempt.json', '2026-07-12T00:00:00.000Z', results);
    const completed = run(root, [source]);
    assert.equal(completed.status, 0, completed.stderr);
    const row = data(root).rows[0];
    assert.equal(row.status, 'EXEMPT');
    assert.match(row.rootCause, /^ADR-999:/);
  });
});

test('rejects reused results and launcher runs below the warm sample floor', () => {
  withWorkspace((root) => {
    const results = cohort({ file: '01.mp4', candidateCount: 1 });
    const reusedPath = writeExport(root, 'reused.json', '2026-07-12T00:00:00.000Z', results);
    const reused = JSON.parse(readFileSync(reusedPath, 'utf8'));
    reused.launcher.filter.reuseSuccessful = true;
    writeFileSync(reusedPath, JSON.stringify(reused));
    const reusedRun = run(root, [reusedPath]);
    assert.notEqual(reusedRun.status, 0);
    assert.match(reusedRun.stderr, /reuseSuccessful must be false/);

    const shortPath = writeExport(root, 'short.json', '2026-07-12T00:01:00.000Z', results);
    const short = JSON.parse(readFileSync(shortPath, 'utf8'));
    short.launcher.filter.iters = 1;
    writeFileSync(shortPath, JSON.stringify(short));
    const shortRun = run(root, [shortPath]);
    assert.notEqual(shortRun.status, 0);
    assert.match(shortRun.stderr, /launcher iters must be >=5/);

    const stalePath = writeExport(root, 'stale.json', '2026-07-10T00:00:00.000Z', results);
    const staleRun = run(root, [stalePath]);
    assert.notEqual(staleRun.status, 0);
    assert.match(staleRun.stderr, /newest export is older than 24 hours/);
  });
});

test('rejects incomplete rosters and mixed selection run seeds', () => {
  withWorkspace((root) => {
    const missing = cohort({ file: '01.mp4', candidateCount: 1 }).slice(0, -1);
    const missingSource = writeExport(root, 'missing.json', '2026-07-12T00:00:00.000Z', missing);
    const missingRun = run(root, [missingSource]);
    assert.notEqual(missingRun.status, 0);
    assert.match(missingRun.stderr, /roster mismatch/);

    const mixed = cohort({ file: '01.mp4', candidateCount: 1 });
    mixed[1].selection.runSeed = 'different';
    const mixedSource = writeExport(root, 'mixed.json', '2026-07-12T00:01:00.000Z', mixed);
    const mixedRun = run(root, [mixedSource]);
    assert.notEqual(mixedRun.status, 0);
    assert.match(mixedRun.stderr, /selection\/SHA\/runSeed differs/);
  });
});

test('newest same-slot observation supersedes an older one without hiding another rotation', () => {
  withWorkspace((root) => {
    const old = writeExport(
      root,
      'old.json',
      '2026-07-12T00:00:00.000Z',
      cohort({ file: '01.mp4', ourWall: 10, rivalWall: 6 }),
    );
    const replacement = writeExport(
      root,
      'replacement.json',
      '2026-07-12T00:05:00.000Z',
      cohort({ file: '01.mp4', ourWall: 5, rivalWall: 8 }),
    );
    const other = writeExport(
      root,
      'other.json',
      '2026-07-12T00:10:00.000Z',
      cohort({ file: '02.mp4', ourWall: 5, rivalWall: 8 }),
    );
    const completed = run(root, [old, replacement, other]);
    assert.equal(completed.status, 0, completed.stderr);
    const row = data(root).rows[0];
    assert.equal(row.status, 'LEAD');
    assert.equal(row.measuredRotations, 2);
  });
});

test('records a no-rival PASS feature as UNCONTESTED', () => {
  withWorkspace((root) => {
    const results = cohort({ file: '01.mp4', candidateCount: 1 });
    for (const result of results.slice(1)) {
      result.status = 'NA_ENGINE';
      result.selection = null;
      result.bench = undefined;
    }
    const source = writeExport(root, 'uncontested.json', '2026-07-12T00:00:00.000Z', results);
    const completed = run(root, [source]);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(data(root).rows[0].status, 'UNCONTESTED');
  });
});

test('excludes all-NA cohorts without allowing an empty ledger to qualify', () => {
  withWorkspace((root) => {
    const unavailable = cohort({
      file: '01.wav',
      candidateCount: 1,
      scenario: 'audio-dsp/oracle-unavailable',
    });
    for (const result of unavailable) {
      result.status = 'NA_ASSET';
      result.selection = null;
      result.oracleOutcomes = [];
      result.bench = undefined;
    }

    const mixed = writeExport(root, 'mixed.json', '2026-07-12T00:00:00.000Z', [
      ...cohort({ file: '01.mp4', candidateCount: 1 }),
      ...unavailable,
    ]);
    const completed = run(root, [mixed]);
    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(
      data(root).rows.map((row) => row.scenario),
      ['probe/x'],
    );

    const onlyUnavailable = writeExport(
      root,
      'unavailable.json',
      '2026-07-12T00:01:00.000Z',
      unavailable,
    );
    const empty = run(root, [onlyUnavailable]);
    assert.equal(
      empty.status,
      1,
      'an export with no contested feature must not be vacuously green',
    );
    assert.equal(data(root).qualified, false);
    assert.deepEqual(data(root).rows, []);
  });
});

test('accepts null selection on NAs and compares only PASS rivals in a mixed real-schema cohort', () => {
  withWorkspace((root) => {
    const results = cohort({ file: '03.wav', candidateCount: 1 });
    const passingRival = results.find((result) => result.engineId === 'mediabunny@1.48.0');
    const errorRival = results.find((result) => result.engineId === 'ffmpeg.wasm@0.12.15');
    errorRival.status = 'ERROR';
    errorRival.oracleOutcomes = [];
    errorRival.bench = undefined;
    for (const result of results) {
      if (
        result.engineId === 'aibrush-media@dev' ||
        result.engineId === passingRival.engineId ||
        result.engineId === errorRival.engineId
      ) {
        continue;
      }
      result.status = 'NA_ENGINE';
      result.selection = null;
      result.oracleOutcomes = [];
      result.bench = undefined;
    }
    const source = writeExport(root, 'mixed-status.json', '2026-07-12T00:00:00.000Z', results);
    const exported = JSON.parse(readFileSync(source, 'utf8'));
    exported.launcher.filter.warmup = 2;
    exported.launcher.filter.iters = 15;
    for (const result of exported.results.filter((result) => result.status === 'PASS')) {
      const wallMedian = result.bench.wall.median;
      result.bench.wall = {
        n: 15,
        warmup: 2,
        metric: 'wall',
        median: wallMedian,
        p95: wallMedian,
        mad: 0,
        unit: 'ms',
        samples: Array.from({ length: 15 }, () => wallMedian),
      };
      result.bench.peakMemory.warmup = 2;
    }
    writeFileSync(source, JSON.stringify(exported));
    const completed = run(root, [source]);
    assert.equal(completed.status, 0, completed.stderr);
    const output = data(root);
    assert.deepEqual(output.roster, roster);
    assert.equal(output.rows[0].status, 'LEAD');
    assert.equal(output.rows[0].bestPassingRival, 'mediabunny@1.48.0');
    assert.deepEqual(
      output.rows[0].rotations[0].wall.pairs.map((pair) => pair.engineId),
      ['mediabunny@1.48.0'],
    );

    exported.results.find((result) => result.engineId === 'ffmpeg.wasm@0.12.15').selection.runSeed =
      'mismatched-error-seed';
    writeFileSync(source, JSON.stringify(exported));
    const mismatchedError = run(root, [source]);
    assert.notEqual(mismatchedError.status, 0);
    assert.match(mismatchedError.stderr, /selection\/SHA\/runSeed differs/);

    const selected = exported.results.find(
      (result) => result.engineId === 'aibrush-media@dev',
    ).selection;
    exported.results.find((result) => result.engineId === 'ffmpeg.wasm@0.12.15').selection.runSeed =
      selected.runSeed;
    exported.results.find((result) => result.engineId === 'mp4box@2.3.0').selection = {
      ...selected,
      runSeed: 'mismatched-na-seed',
    };
    writeFileSync(source, JSON.stringify(exported));
    const mismatchedNa = run(root, [source]);
    assert.notEqual(mismatchedNa.status, 0);
    assert.match(mismatchedNa.stderr, /selection\/SHA\/runSeed differs/);
  });
});
