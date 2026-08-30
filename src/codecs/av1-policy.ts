/**
 * AV1 policy — hardware + dav1d WASM decode, hardware encode, quality-normalized (REQUIREMENTS §5.5, §6, §8.3, §12).
 *
 * AV1 is royalty-free (AOMedia). This package ships a focused WebAssembly decoder (dav1d) as a
 * software fallback where the browser's WebCodecs `VideoDecoder` does not expose `av01` support, and
 * routes encode exclusively through hardware WebCodecs `VideoEncoder` where the browser exposes `av01`
 * (no AV1 encoder WASM is bundled). The level table is Annex A sized to the output
 * dimensions/bitrate, and quality-normalized comparisons use the shared implicit bitrate model
 * (`IMPLICIT_BITS_PER_PIXEL_PER_SECOND` scaled by `VIDEO_CODEC_RATE_EFFICIENCY.av1 = 0.6` and
 * AV1 cadence). See `docs/runtime-and-capabilities.md#av1-policy` for disclosure and preflight.
 *
 * Capability model:
 *   - parse: true (AV1CodecConfigurationRecord `av1C` helpers are pure TypeScript)
 *   - decode: hardware true (WebCodecs `av01.*`), software true (dav1d WASM, 8/10-bit)
 *   - encode: hardware true (WebCodecs `av01.*`), software false — no AV1 encoder WASM is shipped
 *   - alpha: false (AV1 alpha is not part of this build's WebM surface)
 *   - bitDepths: [8, 10] — Main 8-bit and High 10-bit; 12-bit is rejected with typed CapabilityError
 *   - Licensing is documented here and surfaced via `av1LicensingNotice()` — the support matrix
 *     row for `av1` derives from this single source.
 */

export const AV1_POLICY = {
  codec: 'av1' as const,
  parse: true as const,
  decode: { hardware: true as const, software: true as const },
  encode: { hardware: true as const, software: false as const },
  alpha: false as const,
  bitDepths: [8, 10] as const,
  channelLayouts: [] as const,
  profiles: ['Main'] as const,
  softwareWasmShipped: true as const,
  softwareWasmCodec: 'dav1d' as const,
  licensing: {
    pools: ['AOMedia AV1 (royalty-free)'] as const,
    codecBinaryRedistributed: true as const,
    route: 'hardware-only WebCodecs encode; hardware WebCodecs or dav1d WASM decode' as const,
    royaltyFree: true as const,
  },
} as const;

/** Human-readable disclosure for docs and generated license reports. */
export function av1LicensingNotice(): string {
  return [
    'AV1 in @aibrush/media is royalty-free (AOMedia).',
    'Decode is hardware WebCodecs (av01.*) with a dav1d WebAssembly fallback (8/10-bit) where hardware is absent.',
    'Encode is hardware-only via WebCodecs. No AV1 encoder WebAssembly is bundled.',
    'Probe support with VideoDecoder.isConfigSupported / VideoEncoder.isConfigSupported or media.canConvert() before use.',
  ].join(' ');
}

/** Whether this build ships a software (WASM) AV1 decoder — true (dav1d). */
export function av1SoftwareDecodeAvailable(): boolean {
  return true;
}

/** Whether this build ships a software (WASM) AV1 encoder — false (hardware-only). */
export function av1SoftwareEncodeAvailable(): boolean {
  return false;
}

/** The bit depths this policy authorizes for AV1 (8 and 10). */
export function av1SupportedBitDepths(): readonly number[] {
  return AV1_POLICY.bitDepths;
}

/** True when `bitDepth` is an explicitly supported AV1 depth (8 or 10). */
export function isAv1SupportedBitDepth(bitDepth: number | undefined): boolean {
  if (bitDepth === undefined) return false;
  return (AV1_POLICY.bitDepths as readonly number[]).includes(bitDepth);
}
