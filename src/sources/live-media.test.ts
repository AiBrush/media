import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import {
  type LiveTrackProcessorFactory,
  captureElementMediaStream,
  decodeLiveMediaStream,
  fromMediaStream,
  isLiveMediaSource,
  liveTrackInfo,
  mediaStreamOf,
  probeLiveMediaStream,
  rejectLiveByteOperation,
} from './live-media.ts';

class FakeVideoFrame {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null = null,
  ) {}

  close(): void {
    this.closeCount++;
  }
}

class FakeAudioData {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null = null,
  ) {}

  close(): void {
    this.closeCount++;
  }
}

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  stopCount = 0;

  constructor(readonly kind: 'video' | 'audio') {
    super();
  }

  settings: MediaTrackSettings = {};

  getSettings(): MediaTrackSettings {
    return this.settings;
  }

  stop(): void {
    this.stopCount++;
    this.end();
  }

  end(): void {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: readonly FakeTrack[]) {}

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'video') as unknown as MediaStreamTrack[];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio') as unknown as MediaStreamTrack[];
  }

  getTracks(): MediaStreamTrack[] {
    return [...this.getVideoTracks(), ...this.getAudioTracks()];
  }
}

interface FactoryCall {
  readonly track: MediaStreamTrack;
  readonly kind: 'video' | 'audio';
  readonly maxBufferSize: number;
}

function factoryFor(
  create: (track: MediaStreamTrack, kind: 'video' | 'audio') => ReadableStream<unknown>,
): LiveTrackProcessorFactory & { readonly calls: FactoryCall[] } {
  const calls: FactoryCall[] = [];
  return {
    calls,
    create(track, kind, maxBufferSize): ReadableStream<unknown> {
      calls.push({ track, kind, maxBufferSize });
      return create(track, kind);
    },
  };
}

function streamOf(
  values: readonly unknown[],
  onPull: () => void = () => {},
): ReadableStream<unknown> {
  let index = 0;
  return new ReadableStream<unknown>(
    {
      pull(controller): void {
        onPull();
        const value = values[index++];
        if (value === undefined) controller.close();
        else controller.enqueue(value);
      },
    },
    { highWaterMark: 0 },
  );
}

interface LateReaderHarness {
  readonly readable: ReadableStream<unknown>;
  readonly readStarted: Promise<void>;
  readonly cancelCount: () => number;
  readonly releaseCount: () => number;
}

function lateFrameOnCancel(frame: unknown): LateReaderHarness {
  let resolveRead:
    | ((result: { readonly done: false; readonly value: unknown }) => void)
    | undefined;
  let markReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const pendingRead = new Promise<{ readonly done: false; readonly value: unknown }>((resolve) => {
    resolveRead = resolve;
  });
  let cancels = 0;
  let releases = 0;
  const readable = {
    getReader() {
      return {
        read() {
          markReadStarted?.();
          return pendingRead;
        },
        cancel() {
          cancels++;
          resolveRead?.({ done: false, value: frame });
          return Promise.resolve();
        },
        releaseLock() {
          releases++;
        },
      };
    },
  } as unknown as ReadableStream<unknown>;
  return {
    readable,
    readStarted,
    cancelCount: () => cancels,
    releaseCount: () => releases,
  };
}

function liveSource(tracks: readonly FakeTrack[]) {
  return fromMediaStream(new FakeMediaStream(tracks) as unknown as MediaStream);
}

beforeEach(() => {
  vi.stubGlobal('VideoFrame', FakeVideoFrame as unknown as typeof VideoFrame);
  vi.stubGlobal('AudioData', FakeAudioData as unknown as typeof AudioData);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('live MediaStream source identity', () => {
  it('rejects malformed source identities and capture failures at the public boundary', () => {
    expect(() => fromMediaStream({} as MediaStream)).toThrowError(InputError);
    expect(isLiveMediaSource(null)).toBe(false);
    expect(isLiveMediaSource({ __media: 'live-source' })).toBe(false);
    expect(() =>
      captureElementMediaStream({
        captureStream(): never {
          throw new Error('capture denied');
        },
      } as unknown as HTMLMediaElement),
    ).toThrowError(CapabilityError);
    expect(() =>
      captureElementMediaStream({ captureStream: () => ({}) } as unknown as HTMLMediaElement),
    ).toThrowError(CapabilityError);
  });

  it('brands a MediaStream distinctly from byte Source and unwraps it exactly', () => {
    const stream = new FakeMediaStream([]) as unknown as MediaStream;
    const source = fromMediaStream(stream);
    expect(source.kind).toBe('media-stream');
    expect(isLiveMediaSource(source)).toBe(true);
    expect(mediaStreamOf(source)).toBe(stream);
    expect(mediaStreamOf(stream)).toBe(stream);
    expect(mediaStreamOf({})).toBeUndefined();
  });

  it('captures an element only through an explicit supported captureStream call', () => {
    const stream = new FakeMediaStream([]) as unknown as MediaStream;
    let calls = 0;
    const source = captureElementMediaStream({
      captureStream(): MediaStream {
        calls++;
        return stream;
      },
    } as unknown as HTMLMediaElement);
    expect(calls).toBe(1);
    expect(mediaStreamOf(source)).toBe(stream);

    expect(() => captureElementMediaStream({} as HTMLMediaElement)).toThrowError(CapabilityError);
  });

  it('validates raw structural streams and truthful optional/other-track facts', () => {
    expect(() => probeLiveMediaStream({} as MediaStream)).toThrowError(InputError);
    expect(() => liveTrackInfo({} as MediaStream, 'video')).toThrowError(InputError);
    expect(() => decodeLiveMediaStream({} as MediaStream)).toThrowError(InputError);

    const other = {
      kind: 'text',
      readyState: 'live',
      getSettings: () => ({ width: -1, height: Number.NaN }),
    } as unknown as MediaStreamTrack;
    const structural = {
      getTracks: () => [other],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    expect(probeLiveMediaStream(structural).tracks).toEqual([
      { id: 0, type: 'other', codec: 'raw-track' },
    ]);
    expect(liveTrackInfo(structural, 'video')).toBeUndefined();
    expect(liveTrackInfo(structural, 'audio')).toBeUndefined();
    expect(decodeLiveMediaStream(structural)).toEqual({});
  });

  it('survives missing/throwing track settings and rejects fractional source layouts', () => {
    const missingSettings = new FakeTrack('video') as FakeTrack & {
      getSettings: undefined;
    };
    Object.defineProperty(missingSettings, 'getSettings', { value: undefined });
    expect(probeLiveMediaStream(liveSource([missingSettings])).tracks[0]).toEqual({
      id: 0,
      type: 'video',
      codec: 'raw-video',
    });

    const throwingSettings = new FakeTrack('audio');
    throwingSettings.getSettings = (): never => {
      throw new Error('detached track');
    };
    expect(probeLiveMediaStream(liveSource([throwingSettings])).tracks[0]).toEqual({
      id: 0,
      type: 'audio',
      codec: 'raw-audio',
    });

    const video = new FakeTrack('video');
    video.settings = { width: 640.5, height: 480, frameRate: 0 };
    expect(() => liveTrackInfo(liveSource([video]), 'video')).toThrowError(InputError);
    const audio = new FakeTrack('audio');
    audio.settings = { sampleRate: 48_000, channelCount: 1.5 };
    expect(() => liveTrackInfo(liveSource([audio]), 'audio')).toThrowError(InputError);
  });

  it('includes the dedicated suggestion only for live convert', () => {
    try {
      rejectLiveByteOperation('convert');
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityError);
      expect(error).toMatchObject({
        detail: { suggestion: 'use the dedicated live decode→encode path' },
      });
    }
  });

  it('typed-declines byte/container operations on a raw live source', () => {
    for (const op of ['probe', 'demux', 'remux', 'trim', 'seek', 'decrypt', 'two-pass', 'abr']) {
      expect(() => rejectLiveByteOperation(op)).toThrowError(CapabilityError);
    }
  });

  it('probes only truthful current live-track settings without guessing codecs or bytes', () => {
    const video = new FakeTrack('video');
    video.settings = { width: 1280, height: 720, frameRate: 59.94 };
    const ended = new FakeTrack('video');
    ended.settings = { width: 1, height: 1 };
    ended.end();
    const audio = new FakeTrack('audio');
    audio.settings = { sampleRate: 48_000, channelCount: 2 };

    const info = probeLiveMediaStream(liveSource([video, ended, audio]));
    expect(info).toEqual({
      container: 'media-stream',
      durationSec: Number.POSITIVE_INFINITY,
      tracks: [
        {
          id: 0,
          type: 'video',
          codec: 'raw-video',
          width: 1280,
          height: 720,
          fps: 59.94,
        },
        { id: 1, type: 'audio', codec: 'raw-audio', sampleRate: 48_000, channels: 2 },
      ],
      tags: { live: 'true', duration: 'unbounded' },
    });
    // JSON has no Infinity token and serializes the in-memory unbounded sentinel to null; the explicit
    // live/duration tags preserve its meaning for exported JSON consumers.
    expect(JSON.parse(JSON.stringify(info))).toMatchObject({
      durationSec: null,
      tags: { live: 'true', duration: 'unbounded' },
    });
  });

  it('keeps source geometry/layout distinct from different output targets', () => {
    const video = new FakeTrack('video');
    video.settings = { width: 1920, height: 1080, frameRate: 24 };
    const audio = new FakeTrack('audio');
    audio.settings = { sampleRate: 44_100, channelCount: 1 };
    const input = liveSource([video, audio]);

    expect(liveTrackInfo(input, 'video')).toMatchObject({
      codec: 'raw-video',
      fps: 24,
      config: { codedWidth: 1920, codedHeight: 1080 },
    });
    expect(liveTrackInfo(input, 'audio')).toMatchObject({
      codec: 'raw-audio',
      config: { sampleRate: 44_100, numberOfChannels: 1 },
    });
  });

  it('rejects missing source settings instead of substituting requested output facts', () => {
    expect(() => liveTrackInfo(liveSource([new FakeTrack('video')]), 'video')).toThrowError(
      InputError,
    );
    expect(() => liveTrackInfo(liveSource([new FakeTrack('audio')]), 'audio')).toThrowError(
      InputError,
    );
  });
});

describe('decodeLiveMediaStream', () => {
  it('maps default processor constructor and readable-shape failures', async () => {
    vi.stubGlobal(
      'MediaStreamTrackProcessor',
      class {
        constructor() {
          throw new Error('host rejected track');
        }
      },
    );
    const rejected = decodeLiveMediaStream(liveSource([new FakeTrack('video')])).video?.getReader();
    if (rejected === undefined) throw new Error('expected live video stream');
    await expect(rejected.read()).rejects.toBeInstanceOf(CapabilityError);

    vi.stubGlobal(
      'MediaStreamTrackProcessor',
      class {
        readonly readable = {};
      },
    );
    const malformed = decodeLiveMediaStream(
      liveSource([new FakeTrack('video')]),
    ).video?.getReader();
    if (malformed === undefined) throw new Error('expected live video stream');
    await expect(malformed.read()).rejects.toBeInstanceOf(CapabilityError);
  });

  it('maps custom invalid, locked, and capability-preserving processor factories', async () => {
    const invalid = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      processorFactory: factoryFor(() => ({}) as ReadableStream<unknown>),
    }).video?.getReader();
    if (invalid === undefined) throw new Error('expected live video stream');
    await expect(invalid.read()).rejects.toBeInstanceOf(CapabilityError);

    const stream = streamOf([]);
    const held = stream.getReader();
    const locked = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      processorFactory: factoryFor(() => stream),
    }).video?.getReader();
    if (locked === undefined) throw new Error('expected live video stream');
    await expect(locked.read()).rejects.toBeInstanceOf(CapabilityError);
    held.releaseLock();

    const primary = new CapabilityError('capability-miss', 'known host miss');
    const preserved = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      processorFactory: factoryFor(() => {
        throw primary;
      }),
    }).video?.getReader();
    if (preserved === undefined) throw new Error('expected live video stream');
    await expect(preserved.read()).rejects.toBe(primary);
  });

  it('closes before processor creation for pre-abort and pre-pull track end', async () => {
    const primary = new MediaError('aborted', 'caller stop');
    const ctrl = new AbortController();
    ctrl.abort(primary);
    const factory = factoryFor(() => streamOf([]));
    const aborted = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      signal: ctrl.signal,
      processorFactory: factory,
    }).video?.getReader();
    if (aborted === undefined) throw new Error('expected live video stream');
    await expect(aborted.read()).rejects.toBe(primary);
    expect(factory.calls).toHaveLength(0);

    const endedTrack = new FakeTrack('video');
    const ended = decodeLiveMediaStream(liveSource([endedTrack]), {
      processorFactory: factory,
    }).video?.getReader();
    endedTrack.end();
    if (ended === undefined) throw new Error('expected live video stream');
    await expect(ended.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('handles end during processor creation and ordinary processor EOF', async () => {
    const endingTrack = new FakeTrack('video');
    const ending = decodeLiveMediaStream(liveSource([endingTrack]), {
      processorFactory: factoryFor(() => {
        endingTrack.end();
        return streamOf([]);
      }),
    }).video?.getReader();
    if (ending === undefined) throw new Error('expected live video stream');
    await expect(ending.read()).resolves.toEqual({ done: true, value: undefined });

    const eof = decodeLiveMediaStream(liveSource([new FakeTrack('audio')]), {
      processorFactory: factoryFor(() => streamOf([])),
    }).audio?.getReader();
    if (eof === undefined) throw new Error('expected live audio stream');
    await expect(eof.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('classifies null, primitive, and close-failing wrong frames without masking the primary error', async () => {
    for (const value of [
      null,
      7,
      {
        close: () => {
          throw new Error('close failed');
        },
      },
      {},
    ]) {
      const reader = decodeLiveMediaStream(liveSource([new FakeTrack('audio')]), {
        processorFactory: factoryFor(() => streamOf([value])),
      }).audio?.getReader();
      if (reader === undefined) throw new Error('expected live audio stream');
      await expect(reader.read()).rejects.toBeInstanceOf(CapabilityError);
    }
  });

  it('maps an untyped processor read rejection and non-finite first timestamp', async () => {
    const failing = new ReadableStream<unknown>({
      pull(): never {
        throw new Error('host read failed');
      },
    });
    const reader = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      processorFactory: factoryFor(() => failing),
    }).video?.getReader();
    if (reader === undefined) throw new Error('expected live video stream');
    await expect(reader.read()).rejects.toMatchObject({ code: 'decode-error' });

    const invalidTime = new FakeVideoFrame(Number.NaN);
    const timeReader = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      processorFactory: factoryFor(() => streamOf([invalidTime])),
    }).video?.getReader();
    if (timeReader === undefined) throw new Error('expected live video stream');
    await expect(timeReader.read()).rejects.toMatchObject({ code: 'decode-error' });
    expect(invalidTime.closeCount).toBe(1);
  });
  it('rejects multiple live tracks of one kind instead of silently selecting one', () => {
    const factory = factoryFor(() => streamOf([]));
    expect(() =>
      decodeLiveMediaStream(liveSource([new FakeTrack('video'), new FakeTrack('video')]), {
        processorFactory: factory,
      }),
    ).toThrowError(InputError);
    expect(factory.calls).toHaveLength(0);
  });

  it('ignores already-ended tracks and creates no processor for an empty live source', () => {
    const ended = new FakeTrack('video');
    ended.end();
    const factory = factoryFor(() => streamOf([]));
    expect(decodeLiveMediaStream(liveSource([ended]), { processorFactory: factory })).toEqual({});
    expect(factory.calls).toHaveLength(0);
  });

  it('is lazy and performs exactly one processor read per downstream pull', async () => {
    const track = new FakeTrack('video');
    const frames = [new FakeVideoFrame(10, 4), new FakeVideoFrame(14, 7)];
    let pulls = 0;
    const factory = factoryFor(() => streamOf(frames, () => pulls++));
    const decoded = decodeLiveMediaStream(liveSource([track]), { processorFactory: factory });
    expect(factory.calls).toHaveLength(0);
    const reader = decoded.video?.getReader();
    if (reader === undefined) throw new Error('expected live video stream');

    expect((await reader.read()).value).toBe(frames[0]);
    expect(factory.calls).toEqual([{ track, kind: 'video', maxBufferSize: 1 }]);
    expect(pulls).toBe(1);
    expect((await reader.read()).value).toBe(frames[1]);
    expect(pulls).toBe(2);
    await reader.cancel();
    expect(frames.map((frame) => frame.closeCount)).toEqual([0, 0]);
    frames[0]?.close();
    frames[1]?.close();
    expect(frames.map((frame) => frame.closeCount)).toEqual([1, 1]);
    expect(track.stopCount).toBe(0);
  });

  it('preserves a shared audio/video clock regardless of pull order', async () => {
    const videoTrack = new FakeTrack('video');
    const audioTrack = new FakeTrack('audio');
    const video = new FakeVideoFrame(1_250_000, 33_333);
    const audio = new FakeAudioData(1_200_000, 20_000);
    const factory = factoryFor((_track, kind) => streamOf([kind === 'video' ? video : audio]));
    const decoded = decodeLiveMediaStream(liveSource([videoTrack, audioTrack]), {
      processorFactory: factory,
    });
    const audioReader = decoded.audio?.getReader();
    const videoReader = decoded.video?.getReader();
    if (audioReader === undefined || videoReader === undefined) {
      throw new Error('expected dual live streams');
    }

    expect((await audioReader.read()).value).toBe(audio);
    expect((await videoReader.read()).value).toBe(video);
    expect(audio.timestamp).toBe(1_200_000);
    expect(audio.duration).toBe(20_000);
    expect(video.timestamp).toBe(1_250_000);
    expect(video.duration).toBe(33_333);
    await audioReader.cancel();
    await videoReader.cancel();
    audio.close();
    video.close();
  });

  it('closes normally when a track ends during a pending read without stopping the track', async () => {
    const track = new FakeTrack('video');
    let markPullStarted: (() => void) | undefined;
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve;
    });
    let cancels = 0;
    const factory = factoryFor(
      () =>
        new ReadableStream<unknown>({
          pull(): void {
            markPullStarted?.();
          },
          cancel(): void {
            cancels++;
          },
        }),
    );
    const reader = decodeLiveMediaStream(liveSource([track]), {
      processorFactory: factory,
    }).video?.getReader();
    if (reader === undefined) throw new Error('expected live video stream');
    const pending = reader.read();
    await pullStarted;
    track.end();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(cancels).toBe(1);
    expect(track.stopCount).toBe(0);
  });

  it('closes a late processor frame exactly once when abort wins a pending read', async () => {
    const track = new FakeTrack('video');
    const removeEndedListener = vi.spyOn(track, 'removeEventListener');
    const late = new FakeVideoFrame(99);
    const harness = lateFrameOnCancel(late);
    const factory = factoryFor(() => harness.readable);
    const ctrl = new AbortController();
    const reader = decodeLiveMediaStream(liveSource([track]), {
      signal: ctrl.signal,
      processorFactory: factory,
    }).video?.getReader();
    if (reader === undefined) throw new Error('expected live video stream');
    const pending = reader.read();
    await harness.readStarted;
    ctrl.abort('stop');

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(late.closeCount).toBe(1);
    expect(harness.cancelCount()).toBe(1);
    expect(harness.releaseCount()).toBe(1);
    expect(track.stopCount).toBe(0);
    expect(removeEndedListener).toHaveBeenCalledTimes(1);
  });

  it('closes a late processor frame exactly once when the output is cancelled', async () => {
    const track = new FakeTrack('video');
    const late = new FakeVideoFrame(101);
    const harness = lateFrameOnCancel(late);
    const factory = factoryFor(() => harness.readable);
    const reader = decodeLiveMediaStream(liveSource([track]), {
      processorFactory: factory,
    }).video?.getReader();
    if (reader === undefined) throw new Error('expected live video stream');
    const pending = reader.read();
    await harness.readStarted;
    await reader.cancel('consumer done');
    await pending;

    expect(late.closeCount).toBe(1);
    expect(harness.cancelCount()).toBe(1);
    expect(harness.releaseCount()).toBe(1);
  });

  it('closes wrong-kind and regressing frames before surfacing typed errors', async () => {
    const wrong = new FakeAudioData(1);
    const wrongReader = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      processorFactory: factoryFor(() => streamOf([wrong])),
    }).video?.getReader();
    if (wrongReader === undefined) throw new Error('expected live video stream');
    await expect(wrongReader.read()).rejects.toBeInstanceOf(CapabilityError);
    expect(wrong.closeCount).toBe(1);

    const first = new FakeVideoFrame(10);
    const regressing = new FakeVideoFrame(9);
    const timeReader = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      processorFactory: factoryFor(() => streamOf([first, regressing])),
    }).video?.getReader();
    if (timeReader === undefined) throw new Error('expected live video stream');
    expect((await timeReader.read()).value).toBe(first);
    await expect(timeReader.read()).rejects.toMatchObject({ code: 'decode-error' });
    expect(first.closeCount).toBe(0);
    expect(regressing.closeCount).toBe(1);
    first.close();
  });

  it('maps a processor construction failure and missing host constructor to typed capability errors', async () => {
    const throwing = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      processorFactory: factoryFor(() => {
        throw new TypeError('unsupported track');
      }),
    }).video?.getReader();
    if (throwing === undefined) throw new Error('expected live video stream');
    await expect(throwing.read()).rejects.toBeInstanceOf(CapabilityError);

    vi.stubGlobal('MediaStreamTrackProcessor', undefined);
    const missing = decodeLiveMediaStream(liveSource([new FakeTrack('video')])).video?.getReader();
    if (missing === undefined) throw new Error('expected live video stream');
    await expect(missing.read()).rejects.toBeInstanceOf(CapabilityError);
  });

  it('preserves primary typed errors when reader cancellation itself fails', async () => {
    const primary = new MediaError('decode-error', 'processor exploded');
    let releases = 0;
    const readable = {
      getReader() {
        return {
          read: () => Promise.reject(primary),
          cancel: () => Promise.reject(new TypeError('cancel failed')),
          releaseLock: () => {
            releases++;
          },
        };
      },
    } as unknown as ReadableStream<unknown>;
    const reader = decodeLiveMediaStream(liveSource([new FakeTrack('video')]), {
      processorFactory: factoryFor(() => readable),
    }).video?.getReader();
    if (reader === undefined) throw new Error('expected live video stream');

    await expect(reader.read()).rejects.toBe(primary);
    expect(releases).toBe(1);
  });
});
