# Session 13 design note — selective native-audio transcode registration

## Goal and measured cause

Remove the register-all module/runtime residency from definite native compressed-audio transcodes without
changing one source packet, decoded sample, encoded access unit, container byte, timestamp, typed failure,
or ownership edge. The qualified `transcode/aac_to_opus_webm` row already leads wall durably at 56.190 ms,
but its 32,421,157-byte peak exceeds the leanest passing rival by 7,029,024 bytes. The selected real ADTS
source is 163,811 bytes, 470 AAC frames, stereo 48 kHz, and 10.026667 seconds. Its entire f32 signal is
3,850,240 bytes; the existing 128-frame native encoder window is at most 1,048,576 sample bytes; a typical
502-packet Opus WebM is about 150 kB. Product WebM parsing, packet retention, final serialization, and output
readback add only about 151 kB of live ArrayBuffers at that scale. Fresh public-engine processes show the
real fixed cost: selective ADTS probe retains 9,994,240 bytes median RSS versus 22,183,936 after register-all,
but a public ADTS-to-WebM conversion that reaches target and codec routing retains 25,722,880 versus
25,296,896 for a preloaded control. ADR-285 cannot close this row alone because WebM target selection imports
`defaults.ts` before codec work.

## Approach and rejected alternatives

Extend the existing query-selective registrar with only definite MP4/MOV and WebM/Matroska **mux** queries,
then add a parallel codec registrar for known WebCodecs audio families. The initial caller/custom-driver
selection always runs first. On its typed miss, an exact target token imports only the corresponding native
container module and retries the unchanged query. An automatic audio codec query in `determinism:'auto'`
imports/registers only `WebCodecsAudioModule`, retries the unchanged `isConfigSupported` query, and retains
that small graph only when native support succeeds. Support false/throw imports the complete defaults bundle
and retries the established ladder, including WASM. `force-software`, an explicit non-native pin, ambiguous
or unknown codecs/containers, and later unrelated operations skip selective native registration or fall
through to the complete bundle. An explicit `webcodecs-audio` pin may register that exact native driver
before source ownership, but its native miss stays a pinned typed miss after the complete defaults retry.

Rejected alternatives are: leaving target WebM on register-all (measured cause unchanged); importing every
container/codec proxy and hoping GC reclaims compiled modules (module namespaces are permanent); a
fixture/size/duration threshold; raising/lowering native queue bounds without browser evidence; staging the
complete output (already measured slower and larger); reusing stateful decoder/encoder objects across jobs;
or adding pre-output audio runtime replay. Asynchronous native decoder failure currently becomes the same
typed `CapabilityError` even when all defaults were registered; registration-only ADR-290 preserves that
behavior rather than inventing a distinct replay/lifetime policy.

## Edge cases, lifetime, and failure modes

AAC priming, Opus pre-skip, variable coded packet sizes, non-zero clocks, delayed encoder configuration,
empty streams, and native output arriving only during flush remain entirely inside the unchanged demux,
WebCodecs, and mux paths. Audio has no B-frames; DTS remains PTS. The registrar opens no source and owns no
`AudioData`, packet reader, decoder, encoder, or output stream. Existing one-pull packet backpressure and the
128-item native queue bound remain exact. Encoder input closes once after synchronous submission or every
error/abort arm; decoder outputs stay consumer-owned; cancellation still tears down the active coders and
streams. Registration is idempotent by driver id and concurrent imports converge through the module loader;
router caches clear after every registry mutation. A non-`CapabilityError` import or driver error propagates
unchanged. A selective retry that still misses never hides the primary capability ladder: it imports all
defaults and performs the exact established retry.

## Fail-first validation and benchmark plan

Focused registrar tests must prove mux-only MP4/MOV/WebM/MKV selection, demux/wrong/ambiguous decline,
single-family registry contents, custom-driver precedence, repeated/concurrent idempotence, exact known codec
families, native support success, support false/throw fallback, `force-software` fallback, explicit native
and non-native pins, and a later unrelated query loading the complete bundle. Engine tests must prove the
source is not opened before pin validation, cancellation remains typed, and no filter/image/WASM proxy joins
the successful selective graph. Existing browser lifecycle tests remain the close-once/backpressure oracle.
The strict product browser gate compares the same real ADTS input through selective and register-all
controls: exact WebM bytes, packet payload/timestamp/duration digest, re-imported geometry/duration, playback,
470 decoder inputs, exact decoded/encoded frame clocks, one close per `AudioData`, bounded queue maxima,
and abort with no late output. The committed fresh-process benchmark uses at least seven independent
processes per arm and reports RSS/heap/external/ArrayBuffers separately; RSS is module-residency attribution,
not a substitute for the qualified browser UA-memory row. Closure still requires a fresh same-export,
same-rotation warm `n>=5` browser comparison with positive peak memory.
