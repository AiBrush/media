# Session 9 Note - Gapless AAC Whole-Source Identity Trim

## Goal

Close `audio-dsp/edge_gapless_aac_decode` on Chromium without changing the
`gapless-decoded-sample-count-priming-removed` oracle or rewriting away MP4 AAC gapless metadata.

## Design Note

The workload is a full-range accurate trim of a tiny AAC-in-MP4/M4A asset. The strict oracle decodes the
output in the browser and expects the priming/padding-removed program length: 44,673 samples at 44.1 kHz.
An attempted native MP4 packet-copy rewrite was rejected because it decoded to 45,056 samples: the output
preserved the leading edit but did not preserve the trailing padding trim.

The correct fast path is therefore byte preservation, not packet rewriting. Accurate trim now validates
the requested range, computes trim duration from `gapless.totalSamples / sampleRate` when an audio track
exposes gapless facts, and returns the original source stream for a true whole-source identity window
(`start=0`, `end` within 1 ms of the validated duration, re-readable source). Metadata duration validation
uses a driver's `probe()` hook when available, avoiding a demux session before the identity return.

## Validation

- Package focused tests: `bun test src/api/create-media.test.ts src/api/session6-r2-gapless-trim.test.ts`
- Package formatter: `bunx biome check src/api/engine.ts src/api/create-media.test.ts`
- Package typecheck: `bun run typecheck`
- Package build: `bun run build`
- WASM vendor tail copy: `bun run vendor-wasm`
- Fresh browser benchmark: `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media --scenario audio-dsp/edge_gapless_aac_decode --warmup 3 --iters 9 --no-reuse --timeout-ms 300000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-03T20-32-38-676Z.json`

`audio-dsp/edge_gapless_aac_decode`:

- aibrush-media: PASS `property-invariant`, median **9.040 ms**, n=9
- mediabunny: PASS `property-invariant`, stored median **10.600 ms**
- oracle detail: `decodedSamples=44673`, `expectedDecodedRateSamples=44673`, `sampleDelta=0`,
  `decodedSampleRate=44100`, `rawAacFrameSamples=46080`, `primingSamples=1024`

Regenerated backlog: `269 active deficits (0/0/48/221), 1 exempt`.
