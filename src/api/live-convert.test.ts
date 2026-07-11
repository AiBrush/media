import { describe, expect, it } from 'vitest';
import type { Muxer } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { fromMediaStream } from '../sources/live-source.ts';
import {
  convertLiveMediaStream,
  runLiveFramePipeline,
  validateLiveConvertOptions,
} from './live-convert.ts';
import type { MediaStreams } from './types.ts';

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  stopCount = 0;
  readonly settings: MediaTrackSettings;

  constructor(
    readonly kind: 'video' | 'audio',
    settings?: MediaTrackSettings,
  ) {
    super();
    this.settings =
      settings ??
      (kind === 'video'
        ? { width: 1280, height: 720, frameRate: 30 }
        : { sampleRate: 44_100, channelCount: 2 });
  }

  getSettings(): MediaTrackSettings {
    return this.settings;
  }

  stop(): void {
    this.stopCount++;
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: readonly FakeTrack[]) {}

  getTracks(): MediaStreamTrack[] {
    return [...this.tracks] as unknown as MediaStreamTrack[];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'video') as unknown as MediaStreamTrack[];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio') as unknown as MediaStreamTrack[];
  }
}

class FakeVideoFrame {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null,
  ) {}

  close(): void {
    this.closeCount++;
  }
}

class FakeAudioData {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null,
  ) {}

  close(): void {
    this.closeCount++;
  }
}

function source(tracks: readonly FakeTrack[]) {
  return fromMediaStream(new FakeMediaStream(tracks) as unknown as MediaStream);
}

function frameStream<T>(frames: readonly T[]): ReadableStream<T> {
  let offset = 0;
  return new ReadableStream<T>(
    {
      pull(controller): void {
        const frame = frames[offset++];
        if (frame === undefined) controller.close();
        else controller.enqueue(frame);
      },
    },
    { highWaterMark: 0 },
  );
}

interface PendingStream<T> {
  readonly stream: ReadableStream<T>;
  readonly pullStarted: Promise<void>;
  readonly cancelCount: () => number;
}

function pendingStream<T>(): PendingStream<T> {
  let markPullStarted: (() => void) | undefined;
  const pullStarted = new Promise<void>((resolve) => {
    markPullStarted = resolve;
  });
  let cancels = 0;
  return {
    stream: new ReadableStream<T>(
      {
        pull(): void {
          markPullStarted?.();
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    ),
    pullStarted,
    cancelCount: () => cancels,
  };
}

async function drainAndClose<T extends VideoFrame | AudioData>(
  stream: ReadableStream<T> | undefined,
): Promise<void> {
  if (stream === undefined) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      next.value.close();
    }
  } finally {
    reader.releaseLock();
  }
}

const VIDEO_TARGET = { codec: 'vp9', width: 640, height: 360 } as const;
const AUDIO_TARGET = { codec: 'opus', sampleRate: 48_000, channels: 2 } as const;

describe('validateLiveConvertOptions', () => {
  it('requires a target container and all geometry/layout facts unavailable to frame encode', () => {
    const input = source([new FakeTrack('video'), new FakeTrack('audio')]);
    expect(() =>
      validateLiveConvertOptions(input, {
        to: 'webm',
        video: VIDEO_TARGET,
        audio: AUDIO_TARGET,
      }),
    ).not.toThrow();
    expect(() =>
      validateLiveConvertOptions(input, { video: VIDEO_TARGET, audio: AUDIO_TARGET }),
    ).toThrowError(InputError);
    expect(() =>
      validateLiveConvertOptions(input, {
        to: 'webm',
        video: { codec: 'vp9' },
        audio: AUDIO_TARGET,
      }),
    ).toThrowError(InputError);
    expect(() =>
      validateLiveConvertOptions(input, {
        to: 'webm',
        video: VIDEO_TARGET,
        audio: { codec: 'opus' },
      }),
    ).toThrowError(InputError);
  });

  it('rejects replay-only two-pass, multiple same-kind tracks, and an empty selection', () => {
    expect(() =>
      validateLiveConvertOptions(source([new FakeTrack('video')]), {
        to: 'webm',
        video: { ...VIDEO_TARGET, twoPass: true },
      }),
    ).toThrowError(CapabilityError);
    expect(() =>
      validateLiveConvertOptions(source([new FakeTrack('video'), new FakeTrack('video')]), {
        to: 'webm',
        video: VIDEO_TARGET,
      }),
    ).toThrowError(InputError);
    expect(() =>
      validateLiveConvertOptions(source([new FakeTrack('video')]), {
        to: 'webm',
        video: false,
      }),
    ).toThrowError(InputError);
  });

  it('rejects missing source settings even when complete output facts are supplied', () => {
    expect(() =>
      validateLiveConvertOptions(source([new FakeTrack('video', {})]), {
        to: 'webm',
        video: VIDEO_TARGET,
      }),
    ).toThrowError(InputError);
    expect(() =>
      validateLiveConvertOptions(source([new FakeTrack('audio', {})]), {
        to: 'webm',
        audio: AUDIO_TARGET,
      }),
    ).toThrowError(InputError);
  });
});

describe('convertLiveMediaStream coordinator', () => {
  it('plans filters from source settings while keeping different output facts separate', async () => {
    const video = new FakeVideoFrame(0, 33_333);
    const audio = new FakeAudioData(0, 20_000);
    let finalized = false;
    const muxer: Muxer = {
      output: frameStream<Uint8Array>([]),
      addTrack: () => 0,
      write: () => Promise.resolve(),
      finalize: () => {
        finalized = true;
        return Promise.resolve();
      },
    };
    const result = await runLiveFramePipeline(
      new FakeMediaStream([
        new FakeTrack('video'),
        new FakeTrack('audio'),
      ]) as unknown as MediaStream,
      {
        video: frameStream([video as unknown as VideoFrame]),
        audio: frameStream([audio as unknown as AudioData]),
      },
      { to: 'webm', video: VIDEO_TARGET, audio: AUDIO_TARGET },
      new AbortController().signal,
      {
        supportsContainer: (target) => target === 'webm',
        createMuxer: () => Promise.resolve(muxer),
        async applyVideoFilters(stream, target, sourceInfo) {
          expect(target).toEqual(VIDEO_TARGET);
          expect(sourceInfo.config).toMatchObject({ codedWidth: 1280, codedHeight: 720 });
          return stream;
        },
        async applyAudioFilters(stream, target, sourceInfo) {
          expect(target).toEqual(AUDIO_TARGET);
          expect(sourceInfo.config).toMatchObject({ sampleRate: 44_100, numberOfChannels: 2 });
          return stream;
        },
        resolveAudioTarget: (target, sourceCodec) => {
          expect(sourceCodec).toBe('raw-audio');
          return Promise.resolve(target);
        },
        encodeVideo: (stream) => drainAndClose(stream),
        encodeAudio: (stream) => drainAndClose(stream),
        materialize: () => {
          expect(finalized).toBe(true);
          return Promise.resolve('mux-complete');
        },
      },
    );

    expect(result).toBe('mux-complete');
    expect(video.closeCount).toBe(1);
    expect(audio.closeCount).toBe(1);
  });

  it('preserves frame timing/ownership and resolves only after source end plus final mux', async () => {
    const videoTrack = new FakeTrack('video');
    const audioTrack = new FakeTrack('audio');
    const video = new FakeVideoFrame(1_000_000, 33_333);
    const audio = new FakeAudioData(980_000, 20_000);
    let releaseFinalize: (() => void) | undefined;
    const finalize = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    let markFinalizeStarted: (() => void) | undefined;
    const finalizeStarted = new Promise<void>((resolve) => {
      markFinalizeStarted = resolve;
    });

    const task = convertLiveMediaStream(
      source([videoTrack, audioTrack]),
      { to: 'webm', video: VIDEO_TARGET, audio: AUDIO_TARGET },
      {
        decode: (): MediaStreams => ({
          video: frameStream([video as unknown as VideoFrame]),
          audio: frameStream([audio as unknown as AudioData]),
        }),
        async run(frames): Promise<string> {
          await Promise.all([drainAndClose(frames.video), drainAndClose(frames.audio)]);
          markFinalizeStarted?.();
          await finalize;
          return 'mux-complete';
        },
      },
    );
    let settled = false;
    void task.then(() => {
      settled = true;
    });
    await finalizeStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFinalize?.();

    await expect(task).resolves.toBe('mux-complete');
    expect(video.timestamp).toBe(1_000_000);
    expect(video.duration).toBe(33_333);
    expect(audio.timestamp).toBe(980_000);
    expect(audio.duration).toBe(20_000);
    expect(video.closeCount).toBe(1);
    expect(audio.closeCount).toBe(1);
    expect(videoTrack.stopCount).toBe(0);
    expect(audioTrack.stopCount).toBe(0);
  });

  it('cancels the pending sibling stream and preserves the primary typed failure', async () => {
    const primary = new MediaError('encode-error', 'video encoder failed');
    const audio = pendingStream<AudioData>();
    const failingVideo = new ReadableStream<VideoFrame>({
      start(controller): void {
        controller.error(primary);
      },
    });
    const task = convertLiveMediaStream(
      source([new FakeTrack('video'), new FakeTrack('audio')]),
      { to: 'webm', video: VIDEO_TARGET, audio: AUDIO_TARGET },
      {
        decode: () => ({ video: failingVideo, audio: audio.stream }),
        async run(frames): Promise<string> {
          await Promise.all([drainAndClose(frames.video), drainAndClose(frames.audio)]);
          return 'unreachable';
        },
      },
    );
    await audio.pullStarted;

    await expect(task).rejects.toBe(primary);
    expect(audio.cancelCount()).toBe(1);
  });

  it('does not deadlock when setup fails after a sibling encoder locks its relay', async () => {
    const input = source([new FakeTrack('video'), new FakeTrack('audio')]);
    const video = pendingStream<VideoFrame>();
    const audio = frameStream<AudioData>([]);
    const primary = new MediaError('encode-error', 'audio target resolution failed');
    const muxer: Muxer = {
      output: frameStream<Uint8Array>([]),
      addTrack: () => 0,
      write: () => Promise.resolve(),
      finalize: () => Promise.resolve(),
    };
    const task = convertLiveMediaStream(
      input,
      { to: 'webm', video: VIDEO_TARGET, audio: AUDIO_TARGET },
      {
        decode: () => ({ video: video.stream, audio }),
        run: (frames, options, signal) =>
          runLiveFramePipeline(input.mediaStream, frames, options, signal, {
            supportsContainer: () => true,
            createMuxer: () => Promise.resolve(muxer),
            applyVideoFilters: (stream) => Promise.resolve(stream),
            applyAudioFilters: (stream) => Promise.resolve(stream),
            resolveAudioTarget: () => Promise.reject(primary),
            encodeVideo: (stream) => drainAndClose(stream),
            encodeAudio: (stream) => drainAndClose(stream),
            materialize: () => Promise.resolve('unreachable'),
          }),
      },
    );
    await video.pullStarted;

    await expect(task).rejects.toBe(primary);
    expect(video.cancelCount()).toBe(1);
  });

  it('shares cancellation across both pending tracks and never returns a partial mux result', async () => {
    const video = pendingStream<VideoFrame>();
    const audio = pendingStream<AudioData>();
    const task = convertLiveMediaStream(
      source([new FakeTrack('video'), new FakeTrack('audio')]),
      { to: 'webm', video: VIDEO_TARGET, audio: AUDIO_TARGET },
      {
        decode: () => ({ video: video.stream, audio: audio.stream }),
        async run(frames): Promise<string> {
          await Promise.all([drainAndClose(frames.video), drainAndClose(frames.audio)]);
          return 'partial-output-must-be-discarded';
        },
      },
    );
    await Promise.all([video.pullStarted, audio.pullStarted]);
    task.cancel();

    await expect(task).rejects.toMatchObject({ code: 'aborted' });
    expect(video.cancelCount()).toBe(1);
    expect(audio.cancelCount()).toBe(1);
  });

  it('wraps an unexpected runner exception in the typed encode-error model', async () => {
    const task = convertLiveMediaStream(
      source([new FakeTrack('video')]),
      { to: 'webm', video: VIDEO_TARGET },
      {
        decode: () => ({ video: frameStream<VideoFrame>([]) }),
        run: () => Promise.reject(new Error('host failure')),
      },
    );
    await expect(task).rejects.toMatchObject({ code: 'encode-error' });
  });
});
