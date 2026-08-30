/**
 * Still/animated image policy — probe + ImageDecoder decode, conversion via VideoFrame (REQUIREMENTS §6 — 2.3.2).
 *
 * Images are not a `CodecDriver`/`ContainerDriver` seam (no packet mux — see `image-driver.ts`), but the
 * engine routes them through a dedicated `ImageOps` capability: pure-TS probe (magic + header walk) plus
 * browser `ImageDecoder` decode to `VideoFrame`(s). Where `ImageDecoder` is available, a still image
 * decodes to exactly one `VideoFrame` (duration 0, single presentation time) and an animated image
 * decodes to its full frame sequence with per-frame durations reconstructed from container delays
 * (GIF/APNG/WebP `acTL`/`ANIM`/`ANMF`, AVIF `avis` `stsz` sample count). The decoded frame(s) are
 * presentation-oriented `VideoFrame`s that can be piped through the shared filter graph and encoded to
 * any video codec where the browser exposes a `VideoEncoder` for the target `codec`/`bitDepth`.
 *
 * Capability model (mirrors `imageOps`):
 *   - probe: true (pure, `probeImage` for GIF/PNG/JPEG/WebP/AVIF, 8/10/12-bit via SOFn/av1C)
 *   - decode: hardware true iff `ImageDecoder` is present (`hasImageDecoder()`), else typed `CapabilityError`
 *   - still → video: one frame → encode at caller's `fps` (default 30) or at `1` for a single-frame output
 *   - animated → video: frame sequence → encode preserving per-frame durations (VFR)
 *   - formats: GIF/PNG/JPEG/WebP/AVIF where `ImageDecoder` + `canConvert` preflight agree
 *   - Licensing: image containers are royalty-free where the format is (GIF/PNG/JPEG via `ImageDecoder`
 *     is platform-provided, WebP/AVIF via the same plus `dav1d` for AVIF stills where applicable).
 */

export const IMAGE_POLICY = {
  formats: ['gif', 'png', 'jpeg', 'webp', 'avif'] as const,
  probe: true as const,
  decode: { browser: true as const, node: false as const },
  stillToVideo: { supported: true as const, via: 'ImageDecoder→VideoFrame→VideoEncoder' as const },
  animatedToVideo: {
    supported: true as const,
    via: 'ImageDecoder frame sequence → VideoEncoder VFR' as const,
  },
  licensing: {
    note: 'GIF/PNG/JPEG/WebP/AVIF decode via platform ImageDecoder; AVIF stills may use dav1d where ImageDecoder delegates to it',
    royaltyFree: true as const,
  },
} as const;

/** Human-readable disclosure for docs and capability reporting. */
export function imagePolicyNotice(): string {
  return [
    'Still/animated images (GIF/PNG/JPEG/WebP/AVIF) probe pure-TS (probeImage) and decode via WebCodecs ImageDecoder where available.',
    'A still image decodes to one VideoFrame; an animated image decodes to its timed frame sequence.',
    'Decoded frames are presentation-oriented VideoFrames that can be filtered and encoded to H.264/HEVC/VP9/AV1 where VideoEncoder is available.',
    'Probe with sniffImageFormat/probeImage or media.probe(); preflight with hasImageDecoder() or media.canConvert() before decode/convert.',
  ].join(' ');
}

/** Whether the current runtime can decode images (ImageDecoder present). */
export function imageDecodeAvailable(): boolean {
  return typeof ImageDecoder !== 'undefined';
}

/** The image formats this build probes (pure) and can decode where ImageDecoder is present. */
export function imageSupportedFormats(): readonly string[] {
  return IMAGE_POLICY.formats;
}
