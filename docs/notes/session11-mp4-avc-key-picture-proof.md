# Session 11 MP4 AVC key-picture proof audit

Date: 2026-07-11  
Decision: ADR-204

## Outcome

No header-only optimization is valid for the rotated 600-second MOV corpus. `stss` proves the samples it
lists are sync samples, but none of the four files carries header evidence that decides the picture type of
every other AVC sample. The production payload classification therefore stays intact.

This is an intentional no-patch result, not an uninvestigated performance miss. An optimistic sparse
64-byte prefix prototype classified every current non-`stss` sample, but its 13,718 tiny reads on the
selected rotation were slower than the existing coalesced full-payload windows. Generic HTTP multipart
ranges are optional and cannot remove the mandatory exact fallback.

The black-box export
`../media-test/results/raw/chromium-2026-07-10T23-25-04-841Z.json` selected `01.mov`, passed the exact
42,276-packet golden, and measured 986.085 ms. The generated deficit report records web-demuxer at
10.910 ms. That comparison does not alter the truth contract: on these headers, a metadata-only result has
no proof for the 13,718 non-`stss` picture types. The current golden happens to equal `stss`; the separate
real two-hour corpus in [mp4-packet-truth.md](./mp4-packet-truth.md) proves this is not a general invariant
by containing 261 non-IDR I pictures outside its 1,680 declared sync samples.

No harness scenario, oracle, tolerance, runner, selection, output parser, or adapter implementation was
opened for this audit. Inputs were the public result JSON, public corpus/goldens, product code, Bento4,
and the format specifications.

## Rotation-wide evidence

| File | Bytes | SHA-256 | AVC samples | `stss` / golden video keys | Non-`stss` decisions | 64-byte payload floor |
|---|---:|---|---:|---:|---:|---:|
| `huge_h264_1080p_600s.mov` | 447,748,594 | `319bcf37ab6c54b9ed191ade74f4e37e2b633c7dd31026ba98eba1ad50751767` | 18,000 | 300 / 300 | 17,700 | 1,132,800 B |
| `01.mov` | 725,106,140 | `dc2146a2b1172def56730143ad80cd1825b7fad15f1fc9c23a4e7d01a741ac11` | 14,315 | 597 / 597 | 13,718 | 877,952 B |
| `02.mov` | 416,751,190 | `45c8bafeb9a53df7f491198d2e71529701bcf1cd51805782089fac1d32869f9b` | 14,315 | 597 / 597 | 13,718 | 877,952 B |
| `03.mov` | 249,229,883 | `b2acb9bddcb384f9762f919af8f6d8b4be781e40ad2f35a37cc12beef55b9a27` | 14,315 | 597 / 597 | 13,718 | 877,952 B |

The canonical file has no video `sdtp`. Each derived file has the same extracted `sdtp` payload SHA-256,
`c9eec297954653678fdaa46f522281d6146ca56b484ffc2dfcda0cfc5e49b94e`, and the same value histogram:

| Value | Count | QuickTime meaning | Picture type decided? |
|---:|---:|---|---|
| `0x00` | 597 | no dependency fact set | No |
| `0x40` | 6,561 | earlier display times allowed | No |
| `0x08` | 7,157 | no other sample depends on this sample / droppable | No |
| `0x20` | 0 | sample does not depend on others / I picture | Yes: I |
| `0x10` | 0 | sample depends on others / not an I picture | Yes: non-I |

The flag meanings come directly from Apple's
[Sample dependency flags table](https://developer.apple.com/documentation/quicktime-file-format/sample_dependency_flags_atom/sample_dependency_flags_table).
Apple describes [`stss`](https://developer.apple.com/documentation/quicktime-file-format/sync_sample_atom)
as a table of sync sample numbers; it does not say that a sample absent from the table cannot be a non-IDR
I/SI picture. None of the video tracks has `stps`, a RAP sample group, or other dependency metadata. The
`avcC` NAL-length configuration and SPS likewise do not forbid non-IDR intra pictures.

The 64-byte prototype used the declared sample size as the outer boundary, parsed length-prefixed AVC NAL
units, and read `first_mb_in_slice` plus `slice_type` from the first base-AVC VCL NAL. It returned a
tri-state result: I/SI/IDR, P/B/SP, or unknown. Every current candidate returned P/B/SP with zero unknowns
and zero additional I/SI pictures. That is useful empirical evidence for these exact files, but not header
evidence and not permission to assume every future access unit reaches its first VCL header within 64
bytes. Unknown, malformed, and long-prefix cases still require progressive extension through the full
sample.

## Measured I/O floor

On the selected `01.mov`, the existing exact path and optimistic prefix experiment were measured from a
local range-backed file after warmup:

| Path | Samples | Median | Range reads | Bytes requested |
|---|---:|---:|---:|---:|
| Current coalesced payload scan | 7 | 105.453 ms | 310 | 609,092,550 |
| Optimistic 64-byte prefixes | 9 | 132.910 ms payload + 4.826 ms parse | 13,721 | 1,272,638 |

The prefix total is 13,718 payload reads plus three top-level/`moov` reads. It reduces bytes but loses on
per-read cost. Coalescing sparse prefixes also has no useful middle point:

| Maximum bridged gap | Windows | Span bytes |
|---:|---:|---:|
| 16 KiB | 9,612 | 33,330,935 |
| 64 KiB | 2,888 | 274,542,931 |
| 256 KiB | 391 | 564,505,173 |

HTTP multiple ranges do not turn this into a portable fast path. RFC 9110 makes ranges optional, permits a
server to ignore or reject many small ranges, allows coalescing, and notes roughly 80 bytes of multipart
overhead per part. See [RFC 9110 §14](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests).
Even an aggressive 256-prefix batch needs 54 requests for `01.mov`, multipart parsing, a capability check,
and the existing exhaustive fallback when the origin declines. Shipping that route would add complexity
while losing on the available local source and still not establish 10.910 ms parity.

## Reproduction

The following commands inspect only public corpus and golden artifacts:

```bash
CORPUS=../media-test/fixtures/media/scenarios/demux/size_huge_huge_h264_1080p_600s
GOLDEN=../media-test/fixtures/golden/scenarios/demux/size_huge_huge_h264_1080p_600s

shasum -a 256 "$CORPUS"/*.mov
for file in "$CORPUS"/*.mov; do
  stat -f '%N %z' "$file"
  mp4dump --verbosity 1 "$file" | rg '\[avc1\]|\[stss\]|\[sdtp\]|\[stps\]|\[sgpd\]|\[sbgp\]|sample_count =|entry_count ='
done

for stem in 01 02 03; do
  mp4extract --payload-only moov/trak/mdia/minf/stbl/sdtp "$CORPUS/$stem.mov" "/tmp/$stem.sdtp"
  shasum -a 256 "/tmp/$stem.sdtp"
  od -An -tu1 -j4 "/tmp/$stem.sdtp" | tr -s ' ' '\n' |
    awk 'NF { count[$1]++ } END { for (value in count) print value, count[value] }' | sort -n
done

jq -c '{tracks:(group_by(.trackIndex) | map({track:.[0].trackIndex,count:length,keys:(map(select(.keyframe == true))|length)}))}' \
  ../media-test/fixtures/golden/huge_h264_1080p_600s.mov.packets.json \
  "$GOLDEN"/*.packets.json
```

The exact production scan timing was reproduced with two warmups and seven retained samples against a
counting `ByteSource` whose `range(start, end)` returns `Bun.file(path).slice(start, end).arrayBuffer()`.
The retained sample set was:

```text
[80.069, 87.077, 93.754, 105.453, 113.057, 115.607, 117.523] ms
```

The nine optimistic prefix payload samples were:

```text
[131.426, 131.847, 132.248, 132.606, 132.910, 133.011, 133.387, 133.516, 134.218] ms
```

## Guardrail

If future media carries complete, well-formed per-sample `0x20`/`0x10` dependency facts, product code may
use those facts as a tri-state proof after count and conflict validation. Missing or ambiguous entries must
still fall back. A future sparse-prefix implementation is acceptable only if its source capability is
explicit, batches are bounded, every sample is covered, unknown extends to full payload, malformed metadata
remains typed, and a fresh multi-sample benchmark proves it faster. None of those conditions licenses a
header-only shortcut for the four audited rotations.
