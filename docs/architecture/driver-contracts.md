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

The registry is the one place drivers land. The **write side** is `Registry` (`driver.ts:544-549`:
`addCodec`/`addContainer`/`addFilter`); the **read side** the router consumes is `RegistryView`
(`registry.ts:23-28`: `codecs()`/`containers()`/`filters()`/`imageOps()`, snapshots in insertion order).
The concrete `Registry` class implements both plus `ImageRegistry` (`registry.ts:45`), storing each kind in
a `Map<string, Driver>` keyed by id (`registry.ts:46-49`). Two invariants are load-bearing:

1. **Version-gated registration.** `#add` refuses any driver whose `apiVersion` is outside the supported
   window with a typed `driver-incompatible` `MediaError` (`registry.ts:88-95`) — never a later crash.
2. **Idempotent by id, first-wins.** `if (into.has(driver.id)) return;` (`registry.ts:96-98`) makes a
   re-import of the same chunk (HMR, double dynamic-import) a safe no-op.

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

The **lazy driver proxies** (`defaults.ts:372-506`, `lazyCodec` `1250-1291`, `lazyFilter` `768-807`) are
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
  `createLazyFilterStream.cancel` (`defaults.ts:893-900`): it sets `outerDead`, then **initiates**
  `writer.abort` / `reader.cancel` without awaiting them, because WHATWG cancel settles only after any
  in-flight inner write finishes — awaiting would let a stuck stage block cancellation forever.
- **Frame lifetime — `close()` exactly once.** The contract states raw frames are ref-counted and must be
  closed exactly once (`driver.ts:69-70`). Ownership transfers with the stream operation: writing a frame
  into a coder relinquishes it; reading transfers it to the reader. The reference owner is again
  `createLazyFilterStream` (`defaults.ts:836-904`), which closes a frame in every branch that does **not**
  hand it onward: input the inner sink never accepted (`884`), an inner output that lost the enqueue race
  against a downstream cancel (`858, 864`). `@aibrush/media/core` exports `closeFrame`/`closeFrames`/
  `Closable`/`isClosable` (`src/core.ts:37`) as the shared helpers every driver should use.
- **Backpressure.** Coders/filters are `TransformStream`s, so WHATWG queueing strategies apply. The
  contract's non-obvious rule (documented at `defaults.ts:823-834`): a lazy filter stage's **writable
  `highWaterMark` must be ≥ 1** — a zero-HWM writable never reports room, so `pipeTo` waits on
  `writer.ready` forever and the whole decode→filter→encode chain stalls silently before the first frame
  (the Session-10 transcode-timeout regression, ADR-186). The wrapper sets HWM 1 on both sides
  (`defaults.ts:903`) so in-flight frames stay bounded for any stage shape.

## 4. Current state

**What exists and is good.** The contract file (`driver.ts`) is a clean, `any`-free set of interfaces with
the correct WebCodecs-native seam types and a well-designed `Packet` (`driver.ts:89-100`). The `Registry`
class is small and correct: version-gated, idempotent, Map-backed (`registry.ts:45-113`). The typed error
tree (`MediaError` → `CapabilityError`/`InputError`, `errors.ts:25-63`) exists and is used. The lazy proxy
pattern genuinely delivers miss-only loading, and `createLazyFilterStream` (`defaults.ts:836-904`) is a
model of cancel-correct, close-once, backpressure-aware stream wiring.

**God-file: `src/drivers/defaults.ts` (1291 lines).** This one file conflates at least six unrelated
responsibilities:
1. Registration wiring — `registerDefaultDrivers` (`defaults.ts:83-101`).
2. **A full FLAC container driver implemented inline** — `lazyFlacContainerDriver` implements
   `probe`/`packetInfo`/`demux` directly and constructs `EncodedAudioChunk`s in `flacPacketStream`
   (`defaults.ts:542-655`). Real demux logic living in the *registration* file is a layering violation;
   it belongs in `src/drivers/flac/`.
3. **Image format sniffing** — `sniffImageFormat`, `hasAvifBrand`, `brand`, `tag`, `u32be`
   (`defaults.ts:185-244`): byte-level magic parsing embedded in the registration module.
4. Byte-source IO — `readByteStream`, `readFlacBytes` (`defaults.ts:615-686`).
5. Two near-duplicate lazy muxer classes — `LazyFlacMuxer` (`965-1066`) and `LazyContainerMuxer`
   (`1068-1184`) share ~120 lines of ready/pump/error machinery.
6. **Browser UA capability detection** — `webgpuAvailable`, `canvas2dAvailable`,
   `chromiumCanvasTonemapAvailable`, Firefox/Chrome UA regexes (`defaults.ts:906-963`): capability
   detection that belongs in the router/tier layer (S01), not the driver-registration file.

**Module-global mutable state.** `imageOpsPromise` (`defaults.ts:130`) is a module-level `let` shared by
**every** engine instance in the process — the one genuine global-mutable cache in this family, defeating
the per-engine-registry isolation the rest of the design earns.

**Layering smell — drivers reach up into the kernel router.** Both registration helpers import
`../kernel/router.ts` and drive selection + cache invalidation themselves:
`default-codec-registration.ts:11` and `default-container-registration.ts:13` import `Router`;
`pickCodecWithDefaultFallback`/`pickContainerWithDefaultFallback` call `router.clearCache()` and
`router.pickCodec/pickContainer` (`default-codec-registration.ts:54-63`,
`default-container-registration.ts:143-152`). The `src/drivers/*` layer should describe *what to register*,
not orchestrate *how to re-route* — the retry/clear-cache orchestration belongs in the engine/kernel.

**Capability leak — the driver's optional-method surface is re-declared as boolean flags.** `lazyContainer`
rebuilds each container's capability surface from a hand-maintained `LazyContainerSpec` flag table
(`defaults.ts:270-290`) and, per flag, installs a wrapper that loads the real module and throws
`missingLazyMethod` if the real driver lacks the method (`defaults.ts:388-505`, helper `732-737`). The
advertised capability (method present on the proxy) and the real capability (method present on the loaded
module) are two sources of truth that can drift; when they drift the router routes to a driver that then
throws `capability-miss` at call time instead of routing elsewhere.

**Id/spec-id inconsistency in selective registration (owned code).** `SelectiveContainerSpec.id`
(`default-container-registration.ts:23-29`) is used both to pin-resolve (`candidate.id === pinDriver`,
`:125`) and is assumed to equal the registered driver's id — but for the mux entries it does **not**: the
`'mp4'` mux spec loads a driver whose real id is `'mp4-mux'` (`default-container-registration.ts:80-84`
vs `src/drivers/mp4/mp4-mux-driver.ts:32`), and likewise `'webm'` vs `'webm-mux'`
(`:86-90` vs `src/drivers/webm/webm-mux-driver.ts:27`). Combined with **first-wins by bare id**
(`registry.ts:96-98`), the capability surface registered under a container family can depend on which
operation ran first, and a pin on the real driver id (`'mp4-mux'`) is unresolvable through this table.

**Off-contract fourth kind.** Image ops are not one of the three driver kinds; they are bolted onto the
registry through `addImageOps` (`registry.ts:63-65`), which implements `ImageRegistry` declared in a codec
module (`src/codecs/image/image-driver.ts`), not the contract file. `defaults.ts:96` reaches it through a
structural cast: `(reg as Registry & { addImageOps?: ... }).addImageOps?.(...)`. So the canonical contract
(`driver.ts:544-549`) does not own the full registry surface, and image is smuggled in through a side door.

**Error-model smells.**
- `CapabilityErrorDetail.op` is `unknown` (`errors.ts:39`), and call sites pass wildly different shapes:
  a bare string (`'codec'`, `'demux'`, `defaults.ts:1261, 733`), a `CodecQuery` (`router.ts:83`), and a
  *doubly-nested* `{ op: 'mux' }` (`defaults.ts:993, 1002`). The `unknown` papers over an unstable shape.
- `tried` is sometimes `[]` even though work was attempted, e.g. the `writePcm` miss reports
  `tried: []` (`defaults.ts:1126`), contradicting the field's contract ("driver ids that were probed").
- Both `CapabilityError` and `InputError` constructors take an arbitrary `code: MediaErrorCode`
  (`errors.ts:51, 59`), so a `CapabilityError` with code `'decode-error'` is type-legal though nonsensical;
  every call site redundantly passes `'capability-miss'`. `detail` is typed `unknown` (`errors.ts:51`)
  rather than the `CapabilityErrorDetail` the class documents (`errors.ts:36-44`).

**Versioning is a bare major with a suspect window.** `DRIVER_API_VERSION = 1` (`driver.ts:21`).
`supportedApiVersions()` returns `[current, current-1]` guarded by `prev >= 0` (`registry.ts:31-34`), so
today the window is `[1, 0]` — a driver declaring `apiVersion: 0` is **accepted**, though major 0 was
never a real contract. There is no minor version or capability handshake, so the dozen additive optional
`ContainerDriver` methods (`probe … decodePcmInterleavedStream`) are undiscoverable except by duck-typed
runtime probing (`if (loaded.streamCopy === undefined) throw …`, `defaults.ts:425`).

## 5. Delta / punch-list

Ordered; each item has a concrete acceptance test. Items 1–4 are correctness; 5–10 are structure/typing.

1. **Fix selective-spec id vs driver id.** Make `SelectiveContainerSpec.id` equal the id of the driver its
   `load()` registers, or split the spec into a `specId` (for `matches`) and the real `driverId` (for pin
   resolution) and resolve pins against the real id. Ref `default-container-registration.ts:23-29, 80-90`;
   `mp4-mux-driver.ts:32`; `webm-mux-driver.ts:27`.
   *Acceptance:* a unit test iterates `SELECTIVE_CONTAINERS`, calls each `load()`, and asserts the
   registered driver's `id` equals the value used for pin matching; and `pickContainer({direction:'mux'},
   {pinDriver:'mp4-mux'})` after selective registration resolves the mux driver (currently a miss).

2. **Defend the registry against id-collision capability loss.** With two modules per container family
   (full demux+mux vs mux-only) and first-wins-by-id, the surviving surface depends on op order. Either
   (a) never reuse an id across distinct capability surfaces, or (b) make `#add` merge/replace when a
   later driver of the same id is strictly more capable. Ref `registry.ts:96-98`.
   *Acceptance:* register mux-only `mp4-mux`, then attempt to register full-capability `mp4`, then assert
   an MP4 **demux** resolves to a demux-capable driver (today it can be silently dropped by first-wins).

3. **Make `CapabilityError`/`InputError` codes intrinsic and details typed.** `CapabilityError` should fix
   `code = 'capability-miss'` and take `(message, detail: CapabilityErrorDetail)`; `InputError` should fix
   `'unsupported-input'`. Replace `MediaError.detail: unknown` on the capability path with the typed
   detail. Ref `errors.ts:36-63`.
   *Acceptance:* `new CapabilityError('the message', {op, tried})` typechecks and `err.code ===
   'capability-miss'`; passing any other code no longer compiles; a grep proves no call site passes a
   redundant `'capability-miss'` literal.

4. **Type `CapabilityErrorDetail.op` as a discriminated `OperationDescriptor` and forbid empty `tried`
   when work was attempted.** Replace `op: unknown` with a union
   (`{kind:'codec', query:CodecQuery} | {kind:'container', query:ContainerQuery} | {kind:'filter', spec} |
   {kind:'route', id:string}`), and remove the doubly-nested `{op:{op:'mux'}}` shapes. Ref `errors.ts:39`;
   `defaults.ts:993, 1002, 1126, 1261`; `router.ts:83`.
   *Acceptance:* a test constructs each thrown `CapabilityError` in owned code and asserts `detail.op`
   matches the union and `detail.tried.length > 0` whenever the message claims a probe happened.

5. **Assert the lazy flag table against the real modules (kill the drift).** For every `LazyContainerSpec`
   boolean flag (`probe`, `packetInfo`, `streamCopy`, `decrypt`, `transformPcm`, `decodePcm*`,
   `validates*`), assert the loaded module actually exposes that method; drivers that omit a claimed method
   should fail a **build/conformance** check, not a runtime `missingLazyMethod`. Ref `defaults.ts:270-290,
   388-505, 732-737`.
   *Acceptance:* a conformance test loads every lazy spec, and for each `flag: true` asserts
   `typeof loaded[flag] === 'function'` (and for each *false/omitted* flag that the proxy does not
   advertise it); the test fails if any real driver's surface disagrees with its spec flags.

6. **Fix the version window and add a discoverable minor/capabilities handshake.** `supportedApiVersions`
   must not accept `apiVersion: 0` while `DRIVER_API_VERSION === 1`; the window should be `[current]`
   until a real `current-1 ≥ 1` exists. Add either a `DRIVER_API_MINOR` or a `capabilities: readonly
   string[]` field on `DriverBase` so additive optional methods are advertised, not duck-typed. Ref
   `registry.ts:31-39`; `driver.ts:21, 137-142`.
   *Acceptance:* `isApiVersionSupported(0) === false`; a driver advertising `capabilities: ['streamCopy']`
   without implementing `streamCopy` is refused at registration with `driver-incompatible`.

7. **Move image ops into the contract as a first-class kind.** Either add a fourth registerable kind or
   declare `addImageOps`/`imageOps()` in `src/contracts/driver.ts` so the canonical contract owns the full
   registry surface; delete the structural cast. Ref `registry.ts:45, 63-65`; `defaults.ts:96`;
   `driver.ts:544-549`.
   *Acceptance:* `defaults.ts` registers image ops through a typed contract method with no `as` cast, and
   `RegistryView.imageOps()` / the write method are both declared in the contract file.

8. **Extract the FLAC driver, image sniff, and byte-IO out of `defaults.ts`.** Move `lazyFlacContainerDriver`
   /`flacPacketStream` into `src/drivers/flac/`; move `sniffImageFormat`+helpers into the image codec
   module; move `readByteStream`/`readFlacBytes` into a shared source util. `defaults.ts` should contain
   only registration wiring + lazy proxy factories. Ref `defaults.ts:130-244, 542-686`.
   *Acceptance:* `defaults.ts` drops below ~500 lines and imports zero `EncodedAudioChunk` construction;
   FLAC demux tests import from `src/drivers/flac/`, not `drivers/defaults.ts`; all existing tests pass.

9. **De-duplicate the two lazy muxers.** Fold `LazyFlacMuxer` and `LazyContainerMuxer` into one
   parameterized lazy muxer (single-track vs multi-track is a config, not a class). Ref
   `defaults.ts:965-1184`.
   *Acceptance:* one muxer class remains; the FLAC single-stream constraint is expressed as a
   `validateTrack`/`maxTracks: 1` option; mux golden tests for FLAC and every container still pass.

10. **Relocate browser/UA capability detection to the tier layer, and remove the module global.** Move
    `webgpuAvailable`/`canvas2dAvailable`/`chromiumCanvasTonemapAvailable`/UA regexes into S01's
    capability/tier module, and replace the `imageOpsPromise` module global with per-registry state. Ref
    `defaults.ts:130, 906-963`.
    *Acceptance:* `defaults.ts` contains no `navigator.userAgent` regex and no module-level mutable `let`;
    two `createMedia()` engines in one process each resolve image ops independently (a test that creates
    two engines and asserts no shared promise identity leaks between them).

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
