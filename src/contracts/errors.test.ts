import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError, MediaError } from './errors.ts';

describe('MediaError', () => {
  it('carries code, message, and reflects the class name', () => {
    const err = new MediaError('decode-error', 'boom');
    expect(err.code).toBe('decode-error');
    expect(err.message).toBe('boom');
    expect(err.name).toBe('MediaError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MediaError);
  });

  it('preserves an optional structured detail and leaves it undefined when omitted', () => {
    const detail = { tried: ['a', 'b'] };
    expect(new MediaError('mux-error', 'm', detail).detail).toBe(detail);
    expect(new MediaError('mux-error', 'm').detail).toBeUndefined();
  });

  it('is throwable and catchable as a typed error with a stack', () => {
    try {
      throw new MediaError('aborted', 'cancelled');
    } catch (e) {
      expect(e).toBeInstanceOf(MediaError);
      expect((e as MediaError).code).toBe('aborted');
      expect(typeof (e as MediaError).stack).toBe('string');
    }
  });
});

describe('CapabilityError', () => {
  it('subclasses MediaError, reflects its own name, and carries detail', () => {
    const detail = {
      op: { codec: 'flac' },
      tried: ['webcodecs-audio'],
      suggestion: 'register wasm-flac',
    };
    const err = new CapabilityError('capability-miss', 'no codec driver for flac', detail);
    expect(err).toBeInstanceOf(MediaError);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.name).toBe('CapabilityError');
    expect(err.code).toBe('capability-miss');
    expect(err.detail).toEqual(detail);
  });
});

describe('InputError', () => {
  it('subclasses MediaError and reflects its own name', () => {
    const err = new InputError('unsupported-input', 'garbled bytes');
    expect(err).toBeInstanceOf(MediaError);
    expect(err).toBeInstanceOf(InputError);
    expect(err.name).toBe('InputError');
    expect(err.code).toBe('unsupported-input');
  });

  it('is distinguishable from a sibling subclass', () => {
    expect(new InputError('unsupported-input', 'x')).not.toBeInstanceOf(CapabilityError);
  });
});
