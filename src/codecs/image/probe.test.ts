/**
 * Image probe — strict-oracle validation on REAL downloaded media (BUILD §6.1: ≥5 diverse real files,
 * never a hand-forged byte array). Ground truth is produced by INDEPENDENT tools, so the oracle can fail:
 *   • pixel dimensions ← macOS `sips -g pixelWidth -g pixelHeight`
 *   • animated-GIF frame count ← `ffprobe -count_frames` (36 frames for the Newton's-cradle GIF)
 * Fixtures live in fixtures/media-derived/img/ (committed; provenance in that dir's README). The decode
 * path is browser-only (ImageDecoder) and is exercised by the harness; this suite locks the pure parser.
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
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(IMG_DIR, name)));

interface Truth {
  readonly file: string;
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly animated: boolean;
}

/** Each row's width/height/frameCount come from an external tool, never from our own probe. */
const CORPUS: readonly Truth[] = [
  { file: 'test.png', format: 'png', width: 100, height: 100, frameCount: 1, animated: false },
  { file: 'test.jpeg', format: 'jpeg', width: 239, height: 178, frameCount: 1, animated: false },
  { file: 'test.webp', format: 'webp', width: 274, height: 367, frameCount: 1, animated: false },
  { file: 'anim2.gif', format: 'gif', width: 480, height: 360, frameCount: 36, animated: true },
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
    // GIF carries a NETSCAPE loop block → loopCount is defined (0 ⇒ forever ⇒ Infinity here).
    expect(gif.loopCount).toBeDefined();
  });

  it('sniff returns undefined on bytes that match no image magic (honest miss)', () => {
    expect(
      sniffImageFormat(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])),
    ).toBeUndefined();
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
