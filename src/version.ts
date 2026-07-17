/**
 * The library's public version. Kept separate from {@link DRIVER_API_VERSION} (ADR-016). This literal
 * is pinned to `package.json#version` by a CI oracle (`public-surface.test.ts`, R-S05.6 / ADR-322): a
 * version bump that forgets either side fails the gate, so the shipped constant can never drift from
 * the published package version. (A build-time JSON import was rejected — it inlines the whole
 * `package.json` into the eager kernel; a bundler `define` lives in build config owned by S08.)
 */
export const VERSION = '0.0.0';
