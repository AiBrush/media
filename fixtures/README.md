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

The seed corpus is drawn from [web-platform-tests](https://github.com/web-platform-tests/wpt) (the
W3C 3-Clause BSD test suite license), pinned by `sha256`. It spans containers **MP4 / WebM / MP3 / Ogg
/ WAV** and codecs **H.264 / AAC / VP8 / Vorbis / MP3 / PCM**, with tiny (2×2) dimensions, audio-only
and video-only tracks, and a deterministic 440 Hz tone for audio oracles.

**The corpus only grows.** New codecs/containers/traits (FLAC, AV1, HEVC, MOV, MKV, MPEG-TS, ADTS,
HDR, alpha, rotation, fragmented/CMAF, CENC/HLS-encrypted samples) are added — with their source URL,
license, and `sha256` — **before** the feature that needs them is considered done. When a bug is found,
the real file that exposed it is added too.

Only download openly-licensed / public-domain / standards-body test media. Record every file's source,
license, and `sha256` in `manifest.json`.
