# Session 13 — copy-free default-Blob MP4 metadata rewrite

## Design note (written before implementation)

**Goal.** For a direct `Blob`/`File` input, default Blob output, same MP4/MOV brand, and tag-only request,
produce bytes exactly equal to ADR-274 without reading or copying `mdat`: read the complete top-level box
headers plus `ftyp` brand and `moov`, validate the ordinary topology and every declared sample against its
declared `mdat`, patch the owned `moov`, then return a fresh MIME-correct Blob composed from immutable input
slices and the patched `moov`. **Approach.** Reuse the existing MP4 driver's ADR-251 demux validation over
the range-backed Blob and refactor the ADR-274 classifier/writer to accept a complete top-level layout plus
owned `ftyp`/`moov` bytes. The Blob constructor snapshots immutable Blob parts without materializing them,
so payload memory and wall scale with metadata rather than media size. This route is preferable to a
general composite-output abstraction because only the default Blob sink can preserve opaque immutable
source slices; explicit stream/file/OPFS/element targets retain their existing materialization contracts.
**Rejected alternatives.** Trusting chunk offsets without full `stsz`/`stsc` sample extents, reading all
bytes and wrapping the copied array in a Blob, returning the input unchanged, or applying the route to
cross-brand, fragmented/indexed, CENC auxiliary/item-offset, UUID, mixed pre/post-`moov`, one-shot, URL, or
explicit-sink shapes would weaken correctness or change public behavior. **Edge cases and failure modes.**
The scanner handles 32-bit, 64-bit, and to-EOF top-level sizes with exact safe-integer bounds; duplicate or
missing `ftyp`/`moov`, absent `mdat`, malformed/truncated headers, forbidden boxes, external offsets, and
mixed media placement decline to the existing replay path. A qualifying topology whose complete sample
escapes `mdat` raises the same typed demux error. Abort is checked before and after every finite Blob read,
before validation, before Blob composition, and after output; progress remains the existing two-phase
monotonic contract. There are no frames or decoders; B-frame/VFR clocks and close-exactly-once ownership are
unchanged. **Test/benchmark plan.** A fail-first tracked-Blob test proves no full-source read and exact output
bytes versus the current byte route. Five-plus real ordinary MP4s cover faststart/tail-`moov`, AVC, AV1,
HEVC/HDR, B-frame/VFR, audio, and size diversity; strict declines cover fragmented, wrong-brand, malformed,
unsafe-offset, explicit-sink, URL/one-shot, and abort paths. The warmup-three/`n=21` public Blob benchmark
records exact SHA/sample truth plus positive peak memory against the retained whole-byte route.

## Product evidence

The final ten-source corpus includes all three current public rotations plus seven independent real MP4s.
With `warmup=3`, `n=21`, Blob-direct measures 1.860 ms median/MAD 0.348, byte-direct 3.917/0.374,
and full-remux control 8.108/0.375. Sequential positive peak RSS deltas are 0.41, 4.53, and 0.55 MiB;
unsigned checksum 2,249,792,799 covers every fresh output. Exact oracles run outside timing and prove Blob-direct
bytes equal byte-direct bytes before rechecking tag, container, track, sample, and clock truth. Qualified
same-export browser wall/memory remains the closing evidence.

The exact rotated `02.mp4` (5,339,207 bytes) does not decline. Its isolated warm `n=21` medians are 0.232 ms
for topology plus patched `moov`, 0.311 ms for the complete public Blob remux including ADR-251 validation,
0.141 ms for final Blob readback, and 1.077 ms for the retained byte route. The qualified 28.380 ms browser
median versus mediabunny 21.890 is inside the combined 8.825 ms MAD and is not attributable to avoidable
product parsing, payload materialization, or output readback; no speculative product change is justified.

A second isolated-process attribution pass on the current source repeats each warm stage 21 times (101 for
the sub-0.1 ms prepared-`moov` kernels) across every public selection. These stages are intentionally
reported independently and are not additive: the public path reuses range-cache state between routing,
topology proof, and ADR-251 validation, while the isolated planner and validation controls each begin with a
fresh Blob. `readback` is full output `Blob.arrayBuffer()`, `reprobe` is a fresh public MP4 probe of the
already-produced Blob, and `GC` is the median of seven forced terminal collections after the timed loops.

| selection | source / `moov` bytes | core qualify | tag author delta | range planner | ADR-251 validation | public remux | readback | reprobe | terminal GC |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `01.mp4` | 3,666,807 / 8,058 | 0.008 ms | 0.034 ms | 0.454 ms | 0.250 ms | 0.537 ms | 0.255 ms | 0.030 ms | 0.620 ms |
| `02.mp4` | 5,339,207 / 14,639 | 0.009 ms | 0.034 ms | 0.499 ms | 0.211 ms | 0.494 ms | 0.291 ms | 0.025 ms | 0.451 ms |
| `03.mp4` | 7,724,749 / 11,305 | 0.008 ms | 0.038 ms | 0.718 ms | 0.267 ms | 0.581 ms | 0.414 ms | 0.027 ms | 0.464 ms |
| baked H.264 | 31,258,790 / 27,273 | 0.035 ms | 0.054 ms | 2.170 ms | 0.931 ms | 2.156 ms | 2.248 ms | 0.053 ms | 0.629 ms |

The representative public calls read 16,228, 29,390, 22,722, and 54,690 source bytes respectively: two
bounded passes over `moov` plus top-level headers, never `mdat`. The only residual product seam is that the
range planner and independently authoritative ADR-251 demux proof each inspect `moov`. It costs 0.211 ms on
the losing `02.mp4` rotation (0.931 ms on the 31.3 MiB baked control), so eliminating it would require a new
cross-layer, unforgeable sample-storage proof handoff for a sub-millisecond ceiling and still could not close
the exported 6.490 ms raw gap. Warm product routing and all observable output work on `02.mp4` remain about
one millisecond including readback, reprobe, tag re-import, and terminal GC; the exported gap is therefore
consistent with a fixed browser/runtime measurement effect inside the row's measured noise, not an
asset-scaled product hot path. Keep the conservative decline envelope and obtain a current-bundle `01.mp4`
rerun plus a positive-memory sample instead of changing correctness-sensitive MP4 proof ownership.

Exact-vendored browser evidence is now positive on two rotations. Chromium selects baked
`h264_1080p_30s.mp4`: 59.165 ms median/MAD 1.465 versus mediabunny 227.305/2.110 (`n=7`, warmup 3).
Brave selects real `03.mp4` SHA `58dc001d18…`: 42.010/5.770 versus 86.990/3.190. Both pass strict truth,
but neither reports a positive memory sample; the original losing 3.5 MiB `01.mp4` rotation also remains
unrepeated. ADR-280 is a durable wall win on measured rotations, not yet a fully closed all-rotation row.
