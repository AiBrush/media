// Generates the Session-11 correctness, wall-time, and peak-memory worklist.
//
// Inputs are public harness result exports only. Results are compared only when
// they came from the same export and selected the same rotated asset. This
// prevents a targeted overlay from silently replacing another rotation or from
// comparing a fresh aibrush result with a stale rival measurement.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const US = 'aibrush-media@dev';
const EXEMPTIONS_PATH = 'docs/perf/performance-parity-exemptions.json';
const COVERAGE_EXEMPTIONS_PATH = 'docs/perf/coverage-parity-exemptions.json';
const DEFAULT_FRESH_HOURS = 24;
const MIN_SAMPLES = 5;

const parseArguments = (argv) => {
  const paths = [];
  let freshHours = DEFAULT_FRESH_HOURS;
  for (const arg of argv) {
    if (arg.startsWith('--fresh-hours=')) {
      freshHours = Number(arg.slice('--fresh-hours='.length));
      if (!Number.isFinite(freshHours) || freshHours <= 0) {
        throw new Error('--fresh-hours must be a positive finite number');
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      paths.push(arg);
    }
  }
  if (paths.length === 0) {
    throw new Error(
      'usage: node gen-deficits.mjs [--fresh-hours=24] <export.json> [export.json ...]',
    );
  }
  return { paths, freshHours };
};

const readExport = (path, index) => {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.results)) throw new Error(`${path}: results must be an array`);
  const generatedAtMs = Date.parse(raw.generatedAtIso);
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error(`${path}: generatedAtIso must be an ISO timestamp`);
  }
  return {
    index,
    path,
    label: basename(path),
    raw,
    generatedAtMs,
    generatedAtIso: raw.generatedAtIso,
  };
};

const writeAtomic = (path, contents) => {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, contents);
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
};

const readExemptions = () => {
  if (!existsSync(EXEMPTIONS_PATH)) return new Map();
  const parsed = JSON.parse(readFileSync(EXEMPTIONS_PATH, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${EXEMPTIONS_PATH} must be an array`);
  const out = new Map();
  for (const [i, entry] of parsed.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${EXEMPTIONS_PATH}[${i}] must be an object`);
    }
    const { scenario, reason, adr } = entry;
    if (typeof scenario !== 'string' || scenario.length === 0) {
      throw new Error(`${EXEMPTIONS_PATH}[${i}].scenario must be a non-empty string`);
    }
    if (typeof reason !== 'string' || reason.trim().length < 12) {
      throw new Error(`${EXEMPTIONS_PATH}[${i}].reason must explain the exemption`);
    }
    if (typeof adr !== 'string' || !/^ADR-\d{3}$/.test(adr)) {
      throw new Error(`${EXEMPTIONS_PATH}[${i}].adr must look like ADR-123`);
    }
    if (out.has(scenario)) throw new Error(`${EXEMPTIONS_PATH} duplicates ${scenario}`);
    const metrics = entry.metrics ?? ['wall'];
    if (
      !Array.isArray(metrics) ||
      metrics.length === 0 ||
      metrics.some((metric) => metric !== 'wall' && metric !== 'peakMemory')
    ) {
      throw new Error(`${EXEMPTIONS_PATH}[${i}].metrics must contain wall and/or peakMemory`);
    }
    out.set(scenario, { reason: reason.trim(), adr, metrics: [...new Set(metrics)] });
  }
  return out;
};

const readCoverageExemptions = () => {
  if (!existsSync(COVERAGE_EXEMPTIONS_PATH)) return new Map();
  const parsed = JSON.parse(readFileSync(COVERAGE_EXEMPTIONS_PATH, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${COVERAGE_EXEMPTIONS_PATH} must be an array`);
  const out = new Map();
  for (const [i, entry] of parsed.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${COVERAGE_EXEMPTIONS_PATH}[${i}] must be an object`);
    }
    const { scenario, reason, adr } = entry;
    if (typeof scenario !== 'string' || scenario.length === 0) {
      throw new Error(`${COVERAGE_EXEMPTIONS_PATH}[${i}].scenario must be a non-empty string`);
    }
    if (typeof reason !== 'string' || reason.trim().length < 12) {
      throw new Error(`${COVERAGE_EXEMPTIONS_PATH}[${i}].reason must explain the exemption`);
    }
    if (typeof adr !== 'string' || !/^ADR-\d{3}$/.test(adr)) {
      throw new Error(`${COVERAGE_EXEMPTIONS_PATH}[${i}].adr must look like ADR-123`);
    }
    if (out.has(scenario)) {
      throw new Error(`${COVERAGE_EXEMPTIONS_PATH} duplicates ${scenario}`);
    }
    out.set(scenario, { reason: reason.trim(), adr });
  }
  return out;
};

const rotationId = (result) => {
  const selection = result.selection ?? {};
  const kind = selection.isBaked === true ? 'baked' : 'rotated';
  const file = typeof selection.file === 'string' ? selection.file : '(unknown-file)';
  // The slot identity is stable across a justified corpus repair. The digest is
  // retained in the human label, but a newer result for 01.mp4 must supersede
  // the now-unselectable bytes previously stored in that same rotation slot.
  return `${kind}\0${file}`;
};

const rotationLabel = (result) => {
  const selection = result.selection ?? {};
  const kind = selection.isBaked === true ? 'baked' : 'rotated';
  const file = typeof selection.file === 'string' ? selection.file : '(unknown-file)';
  const sha = typeof selection.sha256 === 'string' ? selection.sha256.slice(0, 10) : 'no-sha';
  return `${kind}:${file}@${sha}`;
};

const exactCellKey = (result) =>
  `${result.browser ?? 'unknown'}\0${result.scenarioId}\0${rotationId(result)}\0${result.engineId}`;
const cohortKey = (result) =>
  `${result.browser ?? 'unknown'}\0${result.scenarioId}\0${rotationId(result)}`;
const scenarioKey = (result) => `${result.browser ?? 'unknown'}\0${result.scenarioId}`;

const redKind = (reason) => {
  if (/timed? ?out|timeout/i.test(reason)) return 'timeout';
  if (/allocation failed|out of memory|\boom\b/i.test(reason)) return 'oom';
  return 'red';
};

const finiteMetric = (result, metricName) => {
  const metric = result.bench?.[metricName];
  if (result.status !== 'PASS' || metric === null || typeof metric !== 'object') return null;
  if (!Number.isFinite(metric.median) || !Number.isInteger(metric.n) || metric.n <= 0) return null;
  if (metricName === 'peakMemory' && metric.median <= 0) return null;
  return metric;
};

const resultIsNewer = (candidate, current) =>
  current === undefined ||
  candidate.source.generatedAtMs > current.source.generatedAtMs ||
  (candidate.source.generatedAtMs === current.source.generatedAtMs &&
    candidate.source.index > current.source.index);

const { paths, freshHours } = parseArguments(process.argv.slice(2));
const sources = paths.map(readExport);
const latestAtMs = Math.max(...sources.map((source) => source.generatedAtMs));
const freshnessFloorMs = latestAtMs - freshHours * 60 * 60 * 1000;
const freshSources = sources.filter((source) => source.generatedAtMs >= freshnessFloorMs);
const staleSources = sources.filter((source) => source.generatedAtMs < freshnessFloorMs);
const exemptions = readExemptions();
const coverageExemptions = readCoverageExemptions();

// The universe comes from every supplied export, but only fresh exports can
// satisfy it. This makes a partial fresh overlay expose missing/stale cells
// instead of quietly inheriting them from an old baseline.
const scenarioUniverse = new Map();
for (const source of sources) {
  for (const result of source.raw.results) {
    if (result.engineId !== US) continue;
    const key = scenarioKey(result);
    const candidateCount = Number.isInteger(result.selection?.candidateCount)
      ? Math.max(1, result.selection.candidateCount)
      : 1;
    const known = scenarioUniverse.get(key);
    if (known === undefined) {
      scenarioUniverse.set(key, {
        browser: result.browser ?? 'unknown',
        scenario: result.scenarioId,
        family: result.family,
        expectedRotations: candidateCount,
      });
    } else {
      known.expectedRotations = Math.max(known.expectedRotations, candidateCount);
    }
  }
}

const latestUsCells = new Map();
const freshRotations = new Map();
const cohortsBySource = [];
for (const source of freshSources) {
  const cohorts = new Map();
  for (const result of source.raw.results) {
    const key = cohortKey(result);
    const cohort = cohorts.get(key) ?? [];
    cohort.push(result);
    cohorts.set(key, cohort);
    if (result.engineId !== US) continue;
    const wrapped = { result, source };
    const cellKey = exactCellKey(result);
    if (resultIsNewer(wrapped, latestUsCells.get(cellKey))) latestUsCells.set(cellKey, wrapped);
    const rotations = freshRotations.get(scenarioKey(result)) ?? new Set();
    rotations.add(rotationId(result));
    freshRotations.set(scenarioKey(result), rotations);
  }
  cohortsBySource.push({ source, cohorts });
}

const functionalReds = [];
const bakeBlocked = [];
for (const { result, source } of latestUsCells.values()) {
  const reason = result.reason ?? '';
  const row = {
    s: result.scenarioId,
    fam: result.family,
    status: result.status,
    rotation: rotationLabel(result),
    source: source.label,
    reason,
  };
  if (result.status === 'FAIL' || result.status === 'ERROR') {
    functionalReds.push({ ...row, kind: redKind(reason) });
  } else if (result.status === 'NA_ASSET') {
    bakeBlocked.push(row);
  }
}
functionalReds.sort(
  (a, b) =>
    a.fam.localeCompare(b.fam) || a.s.localeCompare(b.s) || a.rotation.localeCompare(b.rotation),
);
bakeBlocked.sort((a, b) => a.fam.localeCompare(b.fam) || a.s.localeCompare(b.s));

const rotationGaps = [];
for (const [key, scenario] of scenarioUniverse) {
  const measured = freshRotations.get(key)?.size ?? 0;
  if (measured < scenario.expectedRotations) {
    rotationGaps.push({ ...scenario, measured });
  }
}
rotationGaps.sort(
  (a, b) => a.family.localeCompare(b.family) || a.scenario.localeCompare(b.scenario),
);

// Pick the newest fresh same-export cohort for each exact rotation. Engines are
// never spliced together across exports.
const latestComparableCohorts = new Map();
for (const { source, cohorts } of cohortsBySource) {
  for (const [key, results] of cohorts) {
    if (!results.some((result) => result.engineId === US)) continue;
    if (!results.some((result) => result.engineId !== US)) continue;
    const candidate = { source, results };
    const current = latestComparableCohorts.get(key);
    if (resultIsNewer(candidate, current)) latestComparableCohorts.set(key, candidate);
  }
}

const metricDefinitions = [
  { name: 'wall', label: 'Wall', unit: 'ms' },
  { name: 'peakMemory', label: 'Peak memory', unit: 'bytes' },
];
const losses = [];
const metricCoverage = Object.fromEntries(
  metricDefinitions.map(({ name }) => [name, { contested: 0, exactRotations: new Map() }]),
);
const sampleGaps = [];
const coverageGaps = [];
const exemptCoverageGaps = [];

for (const { source, results } of latestComparableCohorts.values()) {
  const usResult = results.find((result) => result.engineId === US);
  if (usResult === undefined) continue;
  if (
    (usResult.status === 'NA_ENGINE' || usResult.status === 'NA_BROWSER') &&
    results.some((result) => result.engineId !== US && result.status === 'PASS')
  ) {
    const exemption = coverageExemptions.get(usResult.scenarioId);
    const row = {
      s: usResult.scenarioId,
      fam: usResult.family,
      status: usResult.status,
      rotation: rotationLabel(usResult),
      source: source.label,
      exemption,
    };
    if (exemption === undefined) coverageGaps.push(row);
    else exemptCoverageGaps.push(row);
  }
  for (const definition of metricDefinitions) {
    const ours = finiteMetric(usResult, definition.name);
    if (ours === null) continue;
    const rivals = results
      .filter((result) => result.engineId !== US)
      .map((result) => ({ result, metric: finiteMetric(result, definition.name) }))
      .filter((entry) => entry.metric !== null);
    if (rivals.length === 0) continue;

    const coverage = metricCoverage[definition.name];
    coverage.contested++;
    const covered = coverage.exactRotations.get(scenarioKey(usResult)) ?? new Set();
    covered.add(rotationId(usResult));
    coverage.exactRotations.set(scenarioKey(usResult), covered);

    for (const participant of [{ result: usResult, metric: ours }, ...rivals]) {
      if (participant.metric.n < MIN_SAMPLES || participant.metric.warmup < 1) {
        sampleGaps.push({
          metric: definition.name,
          s: usResult.scenarioId,
          rotation: rotationLabel(usResult),
          engine: participant.result.engineId,
          n: participant.metric.n,
          warmup: participant.metric.warmup,
          source: source.label,
        });
      }
    }

    let best = rivals[0];
    for (const rival of rivals.slice(1)) {
      if (rival.metric.median < best.metric.median) best = rival;
    }
    if (best.metric.median < ours.median - Number.EPSILON) {
      losses.push({
        metric: definition.name,
        unit: definition.unit,
        s: usResult.scenarioId,
        fam: usResult.family,
        rotation: rotationLabel(usResult),
        our: ours.median,
        comp: best.result.engineId.split('@')[0],
        cw: best.metric.median,
        ratio: ours.median / best.metric.median,
        source: source.label,
        exemption: exemptions.get(usResult.scenarioId)?.metrics.includes(definition.name)
          ? exemptions.get(usResult.scenarioId)
          : undefined,
      });
    }
  }
}

const historicalContested = Object.fromEntries(
  metricDefinitions.map(({ name }) => [name, new Map()]),
);
for (const source of sources) {
  const cohorts = new Map();
  for (const result of source.raw.results) {
    const rows = cohorts.get(cohortKey(result)) ?? [];
    rows.push(result);
    cohorts.set(cohortKey(result), rows);
  }
  for (const rows of cohorts.values()) {
    const usResult = rows.find((result) => result.engineId === US);
    if (usResult === undefined) continue;
    for (const { name } of metricDefinitions) {
      if (finiteMetric(usResult, name) === null) continue;
      if (!rows.some((result) => result.engineId !== US && finiteMetric(result, name) !== null))
        continue;
      historicalContested[name].set(scenarioKey(usResult), usResult);
    }
  }
}

const metricRotationGaps = [];
for (const { name } of metricDefinitions) {
  for (const [key, historicalResult] of historicalContested[name]) {
    const expected = scenarioUniverse.get(key)?.expectedRotations ?? 1;
    const measured = metricCoverage[name].exactRotations.get(key)?.size ?? 0;
    if (measured < expected) {
      metricRotationGaps.push({
        metric: name,
        s: historicalResult.scenarioId,
        fam: historicalResult.family,
        expected,
        measured,
      });
    }
  }
}
metricRotationGaps.sort(
  (a, b) =>
    a.metric.localeCompare(b.metric) || a.fam.localeCompare(b.fam) || a.s.localeCompare(b.s),
);

const hasAnyRivalResults = sources.some((source) =>
  source.raw.results.some((result) => result.engineId !== US),
);
const hasFreshWallComparison = metricCoverage.wall.contested > 0;
const comparisonEvidenceMissing = !hasAnyRivalResults || !hasFreshWallComparison;

const uniqueSampleGaps = [...new Map(sampleGaps.map((gap) => [JSON.stringify(gap), gap])).values()];
losses.sort((a, b) => a.metric.localeCompare(b.metric) || b.ratio - a.ratio);
const activeLosses = losses.filter((loss) => !loss.exemption);
const exemptLosses = losses.filter((loss) => loss.exemption);
const wallLosses = activeLosses.filter((loss) => loss.metric === 'wall');
const memoryLosses = activeLosses.filter((loss) => loss.metric === 'peakMemory');
const tier = (rows, lo, hi) => rows.filter((row) => row.ratio >= lo && row.ratio < hi);
const T1 = tier(wallLosses, 100, Number.POSITIVE_INFINITY);
const T2 = tier(wallLosses, 10, 100);
const T3 = tier(wallLosses, 3, 10);
const T4 = tier(wallLosses, 0, 3);

const escapeCell = (value, limit = 180) => String(value).replace(/\|/g, '\\|').slice(0, limit);
const fmt = (value, unit) => {
  if (unit === 'bytes') return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${value.toFixed(1)} ms`;
};
const lossTable = (rows) => {
  if (rows.length === 0) return '_None._\n';
  let out =
    '| # | Scenario | Rotation | Family | Ours | Fastest/leanest rival | Theirs | Ratio |\n';
  out += '|--:|----------|----------|--------|-----:|------------------------|-------:|------:|\n';
  rows.forEach((row, index) => {
    out += `| ${index + 1} | \`${row.s}\` | \`${row.rotation}\` | ${row.fam} | ${fmt(row.our, row.unit)} | ${row.comp} | ${fmt(row.cw, row.unit)} | ${row.ratio.toFixed(2)}× |\n`;
  });
  return out;
};
const redTable = (rows) => {
  if (rows.length === 0) return '_No functional reds in the measured rotations._\n';
  let out = '| # | Status | Kind | Scenario | Rotation | Family | Reason |\n';
  out += '|--:|--------|------|----------|----------|--------|--------|\n';
  rows.forEach((row, index) => {
    out += `| ${index + 1} | ${row.status} | ${row.kind} | \`${row.s}\` | \`${row.rotation}\` | ${row.fam} | ${escapeCell(row.reason)} |\n`;
  });
  return out;
};
const coverageTable = (rows) => {
  if (rows.length === 0) return '_None._\n';
  let out = '| Scenario | Status | Rotation | Family | ADR | Reason |\n';
  out += '|----------|--------|----------|--------|-----|--------|\n';
  for (const row of rows) {
    out += `| \`${row.s}\` | ${row.status} | \`${row.rotation}\` | ${row.fam} | ${row.exemption?.adr ?? '—'} | ${escapeCell(row.exemption?.reason ?? 'Rival PASSed the same rotation')} |\n`;
  }
  return out;
};
const compactGapTable = (rows, columns, renderRow, empty) => {
  if (rows.length === 0) return `${empty}\n`;
  const shown = rows.slice(0, 100);
  return `${columns}\n${shown.map(renderRow).join('\n')}\n${rows.length > shown.length ? `\n_…and ${rows.length - shown.length} more._\n` : ''}`;
};

const sourceList = freshSources.map((source) => `\`${source.label}\``).join(', ');
const staleList = staleSources.map((source) => `\`${source.label}\``).join(', ');
const newestSource = sources.reduce((best, source) =>
  source.generatedAtMs > best.generatedAtMs ? source : best,
);

const doc = `# Deficit worklist — rotated correctness, wall time, and peak memory

> **Auto-generated** by \`docs/perf/gen-deficits.mjs\` from ${sources.length} public result export(s).
> Newest export: \`${newestSource.label}\` (${newestSource.generatedAtIso}). Freshness window:
> ${freshHours} h. Same-work comparisons never combine engines from different exports.

## Measurement integrity

- Fresh exports used: ${sourceList || '_none_'}
- Stale exports excluded from current cells: ${staleList || '_none_'}
- Required samples per timed participant: **n≥${MIN_SAMPLES}**, with warmup ≥1
- Correctness rotation gaps: **${rotationGaps.length}**
- Timed rotation gaps: **${metricRotationGaps.length}**
- Under-sampled timed participants: **${uniqueSampleGaps.length}**
- Fresh same-export rival wall evidence: **${comparisonEvidenceMissing ? 'missing' : 'present'}**

### Missing correctness rotations

${compactGapTable(
  rotationGaps,
  '| Scenario | Family | Measured | Required |\n|----------|--------|---------:|---------:|',
  (row) => `| \`${row.scenario}\` | ${row.family} | ${row.measured} | ${row.expectedRotations} |`,
  '_Every known scenario has fresh evidence for every rotation._',
)}
### Missing same-export timed rotations

${compactGapTable(
  metricRotationGaps,
  '| Metric | Scenario | Family | Measured | Required |\n|--------|----------|--------|---------:|---------:|',
  (row) => `| ${row.metric} | \`${row.s}\` | ${row.fam} | ${row.measured} | ${row.expected} |`,
  '_Every historically contested rotation has a fresh same-export comparison._',
)}
### Under-sampled timed participants

${compactGapTable(
  uniqueSampleGaps,
  '| Metric | Scenario | Rotation | Engine | n | Warmup |\n|--------|----------|----------|--------|--:|-------:|',
  (row) =>
    `| ${row.metric} | \`${row.s}\` | \`${row.rotation}\` | ${row.engine} | ${row.n} | ${row.warmup} |`,
  '_Every timed participant is multi-sample with warmup._',
)}
## Functional reds — fix before speed work

${redTable(functionalReds)}
### Bake-blocked rotations

${compactGapTable(
  bakeBlocked,
  '| Scenario | Rotation | Family | Reason |\n|----------|----------|--------|--------|',
  (row) => `| \`${row.s}\` | \`${row.rotation}\` | ${row.fam} | ${escapeCell(row.reason, 120)} |`,
  '_None._',
)}
## Headline

- Functional reds: **${functionalReds.length}** (${functionalReds.filter((row) => row.kind === 'timeout').length} timeout · ${functionalReds.filter((row) => row.kind === 'oom').length} OOM · ${functionalReds.filter((row) => row.kind === 'red').length} other)
- Non-exempt coverage gaps (ours NA while a rival PASSes): **${coverageGaps.length}**
- ADR-backed honest-NA coverage exemptions: **${exemptCoverageGaps.length}**
- Contested exact rotations: **${metricCoverage.wall.contested} wall** · **${metricCoverage.peakMemory.contested} peak memory**
- Active losses: **${wallLosses.length} wall** · **${memoryLosses.length} peak memory**
- Wall severity: **${T1.length} catastrophic** (≥100×) · **${T2.length} severe** (10–100×) · **${T3.length} moderate** (3–10×) · **${T4.length} minor** (<3×)
- ADR-backed parity exemptions: **${exemptLosses.length}**

An absent or zero-sample \`peakMemory\` metric is **unmeasured**, never zero. A row is
contested only when both our engine and a rival PASSed the same rotation in the
same export and both reported that metric.

## Coverage parity

### Active gaps

${coverageTable(coverageGaps)}
### ADR-backed honest-NA exemptions

${coverageTable(exemptCoverageGaps)}

## Wall-time losses

${lossTable(wallLosses)}
## Peak-memory losses

${lossTable(memoryLosses)}
## ADR-backed parity exemptions

${lossTable(exemptLosses)}
`;

writeAtomic('docs/perf/performance-deficits.md', `${doc.trimEnd()}\n`);
writeAtomic(
  'docs/perf/_deficit-data.json',
  `${JSON.stringify(
    {
      generatedFrom: newestSource.generatedAtIso,
      sources: sources.map((source) => source.label),
      freshSources: freshSources.map((source) => source.label),
      staleSources: staleSources.map((source) => source.label),
      freshnessHours: freshHours,
      minimumSamples: MIN_SAMPLES,
      functionalReds,
      bakeBlocked,
      coverageGaps,
      exemptCoverageGaps,
      rotationGaps,
      metricRotationGaps,
      sampleGaps: uniqueSampleGaps,
      comparisonEvidenceMissing,
      contested: {
        wall: metricCoverage.wall.contested,
        peakMemory: metricCoverage.peakMemory.contested,
      },
      activeLossCount: activeLosses.length,
      wallLossCount: wallLosses.length,
      peakMemoryLossCount: memoryLosses.length,
      exemptLossCount: exemptLosses.length,
      tiers: {
        catastrophic: T1.length,
        severe: T2.length,
        moderate: T3.length,
        minor: T4.length,
      },
      losses: activeLosses,
      parityExemptions: exemptLosses,
    },
    null,
    2,
  )}\n`,
);

const gateFailures =
  functionalReds.length +
  bakeBlocked.length +
  coverageGaps.length +
  rotationGaps.length +
  metricRotationGaps.length +
  uniqueSampleGaps.length +
  Number(comparisonEvidenceMissing) +
  activeLosses.length;
const summary = `wrote docs/perf/performance-deficits.md — ${functionalReds.length} reds, ${coverageGaps.length} coverage gaps, ${rotationGaps.length} correctness rotation gaps, ${metricRotationGaps.length} timed rotation gaps, ${uniqueSampleGaps.length} sample gaps, ${wallLosses.length} wall losses, ${memoryLosses.length} memory losses, rival evidence ${comparisonEvidenceMissing ? 'missing' : 'present'}`;
if (gateFailures > 0) {
  console.error(summary);
  process.exit(1);
}
console.info(summary);
