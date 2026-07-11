import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { DecryptParams } from '../../contracts/driver.ts';
import { InputError } from '../../contracts/errors.ts';
import { aesCbcPkcs7 } from '../../crypto/aes.ts';
import type { Source } from '../../sources/source.ts';
import { fromBytes } from '../../sources/source.ts';
import { encryptHlsSampleAesTs } from '../../test-support/hls-sample-aes.ts';
import { parseAdts } from '../adts/adts-driver.ts';
import {
  decryptHlsAes128ContainerSegment,
  demandDrivenSegmentStream,
  readHlsSegment,
} from '../hls-full-segment-decrypt.ts';
import { decryptMpegTs, decryptMpegTsSampleAes } from '../mpegts/mpegts-decrypt.ts';
import { parseTs } from '../mpegts/ts-parse.ts';

const ROOT = new URL('../../../fixtures/media-derived/hls-aes128/', import.meta.url).pathname;
const KEY_HEX = '8f2b64a103e75cd94e12bb07f388916c';
const TS_PACKET_BYTES = 188;

interface DirectAesCase {
  readonly cipher: string;
  readonly clear: string;
  readonly iv: string;
}

const TS_CASES: readonly DirectAesCase[] = [
  {
    cipher: 'ffmpeg-explicit-seq47/seg047.ts',
    clear: 'clear/seg000.ts',
    iv: '0000000000000000000000000000002f',
  },
  {
    cipher: 'ffmpeg-explicit-seq47/seg048.ts',
    clear: 'clear/seg001.ts',
    iv: '0000000000000000000000000000002f',
  },
  {
    cipher: 'ffmpeg-explicit-seq47/seg049.ts',
    clear: 'clear/seg002.ts',
    iv: '0000000000000000000000000000002f',
  },
  {
    cipher: 'ffmpeg-explicit-seq47/seg050.ts',
    clear: 'clear/seg003.ts',
    iv: '0000000000000000000000000000002f',
  },
  {
    cipher: 'ffmpeg-explicit-seq47/seg051.ts',
    clear: 'clear/seg004.ts',
    iv: '0000000000000000000000000000002f',
  },
  {
    cipher: 'ffmpeg-explicit-seq47/seg052.ts',
    clear: 'clear/seg005.ts',
    iv: '0000000000000000000000000000002f',
  },
];

const ADTS_CASES: readonly DirectAesCase[] = [
  {
    cipher: 'audio-adts/seg000.aac',
    clear: 'audio-adts/clear000.aac',
    iv: '00000000000000000000000000000000',
  },
  {
    cipher: 'audio-adts/seg001.aac',
    clear: 'audio-adts/clear001.aac',
    iv: '00000000000000000000000000000001',
  },
  {
    cipher: 'audio-adts/seg002.aac',
    clear: 'audio-adts/clear002.aac',
    iv: '00000000000000000000000000000002',
  },
  {
    cipher: 'audio-adts/seg003.aac',
    clear: 'audio-adts/clear003.aac',
    iv: '00000000000000000000000000000003',
  },
  {
    cipher: 'audio-adts/seg004.aac',
    clear: 'audio-adts/clear004.aac',
    iv: '00000000000000000000000000000004',
  },
  {
    cipher: 'audio-adts/seg005.aac',
    clear: 'audio-adts/clear005.aac',
    iv: '00000000000000000000000000000005',
  },
];

async function fixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${ROOT}${path}`));
}

async function outputBytes(value: unknown): Promise<Uint8Array> {
  if (!(value instanceof Blob)) throw new Error('expected a Blob decrypt output');
  return new Uint8Array(await value.arrayBuffer());
}

async function directDecrypt(
  cipher: Uint8Array,
  mime: 'video/mp2t' | 'audio/aac',
  iv: string,
): Promise<Uint8Array> {
  return outputBytes(
    await createMedia().decrypt(fromBytes(cipher, { mime }), {
      scheme: 'hls-aes128',
      keys: { key: KEY_HEX, iv },
    }),
  );
}

function bytesFromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

describe('public direct HLS AES-128 — real MPEG-TS segment matrix', () => {
  it.each(TS_CASES)('$cipher recovers the independent clear twin byte-exactly', async (entry) => {
    const clear = await fixture(entry.clear);
    expect(parseTs(clear).tracks.length).toBe(2);
    const recovered = await directDecrypt(await fixture(entry.cipher), 'video/mp2t', entry.iv);
    expect(recovered).toEqual(clear);
    expect(parseTs(recovered).tracks.map((track) => track.stream.codec)).toEqual(['h264', 'aac']);
  });
});

describe('public direct HLS AES-128 — real packed-ADTS segment matrix', () => {
  it.each(ADTS_CASES)('$cipher recovers the independent clear twin byte-exactly', async (entry) => {
    const clear = await fixture(entry.clear);
    const expectedFrames = parseAdts(clear).frames;
    const recovered = await directDecrypt(await fixture(entry.cipher), 'audio/aac', entry.iv);
    expect(recovered).toEqual(clear);
    expect(parseAdts(recovered).frames).toBe(expectedFrames);
  });
});

describe('direct HLS AES-128 failure and lifecycle truth', () => {
  it.each([
    ['MPEG-TS', TS_CASES[0], 'video/mp2t'],
    ['ADTS', ADTS_CASES[0], 'audio/aac'],
  ] as const)(
    '%s rejects a padding-valid wrong IV before emitting plaintext',
    async (_name, entry, mime) => {
      if (entry === undefined) throw new Error('missing direct AES fixture');
      const wrongIv = `ff${entry.iv.slice(2)}`;
      await expect(directDecrypt(await fixture(entry.cipher), mime, wrongIv)).rejects.toMatchObject(
        {
          code: 'demux-error',
        },
      );
    },
  );

  it('keeps full-segment AES-128 and TS SAMPLE-AES strictly disjoint', async () => {
    const entry = TS_CASES[0];
    if (entry === undefined) throw new Error('missing TS AES fixture');
    const adtsEntry = ADTS_CASES[0];
    if (adtsEntry === undefined) throw new Error('missing ADTS AES fixture');
    const clear = await fixture(entry.clear);
    const key = bytesFromHex(KEY_HEX);
    const iv = bytesFromHex(entry.iv);
    const sampleCipher = encryptHlsSampleAesTs(clear, key, iv);

    const sampleRecovered = await outputBytes(
      await createMedia().decrypt(fromBytes(sampleCipher, { mime: 'video/mp2t' }), {
        scheme: 'hls-sample-aes',
        keys: { key: KEY_HEX, iv: entry.iv },
      }),
    );
    expect(sampleRecovered).toEqual(clear);

    await expect(
      createMedia().decrypt(fromBytes(sampleCipher, { mime: 'video/mp2t' }), {
        scheme: 'hls-aes128',
        keys: { key: KEY_HEX, iv: entry.iv },
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input' });
    await expect(
      createMedia().decrypt(fromBytes(await fixture(entry.cipher), { mime: 'video/mp2t' }), {
        scheme: 'hls-sample-aes',
        keys: { key: KEY_HEX, iv: entry.iv },
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input' });
    await expect(
      createMedia().decrypt(fromBytes(await fixture(adtsEntry.cipher), { mime: 'audio/aac' }), {
        scheme: 'hls-sample-aes',
        keys: { key: KEY_HEX, iv: '00000000000000000000000000000000' },
      }),
    ).rejects.toMatchObject({ code: 'capability-miss' });
  });

  it('abort while draining cancels and releases a direct ADTS ciphertext source', async () => {
    const entry = ADTS_CASES[0];
    if (entry === undefined) throw new Error('missing ADTS AES fixture');
    const cipher = await fixture(entry.cipher);
    const abort = new AbortController();
    let cancelled = false;
    let pulled = false;
    const source: Source = {
      __media: 'source',
      kind: 'stream',
      mimeHint: 'audio/aac',
      stream: () =>
        new ReadableStream<Uint8Array>({
          pull(controller): void {
            if (pulled) return;
            pulled = true;
            controller.enqueue(cipher.subarray(0, Math.floor(cipher.byteLength / 2)));
            abort.abort();
          },
          cancel(): void {
            cancelled = true;
          },
        }),
    };

    await expect(
      createMedia().decrypt(
        source,
        { scheme: 'hls-aes128', keys: { key: KEY_HEX, iv: entry.iv } },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(cancelled).toBe(true);
  });

  it('decrypts a range-less, multi-chunk ADTS segment without re-reading or reordering bytes', async () => {
    const entry = ADTS_CASES[1];
    if (entry === undefined) throw new Error('missing chunked ADTS AES fixture');
    const cipher = await fixture(entry.cipher);
    const cuts = [0, 17, Math.floor(cipher.byteLength / 2), cipher.byteLength];
    let streamCalls = 0;
    const source: Source = {
      __media: 'source',
      kind: 'stream',
      mimeHint: 'audio/aac',
      stream: () => {
        streamCalls += 1;
        return new ReadableStream<Uint8Array>({
          start(controller): void {
            for (let index = 0; index + 1 < cuts.length; index += 1) {
              controller.enqueue(cipher.subarray(cuts[index] ?? 0, cuts[index + 1] ?? 0));
            }
            controller.close();
          },
        });
      },
    };
    const recovered = await outputBytes(
      await createMedia().decrypt(source, {
        scheme: 'hls-aes128',
        keys: { key: KEY_HEX, iv: entry.iv },
      }),
    );
    expect(recovered).toEqual(await fixture(entry.clear));
    expect(streamCalls).toBe(1);
  });

  it('a pre-aborted direct segment reads no source bytes', async () => {
    const abort = new AbortController();
    abort.abort();
    let streamCalls = 0;
    const source: Source = {
      __media: 'source',
      kind: 'stream',
      mimeHint: 'audio/aac',
      stream: () => {
        streamCalls += 1;
        return new ReadableStream<Uint8Array>();
      },
    };
    await expect(
      createMedia().decrypt(
        source,
        {
          scheme: 'hls-aes128',
          keys: { key: KEY_HEX, iv: '00000000000000000000000000000000' },
        },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(streamCalls).toBe(0);
  });

  it('rejects missing/malformed key fields before exposing output', async () => {
    const entry = ADTS_CASES[0];
    if (entry === undefined) throw new Error('missing key-validation AES fixture');
    const input = await fixture(entry.cipher);
    await expect(
      createMedia().decrypt(fromBytes(input, { mime: 'audio/aac' }), {
        scheme: 'hls-aes128',
        keys: { key: KEY_HEX },
      }),
    ).rejects.toMatchObject({ code: 'capability-miss' });
    await expect(
      createMedia().decrypt(fromBytes(input, { mime: 'audio/aac' }), {
        scheme: 'hls-aes128',
        keys: { key: 'abc', iv: entry.iv },
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input' });
    await expect(
      createMedia().decrypt(fromBytes(input, { mime: 'audio/aac' }), {
        scheme: 'hls-aes128',
        keys: { key: '0011', iv: entry.iv },
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input' });
  });

  it('wipes a parsed SAMPLE-AES key when IV parsing fails before source ownership', async () => {
    const fill = vi.spyOn(Uint8Array.prototype, 'fill');
    let streamCalls = 0;
    const source: Source = {
      __media: 'source',
      kind: 'stream',
      mimeHint: 'video/mp2t',
      stream: () => {
        streamCalls++;
        return new ReadableStream<Uint8Array>();
      },
    };
    try {
      await expect(
        decryptMpegTsSampleAes(source, {
          scheme: 'hls-sample-aes',
          keys: { key: KEY_HEX, iv: 'abc' },
        }),
      ).rejects.toMatchObject({ code: 'unsupported-input' });
      expect(fill).toHaveBeenCalledWith(0);
      expect(streamCalls).toBe(0);
    } finally {
      fill.mockRestore();
    }
  });

  it.each([
    {
      name: 'invalid known size',
      source: {
        __media: 'source',
        kind: 'bytes',
        mimeHint: 'audio/aac',
        size: -1,
        stream: () => new ReadableStream<Uint8Array>(),
        range: () => Promise.resolve(new Uint8Array()),
      } satisfies Source,
    },
    {
      name: 'non-integer known size',
      source: {
        __media: 'source',
        kind: 'bytes',
        mimeHint: 'audio/aac',
        size: 1.5,
        stream: () => new ReadableStream<Uint8Array>(),
        range: () => Promise.resolve(new Uint8Array()),
      } satisfies Source,
    },
    {
      name: 'range read failure',
      source: {
        __media: 'source',
        kind: 'bytes',
        mimeHint: 'audio/aac',
        size: 16,
        stream: () => new ReadableStream<Uint8Array>(),
        range: () => Promise.reject(new Error('range failed')),
      } satisfies Source,
    },
    {
      name: 'stream read failure',
      source: {
        __media: 'source',
        kind: 'stream',
        mimeHint: 'audio/aac',
        stream: () =>
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.error(new Error('read failed'));
            },
          }),
      } satisfies Source,
    },
    {
      name: 'stream construction failure',
      source: {
        __media: 'source',
        kind: 'stream',
        mimeHint: 'audio/aac',
        stream: (): ReadableStream<Uint8Array> => {
          throw new Error('stream failed');
        },
      } satisfies Source,
    },
  ])('normalizes a $name to a typed input error', async ({ source }) => {
    await expect(
      createMedia().decrypt(source, {
        scheme: 'hls-aes128',
        keys: { key: KEY_HEX, iv: '00000000000000000000000000000000' },
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input' });
  });

  it('the demand-driven output honors abort and cancel before its first pull', async () => {
    const abort = new AbortController();
    const abortedBytes = Uint8Array.of(1, 2, 3);
    const aborted = demandDrivenSegmentStream(abortedBytes, abort.signal);
    abort.abort();
    await expect(aborted.getReader().read()).rejects.toMatchObject({ code: 'aborted' });
    expect(abortedBytes).toEqual(Uint8Array.of(0, 0, 0));

    const cancelledBytes = Uint8Array.of(4, 5, 6);
    const cancelled = demandDrivenSegmentStream(cancelledBytes, undefined);
    await cancelled.cancel();
    expect(cancelledBytes).toEqual(Uint8Array.of(0, 0, 0));
  });

  it('the shared full-segment helper rejects a non-AES-128 scheme without reading', async () => {
    let reads = 0;
    const source: Source = {
      __media: 'source',
      kind: 'bytes',
      size: 0,
      stream: () => new ReadableStream<Uint8Array>(),
      range: () => {
        reads += 1;
        return Promise.resolve(new Uint8Array());
      },
    };
    const options: DecryptParams = { scheme: 'cenc', keys: { key: KEY_HEX } };
    await expect(
      decryptHlsAes128ContainerSegment(source, options, {
        driverId: 'test',
        containerLabel: 'test container',
        validate: () => {},
      }),
    ).rejects.toMatchObject({ code: 'capability-miss' });
    expect(reads).toBe(0);
  });

  it('normalizes wrong-key padding failure and malformed recovered TS structure', async () => {
    const entry = TS_CASES[0];
    if (entry === undefined) throw new Error('missing TS mutation fixture');
    const cipher = await fixture(entry.cipher);
    await expect(
      createMedia().decrypt(fromBytes(cipher, { mime: 'video/mp2t' }), {
        scheme: 'hls-aes128',
        keys: { key: '00000000000000000000000000000000', iv: entry.iv },
      }),
    ).rejects.toMatchObject({ code: 'demux-error' });

    const key = bytesFromHex(KEY_HEX);
    const iv = bytesFromHex(entry.iv);
    const clear = await fixture(entry.clear);
    const partial = new Uint8Array(clear.byteLength + 1);
    partial.set(clear);
    partial[partial.byteLength - 1] = 0xaa;
    const noFraming = new Uint8Array(TS_PACKET_BYTES * 3).fill(0x11);
    for (const malformed of [partial, noFraming]) {
      const encrypted = await aesCbcPkcs7(key, iv, malformed, 'encrypt');
      await expect(
        createMedia().decrypt(fromBytes(encrypted, { mime: 'video/mp2t' }), {
          scheme: 'hls-aes128',
          keys: { key: KEY_HEX, iv: entry.iv },
        }),
      ).rejects.toMatchObject({ code: 'demux-error' });
    }
  });

  it('keeps direct TS dispatcher misses and missing SAMPLE-AES fields typed', async () => {
    const source = fromBytes(new Uint8Array(16), { mime: 'video/mp2t' });
    const cenc: DecryptParams = { scheme: 'cenc', keys: { key: KEY_HEX } };
    await expect(decryptMpegTs(source, cenc)).rejects.toMatchObject({ code: 'capability-miss' });
    await expect(decryptMpegTsSampleAes(source, cenc)).rejects.toMatchObject({
      code: 'capability-miss',
    });
    await expect(
      decryptMpegTsSampleAes(source, { scheme: 'hls-sample-aes', keys: { key: KEY_HEX } }),
    ).rejects.toMatchObject({ code: 'capability-miss' });
  });

  it('preserves typed range errors and maps an abort that races a range failure to aborted', async () => {
    const typed = new InputError('unsupported-input', 'typed range failure');
    const typedSource: Source = {
      __media: 'source',
      kind: 'bytes',
      size: 16,
      stream: () => new ReadableStream<Uint8Array>(),
      range: () => Promise.reject(typed),
    };
    await expect(readHlsSegment(typedSource, undefined)).rejects.toBe(typed);

    const abort = new AbortController();
    const abortSource: Source = {
      __media: 'source',
      kind: 'bytes',
      size: 16,
      stream: () => new ReadableStream<Uint8Array>(),
      range: () => {
        abort.abort();
        return Promise.reject(new Error('range stopped'));
      },
    };
    await expect(readHlsSegment(abortSource, abort.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('wipes recovered plaintext when validation cancels after WebCrypto completes', async () => {
    const entry = ADTS_CASES[0];
    if (entry === undefined) throw new Error('missing post-crypto abort fixture');
    const abort = new AbortController();
    let recovered: Uint8Array | undefined;
    await expect(
      decryptHlsAes128ContainerSegment(
        fromBytes(await fixture(entry.cipher)),
        {
          scheme: 'hls-aes128',
          keys: { key: KEY_HEX, iv: entry.iv },
          signal: abort.signal,
        },
        {
          driverId: 'test',
          containerLabel: 'test container',
          validate: (clear) => {
            recovered = clear;
            abort.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(recovered).toBeDefined();
    expect(recovered?.every((byte) => byte === 0)).toBe(true);
  });

  it('wipes recovered plaintext when structural validation fails', async () => {
    const entry = ADTS_CASES[0];
    if (entry === undefined) throw new Error('missing validation-failure fixture');
    let recovered: Uint8Array | undefined;
    await expect(
      decryptHlsAes128ContainerSegment(
        fromBytes(await fixture(entry.cipher)),
        { scheme: 'hls-aes128', keys: { key: KEY_HEX, iv: entry.iv } },
        {
          driverId: 'test',
          containerLabel: 'test container',
          validate: (clear) => {
            recovered = clear;
            throw new InputError('unsupported-input', 'validation failed');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'demux-error' });
    expect(recovered).toBeDefined();
    expect(recovered?.every((byte) => byte === 0)).toBe(true);
  });

  it('the shared full-segment helper rejects a missing key before reading', async () => {
    let reads = 0;
    const source: Source = {
      __media: 'source',
      kind: 'bytes',
      size: 16,
      stream: () => new ReadableStream<Uint8Array>(),
      range: () => {
        reads += 1;
        return Promise.resolve(new Uint8Array(16));
      },
    };
    await expect(
      decryptHlsAes128ContainerSegment(
        source,
        { scheme: 'hls-aes128', keys: {} },
        { driverId: 'test', containerLabel: 'test container', validate: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'capability-miss' });
    expect(reads).toBe(0);
  });
});
