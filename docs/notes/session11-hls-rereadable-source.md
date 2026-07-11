# Session 11 — ambiguous HLS sniff preserves re-readable custom sources

## Problem

The HLS resolver correctly sniffs generic/no-hint inputs for `#EXTM3U`. Its bounded peek treated every
source without `range()` as single-use and returned a replay wrapper marked `kind:'stream'`. A caller may,
however, implement the documented `Source` contract as `kind:'bytes'` with a fresh `stream()` on every call
and no random-access method. A non-HLS custom source was needlessly downgraded; the following image sniff
rejected it as non-seekable before container routing.

## Decision

After a bounded HLS peek, a true `kind:'stream'` continues to retain the locked reader and replay every
consumed chunk exactly once. Every other kind is contractually re-readable: cancel and release only the
temporary sniff reader, retain the exact head result, and return the original `Source` object. If the head
is a manifest, resolution opens a fresh full reader; if it is not, later image/container probes do the same.
Hints, size, URL provenance, abort behavior, and the single-use replay path are unchanged.

## Validation

The fail-first public probe test now counts fresh opens on a no-range `kind:'bytes'` source and proves it
routes successfully. The focused create-media/HLS matrix passes 79/79, including unhinted byte manifests,
ambiguous MIME/extension manifests, a split single-use manifest, exact non-HLS stream replay, AES-128
OpenSSL twins, SAMPLE-AES, and the new re-readable path. No normal range-backed media path changes or pays
an extra read.

## Rejected alternatives

- Marking every range-less source single-use despite the public `Source` contract.
- Skipping HLS detection for all unhinted custom sources.
- Reading the whole ambiguous source before knowing it is a manifest.
- Reusing the sniff reader after cancel/release or opening a true single-use stream twice.
- Catching and ignoring the downstream `need seekable` error.
