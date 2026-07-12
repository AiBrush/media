#!/usr/bin/env node
/** Product-only browser A/B: native decoded surfaces versus compact CPU-backed VideoFrames. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUPS = 3;
const SAMPLES = 9;
const root = process.cwd();
const cases = [
  {
    id: 'h264-vfr',
    path: '../media-test/fixtures/media/h264_vfr.mp4',
    bytes: 2_279_109,
    sha256: '0f126ff4956210da801b61aeda6619d6dbf113ba316d3cbcfea103ce9b4e5ea6',
    frames: 111,
  },
  {
    id: 'h264-bframes',
    path: 'fixtures/media/test.mp4',
    bytes: 192_844,
    sha256: '90417c4bcffe64860eee7d072867c0618ee9c10d768828f644f52df99663977b',
    frames: 182,
  },
];

const fixtureById = new Map();
for (const benchmarkCase of cases) {
  const bytes = await readFile(resolve(root, benchmarkCase.path));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== benchmarkCase.bytes || digest !== benchmarkCase.sha256) {
    throw new Error(
      `${benchmarkCase.id}: fixture integrity mismatch (${bytes.byteLength}, ${digest})`,
    );
  }
  fixtureById.set(benchmarkCase.id, bytes);
}

const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    response.end('<!doctype html><meta charset="utf-8"><title>VideoFrame detach A/B</title>');
    return;
  }
  if (url.pathname.startsWith('/dist/')) {
    try {
      const path = resolve(root, `.${url.pathname}`);
      const bytes = await readFile(path);
      response.writeHead(200, {
        'content-length': String(bytes.byteLength),
        'content-type': contentTypes.get(extname(path)) ?? 'application/octet-stream',
        'cross-origin-resource-policy': 'same-origin',
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404).end(String(error));
    }
    return;
  }
  const id = url.pathname.startsWith('/fixture/')
    ? decodeURIComponent(url.pathname.slice('/fixture/'.length))
    : undefined;
  const fixture = id === undefined ? undefined : fixtureById.get(id);
  if (fixture === undefined) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-length': String(fixture.byteLength),
    'content-type': 'video/mp4',
    'cross-origin-resource-policy': 'same-origin',
  });
  response.end(fixture);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('server did not bind');

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ benchmarkCases, warmups, samples }) => {
      const { createMedia } = await import(`/dist/index.js?run=${Date.now()}`);
      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('median of empty samples');
        return value;
      };
      const mad = (values) => {
        const center = median(values);
        return median(values.map((value) => Math.abs(value - center)));
      };
      const hex = (bytes) =>
        [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      const digest = async (bytes) =>
        hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
      const frameRect = (rect) =>
        rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      const colorTruth = (color) => ({
        primaries: color.primaries,
        transfer: color.transfer,
        matrix: color.matrix,
        fullRange: color.fullRange,
      });

      const NativeDecoder = globalThis.VideoDecoder;
      const nativeFrameOwner = new WeakMap();
      let activeStats;
      const statsForDecoder = new WeakMap();
      class ObservedDecoder extends NativeDecoder {
        constructor(init) {
          const stats = activeStats;
          super({
            ...init,
            output(frame) {
              if (stats !== undefined) {
                nativeFrameOwner.set(frame, stats);
                stats.nativeFrames++;
                stats.nativeLive++;
                stats.maxNativeLive = Math.max(stats.maxNativeLive, stats.nativeLive);
              }
              init.output(frame);
            },
          });
          if (stats !== undefined) {
            statsForDecoder.set(this, stats);
            this.addEventListener('dequeue', () => {
              stats.maxDecodeQueueSize = Math.max(stats.maxDecodeQueueSize, this.decodeQueueSize);
            });
          }
        }

        decode(chunk) {
          const stats = statsForDecoder.get(this);
          if (stats !== undefined) {
            stats.maxDecodeQueueSize = Math.max(stats.maxDecodeQueueSize, this.decodeQueueSize);
          }
          super.decode(chunk);
          if (stats !== undefined) {
            stats.maxDecodeQueueSize = Math.max(stats.maxDecodeQueueSize, this.decodeQueueSize);
          }
        }

        close() {
          const stats = statsForDecoder.get(this);
          if (stats !== undefined) stats.decoderCloses++;
          super.close();
        }
      }
      const nativeClose = VideoFrame.prototype.close;
      VideoFrame.prototype.close = function close() {
        const stats = nativeFrameOwner.get(this);
        if (stats !== undefined) {
          const count = (stats.closeCounts.get(this) ?? 0) + 1;
          stats.closeCounts.set(this, count);
          if (count > 1) throw new Error('native decoded VideoFrame closed more than once');
          stats.nativeClosed++;
          stats.nativeLive--;
        }
        return nativeClose.call(this);
      };
      globalThis.VideoDecoder = ObservedDecoder;

      const newStats = () => ({
        nativeFrames: 0,
        nativeClosed: 0,
        nativeLive: 0,
        maxNativeLive: 0,
        maxDecodeQueueSize: 0,
        decoderCloses: 0,
        closeCounts: new WeakMap(),
      });
      const publicStream = (input, stats) => {
        activeStats = stats;
        const stream = createMedia({ worker: false }).decode(input).video;
        if (stream === undefined) throw new Error('public decode returned no video stream');
        return stream;
      };
      const exactColorInit = (frame) => {
        const color = colorTruth(frame.colorSpace);
        return Object.values(color).some((value) => value !== null) ? color : undefined;
      };
      const detachFrame = async (frame, requestedFormat) => {
        const format = requestedFormat === 'natural' ? frame.format : requestedFormat;
        if (typeof format !== 'string') {
          throw new Error('decoded frame exposes no copyable natural format');
        }
        const rect = { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
        // Chromium requires a natural non-RGB copy to omit `format`; the observed format still authors
        // the CPU-backed replacement. Explicit NV12/I420 remain separate conversion diagnostics.
        const options = requestedFormat === 'natural' ? { rect } : { format, rect };
        const storage = new Uint8Array(frame.allocationSize(options));
        const layout = await frame.copyTo(storage, options);
        const visibleRect = frameRect(frame.visibleRect);
        const colorSpace = exactColorInit(frame);
        return new VideoFrame(storage, {
          format,
          codedWidth: frame.codedWidth,
          codedHeight: frame.codedHeight,
          timestamp: frame.timestamp,
          ...(frame.duration === null ? {} : { duration: frame.duration }),
          layout,
          ...(visibleRect === null ? {} : { visibleRect }),
          displayWidth: frame.displayWidth,
          displayHeight: frame.displayHeight,
          ...(colorSpace === undefined ? {} : { colorSpace }),
        });
      };
      const adaptFrame = async (frame, mode) => {
        if (mode === 'native') return frame;
        try {
          return await detachFrame(frame, mode);
        } finally {
          frame.close();
        }
      };
      const assertStatsClosed = (stats, label) => {
        if (stats.nativeFrames !== stats.nativeClosed || stats.nativeLive !== 0) {
          throw new Error(
            `${label}: closed ${stats.nativeClosed}/${stats.nativeFrames}, live=${stats.nativeLive}`,
          );
        }
        if (stats.maxDecodeQueueSize > 8) {
          throw new Error(
            `${label}: decode queue exceeded product bound: ${stats.maxDecodeQueueSize}`,
          );
        }
      };
      const metadataTruth = (frame) => ({
        timestamp: frame.timestamp,
        duration: frame.duration,
        codedWidth: frame.codedWidth,
        codedHeight: frame.codedHeight,
        visibleRect: frameRect(frame.visibleRect),
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
        colorSpace: colorTruth(frame.colorSpace),
      });
      const rgbaDigest = async (frame) => {
        const rgba = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
        await frame.copyTo(rgba, { format: 'RGBA' });
        return digest(rgba);
      };
      const oracleRun = async (input, mode, expectedFrames) => {
        const stats = newStats();
        const reader = publicStream(input, stats).getReader();
        const truth = [];
        let handed = 0;
        let closed = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const frame = await adaptFrame(next.value, mode);
            handed++;
            try {
              truth.push({ ...metadataTruth(frame), rgbaSha256: await rgbaDigest(frame) });
            } finally {
              frame.close();
              closed++;
            }
          }
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
          activeStats = undefined;
        }
        if (handed !== expectedFrames || closed !== handed) {
          throw new Error(`${mode}: handed/closed ${handed}/${closed}, expected ${expectedFrames}`);
        }
        assertStatsClosed(stats, `${mode} oracle`);
        const clocks = truth.map(({ rgbaSha256: _rgbaSha256, ...clock }) => clock);
        const rgbaDigests = truth.map(({ rgbaSha256 }) => rgbaSha256);
        return {
          frames: handed,
          closed,
          truthSha256: await digest(new TextEncoder().encode(JSON.stringify(truth))),
          clockSha256: await digest(new TextEncoder().encode(JSON.stringify(clocks))),
          rgbaSha256: await digest(new TextEncoder().encode(JSON.stringify(rgbaDigests))),
          firstFrame: clocks[0],
          lastFrame: clocks.at(-1),
          maxDecodeQueueSize: stats.maxDecodeQueueSize,
          maxNativeLive: stats.maxNativeLive,
          decoderCloses: stats.decoderCloses,
        };
      };
      const closeOnlyRun = async (input, mode, expectedFrames) => {
        const stats = newStats();
        const started = performance.now();
        const reader = publicStream(input, stats).getReader();
        let handed = 0;
        let closed = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const frame = await adaptFrame(next.value, mode);
            handed++;
            frame.close();
            closed++;
          }
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
          activeStats = undefined;
        }
        const elapsedMs = performance.now() - started;
        if (handed !== expectedFrames || closed !== handed) {
          throw new Error(`${mode}: close-only handed/closed ${handed}/${closed}`);
        }
        assertStatsClosed(stats, `${mode} close-only`);
        return {
          elapsedMs,
          frames: handed,
          closed,
          maxDecodeQueueSize: stats.maxDecodeQueueSize,
          maxNativeLive: stats.maxNativeLive,
        };
      };
      const collectMemory = async () => {
        const jsHeapBytes = performance.memory?.usedJSHeapSize;
        if (typeof jsHeapBytes !== 'number') throw new Error('precise JS heap unavailable');
        let uaBytes;
        let uaReason;
        try {
          if (typeof performance.measureUserAgentSpecificMemory !== 'function') {
            uaReason = 'API unavailable';
          } else {
            uaBytes = (await performance.measureUserAgentSpecificMemory()).bytes;
          }
        } catch (error) {
          uaReason = `${error.name}: ${error.message}`;
        }
        return { jsHeapBytes, ...(uaBytes === undefined ? { uaReason } : { uaBytes }) };
      };
      const forceGc = async () => {
        if (typeof globalThis.gc === 'function') globalThis.gc();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (typeof globalThis.gc === 'function') globalThis.gc();
      };
      const retentionRun = async (input, mode, expectedFrames) => {
        await forceGc();
        const before = await collectMemory();
        const stats = newStats();
        const reader = publicStream(input, stats).getReader();
        const retained = [];
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            retained.push(await adaptFrame(next.value, mode));
          }
          if (retained.length !== expectedFrames) throw new Error(`${mode}: retention frame count`);
          const peak = await collectMemory();
          for (const frame of retained) frame.close();
          retained.length = 0;
          await forceGc();
          const after = await collectMemory();
          assertStatsClosed(stats, `${mode} retention`);
          return { before, peak, after, maxNativeLive: stats.maxNativeLive };
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          throw error;
        } finally {
          for (const frame of retained) frame.close();
          reader.releaseLock();
          activeStats = undefined;
        }
      };
      const cancellationRun = async (input, mode) => {
        const stats = newStats();
        const reader = publicStream(input, stats).getReader();
        const first = await reader.read();
        if (first.done) throw new Error('cancellation source was empty');
        const frame = await adaptFrame(first.value, mode);
        frame.close();
        await new Promise((resolve) => setTimeout(resolve, 50));
        await reader.cancel('bounded cancellation proof');
        reader.releaseLock();
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeStats = undefined;
        assertStatsClosed(stats, `${mode} cancellation`);
        return {
          nativeFrames: stats.nativeFrames,
          nativeClosed: stats.nativeClosed,
          maxNativeLive: stats.maxNativeLive,
          maxDecodeQueueSize: stats.maxDecodeQueueSize,
          decoderCloses: stats.decoderCloses,
        };
      };

      const modes = ['native', 'natural', 'NV12', 'I420'];
      const rows = [];
      for (const benchmarkCase of benchmarkCases) {
        const input = new Uint8Array(
          await (await fetch(`/fixture/${encodeURIComponent(benchmarkCase.id)}`)).arrayBuffer(),
        );
        const oracle = {};
        for (const mode of modes) {
          try {
            oracle[mode] = {
              supported: true,
              result: await oracleRun(input, mode, benchmarkCase.frames),
            };
          } catch (error) {
            oracle[mode] = { supported: false, reason: `${error.name}: ${error.message}` };
          }
        }
        const nativeTruth = oracle.native?.result?.truthSha256;
        if (nativeTruth === undefined) throw new Error(`${benchmarkCase.id}: native oracle failed`);
        for (const mode of modes.slice(1)) {
          const candidate = oracle[mode];
          if (candidate?.supported && candidate.result.truthSha256 !== nativeTruth) {
            throw new Error(`${benchmarkCase.id}: ${mode} changed full RGBA/metadata truth`);
          }
        }
        const supportedModes = modes.filter((mode) => oracle[mode]?.supported === true);
        const timings = {};
        for (let index = 0; index < warmups; index++) {
          for (const mode of supportedModes) await closeOnlyRun(input, mode, benchmarkCase.frames);
        }
        for (const mode of supportedModes) timings[mode] = [];
        for (let index = 0; index < samples; index++) {
          const order = index % 2 === 0 ? supportedModes : [...supportedModes].reverse();
          for (const mode of order) {
            timings[mode].push((await closeOnlyRun(input, mode, benchmarkCase.frames)).elapsedMs);
          }
        }
        const timingSummary = Object.fromEntries(
          supportedModes.map((mode) => [
            mode,
            {
              samplesMs: timings[mode],
              medianMs: median(timings[mode]),
              madMs: mad(timings[mode]),
            },
          ]),
        );
        const retention = {};
        const cancellation = {};
        for (const mode of supportedModes) {
          retention[mode] = await retentionRun(input, mode, benchmarkCase.frames);
          cancellation[mode] = await cancellationRun(input, mode);
        }
        rows.push({
          id: benchmarkCase.id,
          oracle,
          timings: timingSummary,
          retention,
          cancellation,
        });
      }
      globalThis.VideoDecoder = NativeDecoder;
      VideoFrame.prototype.close = nativeClose;
      return { warmups, samples, rows };
    },
    { benchmarkCases: cases, warmups: WARMUPS, samples: SAMPLES },
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
