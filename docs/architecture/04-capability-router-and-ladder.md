# 04 — Capability Router & Ladder

> How a backend is chosen for each stage — the mechanism that makes the API opaque (ADR-003). Contracts → [`05`](05-driver-contracts.md). Decisions: ADR-002 (priority), ADR-007 (determinism), ADR-017 (miss error), ADR-020 (cost-awareness), ADR-026 (WebCodecs codec drivers, hardware-first), ADR-027 (GPU filter drivers — WebGPU + Canvas2D, WebGL omitted), ADR-049 (image probe/decode as a side capability), ADR-076 (native filter substrate for pure-TS CPU filters).

## 1. What the router does

For each stage the Planner produces, the Router selects exactly one driver:

1. Gather the registered drivers of the stage's kind (codec / container / filter).
2. Order them by the **ladder** (best-first, ADR-002).
3. Walk top-down, calling each driver's **capability probe**; pick the first that reports support.
4. **Cache** only a provable highest-ranked positive verdict keyed by the exact query. Unprovable configs and lower-tier fallbacks deliberately re-probe so dynamic capability recovery remains visible (ADR-207).
5. **Lazy-import** the chosen driver's module if not already loaded, then build the stage.
6. If none support it → throw `CapabilityError` (ADR-017).

The developer sees none of this; they called `convert`/`probe` and got a result or a typed error.

For unpinned VP8/VP9 transcode decode, the successful capability probe is not the final proof: some browser
decoders accept and configure an exact profile, then report an asynchronous runtime `CapabilityError` on its
first coded packets. ADR-284 retains a bounded exact packet prefix until the first native frame. A pre-output
runtime miss selects the exact `wasm-vpx` tail and replays that prefix plus the same one-shot reader remainder.
The first native frame, 256 retained packets, or 16 MiB retained payload commits the native route; a later
failure stays typed because emitted frames cannot be retracted. Explicit non-WASM pins never fall through.

## 2. The ladders (seeded from the benchmark)

Top = tried first. These defaults encode the benchmark's per-family winners; they are refined later by telemetry, never exposed.

| Stage | Ladder (best-first) | Capability probe |
|---|---|---|
| probe / metadata | TS container/image header reader (range/bytes) | always — **never `<video>`** [data] |
| demux | TS streaming demuxer → WASM demuxer | container recognized? (mime/extension/magic) |
| mux · remux · trim (copy) | TS muxer / packet-copy → WASM | container supported? |
| decode (video/audio) | WebCodecs **hardware** → WebCodecs **software** → WASM decoder; images use browser `ImageDecoder` | `*Decoder.isConfigSupported(config)` / `ImageDecoder` presence |
| encode (video/audio) | WebCodecs **hardware** → WebCodecs **software** → WASM encoder | `*Encoder.isConfigSupported(config)` |
| video filter (resize/crop/pad/rotate/flip/colorspace/tonemap) | WebGPU → Canvas2D → native CPU → WASM (libavfilter) | `navigator.gpu` + `OffscreenCanvas` + `VideoFrame` / `OffscreenCanvas` / `VideoFrame` |
| audio convert (format/endianness/gain/mix/downmix/fade) | TS / AudioWorklet | always (cheap) |
| audio resample | TS band-limited windowed-sinc (`src/dsp/resample.ts`, ADR-022) | always (pure-TS; any ratio) |
| decrypt (CENC / HLS) | WebCrypto + TS box parse | `crypto.subtle` present |

`Tier` ordering used for normal ranking: `hardware` > `gpu` > `native` > `wasm`. For telemetry-classified tiny work (ADR-020), `hardware` remains first for codecs and `native` moves ahead of GPU/WASM setup.

> **As built (Phase 1–2, ADR-026/027/032/033/049/069/076/203/207/233).** The WebCodecs codec drivers (`webcodecs-video`, `webcodecs-audio`) are a *single* `tier:'hardware'` driver each, codec-agnostic by config; the hardware-vs-software split is not two drivers but the accepted `hardwareAcceleration` config — auto video probes `prefer-hardware` first, proves that candidate through the asynchronous configure control queue, and falls back to exact `no-preference` before packet submission; auto audio uses `'no-preference'`. `force-software` keeps that ranked driver only for an exact `prefer-software` probe and requires its explicit `hardwareAccelerated:false` verdict; a hardware-tier driver that omits or contradicts the verdict is skipped. Both the video acceleration verdict and Router positive-driver caches use exact config facts, including ordinary description bytes, geometry, colour, and effective alpha. Unprovable Router configs re-probe, and only a top-rung positive is cached so a temporary lower-tier fallback cannot lock out later recovery. The image path is deliberately outside the codec/container ladders: `ImageOps` sniffs GIF/PNG/JPEG/WebP/AVIF magic before container probing, uses a pure header parser for `probe`, and uses browser `ImageDecoder` for decode only in auto mode; force-software declines until a software image decoder exists. The video-filter ladder ships **WebGPU + Canvas2D + native CPU** — the **WebGL rung is intentionally omitted** (ADR-027): Canvas2D `drawImage` is GPU-accelerated and remains the normal fallback before the pure-TS CPU floor, but is excluded together with WebGPU/WebGL under `force-software`. The WASM filter rung remains reserved for a future compiled filter tail. **Colorspace + tonemap are now implemented (ADR-032/038)** via a WebGPU color pipeline and the native CPU fallback: WebGPU handles `colorspace` (BT.2020↔709↔601↔sRGB gamut+transfer) and `tonemap` (HDR PQ/HLG → SDR) for all targets, Canvas2D handles `colorspace` only when the target resolves to the display space (srgb/bt709, a UA-color-managed passthrough), and `cpu-video-filter` handles all seven video filter specs through `VideoFrame.copyTo` when GPU/canvas decline. The **audio** `FilterSpec`s (`resample`/`remix`/`gain`) are served by a separate auto-registered `audio-dsp-filter` (`AudioData` seam over the pure-TS dsp kernels, ADR-033); it declares `substrate:'native'`, ranked below GPU/canvas and above WASM. `mpegts` and `hls` are auto-registered container drivers. The real Symphonia audio WASM codec tails are also auto-registered and miss-only, but their probes require the browser `EncodedAudioChunk` → `AudioData` seam and co-vendored assets; scaffold tails stay explicit/not in defaults until their cores exist (see the doc 09 status table).

## 3. Capability probes (per kind)

- **Codec:** `async` — wraps `VideoDecoder/AudioDecoder/VideoEncoder/AudioEncoder.isConfigSupported(config)`. Returns `{ supported, hardwareAccelerated }`. This is the authoritative, cheap, browser-native check.
- **Container:** `sync` — by MIME, file extension, and **magic bytes** from the source head (e.g. `ftyp` for MP4, `1A45DFA3` EBML for WebM/MKV, `RIFF…WAVE`, `fLaC`, `OggS`, `ID3`/`0xFFFx` for MP3, or a repeated MPEG-TS `0x47` sync column at a 188/192/204-byte stride). Public family aliases route through the same exact driver predicates: `aac`→ADTS and `m2ts`/`mts`/`mpegts`→MPEG-TS (ADR-232).
- **Image:** `sync` magic-byte sniff on the source head (`GIF87a`/`GIF89a`, PNG signature, JPEG SOI, RIFF/WebP, AVIF `ftyp` brand). It is a side capability, not a container driver; a positive image match is handled before generic container probing.
- **Filter:** `sync` — `supports(spec)` plus a one-time substrate probe (`navigator.gpu`, WebGL context creation) cached per session.
- **Decrypt:** presence of `crypto.subtle` + scheme allow-list.

## 4. Selection algorithm (pseudocode)

```ts
async function pickCodec(q: CodecQuery, opts: StageOptions): Promise<CodecDriver> {
  const key = exactCodecKey(q, opts.determinism, costBucket(q, opts.cost)) // undefined if unprovable
  if (key !== undefined) {
    const cached = cache.get(key)
    if (cached !== undefined) return cached
  }
  const candidates = registry.codecs()
    .filter(d => opts.determinism === 'force-software' ? d.tier !== 'gpu' : true)
    .sort(byTierAndCost)                           // normal: hardware -> gpu -> native -> wasm; tiny: hardware -> native -> gpu -> wasm
  for (const [rank, d] of candidates.entries()) {
    await ensureLoaded(d)                           // lazy import the driver module if needed
    const s = await d.supports(q, { determinism: opts.determinism }) // exact acceleration / wasm caps
    const deterministic = opts.determinism !== 'force-software' ||
      (s.hardwareAccelerated !== true && (d.tier !== 'hardware' || s.hardwareAccelerated === false))
    if (s.supported && deterministic) {
      if (rank === 0 && key !== undefined && exactCodecKey(q, opts.determinism, costBucket(q, opts.cost)) === key) cache.setLRU(key, d)
      return d                                      // lower-tier wins are deliberately re-probed next call
    }
  }
  throw new CapabilityError('capability-miss', `no codec driver for ${describe(q)}`, { op: q, tried: candidates.map(d => d.id) })
}
```

Container and filter selection are the synchronous analogues (no `await` on `supports`).

> **Lazy-import vs probe ordering.** To probe a WASM driver we must load its (small) glue, but **not** its `.wasm` core — `supports()` answers from declared capabilities/feature-detection; the heavy `.wasm` downloads only when the driver is actually *built* for the stage. So probing the ladder stays cheap.

## 5. Caching

- Codec positives use a bounded 64-entry LRU keyed by the complete provable config snapshot plus media type, direction, determinism, and cost bucket. A descriptor-driven serializer never invokes `toJSON` or accessors. Ordinary BufferSource view bytes participate; shared/cross-realm, cyclic, hostile, or oversized shapes skip the optimization and re-probe. The snapshot is checked again after asynchronous `supports()` before insertion.
- Only the highest-ranked positive codec driver is cached. A lower-tier fallback is re-probed on its next use so dynamic recovery of a hardware/native rung is not hidden for the rest of the session. Container keys retain their documented stable subsets.
- Filter cache hits retain the bounded media/type/determinism/cost key, but re-run the cached driver's synchronous `supports(exactSpec)` before reuse and retain only a top-rung positive. Thus target-dependent support (for example Canvas2D display-space colour versus CPU wide-gamut colour) cannot depend on which target ran first, and a lower fallback cannot hide a faster later match.
- `media.preload(...)` (ADR / [`07`](07-public-api.md)) warms these caches ahead of the first real call.

## 6. Determinism modifier (ADR-007)

`determinism: 'force-software'` removes GPU codec tiers and WebGPU/WebGL/Canvas2D filter substrates. A WebCodecs-ranked `hardware` driver remains eligible only when its exact `prefer-software` probe returns `supported:true, hardwareAccelerated:false`; omitted, rewritten, or hardware verdicts are skipped. Native CPU and WASM remain eligible, and the determinism-specific cache key cannot reuse an auto verdict. Browser-native image decode declines because `ImageDecoder` exposes no software-selection proof. Default `'auto'` keeps the full ladder.

## 7. Cost-awareness (ADR-020/199)

The router accepts an internal `RouteCost`; codec stages keep the static ladder unless an internal caller supplies explicit cost. Generic codec/audio thresholds remain seeded from committed telemetry: `inputBytes <= 64 KiB`, `outputPixels <= 4096`, `mediaSeconds <= 1`, or `audioFrames <= 48_000` marks that stage as tiny. Video filters are modality-specific (ADR-199): when the engine has source and output geometry, it supplies total pixel work `(inputPixels + outputPixels) * estimatedFrames`, using the higher input/output fps (or the 30 fps planning default) and at least one frame when duration is unknown. Only `videoPixelWork <= 245,760` — an identity 64×64 source-read plus destination-write over 30 frames — is tiny; duration alone can never classify a high-resolution video filter as cheap, and incomplete geometry keeps the normal GPU-first ladder. Tiny work re-ranks cheaper native/in-process tiers ahead of GPU/WASM setup while keeping hardware WebCodecs first where present. This is deliberately not exposed as a public backend knob.

## 8. Failure semantics (ADR-017)

A miss is never silent. `CapabilityError` carries `{ op, tried[], suggestion? }` — e.g. probing a codec with no
registered compatible WebCodecs or WASM driver yields a clear error naming what was tried, rather than a
wrong-but-quiet result. (FLAC decode is the opposite case — a first-party **pure-TS** driver is registered,
ADR-024, so it does *not* miss.) Suggestions name only registered/enabled drivers; optional future tails are
not presented as available support (ADR-225). See the known envelope in
[`10-browser-capability-matrix.md`](10-browser-capability-matrix.md).

## 9. Exact driver pins (ADR-014/237)

The hidden per-call `strategy.pinDriver` is an exact id constraint, scoped to the registered driver kind
that owns the id. A codec-only pin therefore leaves container and filter stages of the same compound graph
on their ordinary ladders; when the matching codec stage arrives, only that codec is loaded and probed. A
negative pinned probe never falls through. Container and filter routing apply the identical rule, and pin
identity participates in every positive-cache key so an earlier unpinned winner cannot escape the pin.

An id absent from the current registry joins the shared in-flight default-driver import and is checked
again. If it remains absent, routing raises `CapabilityError` with `tried:[pin]` before opening a source or
pulling a frame. An id registered under another kind does not constrain this stage. This kind scoping is
what lets tests pin `wasm-aac` inside a demux→decode→filter graph without asking a container or filter to
share the codec's id.
