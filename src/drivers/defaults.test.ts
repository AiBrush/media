import { describe, expect, it } from 'vitest';
import { Registry } from '../kernel/registry.ts';
import { registerDefaultDrivers } from './defaults.ts';

describe('registerDefaultDrivers', () => {
  it('registers image support on the default registry host', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);
    const images = reg.imageOps();
    expect(images).toBeDefined();
    expect(images?.sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'png',
    );
  });

  it('keeps core-less video wasm scaffolds out of zero-config defaults', () => {
    const reg = new Registry();
    registerDefaultDrivers(reg);

    expect(reg.codecs().map((d) => d.id)).not.toContain('wasm-av1');
  });
});
