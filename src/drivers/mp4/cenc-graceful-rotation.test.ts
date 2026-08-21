/**
 * CENC AES-CTR mutation robustness over real media, independent of the acceptance harness.
 *
 * Positive rotation: five real MP4s are encrypted through the test-only ISO CENC writer and the public
 * decrypt operation must recover every protected AVC sample byte-exactly. Negative fragmentation:
 * Bento4 authors a real fragmented CENC MP4, then one bit in the first per-sample IV is changed while
 * every box, count, range, and key identifier remains structurally valid. CTR has no authentication tag,
 * so the browser codec boundary must reject the damaged recovery before an output Blob is returned.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { type MediaInput, fromBytes } from '../../sources/source.ts';
import { encryptCenc } from '../../test-support/cenc-encrypt.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { parseSenc } from './cenc.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';

const KEY = '000102030405060708090a0b0c0d0e0f';
const KID = '00112233445566778899aabbccddeeff';
const REAL_AVC_FIXTURES = [
  'movie_5.mp4',
  'bear-1280x720.mp4',
  'test.mp4',
  'bear-non-square-pixel.mp4',
  'bear-rotate-90.mp4',
] as const;

const ra = (bytes: Uint8Array) => ({
  read: (offset: number, length: number): Promise<Uint8Array> =>
    Promise.resolve(bytes.subarray(offset, offset + length)),
  size: bytes.byteLength,
});

async function videoSamples(mp4: Uint8Array): Promise<Uint8Array[]> {
  const movie = await readMovie(ra(mp4));
  const tracks = await muxTracksFromMovie(ra(mp4), movie);
  return (tracks.find((track) => track.mediaType === 'video')?.samples ?? []).map(
    (sample) => sample.data,
  );
}

async function decryptBytes(input: MediaInput): Promise<Uint8Array> {
  const output = await createMedia().decrypt(input, { scheme: 'cenc', keys: { [KID]: KEY } });
  if (!(output instanceof Blob)) throw new Error('expected decrypt to return a Blob');
  return new Uint8Array(await output.arrayBuffer());
}

interface LocatedBox {
  payloadStart: number;
  end: number;
}

/** Locate a complete box by its fourcc; sufficient for the single-file, ffmpeg-authored test fixture. */
function locateBox(bytes: Uint8Array, fourcc: string): LocatedBox {
  const name = new TextEncoder().encode(fourcc);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let typeStart = 4; typeStart + 4 <= bytes.byteLength; typeStart++) {
    if (name.some((byte, index) => bytes[typeStart + index] !== byte)) continue;
    const boxStart = typeStart - 4;
    const size = view.getUint32(boxStart);
    if (size >= 8 && boxStart + size <= bytes.byteLength) {
      return { payloadStart: typeStart + 4, end: boxStart + size };
    }
  }
  throw new Error(`box '${fourcc}' not found`);
}

/** Flip a bit in IV[0] without changing any `senc` structural field or payload length. */
function mutateFirstSencIv(input: Uint8Array): Uint8Array {
  const output = input.slice();
  const box = locateBox(output, 'senc');
  const payload = output.subarray(box.payloadStart, box.end);
  const ivSize = ([8, 16] as const).find((candidate) => {
    try {
      parseSenc(payload, candidate, 'cenc');
      return true;
    } catch {
      return false;
    }
  });
  if (ivSize === undefined) throw new Error('senc is not valid with an 8- or 16-byte CENC IV');
  const firstIv = box.payloadStart + 8; // full-box version/flags (4) + sample_count (4)
  if (firstIv + ivSize > box.end) throw new Error(`senc has no complete ${ivSize}-byte IV`);
  output[firstIv] = (output[firstIv] ?? 0) ^ 0x01;
  // The mutation is intentionally not a parser trick: count, sizes, subsamples and IV width remain valid.
  expect(() => parseSenc(output.subarray(box.payloadStart, box.end), ivSize, 'cenc')).not.toThrow();
  return output;
}

/** Erase the complete `senc` payload while retaining the surrounding MP4 box graph and sizes. */
function zeroSencProtection(input: Uint8Array): Uint8Array {
  const output = input.slice();
  const box = locateBox(output, 'senc');
  output.fill(0, box.payloadStart, box.end);
  return output;
}

async function withStrictVideoDecoder<T>(
  expectedSamples: readonly Uint8Array[],
  run: () => Promise<T>,
): Promise<T> {
  let decodedSample = 0;
  class TestEncodedVideoChunk {
    readonly data: Uint8Array;

    constructor(init: EncodedVideoChunkInit) {
      this.data = ArrayBuffer.isView(init.data)
        ? new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength)
        : new Uint8Array(init.data);
    }
  }
  class TestVideoDecoder {
    static isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
      return Promise.resolve({ config, supported: true });
    }

    readonly decodeQueueSize = 0;
    state: CodecState = 'unconfigured';
    readonly #output: (frame: VideoFrame) => void;

    constructor(init: VideoDecoderInit) {
      this.#output = init.output;
    }

    configure(_config: VideoDecoderConfig): void {
      this.state = 'configured';
    }

    decode(chunk: EncodedVideoChunk): void {
      const actual = (chunk as unknown as TestEncodedVideoChunk).data;
      const expected = expectedSamples[decodedSample++];
      if (
        expected !== undefined &&
        actual.byteLength === expected.byteLength &&
        !actual.some((byte, index) => byte !== expected[index])
      ) {
        this.#output({ close: (): void => undefined } as VideoFrame);
      }
    }

    flush(): Promise<void> {
      return Promise.resolve();
    }

    reset(): void {
      this.state = 'unconfigured';
    }

    close(): void {
      this.state = 'closed';
    }

    addEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {}
    removeEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {}
  }

  const originalDecoder = globalThis.VideoDecoder;
  const originalChunk = globalThis.EncodedVideoChunk;
  Object.defineProperty(globalThis, 'VideoDecoder', {
    configurable: true,
    value: TestVideoDecoder as unknown as typeof VideoDecoder,
  });
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: TestEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
  });
  try {
    return await run();
  } finally {
    if (originalDecoder === undefined) Reflect.deleteProperty(globalThis, 'VideoDecoder');
    else
      Object.defineProperty(globalThis, 'VideoDecoder', {
        configurable: true,
        value: originalDecoder,
      });
    if (originalChunk === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    else
      Object.defineProperty(globalThis, 'EncodedVideoChunk', {
        configurable: true,
        value: originalChunk,
      });
  }
}

describe('CENC valid + graceful mutation rotation — five real MP4s', () => {
  for (const fixture of REAL_AVC_FIXTURES) {
    it(`${fixture}: exact valid decrypt; zeroed protection and a valid-width IV mutation emit no output`, async () => {
      const clear = await loadFixture(fixture);
      const expected = await videoSamples(clear);
      expect(expected.length).toBeGreaterThan(0);
      const encrypted = await encryptCenc(clear, { keyHex: KEY, kidHex: KID, mediaType: 'video' });
      expect(await videoSamples(encrypted)).not.toEqual(expected);
      expect(
        await videoSamples(await decryptBytes(fromBytes(encrypted, { mime: 'video/mp4' }))),
      ).toEqual(expected);

      const zeroedError = await decryptBytes(
        fromBytes(zeroSencProtection(encrypted), { mime: 'video/mp4' }),
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(zeroedError).toBeInstanceOf(MediaError);
      expect(zeroedError).not.toBeInstanceOf(CapabilityError);

      await withStrictVideoDecoder(expected, async () => {
        const bitflipError = await decryptBytes(
          fromBytes(mutateFirstSencIv(encrypted), { mime: 'video/mp4' }),
        ).then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect(bitflipError).toBeInstanceOf(MediaError);
        expect(bitflipError).not.toBeInstanceOf(CapabilityError);
      });
    });
  }
});

function commandAvailable(command: string): boolean {
  const error = spawnSync(command, [], { stdio: 'ignore' }).error as
    | NodeJS.ErrnoException
    | undefined;
  return error?.code !== 'ENOENT';
}
const bento4Available = commandAvailable('mp4fragment') && commandAvailable('mp4encrypt');
const describeBento4 = bento4Available ? describe : describe.skip;

describeBento4('CENC fragmented senc mutation — real Bento4-authored MP4', () => {
  it('valid decrypt emits exact recovered samples; a structurally-valid IV bitflip is a typed no-output failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aibrush-cenc-graceful-'));
    const fragmentedPath = join(directory, 'clear-fragmented.mp4');
    const encryptedPath = join(directory, 'encrypted-fragmented.mp4');
    try {
      const clearPath = new URL('../../../fixtures/media/bear-1280x720.mp4', import.meta.url)
        .pathname;
      execFileSync('mp4fragment', [clearPath, fragmentedPath], { stdio: 'pipe' });
      execFileSync(
        'mp4encrypt',
        [
          '--method',
          'MPEG-CENC',
          '--key',
          `2:${KEY}:0102030405060708`,
          '--property',
          `2:KID:${KID}`,
          fragmentedPath,
          encryptedPath,
        ],
        { stdio: 'pipe' },
      );
      const encrypted = new Uint8Array(readFileSync(encryptedPath));

      // Bento4 is an independent CENC implementation: its clean encrypted fragments must recover to the
      // original public-corpus AVC samples exactly before the mutation oracle is even exercised.
      const expectedSamples = await videoSamples(await loadFixture('bear-1280x720.mp4'));
      const recovered = await decryptBytes(fromBytes(encrypted, { mime: 'video/mp4' }));
      const recoveredSamples = await videoSamples(recovered);
      expect(recoveredSamples.length).toBeGreaterThan(10);
      expect(recoveredSamples).toEqual(expectedSamples);

      await withStrictVideoDecoder(recoveredSamples, async () => {
        const valid = await decryptBytes(fromBytes(encrypted, { mime: 'video/mp4' }));
        expect(await videoSamples(valid)).toEqual(recoveredSamples);
      });

      await withStrictVideoDecoder(recoveredSamples, async () => {
        const error = await decryptBytes(
          fromBytes(mutateFirstSencIv(encrypted), { mime: 'video/mp4' }),
        ).then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(MediaError);
        expect(error).not.toBeInstanceOf(CapabilityError);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
