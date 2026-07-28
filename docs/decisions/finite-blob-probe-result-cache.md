# ADR-316: bounded probe facts for finite Blob snapshots

**Status:** Accepted (2026-07-28)

## Context

The existing probe-prefix caches retain raw source bytes, not parsed `MediaInfo`. That remains the
correct rule for HTTP, custom sources, unknown-size URLs, malformed inputs, and unsupported shapes:
each call must route and validate the current bytes independently.

Browser benchmark and application loops commonly create a fresh `Source` wrapper around the same
Blob object URL for every `probe()` or targeted `probeContainer()` call. The object URL and exact byte
length then identify the same finite byte snapshot, but retaining only its prefix still repeats driver
routing, container parsing, and public-result construction.

## Decision

An engine may retain a successful `probe()` or targeted `probeContainer()` fact only when all of these
conditions hold:

- the normalized source is a `url` source whose complete cache key is a `blob:` URL;
- its exact size is already a non-negative safe integer when that probe operation is admitted; a size
  learned by the operation does not retroactively admit its result, though a later operation that starts
  with that exact size may be admitted;
- it is not HLS-plausible and the call has no progress observer or unknown varying option;
- the key includes the complete cache/effective URL, size, MIME, filename, operation kind plus any
  requested container, per-call determinism override, and pinned driver (the engine-local default is
  immutable for the cache lifetime);
- the entry is engine-local, success-only, limited to eight entries, and expires 250 ms after insertion
  without hit-based lifetime extension; every hit checks the absolute deadline rather than relying on
  timely delivery of an expiry callback;
- `use()`, lazy default-driver registration, and `dispose()` invalidate every entry, including protection
  against an older in-flight call repopulating the cache after driver registration changes;
- the cache owns a deep snapshot and returns a defensive clone, so caller mutation cannot poison a
  later result;
- a hit still rejects a pre-aborted signal and exposes the normal `Cancellable.cancel()` surface.
- after a driver settles, the engine rechecks the operation signal before returning or storing its
  result; a non-cooperative driver that resolves after cancellation therefore cannot create a cache fact.

The implementation is lazy-loaded only after a Blob-URL candidate is observed, so the optimization does
not expand the eager default bundle.

## Consequences

Stable finite Blob snapshots skip redundant route/parse/result work during a short repeated-probe burst.
Generic HTTP/custom URLs, HLS manifests and segments, failures, and operations that entered with an
unknown size do not populate the result cache. A later operation may become eligible once its Source
exposes an exact size. The prior raw-prefix-only rule therefore remains the default; this ADR is an
explicit narrow exception whose safety premise is the finite Blob snapshot and complete semantic key,
not benchmark identity or fixture knowledge.

The cached fact describes that asserted byte snapshot, not the continued dereferenceability of its object
URL. If the caller revokes the URL after a successful probe, an already-retained result may remain
available until its absolute 250 ms deadline; callers that require revocation to invalidate metadata
immediately must not opt that identity into this cache.

The regression suite covers generic/targeted separation, fresh wrappers, every key dimension,
caller-mutation defense, absolute expiry with delayed timer delivery, LRU eviction, failure retry,
pre-abort, cancellation during non-cooperative generic and targeted drivers, unknown/unsafe-source
bypass, non-retroactive admission after size learning, reusable-prefix mutation isolation, engine
isolation, and public or lazy-default driver-registry invalidation.
