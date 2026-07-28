import { describe, expect, it, vi } from 'vitest';
import type { ContainerDriver } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { preflightConvert } from './convert-preflight.ts';

function context() {
  return {
    muxer: vi.fn<() => Promise<ContainerDriver>>(),
    probeCodec: vi.fn<() => Promise<void>>(),
  };
}

describe('convert target preflight — explicit audio mix matrix', () => {
  it.each(['wav', 'aiff', 'caf', 'flac'] as const)(
    'accepts a matrix on the PCM-native %s authoring path',
    async (to) => {
      const dependencies = context();
      await expect(
        preflightConvert(dependencies, {
          to,
          audio: { channels: 1, mixMatrix: [[0.5, 0.5]] },
        }),
      ).resolves.toBeUndefined();
      expect(dependencies.muxer).not.toHaveBeenCalled();
      expect(dependencies.probeCodec).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'mp4', 'webm'] as const)(
    'rejects a matrix before probing a non-PCM target (%s)',
    async (to) => {
      const dependencies = context();
      await expect(
        preflightConvert(dependencies, {
          ...(to === undefined ? {} : { to }),
          audio: { channels: 1, mixMatrix: [[0.5, 0.5]] },
        }),
      ).rejects.toBeInstanceOf(CapabilityError);
      expect(dependencies.muxer).not.toHaveBeenCalled();
      expect(dependencies.probeCodec).not.toHaveBeenCalled();
    },
  );
});
