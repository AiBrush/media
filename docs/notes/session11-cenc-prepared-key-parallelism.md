# Session 11: prepared-key CENC decryption

## Goal

Reduce the fixed per-sample cost of the standards-general MP4 `cenc`/`cens`/`cbcs` decrypt path while
preserving byte-exact sample order, protection validation, typed failures, and size-preserving container
neutralization. The target is the fresh fair-harness CENC tail (171.5 ms versus 30.3 ms for decrypt and
83.9 ms versus 26.8 ms for the clear-equivalence property), across every rotated encrypted file rather
than a fixture-specific shortcut.

## Evidence and approach

One independently baked five-second CENC MP4 contains 150 H.264 and 236 AAC access units. A direct
instrumented run made 387 `SubtleCrypto.importKey` calls and 387 AES-CTR calls; the equivalent CBCS file
made 300 imports for 150 samples (one CBC decrypt key plus one synthetic-pad encrypt key per sample), 150
encrypts, and 150 decrypts. Median Bun wall time was 23.20 ms for CENC and 5.90 ms for CBCS before this
change. The chosen design imports one non-extractable `CryptoKey` per KID and operation, reuses it for all
samples, schedules independent non-overlapping sample ranges through a small bounded worker window, and
passes already-owned buffers directly to WebCrypto instead of copying each payload again. Output writes
remain address-based into the single cloned MP4 buffer, so completion order cannot alter file order.

The rejected alternative is a global raw-key or `CryptoKey` cache. It would retain caller key material
across operations and realms for a small extra setup saving, complicate key lifetime, and make WebCrypto
capability changes observable. A single-operation cache captures the dominant repeated-import cost with
clear lifetime and no persistent secret retention. Combining access units into one CTR invocation is also
invalid because ISO/IEC 23001-7 resets or changes the counter at sample/subsample boundaries.

## Edge cases and failure modes

- B-frame/VFR decode order is irrelevant: encryption metadata and writes stay indexed by the container's
  sample order and absolute byte ranges.
- Multiple KIDs and `seig` key rotation import once per distinct KID; concurrent requests share the same
  in-flight import promise.
- CENC subsample counters, CENS crypt/skip patterns, CBCS constant/per-sample IVs, and CBC chaining reset
  rules are unchanged.
- Clear sample descriptions and clear `seig` groups remain untouched; malformed IVs, ranges, `senc`,
  erased ciphertext, missing keys, and contradictory schemes still reject with their existing typed
  `MediaError`/`CapabilityError`.
- The bounded window prevents hundreds of queued native crypto jobs and their payload copies from becoming
  a transient-memory spike. On any failure the operation-owned output is discarded; no partial file is
  emitted. Public cancellation remains governed by the existing cancellable operation handle.

## Test and benchmark plan

A fail-first instrumented test uses the independently ffmpeg-encrypted real MP4 twin to prove one key
import, more than one but no more than the declared bound of simultaneous transforms, and byte-exact
ordered recovery of every clear sample. Existing NIST AES vectors, OpenSSL/ffmpeg twins, multi-KID
rotation, malformed/truncated protection, wrong-key, and public cancellation tests remain mandatory. A
fresh warmup-plus-nine-sample benchmark covers the real five-second CENC/CBCS files and reports wall time,
throughput, peak in-flight crypto calls, import count, and a checksum; the lead then validates all rotated
files through the black-box browser harness.

## Result

The fail-first run observed 232 imports on the committed ffmpeg twin and 216 on the real-media CBCS case.
After the change both use exactly one non-extractable key for their one KID and reach a measured peak of
16 native transforms; the two-KID `seig` rotation imports exactly twice. A malformed sample at index zero
admits bounded sibling work, waits until every admitted native promise settles, and rejects with a typed
`MediaError` without returning output. Sparse and empty batch regressions are pinned separately.

The focused CENC/CENS/CBCS, AES, independent decrypt-twin/diversity, anti-cheat, mutation, cancellation,
and rotated-real-corpus matrix passes 175/175; production typecheck passes. On the two 2.1 MiB fair-corpus
files, warmup-three/median-nine Bun wall changed from 23.202 to 15.640 ms for CENC and from 5.903 to
3.336 ms for CBCS. The new six-case real-corpus benchmark (warmup three, median nine) reports 0.36–1.77 ms
per file on the local run, one import per case, peak 16 whenever samples contain cipher blocks, and a
checksum over every output. RSS deltas are reported but intentionally not treated as stable on the shared
development process. Fresh rotated Chromium measurement remains the acceptance result.
