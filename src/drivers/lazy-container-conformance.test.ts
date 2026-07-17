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

import { describe, expect, it } from 'vitest';
import { OPTIONAL_CONTAINER_CAPABILITIES } from '../contracts/driver.ts';
import { DEFAULT_LAZY_CONTAINER_SPECS, lazyContainer } from './defaults.ts';

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
});
