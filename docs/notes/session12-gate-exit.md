# Session 12 deterministic integrity-gate exit

## Goal

Make `bun run gate` terminate with the integrity result it has already computed. The anti-cheat program
currently prints all 45 green checks and has no active Node handles or requests, but Bun retains internal
WebCrypto worker state after the CENC/HLS checks and the process never reaches natural quiescence.

## Approach

Keep every assertion and awaited operation unchanged. After `main()` has completed and printed the success
summary, explicitly exit with status zero, mirroring the existing explicit status-one failure branch. A
rejected alternative was to force-exit from a timer or before checking lifecycle state; that could hide
pending work. The chosen point is after every decrypt, demux, close, digest, and output check has settled.

Edge cases: a failed assertion still exits one inside `main`; a thrown exception still rejects top-level and
exits nonzero; stdout must contain the complete summary before success exit; no product runtime or media path
changes. Validation is the real CLI under a wall timeout plus the full aggregate gate. This is gate tooling,
not a media feature, so it has no throughput benchmark surface.

## Fresh validation

The complete aggregate command now exits `0`. The fresh run passed strict typechecking, Biome over 541 files,
all six deficit-generator tests, 183 Vitest files with 3,286 tests and coverage (92.01% lines, 90.02%
branches), the production build, vendored-WASM checks, ten distribution smoke tests, the 49.36 kB eager and
220.80 kB typical bundle budgets, clean packed-package installation, and all 45 anti-cheat assertions. The
package verifier also checked the concrete driver export and TypeScript declarations without warnings.
