# Runtime and capabilities

The engine routes each stage independently. Container parsing, codec execution, filtering, and output
materialization can therefore use different runtime features in one operation.

## Runtime overview

| Capability | Node.js | Browser |
| --- | --- | --- |
| Container probing and byte parsing | Yes | Yes |
| URL and Web Stream input | Yes, when platform APIs are present | Yes |
| TypeScript PCM and FLAC paths | Yes | Yes |
| `VideoFrame`, `AudioData`, codec encode/decode | Only when supplied by the runtime | WebCodecs-dependent |
| Image pixel decode | No standard `ImageDecoder` | `ImageDecoder`-dependent |
| WebGPU/Canvas video filters | No standard DOM graphics path | Browser/device-dependent |
| OPFS and media elements | No | Browser feature-dependent |
| Worker offload | Runtime-dependent; falls back inline | Explicit opt-in |

Node.js 18 is the minimum package runtime. Many metadata, packet, remux, PCM, and focused subpath
operations are browser-independent, but frame-based pipelines require actual frame and codec APIs.

## Containers

The current container vocabulary covers:

| Family | Tokens and common input aliases |
| --- | --- |
| ISO base media | `mp4`, `mov`; common input extensions include M4A/M4V |
| Matroska | `webm`, `mkv`; common input aliases include MKA |
| Ogg | `ogg` |
| RIFF media | `wav`, `avi` |
| Elementary audio | `mp3`, `aac`, `adts`, `flac` |
| PCM audio | `aiff`, `caf` |
| MPEG transport stream | `ts`, `m2ts`, `mts`, `mpegts` |

HLS is resolved as a manifest and segment source before container routing; it is not a `Container` token.
Still and animated GIF, PNG/APNG, JPEG, WebP, and AVIF are available through image inspection and decode
paths.

A recognized token does not imply that every operation or codec combination is valid. For example, a
container may be probeable but reject a requested mux track, an encoder may reject a profile or frame
size, and a streaming layout may require a fragmented output.

## Codecs

Public target tokens are:

- video: H.264, HEVC, VP8, VP9, and AV1;
- audio: AAC, Opus, MP3, FLAC, Vorbis, and the declared PCM sample formats.

The preferred browser route uses WebCodecs where the exact configuration is supported. Selected codec
families also have lazily loaded WebAssembly implementations. WASM is a fallback capability, not a
promise that every codec supports both encode and decode in every environment.

### HEVC licensing

HEVC (H.265) is covered by patent pools (MPEG LA, HEVC Advance, Velos Media). This package does
**not** bundle or redistribute an HEVC decoder or encoder in WebAssembly — all HEVC decode and
encode routes are **hardware-only via WebCodecs** where the browser and device expose
`hvc1`/`hev1` support (see `src/codecs/hevc-policy.ts` for the single source of truth, mirrored in
the generated support matrix). The underlying hardware or OS vendor provides the licensed
implementation; authors publishing HEVC bitstreams should review their own distribution licensing
obligations. Probe hardware support before encoding:

```ts
const supported = await VideoEncoder.isConfigSupported({
  codec: 'hvc1.1.6.L93.B0', // Main 8-bit L3.1
  width: 1920,
  height: 1080,
  bitrate: 5_000_000,
  hardwareAcceleration: 'prefer-hardware',
});
// or via the engine preflight
const can = await media.canConvert({ to: 'mp4', video: { codec: 'hevc', width: 1920, height: 1080, bitDepth: 8 } });
```

HEVC supports Main (8-bit) and Main10 (10-bit); other profiles are rejected with a typed
`CapabilityError` so a wrong encode is never silently produced. There is no software (WASM)
fallback to configure — use H.264, VP9, or AV1 when hardware HEVC is absent.

### AV1 licensing and routes

AV1 (AOMedia Video 1) is royalty-free (AOMedia). This package bundles a
dav1d AV1 decoder WebAssembly (`dav1d_wasm_bg.wasm`, BSD-2-Clause) for
**8-bit 4:2:0 Main profile software decode** fallback; **10-bit AV1 decode**
and **all AV1 encode** are **hardware-only via WebCodecs** where the browser
exposes `av01` support (see `src/codecs/av1-policy.ts` for the single source
of truth, mirrored in the generated support matrix). There is no bundled AV1
encoder WASM — `wasm-av1` is a dav1d decode-only fallback and rejects 10-bit
`4:2:0` and non-`4:2:0`/monochrome configs with a typed `CapabilityError` so a
wrong decode/encode is never silently produced. Probe before encoding:

```ts
const supported = await VideoEncoder.isConfigSupported({
  codec: 'av01.0.04M.08', // AV1 Main 8-bit Level 4.0
  width: 1920,
  height: 1080,
  bitrate: 3_000_000,
  hardwareAcceleration: 'prefer-hardware',
});
// or via the engine preflight
const can = await media.canConvert({ to: 'mp4', video: { codec: 'av1', width: 1920, height: 1080, bitDepth: 8 } });
```

AV1 supports Main 8-bit and Main 10-bit for encode sizing; 12-bit Professional
is rejected with a typed `CapabilityError`. Decode via dav1d is 8-bit 4:2:0
only — 10-bit, 12-bit, 4:2:2/4:4:4, and monochrome AV1 decode fall back to
hardware WebCodecs where available.

### VP8/VP9 alpha and H.264 profile handling

VP8 and VP9 carry alpha as a WebM/Matroska `BlockAdditions` side stream (`BlockAddID 1`) decoded
into an 8-bit grayscale plane and muxed via `Packet.alpha`; the colour and alpha planes are
encoded by two identically-configured VPx encoders and paired by exact PTS (see
`src/api/vpx-alpha.ts`). `alpha:'keep'` preserves that plane (VP8/VP9 only, 8-bit), `alpha:'discard'`
drops it, and any other codec with `alpha:'keep'` rejects with a typed `CapabilityError`
— alpha is never silently discarded. VP8/VP9 alpha is block-addition only; it does not imply
wider bit-depth support (alpha is 8-bit even when VP9 colour is 10-bit).

H.264 profile retention for 8-bit encode preserves Main (`avc1.4D00`) and High (`avc1.6400`),
including High10 sources (`avc1.6E…` → High) after 10→8 down-conversion; unknown/Baseline
sources keep Constrained Baseline (`avc1.42E0…`) for broadest hardware decode coverage. The
level byte is the Annex-A minimum sized to the output dimensions and floored at L3.0
(`H264_BROWSER_PLAYBACK_MIN_LEVEL_IDC`) for Chromium seek compatibility on tiny outputs (see
`src/api/codec-strings.ts`). 10-bit H.264 encode is not available — it rejects with a typed
`CapabilityError` (`use 8-bit H.264 until a High10 encode+mux path is browser-proven`) while
10-bit High10 decode remains probeable.

### Still/animated images ↔ video (GIF/PNG/JPEG/WebP/AVIF)

Still and animated images probe pure-TS via `probeImage`/`sniffImageFormat` (GIF87a/89a, PNG
`IHDR`/`acTL`, JPEG SOFn, WebP `VP8`/`VP8L`/`VP8X` + `ANIM`/`ANMF`, AVIF `ftyp`+`ispe`/`av1C`/`stsz`);
decode is browser-only via WebCodecs `ImageDecoder` where `hasImageDecoder()` is true (see
`src/codecs/image-policy.ts` for the single source of truth, mirrored in `IMAGE_POLICY`).
A still image decodes to exactly one presentation-oriented `VideoFrame` (duration 0); an
animated image decodes to its timed frame sequence with per-frame durations from container
delays. Those `VideoFrame`s flow through the shared filter graph and `VideoEncoder` (H.264/
HEVC/VP9/AV1 where hardware is available) so `image → video` and `video → image` are the same
`VideoFrame` pipeline with different endpoints. Probe with `probeImage`/`sniffImageFormat` or
`media.probe()`; preflight with `hasImageDecoder()` or `media.canConvert({ to:'mp4', video:{codec:'h264', width, height}})` before decode/convert. Where `ImageDecoder` is absent (Node), probe
remains `true` but decode/convert rejects with a typed `CapabilityError` so a wrong still is
never silently produced.

Always ask about the complete target instead of inferring support from a browser name:

```ts
const supported = await media.canConvert({
  to: 'mp4',
  video: { codec: 'h264', width: 1920, height: 1080, bitDepth: 8 },
  audio: { codec: 'aac', channels: 2, sampleRate: 48_000 },
});
```

## Capability preflight

`canConvert(options)` checks the current target container and explicit codec requests without consuming
input bytes. It resolves `false` for typed input or capability misses and does not throw for an ordinary
unsupported target.

Preflight is intentionally target-only. It cannot prove that an unknown source is valid, that the source
codec can be decoded, or that a mutable runtime will remain unchanged. Keep `CapabilityError` handling on
the real operation.

`canConvert()` is suitable for:

- enabling or hiding export choices;
- choosing between MP4/H.264/AAC and WebM/VP9/Opus;
- checking an explicit codec before a user starts a long upload;
- CI smoke checks in a target browser.

## Workers

Heavy pipeline offload is explicit:

```ts
const inline = createMedia();
const oneWorker = createMedia({ worker: true });
const workerPool = createMedia({ worker: { pool: 3 } });
```

No `worker` option means inline execution. When worker execution is requested, the engine checks both
the `Worker` constructor and the worker's media capabilities. It falls back inline if the worker cannot
run the requested media type.

The pool size is floored to an integer and clamped to at least one. A pool is most useful for concurrent
operations and H.264 ABR fan-out; one streamed conversion does not automatically split a codec pipeline
across every worker.

Your bundler must preserve module-worker URL resolution from the distributed package. Test worker mode
in the built application, not only in a development server.

## WASM assets and threads

WASM codec assets load only when routing reaches them. By default their URLs are resolved relative to the
package's emitted modules.

Set `assetBaseUrl` when your deployment copies the package's WASM files to a dedicated same-origin
directory:

```ts
const media = createMedia({
  assetBaseUrl: '/media-codecs/',
});
```

In an HTTP(S) page, the override must resolve to the same origin and cannot contain credentials. The
engine normalizes it as a directory and removes query/hash components.

Threaded WASM is used only when all required conditions are true:

- threads are not disabled by `enableThreads: false`;
- the page is `crossOriginIsolated`;
- `SharedArrayBuffer` is available;
- the selected codec has a compatible threaded asset.

Without those conditions, the engine uses the baseline single-thread profile. A typical isolated web
deployment configures these response headers for the document and required resources:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Only enable those headers after checking their effect on embedded and cross-origin resources.

## Filtering

Video geometry and color operations are routed through available browser filter paths. WebGPU can be
used when present; other browser paths may satisfy supported operations. A filter request rejects when no
implementation can meet its exact geometry, color, alpha, or deterministic-execution requirements.

PCM-native audio transforms use TypeScript processing and are available without WebCodecs. Applying the
same transforms before a compressed audio encode still requires a decoder, frame representation, and
encoder route.

## Determinism

`determinism: 'auto'` selects the best supported route. `force-software` requires an explicitly proved
non-hardware codec/filter path:

```ts
const media = createMedia({ determinism: 'force-software' });
```

Use software forcing when cross-machine reproducibility matters more than throughput. It may turn an
otherwise available operation into a `CapabilityError` if the runtime has only a hardware path.

## Preloading

`preload()` warms code chunks, codec checks, filters, and selected WASM work before the first user-visible
operation:

```ts
await media.preload({
  op: 'convert',
  container: 'webm',
  video: 'vp9',
  audio: 'opus',
  level: 'ready',
});
```

Levels are `chunks`, `compile`, and `ready`. Preload is a best-effort latency optimization: failures are
reported to `onLog` as warnings and do not replace real operation error handling.
