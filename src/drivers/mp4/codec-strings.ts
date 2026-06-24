/**
 * Map MP4 sample-entry codec config (`avcC`, `esds`) to WebCodecs codec strings + the `description`
 * bytes a decoder needs. The codec string must carry profile/level (e.g. `avc1.42E01E`,
 * `mp4a.40.2`) so `isConfigSupported` answers precisely (docs/architecture/10 §6).
 */

import { Reader, readFullBoxHeader } from './reader.ts';

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** `avc1.PPCCLL` from the first bytes of an AVCDecoderConfigurationRecord (`avcC`). */
export function avcCodecString(avcC: Uint8Array): string {
  const profile = avcC[1] ?? 0;
  const compat = avcC[2] ?? 0;
  const level = avcC[3] ?? 0;
  return `avc1.${(hex2(profile) + hex2(compat) + hex2(level)).toUpperCase()}`;
}

/** Reverse the 32 bits of `x` — HEVC encodes the compatibility flags in reverse bit order (RFC 6381). */
function reverseBits32(x: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) r = (r << 1) | ((x >>> i) & 1);
  return r >>> 0;
}

/**
 * `hvc1.PPP.CC.TLL.BB…` from an HEVCDecoderConfigurationRecord (`hvcC`), per RFC 6381: profile-space
 * (A/B/C or none) + profile-idc, the 32-bit compatibility flags as bit-reversed hex, tier (L/H) +
 * level-idc, then the general_constraint_indicator bytes as hex with trailing zero bytes omitted.
 */
export function hevcCodecString(prefix: string, hvcC: Uint8Array): string {
  const dv = new DataView(hvcC.buffer, hvcC.byteOffset, hvcC.byteLength);
  const b1 = dv.getUint8(1);
  const profileSpace = (b1 >> 6) & 0x3;
  const profileIdc = b1 & 0x1f;
  const tierFlag = (b1 >> 5) & 0x1;
  const compat = reverseBits32(dv.getUint32(2));
  const levelIdc = dv.getUint8(12);
  const space = profileSpace === 0 ? '' : String.fromCharCode(0x40 + profileSpace); // 1→A 2→B 3→C
  let out = `${prefix}.${space}${profileIdc}.${compat.toString(16).toUpperCase()}.${tierFlag ? 'H' : 'L'}${levelIdc}`;
  let last = 5;
  while (last >= 0 && dv.getUint8(6 + last) === 0) last--;
  for (let i = 0; i <= last; i++) out += `.${hex2(dv.getUint8(6 + i)).toUpperCase()}`;
  return out;
}

/** `av01.P.LLT.DD` from an AV1CodecConfigurationRecord (`av1C`), per the AV1-ISOBMFF binding. */
export function av1CodecString(av1C: Uint8Array): string {
  const dv = new DataView(av1C.buffer, av1C.byteOffset, av1C.byteLength);
  const b1 = dv.getUint8(1);
  const b2 = dv.getUint8(2);
  const seqProfile = (b1 >> 5) & 0x7;
  const seqLevelIdx = b1 & 0x1f;
  const seqTier = (b2 >> 7) & 0x1;
  const highBitdepth = (b2 >> 6) & 0x1;
  const twelveBit = (b2 >> 5) & 0x1;
  const bitDepth =
    seqProfile === 2 && highBitdepth === 1 ? (twelveBit ? 12 : 10) : highBitdepth ? 10 : 8;
  const level = seqLevelIdx.toString().padStart(2, '0');
  return `av01.${seqProfile}.${level}${seqTier ? 'H' : 'M'}.${bitDepth.toString().padStart(2, '0')}`;
}

export interface EsdsInfo {
  codec: string;
  objectTypeIndication: number;
  audioObjectType?: number;
  /** AudioSpecificConfig — the `description` for an AAC `AudioDecoderConfig`. */
  asc?: Uint8Array;
}

const TAG_ES = 0x03;
const TAG_DECODER_CONFIG = 0x04;
const TAG_DECODER_SPECIFIC = 0x05;

/** Variable-length descriptor size (each byte: 7 bits + continuation flag). */
function readDescriptorLen(r: Reader): number {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = r.u8();
    len = (len << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return len;
}

/** Parse an `esds` box payload into the AAC codec string + AudioSpecificConfig. */
export function parseEsds(esds: Uint8Array): EsdsInfo {
  const r = new Reader(esds);
  readFullBoxHeader(r); // version + flags

  if (r.u8() !== TAG_ES) return { codec: 'mp4a', objectTypeIndication: 0 };
  readDescriptorLen(r);
  r.u16(); // ES_ID
  const esFlags = r.u8();
  if (esFlags & 0x80) r.u16(); // streamDependence
  if (esFlags & 0x40) r.skip(r.u8()); // URL
  if (esFlags & 0x20) r.u16(); // OCR stream

  if (r.u8() !== TAG_DECODER_CONFIG) return { codec: 'mp4a', objectTypeIndication: 0 };
  readDescriptorLen(r);
  const oti = r.u8(); // 0x40 = MPEG-4 Audio
  r.skip(1 + 3 + 4 + 4); // streamType/upstream/reserved + bufferSizeDB + max/avg bitrate

  let asc: Uint8Array | undefined;
  let audioObjectType: number | undefined;
  if (r.remaining > 1 && r.u8() === TAG_DECODER_SPECIFIC) {
    const len = readDescriptorLen(r);
    asc = r.bytes(len).slice();
    audioObjectType = (asc[0] ?? 0) >> 3;
  }

  const codec =
    oti === 0x40 && audioObjectType !== undefined
      ? `mp4a.40.${audioObjectType}`
      : `mp4a.${hex2(oti)}`;
  return {
    codec,
    objectTypeIndication: oti,
    ...(audioObjectType !== undefined ? { audioObjectType } : {}),
    ...(asc ? { asc } : {}),
  };
}
