/**
 * Shared operational ceiling for product paths that retain a complete media payload in memory.
 *
 * One GiB is deliberately below any structural `Uint8Array` limit: buffer-all paths keep source,
 * packet metadata, mux state, and publication buffers live at the same time. Callers that can prove an
 * incremental representation may bypass this policy; callers that retain every payload byte may not.
 */
export const BUFFER_ALL_MAX_RETAINED_BYTES = 1024 * 1024 * 1024;

/**
 * Portable planning ceiling for a single output `ArrayBuffer`.
 *
 * ISO BMFF can describe almost 4 GiB with version-0 box sizes, but browser allocators do not promise
 * that a contiguous allocation near that structural maximum is available. Keep projections within a
 * signed 31-bit byte index and reserve separate headroom for MP4 sample tables and box framing.
 */
export const SAFE_SINGLE_ARRAY_BUFFER_BYTES = 0x7fffffff;

/** Conservative non-payload allowance used by the finite MP4/MOV convert projection. */
export const MP4_PROJECTED_CONTAINER_HEADROOM_BYTES = 64 * 1024 * 1024;

/**
 * Largest whole program a lazy `toStream()` consumer can be reasonably expected to hold as one
 * contiguous buffer.
 *
 * 512 MiB is the ceiling every mainstream browser engine lineage has honored for a single
 * `ArrayBuffer` allocation (the historical V8 limit and the still-enforced bound on 32-bit-class
 * heaps); anything above it may only be retained by consumers in segmented form. A remux whose
 * projected program crosses this ceiling is therefore never published to a lazy stream consumer as
 * a single moov-at-end whole program: ISO BMFF authors switch to the fragmented representation
 * (valid media at every `moof`/`mdat` boundary, no seek-back), and container families without a
 * fragmented whole-program form are spooled through the `toBlob()` materializer, whose parts are
 * user-agent storage that pages to disk. `toStreamTarget()`/OPFS sinks — consumers that prove they
 * write incrementally — always keep the lazy stream.
 */
export const STREAMED_WHOLE_PROGRAM_MAX_BYTES = 512 * 1024 * 1024;
