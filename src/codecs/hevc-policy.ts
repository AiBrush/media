/**
 * HEVC (H.265) policy — native-only, Main/Main10, hardware WebCodecs (REQUIREMENTS §5.5, §6, §8.3, §12).
 *
 * HEVC is subject to patent pools (MPEG LA, HEVC Advance, Velos Media). This package does
 * NOT bundle or redistribute an HEVC decoder or encoder WebAssembly implementation. All
 * HEVC decode and encode routes are hardware/platform-native via WebCodecs
 * (`VideoDecoder`/`VideoEncoder`) where the browser and device expose `hvc1`/`hev1` support.
 * The underlying hardware or OS vendor (Apple, Intel, etc.) provides the licensed
 * implementation; callers that author HEVC-bitstreams should review their own distribution
 * licensing obligations. See `docs/runtime-and-capabilities.md#hevc-licensing` for disclosure
 * and preflight guidance.
 *
 * Capability model:
 *   - parse: true (box parsing via `hvcC` and codec string helpers is pure TypeScript)
 *   - decode: hardware true, software false — no WASM fallback is shipped
 *   - encode: hardware true, software false — no WASM fallback is shipped
 *   - alpha: false (HEVC alpha side-streams are not part of this build's surface)
 *   - bitDepths: [8, 10] — Main 8-bit (`hvc1.1.6.L93.B0`) and Main10 10-bit (`hvc1.2.4.L120.B0`);
 *     other profiles (Main12, 4:4:4, SCC etc.) are intentionally rejected with a typed
 *     `CapabilityError` so a wrong encode is never silently produced.
 *   - Licensing is declared here and surfaced via `hevcLicensingNotice()` for docs and
 *     generated reports — the support matrix row for `hevc` derives from this single source.
 */

export const HEVC_POLICY = {
  codec: 'hevc' as const,
  parse: true as const,
  decode: { hardware: true as const, software: false as const },
  encode: { hardware: true as const, software: false as const },
  alpha: false as const,
  bitDepths: [8, 10] as const,
  channelLayouts: [] as const,
  profiles: ['Main', 'Main10'] as const,
  softwareWasmShipped: false as const,
  licensing: {
    pools: ['MPEG LA', 'HEVC Advance', 'Velos Media'] as const,
    codecBinaryRedistributed: false as const,
    route: 'hardware-only via WebCodecs (platform decoder/encoder)' as const,
  },
} as const;

/** Human-readable licensing disclosure for docs and generated license reports. */
export function hevcLicensingNotice(): string {
  return [
    'HEVC (H.265) in @aibrush/media is hardware-only via WebCodecs.',
    'No HEVC decoder or encoder WebAssembly is bundled or redistributed by this package.',
    'Platform/hardware vendors provide the underlying implementation subject to patent pools',
    '(MPEG LA, HEVC Advance, Velos Media). Review distribution licensing before publishing',
    'HEVC bitstreams. Probe hardware support with VideoDecoder.isConfigSupported /',
    'VideoEncoder.isConfigSupported or media.canConvert() before encoding.',
  ].join(' ');
}

/** Whether this build ships a software (WASM) HEVC decoder — always false (hardware-only). */
export function hevcSoftwareDecodeAvailable(): boolean {
  return false;
}

/** Whether this build ships a software (WASM) HEVC encoder — always false (hardware-only). */
export function hevcSoftwareEncodeAvailable(): boolean {
  return false;
}

/** The bit depths this policy authorizes for HEVC (Main 8, Main10 10). */
export function hevcSupportedBitDepths(): readonly number[] {
  return HEVC_POLICY.bitDepths;
}

/** True when `bitDepth` is an explicitly supported HEVC depth (8 or 10). */
export function isHevcSupportedBitDepth(bitDepth: number | undefined): boolean {
  if (bitDepth === undefined) return false;
  return (HEVC_POLICY.bitDepths as readonly number[]).includes(bitDepth);
}
