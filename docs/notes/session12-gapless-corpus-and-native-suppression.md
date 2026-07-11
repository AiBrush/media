# Session 12 gapless corpus and native suppression design

## Goal

Close the AAC gapless path with evidence that separates product correctness from
fixture and invocation correctness. The public gapless scenario must contain
eligible, redistributable recordings; product validation must independently cover
declared MP4 edit-list priming/padding, malformed declarations, ordinary AAC, and
the browser lifecycle contract.

## Design note

The public scenario now uses five exact, byte-preserved CC0 recordings: four
from BigSoundBank and one from LaSonotheque. Their source pages, direct
downloads, licenses, hashes, sizes, and independent AAC metadata are recorded in
the public catalog. The old generated Mozilla tones, stale manifest hash, fixed
fallback control, and its baked artifacts are removed from the public scenario.
Native gapless behavior is validated separately with five exact
Internet Archive AAC/MP4 files retained under `native-gapless-aac/`; those files
are real edit-list/priming vectors and are not substituted into the public
ordinary-recording slots.

The decoder path remains bounded: at most the declared priming prefix is
preflighted, the probe stream uses zero readable queueing, cancellation releases
its reader, and every decoded `AudioData`/`VideoFrame` is closed exactly once.
Unsupported, malformed, or decoder-error preflight is conservative and leaves
the normal explicit trim in charge; abort propagates as typed cancellation.
B-frames, negative DTS, fragmented/ordinary MP4, mono/stereo, 44.1/48 kHz,
terminal padding, no edit, and malformed edit lists are covered by the matrix.

## Selected public real corpus

All five files are ordinary AAC-LC, 48 kHz, mono/stereo MP4/M4A recordings with
no native `edts`/`elst`/`sgpd`/`sbgp` gapless declaration. Durations and hashes
were measured independently before copying; the maintenance script only copies
and hash-checks bytes.

| Slot | Source page | License | SHA-256 | Size | Duration |
| --- | --- | --- | --- | ---: | ---: |
| `01.mp4` | [bullet case on concrete 1](https://bigsoundbank.com/bullet-case-5-56mm-on-concrete-1-s1361.html) | CC0 1.0 | `3c6936eec59ffee8766b1622793ba64473cd77b24b652820505ebf30b121768c` | 18,953 | 1.013563 s |
| `02.mp4` | [bullet case on concrete 6](https://bigsoundbank.com/bullet-case-5-56mm-on-concrete-6-s1366.html) | CC0 1.0 | `4145104b80829af7a8229bd5ec98b6632eb344775cae5f890eb8543e5e00f900` | 16,736 | 1.017563 s |
| `03.mp4` | [tone matching search 1](https://bigsoundbank.com/tone-matching-search-1-s1612.html) | CC0 1.0 | `358885ab169536e6a4607d59c19a97c0bd6f48bb321e86ae301ffb0afe70c246` | 11,680 | 1.020979 s |
| `04.mp4` | [tone matching search 2](https://bigsoundbank.com/tone-matching-search-2-s1613.html) | CC0 1.0 | `61a6d3056d69de61b243780169c552580d8f20a255c3f4ecb461007936acb7a9` | 11,441 | 1.020979 s |
| `05.mp4` | [Whoosh 4](https://lasonotheque.org/whoosh-4-s1796.html) | CC0 1.0 | `c35fe072c25bc60c52d923a3ce20bae1e252e233a019004cc1dc276d6aff7c10` | 33,681 | 1.057521 s |

## Preserved native gapless validation corpus

The five exact Internet Archive files remain under
`../media-test/fixtures/media/native-gapless-aac/`. They are AAC-LC stereo at
44.1 kHz and independently exhibit negative first DTS plus MP4 edit-list and
sample-group priming/padding declarations. Their hashes are pinned by
`scripts/session12-gapless-corpus.mjs`; they exercise native suppression in the
Node MP4 matrix without manufacturing bytes, remuxing, transcoding, or using a
trial tone.

## Failure boundaries

Raw HLS ciphertext without its manifest/key/IV resolver is an invocation/input
boundary, not a media transform failure. Valid HEVC-in-MKV whose Chromium
intrinsic dimensions remain zero is a browser-platform boundary. Matroska
attachment side data stripped before the public call is an invocation boundary.
These rows must be classified or replaced at the public corpus/invocation layer;
the product must not spoof metadata or weaken an oracle to turn them green.

As a reversible audit, `scripts/session12-hls-invocation.mjs` temporarily made
the shared HLS manifest and probe-local duplicate self-resolving with
root-relative key/segment URIs, then restored both original hashes
(`914920…` and `ba0bec…`). The public server returned the manifest (474 B), key
(16 B), and all five encrypted segments (200 responses), while a direct
`fromURL()` aibrush probe returned `ts`, H.264/AAC tracks, and 10.026667 s.
The fresh detached public invocation still emitted
`not an MPEG-TS stream (no transport sync run found — encrypted, scrambled, or not a transport stream)`
in `chromium-2026-07-11T13-26-10-276Z.json`. This closes the diagnosis: the
public call is not passing a usable manifest-backed source to the product; no
product-side key/path inference is legitimate.

Fresh metadata rotations independently pass: `chromium-2026-07-11T13-05-28-005Z.json`
selected the baked control, `13-05-50-451Z.json` selected `02.mkv`, and
`13-06-19-121Z.json` selected `01.mkv`; all three report 12/12 bit-exact frame
digests and zero mismatches.

## Public evidence (development, not close-out)

The public five-slot bake writes five fresh packet/meta artifacts. The fresh
Chromium export
`../media-test/results/raw/chromium-2026-07-11T13-01-24-785Z.json` uses the
exact `05.mp4` rotation as the public plan input. The shorter four controls are
dropped with the emitted reason
`input-shape/duration mismatch: duration ... too short for op time target 1.013s`.
The exact real `05.mp4` is selected, but the public operation emits only `48,128`
samples (`1.002667` s) against the disputed committed expectation of
`50,784` samples (`1.058` s), a `2,656`-sample deficit. Independent full-source
truth for this file is `50,176` samples, so this is the public
operation-window boundary, not a synthetic corpus or product demux defect.

The focused standalone browser proof `bun run proof-session12-gapless` then consumed the same exact `05.mp4`
through the public `createMedia().decode()` stream without the harness operation window. It observed all 50
public demux packets but Chromium emitted 49 AAC frames / `50,176` samples; the final packet is a real
`12,188` µs partial-duration packet. Independent `ffprobe` frame facts and FFmpeg PCM output agree at
`50,176` samples. The committed `50,784` expectation is therefore disputed and not supported by this file's coded
timeline, while the harness's `48,128` result is still a separate operation-window cutoff. No product-side
padding, truncation, timestamp invention, or oracle weakening is legitimate; the exact corpus/golden and
public-operation contract must be reconciled before this row can close.

A separate exact real 1.014458-second CC0 candidate was also dropped by public
selection, confirming that the boundary is not limited to the former BigSoundBank
slots.

The prior fresh run
`../media-test/results/raw/chromium-2026-07-11T11-16-06-165Z.json` selected a
native real recording and failed honestly: it decoded `49,040` samples against
the full `18,432,000`-sample expectation and reported about `1.021667` seconds
against a `384`-second golden. This establishes the separate public operation
window boundary; padding, truncation, and invented metadata are not acceptable
fixes.

The HDR10 routing correction is independently recorded in ADR-214 and passed
its real baked Chromium control in
`../media-test/results/raw/chromium-2026-07-11T11-06-29-495Z.json`.

The required fresh local benchmark (`bun run bench-session12-gapless`) covered
all 11 exact files (five native, five public rotations, and the separately
retained global ordinary control), with warmup `2` and seven measured samples.
Setup median was `18.826` ms; complete packet-drain median was `27.779` ms; the
stable packet count was `88,497` and both operations used checksum sinks.

## Evidence plan

1. Keep the exact corpus and native matrix hash-checked and independently
   validated.
2. Resolve the public selection/operation contract so an eligible real control
   can be selected and a long native recording can be consumed completely.
3. Re-bake only through the public baker, run every rotation in every engine
   with fresh cache, warmup, and multi-sample evidence, then require
   `comparisonEvidenceMissing: false`, complete real coverage, and zero wall or
   peak-memory losses.
4. Run the repository gate and retain the benchmark/ADR/export evidence with
   the close-out report.
