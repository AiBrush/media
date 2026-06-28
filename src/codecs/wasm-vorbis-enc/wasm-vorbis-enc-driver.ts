/**
 * WASM Vorbis encoder tail. Chromium/WebCodecs does not provide `AudioEncoder` for Vorbis, so this
 * driver lazily instantiates a self-hosted libvorbisenc/libogg wasm module only on Vorbis encode misses.
 */

import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  DecoderConfig,
  DriverModule,
  EncodedChunk,
  EncoderConfig,
  RawFrame,
  Registry,
  StageOptions,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import {
  VORBIS_CODEC,
  type VorbisEncWasmCore,
  type VorbisEncodedPacket,
  type VorbisEncoderInit,
  type VorbisWasmEncoder,
  buildVorbisExtradata,
  errMessage,
  interleaveF32,
  normalizeVorbisEncoderConfig,
  samplesToMicros,
} from './vorbis-enc.ts';

export interface VorbisEncoderStageOptions extends StageOptions {
  onConfig?(config: AudioDecoderConfig): void;
}

function vorbisConfigSink(
  o: StageOptions | undefined,
): ((config: AudioDecoderConfig) => void) | undefined {
  const sink = (o as VorbisEncoderStageOptions | undefined)?.onConfig;
  return typeof sink === 'function' ? sink : undefined;
}

function unsupported(reason: string): CodecSupport {
  return { supported: false, reason };
}

function isVorbisEncodeQuery(q: CodecQuery): boolean {
  return q.mediaType === 'audio' && q.direction === 'encode' && q.config.codec === VORBIS_CODEC;
}

function hasWebCodecsAudioSeam(): boolean {
  return typeof EncodedAudioChunk !== 'undefined' && typeof AudioData !== 'undefined';
}

let corePromise: Promise<VorbisEncWasmCore | null> | undefined;
let coreGluePromise: Promise<boolean> | undefined;

async function hasVorbisEncCoreGlue(): Promise<boolean> {
  coreGluePromise ??= import('./vorbis-enc-core.js').then(
    () => true,
    () => false,
  );
  return coreGluePromise;
}

export async function loadVorbisEncCore(): Promise<VorbisEncWasmCore | null> {
  corePromise ??= (async (): Promise<VorbisEncWasmCore | null> => {
    try {
      const mod = await import('./vorbis-enc-core.js');
      await mod.default();
      return mod.createVorbisEncCore();
    } catch {
      return null;
    }
  })();
  return corePromise;
}

export function resetVorbisEncCoreForTest(): void {
  corePromise = undefined;
  coreGluePromise = undefined;
}

function coreMissing(): CapabilityError {
  return new CapabilityError('capability-miss', 'wasm-vorbis-enc core is not available', {
    op: 'encode',
    tried: ['wasm-vorbis-enc'],
    suggestion: 'build + vendor the Vorbis encoder core per src/codecs/wasm-vorbis-enc/BUILD.md',
  });
}

async function supports(q: CodecQuery): Promise<CodecSupport> {
  if (q.mediaType !== 'audio') return unsupported('wasm-vorbis-enc handles audio only');
  if (q.config.codec !== VORBIS_CODEC) {
    return unsupported(`wasm-vorbis-enc handles Vorbis only, not '${q.config.codec}'`);
  }
  if (q.direction !== 'encode') return unsupported('wasm-vorbis-enc encodes only');
  if (!hasWebCodecsAudioSeam()) {
    return unsupported('wasm-vorbis-enc requires WebCodecs AudioData/EncodedAudioChunk');
  }
  if (!(await hasVorbisEncCoreGlue())) {
    return unsupported('wasm-vorbis-enc core glue is not vendored (see BUILD.md)');
  }
  return { supported: true, hardwareAccelerated: false };
}

/* v8 ignore start -- requires WebCodecs AudioData/EncodedAudioChunk; validated in browser. */

function asAudioData(frame: RawFrame): AudioData {
  if (frame instanceof AudioData) return frame;
  throw new MediaError(
    'encode-error',
    'wasm-vorbis-enc received a VideoFrame (router/seam mismatch)',
  );
}

function audioDataToInterleaved(data: AudioData, init: VorbisEncoderInit): Float32Array {
  if (data.sampleRate !== init.sampleRate) {
    throw new MediaError(
      'encode-error',
      `vorbis: input sample rate ${data.sampleRate} does not match encoder ${init.sampleRate}`,
    );
  }
  if (data.numberOfChannels !== init.channels) {
    throw new MediaError(
      'encode-error',
      `vorbis: input channels ${data.numberOfChannels} do not match encoder ${init.channels}`,
    );
  }
  const frames = data.numberOfFrames;
  const planes: Float32Array[] = [];
  for (let c = 0; c < init.channels; c++) {
    const plane = new Float32Array(frames);
    data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    planes.push(plane);
  }
  return interleaveF32(planes, frames);
}

function publishConfig(
  onConfig: ((config: AudioDecoderConfig) => void) | undefined,
  init: VorbisEncoderInit,
  headers: readonly [Uint8Array, Uint8Array, Uint8Array],
): void {
  onConfig?.({
    codec: VORBIS_CODEC,
    sampleRate: init.sampleRate,
    numberOfChannels: init.channels,
    description: buildVorbisExtradata(headers[0], headers[1], headers[2]),
  });
}

function packetDurationSamples(packet: VorbisEncodedPacket, lastGranule: number): number {
  if (Number.isFinite(packet.granulepos) && packet.granulepos >= lastGranule) {
    return packet.granulepos - lastGranule;
  }
  return 0;
}

/* v8 ignore stop */

function createDecoder(
  _config: DecoderConfig,
  _o?: StageOptions,
): TransformStream<EncodedChunk, RawFrame> {
  throw new CapabilityError('capability-miss', 'wasm-vorbis-enc is encode-only', {
    op: 'decode',
    tried: ['wasm-vorbis-enc'],
  });
}

function createEncoder(
  config: EncoderConfig,
  o?: StageOptions,
): TransformStream<RawFrame, EncodedChunk> {
  const signal = o?.signal;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted before encode');
  const init = normalizeVorbisEncoderConfig(config as AudioEncoderConfig);
  const onConfig = vorbisConfigSink(o);

  /* v8 ignore start -- requires WebCodecs AudioData/EncodedAudioChunk; validated in browser. */
  let encoder: VorbisWasmEncoder | undefined;
  let onAbort: (() => void) | undefined;
  let lastGranule = 0;

  const teardown = (): void => {
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    onAbort = undefined;
    encoder?.free();
    encoder = undefined;
  };

  const emitPackets = (
    packets: readonly VorbisEncodedPacket[],
    controller: TransformStreamDefaultController<EncodedChunk>,
  ): void => {
    for (const packet of packets) {
      const durationSamples = packetDurationSamples(packet, lastGranule);
      const timestamp = samplesToMicros(lastGranule, init.sampleRate);
      const duration = samplesToMicros(durationSamples, init.sampleRate);
      controller.enqueue(
        new EncodedAudioChunk({
          type: 'key',
          timestamp,
          duration,
          data: packet.data,
        }),
      );
      if (durationSamples > 0) lastGranule += durationSamples;
    }
  };

  return new TransformStream<RawFrame, EncodedChunk>({
    async start(controller): Promise<void> {
      const core = await loadVorbisEncCore();
      if (core === null) {
        controller.error(coreMissing());
        return;
      }
      try {
        encoder = await core.createEncoder(init);
        publishConfig(onConfig, init, encoder.headers());
      } catch (e) {
        controller.error(
          new MediaError('encode-error', `wasm-vorbis-enc init: ${errMessage(e)}`, e),
        );
        return;
      }
      onAbort = () => {
        teardown();
        controller.error(new MediaError('aborted', 'operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    },
    transform(frame, controller): void {
      const data = asAudioData(frame);
      try {
        const enc = encoder;
        if (!enc) throw new MediaError('encode-error', 'wasm-vorbis-enc encoder not configured');
        if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
        const interleaved = audioDataToInterleaved(data, init);
        emitPackets(enc.encode(interleaved, data.numberOfFrames), controller);
      } catch (e) {
        if (e instanceof MediaError) throw e;
        throw new MediaError('encode-error', `wasm-vorbis-enc encode: ${errMessage(e)}`, e);
      } finally {
        data.close();
      }
    },
    flush(controller): void {
      const enc = encoder;
      try {
        if (enc) emitPackets(enc.finish(), controller);
      } catch (e) {
        if (e instanceof MediaError) throw e;
        throw new MediaError('encode-error', `wasm-vorbis-enc finish: ${errMessage(e)}`, e);
      } finally {
        teardown();
      }
    },
  });
  /* v8 ignore stop */
}

export const WasmVorbisEncoderDriver: CodecDriver = {
  id: 'wasm-vorbis-enc',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'wasm',
  supports,
  createDecoder,
  createEncoder,
};

export const WasmVorbisEncoderModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(WasmVorbisEncoderDriver);
  },
};

export { isVorbisEncodeQuery };
export default WasmVorbisEncoderModule;
