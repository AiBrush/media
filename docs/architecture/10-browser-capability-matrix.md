# 10 — Browser Capability Matrix & Fallback Plan

> What the browser provides vs what we must ship, where the gaps are, and how the router fills them. **This table is a planning guide, not gospel** — codec support varies by browser, OS, GPU, and version, so **`isConfigSupported` at runtime is the authoritative source of truth** (ADR-003/004). The router never assumes; it probes (ADR / [`04`](04-capability-router-and-ladder.md)).

## 1. Two different "support" questions

- **Containers** (MP4/MOV/WebM/MKV/Ogg/WAV/AIFF/CAF/ADTS/AAC/MP3/FLAC/AVI/TS/M2TS/MTS/HLS) are **ours** — hand-written TS, so support is uniform across browsers, not browser-dependent. `aac` is the ADTS alias; MPEG-TS accepts 188-, 192-, and 204-byte packet framing and the `m2ts`/`mts`/`mpegts` target aliases (ADR-232).
- **Codecs** (decode/encode) depend on **WebCodecs** in the host browser; gaps are filled only by registered,
  license-compatible **WASM** drivers whose exact envelope is validated. This matrix is about codecs.

## 2. Codec support — expected tier (verify at runtime)

Legend: **HW/SW** = WebCodecs (hardware/software) usually available · **wasm** = no reliable WebCodecs path, ship a WASM driver · **—** = out of scope / rare.

| Codec | Decode (Chromium) | Decode (Safari) | Decode (Firefox) | Encode (Chromium) | Our fallback |
|---|---|---|---|---|---|
| H.264 (avc1) | HW/SW | HW | SW/HW | HW/SW | no bundled software fallback; exact host miss is typed |
| HEVC (hev1/hvc1) | HW (OS-dependent) | HW | varies | limited | WebCodecs Main/Main10 by exact config (`hev1.2.4.L120.B0` for explicit 10-bit); no bundled software HEVC fallback, so a rejected exact config remains a typed miss |
| VP8 | SW | varies | SW | SW | vendored WASM decode-only; encode is typed miss |
| VP9 (vp09) | HW/SW | HW (newer) | SW | SW | vendored WASM decode-only; encode is typed miss |
| AV1 (av01) | SW/HW | HW (newer) | SW | limited | vendored dav1d decode-only; encode is typed miss |
| AAC | HW/SW | yes | varies | yes | vendored AAC-LC mono/stereo decode-only; unsupported profiles/encode are typed misses |
| Opus | SW | yes | SW | SW | wasm (libopus) |
| MP3 | SW | varies | SW | — (decode only in WC) | decode-only tail ships; **encode is honest-NA by default** unless a future isolated LGPL LAME tail is explicitly approved |
| **FLAC** | **none (Chrome 149)** [data] | varies | varies | — | **pure-TS FLAC decode (ADR-024) + pure-TS FLAC encode/author (LPC/Rice, ADR-086) — both shipped, no wasm** |
| Vorbis | none | none | none | — | wasm decode (Symphonia) + wasm encode (libvorbisenc/libogg, ADR-108) |
| PCM (s16/s24/f32) | n/a (trivial) | n/a | n/a | n/a | **TS** (no codec needed) |

> The exact cells move with browser releases. This table describes the shipped public envelope, not an
> aspirational codec roadmap: optional software encode tails require a separate license/provenance ADR before
> they become public support. Let `isConfigSupported` and the registered driver envelope decide per call.

## 3. Historical no-winner features (current status)

| Feature | Gap | Plan |
|---|---|---|
| `flac → opus/webm` | Chrome 149 WebCodecs has no FLAC decoder | **Closed:** pure-TS FLAC decode plus native/WebCodecs-or-vendored-libopus encode; the latest completed Chromium export passes. |
| `h264-8bit → hevc-10bit` | Main10 availability varies by browser/OS | **Implemented, focused proof recorded:** explicit ten-bit output authors `hev1.2.4.L120.B0`, widens representable 8-bit samples at the encoder without a pixel copy, and trusts exact `isConfigSupported`; this Chromium host returned typed `NA_BROWSER`, and the external harness declaration remains pending. |
| `h264 → vp8/webm` | Historical output failed `<video>` playback | **Closed in the latest completed Chromium export:** the strict playback-smoke row passes; keep the oracle mandatory. |

## 4. Filters & GPU

- **WebGPU** is the preferred filter substrate; where absent, **Canvas2D** (geometry + display-space colour), then the **pure-TS CPU filter** (`cpu-video-filter`, ADR-038 — the universal floor), then **WASM libavfilter** (ADR-002/027). The **WebGL rung is omitted** (ADR-027): Canvas2D `drawImage` is itself GPU-accelerated and pixel-exact for the geometric ops. Substrate availability is probed once per session (`navigator.gpu` + `OffscreenCanvas` + `VideoFrame`; `OffscreenCanvas` for Canvas2D; `VideoFrame` for the CPU floor).
- The **geometric** pixel filters (resize/crop/pad/rotate/flip) ship now and work everywhere at varying speed — never a hard gap. **Colorspace + tonemap are now implemented** — via WebGPU colorspace, Chromium Canvas2D HDR→SDR display management for opaque HDR frames, and the CPU filter's genuine wide-gamut/HDR→SDR math via readable `VideoFrame.copyTo` frames (ADR-032/038/214/234). So colorspace/tonemap is no longer a hard gap on any WebCodecs-capable browser with one of those honest substrates.

## 5. Crypto, storage, streams

- **WebCrypto** (`crypto.subtle`) is universal → CENC/HLS decrypt works everywhere a key is provided.
- **OPFS**, **Web Streams**, **Workers**, **OffscreenCanvas** are broadly available; absence degrades gracefully (e.g. no OPFS → use Blob/memory; bounded by input size).

## 6. Feature-detection discipline (rules)

1. **Never hardcode** "browser X supports codec Y." Call `isConfigSupported` and cache the verdict per session ([`04`](04-capability-router-and-ladder.md) §5).
2. Probe the **exact config** (codec string incl. profile/level, dims, bitDepth), not just the codec family — e.g. `hev1.2.4.L153.B0`, `av01.0.04M.08`, 10-bit vs 8-bit differ. Bare HEVC demux tokens must first be expanded from `hvcC` `description` bytes to exact `hvc1.*`/`hev1.*` strings.
3. On any miss, fall to the next registered tier; if the shipped chain is exhausted, raise `CapabilityError`
   naming what was tried. Do not name an unshipped future encoder as if it were available (ADR-017/225).
4. Re-probe is unnecessary within a session (capabilities are stable); `preload` warms these.
5. A hidden exact driver pin never changes browser capability truth: it probes only that id within its
   registered kind and raises a typed miss instead of falling through. Threaded WASM is reported only from
   the engine's resolved isolation/SAB profile; an unsafe or cross-origin asset override is rejected before
   probing or fetching (ADR-237).

## 7. Browser floors (planning)

- **Chromium** ≥ 111 (WebCodecs GA; many codecs earlier).
- **Safari** ≥ 16.4/17 (WebCodecs).
- **Firefox** where WebCodecs is shipped; otherwise the engine still does containers/probe/decrypt in TS and falls to WASM for codecs.

The engine **degrades, never breaks** within the shipped ladder: missing WebCodecs → a registered compatible
WASM codec tail where one exists; missing WebGPU → Canvas2D/native CPU filters; missing OPFS → memory/Blob.
When no licensed, validated tail exists, the exact capability is a typed error rather than an aspirational
fallback claim.
