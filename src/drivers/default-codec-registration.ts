/**
 * Query-selective first-party native codec registration.
 *
 * A definite automatic WebCodecs audio query can load only the native audio driver. A native support
 * miss, deterministic-software request, non-native pin, or unrelated query retains the complete defaults
 * fallback, including the matching WASM tail.
 */

import type { CodecDriver, CodecQuery, Registry } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import type { Router, StageSelectOptions } from '../kernel/router.ts';

const NATIVE_AUDIO_DRIVER_ID = 'webcodecs-audio';

function mayUseSelectiveNativeAudio(query: CodecQuery, options: StageSelectOptions): boolean {
  return (
    query.mediaType === 'audio' &&
    options.determinism !== 'force-software' &&
    (options.pinDriver === undefined || options.pinDriver === NATIVE_AUDIO_DRIVER_ID)
  );
}

/** Register only WebCodecs audio for a definite eligible query. `false` means use register-all. */
export async function registerDefaultCodecForQuery(
  registry: Registry,
  query: CodecQuery,
  options: StageSelectOptions,
): Promise<boolean> {
  if (!mayUseSelectiveNativeAudio(query, options)) return false;
  const module = await import('../codecs/webcodecs-audio.ts');
  if (!module.isAudioCodecString(query.config.codec.toLowerCase())) return false;
  module.WebCodecsAudioModule.register(registry);
  return true;
}

/** Register the one exact native codec pin before any source/frame ownership begins. */
export async function registerDefaultNativeCodecPin(
  registry: Registry,
  pinDriver: string,
): Promise<boolean> {
  if (pinDriver !== NATIVE_AUDIO_DRIVER_ID) return false;
  (await import('../codecs/webcodecs-audio.ts')).WebCodecsAudioModule.register(registry);
  return true;
}

/** Complete lazy codec miss path: native-audio retry, then the caller-owned register-all fallback. */
export async function pickCodecWithDefaultFallback(
  registry: Registry,
  router: Router,
  query: CodecQuery,
  options: StageSelectOptions,
  registerAll: () => Promise<void>,
): Promise<CodecDriver> {
  if (await registerDefaultCodecForQuery(registry, query, options)) {
    router.clearCache();
    try {
      return await router.pickCodec(query, options);
    } catch (error) {
      if (!(error instanceof CapabilityError)) throw error;
    }
  }
  await registerAll();
  return router.pickCodec(query, options);
}
