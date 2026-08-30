#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const TYPESCRIPT_CLI = join(ROOT, 'node_modules/typescript/bin/tsc');

// These names are part of the package's public export map. Keep the worker flattened as dist/worker.js:
// worker-host resolves it at runtime with new URL('./worker.js', import.meta.url).
const DRIVER_ENTRIES = {
  adts: 'src/drivers/adts/adts-driver.ts',
  aiff: 'src/drivers/aiff/aiff-driver.ts',
  avi: 'src/drivers/avi/avi-driver.ts',
  caf: 'src/drivers/caf/caf-driver.ts',
  flac: 'src/drivers/flac/flac-driver.ts',
  hls: 'src/drivers/hls/hls-driver.ts',
  mp3: 'src/drivers/mp3/mp3-driver.ts',
  mp4: 'src/drivers/mp4/mp4-driver.ts',
  mpegts: 'src/drivers/mpegts/mpegts-driver.ts',
  ogg: 'src/drivers/ogg/ogg-driver.ts',
  wav: 'src/drivers/wav/wav-driver.ts',
  webm: 'src/drivers/webm/webm-driver.ts',
};

const ENTRY_POINTS = {
  index: 'src/index.ts',
  core: 'src/core.ts',
  image: 'src/image.ts',
  worker: 'src/kernel/worker.ts',
  ...Object.fromEntries(
    Object.entries(DRIVER_ENTRIES).map(([name, source]) => [`drivers/${name}`, source]),
  ),
};

// Vendored Emscripten glue contains Node-only branches that are dead in browsers but still mention these
// built-ins. Leaving them external preserves those branches without trying to bundle Node implementations.
const EXTERNAL_NODE_MODULES = [
  'node:*',
  'fs',
  'path',
  'crypto',
  'os',
  'module',
  'url',
  'worker_threads',
  'node:fs',
  'node:path',
];

const TYPESCRIPT_EXTENSION = /(['"])(\.\.?\/[^'"\r\n]+)\.(mts|cts|tsx|ts)\1/g;
const RUNTIME_EXTENSIONS = {
  mts: 'mjs',
  cts: 'cjs',
  tsx: 'js',
  ts: 'js',
};
const DISPOSABLE_LIB_REFERENCE = '/// <reference lib="esnext.disposable" />\n';

async function bundleJavaScript() {
  // TypeScript deliberately does not bundle. esbuild owns only the ESM transformation, splitting,
  // minification, and source maps; TypeScript 7 remains the checker and declaration emitter below.
  await build({
    absWorkingDir: ROOT,
    entryPoints: ENTRY_POINTS,
    outdir: DIST,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    external: EXTERNAL_NODE_MODULES,
    splitting: true,
    treeShaking: true,
    minify: true,
    sourcemap: 'external',
    entryNames: '[dir]/[name]',
    chunkNames: '[name]-[hash]',
    logLevel: 'info',
  });

  // `@aibrush/media/wav` is the startup-sensitive, short-lived-worker surface. Build it as one small
  // self-contained module instead of making consumers pay several shared-chunk request/evaluation hops.
  // The full engine/core/driver graph above remains split normally; only this deliberately narrow
  // synchronous envelope utility duplicates its few kilobytes.
  await build({
    absWorkingDir: ROOT,
    entryPoints: { wav: 'src/wav.ts' },
    outdir: DIST,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    external: EXTERNAL_NODE_MODULES,
    splitting: false,
    treeShaking: true,
    minify: true,
    sourcemap: 'external',
    entryNames: '[name]',
    logLevel: 'info',
  });

  // MP4/MOV packet-table consumers are also startup-sensitive. Keep this narrow public surface in
  // one request so they do not evaluate the complete multi-container/core graph just to inspect
  // packet metadata. It reuses the canonical implementation and only duplicates the reachable code.
  await build({
    absWorkingDir: ROOT,
    entryPoints: { 'mp4-packet-info': 'src/mp4-packet-info.ts' },
    outdir: DIST,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    external: EXTERNAL_NODE_MODULES,
    splitting: false,
    treeShaking: true,
    minify: true,
    sourcemap: 'external',
    entryNames: '[name]',
    logLevel: 'info',
  });
}

async function emitDeclarations() {
  // TypeScript 7 has no supported JavaScript compiler API, so invoke its CLI as a subprocess instead of
  // importing `typescript` from this build process.
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [TYPESCRIPT_CLI, '--project', join(ROOT, 'tsconfig.json'), '--noEmit', 'false'],
      {
        cwd: ROOT,
        stdio: 'inherit',
      },
    );

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const reason = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      reject(new Error(`TypeScript declaration emission failed with ${reason}`));
    });
  });
}

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return declarationFiles(path);
      return entry.isFile() && entry.name.endsWith('.d.ts') ? [path] : [];
    }),
  );
  return nestedFiles.flat();
}

async function rewriteDeclarationSpecifiers() {
  // Source imports intentionally use explicit .ts extensions. Published declarations must point at the
  // emitted .js modules, and any declaration exposing Symbol.asyncDispose must request its standard lib.
  const files = await declarationFiles(DIST);
  await Promise.all(
    files.map(async (path) => {
      const declaration = await readFile(path, 'utf8');
      let publishable = declaration.replace(
        TYPESCRIPT_EXTENSION,
        (_match, quote, specifier, extension) =>
          `${quote}${specifier}.${RUNTIME_EXTENSIONS[extension]}${quote}`,
      );
      if (publishable.includes('Symbol.asyncDispose')) {
        publishable = `${DISPOSABLE_LIB_REFERENCE}${publishable}`;
      }
      if (publishable !== declaration) await writeFile(path, publishable);
    }),
  );
}

async function writeDeclarationEntries() {
  // TypeScript mirrors source directories, while the export map exposes flattened driver subpaths. These
  // tiny declaration shims make the declaration layout match the JavaScript entry layout.
  await Promise.all(
    Object.keys(DRIVER_ENTRIES).map(async (name) => {
      const path = join(DIST, 'drivers', `${name}.d.ts`);
      const source = `./${name}/${name}-driver.js`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `export { default } from '${source}';\nexport * from '${source}';\n`);
    }),
  );

  await writeFile(join(DIST, 'worker.d.ts'), "export * from './kernel/worker.js';\n");
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

await bundleJavaScript();
await emitDeclarations();
await rewriteDeclarationSpecifiers();
await writeDeclarationEntries();

// Co-vendor WASM tails so a single `bun run build` emits a complete dist/ including same-origin
// `*_wasm_bg.wasm` assets. esbuild does not copy `new URL('./...wasm', import.meta.url)` assets, so
// without this the check-budget WASM assertion would fail and browsers would 404 on codec miss paths.
// This mirrors `scripts/vendor-wasm.ts` discover+copy but runs inline to close the esbuild gap (todo 0.6).
await (async function vendorWasmIntoDist() {
  const { readdir: readdirFs } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const codecsDir = join(ROOT, 'src/codecs');
  const entries = await readdirFs(codecsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('wasm-')) continue;
    const dir = joinPath(codecsDir, entry.name);
    const files = await readdirFs(dir).catch(() => []);
    const wasmName = files.find((f) => f.endsWith('_wasm_bg.wasm'));
    const glueName = files.find((f) => f.endsWith('-core.js'));
    // Self-contained tails have glue+carrier but NO external wasm; any tail with an external
    // `*_wasm_bg.wasm` must be co-vendored regardless of whether it also ships a helper carrier
    // (wasm-av1 has dav1d-wasm.js alongside dav1d_wasm_bg.wasm). Only skip when wasm is absent.
    if (wasmName && glueName) {
      const wasmBytes = await readFile(joinPath(dir, wasmName));
      const glueBytes = await readFile(joinPath(dir, glueName));
      await writeFile(joinPath(DIST, wasmName), wasmBytes);
      await writeFile(joinPath(DIST, glueName), glueBytes);
    }
  }
})();

console.log('Built ESM bundles with esbuild and declarations with TypeScript 7.');
