#!/usr/bin/env node
/** Attribute public decode boundary costs without relying on acceptance-harness implementation details. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUPS = 3;
const SAMPLES = 11;
const root = process.cwd();
const fixturePath = resolve(
  root,
  '../media-test/fixtures/media/scenarios/decode-seek/decode_extreme_fps_1/h264_1fps_30s.mp4',
);
const fixture = await readFile(fixturePath);
const expectedSha256 = '36ad3fd783e4993b751e2aef705f345500faf581d483b5d86a751745e119f46d';
if (
  fixture.byteLength !== 183_419 ||
  createHash('sha256').update(fixture).digest('hex') !== expectedSha256
) {
  throw new Error('1 fps fixture integrity mismatch');
}

const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>decode public-shape profile</title>');
    return;
  }
  if (url.pathname === '/fixture') {
    response.writeHead(200, {
      'content-length': String(fixture.byteLength),
      'content-type': 'video/mp4',
    });
    response.end(fixture);
    return;
  }
  if (url.pathname.startsWith('/dist/')) {
    try {
      const path = resolve(root, `.${url.pathname}`);
      const bytes = await readFile(path);
      response.writeHead(200, {
        'content-length': String(bytes.byteLength),
        'content-type': contentTypes.get(extname(path)) ?? 'application/octet-stream',
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404).end(String(error));
    }
    return;
  }
  response.writeHead(404).end('not found');
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('profile server did not bind');

const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ warmups, samples }) => {
      const { createMedia, fromBlob, fromBytes } = await import(`/dist/index.js?run=${Date.now()}`);
      const bytes = new Uint8Array(await (await fetch('/fixture')).arrayBuffer());
      const blob = new Blob([bytes], { type: 'video/mp4' });
      const file = new File([bytes], 'h264_1fps_30s.mp4', { type: 'video/mp4' });

      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('cannot take median of empty samples');
        return value;
      };
      const mad = (values) => {
        const center = median(values);
        return median(values.map((value) => Math.abs(value - center)));
      };
      const hex = (digest) =>
        [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
      const sha256 = async (data) =>
        hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
      const sameClocks = (left, right) =>
        left.length === right.length &&
        left.every(
          (clock, index) =>
            clock.timestamp === right[index]?.timestamp &&
            clock.duration === right[index]?.duration,
        );

      const makeRangeSource = (copyRanges) => {
        const counters = { rangeCalls: 0, rangeBytes: 0, streamCalls: 0 };
        const source = {
          __media: 'source',
          kind: 'bytes',
          size: bytes.byteLength,
          mimeHint: 'video/mp4',
          stream() {
            counters.streamCalls++;
            return new ReadableStream({
              start(controller) {
                controller.enqueue(copyRanges ? bytes.slice() : bytes);
                controller.close();
              },
            });
          },
          range(start, end) {
            counters.rangeCalls++;
            const view = bytes.subarray(start, end);
            counters.rangeBytes += view.byteLength;
            return Promise.resolve(copyRanges ? view.slice() : view);
          },
        };
        return { source, counters };
      };

      const createInputProvider = (id) => {
        if (id === 'uint8-reused') return () => ({ input: bytes });
        if (id === 'uint8-copied') return () => ({ input: bytes.slice() });
        if (id === 'blob-reused') return () => ({ input: blob });
        if (id === 'file-reused') return () => ({ input: file });
        if (id === 'from-bytes-fresh')
          return () => ({ input: fromBytes(bytes, { mime: 'video/mp4' }) });
        if (id === 'from-blob-fresh') return () => ({ input: fromBlob(blob) });
        if (id === 'from-bytes-reused') {
          const input = fromBytes(bytes, { mime: 'video/mp4' });
          return () => ({ input });
        }
        if (id === 'from-blob-reused') {
          const input = fromBlob(blob);
          return () => ({ input });
        }
        const copyRanges = id.includes('copy');
        if (id.endsWith('reused')) {
          const { source, counters } = makeRangeSource(copyRanges);
          return () => ({ input: source, counters });
        }
        return () => {
          const { source, counters } = makeRangeSource(copyRanges);
          return { input: source, counters };
        };
      };

      const engineSpecs = [
        { id: 'reused-inline', reused: true, options: { worker: false } },
        { id: 'fresh-inline', reused: false, options: { worker: false } },
        { id: 'reused-default', reused: true, options: undefined },
        { id: 'fresh-default', reused: false, options: undefined },
      ];
      const inputIds = [
        'uint8-reused',
        'uint8-copied',
        'blob-reused',
        'file-reused',
        'from-bytes-reused',
        'from-bytes-fresh',
        'from-blob-reused',
        'from-blob-fresh',
        'range-view-reused',
        'range-view-fresh',
        'range-copy-reused',
        'range-copy-fresh',
      ];

      let expectedClocks;
      const pixelTruth = new Map();
      const runDecode = async (engine, inputRecord, operation) => {
        const counterStart = inputRecord.counters
          ? { ...inputRecord.counters }
          : { rangeCalls: 0, rangeBytes: 0, streamCalls: 0 };
        const decodeStarted = performance.now();
        const stream = engine.decode(inputRecord.input).video;
        const setupSyncMs = performance.now() - decodeStarted;
        if (stream === undefined) throw new Error('decode returned no video');
        const reader = stream.getReader();
        const clocks = [];
        const frameDigests = [];
        const materializedFrames = [];
        let firstFrameMs = 0;
        let pixelMs = 0;
        let byteFold = 0;
        let closedFrames = 0;
        let frames = 0;
        const firstReadStarted = performance.now();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            if (frames === 0) firstFrameMs = performance.now() - firstReadStarted;
            const frame = next.value;
            try {
              clocks.push({ timestamp: frame.timestamp, duration: frame.duration });
              if (operation !== 'close') {
                const pixelStarted = performance.now();
                const rgba = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
                await frame.copyTo(rgba, { format: 'RGBA' });
                byteFold = (byteFold + (rgba[0] ?? 0) + (rgba[rgba.length - 1] ?? 0)) >>> 0;
                if (operation === 'digest') {
                  frameDigests.push(new Uint8Array(await crypto.subtle.digest('SHA-256', rgba)));
                } else if (operation === 'materialize') {
                  materializedFrames.push(rgba);
                }
                pixelMs += performance.now() - pixelStarted;
              }
              frames++;
            } finally {
              frame.close();
              closedFrames++;
            }
          }
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
        let rgbaSha256;
        if (operation === 'digest') {
          const chain = new Uint8Array(frameDigests.length * 32);
          frameDigests.forEach((digest, index) => chain.set(digest, index * 32));
          const started = performance.now();
          rgbaSha256 = await sha256(chain);
          pixelMs += performance.now() - started;
        } else if (operation === 'materialize') {
          const started = performance.now();
          const byteLength = materializedFrames.reduce((sum, value) => sum + value.byteLength, 0);
          const allRgba = new Uint8Array(byteLength);
          let offset = 0;
          for (const value of materializedFrames) {
            allRgba.set(value, offset);
            offset += value.byteLength;
          }
          rgbaSha256 = await sha256(allRgba);
          pixelMs += performance.now() - started;
        }
        if (frames !== 30 || closedFrames !== frames) {
          throw new Error(
            `${operation}: delivered/closed ${frames}/${closedFrames}, expected 30/30`,
          );
        }
        if (expectedClocks === undefined) expectedClocks = clocks;
        else if (!sameClocks(expectedClocks, clocks)) throw new Error(`${operation}: clock drift`);
        if (operation === 'digest' || operation === 'materialize') {
          const prior = pixelTruth.get(operation);
          if (prior === undefined) pixelTruth.set(operation, rgbaSha256);
          else if (prior !== rgbaSha256) throw new Error(`${operation}: RGBA digest drift`);
        }
        const counterEnd = inputRecord.counters ?? counterStart;
        return {
          setupSyncMs,
          firstFrameMs,
          pixelMs,
          frames,
          closedFrames,
          byteFold,
          ...(rgbaSha256 === undefined ? {} : { rgbaSha256 }),
          rangeCalls: counterEnd.rangeCalls - counterStart.rangeCalls,
          rangeBytes: counterEnd.rangeBytes - counterStart.rangeBytes,
          streamCalls: counterEnd.streamCalls - counterStart.streamCalls,
        };
      };

      const runCohort = async (engineSpec, inputId, operation) => {
        const provider = createInputProvider(inputId);
        const reusedEngine = engineSpec.reused ? createMedia(engineSpec.options) : undefined;
        const samplesByMetric = {
          totalMs: [],
          createEngineMs: [],
          createInputMs: [],
          setupSyncMs: [],
          firstFrameMs: [],
          pixelMs: [],
          rangeCalls: [],
          rangeBytes: [],
          streamCalls: [],
        };
        let finalTruth;
        for (let index = 0; index < warmups + samples; index++) {
          const totalStarted = performance.now();
          const engineStarted = performance.now();
          const engine = reusedEngine ?? createMedia(engineSpec.options);
          const createEngineMs = performance.now() - engineStarted;
          const inputStarted = performance.now();
          const inputRecord = provider();
          const createInputMs = performance.now() - inputStarted;
          const truth = await runDecode(engine, inputRecord, operation);
          const totalMs = performance.now() - totalStarted;
          if (index >= warmups) {
            samplesByMetric.totalMs.push(totalMs);
            samplesByMetric.createEngineMs.push(createEngineMs);
            samplesByMetric.createInputMs.push(createInputMs);
            samplesByMetric.setupSyncMs.push(truth.setupSyncMs);
            samplesByMetric.firstFrameMs.push(truth.firstFrameMs);
            samplesByMetric.pixelMs.push(truth.pixelMs);
            samplesByMetric.rangeCalls.push(truth.rangeCalls);
            samplesByMetric.rangeBytes.push(truth.rangeBytes);
            samplesByMetric.streamCalls.push(truth.streamCalls);
          }
          finalTruth = truth;
        }
        const summarize = (values) => ({ median: median(values), mad: mad(values) });
        return {
          engine: engineSpec.id,
          input: inputId,
          operation,
          totalMs: summarize(samplesByMetric.totalMs),
          createEngineMs: summarize(samplesByMetric.createEngineMs),
          createInputMs: summarize(samplesByMetric.createInputMs),
          setupSyncMs: summarize(samplesByMetric.setupSyncMs),
          firstFrameMs: summarize(samplesByMetric.firstFrameMs),
          pixelMs: summarize(samplesByMetric.pixelMs),
          rangeCalls: summarize(samplesByMetric.rangeCalls),
          rangeBytes: summarize(samplesByMetric.rangeBytes),
          streamCalls: summarize(samplesByMetric.streamCalls),
          truth: finalTruth,
        };
      };

      const rows = [];
      for (const engineSpec of engineSpecs) {
        for (const inputId of inputIds) rows.push(await runCohort(engineSpec, inputId, 'close'));
      }
      for (const engineSpec of engineSpecs) {
        for (const inputId of ['uint8-reused', 'blob-reused', 'range-copy-fresh']) {
          for (const operation of ['copy', 'digest', 'materialize']) {
            rows.push(await runCohort(engineSpec, inputId, operation));
          }
        }
      }

      return {
        userAgent: navigator.userAgent,
        expectedFrames: expectedClocks?.length,
        pixelTruth: Object.fromEntries(pixelTruth),
        rows,
      };
    },
    { warmups: WARMUPS, samples: SAMPLES },
  );
  console.info(
    JSON.stringify(
      {
        benchmark: 'session13-decoder-public-shape-browser',
        warmups: WARMUPS,
        samples: SAMPLES,
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
