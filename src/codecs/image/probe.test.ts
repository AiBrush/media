/**
 * Image probe — strict-oracle validation on REAL downloaded media (BUILD §6.1: ≥5 diverse real files,
 * never a hand-forged byte array). Ground truth is produced by INDEPENDENT tools, so the oracle can fail:
 *   • pixel dimensions ← macOS `sips -g pixelWidth -g pixelHeight`
 *   • animated-GIF frame count/duration ← `ffprobe -count_frames` (36 frames, 0.82 s for the
 *     Newton's-cradle GIF)
 * Fixtures live in fixtures/media-derived/img/ (committed; provenance in that dir's README). Additional
 * spec-minimal byte streams below exercise alternate parser branches with concrete metadata assertions;
 * they are unit coverage for header syntax, not substitutes for the real-corpus oracle. The decode path is
 * browser-only (ImageDecoder) and is exercised by the harness; this suite locks the pure parser.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InputError } from '../../contracts/errors.ts';
import {
  type ImageFormat,
  probeAvif,
  probeGif,
  probeImage,
  probeJpeg,
  probePng,
  probeWebp,
  sniffImageFormat,
} from './probe.ts';

const IMG_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/media-derived/img',
);
const MEDIA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/media');
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(IMG_DIR, name)));
const loadMedia = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(MEDIA_DIR, name)));

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function be32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function le32(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function le24(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff);
}

function le16(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
}

function box(type: string, body: Uint8Array): Uint8Array {
  return concatBytes(be32(8 + body.length), asciiBytes(type), body);
}

function boxToEnd(type: string, body: Uint8Array): Uint8Array {
  return concatBytes(be32(0), asciiBytes(type), body);
}

function fullBox(type: string, body: Uint8Array): Uint8Array {
  return box(type, concatBytes(Uint8Array.of(0, 0, 0, 0), body));
}

function fullBoxToEnd(type: string, body: Uint8Array): Uint8Array {
  return boxToEnd(type, concatBytes(Uint8Array.of(0, 0, 0, 0), body));
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  return concatBytes(be32(body.length), asciiBytes(type), body, Uint8Array.of(0, 0, 0, 0));
}

function apngFrameControl(sequence: number, delayNum: number, delayDen: number): Uint8Array {
  return pngChunk(
    'fcTL',
    concatBytes(
      be32(sequence),
      be32(1),
      be32(1),
      be32(0),
      be32(0),
      Uint8Array.of((delayNum >>> 8) & 0xff, delayNum & 0xff),
      Uint8Array.of((delayDen >>> 8) & 0xff, delayDen & 0xff),
      Uint8Array.of(0, 0),
    ),
  );
}

function pngBytes(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  ...extraChunks: Uint8Array[]
): Uint8Array {
  const ihdr = concatBytes(be32(width), be32(height), Uint8Array.of(bitDepth, colorType, 0, 0, 0));
  return concatBytes(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    ...extraChunks,
    pngChunk('IEND', new Uint8Array(0)),
  );
}

function gifImageBlock(localPacked = 0, localTable = new Uint8Array(0)): Uint8Array {
  return concatBytes(
    Uint8Array.of(0x2c),
    le16(0),
    le16(0),
    le16(2),
    le16(3),
    Uint8Array.of(localPacked),
    localTable,
    Uint8Array.of(0x02, 0x00),
  );
}

function gifGraphicControl(delayCs: number): Uint8Array {
  return concatBytes(
    Uint8Array.of(0x21, 0xf9, 0x04, 0x00),
    le16(delayCs),
    Uint8Array.of(0x00, 0x00),
  );
}

function riffChunk(type: string, body: Uint8Array): Uint8Array {
  return concatBytes(
    asciiBytes(type),
    le32(body.length),
    body,
    body.length % 2 === 0 ? new Uint8Array(0) : Uint8Array.of(0),
  );
}

function webpBytes(...chunks: Uint8Array[]): Uint8Array {
  const riffBody = concatBytes(asciiBytes('WEBP'), ...chunks);
  return concatBytes(asciiBytes('RIFF'), le32(riffBody.length), riffBody);
}

function webpAnmf(durationMs: number): Uint8Array {
  return riffChunk(
    'ANMF',
    concatBytes(le24(0), le24(0), le24(0), le24(0), le24(durationMs), Uint8Array.of(0)),
  );
}

function ftyp(major: string): Uint8Array {
  return box('ftyp', concatBytes(asciiBytes(major), Uint8Array.of(0, 0, 0, 0), asciiBytes(major)));
}

function ftypWithBrands(major: string, ...brands: string[]): Uint8Array {
  return box(
    'ftyp',
    concatBytes(asciiBytes(major), Uint8Array.of(0, 0, 0, 0), ...brands.map(asciiBytes)),
  );
}

function ftypToEnd(major: string, ...brands: string[]): Uint8Array {
  return boxToEnd(
    'ftyp',
    concatBytes(asciiBytes(major), Uint8Array.of(0, 0, 0, 0), ...brands.map(asciiBytes)),
  );
}

interface Truth {
  readonly file: string;
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly animated: boolean;
  readonly durationSec?: number;
}

/** Each row's width/height/frameCount come from an external tool, never from our own probe. */
const CORPUS: readonly Truth[] = [
  { file: 'test.png', format: 'png', width: 100, height: 100, frameCount: 1, animated: false },
  { file: 'test.jpeg', format: 'jpeg', width: 239, height: 178, frameCount: 1, animated: false },
  { file: 'test.webp', format: 'webp', width: 274, height: 367, frameCount: 1, animated: false },
  {
    file: 'anim2.gif',
    format: 'gif',
    width: 480,
    height: 360,
    frameCount: 36,
    animated: true,
    durationSec: 0.82,
  },
  { file: 'test.avif', format: 'avif', width: 100, height: 100, frameCount: 1, animated: false },
];

describe('image probe — strict oracle on ≥5 real downloaded images', () => {
  it('covers ≥5 diverse real formats (gif/png/jpeg/webp/avif)', () => {
    expect(new Set(CORPUS.map((t) => t.format)).size).toBe(5);
    expect(CORPUS.length).toBeGreaterThanOrEqual(5);
  });

  for (const t of CORPUS) {
    it(`${t.file}: probeImage matches the independent ground truth`, () => {
      const info = probeImage(load(t.file));
      expect(info.format).toBe(t.format);
      expect(info.width).toBe(t.width);
      expect(info.height).toBe(t.height);
      expect(info.frameCount).toBe(t.frameCount);
      expect(info.animated).toBe(t.animated);
      if (t.durationSec !== undefined) expect(info.durationSec).toBeCloseTo(t.durationSec, 6);
      // structural sanity — a real decoder must report a positive depth + a non-empty colour descriptor.
      expect(info.bitDepth).toBeGreaterThan(0);
      expect(info.colorType.length).toBeGreaterThan(0);
    });

    it(`${t.file}: sniffImageFormat identifies it from the magic bytes`, () => {
      expect(sniffImageFormat(load(t.file))).toBe(t.format);
    });
  }

  it('animated GIF is flagged animated with a finite/forever loop count', () => {
    const gif = probeImage(load('anim2.gif'));
    expect(gif.animated).toBe(true);
    expect(gif.frameCount).toBeGreaterThan(1);
    expect(gif.durationSec).toBeCloseTo(0.82, 6);
    // GIF carries a NETSCAPE loop block → loopCount is defined (0 ⇒ forever ⇒ Infinity here).
    expect(gif.loopCount).toBeDefined();
  });

  it('sniff returns undefined on bytes that match no image magic (honest miss)', () => {
    expect(
      sniffImageFormat(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])),
    ).toBeUndefined();
  });

  it('does not treat an AV1 MP4 video brand as AVIF image magic', () => {
    // av1.mp4 carries compatible brand `av01` (the AV1 codec brand), but lacks AVIF/AVIS image brands.
    // It must fall through to the MP4 container driver, not preempt into the image side capability.
    expect(sniffImageFormat(loadMedia('av1.mp4').subarray(0, 64))).toBeUndefined();
  });

  it('probeImage throws a typed InputError on unknown input (never fabricates an ImageInfo)', () => {
    expect(() => probeImage(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]))).toThrow(
      InputError,
    );
    expect(() => probeImage(new Uint8Array(0))).toThrow(InputError);
  });

  it('probeImage throws a typed InputError on a truncated header (no clamped/garbage dimension)', () => {
    // real PNG signature (8B) + a sliced-off IHDR — the width/height read must run past the buffer.
    const truncatedPng = load('test.png').subarray(0, 10);
    expect(() => probeImage(truncatedPng)).toThrow(InputError);
  });

  it('each per-format probe rejects a truncated header with a typed InputError', () => {
    // slice each REAL fixture short enough that a dimension/box read runs past the buffer — every
    // bounds-checked read must raise InputError, never return a fabricated/clamped dimension.
    expect(() => probeGif(load('anim2.gif').subarray(0, 8))).toThrow(InputError);
    expect(() => probePng(load('test.png').subarray(0, 12))).toThrow(InputError);
    expect(() => probeJpeg(load('test.jpeg').subarray(0, 8))).toThrow(InputError);
    expect(() => probeWebp(load('test.webp').subarray(0, 16))).toThrow(InputError);
    expect(() => probeAvif(load('test.avif').subarray(0, 20))).toThrow(InputError);
  });
});

describe('image probe — spec-minimal parser branch fixtures', () => {
  it('sniffs GIF87a and AVIF compatible brands while rejecting malformed short headers', () => {
    const gif87a = concatBytes(
      asciiBytes('GIF87a'),
      le16(1),
      le16(1),
      Uint8Array.of(0, 0, 0),
      gifImageBlock(),
      Uint8Array.of(0x3b),
    );
    expect(sniffImageFormat(gif87a)).toBe('gif');
    expect(sniffImageFormat(ftypToEnd('mif1', 'avif'))).toBe('avif');
    expect(() => probeGif(Uint8Array.of(0x47))).toThrow(InputError);
    expect(() => probeWebp(new Uint8Array(0))).toThrow(InputError);
  });

  it('parses GIF87a without a global color table and GIF local color tables', () => {
    const noGlobal = concatBytes(
      asciiBytes('GIF87a'),
      le16(2),
      le16(3),
      Uint8Array.of(0, 0, 0),
      gifImageBlock(),
      Uint8Array.of(0x3b),
    );
    expect(probeGif(noGlobal)).toEqual({
      format: 'gif',
      width: 2,
      height: 3,
      frameCount: 1,
      animated: false,
      bitDepth: 1,
      colorType: 'indexed',
    });

    const withLocal = concatBytes(
      asciiBytes('GIF89a'),
      le16(2),
      le16(3),
      Uint8Array.of(0, 0, 0),
      gifImageBlock(0x80, Uint8Array.of(0, 0, 0, 255, 255, 255)),
      Uint8Array.of(0x3b),
    );
    expect(probeGif(withLocal).frameCount).toBe(1);
  });

  it('parses GIF extension blocks with finite loops and rejects invalid GIF block walks', () => {
    const finiteLoop = concatBytes(
      asciiBytes('GIF89a'),
      le16(2),
      le16(3),
      Uint8Array.of(0, 0, 0),
      Uint8Array.of(0x21, 0xff, 11),
      asciiBytes('NETSCAPE2.0'),
      Uint8Array.of(3, 1),
      le16(5),
      Uint8Array.of(0),
      gifImageBlock(),
      Uint8Array.of(0x3b),
    );
    expect(probeGif(finiteLoop).loopCount).toBe(5);

    const timed = concatBytes(
      asciiBytes('GIF89a'),
      le16(2),
      le16(3),
      Uint8Array.of(0, 0, 0),
      gifGraphicControl(7),
      gifImageBlock(),
      gifGraphicControl(13),
      gifImageBlock(),
      Uint8Array.of(0x3b),
    );
    expect(probeGif(timed)).toMatchObject({
      frameCount: 2,
      animated: true,
      durationSec: 0.2,
    });

    const commentExtension = concatBytes(
      asciiBytes('GIF89a'),
      le16(2),
      le16(3),
      Uint8Array.of(0, 0, 0),
      Uint8Array.of(0x21, 0xfe, 2, 0x41, 0x42, 0),
      gifImageBlock(),
      Uint8Array.of(0x3b),
    );
    expect(probeGif(commentExtension).frameCount).toBe(1);

    const noFrames = concatBytes(
      asciiBytes('GIF89a'),
      le16(2),
      le16(3),
      Uint8Array.of(0, 0, 0),
      Uint8Array.of(0x3b),
    );
    expect(() => probeGif(noFrames)).toThrow(InputError);

    const unknownBlock = concatBytes(
      asciiBytes('GIF89a'),
      le16(2),
      le16(3),
      Uint8Array.of(0, 0, 0),
      Uint8Array.of(0x00),
    );
    expect(() => probeGif(unknownBlock)).toThrow(InputError);
  });

  it('parses APNG acTL metadata, finite plays, and unknown PNG color types', () => {
    const apng = pngBytes(
      7,
      5,
      8,
      6,
      pngChunk('acTL', concatBytes(be32(3), be32(0))),
      apngFrameControl(0, 1, 10),
      apngFrameControl(1, 25, 100),
      apngFrameControl(2, 1, 0),
    );
    expect(probePng(apng)).toEqual({
      format: 'png',
      width: 7,
      height: 5,
      frameCount: 3,
      animated: true,
      bitDepth: 8,
      colorType: 'rgba',
      loopCount: Number.POSITIVE_INFINITY,
      durationSec: 0.36,
    });

    expect(probePng(pngBytes(4, 3, 12, 99)).colorType).toBe('unknown');
    expect(
      probePng(pngBytes(7, 5, 8, 6, pngChunk('acTL', concatBytes(be32(2), be32(4))))).loopCount,
    ).toBe(4);
  });

  it('rejects bad PNG signatures and PNG streams without IHDR dimensions', () => {
    expect(() => probePng(Uint8Array.of(0x89, 0x50, 0x4e, 0x00, 0x0d, 0x0a, 0x1a, 0x0a))).toThrow(
      InputError,
    );
    expect(() =>
      probePng(
        concatBytes(
          Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
          pngChunk('IEND', new Uint8Array(0)),
        ),
      ),
    ).toThrow(InputError);
  });

  it('walks JPEG fill bytes, standalone restart markers, and progressive SOF markers', () => {
    const jpeg = Uint8Array.of(
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x04,
      0x00,
      0x00,
      0xff,
      0xd0,
      0xff,
      0xff,
      0xc2,
      0x00,
      0x08,
      0x0c,
      0x00,
      0x20,
      0x00,
      0x10,
      0x01,
    );
    expect(probeJpeg(jpeg)).toEqual({
      format: 'jpeg',
      width: 16,
      height: 32,
      frameCount: 1,
      animated: false,
      bitDepth: 12,
      colorType: '1-component',
    });
  });

  it('rejects JPEG streams with missing SOI or lost marker sync', () => {
    expect(() => probeJpeg(Uint8Array.of(0x00, 0xd8))).toThrow(InputError);
    expect(() => probeJpeg(Uint8Array.of(0xff, 0xd8, 0x00))).toThrow(InputError);
  });

  it('parses VP8L lossless and VP8X still WebP headers', () => {
    const vp8lBits = (3 - 1) | ((2 - 1) << 14);
    expect(
      probeWebp(webpBytes(riffChunk('VP8L', concatBytes(Uint8Array.of(0x2f), le32(vp8lBits))))),
    ).toEqual({
      format: 'webp',
      width: 3,
      height: 2,
      frameCount: 1,
      animated: false,
      bitDepth: 8,
      colorType: 'lossless',
    });

    const vp8x = webpBytes(
      riffChunk('VP8X', concatBytes(Uint8Array.of(0x10, 0, 0, 0), le24(11), le24(8))),
    );
    expect(probeWebp(vp8x)).toEqual({
      format: 'webp',
      width: 12,
      height: 9,
      frameCount: 1,
      animated: false,
      bitDepth: 8,
      colorType: 'rgba',
    });
  });

  it('parses animated VP8X WebP loop metadata and rejects empty animations', () => {
    const animated = webpBytes(
      riffChunk('VP8X', concatBytes(Uint8Array.of(0x02, 0, 0, 0), le24(4), le24(5))),
      riffChunk('ANIM', concatBytes(Uint8Array.of(0, 0, 0, 0), le16(0))),
      webpAnmf(1000),
      webpAnmf(250),
    );
    expect(probeWebp(animated)).toEqual({
      format: 'webp',
      width: 5,
      height: 6,
      frameCount: 2,
      animated: true,
      bitDepth: 8,
      colorType: 'rgb',
      loopCount: Number.POSITIVE_INFINITY,
      durationSec: 1.25,
    });

    const emptyAnimation = webpBytes(
      riffChunk('VP8X', concatBytes(Uint8Array.of(0x02, 0, 0, 0), le24(1), le24(1))),
    );
    expect(() => probeWebp(emptyAnimation)).toThrow(InputError);

    const singleFrameAnimatedFlag = webpBytes(
      riffChunk('VP8X', concatBytes(Uint8Array.of(0x02, 0, 0, 0), le24(3), le24(3))),
      riffChunk('ANIM', concatBytes(Uint8Array.of(0, 0, 0, 0), le16(2))),
      riffChunk('ANMF', new Uint8Array(16)),
    );
    expect(probeWebp(singleFrameAnimatedFlag)).toMatchObject({
      frameCount: 1,
      animated: false,
      loopCount: 2,
    });
  });

  it('rejects malformed WebP stream selectors and VP8L signatures', () => {
    expect(() => probeWebp(webpBytes(riffChunk('ABCD', new Uint8Array(0))))).toThrow(InputError);
    expect(() =>
      probeWebp(webpBytes(riffChunk('VP8L', concatBytes(Uint8Array.of(0), le32(0))))),
    ).toThrow(InputError);
  });

  it('parses AVIF sequence dimensions, sample count, and 12-bit av1C depth', () => {
    const ispe = fullBox('ispe', concatBytes(be32(11), be32(9)));
    const av1c = box('av1C', Uint8Array.of(0x81, 0x40, 0x60));
    const meta = fullBox('meta', box('iprp', box('ipco', concatBytes(ispe, av1c))));
    const stsz = fullBox('stsz', concatBytes(be32(0), be32(3)));
    const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsz)))));
    expect(probeAvif(concatBytes(ftyp('avis'), meta, moov))).toEqual({
      format: 'avif',
      width: 11,
      height: 9,
      frameCount: 3,
      animated: true,
      bitDepth: 12,
      colorType: 'av01-sequence',
    });
  });

  it('parses AVIF compatible sequence brands, size-to-end boxes, and 8/10-bit av1C depth', () => {
    const stillIspe = fullBox('ispe', concatBytes(be32(13), be32(17)));
    const stillAv1c = box('av1C', Uint8Array.of(0x81, 0x00, 0x40));
    const stillMeta = fullBoxToEnd(
      'meta',
      box(
        'iprp',
        box(
          'ipco',
          concatBytes(stillIspe, stillAv1c, fullBox('ispe', concatBytes(be32(99), be32(99)))),
        ),
      ),
    );
    expect(probeAvif(concatBytes(ftyp('avif'), stillMeta))).toEqual({
      format: 'avif',
      width: 13,
      height: 17,
      frameCount: 1,
      animated: false,
      bitDepth: 10,
      colorType: 'av01',
    });

    const seqIspe = fullBox('ispe', concatBytes(be32(5), be32(4)));
    const seqAv1c = box('av1C', Uint8Array.of(0x81, 0x00, 0x00));
    const seqMeta = fullBox('meta', box('iprp', box('ipco', concatBytes(seqIspe, seqAv1c))));
    const emptyStsz = fullBox('stsz', concatBytes(be32(0), be32(0)));
    const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', emptyStsz)))));
    expect(probeAvif(concatBytes(ftypWithBrands('mif1', 'avis'), seqMeta, moov))).toEqual({
      format: 'avif',
      width: 5,
      height: 4,
      frameCount: 1,
      animated: false,
      bitDepth: 8,
      colorType: 'av01-sequence',
    });
  });

  it('rejects AVIF inputs without ftyp, dimensions, or valid box sizes', () => {
    expect(() => probeAvif(box('free', new Uint8Array(0)))).toThrow(InputError);
    expect(() => probeAvif(ftyp('avif'))).toThrow(InputError);
    expect(() => probeAvif(ftypToEnd('mif1', 'avis'))).toThrow(InputError);
    expect(() =>
      probeAvif(concatBytes(ftyp('avif'), concatBytes(be32(7), asciiBytes('free')))),
    ).toThrow(InputError);
  });

  it('rejects AVIF boxes whose 64-bit largesize exceeds the supported fixture range', () => {
    const tooLarge = concatBytes(be32(1), asciiBytes('free'), be32(1), be32(0));
    expect(() => probeAvif(concatBytes(ftyp('avif'), tooLarge))).toThrow(InputError);
  });
});
