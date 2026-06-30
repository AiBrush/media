# Design note - CENC cens patterned CTR decrypt

> Session 8 R5 slice. This note covers only CENC `cens` with caller-provided keys. HLS SAMPLE-AES is a
> separate decrypt format and is not claimed here.

## Goal

Add real MP4 CENC `cens` decrypt to the existing driver-native decrypt path:

- Public API accepts `scheme: 'cens'` beside `cenc`, `cbcs`, `hls-aes128`, and `hls-sample-aes`.
- The MP4 driver honors the container's `schm` scheme, so a caller asking for `cenc` on a `cens` file gets
  a typed mismatch rather than corrupted output.
- `cens` samples are decrypted with WebCrypto AES-CTR, using the `tenc` crypt:skip pattern to decide which
  full 16-byte blocks are transformed.
- Output samples are reserialized through the normal MP4 writer so the result is clear media, not a
  passthrough blob with labels changed.

## Design

`cens` is the CTR-pattern sibling of `cbcs`. The MP4 protection metadata is the same family of boxes:
`enca`/`encv` sample entries carry `sinf`, `schm` names the scheme, `tenc` carries the default KID,
per-sample IV size, and crypt:skip pattern, and `senc` carries per-sample IVs plus optional subsample
clear/protected ranges.

The decrypt path is deliberately container-owned:

1. Parse `schm` and require it to be one of `cenc`, `cens`, or `cbcs`.
2. Parse `tenc` with scheme-aware IV and pattern rules.
3. Parse `senc` with the CTR IV-size rules for `cenc`/`cens`.
4. For each sample, walk either the declared subsample protected ranges or the whole sample.
5. Within each protected range, compute full-block offsets selected by the repeating
   `cryptByteBlock:skipByteBlock` pattern.
6. Gather selected blocks, AES-CTR decrypt them with the per-sample IV, scatter them back, and leave skipped
   blocks plus trailing partial bytes unchanged.

The counter model is bounded to the encrypted crypt blocks in a sample. Tests use the same gather/scatter
shape in reverse to build a protected MP4 fixture, then prove the public decrypt API recovers the real
fixture's audio samples bit-exact.

## Edge Cases

- Pattern present in `tenc` version 1; version 0 falls back to full CTR (`1:0`) when a legacy file omits a
  pattern.
- All-zero crypt:skip patterns are rejected as malformed protection metadata.
- `cens` does not support `cbcs` constant-IV mode; CTR modes require per-sample IVs of 8 or 16 bytes.
- Subsample maps can leave leading clear bytes untouched before the patterned protected bytes begin.
- Caller/container scheme mismatches are `MediaError`s, not `CapabilityError`s, because the file is
  protected but contradictory for the requested operation.
- Unknown CENC `schm` values remain typed capability misses.

## Validation

Strict checks for this slice:

- Pure block-pattern test: selected crypt blocks decrypt, skipped full blocks and trailing partial bytes
  stay clear.
- `parseTenc()` reads a `cens` crypt:skip pattern.
- End-to-end real-media test: `encryptCens(movie_5.mp4)` produces cipher samples that differ from clear
  samples, and `media.decrypt(..., { scheme: 'cens', keys })` recovers the original audio samples exactly.
- Wrong-key anti-cheat: decrypting with a wrong key must not recover the clear samples.
- Scheme-mismatch anti-cheat: a `cens` file requested as `cenc` rejects with a typed media error.
- Benchmark: `scripts/bench-containers.ts` measures `decrypt (cens)` across the seven-file MP4/MOV corpus
  using freshly encrypted `cens` twins with a `1:9` crypt:skip pattern.

## Non-goal

This note covers only MP4 CENC `cens`. HLS TS SAMPLE-AES is covered by `docs/notes/hls-sample-aes.md`
and ADR-121. fMP4 SAMPLE-AES, SAMPLE-AES-CTR, and live EME/license acquisition remain out of scope.
