import { dirname, join, normalize } from 'node:path/posix';

/** Local static ESM edges, including minified side-effect imports. Dynamic `import()` is excluded. */
export function staticLocalJsImports(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /(?:^|[\s;])(?:import|export)\b[^'"]*?\bfrom\s*['"]((?:\.\.?\/)+[^'"]+\.js)['"]/g;
  for (const match of code.matchAll(fromRe)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec);
  }
  const bareRe = /(?:^|[\s;])import\s*['"]((?:\.\.?\/)+[^'"]+\.js)['"]/g;
  for (const match of code.matchAll(bareRe)) {
    const spec = match[1];
    if (spec !== undefined) specs.push(spec);
  }
  return [...new Set(specs)].sort();
}

/** Resolve a local emitted-chunk specifier relative to its importing emitted file. */
export function resolveLocalJsImport(importer: string, specifier: string): string {
  return normalize(join(dirname(importer), specifier));
}
