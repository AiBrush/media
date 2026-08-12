import { describe, expect, it, vi } from 'vitest';
import type { CodecQuery, ContainerDriver } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { canConvert, preflightConvert } from './convert-preflight.ts';

function context() {
  return {
    muxer: vi.fn<(target: string) => Promise<ContainerDriver>>(),
    probeCodec: vi.fn<(query: CodecQuery) => Promise<void>>(),
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

describe('convert target preflight — route projection', () => {
  it('rejects video on a PCM-family target before probing routes', async () => {
    const dependencies = context();
    await expect(
      preflightConvert(dependencies, { to: 'flac', audio: { codec: 'flac' }, video: {} }),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(dependencies.muxer).not.toHaveBeenCalled();
    expect(dependencies.probeCodec).not.toHaveBeenCalled();
  });

  it('projects an ordinary container and both explicit codecs into route probes', async () => {
    const dependencies = context();
    dependencies.muxer.mockResolvedValue({} as ContainerDriver);
    dependencies.probeCodec.mockResolvedValue(undefined);
    await preflightConvert(dependencies, {
      to: 'mp4',
      video: { codec: 'h264' },
      audio: { codec: 'aac' },
    });
    expect(dependencies.muxer).toHaveBeenCalledWith('mp4');
    expect(dependencies.probeCodec).toHaveBeenCalledTimes(2);
    expect(dependencies.probeCodec.mock.calls.map(([query]) => query)).toMatchObject([
      { mediaType: 'video', direction: 'encode' },
      { mediaType: 'audio', direction: 'encode' },
    ]);
  });

  it('does not manufacture routes for omitted output and disabled tracks', async () => {
    const dependencies = context();
    await preflightConvert(dependencies, { audio: false, video: false });
    expect(dependencies.muxer).not.toHaveBeenCalled();
    expect(dependencies.probeCodec).not.toHaveBeenCalled();
  });

  it('maps typed capability failures to false without hiding programmer errors', async () => {
    const unsupported = context();
    unsupported.muxer.mockRejectedValue(new MediaError('capability-miss', 'no route'));
    await expect(canConvert(unsupported, { to: 'mp4' })).resolves.toBe(false);

    const supported = context();
    supported.muxer.mockResolvedValue({} as ContainerDriver);
    await expect(canConvert(supported, { to: 'mp4' })).resolves.toBe(true);

    const failure = new Error('route registry bug');
    const broken = context();
    broken.muxer.mockRejectedValue(failure);
    await expect(canConvert(broken, { to: 'mp4' })).rejects.toBe(failure);
  });
});
