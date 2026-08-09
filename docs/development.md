# Development and release

## Tooling

Repository development uses Bun. Install dependencies from the package root:

```sh
bun install
```

## Common commands

| Command | Purpose |
| --- | --- |
| `bun run typecheck` | Type-check source, tests, and repository scripts |
| `bun run docs:check` | Type-check runnable examples and validate public documentation links/content |
| `bun run check` | Run Biome formatting and lint checks |
| `bun run test` | Run the Vitest suite |
| `bun run test:watch` | Run Vitest in watch mode |
| `bun run test:cov` | Run tests with coverage |
| `bun run build` | Build ESM bundles, source maps, and declarations into `dist/` |
| `bun run vendor-wasm` | Copy selected codec WASM assets into the package output |
| `bun run vendor-wasm:check` | Verify vendored asset contents |
| `bun run test:dist` | Smoke-test the built distribution |
| `bun run check-budgets` | Enforce package and eager-bundle size limits |
| `bun run verify:package` | Install the packed package and verify runtime imports and types |
| `bun run verify:integrity` | Run repository integrity checks |
| `bun run gate` | Run the complete local release gate |

## Runnable examples

The [`examples/`](../examples/README.md) directory imports `@aibrush/media`, not source internals. Build
and vendor the distribution before executing an example:

```sh
bun run build
bun run vendor-wasm
bun examples/probe.ts ./fixtures/media/movie_5.mp4
```

`bun run docs:check` resolves those same imports directly to the current source for fast compile-time
validation.

## Documentation rules

Public documentation belongs in `README.md`, `docs/`, and `examples/`. It should:

- describe exported behavior that exists in the current code;
- use current option names and package subpaths;
- keep implementation discussion limited to facts users need for runtime or ownership decisions;
- provide examples through the public package entry;
- avoid internal project tracking and unpublished design references.

Update documentation in the same change as any public function, option, result, error code, runtime
requirement, or package export.

## Build output

`bun run build` recreates `dist/`. The package export map publishes:

- root, core, image, WAV, and MP4 packet-info entries;
- explicit first-party driver entries;
- split JavaScript chunks, source maps, declarations, worker code, and selected codec assets.

Do not edit `dist/` by hand. Change `src/` or the build scripts, then rebuild.

## Release verification

Run the complete gate from a clean dependency install:

```sh
bun install
bun run gate
npm pack --dry-run
```

Before publishing, confirm:

1. `package.json` and `src/version.ts` contain the same intended version.
2. `bun run docs:check` passes and every documented export exists.
3. The build and WASM vendor step complete.
4. Distribution smoke tests and clean-install package verification pass.
5. Bundle budgets and integrity checks pass.
6. `npm pack --dry-run` contains only release assets and public documentation.
7. The package can be installed into a small browser application and its intended codec targets pass
   `canConvert()` in supported browsers.

The package is ESM-only and declares Node.js 18 or newer. Keep those constraints synchronized with the
actual build target and verification environment.
