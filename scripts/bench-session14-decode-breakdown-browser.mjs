#!/usr/bin/env node
/**
 * Browser profile for product-owned MKV/H.264 decode, bounded large-H.264 decode, and decode-anchored
 * MP4 -> MKV stream-copy. Fixture fetch and cryptographic validation stay outside timed samples.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUPS = 2;
const SAMPLES = 7;
const root = process.cwd();
const fixtureRoot = resolve(root, '../media-test/fixtures/media/scenarios/decode-seek');
const cases = [
  {
    id: 'mkv-h264',
    path: 'decode_mkv_h264/h264_in_mkv.mkv',
    bytes: 4_365_473,
    sha256: '56300bb8ec5dd8e9d83031c0c9e5d9cb4cc552fc905399f77cf46046c03af783',
    maxFrames: 60,
  },
  {
    id: 'large-h264-120s',
    path: 'decode_size_large_h264_120s/large_h264_1080p_120s.mp4',
    bytes: 89_573_913,
    sha256: 'efa6dd569d4d17f178bb47f371e6c94aa4ff130a01288419d487827078ff02a5',
    maxFrames: 60,
  },
  {
    id: 'decode-remux-source',
    path: 'meta_decode_remux_eq_decode_anchored/h264_1080p_30s.mp4',
    bytes: 31_258_790,
    sha256: '6d9562aa3b0d3bdd5cb67647fa71fef2f676ddfd2d375d8048e4e967d95bdf03',
    maxFrames: 8,
    remux: true,
  },
];

const fixtureById = new Map();
for (const benchmarkCase of cases) {
  const fixture = await readFile(resolve(fixtureRoot, benchmarkCase.path));
  const digest = createHash('sha256').update(fixture).digest('hex');
  if (fixture.byteLength !== benchmarkCase.bytes || digest !== benchmarkCase.sha256) {
    throw new Error(`${benchmarkCase.id}: fixture integrity mismatch`);
  }
  fixtureById.set(benchmarkCase.id, fixture);
}

const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const headers = {
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (url.pathname === '/') {
    response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>decode breakdown</title>');
    return;
  }
  if (url.pathname.startsWith('/dist/')) {
    try {
      const path = resolve(root, `.${url.pathname}`);
      const bytes = await readFile(path);
      response.writeHead(200, {
        ...headers,
        'content-length': String(bytes.byteLength),
        'content-type': contentTypes.get(extname(path)) ?? 'application/octet-stream',
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404, headers).end(String(error));
    }
    return;
  }
  const id = url.pathname.startsWith('/fixture/')
    ? decodeURIComponent(url.pathname.slice('/fixture/'.length))
    : undefined;
  const fixture = id === undefined ? undefined : fixtureById.get(id);
  if (fixture === undefined) {
    response.writeHead(404, headers).end('not found');
    return;
  }
  response.writeHead(200, {
    ...headers,
    'content-length': String(fixture.byteLength),
    'content-type': 'application/octet-stream',
  });
  response.end(fixture);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('profile server did not bind');

const browser = await chromium.launch({
  headless: false,
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ benchmarkCases, samples, warmups }) => {
      const { createMedia } = await import(`/dist/index.js?run=${Date.now()}`);
      const media = createMedia({ worker: false });
      const inputs = new Map(
        await Promise.all(
          benchmarkCases.map(async ({ id }) => [
            id,
            new Uint8Array(await (await fetch(`/fixture/${encodeURIComponent(id)}`)).arrayBuffer()),
          ]),
        ),
      );

      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('cannot take median of empty samples');
        return value;
      };
      const percentile = (values, fraction) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
        if (value === undefined) throw new Error('cannot take percentile of empty samples');
        return value;
      };
      const mad = (values) => {
        const center = median(values);
        return median(values.map((value) => Math.abs(value - center)));
      };
      const sha256 = async (bytes) => {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      };
      const outputBytes = async (output) => {
        if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
        if (output instanceof Uint8Array) return output;
        if (output instanceof ArrayBuffer) return new Uint8Array(output);
        throw new Error(`unexpected byte output ${Object.prototype.toString.call(output)}`);
      };
      const measure = async (run) => {
        globalThis.gc?.();
        const heapBefore = performance.memory?.usedJSHeapSize ?? null;
        const started = performance.now();
        const truth = await run();
        const elapsedMs = performance.now() - started;
        const heapAfter = performance.memory?.usedJSHeapSize ?? null;
        return { elapsedMs, heapAfter, heapBefore, truth };
      };
      const summarize = (values) => {
        const elapsed = values.map((value) => value.elapsedMs);
        const heapDeltas = values
          .filter((value) => Number.isFinite(value.heapBefore) && Number.isFinite(value.heapAfter))
          .map((value) => value.heapAfter - value.heapBefore);
        return {
          heapDeltaMedianBytes: heapDeltas.length === 0 ? null : median(heapDeltas),
          madMs: mad(elapsed),
          maxMs: Math.max(...elapsed),
          medianMs: median(elapsed),
          minMs: Math.min(...elapsed),
          p75Ms: percentile(elapsed, 0.75),
          p95Ms: percentile(elapsed, 0.95),
          samplesMs: elapsed,
        };
      };

      const demuxPrefix = async (input, maxPackets) => {
        const demuxed = await media.demux(input);
        try {
          const track = demuxed.tracks.find(
            (candidate) => candidate.mediaType === 'video' && candidate.config !== undefined,
          );
          if (track?.config === undefined) throw new Error('demux returned no configured video');
          const reader = demuxed.packets(track.id).getReader();
          let packets = 0;
          let bytes = 0;
          try {
            while (packets < maxPackets) {
              const next = await reader.read();
              if (next.done) break;
              packets++;
              bytes += next.value.chunk.byteLength;
            }
            await reader.cancel();
          } finally {
            reader.releaseLock();
          }
          return { bytes, packets };
        } finally {
          await demuxed.close();
        }
      };

      const publicDecode = async (input, maxFrames, rgba) => {
        const video = media.decode(input).video;
        if (video === undefined) throw new Error('decode returned no video');
        const reader = video.getReader();
        const clocks = [];
        let closed = 0;
        let byteFold = 0;
        try {
          while (clocks.length < maxFrames) {
            const next = await reader.read();
            if (next.done) break;
            const frame = next.value;
            try {
              clocks.push([frame.timestamp, frame.duration]);
              if (rgba) {
                const bytes = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
                await frame.copyTo(bytes, { format: 'RGBA' });
                byteFold = (byteFold + (bytes[0] ?? 0) + (bytes.at(-1) ?? 0)) >>> 0;
              }
            } finally {
              frame.close();
              closed++;
            }
          }
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
        if (closed !== clocks.length || clocks.length !== maxFrames) {
          throw new Error(`public decode delivered/closed ${clocks.length}/${closed}`);
        }
        return { byteFold, clocks, closed };
      };

      const pixelTruth = async (input, maxFrames) => {
        const video = media.decode(input).video;
        if (video === undefined) throw new Error('truth decode returned no video');
        const reader = video.getReader();
        const clocks = [];
        const digests = [];
        try {
          while (digests.length < maxFrames) {
            const next = await reader.read();
            if (next.done) break;
            const frame = next.value;
            try {
              const rgba = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
              await frame.copyTo(rgba, { format: 'RGBA' });
              clocks.push([frame.timestamp, frame.duration]);
              digests.push(await sha256(rgba));
            } finally {
              frame.close();
            }
          }
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
        return { clocks, digests };
      };

      const rows = [];
      for (const benchmarkCase of benchmarkCases.filter((item) => item.remux !== true)) {
        const input = inputs.get(benchmarkCase.id);
        if (input === undefined) throw new Error(`${benchmarkCase.id}: input missing`);
        const demux = [];
        const publicFrames = [];
        const publicRgba = [];
        for (let index = 0; index < warmups + samples; index++) {
          const demuxSample = await measure(() => demuxPrefix(input, benchmarkCase.maxFrames));
          const publicSample = await measure(() =>
            publicDecode(input, benchmarkCase.maxFrames, false),
          );
          const rgbaSample = await measure(() =>
            publicDecode(input, benchmarkCase.maxFrames, true),
          );
          if (index >= warmups) {
            demux.push(demuxSample);
            publicFrames.push(publicSample);
            publicRgba.push(rgbaSample);
          }
        }
        const packetPrefix = demux[0]?.truth.packets;
        if (packetPrefix === undefined) throw new Error('demux profile returned no packet count');
        rows.push({
          id: benchmarkCase.id,
          fixtureBytes: input.byteLength,
          maxFrames: benchmarkCase.maxFrames,
          packetPrefix,
          demuxAndPacketPrefix: summarize(demux),
          publicDecodePrefix: summarize(publicFrames),
          publicDecodeAndRgba: summarize(publicRgba),
          truth: await pixelTruth(input, Math.min(8, benchmarkCase.maxFrames)),
        });
      }

      const remuxCase = benchmarkCases.find((item) => item.remux === true);
      if (remuxCase === undefined) throw new Error('remux case missing');
      const remuxInput = inputs.get(remuxCase.id);
      if (remuxInput === undefined) throw new Error('remux input missing');
      const remuxOnce = async () => outputBytes(await media.remux(remuxInput, { to: 'mkv' }));
      for (let index = 0; index < warmups; index++) await remuxOnce();
      const remuxSamples = [];
      const outputDigests = [];
      let remuxed = new Uint8Array(0);
      for (let index = 0; index < samples; index++) {
        const sample = await measure(remuxOnce);
        remuxed = sample.truth;
        remuxSamples.push(sample);
        outputDigests.push(await sha256(remuxed));
      }
      if (new Set(outputDigests).size !== 1) throw new Error('remux output was not deterministic');
      const sourceTruth = await pixelTruth(remuxInput, remuxCase.maxFrames);
      const outputTruth = await pixelTruth(remuxed, remuxCase.maxFrames);
      if (JSON.stringify(sourceTruth.digests) !== JSON.stringify(outputTruth.digests)) {
        throw new Error('MP4 -> MKV changed decoded pixel truth');
      }
      const timestampDeltasUs = sourceTruth.clocks.map(([timestamp], index) =>
        Math.abs(timestamp - outputTruth.clocks[index][0]),
      );
      const maxTimestampDeltaUs = Math.max(...timestampDeltasUs);
      if (maxTimestampDeltaUs > 500) {
        throw new Error(`MP4 -> MKV timestamp quantization exceeded 500us: ${maxTimestampDeltaUs}`);
      }

      await media.dispose();
      return {
        crossOriginIsolated,
        decodeRows: rows,
        remux: {
          fixtureBytes: remuxInput.byteLength,
          outputBytes: remuxed.byteLength,
          outputSha256: outputDigests[0],
          timing: summarize(remuxSamples),
          truth: {
            maxTimestampDeltaUs,
            output: outputTruth,
            pixelsExact: true,
            source: sourceTruth,
          },
        },
        userAgent: navigator.userAgent,
      };
    },
    { benchmarkCases: cases, samples: SAMPLES, warmups: WARMUPS },
  );
  console.info(
    JSON.stringify(
      {
        benchmark: 'session14-decode-breakdown-browser',
        cases,
        samples: SAMPLES,
        warmups: WARMUPS,
        ...report,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
