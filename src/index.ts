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
  mux,
  preload,
  probe,
  remux,
  transcode,
  trim,
} from './api/create-media.ts';
export type { MediaEngine } from './api/engine.ts';

// Public option/result types
export type * from './api/types.ts';

// Sources (ADR-013)
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
  type Source,
} from './sources/source.ts';

// Sinks (ADR-013)
export { toBlob, toElement, toFile, toOPFS, toStream } from './sinks/sink.ts';

// Typed error model (ADR-017)
export { CapabilityError, InputError, MediaError } from './contracts/errors.ts';
export type { CapabilityErrorDetail, MediaErrorCode } from './contracts/errors.ts';

export { VERSION } from './version.ts';
