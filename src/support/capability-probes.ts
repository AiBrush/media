/**
 * Capability probe policy (REQUIREMENTS §9 — 4.2).
 *
 * Feature support MUST be determined through standards APIs and behavioral
 * probes. User-agent checks MAY select a documented workaround only after a
 * reliable feature probe is impossible. This module is the pure, Node-testable
 * taxonomy for that policy — no browser APIs, no fixture branching, never
 * huge-alloc, deterministic.
 */

export type ProbeCapability =
  | 'webcodecs-video-decode'
  | 'webcodecs-video-encode'
  | 'webcodecs-audio-decode'
  | 'webcodecs-audio-encode'
  | 'webgpu'
  | 'workers'
  | 'opfs'
  | 'range-server'
  | 'isolation'
  | 'image-decoder';

export const PROBE_FIRST_CAPABILITIES: readonly ProbeCapability[] = Object.freeze([
  'webcodecs-video-decode',
  'webcodecs-video-encode',
  'webcodecs-audio-decode',
  'webcodecs-audio-encode',
  'webgpu',
  'workers',
  'opfs',
  'range-server',
  'isolation',
  'image-decoder',
] as const);

// Capabilities where UA fallback is documented as allowed after probe impossible
export const UA_FALLBACK_ALLOWED: readonly ProbeCapability[] = Object.freeze([
  'image-decoder',
] as const);

export function isProbeFirstCapability(value: string): boolean {
  if (typeof value !== 'string') throw new RangeError('capability must be string');
  if (value.length > 40) throw new RangeError('capability too long');
  return (PROBE_FIRST_CAPABILITIES as readonly string[]).includes(value);
}

export function isUaFallbackAllowed(capability: ProbeCapability): boolean {
  if (typeof capability !== 'string') throw new RangeError('capability must be string');
  if (!isProbeFirstCapability(capability)) throw new RangeError(`unknown capability ${capability}`);
  return (UA_FALLBACK_ALLOWED as readonly string[]).includes(capability);
}

/**
 * Whether a user-agent sniff is allowed for this capability given probe status.
 * - If probe succeeded (probePossible true), UA must NOT be used.
 * - If probe is impossible (probePossible false), UA MAY be used only when
 *   documented in UA_FALLBACK_ALLOWED.
 */
export function isUaAllowed(capability: ProbeCapability, probePossible: boolean): boolean {
  if (typeof capability !== 'string') throw new RangeError('capability must be string');
  if (!isProbeFirstCapability(capability)) throw new RangeError(`unknown capability ${capability}`);
  if (typeof probePossible !== 'boolean') throw new RangeError('probePossible must be boolean');
  if (probePossible) return false;
  return isUaFallbackAllowed(capability);
}

/**
 * Assert that a capability was resolved via probe, not UA, unless probe was impossible.
 * Throws RangeError when UA was used but probe was possible or not allowed.
 */
export function assertProbePolicy(
  capability: ProbeCapability,
  resolution: 'probe' | 'ua' | 'not-supported',
  probePossible: boolean,
): void {
  if (typeof capability !== 'string') throw new RangeError('capability must be string');
  if (!isProbeFirstCapability(capability)) throw new RangeError(`unknown capability ${capability}`);
  if (resolution !== 'probe' && resolution !== 'ua' && resolution !== 'not-supported')
    throw new RangeError('resolution must be probe|ua|not-supported');
  if (typeof probePossible !== 'boolean') throw new RangeError('probePossible must be boolean');
  if (resolution === 'ua' && !isUaAllowed(capability, probePossible)) {
    throw new RangeError(
      `UA fallback not allowed for ${capability} when probePossible=${probePossible}`,
    );
  }
}
