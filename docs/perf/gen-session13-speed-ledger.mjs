// Generate the strict Session 13 per-feature speed ledger from public result exports.
//
// This script consumes only the exported JSON contract. It deliberately does not import
// or inspect the external harness implementation, scenarios, adapters, or oracles.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const SCHEMA = 'media-browser-test/results@1';
const OUTPUT_SCHEMA = 'aibrush-media/session13-speed-ledger@1';
const US = 'aibrush-media@dev';
const ROSTER = Object.freeze([
  US,
  'ffmpeg.wasm@0.12.15',
  'mediabunny@1.48.0',
  'mp4box@2.3.0',
  'remotion-media-parser@4.0.479',
  'remotion-webcodecs@4.0.479',
  'web-demuxer@4.0.0',
]);
const ROSTER_SET = new Set(ROSTER);
const RESULT_STATUSES = new Set(['PASS', 'FAIL', 'ERROR', 'NA_ASSET', 'NA_BROWSER', 'NA_ENGINE']);
const MIN_WALL_SAMPLES = 5;
const MIN_MEMORY_SAMPLES = 1;
const MIN_WARMUP = 1;
const DEFAULT_FRESH_HOURS = 24;
const DEFAULT_MD = 'docs/perf/session13-speed-ledger.md';
const DEFAULT_JSON = 'docs/perf/_session13-speed-ledger-data.json';
const DEFAULT_EXEMPTIONS = 'docs/perf/performance-parity-exemptions.json';

const fail = (message) => {
  throw new Error(message);
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const nonEmptyString = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
};

const finiteNumber = (value, label) => {
  if (!Number.isFinite(value)) fail(`${label} must be finite`);
  return value;
};

const positiveInteger = (value, label) => {
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
};

const deepCanonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(deepCanonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${deepCanonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const nearlyEqual = (left, right) =>
  Math.abs(left - right) <= Math.max(1e-6, Math.abs(left) * 1e-9, Math.abs(right) * 1e-9);

const parseArguments = (argv) => {
  const paths = [];
  let markdownPath = DEFAULT_MD;
  let jsonPath = DEFAULT_JSON;
  let notesPath;
  let exemptionsPath = DEFAULT_EXEMPTIONS;
  let freshHours = DEFAULT_FRESH_HOURS;
  let nowMs = Date.now();
  for (const arg of argv) {
    if (arg.startsWith('--markdown=')) markdownPath = arg.slice('--markdown='.length);
    else if (arg.startsWith('--json=')) jsonPath = arg.slice('--json='.length);
    else if (arg.startsWith('--notes=')) notesPath = arg.slice('--notes='.length);
    else if (arg.startsWith('--exemptions=')) exemptionsPath = arg.slice('--exemptions='.length);
    else if (arg.startsWith('--fresh-hours=')) {
      freshHours = Number(arg.slice('--fresh-hours='.length));
      if (!Number.isFinite(freshHours) || freshHours <= 0) {
        fail('--fresh-hours must be a positive finite number');
      }
    } else if (arg.startsWith('--now=')) {
      nowMs = Date.parse(arg.slice('--now='.length));
      if (!Number.isFinite(nowMs)) fail('--now must be an ISO timestamp');
    } else if (arg.startsWith('--')) fail(`unknown option: ${arg}`);
    else paths.push(arg);
  }
  if (paths.length === 0) {
    fail('usage: node gen-session13-speed-ledger.mjs [options] <export.json> [export.json ...]');
  }
  for (const [label, path] of [
    ['--markdown', markdownPath],
    ['--json', jsonPath],
    ['--notes', notesPath],
    ['--exemptions', exemptionsPath],
  ]) {
    if (path !== undefined && path.length === 0) fail(`${label} path must not be empty`);
  }
  return { paths, markdownPath, jsonPath, notesPath, exemptionsPath, freshHours, nowMs };
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

const readJsonArray = (path, label, optional) => {
  if (!existsSync(path)) {
    if (optional) return [];
    fail(`${path}: ${label} file is missing`);
  }
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value)) fail(`${path}: ${label} must be an array`);
  return value;
};

const readNotes = (path) => {
  if (path === undefined) return new Map();
  const entries = readJsonArray(path, 'notes', false);
  const notes = new Map();
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) fail(`${path}[${index}] must be an object`);
    const scenario = nonEmptyString(entry.scenario, `${path}[${index}].scenario`);
    if (notes.has(scenario)) fail(`${path} duplicates ${scenario}`);
    notes.set(scenario, {
      rootCause: nonEmptyString(entry.rootCause, `${path}[${index}].rootCause`),
      optimizationIdeas: nonEmptyString(
        entry.optimizationIdeas,
        `${path}[${index}].optimizationIdeas`,
      ),
      closingEvidence:
        entry.closingEvidence === undefined
          ? undefined
          : nonEmptyString(entry.closingEvidence, `${path}[${index}].closingEvidence`),
    });
  }
  return notes;
};

const readExemptions = (path) => {
  const entries = readJsonArray(path, 'exemptions', true);
  const exemptions = new Map();
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) fail(`${path}[${index}] must be an object`);
    const scenario = nonEmptyString(entry.scenario, `${path}[${index}].scenario`);
    const reason = nonEmptyString(entry.reason, `${path}[${index}].reason`).trim();
    const adr = nonEmptyString(entry.adr, `${path}[${index}].adr`);
    if (reason.length < 12) fail(`${path}[${index}].reason must explain the exemption`);
    if (!/^ADR-\d{3}$/.test(adr)) fail(`${path}[${index}].adr must look like ADR-123`);
    const metrics = entry.metrics ?? ['wall'];
    if (
      !Array.isArray(metrics) ||
      metrics.length === 0 ||
      metrics.some((metric) => metric !== 'wall' && metric !== 'peakMemory')
    ) {
      fail(`${path}[${index}].metrics must contain wall and/or peakMemory`);
    }
    if (exemptions.has(scenario)) fail(`${path} duplicates ${scenario}`);
    exemptions.set(scenario, { reason, adr, metrics: [...new Set(metrics)] });
  }
  return exemptions;
};

const selectionIdentity = (selection, label) => {
  if (!isRecord(selection)) fail(`${label}.selection must be an object`);
  const file = nonEmptyString(selection.file, `${label}.selection.file`);
  const isBaked = selection.isBaked === true;
  if (selection.isBaked !== true && selection.isBaked !== false) {
    fail(`${label}.selection.isBaked must be boolean`);
  }
  const runSeed = nonEmptyString(selection.runSeed, `${label}.selection.runSeed`);
  const candidateCount = positiveInteger(
    selection.candidateCount,
    `${label}.selection.candidateCount`,
  );
  const sha256 = selection.sha256;
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(sha256))) {
    fail(`${label}.selection.sha256 must be a 64-character hex digest when present`);
  }
  if (!isBaked && sha256 === undefined) fail(`${label}.selection.sha256 is required for rotations`);
  return { file, isBaked, runSeed, candidateCount, sha256 };
};

const rotationKey = (selection) => `${selection.isBaked ? 'baked' : 'rotated'}\0${selection.file}`;
const rotationLabel = (selection) =>
  `${selection.isBaked ? 'baked' : 'rotated'}:${selection.file}@${
    selection.sha256?.slice(0, 10) ?? 'no-sha'
  }`;

const parseMetric = (result, metricName, launcher, label) => {
  const raw = result.bench?.[metricName];
  if (!isRecord(raw)) return { metric: undefined, gaps: [`${label}: missing ${metricName}`] };
  const gaps = [];
  const n = raw.n;
  const warmup = raw.warmup;
  const metricMedian = raw.median;
  const mad = raw.mad;
  const samples = raw.samples;
  const minimumSamples = metricName === 'wall' ? MIN_WALL_SAMPLES : MIN_MEMORY_SAMPLES;
  if (!Number.isInteger(n) || n < minimumSamples) {
    gaps.push(`${label}: ${metricName}.n must be >=${minimumSamples}`);
  }
  if (!Number.isInteger(warmup) || warmup < MIN_WARMUP) {
    gaps.push(`${label}: ${metricName}.warmup must be >=1`);
  }
  if (metricName === 'wall' && n !== launcher.iters) {
    gaps.push(`${label}: wall.n does not match launcher iters`);
  }
  if (warmup !== launcher.warmup) {
    gaps.push(`${label}: ${metricName}.warmup does not match launcher warmup`);
  }
  if (raw.metric !== metricName) gaps.push(`${label}: ${metricName}.metric is inconsistent`);
  const expectedUnit = metricName === 'wall' ? 'ms' : 'bytes';
  if (raw.unit !== expectedUnit) gaps.push(`${label}: ${metricName}.unit must be ${expectedUnit}`);
  if (!Array.isArray(samples) || samples.length !== n) {
    gaps.push(`${label}: ${metricName}.samples length must equal n`);
  } else if (samples.some((sample) => !Number.isFinite(sample) || sample <= 0)) {
    gaps.push(`${label}: ${metricName}.samples must all be positive finite values`);
  }
  if (!Number.isFinite(metricMedian) || metricMedian <= 0) {
    gaps.push(`${label}: ${metricName}.median must be positive and finite`);
  }
  if (!Number.isFinite(mad) || mad < 0)
    gaps.push(`${label}: ${metricName}.mad must be finite and >=0`);
  if (
    Array.isArray(samples) &&
    samples.length > 0 &&
    samples.every((sample) => Number.isFinite(sample)) &&
    Number.isFinite(metricMedian) &&
    Number.isFinite(mad)
  ) {
    const calculatedMedian = median(samples);
    const calculatedMad = median(samples.map((sample) => Math.abs(sample - calculatedMedian)));
    if (!nearlyEqual(metricMedian, calculatedMedian)) {
      gaps.push(`${label}: ${metricName}.median does not match samples`);
    }
    if (!nearlyEqual(mad, calculatedMad)) {
      gaps.push(`${label}: ${metricName}.mad does not match samples`);
    }
  }
  if (gaps.length > 0) return { metric: undefined, gaps };
  return { metric: { n, warmup, median: metricMedian, mad, unit: raw.unit }, gaps };
};

const readExport = (path, index) => {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw)) fail(`${path}: root must be an object`);
  if (raw.schema !== SCHEMA) fail(`${path}: schema must be ${SCHEMA}`);
  if (!Array.isArray(raw.results) || raw.results.length === 0) {
    fail(`${path}: results must be a non-empty array`);
  }
  const generatedAtIso = nonEmptyString(raw.generatedAtIso, `${path}.generatedAtIso`);
  const generatedAtMs = Date.parse(generatedAtIso);
  if (!Number.isFinite(generatedAtMs)) fail(`${path}: generatedAtIso must be an ISO timestamp`);
  if (!isRecord(raw.env)) fail(`${path}: env must be an object`);
  if (!isRecord(raw.support)) fail(`${path}: support must be an object`);
  if (!isRecord(raw.launcher) || !isRecord(raw.launcher.filter)) {
    fail(`${path}: launcher.filter must be an object`);
  }
  const browser = nonEmptyString(raw.env.browser, `${path}.env.browser`);
  if (raw.launcher.playwrightBrowser !== browser || raw.launcher.filter.browser !== browser) {
    fail(`${path}: launcher browser must match env.browser`);
  }
  if (raw.launcher.filter.reuseSuccessful !== false) {
    fail(`${path}: launcher.filter.reuseSuccessful must be false`);
  }
  const warmup = positiveInteger(raw.launcher.filter.warmup, `${path}.launcher.filter.warmup`);
  const iters = positiveInteger(raw.launcher.filter.iters, `${path}.launcher.filter.iters`);
  if (warmup < MIN_WARMUP) fail(`${path}: launcher warmup must be >=1`);
  if (iters < MIN_WALL_SAMPLES) fail(`${path}: launcher iters must be >=5`);
  const launcher = { warmup, iters };
  const results = raw.results.map((result, resultIndex) => {
    const label = `${path}.results[${resultIndex}]`;
    if (!isRecord(result)) fail(`${label} must be an object`);
    const engineId = nonEmptyString(result.engineId, `${label}.engineId`);
    const scenario = nonEmptyString(result.scenarioId, `${label}.scenarioId`);
    const family = nonEmptyString(result.family, `${label}.family`);
    if (!RESULT_STATUSES.has(result.status)) fail(`${label}.status is not recognized`);
    if (result.browser !== browser) fail(`${label}.browser must match export browser`);
    if (!isRecord(result.env)) fail(`${label}.env must be an object`);
    nonEmptyString(result.env.suiteVersion, `${label}.env.suiteVersion`);
    nonEmptyString(result.env.browserVersion, `${label}.env.browserVersion`);
    nonEmptyString(result.env.corpusChecksum, `${label}.env.corpusChecksum`);
    if (result.status === 'PASS') {
      if (
        !Array.isArray(result.oracleOutcomes) ||
        result.oracleOutcomes.length === 0 ||
        result.oracleOutcomes.some((outcome) => !isRecord(outcome) || outcome.pass !== true)
      ) {
        fail(`${label}: PASS requires at least one passing oracle outcome`);
      }
    }
    const selection =
      result.status === 'PASS' || result.status === 'FAIL' || result.status === 'ERROR'
        ? selectionIdentity(result.selection, label)
        : result.selection === null || result.selection === undefined
          ? undefined
          : selectionIdentity(result.selection, label);
    const wall =
      result.status === 'PASS' ? parseMetric(result, 'wall', launcher, label) : undefined;
    const peakMemory =
      result.status === 'PASS' ? parseMetric(result, 'peakMemory', launcher, label) : undefined;
    return { raw: result, label, engineId, scenario, family, selection, wall, peakMemory };
  });
  const scenarioIds = [...new Set(results.map((result) => result.scenario))].sort();
  if (Array.isArray(raw.launcher.filter.scenarioIds)) {
    const declared = [...new Set(raw.launcher.filter.scenarioIds)].sort();
    if (deepCanonical(declared) !== deepCanonical(scenarioIds)) {
      fail(`${path}: launcher scenarioIds do not match exported results`);
    }
  }
  const environment = {
    env: raw.env,
    support: raw.support,
    playwrightBrowser: raw.launcher.playwrightBrowser,
    playwrightVersion: raw.launcher.playwrightVersion,
    pillar: raw.launcher.pillar,
    filterPillar: raw.launcher.filter.pillar,
    warmup,
    iters,
    scenarioIds,
  };
  const resultEnvironment = results.map((result) => ({
    suiteVersion: result.raw.env?.suiteVersion,
    browserVersion: result.raw.env?.browserVersion,
    corpusChecksum: result.raw.env?.corpusChecksum,
  }));
  if (
    resultEnvironment.some((value) => deepCanonical(value) !== deepCanonical(resultEnvironment[0]))
  ) {
    fail(`${path}: result suite/browser/corpus environment differs within the export`);
  }
  return {
    path,
    label: basename(path),
    index,
    generatedAtIso,
    generatedAtMs,
    browser,
    launcher,
    environment,
    resultEnvironment: resultEnvironment[0],
    results,
  };
};

const validateSweepEnvironment = (sources, freshHours, nowMs) => {
  const newest = Math.max(...sources.map((source) => source.generatedAtMs));
  const oldest = Math.min(...sources.map((source) => source.generatedAtMs));
  if (newest > nowMs + 5 * 60 * 1000) fail('newest export timestamp is in the future');
  if (nowMs - newest > freshHours * 60 * 60 * 1000) {
    fail(`newest export is older than ${freshHours} hours`);
  }
  if (newest - oldest > freshHours * 60 * 60 * 1000) {
    fail(`input exports span more than ${freshHours} hours`);
  }
  const first = sources[0];
  for (const source of sources.slice(1)) {
    if (deepCanonical(source.environment) !== deepCanonical(first.environment)) {
      fail(`${source.label}: browser/support/launcher settings differ from ${first.label}`);
    }
    if (deepCanonical(source.resultEnvironment) !== deepCanonical(first.resultEnvironment)) {
      fail(`${source.label}: suite/browser/corpus cohort differs from ${first.label}`);
    }
  }
};

const buildCohorts = (sources) => {
  const cohorts = [];
  const slotDigests = new Map();
  for (const source of sources) {
    const byScenario = new Map();
    for (const result of source.results) {
      const list = byScenario.get(result.scenario) ?? [];
      list.push(result);
      byScenario.set(result.scenario, list);
    }
    for (const scenario of source.environment.scenarioIds) {
      const results = byScenario.get(scenario) ?? [];
      const engines = results.map((result) => result.engineId);
      const duplicates = engines.filter((engine, index) => engines.indexOf(engine) !== index);
      const missing = ROSTER.filter((engine) => !engines.includes(engine));
      const extra = engines.filter((engine) => !ROSTER_SET.has(engine));
      if (duplicates.length > 0 || missing.length > 0 || extra.length > 0) {
        fail(
          `${source.label} ${scenario}: roster mismatch (missing=${missing.join(',') || '-'}; ` +
            `extra=${extra.join(',') || '-'}; duplicates=${[...new Set(duplicates)].join(',') || '-'})`,
        );
      }
      const first = results[0];
      if (results.some((result) => result.family !== first.family)) {
        fail(`${source.label} ${scenario}: family differs inside cohort`);
      }
      const executable = results.filter(
        (result) =>
          result.raw.status === 'PASS' ||
          result.raw.status === 'FAIL' ||
          result.raw.status === 'ERROR',
      );
      // Oracle- or browser-unavailable rows can legitimately be NA for the entire roster. They have no
      // selection identity and no passing engine, so they are not contested performance features. Keep
      // mixed cohorts strict: as soon as any engine executes, every executing result must still share the
      // exact selection/SHA/runSeed below.
      if (executable.length === 0) continue;
      const selected = executable[0];
      if (selected.selection === undefined) {
        fail(`${source.label} ${scenario}: no executable result supplies selection identity`);
      }
      const identity = deepCanonical(selected.selection);
      const selectionBearing = results.filter((result) => result.selection !== undefined);
      if (selectionBearing.some((result) => deepCanonical(result.selection) !== identity)) {
        fail(`${source.label} ${scenario}: selection/SHA/runSeed differs inside cohort`);
      }
      const slot = `${scenario}\0${rotationKey(selected.selection)}`;
      const digest = selected.selection.sha256 ?? 'no-sha';
      const previousDigest = slotDigests.get(slot);
      if (previousDigest !== undefined && previousDigest !== digest) {
        fail(`${source.label} ${scenario}: ${rotationLabel(selected.selection)} changed digest`);
      }
      slotDigests.set(slot, digest);
      cohorts.push({
        source,
        scenario,
        family: first.family,
        selection: selected.selection,
        rotationKey: rotationKey(selected.selection),
        rotation: rotationLabel(selected.selection),
        results,
      });
    }
  }
  return cohorts;
};

const qualifiedMetric = (result, metric) => result[metric]?.metric;

const compareWall = (ours, rival) => {
  const deltaMs = rival.median - ours.median;
  const noiseMs = ours.mad + rival.mad;
  const status = deltaMs > noiseMs ? 'LEAD' : deltaMs < -noiseMs ? 'BEHIND' : 'PARITY';
  return { status, deltaMs, noiseMs, durableMarginMs: deltaMs - noiseMs };
};

const statusRank = (status) =>
  ({ BEHIND: 0, PARITY: 1, EXEMPT: 2, LEAD: 3, UNCONTESTED: 4 })[status] ?? 1;

const classifyRotation = (cohort, exemption) => {
  const ours = cohort.results.find((result) => result.engineId === US);
  const passingRivals = cohort.results.filter(
    (result) => result.engineId !== US && result.raw.status === 'PASS',
  );
  const gaps = [];
  if (ours.raw.status !== 'PASS')
    gaps.push(`${cohort.rotation}: aibrush status is ${ours.raw.status}`);
  if (passingRivals.length === 0) {
    return {
      ...cohort,
      status: ours.raw.status === 'PASS' ? 'UNCONTESTED' : 'BEHIND',
      passingRivals: [],
      wall: { status: 'UNCONTESTED', pairs: [] },
      memory: { status: 'UNCONTESTED' },
      gaps,
    };
  }

  const wallExempt = exemption?.metrics.includes('wall') === true;
  const memoryExempt = exemption?.metrics.includes('peakMemory') === true;
  const oursWall = qualifiedMetric(ours, 'wall');
  const wallPairs = [];
  if (oursWall === undefined) gaps.push(...(ours.wall?.gaps ?? [`${ours.label}: missing wall`]));
  for (const rival of passingRivals) {
    const rivalWall = qualifiedMetric(rival, 'wall');
    if (rivalWall === undefined) {
      gaps.push(...(rival.wall?.gaps ?? [`${rival.label}: missing wall`]));
    } else if (oursWall !== undefined) {
      wallPairs.push({
        engineId: rival.engineId,
        oursMedianMs: oursWall.median,
        oursMadMs: oursWall.mad,
        rivalMedianMs: rivalWall.median,
        rivalMadMs: rivalWall.mad,
        ...compareWall(oursWall, rivalWall),
      });
    }
  }
  const wallStatus =
    wallPairs.length !== passingRivals.length || oursWall === undefined
      ? 'PARITY'
      : wallPairs.some((pair) => pair.status === 'BEHIND')
        ? 'BEHIND'
        : wallPairs.some((pair) => pair.status === 'PARITY')
          ? 'PARITY'
          : 'LEAD';
  const bestRival = [...wallPairs].sort(
    (left, right) => left.rivalMedianMs - right.rivalMedianMs,
  )[0];
  const worstWallPair = [...wallPairs].sort(
    (left, right) => left.durableMarginMs - right.durableMarginMs,
  )[0];

  const oursMemory = qualifiedMetric(ours, 'peakMemory');
  const rivalMemories = [];
  if (oursMemory === undefined) {
    gaps.push(...(ours.peakMemory?.gaps ?? [`${ours.label}: missing peakMemory`]));
  }
  for (const rival of passingRivals) {
    const memory = qualifiedMetric(rival, 'peakMemory');
    if (memory === undefined) {
      gaps.push(...(rival.peakMemory?.gaps ?? [`${rival.label}: missing peakMemory`]));
    } else {
      rivalMemories.push({
        engineId: rival.engineId,
        medianBytes: memory.median,
        madBytes: memory.mad,
      });
    }
  }
  const leanestRival = [...rivalMemories].sort(
    (left, right) => left.medianBytes - right.medianBytes,
  )[0];
  const memoryStatus =
    oursMemory === undefined || rivalMemories.length !== passingRivals.length
      ? 'UNQUALIFIED'
      : oursMemory.median <= leanestRival.medianBytes
        ? 'QUALIFIED'
        : 'BEHIND';
  const wallEvidenceQualified = oursWall !== undefined && wallPairs.length === passingRivals.length;
  const memoryEvidenceQualified =
    oursMemory !== undefined && rivalMemories.length === passingRivals.length;

  let status;
  if (!wallEvidenceQualified || !memoryEvidenceQualified || ours.raw.status !== 'PASS') {
    status = 'PARITY';
  } else if (
    (!wallExempt && wallStatus === 'BEHIND') ||
    (!memoryExempt && memoryStatus === 'BEHIND')
  ) {
    status = 'BEHIND';
  } else if (
    (!wallExempt && wallStatus !== 'LEAD') ||
    (!memoryExempt && memoryStatus !== 'QUALIFIED')
  ) {
    status = 'PARITY';
  } else if (wallExempt || memoryExempt) status = 'EXEMPT';
  else status = 'LEAD';

  return {
    ...cohort,
    status,
    passingRivals: passingRivals.map((result) => result.engineId),
    wall: {
      status: wallExempt ? 'EXEMPT' : wallStatus,
      pairs: wallPairs,
      bestRival,
      worstWallPair,
    },
    memory: {
      status: memoryExempt ? 'EXEMPT' : memoryStatus,
      oursMedianBytes: oursMemory?.median,
      leanestRival,
    },
    gaps: [...new Set(gaps)],
  };
};

const newestCohortsByRotation = (cohorts) => {
  const newest = new Map();
  for (const cohort of cohorts) {
    const key = `${cohort.scenario}\0${cohort.rotationKey}`;
    const current = newest.get(key);
    if (
      current === undefined ||
      cohort.source.generatedAtMs > current.source.generatedAtMs ||
      (cohort.source.generatedAtMs === current.source.generatedAtMs &&
        cohort.source.index > current.source.index)
    ) {
      newest.set(key, cohort);
    }
  }
  return [...newest.values()];
};

const chooseWorstRotation = (rotations) =>
  [...rotations].sort((left, right) => {
    const rank = statusRank(left.status) - statusRank(right.status);
    if (rank !== 0) return rank;
    const leftMargin = left.wall.worstWallPair?.durableMarginMs ?? Number.POSITIVE_INFINITY;
    const rightMargin = right.wall.worstWallPair?.durableMarginMs ?? Number.POSITIVE_INFINITY;
    return leftMargin - rightMargin || left.rotation.localeCompare(right.rotation);
  })[0];

const buildRows = (cohorts, exemptions, notes) => {
  const byScenario = new Map();
  for (const cohort of newestCohortsByRotation(cohorts)) {
    const list = byScenario.get(cohort.scenario) ?? [];
    list.push(classifyRotation(cohort, exemptions.get(cohort.scenario)));
    byScenario.set(cohort.scenario, list);
  }
  const rows = [];
  for (const [scenario, rotations] of byScenario) {
    rotations.sort((left, right) => left.rotation.localeCompare(right.rotation));
    const expectedRotations = Math.max(
      ...rotations.map((rotation) => rotation.selection.candidateCount),
    );
    const coverageComplete = rotations.length >= expectedRotations;
    const worst = chooseWorstRotation(rotations);
    const exemption = exemptions.get(scenario);
    let status = worst.status;
    if (!coverageComplete && status !== 'BEHIND') status = 'PARITY';
    const note = notes.get(scenario);
    const generatedEvidence = `${worst.source.label}, ${worst.rotation}, same-export cohort, warm n=${
      worst.wall.bestRival?.oursMedianMs === undefined ? 'unqualified' : worst.source.launcher.iters
    }; worst of ${rotations.length}/${expectedRotations} rotations`;
    const gaps = [...new Set(rotations.flatMap((rotation) => rotation.gaps))];
    if (!coverageComplete) {
      gaps.push(`rotation coverage ${rotations.length}/${expectedRotations}`);
    }
    rows.push({
      scenario,
      family: worst.family,
      status,
      expectedRotations,
      measuredRotations: rotations.length,
      coverageComplete,
      worstRotation: worst.rotation,
      ourMedianMs: worst.wall.bestRival?.oursMedianMs,
      bestPassingRival: worst.wall.bestRival?.engineId,
      rivalMedianMs: worst.wall.bestRival?.rivalMedianMs,
      ratio:
        worst.wall.bestRival === undefined
          ? undefined
          : worst.wall.bestRival.oursMedianMs / worst.wall.bestRival.rivalMedianMs,
      ourPeakMemoryBytes: worst.memory.oursMedianBytes,
      leanestPassingRival: worst.memory.leanestRival?.engineId,
      leanestRivalPeakMemoryBytes: worst.memory.leanestRival?.medianBytes,
      memoryStatus: worst.memory.status,
      rootCause:
        note?.rootCause ??
        (status === 'EXEMPT'
          ? `${exemption.adr}: ${exemption.reason}`
          : status === 'LEAD' || status === 'UNCONTESTED'
            ? 'baseline lead; no optimization required'
            : 'OPEN — measured root cause not yet recorded'),
      optimizationIdeas:
        note?.optimizationIdeas ??
        (status === 'EXEMPT'
          ? 'accepted metric-specific physical limitation'
          : status === 'LEAD' || status === 'UNCONTESTED'
            ? 'none required'
            : 'OPEN — profile product code before optimizing'),
      closingEvidence: note?.closingEvidence ?? generatedEvidence,
      exemption,
      gaps,
      rotations: rotations.map((rotation) => ({
        source: rotation.source.label,
        rotation: rotation.rotation,
        status: rotation.status,
        wall: rotation.wall,
        memory: rotation.memory,
        gaps: rotation.gaps,
      })),
    });
  }
  return rows.sort(
    (left, right) =>
      left.family.localeCompare(right.family) || left.scenario.localeCompare(right.scenario),
  );
};

const mdCell = (value) =>
  String(value ?? 'UNMEASURED')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
const fixed = (value, digits = 3) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const bytes = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—');

const renderMarkdown = (data) => {
  const lines = [
    '# Session 13 per-feature speed ledger',
    '',
    `Generated from ${data.sources.length} public export(s) for ${data.browser}. Comparisons require the pinned seven-engine roster, identical same-export selection/SHA/runSeed, no result reuse, exports inside the freshness window, warm wall \`n>=5\`, complete rotations, a wall lead larger than pairwise sum-MAD, and positive post-warmup memory \`<=\` the leanest passing rival. Public JSON does not encode browser-profile deletion, so fresh-profile provenance must also accompany the final run.`,
    '',
    `Qualification: **${data.qualified ? 'GREEN' : 'RED'}** — ${data.counts.LEAD} LEAD, ` +
      `${data.counts.BEHIND} BEHIND, ${data.counts.PARITY} PARITY/unqualified, ` +
      `${data.counts.UNCONTESTED} UNCONTESTED, ${data.counts.EXEMPT} EXEMPT.`,
    '',
    '| feature | family | rotations | worst rotation | our median ms | best passing rival | rival ms | ratio | our peak bytes | leanest rival peak | memory | status | root cause | optimization idea(s) | closing evidence |',
    '|---|---|---:|---|---:|---|---:|---:|---:|---|---|---|---|---|---|',
  ];
  for (const row of data.rows) {
    lines.push(
      `| \`${mdCell(row.scenario)}\` | ${mdCell(row.family)} | ${row.measuredRotations}/${
        row.expectedRotations
      } | ${mdCell(row.worstRotation)} | ${fixed(row.ourMedianMs)} | ${mdCell(
        row.bestPassingRival,
      )} | ${fixed(row.rivalMedianMs)} | ${fixed(row.ratio)} | ${bytes(
        row.ourPeakMemoryBytes,
      )} | ${mdCell(row.leanestPassingRival)} ${bytes(row.leanestRivalPeakMemoryBytes)} | ${mdCell(
        row.memoryStatus,
      )} | **${row.status}** | ${mdCell(row.rootCause)} | ${mdCell(
        row.optimizationIdeas,
      )} | ${mdCell(row.closingEvidence)} |`,
    );
  }
  const gaps = data.rows.flatMap((row) => row.gaps.map((gap) => `${row.scenario}: ${gap}`));
  if (gaps.length > 0) {
    lines.push('', '## Qualification gaps', '');
    for (const gap of gaps) lines.push(`- ${gap}`);
  }
  lines.push('');
  return lines.join('\n');
};

const args = parseArguments(process.argv.slice(2));
const sources = args.paths.map(readExport);
validateSweepEnvironment(sources, args.freshHours, args.nowMs);
const exemptions = readExemptions(args.exemptionsPath);
const notes = readNotes(args.notesPath);
const cohorts = buildCohorts(sources);
const rows = buildRows(cohorts, exemptions, notes);
for (const scenario of notes.keys()) {
  if (!rows.some((row) => row.scenario === scenario))
    fail(`notes contain unknown scenario ${scenario}`);
}
const counts = Object.fromEntries(
  ['LEAD', 'BEHIND', 'PARITY', 'UNCONTESTED', 'EXEMPT'].map((status) => [
    status,
    rows.filter((row) => row.status === status).length,
  ]),
);
const qualified =
  rows.length > 0 &&
  rows.every(
    (row) => row.status === 'LEAD' || row.status === 'UNCONTESTED' || row.status === 'EXEMPT',
  );
const latestSource = [...sources].sort(
  (left, right) => right.generatedAtMs - left.generatedAtMs,
)[0];
const data = {
  schema: OUTPUT_SCHEMA,
  generatedAtIso: latestSource.generatedAtIso,
  browser: latestSource.browser,
  roster: ROSTER,
  sources: sources.map((source) => source.label),
  run: {
    warmup: latestSource.launcher.warmup,
    iters: latestSource.launcher.iters,
    resultReuse: false,
    freshProfileProvenance: 'required externally; not encoded by public export schema',
    suiteVersion: latestSource.resultEnvironment.suiteVersion,
    corpusChecksum: latestSource.resultEnvironment.corpusChecksum,
  },
  qualified,
  counts,
  rows,
};
writeAtomic(args.jsonPath, `${JSON.stringify(data, null, 2)}\n`);
writeAtomic(args.markdownPath, renderMarkdown(data));
console.info(
  `Session 13 speed ledger: ${rows.length} features; ${counts.LEAD} LEAD; ${counts.BEHIND} BEHIND; ` +
    `${counts.PARITY} PARITY/unqualified; ${counts.UNCONTESTED} UNCONTESTED; ` +
    `${counts.EXEMPT} EXEMPT; qualified=${qualified}`,
);
if (!qualified) process.exitCode = 1;
