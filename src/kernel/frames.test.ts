import { describe, expect, it, vi } from 'vitest';
import { closeFrame, closeFrames, isClosable } from './frames.ts';

describe('frame-lifetime helpers', () => {
  it('isClosable recognizes a close()-bearing handle only', () => {
    expect(isClosable({ close: () => {} })).toBe(true);
    expect(isClosable({})).toBe(false);
    expect(isClosable(null)).toBe(false);
    expect(isClosable(42)).toBe(false);
  });

  it('closeFrame releases a closable and ignores anything else', () => {
    const close = vi.fn();
    closeFrame({ close });
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => closeFrame(undefined)).not.toThrow();
  });

  it('closeFrames drains every closable in an iterable', () => {
    const a = vi.fn();
    const b = vi.fn();
    closeFrames([{ close: a }, 'not-a-frame', { close: b }]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('pins the close-error policy: a teardown close() throw is swallowed, never rethrown', () => {
    const close = vi.fn(() => {
      throw new Error('handle already released');
    });
    expect(() => closeFrame({ close })).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('pins double-close behavior: the helper never dedupes — close-once stays with the caller', () => {
    const close = vi.fn();
    const frame = { close };
    closeFrame(frame);
    closeFrame(frame);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
