/**
 * The AIFF / AIFF-C container driver — hand-written TS. AIFF is **big-endian** IFF (`FORM…AIFF`/`AIFC`)
 * carrying raw PCM (or, in AIFF-C, big-endian float or byte-swapped `sowt` little-endian PCM), so demux
 * is a chunk walk: `COMM` for the layout, `SSND` for the samples. PCM is not a WebCodecs codec — it flows
 * to the TS audio-dsp path — so the packet seam raises a typed {@link CapabilityError} and the codec
 * token is `pcm-s16be` / `pcm-s24be` / `pcm-f32` etc. (docs/architecture/09 audio-dsp).
 */

import {
  type ByteSource,
  type ContainerDriver,
  type ContainerQuery,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type EncodedChunk,
  type Muxer,
  type PcmTransform,
  type Registry,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { type PcmAudio, gain, remix, resample } from '../../dsp/index.ts';
import { parseAiff, readAiffPcm, writeAiff } from './aiff.ts';

const AIFF_MIMES = new Set(['audio/aiff', 'audio/x-aiff', 'audio/aifc', 'audio/x-aifc']);
const AIFF_EXTENSIONS = new Set(['aiff', 'aif', 'aifc']);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/** True iff the head is a `FORM…AIFF`/`AIFC` group. */
function isAiffHead(head: Uint8Array): boolean {
  return (
    head.byteLength >= 12 &&
    ascii(head, 0, 4) === 'FORM' &&
    (ascii(head, 8, 4) === 'AIFF' || ascii(head, 8, 4) === 'AIFC')
  );
}

async function readHead(src: ByteSource, n: number): Promise<Uint8Array> {
  if (src.range) return src.range(0, Math.min(n, src.size ?? n));
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

/** Read the whole source — PCM transforms need every sample (bounded by file size). */
async function readAll(src: ByteSource): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of parts) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && AIFF_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && AIFF_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  return q.head !== undefined && isAiffHead(q.head);
}

export const AiffDriver: ContainerDriver = {
  id: 'aiff',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['aiff'],
  supports: matches,
  async demux(src: ByteSource): Promise<Demuxer> {
    const info = parseAiff(await readHead(src, 65536));
    const track: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: info.codec,
      durationSec: info.durationSec,
      config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
    };
    return {
      tracks: [track],
      packets(): ReadableStream<EncodedChunk> {
        throw new CapabilityError(
          'capability-miss',
          'AIFF PCM flows through the TS audio-dsp path (browser seam), not WebCodecs',
          { op: 'demux', tried: ['aiff'] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const aiff = readAiffPcm(await readAll(src));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    let audio: PcmAudio = aiff;
    if (o?.gainDb !== undefined && o.gainDb !== 0) audio = gain(audio, o.gainDb);
    if (o?.channels !== undefined && o.channels !== audio.channels)
      audio = remix(audio, o.channels);
    // Rate change last, on the final channel layout (band-limited windowed-sinc; pure-TS, ADR-022).
    if (o?.sampleRate !== undefined && o.sampleRate !== audio.sampleRate)
      audio = resample(audio, o.sampleRate);
    const out = writeAiff(audio, aiff.format, { kind: aiff.kind, endian: aiff.endian });
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  createMuxer(): Muxer {
    // AIFF carries raw PCM, not WebCodecs EncodedChunks, so the seam Muxer doesn't map; PCM output is
    // produced by `transformPcm` (writeAiff) — the audio-dsp path (ADR-022), exactly like WAV.
    throw new MediaError(
      'mux-error',
      'aiff output flows through transformPcm (PCM), not the chunk seam',
    );
  },
};

export const AiffModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(AiffDriver);
  },
};

export default AiffModule;
