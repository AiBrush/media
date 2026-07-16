# Video Filters

> Target spec for the **video filter** family (the pixel transforms applied inside a transcode). This
> document describes the **best** design and an honest **delta** against the code as it stands in
> `src/filters/gpu-video.ts`, `src/filters/cpu-video.ts`, `src/filters/geometry.ts`,
> `src/filters/gpu-uniforms.ts`, `src/filters/video-color-space.ts`, and `src/util/rotation.ts`. It is
> what a coding agent implements against — not a description of today's code.

## 1. Purpose & scope

A **video filter** is a declarative, substrate-routed pixel transform on already-decoded
`VideoFrame`s: `resize`, `crop`, `pad`, `rotate`, `flip`, `colorspace`, and `tonemap`. Each is a
`FilterSpec` variant (`src/contracts/driver.ts:499`) realized as a
`TransformStream<VideoFrame, VideoFrame>` (`FilterDriver.createFilter`, `src/contracts/driver.ts:536`).
Filters sit in the middle of the transcode graph — `decode → filter* → encode → mux` — and are the
only stage that touches raw pixels, so their correctness is the pixel-quality (SSIM) determinant of the
whole transcode.

**Benchmark family served: `transcode` (filters).** These are the transform rows of the transcode
family — `h264_rotate_normalize`, `h264_crop_center`, `h264_resize_720p`, `h264_resize_4k_to_1080p`,
the `ladder_*_resize_*` rows, `colorspace`, and `tonemap` (HDR10→SDR). On the fair harness nearly every
transform previously timed out or lost on quality; the two live quality FAILs at the time of harvest were
`transcode/h264_rotate_normalize` SSIM **0.946** and `multitrack_select_default_audio` **0.950** against a
**0.98** gate (measured-evidence.md). The GPU geometric filters currently drop luma to **Y-SSIM ~0.86** (bear
rotate180 0.866, resize 640×360 0.864) while a plain re-encode scores ~0.99 (measured-evidence.md); closing that
gap is the reason this shard exists.

**Scope of these six files:**

- **Geometry math** (pure, Node-tested, no browser types): `geometry.ts` resolves a `FilterSpec` + source
  dims into a `Blit` (resize/crop/pad) or an `Affine`/`OrientedDraw` (rotate/flip).
- **Color science** (pure, Node-tested): `gpu-uniforms.ts` owns gamut matrices (BT.709/601/2020/sRGB),
  transfer curves (sRGB / BT.709 / PQ / HLG / linear), Reinhard & Hable tonemap, spec→`ColorPlan`
  selection, and the two std140 uniform packers.
- **Substrate renderers**: `gpu-video.ts` (WebGPU primary + Canvas2D fallback) and `cpu-video.ts` (pure-TS
  CPU floor) each turn a plan into pixels and wire the `TransformStream`.
- **Color metadata boundary**: `video-color-space.ts` maps a frame's `VideoColorSpace` ↔ the plan's
  `SourceColor` and tags output frames.
- **Rotation normalization**: `src/util/rotation.ts` normalizes clockwise display rotation and converts to
  Matroska's counter-clockwise `ProjectionPoseRoll`.

Out of scope for this shard: audio filters (audio-dsp, S17), the router cost model that classifies filter
work as tiny/heavy (S01; the boundary is `videoPixelWork ≤ 245,760`, measured-evidence.md), and the encoder's
RGB→YUV / rate control (S11). High-bit-depth (10/12-bit) filtering is a documented typed miss — every
crop/resize/pad/rotate/flip/colorspace/tonemap is treated as an **8-bit** pixel boundary (measured-evidence.md).

## 2. Spec & references

Governing standards (every reference links to its canonical source):

- **W3C WebCodecs** — `VideoFrame`, `VideoFrame.copyTo(...,{format:'RGBA'})`, `VideoColorSpace`
  (`primaries`/`transfer`/`matrix`/`fullRange`), explicit `close()` lifetime:
  <https://www.w3.org/TR/webcodecs/>. `copyTo` to `'RGBA'` returns pixels in the frame's **own** color
  space (the UA applies only the YUV→RGB matrix, not display tone-management) — the property that lets the
  CPU path do genuine wide-gamut / PQ·HLG→SDR math (measured-evidence.md, ADR-038; `src/filters/cpu-video.ts:17-22`).
- **W3C WebGPU** and **WGSL** — external textures, render pipelines, std140 uniform layout:
  <https://www.w3.org/TR/webgpu/>, <https://www.w3.org/TR/WGSL/>. `importExternalTexture` +
  `textureSampleBaseClampToEdge` are the zero-copy sampling primitives:
  <https://www.w3.org/TR/webgpu/#gpuexternaltexture>.
- **WHATWG HTML — Canvas 2D** — `drawImage(VideoFrame, …)`, `setTransform`, `imageSmoothingEnabled`,
  `imageSmoothingQuality`: <https://html.spec.whatwg.org/multipage/canvas.html#image-smoothing>.
  `drawImage(VideoFrame)` yields UA-color-managed display pixels (the honest HDR→SDR path on Chromium).
- **WHATWG Streams** — `TransformStream`, backpressure, `highWaterMark`, readable `cancel`:
  <https://streams.spec.whatwg.org/>.
- **Color spaces:** ITU-R **BT.709** <https://www.itu.int/rec/R-REC-BT.709>, **BT.601**
  <https://www.itu.int/rec/R-REC-BT.601>, **BT.2020** <https://www.itu.int/rec/R-REC-BT.2020>, **BT.2100**
  (PQ & HLG systems) <https://www.itu.int/rec/R-REC-BT.2100>, SMPTE **ST 2084** (PQ EOTF)
  <https://ieeexplore.ieee.org/document/7291452>, ARIB **STD-B67** (HLG), IEC **61966-2-1** (sRGB)
  <https://webstore.iec.ch/en/publication/6169>. The engine's constants derive directly from these:
  the PQ constants `m1=2610/16384, m2=(2523/4096)·128, c1=3424/4096, c2=(2413/4096)·32, c3=(2392/4096)·32`
  (`src/filters/gpu-uniforms.ts:272-276`) are the ST 2084 values verbatim, and the HLG `a/b/c`
  (`src/filters/gpu-uniforms.ts:281-283`) are the STD-B67/BT.2100 constants.
- **H.273 coded-independent code points** — WebCodecs accepts several tokens (`bt2020`, `smpte432`, `pq`,
  `hlg`, `bt2020-ncl`) that lib.dom's color enums predate (measured-evidence.md), which is why the code casts its
  RGB tag through `VideoColorSpaceInit` (`src/filters/cpu-video.ts:449-452`):
  <https://www.itu.int/rec/T-REC-H.273>.

**OSS exemplars to study & beat:**

- **FFmpeg `vf_scale`** (libswscale) — resize with explicit `in_range`/`out_range`,
  `in_color_matrix`/`out_color_matrix`; it never silently reinterprets transfer:
  <https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_scale.c>,
  <https://github.com/FFmpeg/FFmpeg/blob/master/libswscale/swscale.c>.
- **FFmpeg `vf_zscale`** wrapping **zimg** (Sekrit-twc) — the reference for *transfer-correct* scaling:
  it linearizes (EOTF) before resampling, does full primaries/matrix/range/transfer conversion, tone-maps,
  and dithers on output: <https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_zscale.c>,
  <https://github.com/sekrit-twc/zimg>. **The SOTA lesson zscale teaches — and where our current code is
  wrong — is that resampling must happen in *linear light* and the working (matrix/transfer/primaries/range)
  space must be a first-class tag that is never re-interpreted.** Our geometry path resamples in gamma space
  and re-tags BT.709 as sRGB (§4, §5.1/§5.6).
- **GPU shader filters** — the single-textured-quad pattern (one pipeline, geometry encoded in per-frame
  uniforms) mirrors the classic full-screen-triangle blit used across WebGPU samples:
  <https://github.com/webgpu/webgpu-samples>.

## 3. Target design

### 3.1 Data model (substrate-independent, pure)

The whole filter family reduces to two pure resolutions, both computable in Node with **no** browser types
(so they are bit-exactly unit-tested independent of any GPU):

1. **Geometry**: `(FilterSpec, srcW, srcH) → DrawRecipe`.
   - `Blit { dims, src: Rect, dst: Rect }` for resize/crop/pad (`src/filters/geometry.ts:36-41`). `resize`
     honors `fit: 'fill' | 'contain' | 'cover'` (`src/filters/geometry.ts:97-130`); `crop` and `pad`
     validate the rect against real source dims and throw a typed `InputError` on out-of-bounds
     (`src/filters/geometry.ts:141-164`, `:175-197`) — never a silent clamp.
   - `OrientedDraw { dims, transform: Affine }` for the lossless ops rotate/flip
     (`src/filters/geometry.ts:207-238`, `:248-257`). Rotation affines are exact ±1 integer matrices;
     90°/270° swap width↔height.
2. **Color**: `(FilterSpec, SourceColor) → ColorPlan { decode, gamut, tonemap, encode }`
   (`src/filters/gpu-uniforms.ts:387-392`). The plan is the canonical per-pixel pipeline — the same order
   the CPU loop and both WGSL fragment shaders execute:

   ```ts
   // src/filters/cpu-video.ts:171-188 (applyColorPlanRgb): EOTF → gamut 3×3 → tonemap → OETF, clamped.
   const lin: Rgb = [eotf(plan.decode, rgb[0]), eotf(plan.decode, rgb[1]), eotf(plan.decode, rgb[2])];
   const conv = applyMat3(plan.gamut, lin);
   let mapped: Rgb = [conv[0], conv[1], conv[2]];
   if (plan.tonemap !== null) { /* per-channel applyTonemap */ }
   return [ sat01(oetf(plan.encode, sat01(mapped[0]))), /* g, b */ ];
   ```

   Gamut matrices are built from CIE xy primaries + D65 by the canonical `M = [R G B]·diag(S)` construction
   (`src/filters/gpu-uniforms.ts:217-237`) so they reproduce the published constants; same-primaries pairs
   (sRGB↔BT.709) return exact identity (`:259-262`). HDR EOTFs return **SDR-white-relative** linear light
   (PQ code 1.0 = 100× SDR white, HLG = 12×) so the tonemap `peak` is a real parameter
   (`src/filters/gpu-uniforms.ts:277-283, 296-316`).

These two resolutions are the **single seam**: every substrate consumes the *same* `DrawRecipe`/`ColorPlan`
and must produce pixel-equal output. The uniform packers `packUniforms` (48 bytes std140,
`src/filters/gpu-uniforms.ts:15, 82-99`) and `packColorUniforms` (64 bytes, column-major `mat3x3`,
`:479, 501-517`) are the only bridge from pure plan → GPU buffer.

### 3.2 Seams & capability routing (WebCodecs → GPU → WASM, miss-only)

The developer never names a substrate. `Engine` builds a `FilterSpec`; the router ranks the registered
`FilterDriver`s by `substrate` (`webgpu → webgl → canvas2d → native → wasm`, `src/contracts/driver.ts:528`)
and picks the highest whose cheap synchronous `supports()` is true (ADR-003, measured-evidence.md). Filters are the
**GPU rung** of the codec ladder (`hardware WebCodecs → GPU (filters) → native/sw WebCodecs → WASM`,
ADR-002). Concretely:

- **WebGPU** (`substrate:'webgpu'`, `src/filters/gpu-video.ts:793-815`) — `importExternalTexture(frame)` →
  sampled full-screen quad → `OffscreenCanvas` of the target size → new `VideoFrame`. Device/pipeline/sampler
  are built once per stream `start` and reused per frame (`:530-563`). Handles every geometric op + a
  `colorspace` op; **tonemap intentionally falls through to CPU** because Chromium WebGPU external-texture
  tonemap proved unstable on the tiny HDR10 path (`:773-775`).
- **Canvas2D** (`substrate:'canvas2d'`, `src/filters/gpu-video.ts:823-845`) — `drawImage`/`setTransform`.
  Handles geometry + display-gamut colorspace + (Chromium) HDR→SDR tonemap; declines wide-gamut colorspace
  so it never emits wrong pixels (`:95-99, :782-785`). WebGL is intentionally **omitted** (ADR-027): Canvas2D
  `drawImage` is itself GPU-accelerated and pixel-exact for geometry, so it is the single fallback
  (measured-evidence.md).
- **Native CPU** (`substrate:'native'`, `src/filters/cpu-video.ts:573-590`) — pure-TS `copyTo`→RGBA→math→new
  `VideoFrame`. It is **more** capable for color than Canvas2D because `copyTo` yields own-space pixels, so it
  is the honest floor for genuine wide-gamut / PQ·HLG→SDR (ADR-038, `src/filters/cpu-video.ts:17-22`). It is
  `'native'` (pure TS, zero WASM), ranked below the GPU rungs and above a future WASM filter tail (ADR-076,
  measured-evidence.md).
- **Miss-only WASM:** there is **no** WASM video-filter tail today; the `wasm` rung of the substrate enum is
  reserved. On a true miss (e.g. Node, no `VideoFrame`) `supports()` returns false everywhere and
  `createFilter` throws a typed `CapabilityError` (`src/filters/gpu-video.ts:802-807`,
  `src/filters/cpu-video.ts:582-587`) — fail loudly, never a silent passthrough.

**Registration is lazy** to protect the bundle budget: the default build installs cheap `FilterDriver`
proxies whose `supports()` is synchronous and imports the concrete module only on the first supported frame
(measured-evidence.md). **`force-software`** (`StageOptions.determinism`, `src/contracts/driver.ts:48`) drops
`webgpu`/`webgl`/`canvas2d` (Canvas2D counts as GPU-accelerated) leaving native → wasm (measured-evidence.md).

Capability probing is **cheap and honest** — `supports()` only feature-detects globals; heavy device
acquisition happens lazily in the stream `start` (`WebGPURenderer.create`, `src/filters/gpu-video.ts:530`),
and if no adapter is granted it throws `CapabilityError` so the router falls through.

### 3.3 Edge cases

- **B-frames — not applicable.** A filter operates on already-decoded `VideoFrame`s handed to it one at a
  time in presentation order by the decode stage (S10). Bitstream frame types never reach this layer. State
  it and move on.
- **VFR (variable frame rate) — preserved, not interpreted.** Filters are per-frame and stateless w.r.t.
  timing: each output carries the source `timestamp` and, **only when present**, the source `duration`
  (`framedInit`, `src/filters/gpu-video.ts:195-198`; `rgbaToFrame` duration-conditional,
  `src/filters/cpu-video.ts:479`). No cadence is assumed or resampled here; VFR is faithfully carried
  through. (Omitting `duration` when `null` is deliberate — a fabricated duration would corrupt VFR.)
- **Seek — not applicable at this layer.** Seek is a decoder/demuxer concern (S10). Filters see whatever
  frames the upstream produces.
- **Cancel.** Both stream builders bind teardown to `StageOptions.signal`: the GPU stream disposes the
  device/context/canvas ring on abort (`release` on the abort listener, `src/filters/gpu-video.ts:716-725`,
  `dispose` destroys the device and pooled canvases `:655-665`); the CPU stream flips a `cancelled` flag and
  throws `MediaError('aborted')` on the next frame (`src/filters/cpu-video.ts:519-531`). The `Transformer`
  interface has no `cancel` hook, so cancel rides the `AbortSignal` listener by design. No frame is buffered
  across the boundary — the draw consumes the source synchronously (GPU) or awaits `copyTo` to completion
  (CPU) within a single `transform`.
- **Frame lifetime (`close()` exactly once) — the hardest invariant.** Every input frame is closed exactly
  once in a `finally`, and a failed hand-off closes the output:

  ```ts
  // src/filters/gpu-video.ts:743-756 — close-once discipline.
  try {
    const out = renderer.render(frame, recipe);
    let handedOff = false;
    try { controller.enqueue(out); handedOff = true; } finally { if (!handedOff) out.close(); }
  } finally {
    frame.close(); // the draw consumed the source synchronously; release it exactly once.
  }
  ```

  The CPU path mirrors this (`src/filters/cpu-video.ts:532-544`), closing the source only after `copyTo` has
  fully read it into our buffer. **Gap (see §5.5):** a frame already *enqueued* into the readable side that is
  then cancelled downstream is discarded by the Streams spec **without** `close()` — a leak the target design
  must plug.
- **Backpressure.** The `TransformStream`'s default queuing applies natural backpressure: `transform` is not
  re-invoked until the readable is pulled, so at most one output is in flight per stage. The CPU `transform`
  is `async` (`copyTo` is a Promise) but buffers nothing across calls; the GPU `transform` is synchronous.
  Target: keep `highWaterMark` explicit (the sibling stages run pull-driven at `highWaterMark: 0`,
  measured-evidence.md) and never accumulate unclosed frames under stall.

## 4. Current state

What exists today, with the smells named plainly.

**It works and is honest where it counts.** The pure geometry/color math is real, standards-derived, and
Node-tested to parity (`geometry.ts`, `gpu-uniforms.ts` are clean, single-purpose, browser-type-free). There
is **no module-global mutable state**: renderer pools are per-instance (`Canvas2DRenderer.pool`
`src/filters/gpu-video.ts:248`, `WebGPURenderer.canvasPool` `:519`), constants are `const`. Close-once
discipline is implemented on both substrates. Capability checks are cheap. This is a good base.

**God-file: `gpu-video.ts` (868 lines).** One file holds: capability detection (`:104-142`), **two** inline
WGSL shader strings (geometric quad `:329-373`, color pipeline `:386-496`), `Canvas2DRenderer` (`:244-319`),
`WebGPURenderer` (`:515-666`), the shared stream wiring (`:707-764`), and **two** driver definitions
(`:793-845`). It should be five or six files (§5.9).

**Duplication / triplicated logic.**
- Spec predicates `isGeometricVideoSpec`/`isColorVideoSpec` are defined in **both** `gpu-video.ts:73-87` and
  `cpu-video.ts:359-378`.
- Plan resolution is mirrored: `planDraw`/`planColor` (`gpu-video.ts:157-183`) vs
  `planCpuGeometry`/`planCpuColor` (`cpu-video.ts:381-407`) — the CPU file's own comment admits it "mirrors
  gpu-video, kept local" (`cpu-video.ts:344`). `DrawRecipe` (`gpu-video.ts:151-154`) and `CpuGeometry`
  (`cpu-video.ts:334`) are near-duplicate recipe types.
- `chromiumCanvasTonemapAvailable` is defined **twice** verbatim: `gpu-video.ts:120-123` and
  `cpu-video.ts:433-441`.

**Second source of truth for color math (the sharpest smell).** `COLOR_WGSL` (`gpu-video.ts:386-496`)
hand-transcribes `eotf`/`oetf`/`reinhard`/`hable` and every constant — `BT709_A`, the five PQ constants,
`HLG_B = 0.28466892`, `HLG_C = 0.55991073` (`:409-420`) — that must stay bit-identical to the TS constants in
`gpu-uniforms.ts:266-343`. **Nothing enforces the match**; a change to one silently diverges from the other.
The doc comment *claims* "same constants" but there is no generator and no cross-check test.

**Capability leak: browser-name sniffing in the driver layer.** `webgpuAvailable` hardcodes a Firefox UA
exclusion (`gpu-video.ts:104-113`) and `chromiumCanvasTonemapAvailable` matches `Chrome|Chromium|CriOS|Edg`
(`gpu-video.ts:120-123`, `cpu-video.ts:433-441`). The Firefox decline is driven by a *measured* SSIM
0.9694 < 0.97 (ADR-110, measured-evidence.md) and the Chromium tonemap routing by a real `copyTo`-rejects-opaque-HDR
quirk (ADR-214, measured-evidence.md) — both facts are legitimate, but encoding them as UA regexes in `supports()`
leaks browser identity into the layer that is supposed to route on *capability*, and is fragile across UA
changes.

**The correctness defect: geometry round-trips YUV→RGB→sRGB→YUV.** Both GPU and Canvas2D geometry draw to an
`OffscreenCanvas`, which yields a **full-range sRGB** `VideoFrame` (primaries bt709, transfer
`iec61966-2-1`, matrix rgb, fullRange true) from a **limited-range BT.709** source (matrix bt709, fullRange
false). Per the harvest, the dominant SSIM error is the **sRGB transfer curve forced onto BT.709 content**
(range is only a minor +6/255 luma lift), producing Y-SSIM ~0.86 (measured-evidence.md). Two quick fixes (re-tagging
output color space; studio-range compressing RGBA) were tried, measured, and reverted — the encoder ignores
the tag and the transfer error dominates; the recorded correct fix is **keeping geometry in native YUV
planes / a transfer-and-range-correct resample** (measured-evidence.md). The `webgpuGeometryNeedsCanvasColorManagement`
guard (`gpu-video.ts:134-142`) routes explicitly-tagged limited-range / BT.601-matrix frames to Canvas2D to
avoid an `importExternalTexture` luma offset — a mitigation, not the fix.

**Dead-in-plan operator.** `tonemapHable` (`gpu-uniforms.ts:363-373`) and WGSL `hable` (`gpu-video.ts:474-485`)
are implemented and tested, but `planTonemap` only ever emits `reinhard` (`gpu-uniforms.ts:466-474`) and the
`FilterSpec` tonemap target is `'sdr'` only (`src/contracts/driver.ts:512`), so Hable is unreachable from any
spec.

**Canvas2D quality knob is a Chromium-tuned magic value.** `imageSmoothingQuality = 'medium'`
(`gpu-video.ts:289`) was the fix that took the ladder transcode from ~12× behind to tied (`'high'` is
Chromium bicubic/Lanczos, CPU-bound, main-thread-blocking; mediabunny leaves the default `'low'`, measured-evidence.md).
Correct on Chromium; unproven on other UAs. `OUTPUT_CANVAS_POOL_SIZE = 4` (`gpu-video.ts:228`) is likewise a
hardcoded ring depth with a good rationale but no benchmark tying the number to the pipeline.

**CPU parity is self-parity.** `sampleBilinear` (`cpu-video.ts:250-277`) uses per-channel `Math.round`;
the "parity to GPU" tests are Node-only pure math (`cpu-video.ts:29-31`), never cross-checked against real
GPU `textureSampleBaseClampToEdge`. Resampling on both paths happens in **gamma (encoded) space**, not linear
light — a quality gap versus zscale/zimg.

## 5. Delta / punch-list

Ordered by impact. Each item states the change and a concrete acceptance oracle.

1. **Fix the geometry color round-trip (top defect).** Make geometric ops transfer-and-range correct:
   preserve the source transfer (a BT.709 source stays BT.709, not `iec61966-2-1`) and limited range, ideally
   by resampling in native YUV planes or in linear light with a range-preserving re-encode, rather than
   letting the `OffscreenCanvas` re-encode to full-range sRGB (`src/filters/gpu-video.ts:272-313`,
   `:606-653`; tag site `src/filters/video-color-space.ts:79-86`).
   *Acceptance:* an in-browser oracle rotates/resizes a limited-range BT.709 fixture and asserts **Y-SSIM ≥
   0.98** vs the ffmpeg reference (today `transcode/h264_rotate_normalize` = 0.946); plus a tag assertion that
   a geometry-only output is **not** retagged to `iec61966-2-1` and keeps `fullRange:false` when the source is
   limited range.

2. **Collapse the triplicated spec-classification + plan resolution into one module.** Extract a single
   substrate-independent plan module owning `isGeometricVideoSpec`/`isColorVideoSpec`, `planDraw`/`planColor`,
   and the `DrawRecipe` type; delete the copies in `cpu-video.ts:334, 359-407` and `gpu-video.ts:73-87,
   151-183`.
   *Acceptance:* `grep` finds exactly one definition of each predicate/planner; a test asserts the CPU and GPU
   recipe for the same `(spec, srcW, srcH)` are `deepStrictEqual`.

3. **Eliminate the second source of truth for color math.** Generate the `COLOR_WGSL` constant block
   (`src/filters/gpu-video.ts:409-420`) from the TS constants in `gpu-uniforms.ts:266-283`, or add a guard
   test that parses each `const X : f32 = N;` out of the shader string and asserts equality with the TS value
   to full precision.
   *Acceptance:* a Node test extracts every WGSL `f32` constant and asserts `=== ` the TS constant; a browser
   GPU-vs-CPU parity test on PQ/HLG/BT.2020 fixtures asserts SSIM ≥ threshold.

4. **De-duplicate and de-UA-sniff capability detection.** One shared `capabilities` module; express the
   Firefox WebGPU decline (measured SSIM 0.9694 < 0.97, ADR-110) and the Chromium HDR `copyTo` quirk
   (ADR-214) as named capability/quirk flags, not `/Firefox/`/`/Chrome|Chromium|CriOS|Edg/` regexes in
   `supports()` (`src/filters/gpu-video.ts:104-123`, `src/filters/cpu-video.ts:433-441`).
   *Acceptance:* exactly one definition of `chromiumCanvasTonemapAvailable`; a test asserts no `navigator.
   userAgent` read inside any `FilterDriver.supports()`; router still declines WebGPU under the Firefox-SSIM
   quirk flag.

5. **Close queued output frames on readable cancel (frame-lifetime leak).** Add a readable `cancel` /
   drain-and-close path so `VideoFrame`s already enqueued but never read are `close()`d when the consumer
   cancels (`src/filters/gpu-video.ts:727-763`, `src/filters/cpu-video.ts:526-549`).
   *Acceptance:* a test enqueues N outputs, cancels the readable, and asserts `VideoFrame.close()` was called
   exactly N times (spy count == enqueued count), zero leaks.

6. **Resize in linear light (match zscale/zimg).** Change `resizeBlitToRgba` (`src/filters/cpu-video.ts:284-299`)
   and the GPU sampling so downscales resample after EOTF (linear), then re-encode — reducing ringing/aliasing
   the way zimg does.
   *Acceptance:* a downscale oracle on a high-contrast edge fixture asserts lower energy error than the current
   gamma-space resample and SSIM parity with a `zscale=...:t=linear` reference (exact threshold `UNVERIFIED`
   pending a baked golden).

7. **Give the CPU path a real cross-substrate parity oracle.** Add a browser harness that renders the same
   `(spec, fixture)` on WebGPU, Canvas2D, and CPU and compares pixels — replacing self-parity
   (`src/filters/cpu-video.ts:29-31, 250-277`).
   *Acceptance:* pairwise SSIM ≥ threshold across the three substrates on the geometry + colorspace fixtures
   (threshold `UNVERIFIED` pending goldens).

8. **Make tonemap operator/target configurable, or delete the dead operator.** Either extend the `tonemap`
   `FilterSpec` (`src/contracts/driver.ts:512`) with an operator/peak and make `planTonemap`
   (`src/filters/gpu-uniforms.ts:466-474`) able to select Hable, or remove `tonemapHable`
   (`gpu-uniforms.ts:363-373`) + WGSL `hable` (`gpu-video.ts:474-485`).
   *Acceptance:* a plan test proves both reinhard and hable are reachable from a spec; **or** the Hable code is
   gone and coverage stays green with no orphaned tested-but-unreachable branch.

9. **Split the `gpu-video.ts` god-file (868 lines).** Extract `wgsl/geometry.wgsl.ts`, `wgsl/color.wgsl.ts`,
   `canvas2d-renderer.ts`, `webgpu-renderer.ts`, `filter-stream.ts`, `capabilities.ts` from
   `src/filters/gpu-video.ts:104-865`.
   *Acceptance:* no single filter source file exceeds ~300 lines; the public exports (`webgpuVideoFilterDriver`,
   `canvas2dVideoFilterDriver`, `GpuVideoFilterModule`) are unchanged (import-surface test green).

10. **Add an explicit identity/no-op geometry passthrough recipe.** A resize/pad/rotate-0 whose output equals
    the source dims still round-trips through RGBA today (`exactBlitToRgba`, `src/filters/cpu-video.ts:236-248`;
    GPU still draws) — the identity round-trip is the SSIM 0.9735→0.9943 case (ADR-189, measured-evidence.md).
    Introduce a `{ kind: 'identity' }` recipe that the stream passes the input frame through unchanged
    (close-once preserved).
    *Acceptance:* a plan test that resize/pad/rotate-0 equal to source dims yields `identity` and the stream
    enqueues the source frame with no draw; measured output SSIM == 1.0.

11. **Document/benchmark `OUTPUT_CANVAS_POOL_SIZE` and the Canvas2D smoothing knob.** Tie the ring depth
    (`src/filters/gpu-video.ts:228`) and `imageSmoothingQuality` (`:289`) to measurements rather than magic
    values.
    *Acceptance:* a benchmark shows ring depth > 1 hides snapshot latency (throughput ≥ single-canvas
    baseline) and records the per-UA smoothing choice; regression fails if throughput drops below the recorded
    floor.

## 6. Open questions

Each seeds a decision record in `docs/decisions/`.

1. **YUV-plane vs linear-RGB geometry.** Is the correct geometry fix a true YUV-plane resample (WebGPU compute
   over Y/U/V planes, keeping limited range) or a linear-light RGB path that re-encodes with the *source*
   transfer/range? The harvest names "native YUV planes" as the recorded correct fix (measured-evidence.md); WebGPU
   external textures sample to RGB, so a plane path needs `copyTo` into YUV buffers + a compute shader. Decide
   the substrate and prove the SSIM ≥ 0.98 gate on limited-range BT.709. Cross-cutting with S11 (encoder
   RGB→YUV).

2. **Firefox WebGPU decline — quirk flag vs measured probe.** Should the Firefox WebGPU decline be a static
   quirk flag (current UA sniff, ADR-110) or a one-time in-session capability probe that renders a known
   fixture and measures SSIM before trusting the rung? A probe removes the UA regex but costs a warm-up render.

3. **Resampler quality target.** Do we match zscale's linear-light + dither, or stop at bilinear? Bilinear is
   cheap and matches Canvas2D; linear-light + a proper kernel (Lanczos/area) closes the downscale-quality gap
   but adds cost on the CPU floor (baseline colorspace kernel ~7.7 MP/s, measured-evidence.md). Needs a
   quality-vs-throughput decision with a baked golden threshold (`UNVERIFIED` today).

4. **WASM filter tail — build it or keep it reserved?** The `wasm` substrate rung exists in the enum
   (`src/contracts/driver.ts:529`) but no driver fills it. Is there any filter op (e.g. a high-quality
   linear-light resampler, or a filter needed under `force-software` where Canvas2D is dropped) that justifies
   a WASM tail, or does the pure-TS `native` floor suffice forever?

5. **Tonemap surface.** Should `tonemap` expose operator (reinhard/hable) + target peak + a non-`sdr` target,
   or stay `to:'sdr'` with a fixed reinhard operator (deleting Hable)? Depends on whether any benchmark row
   needs HDR→HDR or filmic tone mapping.

6. **High-bit-depth filtering.** 10/12-bit filtering is a typed miss today; every op is an 8-bit boundary
   (measured-evidence.md). When (if) a proven 10-bit browser encode+reimport path lands (S11/S30), which filters get a
   16-bit intermediate, and does the CPU floor carry `Uint16` RGBA?
