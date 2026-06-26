# 04 — Capability Router & Ladder

> How a backend is chosen for each stage — the mechanism that makes the API opaque (ADR-003). Contracts → [`05`](05-driver-contracts.md). Decisions: ADR-002 (priority), ADR-007 (determinism), ADR-017 (miss error), ADR-020 (cost-awareness, deferred), ADR-026 (WebCodecs codec drivers, hardware-first), ADR-027 (GPU filter drivers — WebGPU + Canvas2D, WebGL omitted), ADR-049 (image probe/decode as a side capability).

## 1. What the router does

For each stage the Planner produces, the Router selects exactly one driver:

1. Gather the registered drivers of the stage's kind (codec / container / filter).
2. Order them by the **ladder** (best-first, ADR-002).
3. Walk top-down, calling each driver's **capability probe**; pick the first that reports support.
4. **Cache** the verdict keyed by the query (so the hot path never re-probes).
5. **Lazy-import** the chosen driver's module if not already loaded, then build the stage.
6. If none support it → throw `CapabilityError` (ADR-017).

The developer sees none of this; they called `convert`/`probe` and got a result or a typed error.

## 2. The ladders (seeded from the benchmark)

Top = tried first. These defaults encode the benchmark's per-family winners; they are refined later by telemetry, never exposed.

| Stage | Ladder (best-first) | Capability probe |
|---|---|---|
| probe / metadata | TS container/image header reader (range/bytes) | always — **never `<video>`** [data] |
| demux | TS streaming demuxer → WASM demuxer | container recognized? (mime/extension/magic) |
| mux · remux · trim (copy) | TS muxer / packet-copy → WASM | container supported? |
| decode (video/audio) | WebCodecs **hardware** → WebCodecs **software** → WASM decoder; images use browser `ImageDecoder` | `*Decoder.isConfigSupported(config)` / `ImageDecoder` presence |
| encode (video/audio) | WebCodecs **hardware** → WebCodecs **software** → WASM encoder | `*Encoder.isConfigSupported(config)` |
| video filter (resize/crop/rotate/flip) | WebGPU → Canvas2D → WASM (libavfilter) | `navigator.gpu` + `OffscreenCanvas` + `VideoFrame` / `OffscreenCanvas` |
| audio convert (format/endianness/gain/mix/downmix/fade) | TS / AudioWorklet | always (cheap) |
| audio resample | TS band-limited windowed-sinc (`src/dsp/resample.ts`, ADR-022) | always (pure-TS; any ratio) |
| decrypt (CENC / HLS) | WebCrypto + TS box parse | `crypto.subtle` present |

`Tier` ordering used for ranking: `hardware` > `gpu` > `native` > `wasm`.

> **As built (Phase 1–2, ADR-026/027/032/033/049).** The WebCodecs codec drivers (`webcodecs-video`, `webcodecs-audio`) are a *single* `tier:'hardware'` driver each, codec-agnostic by config; the hardware-vs-software split is not two drivers but the `hardwareAcceleration` hint the determinism modifier sets — `auto → 'prefer-hardware'` (video) / `'no-preference'` (audio), `force-software → 'prefer-software'` (both). `isConfigSupported` then reports whether the UA will actually accelerate, and `force-software` additionally drops the whole `hardware`/`gpu` tier (§6). The image path is deliberately outside the codec/container ladders: `ImageOps` sniffs GIF/PNG/JPEG/WebP/AVIF magic before container probing, uses a pure header parser for `probe`, and uses browser `ImageDecoder` for `decode` when present. The video-filter ladder ships **WebGPU + Canvas2D only** — the **WebGL rung is intentionally omitted** (ADR-027): Canvas2D `drawImage` is itself GPU-accelerated and pixel-exact for every geometric op, so it is the single, simpler fallback. The WASM filter rung is the Phase-2 tail. **Colorspace + tonemap are now implemented (ADR-032)** via a second WGSL color pipeline: WebGPU handles `colorspace` (BT.2020↔709↔601↔sRGB gamut+transfer) and `tonemap` (HDR PQ/HLG → SDR) for all targets, while Canvas2D `supports()` is honest — it handles `colorspace` only when the target resolves to the display space (srgb/bt709, a UA-color-managed passthrough) and declines wider-gamut targets and all tonemap, so an unbuilt path is a typed miss until the WASM tail, never wrong pixels. The **audio** `FilterSpec`s (`resample`/`remix`/`gain`) are served by a separate auto-registered `audio-dsp-filter` (`AudioData` seam over the pure-TS dsp kernels, ADR-033); it declares `substrate:'wasm'` (the least-wrong CPU tier — it must rank below the GPU substrates; a `'native'` `FilterSubstrate` is the proper future fit). `mpegts` and `hls` are auto-registered container drivers; the wasm codec tails stay explicit/not in the default bundle until browser `.wasm` co-vendoring is complete (see the doc 09 status table).

## 3. Capability probes (per kind)

- **Codec:** `async` — wraps `VideoDecoder/AudioDecoder/VideoEncoder/AudioEncoder.isConfigSupported(config)`. Returns `{ supported, hardwareAccelerated }`. This is the authoritative, cheap, browser-native check.
- **Container:** `sync` — by MIME, file extension, and **magic bytes** from the source head (e.g. `ftyp` for MP4, `1A45DFA3` EBML for WebM/MKV, `RIFF…WAVE`, `fLaC`, `OggS`, `ID3`/`0xFFFx` for MP3).
- **Image:** `sync` magic-byte sniff on the source head (`GIF87a`/`GIF89a`, PNG signature, JPEG SOI, RIFF/WebP, AVIF `ftyp` brand). It is a side capability, not a container driver; a positive image match is handled before generic container probing.
- **Filter:** `sync` — `supports(spec)` plus a one-time substrate probe (`navigator.gpu`, WebGL context creation) cached per session.
- **Decrypt:** presence of `crypto.subtle` + scheme allow-list.

## 4. Selection algorithm (pseudocode)

```ts
async function pickCodec(q: CodecQuery, opts: StageOptions): Promise<CodecDriver> {
  const key = codecKey(q, opts.determinism)
  if (cache.has(key)) return cache.get(key)!
  const candidates = registry.codecs()
    .filter(d => opts.determinism === 'force-software' ? d.tier !== 'hardware' && d.tier !== 'gpu' : true)
    .sort(byTier)                                  // hardware -> gpu -> native -> wasm
  for (const d of candidates) {
    await ensureLoaded(d)                           // lazy import the driver module if needed
    const s = await d.supports(q)                   // isConfigSupported / wasm caps
    if (s.supported) { cache.set(key, d); return d }
  }
  throw new CapabilityError('capability-miss', `no codec driver for ${describe(q)}`, { op: q, tried: candidates.map(d => d.id) })
}
```

Container and filter selection are the synchronous analogues (no `await` on `supports`).

> **Lazy-import vs probe ordering.** To probe a WASM driver we must load its (small) glue, but **not** its `.wasm` core — `supports()` answers from declared capabilities/feature-detection; the heavy `.wasm` downloads only when the driver is actually *built* for the stage. So probing the ladder stays cheap.

## 5. Caching

- Verdicts are cached by `(stage-kind, codec/mime, direction, determinism)`. Capabilities are environment-stable within a session, so one probe per distinct query suffices.
- Capability of the *environment* (does the browser have WebGPU? does WebCodecs support `hev1`?) is also cached once per session.
- `media.preload(...)` (ADR / [`07`](07-public-api.md)) warms these caches ahead of the first real call.

## 6. Determinism modifier (ADR-007)

`determinism: 'force-software'` removes the `hardware` and `gpu` tiers from candidate lists before ranking, forcing software WebCodecs / WASM / Canvas paths so output is identical across machines. Default `'auto'` keeps the full ladder.

## 7. Cost-awareness (ADR-020 — deferred)

A future refinement will let the router pick a cheaper tier for tiny inputs (where a worker/WASM spin-up costs more than it saves). The cutoffs need real measurements, so until then the **static ladder** is used and no thresholds are guessed. When added, it is a re-ranking input, not a new public knob.

## 8. Failure semantics (ADR-017)

A miss is never silent. `CapabilityError` carries `{ op, tried[], suggestion? }` — e.g. probing Vorbis decode, where no browser has a WebCodecs `AudioDecoder` and no WASM Vorbis driver is registered, yields a clear error naming what was tried and how to enable it (register the WASM Vorbis driver), rather than a wrong-but-quiet result. (FLAC decode is the opposite case — a first-party **pure-TS** driver is registered, ADR-024, so it does *not* miss.) See the known gaps in [`10-browser-capability-matrix.md`](10-browser-capability-matrix.md).
