# Coverage Matrix

> Completeness oracle for the documentation set: proves every `src/` area and every benchmark family maps to exactly one owning doc, and that every planned shard doc exists on disk. Generated deterministically from the shard map and a filesystem check — not hand-asserted.

**Summary:** 33/33 shard docs present — **all shards present.** · 52 src areas mapped · 13/13 benchmark families mapped.


## 1. Shard docs → exists?

| Shard | Doc | Title | Family | On disk |
|---|---|---|---|---|
| S01 | [`docs/architecture/capability-router.md`](capability-router.md) | Capability Router & Tier Ladder | routing spine (all families) | ✅ |
| S02 | [`docs/architecture/execution-runtime.md`](execution-runtime.md) | Execution & Runtime | cross-cutting | ✅ |
| S03 | [`docs/architecture/worker-and-wasm-runtime.md`](worker-and-wasm-runtime.md) | Worker & WASM Runtime | cross-cutting | ✅ |
| S04 | [`docs/architecture/driver-contracts.md`](driver-contracts.md) | Driver Contracts & Registry | cross-cutting | ✅ |
| S05 | [`docs/architecture/public-api.md`](public-api.md) | Public API | developer surface | ✅ |
| S06 | [`docs/architecture/sources.md`](sources.md) | Input Sources | input model | ✅ |
| S07 | [`docs/operations/streaming-output.md`](../operations/streaming-output.md) | Sinks & Streaming Output | streaming-output | ✅ |
| S08 | [`docs/architecture/packaging-and-loading.md`](packaging-and-loading.md) | Packaging & Loading | delivery | ✅ |
| S09 | [`docs/operations/probe-and-demux.md`](../operations/probe-and-demux.md) | Probe & Demux | probe, demux | ✅ |
| S10 | [`docs/operations/decode-seek.md`](../operations/decode-seek.md) | Decode & Seek | decode-seek | ✅ |
| S11 | [`docs/operations/transcode-video.md`](../operations/transcode-video.md) | Transcode — Video | transcode (video) | ✅ |
| S12 | [`docs/operations/transcode-audio-convert.md`](../operations/transcode-audio-convert.md) | Transcode — Audio & Convert | transcode (audio), convert | ✅ |
| S13 | [`docs/architecture/codec-pipeline.md`](codec-pipeline.md) | Codec Pipeline (shared brain) | transcode spine | ✅ |
| S14 | [`docs/operations/mux.md`](../operations/mux.md) | Mux | mux | ✅ |
| S15 | [`docs/operations/remux.md`](../operations/remux.md) | Remux | remux | ✅ |
| S16 | [`docs/operations/trim.md`](../operations/trim.md) | Trim | trim | ✅ |
| S17 | [`docs/operations/audio-dsp.md`](../operations/audio-dsp.md) | Audio DSP & PCM Convert | audio-dsp, convert (pcm) | ✅ |
| S18 | [`docs/operations/video-filters.md`](../operations/video-filters.md) | Video Filters | transcode (filters) | ✅ |
| S19 | [`docs/operations/encryption.md`](../operations/encryption.md) | Encryption / Decrypt | encryption | ✅ |
| S20 | [`docs/operations/metadata.md`](../operations/metadata.md) | Metadata | metadata | ✅ |
| S21 | [`docs/operations/performance.md`](../operations/performance.md) | Performance Methodology | performance | ✅ |
| S22 | [`docs/operations/robustness.md`](../operations/robustness.md) | Robustness | robustness | ✅ |
| S23 | [`docs/drivers/mp4.md`](../drivers/mp4.md) | MP4 / MOV Driver | demux, mux, remux | ✅ |
| S24 | [`docs/drivers/webm-mkv.md`](../drivers/webm-mkv.md) | WebM / MKV Driver | demux, mux | ✅ |
| S25 | [`docs/drivers/mpegts-hls.md`](../drivers/mpegts-hls.md) | MPEG-TS & HLS Driver | demux, remux | ✅ |
| S26 | [`docs/drivers/ogg.md`](../drivers/ogg.md) | Ogg Driver | demux, mux | ✅ |
| S27 | [`docs/drivers/wav-aiff-caf.md`](../drivers/wav-aiff-caf.md) | WAV / AIFF / CAF Drivers | demux, mux, convert | ✅ |
| S28 | [`docs/drivers/mp3-adts-flac.md`](../drivers/mp3-adts-flac.md) | MP3 / ADTS / FLAC Drivers | demux, mux | ✅ |
| S29 | [`docs/drivers/avi.md`](../drivers/avi.md) | AVI Driver | demux, mux | ✅ |
| S30 | [`docs/codecs/webcodecs.md`](../codecs/webcodecs.md) | WebCodecs Codec Tier | transcode, decode | ✅ |
| S31 | [`docs/codecs/wasm-tail.md`](../codecs/wasm-tail.md) | WASM Codec Tail | transcode, decode (miss-only) | ✅ |
| S32 | [`docs/codecs/flac-and-image.md`](../codecs/flac-and-image.md) | FLAC & Image Codecs | decode, probe | ✅ |
| S33 | [`docs/architecture/testing-and-validation.md`](testing-and-validation.md) | Testing & Validation | cross-cutting | ✅ |

## 2. `src/` area → owning shard

| src area | Owning shard(s) |
|---|---|
| `src/ (core,image,index,version)` | S05 |
| `src/api/ (job,job-runner,chain,chain-runner)` | S02 |
| `src/api/ (create-media,engine,types,preload,runtime-detect,track-select)` | S05 |
| `src/api/ (deferred-stream-cleanup,streaming-webm-remux)` | S07 |
| `src/api/replayable-video-decoder.ts` | S10 |
| `src/api/ (video-stream-plan,video-frame-convert,video-two-pass,video-two-pass-runner,vpx-alpha-pixels)` | S11 |
| `src/api/ (audio-stream-plan,codec-convert-runner,convert-stream-copy,pcm-convert-plan,flac-convert-plan,wav-frame-encode,gapless-native-suppression,live-convert)` | S12 |
| `src/api/ (codec-pipeline,codec-routing)` | S13 |
| `src/api/ (mux-packet-streams,mux-runner,native-packet-mux,mp4-prepared-mux,mpegts-prepared-mux,flac-mkv-mux)` | S14 |
| `src/api/ (remux-runner,remux-metadata,semantic-stream-copy,mpegts-packet-info-remux)` | S15 |
| `src/api/ (trim-runner,trim-streams)` | S16 |
| `src/api/decrypt-runner.ts` | S19 |
| `src/kernel/ (router,tier-thresholds,tier-thresholds-telemetry)` | S01 |
| `src/kernel/ (executor,planner,frames)` | S02 |
| `src/kernel/ (worker*,wasm-runtime,wasm-loader-runtime)` | S03 |
| `src/kernel/registry.ts` | S04 |
| `src/contracts/ (driver,errors)` | S04 |
| `src/codecs/h264-avcc-crop.ts` | S10 |
| `src/codecs/ (webcodecs-video,webcodecs-audio)` | S30 |
| `src/codecs/flac/` | S32 |
| `src/codecs/image/` | S32 |
| `src/codecs/wasm-*/` | S31 |
| `src/conformance/` | S33 |
| `src/crypto/` | S19 |
| `src/dsp/` | S17 |
| `src/filters/audio-dsp.ts` | S17 |
| `src/filters/ (cpu-video,geometry,gpu-uniforms,gpu-video,video-color-space)` | S18 |
| `src/internal/packet-provenance.ts` | S09 |
| `src/metadata/` | S20 |
| `src/sinks/` | S07 |
| `src/sources/` | S06 |
| `src/test-support/fuzz/corrupt.ts` | S22 |
| `src/test-support/ (rest: goldens/encrypt/corpus/mp4-builder)` | S33 |
| `src/util/digest.ts` | S20 |
| `src/util/rotation.ts` | S18 |
| `src/drivers/audio-container-mux-validation.ts` | S14 |
| `src/drivers/audio-container-sniff.ts` | S09 |
| `src/drivers/ (default-codec-registration,default-container-registration,defaults)` | S04 |
| `src/drivers/hls-full-segment-decrypt.ts` | S19 |
| `src/drivers/ (pcm-output,pcm-transform)` | S17 |
| `src/drivers/adts/` | S28 |
| `src/drivers/aiff/` | S27 |
| `src/drivers/avi/` | S29 |
| `src/drivers/caf/` | S27 |
| `src/drivers/flac/` | S28 |
| `src/drivers/hls/` | S25 |
| `src/drivers/mp3/` | S28 |
| `src/drivers/mp4/ (cenc.ts -> S19; rest -> S23)` | S23/S19 |
| `src/drivers/mpegts/ (mpegts-decrypt.ts -> S19; rest -> S25)` | S25/S19 |
| `src/drivers/ogg/` | S26 |
| `src/drivers/wav/` | S27 |
| `src/drivers/webm/` | S24 |

## 3. Benchmark family (13) → owning shard

| Benchmark family | Owning shard(s) |
|---|---|
| audio-dsp | S17 |
| decode-seek | S10 |
| demux | S09 (+ driver docs S23-S29) |
| encryption | S19 |
| metadata | S20 |
| mux | S14 (+ driver docs) |
| performance | S21 |
| probe | S09 (+ driver docs) |
| remux | S15 |
| robustness | S22 |
| streaming-output | S07 |
| transcode | S11/S12/S13 (+ filters S18) |
| trim | S16 |

## 4. Gaps & mismatches

- **No gaps.** All 33 shard docs exist; every `src/` directory/file-group above is owned by exactly one shard; all 13 benchmark families are covered. Cross-cutting docs S08 (packaging) and S21 (performance methodology) intentionally own a *concern* rather than unique `src/*.ts` files, so they add no overlap.

> Disjointness rule: one agent owned exactly one output file; two files split within a directory (e.g. `src/drivers/mp4/cenc.ts` → S19 while the rest of `mp4/` → S23) are annotated inline above.

