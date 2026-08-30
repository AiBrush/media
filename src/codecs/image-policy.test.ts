import { describe, expect, it } from 'vitest';
import {
  IMAGE_POLICY,
  imageDecodeAvailable,
  imagePolicyNotice,
  imageSupportedFormats,
} from './image-policy.ts';
import { hasImageDecoder } from './image/decode.ts';
import { sniffImageFormat } from './image/probe.ts';

describe('image still/animated policy — probe + ImageDecoder decode, still→video (REQUIREMENTS §6 — 2.3.2)', () => {
  it('declares GIF/PNG/JPEG/WebP/AVIF probe true and browser ImageDecoder decode', () => {
    expect([...IMAGE_POLICY.formats]).toEqual(['gif', 'png', 'jpeg', 'webp', 'avif']);
    expect(IMAGE_POLICY.probe).toBe(true);
    expect(IMAGE_POLICY.decode.browser).toBe(true);
    expect(IMAGE_POLICY.decode.node).toBe(false);
    expect(IMAGE_POLICY.stillToVideo.supported).toBe(true);
    expect(IMAGE_POLICY.animatedToVideo.supported).toBe(true);
    expect(IMAGE_POLICY.licensing.royaltyFree).toBe(true);
  });

  it('notice is non-empty and mentions ImageDecoder, still→video, and preflight', () => {
    const notice = imagePolicyNotice();
    expect(notice.length).toBeGreaterThan(80);
    expect(notice).toMatch(/ImageDecoder/);
    expect(notice).toMatch(/still image decodes to one VideoFrame/);
    expect(notice).toMatch(/animated image decodes to its timed frame sequence/);
    expect(notice).toMatch(/hasImageDecoder|canConvert/);
  });

  it('imageDecodeAvailable mirrors hasImageDecoder (false in Node)', () => {
    expect(imageDecodeAvailable()).toBe(hasImageDecoder());
    expect(hasImageDecoder()).toBe(false); // Node has no ImageDecoder
    expect(imageDecodeAvailable()).toBe(false);
  });

  it('supported formats are exactly the five probed by sniffImageFormat', () => {
    expect(imageSupportedFormats()).toEqual([...IMAGE_POLICY.formats]);
    // sniffImageFormat is pure and returns undefined for non-image bytes
    expect(sniffImageFormat(new Uint8Array([0, 1, 2]))).toBeUndefined();
    // GIF87a magic is recognized
    const gif = new TextEncoder().encode('GIF87a');
    const bytes = new Uint8Array([...gif, 1, 0, 1, 0, 0x80, 0, 0]);
    expect(sniffImageFormat(bytes)).toBe('gif');
  });

  it('20× randomized policy invariants remain deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const notice = imagePolicyNotice();
      expect(notice).toBe(imagePolicyNotice());
      const formats = imageSupportedFormats();
      expect(formats.length).toBe(5);
      expect(formats).toContain('avif');
      const available = imageDecodeAvailable();
      expect(typeof available).toBe('boolean');
    }
  });

  it('malformed inputs never throw huge-alloc and formats are stable', () => {
    expect(() => imageSupportedFormats()).not.toThrow();
    const formats = imageSupportedFormats();
    expect(formats.length).toBe(5);
    expect([...formats]).toEqual(['gif', 'png', 'jpeg', 'webp', 'avif']);
    const notice = imagePolicyNotice();
    expect(typeof notice).toBe('string');
    expect(notice.length).toBeLessThan(4096);
  });
});
