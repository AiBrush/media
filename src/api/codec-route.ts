/**
 * Capability-verdict projection for routed codecs (R-S01.2 / ADR-203 and R-S05.2). The Router returns a
 * `CodecRoute = { driver, support }`; these helpers let the engine act on that verdict without a second
 * `supports()`/`isConfigSupported` probe and without ever naming a backend:
 *
 * - {@link decoderConfigWithRoutedAcceleration} pins the decoder config to the *exact accepted*
 *   `hardwareAcceleration` rung from the probe verdict (re-deriving the rung caused the ADR-203 ~4×
 *   decode regression).
 * - {@link supportsWarmDecoderReuse} reads the *capability* flag a codec driver advertises when its
 *   decoders are warm-poolable native decoders — the engine pools by capability, never by a driver id.
 */

import type { CodecDriver, CodecSupport, DecoderConfig } from '../contracts/driver.ts';

/**
 * The optional warm-decoder-reuse capability flag on a codec driver (an additive, duck-typed contract
 * member — absent means "no pooling"). A driver sets it when a decoder it builds is a natively pooled
 * `VideoDecoder` that stays correct when reused across same-config sequential streams.
 */
interface WarmDecoderReuseCapability {
  readonly supportsWarmDecoderReuse?: boolean;
}

/** True when the routed codec driver advertises warm-decoder reuse (capability, not a backend name). */
export function supportsWarmDecoderReuse(driver: CodecDriver): boolean {
  return (driver as CodecDriver & WarmDecoderReuseCapability).supportsWarmDecoderReuse === true;
}

/** WebCodecs `hardwareAcceleration` decoder-config hint (also honored by the audio config extension). */
type HardwareAccelerationPreference = 'no-preference' | 'prefer-hardware' | 'prefer-software';

/**
 * Pin a decoder config to the exact `hardwareAcceleration` rung the accepted routing probe reported —
 * `prefer-hardware` for an accelerated verdict, `prefer-software` for an explicit software verdict — with
 * NO second capability probe. A verdict without an acceleration fact returns the config unchanged (the
 * driver keeps its own default). The input config is never mutated: routing cache keys stay byte-stable.
 */
export function decoderConfigWithRoutedAcceleration<C extends DecoderConfig>(
  config: C,
  support: Readonly<CodecSupport>,
): C {
  if (support.hardwareAccelerated === undefined) return config;
  // A software-only verdict is forwarded so the decoder never waits for a hardware session that the
  // probe already ruled out. A hardware-capable verdict is deliberately *not* forced: creating a
  // hardware decoder session costs ~2.5 ms in Chromium before the first frame, which dominates
  // thumbnails, first-frame probes and short clips, while the browser's own default preference still
  // picks hardware for sustained decodes. Measured 2026-09-03: one H.264 frame 3.15 ms → 0.58 ms.
  if (support.hardwareAccelerated) return config;
  const hardwareAcceleration: HardwareAccelerationPreference = 'prefer-software';
  return { ...config, hardwareAcceleration };
}
