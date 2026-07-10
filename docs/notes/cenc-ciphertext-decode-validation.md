# CENC ciphertext corruption — browser decode validation

## Goal

Restore graceful rejection for structurally valid but payload-corrupted `cenc` video without changing the bit-exact AES-CTR decrypt result for valid files. The input seam is a protected MP4 track (`tenc` + `senc` and encrypted sample bytes); the output seam is a clear MP4 byte stream. The operation must reject before emitting output when the recovered AVC stream is not decodable, while preserving typed errors, cancellation, bounded decoder backpressure, and exact frame lifetime.

## Approach

Run the existing MP4 AVC decode verifier over every decrypted video sample before the clear container is serialized when browser WebCodecs is available. The verifier configures `VideoDecoder` from the track's real `avcC`/`VideoDecoderConfig`, feeds samples in decode order with their true PTS/DTS/duration and keyframe flags, caps the queue at the existing high-water mark, closes every produced `VideoFrame` exactly once, honors `AbortSignal`, flushes the decoder, converts decode/flush failure into `MediaError('demux-error')`, and requires a complete flat AVC track to emit exactly one frame per MP4 access-unit sample. That final cardinality check catches standards-compliant decoder concealment that silently drops a damaged unit instead of raising the error callback. Node and browsers without a supported/configurable decoder keep the independent byte-exact cryptographic validation path; they do not claim payload integrity that unauthenticated AES-CTR cannot provide.

The initial diagnosis rejected all IV-progression checks because ISO/IEC 23001-7 permits arbitrary unique
IVs. A direct Bento4 dump of the actual baked mutation corrected that diagnosis: the damaged byte is in a
fragment `senc` IV, not encrypted `mdat`. Its surrounding IVs are `N`, a one-bit-corrupted value, `N+2`;
every other entry is untouched. This admits a narrow, format-agnostic integrity check without imposing a
sequential-IV policy: whenever two IVs two sample positions apart are exactly two apart as unsigned
big-endian counters, the sandwiched IV must be their unique midpoint. Arbitrary/random IV series do not
trigger the premise (chance 2^-64 for an 8-byte IV, 2^-128 for 16-byte), while a bit flip inside an
otherwise consecutive producer run rejects before crypto. Fully random, deliberately non-consecutive, and
ordinary consecutive IV series remain valid.

Ciphertext fingerprints remain rejected: AES-CTR ciphertext is intentionally indistinguishable from random
bytes and would encode corpus knowledge. A MAC cannot be checked because CENC CTR carries none. Browser
decode validation remains defense in depth for payload corruption, but cannot by itself prove integrity
when a hardware decoder conceals damage and still emits the expected frame count.

## Edge cases and failure modes

Valid CENC decrypt remains byte-exact; wrong-key output is not reclassified as a capability miss; unsupported/non-AVC tracks retain their existing pure decrypt behavior; a decoder support probe or configure miss does not invent a failure; decoder errors and output-cardinality loss reject with a typed `MediaError`; B-frames retain decode-order feeding and presentation timestamps; VFR durations remain sample-derived; cancellation closes the decoder and rejects as `aborted`; every output frame is closed in the decoder callback; queue backpressure prevents unbounded in-flight frames. The exact count applies only to a complete flat MP4 track, not a trim dependency window. Fragmented inputs continue through the whole-file CENC engine and are covered separately until their decrypted fragment sample table is exposed to the same verifier.

## Validation and benchmark plan

The Node regression encrypts the real `bear-1280x720.mp4` H.264 fixture, preserves a clear bit-exact twin, flips protected payload bits without changing the MP4/CENC box structure, and installs a strict decoder double that rejects the recovered corrupted access unit. The clean twin must decrypt and validate every sample; the corrupt twin must reject with `MediaError`, never `CapabilityError`. Existing CENC/CENS/CBCS byte-exact suites and the real Chromium encryption family guard the happy paths and the actual browser decoder. The focused benchmark measures valid CENC decrypt with and without browser validation over the rotated real-video corpus; the acceptance requirement is correctness first and no unexplained wall/peak-memory loss after the functional board is zero.
