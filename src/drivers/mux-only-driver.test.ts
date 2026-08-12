import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import { Registry } from '../kernel/registry.ts';
import Mp4MuxOnlyModule, { Mp4MuxOnlyDriver } from './mp4/mp4-mux-driver.ts';
import WebmMuxOnlyModule, { WebmMuxOnlyDriver } from './webm/webm-mux-driver.ts';

describe('query-selective mux-only drivers', () => {
  it.each([
    [
      Mp4MuxOnlyDriver,
      'MP4',
      ['mp4', 'mov'],
      ['video/mp4', 'audio/mp4', 'application/mp4', 'video/quicktime'],
    ],
    [
      WebmMuxOnlyDriver,
      'WebM',
      ['webm', 'mkv', 'mka'],
      ['video/webm', 'audio/webm', 'video/x-matroska'],
    ],
  ] as const)(
    'matches normalized %s output hints and never demux queries',
    (driver, _name, extensions, mimes) => {
      expect(driver.supports({ direction: 'demux', extension: extensions[0] })).toBe(false);
      for (const extension of extensions) {
        expect(driver.supports({ direction: 'mux', extension: extension.toUpperCase() })).toBe(
          true,
        );
      }
      for (const mime of mimes) {
        expect(
          driver.supports({ direction: 'mux', mime: ` ${mime.toUpperCase()} ; codecs=x` }),
        ).toBe(true);
      }
      expect(driver.supports({ direction: 'mux' })).toBe(false);
      expect(driver.supports({ direction: 'mux', extension: 'unknown', mime: 'text/plain' })).toBe(
        false,
      );
    },
  );

  it('keeps both drivers output-only and preserves their exact muxer variants', async () => {
    const source = { stream: () => new ReadableStream<Uint8Array>() };
    await expect(Mp4MuxOnlyDriver.demux(source)).rejects.toBeInstanceOf(CapabilityError);
    await expect(WebmMuxOnlyDriver.demux(source)).rejects.toBeInstanceOf(CapabilityError);
    expect(Mp4MuxOnlyDriver.createMuxer()).toBeDefined();
    expect(WebmMuxOnlyDriver.createMuxer()).toBeDefined();
    expect(WebmMuxOnlyDriver.createMuxer({ container: 'mkv' })).toBeDefined();
  });

  it('registers the narrow drivers without loading full demux implementations', () => {
    const registry = new Registry();
    Mp4MuxOnlyModule.register(registry);
    WebmMuxOnlyModule.register(registry);
    expect(registry.containers().map(({ id }) => id)).toEqual(['mp4-mux', 'webm-mux']);
  });
});
