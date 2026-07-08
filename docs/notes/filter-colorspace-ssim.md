# GPU geometric-filter colour round-trip vs the SSIM oracle (Session 10)

**Status:** root-caused, not yet fixed; the correct fix is a native-YUV geometric filter (below). Two fair-harness cells depend on it: `transcode/h264_rotate_normalize` (SSIM 0.946) and `transcode/multitrack_select_default_audio` (SSIM 0.950), gate 0.98.

## Symptom

On real footage a **plain** H.264 re-encode scores SSIM ≈ 0.99 (bear 0.9875, obs 1.000 vs source), but any transcode that runs a **geometric GPU filter** (rotate / resize / crop / flip) drops to **Y-SSIM ≈ 0.86** while chroma stays high (U 0.97, V 0.98). The luma-only degradation is the tell.

## Measurements (real corpus, bear-1280x720, force-software-independent)

| path | Y-SSIM | All-SSIM | output YAVG (source rotated = 143.99) |
|------|-------:|---------:|--------------------------------------:|
| plain re-encode (no filter) | ~0.99 | 0.9875 | — |
| rotate180 (GPU filter) | 0.866 | 0.902 | **149.96** (+6, full-range) |
| resize 640×360 (GPU filter) | 0.864 | 0.899 | — |
| rotate180 + source-colorspace re-tag | 0.864 | 0.902 | 149.87 (tag limited, pixels still full) |
| rotate180 + studio-range compress | 0.860 | 0.899 | **144.72** (mean now matches!) |

## Root cause — two stacked colour errors, both from the canvas round-trip

The GPU renderers (`gpu-video.ts`) draw the decoded frame to an `OffscreenCanvas` and return `new VideoFrame(canvas, …)`. Probing the live `VideoColorSpace`:

- **source** frame: `{ primaries: bt709, transfer: bt709, matrix: bt709, fullRange: false }` (limited-range BT.709 video).
- **canvas-derived** frame: `{ primaries: bt709, transfer: iec61966-2-1 (sRGB), matrix: rgb, fullRange: true }` (full-range sRGB).

1. **Range.** The canvas is full-range; the WebCodecs `VideoEncoder` then writes a **limited**-range VUI over full-range pixels (probed: encoder emits `fullRange:false` from a full-range input) → a uniform +6/255 luma lift. Compressing the RGBA to studio swing before encode makes the **mean** match (144.72 vs 143.99) — but SSIM does **not** move, so range is the *minor* term.

2. **Transfer curve (dominant).** The canvas forces the **sRGB** transfer onto BT.709 source content. sRGB and BT.709 OETF differ (linear toe + 2.4 vs pure ~2.2), so the luma **tone curve** is distorted through decode→sRGB-canvas→encode. That is a *structural* luma error: the mean can match while local contrast/detail does not — exactly the observed Y-SSIM 0.86 with a correct mean. Neither a colour-space re-tag nor a studio-range compress fixes it, because both leave the pixels on the wrong transfer curve.

Chroma survives because it is centred (matrix `rgb`↔`bt709` and 4:2:0 are near-lossless for the low-frequency chroma of natural footage), so U/V stay ≥ 0.97.

## Why the quick fixes fail (evidence, so we don't retry them)

- **Re-tag output to the source colour space** (mirrors `cpu-video.ts`): the encoder ignores the input tag for range and keeps full-range pixels → no SSIM change.
- **Studio-range compress the RGBA**: fixes the mean, not the transfer → no SSIM change.

Both were implemented, measured, and reverted (`gpu-video.ts` is byte-identical to HEAD). The CPU filter path (`cpu-video.ts`) round-trips through RGBA the same way, so it shares the defect — routing geometric ops to CPU would not help and would cost speed.

## Correct fix (deferred — substantial, shared-hot-path)

Keep geometric ops in the decoder's **native YUV** and never touch the canvas sRGB pipeline (BUILD §3.A: "keep the plain path in the decoder's native pixel format — avoid per-frame RGBA round-trips unless a colour op requires them"):

- Sample the **luma and chroma planes** of the `VideoFrame` directly (WebGPU can bind them via `copyExternalImageToTexture`/plane views or a NV12/I420 upload) rather than `importExternalTexture` → sRGB canvas.
- Apply the geometry (the existing pure `uvScale/uvOffset/rot` uniforms already describe it) in plane space, write NV12/I420 planes, and construct the output `VideoFrame(buffer, { format:'I420', colorSpace: source })`.
- The colour ops (`colorspace`/`tonemap`) legitimately need linear RGB and keep the current path.

This removes both errors at once (no range expansion, no transfer swap) and should return geometric transcodes to the plain-path ≈ 0.99 SSIM. It is a real WebGPU renderer rewrite and must be validated frame-exact against `ffmpeg` on the rotated corpus before landing.

## Note on the oracle

Local `ffmpeg` SSIM compares **raw YUV without range/transfer normalisation**, so it reads this defect as ~0.90 — harsher than the fair harness (which reported 0.946/0.950 and likely decodes both sides through a common browser path that cancels part of the transfer error). The true post-fix number must be read from a fresh harness run, not the ffmpeg proxy.
