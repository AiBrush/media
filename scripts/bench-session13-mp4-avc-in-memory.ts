#!/usr/bin/env bun
/** Full packet-info benchmark for exhaustive in-memory AVC first-VCL classification (ADR-259 pending). */

import { readFile } from 'node:fs/promises';
import type { ByteSource, PacketInfoTable } from '../src/contracts/driver.ts';
import {
  h264AccessUnitIsKeyPicture,
  h264AccessUnitRangeIsKeyPicture,
} from '../src/drivers/mp4/h264-access-unit.ts';
import { Mp4Driver, mp4PacketInfoTable, readMovie } from '../src/drivers/mp4/mp4-driver.ts';
import { buildSampleData } from '../src/drivers/mp4/samples.ts';

const FIXTURE =
  '../media-test/fixtures/media/scenarios/performance/size-ladder-iterate-packets-massive/massive_h264_1080p_2h.mp4';
const WARMUP = 1;
const SAMPLES = 11;
const CHECK = process.argv.includes('--check');
const loaded = await readFile(FIXTURE);
const bytes = new Uint8Array(loaded.buffer, loaded.byteOffset, loaded.byteLength);
const packetInfoCapability = Mp4Driver.packetInfo;
if (packetInfoCapability === undefined) throw new Error('MP4 packet info is unavailable');
const readPacketInfo: NonNullable<typeof Mp4Driver.packetInfo> = packetInfoCapability;

function checksum(table: PacketInfoTable): number {
  let value = table.tracks.length;
  for (const packet of table.packets) {
    value =
      (value +
        packet.trackIndex * 7 +
        packet.size * 11 +
        packet.ptsUs * 13 +
        packet.dtsUs * 17 +
        (packet.durationUs ?? 0) * 19 +
        (packet.keyframe ? 23 : 0)) >>>
      0;
  }
  return value;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take median of empty samples');
  return value;
}

function medianAbsoluteDeviation(values: readonly number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function assertPacketRowsEqual(
  label: string,
  actual: PacketInfoTable,
  expected: PacketInfoTable,
): void {
  if (actual.packets.length !== expected.packets.length) {
    throw new Error(
      `${label} packet count ${actual.packets.length} differs from ${expected.packets.length}`,
    );
  }
  for (let index = 0; index < expected.packets.length; index++) {
    const left = actual.packets[index];
    const right = expected.packets[index];
    if (
      left === undefined ||
      right === undefined ||
      left.trackIndex !== right.trackIndex ||
      left.offset !== right.offset ||
      left.size !== right.size ||
      left.ptsUs !== right.ptsUs ||
      left.dtsUs !== right.dtsUs ||
      left.durationUs !== right.durationUs ||
      left.keyframe !== right.keyframe
    ) {
      throw new Error(`${label} packet ${index} differs from the full-parser truth`);
    }
  }
}

interface ClassificationSubject {
  readonly lengthSize: 1 | 2 | 4;
  readonly samples: ReturnType<typeof buildSampleData>;
}

interface ClassificationTruth {
  readonly intraPictures: number;
  readonly checksum: number;
}

async function classificationSubjects(): Promise<readonly ClassificationSubject[]> {
  const movie = await readMovie({
    size: bytes.byteLength,
    inMemory: true,
    cachedWhole: () => bytes,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  });
  const subjects: ClassificationSubject[] = [];
  for (const track of movie.tracks) {
    if (
      track.mediaType !== 'video' ||
      (track.sampleEntryType !== 'avc1' && track.sampleEntryType !== 'avc3') ||
      track.codecPrivate?.boxType !== 'avcC'
    ) {
      continue;
    }
    const size = ((track.codecPrivate.data[4] ?? 0) & 3) + 1;
    if (size !== 1 && size !== 2 && size !== 4) continue;
    subjects.push({
      lengthSize: size,
      samples: buildSampleData(track).filter((sample) => !sample.keyframe),
    });
  }
  return subjects;
}

function classificationTruth(
  prior: ClassificationTruth,
  sampleIndex: number,
  picture: boolean | undefined,
): ClassificationTruth {
  const status = picture === true ? 3 : picture === false ? 2 : 1;
  const checksum = Math.imul(
    Math.imul(prior.checksum ^ sampleIndex, 0x01000193) ^ status,
    0x01000193,
  );
  return {
    intraPictures: prior.intraPictures + (picture === true ? 1 : 0),
    checksum: checksum >>> 0,
  };
}

function directClassification(subjects: readonly ClassificationSubject[]): ClassificationTruth {
  let truth: ClassificationTruth = { intraPictures: 0, checksum: 0x811c9dc5 };
  for (const subject of subjects) {
    for (const sample of subject.samples) {
      truth = classificationTruth(
        truth,
        sample.index,
        h264AccessUnitRangeIsKeyPicture(bytes, sample.offset, sample.size, subject.lengthSize),
      );
    }
  }
  return truth;
}

async function legacyPromiseClassification(
  subjects: readonly ClassificationSubject[],
): Promise<{ readonly truth: ClassificationTruth; readonly readCalls: number }> {
  let truth: ClassificationTruth = { intraPictures: 0, checksum: 0x811c9dc5 };
  let readCalls = 0;
  for (const subject of subjects) {
    for (let start = 0; start < subject.samples.length; start += 2_048) {
      const batch = subject.samples.slice(start, start + 2_048);
      const accessUnits = await Promise.all(
        batch.map((sample) => {
          readCalls++;
          return Promise.resolve(bytes.subarray(sample.offset, sample.offset + sample.size));
        }),
      );
      for (let index = 0; index < batch.length; index++) {
        const sample = batch[index];
        const accessUnit = accessUnits[index];
        if (sample === undefined || accessUnit === undefined) continue;
        truth = classificationTruth(
          truth,
          sample.index,
          h264AccessUnitIsKeyPicture(accessUnit, subject.lengthSize),
        );
      }
    }
  }
  return { truth, readCalls };
}

interface ReadStats {
  reads: number;
  bytes: number;
}

function source(
  stats: ReadStats,
  kind: 'bytes' | 'blob',
): ByteSource & { readonly kind: 'bytes' | 'blob' } {
  return {
    kind,
    size: bytes.byteLength,
    stream(): ReadableStream<Uint8Array> {
      throw new Error('massive in-memory packet-info benchmark must stay range-backed');
    },
    range(start, end): Promise<Uint8Array> {
      stats.reads++;
      stats.bytes += end - start;
      return Promise.resolve(bytes.subarray(start, end));
    },
  };
}

async function run(kind: 'bytes' | 'blob' = 'bytes'): Promise<{
  readonly table: PacketInfoTable;
  readonly elapsedMs: number;
  readonly reads: number;
  readonly readBytes: number;
  readonly peakRssBytes: number;
}> {
  const stats = { reads: 0, bytes: 0 };
  const started = Bun.nanoseconds();
  const table = await readPacketInfo.call(Mp4Driver, source(stats, kind));
  return {
    table,
    elapsedMs: (Bun.nanoseconds() - started) / 1_000_000,
    reads: stats.reads,
    readBytes: stats.bytes,
    peakRssBytes: process.resourceUsage().maxRSS,
  };
}

for (let index = 0; index < WARMUP; index++) await run();
const baselineMs: number[] = [];
let declaredKeyframes: number | undefined;
let fullParserTable: PacketInfoTable | undefined;
for (let index = 0; index < SAMPLES; index++) {
  const started = Bun.nanoseconds();
  const movie = await readMovie({
    size: bytes.byteLength,
    inMemory: true,
    cachedWhole: () => bytes,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  });
  const rawTable = mp4PacketInfoTable(movie);
  fullParserTable = rawTable;
  baselineMs.push((Bun.nanoseconds() - started) / 1_000_000);
  const currentDeclared = rawTable.packets.filter((packet) => packet.keyframe).length;
  declaredKeyframes ??= currentDeclared;
  if (currentDeclared !== declaredKeyframes) {
    throw new Error('massive MP4 declared stss truth changed between fresh samples');
  }
  Bun.gc(true);
}
const samples = [];
const reads = [];
const readBytes = [];
const peakRssBytes = [];
let truth:
  | {
      readonly packets: number;
      readonly keyframes: number;
      readonly checksum: number;
    }
  | undefined;
let truthTable: PacketInfoTable | undefined;
for (let index = 0; index < SAMPLES; index++) {
  const measured = await run();
  const current = {
    packets: measured.table.packets.length,
    keyframes: measured.table.packets.filter((packet) => packet.keyframe).length,
    checksum: checksum(measured.table),
  };
  if (truth === undefined) {
    truth = current;
    truthTable = measured.table;
  } else if (
    current.packets !== truth.packets ||
    current.keyframes !== truth.keyframes ||
    current.checksum !== truth.checksum
  ) {
    throw new Error('massive MP4 packet truth changed between fresh samples');
  }
  samples.push(measured.elapsedMs);
  reads.push(measured.reads);
  readBytes.push(measured.readBytes);
  peakRssBytes.push(measured.peakRssBytes);
  Bun.gc(true);
}
if (
  truth === undefined ||
  truthTable === undefined ||
  fullParserTable === undefined ||
  declaredKeyframes === undefined
) {
  throw new Error('massive MP4 benchmark produced no truth sample');
}
const inferredNonStssPictures = truth.keyframes - declaredKeyframes;
const subjects = await classificationSubjects();
await legacyPromiseClassification(subjects);
directClassification(subjects);
const legacyClassifierMs: number[] = [];
const directClassifierMs: number[] = [];
let legacyClassifier:
  | { readonly truth: ClassificationTruth; readonly readCalls: number }
  | undefined;
let directClassifier: ClassificationTruth | undefined;
for (let index = 0; index < SAMPLES; index++) {
  if (index % 2 === 0) {
    let started = Bun.nanoseconds();
    legacyClassifier = await legacyPromiseClassification(subjects);
    legacyClassifierMs.push((Bun.nanoseconds() - started) / 1_000_000);
    started = Bun.nanoseconds();
    directClassifier = directClassification(subjects);
    directClassifierMs.push((Bun.nanoseconds() - started) / 1_000_000);
  } else {
    let started = Bun.nanoseconds();
    directClassifier = directClassification(subjects);
    directClassifierMs.push((Bun.nanoseconds() - started) / 1_000_000);
    started = Bun.nanoseconds();
    legacyClassifier = await legacyPromiseClassification(subjects);
    legacyClassifierMs.push((Bun.nanoseconds() - started) / 1_000_000);
  }
}
if (legacyClassifier === undefined || directClassifier === undefined) {
  throw new Error('AVC classifier control produced no samples');
}
if (
  legacyClassifier.truth.intraPictures !== directClassifier.intraPictures ||
  legacyClassifier.truth.checksum !== directClassifier.checksum
) {
  throw new Error('direct AVC classifier differs from the former promise/batch implementation');
}
const rangeControl = await run('blob');
const rangeTruth = {
  packets: rangeControl.table.packets.length,
  keyframes: rangeControl.table.packets.filter((packet) => packet.keyframe).length,
  checksum: checksum(rangeControl.table),
};
assertPacketRowsEqual('in-memory versus range', truthTable, rangeControl.table);
assertPacketRowsEqual('in-memory versus full parser', truthTable, fullParserTable);
if (
  rangeTruth.packets !== truth.packets ||
  rangeTruth.keyframes !== truth.keyframes ||
  rangeTruth.checksum !== truth.checksum
) {
  throw new Error(
    `in-memory AVC truth differs from exhaustive range control: ${JSON.stringify({ truth, rangeTruth })}`,
  );
}
const medianMs = median(samples);
const tableBaselineMedianMs = median(baselineMs);
if (CHECK && medianMs > 2_000) {
  throw new Error(
    `massive in-memory packet-info median ${medianMs.toFixed(3)}ms exceeds safety ceiling`,
  );
}
console.info(
  JSON.stringify(
    {
      benchmark: 'session13-mp4-avc-in-memory',
      fixture: FIXTURE,
      sourceBytes: bytes.byteLength,
      warmup: WARMUP,
      samples: SAMPLES,
      medianMs,
      madMs: medianAbsoluteDeviation(samples),
      sampleMs: samples,
      tableBaselineMedianMs,
      exhaustiveClassificationMs: medianMs - tableBaselineMedianMs,
      reads,
      readBytes,
      declaredKeyframes,
      inferredNonStssPictures,
      strictPacketRowsCompared: truth.packets,
      classifierControl: {
        candidateSamples: legacyClassifier.readCalls,
        inferredIntraPictures: directClassifier.intraPictures,
        checksum: directClassifier.checksum,
        formerPromiseBatchMedianMs: median(legacyClassifierMs),
        directWholeRangeMedianMs: median(directClassifierMs),
        speedup: median(legacyClassifierMs) / median(directClassifierMs),
        formerReadCallsPerSample: legacyClassifier.readCalls,
      },
      rangeControl: {
        elapsedMs: rangeControl.elapsedMs,
        reads: rangeControl.reads,
        readBytes: rangeControl.readBytes,
        ...rangeTruth,
      },
      peakRssBytes: Math.max(...peakRssBytes),
      retainedMemory: process.memoryUsage(),
      ...truth,
    },
    null,
    2,
  ),
);
