# Test media corpus

Real, internet-sourced media for validation and benchmarking (`BUILD_INSTRUCTIONS.md` §6.1). **No
synthetic/mock subject media, ever.**

## Layout

- **`manifest.json`** — committed. One entry per file: `url`, `sha256`, `bytes`, `license`, `source`,
  `container`/`video`/`audio`, and `traits`. The single source of truth for the corpus.
- **`media/`** — git-ignored. The downloaded files, cached locally and in CI; **never committed** (too
  large) and **never fetched at test run time**.
- **`golden/`** — committed. Small, checksum-pinned reference data baked from the verified corpus
  (`corpus-index.json` now; `golden-metadata`, `golden-packets`, `decoded-frames-bitexact`, decrypt
  cleartext twins as their ops land).

## Workflow

```bash
bun run fetch-fixtures          # download missing files, verify all against pinned sha256
bun run fetch-fixtures --update # re-pin sha256/bytes after adding/replacing an entry
bun run bake-goldens            # re-verify the cache and (re)bake committed goldens
```

Tests read the **verified local cache** — they never touch the network. A missing or mismatched file
fails setup loudly (`fetch-fixtures` exits non-zero), so CI fetches the corpus before running tests.

## Sourcing & licensing

The corpus is drawn from three openly-licensed sources, each entry pinned by `sha256` and recorded with
its `source`, `license`, and `attribution`:

- **[web-platform-tests](https://github.com/web-platform-tests/wpt)** — W3C 3-Clause BSD test suite
  license. Tiny (2×2) MP4/WebM, every PCM wire format (u8/s16/s24/s32/f32), a deterministic 440 Hz tone,
  single-frame AV1/HEVC/H.264, ADTS-AAC, Opus-in-Ogg.
- **[ietf-wg-cellar/flac-test-files](https://github.com/ietf-wg-cellar/flac-test-files)** — CC0-1.0
  (public domain). The FLAC conformance subset: 8/12/16/24-bit, mono/stereo/5.1, 44.1 k–192 kHz, wasted
  bits, escaped Rice partitions, LPC/FIXED/VERBATIM subframes — each carrying a STREAMINFO MD5 oracle.
- **[chromium/chromium `media/test/data`](https://chromium.googlesource.com/chromium/src/+/main/media/test/data)**
  — BSD-3-Clause, © The Chromium Authors. The "bear" clip and its many variants supply the real-world
  traits WPT lacks: 720p/4K, H.264-high + AAC-**stereo**, **rotation**/display-matrix (`qt` brand MOV),
  **HEVC 10-bit HDR10**, **AV1 10-bit**, **VP9 + alpha** (yuv444), **open-GOP** + **fragmented/CMAF**
  MP4, **VFR**/recorder-remux, **multitrack** WebM, real **MPEG-TS**, **non-square-pixel** (`pasp`),
  **VBR MP3** (Xing TOC + ID3v2), Opus-only WebM, FLAC-in-MP4.

Together they span containers **MP4 / MOV / WebM / MKV / MP3 / Ogg / WAV / FLAC / ADTS / MPEG-TS** and
codecs **H.264 / HEVC / VP8 / VP9 / AV1 / AAC / Opus / Vorbis / MP3 / FLAC / PCM** across the §6.1 trait
axes (resolution, fps/VFR, B-frames/open-GOP, bit depth, channel count, rotation, HDR, alpha,
fragmented, tags), so each oracle runs on ≥ 5 diverse real files.

**The corpus only grows.** New codecs/containers/traits are added — with their source URL, license, and
`sha256` — **before** the feature that needs them is considered done. When a bug is found, the real file
that exposed it is added too.

Only download openly-licensed / public-domain / standards-body test media. Record every file's source,
license, attribution, and `sha256` in `manifest.json`.
