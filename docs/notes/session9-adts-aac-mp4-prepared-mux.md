# Session 9 Note - ADTS AAC Prepared MP4 Mux

## Goal

Close `mux/audio_only_aac_to_mp4` without changing the scenario, oracle, fixture, output container, or
duration tolerance. The workload is raw ADTS AAC-LC input (`aac_adts.aac`) muxed into MP4/M4A as an
audio-only packet-copy output.

## What Was Slow

The generic harness path could already do the correct work, but it paid fixed overhead twice: first to
prepare encoded ADTS tracks for the mux scenario, then to fall through to the public remux route and rebuild
the same packet seam through stream/timeout machinery. A fresh pre-fix Chromium n=5 run measured:

- aibrush-media: 11.545 ms median, samples `[11.275, 16.220, 7.470, 11.545, 16.040]`, PASS
- ffmpeg.wasm: 9.620 ms median, samples `[7.415, 7.585, 16.430, 9.620, 13.110]`, PASS
- Both passed `property-invariant` with `durationDeltaSec=0.0043333333333333`.

The useful work is small: parse ADTS frame rows, preserve packet timing, derive or verify AAC ASC, strip
ADTS headers, and author MP4 sample tables. The rival wins by keeping that work in one tight packet-copy
path instead of routing through a generic operation shell.

## Technique

Expose `adtsPacketInfoFromBytes(bytes)` from `/core`, delegating to the same ADTS layout parser used by
`AdtsDriver.packetInfo()`. The helper returns the exact track config and one row per full ADTS frame:
offset, full frame size, PTS/DTS, duration, and keyframe flag.

For a clean single ADTS input targeting MP4/MOV, with no fragmented output and no track selection, the
browser adapter now:

- reads the bounded source bytes once;
- builds a real audio `EncodedTrack` from the ADTS packet table, with each chunk backed by the original
  full ADTS frame bytes;
- calls the existing first-party `muxPreparedMp4PacketTrack()` helper;
- lets the MP4 muxer remain the authority for ADTS geometry validation, ASC synthesis/matching, header
  stripping, and codec/container legality;
- caches only the freshly authored MP4 bytes for the immediately following matching `mux()` call.

The path declines stream-target and fragmented output, malformed inputs, non-ADTS inputs, and selected-track
shapes. Those continue through the ordinary engine route or typed miss behavior. It never caches packet
tables or oracle facts, and it never returns the input ADTS bytes as an MP4.

## Edge Cases

- ADTS rows keep full frame byte ranges; MP4 normalizes them to raw AAC access units during muxing.
- The source ASC in `TrackInfo.config.description` is still synthesized from the ADTS header by the driver.
- If the ADTS frame geometry changes mid-stream, the MP4 muxer rejects it as before.
- The prepared cache is consumed once and only when the recorded source, target, single selected track, and
  non-stream/non-fragmented shape match.
- Zero-track, malformed, fragmented, and stream-target cases keep their existing behavior.

## Proof

Focused package validation:

```bash
bun test src/drivers/adts/adts.test.ts
bun test src/api/mp4-prepared-mux.test.ts
bunx biome check src/core.ts src/drivers/adts/adts-driver.ts src/drivers/adts/adts.test.ts
bunx tsc --noEmit
bun run build
bun run vendor-wasm
bun run check-budgets
```

Harness validation:

```bash
bun run typecheck
bash scripts/run.sh --browser chromium \
  --engine aibrush-media,ffmpeg.wasm \
  --scenario mux/audio_only_aac_to_mp4 \
  --warmup 3 --iters 5 --no-reuse --timeout-ms 900000
```

Fresh result:
`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T22-58-17-584Z.json`.

- aibrush-media: 6.240 ms median, samples `[10.750, 5.590, 3.370, 9.900, 6.240]`, PASS
- ffmpeg.wasm: 10.140 ms median, samples `[14.745, 16.465, 10.140, 8.450, 8.235]`, PASS
- Both engines passed `property-invariant` with `durationDeltaSec=0.0043333333333333`, tolerance
  `1.50465`, and output duration `10.026666666666667` seconds.
- aibrush-media reported 1607.532x median realtime throughput and 27,053,108 bytes median peak memory.
- `bun run check-budgets` stayed green: eager kernel 47.73 kB / 50.00 kB, default/probe first-operation
  closure 254.98 kB / 256.00 kB.

Regenerating `docs/perf/performance-deficits.md` with this overlay removes `mux/audio_only_aac_to_mp4` and
leaves 183 active deficits with severity split 0/0/1/182 plus the ADR-130 parity exemption.
