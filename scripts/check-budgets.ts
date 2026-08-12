#!/usr/bin/env bun
/**
 * scripts/check-budgets.ts — enforce the package/bundle budgets (docs/architecture/08 §7, DoD §2).
 *
 * This inspects the built `dist/` artifacts, not source code. It gates:
 * - the eager default-entry kernel;
 * - the concrete first-operation MP4 probe route loaded by the public default entry;
 * - code splitting;
 * - same-origin, lazy WASM assets;
 * - the probe-only path pulling zero `.wasm` assets by static import.
 * - the heavy lazy codec/worker/op chunks staying OUT of the eager/default-registration closures.
 *
 * Run after `bun run build && bun run vendor-wasm`. Exits non-zero if a check fails.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { resolveLocalJsImport, staticLocalJsImports } from './bundle-graph.ts';

const DIST = new URL('../dist/', import.meta.url).pathname;
// Eager-kernel ceiling — the DoD §2 target. The Session-4 accretion (worker-offload dispatch + the
// lossy-seam audio filter planner) briefly pushed the leak-free eager kernel to ~54 kB, but those were
// genuinely lazy-split (offload execution → worker-host.ts; `audioFilterSpecs` + helpers →
// audio-stream-plan.ts, both reached only behind `import()`), bringing it back UNDER the DoD target —
// verified ZERO heavy codec/container/DSP/worker code in the eager closure.
const KERNEL_BUDGET = 50 * 1024; // eager kernel ≤ ~50 kB (DoD §2)
// Typical-app first-operation JS ceiling from REQUIREMENTS.md §8.3. Heavy WASM cores remain outside
// this closure and load only after a selected codec miss.
const TYPICAL_APP_BUDGET = 250 * 1024;
const MIN_JS_CHUNK_COUNT = 8;
// A non-zero guard band keeps "technically below the ceiling" from looking healthy. Probe orchestration
// now lives behind its operation import, so the eager kernel has enough honest room to reject a half-KiB
// regression without raising the public budget.
const MIN_BUDGET_MARGIN = 512;

const HEAVY_LAZY_GUARDS: readonly HeavyLazyGuard[] = [
  {
    label: 'native codec/filter implementation',
    pattern:
      /^(?:webcodecs-(?:audio|video)|gpu-video|cpu-video|audio-dsp|image-driver)(?:-[A-Z0-9]+)?\.js$/,
  },
  {
    label: 'WASM codec driver',
    pattern: /^wasm-(?:aac|av1|mp3|opus|vorbis|vorbis-enc|vpx)-driver-[A-Z0-9]+\.js$/,
  },
  {
    label: 'WASM/codec core',
    pattern: /^(?:aac|dav1d|mp3|opus|vorbis|vorbis-enc|vpx)-core(?:-[A-Z0-9]+)?\.js$/,
  },
  {
    label: 'lazy FLAC implementation',
    pattern: /^flac-(?:codec|driver)-[A-Z0-9]+\.js$/,
  },
  {
    label: 'worker boot/host',
    pattern: /^(?:worker\.js|worker-host-[A-Z0-9]+\.js)$/,
  },
  {
    label: 'live codec pipeline helper',
    pattern:
      /^(?:audio-stream-plan|codec-pipeline|decrypt-runner|element-materialize|flac-convert-plan|job-runner|live-convert|live-media|materialize|mux-packet-streams|mux-runner|pcm-convert-plan|preload|probe-runner|remux-runner|stream-target-materialize|trim-runner|trim-streams|video-frame-convert|video-stream-plan)-[A-Z0-9]+\.js$/,
  },
  {
    label: 'metadata writer helper',
    pattern:
      /^(?:id3|matroska-tags|metadata-rewrite|mp4-tags|ogg-vorbis-comment|remux-metadata|vorbis-comment)-[A-Z0-9]+\.js$/,
  },
];

// Chunk names are an intentionally independent first oracle above. Source maps make the leak check robust
// when esbuild folds a heavy module into a generic `chunk-*` artifact whose filename carries no identity.
const HEAVY_LAZY_SOURCE_GUARDS: readonly HeavyLazySourceGuard[] = [
  {
    label: 'worker boot/host',
    pattern: /\/src\/kernel\/worker(?!-mode\.ts$)[^/]*\.ts$/,
  },
  {
    label: 'WASM loader-only runtime',
    pattern: /\/src\/kernel\/wasm-loader-runtime\.ts$/,
  },
  {
    label: 'live/declarative operation implementation',
    pattern: /\/src\/(?:api\/(?:job-runner|live-convert)|sources\/live-media)\.ts$/,
  },
  {
    label: 'heavy operation helper',
    pattern:
      /\/src\/api\/(?:audio-stream-plan|codec-pipeline|decrypt-runner|flac-convert-plan|mux-runner|pcm-convert-plan|preload|probe-runner|remux-metadata|remux-runner|trim-runner|trim-streams|video-frame-convert|video-stream-plan)\.ts$/,
  },
  {
    label: 'sink implementation',
    pattern: /\/src\/sinks\/(?:element-materialize|stream-target-materialize)\.ts$/,
  },
  {
    label: 'codec implementation',
    pattern:
      /\/src\/(?:codecs\/(?:webcodecs-(?:audio|video)\.ts|wasm-[^/]+\/)|drivers\/flac\/flac-codec\.ts)/,
  },
  {
    label: 'filter/image implementation',
    pattern:
      /\/src\/(?:filters\/(?:audio-dsp|cpu-video|gpu-video)|codecs\/image\/image-driver)\.ts$/,
  },
  {
    label: 'container implementation',
    pattern:
      /\/src\/drivers\/(?:adts\/|aiff\/|avi\/(?!avi-sniff\.ts$)|caf\/|flac\/(?!flac-match\.ts$)|mp3\/|mp4\/(?!mp4-(?:lazy-driver|sniff)\.ts$)|mpegts\/(?!(?:mpegts-sniff|ts-framing)\.ts$)|ogg\/|wav\/|webm\/(?!webm-sniff\.ts$))/,
  },
];

const PROBE_ROUTE_GUARDS: readonly HeavyLazyGuard[] = [
  {
    label: 'register-all default drivers',
    pattern: /^defaults(?:-[A-Z0-9]+)?\.js$/,
  },
  {
    label: 'codec/filter implementation',
    pattern:
      /^(?:webcodecs-(?:audio|video)|gpu-video|cpu-video|audio-dsp|wasm-[A-Z0-9-]+-driver)(?:-[A-Z0-9]+)?\.js$/,
  },
  {
    label: 'full container implementation',
    pattern:
      /^(?:drivers\/(?:mp4|webm|wav|mp3|ogg|adts|aiff|caf|mpegts|avi|flac)\.js|(?:flac|wav)-lazy-driver-[A-Z0-9]+\.js)$/,
  },
  {
    label: 'unselected operation implementation',
    pattern:
      /^(?:audio-stream-plan|codec-pipeline|decrypt-runner|element-materialize|flac-convert-plan|job-runner|live-convert|live-media|materialize|mux-packet-streams|mux-runner|pcm-convert-plan|preload|remux-metadata|remux-runner|stream-target-materialize|trim-runner|trim-streams|video-frame-convert|video-stream-plan)-[A-Z0-9]+\.js$/,
  },
  ...HEAVY_LAZY_GUARDS.filter((guard) => guard.label !== 'live codec pipeline helper'),
];

const REMUX_ROUTE_GUARDS: readonly HeavyLazyGuard[] = [
  {
    label: 'register-all default drivers',
    pattern: /^defaults(?:-[A-Z0-9]+)?\.js$/,
  },
  {
    label: 'codec/filter implementation',
    pattern:
      /^(?:webcodecs-(?:audio|video)|gpu-video|cpu-video|audio-dsp|wasm-[A-Z0-9-]+-driver)(?:-[A-Z0-9]+)?\.js$/,
  },
  {
    label: 'unselected container implementation',
    pattern:
      /^(?:drivers\/(?:webm|wav|mp3|ogg|adts|aiff|caf|mpegts|avi|flac)\.js|(?:flac|wav)-lazy-driver-[A-Z0-9]+\.js)$/,
  },
  {
    label: 'unselected operation implementation',
    pattern:
      /^(?:audio-stream-plan|codec-pipeline|decrypt-runner|element-materialize|flac-convert-plan|job-runner|live-convert|live-media|mux-packet-streams|mux-runner|pcm-convert-plan|preload|probe-runner|remux-metadata|stream-target-materialize|trim-runner|trim-streams|video-frame-convert|video-stream-plan)-[A-Z0-9]+\.js$/,
  },
  ...HEAVY_LAZY_GUARDS.filter((guard) => guard.label !== 'live codec pipeline helper'),
];

const PROBE_ROUTE_SOURCE_GUARDS: readonly HeavyLazySourceGuard[] = [
  {
    label: 'codec implementation',
    pattern:
      /\/src\/codecs\/(?:webcodecs-(?:audio|video)\.ts|wasm-[^/]+\/|image\/image-driver\.ts)/,
  },
  {
    label: 'filter implementation',
    pattern: /\/src\/filters\/(?:audio-dsp|cpu-video|gpu-video)\.ts$/,
  },
  {
    label: 'full MP4 implementation',
    pattern:
      /\/src\/drivers\/mp4\/(?!codec-strings|display-transform|gapless|mdhd-language|mp4-lazy-driver|mp4-lazy-probe|mp4-sniff|reader|simple-video-probe)[^/]+\.ts$/,
  },
  {
    label: 'unselected container implementation',
    pattern:
      /\/src\/drivers\/(?:adts\/|aiff\/|avi\/(?!avi-sniff\.ts$)|caf\/|flac\/(?!flac-match\.ts$)|mp3\/|mpegts\/(?!(?:mpegts-sniff|ts-framing)\.ts$)|ogg\/|wav\/|webm\/(?!webm-sniff\.ts$))/,
  },
  {
    label: 'unselected operation implementation',
    pattern:
      /\/src\/api\/(?:audio-stream-plan|codec-pipeline|decrypt-runner|flac-convert-plan|job-runner|live-convert|mux-packet-streams|mux-runner|pcm-convert-plan|preload|remux-metadata|remux-runner|trim-runner|trim-streams|video-frame-convert|video-stream-plan)\.ts$/,
  },
  {
    label: 'worker/wasm runtime',
    pattern: /\/src\/kernel\/(?:worker(?!-mode\.ts$)[^/]*|wasm-loader-runtime)\.ts$/,
  },
  {
    label: 'FLAC codec implementation',
    pattern: /\/src\/drivers\/flac\/flac-codec\.ts$/,
  },
  {
    label: 'sink materializer',
    pattern: /\/src\/sinks\/(?:materialize|element-materialize|stream-target-materialize)\.ts$/,
  },
  {
    label: 'metadata writer implementation',
    pattern:
      /\/src\/metadata\/(?:id3|matroska-tags|metadata-rewrite|mp4-tags|ogg-vorbis-comment|vorbis-comment)\.ts$/,
  },
];

const REMUX_ROUTE_SOURCE_GUARDS: readonly HeavyLazySourceGuard[] = [
  {
    label: 'codec implementation',
    pattern:
      /\/src\/codecs\/(?:webcodecs-(?:audio|video)\.ts|wasm-[^/]+\/|image\/image-driver\.ts)/,
  },
  {
    label: 'filter implementation',
    pattern: /\/src\/filters\/(?:audio-dsp|cpu-video|gpu-video)\.ts$/,
  },
  {
    label: 'unselected container implementation',
    pattern:
      /\/src\/drivers\/(?:adts\/|aiff\/|avi\/(?!avi-sniff\.ts$)|caf\/|flac\/(?!flac-match\.ts$)|mp3\/|mpegts\/(?!(?:mpegts-sniff|ts-framing)\.ts$)|ogg\/|wav\/|webm\/(?!webm-sniff\.ts$))/,
  },
  {
    label: 'unselected operation implementation',
    pattern:
      /\/src\/api\/(?:audio-stream-plan|codec-pipeline|decrypt-runner|flac-convert-plan|job-runner|live-convert|mux-packet-streams|mux-runner|pcm-convert-plan|preload|probe-runner|remux-metadata|trim-runner|trim-streams|video-frame-convert|video-stream-plan)\.ts$/,
  },
  {
    label: 'worker/wasm runtime',
    pattern: /\/src\/kernel\/(?:worker(?!-mode\.ts$)[^/]*|wasm-loader-runtime)\.ts$/,
  },
  {
    label: 'FLAC codec implementation',
    pattern: /\/src\/drivers\/flac\/flac-codec\.ts$/,
  },
  {
    label: 'unselected sink materializer',
    pattern: /\/src\/sinks\/(?:element-materialize|stream-target-materialize)\.ts$/,
  },
  {
    label: 'metadata writer implementation',
    pattern:
      /\/src\/metadata\/(?:id3|matroska-tags|metadata-rewrite|mp4-tags|ogg-vorbis-comment|vorbis-comment)\.ts$/,
  },
];

const REQUIRED_EAGER_LAZY_IMPORTS: readonly LazyImportRequirement[] = [
  { label: 'default driver bundle', pattern: /^(?:defaults|defaults-[A-Z0-9]+)\.js$/ },
  {
    label: 'query-selective container registration',
    pattern: /^default-container-registration-[A-Z0-9]+\.js$/,
  },
  { label: 'worker host', pattern: /^worker-host-[A-Z0-9]+\.js$/ },
  { label: 'live codec pipeline', pattern: /^codec-pipeline-[A-Z0-9]+\.js$/ },
  { label: 'live MediaStream processor', pattern: /^live-media-[A-Z0-9]+\.js$/ },
  { label: 'live MediaStream convert coordinator', pattern: /^live-convert-[A-Z0-9]+\.js$/ },
  { label: 'live media processor', pattern: /^live-media-[A-Z0-9]+\.js$/ },
  { label: 'live conversion coordinator', pattern: /^live-convert-[A-Z0-9]+\.js$/ },
  { label: 'declarative job runner', pattern: /^job-runner-[A-Z0-9]+\.js$/ },
  { label: 'decrypt operation runner', pattern: /^decrypt-runner-[A-Z0-9]+\.js$/ },
  { label: 'explicit mux runner', pattern: /^mux-runner-[A-Z0-9]+\.js$/ },
  { label: 'probe operation runner', pattern: /^probe-runner-[A-Z0-9]+\.js$/ },
  { label: 'remux operation runner', pattern: /^remux-runner-[A-Z0-9]+\.js$/ },
  { label: 'trim operation runner', pattern: /^trim-runner-[A-Z0-9]+\.js$/ },
  { label: 'sink materializer', pattern: /^materialize-[A-Z0-9]+\.js$/ },
  {
    label: 'stream-target materializer',
    pattern: /^stream-target-materialize-[A-Z0-9]+\.js$/,
  },
];

const REQUIRED_REMUX_RUNNER_LAZY_IMPORTS: readonly LazyImportRequirement[] = [
  { label: 'remux metadata rewriter', pattern: /^remux-metadata-[A-Z0-9]+\.js$/ },
];

const REQUIRED_DEFAULT_PROBE_LAZY_IMPORTS: readonly LazyImportRequirement[] = [
  {
    label: 'lightweight MP4 faststart probe',
    pattern: /^mp4-lazy-probe-[A-Z0-9]+\.js$/,
  },
  {
    label: 'lazy FLAC driver',
    pattern: /^(?:flac-lazy-driver-[A-Z0-9]+\.js|drivers\/flac\.js)$/,
  },
  {
    label: 'lazy WAV driver',
    pattern: /^(?:wav-lazy-driver-[A-Z0-9]+\.js|drivers\/wav\.js)$/,
  },
  {
    label: 'WASM fallback driver',
    pattern: /^wasm-(?:aac|av1|mp3|opus|vorbis|vpx)-driver-[A-Z0-9]+\.js$/,
  },
  { label: 'WASM encoder driver', pattern: /^wasm-vorbis-enc-driver-[A-Z0-9]+\.js$/ },
];

interface FileReport {
  readonly file: string;
  readonly size: number;
}

interface DistGraph {
  readonly files: readonly string[];
  readonly jsFiles: readonly string[];
  readonly wasmFiles: readonly string[];
  readonly text: ReadonlyMap<string, string>;
  readonly sourceMapSources: ReadonlyMap<string, readonly string[]>;
}

interface WasmReference {
  readonly file: string;
  readonly asset: string;
}

interface HeavyLazyGuard {
  readonly label: string;
  readonly pattern: RegExp;
}

interface HeavyLazySourceGuard {
  readonly label: string;
  readonly pattern: RegExp;
}

interface LazyImportRequirement {
  readonly label: string;
  readonly pattern: RegExp;
}

interface LazyImportEdge {
  readonly from: string;
  readonly to: string;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

function fmt(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function distPath(file: string): string {
  return `${DIST}${file}`;
}

async function readDistGraph(): Promise<DistGraph> {
  let files: string[];
  try {
    files = collectDistFiles(DIST).sort();
  } catch {
    fail('dist/ is missing; run `bun run build` before `bun run check-budgets`');
  }
  const jsFiles = files.filter((file) => file.endsWith('.js'));
  const wasmFiles = files.filter((file) => file.endsWith('.wasm'));
  const entries = await Promise.all(
    jsFiles.map(
      async (file): Promise<readonly [string, string]> => [
        file,
        await Bun.file(distPath(file)).text(),
      ],
    ),
  );
  const sourceEntries = await Promise.all(
    jsFiles
      .filter((file) => files.includes(`${file}.map`))
      .map(async (file): Promise<readonly [string, readonly string[]]> => {
        const mapFile = `${file}.map`;
        const mapText = await Bun.file(distPath(mapFile)).text();
        return [file, parseSourceMapSources(mapText, mapFile)];
      }),
  );
  return {
    files,
    jsFiles,
    wasmFiles,
    text: new Map(entries),
    sourceMapSources: new Map(sourceEntries),
  };
}

function parseSourceMapSources(text: string, file: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail(`dist/${file} is not valid JSON`);
  }
  assert(
    typeof parsed === 'object' && parsed !== null && 'sources' in parsed,
    `dist/${file} has no sources array`,
  );
  const sources = parsed.sources;
  assert(Array.isArray(sources), `dist/${file} has no sources array`);
  const result: string[] = [];
  for (const source of sources) {
    assert(typeof source === 'string', `dist/${file} contains a non-string source`);
    result.push(source);
  }
  return result;
}

function collectDistFiles(directory: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...collectDistFiles(`${directory}${entry.name}/`, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function dynamicLocalJsImports(code: string): string[] {
  const specs: string[] = [];
  const re = /import\(\s*['"]((?:\.\.?\/)+[^'"]+\.js)['"]\s*\)/g;
  for (const match of code.matchAll(re)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec);
  }
  return unique(specs);
}

function staticLocalWasmImports(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /(?:^|[\s;])(?:import|export)\b[^'"]*?\bfrom\s*['"](\.\/[^'"]+\.wasm)['"]/g;
  for (const match of code.matchAll(fromRe)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec.replace(/^\.\//, ''));
  }
  const bareRe = /(?:^|[\s;])import\s*['"](\.\/[^'"]+\.wasm)['"]/g;
  for (const match of code.matchAll(bareRe)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec.replace(/^\.\//, ''));
  }
  return unique(specs);
}

function wasmUrlReferences(file: string, code: string): WasmReference[] {
  const refs: WasmReference[] = [];
  const re = /new\s+URL\(\s*['"]\.\/([^'"]+\.wasm)['"]\s*,\s*import\.meta\.url\s*\)/g;
  for (const match of code.matchAll(re)) {
    const asset = match[1];
    if (asset !== undefined) refs.push({ file, asset });
  }
  return refs;
}

function rawWasmMentions(code: string): string[] {
  const refs: string[] = [];
  const re = /['"]\.\/([^'"]+\.wasm)['"]/g;
  for (const match of code.matchAll(re)) {
    const asset = match[1];
    if (asset !== undefined) refs.push(asset);
  }
  return unique(refs);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function resolveDistJsImport(importer: string, specifier: string): string {
  const resolved = resolveLocalJsImport(importer, specifier);
  assert(!resolved.startsWith('../'), `dist/${importer} imports outside dist/: ${specifier}`);
  return resolved;
}

function closure(graph: DistGraph, entryFile: string): Map<string, number> {
  assert(graph.text.has(entryFile), `dist/${entryFile} is missing`);
  const sizes = new Map<string, number>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || sizes.has(file)) continue;
    const code = graph.text.get(file);
    assert(code !== undefined, `dist/${file} is imported but was not emitted`);
    sizes.set(file, Bun.file(distPath(file)).size);
    for (const spec of staticLocalJsImports(code)) queue.push(resolveDistJsImport(file, spec));
  }
  return sizes;
}

function unionClosure(graph: DistGraph, entryFiles: readonly string[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const entry of entryFiles) {
    for (const [file, size] of closure(graph, entry)) merged.set(file, size);
  }
  return merged;
}

function closureReport(title: string, files: Map<string, number>, budget: number): number {
  const report: FileReport[] = [...files].map(([file, size]) => ({ file, size }));
  const total = report.reduce((sum, item) => sum + item.size, 0);
  console.info(title);
  for (const item of report.sort((a, b) => b.size - a.size || a.file.localeCompare(b.file))) {
    console.info(`  ${fmt(item.size).padStart(10)}  ${item.file}`);
  }
  console.info(`  ${'-'.repeat(10)}`);
  console.info(`  ${fmt(total).padStart(10)}  total (budget ${fmt(budget)})`);
  const compressed = compressedTotals([...files.keys()]);
  console.info(
    `  compressed totals: gzip ${fmt(compressed.gzip)}, Brotli ${fmt(compressed.brotli)}`,
  );
  return total;
}

function compressedTotals(files: readonly string[]): {
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
} {
  let raw = 0;
  let gzip = 0;
  let brotli = 0;
  for (const file of files) {
    const bytes = readFileSync(distPath(file));
    raw += bytes.byteLength;
    gzip += gzipSync(bytes).byteLength;
    brotli += brotliCompressSync(bytes).byteLength;
  }
  return { raw, gzip, brotli };
}

function artifactReport(label: string, files: readonly string[]): void {
  const totals = compressedTotals(files);
  console.info(
    `${label}: ${files.length} files; raw ${fmt(totals.raw)}, gzip ${fmt(
      totals.gzip,
    )}, Brotli ${fmt(totals.brotli)}`,
  );
}

function findDefaultDriverChunk(graph: DistGraph): string {
  const matches = graph.jsFiles.filter(
    (file) => file === 'defaults.js' || /^defaults-[A-Z0-9]+\.js$/.test(file),
  );
  assert(matches.length === 1, `expected exactly one defaults chunk, found ${matches.length}`);
  const match = matches[0];
  assert(match !== undefined, 'internal error: defaults chunk match disappeared');
  return match;
}

function assertBudget(label: string, total: number, budget: number): void {
  if (total > budget) {
    fail(`${label} ${fmt(total)} exceeds the ${fmt(budget)} budget`);
  }
  const margin = budget - total;
  if (margin < MIN_BUDGET_MARGIN) {
    console.warn(
      `! ${label} has only ${fmt(margin)} architecture headroom (recommended ${fmt(
        MIN_BUDGET_MARGIN,
      )})`,
    );
  }
  console.info(`✓ ${label} within budget (${fmt(total)} <= ${fmt(budget)}, margin ${fmt(margin)})`);
}

function assertCodeSplit(
  graph: DistGraph,
  eagerKernel: Map<string, number>,
  defaultDriverChunk: string,
): void {
  assert(
    graph.jsFiles.length >= MIN_JS_CHUNK_COUNT,
    `expected at least ${MIN_JS_CHUNK_COUNT} JS chunks, found ${graph.jsFiles.length}`,
  );
  const dynamicImports = new Set<string>();
  const staticImports = new Set<string>();
  for (const edge of dynamicImportEdges(graph, eagerKernel)) dynamicImports.add(edge.to);
  for (const file of eagerKernel.keys()) {
    const code = graph.text.get(file);
    assert(code !== undefined, `dist/${file} is missing`);
    for (const spec of staticLocalJsImports(code)) {
      staticImports.add(resolveDistJsImport(file, spec));
    }
  }
  assert(
    dynamicImports.has(defaultDriverChunk),
    `eager kernel must lazy-import ${defaultDriverChunk}`,
  );
  assert(!staticImports.has(defaultDriverChunk), 'default driver bundle is statically imported');
  console.info(`✓ code-split chunks present (${graph.jsFiles.length} JS files)`);
  console.info(`✓ default driver bundle is lazy (${defaultDriverChunk})`);
}

function dynamicImportEdges(
  graph: DistGraph,
  files: ReadonlyMap<string, number>,
): LazyImportEdge[] {
  const edges: LazyImportEdge[] = [];
  for (const file of files.keys()) {
    const code = graph.text.get(file);
    assert(code !== undefined, `dist/${file} is missing`);
    for (const spec of dynamicLocalJsImports(code)) {
      const target = resolveDistJsImport(file, spec);
      assert(graph.text.has(target), `dist/${file} lazy-imports missing chunk ${target}`);
      edges.push({ from: file, to: target });
    }
  }
  return edges.sort((a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from));
}

function assertRequiredLazyImports(
  label: string,
  edges: readonly LazyImportEdge[],
  requirements: readonly LazyImportRequirement[],
): void {
  const targets = new Set(edges.map((edge) => edge.to));
  for (const requirement of requirements) {
    assert(
      [...targets].some((file) => requirement.pattern.test(file)),
      `${label} does not expose a lazy ${requirement.label} import`,
    );
  }
}

function requireLazyTarget(
  label: string,
  edges: readonly LazyImportEdge[],
  pattern: RegExp,
): string {
  const matches = unique(edges.map((edge) => edge.to)).filter((file) => pattern.test(file));
  assert(
    matches.length === 1,
    `${label} expected exactly one lazy target, found ${matches.length}`,
  );
  const match = matches[0];
  assert(match !== undefined, `${label} lazy target disappeared`);
  return match;
}

function assertClosureContainsSource(
  label: string,
  files: ReadonlyMap<string, number>,
  graph: DistGraph,
  pattern: RegExp,
): void {
  const sources = [...files.keys()].flatMap((file) => graph.sourceMapSources.get(file) ?? []);
  assert(
    sources.some((source) => pattern.test(source)),
    `${label} source implementation is missing`,
  );
  console.info(`✓ ${label} is present only in its lazy operation closure`);
}

function logLazyFrontier(label: string, edges: readonly LazyImportEdge[]): void {
  const targets = unique(edges.map((edge) => edge.to));
  console.info(`${label} lazy frontier (${targets.length} chunks):`);
  for (const target of targets) {
    const from = edges
      .filter((edge) => edge.to === target)
      .map((edge) => edge.from)
      .join(', ');
    console.info(`  ${target}  <- ${from}`);
  }
}

function heavyLazyLeaks(
  files: ReadonlyMap<string, number>,
  guards: readonly HeavyLazyGuard[] = HEAVY_LAZY_GUARDS,
): string[] {
  const leaks: string[] = [];
  for (const file of files.keys()) {
    const guard = guards.find((candidate) => candidate.pattern.test(file));
    if (guard !== undefined) leaks.push(`${file} (${guard.label})`);
  }
  return leaks.sort();
}

function assertNoHeavyLazyLeaks(
  label: string,
  files: ReadonlyMap<string, number>,
  guards: readonly HeavyLazyGuard[] = HEAVY_LAZY_GUARDS,
): void {
  const leaks = heavyLazyLeaks(files, guards);
  assert(
    leaks.length === 0,
    `${label} statically includes heavy lazy artifacts: ${leaks.join(', ')}`,
  );
  console.info(`✓ ${label} excludes heavy lazy codec/worker/op chunks`);
}

function assertNoHeavyLazySourceLeaks(
  label: string,
  files: ReadonlyMap<string, number>,
  graph: DistGraph,
  guards: readonly HeavyLazySourceGuard[] = HEAVY_LAZY_SOURCE_GUARDS,
): void {
  const leaks: string[] = [];
  for (const file of files.keys()) {
    const sources = graph.sourceMapSources.get(file);
    assert(sources !== undefined, `dist/${file}.map sources are missing`);
    for (const source of sources) {
      const guard = guards.find((candidate) => candidate.pattern.test(source));
      if (guard !== undefined) leaks.push(`${source} via ${file} (${guard.label})`);
    }
  }
  assert(
    leaks.length === 0,
    `${label} source maps contain heavy lazy implementations: ${leaks.sort().join(', ')}`,
  );
  console.info(`✓ ${label} source maps exclude heavy lazy implementations`);
}

function assertNoWasmRouteReferences(
  label: string,
  files: ReadonlyMap<string, number>,
  graph: DistGraph,
): void {
  const references: string[] = [];
  for (const file of files.keys()) {
    const code = graph.text.get(file);
    assert(code !== undefined, `dist/${file} is missing`);
    for (const asset of rawWasmMentions(code)) references.push(`${file} -> ${asset}`);
  }
  assert(references.length === 0, `${label} contains WASM references: ${references.join(', ')}`);
  console.info(`✓ ${label} contains zero WASM references/assets`);
}

function assertWasmPackaging(
  graph: DistGraph,
  eagerKernel: Map<string, number>,
  probeOnlyJs: Map<string, number>,
): void {
  const allStaticWasm = new Map<string, string[]>();
  const urlRefs: WasmReference[] = [];
  const malformedMentions: WasmReference[] = [];
  for (const [file, code] of graph.text) {
    const staticRefs = staticLocalWasmImports(code);
    if (staticRefs.length > 0) allStaticWasm.set(file, staticRefs);
    const sameOriginRefs = wasmUrlReferences(file, code);
    urlRefs.push(...sameOriginRefs);
    const sameOriginAssets = new Set(sameOriginRefs.map((ref) => ref.asset));
    for (const asset of rawWasmMentions(code)) {
      if (!sameOriginAssets.has(asset)) malformedMentions.push({ file, asset });
    }
  }

  assert(
    allStaticWasm.size === 0,
    `WASM must not be statically imported; found ${formatRefMap(allStaticWasm)}`,
  );
  assert(
    malformedMentions.length === 0,
    `WASM references must use new URL('./asset.wasm', import.meta.url); found ${formatRefs(
      malformedMentions,
    )}`,
  );

  const emittedWasm = new Set(graph.wasmFiles);
  for (const wasmFile of graph.wasmFiles) {
    assert(
      urlRefs.some((ref) => ref.asset === wasmFile),
      `emitted WASM asset ${wasmFile} is not referenced by a same-origin import.meta.url URL`,
    );
  }
  for (const ref of urlRefs) {
    assert(
      !eagerKernel.has(ref.file),
      `eager kernel contains a WASM URL reference (${ref.file} -> ${ref.asset})`,
    );
  }
  const probeStaticWasmAssets = new Set<string>();
  for (const file of probeOnlyJs.keys()) {
    const code = graph.text.get(file);
    if (code === undefined) continue;
    for (const asset of staticLocalWasmImports(code)) probeStaticWasmAssets.add(asset);
  }
  assert(
    probeStaticWasmAssets.size === 0,
    `probe-only path statically pulls WASM assets: ${[...probeStaticWasmAssets].join(', ')}`,
  );
  assert(emittedWasm.size > 0, 'expected emitted WASM assets in dist/');
  const probeWasmUrlRefs = urlRefs.filter((ref) => probeOnlyJs.has(ref.file));
  console.info(`✓ WASM assets emitted separately (${[...emittedWasm].sort().join(', ')})`);
  console.info('✓ WASM is same-origin via import.meta.url and absent from the eager static path');
  if (probeWasmUrlRefs.length === 0) {
    console.info('✓ default/probe first-operation closure contains no WASM URL references');
  } else {
    console.info(
      `• default/probe first-operation closure contains deferred WASM URL references: ${formatRefs(
        probeWasmUrlRefs,
      )}`,
    );
    console.info(
      '  verify:package owns the installed tree-shaken probe-only zero-emitted-WASM assertion',
    );
  }
}

function formatRefs(refs: readonly WasmReference[]): string {
  return refs.map((ref) => `${ref.file} -> ${ref.asset}`).join(', ');
}

function formatRefMap(map: ReadonlyMap<string, readonly string[]>): string {
  return [...map].map(([file, refs]) => `${file} -> ${refs.join(',')}`).join('; ');
}

const graph = await readDistGraph();
assert(graph.files.includes('index.js'), 'dist/index.js is missing');
assert(graph.files.includes('index.d.ts'), 'dist/index.d.ts is missing');
assert(graph.files.includes('core.js'), 'dist/core.js is missing');
assert(graph.files.includes('core.d.ts'), 'dist/core.d.ts is missing');

const defaultDriverChunk = findDefaultDriverChunk(graph);
const eagerKernel = closure(graph, 'index.js');
const eagerTotal = closureReport(
  'Eager kernel closure (statically reachable from the default entry):',
  eagerKernel,
  KERNEL_BUDGET,
);
assertNoHeavyLazySourceLeaks('eager kernel', eagerKernel, graph);
assertBudget('eager kernel', eagerTotal, KERNEL_BUDGET);
assertNoHeavyLazyLeaks('eager kernel', eagerKernel);

assertCodeSplit(graph, eagerKernel, defaultDriverChunk);
const eagerLazyEdges = dynamicImportEdges(graph, eagerKernel);
const defaultDriverClosure = closure(graph, defaultDriverChunk);
const defaultProbeLazyEdges = dynamicImportEdges(graph, defaultDriverClosure);
assertRequiredLazyImports('eager kernel', eagerLazyEdges, REQUIRED_EAGER_LAZY_IMPORTS);
assertRequiredLazyImports(
  'default registration closure',
  defaultProbeLazyEdges,
  REQUIRED_DEFAULT_PROBE_LAZY_IMPORTS,
);
const probeRunnerChunk = requireLazyTarget(
  'eager probe runner',
  eagerLazyEdges,
  /^probe-runner-[A-Z0-9]+\.js$/,
);
assertClosureContainsSource(
  'probe operation orchestration',
  closure(graph, probeRunnerChunk),
  graph,
  /\/src\/api\/probe-runner\.ts$/,
);
const probeRangeCacheChunk = requireLazyTarget(
  'eager probe range cache',
  eagerLazyEdges,
  /^probe-range-cache-[A-Z0-9]+\.js$/,
);
const selectiveContainerRegistrationChunk = requireLazyTarget(
  'query-selective container registration',
  eagerLazyEdges,
  /^default-container-registration-[A-Z0-9]+\.js$/,
);
const selectiveContainerClosure = closure(graph, selectiveContainerRegistrationChunk);
const selectiveContainerLazyEdges = dynamicImportEdges(graph, selectiveContainerClosure);
const mp4LazyDriverChunk = requireLazyTarget(
  'query-selective MP4 lazy driver',
  selectiveContainerLazyEdges,
  /^mp4-lazy-driver-[A-Z0-9]+\.js$/,
);
const mp4LazyDriverClosure = closure(graph, mp4LazyDriverChunk);
const mp4LazyDriverEdges = dynamicImportEdges(graph, mp4LazyDriverClosure);
const mp4ProbeChunk = requireLazyTarget(
  'lightweight query-selective MP4 faststart probe',
  mp4LazyDriverEdges,
  /^mp4-lazy-probe-[A-Z0-9]+\.js$/,
);
const mp4DriverChunk = requireLazyTarget(
  'full query-selective MP4 container fallback',
  mp4LazyDriverEdges,
  /^drivers\/mp4\.js$/,
);
const typicalMp4Probe = unionClosure(graph, [
  'index.js',
  probeRunnerChunk,
  probeRangeCacheChunk,
  selectiveContainerRegistrationChunk,
  mp4LazyDriverChunk,
  mp4ProbeChunk,
]);
const typicalTotal = closureReport(
  '\nTypical MP4 probe first-operation JS closure (public default entry):',
  typicalMp4Probe,
  TYPICAL_APP_BUDGET,
);
assertNoHeavyLazySourceLeaks('default registration closure', defaultDriverClosure, graph);
assertNoHeavyLazyLeaks('default registration closure', defaultDriverClosure);
assert(
  !typicalMp4Probe.has(mp4DriverChunk),
  'typical faststart MP4 probe route statically loads the full MP4 driver fallback',
);
assertNoHeavyLazySourceLeaks(
  'typical MP4 probe route',
  typicalMp4Probe,
  graph,
  PROBE_ROUTE_SOURCE_GUARDS,
);
assertNoHeavyLazyLeaks('typical MP4 probe route', typicalMp4Probe, PROBE_ROUTE_GUARDS);
assertNoWasmRouteReferences('typical MP4 probe route', typicalMp4Probe, graph);
assertBudget('typical MP4 probe first-operation JS', typicalTotal, TYPICAL_APP_BUDGET);
const remuxRunnerChunk = requireLazyTarget(
  'eager remux runner',
  eagerLazyEdges,
  /^remux-runner-[A-Z0-9]+\.js$/,
);
const remuxRunnerClosure = closure(graph, remuxRunnerChunk);
const materializeChunk = requireLazyTarget(
  'default Blob materializer',
  eagerLazyEdges,
  /^materialize-[A-Z0-9]+\.js$/,
);
const typicalMp4Remux = unionClosure(graph, [
  'index.js',
  remuxRunnerChunk,
  selectiveContainerRegistrationChunk,
  mp4LazyDriverChunk,
  mp4DriverChunk,
  materializeChunk,
]);
const typicalRemuxTotal = closureReport(
  '\nTypical native MP4 remux first-operation JS closure (public default entry):',
  typicalMp4Remux,
  TYPICAL_APP_BUDGET,
);
assertNoHeavyLazySourceLeaks(
  'typical native MP4 remux route',
  typicalMp4Remux,
  graph,
  REMUX_ROUTE_SOURCE_GUARDS,
);
assertNoHeavyLazyLeaks('typical native MP4 remux route', typicalMp4Remux, REMUX_ROUTE_GUARDS);
assertNoWasmRouteReferences('typical native MP4 remux route', typicalMp4Remux, graph);
assertBudget('typical native MP4 remux first-operation JS', typicalRemuxTotal, TYPICAL_APP_BUDGET);
const remuxRunnerLazyEdges = dynamicImportEdges(graph, remuxRunnerClosure);
assertRequiredLazyImports(
  'remux operation closure',
  remuxRunnerLazyEdges,
  REQUIRED_REMUX_RUNNER_LAZY_IMPORTS,
);
const remuxMetadataChunk = requireLazyTarget(
  'remux metadata rewriter',
  remuxRunnerLazyEdges,
  /^remux-metadata-[A-Z0-9]+\.js$/,
);
assertClosureContainsSource(
  'metadata rewrite dispatch',
  closure(graph, remuxMetadataChunk),
  graph,
  /\/src\/metadata\/metadata-rewrite\.ts$/,
);
logLazyFrontier('\nEager kernel', eagerLazyEdges);
logLazyFrontier('\nRemux operation', remuxRunnerLazyEdges);
logLazyFrontier('\nSelective container registration', selectiveContainerLazyEdges);
logLazyFrontier('\nMP4 lazy driver', mp4LazyDriverEdges);
logLazyFrontier('\nDefault registration', defaultProbeLazyEdges);
assertWasmPackaging(graph, eagerKernel, typicalMp4Probe);
console.info('\nEmitted artifact compression report (per-file compressed sums):');
artifactReport('  JavaScript', graph.jsFiles);
artifactReport(
  '  worker JavaScript',
  graph.jsFiles.filter((file) => /(?:^|\/)(?:worker|worker-host)(?:-[A-Z0-9]+)?\.js$/.test(file)),
);
artifactReport('  WebAssembly', graph.wasmFiles);
artifactReport(
  '  other codec data',
  graph.files.filter((file) => /\.(?:bin|data|model|weights)$/i.test(file)),
);

console.info('\n✓ all package budget checks passed');
