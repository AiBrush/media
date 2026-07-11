# Session 11 — exact WebCodecs video acceleration handoff

## Problem and independent evidence

The exported fair-harness result data (status/metric/reason only; no harness implementation was read)
reported two codec-heavy fixed-overhead losses:

- `decode-seek/decode_size_tiny_vp9_360p`: 476.315 ms versus 117.845 ms.
- the tiny H.264 decode row: 265.385 ms versus 105.940 ms.

Product inspection found a real routing/configuration mismatch. `supports()` asked Chromium about
`prefer-hardware` first and could report a hardware win, but `createVideoDecoder()` discarded that accepted
choice and always configured `no-preference` under `auto`. ADR-002 and architecture docs 04/09 require the
video auto route to take the accepted hardware fast path. The gap is general to every H.264/HEVC/VPx/AV1
decode; it is not tied to a fixture or scenario.

## Design

`supports()` records only the accepted acceleration hint in a bounded 64-entry LRU. Its key is the exact
enumerable decoder config submitted to WebCodecs, excluding only the acceleration rung being selected.
Codec-description bytes (including direct `SharedArrayBuffer` and cross-realm `ArrayBufferLike` values),
geometry, display aspect, colour fields, latency flags, and the effective VPx alpha option all participate.
The key retains neither the caller config nor its byte buffer. Unsupported vendor-object/cyclic shapes are
uncacheable and take the exact probe path instead of collapsing to a shared key.

On decoder construction:

1. `force-software` always configures `prefer-software`, ignoring any cached auto verdict.
2. An exact cached verdict selects the first candidate, normally `prefer-hardware` after a hardware support
   win or `no-preference` after a software-only win.
3. A cache miss probes the exact config hardware-first and then `no-preference`; one rejected promise does
   not suppress the fallback.
4. Every candidate runs `configure()` followed by an empty `flush()` before writable startup resolves. The
   flush is a WebCodecs control-queue barrier: configuration support is checked asynchronously by the UA,
   so returning from `configure()` alone is not proof ([W3C WebCodecs Editor's Draft](https://w3c.github.io/webcodecs/),
   accessed 2026-07-11, VideoDecoder `configure`/`flush` algorithms).
5. A stale hardware verdict or asynchronous startup rejection deletes that verdict and proves the exact
   `no-preference` config before any packet can be submitted. Runtime errors after the barrier still fail
   typed and are never replayed.

The cache never supplies an old accepted config object. Configuration is rebuilt from the current caller's
config so `description`, colour, alpha, geometry, and latency facts cannot drift. Engine decode, seek,
accurate trim, and ordinary convert reuse the same normalized config object for routing and decoder
construction instead of normalizing it twice. Packet-plane VPx-alpha transcode additionally places its
effective `alpha:'discard'` in that shared query/config object; route support and construction can no longer
probe different alpha modes.

Packet submission, the queue high-water marks, decoder flush, presentation-order output, timestamps, and
frame ownership are unchanged. Consequently B-frame ordering and VFR timing remain WebCodecs-owned;
seek still closes preroll frames and cancels after its target; readable cancel or external abort races both
capability probes and configuration barriers, settles startup promptly, and ignores late results; and every
queued/late frame retains the existing close-once path.

## Validation

Fail-first Node tests use injected capability probes plus a control-queue-only decoder double (no coded-byte
or pixel claims). They pin:

- hardware-first acceptance and single-probe short-circuiting;
- hardware rejection/throw followed by an accepted `no-preference` fallback;
- use of the UA-returned accepted hint;
- `force-software` precedence;
- exact structural equality across separately allocated configs;
- description-byte, geometry, colour, and alpha separation;
- no caller-config/description mutation; and
- repeated equal-config reuse after a router-level cache hit;
- byte separation for direct shared and cross-realm description buffers, with unsupported vendor/cyclic
  values safely uncacheable;
- stale hardware rejection at the asynchronous configure barrier, exact software fallback, and proof that
  the first packet reaches only the fallback decoder;
- prompt readable-cancel/external-abort settlement during an unresolved probe, with no late configure; and
- VPx discard route/config identity independently of prior keep/discard operation order.

Focused WebCodecs selection/startup tests pass 66/66 with 169 assertions. The VPx alpha-normalization suite
passes 3/3, and the exact Router suite passes 30/30 with 75 assertions, including keep→discard and
discard→keep operation order. Full TypeScript checks, scoped Biome, the production build, diff checks, and
the unchanged package budgets are green; the eager bundle is 49.68 KiB against its 50 KiB guard. No Node
control-flow double or package measurement is evidence of browser throughput or decode conformance.

The prior pure-key benchmark did not include the now-required browser configuration barrier and is not a
current end-to-end decoder-start measurement. A fresh local key benchmark may bound TypeScript overhead,
but only the unchanged rotated browser run can measure the barrier and actual decode throughput.

## Browser proof still required

The lead must build and re-vendor the package, then run unchanged black-box Chromium with rotation enabled
and at least five timed samples for both exported deficit cells. Every rotated file must keep its strongest
decode oracle PASS; wall and peak memory must beat the fastest passing rival. The same run must show no
PASS-to-FAIL elsewhere, followed by the existing full WebKit regression run. Until that evidence exists,
this change fixes a proven product routing violation but does not claim the leaderboard cells closed.

## Rejected

- Unconditionally configuring `prefer-hardware`: this breaks genuine software-only decoders.
- Trusting only a `WeakMap` object identity: the Router can reuse a driver for a later equal but newly
  allocated config.
- Caching by codec string/profile alone: dimensions, description bytes, colour, alpha, and latency can
  change capability.
- Reusing the UA-returned config object: it can retain stale caller bytes and metadata.
- Treating `configure()` return as proof: WebCodecs checks support on its asynchronous control queue.
- Retrying a failed hardware decoder after packets have been submitted: replay would violate stream and
  ownership semantics; the empty-flush barrier resolves fallback before the first packet.
- Changing queue depth, frame copies, timestamp order, seek tolerance, fixtures, or any oracle.
