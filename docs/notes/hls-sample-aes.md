# Design note - HLS TS SAMPLE-AES decrypt

> Session 8 R5 slice. This note covers key-provided MPEG-TS `SAMPLE-AES` for H.264/AAC segments. It does
> not claim live EME/license acquisition, fMP4 SAMPLE-AES, or SAMPLE-AES-CTR.

## Goal

Add real HLS TS SAMPLE-AES decrypt to both supported entry points:

- `resolveHlsSource()` accepts `#EXT-X-KEY:METHOD=SAMPLE-AES` when the key format is identity, fetches the
  playlist key, derives the IV, decrypts each TS segment, and returns the clear stitched source.
- `media.decrypt(fromBytes(ts), { scheme: 'hls-sample-aes', keys: { key, iv } })` decrypts one key-provided
  MPEG-TS segment through the MPEG-TS container driver.
- The oracle is a cleartext-twin check on real corpus bytes: encrypted segment bytes must differ from the
  clear segment, and decrypt must recover the original bytes exactly.

## Design

SAMPLE-AES is sample-payload encryption, not full-segment HLS `AES-128`. The TS packet stream, PAT/PMT,
PES headers, timestamps, continuity counters, and packet boundaries stay in place. Only codec sample blocks
are transformed.

The shared decryptor in `src/crypto/hls-aes.ts` detects 188/192/204-byte TS framing, parses PAT and PMT to
find H.264 (`0x1b`) and ADTS AAC (`0x0f`) PIDs, reassembles each PID's PES payload across TS packet
boundaries, decrypts protected blocks in a same-length buffer, then writes the recovered PES bytes back
into the original packet payload slices.

For H.264, Annex-B slice NAL units (`nal_unit_type` 1 and 5) keep the first 32 NAL bytes clear. After that
lead, one 16-byte AES-CBC block is decrypted, up to 144 bytes are skipped, and the cycle repeats while a
full encrypted block remains. The CBC IV is reset per NAL unit. The NAL scanner accepts only plausible
H.264 NAL headers so accidental `00 00 01` byte patterns inside encrypted ciphertext blocks cannot create
false NAL boundaries during decrypt. For ADTS AAC, each frame keeps the first 16 bytes clear, then all
remaining full 16-byte blocks are AES-CBC-decrypted with the IV reset per frame.

The MPEG-TS driver lazy-loads the decryptor only inside its `decrypt()` branch so ordinary probe/demux/mux
paths do not pay for the SAMPLE-AES code in the static driver closure.

## Edge Cases

- Empty input or non-TS input raises `InputError`.
- Transport-level MPEG-TS scrambling is not SAMPLE-AES and raises `InputError`.
- TS with no supported H.264/AAC stream raises `MediaError`.
- TS with supported streams but no decryptable protected block raises `MediaError`; this prevents a
  passthrough from counting as a decrypt pass.
- Encrypted H.264 payload blocks may contain accidental Annex-B start-code bytes; these are ignored unless
  the following byte is a plausible H.264 NAL header.
- Non-identity `KEYFORMAT`, missing key URIs, malformed hex keys, and wrong key/IV lengths reject with
  typed errors.
- fMP4 SAMPLE-AES/CENC-in-HLS, SAMPLE-AES-CTR, and live EME license acquisition are non-goals until real
  vectors and a separate strict oracle exist.

## Validation

Strict checks for this slice:

- Real-media test subjects: all five clear VOD TS corpus segments, `hls_vod_000.ts` through
  `hls_vod_004.ts`.
- Test-only independent encryptor: Node `crypto.createCipheriv('aes-128-cbc')` applies the same TS/PES
  SAMPLE-AES block model to each clear segment.
- HLS path: a synthetic playlist points at the encrypted real segment and an identity key; `resolveHlsSource`
  decrypts it and the resulting source bytes equal the original segment.
- Public API path: `media.decrypt(..., { scheme: 'hls-sample-aes', keys:{key,iv} })` over the encrypted TS
  sources returns the original bytes exactly across all five VOD segments.
- Anti-cheat: the test asserts ciphertext differs from cleartext, and the decryptor raises when no
  encrypted sample blocks are found.
- Benchmark: `scripts/bench-containers.ts` measures `decrypt (hls-sample-aes)` across the same five real TS
  segments and asserts one byte-exact recovery per segment before timing.

## Non-goal

This does not implement live key acquisition, CDM/EME, ClearKey license exchange, fMP4 SAMPLE-AES, or
SAMPLE-AES-CTR. Those remain signed-off capability misses rather than weak claims.
