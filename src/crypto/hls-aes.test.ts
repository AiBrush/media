/**
 * HLS `AES-128` (AES-128-CBC + PKCS#7) segment decryption — byte-exact recovery of a REAL media payload.
 * The ciphertext is produced by an INDEPENDENT `node:crypto` AES-128-CBC encryption (not by our own
 * code), so {@link decryptHlsAes128} recovering the original bytes is a true external oracle, not a self
 * round-trip. The `.ts`/`.adts` corpus byte stream stands in for an encrypted HLS media segment.
 */

import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InputError, MediaError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { aesCbcNoPadding, hexToBytes } from './aes.ts';
import { decryptHlsAes128, decryptHlsSampleAesTs } from './hls-aes.ts';

const KEY = hexToBytes('000102030405060708090a0b0c0d0e0f');
const IV = hexToBytes('00112233445566778899aabbccddeeff');

/** AES-128-CBC + PKCS#7 encrypt with the Node stdlib — the external truth the decryptor must invert. */
function nodeEncryptAes128Cbc(data: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-128-cbc', Buffer.from(KEY), Buffer.from(IV)); // PKCS#7 padding by default
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
}

function tsPacket(pid: number, payload: Uint8Array, payloadUnitStart = false): Uint8Array {
  const out = new Uint8Array(188);
  out.fill(0xff);
  out[0] = 0x47;
  out[1] = ((payloadUnitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f)) & 0xff;
  out[2] = pid & 0xff;
  out[3] = 0x10;
  out.set(payload.subarray(0, 184), 4);
  return out;
}

function scrambledTsPacket(pid: number): Uint8Array {
  const out = tsPacket(pid, new Uint8Array([0]), false);
  out[3] = 0x90;
  return out;
}

function tsSegment(...packets: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(packets.reduce((n, packet) => n + packet.byteLength, 0));
  let offset = 0;
  for (const packet of packets) {
    out.set(packet, offset);
    offset += packet.byteLength;
  }
  return out;
}

function patPacket(pmtPid: number): Uint8Array {
  return tsPacket(
    0x0000,
    new Uint8Array([
      0x00,
      0x00,
      0xb0,
      0x0d,
      0x00,
      0x01,
      0xc1,
      0x00,
      0x00,
      0x00,
      0x01,
      0xe0 | ((pmtPid >> 8) & 0x1f),
      pmtPid & 0xff,
      0x00,
      0x00,
      0x00,
      0x00,
    ]),
    true,
  );
}

function pmtPacket(streamPid: number, streamType: number): Uint8Array {
  return tsPacket(
    0x0100,
    new Uint8Array([
      0x00,
      0x02,
      0xb0,
      0x12,
      0x00,
      0x01,
      0xc1,
      0x00,
      0x00,
      0xe0,
      0x00,
      0xf0,
      0x00,
      streamType,
      0xe0 | ((streamPid >> 8) & 0x1f),
      streamPid & 0xff,
      0xf0,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]),
    true,
  );
}

function h264PesPacket(streamPid: number): Uint8Array {
  return pesPacket(streamPid, 0xe0, new Uint8Array([0x00, 0x00, 0x01, 0x09]));
}

function pesPacket(streamPid: number, streamId: number, payload: Uint8Array): Uint8Array {
  return tsPacket(
    streamPid,
    new Uint8Array([0x00, 0x00, 0x01, streamId, 0x00, 0x00, 0x80, 0x00, 0x00, ...payload]),
    true,
  );
}

function h264SamplePayload(): Uint8Array {
  const nalStart = 4;
  const encryptedOffset = nalStart + 32;
  const payload = new Uint8Array(encryptedOffset + 17);
  payload.set([0x00, 0x00, 0x00, 0x01, 0x65]);
  for (let i = nalStart + 1; i < payload.byteLength; i += 1) payload[i] = i & 0xff;
  return payload;
}

function aacSamplePayload(): Uint8Array {
  const frameLength = 32;
  const payload = new Uint8Array(frameLength);
  payload[0] = 0xff;
  payload[1] = 0xf1;
  payload[2] = 0x50;
  payload[3] = 0x80 | ((frameLength >> 11) & 0x03);
  payload[4] = (frameLength >> 3) & 0xff;
  payload[5] = ((frameLength & 0x07) << 5) | 0x1f;
  payload[6] = 0xfc;
  for (let i = 7; i < payload.byteLength; i += 1) payload[i] = (i * 3) & 0xff;
  return payload;
}

async function encryptSampleBlock(payload: Uint8Array, offset: number): Promise<Uint8Array> {
  const out = payload.slice();
  const encrypted = await aesCbcNoPadding(KEY, IV, out.subarray(offset, offset + 16), 'encrypt');
  out.set(encrypted, offset);
  return out;
}

describe('decryptHlsAes128 — full-segment AES-128 on real media (node:crypto oracle)', () => {
  it('recovers the exact original segment bytes for a real .adts payload', async () => {
    const segment = await loadFixture('sfx.adts');
    expect(segment.byteLength).toBeGreaterThan(64);
    const cipher = nodeEncryptAes128Cbc(segment);
    expect(cipher.byteLength % 16).toBe(0);
    expect([...cipher.subarray(0, 16)]).not.toEqual([...segment.subarray(0, 16)]); // real encryption

    const clear = await decryptHlsAes128(cipher, KEY, IV);
    expect([...clear]).toEqual([...segment]); // byte-exact
  });

  it('a wrong key does NOT recover the cleartext (invalid PKCS#7 → throws, or wrong bytes)', async () => {
    const segment = await loadFixture('sfx.adts');
    const cipher = nodeEncryptAes128Cbc(segment);
    const wrong = hexToBytes('ffffffffffffffffffffffffffffffff');
    const got = await decryptHlsAes128(cipher, wrong, IV).then(
      (b) => b,
      () => undefined, // a wrong key usually trips PKCS#7 validation (SubtleCrypto OperationError)
    );
    if (got) expect([...got]).not.toEqual([...segment]);
  });

  it('rejects a non-block-aligned payload, a short key, and a short IV with InputError', async () => {
    const ok = nodeEncryptAes128Cbc(await loadFixture('sfx.adts'));
    await expect(decryptHlsAes128(ok.subarray(0, ok.byteLength - 1), KEY, IV)).rejects.toThrow(
      InputError,
    );
    await expect(decryptHlsAes128(ok, hexToBytes('0011'), IV)).rejects.toThrow(InputError);
    await expect(decryptHlsAes128(ok, KEY, hexToBytes('0011'))).rejects.toThrow(InputError);
    await expect(decryptHlsAes128(new Uint8Array(0), KEY, IV)).rejects.toThrow(InputError);
  });
});

describe('decryptHlsSampleAesTs — typed negative paths for malformed SAMPLE-AES TS', () => {
  it('rejects malformed key material, empty payloads, and non-TS data with typed InputError', async () => {
    await expect(
      decryptHlsSampleAesTs(new Uint8Array([0x47]), hexToBytes('0011'), IV),
    ).rejects.toThrow(InputError);
    await expect(
      decryptHlsSampleAesTs(new Uint8Array([0x47]), KEY, hexToBytes('0011')),
    ).rejects.toThrow(InputError);
    await expect(decryptHlsSampleAesTs(new Uint8Array(0), KEY, IV)).rejects.toThrow(InputError);
    await expect(decryptHlsSampleAesTs(new Uint8Array([1, 2, 3, 4]), KEY, IV)).rejects.toThrow(
      InputError,
    );
  });

  it('distinguishes transport scrambling, absent streams, and clear SAMPLE-AES streams', async () => {
    const scrambled = tsSegment(scrambledTsPacket(0x0101), scrambledTsPacket(0x0101));
    await expect(decryptHlsSampleAesTs(scrambled, KEY, IV)).rejects.toThrow(InputError);

    const noStreams = tsSegment(
      tsPacket(0x0020, new Uint8Array([1])),
      tsPacket(0x0020, new Uint8Array([2])),
    );
    await expect(decryptHlsSampleAesTs(noStreams, KEY, IV)).rejects.toThrow(MediaError);

    const h264NoEncryptedBlocks = tsSegment(
      patPacket(0x0100),
      pmtPacket(0x0101, 0x1b),
      h264PesPacket(0x0101),
    );
    await expect(decryptHlsSampleAesTs(h264NoEncryptedBlocks, KEY, IV)).rejects.toThrow(MediaError);
  });

  it('skips malformed TS packets and invalid PSI sections without accepting them as SAMPLE-AES', async () => {
    const patWithBadPointer = tsPacket(0x0000, new Uint8Array([0xff]), true);
    const teiPacket = tsPacket(0x0020, new Uint8Array([1]));
    teiPacket[1] = (teiPacket[1] ?? 0) | 0x80;
    const reservedControlPacket = tsPacket(0x0021, new Uint8Array([2]));
    reservedControlPacket[3] = 0x00;
    const adaptationOnlyPacket = tsPacket(0x0022, new Uint8Array([0]));
    adaptationOnlyPacket[3] = 0x20;
    adaptationOnlyPacket[4] = 0x00;
    const invalidPmt = tsPacket(
      0x0100,
      new Uint8Array([
        0x00, 0x03, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe0, 0x00, 0xf0, 0x00, 0x00, 0x00,
        0x00, 0x00,
      ]),
      true,
    );
    const malformed = tsSegment(
      patWithBadPointer,
      teiPacket,
      tsPacket(0x1fff, new Uint8Array([3])),
      reservedControlPacket,
      adaptationOnlyPacket,
      patPacket(0x0100),
      invalidPmt,
    );

    await expect(decryptHlsSampleAesTs(malformed, KEY, IV)).rejects.toThrow(MediaError);
  });

  it('decrypts protected H.264 slice and AAC frame blocks while preserving TS framing', async () => {
    const h264ClearPayload = h264SamplePayload();
    const h264CipherPayload = await encryptSampleBlock(h264ClearPayload, 36);
    const h264Clear = tsSegment(
      patPacket(0x0100),
      pmtPacket(0x0101, 0x1b),
      pesPacket(0x0101, 0xe0, h264ClearPayload),
    );
    const h264Cipher = tsSegment(
      patPacket(0x0100),
      pmtPacket(0x0101, 0x1b),
      pesPacket(0x0101, 0xe0, h264CipherPayload),
    );
    expect([...h264Cipher]).not.toEqual([...h264Clear]);
    await expect(decryptHlsSampleAesTs(h264Cipher, KEY, IV)).resolves.toEqual(h264Clear);

    const aacClearPayload = aacSamplePayload();
    const aacCipherPayload = await encryptSampleBlock(aacClearPayload, 16);
    const aacClear = tsSegment(
      patPacket(0x0100),
      pmtPacket(0x0101, 0x0f),
      pesPacket(0x0101, 0xc0, aacClearPayload),
    );
    const aacCipher = tsSegment(
      patPacket(0x0100),
      pmtPacket(0x0101, 0x0f),
      pesPacket(0x0101, 0xc0, aacCipherPayload),
    );
    expect([...aacCipher]).not.toEqual([...aacClear]);
    await expect(decryptHlsSampleAesTs(aacCipher, KEY, IV)).resolves.toEqual(aacClear);
  });
});
