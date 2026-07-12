import type { EncodedChunk, Packet, TrackInfo } from '../contracts/driver.ts';

/** Payload/timing truth already validated by a first-party demuxer, without a WebCodecs host wrapper. */
export interface NativePacketChunk {
  readonly timestampUs: number;
  readonly durationUs?: number;
  readonly key: boolean;
  readonly data: Uint8Array;
  readonly dtsUs?: number;
}

export interface NativePacketSource {
  readonly track: TrackInfo;
  isClaimable(): boolean;
  claim(signal: AbortSignal): Promise<readonly NativePacketChunk[]>;
}

const sources = new WeakMap<ReadableStream<EncodedChunk | Packet>, NativePacketSource>();

const TRACK_KEYS = [
  'id',
  'mediaType',
  'codec',
  'nonMedia',
  'durationSec',
  'fps',
  'rotation',
  'encrypted',
  'alpha',
  'containerSideData',
  'containerProjection',
  'codecDelayNs',
  'seekPreRollNs',
  'config',
  'color',
  'gapless',
] as const;

const TRACK_SCALAR_KEYS = [
  'id',
  'mediaType',
  'codec',
  'nonMedia',
  'durationSec',
  'fps',
  'rotation',
  'encrypted',
  'alpha',
  'codecDelayNs',
  'seekPreRollNs',
] as const;

const VIDEO_CONFIG_KEYS = [
  'codec',
  'codedHeight',
  'codedWidth',
  'colorSpace',
  'description',
  'displayAspectHeight',
  'displayAspectWidth',
  'hardwareAcceleration',
  'optimizeForLatency',
] as const;

const AUDIO_CONFIG_KEYS = ['codec', 'description', 'numberOfChannels', 'sampleRate'] as const;
const VIDEO_COLOR_SPACE_KEYS = ['fullRange', 'matrix', 'primaries', 'transfer'] as const;
const TRACK_COLOR_KEYS = [
  'matrixCoefficients',
  'bitsPerChannel',
  'chromaSubsamplingHorz',
  'chromaSubsamplingVert',
  'cbSubsamplingHorz',
  'cbSubsamplingVert',
  'chromaSitingHorz',
  'chromaSitingVert',
  'range',
  'transferCharacteristics',
  'primaries',
  'maxCll',
  'maxFall',
] as const;
const GAPLESS_KEYS = ['basis', 'leadingSamples', 'trailingSamples', 'totalSamples'] as const;
const PROJECTION_KEYS = ['kind', 'sideDataIndex', 'attachmentIndex'] as const;
const SIDE_DATA_KEYS = ['kind', 'attachedFilePayloads'] as const;

interface KnownRecord extends Readonly<Record<string, unknown>> {
  readonly description?: unknown;
  readonly colorSpace?: unknown;
  readonly kind?: unknown;
  readonly attachedFilePayloads?: unknown;
  readonly color?: unknown;
  readonly gapless?: unknown;
  readonly containerProjection?: unknown;
  readonly containerSideData?: unknown;
  readonly config?: unknown;
}

function knownRecord(value: unknown, keys: readonly string[]): KnownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) return undefined;
  }
  return value as KnownRecord;
}

function sameScalars(left: KnownRecord, right: KnownRecord, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (Object.hasOwn(left, key) !== Object.hasOwn(right, key)) return false;
    if (Object.hasOwn(left, key) && !Object.is(left[key], right[key])) return false;
  }
  return true;
}

function sameKnownScalars(left: unknown, right: unknown, keys: readonly string[]): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftRecord = knownRecord(left, keys);
  const rightRecord = knownRecord(right, keys);
  return (
    leftRecord !== undefined &&
    rightRecord !== undefined &&
    sameScalars(leftRecord, rightRecord, keys)
  );
}

function byteView(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function sameBufferSource(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftBytes = byteView(left);
  const rightBytes = byteView(right);
  if (
    leftBytes === undefined ||
    rightBytes === undefined ||
    Object.getPrototypeOf(left) !== Object.getPrototypeOf(right) ||
    leftBytes.byteLength !== rightBytes.byteLength
  ) {
    return false;
  }
  for (let index = 0; index < leftBytes.byteLength; index++) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

function sameConfig(left: unknown, right: unknown, mediaType: TrackInfo['mediaType']): boolean {
  if (left === undefined || right === undefined) return left === right;
  const keys = mediaType === 'video' ? VIDEO_CONFIG_KEYS : AUDIO_CONFIG_KEYS;
  const leftConfig = knownRecord(left, keys);
  const rightConfig = knownRecord(right, keys);
  if (leftConfig === undefined || rightConfig === undefined) return false;
  const scalarKeys = keys.filter((key) => key !== 'description' && key !== 'colorSpace');
  if (!sameScalars(leftConfig, rightConfig, scalarKeys)) return false;
  if (!sameBufferSource(leftConfig.description, rightConfig.description)) return false;
  return mediaType === 'audio'
    ? true
    : sameKnownScalars(leftConfig.colorSpace, rightConfig.colorSpace, VIDEO_COLOR_SPACE_KEYS);
}

function ordinaryArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string') return undefined;
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      return undefined;
    }
  }
  return value;
}

function sameSideData(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftItems = ordinaryArray(left);
  const rightItems = ordinaryArray(right);
  if (
    leftItems === undefined ||
    rightItems === undefined ||
    leftItems.length !== rightItems.length
  ) {
    return false;
  }
  for (let index = 0; index < leftItems.length; index++) {
    const leftItem = knownRecord(leftItems[index], SIDE_DATA_KEYS);
    const rightItem = knownRecord(rightItems[index], SIDE_DATA_KEYS);
    if (
      leftItem === undefined ||
      rightItem === undefined ||
      leftItem.kind !== 'matroska-attachments' ||
      rightItem.kind !== leftItem.kind
    ) {
      return false;
    }
    const leftPayloads = ordinaryArray(leftItem.attachedFilePayloads);
    const rightPayloads = ordinaryArray(rightItem.attachedFilePayloads);
    if (
      leftPayloads === undefined ||
      rightPayloads === undefined ||
      leftPayloads.length !== rightPayloads.length
    ) {
      return false;
    }
    for (let payloadIndex = 0; payloadIndex < leftPayloads.length; payloadIndex++) {
      const leftPayload = leftPayloads[payloadIndex];
      const rightPayload = rightPayloads[payloadIndex];
      if (
        !(leftPayload instanceof Uint8Array) ||
        !(rightPayload instanceof Uint8Array) ||
        !sameBufferSource(leftPayload, rightPayload)
      ) {
        return false;
      }
    }
  }
  return true;
}

function sameTrackInfo(left: TrackInfo, right: TrackInfo): boolean {
  if (left === right) return true;
  const leftTrack = knownRecord(left, TRACK_KEYS);
  const rightTrack = knownRecord(right, TRACK_KEYS);
  if (
    leftTrack === undefined ||
    rightTrack === undefined ||
    !sameScalars(leftTrack, rightTrack, TRACK_SCALAR_KEYS) ||
    !sameKnownScalars(leftTrack.color, rightTrack.color, TRACK_COLOR_KEYS) ||
    !sameKnownScalars(leftTrack.gapless, rightTrack.gapless, GAPLESS_KEYS) ||
    !sameKnownScalars(
      leftTrack.containerProjection,
      rightTrack.containerProjection,
      PROJECTION_KEYS,
    ) ||
    !sameSideData(leftTrack.containerSideData, rightTrack.containerSideData)
  ) {
    return false;
  }
  return sameConfig(leftTrack.config, rightTrack.config, left.mediaType);
}

export function registerNativePacketSource(
  stream: ReadableStream<Packet>,
  source: NativePacketSource,
): void {
  sources.set(stream, source);
}

export function nativePacketSource(
  stream: ReadableStream<EncodedChunk | Packet>,
  track: TrackInfo,
): NativePacketSource | undefined {
  if (stream.locked) return undefined;
  const source = sources.get(stream);
  return source !== undefined && sameTrackInfo(source.track, track) ? source : undefined;
}
