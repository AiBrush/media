# Session 13 — declared WebM alpha proof

## Goal

Project Matroska `Video/AlphaMode` into `TrackInfo.alpha` during bounded `WebmDriver.probe()` so an
otherwise exact VP8/VP9 `{ alpha: 'keep' }` request can use ADR-263's lossless semantic rewrite. The
resulting WebM writer must declare the same fact and preserve every color and alpha access unit, key flag,
PTS, duration, and ordering fact.

## Design

Parse the standards-defined `AlphaMode` element (`0x53C0`) only inside a complete `Video` master. A
single complete unsigned value of `1` is positive proof; omission, the default/explicit value `0`, unknown
values, empty/oversized/truncated integers, conflicting duplicates, and non-video placement are not proof.
Keep the existing full-demux observation fallback so malformed legacy files with real `BlockAdditional`
payloads remain decodable, but metadata-only semantic routing never infers alpha from a filename, codec,
packet scan, or asset shape. Project the declaration through `WebmTrack` and `TrackInfo`, and have every
WebM writer emit `AlphaMode=1` when its input track declares alpha (or, for buffered output, when already
buffered packets prove it). The rejected alternative is probing BlockAdditions during metadata routing:
that would require a full packet scan, weaken bounded probe behavior, and still turn a stream fact into an
inference instead of honoring the normative declaration.

## Edge cases and ownership

- B-frames and VFR retain original Block order, PTS, durations, and key flags; no timestamps are derived
  from `AlphaMode`.
- A semantic rewrite preserves color and alpha packets byte-for-byte. It performs no decode, filter, or
  encode, so it creates no `VideoFrame`/`AudioData` and changes no close ownership.
- One-shot streams remain ineligible for semantic pre-probe, preserving the existing single-consumption
  rule. Seekable sources remain replayable; probe and stream-copy read independent exact source snapshots.
- Abort remains checked before/after metadata reads and throughout the native stream-copy packet loop.
  Alpha parsing allocates no payload copy and introduces no backpressure change.
- Malformed, duplicate, unknown, absent, or zero declarations never prove `alpha:'keep'`; the codec path
  remains the safe fallback.

## Validation and benchmark

Fail-first validation covers the real pinned `bear-vp9-alpha.webm` corpus file and the public VP9-alpha
acceptance asset, plus synthetic absent, zero, unknown, empty, oversized, truncated, duplicate, and
non-video declarations. A public-convert oracle compares the rewritten track projection and SHA-256 of
every color/alpha access unit together with PTS, duration, type, and DTS. Cancellation and one-shot replay
guards stay explicit. `bench-session13-semantic-vp9-alpha` runs warmup three and 21 measured conversions on
the real acceptance asset, rejecting any track/packet/color/alpha difference.
