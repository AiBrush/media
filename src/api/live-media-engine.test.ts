import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { type LiveMediaSource, isLiveMediaSource } from '../sources/live-source.ts';
import type { Source } from '../sources/source.ts';
import { createMedia } from './create-media.ts';

function assertPrecisePublicSourceTypes(
  media: ReturnType<typeof createMedia>,
  element: HTMLMediaElement,
  stream: MediaStream,
): void {
  expectTypeOf(media.from(new Uint8Array())).toEqualTypeOf<Source>();
  expectTypeOf(media.source(new Uint8Array())).toEqualTypeOf<Source>();
  expectTypeOf(media.from(element)).toEqualTypeOf<Source>();
  expectTypeOf(media.from(element, { mode: 'bytes' })).toEqualTypeOf<Source>();
  expectTypeOf(media.source(element)).toEqualTypeOf<Source>();
  expectTypeOf(media.from(stream)).toEqualTypeOf<LiveMediaSource>();
  expectTypeOf(media.from(element, { mode: 'capture' })).toEqualTypeOf<LiveMediaSource>();
  expectTypeOf(media.source(stream)).toEqualTypeOf<LiveMediaSource>();
}
void assertPrecisePublicSourceTypes;

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  stopCount = 0;

  constructor(
    readonly kind: 'video' | 'audio',
    private readonly settings: MediaTrackSettings = {},
  ) {
    super();
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

function mediaStream(tracks: readonly FakeTrack[]): MediaStream {
  return new FakeMediaStream(tracks) as unknown as MediaStream;
}

afterEach(() => vi.unstubAllGlobals());

describe('MediaEngine live MediaStream integration', () => {
  it('normalizes direct and explicitly captured streams with a distinct live brand', () => {
    const media = createMedia({ worker: false });
    const stream = mediaStream([]);
    const direct = media.from(stream);
    expect(isLiveMediaSource(direct)).toBe(true);
    if (!isLiveMediaSource(direct)) throw new Error('expected live source');
    expect(direct.mediaStream).toBe(stream);

    class FakeElement {
      captureStream(): MediaStream {
        return stream;
      }
    }
    vi.stubGlobal('HTMLMediaElement', FakeElement);
    const captured = media.from(new FakeElement() as unknown as HTMLMediaElement, {
      mode: 'capture',
    });
    expect(isLiveMediaSource(captured)).toBe(true);
  });

  it('probes current raw track settings without consuming or constructing processors', async () => {
    let processorConstructions = 0;
    vi.stubGlobal(
      'MediaStreamTrackProcessor',
      class {
        readonly readable = new ReadableStream();

        constructor() {
          processorConstructions++;
        }
      },
    );
    const media = createMedia({ worker: false });
    const info = await media.probe(
      mediaStream([
        new FakeTrack('video', { width: 1920, height: 1080, frameRate: 29.97 }),
        new FakeTrack('audio', { sampleRate: 48_000, channelCount: 2 }),
      ]),
    );

    expect(info).toEqual({
      container: 'media-stream',
      durationSec: Number.POSITIVE_INFINITY,
      tracks: [
        {
          id: 0,
          type: 'video',
          codec: 'raw-video',
          width: 1920,
          height: 1080,
          fps: 29.97,
        },
        { id: 1, type: 'audio', codec: 'raw-audio', sampleRate: 48_000, channels: 2 },
      ],
      tags: { live: 'true', duration: 'unbounded' },
    });
    expect(processorConstructions).toBe(0);
  });

  it('loads the real processor bridge only on the first decoded-frame pull', async () => {
    const emitted = new FakeVideoFrame(700_000, 40_000);
    let constructions = 0;
    vi.stubGlobal('VideoFrame', FakeVideoFrame as unknown as typeof VideoFrame);
    vi.stubGlobal(
      'MediaStreamTrackProcessor',
      class {
        readonly readable: ReadableStream<unknown>;

        constructor(init: { readonly maxBufferSize: number }) {
          constructions++;
          if (init.maxBufferSize !== 1) throw new Error('expected one-frame processor buffer');
          this.readable = new ReadableStream<unknown>(
            {
              start(controller): void {
                controller.enqueue(emitted);
                controller.close();
              },
            },
            { highWaterMark: 0 },
          );
        }
      },
    );
    const track = new FakeTrack('video', { width: 320, height: 240 });
    const decoded = createMedia({ worker: false }).decode(mediaStream([track]));
    expect(constructions).toBe(0);
    const reader = decoded.video?.getReader();
    if (reader === undefined) throw new Error('expected deferred live video stream');

    expect((await reader.read()).value).toBe(emitted);
    expect(constructions).toBe(1);
    expect(emitted.closeCount).toBe(0);
    emitted.close();
    expect(emitted.closeCount).toBe(1);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(track.stopCount).toBe(0);
  });

  it('typed-declines finite byte/replay operations before reading the live tracks', async () => {
    const media = createMedia({ worker: false });
    const stream = mediaStream([new FakeTrack('video', { width: 320, height: 240 })]);
    const failures = [
      media.demux(stream),
      media.remux(stream, { to: 'webm' }),
      media.trim(stream, { start: 0, end: 1 }),
      media.seek(stream, 0),
      media.decrypt(stream, { scheme: 'cenc', keys: { key: '00' } }),
      media.h264AbrLadder(stream, [{ width: 320, height: 240, bitrate: 100_000 }]),
    ];
    await Promise.all(
      failures.map((failure) => expect(failure).rejects.toBeInstanceOf(CapabilityError)),
    );
  });

  it('enters the live convert coordinator and rejects missing raw-source target facts', async () => {
    const media = createMedia({ worker: false });
    const stream = mediaStream([new FakeTrack('video', { width: 320, height: 240 })]);
    await expect(
      media.convert(stream, { to: 'webm', video: { width: 320, height: 240 } }),
    ).rejects.toBeInstanceOf(InputError);
  });
});
