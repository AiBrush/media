/**
 * Image-support **registration hook** (for the lead to wire into the engine) — bundles the still/animated
 * image ops (probe + browser decode) into one attachable unit, the way each first-party driver exposes a
 * `*Module`. Images are not a `CodecDriver`/`ContainerDriver` (no packet seam — see `index.ts`), so this
 * module does **not** call `Registry.addCodec/addContainer`; instead it carries the image ops as a small,
 * typed capability object and registers them onto an {@link ImageRegistry} host.
 *
 * Integration (lead-owned): the engine can either (a) hold an `imageOps` capability and call it directly
 * from `probe`/`decode` when the source sniffs as an image, or (b) call {@link registerImageSupport} on a
 * host that collects image ops. The {@link ImageModule} mirrors the `DriverModule` shape (`apiVersion` +
 * `register`) so it can sit alongside the other modules; `register` is a no-op against the plain driver
 * `Registry` (it has no image slot) and attaches only when given an {@link ImageRegistry}. Public helper
 * exports live on the `@aibrush/media/image` subpath (`src/image.ts`): `probeImage`, `decodeImage`,
 * `decodeImageFrames`, `inspectImage`, `sniffImageFormat`, the `ImageInfo`/`ImageFormat` types, and
 * `IMAGE_MIME`.
 */

import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import {
  type DecodeImageOptions,
  decodeImage,
  decodeImageFrames,
  hasImageDecoder,
} from './decode.ts';
import { type ImageFormat, type ImageInfo, probeImage, sniffImageFormat } from './probe.ts';

/** Every still/animated image format this module supports. */
export const IMAGE_FORMATS: readonly ImageFormat[] = ['gif', 'png', 'jpeg', 'webp', 'avif'];

/**
 * The image capability surface — pure probe (Node) + browser decode (capability-gated). A host that wants
 * image support holds one of these and routes to it when a source sniffs as an image.
 */
export interface ImageOps {
  /** The formats handled (for capability reporting / routing). */
  readonly formats: readonly ImageFormat[];
  /** Format from magic bytes, or `undefined` if the bytes are not a supported image. */
  sniff(bytes: Uint8Array): ImageFormat | undefined;
  /** Pure, bit-exact header probe (dimensions/frame count/animated/duration/bit depth/colour/loop). */
  probe(bytes: Uint8Array): ImageInfo;
  /** Whether the live decode path is available here (a real WebCodecs `ImageDecoder`). */
  canDecode(): boolean;
  /** Decode to a `ReadableStream<VideoFrame>` (consumer closes each frame). Browser-only; typed miss in Node. */
  decode(bytes: Uint8Array, options?: DecodeImageOptions): ReadableStream<VideoFrame>;
  /** Decode to an async `VideoFrame` generator (consumer closes each frame). Browser-only; typed miss in Node. */
  decodeFrames(
    bytes: Uint8Array,
    options?: DecodeImageOptions,
  ): AsyncGenerator<VideoFrame, void, undefined>;
}

/** The singleton image capability — stateless, so one shared instance is safe. */
export const imageOps: ImageOps = {
  formats: IMAGE_FORMATS,
  sniff: sniffImageFormat,
  probe: probeImage,
  canDecode: hasImageDecoder,
  decode: decodeImage,
  decodeFrames: decodeImageFrames,
};

/** A host that can accept image support (a superset of the plain driver `Registry`, lead-defined). */
export interface ImageRegistry {
  addImageOps(ops: ImageOps): void;
}

/** Type guard: does this registration host expose an image slot? */
function isImageRegistry(reg: unknown): reg is ImageRegistry {
  return (
    typeof reg === 'object' &&
    reg !== null &&
    typeof (reg as { addImageOps?: unknown }).addImageOps === 'function'
  );
}

/**
 * Attach the image ops onto a host. If the host implements {@link ImageRegistry} (`addImageOps`), register
 * there and report `true`; otherwise this is a no-op (`false`) — safe to call against the plain driver
 * `Registry`, which has no image slot, so {@link ImageModule} can live in the defaults array harmlessly.
 */
export function registerImageSupport(reg: unknown): boolean {
  if (isImageRegistry(reg)) {
    reg.addImageOps(imageOps);
    return true;
  }
  return false;
}

/**
 * The image module — `DriverModule`-shaped (`apiVersion` + `register`) so the lead can list it beside the
 * other first-party modules. `register` attaches the image ops only to an {@link ImageRegistry} host; on
 * the plain `Registry` it is an intentional no-op (images have no codec/container slot there).
 */
export const ImageModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: unknown): void {
    registerImageSupport(reg);
  },
} as const;

export default ImageModule;
