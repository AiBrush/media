import { describe, expect, it } from 'vitest';
import { DRIVER_API_VERSION } from './driver.ts';

describe('driver contract', () => {
  it('pins DRIVER_API_VERSION to the v1 integer-major', () => {
    expect(DRIVER_API_VERSION).toBe(1);
  });
});
