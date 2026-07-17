/**
 * The declarative job runner — the lazily-imported public seam for `engine.run(job)`
 * (docs/architecture/execution-runtime §3.2/§3.5). The implementation is split by concern:
 *
 * - `job-schema.ts` (+ `job-schema-targets.ts`, `job-schema-values.ts`) — structural validation of the
 *   structured-clone-safe `MediaJob`;
 * - `job-compile.ts` — rank-based transform fusion into the ordered flat-op stage list;
 * - `job-progress.ts` — the monotonic per-stage progress timeline;
 * - `job-run.ts` — orchestration: one linked signal, one pipeline, typed errors.
 *
 * This module stays the single dynamic-import entry (`import('./job-runner.ts')`) so the packaging
 * budget's lazy `job-runner` chunk identity is stable.
 */

export { runMediaJob } from './job-run.ts';
