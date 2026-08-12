import { describe, expect, it, vi } from 'vitest';
import type { FilterDriver, FilterSpec, TrackInfo } from '../contracts/driver.ts';
import {
  type MediaFilterRunnerContext,
  applyAudioFrameFilters,
  applyVideoFrameFilters,
} from './media-filter-runner.ts';

function streamOf<T>(values: readonly T[] = []): ReadableStream<T> {
  let index = 0;
  return new ReadableStream<T>({
    pull(controller): void {
      const value = values[index++];
      if (value === undefined) controller.close();
      else controller.enqueue(value);
    },
  });
}

function context(specs: FilterSpec[]): MediaFilterRunnerContext {
  const driver = {
    createFilter(spec: FilterSpec) {
      specs.push(spec);
      return new TransformStream({
        transform(value, controller): void {
          controller.enqueue(value);
        },
      });
    },
  } as FilterDriver;
  return {
    routeFilter: vi.fn(async () => driver),
    stageOptions: () => ({ determinism: 'auto' }),
  };
}

const VIDEO_TRACK: TrackInfo = {
  id: 1,
  mediaType: 'video',
  codec: 'h264',
  config: { codec: 'avc1.42E01E', codedWidth: 320, codedHeight: 240 },
};

const AUDIO_TRACK: TrackInfo = {
  id: 2,
  mediaType: 'audio',
  codec: 'pcm-s16',
  config: { codec: 'pcm-s16', sampleRate: 48_000, numberOfChannels: 2 },
};

describe('lazy media filter orchestration', () => {
  it('returns untouched video and audio streams when no pixel or sample operation is requested', async () => {
    const specs: FilterSpec[] = [];
    const dependencies = context(specs);
    const video = streamOf<VideoFrame>();
    const audio = streamOf<AudioData>();
    await expect(
      applyVideoFrameFilters(
        video,
        {},
        VIDEO_TRACK,
        new AbortController().signal,
        {},
        dependencies,
      ),
    ).resolves.toBe(video);
    await expect(
      applyAudioFrameFilters(
        audio,
        {},
        AUDIO_TRACK,
        new AbortController().signal,
        {},
        dependencies,
      ),
    ).resolves.toBe(audio);
    expect(dependencies.routeFilter).not.toHaveBeenCalled();
  });

  it('routes and composes planned video and audio filter stages', async () => {
    const specs: FilterSpec[] = [];
    const dependencies = context(specs);
    const frame = {} as VideoFrame;
    const video = await applyVideoFrameFilters(
      streamOf([frame]),
      { width: 160, height: 120 },
      VIDEO_TRACK,
      new AbortController().signal,
      {},
      dependencies,
    );
    await expect(video.getReader().read()).resolves.toEqual({ done: false, value: frame });

    const sample = {} as AudioData;
    const audio = await applyAudioFrameFilters(
      streamOf([sample]),
      { gainDb: -6 },
      AUDIO_TRACK,
      new AbortController().signal,
      {},
      dependencies,
    );
    await expect(audio.getReader().read()).resolves.toEqual({ done: false, value: sample });
    expect(specs).toEqual([
      { mediaType: 'video', type: 'resize', width: 160, height: 120 },
      { mediaType: 'audio', type: 'gain', db: -6 },
    ]);
  });

  it('keeps a non-bypassed but identity audio plan allocation-free', async () => {
    const specs: FilterSpec[] = [];
    const dependencies = context(specs);
    const audio = streamOf<AudioData>();
    await expect(
      applyAudioFrameFilters(
        audio,
        { gainDb: 0 },
        AUDIO_TRACK,
        new AbortController().signal,
        {},
        dependencies,
      ),
    ).resolves.toBe(audio);
    expect(dependencies.routeFilter).not.toHaveBeenCalled();
  });

  it.each([2, Number.NaN])('plans CFR retiming with finite duration %s', async (durationSec) => {
    const dependencies = context([]);
    const output = await applyVideoFrameFilters(
      streamOf(),
      { fps: 25 },
      { ...VIDEO_TRACK, durationSec },
      new AbortController().signal,
      {},
      dependencies,
    );
    await output.cancel();
  });
});
