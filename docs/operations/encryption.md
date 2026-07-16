# Encryption / Decrypt

> Shard S19 — benchmark family: `encryption`. Owned code: `src/crypto/aes.ts`,
> `src/crypto/hls-aes.ts`, `src/drivers/mp4/cenc.ts`, `src/drivers/mpegts/mpegts-decrypt.ts`,
> `src/drivers/hls-full-segment-decrypt.ts`, `src/api/decrypt-runner.ts`.
> This is the **target spec** (best design) plus an honest **delta** vs today's code.

## 1. Purpose & scope

**Concretely:** this family answers one question — *given a protected container and the caller's raw
keys, produce the byte-identical clear container.* It is a pure **byte-in → byte-out transform**
(`media.decrypt(input, { scheme, keys, sink })`), never a live license/DRM exchange. It serves the
`encryption` benchmark family, which today exercises five schemes:

| Scheme | Cipher | Where the crypto lives | Owner file |
|---|---|---|---|
| `cenc` | AES-128-CTR (per-sample IV) | ISO/IEC 23001-7 sample decrypt | `src/drivers/mp4/cenc.ts` |
| `cens` | AES-128-CTR **pattern** | ISO/IEC 23001-7 §9.6 | `src/drivers/mp4/cenc.ts` |
| `cbcs` | AES-128-CBC **pattern** (constant/per-sample IV) | ISO/IEC 23001-7 §10.4 | `src/drivers/mp4/cenc.ts` |
| `hls-aes128` | AES-128-CBC + PKCS#7, whole segment | RFC 8216 §4.3.2.4 | `src/crypto/hls-aes.ts`, `src/drivers/hls-full-segment-decrypt.ts` |
| `hls-sample-aes` | AES-128-CBC, per-NAL/per-frame block runs | Apple SAMPLE-AES | `src/crypto/hls-aes.ts`, `src/drivers/mpegts/mpegts-decrypt.ts` |

The scheme set is the source of truth in three places that must stay in lockstep:
`DecryptParams.scheme` (`src/contracts/driver.ts:405`), `EncryptionScheme`/`KeyMap`
(`src/api/types.ts:210`), and `assertSupportedDecryptScheme` (`src/api/decrypt-runner.ts:74`).

**Explicitly out of scope** (a deliberate scoping decision, not a gap): live EME/CDM license exchange.
An empty `keys` object is rejected up front as "a live EME/license exchange, deliberately outside this
byte-transform API" (`src/api/decrypt-runner.ts:49`). aibrush is a **ClearKey / known-key** engine; it
is not a Widevine/PlayReady/FairPlay client (see §2 shaka-player contrast, and Open Question 2).

## 2. Spec & references

Governing standards (every external reference is linked):

- **ISO/IEC 23001-7 — Common Encryption in ISO-BMFF (CENC).** Defines `cenc`/`cens`/`cbcs`/`cbc1`
  schemes, the `tenc` (default KID, per-sample IV size, crypt:skip pattern, `default_constant_IV`),
  `senc` (per-sample IV + subsample map), `saiz`/`saio` (auxiliary-info sizes/offsets), and
  `sbgp`/`sgpd` `'seig'` sample-group protection overrides.
  <https://www.iso.org/standard/68042.html>
- **ISO/IEC 14496-12 — ISO Base Media File Format.** The box grammar those protection boxes live
  inside (`moov/trak/mdia/minf/stbl`, `moof/traf`, `tfhd`/`trun` §8.8.7–8.8.8, `saiz`/`saio`
  §8.7.8–8.7.9). <https://www.iso.org/standard/83102.html>
- **RFC 8216 — HTTP Live Streaming.** `EXT-X-KEY` `METHOD=AES-128` (full-segment AES-128-CBC + PKCS#7),
  `METHOD=SAMPLE-AES`, and the implicit IV = media-sequence-number rule (§4.3.2.4).
  <https://www.rfc-editor.org/rfc/rfc8216>
- **Apple — MPEG-2 Stream Encryption Format for HTTP Live Streaming (SAMPLE-AES).** The per-NAL /
  per-ADTS-frame block-run model (H.264: 32-byte clear leader, one 16-byte encrypted block then up to
  144 clear, IV reset per NAL; AAC: 16-byte clear leader, all remaining full blocks, IV reset per
  frame). <https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/HLS_Sample_Encryption/Intro/Intro.html>
- **W3C Web Cryptography API — `SubtleCrypto`.** The single crypto primitive tier used here
  (`importKey`, `encrypt`, `decrypt`; `AES-CTR`, `AES-CBC`). No hand-rolled cipher, ever.
  <https://www.w3.org/TR/WebCryptoAPI/> · MDN: <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto>
- **NIST SP 800-38A — Block Cipher Modes of Operation (CBC, CTR).** The vectors the crypto core is
  validated against (see `src/crypto/aes.ts:226`). <https://csrc.nist.gov/publications/detail/sp/800-38a/final>

OSS exemplars (studied to inform the target design and the delta):

- **hls.js** — `src/crypt/*`: `decrypter.ts` (dispatch), `aes-crypto.ts` (WebCrypto path),
  `aes-decryptor.ts` (a **hand-written JS software AES** fallback for insecure contexts / missing
  SubtleCrypto), and `sample-aes.ts` (TS SAMPLE-AES). <https://github.com/video-dev/hls.js>
  *Where aibrush deliberately diverges:* aibrush ships **no** software-AES fallback — a true
  SubtleCrypto miss is a loud `CapabilityError` (`src/crypto/aes.ts:40`), not a slow JS cipher (ADR-018:
  no fake work; and there is no honest bit-exact-and-fast software crypto tier to route to).
  `UNVERIFIED: hls.js still ships aes-decryptor.ts as a live fallback on current main` — behavioral
  claim from prior knowledge; confirm against the repo before quoting it as current.
- **shaka-player** — parses `pssh`/`tenc` (`lib/util/pssh.js`, `lib/util/mp4_box_parsers.js`) but
  **delegates decryption to the platform CDM via EME** (`lib/media/*` / EME engine); it does not
  software-decrypt protected media in JS. <https://github.com/shaka-project/shaka-player>
  *Where aibrush diverges:* aibrush software-decrypts with caller-supplied keys and never touches EME —
  the two projects solve **different** problems (offline byte transform vs. online DRM playback).
  `UNVERIFIED: exact current shaka file paths` — architecture (EME delegation) is certain; the file
  names may drift.

## 3. Target design

### Data model & layering (four seams, no leaks)

1. **Crypto core** — `src/crypto/aes.ts`. Pure WebCrypto primitives with **zero container knowledge**:
   `aesCtr`/`aesCtrWithPreparedKey` (`aes.ts:111`/`aes.ts:89`), `aesCbcNoPadding` (`aes.ts:228`),
   `aesCbcPkcs7` (`aes.ts:245`), plus prepared-key imports (`prepareAesCtrKey` `aes.ts:75`,
   `prepareAesCbcKey` `aes.ts:141`). One typed capability gate: `subtle()` (`aes.ts:40`) returns
   `crypto.subtle` or throws `CapabilityError('capability-miss', … op:'decrypt')`. `PreparedAesKey`
   (`aes.ts:61`) carries the exact importing `SubtleCrypto` realm alongside the non-extractable
   `CryptoKey`, so a host that swaps `globalThis.crypto` between async stages can't invalidate a
   prepared key. **AES-CBC-NoPadding** is the one clever primitive: SubtleCrypto has no no-padding CBC,
   so decrypt appends a synthetic terminal block `AES_enc((0x10)^16 ^ C_last)` and lets SubtleCrypto
   strip the resulting full PKCS#7 block; encrypt drops the appended pad block (`aes.ts:169`–`237`,
   NIST-vector validated `aes.ts:226`).
2. **Scheme/container layer** — `cenc.ts` (ISO-BMFF CENC), `hls-aes.ts` (HLS AES-128 + TS SAMPLE-AES
   block model), `hls-full-segment-decrypt.ts` (shared abort-aware whole-segment path),
   `mpegts-decrypt.ts` (TS dispatch). These parse protection boxes / TS-PES structure and call the
   crypto core; they never call SubtleCrypto directly.
3. **Driver seam** — `ContainerDriver.decrypt(src, DecryptParams): ReadableStream<Uint8Array>`
   (`src/contracts/driver.ts:465`), optional ⇒ a container with no `decrypt` is a **typed miss**
   (`src/api/decrypt-runner.ts:56`).
4. **API seam** — `media.decrypt` lazy-imports `runDecrypt` (`src/api/engine.ts:901`);
   `runDecrypt` (`src/api/decrypt-runner.ts:41`) normalizes input, resolves the container driver in
   the `'demux'` direction, calls `container.decrypt`, and materializes to the caller's sink.

### Capability routing (WebCodecs → GPU → WASM, applied to crypto)

For this family the ladder **collapses to one native tier**: `crypto.subtle` is the "hardware/native"
decrypt provider. There is **no GPU tier** (AES on GPU is not a supported native primitive) and
**deliberately no WASM/JS software-AES tier** — heavy WASM is only downloaded on a *hardware miss*, and
here a "miss" (no `crypto.subtle`) has no honest software substitute we would ship, so it fails loudly
with `CapabilityError` (`aes.ts:40`). The developer never names `AES-CTR` vs `AES-CBC`; the
`scheme` + container drive primitive selection (`cenc/cens` → prepared CTR key; `cbcs` → prepared CBC
key: `cenc.ts:1387`). The AVC **decode-verify** that gates fragmented CENC output *does* route through
the hardware→WASM decode ladder, but that decoder is owned by decode-seek (S10), not this family.

### Edge cases

- **B-frames** — irrelevant to the crypto itself (a byte transform is codec- and order-agnostic). They
  matter only to the *validation decoder*: recovered samples finish **out of decode order** (the
  bounded window, below), so an in-order gate must reorder them before the decoder. The out-of-order
  completion hook is `SampleDecryptedCallback` (`cenc.ts:583`); the reorder gate lives in the driver
  (`mp4-driver.ts` `createOrderedSampleGate`, referenced `mp4-driver.ts:3219`). Target: the fragmented
  path must feed that same gate (Delta 7).
- **VFR** — **not applicable.** Decryption is byte-length-preserving and never touches
  `stts`/`ctts`/`trun` sample durations or composition offsets; a VFR timeline survives verbatim
  (`decryptCencFile` writes clear bytes **in place**, output length === input, `cenc.ts:1319`).
- **Seek** — **not applicable in the streaming sense.** Decrypt is a whole-unit operation. For a
  seekable `ByteSource` the HLS path issues exactly one `source.range(0, size)` and never opens a
  redundant stream (`hls-full-segment-decrypt.ts:38`); the CENC engine consumes the whole file once.
- **Cancel** — HLS is fully abort-aware end to end: pre-op (`assertHlsSegmentNotAborted`
  `hls-full-segment-decrypt.ts:20`), during the stream read (an `abort` listener cancels the reader,
  `:60`), and post-op (`assertHlsSegmentClearNotAborted` **zeroes recovered plaintext before throwing**,
  `:120`). The output stream is demand-driven and cancel-before-pull wipes bytes
  (`demandDrivenSegmentStream`, `:96`). **Gap:** `decryptCencFile` / `forEachSampleBounded` take no
  signal (`cenc.ts:338`, `cenc.ts:1319`) — Delta 2.
- **Frame lifetime (`close()` exactly once)** — the crypto core produces **no `VideoFrame`/`AudioData`**;
  the only frames in the whole flow come from the optional AVC decode-verify
  (`verifyTrimmedAvcDecodeIfAvailable`, `mp4-driver.ts:4459`), whose frame lifetime is owned by
  decode-seek (S10). This family owns only **key material** lifetime: HLS zeroes `key`/`iv` in a
  `finally` (`hls-full-segment-decrypt.ts:177`, `mpegts-decrypt.ts:66`) and `clear` on abort; the CENC
  engine imports **one non-extractable `CryptoKey` per KID** and caches it per file (`cenc.ts:1374`),
  but does not zero the caller's raw hex (Open Question 7).
- **Backpressure** — real, on both paths. CENC bounds concurrent SubtleCrypto operations to
  `CENC_DECRYPT_MAX_IN_FLIGHT = 16` via a pull-style worker window (`cenc.ts:331`, `forEachSampleBounded`
  `cenc.ts:338`); on any failure it stops admitting work, drains in-flight ops, and rethrows the
  **lowest-index** failure so a partial file is never emitted (`cenc.ts:365`). HLS output uses
  `highWaterMark: 0` and enqueues exactly one buffer on pull (`hls-full-segment-decrypt.ts:96`). The
  WebCrypto floor is **one call per protected sample/subsample** — combining samples into one CTR/CBC
  call is invalid because the counter/chain resets at sample boundaries (measured-evidence.md_, and see
  `counterBlockAt` `cenc.ts:302`).

### Graceful-failure oracle (never fake; typed errors only)

AES-CTR/CBC ciphertext is unauthenticated and indistinguishable from random, so integrity is **not**
provable from the bytes alone (measured-evidence.md_). The design uses defense-in-depth, not fingerprinting:
- `assertNotErasedProtection` (`cenc.ts:378`): a 16-byte all-zero run inside protected data is
  impossible for real ciphertext (2⁻¹²⁸) ⇒ erased/tampered ⇒ typed `MediaError('demux-error')`.
- `assertNoSandwichedIvCorruption` (`cenc.ts:204`, `ivEqualsIncremented` `cenc.ts:186`): rejects a
  single IV that isn't the unique midpoint of two consecutive-counter neighbours (false-premise chance
  2⁻⁶⁴/2⁻¹²⁸), catching a one-bit `senc` IV flip without assuming sequential IVs.
- The **load-bearing** check is the full AVC decode-verify at the codec seam (`mp4-driver.ts:4459`): a
  structurally-valid IV/payload mutation decrypts to garbage that only a real decoder rejects
  (`cenc-graceful-rotation.test.ts`; measured-evidence.md_). This is why the family is ~2× a decrypt-only
  competitor (aibrush ~80–164 ms vs ffmpeg.wasm ~33–67 ms per file; measured-evidence.md_) — and why it must be
  **pipelined** (Delta 7), not removed.

## 4. Current state

What exists today, with citations and the smells to fix.

- **Crypto core `src/crypto/aes.ts`** — clean and complete: prepared-key CTR/CBC, no-padding CBC via
  synthetic-block framing (`aes.ts:169`–`237`), PKCS#7 CBC for HLS (`aes.ts:245`), single
  `CapabilityError` gate (`aes.ts:40`). **No module-global mutable state.** Good seam.
- **CENC `src/drivers/mp4/cenc.ts` (1,550 lines) — a god-file.** It contains three logically distinct
  layers: (a) box parsers (`parseTenc` `:97`, `parseSenc` `:229`, `parseSaiz/SaioSizes`
  `:949`/`:964`, `parseSeigGroups` `:888`, `parseTfhd`/`parseTrun`/`parseTrak`
  `:1069`/`:1090`/`:1116`); (b) the per-sample cipher (`decryptSamplePrepared` `:392`,
  `decryptSampleCensPrepared` `:442`, `decryptSampleCbcsPrepared` `:529`, `cryptBlockOffsets` `:511`);
  (c) the whole-file engine `decryptCencFile` (`:1319`) with in-place neutralization
  (rename `enca`/`encv`/`sinf`/`senc`/`saiz`/`saio` → `free`, zero `'seig'` grouping_type, `:1544`).
  It handles flat `stbl` **and** fragmented `moof` layouts, constant-IV / per-sample-IV / `saiz`-located
  aux, and `sbgp`/`sgpd` `'seig'` overrides. The `keyCache` is a **per-file local** `Map`
  (`:1374`) — correctly *not* module-global, but the file's size and the parser/cipher/engine mixing are
  the layering smell. `assertNotErasedProtection` copies data via `data.subarray` scans; fine.
- **Two competing CENC decrypt implementations.** `Mp4Driver.decrypt` (`mp4-driver.ts:4386`, S23-owned)
  routes **fragmented** files through `decryptCencFile` (`mp4-driver.ts:4422`) but **flat moov** files
  through a *second*, older `decryptCencTrack`/`decryptAndVerifyCencTrack`
  (`mp4-driver.ts:3149`/`3290`). The whole-file engine already covers flat `stbl` layouts
  (`buildFlatSamples` `cenc.ts:1012`; `cbcs.test.ts:958`). This duplication is the top delta (Delta 1;
  measured-evidence.md_ flags `cbcs_decrypt` still on the `decryptCencTrack` path).
- **HLS full-segment `src/drivers/hls-full-segment-decrypt.ts`** — the SOTA shared path: abort-aware,
  key/iv zeroed, `validate` callback, demand-driven output. Correctly reused by **MPEG-TS**
  (`mpegts-decrypt.ts:30`) and **ADTS** (`adts-driver.ts:846`).
- **Layering smell — MP4 does *not* reuse the shared HLS helper.** `Mp4Driver` has a private
  `decryptHlsSegmentMp4` (`mp4-driver.ts:3362`) that re-implements the full-segment path but (a) never
  threads `o.signal`, (b) never zeroes `key`/`iv`, (c) re-derives the length/PKCS#7 gating that
  `decryptHlsAes128` (`hls-aes.ts:66`) already owns (Delta 3).
- **HLS SAMPLE-AES `src/crypto/hls-aes.ts`** — the TS/PES walker with per-codec block runs
  (`h264EncryptedRuns` `:409`, `decryptAacSampleAes` `:420`), a scrambled-bit check (`parseTsPacket`
  `:258`), and a plausibility-validated NAL scanner (`isPlausibleH264NalHeader` `:402`) so a `00 00 01`
  in ciphertext can't fake a NAL boundary. Constants `H264_CLEAR_LEAD=32`/`H264_SKIP_BYTES=144`/
  `AAC_CLEAR_LEAD=16` (`:18`–`:20`). Uses `gather → aesCbcNoPadding → scatter` (`decryptBlockRuns`
  `:458`).
- **TS dispatch `src/drivers/mpegts/mpegts-decrypt.ts`** — small and correct: dispatches `hls-aes128`
  to the shared helper and `hls-sample-aes` to the TS walker, zeroing `key`/`iv` in a `finally`
  (`:66`). No smells.
- **API `src/api/decrypt-runner.ts`** — correct scoping (empty keys ⇒ EME miss `:49`; live MediaStream
  rejected `:88`). **Smell: a 17-entry `CONTAINER_MIME` literal (`:9`)** hard-codes container→MIME
  inside the API layer (a capability leak duplicating driver knowledge) and defaults
  `container.formats[0] ?? 'mp4'` (`:70`) — Delta 4.

## 5. Delta / punch-list (ordered; each item has an acceptance test)

1. **Unify MP4 CENC on the whole-file engine; delete `decryptCencTrack`.** Route *all* `cenc`/`cens`/
   `cbcs` through `decryptCencFile` (`cenc.ts:1319`) and remove `decryptCencTrack`/
   `decryptAndVerifyCencTrack` (`mp4-driver.ts:3149`/`3290`), keeping the pipelined decode-verify (Delta 7).
   *Acceptance:* `encryption/cbcs_decrypt` and `cenc_ctr_decrypt` pass via the single engine; a new test
   asserts the **flat** (non-fragmented) path output is **byte-identical** to the openssl/Bento4 twin
   (extend `cbcs.test.ts:958`); `grep -R decryptCencTrack src` returns nothing.
2. **Thread `AbortSignal` into the CENC engine.** Add `signal?: AbortSignal` to `DecryptFileOptions`
   (`cenc.ts:685`) and check it between samples in `forEachSampleBounded` (`cenc.ts:338`); on abort,
   zero the written region of `out` before throwing `MediaError('aborted')`.
   *Acceptance:* a test aborts after N of M samples and asserts (i) a typed `MediaError('aborted')`,
   (ii) no clear bytes leak (the touched `out` range is zeroed), mirroring
   `assertHlsSegmentClearNotAborted` (`hls-full-segment-decrypt.ts:120`).
3. **Route MP4 `hls-aes128` through the shared helper.** Replace `decryptHlsSegmentMp4`
   (`mp4-driver.ts:3362`) with `decryptHlsAes128ContainerSegment(src, o, { driverId:'mp4',
   containerLabel:'MP4', validate })` (`hls-full-segment-decrypt.ts:149`), matching ADTS/MPEG-TS.
   *Acceptance:* MP4 `hls-aes128` with a pre-aborted signal throws `MediaError('aborted')`; a spy proves
   `key`/`iv` are `fill(0)`-zeroed; the passing twin's byte output is unchanged.
4. **Lift `CONTAINER_MIME` out of the API layer.** Move the container→MIME map (`decrypt-runner.ts:9`)
   into the driver/registry (a driver already owns `formats`); the runner asks the driver for its output
   MIME. *Acceptance:* `decrypt-runner.ts` contains no literal MIME table; decrypt-to-Blob still stamps
   `video/mp4` / `video/mp2t` / `audio/aac` correctly; `grep CONTAINER_MIME src/api` is empty.
5. **Make typed `CapabilityError` the *sole* NA signal (no message-regex).** (measured-evidence.md_.) The harness
   must classify NA on `CapabilityError`, not on a message-matching regex, so a real capability sentence
   can't silently become NA instead of FAIL. *Acceptance:* a decrypt throwing `CapabilityError` ⇒ NA; a
   decrypt throwing `MediaError('demux-error')` ⇒ FAIL; a harness test asserts both classifications.
6. **Resolve fMP4 SAMPLE-AES / SAMPLE-AES-CTR: implement with real vectors, or keep a typed non-claim.**
   (measured-evidence.md_: only `cenc/cens/cbcs`, `hls-aes128`, TS `hls-sample-aes` are implemented.)
   *Acceptance (interim):* `decrypt({scheme:'hls-sample-aes'})` on an **fMP4** segment throws a typed
   `CapabilityError` (never a wrong result). *Acceptance (if implemented):* recover an independently
   AES-CBC-encrypted fMP4 twin **byte-exact** through `media.decrypt`.
7. **Pipeline the fragmented decrypt→decode-verify.** The flat path already overlaps via the ordered
   gate (`mp4-driver.ts:3219`); the fragmented path decrypts the whole file, re-reads it, then
   decode-verifies serially (`mp4-driver.ts:4430`–`4468`). Feed each recovered access unit to the
   validation decoder through the existing `SampleDecryptedCallback` (`cenc.ts:583`).
   *Acceptance:* a benchmark shows fragmented-CENC wall ≈ `max(decrypt, decode)` (not the sum);
   `cenc-graceful-rotation.test.ts` still rejects the structurally-valid IV mutation.
8. **Add a WebCrypto-miss conformance test.** `subtle()` (`aes.ts:40`) throws `CapabilityError` when
   `crypto.subtle` is absent, but no test exercises it. *Acceptance:* with `globalThis.crypto.subtle`
   stubbed `undefined`, every scheme's `decrypt` throws `CapabilityError('capability-miss', … op:'decrypt')`
   — proving there is **no** silent JS-cipher fallback (contrast hls.js `aes-decryptor.ts`).

## 6. Open questions (each seeds a decision record)

1. **Software-AES fallback?** Should aibrush ever ship a WASM/JS AES for insecure-context or
   SubtleCrypto-less environments (as hls.js `aes-decryptor.ts` does)? Current stance: no — loud
   `CapabilityError` (ADR-018). Log the decision explicitly so the "miss-only WASM" ladder's crypto
   exception is on record.
2. **EME/CDM boundary.** `runDecrypt` rejects empty keys as out-of-scope EME (`decrypt-runner.ts:49`).
   Do we ever integrate EME for real DRM (the shaka-player problem), or stay a ClearKey/known-key byte
   transform forever? Log the scope boundary.
3. **Always-on decode-verify vs. speed.** The load-bearing AVC decode-verify makes the family ~2×
   decrypt-only competitors (measured-evidence.md_). Keep it always on (integrity guarantee) or add a documented
   opt-out for trusted inputs? Log the safety/speed tradeoff.
4. **fMP4 SAMPLE-AES / SAMPLE-AES-CTR vectors.** Which independent tool authors the oracle twins
   (Bento4? Apple `mediastreamsegmenter`?) before we can honestly claim these schemes (Delta 6)? Log.
5. **Multi-entry `saio`.** Interleaved multi-run auxiliary offsets are a `CapabilityError` today
   (`cenc.ts:1424`, `cenc.ts:1500`). Is single-entry `saio` sufficient for every real corpus, or must
   multi-run aux be supported? Log the capability boundary.
6. **Home for the container→MIME map (Delta 4).** Registry, driver, or shared util? Log the chosen
   owner so the capability leak doesn't reappear.
7. **Caller key-material lifetime.** HLS zeroes `key`/`iv`/`clear`; the CENC engine imports
   non-extractable `CryptoKey`s but does not zero the caller's raw hex in `opts.keys` after use
   (`cenc.ts:1386`). Should the runner zero caller key bytes post-op (defense-in-depth), given the
   imported keys are already non-extractable? Log.
