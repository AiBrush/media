import type { ByteSource, DecryptParams } from '../../contracts/driver.ts';
import { CapabilityError, InputError } from '../../contracts/errors.ts';
import { hexToBytes } from '../../crypto/aes.ts';
import { decryptHlsSampleAesTs } from '../../crypto/hls-aes.ts';
import {
  assertHlsSegmentClearNotAborted,
  decryptHlsAes128ContainerSegment,
  demandDrivenSegmentStream,
  readHlsSegment,
} from '../hls-full-segment-decrypt.ts';
import { detectFraming, parseTs } from './ts-parse.ts';

function validateMpegTsSegment(clear: Uint8Array): void {
  const framing = detectFraming(clear);
  if (framing === undefined || framing.start !== 0 || clear.byteLength % framing.packetSize !== 0) {
    throw new InputError(
      'unsupported-input',
      'HLS AES-128 plaintext is not a complete packet-aligned MPEG-TS segment',
    );
  }
  parseTs(clear);
}

/** Dispatch direct TS decrypt without ever conflating full-segment AES-128 and SAMPLE-AES. */
export async function decryptMpegTs(
  src: ByteSource,
  o: DecryptParams,
): Promise<ReadableStream<Uint8Array>> {
  if (o.scheme === 'hls-aes128') {
    return decryptHlsAes128ContainerSegment(src, o, {
      driverId: 'mpegts',
      containerLabel: 'MPEG-TS',
      validate: validateMpegTsSegment,
    });
  }
  if (o.scheme === 'hls-sample-aes') return decryptMpegTsSampleAes(src, o);
  throw new CapabilityError('capability-miss', `bad TS decrypt '${o.scheme}'`, {
    op: 'decrypt',
    tried: ['mpegts'],
  });
}

export async function decryptMpegTsSampleAes(
  src: ByteSource,
  o: DecryptParams,
): Promise<ReadableStream<Uint8Array>> {
  if (o.scheme !== 'hls-sample-aes') {
    throw new CapabilityError('capability-miss', `bad TS decrypt '${o.scheme}'`, {
      op: 'decrypt',
      tried: ['mpegts'],
    });
  }
  const { key, iv } = o.keys;
  if (key === undefined || iv === undefined) {
    throw new CapabilityError('capability-miss', 'need key/iv hex', {
      op: 'decrypt',
      tried: ['mpegts'],
    });
  }
  const keyBytes = hexToBytes(key);
  let ivBytes: Uint8Array<ArrayBuffer> | undefined;
  let clear: Uint8Array<ArrayBuffer>;
  try {
    ivBytes = hexToBytes(iv);
    clear = await decryptHlsSampleAesTs(await readHlsSegment(src, o.signal), keyBytes, ivBytes);
  } finally {
    keyBytes.fill(0);
    ivBytes?.fill(0);
  }
  assertHlsSegmentClearNotAborted(clear, o.signal);
  return demandDrivenSegmentStream(clear, o.signal);
}
