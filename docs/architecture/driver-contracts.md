# Driver Contracts & Registry

> Shard S04 · Owned code: `src/contracts/driver.ts`, `src/contracts/errors.ts`, `src/kernel/registry.ts`,
> `src/drivers/default-codec-registration.ts`, `src/drivers/default-container-registration.ts`,
> `src/drivers/defaults.ts`.
> This document is the **target spec** (the best design) plus an honest **delta vs today's code**. It is
> not a description of what exists.

## 1. Purpose & scope

The driver-contract family is the **kernel ↔ backend boundary**: a small, versioned set of TypeScript
interfaces that every codec, container, and filter implementation satisfies, plus the **registry** that
holds them and the **default-registration** glue that lazily materializes first-party drivers on a
capability miss. It is the seam that lets the capability router (S01) rank substrates without knowing how
any of them work, and lets a third party publish a driver against a stable, semver'd surface
(`@aibrush/media/core` re-exports the whole contract — `src/core.ts:9-10`).

Three driver kinds map onto the two data-flow seams (`src/contracts/driver.ts:4-7`):

- **`CodecDriver`** — decode/encode exactly one codec on one substrate (`driver.ts:172-179`).
- **`ContainerDriver`** — demux/mux one container family (`driver.ts:411-494`).
- **`FilterDriver`** — transform frames (`driver.ts:531-540`).

Encoded units and raw frames cross the seams as **WebCodecs-native host types**, so a stage's substrate
can change (hardware WebCodecs → GPU → WASM) without touching its neighbours. The governing principle is
stated in the contract header: *drivers **declare** (`supports()`); the router **decides**.*
(`driver.ts:6`).

**Benchmark family served:** cross-cutting. This family has no scenario family of its own; it is the
substrate every family (probe, demux, decode-seek, transcode, mux, remux, trim, audio-dsp, encryption,
metadata, streaming-output, robustness, performance) routes through. Its correctness oracle is indirect:
if the contract is wrong, wins in every family degrade to typed misses or wrong results.

## 2. Spec & references

This family has no external wire format; its "standard" is an **internal contract** governed by a
**semver major** (`DRIVER_API_VERSION`, `driver.ts:21`) plus the platform types the seams are built from.

- **WebCodecs** (W3C Working Draft) — the seam types (`EncodedVideoChunk`, `EncodedAudioChunk`,
  `VideoFrame`, `AudioData`, `VideoDecoderConfig`/`AudioDecoderConfig`, `isConfigSupported`) are WebCodecs
  objects. <https://www.w3.org/TR/webcodecs/>. Config-support probing model:
  <https://www.w3.org/TR/webcodecs/#dom-videodecoder-isconfigsupported>.
- **WHATWG Streams** — every coder/filter is a `TransformStream`; backpressure and `highWaterMark` come
  from this spec. <https://streams.spec.whatwg.org/>.
- **AbortSignal / AbortController** (WHATWG DOM) — the cancellation model threaded through
  `StageOptions.signal`. <https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal>.
- **Semantic Versioning 2.0.0** — the policy `DRIVER_API_VERSION` should implement.
  <https://semver.org/>.

**OSS exemplar — mediabunny custom-coder registry.** mediabunny exposes a plugin surface built from four
base classes (`CustomVideoEncoder`, `CustomAudioEncoder`, `CustomVideoDecoder`, `CustomAudioDecoder`) and
two free functions (`registerEncoder`, `registerDecoder`); each coder gates itself with a `static
supports(codec, config): boolean`, and registered custom coders take **precedence** over the default
WebCodecs path.
- Guide: <https://mediabunny.dev/guide/supported-formats-and-codecs.html>
- API: <https://mediabunny.dev/api/CustomVideoEncoder> · <https://mediabunny.dev/api/registerEncoder> ·
  <https://mediabunny.dev/api/CustomVideoDecoder>
- Repo: <https://github.com/Vanilagy/mediabunny>
- Reference WASM extension (`@mediabunny/mp3-encoder`, registered with one `registerMp3Encoder()` call):
  <https://github.com/Vanilagy/mediabunny/blob/main/packages/mp3-encoder/README.md>

**Where our design must match or beat the exemplar.**
1. **Instance registry, not module globals.** mediabunny's `registerEncoder`/`registerDecoder` mutate a
   process-global roster. Our `Registry` is a per-engine instance (`src/api/engine.ts:209`
   `#registry = new Registry()`), so multiple engines coexist with disjoint capability sets. Keep this;
   never regress to a module-global roster.
2. **Three kinds, not "codecs only."** mediabunny states "It is not possible to add new codecs" — its
   plugin surface is a polyfill for a fixed codec roster and offers no container plugin. Our contract adds
   containers and filters as first-class registerable kinds (`driver.ts:544-549`), a strictly larger seam.
3. **A versioned handshake.** mediabunny has no coder-contract version. We gate registration on
   `DRIVER_API_VERSION` with a supported window (`registry.ts:36-39`), so an out-of-date third-party
   driver is refused at registration with a typed error, not a later crash. Keep and formalize this.
4. **Tier-ranked, not custom-first.** mediabunny's precedence is "custom beats default." Ours is
   *capability-ranked*: `pickCodec` sorts by `Tier` (hardware → gpu → native → wasm), independent of
   registration order (`src/kernel/router.ts:81-84`), which is what makes "hardware WebCodecs first,
   heavy WASM only on a miss" true rather than an accident of load order.

## 3. Target design

### 3.1 Data model — the seam types

Two WebCodecs-native units flow across the seams (`driver.ts:65-70`):

```ts
/** The container ↔ codec seam: a sealed WebCodecs encoded unit (its `timestamp` is the PTS). */
export type EncodedChunk = EncodedVideoChunk | EncodedAudioChunk;
/** The codec ↔ filter seam: a decoded frame (ref-counted; must be `close()`d exactly once). */
export type RawFrame = VideoFrame | AudioData;
```

The container↔codec seam wraps `EncodedChunk` in a **`Packet`** (`driver.ts:89-100`) that carries the
facts WebCodecs host objects omit: an optional decode timestamp `dtsUs` (`undefined ⇒ DTS == PTS`, no
reorder), an owned `data` byte view for packet-copy muxers, an `alpha` side-data chunk for VPx-in-Matroska,
and `sizeBytes` for oracles whose packet unit differs from the decoder access unit. A `Packet` owns no
releasable resource — the chunk owns its bytes (`driver.ts:86-87`). For consumers that need timeline facts
without payloads there are the payload-free `PacketMetadata` / `PacketInfoMetadata` / `PacketInfoTable`
shapes (`driver.ts:103-134`) — the Node-safe, host-object-free path that probe/demux fast-paths use.

`DriverBase` (`driver.ts:137-142`) is the identity every driver declares: a unique string `id` and the
`apiVersion` it was built against. The three kinds extend it; `AnyDriver` unions them (`driver.ts:559`).

### 3.2 Seams — declare vs decide

- A **`CodecDriver`** is a pair of `TransformStream` factories plus a cheap capability probe
  (`driver.ts:172-179`): `supports(q, o?)` wraps `isConfigSupported` and **returns `false`, never throws
  later**; `createDecoder`/`createEncoder` return `TransformStream<EncodedChunk, RawFrame>` /
  `TransformStream<RawFrame, EncodedChunk>`. Each driver carries a `tier` (`'hardware' | 'gpu' | 'native'
  | 'wasm'`, `driver.ts:26`) that the router ranks.
- A **`ContainerDriver`** has a **synchronous** `supports(q)` (magic bytes / mime / extension,
  `driver.ts:414`) plus a wide, mostly-**optional** method surface: `probe`, `packetInfo`, `demux`,
  `createMuxer`, and lossless-path methods (`streamCopy`, `decrypt`, `transformPcm`, `decodePcm*`) each
  gated behind an optional field so a driver advertises only what it authors (`driver.ts:411-494`).
- A **`FilterDriver`** declares its `substrate` (`'webgpu' | 'webgl' | 'canvas2d' | 'native' | 'wasm'`,
  `driver.ts:529`) and a synchronous `supports(spec)`; `createFilter` returns a same-media
  `TransformStream` (`driver.ts:531-540`).

### 3.3 Registry — the single write/read split

The registry is the one place drivers land. The **write side** is `Registry`
(`src/contracts/driver.ts`: `addCodec`/`addContainer`/`addFilter` plus the optional image slot
`addImageOps?`); the **read side** the router consumes is `RegistryView` (also declared in the contract
file: `codecs()`/`containers()`/`filters()`/`imageOps()`, snapshots in insertion order; re-exported from
`src/kernel/registry.ts` for the kernel/`core` surface). The concrete `Registry` class implements both,
storing each kind in a `Map<string, Driver>` keyed by id. Three invariants are load-bearing:

1. **Version-gated registration.** `#add` refuses any driver whose `apiVersion` is outside the supported
   window with a typed `driver-incompatible` `MediaError` — never a later crash. The window is
   `[current]` until a real previous major (≥ 1) exists; the phantom major 0 is never accepted
   (`supportedApiVersions`, `registry.ts`).
2. **Honest capability advertisement.** A driver may declare `DriverBase.capabilities` (names of the
   additive optional contract members it implements); registration refuses an advertisement its surface
   does not back with a typed `driver-incompatible` (`assertHonestCapabilities`, `registry.ts`).
3. **Idempotent by id — first-wins, unless strictly superseded.** A re-import of the same chunk (HMR,
   double dynamic-import) is a safe no-op; but a later same-id driver whose capability surface is a
   *strict superset* of the incumbent's (e.g. the full demux+mux module arriving after its mux-only
   sibling) replaces it, so op order can never silently drop a capability
   (`isStrictlyMoreCapable` over `OPTIONAL_CONTAINER_CAPABILITIES`, `registry.ts`).

### 3.4 Capability routing — WebCodecs → GPU → WASM, miss-only

The developer never names a backend. Routing is a two-stage funnel:

1. **Eager kernel is tiny.** No first-party driver is in the eager bundle. The engine's registry starts
   empty; on the **first capability miss** it lazily `import()`s a registration module (`engine.ts:1054`
   `import('../drivers/defaults.ts')`), so the container parsers and WASM tails are code-split chunks
   (`defaults.ts:1-6`, ADR-004).
2. **Two-step miss recovery.** Before falling back to the whole bundle, a *definite* query registers only
   the one driver it needs: `pickContainerWithDefaultFallback` / `pickCodecWithDefaultFallback`
   (`default-container-registration.ts:135-153`, `default-codec-registration.ts:47-64`) register a single
   selective driver, `router.clearCache()`, retry `pickContainer`/`pickCodec`; on a *typed*
   `CapabilityError` only, they then `registerAll()` and retry once. Any non-capability error propagates
   unchanged.

Inside `pickCodec`, the ladder is enforced by **tier rank**, not registration order: candidates are sorted
`hardware → gpu → native → wasm` and the first whose `supports()` verdict honours `determinism` wins
(`router.ts:81-99`). A heavy WASM tail is therefore imported **only after** every hardware/native probe has
missed — the "download heavy WASM only on a hardware miss" rule is a routing consequence, not a special
case. On a true miss the router throws `CapabilityError` naming, in ladder order, every driver id it tried
(`router.ts:105-111`) — fail loudly, never a silent wrong result (`errors.ts:1-7`).

The **lazy driver proxies** (`lazyContainer`, `lazyCodec`, `lazyFilter` in `defaults.ts`) are
what make miss-only real: each proxy carries the driver's `id`/`kind`/`tier` and a **cheap pre-load
`supports`/`matches` gate**, but defers `spec.load()` until a frame or packet actually flows. `lazyCodec.
supports` first runs the string-prefix `matches(q)` and only then imports and delegates to the real
`supports` (`defaults.ts:1269-1279`), so an obviously-non-matching codec never pulls its WASM chunk.

### 3.5 Edge cases

- **B-frames / reordered streams.** Handled at the contract data model: `Packet.dtsUs` carries the decode
  timestamp alongside the PTS-only WebCodecs chunk, with `undefined ⇒ no reorder` (`driver.ts:76-97`).
  MP4 stores DTS + composition offset and Matroska must lay blocks in decode order, so a lossless remux
  needs DTS the host object does not expose — that is exactly why `Packet` exists. Alpha side data
  (open-GOP VPx-in-WebM) rides `Packet.alpha` (`driver.ts:95`).
- **VFR (variable frame rate).** The contract is inherently VFR-correct: timing lives per-`Packet`
  (`chunk.timestamp`, `dtsUs`, `durationUs` in the metadata shapes), never a global fps. `TrackInfo.fps`
  is an optional *hint* (frames ÷ duration, `driver.ts:245-247`), never authoritative for timing.
- **Seek.** Not a contract method — seek is a *decode-path* concern (S10) built on `demux()` +
  keyframe-aligned packet ranges. The contract's contribution is the payload-free `packetInfo()` /
  `PacketInfoTable` (`driver.ts:118-134, 425`) giving keyframe + PTS/DTS/offset rows so a seeker can find
  the target keyframe without materializing payloads.
- **Cancel.** Every stage takes `StageOptions.signal?: AbortSignal` (`driver.ts:45-46`). A coder is a
  `TransformStream`; cancellation must release the WebCodecs/WASM object and `close()` in-flight frames
  (`driver.ts:167-171`). The reference implementation of cancel-correct teardown is
  `createLazyFilterStream.cancel` (`src/drivers/lazy-filter-stream.ts`): it sets `outerDead`, then **initiates**
  `writer.abort` / `reader.cancel` without awaiting them, because WHATWG cancel settles only after any
  in-flight inner write finishes — awaiting would let a stuck stage block cancellation forever.
- **Frame lifetime — `close()` exactly once.** The contract states raw frames are ref-counted and must be
  closed exactly once (`driver.ts:69-70`). Ownership transfers with the stream operation: writing a frame
  into a coder relinquishes it; reading transfers it to the reader. The reference owner is again
  `createLazyFilterStream` (`src/drivers/lazy-filter-stream.ts`), which closes a frame in every branch that does **not**
  hand it onward: input the inner sink never accepted, an inner output that lost the enqueue race
  against a downstream cancel. `@aibrush/media/core` exports `closeFrame`/`closeFrames`/
  `Closable`/`isClosable` (`src/core.ts:37`) as the shared helpers every driver should use.
- **Backpressure.** Coders/filters are `TransformStream`s, so WHATWG queueing strategies apply. The
  contract's non-obvious rule (documented at `defaults.ts:823-834`): a lazy filter stage's **writable
  `highWaterMark` must be ≥ 1** — a zero-HWM writable never reports room, so `pipeTo` waits on
  `writer.ready` forever and the whole decode→filter→encode chain stalls silently before the first frame
  (the Session-10 transcode-timeout regression, ADR-186). The wrapper sets HWM 1 on both sides
  (`defaults.ts:903`) so in-flight frames stay bounded for any stage shape.

## 4. Current state

**The R-S04 punch-list (§5) is implemented; this section describes the code as it now stands.**

**Contract file.** `driver.ts` is a clean, `any`-free set of interfaces with the correct WebCodecs-native
seam types and a well-designed `Packet`. It now owns the **full** registry surface: the write-side
`Registry` (including the optional image slot `addImageOps?`) and the read-side `RegistryView` are both
declared in the contract file, so image support is no longer smuggled in through a structural cast.
`DriverBase` gained an optional `capabilities: readonly string[]` handshake naming the additive optional
contract members a driver implements, and `OPTIONAL_CONTAINER_CAPABILITIES` is the single exported list
of the container contract's optional members (the registry's supersession comparison and the lazy-spec
conformance test both key off it).

**Registry.** Version-gated (window `[current]`, phantom major 0 refused), capability-advertisement-
validated (`driver-incompatible` for a dishonest `capabilities` entry), idempotent by id with
strict-superset supersession (see §3.3). Selective registration specs
(`default-container-registration.ts`) carry the **real registered driver id** (`'mp4-mux'`,
`'webm-mux'`), so pins resolve against the same ids the registry holds.

**Error model.** `CapabilityError` fixes `code = 'capability-miss'` intrinsically and takes
`(message, detail?: CapabilityErrorDetail, options?: ErrorOptions)`; `InputError` fixes
`'unsupported-input'`. `CapabilityErrorDetail.op` is the discriminated `OperationDescriptor` union
(`{kind:'codec', query}` | `{kind:'container', query}` | `{kind:'filter', spec}` |
`{kind:'route', id, facts?}`), and `isCapabilityErrorDetail` guards untyped payloads (the structured-clone
worker wire) so the subclass is only ever rebuilt with a genuine typed detail. The typed detail is
optional-by-presence: an error rebuilt from a wire that carried none stays a `CapabilityError` rather
than gaining a fabricated descriptor. Every owned throw site names what it tried (`LazyMuxer`'s PCM miss
reports the driver id, never `tried: []`).

**Registration bundle (`defaults.ts`, ~665 lines).** Now only registration wiring plus the lazy proxy
factories:
- The lazy container roster is one exported data table, `DEFAULT_LAZY_CONTAINER_SPECS` (mp4, webm, wav,
  mp3, ogg, adts, aiff, caf, mpegts, avi), consumed by `lazyContainer()`; FLAC's bespoke fast-path proxy
  lives in `src/drivers/flac/flac-lazy-driver.ts`. The spec flag table is drift-proof: a conformance test
  (`lazy-container-conformance.test.ts`) loads every spec and fails if the flags disagree with the loaded
  module's real surface in either direction.
- The two lazy muxers are folded into one parameterized `LazyMuxer`
  (`src/drivers/lazy-muxer.ts`): single-track vs multi-track is a `validateTrack` config, and the raw-PCM
  seam is exposed only when configured (`pcmSeam`), so FLAC never advertises a `writePcm` its real muxer
  lacks. `missingLazyMethod` lives beside it.
- `createLazyFilterStream` — still the model of cancel-correct, close-once, backpressure-aware stream
  wiring (ADR-186) — lives in `src/drivers/lazy-filter-stream.ts` next to its test.
- Image sniffing is the image codec module's own `sniffImageFormat` (`src/codecs/image/probe.ts`);
  byte-stream draining is the shared `src/util/byte-stream.ts`.
- Browser/UA capability detection (`webgpuAvailable`/`canvas2dAvailable`/
  `chromiumCanvasTonemapAvailable`/UA predicates) lives in the tier layer,
  `src/kernel/runtime-capabilities.ts`; `defaults.ts` contains no UA regex and no module-level mutable
  state — the image-ops load promise is closure-scoped per registration, so engines in one process never
  share resolution state.

**Remaining layering smell (open).** Both registration helpers still import `../kernel/router.ts` and
drive selection + cache invalidation themselves (`pickCodecWithDefaultFallback` /
`pickContainerWithDefaultFallback` call `router.clearCache()` and retry). The `src/drivers/*` layer should
describe *what to register*, not orchestrate *how to re-route* — moving that orchestration into the
engine/kernel remains open question §6.4 (not part of the R-S04 list).

## 5. Delta / punch-list

Ordered; each item has a concrete acceptance test. Items 1–4 are correctness; 5–10 are structure/typing.

1. **Fix selective-spec id vs driver id.** Make `SelectiveContainerSpec.id` equal the id of the driver its
   `load()` registers, or split the spec into a `specId` (for `matches`) and the real `driverId` (for pin
   resolution) and resolve pins against the real id. Ref `default-container-registration.ts:23-29, 80-90`;
   `mp4-mux-driver.ts:32`; `webm-mux-driver.ts:27`.
   *Acceptance:* a unit test iterates `SELECTIVE_CONTAINERS`, calls each `load()`, and asserts the
   registered driver's `id` equals the value used for pin matching; and `pickContainer({direction:'mux'},
   {pinDriver:'mp4-mux'})` after selective registration resolves the mux driver (currently a miss).
   **✅ Done** — `src/drivers/default-container-registration.test.ts`: “every selective spec id equals the
   id its load() actually registers (pin truth)” and “resolves a pin on the real mux driver id through
   selective registration”.

2. **Defend the registry against id-collision capability loss.** With two modules per container family
   (full demux+mux vs mux-only) and first-wins-by-id, the surviving surface depends on op order. Either
   (a) never reuse an id across distinct capability surfaces, or (b) make `#add` merge/replace when a
   later driver of the same id is strictly more capable. Ref `registry.ts:96-98`.
   *Acceptance:* register mux-only `mp4-mux`, then attempt to register full-capability `mp4`, then assert
   an MP4 **demux** resolves to a demux-capable driver (today it can be silently dropped by first-wins).
   **✅ Done** — `src/kernel/registry.test.ts`: “replaces a registered container when a same-id driver is
   strictly more capable”, “keeps the wider surface when a narrower same-id driver registers second”,
   “never loses demux across the real mux-only/full MP4 module pair”.

3. **Make `CapabilityError`/`InputError` codes intrinsic and details typed.** `CapabilityError` should fix
   `code = 'capability-miss'` and take `(message, detail: CapabilityErrorDetail)`; `InputError` should fix
   `'unsupported-input'`. Replace `MediaError.detail: unknown` on the capability path with the typed
   detail. Ref `errors.ts:36-63`.
   *Acceptance:* `new CapabilityError('the message', {op, tried})` typechecks and `err.code ===
   'capability-miss'`; passing any other code no longer compiles; a grep proves no call site passes a
   redundant `'capability-miss'` literal.
   **✅ Done** — `src/contracts/errors.test.ts`: “fixes code = capability-miss intrinsically and carries
   the typed detail”, “fixes code = unsupported-input intrinsically…”, and the source-scan oracle “no
   call site passes a redundant code literal”. (Detail is typed but optional: a worker-wire error that
   carried no structured detail stays a `CapabilityError` — see §4.)

4. **Type `CapabilityErrorDetail.op` as a discriminated `OperationDescriptor` and forbid empty `tried`
   when work was attempted.** Replace `op: unknown` with a union
   (`{kind:'codec', query:CodecQuery} | {kind:'container', query:ContainerQuery} | {kind:'filter', spec} |
   {kind:'route', id:string}`), and remove the doubly-nested `{op:{op:'mux'}}` shapes. Ref `errors.ts:39`;
   `defaults.ts:993, 1002, 1126, 1261`; `router.ts:83`.
   *Acceptance:* a test constructs each thrown `CapabilityError` in owned code and asserts `detail.op`
   matches the union and `detail.tried.length > 0` whenever the message claims a probe happened.
   **✅ Done** — `src/kernel/router.test.ts`: “every routed miss carries the discriminated op descriptor
   and names what was probed”; `src/contracts/errors.test.ts`: “accepts every OperationDescriptor kind of
   the discriminated union”; `src/drivers/lazy-muxer.test.ts`: “raises a typed PCM miss naming the tried
   driver…” (the former `tried: []` writePcm miss).

5. **Assert the lazy flag table against the real modules (kill the drift).** For every `LazyContainerSpec`
   boolean flag (`probe`, `packetInfo`, `streamCopy`, `decrypt`, `transformPcm`, `decodePcm*`,
   `validates*`), assert the loaded module actually exposes that method; drivers that omit a claimed method
   should fail a **build/conformance** check, not a runtime `missingLazyMethod`. Ref `defaults.ts:270-290,
   388-505, 732-737`.
   *Acceptance:* a conformance test loads every lazy spec, and for each `flag: true` asserts
   `typeof loaded[flag] === 'function'` (and for each *false/omitted* flag that the proxy does not
   advertise it); the test fails if any real driver's surface disagrees with its spec flags.
   **✅ Done** — `src/drivers/lazy-container-conformance.test.ts`: “the %s proxy advertises exactly the
   surface its loaded module implements” (both directions, over `DEFAULT_LAZY_CONTAINER_SPECS`; caught
   and fixed a real drift — the aiff spec had hidden the real driver's `probe`).

6. **Fix the version window and add a discoverable minor/capabilities handshake.** `supportedApiVersions`
   must not accept `apiVersion: 0` while `DRIVER_API_VERSION === 1`; the window should be `[current]`
   until a real `current-1 ≥ 1` exists. Add either a `DRIVER_API_MINOR` or a `capabilities: readonly
   string[]` field on `DriverBase` so additive optional methods are advertised, not duck-typed. Ref
   `registry.ts:31-39`; `driver.ts:21, 137-142`.
   *Acceptance:* `isApiVersionSupported(0) === false`; a driver advertising `capabilities: ['streamCopy']`
   without implementing `streamCopy` is refused at registration with `driver-incompatible`.
   **✅ Done** — `src/kernel/registry.test.ts`: “accepts only real contract majors — never the phantom
   major 0”, “refuses the phantom previous major 0…”, “refuses a driver advertising a capability its
   surface does not implement”, “accepts an honest capabilities advertisement…”.

7. **Move image ops into the contract as a first-class kind.** Either add a fourth registerable kind or
   declare `addImageOps`/`imageOps()` in `src/contracts/driver.ts` so the canonical contract owns the full
   registry surface; delete the structural cast. Ref `registry.ts:45, 63-65`; `defaults.ts:96`;
   `driver.ts:544-549`.
   *Acceptance:* `defaults.ts` registers image ops through a typed contract method with no `as` cast, and
   `RegistryView.imageOps()` / the write method are both declared in the contract file.
   **✅ Done** — `Registry.addImageOps?` and `RegistryView` are declared in `src/contracts/driver.ts`;
   `defaults.ts` calls `reg.addImageOps?.(…)` with no cast. Proof: `src/kernel/registry.test.ts`: “holds
   image ops idempotently outside the container/codec/filter driver maps”; `src/drivers/defaults.test.ts`:
   “registers image support on the default registry host”.

8. **Extract the FLAC driver, image sniff, and byte-IO out of `defaults.ts`.** Move `lazyFlacContainerDriver`
   /`flacPacketStream` into `src/drivers/flac/`; move `sniffImageFormat`+helpers into the image codec
   module; move `readByteStream`/`readFlacBytes` into a shared source util. `defaults.ts` should contain
   only registration wiring + lazy proxy factories. Ref `defaults.ts:130-244, 542-686`.
   *Acceptance:* `defaults.ts` drops below ~500 lines and imports zero `EncodedAudioChunk` construction;
   FLAC demux tests import from `src/drivers/flac/`, not `drivers/defaults.ts`; all existing tests pass.
   **✅ Done** — FLAC proxy in `src/drivers/flac/flac-lazy-driver.ts` (tests:
   `src/drivers/flac/flac-lazy-driver.test.ts`), byte IO in `src/util/byte-stream.ts`, image sniff deduped
   into `src/codecs/image/probe.ts`. `defaults.ts` is ~665 lines of registration wiring + proxy factories
   (the spec table and factories carry the remainder); zero `EncodedAudioChunk` construction, enforced by
   `src/drivers/defaults.test.ts`: “contains only registration wiring: no UA sniffing, no module-level
   mutable state”.

9. **De-duplicate the two lazy muxers.** Fold `LazyFlacMuxer` and `LazyContainerMuxer` into one
   parameterized lazy muxer (single-track vs multi-track is a config, not a class). Ref
   `defaults.ts:965-1184`.
   *Acceptance:* one muxer class remains; the FLAC single-stream constraint is expressed as a
   `validateTrack`/`maxTracks: 1` option; mux golden tests for FLAC and every container still pass.
   **✅ Done** — one `LazyMuxer` (`src/drivers/lazy-muxer.ts`); FLAC's constraint is
   `validateFlacMuxTrack` passed as `validateTrack`. Proof: `src/drivers/lazy-muxer.test.ts` (all four
   tests) and `src/drivers/flac/flac-lazy-driver.test.ts`: “routes the lazy FLAC muxer through the real
   muxer and preserves typed misuse errors”.

10. **Relocate browser/UA capability detection to the tier layer, and remove the module global.** Move
    `webgpuAvailable`/`canvas2dAvailable`/`chromiumCanvasTonemapAvailable`/UA regexes into S01's
    capability/tier module, and replace the `imageOpsPromise` module global with per-registry state. Ref
    `defaults.ts:130, 906-963`.
    *Acceptance:* `defaults.ts` contains no `navigator.userAgent` regex and no module-level mutable `let`;
    two `createMedia()` engines in one process each resolve image ops independently (a test that creates
    two engines and asserts no shared promise identity leaks between them).
    **✅ Done** — detection lives in `src/kernel/runtime-capabilities.ts`; the image-ops promise is
    closure-scoped per registration. Proof: `src/drivers/defaults.test.ts`: “contains only registration
    wiring: no UA sniffing, no module-level mutable state” (source oracle) and “two registries resolve
    image ops independently — no shared promise identity” (each engine holds its own registry, so
    per-registry independence is exactly the engine-level property).

## 6. Open questions

Each seeds a decision record in `docs/decisions/`.

1. **Semver policy for `DRIVER_API_VERSION`.** Is the support window "current major only," "current +
   previous major," or minor-aware? What is the migration story when the major bumps to 2 — do we ship a
   shim that adapts v1 drivers, or hard-refuse? (Ref `registry.ts:31-39`.) Decide and encode the exact
   window function and the meaning of major 0.

2. **How do drivers advertise optional capabilities?** Duck-typed method presence
   (`if (loaded.streamCopy === undefined)`) vs an explicit `capabilities` set vs a minor version. This
   determines whether a mis-declared lazy proxy is a build error or a runtime miss (delta items 5–6).

3. **Should `pinDriver` live in `StageOptions`?** `pinDriver` is a *routing* concept threaded into the
   *driver* seam so nested stage routes inherit the caller's strategy (`driver.ts:54-55`). Is a driver the
   right owner of a route pin, or should nested routing carry strategy out-of-band? (Capability-leak risk.)

4. **Where does the miss-recovery orchestration belong?** The `*WithDefaultFallback` helpers put
   selective-register → clearCache → retry logic in `src/drivers/*` while importing the kernel router
   (`default-*-registration.ts`). Should this move wholesale into the engine/kernel so `drivers/` has no
   dependency on `kernel/router.ts`?

5. **Node-side story for the WebCodecs-native seams.** `EncodedChunk`/`RawFrame` are browser host types, so
   packet-producing demux throws `capability-miss` in Node (`defaults.ts:625-631`) while the payload-free
   `PacketInfoTable` path works. Do we adopt a polyfill/shim for the encoded-chunk seam under Node, or
   formally scope packet-level demux/mux as browser-only and route Node consumers to `packetInfo()`?

6. **Should image be a driver kind at all?** `ImageOps` is an object, not a `TransformStream`-based driver.
   Is the right model a fourth kind, a container driver whose "packets" are frames, or a separate
   capability registry? (Ref delta item 7.)

7. **`Registry.has(kind: DriverBase & {kind: string})`** takes a driver-shaped argument named `kind` and is
   part of neither the write contract nor `RegistryView` (`registry.ts:83-86`). Keep it, promote it into a
   contract, or delete it in favour of `codecs()/containers()/filters().some(...)` (as `engine.ts:1788-1790`
   already does)?
