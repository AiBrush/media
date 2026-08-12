import { describe, expect, it, vi } from 'vitest';
import type { FilterDriver, FilterSpec } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { applyDecodedDisplayRotation } from './decoded-display-rotation.ts';

function emptyFrames(onCancel?: () => void): ReadableStream<VideoFrame> {
  const source: UnderlyingDefaultSource<VideoFrame> =
    onCancel === undefined ? {} : { cancel: onCancel };
  return new ReadableStream<VideoFrame>(source);
}

describe('decoded display rotation', () => {
  it('keeps identity rotations lazy', async () => {
    const frames = emptyFrames();
    const route = vi.fn<() => Promise<FilterDriver>>();
    await expect(applyDecodedDisplayRotation(frames, 360, {}, route)).resolves.toBe(frames);
    expect(route).not.toHaveBeenCalled();
  });

  it.each([90, 180, 270])('routes a normalized %i-degree quarter turn', async (degrees) => {
    const frames = emptyFrames();
    let received: FilterSpec | undefined;
    const driver = {
      createFilter(spec: FilterSpec) {
        received = spec;
        return new TransformStream<VideoFrame, VideoFrame>();
      },
    } as FilterDriver;
    const output = await applyDecodedDisplayRotation(frames, degrees - 360, {}, async () => driver);
    expect(output).not.toBe(frames);
    expect(received).toEqual({ mediaType: 'video', type: 'rotate', degrees });
  });

  it('cancels the input when rotation is not a quarter turn', async () => {
    const cancelled = vi.fn();
    const frames = emptyFrames(cancelled);
    await expect(
      applyDecodedDisplayRotation(frames, 45, {}, async () => null as never),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cancels the input when filter routing fails', async () => {
    const cancelled = vi.fn();
    const frames = emptyFrames(cancelled);
    const failure = new Error('filter unavailable');
    await expect(
      applyDecodedDisplayRotation(frames, 90, {}, async () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
