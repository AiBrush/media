# Sinks & Streaming Output (S07)

> Target spec for the `streaming-output` benchmark family. This is the **best** design plus an
> honest delta versus today's code. Every claim traces to `path:line` or a cited external source.
> Owned code: `src/sinks/*.ts` (`sink.ts`, `materialize.ts`, `stream-target.ts`,
> `stream-target-materialize.ts`, `opfs-target.ts`, `element-materialize.ts`);
> `src/api/deferred-stream-cleanup.ts`; `src/api/streaming-webm-remux.ts`.

## 1. Purpose & scope

A **sink** answers one question: *where do an op's produced bytes go?* Every op in the engine emits a
`ReadableStream<Uint8Array>`; the sink layer is the thin, driver-agnostic tail that drains that stream
to a destination and returns whatever the caller asked for. A sink is a small immutable descriptor —
never an object with behavior — and a lazily-loaded *materializer* turns the descriptor plus the byte
stream into the final `Output` (`src/sinks/sink.ts:10`, `src/sinks/sink.ts:26`).

Sinks fall into two classes:

- **Buffering sinks** collect the whole output into one buffer: `toBlob()` / `toFile()`
  (`src/sinks/sink.ts:31`, `src/sinks/sink.ts:35`). Correct and fast for a *faststart* MP4, but they
  defeat a streaming producer whose entire point is bounded memory.
- **Streaming sinks** write each produced chunk straight to a caller-owned destination as it is
  produced, so peak memory stays at one chunk regardless of total output size: `toStreamTarget()` over
  a `WritableStream`/callback (`src/sinks/stream-target.ts:17`), the public OPFS path (`toOPFS()`
  `src/sinks/sink.ts:43`; backed by the richer internal `OpfsTarget` descriptor in
  `src/sinks/opfs-target.ts:54`), and the media element MSE path
  (`toElement(el, { via: 'mse' | 'stream' })` `src/sinks/sink.ts:47`).

This shard serves the **`streaming-output`** benchmark family (`../media-test/src/scenarios/streaming-output/`).
That family measures, per case, `bytesOut`, `peakMemory` (the buffer-vs-stream discriminator),
`targetWrites` (write granularity), and the headline **`timeToFirstByte` (TTFB)** — a streaming
target's whole reason to exist is that the first bytes leave the engine *before* `finalize()`, whereas
a buffer target emits its first byte only at the end
(`../media-test/src/scenarios/streaming-output/ttfb.ts:1`,
`../media-test/src/scenarios/streaming-output/_shared.ts:64`). Cases span buffer vs streaming target,
fragmented/CMAF MP4, MPEG-TS tiny writes, and headerless/live WebM.

Scope boundary: this layer moves **opaque bytes**. It does not know codecs, containers, PTS/DTS, or
frames. The muxer upstream (S14/S23/S24) decides *what* bytes and *in what order*; the sink decides
*where they land and how backpressure/cancel flow back*. The one exception this shard owns is
`streaming-webm-remux.ts`, a streaming remux *producer* that feeds a WebM/MKV streaming muxer — it is
in scope because it is the concrete producer paired with these streaming sinks, and it is the current
home of a layering leak (§4).

## 2. Spec & references

- **WHATWG Streams Standard** — `WritableStream`, the underlying sink contract
  (`write`/`close`/`abort`), `ReadableStream.pipeTo`, and backpressure via `desiredSize`/`ready`. This
  is the governing standard for the streaming-sink drain path.
  <https://streams.spec.whatwg.org/>
- **WHATWG File System Standard** — Origin Private File System (OPFS), `FileSystemFileHandle.createWritable`,
  and `FileSystemWritableFileStream` (`write`/`seek`/`truncate`/`abort`), the durable streaming target.
  <https://fs.spec.whatwg.org/> · createWritable options
  (`keepExistingData`): <https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable>
- **ISO/IEC 14496-12 (ISO Base Media File Format), §8.8 movie fragments** — `moof` + `mdat` media
  segments and `mfra`; the container grammar that makes MP4 output streamable (init segment, then one
  fragment per keyframe run). <https://www.iso.org/standard/83102.html>
- **ISO/IEC 23000-19 (CMAF, Common Media Application Format)** — the constraints on fragmented MP4 that
  make each media segment independently decodable (a fragment begins at a keyframe).
  <https://www.iso.org/standard/85623.html>
- **Matroska / WebM + RFC 8794 (EBML)** — the EBML *unknown-size* element used for live, headerless
  WebM: an open-ended `Segment` streamed as top-level `Cluster`s. <https://www.rfc-editor.org/rfc/rfc8794>
  · WebM byte stream (MSE): <https://www.w3.org/TR/mse-byte-stream-format-webm/>
- **W3C Media Source Extensions (MSE)** — `MediaSource`, `SourceBuffer.appendBuffer`, `endOfStream`;
  the browser-side streaming sink into a `<video>`/`<audio>` element.
  <https://www.w3.org/TR/media-source-2/>
- **Time to First Byte (TTFB)** — the streaming metric this family ranks on. Not a media spec; a web
  performance metric. <https://developer.mozilla.org/en-US/docs/Glossary/Time_to_first_byte>
- **OSS exemplar — mediabunny `StreamTarget`** (`Vanilagy/mediabunny`, `src/target.ts`):
  <https://github.com/Vanilagy/mediabunny/blob/main/src/target.ts> · guide:
  <https://mediabunny.dev/guide/writing-media-files>. Its shape is the reference this design is measured
  against (§3).

### What the exemplar does (and where SOTA must match/beat it)

mediabunny's `Target` hierarchy separates `BufferTarget` (whole output in an `ArrayBuffer`) from
`StreamTarget` (writes to a `WritableStream`). Its chunk type is **position-addressed**:

```ts
// mediabunny src/target.ts (verbatim)
export type StreamTargetChunk = {
  type: 'write';
  data: Uint8Array<ArrayBuffer>;
  position: number;
};
export type StreamTargetOptions = {
  chunked?: boolean;
  chunkSize?: number;
  writeChunkBytes?: number;
};
```

Four properties matter for our design:

1. **Position is the producer's intended byte offset, not a running append counter.** mediabunny's docs
   are explicit: *"some byte regions in the output file may be written to multiple times"* — the muxer
   may re-write a header/box after the fact, so the sink must honor `position`. Only append-only formats
   guarantee `position == sum(previous chunk lengths)`.
2. **`chunked` mode** coalesces writes into ≥`chunkSize` (default 16 MiB) buffers in memory to cut write
   frequency — a knob trading peak memory for fewer `targetWrites`.
3. **Backpressure** is native: it checks `desiredSize <= 0` and awaits the writer's `ready`, which
   propagates through the `Output` to throttle the encoders.
4. **Exact transport writes are a separate contract from coalescing.** `writeChunkBytes` reshapes
   arbitrary producer chunks into strictly fixed-size awaited writes. It rejects a short final run
   instead of weakening the promise; this is what makes packet-aligned transports such as 188-byte
   MPEG-TS observable and testable.

Our design matches #1–#3 and adds #4 while keeping the ergonomics backend-free: the caller provides a
`WritableStream` or callback, and the descriptor selects raw, coalesced, or exact-sized writes.

## 3. Target design

### 3.1 Data model — descriptor vs materializer

A sink is a discriminated union of **immutable descriptors** carried through the eager kernel; the byte
writer is loaded lazily on first materialization so descriptor-only apps never pull the writer into the
default entry closure (`src/sinks/sink.ts:10`, `src/sinks/sink.ts:55`). The union today
(`src/sinks/sink.ts:10`):

```ts
export type Sink =
  | { readonly kind: 'blob' }
  | { readonly kind: 'file'; readonly name: string }
  | { readonly kind: 'stream' }
  | { readonly kind: 'opfs'; readonly path: string }
  | { readonly kind: 'element'; readonly el: HTMLMediaElement; readonly via: 'blob' | 'mse' | 'stream' }
  | StreamTarget;
```

The materializer is a single exhaustive `switch (sink.kind)` returning the typed `Output`
(`Blob | File | ReadableStream<Uint8Array> | undefined`, `src/sinks/sink.ts:26`), with `assertNever`
on the default arm to force compile-time exhaustiveness when a variant is added
(`src/sinks/materialize.ts:17`, `src/sinks/materialize.ts:72`).

The streaming destination model (`src/sinks/stream-target.ts:5`) is the SOTA seam:

```ts
export type StreamTargetWriter = (chunk: Uint8Array, position: number) => void | Promise<void>;
export type StreamDestination = WritableStream<Uint8Array> | StreamTargetWriter;
```

Accepting **both** a native `WritableStream` (OPFS `FileSystemWritableFileStream`, a `fetch` upload
body, a `TransformStream` tee) and a plain position-aware callback is the right shape: the
`WritableStream` arm delegates backpressure/cancel to the platform, and the callback arm is the minimal
surface the benchmark's `CountingTarget` uses to record `targetWrites` and first-byte time. **Design
rule:** the callback's `position` must be the producer's intended offset (see §5 item 2), matching
mediabunny's `StreamTargetChunk.position`.

### 3.2 Seams & capability routing

Sinks sit at the **very end** of the pipeline and are almost entirely capability-free: moving bytes to
a `WritableStream` or a callback needs no hardware, no GPU, no WASM. The WebCodecs→GPU→WASM(miss-only)
routing that governs the rest of the engine therefore applies to the **producer** upstream (the
muxer/encoder), not to the drain. The developer never names a sink backend for that reason — they say
`toStreamTarget(writable)` / `toOPFS(path)` / `toElement(el, { via: 'mse' })` and the materializer
picks the concrete drain.

Where a sink *does* touch a platform capability it must **fail loudly with a typed error**, never
silently downgrade:

- OPFS absent (`navigator.storage.getDirectory` missing) ⇒ `CapabilityError('capability-miss', …)`
  from the shared OPFS materializer. The public `toOPFS()` descriptor and internal rich `OpfsTarget`
  descriptor deliberately route through the same seam and therefore have identical miss behavior.
- MSE absent / MIME unsupported / `srcObject` MediaProvider unsupported ⇒ typed `CapabilityError` via
  `elementCapability(...)` (`src/sinks/element-materialize.ts:514`); it must **not** fall back to a
  whole-file Blob (silent buffering would defeat the streaming request — measured-evidence.md session12-element-sinks).
- A `stream-target` destination that is neither a `WritableStream` nor a function ⇒ `CapabilityError`
  (`src/sinks/stream-target-materialize.ts:41`).

**Bounded-memory invariant (the family's whole point):** a streaming sink only delivers bounded peak
memory when paired with a *streaming-capable muxer*. Fragmented/CMAF MP4 emits an init segment followed
by `moof`+`mdat` runs. Non-fragmented MP4/MOV can instead use `faststart:'reserve'`: the writer reserves
a bounded `moov` region from the caller's per-track `maximumPacketCount`, writes `mdat` payload forward,
then patches `moov` plus a valid `free` remainder into the reserved range through a positioned sink.
Ordinary in-memory faststart still buffers upstream and is intentionally a different mode. Live WebM
uses an unknown-size EBML `Segment`; finite WebM remux precomputes a definite Segment size from packet
metadata and streams contiguous clusters. These are producer guarantees—the sink never pretends an
upstream whole-file buffer is streaming.

### 3.3 Edge cases

- **B-frames.** Not applicable at the byte-drain layer — a sink moves opaque bytes and never reorders.
  The one producer this shard owns handles it correctly: `streaming-webm-remux.ts` orders packets by
  **decode** time (`packetDecodeTimeUs` = `dtsUs ?? chunk.timestamp`,
  `src/api/streaming-webm-remux.ts:56`; k-way merge by decode time at
  `src/api/streaming-webm-remux.ts:113`), because a WebM `SimpleBlock` carries only presentation time +
  a keyframe flag, so a reordered (B-frame) source must be laid down by DTS even though each block's
  timecode is PTS (`src/drivers/webm/ebml-write.ts:363`). Composition-offset preservation for MP4
  fragments lives in the muxer (S23), not here.
- **VFR (variable frame rate).** Handled by carrying an explicit per-packet `durationUs` rather than
  assuming a fixed fps (`src/api/streaming-webm-remux.ts:366`), and by choosing fragment boundaries on
  keyframes/block-count caps, never on a frame-rate assumption (ADR-091, measured-evidence.md). The byte sinks
  themselves are duration-agnostic.
- **Seek / positioned writes.** Ordinary output is append-only, but reserved faststart must patch an
  earlier byte region after streaming `mdat`. Producers tag such chunks with their intended offset.
  A callback receives that offset verbatim; `OpfsTarget` and seekable writable destinations perform an
  explicit positioned write; an append-only `WritableStream` rejects a discontinuity with a typed
  `CapabilityError`. Untagged chunks retain the common `position == Σ previous lengths` behavior.
- **Cancel.** Every sink must cancel the source reader *and* abort the destination, and surface a typed
  `MediaError('aborted', …)`:
  - `WritableStream` arm: `runToSink` aborts both source and sink on a pre-aborted signal and pipes with
    the native `{ signal }` otherwise (`src/kernel/executor.ts:120`, `src/kernel/executor.ts:129`).
  - callback arm: `writeToCallback` races each read/write against the signal so a stalled writer cannot
    pin the op forever, then `reader.cancel(err)` on abort/throw (`src/sinks/stream-target-materialize.ts:52`,
    `src/sinks/stream-target-materialize.ts:97`).
  - OPFS: an abort or write failure calls `writable.abort()` so a half-written file is discarded rather
    than left looking complete (`src/sinks/opfs-target.ts:194`).
  - element/MSE: a per-attachment `AbortController` session; a newer attachment aborts the prior one,
    and failure aborts an in-flight `SourceBuffer` append (`src/sinks/element-materialize.ts:56`,
    `src/sinks/element-materialize.ts:142`).
- **Frame lifetime (`VideoFrame`/`AudioData` `close()` exactly once).** Not applicable to the byte
  sinks — they drain `Uint8Array`, never decoded frames; `streaming-webm-remux.ts` drains
  byte-backed `Packet`s (encoded chunks), which need no `close()`. The **one** boundary where a frame
  could leak is the deferred/lazy producer path: when a cancel arrives after a deferred stream has
  already produced one value but before a reader drains it, `closeThenCancelDeferredStream` claims that
  single queued value and calls `closeValue` on it *before* `reader.cancel`, so exactly one buffered
  frame is closed and not double-closed (`src/api/deferred-stream-cleanup.ts:32`,
  `src/api/deferred-stream-cleanup.ts:33`; wired at `src/api/engine.ts:1897`).
- **Backpressure.** Bounded to one chunk in flight on every arm. `WritableStream`/OPFS: native
  `pipeTo` backpressure (`src/kernel/executor.ts:129`, `src/sinks/opfs-target.ts:190`). Callback:
  `await` the callback's returned promise, so a slow writer throttles the reader
  (`src/sinks/stream-target-materialize.ts:92`). MSE: `await` `updateend` before the next append
  (`src/sinks/element-materialize.ts:359`). This matches mediabunny's `desiredSize<=0 → await ready`
  and is why the freshly-measured `peakMemory` stays flat for streaming targets (measured-evidence.md).

## 4. Current state

What exists today, with precise citations. The streaming-sink machinery is position-aware,
backpressured, and reachable from the public API; remaining work is primarily architectural cleanup
outside the benchmark contract.

**Descriptor + materializer (good).** `src/sinks/sink.ts` owns the union and lazy loader
(`sink.ts:10`, `sink.ts:55`); `src/sinks/materialize.ts` owns the exhaustive `switch` with
`assertNever` (`materialize.ts:17`, `materialize.ts:72`). `blob`/`file` collect via `collect`
(`materialize.ts:22`); `stream` hands the readable back untouched (`materialize.ts:19`); `opfs` streams
via `writeOpfs` → `runToSink` (`materialize.ts:29`, `materialize.ts:69`); `stream-target` delegates to
`writeToStreamTarget` (`materialize.ts:43`); `element` lazy-loads `writeElement` and cancels an unlocked
stream on failure (`materialize.ts:32`).

**`StreamTarget` (position-aware and backpressured).** `src/sinks/stream-target.ts` owns the descriptor,
producer-position tag, pure write plan, and lazy wrapper. `src/sinks/stream-target-materialize.ts` owns
the common positioned pump and destination-specific emitters. Callbacks receive producer-intended
positions verbatim; seekable writables receive explicit positioned writes; append-only writables reject
non-contiguous output with a typed `CapabilityError`. The same pump provides optional bounded
coalescing and strict fixed-size writes without allowing more than one outstanding destination write.

**`OpfsTarget` (wired and shared).** `src/sinks/opfs-target.ts` owns the advanced descriptor and pure
`parseOpfsPath`/`planOpfsWrite` core; `opfs-target-materialize.ts` owns the guarded browser seam with
`seek`/`keepExistingData`/`position` and abort-on-failure. `OpfsTarget` is a member of `Sink`,
`materialize` routes it, and the default entry exports the compact `toOPFS()` constructor, which
delegates to the same writer with replace-file semantics. The richer source-level constructor stays
off the eager default entry so ordinary imports do not carry its planning code. Product tests drive
the shared materializer through directory creation, `createWritable({keepExistingData:true})`, and a
nonzero positioned write.

**Element/MSE sink (good, with module-global state).** `src/sinks/element-materialize.ts` is a large
(529-line) but cohesive module: blob-URL whole-file, and MSE/`srcObject` streaming with a proper
`sourceopen`→`addSourceBuffer`→`appendBuffer`→`endOfStream` state machine (`element-materialize.ts:95`,
`element-materialize.ts:341`, `element-materialize.ts:383`). **Smell:** two **module-global mutable**
`WeakMap`s track the active session and attachment per element (`element-materialize.ts:49`,
`element-materialize.ts:50`). The intent (a newer attachment aborts the prior one so an element is
never driven by two sessions) is legitimate, but module-global mutable state keyed on a DOM node is a
layering smell worth an explicit ADR.

**`streaming-webm-remux.ts` — LAYERING LEAK.** `src/api/streaming-webm-remux.ts` is a 484-line
streaming remux producer with a solid packet-info fast path (windowed range reads,
`PacketInfoWindowReader`, `src/api/streaming-webm-remux.ts:194`), keyframe-aware fragmentation, and a
k-way decode-order merge (`streaming-webm-remux.ts:113`). But it lives in the `api` layer and
**imports a concrete driver**: `import { WebmStreamingMuxer } from '../drivers/webm/ebml-write.ts'`
(`streaming-webm-remux.ts:12`) and hard-codes the container choice
`opts.to === 'mkv' ? 'matroska' : 'webm'` (`streaming-webm-remux.ts:298`, `streaming-webm-remux.ts:431`).
That is a **capability leak** — a specific backend/container named in the wrong layer — the very thing
the router exists to prevent. The op should obtain a streaming muxer through the driver registry, not
`import` one container's writer.

**Inconsistent split pattern.** `stream-target` splits descriptor (`stream-target.ts`) from seam
(`stream-target-materialize.ts`); `opfs-target` co-locates pure core + guarded seam in one file with
`/* v8 ignore */` (`opfs-target.ts:178`). Both are defensible, but the codebase uses two different
conventions for the same shape, which makes the orphaned-vs-wired confusion easier to miss.

**Timing heuristic.** `deferred-stream-cleanup.ts` yields for at most one macrotask via
`setTimeout(resolve, 0)` before cancelling (`src/api/deferred-stream-cleanup.ts:28`) so a hung source
cannot delay cancellation. Correct, but a magic one-task deadline that deserves a recorded rationale.

## 5. Delta / punch-list

Ordered, each with a concrete acceptance test / oracle.

1. **Implemented: one reachable OPFS drain.** `OpfsTarget` is in the `Sink` union and both OPFS
   descriptors route through `writeToOpfsTarget`; the default entry exports `toOPFS()` while keeping
   the richer constructor behind the internal lazy materializer boundary. Tests record
   `createWritable({keepExistingData:true})`, `seek(N)`, and verify the public compact descriptor and
   rich internal descriptor share the same writer.

2. **Implemented: producer-intended positions.** `positionedChunk` tags producer offsets without
   copying payload; the common pump preserves them for callback/seekable destinations and rejects
   impossible append-only rewrites. Tests cover non-monotonic patches and contiguous append output.

3. **Remove the driver leak from `streaming-webm-remux.ts`.** Obtain the streaming muxer through the
   driver/registry contract (a `container.streamingMux(...)` capability) rather than
   `import { WebmStreamingMuxer } from '../drivers/webm/ebml-write.ts'`
   (`src/api/streaming-webm-remux.ts:12`); move the `opts.to → 'matroska'|'webm'` decision
   (`streaming-webm-remux.ts:298`, `streaming-webm-remux.ts:431`) behind that contract.
   *Acceptance:* `grep -n "from '../drivers/" src/api/streaming-webm-remux.ts` returns nothing; the
   remux still passes its existing golden tests (`src/api/streaming-webm-remux.test.ts`) and the
   `streaming-output` WebM-live oracle (`webm-live-layout`) stays green; a second streaming container
   (e.g. fragmented MP4) can be added without editing this file.

4. **Implemented for progressive MP4/MOV: reserved faststart.** `faststart:'reserve'` requires a
   positive per-track `maximumPacketCount` and a positioned callback/seekable/OPFS sink before input is
   pulled. It emits `ftyp`, jumps forward to stream `mdat`, then patches a bounded `moov`+`free` region.
   Packet-ceiling overflow is a stable typed failure; buffer and append-only sinks are rejected instead
   of silently materializing. Fragmented MP4 remains the append-only streaming choice.

5. **Implemented: first-byte/write hook.** The callback receives `(chunk, position)` as soon as the
   first producer chunk exists, providing the TTFB and write-count signal without waiting for finalize.
   Unit and exhaustive browser oracles re-import the result before accepting the measurement.

6. **Implemented: one OPFS capability error.** Both public descriptors use the same materializer and
   report OPFS absence as `CapabilityError('capability-miss')`.

7. **Implemented: write shaping on `StreamTarget`.** `chunked`/`chunkSize` provides bounded
   coalescing (default off; default 16 MiB), while `writeChunkBytes` provides a distinct strict
   fixed-write contract. Product tests cover byte identity, write counts and positions, oversized
   producer chunks, one-at-a-time backpressure, append-only writables, and typed partial-run rejection.

8. **Record the module-global element-session state as an ADR (or scope it).** The two `WeakMap`s
   (`src/sinks/element-materialize.ts:49`–`:50`) are module-global mutable singletons. Either document
   the "one active session per element" invariant in an ADR or move ownership onto an engine-scoped
   registry so two `Engine` instances cannot cross-abort each other's element sessions.
   *Acceptance:* a test attaching two sessions to the *same* element asserts the first is aborted with
   `MediaError('aborted', 'element sink was replaced by a newer attachment')`
   (`element-materialize.ts:58`); a test with two independent engines on *different* elements asserts no
   cross-abort.

9. **Unify the descriptor/seam split convention.** Pick one pattern (two-file descriptor+seam, or
   one-file pure-core+guarded-seam) and apply it to both `stream-target*` and `opfs-target`.
   *Acceptance:* both streaming sinks follow the same file layout; the packaging budget test
   (default-entry closure size) is unchanged, proving the seam is still lazily loaded.

## 6. Open questions

Each seeds a decision record in `docs/decisions/`.

1. **Streaming-muxer capability in the driver contract (delta #3).** What is the exact registry seam —
   a `ContainerDriver.streamingMux()` returning a `WebmStreamingMuxer`-shaped sink, or a generic
   `chunkMux` the remux runner already probes (`containerHasChunkMuxer`,
   `src/api/remux-runner.ts:252`)? Reconcile with S14 (mux) so `streaming-webm-remux.ts` and the
   MP4/MPEG-TS streaming paths share one contract.

2. **`chunked` default (delta #7).** Off by default (lowest latency/TTFB, most writes) matches the
   family's headline metric, but a network `WritableStream` upload usually wants coalescing. Should the
   default depend on the destination kind (append-only network body ⇒ chunk; seekable OPFS ⇒ raw)?

3. **Element/MSE cross-browser playback (delta #8).** The MSE sink's playback has never been verified
   in a real browser — it was validated against deterministic event doubles only (measured-evidence.md
   session12-element-sinks). This is an explicit parent-session browser gate, not a claim; log it as an
   open verification item with the exact assets/MIME types to test.

4. **`deferred-stream-cleanup` one-task deadline (`src/api/deferred-stream-cleanup.ts:28`).** Is a
   single `setTimeout(0)` macrotask the right bound for claiming an already-produced frame before
   cancel, or should it be a microtask/`queueMicrotask` (tighter) or a configurable budget? Record the
   rationale for the current value.
