# Decrypted fragmented MP4 timeline normalization

## Goal and evidence

Rotated `cbcs` and `cens` inputs decrypt to valid, playable H.264, but Chromium reimport begins three frames
late. Bento4/ffprobe show the same content/timing shape in both schemes: the fragmented encrypted file has
signed version-1 `trun` composition offsets and no `edts`; its independently derived clear original has
the equivalent non-negative `ctts` values plus a single-rate edit-list preroll. For example, encrypted
offsets `0, 3003, 0, -2002, -1001, ...` correspond to clear offsets
`3003, 6006, 3003, 1001, 2002, ...` with `elst.media_time = 3003`. The cipher output is therefore correct;
preserving the signed fragmented representation is what loses the decoder preroll at reimport.

## Design

After whole-file CENC decryption of a fragmented movie, rebuild its clear tracks from `moof`/`traf`/`trun`
sample tables and serialize a progressive MP4. For a video track with negative composition offsets, choose
`shift = -min(cttsTicks)`, add `shift` to every sample's CTO, and emit an edit with
`mediaTimeTicks = shift`. This is algebraically exact for every sample:
`DTS + (CTO + shift) - shift = DTS + CTO`. It neither assumes constant frame rate nor changes decode order,
duration, keyframe flags, coded bytes, B-frame presentation order, or audio timing. Tracks with no negative
CTO remain byte-timing-equivalent and receive no invented edit. Progressive CENC and the throughput common
path remain unchanged.

The rematerialization is intentionally bounded to the already-buffered fragmented decrypt branch. Sample
payloads are read through the existing coalesced-window planner; malformed/truncated ranges retain typed
errors; cancellation remains owned by the outer operation; no `VideoFrame`/`AudioData` objects are created.
The tradeoff is one progressive output allocation after the clear in-place copy, acceptable for correctness
first and measured later against the encryption wall/peak-memory cell.

## Validation

The unit invariant covers negative B-frame CTOs and VFR durations and proves every presentation timestamp is
identical before/after normalization, the new CTOs are non-negative, the edit exactly compensates the shift,
and audio/non-negative video tracks are untouched. Existing fragment parsing tests remain the structural
oracle; CENC/CENS/CBCS byte-exact crypto suites prove payloads do not change; full rotated Chromium
`encryption` is the real decoder/golden gate. A fresh multi-sample benchmark follows after the functional
board is zero.
