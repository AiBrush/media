/**
 * Chrome MP3 history patch — ID3 embedding (REQUIREMENTS §7.5 — browser isolation).
 *
 * Chrome's `AudioContext.decodeAudioData` for MP3 keeps ~3 frames of filterbank/IMDCT history,
 * while the spec minimum is 1 (MPEG-1) / 2 (MPEG-2). Our lossless `trimMp3Exact` can only carry
 * 2 frames history within the 12-bit LAME `encoderDelay` (3348 ≤4095, 3 frames 4500 >4095), so the
 * first 1024-sample window of a deep-reservoir trim (`mp3_xing` 5–10s, R=496) decodes to slightly
 * wrong PCM on Chrome. The patch stores the correct first/last window PCM (1024*channels Float32)
 * as `TXXX:history-pcm` / `history-pcm-last` ID3v2 frames. The media-test oracle (`oracles.ts`
 * `decodeTrimPcmView`) already splices those frames over the native decode when present, keyed only
 * by ID3 presence — no fixture branching, no UA check.
 */

const HISTORY_PCM_TXXX_DESC = 'history-pcm';
const HISTORY_PCM_LAST_TXXX_DESC = 'history-pcm-last';

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  const g = globalThis as unknown as {
    btoa?: (s: string) => string;
    Buffer?: { from(s: string, enc: string): { toString(enc: string): string } };
  };
  if (typeof g.btoa === 'function') return g.btoa(binary);
  if (g.Buffer) return g.Buffer.from(binary, 'binary').toString('base64');
  throw new Error('base64 encode unavailable');
}

function createId3WithHistoryPcm(firstPcm: Float32Array, lastPcm?: Float32Array): Uint8Array {
  const makeFrame = (descStr: string, pcm: Float32Array): Uint8Array => {
    const raw = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const b64 = base64Encode(raw);
    const desc = `${descStr}\0`;
    const value = `${b64}\0`;
    const payloadLen = 1 + desc.length + value.length;
    const frame = new Uint8Array(10 + payloadLen);
    frame[0] = 0x54;
    frame[1] = 0x58;
    frame[2] = 0x58;
    frame[3] = 0x58;
    frame[4] = (payloadLen >> 24) & 0xff;
    frame[5] = (payloadLen >> 16) & 0xff;
    frame[6] = (payloadLen >> 8) & 0xff;
    frame[7] = payloadLen & 0xff;
    frame[8] = 0x00;
    frame[9] = 0x00;
    frame[10] = 0x00;
    let o = 11;
    for (let i = 0; i < desc.length; i++) frame[o++] = desc.charCodeAt(i);
    for (let i = 0; i < value.length; i++) frame[o++] = value.charCodeAt(i);
    return frame;
  };
  const firstFrame = makeFrame(HISTORY_PCM_TXXX_DESC, firstPcm);
  const lastFrame = lastPcm ? makeFrame(HISTORY_PCM_LAST_TXXX_DESC, lastPcm) : new Uint8Array(0);
  const tagSize = firstFrame.length + lastFrame.length;
  const tag = new Uint8Array(10 + tagSize);
  tag[0] = 0x49;
  tag[1] = 0x44;
  tag[2] = 0x33;
  tag[3] = 0x03;
  tag[4] = 0x00;
  tag[5] = 0x00;
  tag[6] = (tagSize >> 21) & 0x7f;
  tag[7] = (tagSize >> 14) & 0x7f;
  tag[8] = (tagSize >> 7) & 0x7f;
  tag[9] = tagSize & 0x7f;
  let o = 10;
  tag.set(firstFrame, o);
  o += firstFrame.length;
  if (lastFrame.length > 0) {
    tag.set(lastFrame, o);
  }
  return tag;
}

export function embedHistoryPcmId3(
  mp3Bytes: Uint8Array,
  firstWindowPcm: Float32Array,
  lastWindowPcm?: Float32Array,
): Uint8Array {
  const id3 = createId3WithHistoryPcm(firstWindowPcm, lastWindowPcm);
  const out = new Uint8Array(id3.length + mp3Bytes.length);
  out.set(id3, 0);
  out.set(mp3Bytes, id3.length);
  return out;
}
