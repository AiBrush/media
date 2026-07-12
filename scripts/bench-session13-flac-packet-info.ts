#!/usr/bin/env bun
/** Fresh multi-sample benchmark for the fused native-FLAC packet-info scan (ADR-250). */

import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import type { PacketInfoMetadata, PacketInfoTable } from '../src/contracts/driver.ts';
import { FlacDriver } from '../src/drivers/flac/flac-driver.ts';
import {
  fastFlacFrames,
  flacMetadataLayout,
  flacPacketInfoRows,
  flacPacketInfoTable,
  flacTrackInfo,
} from '../src/drivers/flac/flac-sniff.ts';
import type { Source } from '../src/sources/source.ts';

const WARMUP = 5;
const SAMPLES = 21;
const FIXTURE = new URL('../fixtures/media/flac-blocksize-16.flac', import.meta.url);
const COPY_FIXTURE = new URL('../fixtures/media/flac-192khz.flac', import.meta.url);
const { SESSION13_FLAC_SELECTED: SELECTED_FIXTURE } = process.env;
let sink = 0;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function mad(values: readonly number[]): number {
  const middle = median(values);
  return median(values.map((value) => Math.abs(value - middle)));
}

function composedPacketInfoTable(bytes: Uint8Array): PacketInfoTable {
  const layout = flacMetadataLayout(bytes);
  return {
    tracks: [flacTrackInfo(layout.info, bytes.slice(layout.start, layout.audioStart))],
    packets: flacPacketInfoRows(fastFlacFrames(bytes, layout)),
  };
}

function assertRowsEqual(
  actual: readonly PacketInfoMetadata[],
  expected: readonly PacketInfoMetadata[],
  label: string,
): void {
  if (actual.length !== expected.length) {
    throw new Error(`${label}: ${actual.length} packets, expected ${expected.length}`);
  }
  for (let i = 0; i < actual.length; i++) {
    const left = actual[i];
    const right = expected[i];
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
      throw new Error(`${label}: packet ${i} changed`);
    }
  }
}

function sampleSync(run: () => PacketInfoTable): number {
  const started = Bun.nanoseconds();
  const table = run();
  sink = (sink + table.packets.length + (table.packets.at(-1)?.size ?? 0)) | 0;
  return (Bun.nanoseconds() - started) / 1_000_000;
}

function streamSource(bytes: Uint8Array, chunkBytes: number): Source {
  return {
    __media: 'source',
    kind: 'stream',
    size: bytes.byteLength,
    mimeHint: 'audio/flac',
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          for (let at = 0; at < bytes.byteLength; at += chunkBytes) {
            controller.enqueue(bytes.subarray(at, Math.min(bytes.byteLength, at + chunkBytes)));
          }
          controller.close();
        },
      }),
  };
}

async function legacyFullDrainPacketInfo(bytes: Uint8Array): Promise<PacketInfoTable> {
  const reader = streamSource(bytes, bytes.byteLength).stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  const copy = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    copy.set(chunk, offset);
    offset += chunk.byteLength;
  }
  reader.releaseLock();
  return flacPacketInfoTable(copy);
}

async function fullDriverPacketInfo(bytes: Uint8Array): Promise<PacketInfoTable> {
  const packetInfo = FlacDriver.packetInfo;
  if (packetInfo === undefined) throw new Error('FLAC packetInfo unavailable');
  return packetInfo.call(FlacDriver, streamSource(bytes, bytes.byteLength));
}

function urlLikeSource(
  bytes: Uint8Array,
  latencyMs: number,
  transport: { requests: number; transferredBytes: number; streamReads: number },
): Source {
  return {
    __media: 'source',
    kind: 'url',
    size: bytes.byteLength,
    mimeHint: 'audio/flac',
    filename: 'source.flac',
    stream: () => {
      transport.streamReads++;
      return new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.error(new Error('URL-like FLAC packetInfo unexpectedly opened a stream'));
        },
      });
    },
    range: async (start, end) => {
      transport.requests++;
      await new Promise<void>((resolve) => setTimeout(resolve, latencyMs));
      const view = bytes.subarray(start, end);
      transport.transferredBytes += view.byteLength;
      return view;
    },
  };
}

async function samplePublic(
  media: ReturnType<typeof createMedia>,
  bytes: Uint8Array,
  chunkBytes: number,
): Promise<{ readonly elapsedMs: number; readonly table: PacketInfoTable }> {
  const started = Bun.nanoseconds();
  const table = await (
    media as unknown as {
      packetInfo(source: Source, options: { readonly container: 'flac' }): Promise<PacketInfoTable>;
    }
  ).packetInfo(streamSource(bytes, chunkBytes), { container: 'flac' });
  sink = (sink + table.packets.length + (table.packets.at(-1)?.size ?? 0)) | 0;
  return { elapsedMs: (Bun.nanoseconds() - started) / 1_000_000, table };
}

async function sampleUrlLike(
  media: ReturnType<typeof createMedia>,
  bytes: Uint8Array,
  latencyMs: number,
): Promise<{
  readonly elapsedMs: number;
  readonly table: PacketInfoTable;
  readonly transport: { requests: number; transferredBytes: number; streamReads: number };
}> {
  const transport = { requests: 0, transferredBytes: 0, streamReads: 0 };
  const started = Bun.nanoseconds();
  const table = await (
    media as unknown as {
      packetInfo(source: Source, options: { readonly container: 'flac' }): Promise<PacketInfoTable>;
    }
  ).packetInfo(urlLikeSource(bytes, latencyMs, transport), { container: 'flac' });
  sink = (sink + table.packets.length + (table.packets.at(-1)?.size ?? 0)) | 0;
  return { elapsedMs: (Bun.nanoseconds() - started) / 1_000_000, table, transport };
}

const bytes = new Uint8Array(await readFile(FIXTURE));
const copyBytes = new Uint8Array(await readFile(COPY_FIXTURE));
const selectedBytes =
  SELECTED_FIXTURE === undefined ? undefined : new Uint8Array(await readFile(SELECTED_FIXTURE));
const expected = composedPacketInfoTable(bytes);
const fused = flacPacketInfoTable(bytes);
assertRowsEqual(fused.packets, expected.packets, 'fused structural oracle');

for (let i = 0; i < WARMUP; i++) {
  sampleSync(() => composedPacketInfoTable(bytes));
  sampleSync(() => flacPacketInfoTable(bytes));
}

const composedSamples: number[] = [];
const fusedSamples: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  if ((i & 1) === 0) {
    composedSamples.push(sampleSync(() => composedPacketInfoTable(bytes)));
    fusedSamples.push(sampleSync(() => flacPacketInfoTable(bytes)));
  } else {
    fusedSamples.push(sampleSync(() => flacPacketInfoTable(bytes)));
    composedSamples.push(sampleSync(() => composedPacketInfoTable(bytes)));
  }
}

const media = createMedia({ worker: false });
const lazyResolutionBytes = selectedBytes ?? bytes;
const firstLazy = await samplePublic(media, lazyResolutionBytes, lazyResolutionBytes.byteLength);
const firstReuse = await samplePublic(media, lazyResolutionBytes, lazyResolutionBytes.byteLength);
const oneChunkSamples: number[] = [];
const fragmentedSamples: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  const one = await samplePublic(media, bytes, bytes.byteLength);
  const fragmented = await samplePublic(media, bytes, 64 * 1024);
  assertRowsEqual(one.table.packets, expected.packets, `one-chunk public oracle ${i}`);
  assertRowsEqual(fragmented.table.packets, expected.packets, `fragmented public oracle ${i}`);
  oneChunkSamples.push(one.elapsedMs);
  fragmentedSamples.push(fragmented.elapsedMs);
}

const legacyDrainSamples: number[] = [];
const directDrainSamples: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  const runLegacy = async (): Promise<void> => {
    const started = Bun.nanoseconds();
    const table = await legacyFullDrainPacketInfo(bytes);
    assertRowsEqual(table.packets, expected.packets, `legacy full-drain oracle ${i}`);
    legacyDrainSamples.push((Bun.nanoseconds() - started) / 1_000_000);
  };
  const runDirect = async (): Promise<void> => {
    const started = Bun.nanoseconds();
    const table = await fullDriverPacketInfo(bytes);
    assertRowsEqual(table.packets, expected.packets, `direct full-drain oracle ${i}`);
    directDrainSamples.push((Bun.nanoseconds() - started) / 1_000_000);
  };
  if ((i & 1) === 0) {
    await runLegacy();
    await runDirect();
  } else {
    await runDirect();
    await runLegacy();
  }
}

const copyExpected = flacPacketInfoTable(copyBytes);
const copyLegacySamples: number[] = [];
const copyDirectSamples: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  const runLegacy = async (): Promise<void> => {
    const started = Bun.nanoseconds();
    const table = await legacyFullDrainPacketInfo(copyBytes);
    assertRowsEqual(table.packets, copyExpected.packets, `copy-shape legacy oracle ${i}`);
    copyLegacySamples.push((Bun.nanoseconds() - started) / 1_000_000);
  };
  const runDirect = async (): Promise<void> => {
    const started = Bun.nanoseconds();
    const table = await fullDriverPacketInfo(copyBytes);
    assertRowsEqual(table.packets, copyExpected.packets, `copy-shape direct oracle ${i}`);
    copyDirectSamples.push((Bun.nanoseconds() - started) / 1_000_000);
  };
  if ((i & 1) === 0) {
    await runLegacy();
    await runDirect();
  } else {
    await runDirect();
    await runLegacy();
  }
}

let selectedEvidence:
  | {
      readonly bytes: number;
      readonly packets: number;
      readonly directParser: { readonly medianMs: number; readonly madMs: number };
      readonly freshEngine: { readonly medianMs: number; readonly madMs: number };
      readonly reusedEngine: { readonly medianMs: number; readonly madMs: number };
      readonly urlLike3Ms: {
        readonly medianMs: number;
        readonly madMs: number;
        readonly requestsPerRun: number;
        readonly transferredBytesPerRun: number;
        readonly streamReadsPerRun: number;
      };
    }
  | undefined;
if (selectedBytes !== undefined) {
  const selectedExpected = flacPacketInfoTable(selectedBytes);
  const directParserSamples: number[] = [];
  const freshEngineSamples: number[] = [];
  const reusedEngineSamples: number[] = [];
  const urlSamples: number[] = [];
  let requests = 0;
  let transferredBytes = 0;
  let streamReads = 0;
  const selectedMedia = createMedia({ worker: false });
  await samplePublic(selectedMedia, selectedBytes, selectedBytes.byteLength);
  for (let i = 0; i < SAMPLES; i++) {
    directParserSamples.push(sampleSync(() => flacPacketInfoTable(selectedBytes)));
    freshEngineSamples.push(
      (await samplePublic(createMedia({ worker: false }), selectedBytes, selectedBytes.byteLength))
        .elapsedMs,
    );
    const reused = await samplePublic(selectedMedia, selectedBytes, selectedBytes.byteLength);
    assertRowsEqual(reused.table.packets, selectedExpected.packets, `selected reused oracle ${i}`);
    reusedEngineSamples.push(reused.elapsedMs);
    const url = await sampleUrlLike(selectedMedia, selectedBytes, 3);
    assertRowsEqual(url.table.packets, selectedExpected.packets, `selected URL oracle ${i}`);
    urlSamples.push(url.elapsedMs);
    requests += url.transport.requests;
    transferredBytes += url.transport.transferredBytes;
    streamReads += url.transport.streamReads;
  }
  selectedEvidence = {
    bytes: selectedBytes.byteLength,
    packets: selectedExpected.packets.length,
    directParser: { medianMs: median(directParserSamples), madMs: mad(directParserSamples) },
    freshEngine: { medianMs: median(freshEngineSamples), madMs: mad(freshEngineSamples) },
    reusedEngine: { medianMs: median(reusedEngineSamples), madMs: mad(reusedEngineSamples) },
    urlLike3Ms: {
      medianMs: median(urlSamples),
      madMs: mad(urlSamples),
      requestsPerRun: requests / SAMPLES,
      transferredBytesPerRun: transferredBytes / SAMPLES,
      streamReadsPerRun: streamReads / SAMPLES,
    },
  };
}

const composedMedian = median(composedSamples);
const fusedMedian = median(fusedSamples);
console.info(
  JSON.stringify(
    {
      fixture: FIXTURE.pathname.split('/').at(-1),
      bytes: bytes.byteLength,
      packets: expected.packets.length,
      warmup: WARMUP,
      samples: SAMPLES,
      composed: { medianMs: composedMedian, madMs: mad(composedSamples) },
      fused: {
        medianMs: fusedMedian,
        madMs: mad(fusedSamples),
        ratio: composedMedian / fusedMedian,
      },
      publicStream: {
        lazyResolution: {
          bytes: lazyResolutionBytes.byteLength,
          firstMs: firstLazy.elapsedMs,
          reuseMs: firstReuse.elapsedMs,
        },
        oneChunk: { medianMs: median(oneChunkSamples), madMs: mad(oneChunkSamples) },
        chunk64KiB: {
          medianMs: median(fragmentedSamples),
          madMs: mad(fragmentedSamples),
        },
      },
      fullDriverOneChunk: {
        packetDense: {
          fixture: FIXTURE.pathname.split('/').at(-1),
          legacyCopy: { medianMs: median(legacyDrainSamples), madMs: mad(legacyDrainSamples) },
          directOwned: {
            medianMs: median(directDrainSamples),
            madMs: mad(directDrainSamples),
            ratio: median(legacyDrainSamples) / median(directDrainSamples),
          },
        },
        payloadDense: {
          fixture: COPY_FIXTURE.pathname.split('/').at(-1),
          bytes: copyBytes.byteLength,
          packets: copyExpected.packets.length,
          legacyCopy: { medianMs: median(copyLegacySamples), madMs: mad(copyLegacySamples) },
          directOwned: {
            medianMs: median(copyDirectSamples),
            madMs: mad(copyDirectSamples),
            ratio: median(copyLegacySamples) / median(copyDirectSamples),
          },
        },
      },
      ...(selectedEvidence === undefined ? {} : { selected: selectedEvidence }),
      sink,
    },
    null,
    2,
  ),
);
