# MPEG-TS AAC ADTS de-framing (ADR-184)

Why the MPEG-TS demuxer runs a **stateful ADTS de-framer** for every `stream_type 0x0f` (ADTS AAC)
elementary PID, what it emits, and how it is validated. Lives in
[`src/drivers/mpegts/ts-parse.ts`](../../src/drivers/mpegts/ts-parse.ts) (`class AdtsDeframer`).

## The bug it fixes

Remuxing a real MPEG-TS to MP4 (`remux/prop_ts_to_mp4_duration_materialized`) threw

> AAC MP4 muxing cannot mix ADTS-framed and raw samples

from the MP4 muxer's mix-detector (which is correct — a fragmented-MP4 `mdat` sample is a **raw** AAC
access unit; the `esds` carries the AudioSpecificConfig the ADTS header would otherwise repeat per frame).
The root cause was in the TS demux, not the muxer: a real transport stream packs **several** ADTS frames
into one audio PES *and* splits frames **across** PES packets (broadcast muxers flush on byte budgets, not
frame boundaries). Splitting per-PES therefore emitted **inconsistently framed** samples — some still
ADTS-framed (header present), some raw, some boundary-corrupted — so the muxer saw a mix and rejected it.

## What the de-framer guarantees

One `AdtsDeframer` per audio PID consumes the reassembled PES payload byte stream **once** (streaming,
single-pass, O(n)) and emits **exactly one raw AAC access unit per ADTS frame**:

- **buffers across PES boundaries** — a partial frame (or partial header) is carried in `#pending` and
  resumed on the next PES payload (`concatPending`);
- **resyncs** by hunting for the next byte pair that could open a real header (`0xFFF` syncword + layer
  `00`), then *validating* it (`parseAdtsHeaderAt`: syncword, layer, non-reserved
  `sampling_frequency_index`, `frame_length > header_length`) so payload bytes that merely contain `0xFFF`
  do not fake a frame;
- **strips the header** — 7 bytes, or 9 when `protection_absent == 0` (CRC present); the CRC is discarded,
  never validated (decode robustness is the decoder's job);
- **derives the AudioSpecificConfig** (`objectType`, `samplingFrequencyIndex`, `channelConfiguration`)
  from the first valid ADTS header → the WebCodecs `description` / MP4 `esds`;
- **times each frame** on the exact 90 kHz rational (see below), monotonic;
- **drops** frames that precede the first PTS anchor and a trailing partial frame at EOF — matching what
  ffmpeg emits, so our access-unit count equals `ffprobe -count_packets nb_read_packets`.

The invariant the muxer needs: **no emitted unit is ADTS-framed** — none opens with a valid `0xFFF`
header whose self-described `aac_frame_length` equals the unit length. Every test asserts this
(`looksAdtsFramed(u.data) === false`), which is exactly the muxer's `parseAdtsAccessUnit` mix-detector.

## Timing: anchor once, then pure 1024-sample cadence, discontinuity-gated rebase

ISO/IEC 13818-1 §2.4.3.7: a PES PTS names the first access unit that **commences** in that PES payload.
The de-framer arms a PTS anchor per PES-with-PTS (at the payload's first byte, i.e. after any pending
tail) and, at each commencing frame, applies it via `#rebase`:

- **first anchor ever** → starts the cadence chain (base = the PES PTS, `chainSamples = 0`);
- **subsequent frames** advance `samples × 90000 / sampleRate` from the base on the exact rational
  (no per-frame rounding accumulation); a PES **without** a PTS simply continues the chain;
- **a later PES PTS** only rebases the chain on a **genuine discontinuity** — a jump farther from the
  cadence-predicted value than `REBASE_DISCONTINUITY_TICKS` (½ s at 90 kHz). Otherwise the monotonic
  cadence is kept.

### Why gated, not per-PES (the "bear frame-12 wobble")

`bear-1280x720.ts`'s audio has 10 PES, each starting on a frame boundary; **frame 12 is the first frame
of PES 1** (PTS 148988). But bear carries a priming/encoder-delay frame: ffmpeg folds it onto frame 0's
PTS slot (its frame 1 *steps back* to 125999), so every PES PTS after the first sits **exactly one AAC
frame (≈2090 ticks) behind** a clean cadence. Re-anchoring on each PES (the naive design) makes frame 12
adopt 148988 while frame 11 already reached ≈148988 by cadence → a ≈0 (even negative) delta: the wobble,
non-monotonic and outside the 1024-sample cadence.

The gate (threshold ≫ 1 frame, ≪ any real reset) treats bear's ±1-frame PES wobble as *not* a
discontinuity, keeping a strictly monotonic cadence. Consequence, by design: our last frame lands one
frame later than ffprobe's raw last packet PTS (372596 vs 370506 ticks) — but the materialized
**duration** still matches ffprobe within one frame, and the PTS list is exact-cadence monotonic. A real
splice / loop / 2^33-adjacent reset (Δ ≫ ½ s) *does* rebase.

## Oracles (ffmpeg / ffprobe ground truth)

Validated in [`ts-aac-deframe.test.ts`](../../src/drivers/mpegts/ts-aac-deframe.test.ts) against four
structurally distinct **real** transport streams (anti-overfit): multi-frame-per-PES 44.1 kHz stereo;
every-frame-crossing 48 kHz with PTS-less PES; ≥30 s 22.05 kHz mono; real H.264+AAC bear.

| Oracle | Source | Assertion |
| --- | --- | --- |
| byte-exact frames | `ffmpeg -i f -c:a copy -f adts` (committed twin) | our raw AU == twin frame (header stripped), 1:1, every frame |
| packet count | `ffprobe -count_packets nb_read_packets` | `units.length` equals it (== the twin's own count) |
| materialized duration | `ffprobe format=duration` of the lossless `-c copy` MP4 remux | within one AAC frame |
| timing | ffprobe first packet pts + cadence | first frame == anchor; 48 kHz whole list exact (1920 ticks); monotonic 1024-cadence |
| raw-framing invariant | MP4 muxer mix-detector shape | no unit is ADTS-framed |

Synthetic ADTS (built in-test) drives `AdtsDeframer` directly for the branches the corpus cannot
deterministically exercise: 9-byte CRC header, resync past garbage, false-`0xFFF` rejection, frame/header
split across a push boundary, PTS-less continuation, discontinuity rebase vs within-tolerance no-rebase,
pre-anchor drop, trailing-partial drop.

Benchmark: [`scripts/bench-mpegts-demux.ts`](../../scripts/bench-mpegts-demux.ts) — the de-framer stays a
streaming single-pass scan (≈540 MB/s on the 30 s fixture); guards against any O(n²)/per-frame-copy
regression.
