# Real-world `cbcs` decrypt — the whole-file `decryptCencFile` engine (ADR-182)

## Problem / root cause

The driver's original decrypt path (`decryptCencTrack` in `mp4-driver.ts`) reads sample encryption metadata
only from the **`moov` sample tables** (a `stbl`-level `senc`, or a `tenc` `default_constant_IV`). Real
`cbcs` assets — Apple HLS/DASH-IF/CMAF, Bento4 `mp4encrypt --method MPEG-CBCS` — are almost always
**fragmented**: the `moov` `stbl` is empty and every sample's size, position, IV and subsample map live in
`moof/traf` (`tfhd`/`trun`/`senc`/`saiz`/`saio`/`sbgp`/`sgpd`). Such a track has
`parsed.samples.sampleSizes.length === 0`, so the driver rejected it with *"cbcs track N has no decryptable
samples"*. It also handled exactly one `cbcs` shape and missed constant-IV-no-`senc` audio, `seig`
sample-group overrides, `saiz`/`saio`-located aux, and multi-`moof` fragments.

`src/drivers/mp4/cenc.ts` now exports **`decryptCencFile(bytes, { scheme, keys })`**: a single self-contained
pass over a *complete* ISO-BMFF byte buffer that decrypts every protected sample **in place** (output length
=== input length) and neutralizes the protection signalling so the result probes as a clear file. It parses
raw bytes with `reader.ts` primitives only (no `parse.ts`/`mp4-driver.ts` coupling → no import cycle).

## Layouts handled (ISO/IEC 23001-7 §§7–10, 14496-12 §8.8/§8.9)

1. **Constant-IV, NO aux data** — `tenc` `default_constant_IV`, Per_Sample_IV_Size 0, no `senc`/`saiz`.
   Full-sample audio (Apple/Bento4 write `tenc` v1 pattern `0:0`). Positions come from `trun`; the IV is the
   constant IV; every whole 16-byte block is CBC-decrypted, the sub-block tail stays clear.
2. **Per-sample-IV `senc` + subsample maps** — the `cbcs` video layout, across multiple `moof` fragments
   (each fragment's `moof`-relative base is recomputed from that `moof`'s absolute start).
3. **`sbgp`/`sgpd` 'seig' overrides** — per-group `isProtected` (clear groups skipped), KID rotation
   (per-sample key), constant-IV and crypt:skip overrides; traf-local indices (`≥ 0x10001`) resolve against
   the traf `sgpd`, indices `1..0xFFFF` against the movie-level (`stbl`) `sgpd`, index `0` uses `tenc`.
4. **`saiz`/`saio`-located aux (no `senc`)** — per-sample IV (+ optional subsample map) read from the `mdat`
   at `trafBase + saio_offset`; explicit-absolute / default-base-is-moof / legacy-implicit `tfhd` bases;
   32-bit and 64-bit `saio`; typed (`aux_info_type`) `saio`. A multi-entry `saio` is a typed decline.
5. **Mixed clear/encrypted** — clear tracks and clear sample descriptions (`stsd` > 1) pass through
   byte-identical; only samples whose `stsd` entry is `enca`/`encv` (and not `seig`-cleared) are decrypted.

`cenc` (AES-CTR) and `cens` (AES-CTR pattern) fragmented files share the same engine (scheme switch on the
per-sample decrypt). Flat (non-fragmented) `stbl`-table files — `stsc`/`stsz`/`stco`/`co64`, `stbl`-level
`senc`/`saiz`/`saio` — are also handled by the same code path.

## Neutralization (so the output probes clear)

`parse.ts` detects protection purely via the sample-entry type (`enca`/`encv`). After decryption the engine
rewrites, in the output copy: the sample-entry fourcc → its `frma` original format (`enca`→`mp4a`,
`encv`→`avc1`); each `sinf` → `free`; each `senc` → `free`; each `seig` `sgpd`/`sbgp` → `free` with its
grouping_type zeroed. All rewrites preserve byte offsets, so decrypted sample ranges stay put and
`readMovie(out).tracks[*].encryption` is `undefined`.

## Oracles (independent of the SUT; ADR-182)

- **openssl / `node:crypto` AES-128-CBC twin**: constructed assets place ciphertext computed by
  `createCipheriv('aes-128-cbc', …, autoPadding=false)` at byte positions known a priori, over **real
  fixture media** plaintext; every decrypted byte is compared to the original. The test's cbcs-encryptor
  re-derives the crypt-block gather/scatter, so a wrong pattern/offset fails the byte-exact gate.
- **Bento4 third-party leg** (`mp4fragment` + `mp4encrypt --method MPEG-CBCS`): a fully independent tool
  fragments and cbcs-encrypts `movie_5.mp4` (video `1:9` + audio `0:0`); the engine's output `mdat`
  payloads must equal the clear original's byte-for-byte, and a wrong key must NOT recover them.
- **ffmpeg is NOT used** for `cbcs` crypto: it cannot even open this fragmented layout (`error reading
  header`), and (per the CENC-CTR memo) its video-subsample crypto is non-conformant. openssl + Bento4 +
  the 23001-7 construction are the oracle set.

Coverage: strict TS, zero `any`, typed errors only; `bunx vitest` gate is
`cbcs.test.ts cenc.test.ts cenc-ops.test.ts cenc-robustness.test.ts` (all green), ≥90% branch on `cenc.ts`.
Benchmark: `bun scripts/bench-cbcs-decrypt.ts` (fresh, multi-sample, median-of-9 throughput).

## Follow-up for the lead (NOT edited by this task — driver-owned files)

The whole-file engine is complete and validated, but the **acceptance harness feature
`encryption/cbcs_decrypt` goes through `media.decrypt`**, which still uses the `moov`-only `decryptCencTrack`
path. To close the harness feature, `Mp4Driver.decrypt` (`src/drivers/mp4/mp4-driver.ts`, ~line 2696) should
route the buffered whole file through `decryptCencFile` when the container has protected tracks (the buffer
is already fully read via `randomAccess`), e.g. for `scheme ∈ {cenc,cens,cbcs}` call
`decryptCencFile(await ra.read(0, ra.size), { scheme, keys })` and `oneShot` the result, keeping the
existing HLS-AES-128 branch. `decryptCencFile` needs **no new field from `parse.ts`** — it parses the raw
bytes itself.
