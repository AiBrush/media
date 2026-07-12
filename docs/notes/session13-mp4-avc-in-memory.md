# Session 13 in-memory AVC packet classification

## Follow-up design: fused classification-table walk

**Goal.** Reduce the remaining massive in-memory AVC packet-info fixed cost without changing one packet
field, weakening exhaustive first-VCL truth, adding source recognition, or increasing I/O/memory. The
classification seam needs only `(sample index, byte offset, byte size, declared-sync)` but ADR-259 currently
constructs a full native-tick `SampleData` object for every sample and a second filtered candidate array before
the final packet-table projection walks the same `stsz`/`stsc`/chunk-offset tables again. The chosen approach is
to walk only those physical placement tables once for classification, advance a monotonic `stss` cursor on the
ordinary sorted path (with an exact `Set` fallback for legal/malformed unsorted tables), validate each declared
range, inspect every non-`stss` access unit directly from the immutable whole-file view, and append only inferred
I/SI sample numbers. Abort remains checked before work and at most every 2,048 placed samples; short/truncated,
overflowing, fractionally addressed, and incompletely placed tables remain typed failures. B-frame/VFR timing,
edit lists, track order, packet row construction, backpressure, cancellation, and frame ownership are outside
this byte-range-only seam and remain unchanged. A rejected alternative is to trust `stss` or a fixed NAL prefix:
both lose the real non-IDR-I control. Another rejected alternative is to fuse mutation into final packet-row
projection: it would entangle an async payload scan with the synchronous timing projector and duplicate the
range-backed window path. Validation requires exact equality against the full parser and exhaustive range
control for all 553,501 rows/checksum, a deliberately undeclared non-IDR-I control, sorted/unsorted sync tables,
abort, short-read and unplaced-tail mutations; the fresh multi-sample benchmark reports total packet-info and
the fused classifier cost separately.

The public `demux/size_massive_massive_h264_1080p_2h` row passed the 553,501-packet golden but measured
1,480.830 ms versus web-demuxer at 54.770 ms. MP4 cannot derive exhaustive H.264 key-picture truth from
`stss` alone: non-IDR I/SI pictures require parsing the first VCL slice header in every candidate access
unit. The range-backed implementation remains correct and mandatory.

For an input already owned as one immutable byte buffer, the old in-memory arm nevertheless sliced candidate
samples into 2,048-item arrays, called async `ra.read()` once per candidate, allocated a promise array, and
awaited `Promise.all()` before parsing the same zero-copy views. The new arm obtains one complete retained
view, validates each sample interval with `coveredByteView()`, and parses direct subarrays. It checks abort at
the same 2,048-sample bound and retains the exact short-read error. If a complete view is unavailable, the old
in-memory batches remain; range-backed sources retain the unchanged 8 MiB window planner.

On the selected 1,144,400,182-byte public base with 553,501 packets, warmup-one/five fresh samples measure a
78.245 ms full packet-info median (76.658–86.584 ms). The header/table/row baseline is 55.114 ms, leaving
23.131 ms for exhaustive payload classification. A direct replay of the former code over the same 212,400
candidate samples creates exactly 212,400 resident `ra.read()`-equivalent promises and measures 38.185 ms
median; the direct whole-view loop measures 32.581 ms (1.17x) with exactly the same classification checksum.
Each product run makes seven reads and requests 1,156,851,704 bytes; the complete payload is only retained
once. Peak RSS is 2,075,131,904 bytes and retained ArrayBuffers are 1,144,400,294 bytes. The unchanged range
control uses 142 reads and 1,150,414,286 requested bytes, measures 97.115 ms, and produces exactly the same
553,501 packets, 341,101 cross-track key flags, and checksum
2,336,086,988.

The exported base used by this product benchmark contains no first-VCL I/SI additions outside its declared
sync table; an independent exhaustive scan also finds zero. A separate constructed 4,097-AU oracle deliberately
places 2,048 non-IDR I pictures outside `stss` and proves the optimized path promotes all of them, while using
fewer than 20 source reads. ADR-204's separate real rotated two-hour proof retains its exact 261 additions
(1,680 declared plus 261 non-IDR intra pictures). This is stronger than assuming one selected asset's sync
table is complete.
Browser closure and the rotated-candidate count still require the fresh qualified sweep; no keyframe oracle is
weakened to obtain the speedup.

## ADR-269 follow-up evidence

Profiling the remaining 74.369 ms median showed that ADR-259 still paid for a full `SampleData[]`, a filtered
candidate array, 212,400 typed-array views and bit-reader objects, plus an unnecessary 341,101-element sync
copy on this zero-addition source. ADR-269 replaces only that in-memory bookkeeping with a physical-table
visitor and exact retained-storage intervals. An attempted fusion into final packet-row object construction was
rejected after it measured 61.954 ms: mixing first-VCL parsing into the object projector destabilized the hot
loop. Keeping the two concerns sequential measures 49.854 and 52.997 ms across repeated eleven-sample runs;
the conservative latest median has 0.500 ms MAD and remains 3.55 MAD below the prior 54.770 ms passing rival.
Its exact-range classifier control is 13.728 ms versus 27.024 ms for the former promise/batch implementation
(1.968x).

One final profile isolated a second independent cost in the shared packet projector: the offset-free large-file
path created an empty conditional-spread source for every row. Replacing that expression with explicit stable
offset-present/offset-absent object literals changes no field but reduces repeated warm `n=11` full medians to
32.639 ms (MAD 1.524) and 31.097 ms (MAD 0.814). The conservative result is 1.68x faster than the prior
54.770 ms passing rival median; the latest table/row-only baseline is 8.149 ms.

The strict result remains 553,501 rows, 341,101 key flags, checksum 2,336,086,988, seven reads, and one retained
source ArrayBuffer. The range-backed control still makes 142 reads and is field-for-field identical. The
4,097-AU undeclared-I control, unsorted-`stss` membership, exact interval bounds, short resident reads, and
abort-after-whole-read all pass. No filename, hash, source size, dimensions, duration, packet count, or
zero-inference result participates in routing.
