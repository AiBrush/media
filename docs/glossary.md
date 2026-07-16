# Glossary

Load-bearing terms used across the aibrush-media docs. Definitions describe how the term is used *here*; the
authoritative mechanics live in the linked shard doc.

- **Backpressure** — flow control on a `TransformStream`/`ReadableStream` seam: a slow consumer stops a fast
  producer from buffering unbounded frames. The engine's data flow is web-streams-based so backpressure is
  native. See [`architecture/execution-runtime.md`](architecture/execution-runtime.md).
- **B-frame (bidirectional frame)** — a coded frame that references both past and future frames, so
  **decode order ≠ presentation order**. Handled via DTS/PTS and composition offsets on the packet seam, not
  by the router. See [`operations/decode-seek.md`](operations/decode-seek.md), [`drivers/mp4.md`](drivers/mp4.md).
- **Capability router** — the kernel component that, for each stage, selects exactly one driver by walking the
  **tier ladder** best-first and probing each candidate's cheap `supports()`; throws a `CapabilityError` on a
  true miss. See [`architecture/capability-router.md`](architecture/capability-router.md).
- **`CapabilityError`** — the typed error raised when no substrate can serve an intent (carries `{ op, tried }`).
  Never a silent wrong result. See [`architecture/driver-contracts.md`](architecture/driver-contracts.md).
- **CENC (Common Encryption, ISO/IEC 23001-7)** — the MP4 encryption scheme family: **`cenc`**/**`cens`**
  (AES-CTR, full/subsample) and **`cbc1`**/**`cbcs`** (AES-CBC, pattern). Plus HLS **AES-128** (full segment)
  and **SAMPLE-AES**. See [`operations/encryption.md`](operations/encryption.md).
- **CMAF / fragmented MP4 (fMP4)** — MP4 written as an `moof`+`mdat` fragment stream (init segment + media
  segments) for low-latency/streaming output, as opposed to a single `moov`+`mdat` file. See
  [`operations/streaming-output.md`](operations/streaming-output.md).
- **Convert** — the public verb for re-encoding/format change (a transcode), including PCM format/gain/mix/
  resample paths. See [`operations/transcode-audio-convert.md`](operations/transcode-audio-convert.md).
- **Driver** — a pluggable backend implementing a contract: **`CodecDriver`** (encode/decode), **`ContainerDriver`**
  (probe/demux/mux), **`FilterDriver`** (pixel/audio transform). Registered in the registry; selected by the
  router. See [`architecture/driver-contracts.md`](architecture/driver-contracts.md).
- **DTS / PTS** — Decode TimeStamp / Presentation TimeStamp on a packet; differ when B-frames reorder frames.
- **EBML** — the tag-length-value binary format underlying Matroska/WebM. See
  [`drivers/webm-mkv.md`](drivers/webm-mkv.md).
- **Faststart** — MP4 layout with the `moov` atom **before** `mdat`, so playback can begin without reading the
  whole file. See [`drivers/mp4.md`](drivers/mp4.md).
- **Frame lifetime / `close()` once** — every `VideoFrame`/`AudioData` owns GPU/native memory and **must be
  `close()`d exactly once**. A missed close leaks; a double close throws. Ownership is tracked through the
  executor and drivers. See [`architecture/execution-runtime.md`](architecture/execution-runtime.md).
- **Gapless** — lossless audio boundaries: encoder delay/**priming** samples at the start and **padding** at
  the end are recorded and honored so concatenation/trim has no click or silence. See
  [`operations/transcode-audio-convert.md`](operations/transcode-audio-convert.md), [`operations/trim.md`](operations/trim.md).
- **Kernel** — the tiny eager core: **Normalizer → Planner → Router → Executor → Worker-bridge + Registry**.
  Everything else lazy-loads. See [`architecture/README.md`](architecture/README.md).
- **Miss-only WASM** — WASM codec cores are downloaded/instantiated **only after** the hardware/native tiers
  have missed, keeping the common path free of large downloads. See [`codecs/wasm-tail.md`](codecs/wasm-tail.md).
- **Mux / Remux / Transcode** — **mux**: package packets into a container. **Remux**: change container with
  **stream copy** (no re-encode). **Transcode**: re-encode the media. See
  [`operations/mux.md`](operations/mux.md), [`operations/remux.md`](operations/remux.md),
  [`operations/transcode-video.md`](operations/transcode-video.md).
- **Packet** — one coded, container-level unit (with DTS/PTS/duration/flags), pre-decode. Contrast **frame**
  (decoded) and **sample** (one PCM sample per channel).
- **Probe** — cheap metadata read (tracks, codecs, duration) without a full demux. See
  [`operations/probe-and-demux.md`](operations/probe-and-demux.md).
- **Seam** — a typed boundary between layers (e.g. `Source`, `Packet`, the `TransformStream` codec seam, the
  `Sink`) where ownership and backpressure are defined.
- **Seek** — decode at/near a timestamp; accurate seek decodes from the prior **keyframe (sync sample)**
  forward. See [`operations/decode-seek.md`](operations/decode-seek.md).
- **Sink / Source** — output/input abstractions. `Source` = normalized bytes (URL/Range, stream, Blob, OPFS,
  live); `Sink` = where output lands (`toBlob`, `toStream`, `toOPFS`, `toStreamTarget`, …). See
  [`architecture/sources.md`](architecture/sources.md), [`operations/streaming-output.md`](operations/streaming-output.md).
- **Stream copy** — moving coded packets between containers without decoding/re-encoding (ffmpeg `-c copy`);
  the mechanism behind remux and keyframe trim.
- **Substrate** — a class of execution backend: **WebCodecs** (hardware/native), **GPU** (WebGPU/Canvas2D),
  **pure-TS** (`native`), **WASM**. The ladder ranks them.
- **Tier** — a driver's substrate rank on the ladder: `hardware | gpu | native | wasm` for codecs;
  `webgpu | webgl | canvas2d | native | wasm` for filters. See
  [`architecture/capability-router.md`](architecture/capability-router.md).
- **Tiny-work tier** — below small-input thresholds the router re-ranks cheap in-process work ahead of
  GPU/WASM setup, because setup cost dominates for tiny media. See
  [`architecture/capability-router.md`](architecture/capability-router.md).
- **VFR (variable frame rate)** — content whose frame durations vary; timing comes from per-frame timestamps,
  not a fixed cadence. Must survive decode → filter → encode → mux unchanged. See
  [`operations/transcode-video.md`](operations/transcode-video.md).
