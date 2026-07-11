# Session 12 design note — container aliases, transport framing, and direct HLS AES-128

## Goal

Make every container token already promised by the public `Container` type operational at the container
seam: `m2ts`, `mts`, and `mpegts` route to the MPEG-TS driver, while `aac` is the documented alias of the
ADTS elementary-stream driver. Keep `ts` and `adts` as the canonical probe results. Extend the cheap raw
MPEG-TS magic predicate from 188-byte packets to the parser's complete 188/192/204-byte framing set. Finally,
make direct `decrypt(input, { scheme:'hls-aes128', keys:{key,iv} })` work for caller-hinted MPEG-TS and
packed-audio ADTS segments, while leaving the existing TS `hls-sample-aes` algorithm and rejection rules
strictly disjoint.

## Approach

Declare aliases in each driver's `formats` list and in the eager chunk-mux truth table, but retain the first
format as the canonical reported container. Extract the parser's bounded sync-column detector into a tiny
shared MPEG-TS framing module so both lazy routing and the full parser use the same 188/192/204 truth without
pulling PSI/PES parsing into the default-driver chunk. Full-segment AES-128 is necessarily a bounded whole-
segment operation because WebCrypto exposes no streaming AES-CBC interface: drain with abort-aware reader
cancellation, validate the caller's hex key and IV, decrypt via the existing real WebCrypto primitive, then
structurally validate the recovered bytes before exposing a demand-driven one-chunk stream. MPEG-TS must
start on a complete packet grid and parse to real PAT/PMT/PES tracks; ADTS must complete a real frame walk.
The TS decrypt dispatcher retains a separate `hls-sample-aes` branch that calls only the existing sample
payload decryptor. Rejected alternatives: duplicate three ad-hoc sync predicates; accept aliases only as
input extensions but not output targets; emit padding-valid cleartext without a container oracle; infer a
missing key/IV; or route `AES-128` through SAMPLE-AES based on byte shape.

## Edge cases and lifecycle

- 188-byte TS, 192-byte M2TS/MTS with a four-byte timestamp prefix, and 204-byte TS with a 16-byte parity
  suffix; shifted/truncated/random heads; two packets are the minimum cheap lock and the full parser remains
  authoritative.
- H.264 B-frames, VFR, DTS/PTS reordering, PCR, discontinuities, and multiple tracks are not rewritten by
  routing or decrypt. Structural validation parses their existing timing but returns the exact decrypted
  bytes.
- Empty/non-block-aligned ciphertext, malformed hex, short/absent keys, wrong keys, wrong IVs, padding-valid
  but structurally invalid plaintext, and cross-scheme inputs all fail with typed errors and emit no bytes.
- A pre-aborted operation reads nothing. Abort while draining cancels and releases the source reader; abort
  after the non-cancellable WebCrypto promise is observed before output becomes readable. The returned
  stream enqueues only from `pull`, so downstream demand controls the sole cleartext chunk. No
  `VideoFrame`, `AudioData`, or encoded-chunk ownership crosses this byte-only path.
- Full-segment AES-CBC inherently retains ciphertext plus cleartext for one finite HLS segment. It never
  buffers a playlist or unbounded live stream, and SAMPLE-AES keeps its existing bounded TS/PES behavior.

## Failure modes

Missing `key`/`iv` is a `CapabilityError('capability-miss')`; malformed lengths/hex or non-CBC ciphertext is
an `InputError('unsupported-input')`; a WebCrypto/padding failure or plaintext that is not the promised
container becomes `MediaError('demux-error')`; cancellation is `MediaError('aborted')`. An unsupported
scheme remains a typed capability miss naming the selected driver. No branch falls back from SAMPLE-AES to
AES-128 or vice versa.

## Validation and benchmark plan

Fail-first public/driver tests use the committed real-media-derived corpus: six independently encrypted
ffmpeg MPEG-TS segments and their clear twins; six independently encrypted packed-ADTS segments and clear
twins; three real TS programs for alias remux/routing; and real TS packet bytes wrapped into 192- and
204-byte transport framing without altering their 188-byte payloads. The oracle is byte-exact recovery plus
`parseTs`/complete ADTS frame structure, with mutations for a wrong IV, swapped scheme, and random/truncated
framing. Cancellation must prove source cancellation. A fresh benchmark performs warmups and at least five
samples over all twelve AES segments, plus the three framing predicates, reporting median wall time,
throughput, and a content checksum so work cannot be elided.

## Recorded result

The fail-first run produced 21 failures at the alias tables, 192/204-byte router magic, TS AES dispatcher,
and absent ADTS decrypt seam while the existing SAMPLE-AES positive remained green. After implementation
and the final plaintext-zeroization review, the focused alias/AES/existing-container matrix passed **120/120**,
including ordinary ADTS junk/tag resilience, wrong-key rejection, leading-structure wrong-IV rejection,
source cancellation, recovered-cleartext wiping, and parsed-key wiping when malformed IV parsing fails.
Central review then passed a broader **337/337** matrix and added case-insensitive parameterized MIME plus
alias Blob-MIME checks. The wrong-IV mutation
specifically corrupts the leading container sync/header; unauthenticated AES-CBC cannot prove an IV
mutation that leaves structure valid.

Fresh benchmark (`bun run bench-session12-container-routing-aes`, 2 warmups + 7 recorded samples):

- Direct AES-128 over all 12 real TS/ADTS segments (50,944 encrypted bytes per batch): median **1.086 ms**,
  **46.90 MB/s**, deterministic SHA-256
  `04f543838a822be352846c6267ed8f6197db89c4b7d2a33c2f04f693a09648c9`.
- Public native remux through `m2ts`/`mts`/`mpegts`/`aac` aliases (429,864 input bytes per batch): median
  **2.197 ms**, **195.66 MB/s**, deterministic SHA-256
  `4c8dc0de7a2a6b4870bef649ded99dcbfb1487622db42699a629e8c87733f6cf`.
- Cheap raw 188/192/204-byte sniff: median **3.438 ms per 6,000 predicates** (all 42,000/42,000
  predicates matched over the seven recorded samples).
