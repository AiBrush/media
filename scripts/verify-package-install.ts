#!/usr/bin/env bun
/**
 * Verify the package as a clean consumer sees it: pack the current workspace, install that tarball into a
 * fresh app, typecheck public export-map imports, run a package-name import, and measure a tree-shaken
 * probe-only browser bundle. This is intentionally downstream of `bun run build && bun run vendor-wasm`:
 * the packed artifact must contain the same `dist/` a publisher would ship.
 */

import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BUN = process.execPath;
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');
const EAGER_KERNEL_BUDGET = 50 * 1024;
const KEEP_TEMP = process.argv.includes('--keep-temp');
const REPORT_PATH = optionValue('--report');
const TEXT = new TextDecoder();

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

interface BundleReport {
  readonly entryFile: string;
  readonly eagerJsBytes: number;
  readonly emittedJsBytes: number;
  readonly emittedJsFiles: readonly string[];
  readonly emittedWasmFiles: readonly string[];
}

interface VerificationReport {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly tarball: string;
  readonly exportsMapChecked: true;
  readonly declarationsChecked: true;
  readonly runtimeImportChecked: true;
  readonly bundle: BundleReport;
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

async function installPackedPackage(
  appDir: string,
  tarball: string,
  cacheDir: string,
): Promise<void> {
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  );
  runCommand(
    'npm',
    ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
    appDir,
    {
      npm_config_cache: cacheDir,
      npm_config_update_notifier: 'false',
    },
  );
}

async function verifyInstalledPackage(installedDir: string): Promise<{
  readonly name: string;
  readonly version: string;
}> {
  const pkg = (await readJsonRecord(join(installedDir, 'package.json'))) as PackageJsonShape;
  const name = expectString(pkg.name, 'package.json name');
  const version = expectString(pkg.version, 'package.json version');
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

  return { name, version };
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

async function writeConsumerSources(appDir: string): Promise<{
  readonly probeEntry: string;
  readonly typecheckConfig: string;
  readonly runtimeProbe: string;
}> {
  const probeEntry = join(appDir, 'probe-only.ts');
  const typeProbe = join(appDir, 'types-probe.ts');
  const typecheckConfig = join(appDir, 'tsconfig.json');
  const runtimeProbe = join(appDir, 'runtime-probe.mjs');

  await writeFile(
    probeEntry,
    [
      "import { MediaError, probe } from '@aibrush/media';",
      '',
      'try {',
      '  await probe(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));',
      '} catch (error) {',
      '  if (!(error instanceof MediaError)) throw error;',
      '  console.info(error.code);',
      '}',
      '',
    ].join('\n'),
  );

  await writeFile(
    runtimeProbe,
    [
      "import { MediaError, VERSION, probe } from '@aibrush/media';",
      '',
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

  await writeFile(
    typeProbe,
    [
      "import { createMedia, fromBytes, toBlob } from '@aibrush/media';",
      "import type { ConvertOptions, MediaEngine, MediaInfo, PacketStreams } from '@aibrush/media';",
      "import { DRIVER_API_VERSION } from '@aibrush/media/core';",
      "import type { CodecDriver, ContainerDriver } from '@aibrush/media/core';",
      "import { IMAGE_FORMATS } from '@aibrush/media/image';",
      "import type { ImageFormat, ImageInfo } from '@aibrush/media/image';",
      '',
      'const engine: MediaEngine = createMedia();',
      'const source = fromBytes(new Uint8Array([0]));',
      'const options: ConvertOptions = { to: "mp4", video: false, audio: false, sink: toBlob() };',
      'const formats: readonly ImageFormat[] = IMAGE_FORMATS;',
      'const apiVersion: number = DRIVER_API_VERSION;',
      'const streams: PacketStreams = {};',
      'type PublicPins = [MediaInfo, CodecDriver, ContainerDriver, ImageInfo];',
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

  return { probeEntry, typecheckConfig, runtimeProbe };
}

function runTypecheck(typecheckConfig: string, appDir: string): void {
  runCommand(BUN, [TSC, '-p', typecheckConfig], appDir);
}

function runRuntimeImport(runtimeProbe: string, appDir: string): void {
  runCommand(BUN, [runtimeProbe], appDir);
}

async function measureProbeBundle(probeEntry: string, outDir: string): Promise<BundleReport> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [probeEntry],
    outdir: outDir,
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: true,
    sourcemap: 'none',
  });
  assertCondition(
    result.success,
    'bundle',
    'probe-only consumer browser bundle failed',
    result.logs.map((log) => String(log)),
  );

  const files = await collectFiles(outDir);
  const jsFiles = files.filter((file) => file.endsWith('.js')).sort();
  const wasmFiles = files.filter((file) => file.endsWith('.wasm')).sort();
  assertCondition(jsFiles.length > 0, 'bundle', 'probe-only bundle emitted no JavaScript');
  assertCondition(
    wasmFiles.length === 0,
    'bundle',
    `probe-only installed bundle emitted WASM assets: ${wasmFiles.join(', ')}`,
    wasmFiles,
  );

  const entryFile = 'probe-only.js';
  assertCondition(
    jsFiles.includes(entryFile),
    'bundle',
    'probe-only entry file was not emitted',
    jsFiles,
  );
  const jsText = new Map<string, string>();
  const jsSizes = new Map<string, number>();
  for (const file of jsFiles) {
    const path = join(outDir, file);
    jsText.set(file, await Bun.file(path).text());
    jsSizes.set(file, (await stat(path)).size);
  }
  const eagerClosure = staticClosure(entryFile, jsText, jsSizes);
  const eagerJsBytes = [...eagerClosure.values()].reduce((sum, size) => sum + size, 0);
  const emittedJsBytes = [...jsSizes.values()].reduce((sum, size) => sum + size, 0);
  assertCondition(
    eagerJsBytes <= EAGER_KERNEL_BUDGET,
    'bundle',
    `probe-only eager JS closure ${(eagerJsBytes / 1024).toFixed(2)} kB exceeds 50.00 kB`,
    [...eagerClosure.keys()].sort(),
  );

  return {
    entryFile,
    eagerJsBytes,
    emittedJsBytes,
    emittedJsFiles: jsFiles,
    emittedWasmFiles: wasmFiles,
  };
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
    for (const spec of staticLocalJsImports(code)) queue.push(spec);
  }
  return closure;
}

function staticLocalJsImports(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /(?:^|[\s;])(?:import|export)\b[^'"]*?\bfrom\s*['"](\.\/[^'"]+\.js)['"]/g;
  for (const match of code.matchAll(fromRe)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec.replace(/^\.\//, ''));
  }
  const bareRe = /(?:^|[\s;])import\s*['"](\.\/[^'"]+\.js)['"]/g;
  for (const match of code.matchAll(bareRe)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec.replace(/^\.\//, ''));
  }
  return [...new Set(specs)].sort();
}

function fmt(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  await assertFile(
    join(ROOT, 'dist/index.js'),
    'dist/index.js is missing; run `bun run build` first',
  );
  await assertFile(
    join(ROOT, 'dist/index.d.ts'),
    'dist/index.d.ts is missing; run `bun run build` first',
  );
  await assertFile(TSC, 'TypeScript is not installed; run `bun install` first');

  const tmpRoot = await mkdtemp(join(tmpdir(), 'aibrush-package-'));
  try {
    const packDir = join(tmpRoot, 'pack');
    const appDir = join(tmpRoot, 'app');
    const cacheDir = join(tmpRoot, 'npm-cache');
    const bundleDir = join(tmpRoot, 'probe-bundle');
    await mkdir(packDir, { recursive: true });
    await mkdir(appDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });

    const tarball = await packWorkspace(packDir);
    await installPackedPackage(appDir, tarball, cacheDir);
    const installedDir = join(appDir, 'node_modules/@aibrush/media');
    const pkg = await verifyInstalledPackage(installedDir);
    const sources = await writeConsumerSources(appDir);
    runTypecheck(sources.typecheckConfig, appDir);
    runRuntimeImport(sources.runtimeProbe, appDir);
    const bundle = await measureProbeBundle(sources.probeEntry, bundleDir);

    const report: VerificationReport = {
      packageName: pkg.name,
      packageVersion: pkg.version,
      tarball: basename(tarball),
      exportsMapChecked: true,
      declarationsChecked: true,
      runtimeImportChecked: true,
      bundle,
    };

    if (REPORT_PATH !== undefined) {
      const reportPath = resolve(ROOT, REPORT_PATH);
      await mkdir(dirname(reportPath), { recursive: true });
      await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }

    console.info(`verify-package-install: packed ${report.tarball}`);
    console.info('verify-package-install: clean npm install + public runtime import passed');
    console.info('verify-package-install: export map and declarations passed TypeScript');
    console.info(
      `verify-package-install: probe-only eager JS ${fmt(bundle.eagerJsBytes)}; emitted lazy JS ${fmt(
        bundle.emittedJsBytes,
      )}; emitted WASM ${bundle.emittedWasmFiles.length}`,
    );
    console.info('verify-package-install: all checks passed');
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
