/**
 * `@aibrush/media` — the default entry: the tiny eager kernel plus bare-function sugar (ADR-004/009).
 *
 * The developer expresses intent (`probe`, `convert`, …) and the engine routes each operation to the
 * best available substrate internally; backends are never named here (ADR-003).
 */

// Engine + bare-function sugar
export {
  convert,
  createMedia,
  decode,
  decrypt,
  demux,
  encode,
  load,
  mux,
  preload,
  probe,
  remux,
  seek,
  transcode,
  trim,
} from './api/create-media.ts';
export type { MediaEngine } from './api/engine.ts';

// Public option/result types
export type * from './api/types.ts';

// Sources (ADR-013). `cacheSource` wraps any source in an opt-in in-memory range cache (the backing for
// source-level `preload`, doc 07 §5); `probeUrlSize` learns a URL's length body-free for tail-seeking probes.
export {
  from,
  fromBlob,
  fromBytes,
  fromElement,
  fromOPFS,
  fromStream,
  fromURL,
  isSource,
  type MediaInput,
  probeUrlSize,
  type Source,
} from './sources/source.ts';
export { cacheSource } from './sources/cache.ts';
export type { ByteRange, CacheOptions, CachingSource } from './sources/cache.ts';

// Sinks (ADR-013). `toBlob`/`toFile` buffer the whole output; `toStreamTarget` writes each chunk straight
// to a caller-owned `WritableStream`/callback for bounded-memory streaming output (doc 09 streaming-output).
export { toBlob, toElement, toFile, toOPFS, toStream } from './sinks/sink.ts';
export { toStreamTarget, writeToStreamTarget } from './sinks/stream-target.ts';
export type {
  StreamDestination,
  StreamTarget,
  StreamTargetWriter,
} from './sinks/stream-target.ts';

// Images (ADR-049). Zero-config `probe`/`decode` support is registered through defaults, but the
// standalone helper barrel lives on `@aibrush/media/image` so the pure image parser does not join the
// eager default-entry closure (BUILD §2 budget).

// NOTE: `fragmentMp4` (the fragmented-MP4/CMAF generator) is intentionally NOT re-exported here. It is
// heavy MP4 box-writer code (`moof`/`trun`/`tfdt`/`mvex`/…) that, exported from this eager entry, inlines
// ~19 kB of driver code straight into the kernel chunk — defeating the "tiny eager kernel, lazy drivers"
// budget (BUILD §2, doc 08 §3/§7). It is an advanced MP4-driver escape hatch and belongs on the `/core`
// surface (or a lazy subpath), reached by apps through `convert(..., { fragmented: true })`. See report.

// Typed error model (ADR-017)
export { CapabilityError, InputError, MediaError } from './contracts/errors.ts';
export type { CapabilityErrorDetail, MediaErrorCode } from './contracts/errors.ts';

export { VERSION } from './version.ts';
