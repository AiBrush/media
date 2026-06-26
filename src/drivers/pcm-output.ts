import type { PcmContainer } from '../contracts/driver.ts';
import type { Endianness, PcmAudio, SampleFormat } from '../dsp/pcm.ts';
import { type AiffKind, writeAiff } from './aiff/aiff.ts';
import { writeCaf } from './caf/caf.ts';
import { writeWav } from './wav/pcm.ts';

export function writePcmContainer(
  audio: PcmAudio,
  container: PcmContainer,
  sampleFormat: SampleFormat,
  endian: Endianness,
  aiffKind?: AiffKind,
): Uint8Array<ArrayBuffer> {
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
