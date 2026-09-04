/**
 * The ids of the first-party container drivers, as a dependency-free constant the eager engine can
 * consult without importing the driver bundle (the defaults module registers exactly these ids).
 */
export const FIRST_PARTY_CONTAINER_IDS = [
  'adts',
  'aiff',
  'avi',
  'caf',
  'flac',
  'mp3',
  'mp4',
  'mpegts',
  'ogg',
  'wav',
  'webm',
] as const;

export const FIRST_PARTY_CONTAINER_ID_SET: ReadonlySet<string> = new Set(FIRST_PARTY_CONTAINER_IDS);
