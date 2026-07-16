# aibrush-media

A unified, **capability-routed, in-browser media engine**. One flat, verb-based API — `probe`, `demux`,
`decode`/`seek`, `encode`, `convert` (transcode), `mux`, `remux`, `trim`, `decrypt` — behind which the engine
routes every stage of every operation to the best available substrate: **hardware WebCodecs → GPU → hand-written
TypeScript → WASM (downloaded only on a hardware miss)**. You express *intent* ("convert this to Opus in
WebM"); the engine picks the mechanism. It only fails loudly, with a typed `CapabilityError`, when nothing can
do the work — never a silent wrong result.

## Why

No single in-browser engine spans all the substrates that win: hardware WebCodecs, hand-written TS containers,
the GPU for pixel filters, and a WASM tail for the codec/DSP work browsers don't cover. aibrush-media unifies
them behind one API where **the developer never names a backend**, aiming to be best-in-aggregate across a
13-family, 7-engine benchmark.

**Design principles:** intent not mechanism · pay-for-what-you-use lazy loading · correctness gated by strict
bit-exact/structural oracles · deployable by default (no cross-origin isolation on the common path; WASM
self-hosted, no CDN).

## Usage

```ts
import { createMedia, convert, probe, toOPFS } from '@aibrush/media';

// One-shot, verb-based — the engine routes WebCodecs → GPU → TS → WASM internally:
const info = await probe(file);                    // MediaInfo (tracks, codecs, duration)
const webm = await convert(file, {                 // → Blob by default
  video: { codec: 'vp9' },
  audio: { codec: 'opus' },
  container: 'webm',
});

// Or a reusable, isolated engine instance (multi-instance, SSR-safe):
const media = createMedia();
const out = await media.convert(file, { audio: { codec: 'flac' }, container: 'flac', sink: toOPFS('out.flac') });

// Every async op is cancellable:
const job = media.convert(bigFile, { video: { codec: 'av1' } });
// job.cancel();
await job;
```

Inputs (`MediaInput`) accept `Blob`/`File`, a URL, a `ReadableStream<Uint8Array>`, `ArrayBuffer`/`Uint8Array`,
a `MediaStream` (live), or OPFS handles. Outputs go to a `Sink` — `toBlob()` (default), `toFile()`,
`toStream()`, `toOPFS()`, `toElement()`, or `toStreamTarget()` for live/streaming output. Codec and container
names (`Container`, `VideoCodec`, `AudioCodec`, `PcmCodec`) are **intent tokens**, never driver ids.

## Documentation

The docs are the authoritative **target spec**. Start at
**[`docs/architecture/README.md`](docs/architecture/README.md)** for the full index — architecture spine,
per-operation family docs, container/codec drivers, the decision log, and the glossary. Locked decisions live
in [`docs/decisions/`](docs/decisions/README.md).

## Building & testing

See **[`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md)** for the Definition of Done and the per-feature loop
(ultrathink → failing validation test → implement → pass → benchmark → full gate → green commit). Validation
is **tier-split**: the pure-TS tier is validated in Node (CI); the WebCodecs/GPU/WASM tier is validated in a
browser on a target machine. The acceptance benchmark harness (13 scenario families × 7 engines) is the
sibling project [`../media-test`](../media-test).

## License

See package metadata. Third-party WASM codec cores retain their own licenses and attribution — see the
`THIRD_PARTY_NOTICES` and `BUILD.md` files under `src/codecs/wasm-*/`.
