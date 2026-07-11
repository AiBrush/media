# Session 12 public truth-boundary repairs

## Goal

Supersede stale exact-slot reds without changing correct product bytes or weakening an oracle. The repair
surface is limited to public corpus metadata and independently baked goldens whose current values contradict
the exact source bytes. Product behavior remains unchanged unless ffmpeg/ffprobe, decoded PCM, and container
packet truth disagree with aibrush.

## Approach

For the rotated `02.aac` ADTS file used by both remux scenarios, count every validated ADTS frame and derive
duration from the codec clock: `861 * 1024 / 44100 = 19.992380952...` seconds. The existing 17.135660-second
value is ffprobe's raw-VBR bitrate estimate and contradicts both the packet vector (861 frames, last PTS
19.969161 seconds) and an independent ffmpeg decode (880,640 stereo sample frames, about 19.97 seconds after
decoder priming/trailing treatment). A hash-guarded maintenance script updates all eleven catalog rows that
reference those exact bytes and their exact scenario metadata goldens. A different file hash, packet count,
rate, or existing metadata value is a hard failure.

The massive-MP4 and s24 rows remain separately classified public boundaries. The MP4 driver's payload-free
table matches the freshly ffprobe-baked 553,501-packet golden exactly by `(track, PTS, DTS, size)`, while the
public invocation reports the same count/timestamps but loses 214,646 sizes. For s24, aibrush's complete
interleaved f32 output SHA-256 is byte-identical to ffmpeg (`7eafe0fe...`), and its first stereo-frame digest
is exactly `2c3498ed...`; the public oracle expects unrelated `c660ee15...` bytes after a public re-bake and a
fresh browser profile. Neither product path may be distorted to match those stripped/stale public facts.

## Edge cases and failure modes

- ADTS CRC/no-CRC frames, VBR payload sizes, ID3 prefixes, truncated tails, and HE-AAC rate semantics must not
  be inferred from file size or bitrate.
- A source hash mismatch, non-861 packet vector, non-44.1 kHz metadata, or an already-unexpected duration
  raises an ordinary script error before any write.
- Writes are atomic and preserve every unrelated catalog line and golden field.
- No scenario id, fixture filename, or product runtime branch is added; this is a corpus maintenance repair.

Rejected alternatives: retaining the bitrate estimate; padding/truncating AAC; changing packet timestamps;
removing the valid rotated file; weakening duration tolerance; changing PCM bytes to match a stale digest;
or dropping packet sizes from the strict MP4 oracle.

## Test and evidence plan

Run the repair script, re-read every metadata file, then execute affected exact public ADTS scenarios until
`02.aac` is selected. The output must preserve one AAC track and reimport at the packet-derived duration.
Regenerate the deficit report afterward. Keep the direct ffmpeg PCM hash and massive packet-table comparison
as independent can-fail evidence for the still-open invocation boundaries.

## Completed public sweep

The fresh headed, no-reuse Chromium export
`chromium-2026-07-11T14-11-41-575Z.json` completed all 563 selected cells: 498 PASS, 63 honest N/A, one FAIL,
and one ERROR. The two active reds in that export are the already-proven Chromium HEVC `<video>` decode
boundary and detached HLS AES-128 invocation boundary. The gapless slot was `NA_ASSET` for the deliberately
removed obsolete baked `gapless_aac.m4a` trial path; it is not counted as a pass. The latest exact real
`05.mp4` rotation remains the public operation-window failure documented in ADR-215.

After a public all-scenario metadata/packet bake (1,301 exact metadata and 1,301 packet goldens across 436
scenarios), a second full headed Chromium export
`chromium-2026-07-11T14-55-47-618Z.json` completed 563/563 with 499 PASS, 61 N/A, two FAIL, and one ERROR. The
generic ffprobe bake temporarily restored the disproved ADTS estimate in a third scenario; expanding the
exact-hash repair to all eleven catalog references and naturally selecting `02.aac@052f9c…` produced a fresh
PASS. The strict aggregate is therefore back to nine historical/current reds, zero non-exempt
coverage-parity gaps, 171 missing correctness rotations, 480 missing same-export timed rotations, and
missing rival comparison evidence. Speed and leaderboard work remains gated. The nine reds are the four
historical/current gapless operation-window rows, independently disproved s24 golden, stripped Matroska
attachment projection, Chromium HEVC platform decode, stripped massive packet sizes, and detached HLS
context. None admits an honest product-byte workaround.

## Conversion reachability correction

The same completed export's 57 `NA_ASSET` rows were audited through public catalog output. Fifty-one
conversion-family rows demanded an output codec as an input capability and therefore rejected every exact
source before invoking aibrush. A hash-guarded, conversion-only catalog repair removed only requirements
absent from every candidate input after validating 54 unique exact-source hashes. This changes reachability,
not product bytes or pass evidence. The export had only two actual `NA_ENGINE` declarations: HEVC Main10 and
two-pass bitrate. See ADR-221 and `session12-catalog-input-requirements.md`.

## Focused post-refresh evidence

After rebuilding and vendoring the current working tree, a four-scenario headed Chromium run
(`chromium-2026-07-11T17-07-33-807Z.json`) produced one PASS (`mux/audio_only_aac_to_mp4`), one ERROR
(`probe/hls_aes128`), and two FAILs: the known 48,128-vs-disputed-50,784-sample public gapless window and the
known zero-intrinsic-size Chromium HEVC-in-MKV decode boundary. The reversible manifest URI experiment was
then applied only to the shared and probe-local HLS manifests, rerun for `probe/hls_aes128`, and restored
both original hashes (`914920…` and `ba0bec…`); the error was unchanged, proving the failure is the public
ciphertext invocation rather than relative URI resolution.

The same four scenarios were run in WebKit and Firefox. WebKit passed the repaired AAC duration row, honestly
reported the missing removed gapless fixture as `NA_ASSET`, classified HEVC strict-golden comparability as
`NA_BROWSER`, and retained the HLS invocation error. Firefox passed AAC duration, retained the HLS error,
reported the HEVC browser capability as `NA_ENGINE`, and reproduced the gapless operation-window deficit at
49,152 decoded samples. No product byte, oracle, or tolerance was changed for these boundaries.

## Focused Main10 and two-pass proof

The standalone public-API proof `bun run proof-session12-video` was run against the current Chromium build on
2026-07-11 using the exact `transcode/h264_two_pass_bitrate/01.mp4` fixture. It does not read or modify the
harness adapter and does not invoke the broad rotation. The requested HEVC Main10 target was built exactly as
`hev1.2.4.L120.B0`, then correctly classified `NA_BROWSER` with typed `capability-miss` because Chromium had no
codec driver for that encoder configuration. This is a physical browser boundary, not a downconversion or a
pass claim.

The same proof completed the real H.264 two-pass path: the latest five fresh samples had a 2,802.3 ms median, all five
outputs shared SHA-256 `e768d3f03ff37f9fa3310bc76272098cd7ba4e33e9f559bd60b7ba5e1623814d`, and the output facts
were `avc1.64001F`, 1280×720, 12.84 s, 321 packets, and 810,678 video-payload bytes. Cancellation returned
`aborted`. The focused proof therefore closes product/runtime validation for two-pass; the harness’s public
feature declaration is still a separate required action, and the Main10 row remains browser-unsupported in
this Chromium environment.

A bounded public harness run on the same date, limited to
`transcode/h264_8bit_to_hevc_10bit` and `transcode/h264_two_pass_bitrate` with Chromium, one iteration, and
reuse disabled (`chromium-2026-07-11T17-39-27-944Z.json`), selected neither asset. It returned
`NA_ENGINE` before execution with the exact reasons `engine does not declare feature 'depth:10bit-output'`
and `engine does not declare feature 'two-pass'`. The product repository exposes no separate public feature
catalog for this declaration; the remaining action is therefore the allowed external declaration seam, not a
new codec implementation.

## Focused MP3 encode capability evidence

The two exact MP3 encode rows were rerun together in Chromium with no reuse on 2026-07-11
(`chromium-2026-07-11T17-30-17-570Z.json`). Both `transcode/aac_to_mp3_mp4` and
`transcode/wav_to_mp3_mp4` returned `NA_BROWSER` before asset selection because
`AudioEncoder.isConfigSupported=false` for `mp3`. No encoder tail, license, output, or fallback claim was
invented; ADR-105 remains the governing explicit-license boundary.

## Focused Matroska attachment rotation evidence

The retained `metadata/write_mkv_tags` slot was reached on the second focused Chromium rotation
(`chromium-2026-07-11T17-28-52-863Z.json`) with exact `03.mkv` SHA-256
`15ac6672aed3905b6fff8dd3ca12c463d03a57f174dc8ca5a75229ef92a22b26`. The public result failed the strict
reference reimport because the reimport had one video plus one audio media track while the golden expected
two video plus one audio media tracks; the exported measurements were reimport `2` versus golden `3`.
The property oracle also reported frame-bake evidence missing. This reproduces the known public side-data
projection boundary; product attachment preservation remains independently covered, and no attachment or
track was synthesized in the product.

## Focused s24 rotation evidence

The exact retained s24 row was rerun alone in Chromium with `warmup=1`, `n=5`, and no reuse
(`chromium-2026-07-11T17-27-47-772Z.json`). Rotation selected `01.wav` with SHA-256
`3cb89a79d3164ea340ce20150b7ce1fe1719b1e908f379b5a56e9db657e9c085`; the strict `decoded-audio-pcm`
oracle compared 4,096/4,096 frames and found 4,096 mismatches. A separate focused rotation selected the
real `02.wav` candidate and passed 4,096/4,096 frames, but that different rotation cannot supersede the
historical `01.wav` slot. No product PCM path, golden, or oracle was changed.

The documented public bake path was then run only for `audio-dsp/throughput_decode_s24` with packet and frame
options. It exited successfully but wrote no replacement audio golden; the public headed Chromium
`frame-bake` path likewise reported `audio-only/absent` because there is no `.frames.json` target for this
asset. This confirms that the remaining s24 repair needs the suite's decoded-audio PCM evidence route, not
RGBA frame-bake data or a product-side byte change.

A fresh public rotation then selected real `03.wav` (`chromium-2026-07-11T17-47-01-583Z.json`) and passed the
same strict oracle with five timing samples: median `113,399.78` fps, median wall `36.12` ms, and three
peak-memory samples. A second focused run selected the baked `wav_s24.wav` control and passed. The next run
selected the retained real `01.wav` hash
`3cb89a79d3164ea340ce20150b7ce1fe1719b1e908f379b5a56e9db657e9c085`
(`chromium-2026-07-11T17-47-42-602Z.json`) and reproduced `4,096/4,096` decoded-audio mismatches with the
same first-frame digest divergence. The cross-rotation result isolates the red to the `01.wav` golden, not
the aibrush PCM decoder or the scenario operation.

A focused all-engine Chromium run of the same scenario
(`chromium-2026-07-11T17-55-45-690Z.json`, warmup `1`, `n=5`, no reuse) selected the identical real `03.wav`
for all executable engines. aibrush and Mediabunny both passed the strict 4,096-frame oracle; four engines
were honest `NA_ENGINE`, and FFmpeg reported an infrastructure error loading its vendored module before any
oracle ran. This is valid same-export contested evidence for the passing `03.wav` rotation, but it cannot
supersede the retained `01.wav` red.

The product-side fix for the observed startup loss is now implemented as the additive
`decodePcmAudioStream` contract (ADR-226). WAV range-capable sources read one bounded 64 KiB prefix (clamped
to known source size) so the header and first PCM chunk share one range round trip, and emit
bounded 4,096-frame canonical chunks; non-range sources retain the full-buffer fallback. Focused tests
cover exact s24 values, cancellation, contiguous frame ownership, and timestamp continuity. The fresh
real-`03.wav` benchmark (`bun run bench-session12-wav-pcm-stream`, 2 warmups plus 7 samples) records a
0.135 ms median first chunk after 65,536 returned bytes, a 12.497 ms median complete drain of all
1,315,328 frames with checksum `3860784884`, and a 9.286 ms legacy full-buffer median with checksum
`2936041591`. The post-direct-path focused export selected passing `03.wav` and measured aibrush
`58.590 ms` versus Mediabunny `19.200 ms`; the subsequent export taken during the rejected 4 KiB experiment
selected retained `01.wav` and reproduced the shared stale golden with no timing metrics. An isolated
product-only Chromium probe then found that generic image sniffing added a second `[0,4096)` URL range
before the WAV `[0,65536)` range; ADR-227 removes that redundant read for known media extensions while
keeping unknown/image sniffing intact. Raw-PCM engine egress now also uses interleaved `f32` AudioData
to match the public sample-digest consumer, while the canonical DSP representation remains planar
Float64. The final focused export (`chromium-2026-07-11T18-29-37-500Z.json`) selected `01.wav` for both
PASS-capable engines and reproduced the shared stale golden with no timing metrics; the qualified `03.wav`
wall loss remains active in the deficit artifact.

## Focused gapless full-source proof

The strict standalone proof `bun run proof-session12-gapless` intentionally exits nonzero against the current
50,784-sample expectation, after printing the public facts. On the exact CC0 `05.mp4`, `createMedia().decode()`
emits 49 frames / 50,176 samples at 48 kHz stereo; public demux exposes 50 AAC packets and the final packet
has a 12,188 µs duration. Independent FFmpeg/ffprobe output also measures 50,176 samples. The harness's
48,128-sample result is therefore an additional one-second operation-window cutoff, not evidence that the
product should synthesize the missing samples. The strict oracle and public operation contract remain open
for reconciliation; no AAC bytes, timestamps, padding, or tolerances were changed.

## Focused HLS public-URL proof

The standalone proof `bun run proof-session12-hls` was run on 2026-07-11 against the exact scenario manifest
`probe/hls_aes128/hls_aes128.m3u8` through the public `createMedia().probe()` API in headed Chromium. With
the manifest's real URL preserved, the product fetched the real key and five encrypted TS segments, decrypted
and stitched them, and reported `ts`, H.264 video, AAC audio, and 10.0266666667 seconds. The same proof also
passed a detached Blob whose manifest carried explicit same-origin key/segment paths, with identical tracks
and duration. The current harness row still reports `ERROR` with the raw MPEG-TS sync failure, including
after the reversible root-relative URI experiment, so the remaining red is the harness's detached source
construction/base-URL invocation seam rather than an unimplemented HLS resolver. No key, IV, fixture branch,
or oracle was guessed or changed.

The focused local HLS benchmark (`bun run bench-session12-hls`) independently ran the same real five-segment
manifest with warmup `2` and `n=5`: median resolve/decrypt/stitch time was `3.861` ms, output was
`4,598,668` bytes, and every sample shared SHA-256
`27d7492ec2c83746c673f284b151b4dfdbd05c1ddc2b6a6e5c0ce8711615db48` with an MPEG-TS sync byte.
