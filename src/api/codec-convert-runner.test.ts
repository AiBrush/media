import { describe, expect, it, vi } from 'vitest';
import type { ContainerDriver, Demuxer, Muxer, Packet, TrackInfo } from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { Mp4Muxer } from '../drivers/mp4/mux.ts';
import { fromBytes } from '../sources/source.ts';
import { type CodecConvertRunnerContext, runCodecConvert } from './codec-convert-runner.ts';

const source = fromBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));

function unused(name: string): never {
  throw new Error(`${name} must not run in this setup-failure test`);
}

function containerDriver(
  demuxer: Demuxer,
  createMuxer: ContainerDriver['createMuxer'],
): ContainerDriver {
  return {
    id: 'setup-failure-container',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['webm'],
    supports: () => true,
    demux: () => Promise.resolve(demuxer),
    createMuxer,
  };
}

function runnerContext(
  inputContainer: ContainerDriver,
  routeMuxer: CodecConvertRunnerContext['routeMuxer'],
  materializeOutput: CodecConvertRunnerContext['materializeOutput'],
): CodecConvertRunnerContext {
  return {
    routeContainer: () => Promise.resolve(inputContainer),
    stageOptions: (signal) => ({ signal }),
    offloadStream: () => Promise.resolve(undefined),
    videoRunnerContext: () => unused('videoRunnerContext'),
    routeMuxer,
    muxOptions: () => ({ container: 'webm' }),
    materializeOutput,
    mimeOptions: (signal) => ({ signal, mime: 'video/webm' }),
    sourceGeometry: () => unused('sourceGeometry'),
    transcodeVpxAlphaGeometry: () => Promise.reject(unused('transcodeVpxAlphaGeometry')),
    transcodeVpxAlpha: () => Promise.reject(unused('transcodeVpxAlpha')),
    routeCodec: () => Promise.reject(unused('routeCodec')),
    closeIfClosable: () => {},
    applyVideoFilters: () => Promise.reject(unused('applyVideoFilters')),
    encodeVideoStream: () => Promise.reject(unused('encodeVideoStream')),
    isRawPcmTrack: () => false,
    decodeAudioTrackPackets: () => Promise.reject(unused('decodeAudioTrackPackets')),
    applyAudioFilters: () => Promise.reject(unused('applyAudioFilters')),
    encodeAudioStream: () => Promise.reject(unused('encodeAudioStream')),
  };
}

function emptyDemuxer(close: Demuxer['close']): Demuxer {
  return {
    tracks: [],
    packets: () => unused('packets'),
    close,
  };
}

describe('runCodecConvert setup ownership', () => {
  it('closes the acquired demuxer exactly once when output routing rejects', async () => {
    const failure = new Error('output route failed');
    const close = vi.fn(() => Promise.resolve());
    const demuxer = emptyDemuxer(close);
    const inputContainer = containerDriver(demuxer, () => unused('input createMuxer'));
    const routeMuxer = vi.fn(() => Promise.reject(failure));
    const materializeOutput = vi.fn(() => Promise.reject(unused('materializeOutput')));

    await expect(
      runCodecConvert(
        source,
        { to: 'webm', video: false, audio: false },
        new AbortController().signal,
        {},
        source,
        runnerContext(inputContainer, routeMuxer, materializeOutput),
      ),
    ).rejects.toBe(failure);

    expect(close).toHaveBeenCalledTimes(1);
    expect(materializeOutput).not.toHaveBeenCalled();
  });

  it('closes the acquired demuxer exactly once when createMuxer throws', async () => {
    const failure = new Error('createMuxer failed');
    const close = vi.fn(() => Promise.resolve());
    const demuxer = emptyDemuxer(close);
    const inputContainer = containerDriver(demuxer, () => unused('input createMuxer'));
    const createMuxer = vi.fn(() => {
      throw failure;
    });
    const outputContainer = containerDriver(demuxer, createMuxer);
    const materializeOutput = vi.fn(() => Promise.reject(unused('materializeOutput')));

    await expect(
      runCodecConvert(
        source,
        { to: 'webm', video: false, audio: false },
        new AbortController().signal,
        {},
        source,
        runnerContext(inputContainer, () => Promise.resolve(outputContainer), materializeOutput),
      ),
    ).rejects.toBe(failure);

    expect(createMuxer).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(materializeOutput).not.toHaveBeenCalled();
  });

  it('closes the acquired demuxer and publishes no output when initial addTrack setup throws', async () => {
    const failure = new Error('addTrack failed');
    const close = vi.fn(() => Promise.resolve());
    const cancelPackets = vi.fn();
    const packets = new ReadableStream<Packet>({ cancel: cancelPackets }, { highWaterMark: 0 });
    const audioTrack: TrackInfo = {
      id: 7,
      mediaType: 'audio',
      codec: 'opus',
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const demuxer: Demuxer = {
      tracks: [audioTrack],
      packets: () => packets,
      close,
    };
    const inputContainer = containerDriver(demuxer, () => unused('input createMuxer'));
    const finalize = vi.fn(() => Promise.resolve());
    const muxer: Muxer = {
      output: new ReadableStream<Uint8Array>(undefined, { highWaterMark: 0 }),
      addTrack: () => {
        throw failure;
      },
      write: () => Promise.resolve(),
      finalize,
    };
    const outputContainer = containerDriver(demuxer, () => muxer);
    const materializeOutput = vi.fn(() => Promise.reject(unused('materializeOutput')));

    await expect(
      runCodecConvert(
        source,
        { to: 'webm', video: false },
        new AbortController().signal,
        {},
        source,
        runnerContext(inputContainer, () => Promise.resolve(outputContainer), materializeOutput),
      ),
    ).rejects.toBe(failure);

    expect(cancelPackets).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(materializeOutput).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects an impossible MP4 projection before mux construction or any packet pull', async () => {
    const close = vi.fn(() => Promise.resolve());
    const packets = vi.fn(() => {
      throw new Error('packets must not be opened before projected-output preflight');
    });
    const videoTrack: TrackInfo = {
      id: 3,
      mediaType: 'video',
      codec: 'vp09.00.31.08',
      bitrate: 545_405,
      durationSec: 1697.261,
      fps: 25,
      config: { codec: 'vp09.00.31.08', codedWidth: 640, codedHeight: 480 },
    };
    const audioTrack: TrackInfo = {
      id: 4,
      mediaType: 'audio',
      codec: 'opus',
      bitrate: 126_632,
      durationSec: 1697.261,
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const demuxer: Demuxer = { tracks: [videoTrack, audioTrack], packets, close };
    const createMuxer = vi.fn(() => unused('createMuxer'));
    const inputContainer = containerDriver(demuxer, () => unused('input createMuxer'));
    const outputContainer: ContainerDriver = {
      ...containerDriver(demuxer, createMuxer),
      id: 'mp4-mux',
      formats: ['mp4', 'mov'],
    };
    const routeCodec = vi.fn(() => Promise.reject(unused('routeCodec')));
    const materializeOutput = vi.fn(() => Promise.reject(unused('materializeOutput')));
    const context: CodecConvertRunnerContext = {
      ...runnerContext(inputContainer, () => Promise.resolve(outputContainer), materializeOutput),
      sourceGeometry: () => ({
        width: 640,
        height: 480,
        fps: 25,
        durationSec: 1697.261,
        bitrate: 545_405,
      }),
      routeCodec,
    };

    let failure: unknown;
    try {
      await runCodecConvert(
        source,
        {
          to: 'mp4',
          video: { codec: 'h264', width: 1280, height: 720 },
          audio: { codec: 'aac', bitrate: 128_000 },
        },
        new AbortController().signal,
        {},
        source,
        context,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CapabilityError);
    expect(failure).toMatchObject({
      code: 'capability-miss',
      detail: {
        op: {
          kind: 'route',
          id: 'buffered-mp4-convert-projection',
          facts: { durationSec: 1697.261, plannedBitrateBps: 18_560_000 },
        },
      },
    });
    expect(createMuxer).not.toHaveBeenCalled();
    expect(packets).not.toHaveBeenCalled();
    expect(routeCodec).not.toHaveBeenCalled();
    expect(materializeOutput).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not apply the single-array projection to fragmented MP4 output', async () => {
    const constructionFailure = new Error('fragmented mux construction reached');
    const close = vi.fn(() => Promise.resolve());
    const videoTrack: TrackInfo = {
      id: 3,
      mediaType: 'video',
      codec: 'vp09.00.31.08',
      bitrate: 545_405,
      durationSec: 1697.261,
      fps: 25,
      config: { codec: 'vp09.00.31.08', codedWidth: 640, codedHeight: 480 },
    };
    const demuxer: Demuxer = {
      tracks: [videoTrack],
      packets: () => unused('packets'),
      close,
    };
    const createMuxer = vi.fn(() => {
      throw constructionFailure;
    });
    const inputContainer = containerDriver(demuxer, () => unused('input createMuxer'));
    const outputContainer: ContainerDriver = {
      ...containerDriver(demuxer, createMuxer),
      id: 'mp4-mux',
      formats: ['mp4', 'mov'],
    };
    const context: CodecConvertRunnerContext = {
      ...runnerContext(
        inputContainer,
        () => Promise.resolve(outputContainer),
        () => Promise.reject(unused('materializeOutput')),
      ),
      muxOptions: () => ({ container: 'mp4', fragmented: true }),
      sourceGeometry: () => ({
        width: 640,
        height: 480,
        fps: 25,
        durationSec: 1697.261,
        bitrate: 545_405,
      }),
    };

    await expect(
      runCodecConvert(
        source,
        {
          to: 'mp4',
          fragmented: true,
          video: { codec: 'h264', width: 1280, height: 720 },
          audio: false,
        },
        new AbortController().signal,
        {},
        source,
        context,
      ),
    ).rejects.toBe(constructionFailure);

    expect(createMuxer).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not project a requested video bitrate when the source has no video track', async () => {
    const constructionFailure = new Error('audio-only mux construction reached');
    const close = vi.fn(() => Promise.resolve());
    const audioTrack: TrackInfo = {
      id: 4,
      mediaType: 'audio',
      codec: 'opus',
      bitrate: 128_000,
      durationSec: 1697.261,
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const demuxer: Demuxer = {
      tracks: [audioTrack],
      packets: () => unused('packets'),
      close,
    };
    const createMuxer = vi.fn(() => {
      throw constructionFailure;
    });
    const inputContainer = containerDriver(demuxer, () => unused('input createMuxer'));
    const outputContainer: ContainerDriver = {
      ...containerDriver(demuxer, createMuxer),
      id: 'mp4-mux',
      formats: ['mp4', 'mov'],
    };

    await expect(
      runCodecConvert(
        source,
        {
          to: 'mp4',
          video: { codec: 'h264', bitrate: 18_432_000 },
        },
        new AbortController().signal,
        {},
        source,
        runnerContext(
          inputContainer,
          () => Promise.resolve(outputContainer),
          () => Promise.reject(unused('materializeOutput')),
        ),
      ),
    ).rejects.toBe(constructionFailure);

    expect(createMuxer).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('cancels the producer and publishes nothing when actual MP4 retention crosses its cap', async () => {
    const oneMiB = new Uint8Array(1024 * 1024);
    const crossingByte = new Uint8Array(1);
    const cancelPackets = vi.fn();
    let packetIndex = 0;
    const packets = new ReadableStream<Packet>(
      {
        pull(controller): void {
          if (packetIndex > 1024) {
            controller.close();
            return;
          }
          const data = packetIndex === 1024 ? crossingByte : oneMiB;
          const timestamp = packetIndex * 20_000;
          packetIndex++;
          controller.enqueue({
            chunk: {
              byteLength: data.byteLength,
              timestamp,
              duration: 20_000,
              type: 'key',
              copyTo: () => {},
            } as EncodedAudioChunk,
            data,
          });
        },
        cancel: cancelPackets,
      },
      { highWaterMark: 0 },
    );
    const close = vi.fn(() => Promise.resolve());
    const audioTrack: TrackInfo = {
      id: 7,
      mediaType: 'audio',
      codec: 'opus',
      bitrate: 128_000,
      durationSec: 1,
      config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const demuxer: Demuxer = { tracks: [audioTrack], packets: () => packets, close };
    const muxer = new Mp4Muxer();
    const finalize = vi.spyOn(muxer, 'finalize');
    const inputContainer = containerDriver(demuxer, () => unused('input createMuxer'));
    const outputContainer: ContainerDriver = {
      ...containerDriver(demuxer, () => muxer),
      id: 'mp4',
      formats: ['mp4', 'mov'],
    };
    const materializeOutput = vi.fn(() => Promise.reject(unused('materializeOutput')));

    let failure: unknown;
    try {
      await runCodecConvert(
        source,
        { to: 'mp4', video: false },
        new AbortController().signal,
        {},
        source,
        runnerContext(inputContainer, () => Promise.resolve(outputContainer), materializeOutput),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CapabilityError);
    expect(failure).toMatchObject({
      code: 'capability-miss',
      detail: { op: { kind: 'route', id: 'mp4-buffer-all-payload' } },
    });
    expect(packetIndex).toBe(1025);
    expect(cancelPackets).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(materializeOutput).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
