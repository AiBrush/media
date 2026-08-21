#!/usr/bin/env bun
/**
 * Verify the package as a clean consumer sees it: pack the current workspace, install that tarball into a
 * fresh app, typecheck public export-map imports, run a package-name import, and measure real consumer
 * browser bundles. This is intentionally downstream of `bun run build && bun run vendor-wasm`: the packed
 * artifact must contain the same `dist/` a publisher would ship.
 *
 * **Three eager numbers, one gate.** REQUIREMENTS §8.3 budgets the *"default-import eager static
 * JavaScript closure"*, *"measured from a clean consumer build"* — so the gate is a namespace-import app
 * (`import * as media`), which no bundler can tree-shake. Two other figures are reported beside it and are
 * *expected* to differ by several KiB: a `import { probe }` app (the floor, since a single named import
 * lets the consumer shake everything else) and the whole-chunk static closure of the shipped
 * `dist/index.js` that `scripts/check-budgets.ts` gates on (the ceiling, since it sums whole chunk files
 * with no consumer DCE). Reporting all three together is deliberate: measuring the floor and calling it
 * the budget understates what a consumer pays, and the two tools disagreeing by ~5 KiB has already been
 * mistaken once for a regression.
 */

import { access, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { resolveLocalJsImport, staticLocalJsImports } from './bundle-graph.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const BUN = process.execPath;
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');
const EAGER_KERNEL_BUDGET = 50 * 1024;
const TYPICAL_APP_BUDGET = 250 * 1024;
const MIN_BUDGET_MARGIN = 512;
/**
 * Headroom below which the eager gate is reported as at-risk. The gate itself only fails *above* the
 * budget, which gives no warning until a release is already blocked — and the closure is currently within
 * a fraction of a KiB, so a single modest public export crosses it. One KiB is roughly the cost of one new
 * eagerly-reachable export plus what it drags in, so this fires while there is still time to choose.
 */
const MIN_EAGER_BUDGET_MARGIN = 1024;
const KEEP_TEMP = process.argv.includes('--keep-temp');
const REPORT_PATH = optionValue('--report');
const INSTALL_SPEC = optionValue('--install-spec') ?? optionValue('--package');
const TARBALL_PATH = optionValue('--tarball');
const SOURCE_LABEL = optionValue('--label');
const TEXT = new TextDecoder();

type PackageSourceKind = 'workspace-pack' | 'tarball' | 'install-spec';

type VerificationErrorCode =
  | 'precondition'
  | 'command-failed'
  | 'package-shape'
  | 'typecheck'
  | 'runtime-import'
  | 'bundle'
  | 'unexpected';

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface SizedFileReport {
  readonly file: string;
  readonly size: number;
}

/**
 * The three eager-closure figures, reported side by side so the difference between them is never
 * re-litigated from memory. They measure genuinely different subjects and are expected to differ:
 *
 *  - `namespaceEager` — **the §8.3 gate.** A clean consumer build of `import * as media from
 *    '@aibrush/media'`, i.e. the "default-import eager static JavaScript closure" the requirement names,
 *    measured by the method it specifies.
 *  - `probeOnlyEager` — the informational **floor**: an app importing the single name `probe`, so the
 *    consumer bundler shakes out every other export. Always ≤ the gate.
 *  - `shippedChunkClosure` — what `scripts/check-budgets.ts` reports: the whole-chunk static closure of
 *    the shipped `dist/index.js`, summed at **file** granularity with **no consumer DCE**. Always ≥ the
 *    gate, because a chunk is counted whole even where a consumer keeps only part of it.
 */
interface EagerClosureReport {
  readonly subject: 'namespace-import' | 'probe-only' | 'shipped-chunk-closure';
  readonly method: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly brotliBytes: number;
  readonly files: readonly SizedFileReport[];
}

interface BundleReport {
  readonly entryFile: string;
  readonly eagerBudgetBytes: number;
  readonly eagerJsBytes: number;
  readonly eagerGzipBytes: number;
  readonly eagerBrotliBytes: number;
  readonly eagerMarginBytes: number;
  /** The gated closure, the floor, and the un-shaken shipped closure (see {@link EagerClosureReport}). */
  readonly eagerClosures: readonly EagerClosureReport[];
  readonly probeOnlyEagerJsBytes: number;
  readonly shippedChunkClosureBytes: number;
  readonly eagerWorkerJsBytes: 0;
  readonly eagerWasmBytes: 0;
  readonly eagerCodecDataBytes: 0;
  readonly emittedJsBytes: number;
  readonly lazyJsBytes: number;
  readonly eagerJsFiles: readonly SizedFileReport[];
  readonly emittedJsFiles: readonly string[];
  readonly emittedJsFileDetails: readonly SizedFileReport[];
  readonly emittedWasmFiles: readonly string[];
  readonly emittedAssetFiles: readonly string[];
  readonly typicalMp4Probe: RouteBundleReport;
  readonly typicalMp4Remux: RouteBundleReport;
}

interface RouteBundleReport {
  readonly entryFile: string;
  readonly route: 'finite-faststart-mp4-probe' | 'default-blob-mp4-remux';
  readonly budgetBytes: number;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly brotliBytes: number;
  readonly marginBytes: number;
  readonly workerJsBytes: 0;
  readonly wasmBytes: 0;
  readonly codecDataBytes: 0;
  readonly seedFiles: readonly string[];
  readonly jsFiles: readonly SizedFileReport[];
  readonly runtimeCompletenessChecked: true;
}

interface ConsumerBundleGraph {
  readonly outDir: string;
  readonly entryFile: string;
  readonly jsFiles: readonly string[];
  readonly wasmFiles: readonly string[];
  readonly assetFiles: readonly string[];
  readonly jsText: ReadonlyMap<string, string>;
  readonly jsSizes: ReadonlyMap<string, number>;
  readonly metafile: Bun.BuildMetafile;
}

interface PackageSourceReport {
  readonly kind: PackageSourceKind;
  readonly label: string;
  readonly installTarget: string;
  readonly tarball?: string;
  readonly installSpec?: string;
}

interface VerificationReport {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageSource: PackageSourceReport;
  readonly installedPackageDir: string;
  readonly installedPackageRealPath: string;
  readonly workspaceRealPath: string;
  readonly exportsMapChecked: true;
  readonly declarationsChecked: true;
  readonly runtimeImportChecked: true;
  readonly bundle: BundleReport;
  readonly warnings: readonly string[];
}

interface PackageJsonShape extends Record<string, unknown> {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly sideEffects?: unknown;
  readonly types?: unknown;
  readonly module?: unknown;
  readonly exports?: unknown;
  readonly browser?: unknown;
}

interface ExportEntryShape extends Record<string, unknown> {
  readonly import?: unknown;
  readonly types?: unknown;
}

interface PackageSource {
  readonly kind: PackageSourceKind;
  readonly label: string;
  readonly tarball?: string;
  readonly installSpec?: string;
}

interface MaterializedPackageSource {
  readonly kind: PackageSourceKind;
  readonly label: string;
  readonly installTarget: string;
  readonly tarball?: string;
  readonly installSpec?: string;
}

interface InstalledPackageCheck {
  readonly name: string;
  readonly version: string;
  readonly concreteDriverSubpath?: string;
  readonly warnings: readonly string[];
}

class PackageVerificationError extends Error {
  readonly code: VerificationErrorCode;
  readonly detail: unknown;

  constructor(code: VerificationErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'PackageVerificationError';
    this.code = code;
    this.detail = detail;
  }
}

function optionValue(name: string): string | undefined {
  const exact = `${name}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg?.startsWith(exact)) return arg.slice(exact.length);
  }
  return undefined;
}

function fail(code: VerificationErrorCode, message: string, detail?: unknown): never {
  throw new PackageVerificationError(code, message, detail);
}

function assertCondition(
  condition: boolean,
  code: VerificationErrorCode,
  message: string,
  detail?: unknown,
): asserts condition {
  if (!condition) fail(code, message, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assertCondition(isRecord(value), 'package-shape', `${label} must be an object`, value);
  return value;
}

function expectString(value: unknown, label: string): string {
  assertCondition(typeof value === 'string', 'package-shape', `${label} must be a string`, value);
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertFile(path: string, message: string): Promise<void> {
  assertCondition(await exists(path), 'precondition', message, path);
}

function packageSourceFromArgs(): PackageSource {
  assertCondition(
    !(INSTALL_SPEC !== undefined && TARBALL_PATH !== undefined),
    'precondition',
    'use only one of --install-spec/--package or --tarball',
    { installSpec: INSTALL_SPEC, tarball: TARBALL_PATH },
  );
  if (INSTALL_SPEC !== undefined) {
    assertCondition(
      INSTALL_SPEC.trim().length > 0,
      'precondition',
      '--install-spec must not be empty',
    );
    return {
      kind: 'install-spec',
      label: SOURCE_LABEL ?? 'external-install-spec',
      installSpec: INSTALL_SPEC,
    };
  }
  if (TARBALL_PATH !== undefined) {
    assertCondition(TARBALL_PATH.trim().length > 0, 'precondition', '--tarball must not be empty');
    return {
      kind: 'tarball',
      label: SOURCE_LABEL ?? 'external-tarball',
      tarball: resolve(ROOT, TARBALL_PATH),
    };
  }
  return { kind: 'workspace-pack', label: SOURCE_LABEL ?? 'workspace-pack' };
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith('/');
}

function decode(bytes: Uint8Array | string | undefined): string {
  if (bytes === undefined) return '';
  if (typeof bytes === 'string') return bytes;
  return TEXT.decode(bytes);
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): CommandResult {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: [command, ...args],
      cwd,
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    fail('command-failed', `failed to start ${command}`, { command, args, cwd, error });
  }

  const stdout = decode(result.stdout);
  const stderr = decode(result.stderr);
  if (result.exitCode !== 0) {
    fail('command-failed', `${command} exited with ${result.exitCode}`, {
      command,
      args,
      cwd,
      stdout,
      stderr,
    });
  }
  return { stdout, stderr };
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = await Bun.file(path).json();
  return expectRecord(parsed, path);
}

async function packWorkspace(packDir: string): Promise<string> {
  const { stdout } = runCommand(
    BUN,
    ['pm', 'pack', '--destination', packDir, '--ignore-scripts', '--quiet'],
    ROOT,
  );
  const printedPath = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.endsWith('.tgz'));
  if (printedPath !== undefined) return resolve(ROOT, printedPath);

  const packed = (await readdir(packDir)).filter((file) => file.endsWith('.tgz')).sort();
  const tarball = packed.at(-1);
  assertCondition(tarball !== undefined, 'command-failed', 'bun pm pack did not produce a .tgz');
  return join(packDir, tarball);
}

async function materializePackageSource(
  source: PackageSource,
  packDir: string,
): Promise<MaterializedPackageSource> {
  switch (source.kind) {
    case 'workspace-pack': {
      const tarball = await packWorkspace(packDir);
      return {
        kind: source.kind,
        label: source.label,
        installTarget: tarball,
        tarball: basename(tarball),
      };
    }
    case 'tarball': {
      const tarball = expectString(source.tarball, 'tarball source path');
      await assertFile(tarball, `tarball ${tarball} is missing`);
      return {
        kind: source.kind,
        label: source.label,
        installTarget: tarball,
        tarball: basename(tarball),
      };
    }
    case 'install-spec': {
      const installSpec = expectString(source.installSpec, 'install spec');
      return {
        kind: source.kind,
        label: source.label,
        installTarget: installSpec,
        installSpec,
      };
    }
    default: {
      const unreachable: never = source.kind;
      return unreachable;
    }
  }
}

async function installPackage(
  appDir: string,
  installTarget: string,
  cacheDir: string,
): Promise<void> {
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  );
  runCommand(
    'npm',
    [
      'install',
      installTarget,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    appDir,
    {
      npm_config_cache: cacheDir,
      npm_config_update_notifier: 'false',
    },
  );
}

async function verifyInstalledPackage(installedDir: string): Promise<InstalledPackageCheck> {
  const pkg = (await readJsonRecord(join(installedDir, 'package.json'))) as PackageJsonShape;
  const name = expectString(pkg.name, 'package.json name');
  const version = expectString(pkg.version, 'package.json version');
  const warnings: string[] = [];
  assertCondition(
    name === '@aibrush/media',
    'package-shape',
    'installed package has wrong name',
    name,
  );
  assertCondition(pkg.sideEffects === false, 'package-shape', 'package sideEffects must be false');
  assertCondition(
    pkg.types === './dist/index.d.ts',
    'package-shape',
    'package types entry is wrong',
  );
  assertCondition(
    pkg.module === './dist/index.js',
    'package-shape',
    'package module entry is wrong',
  );

  const exportsMap = expectRecord(pkg.exports, 'package.json exports');
  await verifyExportEntry(installedDir, exportsMap, '.', './dist/index.js', './dist/index.d.ts');
  await verifyExportEntry(installedDir, exportsMap, './core', './dist/core.js', './dist/core.d.ts');
  await verifyExportEntry(
    installedDir,
    exportsMap,
    './image',
    './dist/image.js',
    './dist/image.d.ts',
  );
  await verifyExportEntry(installedDir, exportsMap, './wav', './dist/wav.js', './dist/wav.d.ts');
  const driversExport = expectRecord(
    exportsMap['./drivers/*'],
    'exports["./drivers/*"]',
  ) as ExportEntryShape;
  assertCondition(
    driversExport.import === './dist/drivers/*.js',
    'package-shape',
    'drivers wildcard import export is wrong',
    driversExport,
  );
  assertCondition(
    driversExport.types === './dist/drivers/*.d.ts',
    'package-shape',
    'drivers wildcard types export is wrong',
    driversExport,
  );
  const concreteDriverSubpath = await concreteDriverExportSubpath(installedDir, warnings);
  assertCondition(
    exportsMap['./package.json'] === './package.json',
    'package-shape',
    'package.json export is missing',
  );

  const browser = expectRecord(pkg.browser, 'package.json browser');
  for (const builtin of [
    'module',
    'node:module',
    'fs',
    'node:fs',
    'path',
    'node:path',
    'crypto',
    'os',
    'url',
    'worker_threads',
  ] as const) {
    assertCondition(
      browser[builtin] === false,
      'package-shape',
      `browser build must stub Node builtin '${builtin}'`,
      browser,
    );
  }

  return concreteDriverSubpath === undefined
    ? { name, version, warnings }
    : { name, version, concreteDriverSubpath, warnings };
}

async function concreteDriverExportSubpath(
  installedDir: string,
  warnings: string[],
): Promise<string | undefined> {
  const driversDir = join(installedDir, 'dist/drivers');
  if (!(await exists(driversDir))) {
    warnings.push(
      'package.json advertises exports["./drivers/*"], but the installed package has no dist/drivers/ directory; concrete driver subpath imports were not typechecked',
    );
    return undefined;
  }

  const jsFiles = (await collectFiles(driversDir)).filter((file) => file.endsWith('.js')).sort();
  if (jsFiles.length === 0) {
    warnings.push(
      'package.json advertises exports["./drivers/*"], but dist/drivers/ contains no JavaScript files; concrete driver subpath imports were not typechecked',
    );
    return undefined;
  }

  let withTypes: string | undefined;
  for (const file of jsFiles) {
    const dtsFile = `${file.slice(0, -'.js'.length)}.d.ts`;
    if (await Bun.file(join(driversDir, dtsFile)).exists()) {
      withTypes = file;
      break;
    }
  }
  if (withTypes === undefined) {
    warnings.push(
      'package.json advertises exports["./drivers/*"], but no dist/drivers/*.js file has a matching .d.ts declaration; concrete driver subpath imports were not typechecked',
    );
    return undefined;
  }

  return withTypes.slice(0, -'.js'.length);
}

async function verifyExportEntry(
  installedDir: string,
  exportsMap: Readonly<Record<string, unknown>>,
  key: string,
  expectedImport: string,
  expectedTypes: string,
): Promise<void> {
  const entry = expectRecord(exportsMap[key], `exports["${key}"]`) as ExportEntryShape;
  const importPath = expectString(entry.import, `exports["${key}"].import`);
  const typesPath = expectString(entry.types, `exports["${key}"].types`);
  assertCondition(
    importPath === expectedImport,
    'package-shape',
    `${key} import path changed`,
    entry,
  );
  assertCondition(typesPath === expectedTypes, 'package-shape', `${key} types path changed`, entry);
  await assertFile(join(installedDir, importPath), `${key} import file is missing`);
  await assertFile(join(installedDir, typesPath), `${key} declaration file is missing`);
}

async function writeConsumerSources(
  appDir: string,
  concreteDriverSubpath: string | undefined,
): Promise<{
  readonly probeEntry: string;
  readonly remuxEntry: string;
  readonly namespaceEntry: string;
  readonly typecheckConfig: string;
  readonly runtimeProbe: string;
}> {
  const probeEntry = join(appDir, 'probe-only.ts');
  const remuxEntry = join(appDir, 'remux-only.ts');
  const namespaceEntry = join(appDir, 'namespace-entry.ts');
  const typeProbe = join(appDir, 'types-probe.ts');
  const typecheckConfig = join(appDir, 'tsconfig.json');
  const runtimeProbe = join(appDir, 'runtime-probe.mjs');

  await writeFile(
    probeEntry,
    [
      "import { probe } from '@aibrush/media';",
      '',
      'export async function run(bytes: Uint8Array): Promise<number> {',
      '  const input = new Blob([bytes.slice().buffer], { type: "video/mp4" });',
      '  const info = await probe(input);',
      '  if (info.tracks.length === 0) throw new Error("MP4 probe returned no tracks");',
      '  return info.tracks.length;',
      '}',
      '',
    ].join('\n'),
  );

  await writeFile(
    remuxEntry,
    [
      "import { remux } from '@aibrush/media';",
      '',
      'export async function run(bytes: Uint8Array): Promise<number> {',
      '  const input = new Blob([bytes.slice().buffer], { type: "video/mp4" });',
      '  const output = await remux(input, { to: "mp4" });',
      '  if (!(output instanceof Blob)) throw new Error("default MP4 remux did not return a Blob");',
      '  const result = await output.arrayBuffer();',
      '  if (result.byteLength === 0) throw new Error("default MP4 remux returned an empty Blob");',
      '  return result.byteLength;',
      '}',
      '',
    ].join('\n'),
  );

  // The §8.3 subject: the **default-import** eager static closure. `probe-only.ts` above imports one
  // name, so a consumer bundler dead-code-eliminates the rest of the entry and measures a *floor*, not
  // the closure the requirement names. This seed imports the namespace and reads it through
  // `Object.keys`, which no bundler can shake — it cannot prove any export unused — so what survives is
  // exactly "what a consumer pays for `import … from '@aibrush/media'`", measured on §8.3's own method
  // (a clean consumer build). Keep both: the floor is useful, but the gate belongs on this one.
  await writeFile(
    namespaceEntry,
    [
      "import * as media from '@aibrush/media';",
      '',
      'export function run(): number {',
      '  const names = Object.keys(media);',
      '  if (names.length === 0) {',
      '    throw new Error("@aibrush/media namespace import exposed no exports");',
      '  }',
      '  return names.length;',
      '}',
      '',
    ].join('\n'),
  );

  await writeFile(
    runtimeProbe,
    [
      "import { MediaError, VERSION, probe } from '@aibrush/media';",
      '',
      ...(concreteDriverSubpath === undefined
        ? []
        : [
            `const concreteDriver = await import('@aibrush/media/drivers/${concreteDriverSubpath}');`,
            'if (typeof concreteDriver.default?.register !== "function") {',
            '  throw new Error("concrete driver default export is not a DriverModule");',
            '}',
            'if (typeof concreteDriver.default.apiVersion !== "number") {',
            '  throw new Error("concrete driver apiVersion is missing");',
            '}',
            '',
          ]),
      'if (typeof VERSION !== "string" || VERSION.length === 0) {',
      '  throw new Error("VERSION is not exported");',
      '}',
      'const handle = probe(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));',
      'if (typeof handle.cancel !== "function") {',
      '  throw new Error("probe did not return a cancellable promise");',
      '}',
      'try {',
      '  await handle;',
      '  throw new Error("probe unexpectedly accepted garbage bytes");',
      '} catch (error) {',
      '  if (!(error instanceof MediaError)) throw error;',
      '  console.info(`runtime typed error: ${error.code}`);',
      '}',
      '',
    ].join('\n'),
  );

  const concreteDriverImport =
    concreteDriverSubpath === undefined
      ? []
      : [
          `import concreteDriverModule from '@aibrush/media/drivers/${concreteDriverSubpath}';`,
          "import type { DriverModule } from '@aibrush/media/core';",
        ];
  const concreteDriverPins =
    concreteDriverSubpath === undefined
      ? []
      : ['const concreteDriver: DriverModule = concreteDriverModule;', 'void concreteDriver;'];

  await writeFile(
    typeProbe,
    [
      "import { createMedia, fromBytes, toBlob } from '@aibrush/media';",
      "import type { ConvertOptions, MediaEngine, MediaInfo, PacketInfoBatchStream, PacketInfoTable, PacketStreams } from '@aibrush/media';",
      "import { DRIVER_API_VERSION } from '@aibrush/media/core';",
      "import type { CodecDriver, ContainerDriver } from '@aibrush/media/core';",
      "import { IMAGE_FORMATS } from '@aibrush/media/image';",
      "import type { ImageFormat, ImageInfo } from '@aibrush/media/image';",
      ...concreteDriverImport,
      '',
      'const engine: MediaEngine = createMedia();',
      'const source = fromBytes(new Uint8Array([0]));',
      'const options: ConvertOptions = { to: "mp4", video: false, audio: false, sink: toBlob() };',
      'const formats: readonly ImageFormat[] = IMAGE_FORMATS;',
      'const apiVersion: number = DRIVER_API_VERSION;',
      'const streams: PacketStreams = {};',
      'type PublicPins = [MediaInfo, PacketInfoTable, PacketInfoBatchStream, CodecDriver, ContainerDriver, ImageInfo];',
      ...concreteDriverPins,
      '',
      'void engine;',
      'void source;',
      'void options;',
      'void formats;',
      'void apiVersion;',
      'void streams;',
      'type _KeepPublicPins = PublicPins;',
      '',
    ].join('\n'),
  );

  await writeFile(
    typecheckConfig,
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          skipLibCheck: false,
          noEmit: true,
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        },
        include: ['types-probe.ts'],
      },
      null,
      2,
    )}\n`,
  );

  return { probeEntry, remuxEntry, namespaceEntry, typecheckConfig, runtimeProbe };
}

function runTypecheck(typecheckConfig: string, appDir: string): void {
  runCommand(BUN, [TSC, '-p', typecheckConfig], appDir);
}

function runRuntimeImport(runtimeProbe: string, appDir: string): void {
  runCommand(BUN, [runtimeProbe], appDir);
}

async function buildConsumerBundle(entry: string, outDir: string): Promise<ConsumerBundleGraph> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: outDir,
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: true,
    sourcemap: 'none',
    metafile: true,
  });
  assertCondition(
    result.success,
    'bundle',
    `${basename(entry)} consumer browser bundle failed`,
    result.logs.map((log) => String(log)),
  );
  assertCondition(result.metafile !== undefined, 'bundle', 'consumer build emitted no metafile');

  const files = await collectFiles(outDir);
  const jsFiles = files.filter((file) => file.endsWith('.js')).sort();
  const wasmFiles = files.filter((file) => file.endsWith('.wasm')).sort();
  const assetFiles = files.filter((file) => !file.endsWith('.js')).sort();
  assertCondition(jsFiles.length > 0, 'bundle', `${basename(entry)} emitted no JavaScript`);
  assertCondition(
    wasmFiles.length === 0,
    'bundle',
    `${basename(entry)} installed bundle emitted WASM assets: ${wasmFiles.join(', ')}`,
    wasmFiles,
  );
  assertCondition(
    assetFiles.length === 0,
    'bundle',
    `${basename(entry)} native route bundle emitted non-JS assets: ${assetFiles.join(', ')}`,
    assetFiles,
  );

  const entryFile = `${basename(entry, '.ts')}.js`;
  assertCondition(jsFiles.includes(entryFile), 'bundle', `${entryFile} was not emitted`, jsFiles);
  const jsText = new Map<string, string>();
  const jsSizes = new Map<string, number>();
  for (const file of jsFiles) {
    const path = join(outDir, file);
    jsText.set(file, await Bun.file(path).text());
    jsSizes.set(file, (await stat(path)).size);
  }
  return {
    outDir,
    entryFile,
    jsFiles,
    wasmFiles,
    assetFiles,
    jsText,
    jsSizes,
    metafile: result.metafile,
  };
}

function outputRelativeFile(graph: ConsumerBundleGraph, outputPath: string): string | undefined {
  const candidate = relative(graph.outDir, resolve(outputPath)).replaceAll('\\', '/');
  if (graph.jsFiles.includes(candidate)) return candidate;
  const normalized = outputPath.replaceAll('\\', '/');
  return graph.jsFiles.find((file) => normalized === file || normalized.endsWith(`/${file}`));
}

function requireEntryOutput(
  graph: ConsumerBundleGraph,
  label: string,
  entryPointPattern: RegExp,
): string {
  const matches: string[] = [];
  for (const [outputPath, output] of Object.entries(graph.metafile.outputs)) {
    const entryPoint = output.entryPoint?.replaceAll('\\', '/');
    if (entryPoint === undefined || !entryPointPattern.test(entryPoint)) continue;
    const file = outputRelativeFile(graph, outputPath);
    if (file !== undefined) matches.push(file);
  }
  const uniqueMatches = [...new Set(matches)].sort();
  assertCondition(
    uniqueMatches.length === 1,
    'bundle',
    `${label} expected one emitted entry chunk, found ${uniqueMatches.length}`,
    { pattern: String(entryPointPattern), matches: uniqueMatches },
  );
  const match = uniqueMatches[0];
  assertCondition(match !== undefined, 'bundle', `${label} emitted entry chunk disappeared`);
  return match;
}

function unionStaticClosures(
  seedFiles: readonly string[],
  graph: ConsumerBundleGraph,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const seed of seedFiles) {
    for (const [file, size] of staticClosure(seed, graph.jsText, graph.jsSizes)) {
      result.set(file, size);
    }
  }
  return result;
}

function outputMetadata(
  graph: ConsumerBundleGraph,
  file: string,
): Bun.BuildMetafile['outputs'][string] | undefined {
  for (const [outputPath, output] of Object.entries(graph.metafile.outputs)) {
    if (outputRelativeFile(graph, outputPath) === file) return output;
  }
  return undefined;
}

function assertNoRouteInputLeaks(
  label: string,
  files: ReadonlyMap<string, number>,
  graph: ConsumerBundleGraph,
  forbidden: RegExp,
): void {
  const leaks: string[] = [];
  for (const file of files.keys()) {
    const output = outputMetadata(graph, file);
    assertCondition(output !== undefined, 'bundle', `metafile output is missing for ${file}`);
    const sources = [output.entryPoint, ...Object.keys(output.inputs)].filter(
      (source): source is string => source !== undefined,
    );
    for (const source of sources) {
      const normalized = source.replaceAll('\\', '/');
      if (forbidden.test(normalized)) leaks.push(`${normalized} via ${file}`);
    }
    const code = graph.jsText.get(file);
    assertCondition(code !== undefined, 'bundle', `missing JS text for ${file}`);
    if (/['"][^'"]+\.(?:wasm|bin|data|model|weights)(?:\?[^'"]*)?['"]/.test(code)) {
      leaks.push(`codec asset reference via ${file}`);
    }
  }
  assertCondition(
    leaks.length === 0,
    'bundle',
    `${label} contains heavy route leaks`,
    leaks.sort(),
  );
}

function compressedRouteSizes(
  files: ReadonlyMap<string, number>,
  graph: ConsumerBundleGraph,
): { readonly raw: number; readonly gzip: number; readonly brotli: number } {
  let raw = 0;
  let gzip = 0;
  let brotli = 0;
  for (const [file, size] of files) {
    const code = graph.jsText.get(file);
    assertCondition(code !== undefined, 'bundle', `missing JS text for ${file}`);
    const bytes = new TextEncoder().encode(code);
    raw += size;
    gzip += gzipSync(bytes).byteLength;
    brotli += brotliCompressSync(bytes).byteLength;
  }
  return { raw, gzip, brotli };
}

function assertTypicalRouteBudget(
  label: string,
  bytes: number,
  files: ReadonlyMap<string, number>,
) {
  assertCondition(
    bytes <= TYPICAL_APP_BUDGET,
    'bundle',
    `${label} ${fmt(bytes)} exceeds ${fmt(TYPICAL_APP_BUDGET)}`,
    fileDetails(files),
  );
  const margin = TYPICAL_APP_BUDGET - bytes;
  if (margin < MIN_BUDGET_MARGIN) {
    console.warn(
      `verify-package-install: ${label} has only ${fmt(
        margin,
      )} architecture headroom (recommended ${fmt(MIN_BUDGET_MARGIN)})`,
    );
  }
}

async function executePrunedRoute(
  graph: ConsumerBundleGraph,
  routeFiles: ReadonlyMap<string, number>,
  fixturePath: string,
): Promise<void> {
  for (const file of graph.jsFiles) {
    if (!routeFiles.has(file)) await rm(join(graph.outDir, file), { force: true });
  }
  for (const file of graph.assetFiles) await rm(join(graph.outDir, file), { force: true });
  const runner = join(graph.outDir, 'verify-route.mjs');
  const entryUrl = pathToFileURL(join(graph.outDir, graph.entryFile)).href;
  await writeFile(
    runner,
    [
      `import { run } from ${JSON.stringify(entryUrl)};`,
      `const bytes = new Uint8Array(await Bun.file(${JSON.stringify(fixturePath)}).arrayBuffer());`,
      'const result = await run(bytes);',
      'if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`invalid route result ${result}`);',
      '',
    ].join('\n'),
  );
  runCommand(BUN, [runner], graph.outDir);
}

function routeReport(
  route: RouteBundleReport['route'],
  seedFiles: readonly string[],
  files: ReadonlyMap<string, number>,
  graph: ConsumerBundleGraph,
): RouteBundleReport {
  const compressed = compressedRouteSizes(files, graph);
  const workerFiles = [...files.keys()].filter((file) =>
    /(?:^|\/)worker(?!-mode(?:-[A-Z0-9]+)?\.js$)[^/]*\.js$/.test(file),
  );
  assertCondition(
    workerFiles.length === 0,
    'bundle',
    `${route} contains worker JavaScript`,
    workerFiles,
  );
  assertTypicalRouteBudget(route, compressed.raw, files);
  return {
    entryFile: graph.entryFile,
    route,
    budgetBytes: TYPICAL_APP_BUDGET,
    rawBytes: compressed.raw,
    gzipBytes: compressed.gzip,
    brotliBytes: compressed.brotli,
    marginBytes: TYPICAL_APP_BUDGET - compressed.raw,
    workerJsBytes: 0,
    wasmBytes: 0,
    codecDataBytes: 0,
    seedFiles,
    jsFiles: fileDetails(files),
    runtimeCompletenessChecked: true,
  };
}

/**
 * The whole-chunk static closure of the **shipped** `dist/index.js` — the figure
 * `scripts/check-budgets.ts` gates on, recomputed here from the installed package so all three eager
 * numbers come from one run and one tree. No consumer bundler is involved, so nothing is shaken: a chunk
 * that `index.js` imports is counted whole even when a consumer would keep only part of it.
 */
async function measureShippedChunkClosure(installedDir: string): Promise<EagerClosureReport> {
  const distDir = join(installedDir, 'dist');
  const files = (await collectFiles(distDir)).filter((file) => file.endsWith('.js'));
  const jsText = new Map<string, string>();
  const jsSizes = new Map<string, number>();
  for (const file of files) {
    const path = join(distDir, file);
    jsText.set(file, await Bun.file(path).text());
    jsSizes.set(file, (await stat(path)).size);
  }
  assertCondition(jsText.has('index.js'), 'bundle', 'installed dist/index.js is missing');
  const closure = staticClosure('index.js', jsText, jsSizes);
  let raw = 0;
  let gzip = 0;
  let brotli = 0;
  for (const [file, size] of closure) {
    const bytes = new TextEncoder().encode(jsText.get(file) ?? '');
    raw += size;
    gzip += gzipSync(bytes).byteLength;
    brotli += brotliCompressSync(bytes).byteLength;
  }
  return {
    subject: 'shipped-chunk-closure',
    method: 'whole-chunk static closure of the shipped dist/index.js; no consumer bundler, no DCE',
    rawBytes: raw,
    gzipBytes: gzip,
    brotliBytes: brotli,
    files: fileDetails(closure),
  };
}

async function measureConsumerBundles(
  probeEntry: string,
  remuxEntry: string,
  namespaceEntry: string,
  outRoot: string,
  installedDir: string,
): Promise<BundleReport> {
  const probeGraph = await buildConsumerBundle(probeEntry, join(outRoot, 'probe'));
  const remuxGraph = await buildConsumerBundle(remuxEntry, join(outRoot, 'remux'));
  const namespaceGraph = await buildConsumerBundle(namespaceEntry, join(outRoot, 'namespace'));

  const probeSeeds = [
    probeGraph.entryFile,
    requireEntryOutput(probeGraph, 'probe runner', /\/dist\/probe-runner(?:-[^/]+)?\.js$/),
    requireEntryOutput(
      probeGraph,
      'probe range cache',
      /\/dist\/probe-range-cache(?:-[^/]+)?\.js$/,
    ),
    requireEntryOutput(
      probeGraph,
      'query-selective container registration',
      /\/dist\/default-container-registration(?:-[^/]+)?\.js$/,
    ),
    requireEntryOutput(
      probeGraph,
      'query-selective MP4 lazy driver',
      /\/dist\/mp4-lazy-driver(?:-[^/]+)?\.js$/,
    ),
    requireEntryOutput(
      probeGraph,
      'lightweight MP4 probe',
      /\/dist\/mp4-lazy-probe(?:-[^/]+)?\.js$/,
    ),
  ];
  const fullProbeFallback = requireEntryOutput(
    probeGraph,
    'full MP4 fallback',
    /\/dist\/drivers\/mp4\.js$/,
  );
  const typicalMp4ProbeFiles = unionStaticClosures(probeSeeds, probeGraph);
  assertCondition(
    !typicalMp4ProbeFiles.has(fullProbeFallback),
    'bundle',
    'finite faststart MP4 probe route includes the full MP4 fallback',
    fileDetails(typicalMp4ProbeFiles),
  );
  assertNoRouteInputLeaks(
    'finite faststart MP4 probe route',
    typicalMp4ProbeFiles,
    probeGraph,
    /\/dist\/(?:defaults|drivers\/mp4|(?:flac|wav)-lazy-driver|webcodecs-(?:audio|video)|wasm-[^/]+|(?:aac|dav1d|mp3|mp3-enc|opus|vorbis|vorbis-enc|vpx)-core|gpu-video|cpu-video|audio-dsp|image-driver|(?:audio-stream-plan|codec-pipeline|decrypt-runner|element-materialize|job-runner|live-convert|live-media|materialize|mux-packet-streams|mux-runner|preload|remux-runner|stream-target-materialize|trim-runner|video-frame-convert|video-stream-plan|worker(?!-mode(?:-[A-Z0-9]+)?\.js$)[^/]*))[^/]*\.js$/,
  );

  const remuxSeeds = [
    remuxGraph.entryFile,
    requireEntryOutput(remuxGraph, 'remux runner', /\/dist\/remux-runner(?:-[^/]+)?\.js$/),
    requireEntryOutput(
      remuxGraph,
      'query-selective container registration',
      /\/dist\/default-container-registration(?:-[^/]+)?\.js$/,
    ),
    requireEntryOutput(
      remuxGraph,
      'query-selective MP4 lazy driver',
      /\/dist\/mp4-lazy-driver(?:-[^/]+)?\.js$/,
    ),
    requireEntryOutput(remuxGraph, 'MP4 driver', /\/dist\/drivers\/mp4\.js$/),
    requireEntryOutput(
      remuxGraph,
      'default Blob materializer',
      /\/dist\/materialize(?:-[^/]+)?\.js$/,
    ),
  ];
  const typicalMp4RemuxFiles = unionStaticClosures(remuxSeeds, remuxGraph);
  assertNoRouteInputLeaks(
    'default Blob MP4 remux route',
    typicalMp4RemuxFiles,
    remuxGraph,
    /\/dist\/(?:defaults|drivers\/(?:webm|wav|mp3|ogg|adts|aiff|caf|mpegts|avi|flac)|(?:flac|wav)-lazy-driver|webcodecs-(?:audio|video)|wasm-[^/]+|(?:aac|dav1d|mp3|mp3-enc|opus|vorbis|vorbis-enc|vpx)-core|gpu-video|cpu-video|audio-dsp|image-driver|(?:audio-stream-plan|codec-pipeline|decrypt-runner|element-materialize|job-runner|live-convert|live-media|mux-packet-streams|mux-runner|preload|probe-runner|remux-metadata|stream-target-materialize|trim-runner|video-frame-convert|video-stream-plan|worker(?!-mode(?:-[A-Z0-9]+)?\.js$)[^/]*))[^/]*\.js$/,
  );

  const typicalMp4Probe = routeReport(
    'finite-faststart-mp4-probe',
    probeSeeds,
    typicalMp4ProbeFiles,
    probeGraph,
  );
  const typicalMp4Remux = routeReport(
    'default-blob-mp4-remux',
    remuxSeeds,
    typicalMp4RemuxFiles,
    remuxGraph,
  );

  const fixturePath = join(ROOT, 'fixtures/media/movie_5.mp4');
  await assertFile(fixturePath, 'representative faststart MP4 fixture is missing');
  await executePrunedRoute(probeGraph, typicalMp4ProbeFiles, fixturePath);
  await executePrunedRoute(remuxGraph, typicalMp4RemuxFiles, fixturePath);

  const eagerClosure = staticClosure(probeGraph.entryFile, probeGraph.jsText, probeGraph.jsSizes);
  const eagerCompressed = compressedRouteSizes(eagerClosure, probeGraph);
  const eagerWorkerFiles = [...eagerClosure.keys()].filter((file) =>
    /(?:^|\/)worker(?!-mode(?:-[A-Z0-9]+)?\.js$)[^/]*\.js$/.test(file),
  );
  assertCondition(
    eagerWorkerFiles.length === 0,
    'bundle',
    'probe-only eager closure contains worker JavaScript',
    eagerWorkerFiles,
  );
  const probeOnlyEagerJsBytes = [...eagerClosure.values()].reduce((sum, size) => sum + size, 0);
  const emittedJsBytes = [...probeGraph.jsSizes.values()].reduce((sum, size) => sum + size, 0);
  const emittedJsFileDetails = fileDetails(probeGraph.jsSizes);

  // The gated subject: what a consumer pays for `import … from '@aibrush/media'` (REQUIREMENTS §8.3,
  // "Default-import eager static JavaScript closure ≤ 50 KiB", "measured from a clean consumer build").
  const namespaceClosure = staticClosure(
    namespaceGraph.entryFile,
    namespaceGraph.jsText,
    namespaceGraph.jsSizes,
  );
  const namespaceCompressed = compressedRouteSizes(namespaceClosure, namespaceGraph);
  const eagerJsBytes = [...namespaceClosure.values()].reduce((sum, size) => sum + size, 0);
  const eagerJsFiles = fileDetails(namespaceClosure);
  const namespaceWorkerFiles = [...namespaceClosure.keys()].filter((file) =>
    /(?:^|\/)worker(?!-mode(?:-[A-Z0-9]+)?\.js$)[^/]*\.js$/.test(file),
  );
  assertCondition(
    namespaceWorkerFiles.length === 0,
    'bundle',
    'default-import eager closure contains worker JavaScript',
    namespaceWorkerFiles,
  );
  // A single-name import can never pull more than the whole namespace; if it does, one of the two
  // measurements is wrong and neither number can be trusted.
  assertCondition(
    probeOnlyEagerJsBytes <= eagerJsBytes,
    'bundle',
    `probe-only floor ${fmt(probeOnlyEagerJsBytes)} exceeds the default-import closure ${fmt(
      eagerJsBytes,
    )}; the two eager measurements disagree`,
    { probeOnlyEagerJsBytes, eagerJsBytes },
  );

  const shippedClosure = await measureShippedChunkClosure(installedDir);
  const eagerClosures: readonly EagerClosureReport[] = [
    {
      subject: 'namespace-import',
      method: "clean consumer build of `import * as media from '@aibrush/media'` (the §8.3 gate)",
      rawBytes: eagerJsBytes,
      gzipBytes: namespaceCompressed.gzip,
      brotliBytes: namespaceCompressed.brotli,
      files: eagerJsFiles,
    },
    {
      subject: 'probe-only',
      method: 'clean consumer build of `import { probe }` — informational floor, not the gate',
      rawBytes: probeOnlyEagerJsBytes,
      gzipBytes: eagerCompressed.gzip,
      brotliBytes: eagerCompressed.brotli,
      files: fileDetails(eagerClosure),
    },
    shippedClosure,
  ];

  assertCondition(
    eagerJsBytes <= EAGER_KERNEL_BUDGET,
    'bundle',
    `default-import eager JS closure ${fmt(eagerJsBytes)} exceeds ${fmt(
      EAGER_KERNEL_BUDGET,
    )} (REQUIREMENTS §8.3). This is a real budget breach, not a measurement artifact: raising the budget requires architecture review and benchmark evidence, not a new number.`,
    eagerJsFiles,
  );
  const eagerMargin = EAGER_KERNEL_BUDGET - eagerJsBytes;
  if (eagerMargin < MIN_EAGER_BUDGET_MARGIN) {
    // Loud on purpose: passing at 99 % of budget looks identical to passing comfortably in a CI log, and
    // the person who breaches it will be whoever adds the next export — not whoever spent the headroom.
    console.warn(
      `verify-package-install: !! default-import eager closure has only ${fmt(
        eagerMargin,
      )} headroom (${fmt(eagerJsBytes)} of ${fmt(
        EAGER_KERNEL_BUDGET,
      )}, ${((eagerJsBytes / EAGER_KERNEL_BUDGET) * 100).toFixed(2)}% used; recommended headroom ${fmt(
        MIN_EAGER_BUDGET_MARGIN,
      )}). The next eagerly-reachable public export is likely to breach REQUIREMENTS §8.3 — reclaim space before adding one.`,
    );
  }

  return {
    entryFile: probeGraph.entryFile,
    eagerBudgetBytes: EAGER_KERNEL_BUDGET,
    eagerJsBytes,
    eagerGzipBytes: namespaceCompressed.gzip,
    eagerBrotliBytes: namespaceCompressed.brotli,
    eagerMarginBytes: EAGER_KERNEL_BUDGET - eagerJsBytes,
    eagerClosures,
    probeOnlyEagerJsBytes,
    shippedChunkClosureBytes: shippedClosure.rawBytes,
    eagerWorkerJsBytes: 0,
    eagerWasmBytes: 0,
    eagerCodecDataBytes: 0,
    emittedJsBytes,
    // `emittedJsBytes` is the probe app's whole output, so the lazy remainder is measured against the
    // probe app's own eager closure — mixing in the namespace figure would subtract across two bundles.
    lazyJsBytes: emittedJsBytes - probeOnlyEagerJsBytes,
    eagerJsFiles,
    emittedJsFiles: probeGraph.jsFiles,
    emittedJsFileDetails,
    emittedWasmFiles: probeGraph.wasmFiles,
    emittedAssetFiles: probeGraph.assetFiles,
    typicalMp4Probe,
    typicalMp4Remux,
  };
}

function fileDetails(files: ReadonlyMap<string, number>): SizedFileReport[] {
  return [...files]
    .map(([file, size]) => ({ file, size }))
    .sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
}

async function collectFiles(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectFiles(path, base)));
    } else if (entry.isFile()) {
      found.push(relative(base, path).replaceAll('\\', '/'));
    }
  }
  return found.sort();
}

function staticClosure(
  entryFile: string,
  jsText: ReadonlyMap<string, string>,
  jsSizes: ReadonlyMap<string, number>,
): Map<string, number> {
  const closure = new Map<string, number>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || closure.has(file)) continue;
    const code = jsText.get(file);
    const size = jsSizes.get(file);
    assertCondition(code !== undefined && size !== undefined, 'bundle', `missing JS chunk ${file}`);
    closure.set(file, size);
    for (const spec of staticLocalJsImports(code)) {
      const target = resolveLocalJsImport(file, spec);
      assertCondition(
        !target.startsWith('../'),
        'bundle',
        `${file} imports outside bundle: ${spec}`,
      );
      queue.push(target);
    }
  }
  return closure;
}

function fmt(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const source = packageSourceFromArgs();
  if (source.kind === 'workspace-pack') {
    await assertFile(
      join(ROOT, 'dist/index.js'),
      'dist/index.js is missing; run `bun run build` first',
    );
    await assertFile(
      join(ROOT, 'dist/index.d.ts'),
      'dist/index.d.ts is missing; run `bun run build` first',
    );
  }
  await assertFile(TSC, 'TypeScript is not installed; run `bun install` first');

  const tmpRoot = await mkdtemp(join(tmpdir(), 'aibrush-package-'));
  const workspaceRealPath = await realpath(ROOT);
  try {
    const packDir = join(tmpRoot, 'pack');
    const appDir = join(tmpRoot, 'app');
    const cacheDir = join(tmpRoot, 'npm-cache');
    const bundleDir = join(tmpRoot, 'consumer-bundles');
    await mkdir(packDir, { recursive: true });
    await mkdir(appDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });

    const materializedSource = await materializePackageSource(source, packDir);
    await installPackage(appDir, materializedSource.installTarget, cacheDir);
    const installedDir = join(appDir, 'node_modules/@aibrush/media');
    const installedPackageRealPath = await realpath(installedDir);
    assertCondition(
      installedPackageRealPath !== workspaceRealPath &&
        !isPathInside(installedPackageRealPath, workspaceRealPath),
      'package-shape',
      'installed package resolved to the workspace instead of a clean consumer install',
      { installedPackageRealPath, workspaceRealPath },
    );
    const pkg = await verifyInstalledPackage(installedDir);
    const sources = await writeConsumerSources(appDir, pkg.concreteDriverSubpath);
    runTypecheck(sources.typecheckConfig, appDir);
    runRuntimeImport(sources.runtimeProbe, appDir);
    const bundle = await measureConsumerBundles(
      sources.probeEntry,
      sources.remuxEntry,
      sources.namespaceEntry,
      bundleDir,
      installedDir,
    );

    const report: VerificationReport = {
      packageName: pkg.name,
      packageVersion: pkg.version,
      packageSource: {
        kind: materializedSource.kind,
        label: materializedSource.label,
        installTarget: materializedSource.installTarget,
        ...(materializedSource.tarball !== undefined
          ? { tarball: materializedSource.tarball }
          : {}),
        ...(materializedSource.installSpec !== undefined
          ? { installSpec: materializedSource.installSpec }
          : {}),
      },
      installedPackageDir: installedDir,
      installedPackageRealPath,
      workspaceRealPath,
      exportsMapChecked: true,
      declarationsChecked: true,
      runtimeImportChecked: true,
      bundle,
      warnings: pkg.warnings,
    };

    if (REPORT_PATH !== undefined) {
      const reportPath = resolve(ROOT, REPORT_PATH);
      await mkdir(dirname(reportPath), { recursive: true });
      await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }

    console.info(
      `verify-package-install: source ${report.packageSource.label} (${report.packageSource.kind})`,
    );
    if (report.packageSource.tarball !== undefined) {
      console.info(`verify-package-install: packed ${report.packageSource.tarball}`);
    }
    if (report.packageSource.installSpec !== undefined) {
      console.info(`verify-package-install: installed spec ${report.packageSource.installSpec}`);
    }
    console.info(
      `verify-package-install: installed package ${report.installedPackageRealPath} (workspace ${report.workspaceRealPath})`,
    );
    console.info('verify-package-install: clean npm install + public runtime import passed');
    console.info('verify-package-install: export map and declarations passed TypeScript');
    console.info(
      `verify-package-install: default-import eager JS ${fmt(bundle.eagerJsBytes)} / ${fmt(
        bundle.eagerBudgetBytes,
      )} (margin ${fmt(bundle.eagerMarginBytes)}); gzip ${fmt(
        bundle.eagerGzipBytes,
      )}; Brotli ${fmt(bundle.eagerBrotliBytes)}; eager worker/WASM/codec data 0/0/0 bytes`,
    );
    // All three eager figures together, so the ~5 KiB they differ by is never mistaken for a regression
    // again. They measure different subjects; only the first is the §8.3 gate.
    console.info('verify-package-install: eager closure by subject (only the first is gated):');
    for (const closure of bundle.eagerClosures) {
      console.info(
        `  ${fmt(closure.rawBytes).padStart(10)}  ${closure.subject.padEnd(21)} gzip ${fmt(
          closure.gzipBytes,
        )}; ${closure.method}`,
      );
    }
    console.info(
      `verify-package-install: probe-only app emitted JS ${fmt(
        bundle.emittedJsBytes,
      )} including lazy ${fmt(bundle.lazyJsBytes)}`,
    );
    for (const route of [bundle.typicalMp4Probe, bundle.typicalMp4Remux]) {
      console.info(
        `verify-package-install: ${route.route} JS raw ${fmt(route.rawBytes)} / ${fmt(
          route.budgetBytes,
        )} (margin ${fmt(route.marginBytes)}); gzip ${fmt(route.gzipBytes)}; Brotli ${fmt(
          route.brotliBytes,
        )}; worker/WASM/codec data ${route.workerJsBytes}/${route.wasmBytes}/${
          route.codecDataBytes
        } bytes`,
      );
      console.info(`verify-package-install: ${route.route} seeds ${route.seedFiles.join(', ')}`);
      for (const file of route.jsFiles.slice(0, 12)) {
        console.info(`  ${fmt(file.size).padStart(10)}  ${file.file}`);
      }
    }
    for (const warning of report.warnings)
      console.warn(`verify-package-install: warning: ${warning}`);
    console.info(
      report.warnings.length === 0
        ? 'verify-package-install: all checks passed'
        : `verify-package-install: all checks passed with ${report.warnings.length} warning(s)`,
    );
    if (KEEP_TEMP) console.info(`verify-package-install: kept temp dir ${tmpRoot}`);
  } finally {
    if (!KEEP_TEMP) await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const err =
    error instanceof PackageVerificationError
      ? error
      : new PackageVerificationError('unexpected', errorMessage(error), error);
  console.error(`verify-package-install: ${err.code}: ${err.message}`);
  if (err.detail !== undefined) console.error(err.detail);
  process.exit(1);
});
