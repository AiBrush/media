/**
 * Image driver — the capability surface + registration hook (Node-reachable parts). The live decode path
 * is browser-only (`ImageDecoder`) and is exercised by the harness; here we lock the wiring: `imageOps`
 * routes sniff/probe through the real parser on REAL fixtures, decode is an HONEST typed miss in Node
 * (never a wrong frame), and `registerImageSupport`/`ImageModule` attach only to an `ImageRegistry` host.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError } from '../../contracts/errors.ts';
import {
  IMAGE_FORMATS,
  ImageModule,
  type ImageOps,
  imageOps,
  registerImageSupport,
} from './image-driver.ts';

const IMG = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/media-derived/img');
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(IMG, name)));

describe('image driver — capability surface (Node-reachable)', () => {
  it('exposes the five supported image formats', () => {
    expect([...IMAGE_FORMATS]).toEqual(['gif', 'png', 'jpeg', 'webp', 'avif']);
    expect(imageOps.formats).toBe(IMAGE_FORMATS);
  });

  it('routes sniff + probe through to the real parser on real fixtures', () => {
    expect(imageOps.sniff(load('test.png'))).toBe('png');
    expect(imageOps.sniff(new Uint8Array([0, 1, 2, 3]))).toBeUndefined();
    expect(imageOps.probe(load('anim2.gif'))).toMatchObject({
      format: 'gif',
      width: 480,
      height: 360,
      frameCount: 36,
      animated: true,
      durationSec: 0.82,
    });
  });

  it('reports decode unavailable in Node (no WebCodecs ImageDecoder)', () => {
    expect(imageOps.canDecode()).toBe(false);
  });

  it('decode + decodeFrames are a typed CapabilityError in Node — honest miss, never a wrong frame', async () => {
    await expect(
      (async () => {
        const reader = imageOps.decode(load('test.png')).getReader();
        await reader.read();
      })(),
    ).rejects.toBeInstanceOf(CapabilityError);
    await expect(
      (async () => {
        for await (const frame of imageOps.decodeFrames(load('test.png'))) frame.close();
      })(),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('registerImageSupport attaches to an ImageRegistry host, no-ops on anything else', () => {
    let captured: ImageOps | undefined;
    const host = {
      addImageOps: (ops: ImageOps): void => {
        captured = ops;
      },
    };
    expect(registerImageSupport(host)).toBe(true);
    expect(captured).toBe(imageOps);
    // the guard's three negative branches: missing slot, null (typeof null === 'object'), non-object.
    expect(registerImageSupport({})).toBe(false);
    expect(registerImageSupport(null)).toBe(false);
    expect(registerImageSupport(42)).toBe(false);
  });

  it('ImageModule is DriverModule-shaped and registers harmlessly on a plain Registry', () => {
    expect(ImageModule.apiVersion).toBe(DRIVER_API_VERSION);
    expect(() => ImageModule.register({})).not.toThrow(); // no addImageOps slot → intentional no-op
  });
});
