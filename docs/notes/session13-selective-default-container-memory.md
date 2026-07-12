# Session 13 design note — family-selective default container registration

Two unrelated qualified Brave rows reported nearly identical aibrush absolute peaks: 33,729,168 bytes for
s24 WAV decode and 33,478,114 bytes for Ogg-to-MKV remux, about 9.7-9.9 MiB above mediabunny. The selected
inputs are only 141,168 and 3,998 bytes. Public Node lifecycle profiles attribute live operation memory to
329,842 peak ArrayBuffer bytes for WAV (141,168 source bytes plus six closed frames totaling 187,944 bytes)
and 13,765 bytes for Ogg including output readback and re-probe. All readers unlock, source/output Blobs and
stream wrappers collect, and post-GC ArrayBuffers return to zero. Chromium's Ogg rotation reports the two
engines equal within 2,984 bytes, while Brave moves mediabunny down roughly 9.1 MiB and leaves aibrush near
the same baseline. This is not evidence for a packet/frame lifetime defect.

Fresh-process controls identify the general source: the first container capability miss imports the complete
`defaults.ts` registration bundle, including statically referenced MP4, WebM, codec, filter, and image proxy
families. Explicitly registering only Ogg or WAV lowers post-GC Node RSS by roughly 13 MiB without changing
live operation ArrayBuffers. The design therefore adds a small query-selective registrar for definite
long-tail audio container MIME, extension, or magic queries. It imports and registers the one actual native
driver, retries routing with the same query and precedence, and leaves the full register-all bundle as the
second fallback for ambiguous/unsupported queries, failed pins, codec/filter/image selection, preload, and
later unrelated operations. Caller-registered drivers still win because selection succeeds before either
default path. No filename, asset size, digest, scenario, corpus rotation, or performance threshold appears
in routing. Cancellation, stream backpressure, frame close-once ownership, B-frame/VFR behavior, and media
bytes are downstream of registration and remain unchanged.
