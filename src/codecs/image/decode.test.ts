/**
 * Image decode — the Node-reachable capability gates (the live `ImageDecoder` pixel path is browser-only,
 * `/* v8 ignore *​/`-marked and harness-validated). Here we lock the honest-miss behaviour on REAL fixtures:
 * `hasImageDecoder` is false in Node, `inspectImage` still reports format/info but `decodable:false`, and
 * both decode entry points raise a typed `CapabilityError` — never a mock or a fabricated frame.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../../contracts/errors.ts';
import { decodeImage, decodeImageFrames, hasImageDecoder, inspectImage } from './decode.ts';

const IMG = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/media-derived/img');
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(IMG, name)));

describe('image decode — Node-reachable capability gates', () => {
  it('hasImageDecoder() is false in Node (no WebCodecs ImageDecoder global)', () => {
    expect(hasImageDecoder()).toBe(false);
  });

  it('inspectImage reports format + real info but decodable:false in Node', () => {
    const r = inspectImage(load('test.webp'));
    expect(r.format).toBe('webp');
    expect(r.info).toMatchObject({ format: 'webp', width: 274, height: 367, frameCount: 1 });
    expect(r.decodable).toBe(false);
    // animated source: info still parses fully even though decode is unavailable here.
    expect(inspectImage(load('anim2.gif')).info).toMatchObject({ frameCount: 36, animated: true });
  });

  it('decodeImage throws a typed CapabilityError synchronously in Node', () => {
    expect(() => decodeImage(load('test.png'))).toThrow(CapabilityError);
  });

  it('decodeImageFrames raises a typed CapabilityError on first iteration in Node', async () => {
    await expect(
      (async () => {
        for await (const frame of decodeImageFrames(load('test.jpeg'))) frame.close();
      })(),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});
