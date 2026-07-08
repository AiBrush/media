# HLS AES-128 full-segment decrypt — RFC 8216 conformance (ADR-183)

Engineering note for the `src/drivers/hls/` AES-128 path. The authority is RFC 8216 §4.3.2.4 / §4.3.2.5 /
§4.3.2.2 and the independent twins `openssl enc -d -aes-128-cbc` + `ffprobe`. Corpus lives under
`fixtures/media-derived/hls-aes128/`, baked by `scripts/bake-hls-aes128-fixtures.ts`
(`ffmpeg -hls_key_info_file` and `openssl enc`; every playlist ffprobe-verified at bake time).

## Symptom

On a real AES-128 playlist the pipeline emitted `not an MPEG-TS stream (no transport sync run found)`:
the decrypt produced no `0x47` sync run, i.e. the key/IV/padding was wrong for that playlist *shape*.
Only one narrow variant (explicit IV, media-sequence 0) had ever been exercised.

## Root causes + fixes (all in `m3u8-parse.ts` / `hls-source.ts`)

1. **Implicit IV truncated past 2^32.** RFC 8216 §4.3.2.4: with no `IV=` attribute, the IV is the
   segment's *media sequence number* (`EXT-X-MEDIA-SEQUENCE` + per-segment offset) as a **128-bit
   big-endian** integer. `hls-source.ts` wrote only the low **32** bits (`setUint32`, `sequence >>> 0`),
   so sequence `2^32` decrypted with IV `0` → garbage. Fixed to a big-endian **u64** in the low 8 bytes
   (`DataView.setBigUint64(8, BigInt(sequence))`) — exact across the realistic 64-bit media-sequence
   domain, e.g. `2^32 → …0001_00000000`.

2. **`EXT-X-BYTERANGE` continuation form unresolved.** §4.3.2.2: a range with no `@offset` resumes at the
   previous sub-range's end **within the same resource**; a first/orphan/cross-resource continuation is
   malformed. The parser passed the offset-less range straight through (sliced from 0 → wrong window →
   PKCS#7 fail). Added a running byte-range cursor in the parser that materializes the offset and raises
   `InputError` on an invalid continuation.

3. **Malformed vs short `IV=`.** §4.2 hexadecimal-sequence: a `0x`/`0X`-prefixed 1..32 hex digits,
   left-padded to 16 bytes (`IV=0X7F → 00…007f`). A *malformed* IV (non-hex / >128-bit / no prefix) must
   never silently fall back to the sequence IV — that decrypts to garbage. Now a hard `InputError` for
   the methods we decrypt (`AES-128` / `SAMPLE-AES`), but tolerated for opaque DRM methods
   (`SAMPLE-AES-CTR`, non-`identity` KEYFORMAT) whose IV we never interpret.

4. **Encrypted `EXT-X-MAP` init section not decrypted.** §4.3.2.4/§4.3.2.5: the `EXT-X-KEY` in force
   applies to the media-initialization section *and* an encrypted init section **requires an explicit
   `IV=`** (there is no sequence number to derive one). The init was appended raw. The parser now
   snapshots the key in force at the map's declaration (`HlsMap.key`); resolve decrypts the init with that
   key's explicit IV, or raises `InputError` when the IV is absent. A map declared *before* any key stays
   clear.

5. **Packed-audio misrouted.** §3.4: a raw ADTS/AAC rendition's stitched cleartext is **not** MPEG-TS.
   The MIME was hard-coded `video/mp2t`. Now the stitched head is sniffed: fMP4 (an `EXT-X-MAP` was
   present) → `video/mp4`; `0x47` → `video/mp2t`; ADTS syncword (`0xFFF`, layer 0 ⇒ `byte1 & 0xF6 ==
   0xF0`) → `audio/aac`; else default MPEG-TS.

Unchanged, per RFC: a key applies to all following segments until the next `EXT-X-KEY` (rotation /
multiple keys); `METHOD=NONE` resets to clear; key URIs resolve against the playlist URI; each segment is
independently AES-128-CBC + PKCS#7 and stripped before concatenation; AES-128 is full-segment (distinct
from `SAMPLE-AES`, whose existing TS slice handling is untouched); `src/crypto/aes.ts` is unchanged (its
`aesCbcPkcs7` is the real WebCrypto primitive and was already correct).

## Oracles (can-fail, independent — directive 6)

Per baked variant: our decrypted bytes `== node:crypto/openssl` output byte-exact; stitched TS is
`0x47`-sync every 188 bytes; the unmodified engine probes to the ffprobe duration/tracks. Variants:
`ffmpeg-explicit-seq47`, `implicit-seq47` (media-seq ≠ 0), `implicit-seq0` (6-segment IV progression),
`rotation` (k1 implicit → k2 explicit, CRLF), `none-mid`, `byterange` + `byterange-continuation`,
`seq-2pow32`, `audio-adts`, `fmp4-encmap`. Tests: `src/drivers/hls/hls-aes128.test.ts`. Bench:
`scripts/bench-sources.ts` (HLS resolve+decrypt section).

## ADR-183 addendum — the `probe/hls_aes128` harness red is ROUTING, not decrypt

A later fair-harness re-run STILL showed `probe/hls_aes128` red with the exact message
`not an MPEG-TS stream (no transport sync run found — encrypted, scrambled, or not a transport stream)`
(origin: `src/drivers/mpegts/ts-parse.ts`). The prior "Symptom" section read that as a decrypt failure. It
is **not**. Measured against the actual harness corpus (`media-test/.../fixtures/media/hls_aes128.m3u8` and
every `scenarios/{probe,demux,encryption}/hls_aes128/` copy — two distinct key/IV pairs):

- `resolveHlsSource` on each copy is **byte-exact to `openssl enc -d -aes-128-cbc`** with the playlist's
  declared key + explicit `IV=0x…`, first byte `0x47`, a `0x47` sync at every one of ~24 461 packets, and
  the stitched TS **ffprobes** cleanly as `h264` video + `aac` audio (`ffmpeg -allowed_extensions ALL` agrees).
  The decrypt was correct the whole time; the RFC-conformance items 1–5 above are real hardening but were
  **never** the cause of this red.

- Root cause: the `.m3u8` **manifest input is never resolved** before container routing. `resolveHlsSource`
  is a driver-author export, not wired into `probe`/`demux`/`decode`. The harness feeds the manifest (or a
  raw encrypted segment) tagged `video/mp2t`; `engine.ts#routeContainer` picks the MPEG-TS driver by that
  MIME and `ts-parse` correctly finds no sync run in the *undecrypted manifest/segment* bytes. Reproduced
  byte-for-byte: `createMedia().probe(fromBytes(playlistOrSegment, { mime: 'video/mp2t' }))` throws that exact
  error; the HLS MIME instead yields `no container driver for demux application/vnd.apple.mpegurl`.

**Fix (source-level, ADR-023 — HLS is not a byte container):** `src/drivers/hls/hls-source.ts` now exports
`isHlsPlaylist(head)` (structural `#EXTM3U` sniff per RFC 8216 §4.3.1.1 — BOM-tolerant, tag-boundary-checked,
so a `video/mp2t`-tagged manifest is caught) and `resolveHlsSourceFromSource(src, opts)` (drains a manifest
`Source` to text, then `resolveHlsSource`). These are the seam an engine pre-route step uses to auto-resolve
a manifest into the demuxable segment `Source` the existing `probe`/`demux`/`decode` already consume.

**Core glue the lead must apply (engine.ts / core.ts — outside `src/drivers/hls/`):** at the top of the input
path — mirroring the existing `#probeImageInfo` pre-sniff — read the routing head and, when
`isHlsPlaylist(head)`, replace the source before `#routeContainer`:

```ts
// engine.ts, shared input step used by probe/demux/decode/convert/remux/packetInfo:
const head = await readHead(src, routeHeadBytes(src));
if (isHlsPlaylist(head)) {
  const baseUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : undefined;
  src = await resolveHlsSourceFromSource(src, baseUrl !== undefined ? { baseUrl } : {});
}
```

`resolveHlsSource`'s `fetchResource` defaults to the platform `fetch`, so a URL-served manifest resolves its
relative segment/key URIs against `baseUrl` with no extra wiring. Re-export both symbols from `src/core.ts`.
Oracles for the seam + the exact harness shape (0x47-sync + `node:crypto`/openssl byte-equality + engine
probe → `ts` with video+audio): `src/drivers/hls/hls-aes128.test.ts` (`fair-harness hls_aes128 shape`,
`isHlsPlaylist`, `resolveHlsSourceFromSource` blocks).
