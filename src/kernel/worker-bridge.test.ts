import { describe, expect, it } from 'vitest';
import { InlineBridge } from './worker-bridge.ts';

describe('InlineBridge', () => {
  it('runs a task on the calling thread and returns its result', async () => {
    const bridge = new InlineBridge();
    await expect(bridge.run(async () => 21 * 2)).resolves.toBe(42);
  });

  it('propagates task rejections', async () => {
    const bridge = new InlineBridge();
    await expect(bridge.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('terminate() resolves and is idempotent', async () => {
    const bridge = new InlineBridge();
    await expect(bridge.terminate()).resolves.toBeUndefined();
    await expect(bridge.terminate()).resolves.toBeUndefined();
  });
});
