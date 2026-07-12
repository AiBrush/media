#!/usr/bin/env bun
/** Complete public Ogg -> Matroska product benchmark and strict reparse oracle (ADR-255). */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import {
  OggDriver,
  oggPacketBytes,
  oggPacketInfoFromBytes,
} from '../src/drivers/ogg/ogg-driver.ts';
import { parseWebm, webmPacketPayloadInfoFromBytes } from '../src/drivers/webm/webm-driver.ts';
import { toStream } from '../src/sinks/sink.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 7;
const SAMPLES = 31;
const MEMORY_OPERATIONS = 256;
const FIXTURES = ['sfx-opus.ogg', 'sound_5.oga'] as const;
const MEDIA = new URL('../fixtures/media/', import.meta.url);
const media = createMedia({ worker: false });

interface Subject {
  readonly fixture: (typeof FIXTURES)[number];
  readonly bytes: Uint8Array;
}

interface TimedOutput {
  readonly elapsedMs: number;
  readonly bytes: Uint8Array;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('median needs at least one sample');
  return value;
}

function mad(values: readonly number[]): number {
  const middle = median(values);
  return median(values.map((value) => Math.abs(value - middle)));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bufferSourceBytes(source: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (source === undefined) return undefined;
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{
  readonly bytes: Uint8Array;
  readonly chunks: number;
}> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) {
    const only = chunks[0];
    if (only === undefined) throw new Error('single output chunk disappeared');
    return { bytes: only, chunks: 1 };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, chunks: chunks.length };
}

function strictReparseOracle(subject: Subject, output: Uint8Array): number {
  if (equalBytes(subject.bytes, output)) {
    throw new Error(`${subject.fixture}: remux returned its Ogg input`);
  }
  const source = oggPacketInfoFromBytes(subject.bytes);
  const target = webmPacketPayloadInfoFromBytes(output);
  const parsed = parseWebm(output);
  const sourceTrack = source.tracks[0];
  const targetTrack = target.tracks[0];
  if (sourceTrack === undefined || targetTrack === undefined) {
    throw new Error(`${subject.fixture}: missing source or target track`);
  }
  if (
    parsed.container !== 'mkv' ||
    source.tracks.length !== 1 ||
    target.tracks.length !== 1 ||
    targetTrack.mediaType !== 'audio' ||
    targetTrack.codec !== sourceTrack.codec ||
    sourceTrack.durationSec === undefined ||
    targetTrack.durationSec !== sourceTrack.durationSec
  ) {
    throw new Error(`${subject.fixture}: Matroska track truth changed`);
  }
  const sourceConfig = sourceTrack.config;
  const targetConfig = targetTrack.config;
  if (
    sourceConfig === undefined ||
    targetConfig === undefined ||
    !('sampleRate' in sourceConfig) ||
    !('sampleRate' in targetConfig) ||
    targetConfig.sampleRate !== sourceConfig.sampleRate ||
    targetConfig.numberOfChannels !== sourceConfig.numberOfChannels ||
    !equalBytes(
      bufferSourceBytes(targetConfig.description) ?? new Uint8Array(),
      bufferSourceBytes(sourceConfig.description) ?? new Uint8Array(),
    )
  ) {
    throw new Error(`${subject.fixture}: codec-private truth changed`);
  }

  let codecDelayUs = 0;
  if (sourceTrack.codec === 'opus') {
    const description = bufferSourceBytes(sourceConfig.description);
    if (description === undefined || description.byteLength < 12) {
      throw new Error(`${subject.fixture}: OpusHead is missing pre-skip`);
    }
    const preSkip = new DataView(
      description.buffer,
      description.byteOffset,
      description.byteLength,
    ).getUint16(10, true);
    const expectedDelayNs = Math.round((preSkip / 48_000) * 1_000_000_000);
    if (
      targetTrack.codecDelayNs !== expectedDelayNs ||
      targetTrack.seekPreRollNs !== 80_000_000 ||
      targetTrack.gapless?.leadingSamples !== preSkip ||
      targetTrack.gapless.totalSamples !== Math.round(sourceTrack.durationSec * 48_000) - preSkip
    ) {
      throw new Error(`${subject.fixture}: Opus gapless truth changed`);
    }
    codecDelayUs = expectedDelayNs / 1_000;
  } else if (targetTrack.gapless !== undefined) {
    throw new Error(`${subject.fixture}: non-Opus output invented gapless facts`);
  }

  if (target.packets.length !== source.packets.length) {
    throw new Error(`${subject.fixture}: packet count changed`);
  }
  let checksum = output.byteLength;
  for (let index = 0; index < source.packets.length; index++) {
    const before = source.packets[index];
    const after = target.packets[index];
    if (before === undefined || after === undefined) {
      throw new Error(`${subject.fixture}: missing packet ${index}`);
    }
    const payload = oggPacketBytes(subject.bytes, before);
    if (
      !equalBytes(after.data, payload) ||
      after.size !== before.size ||
      after.keyframe !== before.keyframe ||
      after.dtsUs !== after.ptsUs ||
      Math.abs(after.ptsUs - (before.ptsUs - codecDelayUs)) > 1_000 ||
      before.durationUs === undefined ||
      after.durationUs === undefined ||
      Math.abs(after.durationUs - before.durationUs) > 1_000
    ) {
      throw new Error(`${subject.fixture}: packet ${index} changed`);
    }
    checksum = Math.imul(checksum ^ after.size ^ Math.round(after.ptsUs), 16_777_619) >>> 0;
  }
  return checksum;
}

async function publicBlob(subject: Subject): Promise<Uint8Array> {
  const output = await media.remux(subject.bytes, { to: 'mkv' });
  if (!(output instanceof Blob)) throw new Error('public Ogg remux did not return a Blob');
  return new Uint8Array(await output.arrayBuffer());
}

async function publicStream(subject: Subject): Promise<Uint8Array> {
  const output = await media.remux(fromBytes(subject.bytes, { mime: 'audio/ogg' }), {
    to: 'mkv',
    sink: toStream(),
  });
  if (!(output instanceof ReadableStream)) {
    throw new Error('stream-sink Ogg remux did not return a stream');
  }
  const collected = await collect(output);
  if (collected.chunks !== 1) {
    throw new Error(`${subject.fixture}: buffered Matroska output split into ${collected.chunks}`);
  }
  return collected.bytes;
}

async function directDriver(subject: Subject): Promise<Uint8Array> {
  const streamCopy = OggDriver.streamCopy;
  if (streamCopy === undefined) throw new Error('Ogg stream-copy is unavailable');
  return (await collect(await streamCopy(fromBytes(subject.bytes), { container: 'mkv' }))).bytes;
}

async function timed(run: () => Promise<Uint8Array>): Promise<TimedOutput> {
  const started = Bun.nanoseconds();
  const bytes = await run();
  return { elapsedMs: (Bun.nanoseconds() - started) / 1_000_000, bytes };
}

const subjects: readonly Subject[] = await Promise.all(
  FIXTURES.map(async (fixture) => ({
    fixture,
    bytes: new Uint8Array(await readFile(new URL(fixture, MEDIA))),
  })),
);

const results = [];
let sink = 0;
for (const subject of subjects) {
  for (let index = 0; index < WARMUP; index++) {
    sink ^= strictReparseOracle(subject, await publicBlob(subject));
    sink ^= strictReparseOracle(subject, await publicStream(subject));
    sink ^= strictReparseOracle(subject, await directDriver(subject));
  }
  const publicBlobMs: number[] = [];
  const publicStreamMs: number[] = [];
  const directMs: number[] = [];
  let expectedSha: string | undefined;
  const variants: readonly ((subject: Subject) => Promise<Uint8Array>)[] = [
    publicBlob,
    publicStream,
    directDriver,
  ];
  for (let index = 0; index < SAMPLES; index++) {
    const order = index % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order) {
      const result = await timed(() => variant(subject));
      sink ^= strictReparseOracle(subject, result.bytes);
      const outputSha = sha256(result.bytes);
      expectedSha ??= outputSha;
      if (outputSha !== expectedSha) {
        throw new Error(`${subject.fixture}: public and direct outputs differ`);
      }
      (variant === publicBlob
        ? publicBlobMs
        : variant === publicStream
          ? publicStreamMs
          : directMs
      ).push(result.elapsedMs);
    }
  }
  results.push({
    fixture: subject.fixture,
    codec: oggPacketInfoFromBytes(subject.bytes).tracks[0]?.codec,
    inputBytes: subject.bytes.byteLength,
    inputSha256: sha256(subject.bytes),
    outputSha256: expectedSha,
    packets: oggPacketInfoFromBytes(subject.bytes).packets.length,
    publicBlobMedianMs: median(publicBlobMs),
    publicBlobMadMs: mad(publicBlobMs),
    publicStreamMedianMs: median(publicStreamMs),
    publicStreamMadMs: mad(publicStreamMs),
    directDriverMedianMs: median(directMs),
    directDriverMadMs: mad(directMs),
  });
}

Bun.gc(true);
const memoryBefore = process.memoryUsage();
let peak = memoryBefore;
for (let index = 0; index < MEMORY_OPERATIONS; index++) {
  const subject = subjects[index % subjects.length];
  if (subject === undefined) throw new Error('memory benchmark lost its subject');
  const output = await publicBlob(subject);
  sink ^= output.byteLength ^ (output[index % output.byteLength] ?? 0);
  const current = process.memoryUsage();
  peak = {
    ...current,
    rss: Math.max(peak.rss, current.rss),
    heapUsed: Math.max(peak.heapUsed, current.heapUsed),
    arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers),
  };
}
Bun.gc(true);
const memoryAfter = process.memoryUsage();
const memory = {
  operations: MEMORY_OPERATIONS,
  peakRssDeltaBytes: Math.max(0, peak.rss - memoryBefore.rss),
  peakHeapDeltaBytes: Math.max(0, peak.heapUsed - memoryBefore.heapUsed),
  peakArrayBufferDeltaBytes: Math.max(0, peak.arrayBuffers - memoryBefore.arrayBuffers),
  retainedRssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
  retainedHeapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
  retainedArrayBufferDeltaBytes: memoryAfter.arrayBuffers - memoryBefore.arrayBuffers,
};
if (memory.retainedArrayBufferDeltaBytes > 1_048_576) {
  throw new Error(`Ogg remux retained source-sized buffers: ${JSON.stringify(memory)}`);
}

console.info(
  JSON.stringify(
    {
      benchmark: 'session13-ogg-matroska-public',
      warmup: WARMUP,
      samples: SAMPLES,
      results,
      memory,
      sink,
    },
    null,
    2,
  ),
);
