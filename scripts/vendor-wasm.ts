#!/usr/bin/env bun
/**
 * scripts/vendor-wasm.ts — co-vendor the real WASM tails' artifacts next to the built engine so they
 * load same-origin in a browser/harness (docs/architecture/08 §7, ADR-042 — the co-vendoring step
 * ADR-041 deferred).
 *
 * Each miss-only WASM codec tail (`src/codecs/wasm-<id>/`) ships a vendored pair built by `wasm-pack`:
 *   - `*_wasm_bg.wasm` — the compiled core, and
 *   - `*-core.js`      — the wasm-bindgen `--target web` glue the driver `import()`s.
 * The driver loads the core via `new URL('./<id>_wasm_bg.wasm', import.meta.url)`, so at runtime the
 * `.wasm` must sit **next to the emitted `*-core.js` chunk**. `tsup` code-splits the string-literal
 * `import('./<id>-core.js')` into `dist/`, but it does **not** copy the `import.meta.url`-referenced
 * `.wasm` (it is a plain `new URL`, not a recognized asset import). This script fills that gap: it copies
 * every real tail's `.wasm` + glue into `dist/` (flat, original filenames), so the pair is co-located and
 * the harness's `dist → vendor/` copy carries both.
 *
 *   bun run build && bun run vendor-wasm     # copy every vendored tail's wasm+glue into dist/
 *   bun run vendor-wasm --check              # verify dist/ already has every tail pair (CI; no writes)
 *
 * Honest by construction: a tail with only one half of the pair AND no inlined-wasm carrier, or a
 * `--check` with a missing artifact, fails loudly (non-zero exit) — never a silent half-vendor.
 * Self-contained inlined-wasm tails (a `*-core.js` glue + an inlined carrier, no separate `*_wasm_bg.wasm`,
 * e.g. `wasm-opus`, `wasm-vpx`) and not-yet-built scaffolds are both skipped — they carry nothing for this
 * script to co-vendor (see {@link discoverTails}).
 */

import { readdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url).pathname;
const CODECS_DIR = `${ROOT}src/codecs`;
const DIST_DIR = `${ROOT}dist`;

const CHECK = process.argv.includes('--check');

/** One real WASM tail's vendored artifact pair (both halves present in its source dir). */
interface TailArtifacts {
  /** Tail id, e.g. `mp3` (from `wasm-mp3`). */
  id: string;
  /** Absolute path to the vendored `*_wasm_bg.wasm`. */
  wasmPath: string;
  /** Absolute path to the vendored `*-core.js` glue. */
  gluePath: string;
  /** Basenames to emit into `dist/` (preserved verbatim so `new URL(...)` resolution holds). */
  wasmName: string;
  glueName: string;
}

/**
 * Discover every real tail under `src/codecs/wasm-*` that has BOTH a `*_wasm_bg.wasm` and a `*-core.js`
 * to co-vendor. Three other shapes are handled WITHOUT error:
 *   1. NEITHER half present → a not-yet-built scaffold (skipped; nothing to vendor).
 *   2. A **self-contained inlined-wasm** tail — a `*-core.js` glue PLUS an inlined-wasm carrier (a
 *      `*-wasm.js` single-file module and/or a `generated/*.generated.mjs` blob) and NO separate
 *      `*_wasm_bg.wasm` (ADR-090). `tsup` bundles the wasm into the glue chunk, so there is nothing
 *      separate to copy → skipped. This is the Option-A path for prebuilt cores: libopus (`wasm-opus`),
 *      ogv.js libvpx (`wasm-vpx`).
 * A directory with exactly ONE half of the standard pair and NO inlined carrier is a genuinely broken
 * vendor, reported by {@link main} as an error. So a Rust/Symphonia tail (vorbis/aac/mp3) still REQUIRES
 * both files, while an inlined prebuilt is a valid glue-only tail.
 */
async function discoverTails(): Promise<{ tails: TailArtifacts[]; broken: string[] }> {
  const entries = await readdir(CODECS_DIR, { withFileTypes: true });
  const tails: TailArtifacts[] = [];
  const broken: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('wasm-')) continue;
    const id = entry.name.slice('wasm-'.length);
    const dir = `${CODECS_DIR}/${entry.name}`;
    const files = await readdir(dir);
    const wasmName = files.find((f) => f.endsWith('_wasm_bg.wasm'));
    const glueName = files.find((f) => f.endsWith('-core.js'));
    // A self-contained core INLINES its wasm into the glue rather than shipping a separate
    // `*_wasm_bg.wasm`: a prebuilt Emscripten single-file module (`*-wasm.js`, e.g. `libopus-wasm.js`,
    // `vpx-vp8-data-wasm.js`, `ogv-vp9-wasm.js`) and/or a generated ESM blob (`*.generated.mjs`, kept under
    // a `generated/` dir). `tsup` bundles that whole into the lazy `*-core.js` chunk, so there is NOTHING
    // separate for this script to co-vendor next to the emitted chunk (ADR-090). Detect any inlined-wasm
    // carrier so such a tail is SKIPPED — never mistaken for a broken half-vendor. (A standard Rust/Symphonia
    // tail has no such carrier, so it still REQUIRES both `*_wasm_bg.wasm` + `*-core.js`.)
    const hasInlinedWasmCarrier = files.some(
      (f) => f.endsWith('-wasm.js') || f.endsWith('.generated.mjs') || f === 'generated',
    );
    // Self-contained iff there is a glue chunk AND an inlined carrier but no separate `*_wasm_bg.wasm`.
    const selfContained = wasmName === undefined && glueName !== undefined && hasInlinedWasmCarrier;
    if (wasmName === undefined && glueName === undefined) continue; // scaffold-only tail: nothing to vendor
    if (selfContained) continue; // self-contained inlined-wasm core (glue + inlined carrier): tsup bundles it
    if (wasmName === undefined || glueName === undefined) {
      broken.push(
        `wasm-${id}: incomplete vendor (${wasmName ? 'glue' : 'wasm'} missing) — build it per BUILD.md`,
      );
      continue;
    }
    tails.push({
      id,
      wasmPath: `${dir}/${wasmName}`,
      gluePath: `${dir}/${glueName}`,
      wasmName,
      glueName,
    });
  }
  tails.sort((a, b) => a.id.localeCompare(b.id));
  return { tails, broken };
}

/** Copy one source file into `dist/`, returning the byte count written (Bun's `write` is atomic-ish). */
async function copyIntoDist(srcPath: string, name: string): Promise<number> {
  const src = Bun.file(srcPath);
  const bytes = await src.arrayBuffer();
  await Bun.write(`${DIST_DIR}/${name}`, bytes);
  return bytes.byteLength;
}

/** Assert a `dist/` artifact exists and matches the source byte-for-byte (the `--check`/CI oracle). */
async function verifyInDist(srcPath: string, name: string): Promise<string | undefined> {
  const distFile = Bun.file(`${DIST_DIR}/${name}`);
  if (!(await distFile.exists())) return `dist/${name} is missing (run \`bun run vendor-wasm\`)`;
  const [srcBytes, distBytes] = await Promise.all([
    Bun.file(srcPath).arrayBuffer(),
    distFile.arrayBuffer(),
  ]);
  if (srcBytes.byteLength !== distBytes.byteLength) {
    return `dist/${name} is stale (${distBytes.byteLength}B vs source ${srcBytes.byteLength}B)`;
  }
  const a = new Uint8Array(srcBytes);
  const b = new Uint8Array(distBytes);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return `dist/${name} differs from source at byte ${i} (stale — re-vendor)`;
  }
  return undefined;
}

async function main(): Promise<void> {
  if (!(await Bun.file(`${DIST_DIR}/index.js`).exists())) {
    console.error('vendor-wasm: dist/ not built — run `bun run build` first.');
    process.exit(1);
  }

  const { tails, broken } = await discoverTails();
  if (broken.length > 0) {
    for (const b of broken) console.error(`vendor-wasm: ${b}`);
    process.exit(1);
  }
  if (tails.length === 0) {
    console.log('vendor-wasm: no built WASM tails to vendor (all scaffolds).');
    return;
  }

  let problems = 0;
  for (const tail of tails) {
    if (CHECK) {
      const wasmIssue = await verifyInDist(tail.wasmPath, tail.wasmName);
      const glueIssue = await verifyInDist(tail.gluePath, tail.glueName);
      for (const issue of [wasmIssue, glueIssue]) {
        if (issue !== undefined) {
          console.error(`vendor-wasm: ${issue}`);
          problems++;
        }
      }
      if (wasmIssue === undefined && glueIssue === undefined) {
        console.log(
          `vendor-wasm: ✓ ${tail.id} (${tail.wasmName} + ${tail.glueName}) present in dist/`,
        );
      }
    } else {
      const wasmBytes = await copyIntoDist(tail.wasmPath, tail.wasmName);
      const glueBytes = await copyIntoDist(tail.gluePath, tail.glueName);
      console.log(
        `vendor-wasm: → dist/${tail.wasmName} (${wasmBytes}B) + dist/${tail.glueName} (${glueBytes}B)`,
      );
    }
  }

  if (problems > 0) {
    console.error(
      `vendor-wasm: ${problems} artifact(s) missing/stale in dist/ (run \`bun run vendor-wasm\`).`,
    );
    process.exit(1);
  }
  console.log(
    `vendor-wasm: ${CHECK ? 'verified' : 'vendored'} ${tails.length} tail(s) into dist/.`,
  );
}

main().catch((err: unknown) => {
  console.error('vendor-wasm: fatal', err);
  process.exit(1);
});
