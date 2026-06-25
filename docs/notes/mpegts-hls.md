# Design note — MPEG-TS container driver + HLS playlist parser

> Per `BUILD_INSTRUCTIONS.md` §4 (ULTRATHINK). Implements `src/drivers/mpegts/` (a `ContainerDriver`,
> ADR-002: containers are ours, pure TS) and `src/drivers/hls/` (an `.m3u8` parser). Not registered in
> `defaults.ts` (the parent owns that). Validated structurally against real `.ts`/`.m3u8` fixtures.

## Goal (concrete)

**MPEG-TS** (ISO/IEC 13818-1) — `id:'mpegts'`, `formats:['ts','m2ts','mts']`:

- **probe** `(ByteSource) → Demuxer` whose `.tracks` feed `toMediaInfo` (`engine.ts`): `container` becomes
  `formats[0]='ts'`; per track a `TrackInfo { id, mediaType, codec, durationSec, config }` — video
  `config:{ codec, codedWidth, codedHeight }`, audio `config:{ codec, sampleRate, numberOfChannels }`
  (that is exactly what `toInfoTrack` reads to surface width/height/sampleRate/channels). `durationSec`
  from the PES PTS span (PCR refines it when present).
- **demux** `packets(trackId) → ReadableStream<EncodedChunk>` — reassemble PES → access units, attach
  33-bit/90 kHz PTS/DTS as WebCodecs µs, emit `EncodedVideoChunk`/`EncodedAudioChunk` in **decode order**.
  Browser-gated exactly like `mp4-driver.ts` `packetStream`: `typeof EncodedVideoChunk==='undefined'` →
  `CapabilityError`, body behind `/* v8 ignore */` (validated under browser-mode in a later phase).

**HLS** — parse `.m3u8` (master + media): `#EXTM3U`, `#EXT-X-STREAM-INF` (master variants),
`#EXTINF` + URI (media segments), `#EXT-X-KEY` (encryption descriptor), plus the common media tags
(`VERSION`, `TARGETDURATION`, `MEDIA-SEQUENCE`, `PLAYLIST-TYPE`, `ENDLIST`, `BYTERANGE`,
`DISCONTINUITY`). Output a structured, typed playlist + segment list; segment **resolution/demux reuses
the mpegts driver** (HLS itself is not a `ContainerDriver` — it has no byte container — so it is a pure
parser module that also default-exports a `DriverModule` re-exposing the mpegts driver for the `.ts`
segments, keeping the "export DriverModule default(s)" contract without registering a bogus container).

## Ground truth (measured from the real fixtures — the oracle, can fail)

`media-test/.../h264_ts.ts` (4.63 MB, 24 647 × 188 B, all sync `0x47`):
PAT@pkt1 → program 1 → PMT PID `0x1000`; PMT@pkt2 PCR_PID `0x100`, ES: `stream_type 0x1b`=H.264 @ PID
`0x100`, `0x0f`=AAC-ADTS @ PID `0x101`. First video PES `stream_id 0xe0`, PTS 127920 → **1.42133 s**
(== ffprobe `start_time`); first audio PES `0xc0`, PTS 126000 → **1.4 s**. `hls_vod_000.ts`: same codecs,
video span 1.97 s / 60 frames. `ts_discontinuity.ts`: H.264 320×240 + AAC. `hls_aes128_000.ts`:
whole-segment AES-128 (not 188-aligned, ~0 % sync) → probe must **reject** (`InputError`).
`fuzz_ts_zeroed_spans.ts`: 8/24647 packets zeroed → must resync and not crash.

## Approach

- **One 188-byte packet cursor** over a fully-read source (a TS has no header/index — duration needs the
  PTS span, so probe reads the whole segment; segments are bounded, MBs not GBs). `m2ts`/`mts` carry a
  4-byte timestamp prefix (192-byte packets) → detect packet size from the sync-byte stride (188 / 192 /
  204), then index from the first `0x47`. **Rejected alternative:** streaming, header-only probe like
  WebM — impossible here, TS has no front-loaded metadata; duration would be a fabricated 0.
- **PSI (PAT/PMT)** parsed from the `payload_unit_start` packet (skip `pointer_field`, then a `section`);
  only the *first* PAT/PMT instance is needed (they repeat). PMT `stream_type` → codec id via a table
  (`0x1b`→h264, `0x24`→hevc, `0x0f`→aac, `0x03/0x04`→mp3, `0x81`→ac-3, `0x1c`→pcm, `0x06`→PES-private
  probed for an AC-3/Opus registration descriptor; conservative fallback otherwise).
- **PES reassembly per PID:** a PUSI starts a new PES; accumulate continuation packets until the next
  PUSI (or the declared `PES_packet_length` for audio, which is non-zero). Strip the PES header, read
  PTS/DTS (33-bit across 5 bytes with marker bits, as validated above), and the payload **is** the access
  unit for that frame in TS (H.264/AAC are byte-stream/ADTS — no extra framing needed for the chunk seam).
- **Decode order:** TS PES already arrive in decode (transmission) order; we emit as-reassembled, so DTS
  is monotonic and B-frames keep PTS≠DTS without reordering. Keyframe flag: for H.264 we scan the access
  unit's Annex-B NAL units for an IDR (type 5) / SPS/PPS; absent a recognizable codec we mark the first
  AU of each PID as key and the rest delta only when we cannot do better — but we *do* better for H.264.

## Edge cases (enumerated)

- m2ts/mts 192-B (4-B prefix) and 204-B (16-B RS parity) packets; mis-aligned start; partial trailing
  packet (truncated) → dropped, not crashed. Non-`0x47` (corrupt/zeroed) packets → **resync** to the next
  `0x47` at the stride; never read past `188`.
- `adaptation_field_control`: 0 (reserved→skip), 1 (payload only), 2 (AF only, e.g. PCR-only / stuffing),
  3 (AF+payload); AF length may consume the whole packet. PCR read from AF when `PCR_flag`.
- PES with `PES_packet_length==0` (unbounded — video): terminated by the next PUSI on that PID or EOF.
- 33-bit PTS/DTS **wraparound** (≈ 26.5 h) and HLS discontinuities (a large backward jump): the duration
  estimate uses (last − first) but unwraps a single 2³³ wrap and ignores a backward discontinuity rather
  than reporting a negative/huge span.
- multitrack (≥1 video + ≥1 audio + others); unknown `stream_type` → still a track with a best-effort
  codec string (honest, never silently dropped). Encrypted segment (HLS AES-128 / scrambled
  `transport_scrambling_control≠0`) → `InputError` (the cleartext is unavailable to probe).
- demux `packets(badId)` → `demux-error`; `signal` aborted → `aborted`.
- HLS: master (variants, no segments) vs media (segments) — detected by `EXT-X-STREAM-INF` vs
  `EXTINF`/`ENDLIST`; CRLF or LF line endings; comments (`#` not a tag); blank lines; relative vs absolute
  URIs (resolved against an optional base); attribute-list quoting (`URI="..."`, `IV=0x…`); missing
  `#EXTM3U` → `InputError`.

## Failure modes → typed errors

`InputError('unsupported-input')`: not a TS (no recoverable sync run), fully scrambled/encrypted segment,
not an `.m3u8` (missing `#EXTM3U`). `MediaError('demux-error')`: a TS with sync but no PAT/PMT/usable
track, or a bad `trackId`. `CapabilityError('capability-miss')`: WebCodecs `Encoded*Chunk` absent in the
env (the packet seam). `MediaError('aborted')` on signal. Never a silent wrong result.

## Test plan (strict structural oracle, real media)

- A small **real-bytes slice** of `h264_ts.ts` committed under `fixtures/media-derived/` (verbatim first
  N×188 B carrying PAT+PMT+first PES — a valid probe input) for an offline, committed oracle; the larger
  spans use the sibling `media-test` `.ts` directly by path. Assert: packet count & 188 alignment; PAT
  program→PMT PID; PMT stream-type→codec (h264 + aac); per-track `config` dims/sampleRate/channels;
  **first PTS == 127920/126000** and **monotonic non-decreasing DTS** across the reassembled PES;
  duration ≈ ffprobe within ±1 frame. HLS: parse both real playlists — segment list (5 URIs, EXTINF
  2.0), `EXT-X-KEY` METHOD=AES-128 + IV on the encrypted one, PLAYLIST-TYPE=VOD, ENDLIST; reject a
  playlist missing `#EXTM3U`; classify master vs media. Anti-overfit: run probe across ≥5 distinct real
  `.ts` files (h264_ts + 4 HLS segments + discontinuity). Mutation: a corrupted stream-type / wrong PID
  must make the oracle fail.
- Validate: `bun run typecheck` + `bun test` on the two new test files. (Browser packet-emission path is
  `/* v8 ignore */`, validated under Playwright in the codec phase, as with mp4.)
