/**
 * Shared `AudioData` framing for the raw-frame seam. The pure layout helpers live here so the engine,
 * codec drivers, and audio-dsp filter can build/read `f32-planar` frames without importing a concrete
 * filter driver into the eager API layer.
 */

import type { StageOptions } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { type PcmAudio, channelAt } from './pcm.ts';

/** The `f32-planar` layout: one full channel plane at a time. */
const F32_PLANAR = 'f32-planar' as const;
const PCM_AUDIO_DATA_CHUNK_FRAMES = 4096;

/**
 * Read every channel of an `AudioData` into canonical planar Float64 PCM. This does not close `data`;
 * the caller owns frame lifetime and must close it exactly once when it is the last consumer.
 */
export function audioDataToPcm(data: AudioData): PcmAudio {
  const channels = data.numberOfChannels;
  const frames = data.numberOfFrames;
  const sampleRate = data.sampleRate;
  const planar: Float64Array[] = [];
  for (let c = 0; c < channels; c++) {
    const plane = new Float32Array(frames);
    if (frames > 0) data.copyTo(plane, { planeIndex: c, format: F32_PLANAR });
    const ch = new Float64Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = plane[i] as number;
    planar.push(ch);
  }
  return { sampleRate, channels, frames, planar };
}

/**
 * Lay a frame range from canonical planar PCM into channel-major `f32-planar` data and a matching
 * `AudioDataInit`. The returned `Float32Array` owns its `ArrayBuffer`.
 */
export function pcmRangeToPlanarInit(
  audio: PcmAudio,
  startFrame: number,
  frameCount: number,
  timestamp: number,
): { init: AudioDataInit; data: Float32Array<ArrayBuffer> } {
  const start = clampFrame(startFrame, audio.frames);
  const frames = Math.max(0, Math.min(Math.trunc(frameCount), audio.frames - start));
  const { channels, sampleRate } = audio;
  const data = new Float32Array(new ArrayBuffer(channels * frames * 4));
  for (let c = 0; c < channels; c++) {
    const ch = channelAt(audio.planar, c);
    const base = c * frames;
    for (let i = 0; i < frames; i++) data[base + i] = ch[start + i] as number;
  }
  const init: AudioDataInit = {
    format: F32_PLANAR,
    sampleRate,
    numberOfChannels: channels,
    numberOfFrames: frames,
    timestamp,
    data: data.buffer,
  };
  return { init, data };
}

/** Lay a canonical planar frame range into interleaved `f32` AudioData storage. */
export function pcmRangeToInterleavedInit(
  audio: PcmAudio,
  startFrame: number,
  frameCount: number,
  timestamp: number,
): { init: AudioDataInit; data: Float32Array<ArrayBuffer> } {
  const start = clampFrame(startFrame, audio.frames);
  const frames = Math.max(0, Math.min(Math.trunc(frameCount), audio.frames - start));
  const { channels, sampleRate } = audio;
  const data = new Float32Array(new ArrayBuffer(channels * frames * 4));
  for (let channel = 0; channel < channels; channel++) {
    const samples = channelAt(audio.planar, channel);
    for (let frame = 0; frame < frames; frame++) {
      data[frame * channels + channel] = samples[start + frame] as number;
    }
  }
  return {
    init: {
      format: 'f32',
      sampleRate,
      numberOfChannels: channels,
      numberOfFrames: frames,
      timestamp,
      data: data.buffer,
    },
    data,
  };
}

/**
 * Lay a complete canonical PCM buffer into channel-major `f32-planar` data and `AudioDataInit`.
 */
export function pcmToPlanarInit(
  audio: PcmAudio,
  timestamp: number,
): { init: AudioDataInit; data: Float32Array<ArrayBuffer> } {
  return pcmRangeToPlanarInit(audio, 0, audio.frames, timestamp);
}

/** Lay a complete canonical planar PCM buffer into interleaved `f32` AudioData storage. */
export function pcmToInterleavedInit(
  audio: PcmAudio,
  timestamp: number,
): { init: AudioDataInit; data: Float32Array<ArrayBuffer> } {
  return pcmRangeToInterleavedInit(audio, 0, audio.frames, timestamp);
}

/**
 * Wrap canonical PCM from a raw-audio container in bounded `AudioData` frames. The readable consumer
 * owns every successfully-enqueued frame; a frame that loses an enqueue/cancel race is closed here.
 * Keeping this next to the planar framing primitive means raw PCM decode loads no extra codec module.
 */
export function pcmAudioToAudioDataStream(
  audio: PcmAudio,
  stage: StageOptions,
  label: string,
  format: 'f32' | 'f32-planar' = 'f32-planar',
): ReadableStream<AudioData> {
  if (typeof AudioData === 'undefined') {
    throw new CapabilityError('capability-miss', 'AudioData missing for PCM decode', {
      op: 'decode',
      tried: [label],
      suggestion: 'run in a browser or worker with AudioData',
    });
  }
  /* v8 ignore start -- requires the browser `AudioData` constructor; browser-harness validated. */
  let cursor = 0;
  return new ReadableStream<AudioData>(
    {
      pull(controller): void {
        try {
          if (stage.signal?.aborted) throw new MediaError('aborted', 'aborted');
          if (cursor >= audio.frames) {
            controller.close();
            return;
          }
          const frames = Math.min(PCM_AUDIO_DATA_CHUNK_FRAMES, audio.frames - cursor);
          const timestamp = Math.round((cursor / audio.sampleRate) * 1_000_000);
          const init =
            format === 'f32'
              ? pcmRangeToInterleavedInit(audio, cursor, frames, timestamp).init
              : pcmRangeToPlanarInit(audio, cursor, frames, timestamp).init;
          const frame = new AudioData(init);
          try {
            controller.enqueue(frame);
          } catch (error) {
            frame.close();
            throw error;
          }
          cursor += frames;
        } catch (error) {
          if (error instanceof MediaError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new MediaError(
            'decode-error',
            `PCM audio decode failed to construct AudioData: ${message}`,
            error,
          );
        }
      },
      cancel(): void {
        cursor = audio.frames;
      },
    },
    { highWaterMark: 0 },
  );
  /* v8 ignore stop */
}

/**
 * Wrap a bounded stream of canonical PCM chunks as browser `AudioData` frames. The upstream reader stays
 * locked for the stream lifetime, so at most one canonical chunk and one browser frame are in flight. The
 * downstream consumer owns every successfully-enqueued frame; cancellation propagates to the chunk stream.
 */
export function pcmAudioChunksToAudioDataStream(
  chunks: ReadableStream<PcmAudio>,
  stage: StageOptions,
  label: string,
  format: 'f32' | 'f32-planar' = 'f32-planar',
): ReadableStream<AudioData> {
  if (typeof AudioData === 'undefined') {
    throw new CapabilityError('capability-miss', 'AudioData missing for PCM decode', {
      op: 'decode',
      tried: [label],
      suggestion: 'run in a browser or worker with AudioData',
    });
  }
  /* v8 ignore start -- requires the browser `AudioData` constructor; browser-harness validated. */
  const reader = chunks.getReader();
  let cursor = 0;
  let upstreamCancelled = false;
  const cancelUpstream = async (reason?: unknown): Promise<void> => {
    if (upstreamCancelled) return;
    upstreamCancelled = true;
    await reader.cancel(reason);
  };
  return new ReadableStream<AudioData>(
    {
      async pull(controller): Promise<void> {
        try {
          if (stage.signal?.aborted) {
            await cancelUpstream(stage.signal.reason);
            throw new MediaError('aborted', 'aborted');
          }
          for (;;) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            const audio = next.value;
            if (audio.frames <= 0) continue;
            if (stage.signal?.aborted) {
              await cancelUpstream(stage.signal.reason);
              throw new MediaError('aborted', 'aborted');
            }
            const timestamp = Math.round((cursor / audio.sampleRate) * 1_000_000);
            const init =
              format === 'f32'
                ? pcmToInterleavedInit(audio, timestamp).init
                : pcmToPlanarInit(audio, timestamp).init;
            const frame = new AudioData(init);
            try {
              controller.enqueue(frame);
            } catch (error) {
              frame.close();
              throw error;
            }
            cursor += audio.frames;
            return;
          }
        } catch (error) {
          if (error instanceof MediaError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new MediaError(
            'decode-error',
            `PCM audio chunk decode failed to construct AudioData: ${message}`,
            error,
          );
        }
      },
      async cancel(reason): Promise<void> {
        await cancelUpstream(reason);
      },
    },
    { highWaterMark: 0 },
  );
  /* v8 ignore stop */
}

function clampFrame(frame: number, total: number): number {
  if (!Number.isFinite(frame)) return 0;
  const i = Math.trunc(frame);
  if (i <= 0) return 0;
  if (i >= total) return total;
  return i;
}
