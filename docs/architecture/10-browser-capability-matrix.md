# 10 — Browser Capability Matrix & Fallback Plan

> What the browser provides vs what we must ship, where the gaps are, and how the router fills them. **This table is a planning guide, not gospel** — codec support varies by browser, OS, GPU, and version, so **`isConfigSupported` at runtime is the authoritative source of truth** (ADR-003/004). The router never assumes; it probes (ADR / [`04`](04-capability-router-and-ladder.md)).

## 1. Two different "support" questions

- **Containers** (MP4/WebM/Ogg/WAV/ADTS/MP3/FLAC/TS) are **ours** — hand-written TS, so support is uniform across browsers, not browser-dependent.
- **Codecs** (decode/encode) depend on **WebCodecs** in the host browser; gaps are filled by **WASM** drivers. This matrix is about codecs.

## 2. Codec support — expected tier (verify at runtime)

Legend: **HW/SW** = WebCodecs (hardware/software) usually available · **wasm** = no reliable WebCodecs path, ship a WASM driver · **—** = out of scope / rare.

| Codec | Decode (Chromium) | Decode (Safari) | Decode (Firefox) | Encode (Chromium) | Our fallback |
|---|---|---|---|---|---|
| H.264 (avc1) | HW/SW | HW | SW/HW | HW/SW | wasm (openh264/x264) if WC missing |
| HEVC (hev1/hvc1) | HW (OS-dependent) | HW | varies | limited | wasm decode; **10-bit encode out of scope** |
| VP8 | SW | varies | SW | SW | wasm (libvpx) |
| VP9 (vp09) | HW/SW | HW (newer) | SW | SW | wasm (libvpx) |
| AV1 (av01) | SW/HW | HW (newer) | SW | limited | wasm (dav1d decode / SVT-AV1 encode) |
| AAC | HW/SW | yes | varies | yes | wasm fallback |
| Opus | SW | yes | SW | SW | wasm (libopus) |
| MP3 | SW | varies | SW | — (decode only in WC) | wasm libmp3lame for **encode** |
| **FLAC** | **none (Chrome 149)** [data] | varies | varies | — | **pure-TS FLAC decode (shipped, ADR-024)**; wasm encode |
| Vorbis | none | none | none | — | wasm (libvorbis) |
| PCM (s16/s24/f32) | n/a (trivial) | n/a | n/a | n/a | **TS** (no codec needed) |

> The exact cells move with browser releases. Treat this as "where to expect a WASM driver to be needed," and let `isConfigSupported` decide per call.

## 3. Confirmed gaps (the 3 no-winner benchmark features) [data: Finding 8]

| Feature | Gap | Plan |
|---|---|---|
| `flac → opus/webm` | Chrome 149 WebCodecs has **no FLAC `AudioDecoder`** | **FLAC decode now ships in pure TS** (ADR-024, `src/codecs/flac` — the decode side of this gap is closed); the remaining tail is the Opus *encode* (WebCodecs where present, else WASM libopus) |
| `h264-8bit → hevc-10bit` | **no 10-bit HEVC encoder** in-browser | **out of scope** (license/size); `CapabilityError` with a clear message |
| `h264 → vp8/webm` | encode succeeded but output **failed `<video>` playback** | enforce `playback-smoke` in our oracle; prefer VP9/AV1 or fix the VP8 muxing path |

## 4. Filters & GPU

- **WebGPU** is the preferred filter substrate; where absent, **Canvas2D** (geometry + display-space colour), then the **pure-TS CPU filter** (`cpu-video-filter`, ADR-038 — the universal floor), then **WASM libavfilter** (ADR-002/027). The **WebGL rung is omitted** (ADR-027): Canvas2D `drawImage` is itself GPU-accelerated and pixel-exact for the geometric ops. Substrate availability is probed once per session (`navigator.gpu` + `OffscreenCanvas` + `VideoFrame`; `OffscreenCanvas` for Canvas2D; `VideoFrame` for the CPU floor).
- The **geometric** pixel filters (resize/crop/rotate/flip) ship now and work everywhere at varying speed — never a hard gap. **Colorspace + tonemap are now implemented** — on WebGPU for all targets (ADR-032) and, for browsers without WebGPU, on the **CPU filter** which performs genuine wide-gamut colorspace + HDR→SDR tonemap via `VideoFrame.copyTo` (ADR-038); Canvas2D handles only display-space colour. So colorspace/tonemap is no longer a hard gap on any WebCodecs-capable browser.

## 5. Crypto, storage, streams

- **WebCrypto** (`crypto.subtle`) is universal → CENC/HLS decrypt works everywhere a key is provided.
- **OPFS**, **Web Streams**, **Workers**, **OffscreenCanvas** are broadly available; absence degrades gracefully (e.g. no OPFS → use Blob/memory; bounded by input size).

## 6. Feature-detection discipline (rules)

1. **Never hardcode** "browser X supports codec Y." Call `isConfigSupported` and cache the verdict per session ([`04`](04-capability-router-and-ladder.md) §5).
2. Probe the **exact config** (codec string incl. profile/level, dims, bitDepth), not just the codec family — e.g. `hev1.2.4.L153.B0`, `av01.0.04M.08`, 10-bit vs 8-bit differ.
3. On any miss, fall to the next tier; if the tier chain is exhausted, raise `CapabilityError` naming what was tried and which WASM driver would enable it (ADR-017).
4. Re-probe is unnecessary within a session (capabilities are stable); `preload` warms these.

## 7. Browser floors (planning)

- **Chromium** ≥ 111 (WebCodecs GA; many codecs earlier).
- **Safari** ≥ 16.4/17 (WebCodecs).
- **Firefox** where WebCodecs is shipped; otherwise the engine still does containers/probe/decrypt in TS and falls to WASM for codecs.

The engine **degrades, never breaks**: missing WebCodecs → WASM codecs; missing WebGPU → WebGL/Canvas; missing OPFS → memory/Blob. The only true "no" is a capability no engine can provide in that environment, surfaced as a typed error.
