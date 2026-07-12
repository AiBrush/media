import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { drainEncoderToMuxer, unwrapPackets } from '../src/api/codec-pipeline.ts';
import type { EncodedChunk, Packet } from '../src/contracts/driver.ts';
import { enumerateAdtsFrames } from '../src/drivers/adts/adts-driver.ts';
import { OggDriver } from '../src/drivers/ogg/ogg-driver.ts';
import { WebmDriver } from '../src/drivers/webm/webm-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 7;
const SAMPLES = 51;
const FIXTURES = ['sfx-opus.ogg', 'sound_5.oga'] as const;
const MEDIA = new URL('../fixtures/media/', import.meta.url);
const ADTS_BATCH = 1_000;
const PROJECTION_PACKETS = 1_296;

let copiedHostChunkBytes = 0;

function copyBufferSource(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice();
}

class BenchmarkEncodedAudioChunk {
  readonly type: EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: EncodedAudioChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = copyBufferSource(init.data);
    this.byteLength = this.#data.byteLength;
    copiedHostChunkBytes += this.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const view = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    view.set(this.#data);
    copiedHostChunkBytes += this.byteLength;
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function direct(bytes: Uint8Array): Promise<Uint8Array> {
  const streamCopy = OggDriver.streamCopy;
  if (streamCopy === undefined) throw new Error('Ogg stream-copy is unavailable');
  return collect(await streamCopy(fromBytes(bytes, { mime: 'audio/ogg' }), { container: 'mkv' }));
}

async function priorHostChunkShape(bytes: Uint8Array): Promise<Uint8Array> {
  const demuxer = await OggDriver.demux(fromBytes(bytes, { mime: 'audio/ogg' }));
  const track = demuxer.tracks[0];
  if (track === undefined) throw new Error('Ogg source has no audio track');
  const muxer = WebmDriver.createMuxer({ container: 'mkv' });
  try {
    await drainEncoderToMuxer(demuxer.packets(track.id), muxer, track);
    await muxer.finalize();
    return collect(muxer.output);
  } finally {
    await demuxer.close();
  }
}

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('median needs samples');
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function adtsFrameChecksum(bytes: Uint8Array, repeatedWalk: boolean): number {
  const first = enumerateAdtsFrames(bytes);
  let checksum = 0;
  for (const frame of first) checksum += frame.offset + frame.size + frame.ptsUs + frame.durationUs;
  if (!repeatedWalk) return checksum;
  const second = enumerateAdtsFrames(bytes);
  for (const frame of second)
    checksum += frame.offset + frame.size + frame.ptsUs + frame.durationUs;
  return checksum;
}

function benchmarkAdtsLayout(bytes: Uint8Array): void {
  for (let index = 0; index < WARMUP; index++) {
    adtsFrameChecksum(bytes, false);
    adtsFrameChecksum(bytes, true);
  }
  const retained: number[] = [];
  const repeated: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < SAMPLES; sample++) {
    for (const repeatedWalk of sample % 2 === 0 ? [false, true] : [true, false]) {
      const start = Bun.nanoseconds();
      for (let batch = 0; batch < ADTS_BATCH; batch++) {
        checksum += adtsFrameChecksum(bytes, repeatedWalk);
      }
      const elapsed = (Bun.nanoseconds() - start) / 1_000_000 / ADTS_BATCH;
      (repeatedWalk ? repeated : retained).push(elapsed);
    }
  }
  const retainedMedian = median(retained);
  const repeatedMedian = median(repeated);
  console.log(
    JSON.stringify({
      fixture: 'sfx.adts',
      inputBytes: bytes.byteLength,
      retainedLayoutMedianMs: retainedMedian,
      repeatedWalkMedianMs: repeatedMedian,
      speedup: repeatedMedian / retainedMedian,
      checksum,
    }),
  );
}

function projectionPackets(): readonly Packet[] {
  return Array.from({ length: PROJECTION_PACKETS }, (_, index) => {
    const timestamp = index * 23_220;
    const chunk = {
      type: 'key',
      timestamp,
      duration: 23_220,
      byteLength: 1,
      copyTo(): void {},
    } as unknown as EncodedChunk;
    return { chunk, dtsUs: timestamp };
  });
}

function packetSource(packets: readonly Packet[]): ReadableStream<Packet> {
  let index = 0;
  return new ReadableStream<Packet>(
    {
      pull(controller): void {
        const packet = packets[index];
        if (packet === undefined) {
          controller.close();
          return;
        }
        index++;
        controller.enqueue(packet);
      },
    },
    { highWaterMark: 0 },
  );
}

function priorTransformProjection(packets: ReadableStream<Packet>): ReadableStream<EncodedChunk> {
  return packets.pipeThrough(
    new TransformStream<Packet, EncodedChunk>({
      transform(packet, controller): void {
        controller.enqueue(packet.chunk);
      },
    }),
  );
}

async function drainProjection(stream: ReadableStream<EncodedChunk>): Promise<number> {
  const reader = stream.getReader();
  let checksum = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return checksum;
      checksum += value.timestamp + value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

async function benchmarkPacketProjection(): Promise<void> {
  const packets = projectionPackets();
  const direct = (): Promise<number> => drainProjection(unwrapPackets(packetSource(packets)));
  const prior = (): Promise<number> =>
    drainProjection(priorTransformProjection(packetSource(packets)));
  for (let index = 0; index < WARMUP; index++) {
    await direct();
    await prior();
  }
  const directSamples: number[] = [];
  const priorSamples: number[] = [];
  let checksum: number | undefined;
  for (let index = 0; index < SAMPLES; index++) {
    const order = index % 2 === 0 ? ([direct, prior] as const) : ([prior, direct] as const);
    for (const run of order) {
      const start = Bun.nanoseconds();
      const value = await run();
      const elapsed = (Bun.nanoseconds() - start) / 1_000_000;
      checksum ??= value;
      if (value !== checksum) throw new Error('packet projection checksum mismatch');
      (run === direct ? directSamples : priorSamples).push(elapsed);
    }
  }
  const directMedian = median(directSamples);
  const priorMedian = median(priorSamples);
  console.log(
    JSON.stringify({
      packets: packets.length,
      directPullMedianMs: directMedian,
      priorTransformMedianMs: priorMedian,
      speedup: priorMedian / directMedian,
      checksum,
    }),
  );
}

async function time(run: () => Promise<Uint8Array>): Promise<{ ms: number; output: Uint8Array }> {
  const start = Bun.nanoseconds();
  const output = await run();
  return { ms: (Bun.nanoseconds() - start) / 1_000_000, output };
}

const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EncodedAudioChunk');
Object.defineProperty(globalThis, 'EncodedAudioChunk', {
  configurable: true,
  writable: true,
  value: BenchmarkEncodedAudioChunk as unknown as typeof EncodedAudioChunk,
});

try {
  let sink = 0;
  for (const fixture of FIXTURES) {
    const bytes = new Uint8Array(await readFile(new URL(fixture, MEDIA)));
    for (let index = 0; index < WARMUP; index++) {
      sink += (await direct(bytes)).byteLength;
      sink += (await priorHostChunkShape(bytes)).byteLength;
    }
    const directSamples: number[] = [];
    const priorSamples: number[] = [];
    let expectedDigest: string | undefined;
    for (let index = 0; index < SAMPLES; index++) {
      const order =
        index % 2 === 0
          ? ([direct, priorHostChunkShape] as const)
          : ([priorHostChunkShape, direct] as const);
      for (const run of order) {
        const result = await time(() => run(bytes));
        const outputDigest = digest(result.output);
        expectedDigest ??= outputDigest;
        if (outputDigest !== expectedDigest) {
          throw new Error(`${fixture}: direct and prior-shape output differ`);
        }
        sink += result.output.byteLength + (result.output[0] ?? 0);
        (run === direct ? directSamples : priorSamples).push(result.ms);
      }
    }
    const directMedian = median(directSamples);
    const priorMedian = median(priorSamples);
    console.log(
      JSON.stringify({
        fixture,
        inputBytes: bytes.byteLength,
        directMedianMs: directMedian,
        priorHostChunkShapeMedianMs: priorMedian,
        speedup: priorMedian / directMedian,
        outputSha256: expectedDigest,
      }),
    );
  }
  benchmarkAdtsLayout(new Uint8Array(await readFile(new URL('sfx.adts', MEDIA))));
  await benchmarkPacketProjection();
  console.log(JSON.stringify({ copiedHostChunkBytes, sink }));
} finally {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
  else Object.defineProperty(globalThis, 'EncodedAudioChunk', descriptor);
}
