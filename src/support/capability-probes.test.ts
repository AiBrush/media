import { describe, expect, it } from 'vitest';
import {
  PROBE_FIRST_CAPABILITIES,
  UA_FALLBACK_ALLOWED,
  assertProbePolicy,
  isProbeFirstCapability,
  isUaAllowed,
  isUaFallbackAllowed,
} from './capability-probes.ts';

describe('capability probes — §9 4.2 probe before UA', () => {
  it('probe-first list covers 10 capabilities and UA fallback only for documented ones', () => {
    expect(PROBE_FIRST_CAPABILITIES.length).toBe(10);
    expect(PROBE_FIRST_CAPABILITIES).toEqual([
      'webcodecs-video-decode',
      'webcodecs-video-encode',
      'webcodecs-audio-decode',
      'webcodecs-audio-encode',
      'webgpu',
      'workers',
      'opfs',
      'range-server',
      'isolation',
      'image-decoder',
    ]);
    expect(UA_FALLBACK_ALLOWED).toEqual(['image-decoder']);
    for (const c of PROBE_FIRST_CAPABILITIES) expect(isProbeFirstCapability(c)).toBe(true);
    expect(isProbeFirstCapability('unknown')).toBe(false);
    expect(isUaFallbackAllowed('webcodecs-video-decode')).toBe(false);
    expect(isUaFallbackAllowed('image-decoder')).toBe(true);
  });

  it('UA only allowed when probe impossible and documented', () => {
    expect(isUaAllowed('webcodecs-video-decode', true)).toBe(false);
    expect(isUaAllowed('webcodecs-video-decode', false)).toBe(false);
    expect(isUaAllowed('image-decoder', true)).toBe(false);
    expect(isUaAllowed('image-decoder', false)).toBe(true);
    expect(() => assertProbePolicy('webcodecs-video-decode', 'probe', true)).not.toThrow();
    expect(() => assertProbePolicy('image-decoder', 'ua', false)).not.toThrow();
    expect(() => assertProbePolicy('webcodecs-video-decode', 'ua', true)).toThrow(RangeError);
    expect(() => assertProbePolicy('webcodecs-video-decode', 'ua', false)).toThrow(RangeError);
  });

  it('not-supported resolution always allowed', () => {
    expect(() => assertProbePolicy('webcodecs-video-decode', 'not-supported', true)).not.toThrow();
    expect(() => assertProbePolicy('webcodecs-video-decode', 'not-supported', false)).not.toThrow();
  });

  it('20× randomized deterministic never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const cap = PROBE_FIRST_CAPABILITIES[i % PROBE_FIRST_CAPABILITIES.length]!;
      const probePossible = i % 3 !== 0;
      expect(typeof isProbeFirstCapability(cap)).toBe('boolean');
      expect(typeof isUaAllowed(cap, probePossible)).toBe('boolean');
      const res = probePossible ? 'probe' : isUaFallbackAllowed(cap) ? 'ua' : 'not-supported';
      expect(() => assertProbePolicy(cap, res as never, probePossible)).not.toThrow();
    }
  });

  it('boundary: probe impossible vs possible', () => {
    expect(isUaAllowed('image-decoder', true)).toBe(false);
    expect(isUaAllowed('image-decoder', false)).toBe(true);
    expect(() => assertProbePolicy('image-decoder', 'ua', true)).toThrow(RangeError);
    expect(() => assertProbePolicy('image-decoder', 'probe', false)).not.toThrow();
    expect(isProbeFirstCapability('')).toBe(false);
  });

  it('malformed throws RangeError never huge-alloc', () => {
    expect(() => isProbeFirstCapability(null as never)).toThrow(RangeError);
    expect(() => isProbeFirstCapability('x'.repeat(50) as never)).toThrow(RangeError);
    expect(() => isUaFallbackAllowed(null as never)).toThrow(RangeError);
    expect(() => isUaFallbackAllowed('unknown' as never)).toThrow(RangeError);
    expect(() => isUaAllowed('unknown' as never, true as never)).toThrow(RangeError);
    expect(() => isUaAllowed('webcodecs-video-decode' as never, null as never)).toThrow(RangeError);
    expect(() => assertProbePolicy(null as never, 'probe' as never, true as never)).toThrow(
      RangeError,
    );
    expect(() =>
      assertProbePolicy('webcodecs-video-decode' as never, 'unknown' as never, true as never),
    ).toThrow(RangeError);
    expect(() =>
      assertProbePolicy('webcodecs-video-decode' as never, 'probe' as never, null as never),
    ).toThrow(RangeError);
  });
});
