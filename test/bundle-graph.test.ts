import { describe, expect, it } from 'vitest';
import { resolveLocalJsImport, staticLocalJsImports } from '../scripts/bundle-graph.ts';

describe('bundle graph static imports', () => {
  it('finds from, export, and minified bare edges without treating dynamic imports as static', () => {
    const code = [
      'import{a}from"./chunk-A.js";',
      'export { b } from "../shared/chunk-B.js";',
      'import"./chunk-C.js";',
      'const lazy=import("./chunk-D.js");',
    ].join('');

    expect(staticLocalJsImports(code)).toEqual([
      '../shared/chunk-B.js',
      './chunk-A.js',
      './chunk-C.js',
    ]);
    expect(resolveLocalJsImport('nested/entry.js', '../shared/chunk-B.js')).toBe(
      'shared/chunk-B.js',
    );
  });
});
