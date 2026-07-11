/**
 * Lazy raw-frame WAV authoring for public `encode()` (ADR-243). PCM is not an `EncodedAudioChunk`, so
 * this path copies each `AudioData` into the existing canonical PCM kernel and feeds the first-party
 * WAV muxer's explicit raw-chunk seam without fabricating coded chunks.
 */

import type { Muxer } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { audioDataToPcm } from '../dsp/audio-data.ts';
import { type Endianness, type SampleFormat, encodePcm } from '../dsp/pcm.ts';
import type { AudioTarget, CallOptions, EncodeOptions, MediaStreams } from './types.ts';

const MICROS_PER_SECOND = 1_000_000;
const TIMESTAMP_ROUNDING_TOLERANCE_US = 1;

interface PcmWavMuxer extends Muxer {
  writePcm(trackId: number, data: Uint8Array): Promise<void>;
}

interface PcmWireTarget {
  readonly codec: string;
  readonly format: SampleFormat;
  readonly endian: Endianness;
}

export interface WavFrameEncodeDeps {
  readonly createMuxer: () => Promise<Muxer>;
}

/** Consume a public raw-audio frame stream and finalize one genuine PCM WAV byte stream. */
export async function encodeWavFrames(
  deps: WavFrameEncodeDeps,
  frames: MediaStreams,
  opts: EncodeOptions,
  signal: AbortSignal,
  call: Pick<CallOptions, 'onProgress'> = {},
): Promise<ReadableStream<Uint8Array>> {
  const shapeError = validateInputShape(frames, opts);
  if (shapeError !== undefined) {
    await cancelFrameStreams(frames, shapeError);
    throw shapeError;
  }
  const audioStream = frames.audio;
  const audioTarget = opts.audio;
  if (audioStream === undefined || audioTarget === undefined) {
    const error = new InputError(
      'unsupported-input',
      'WAV encode needs an audio stream and target',
    );
    await cancelFrameStreams(frames, error);
    throw error;
  }
  const wire = pcmWireTarget(audioTarget.codec);
  if (wire instanceof MediaError) {
    await cancelFrameStreams(frames, wire);
    throw wire;
  }
  const optionError = validatePcmOptions(audioTarget);
  if (optionError !== undefined) {
    await cancelFrameStreams(frames, optionError);
    throw optionError;
  }

  let muxer: Muxer;
  try {
    muxer = await deps.createMuxer();
  } catch (error) {
    await cancelFrameStreams(frames, error);
    throw error;
  }
  if (!isPcmWavMuxer(muxer)) {
    const error = new CapabilityError(
      'capability-miss',
      'the selected WAV muxer has no raw PCM frame seam',
      { op: 'encode', tried: ['wav'] },
    );
    await cancelFrameStreams(frames, error);
    throw error;
  }

  const reader = audioStream.getReader();
  let trackId: number | undefined;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let baseTimestampUs: number | undefined;
  let totalFrames = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await readAudioFrame(reader, signal);
      if (next.done) break;
      const frame = next.value;
      let frameFailure: MediaError | undefined;
      try {
        validateFrame(frame);
        if (frame.numberOfFrames > 0) {
          if (trackId === undefined) {
            sampleRate = audioTarget.sampleRate ?? frame.sampleRate;
            channels = audioTarget.channels ?? frame.numberOfChannels;
            validateOutputGeometry(sampleRate, channels);
            assertFrameGeometry(frame, sampleRate, channels);
            trackId = muxer.addTrack({
              id: 0,
              mediaType: 'audio',
              codec: wire.codec,
              config: { codec: wire.codec, sampleRate, numberOfChannels: channels },
            });
            baseTimestampUs = frame.timestamp;
          } else {
            assertFrameGeometry(frame, sampleRate, channels);
            assertContinuousTimestamp(frame.timestamp, baseTimestampUs, totalFrames, sampleRate);
          }

          const pcm = audioDataToPcm(frame);
          const bytes = encodePcm(pcm, wire.format, wire.endian);
          throwIfAborted(signal);
          await muxer.writePcm(trackId, bytes);
          totalFrames += frame.numberOfFrames;
          call.onProgress?.({ done: totalFrames, stage: 'encode' });
        }
      } catch (error) {
        frameFailure = toEncodeError(error);
      }
      try {
        frame.close();
      } catch (error) {
        frameFailure ??= toEncodeError(error);
      }
      if (frameFailure !== undefined) throw frameFailure;
    }
    if (trackId === undefined || totalFrames === 0) {
      throw new InputError('unsupported-input', 'WAV encode received no PCM sample frames');
    }
    throwIfAborted(signal);
    await muxer.finalize();
    call.onProgress?.({ done: totalFrames, total: totalFrames, stage: 'encode' });
    return muxer.output;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw toEncodeError(error);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An abort can win while read() is pending; readAudioFrame owns the eventual late frame close.
    }
  }
}

function validateInputShape(frames: MediaStreams, opts: EncodeOptions): MediaError | undefined {
  if (frames.video === undefined && frames.audio === undefined) {
    return new InputError('unsupported-input', 'encode needs streams');
  }
  if (frames.video !== undefined && opts.video === undefined) {
    return new InputError('unsupported-input', 'video target missing');
  }
  if (frames.audio !== undefined && opts.audio === undefined) {
    return new InputError('unsupported-input', 'audio target missing');
  }
  if (frames.video !== undefined) {
    return new CapabilityError('capability-miss', 'WAV encode accepts audio frames only', {
      op: 'encode',
      tried: ['wav'],
    });
  }
  return undefined;
}

function pcmWireTarget(codec: AudioTarget['codec']): PcmWireTarget | MediaError {
  switch (codec) {
    case undefined:
    case 'pcm':
    case 'pcm-f32':
      return { codec: 'pcm-f32', format: 'f32', endian: 'le' };
    case 'pcm-u8':
    case 'pcm-u8be':
      return { codec, format: 'u8', endian: 'le' };
    case 'pcm-s8':
    case 'pcm-s8be':
      return { codec: 'pcm-s8', format: 's8', endian: 'le' };
    case 'pcm-s16':
      return { codec, format: 's16', endian: 'le' };
    case 'pcm-s16be':
      return { codec, format: 's16', endian: 'be' };
    case 'pcm-s24':
      return { codec, format: 's24', endian: 'le' };
    case 'pcm-s24be':
      return { codec, format: 's24', endian: 'be' };
    case 'pcm-s32':
      return { codec, format: 's32', endian: 'le' };
    case 'pcm-s32be':
      return { codec, format: 's32', endian: 'be' };
    case 'pcm-f32be':
      return { codec, format: 'f32', endian: 'be' };
    case 'pcm-f64':
      return { codec, format: 'f64', endian: 'le' };
    case 'pcm-f64be':
      return { codec, format: 'f64', endian: 'be' };
    case 'aac':
    case 'opus':
    case 'mp3':
    case 'flac':
    case 'vorbis':
      return new CapabilityError(
        'capability-miss',
        `WAV frame encode accepts raw PCM, not '${codec}'`,
        { op: 'encode', tried: ['wav'] },
      );
    default:
      return new InputError('unsupported-input', `unsupported WAV PCM codec '${String(codec)}'`);
  }
}

function validatePcmOptions(target: NonNullable<EncodeOptions['audio']>): MediaError | undefined {
  if (target.bitrate !== undefined) {
    return new CapabilityError('capability-miss', 'PCM WAV has no bitrate control', {
      op: 'encode',
      tried: ['wav'],
    });
  }
  if (
    target.gainDb !== undefined ||
    target.fade !== undefined ||
    target.dynamics !== undefined ||
    target.biquad !== undefined
  ) {
    return new CapabilityError(
      'capability-miss',
      'WAV frame encode expects already-filtered AudioData frames',
      { op: 'encode', tried: ['wav'] },
    );
  }
  if (target.sampleRate !== undefined && !isValidSampleRate(target.sampleRate)) {
    return new InputError('unsupported-input', `invalid WAV sample rate ${target.sampleRate}`);
  }
  if (target.channels !== undefined && !isValidChannelCount(target.channels)) {
    return new InputError('unsupported-input', `invalid WAV channel count ${target.channels}`);
  }
  return undefined;
}

function validateFrame(frame: AudioData): void {
  if (!Number.isSafeInteger(frame.numberOfFrames) || frame.numberOfFrames < 0) {
    throw new InputError(
      'unsupported-input',
      'AudioData frame count must be a non-negative integer',
    );
  }
  if (!isValidSampleRate(frame.sampleRate)) {
    throw new InputError('unsupported-input', `invalid AudioData sample rate ${frame.sampleRate}`);
  }
  if (!isValidChannelCount(frame.numberOfChannels)) {
    throw new InputError(
      'unsupported-input',
      `invalid AudioData channel count ${frame.numberOfChannels}`,
    );
  }
  if (!Number.isFinite(frame.timestamp) || !Number.isSafeInteger(frame.timestamp)) {
    throw new InputError('unsupported-input', 'AudioData timestamp must be a finite integer');
  }
}

function validateOutputGeometry(sampleRate: number, channels: number): void {
  if (!isValidSampleRate(sampleRate)) {
    throw new InputError('unsupported-input', `invalid WAV sample rate ${sampleRate}`);
  }
  if (!isValidChannelCount(channels)) {
    throw new InputError('unsupported-input', `invalid WAV channel count ${channels}`);
  }
}

function assertFrameGeometry(
  frame: AudioData,
  sampleRate: number | undefined,
  channels: number | undefined,
): void {
  if (frame.sampleRate !== sampleRate || frame.numberOfChannels !== channels) {
    throw new InputError(
      'unsupported-input',
      `WAV encode frame layout ${frame.sampleRate} Hz/${frame.numberOfChannels} ch does not match ${String(sampleRate)} Hz/${String(channels)} ch`,
    );
  }
}

function assertContinuousTimestamp(
  timestampUs: number,
  baseTimestampUs: number | undefined,
  totalFrames: number,
  sampleRate: number | undefined,
): void {
  if (baseTimestampUs === undefined || sampleRate === undefined) {
    throw new MediaError('encode-error', 'WAV encode sample clock was not initialized');
  }
  const expected = baseTimestampUs + Math.round((totalFrames / sampleRate) * MICROS_PER_SECOND);
  if (Math.abs(timestampUs - expected) > TIMESTAMP_ROUNDING_TOLERANCE_US) {
    throw new InputError(
      'unsupported-input',
      `WAV encode requires contiguous AudioData timestamps (expected ${expected}, received ${timestampUs})`,
    );
  }
}

function isValidSampleRate(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function isValidChannelCount(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffff;
}

function isPcmWavMuxer(muxer: Muxer): muxer is PcmWavMuxer {
  return typeof muxer.writePcm === 'function';
}

async function cancelFrameStreams(frames: MediaStreams, reason: unknown): Promise<void> {
  const pending: Promise<void>[] = [];
  if (frames.video !== undefined) pending.push(frames.video.cancel(reason).catch(() => undefined));
  if (frames.audio !== undefined) pending.push(frames.audio.cancel(reason).catch(() => undefined));
  await Promise.all(pending);
}

async function readAudioFrame(
  reader: ReadableStreamDefaultReader<AudioData>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<AudioData>> {
  throwIfAborted(signal);
  const pending = reader.read();
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new MediaError('aborted', 'operation aborted'));
  });
  const onAbort = (): void => rejectAbort?.();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    if (signal.aborted) {
      void pending.then(
        (late) => {
          if (!late.done) late.value.close();
        },
        () => undefined,
      );
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaError('aborted', 'operation aborted');
}

function toEncodeError(error: unknown): MediaError {
  if (error instanceof MediaError) return error;
  return new MediaError(
    'encode-error',
    error instanceof Error ? error.message : String(error),
    error,
  );
}
