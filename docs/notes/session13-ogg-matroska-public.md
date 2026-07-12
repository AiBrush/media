# Session 13 public Ogg-to-Matroska closure

## Goal and measured seam

Close the contested `remux/opus_ogg_to_mkv` row with product-level evidence, not just the ADR-255 writer
microbenchmark. The measurement covers the complete public `createMedia().remux(input, { to: 'mkv' })`
operation over the verified real Opus and Vorbis Ogg corpus, including lazy-driver routing, complete Ogg page
and lacing validation, Matroska authoring, and the default Blob sink. A separate direct-driver control attributes
the remaining fixed cost without changing the product. The strict oracle compares every coded packet payload,
packet count, codec, codec-private header, PTS/duration, Opus pre-skip/CodecDelay, output DocType, and complete
reparse truth; output must be freshly authored and deterministic. Alternating warm samples avoid order bias,
and memory is measured separately after forced collection so timing samples are not distorted by GC.

## Edge cases, lifecycle, and alternatives

Ogg audio has no B-frame reorder, but Vorbis variable packet duration, negative Opus starting PTS, pre-skip,
terminal gapless padding, packets continued across pages, multi-segment packet spans, malformed/truncated pages,
one-shot streaming, cancellation, backpressure, and caller-owned source lifetime all remain relevant. The public
route must read a one-shot source exactly once, reject abort before source acquisition, propagate cancellation
while output is backpressured, and retain no operation output or source-sized packet copies after completion.
The ADR-255 direct packet projection is preferred over host `EncodedAudioChunk` construction because it keeps
the validated Ogg parser and existing Matroska writer as the sole authorities while removing two payload copies.
A runner-specific fixture shortcut, persistent output cache, per-size threshold, packet-count recognition,
passthrough, weaker re-import oracle, alternate EBML serializer, and wider unbounded buffering are rejected.
If public profiling shows only routing/import/Blob floors after warmup, no speculative product change is justified;
the row remains provisional until same-export browser evidence. If a general redundant read, copy, or promise
boundary remains, it must first receive a failing invariant test, then ADR-275 and fresh multi-input evidence.

## Validation and benchmark plan

The benchmark uses warmup `n=7` and alternating `n=31` samples on every available pinned real Opus/Vorbis Ogg
fixture. It reports public Blob, public stream-sink drain, direct-driver drain, parse/reparse, throughput, robust
median/MAD, packet and byte checksums, and fresh-output SHA-256. Each output is reparsed independently with the
public WebM/Matroska parser and compared packet-by-packet with the independently parsed Ogg source. A separate
memory pass records positive peak RSS/heap/ArrayBuffer growth and retained deltas after `Bun.gc(true)`, with a
bounded retention guard. Existing focused tests remain the cancellation/backpressure oracle, and any production
edit additionally requires the Ogg, remux-runner, default-driver, typecheck, and Biome gates.

## Result

Repeated complete public runs are already below a tenth of a millisecond for the real Opus input and near
one tenth for the larger Vorbis input: public Blob medians are 0.063-0.065 ms and 0.128-0.133 ms, while the
direct-driver controls are 0.035-0.037 ms and 0.098-0.101 ms. Every run preserves deterministic output SHA,
all coded payloads and clock facts, codec-private bytes, and Opus gapless truth. The separate 256-operation
pass observed a positive 6,485,376-byte ArrayBuffer peak and only 0-19,796 bytes retained after forced
collection. No further local speed seam is large enough to justify product complexity; the ledger remains
BEHIND until a current-bundle same-export browser comparison supplies qualified rival wall and memory.

The lifecycle and trim review did expose correctness gaps independent of the fast-path timing, resolved by
ADR-275. A one-shot producer is now cancelled and unlocked at the abort edge instead of delivering another
chunk. Cross-target trim declares the actual kept full-packet extent; a later-starting Opus selection resets
pre-skip in an owned OpusHead while a selection retaining packet zero keeps the original pre-skip. Real
FLAC-derived Ogg writes exact Matroska and declines the illegal WebM target with a typed capability miss.
