import type { PcmContainer } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import type { Endianness, PcmAudio, SampleFormat } from '../dsp/pcm.ts';
import { type AiffKind, writeAiff } from './aiff/aiff.ts';
import { writeCaf } from './caf/caf.ts';
import { writeWav } from './wav/pcm.ts';

function supportsSampleFormat(container: PcmContainer, sampleFormat: SampleFormat): boolean {
  if (container === 'wav') return sampleFormat !== 's8';
  return sampleFormat !== 'u8';
}

function unsupportedSampleFormat(
  container: PcmContainer,
  sampleFormat: SampleFormat,
): CapabilityError {
  const message =
    container === 'wav'
      ? 'WAV 8-bit PCM is unsigned; use pcm-u8 instead of pcm-s8'
      : `${container.toUpperCase()} 8-bit PCM is signed; use pcm-s8 instead of pcm-u8`;
  return new CapabilityError('capability-miss', message, {
    op: { op: 'pcm-write', container, sampleFormat },
    tried: [container],
  });
}

export function resolvePcmSampleFormat(
  container: PcmContainer,
  sourceFormat: SampleFormat,
  requestedFormat?: SampleFormat,
): SampleFormat {
  if (requestedFormat !== undefined) {
    if (!supportsSampleFormat(container, requestedFormat)) {
      throw unsupportedSampleFormat(container, requestedFormat);
    }
    return requestedFormat;
  }
  if (supportsSampleFormat(container, sourceFormat)) return sourceFormat;
  if (container === 'wav' && sourceFormat === 's8') return 'u8';
  if ((container === 'aiff' || container === 'caf') && sourceFormat === 'u8') return 's8';
  throw unsupportedSampleFormat(container, sourceFormat);
}

export function writePcmContainer(
  audio: PcmAudio,
  container: PcmContainer,
  sampleFormat: SampleFormat,
  endian: Endianness,
  aiffKind?: AiffKind,
): Uint8Array<ArrayBuffer> {
  if (!supportsSampleFormat(container, sampleFormat)) {
    throw unsupportedSampleFormat(container, sampleFormat);
  }
  switch (container) {
    case 'wav':
      return writeWav(audio, sampleFormat);
    case 'aiff': {
      const opts: { kind?: AiffKind; endian?: Endianness } = { endian };
      if (aiffKind !== undefined) opts.kind = aiffKind;
      return writeAiff(audio, sampleFormat, opts);
    }
    case 'caf':
      return writeCaf(audio, sampleFormat, endian);
  }
}
