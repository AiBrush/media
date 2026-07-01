// One-shot generator for docs/perf/performance-deficits.md.
// Reads the exported browser-cache run, computes every scenario where a
// competitor beats us on wall-time (same-work: both PASS the identical oracle),
// and emits the ranked deficit backlog. Re-run against a fresher export to refresh.
//
// This is also the Session 9 speed gate: it exits non-zero while any
// non-exempt deficit remains. Parity exemptions must be explicit and ADR-backed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [SRC, ...OVERLAY_SRCS] = process.argv.slice(2);
if (!SRC) throw new Error('usage: node gen-deficits.mjs <export.json> [overlay-export.json ...]');
const raw = JSON.parse(readFileSync(SRC, 'utf8'));
const overlays = OVERLAY_SRCS.map((path) => ({ path, raw: JSON.parse(readFileSync(path, 'utf8')) }));
const US = 'aibrush-media@dev';
const EXEMPTIONS_PATH = 'docs/perf/performance-parity-exemptions.json';

const readExemptions = () => {
  if (!existsSync(EXEMPTIONS_PATH)) return new Map();
  const parsed = JSON.parse(readFileSync(EXEMPTIONS_PATH, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${EXEMPTIONS_PATH} must be an array`);
  }
  const out = new Map();
  for (const [i, entry] of parsed.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${EXEMPTIONS_PATH}[${i}] must be an object`);
    }
    const scenario = entry.scenario;
    const reason = entry.reason;
    const adr = entry.adr;
    if (typeof scenario !== 'string' || scenario.length === 0) {
      throw new Error(`${EXEMPTIONS_PATH}[${i}].scenario must be a non-empty string`);
    }
    if (typeof reason !== 'string' || reason.trim().length < 12) {
      throw new Error(`${EXEMPTIONS_PATH}[${i}].reason must explain the exemption`);
    }
    if (typeof adr !== 'string' || !/^ADR-\d{3}$/.test(adr)) {
      throw new Error(`${EXEMPTIONS_PATH}[${i}].adr must look like ADR-123`);
    }
    if (out.has(scenario)) {
      throw new Error(`${EXEMPTIONS_PATH} duplicates scenario ${scenario}`);
    }
    out.set(scenario, { reason: reason.trim(), adr });
  }
  return out;
};

const exemptions = readExemptions();

const resultKey = (x) => `${x.browser ?? 'unknown'}\0${x.scenarioId}\0${x.engineId}`;
const mergedResults = new Map();
for (const x of raw.results) {
  mergedResults.set(resultKey(x), x);
}
for (const overlay of overlays) {
  for (const x of overlay.raw.results) {
    mergedResults.set(resultKey(x), x);
  }
}
const generatedAtIso = overlays.at(-1)?.raw.generatedAtIso ?? raw.generatedAtIso;
const sourceLabel = [basename(SRC), ...overlays.map((overlay) => basename(overlay.path))].join(' + ');

/** scenario -> engine -> { wall, family, status } (only oracle-passing, timed cells) */
const idx = {};
for (const x of mergedResults.values()) {
  const w = x.bench?.wall?.median;
  if (x.status !== 'PASS') continue;
  if (typeof w !== 'number') continue;
  (idx[x.scenarioId] ||= {})[x.engineId] = { w, fam: x.family, status: x.status };
}

const losses = [];
let contested = 0;
for (const [s, engs] of Object.entries(idx)) {
  const us = engs[US];
  if (!us) continue;
  const comps = Object.entries(engs).filter(([e]) => e !== US);
  if (!comps.length) continue;
  contested++;
  let best = null;
  for (const [e, d] of comps) if (!best || d.w < best.w) best = { e, w: d.w };
  if (best.w < us.w - 1e-6) {
    const exemption = exemptions.get(s);
    losses.push({
      s,
      fam: us.fam,
      our: us.w,
      comp: best.e.split('@')[0],
      cw: best.w,
      ratio: us.w / best.w,
      exemption,
    });
  }
}
losses.sort((a, b) => b.ratio - a.ratio);

const activeLosses = losses.filter((l) => !l.exemption);
const exemptLosses = losses.filter((l) => l.exemption);
const tier = (lo, hi) => activeLosses.filter((l) => l.ratio >= lo && l.ratio < hi);
const T1 = tier(100, Infinity),
  T2 = tier(10, 100),
  T3 = tier(3, 10),
  T4 = tier(0, 3);

const famStat = {};
for (const l of activeLosses) {
  const f = (famStat[l.fam] ||= { n: 0, worst: 0 });
  f.n++;
  f.worst = Math.max(f.worst, l.ratio);
}

const table = (rows) => {
  let o = '| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |\n';
  o += '|--:|----------|--------|----------:|---------------|------------:|---------:|\n';
  rows.forEach((l, i) => {
    o += `| ${i + 1} | \`${l.s}\` | ${l.fam} | ${l.our.toFixed(1)} | ${l.comp} | ${l.cw.toFixed(1)} | ${l.ratio.toFixed(1)}× |\n`;
  });
  return o;
};

const famRows =
  Object.entries(famStat)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `| ${k} | ${v.n} | ${v.worst.toFixed(0)}× |`)
    .join('\n') || '| _(none)_ | 0 | 0× |';

const exemptionTable = (rows) => {
  if (!rows.length) return '_No parity exemptions are currently recorded._\n';
  let o =
    '| Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown | ADR | Reason |\n';
  o +=
    '|----------|--------|----------:|---------------|------------:|---------:|-----|--------|\n';
  for (const l of rows) {
    o += `| \`${l.s}\` | ${l.fam} | ${l.our.toFixed(1)} | ${l.comp} | ${l.cw.toFixed(1)} | ${l.ratio.toFixed(1)}× | ${l.exemption.adr} | ${l.exemption.reason} |\n`;
  }
  return o;
};

const doc = `# Performance deficits — where rivals beat aibrush-media (Chromium)

> **Auto-generated** by \`docs/perf/gen-deficits.mjs\` from \`${sourceLabel}\`
> (latest included export ${generatedAtIso}). Re-run the generator against a
> fresher export to refresh. Do not hand-edit the tables.

We rank **#1 on correctness** (100% conformance). This file is the opposite view:
the **speed** gaps. A cell is a *deficit* iff, on Chromium, we and at least one
competitor **both PASS the identical golden oracle** (same work) and the
competitor's median wall-time is lower than ours. NA/FAIL cells and cells no
rival timed are excluded — so every row below is an honest, same-work loss.

## Headline

- **Contested scenarios** (we + ≥1 rival both timed & passing): **${contested}**
- **Active deficits where a rival is faster than us: ${activeLosses.length} (${((100 * activeLosses.length) / contested).toFixed(0)}%)**
- **ADR-backed parity exemptions:** ${exemptLosses.length}
- **Raw faster-rival rows before exemptions:** ${losses.length} (${((100 * losses.length) / contested).toFixed(0)}%)
- Severity split: **${T1.length} catastrophic** (≥100×) · **${T2.length} severe** (10–100×) · **${T3.length} moderate** (3–10×) · **${T4.length} minor** (<3×)

⚠️ **Caveat:** this export is **single-sample (\`n=1\`)** per cell — exact ratios are
noisy; the *direction* and the *tiering* are reliable. Re-measure multi-sample
before locking any specific number.

## Two root causes (this is the whole story)

**A. Eager, whole-file processing where rivals seek to the index/\`moov\`.**
The original Session 9 export exposed catastrophic whole-file scans on
\`massive\`/\`huge\` files; overlay exports in this header record which of those
have been closed. Remaining large-file rows should still be treated as index
routing work first: metadata/probe should seek to the header or index, and
packet-table scenarios should enumerate timeline facts without materializing
payload bytes. Any full-body read on these rows is a real speed loss.

**B. High fixed per-operation overhead.** On tiny inputs we are still 5–30×
slower even though the real work is microseconds — e.g. \`mux/pcm_s16_to_wav\`
(a header + copy): **us 110 ms** vs mediabunny 4 ms. A large constant (init /
WASM / WebCodecs config / worker spin-up / buffer copies with no reuse) dominates.
This explains the ${T4.length} "minor" losses smeared across *every* family.

Fixing **A** collapses the tail of the distribution; fixing **B** shifts the whole
curve left. Attack **A first** (algorithmic, few code paths, 100–1000× cells),
then **B** (profile the ~100 ms floor on a trivial op and amortize it).

## Deficits by family

| Family | # deficits | Worst slowdown |
|--------|-----------:|---------------:|
${famRows}

## Tier 1 — Catastrophic (≥100× slower) — fix first

${table(T1)}
## Tier 2 — Severe (10–100× slower)

${table(T2)}
## Tier 3 — Moderate (3–10× slower)

${table(T3)}
## Tier 4 — Minor (<3× slower) — the long tail (mostly root-cause B)

${table(T4)}
## ADR-backed parity exemptions

${exemptionTable(exemptLosses)}`;

writeFileSync('docs/perf/performance-deficits.md', doc);
writeFileSync(
  'docs/perf/_deficit-data.json',
  `${JSON.stringify(
    {
      generatedFrom: generatedAtIso,
      source: basename(SRC),
      overlays: overlays.map((overlay) => basename(overlay.path)),
      contested,
      rawLossCount: losses.length,
      activeLossCount: activeLosses.length,
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

const summary = `wrote docs/perf/performance-deficits.md — ${activeLosses.length} active deficits (${T1.length}/${T2.length}/${T3.length}/${T4.length}), ${exemptLosses.length} exempt`;
if (activeLosses.length > 0) {
  console.error(summary);
  process.exit(1);
}
console.log(summary);
