/**
 * The single container-token → MIME table shared by the engine (output materialization, HLS gating) and
 * the preload planner (container warmup queries). Exactly one definition exists (R-S05.3): duplicating it
 * created two sources of truth that could silently diverge per container family.
 */

export const CONTAINER_MIME: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  adts: 'audio/aac',
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpegts: 'video/mp2t',
};

/** Materialize options carrying the container's MIME type when known. */
export function mimeOpts(
  signal: AbortSignal,
  container: string,
): { signal: AbortSignal; mime?: string } {
  const mime = CONTAINER_MIME[container];
  return mime ? { signal, mime } : { signal };
}
