# Session 11 lazy audio-container defaults

## Goal

Return the default-driver first-operation JavaScript closure from 306.25 KiB to the Session 11 target of
at most 245 KiB, without raising the 256 KiB hard budget, moving the hot MP4/WebM path, changing container
selection, or deferring errors that the public mux contract raises synchronously.

## Design

Keep MP4 and WebM statically registered in the default driver bundle. Register WAV, MP3, Ogg, ADTS, AIFF,
and CAF through small `ContainerDriver` proxies with literal dynamic imports. A proxy memoizes one in-flight
driver promise, retains the real driver's formats and optional methods, and delegates the caller's source,
stage options, stream, abort signal, and output without extra buffering.

The light support predicates live in `audio-container-sniff.ts` and are also used by the real drivers, so
the proxy cannot drift from the implementation it selects. They preserve every existing MIME and extension
alias and the exact container magic checks. MP3 rejects ADTS layer bits; ADTS rejects MP3 layer bits and can
skip fully visible stacked ID3v2 tags, including the optional footer, before checking sync.

Lazy mux construction needs an additional contract guard. Returning a proxy and loading the real muxer only
on its first async write would otherwise postpone invalid `fragmented` options and invalid or duplicate
tracks. `audio-container-mux-validation.ts` therefore holds the exact synchronous rules shared by the proxy
and real WAV/MP3/Ogg/ADTS muxers. AIFF and CAF continue to reject `createMuxer()` immediately because their
raw PCM output is served only through `transformPcm`.

## Invariants and edge cases

- Optional `probe`, `packetInfo`, `streamCopy`, `transformPcm`, `decodePcm`, and `decodePcmAudio` members
  exist only where the real driver provides them.
- `validatesStreamCopyTrim` and `validatesPcmTrim` stay identical to the real drivers.
- MIME, case-normalized extension, short-head, unknown-input, RIFF/WAVE, OggS, FORM/AIFF/AIFC, CAF, MP3,
  raw ADTS, and ID3-prefixed ADTS selection remain exact.
- Fragmented WAV/MP3/Ogg/ADTS creation, unsupported codecs/media types, missing WAV/ADTS metadata, and a
  second audio track fail synchronously with the same typed error and message as the real muxer.
- B-frame/VFR video behavior, seek, cancellation, backpressure, frame lifetime, force-software routing,
  packet bytes, PCM endian conversion, and gapless metadata do not change; the proxy owns none of them.

## Validation and measurement

The focused container matrix exercises exact proxy selection and optional surfaces, loads all six real
implementations against corpus fixtures, and retains the existing real demux, packet, PCM, mux, remux,
decode, abort, and structural oracles: 327 passed, 0 failed. The eager helper split adds 339 passing codec,
trim, metadata, image, and raw-PCM tests. Strict TypeScript and Biome pass.

On a fresh production build, the default-driver static closure is 216.68 KiB: 89.57 KiB below the measured
306.25 KiB baseline, 28.32 KiB below the 245 KiB working target, and 39.32 KiB below the unchanged 256 KiB
hard ceiling. The current settled combined eager closure is 49.68 KiB, down from 51.26 KiB and with 0.32 KiB
margin to its 50 KiB ceiling after ADR-207.
`vendor-wasm` and `check-budgets` pass; the emitted frontier contains six independent audio-driver chunks,
`wav-driver-*`, `mp3-driver-*`, `ogg-driver-*`, `adts-driver-*`, `aiff-driver-*`, and `caf-driver-*`, while
the default/probe closure contains neither heavy lazy helpers nor WASM URL references. These measurements
close the package-budget regression only; browser performance and full-harness acceptance remain separate.

Rejected alternatives were raising the budget, lazifying MP4/WebM first, duplicating support/validation
logic, silently omitting optional driver methods, deferring synchronous mux errors, preloading all six tails,
or selecting code paths by fixture identity.
