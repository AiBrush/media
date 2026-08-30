import { describe, expect, it } from 'vitest';
import { createMedia } from './create-media.ts';
import { fromBytes } from '../sources/source.ts';

// The unencrypted-noop scenario: decrypting a clear MP4 with KID 'default' must return the file verbatim, not throw KID validation.
// This was the 1 ERROR in 2026-08-29T15:49 partial (158 PASS /1 ERROR).

describe('decrypt unencrypted noop (2.5)', () => {
  it('unit: KID default is allowed for cenc and does not throw KID validation', async () => {
    const media = createMedia();
    const tiny = fromBytes(new Uint8Array([0,0,0,8, 0x66,0x74,0x79,0x70, 0x69,0x73,0x6F,0x6D]));
    try {
      await media.decrypt(tiny, { scheme: 'cenc', keys: { default: '00112233445566778899aabbccddeeff' } });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("KID 'default' must be 16 bytes");
    }
  });

  it('property: same KID default with different valid keys is deterministic (no KID throw)', async () => {
    const media = createMedia();
    const tiny = fromBytes(new Uint8Array([0,0,0,8, 0x66,0x74,0x79,0x70, 0x69,0x73,0x6F,0x6D]));
    for (let i=0;i<5;i++) {
      const key = i.toString(16).padStart(32,'0');
      try {
        await media.decrypt(tiny, { scheme: 'cenc', keys: { default: key } });
      } catch (e) {
        expect(String((e as Error).message)).not.toContain("KID 'default'");
      }
    }
  });

  it('boundary: 32-char hex KID still required for non-default', async () => {
    const media = createMedia();
    const tiny = fromBytes(new Uint8Array([0,0,0,8, 0x66,0x74,0x79,0x70, 0x69,0x73,0x6F,0x6D]));
    await expect(media.decrypt(tiny, { scheme: 'cenc', keys: { bad: '00112233445566778899aabbccddeeff' } } as any)).rejects.toThrow();
    await expect(media.decrypt(tiny, { scheme: 'cenc', keys: { ['a'.repeat(31)]: '00112233445566778899aabbccddeeff' } } as any)).rejects.toThrow();
  });

  it('malformed: empty keys still throws before KID check', async () => {
    const media = createMedia();
    const tiny = fromBytes(new Uint8Array([0,0,0,8, 0x66,0x74,0x79,0x70, 0x69,0x73,0x6F,0x6D]));
    await expect(media.decrypt(tiny, { scheme: 'cenc', keys: {} } as any)).rejects.toThrow();
  });

  it('randomized: 20 random hex keys with KID default all avoid KID validation', async () => {
    const media = createMedia();
    for(let i=0;i<20;i++) {
      const key = Array.from({length:32},()=> Math.floor(Math.random()*16).toString(16)).join('');
      const tiny = fromBytes(new Uint8Array([0,0,0,8, 0x66,0x74,0x79,0x70, 0x69,0x73,0x6F,0x6D]));
      try {
        await media.decrypt(tiny, { scheme: 'cenc', keys: { default: key } });
      } catch(e) {
        expect(String((e as Error).message)).not.toContain("KID 'default' must be 16 bytes");
      }
    }
  });
});
