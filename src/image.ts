/**
 * `@aibrush/media/image` — standalone still/animated image helpers (ADR-049).
 *
 * The default entry still supports image `probe`/browser `decode` through zero-config registration, but
 * these direct helpers live on a subpath so importing `@aibrush/media` keeps the eager kernel under the
 * bundle budget.
 */

export {
  type DecodeImageOptions,
  decodeImage,
  decodeImageFrames,
  hasImageDecoder,
  IMAGE_FORMATS,
  IMAGE_MIME,
  type ImageFormat,
  type ImageInfo,
  inspectImage,
  probeImage,
  sniffImageFormat,
} from './codecs/image/index.ts';
