#!/usr/bin/env bun
/**
 * scripts/check-budgets.ts — enforce the bundle budgets (docs/architecture/08 §7, DoD §2). The eager
 * kernel (the `@aibrush/media` entry plus everything it **statically** imports) must stay tiny; heavy
 * codecs/wasm are lazy `import()`s and same-origin `.wasm` assets that this budget excludes by design.
 *
 * Run after `bun run build`.  Exits non-zero if a budget is exceeded.
 */

const DIST = new URL('../dist/', import.meta.url).pathname;
const KERNEL_BUDGET = 50 * 1024; // eager kernel ≤ ~50 kB

/** Collect the entry plus the transitive closure of its static (non-`import()`) local imports. */
async function eagerClosure(entryFile: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || sizes.has(file)) continue;
    const handle = Bun.file(`${DIST}${file}`);
    const code = await handle.text();
    sizes.set(file, handle.size);
    for (const spec of staticLocalImports(code)) {
      queue.push(spec);
    }
  }
  return sizes;
}

/** Static `import …/export … from './x.js'` specifiers — excludes dynamic `import('./x.js')`. */
function staticLocalImports(code: string): string[] {
  const specs: string[] = [];
  const re = /(?:^|[\s;])(?:import|export)\b[^'"]*?\bfrom\s*['"](\.\/[^'"]+)['"]/g;
  for (const m of code.matchAll(re)) {
    const spec = m[1];
    if (spec !== undefined) specs.push(spec.replace(/^\.\//, ''));
  }
  return specs;
}

function fmt(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

const closure = await eagerClosure('index.js');
const total = [...closure.values()].reduce((a, b) => a + b, 0);

console.info('Eager kernel closure (statically reachable from the default entry):');
for (const [file, size] of [...closure].sort((a, b) => b[1] - a[1])) {
  console.info(`  ${fmt(size).padStart(10)}  ${file}`);
}
console.info(`  ${'─'.repeat(10)}`);
console.info(`  ${fmt(total).padStart(10)}  total (budget ${fmt(KERNEL_BUDGET)})`);

if (total > KERNEL_BUDGET) {
  console.error(`\n✗ eager kernel ${fmt(total)} exceeds the ${fmt(KERNEL_BUDGET)} budget`);
  process.exit(1);
}
console.info(`\n✓ eager kernel within budget (${fmt(total)} ≤ ${fmt(KERNEL_BUDGET)})`);
