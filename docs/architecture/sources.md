# Input Sources (`src/sources/`)

> **Shard S06 — the input model.** This is the *target spec* (the best design) plus an honest delta
> against today's code. It governs `src/sources/*.ts`. Write code against §3; fix code against §5.

## 1. Purpose & scope

The **input model** is the substrate every operation reads its bytes (or frames) through. It answers
one question for the whole engine: *given anything a caller has — an `ArrayBuffer`, a `Blob`/`File`, a
`URL`, a one-shot `ReadableStream<Uint8Array>`, an OPFS path, an `HTMLMediaElement`, or a live
`MediaStream` — hand the rest of the engine a **uniform, codec-agnostic, offset-addressable byte
snapshot** (`Source`), or, for a raw live capture, a **separately-branded** `LiveMediaSource` that is
never pretended to be container bytes.* (`src/sources/source.ts:1`, `:59`, `:347`.)

**Benchmark families served.** "Input model" is not one of the 13 harness scenario families
(`../media-test/src/scenarios/`: audio-dsp, decode-seek, demux, encryption, metadata, mux,
performance, probe, remux, robustness, streaming-output, transcode, trim). It is the *cross-cutting
seam every one of them enters through*. It is exercised most directly by:

- **probe** and **demux** — random-access `range()` (HTTP `Range` / `Blob.slice`) is what lets a
  probe read only the header + trailing `moov`/last-Ogg-page instead of the whole file, and what makes
  the difference between winning and losing those cells: `probe/realworld_mdn_trex_mp3` went
  14.555 ms → 0.330 ms once a probe-prefix range cache landed, and rivals win the catastrophic
  probe/demux cells by *lazily* seeking the sample table without touching payload bytes
  (`measured-evidence.md`).
- **robustness** — malformed / truncated / already-locked / already-consumed inputs must fail as typed
  `InputError`/`MediaError`, never as a raw `TypeError`/`RangeError` (`measured-evidence.md` ADR-073;
  `src/sources/source.ts:195`, `src/sources/stream-input.ts:191`).
- **transcode/decode of live input** — a raw `MediaStream` decodes to caller-owned `VideoFrame`/
  `AudioData` frame streams (`src/sources/live-media.ts:177`).

The layer is **transport only**: it knows offsets, byte lengths, HTTP status codes, and stream
liveness. It knows nothing about codecs, containers, PTS/DTS, or frame cadence — those live one layer
up in the container drivers and the codec pipeline.

## 2. Spec & references

Governing standards (every claim about wire behavior traces here):

- **WHATWG Fetch Standard** — `fetch()`, `Request`/`Response`, `Headers`, `Response.body` as a
  `ReadableStream`, `Response.url` (post-redirect effective URL), request `priority`.
  <https://fetch.spec.whatwg.org/>
- **RFC 9110 (HTTP Semantics) §14 — Range Requests** — the `Range: bytes=lo-hi` request header
  (**inclusive** bounds), `206 Partial Content`, `Content-Range: bytes lo-hi/total`, and the explicit
  rule that **a server MAY ignore `Range` and answer `200` with the full body**.
  <https://www.rfc-editor.org/rfc/rfc9110#name-range-requests> ·
  `Content-Range`: <https://www.rfc-editor.org/rfc/rfc9110#name-content-range>
- **WHATWG Streams Standard** — `ReadableStream`, default reader, `getReader()`/`releaseLock()`,
  `cancel()`, and **backpressure** via the internal queue + `highWaterMark` (a `pull` source only
  produces when the consumer asks). <https://streams.spec.whatwg.org/>
- **WHATWG File System Standard (OPFS)** — `navigator.storage.getDirectory()`,
  `FileSystemDirectoryHandle.getFileHandle()`, `FileSystemFileHandle.getFile()`, and (worker-only)
  `createSyncAccessHandle()`. <https://fs.spec.whatwg.org/> · size origin:
  <https://storage.spec.whatwg.org/>
- **W3C File API** — `Blob.slice()`, `Blob.stream()`, `Blob.arrayBuffer()`, `File.name`,
  `File.webkitRelativePath`. <https://www.w3.org/TR/FileAPI/>
- **W3C WebCodecs** — `VideoFrame`/`AudioData` and their `close()` contract (each frame is a manually
  reference-counted host resource; must be `close()`d exactly once). <https://www.w3.org/TR/webcodecs/>
- **W3C Media Capture Transform** — `MediaStreamTrackProcessor` (`{ track, maxBufferSize }` →
  `.readable` of `VideoFrame`/`AudioData`), the live-input primitive.
  <https://w3c.github.io/mediacapture-transform/>
- **W3C Media Capture from DOM Elements** — `HTMLMediaElement.captureStream()` (explicit live-capture
  mode). <https://w3c.github.io/mediacapture-fromelement/>
- **WHATWG DOM — `AbortSignal`** — cancellation contract threaded through reads.
  <https://dom.spec.whatwg.org/#interface-abortsignal>

OSS exemplar to study & beat — **Remotion `@remotion/media-parser` reader model**:

- Readers directory: <https://github.com/remotion-dev/remotion/tree/main/packages/media-parser/src/readers>
- Interface source (`reader.ts`):
  <https://github.com/remotion-dev/remotion/blob/main/packages/media-parser/src/readers/reader.ts>
- Docs: <https://www.remotion.dev/docs/media-parser/readers>

Its `MediaParserReaderInterface` is `{ read, readWholeAsText, createAdjacentFileSource, preload }`,
where `read({ src, range, controller, logLevel, prefetchCache })` returns
`{ reader: { reader: ReadableStreamDefaultReader<Uint8Array>; abort() }, contentLength: number|null,
contentType: string|null, name: string, supportsContentRange: boolean, needsContentRange: boolean }`
(verbatim from `reader.ts`, verified 2026-07). Three design lessons this shard should **match or
beat** (they drive the §5 punch-list):

1. **Range support is a first-class fact.** Remotion returns `supportsContentRange` /
   `needsContentRange` explicitly; our layer signals it *structurally* by whether `range?()` is
   present. Structural is cleaner for the developer, **but** the RFC lets a server that advertises
   ranges answer `200` anyway — we must *learn and surface* whether ranges were actually honored
   (delta §5.1, open question §6.1). Our `fetchRange` already tolerates the `200` fallback
   (`src/sources/source.ts:473`); the *fact* is just not exported.
2. **Cancellation is threaded into every read.** Remotion's `read` takes a `controller`. Our
   `range()` takes **no `AbortSignal`** — the single biggest correctness gap (delta §5.2).
3. **`preload` and adjacent-file resolution are in the reader interface.** We have `preload` as
   `cacheSource().prime()` (`src/sources/cache.ts:123`) but *outside* the `Source` type, and our
   HLS/sidecar resolution lives in the engine, not as a source-level `createAdjacentFileSource`
   (open questions §6.2, §6.3).

## 3. Target design

### 3.1 Data model — one byte contract, one live brand

```ts
// src/sources/source.ts:59 — the uniform byte snapshot.
export interface Source {
  readonly __media: 'source';
  readonly kind: SourceKind;                 // 'bytes'|'blob'|'stream'|'url'|'opfs'|'element'
  stream(): ReadableStream<Uint8Array>;      // fresh each call, EXCEPT 'stream' (single-use)
  readonly size?: number;                     // absent ⇒ unknown until probed
  range?(start: number, end: number): Promise<Uint8Array>; // half-open [start,end); absent ⇒ pure stream
  readAll?(signal?: AbortSignal): Promise<Uint8Array>;     // owned single-buffer read
  readonly mimeHint?: string;
  readonly filename?: string;
  readonly [SOURCE_CACHE_KEY]?: string;       // opaque cross-op identity
  readonly [SOURCE_URL_KEY]?: string;         // effective URL after redirects
}
```

`LiveMediaSource` is a **deliberately distinct brand** (`src/sources/live-source.ts:6`):
`{ __media: 'live-source'; kind: 'media-stream'; mediaStream }`. The universal normalizer `from()`
returns `Source | LiveMediaSource` and *never* converts a live track to bytes
(`src/sources/source.ts:360`). This is the load-bearing type invariant: byte ops that cannot represent
a live source decline with a typed `CapabilityError` (`src/sources/live-media.ts:213`,
`rejectLiveByteOperation`), rather than silently recording it.

**Invariants the whole engine relies on:**

- **Immutability of a snapshot.** Every read from one `Source` object describes the *same* immutable
  bytes; a mutable URL/OPFS resource that changes requires a *new* `Source` (`source.ts:55`). A finite
  `blob:` URL plus an explicitly seeded size is the caller's assertion that URL+size names one immutable
  snapshot across short-lived Source wrappers — not an inference from the scheme. A mutable `MediaSource`
  must omit that finite cache identity or mint a new object URL / Source identity when its bytes change.
- **`range()` is half-open `[start, end)`** (JS `subarray`/`slice` semantics); the URL source
  translates it to the *inclusive* HTTP `Range: bytes=lo-(hi-1)` (`source.ts:9`, `:457`).
- **`range()` never short-reads before EOF.** A compliant `range(a, b)` returns exactly
  `min(b, size) - a` bytes. (Today this is an *inference* in the probe cache — target: a documented
  contract; delta §5.8.)
- **`size` is honest.** For a remote URL it is `undefined` until a round-trip learns it from
  `Content-Range`/`Content-Length` (`source.ts:274`); it is memoized *first-writer-wins*
  (`source.ts:384`) so a later tail-seek can clamp.

### 3.2 Seams (where the layer plugs in)

```
caller value ──from()──▶ Source | LiveMediaSource        (source.ts:360)
                          │
     ┌────────────────────┼───────────────────────────────┐
     │ range()/stream()   │ readAll()                      │ decodeLiveMediaStream()
     ▼                    ▼                                ▼
 container drivers   whole-object ops (WAV/AIFF/CAF)   live frame streams
 (probe/demux/seek)  (small finite audio)             (VideoFrame/AudioData)
```

Three bounded reuse seams wrap a `Source` without changing its type:

- **`CachingSource` (opt-in, public)** — `cacheSource(src|url)` → coalescing in-memory range cache +
  `prime()` preload; **never on the default path** (`src/sources/cache.ts:72`, `:123`).
- **Per-engine probe-range reuse (implicit)** — `cacheRepeatedProbeRangesFor(engine, src)` gives one
  engine bounded (≤8 intervals, ≤1 MiB, 60 s TTL) byte reuse across repeated probes of the *same*
  source object (`src/sources/probe-range-cache.ts:222`, `:25`). Wired in `api/engine.ts` probe path
  only, behind `range !== undefined`.
- **Finite blob-URL prefix handoff (implicit)** — an explicitly sized URL Source whose internal key is
  the same `blob:` URL may reuse an owned start-at-zero prefix across fresh Source wrappers in one engine.
  Admission is bounded to ≤1 MiB per entry, eight entries / 8 MiB total, and an absolute ≤250 ms lifetime;
  hits update only LRU order and never extend expiry. This relies on the immutable-snapshot assertion above.
  Unknown-size blob URLs, ordinary HTTP URLs, and mutable `MediaSource` identities do not enter this path.

The `ByteSource` the drivers consume (`src/contracts/driver.ts:184`) is the *structural subset*
`{ stream(); size?; range?(); readAll?() }` — drivers never see `MediaInput`, the constructors, or the
brands. That is the correct capability boundary: **no driver, codec, or backend name appears in this
layer, and no `MediaInput`/DOM/live type leaks down into a driver.**

### 3.3 Capability routing (WebCodecs → GPU → WASM, miss-only)

This layer is **below** codec routing, so it carries no codec ladder of its own — but it embodies the
same *fail-loud-on-a-true-miss* philosophy at the **transport** tier:

- **Native fast path first.** Random access prefers the platform primitive: HTTP `Range` for URLs
  (`source.ts:442`), `Blob.slice()` for Blob/File/OPFS (`source.ts:162`), `subarray` for in-memory
  bytes (`source.ts:139`). A URL that answers `200` to a `Range` request degrades *gracefully* to a
  local slice of the full body — never an error (`source.ts:473`).
- **Miss-only heavier work.** A pure `ReadableStream` with no `range()` is *not* eagerly buffered; it
  is materialized once only when an op genuinely needs whole bytes or a re-read (`cache.ts:147`,
  `:198`). Direct-stream input explicitly **rejected** full-buffer-before-routing and `tee()` and uses
  one memoized abort-aware materialization (`measured-evidence.md`, session12-readable-stream-input).
- **True miss → typed `CapabilityError`.** No OPFS in this realm (`opfs.ts:7`), no
  `MediaStreamTrackProcessor`/`VideoFrame`/`AudioData` (`live-media.ts:66`, `:446`), no
  `captureStream()` (`live-source.ts:28`) each raise a `CapabilityError('capability-miss', …)` with
  `{ op, tried }` — never a silent `undefined`.

### 3.4 Edge cases (mandatory treatment)

- **B-frames — N/A.** This layer is codec-agnostic; it addresses *byte offsets*, not decode order.
  B-frame reordering is entirely a demuxer/decoder concern (S09/S10).
- **VFR — N/A at the byte layer.** Variable frame rate is a timeline fact discovered by the container
  driver from timestamps; a byte `Source` has no notion of frames. (The *live* path is the one place
  cadence appears: `probeLiveMediaStream` reports `fps` only when the track advertises it and reports
  `durationSec: Infinity` for an unbounded source — `live-media.ts:104`, `:115`.)
- **Seek → byte-range seek.** "Seek" here means random access: a demuxer seeking to a keyframe or to a
  trailing `moov` calls `range(offset, offset+n)`. This is the whole reason `range()` exists and the
  hot path the harness measures. Target behaviors, all currently proven by measurement (`measured-evidence.md`):
  targeted moov+keyframe reads beat bulk/prefix fetch for large-file seek; tiny known-full windows use
  **high-priority `Range`** not plain GET (`source.ts:459`; ADR-315); a `206` reply learns and memoizes
  the total for future clamps (`source.ts:466`). Read coalescing/read-ahead (256 KiB windows, 8 MiB
  cap, 256 KiB gap-bridge; ADR-052) currently lives in the *drivers* — see delta §5.10 for whether it
  belongs here.
- **Cancel.** Every read path is (or must become) abort-aware. Today: `peekSourceHead(src, n, signal)`
  and `cancelSource(src, reason)` (`source.ts:219`, `:236`); the one-shot stream cursor races
  `reader.read()` against the signal and cancels on abort (`stream-input.ts:195`, `:66`); `readAll`
  forwards its signal (`source.ts:429`); live `dispose()` cancels the reader and closes any late frame
  (`live-media.ts:294`). **Gap:** `range()` takes no signal, so an in-flight range fetch cannot be
  aborted (delta §5.2).
- **Frame lifetime (`close()` exactly once) — only the live path produces frames.** Byte sources emit
  `Uint8Array`, never `VideoFrame`/`AudioData`, so the rule is vacuous for them. `live-media.ts` owns
  the whole contract: on **every** non-enqueue exit — abort, track-ended, timestamp regression, wrong
  frame type, enqueue failure — it calls `closeUntransferred(value)` exactly once and only once
  (`live-media.ts:357`, `:363`, `:376`, `:387`, `:394`); once `controller.enqueue(value)` succeeds the
  *consumer* owns the frame and this layer must not close it (`live-media.ts:394`); `dispose()` drains
  the concurrently-pending read and closes a late frame so a cancel racing a read never leaks
  (`live-media.ts:301`, `:307`). Regressing/non-finite timestamps are a typed `decode-error`, not a
  silent drop (`live-media.ts:379`).
- **Backpressure.** Byte sources inherit Streams-native backpressure: a `pull` source only fetches the
  next chunk when the consumer reads (`source.ts:399`). The one-shot replay stream opens at
  `highWaterMark: 0` so prefix replay pulls one retained chunk at a time (`stream-input.ts:151`). The
  live path is the strict case — a real-time producer that cannot be told to slow down — so it uses
  `MediaStreamTrackProcessor({ maxBufferSize: 1 })` inside a `highWaterMark: 0` stream: the processor
  buffers at most one frame and the reader pulls exactly one at a time; `MediaRecorder`, canvas
  polling, and `ScriptProcessor`/`AudioWorklet` recorders were all rejected precisely because they
  cannot apply backpressure to a live graph (`live-media.ts:275`, `:414`; `measured-evidence.md`,
  session12-live-media-input).

## 4. Current state (what exists today)

| File | Lines | Responsibility |
|------|------:|----------------|
| `source.ts` | 515 | Types (`MediaInput`, `Source`), 6 constructors, universal `from()`, **and** the low-level fetch transport (`fetchStream`/`fetchWhole`/`fetchRange`) + header parsers |
| `live-media.ts` | 533 | Live probe (`probeLiveMediaStream`), `liveTrackInfo`, `decodeLiveMediaStream`, per-track frame pump |
| `cache.ts` | 312 | `CachingSource`/`RangeCache` — public opt-in coalescing range cache + `prime()` |
| `stream-input.ts` | 240 | One-shot stream prefix-replay cursor + cancel (ADR-231) |
| `probe-range-cache.ts` | 229 | Bounded per-engine exact-source range reuse (ADR-246) |
| `live-source.ts` | 80 | `LiveMediaSource` brand + guards |
| `url-size.ts` | 42 | `probeUrlSizeImpl` (HEAD → `bytes=0-0` GET) |
| `opfs.ts` | 25 | `fromOPFSImpl` (wraps `fromBlob`, relabels `kind:'opfs'`) |

**God-files.** `source.ts` (515 lines) fuses three concerns that should be three modules: the *type
model* + *normalizer* (`from`, `isSource`, the constructors, `source.ts:115`–`:374`), and the *HTTP
transport* (`fetchStream` `:392`, `fetchWhole` `:424`, `fetchRange` `:442`, `parseContentLength` `:491`,
`parseContentRangeTotal` `:499`). `live-media.ts` (533 lines) fuses live *probe/track-info* with the
live *frame pump*.

**Module-global mutable state.** `probe-range-cache.ts:30`:
`const cachesByOwner = new WeakMap<object, WeakMap<Source, ProbeRangeCacheState>>()` — a *module-level*
cache keyed on the engine instance, plus a module-level `DEFAULT_OPTIONS` (`:25`). It is WeakMap-keyed
so it does not leak memory, but it is still process-global mutable state that an engine instance should
own as a field.

**Layering smells / capability boundary:**

- **Upward dependency (sources → api).** `live-media.ts:3` imports `MediaInfo`, `MediaInfoTrack`,
  `MediaStreams` from `../api/types.ts` and `TrackInfo` from `../contracts/driver.ts`. The *byte*
  sources layer stays clean; the *live* code reaches **up** into the api/contracts layer, so
  `src/sources` is not import-below-only.
- **Two interval engines.** `cache.ts` (coalesce-to-one-contiguous-run, `:250`) and
  `probe-range-cache.ts` (bounded LRU+TTL interval list, `:97`) each hand-roll interval
  insert/slice/coalesce. Two implementations of the same primitive.
- **Duplicated header parsers.** `parseContentLength`/`parseContentRangeTotal` exist **verbatim** in
  both `source.ts:491`/`:499` and `url-size.ts:27`/`:34`.
- **Fragile wrapper.** `probe-range-cache.ts:181` clones via object spread `{ ...src }`, which snapshots
  getters and drops the live `size`/`SOURCE_URL_KEY` behavior — so `preserveLiveSourceFacts` re-pins
  those two by hand with `Object.defineProperties` (`:141`). Any *new* getter/symbol field on `Source`
  (or a future non-enumerable field) is silently dropped by this pattern.
- **Duplicated `readAll` across drivers.** `Source.readAll?` is implemented only for `url`/`element`
  (`source.ts:288`, `:329`); every container driver (caf/wav/ogg/adts/aiff/webm/flac/mp3/mpegts/avi)
  re-implements a local `readAll(ByteSource)` that drains `stream()`, duplicating `cache.ts:295`
  `drain()`.
- **Cancel gap in `range()`.** `Source.range(start, end)` and `ByteSource.range` have no `AbortSignal`
  (`source.ts:67`, `contracts/driver.ts:187`); `peekSourceHead` calls `src.range(0, bounded)` and only
  checks `aborted` *after* it resolves (`source.ts:227`); `fetchRange` never binds a signal
  (`source.ts:442`).

What is genuinely good and should be preserved: the strict `Source`/`LiveMediaSource` brand split; the
one-shot prefix-replay cursor with a `pendingPeeks` guard that forbids opening the body mid-peek
(`stream-input.ts:118`); high-priority tiny-window `Range` (`source.ts:459`); first-writer-wins
size memoization (`source.ts:384`); and the exactly-once live frame close discipline.

## 5. Delta / punch-list (ordered)

Each item: the change, the `path:line`, and the oracle that proves it.

1. **Surface whether ranges were honored.** Add a learned `rangesHonored?: boolean` fact (set `false`
   the first time a `Range` request returns `200`, `source.ts:473`). Higher layers use it to skip
   range-based seek planning on a non-compliant server (RFC 9110 §14; `measured-evidence.md`).
   *Acceptance:* mock a server that answers `200` to `Range`; assert `range(4, 8)` still returns the
   correct 4 bytes **and** the source reports `rangesHonored === false`; a compliant `206` server
   reports `true`.

2. **Thread `AbortSignal` through `range()`.** Extend `Source.range(start, end, signal?)` and
   `ByteSource.range` (`source.ts:67`, `contracts/driver.ts:187`); bind it into `fetchRange`
   (`source.ts:442`) via `fetch(href, { signal, … })`; pass the caller signal from `peekSourceHead`
   (`source.ts:227`) and from the probe-cache range (`probe-range-cache.ts:183`).
   *Acceptance:* behind a never-resolving `fetch` mock, call `fromURL(u).range(0, 16, signal)` then
   `signal.abort()`; assert the promise rejects with `MediaError('aborted')` **and** the `fetch` init
   received an already/soon-aborted signal (spy on `init.signal`).

3. **Replace the spread+redefine wrapper with a forwarding wrapper.** In `probe-range-cache.ts`, stop
   cloning `{ ...src }` (`:181`) + `preserveLiveSourceFacts` (`:141`); delegate via a wrapper that
   forwards *every* own key, symbol, and getter of the wrapped `Source`, overriding only `range`.
   *Acceptance:* wrap a `fromURL` source, then on the **original** learn a redirect and a size via a
   range read; assert `wrapped[SOURCE_URL_KEY]` equals the redirected URL, `wrapped.size` equals the
   learned size, `wrapped[SOURCE_CACHE_KEY] === src[SOURCE_CACHE_KEY]`, and `wrapped.readAll` is the
   original's — all without listing fields by hand.

4. **De-duplicate the header parsers.** Extract `parseContentLength`/`parseContentRangeTotal` into one
   internal module (e.g. `sources/http-range.ts`); import from both `source.ts` (`:491`/`:499`) and
   `url-size.ts` (`:27`/`:34`).
   *Acceptance:* `grep` finds exactly one definition of each; a unit test drives the shared parser over
   `bytes 0-0/1234` → 1234, `bytes 0-0/*` → undefined, `` (missing) → undefined, `abc` → undefined.

5. **One canonical whole-read helper; delete per-driver `readAll`.** Add
   `readAllBytes(src, signal?)` in the sources layer preferring `src.readAll?` → `src.range(0, size)`
   → `drain(src.stream())` (mirroring `cache.ts:207`); replace the 10+ driver-local `readAll`
   duplicates (caf/wav/ogg/adts/aiff/webm/flac/mp3/mpegts/avi).
   *Acceptance:* a source exposing `readAll` is drained via that fast path (spy shows `stream()` never
   called); a pure stream is drained via the generic path; both yield identical bytes + checksum.

6. **Implement `readAll` for `bytes`/`blob`/`opfs`.** Only `url`/`element` have it today
   (`source.ts:288`, `:329`). `fromBytes` returns its owned buffer in one call; `fromBlob`/`fromOPFS`
   via `blob.arrayBuffer()`. Backs the measured whole-read win (`measured-evidence.md`, one plain full read beat
   multi-pull concatenation).
   *Acceptance:* `fromBlob(b).readAll()` returns exactly `b`'s bytes and never constructs a
   `getReader()` (spy); checksum matches a `drain(stream())` baseline.

7. **Move the live decode path out of `src/sources`.** Relocate `probeLiveMediaStream`/`liveTrackInfo`/
   `decodeLiveMediaStream` (which import `../api/types.ts`, `live-media.ts:3`) into an `api/live-*.ts`
   module, leaving only the `LiveMediaSource` brand + `fromMediaStream`/guards in `src/sources`.
   *Acceptance:* a dependency-lint rule forbids `src/sources/**` importing `src/api/**`; the rule
   passes; existing live tests still green.

8. **Make "range never short-reads before EOF" a contract, not an inference.** The probe cache infers
   EOF from `start === 0 && bytes.byteLength < requestedEnd` (`probe-range-cache.ts:196`, `:209`).
   Document the invariant on `Source.range` and assert it across all constructors.
   *Acceptance:* a conformance test calls each constructor's `range(a, b)` with `b > size` and asserts
   the length equals `size - a`; a separate test proves a *mid-file* short read is **not** treated as
   EOF (only `start === 0` learns size).

9. **Give the per-engine probe cache to the engine as an instance field.** Replace the module-global
   `cachesByOwner` WeakMap (`probe-range-cache.ts:30`) with per-engine ownership (the engine passes its
   own `WeakMap<Source, ProbeRangeCacheState>`), removing module-level mutable state.
   *Acceptance:* two engines probing the same `Source` object keep independent cache state; disposing an
   engine drops its cache with no module-level residue (assert via a fresh cache map per engine).

10. **Decide the home of read coalescing / read-ahead.** The 256 KiB read-ahead + 8 MiB-window / 256
    KiB gap-bridge coalescing (ADR-052; `measured-evidence.md`) lives in the drivers today
    (`mp4-driver.ts`, etc.). Evaluate hoisting a *policy-free* coalescing decorator into the sources
    layer so every driver inherits it (as `CachingSource` already coalesces, `cache.ts:250`).
    *Acceptance:* an ADR is logged with the chosen owner; if hoisted, a demux over a URL source issues
    the coalesced window count the ledger expects (e.g. 256 KiB coalescing → the recorded window/byte
    totals) with no per-driver read loop.

11. **Bind `fetchStream` to a signal.** `fetchStream` (`source.ts:392`) fires `fetch(href)` with no
    signal, so aborting the returned stream before the first chunk cannot cancel the initial request.
    Thread the consumer's signal into the `fetch`.
    *Acceptance:* abort during `pull()` before the first chunk arrives → the stream errors aborted and
    the `fetch` init carried the signal (spy).

## 6. Open questions (→ decision log)

1. **Structural vs explicit range capability.** Keep signaling range support by the *presence* of
   `range?()`, or add an explicit learned `rangesHonored`/`needsContentRange` (Remotion's
   `supportsContentRange`/`needsContentRange`)? RFC 9110 §14 permits a server to ignore `Range`; a
   higher layer that plans a tail-seek needs to know it was *actually* honored. (Feeds delta §5.1.)

2. **Adjacent-file resolution.** Adopt Remotion's `createAdjacentFileSource` at the source layer for
   HLS/DASH sidecar segments, or keep segment resolution in `api/engine.ts` (`#resolveHlsInput`) above
   the source layer? Today the source layer has no "resolve a sibling relative to me" primitive.

3. **One preload owner.** We have two overlapping warm/reuse mechanisms: public opt-in
   `cacheSource().prime()` (`cache.ts:123`) and implicit per-engine `probe-range-cache`
   (`probe-range-cache.ts:222`) with different lifetimes and interval policies. Should preload be a
   single first-class capability (a `preload()`/`prime()` on the `Source`-decorator, mirroring
   Remotion's `preload` interface member), with one interval engine underneath (also resolves delta
   §5.9)?

4. **OPFS random-access fast path.** `fromOPFS` reads via `Blob.slice()` (`opfs.ts:10`), re-touching the
   file per range. In a worker, `FileSystemFileHandle.createSyncAccessHandle().read(buf, { at })` gives
   cheaper scattered reads. Adopt it (worker-only, main-thread falls back to blob)? *(Perf benefit
   UNVERIFIED — needs a benchmark on scattered OPFS reads.)*

5. **Multi-track live input.** A `MediaStream` carrying more than one track of a kind is a typed
   `InputError` (`live-media.ts:226`; `measured-evidence.md`). Confirm we never expose multi-track live (e.g.
   multi-cam / multi-mic) — log the decision and its rationale (`MediaStreams` has one slot per kind).

6. **Cross-call size memoization.** Two ordinary HTTP `fromURL()` calls to the same href each learn
   `size` independently; the finite blob-URL handoff is the narrow immutable-snapshot exception. Should
   an engine memoize `probeUrlSize` results for other hrefs within its lifetime to save a round-trip, and
   if so what explicit validator prevents mutable-URL staleness?
</content>
</invoke>
