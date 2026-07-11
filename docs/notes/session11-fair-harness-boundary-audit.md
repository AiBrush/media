# Session 11 fair-harness boundary audit

Session 11 treats the browser harness as a black box. Every classification below comes only from exported
status/reason/selection data, public product calls, scenario-local media bytes, and independent
FFmpeg/ffprobe/MediaInfo/OpenSSL truth. No scenario, oracle, tolerance, runner, selection, output-parser, or
adapter implementation was opened.

## Product regression repaired

The strict MP4 container-integrity pass exposed a real Source-wrapper bug: an initially unknown URL learned
its size on the underlying range response, but a probe-cache wrapper created with object spread could not
see that late fact. Probe→decode could also consume a cached prefix through a fresh URL Source without any
new request. Live `size`/effective-URL accessors plus a learned-size prefix handoff fix the cause without
weakening validation. The focused no-reuse Chromium result
`chromium-2026-07-10T23-22-34-796Z.json` passes all 14 previously affected cells.

## Objective corpus and golden defects

- `demux/graceful_mp4_header_destroyed` and `demux/graceful_webm_header_destroyed`: the base assets are
  genuinely destroyed, but rotated `01`/`02`/`03` files retain valid container headers. ffprobe recognizes
  them and FFmpeg decodes them. A conforming demuxer must not reject a valid rotation merely because the
  scenario name says it is corrupt. Each distinct rotation must receive the intended destructive header
  mutation and independently fail real parsers before rebaking.
- `transcode/h264_crop_center`: the exported crop is `1440×810` at `(240,135)`. Rotations are 1280×720,
  960×540, and 1080×1920, so the requested rectangle is outside every rotated source. Clamping changes
  the requested operation. Rotated sources must satisfy the rectangle, or the operation must derive the
  same relative centered crop from each selected geometry before reference rebaking.
- `trim/vp9_noop_full_range_idempotent`: the exported result simultaneously says the requested duration is
  10 seconds (which product emits and the trim-boundary check accepts) and requires equality with the
  selected input duration. Rotations are 26.019, 46.548, and 224.107 seconds. `{start:0,end:10}` is a prefix,
  not a full-range no-op. Use duration-equivalent rotations or derive `end` from the selected input.
- ADTS rotation `02.aac`: the exact duration is `861 × 1024 / 44100 = 19.992381` seconds. FFmpeg stream-copy
  emits 861 MP4 packets and the same duration. The 17.135660-second value is ffprobe's explicitly warned
  bitrate estimate for raw VBR ADTS. Bake duration from access-unit/sample truth.
- Massive H.264 packet truth: scenario-local and root files share a basename but not bytes. The global
  packet golden matches the root file while the selected scenario file has different sizes for all 214,646
  video packets. Scenario-local bytes require scenario-local packet truth.
- Frame-digest rows for rotation, B-frames, and VP9 contain retained stale/partial goldens. In live Chromium,
  source and current remux output have exact packet/YUV manifests and 12/12 identical canvas hashes on the
  selected real files. Re-bake source truth on the active platform; do not alter valid output pixels to
  chase hashes that no longer describe the selected source decode.
- `transcode/vp8_to_vp9_webm` exposed the same issue after the recorder fixture was corrected. The current
  fixture SHA has 180 VP8 frames at about 60 fps with PTS beginning `0,13,31,47,61…` ms. Its retained
  frame/SSIM golden described the old 93-frame/30-fps SHA, including old PTS `0,57,85,118,151…` ms and old
  frame-zero luma statistics. Deleting that stale placeholder, recreating it from the current fixture, and
  running the headed frame bake produced a fresh 12/12 frame/SSIM golden; the transcode row then passed.

## Invocation and capability boundaries

- `probe/hls_aes128`: the full RFC 8216 manifest URL/bytes plus relative-resource context probes as a
  10.0267-second HLS program and decrypts to valid H.264 1280×720 + AAC 48 kHz stereo TS. The failing
  invocation supplies only the 920,272-byte first-segment AES ciphertext (SHA-256 `4417b34d…`, head
  `e67b35246777a06465c23850f1227f96`) without playlist URI, five-segment timeline, key URI/key bytes, or
  IV. The separate scenario playlist carries key `366a6383…` and explicit IV `953e5e23…`; OpenSSL recovers
  all five clear segments byte-for-byte. The root fixture deliberately uses another valid key/IV tuple,
  which fails on the selected ciphertext with `bad decrypt`, so basename/directory key search is not a
  fallback. [RFC 8216](https://www.rfc-editor.org/rfc/rfc8216.html) derives segment keys, IVs, and relative
  resource resolution from the playlist. Ciphertext alone is information-theoretically insufficient;
  probe must receive the manifest and resolver context.
- `robustness/edge_open_gop_bframes_decode`: the failing result contains no frames, seek frame, or output
  bytes and returns in roughly 0.1 seconds. The same current product and exact baked H.264 file pass seek,
  while the separate current open-GOP decode is 12/12 digest-identical. This is invocation/result capture,
  not a codec artifact that product bytes can repair.
- `mux/edge_hevc_decode_mux_mkv`: product output and an independent FFmpeg HEVC Matroska reference preserve
  packets, decoded frames, colour, and HDR metadata, but the browser `<video>` path rejects both valid MKVs.
  A platform playback limitation cannot be repaired by emitting a different container under an MKV request.
- `metadata/write_mkv_tags` rotation `03.mkv`: the exact 924,924-byte source declares H.264, AAC, one JSON
  attachment, and one attached JPEG/MJPEG stream. Current built product preserves both opaque
  `AttachedFile` payloads (SHA-256 `94809623…` and `831953157…`) through every public browser route tested:
  same-container tag rewrite, same-container remux, full demux-to-mux, H.264+AAC-only selection, prepared
  packet arrays, fragmented output, and streaming output. Independent ffprobe sees all four declared
  streams and the exact attachment hashes. A clean-profile black-box invocation still reports two media
  tracks versus the three-track golden while its 12/12 decoded-frame invariant passes
  (`chromium-2026-07-11T05-31-35-994Z.json`). A second generic experiment redundantly carried the exact
  bundle on forwarded packets as well as TrackInfo; the same invocation still dropped it, so that extra
  surface was reverted. The invocation must preserve the product's container side-data contract or call
  the native `remux(..., {tags})` path; authoring JPEG bytes as timed Blocks or guessing stripped metadata
  would corrupt Matroska semantics.
- Rotated gapless AAC: the selected HE-AAC file is 44.1 kHz with 2,652,160 coded samples; the retained
  expectation is 48 kHz/2,886,720 samples from a different asset. Direct public product decode drains the
  complete selected file. Per-rotation sample-rate/sample-count truth must be baked from the selected bytes.

These findings do not justify a fixture hash branch, silent crop clamp, duration lie, key search, alternate
container, input passthrough, or looser oracle. They identify the exact boundary that must be corrected so
the fair harness measures real media behavior.

## Fresh-run outcome

The sealed no-reuse Chromium rotation `chromium-2026-07-10T23-25-04-841Z.json` completed all 563 cells with
no timeout or OOM: 482 PASS, 59 N/A, 20 FAIL, and 2 ERROR. After the source-truth repairs and a full headed
frame bake (543 filled, 54 honest partial, 15 honest failures), a no-reuse rerun of all 22 reds plus both
header-destroyed rows returned 19 PASS, 3 FAIL, and 2 ERROR. A clean-cache crop rerun passed, and a
scenario-local massive packet manifest generated by a transformation proven byte-for-byte identical to the
public baker cleared the same-basename collision. Every stale frame/SSIM row, ADTS duration, no-op trim,
crop, massive packet, and malformed-header row therefore cleared without a product-byte workaround.

The raw-ciphertext HLS probe, browser playback of valid HEVC MKV, and black-box stripping of exact Matroska
container side data remain proven non-product boundaries. The gapless rotations are undergoing an exact
licensed corpus repair. None of these findings is allowed to hide a product or corpus defect, and none
authorizes a fabricated product fallback.
