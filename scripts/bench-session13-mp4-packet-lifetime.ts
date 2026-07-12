#!/usr/bin/env bun
/** Retained-backing-store proof for ADR-260's terminal MP4 packet-stream leases. */

import { readFile } from 'node:fs/promises';
import type { Demuxer, Packet } from '../src/contracts/driver.ts';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';
import { type Source, fromBytes } from '../src/sources/source.ts';

const FIXTURE =
  '../media-test/fixtures/media/scenarios/demux/size_large_large_h264_1080p_120s/02.mp4';
const CHECK = process.argv.includes('--check');
const NEGATIVE_CONTROL = process.argv.includes('--retain-source-negative-control');

interface V8HeapSnapshot {
  readonly snapshot: {
    readonly meta: {
      readonly node_fields: readonly string[];
      readonly node_types: readonly (readonly string[])[];
      readonly edge_fields: readonly string[];
      readonly edge_types: readonly (readonly string[])[];
    };
  };
  readonly nodes: readonly number[];
  readonly edges: readonly number[];
  readonly strings: readonly string[];
}

interface HeapRetainer {
  readonly sourceType: string;
  readonly sourceName: string;
  readonly edgeType: string;
}

function requiredField(fields: readonly string[], name: string): number {
  const index = fields.indexOf(name);
  if (index < 0) throw new Error(`heap snapshot has no ${name} field`);
  return index;
}

/** Strong inbound references to the exact large source buffer; WeakRef itself is intentionally ignored. */
function sourceBufferRetainers(sourceBytes: number): {
  readonly sourceBufferPresent: boolean;
  readonly strongRetainers: readonly HeapRetainer[];
} {
  const snapshot = JSON.parse(Bun.generateHeapSnapshot('v8')) as V8HeapSnapshot;
  const nodeFields = snapshot.snapshot.meta.node_fields;
  const edgeFields = snapshot.snapshot.meta.edge_fields;
  const nodeWidth = nodeFields.length;
  const edgeWidth = edgeFields.length;
  const nodeTypeIndex = requiredField(nodeFields, 'type');
  const nodeNameIndex = requiredField(nodeFields, 'name');
  const nodeSizeIndex = requiredField(nodeFields, 'self_size');
  const nodeEdgeCountIndex = requiredField(nodeFields, 'edge_count');
  const edgeTypeIndex = requiredField(edgeFields, 'type');
  const edgeTargetIndex = requiredField(edgeFields, 'to_node');
  const nodeTypes = snapshot.snapshot.meta.node_types[0];
  const edgeTypes = snapshot.snapshot.meta.edge_types[0];
  if (nodeTypes === undefined || edgeTypes === undefined) {
    throw new Error('heap snapshot has no node/edge type dictionaries');
  }

  const candidates: number[] = [];
  for (let node = 0; node < snapshot.nodes.length; node += nodeWidth) {
    const type = nodeTypes[snapshot.nodes[node + nodeTypeIndex] ?? -1];
    const name = snapshot.strings[snapshot.nodes[node + nodeNameIndex] ?? -1];
    const selfSize = snapshot.nodes[node + nodeSizeIndex] ?? -1;
    // Bun/JSC accounts a small object header in ArrayBuffer.self_size; no packet-owned buffer is close
    // to this exact 74 MB source size, so a 1 KiB structural allowance remains unambiguous.
    if (
      type === 'object' &&
      name === 'ArrayBuffer' &&
      selfSize >= sourceBytes &&
      selfSize < sourceBytes + 1_024
    ) {
      candidates.push(node);
    }
  }
  if (candidates.length === 0) return { sourceBufferPresent: false, strongRetainers: [] };
  if (candidates.length !== 1) {
    throw new Error(`heap snapshot found ${candidates.length} source-sized ArrayBuffers`);
  }

  const target = candidates[0];
  if (target === undefined) throw new Error('source-sized ArrayBuffer candidate disappeared');
  const strongRetainers: HeapRetainer[] = [];
  let edge = 0;
  for (let node = 0; node < snapshot.nodes.length; node += nodeWidth) {
    const edgeCount = snapshot.nodes[node + nodeEdgeCountIndex] ?? 0;
    for (let index = 0; index < edgeCount; index++, edge += edgeWidth) {
      if (snapshot.edges[edge + edgeTargetIndex] !== target) continue;
      const sourceType = nodeTypes[snapshot.nodes[node + nodeTypeIndex] ?? -1] ?? 'unknown';
      const sourceName = snapshot.strings[snapshot.nodes[node + nodeNameIndex] ?? -1] ?? 'unknown';
      const edgeType = edgeTypes[snapshot.edges[edge + edgeTypeIndex] ?? -1] ?? 'unknown';
      // Bun's V8 conversion currently labels the WeakRef target edge `internal`, so identify the actual
      // source object instead of trusting that converted edge label.
      if (sourceName !== 'WeakRef' && edgeType !== 'weak') {
        strongRetainers.push({ sourceType, sourceName, edgeType });
      }
    }
  }
  return { sourceBufferPresent: true, strongRetainers };
}

interface FakeChunkInit {
  readonly type?: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration?: number;
  readonly data: AllowSharedBufferSource;
}

class FakeEncodedChunk {
  readonly type: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #bytes: Uint8Array;

  constructor(init: FakeChunkInit) {
    this.type = init.type ?? 'key';
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.byteLength = init.data.byteLength;
    this.#bytes = new Uint8Array(this.byteLength);
    const source = ArrayBuffer.isView(init.data)
      ? new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength)
      : new Uint8Array(init.data);
    this.#bytes.set(source);
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const target = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    target.set(this.#bytes);
  }
}

async function drain(
  stream: ReadableStream<Packet>,
): Promise<{ count: number; checksum: number; packetDataViews: number }> {
  let reader: ReadableStreamDefaultReader<Packet> | undefined = stream.getReader();
  let count = 0;
  let checksum = 0;
  let packetDataViews = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return { count, checksum, packetDataViews };
      count++;
      if (next.value.data !== undefined) packetDataViews++;
      checksum =
        (checksum +
          next.value.chunk.byteLength * 3 +
          next.value.chunk.timestamp * 5 +
          (next.value.dtsUs ?? 0) * 7) >>>
        0;
    }
  } finally {
    reader.releaseLock();
    reader = undefined;
  }
}

function packetStreams(demuxer: Demuxer): ReadableStream<Packet>[] {
  return demuxer.tracks.map((track) => demuxer.packets(track.id));
}

async function run(): Promise<{
  readonly streams: readonly ReadableStream<Packet>[];
  readonly retainedValues: readonly unknown[];
  readonly sourceBuffer: WeakRef<ArrayBuffer>;
  readonly sourceBytes: number;
  readonly packets: number;
  readonly checksum: number;
  readonly packetDataViews: number;
  readonly elapsedMs: number;
}> {
  let file: Uint8Array | undefined = await readFile(FIXTURE);
  let sourceArrayBuffer: ArrayBuffer | undefined = new ArrayBuffer(file.byteLength);
  let bytes: Uint8Array | undefined = new Uint8Array(sourceArrayBuffer);
  bytes.set(file);
  const sourceBuffer = new WeakRef(sourceArrayBuffer);
  const sourceBytes = bytes.byteLength;
  const started = Bun.nanoseconds();
  let source: Source | undefined = fromBytes(bytes, { mime: 'video/mp4' });
  let demuxer: Demuxer | undefined = await Mp4Driver.demux(source);
  source = undefined;
  const retainedValues: unknown[] = [
    demuxer.close,
    demuxer.packets,
    demuxer.packetTable,
    demuxer.tracks,
  ];
  const streams = packetStreams(demuxer);
  let packets = 0;
  let checksum = 0;
  let packetDataViews = 0;
  for (const stream of streams) {
    const drained = await drain(stream);
    packets += drained.count;
    checksum = (checksum + drained.checksum) >>> 0;
    packetDataViews += drained.packetDataViews;
  }
  await demuxer.close();
  demuxer = undefined;
  file = undefined;
  if (NEGATIVE_CONTROL) retainedValues.push(sourceArrayBuffer);
  bytes = undefined;
  sourceArrayBuffer = undefined;
  return {
    streams,
    retainedValues,
    sourceBuffer,
    sourceBytes,
    packets,
    checksum,
    packetDataViews,
    elapsedMs: (Bun.nanoseconds() - started) / 1_000_000,
  };
}

const originalVideo = globalThis.EncodedVideoChunk;
const originalAudio = globalThis.EncodedAudioChunk;
Object.defineProperty(globalThis, 'EncodedVideoChunk', {
  configurable: true,
  value: FakeEncodedChunk as unknown as typeof EncodedVideoChunk,
});
Object.defineProperty(globalThis, 'EncodedAudioChunk', {
  configurable: true,
  value: FakeEncodedChunk as unknown as typeof EncodedAudioChunk,
});
try {
  const result = await run();
  for (let index = 0; index < 4; index++) {
    Bun.gc(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const retention = sourceBufferRetainers(result.sourceBytes);
  const sourceReleasedWhileCompletedStreamsAreRetained = result.sourceBuffer.deref() === undefined;
  const oracleRejectedRetainedSource = retention.strongRetainers.length > 0;
  if (CHECK && NEGATIVE_CONTROL !== oracleRejectedRetainedSource) {
    throw new Error(
      NEGATIVE_CONTROL
        ? 'retained-source negative control escaped the heap-retainer oracle'
        : `completed MP4 demux values retained the source: ${JSON.stringify(retention.strongRetainers)}`,
    );
  }
  if (CHECK && (result.packets !== 1_808 || result.checksum !== 1_438_865_538)) {
    throw new Error('MP4 lifetime benchmark packet truth changed');
  }
  if (CHECK && result.packetDataViews !== 0) {
    throw new Error('in-memory MP4 packets exposed source-backed Packet.data views');
  }
  console.info(
    JSON.stringify(
      {
        benchmark: 'session13-mp4-packet-lifetime',
        fixture: FIXTURE,
        sourceBytes: result.sourceBytes,
        packets: result.packets,
        checksum: result.checksum,
        packetDataViews: result.packetDataViews,
        elapsedMs: result.elapsedMs,
        completedStreamsRetained: result.streams.length,
        retainedValues: result.retainedValues.length,
        sourceBufferPresentInHeapSnapshot: retention.sourceBufferPresent,
        strongSourceRetainers: retention.strongRetainers,
        oracleRejectedRetainedSource,
        negativeControl: NEGATIVE_CONTROL,
        sourceReleasedWhileCompletedStreamsAreRetained,
        memory: process.memoryUsage(),
      },
      null,
      2,
    ),
  );
} finally {
  if (originalVideo === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
  else Object.defineProperty(globalThis, 'EncodedVideoChunk', { value: originalVideo });
  if (originalAudio === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
  else Object.defineProperty(globalThis, 'EncodedAudioChunk', { value: originalAudio });
}
