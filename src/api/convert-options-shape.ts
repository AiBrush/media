/**
 * Unknown-key rejection for the direct `convert()` option objects.
 *
 * The declarative job surface already refuses an unknown field (`job-schema-targets.ts`), but the direct
 * call path accepted any extra property and silently dropped it. A caller that builds options at runtime
 * — from a form, a config file, or a hand-written object — could ask for `{ container: 'mp4', crop }` and
 * receive a WebM with no crop applied and no error, which §5.5 forbids: a requested control must be
 * applied, explicitly downgraded, or rejected before expensive work begins. Structural typing makes this
 * unreachable only for a caller passing an exact object literal; every widened or dynamically built
 * options value reaches here untyped.
 *
 * The check is a key-name scan, so it costs nothing measurable next to the operation it guards.
 */

import { InputError } from '../contracts/errors.ts';

const CONVERT_OPTION_KEYS = [
  'to',
  'video',
  'audio',
  'faststart',
  'maximumPacketCount',
  'fragmented',
  'sink',
] as const;

const VIDEO_TARGET_KEYS = [
  'codec',
  'width',
  'height',
  'fit',
  'fps',
  'bitrate',
  'maxAverageBitrate',
  'quality',
  'bitrateMode',
  'crf',
  'twoPass',
  'bitDepth',
  'alpha',
  'rotate',
  'flip',
  'crop',
  'pad',
  'colorspace',
  'tonemap',
] as const;

const AUDIO_TARGET_KEYS = [
  'codec',
  'sampleRate',
  'channels',
  'bitrate',
  'gainDb',
  'fade',
  'mixMatrix',
  'dynamics',
  'biquad',
] as const;

/** Suggest the intended field when an unknown key is a near miss for a real one (one edit away). */
function nearestKey(key: string, allowed: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  return allowed.find((candidate) => candidate.toLowerCase() === lower);
}

function assertKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== 'object' || value === null) return;
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const suggestion = nearestKey(key, allowed);
    throw new InputError(
      suggestion === undefined
        ? `${label} has unknown field '${key}'`
        : `${label} has unknown field '${key}' (did you mean '${suggestion}'?)`,
    );
  }
}

/**
 * Reject an unknown field anywhere in a `convert()` options object, before any input byte is read.
 * A `false` video/audio target is the documented "drop this track" value and carries no fields.
 */
export function assertConvertOptionsShape(options: unknown): void {
  assertKeys(options, CONVERT_OPTION_KEYS, 'convert options');
  if (typeof options !== 'object' || options === null) return;
  const { video, audio } = options as { video?: unknown; audio?: unknown };
  if (video !== false) assertKeys(video, VIDEO_TARGET_KEYS, 'convert options video target');
  if (audio !== false) assertKeys(audio, AUDIO_TARGET_KEYS, 'convert options audio target');
}
