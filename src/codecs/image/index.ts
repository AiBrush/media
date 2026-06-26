/**
 * Public barrel for **image breadth** — still + animated GIF / PNG (+APNG) / JPEG / WebP / AVIF.
 *
 * Two capabilities, split by validation tier (ADR-025):
 *  - **probe** ({@link probeImage}) — pure TS, Node-runnable, **bit-exact** on real files: format, width,
 *    height, frame count, animated flag, exact header duration when present, bit depth/colour, loop count.
 *  - **decode** ({@link decodeImage}/{@link decodeImageFrames}) — browser-only via WebCodecs `ImageDecoder`,
 *    capability-gated (a typed `CapabilityError` in Node), yielding `VideoFrame`(s) the consumer closes.
 *
 * Images do not flow through the container↔codec packet seam (there is no demux-to-`EncodedChunk` step —
 * `ImageDecoder` consumes the whole encoded buffer), so this ships as a focused, self-contained surface
 * rather than a `ContainerDriver`/`CodecDriver`. {@link ImageModule} is the registration hook the engine
 * imports; {@link registerImageSupport} attaches the image ops onto a registry-like host. See the module
 * note in `image-driver.ts` for how the lead wires it into the engine + public exports.
 */

export {
  type ImageFormat,
  type ImageInfo,
  IMAGE_MIME,
  probeAvif,
  probeGif,
  probeImage,
  probeJpeg,
  probePng,
  probeWebp,
  sniffImageFormat,
} from './probe.ts';

export {
  type DecodeImageOptions,
  decodeImage,
  decodeImageFrames,
  hasImageDecoder,
  inspectImage,
} from './decode.ts';

export {
  type ImageOps,
  type ImageRegistry,
  default as ImageSupportModule,
  IMAGE_FORMATS,
  ImageModule,
  imageOps,
  registerImageSupport,
} from './image-driver.ts';
