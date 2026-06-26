import { describe, expect, it } from 'vitest';
import * as core from './core.ts';
import * as image from './image.ts';
import * as index from './index.ts';

describe('public surface', () => {
  it('default entry re-exports the typed error classes and version', () => {
    expect(index.VERSION).toBe('0.0.0');
    expect(new index.MediaError('aborted', 'x')).toBeInstanceOf(index.MediaError);
    expect(new index.CapabilityError('capability-miss', 'x')).toBeInstanceOf(index.MediaError);
    expect(new index.InputError('unsupported-input', 'x')).toBeInstanceOf(index.MediaError);
  });

  it('core entry exposes the driver-author surface', () => {
    expect(core.DRIVER_API_VERSION).toBe(1);
    expect(core.VERSION).toBe('0.0.0');
    expect(new core.MediaError('demux-error', 'x').code).toBe('demux-error');
  });

  it('image subpath exposes standalone helpers without joining the default entry', () => {
    expect(image.IMAGE_FORMATS).toEqual(['gif', 'png', 'jpeg', 'webp', 'avif']);
    expect(typeof image.probeImage).toBe('function');
    expect(typeof image.decodeImage).toBe('function');
    expect('probeImage' in index).toBe(false);
    expect('decodeImage' in index).toBe(false);
  });
});
