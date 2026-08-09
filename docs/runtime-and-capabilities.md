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
