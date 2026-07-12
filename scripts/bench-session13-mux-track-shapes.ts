import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import type { EncodedChunk, Packet, TrackInfo } from '../src/contracts/driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const videoBytes = new Uint8Array(
  await readFile(new URL('../../media-test/fixtures/media/h264_1080p_30s.mp4', import.meta.url)),
);
const audioBytes = new Uint8Array(
  await readFile(new URL('../../media-test/fixtures/media/aac_adts.aac', import.meta.url)),
);

let hostConstructions = 0;
class HostChunk {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #bytes: Uint8Array;

  constructor(init: EncodedVideoChunkInit) {
    hostConstructions++;
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#bytes = Uint8Array.from(bufferSourceBytes(init.data));
    this.byteLength = this.#bytes.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    bufferSourceBytes(destination).set(this.#bytes);
  }
}

Object.defineProperty(globalThis, 'EncodedVideoChunk', {
  configurable: true,
  value: HostChunk,
});
Object.defineProperty(globalThis, 'EncodedAudioChunk', {
  configurable: true,
  value: HostChunk,
});

type Shape = 'identity' | 'shallow-clone' | 'structured-clone' | 'wrapped-stream';

function bufferSourceBytes(value: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

function shapedTrack(track: TrackInfo, shape: Shape): TrackInfo {
  if (shape === 'identity' || shape === 'wrapped-stream') return track;
  if (shape === 'shallow-clone') return { ...track };
  return structuredClone(track);
}

function shapedStream(
  packets: ReadableStream<EncodedChunk | Packet>,
  shape: Shape,
): ReadableStream<EncodedChunk | Packet> {
  if (shape !== 'wrapped-stream') return packets;
  return packets.pipeThrough(
    new TransformStream<EncodedChunk | Packet, EncodedChunk | Packet>({
      transform(packet, controller): void {
        controller.enqueue(packet);
      },
    }),
  );
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('empty sample set');
  return value;
}

async function run(shape: Shape): Promise<{
  readonly elapsedMs: number;
  readonly hostChunks: number;
  readonly bytes: number;
  readonly sha256: string;
}> {
  const media = createMedia({ worker: false });
  const video = await media.demux(fromBytes(videoBytes, { mime: 'video/mp4' }));
  const audio = await media.demux(fromBytes(audioBytes, { mime: 'audio/aac' }));
  const videoTrack = video.tracks.find((track) => track.mediaType === 'video');
  const audioTrack = audio.tracks[0];
  if (videoTrack === undefined || audioTrack === undefined)
    throw new Error('missing source tracks');
  const before = hostConstructions;
  const started = performance.now();
  const output = await media.mux(
    {
      video: {
        track: shapedTrack(videoTrack, shape),
        packets: shapedStream(video.packets(videoTrack.id), shape),
      },
      audio: {
        track: shapedTrack(audioTrack, shape),
        packets: shapedStream(audio.packets(audioTrack.id), shape),
      },
    },
    { container: 'mp4', faststart: true },
  );
  if (!(output instanceof Blob)) throw new Error('expected Blob output');
  const bytes = new Uint8Array(await output.arrayBuffer());
  return {
    elapsedMs: performance.now() - started,
    hostChunks: hostConstructions - before,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const rows = [];
for (const shape of ['identity', 'shallow-clone', 'structured-clone', 'wrapped-stream'] as const) {
  for (let index = 0; index < 2; index++) await run(shape);
  const results = [];
  for (let index = 0; index < 7; index++) results.push(await run(shape));
  const hashes = new Set(results.map((result) => result.sha256));
  if (hashes.size !== 1) throw new Error(`${shape}: output bytes changed between runs`);
  rows.push({
    shape,
    medianMs: median(results.map((result) => result.elapsedMs)),
    hostChunks: results[0]?.hostChunks,
    bytes: results[0]?.bytes,
    sha256: results[0]?.sha256,
  });
}

const referenceHash = rows[0]?.sha256;
if (referenceHash === undefined || rows.some((row) => row.sha256 !== referenceHash)) {
  throw new Error('shape changed output bytes');
}

console.log(JSON.stringify({ benchmark: 'session13-mux-track-shapes', rows }, undefined, 2));
