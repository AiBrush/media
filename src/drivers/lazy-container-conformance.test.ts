/**
 * R-S04.5 — the lazy flag table is asserted against the real modules, both directions, so the
 * advertised capability surface (methods on the proxy) and the real capability surface (methods on
 * the loaded driver) can never drift apart silently:
 *
 * 1. every `flag: true` must be a real function/flag on the loaded module (no runtime
 *    `missingLazyMethod` for an advertised capability), and
 * 2. every optional capability the loaded module implements must be flagged, and the built proxy
 *    must advertise exactly the flagged surface (an unflagged real method is a lost capability).
 */

import { describe, expect, it, vi } from 'vitest';
import { OPTIONAL_CONTAINER_CAPABILITIES } from '../contracts/driver.ts';
import { fromBytes } from '../sources/source.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { DEFAULT_LAZY_CONTAINER_SPECS, lazyContainer } from './defaults.ts';
import { WAV_LAZY_CONTAINER_SPEC } from './wav/wav-lazy-driver.ts';

function surfaceOf(target: object): readonly string[] {
  return OPTIONAL_CONTAINER_CAPABILITIES.filter((capability) => {
    const member: unknown = Reflect.get(target, capability);
    return typeof member === 'function' || member === true;
  });
}

describe('lazy container spec conformance', () => {
  it('covers every spec-registered default container', () => {
    expect(DEFAULT_LAZY_CONTAINER_SPECS.map((spec) => spec.id).sort()).toEqual(
      ['adts', 'aiff', 'avi', 'caf', 'mp3', 'mp4', 'mpegts', 'ogg', 'wav', 'webm'].sort(),
    );
  });

  it.each(DEFAULT_LAZY_CONTAINER_SPECS.map((spec) => [spec.id, spec] as const))(
    'the %s proxy advertises exactly the surface its loaded module implements',
    async (_id, spec) => {
      const loaded = await spec.load();
      const proxy = lazyContainer(spec);
      const advertised = surfaceOf(proxy);
      const real = surfaceOf(loaded);
      const flagged = OPTIONAL_CONTAINER_CAPABILITIES.filter(
        (capability) => spec[capability] === true,
      );
      // Direction 1: every flag is real — an advertised method may never miss at call time.
      expect(flagged).toEqual(advertised);
      // Direction 2: every real optional capability is flagged — no silent capability loss.
      expect(advertised).toEqual(real);
    },
  );

  it('keeps WAV probe on the lightweight implementation until a full-driver flow is requested', async () => {
    const load = vi.fn(WAV_LAZY_CONTAINER_SPEC.load);
    const proxy = lazyContainer({ ...WAV_LAZY_CONTAINER_SPEC, load });
    const bytes = await loadFixture('speech.wav');
    const probe = proxy.probe;
    if (probe === undefined) throw new Error('lazy WAV proxy must expose probe');

    await expect(probe.call(proxy, fromBytes(bytes, { mime: 'audio/wav' }))).resolves.toMatchObject(
      [{ mediaType: 'audio', codec: 'pcm-s16' }],
    );
    expect(load).not.toHaveBeenCalled();

    await expect(proxy.demux(fromBytes(bytes, { mime: 'audio/wav' }))).resolves.toMatchObject({
      tracks: [{ mediaType: 'audio', codec: 'pcm-s16' }],
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
