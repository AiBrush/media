#!/usr/bin/env node
/**
 * Browser profile for the product-owned VP9-alpha decode path.
 *
 * The timed modes separate dual-plane decode/merge from the RGBA readback performed by frame
 * validators. Cryptographic pixel truth is collected once, outside the timing loop.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUPS = 3;
const SAMPLES = 11;
const MAX_FRAMES = 12;
const root = process.cwd();
const fixturePath = resolve(
  root,
  '../media-test/fixtures/media/scenarios/decode-seek/decode_vp9_alpha/vp9_alpha.webm',
);
const expectedBytes = 748_970;
const expectedSha256 = '3f130b8eadd0dc36b3992124e37a879938a89730487e48a9e8a5c41202d5c4c3';
const fixture = await readFile(fixturePath);
const fixtureSha256 = createHash('sha256').update(fixture).digest('hex');
if (fixture.byteLength !== expectedBytes || fixtureSha256 !== expectedSha256) {
  throw new Error('VP9-alpha fixture integrity mismatch');
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
    response.end('<!doctype html><meta charset="utf-8"><title>VP9 alpha decode profile</title>');
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
  if (url.pathname === '/fixture.webm') {
    response.writeHead(200, {
      ...headers,
      'content-length': String(fixture.byteLength),
      'content-type': 'video/webm',
    });
    response.end(fixture);
    return;
  }
  response.writeHead(404, headers).end('not found');
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
    async ({ maxFrames, samples, warmups }) => {
      const { createMedia } = await import(`/dist/index.js?run=${Date.now()}`);
      const input = new Uint8Array(await (await fetch('/fixture.webm')).arrayBuffer());
      const media = createMedia({ worker: false });
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
      const percentile = (values, fraction) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
        if (value === undefined) throw new Error('cannot take percentile of empty samples');
        return value;
      };

      const drain = async (rgbaReadback) => {
        const video = media.decode(input).video;
        if (video === undefined) throw new Error('VP9-alpha decode returned no video stream');
        const reader = video.getReader();
        const formats = [];
        let frames = 0;
        let closed = 0;
        let rgbaFold = 0;
        try {
          while (frames < maxFrames) {
            const next = await reader.read();
            if (next.done) break;
            const frame = next.value;
            try {
              formats.push(frame.format);
              if (rgbaReadback) {
                const rgba = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
                await frame.copyTo(rgba, { format: 'RGBA' });
                rgbaFold =
                  (rgbaFold + (rgba[0] ?? 0) + (rgba[3] ?? 0) + (rgba[rgba.length - 1] ?? 0)) >>> 0;
              }
              frames++;
            } finally {
              frame.close();
              closed++;
            }
          }
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
        if (frames !== maxFrames || closed !== frames) {
          throw new Error(`VP9-alpha profile delivered/closed ${frames}/${closed} frames`);
        }
        return { closed, formats, frames, rgbaFold };
      };

      const digestTruth = async () => {
        const video = media.decode(input).video;
        if (video === undefined) throw new Error('VP9-alpha truth decode returned no video stream');
        const reader = video.getReader();
        const digests = [];
        const clocks = [];
        const alphaExtrema = [];
        try {
          while (digests.length < maxFrames) {
            const next = await reader.read();
            if (next.done) break;
            const frame = next.value;
            try {
              const rgba = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
              await frame.copyTo(rgba, { format: 'RGBA' });
              const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rgba));
              digests.push(
                Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
              );
              let minimum = 255;
              let maximum = 0;
              for (let offset = 3; offset < rgba.length; offset += 4) {
                const alpha = rgba[offset];
                if (alpha < minimum) minimum = alpha;
                if (alpha > maximum) maximum = alpha;
              }
              alphaExtrema.push([minimum, maximum]);
              clocks.push({ duration: frame.duration, timestamp: frame.timestamp });
            } finally {
              frame.close();
            }
          }
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
        return { alphaExtrema, clocks, digests };
      };

      const inspectNativePlanes = async () => {
        const demuxed = await media.demux(input);
        try {
          const track = demuxed.tracks.find(
            (candidate) => candidate.mediaType === 'video' && candidate.alpha === true,
          );
          if (track?.config === undefined) throw new Error('VP9-alpha track has no decoder config');
          const reader = demuxed.packets(track.id).getReader();
          let packet;
          try {
            const next = await reader.read();
            if (next.done || next.value.alpha === undefined) {
              throw new Error('VP9-alpha track has no first alpha packet');
            }
            packet = next.value;
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
          const decodeOne = async (chunk) => {
            let resolveFrame;
            let rejectFrame;
            const output = new Promise((resolve, reject) => {
              resolveFrame = resolve;
              rejectFrame = reject;
            });
            const decoder = new VideoDecoder({
              error: rejectFrame,
              output: resolveFrame,
            });
            try {
              decoder.configure(track.config);
              decoder.decode(chunk);
              await decoder.flush();
              const frame = await output;
              try {
                const native = new Uint8Array(frame.allocationSize());
                const layout = await frame.copyTo(native);
                return {
                  allocationBytes: native.byteLength,
                  codedHeight: frame.codedHeight,
                  codedWidth: frame.codedWidth,
                  format: frame.format,
                  layout,
                };
              } finally {
                frame.close();
              }
            } finally {
              decoder.close();
            }
          };
          return {
            alpha: await decodeOne(packet.alpha),
            color: await decodeOne(packet.chunk),
          };
        } finally {
          await demuxed.close();
        }
      };

      const modes = {
        decodeAndMerge: () => drain(false),
        decodeMergeAndRgba: () => drain(true),
      };
      for (let iteration = 0; iteration < warmups; iteration++) {
        for (const run of Object.values(modes)) await run();
      }
      const timings = Object.fromEntries(Object.keys(modes).map((name) => [name, []]));
      let lastTruth;
      for (let iteration = 0; iteration < samples; iteration++) {
        const order =
          iteration % 2 === 0
            ? ['decodeAndMerge', 'decodeMergeAndRgba']
            : ['decodeMergeAndRgba', 'decodeAndMerge'];
        for (const name of order) {
          globalThis.gc?.();
          const heapBefore = performance.memory?.usedJSHeapSize ?? null;
          const started = performance.now();
          const truth = await modes[name]();
          const elapsed = performance.now() - started;
          const heapAfter = performance.memory?.usedJSHeapSize ?? null;
          timings[name].push({ elapsed, heapAfter, heapBefore });
          lastTruth = truth;
        }
      }
      const summarized = Object.fromEntries(
        Object.entries(timings).map(([name, values]) => {
          const elapsed = values.map((value) => value.elapsed);
          const heapDeltas = values
            .filter(
              (value) => Number.isFinite(value.heapBefore) && Number.isFinite(value.heapAfter),
            )
            .map((value) => value.heapAfter - value.heapBefore);
          return [
            name,
            {
              heapDeltaMedianBytes: heapDeltas.length === 0 ? null : median(heapDeltas),
              madMs: mad(elapsed),
              maxMs: Math.max(...elapsed),
              medianMs: median(elapsed),
              minMs: Math.min(...elapsed),
              p75Ms: percentile(elapsed, 0.75),
              p95Ms: percentile(elapsed, 0.95),
              samplesMs: elapsed,
            },
          ];
        }),
      );
      const pixelTruth = await digestTruth();
      const nativePlanes = await inspectNativePlanes();
      await media.dispose();
      return {
        crossOriginIsolated,
        lastTruth,
        nativePlanes,
        pixelTruth,
        timings: summarized,
        userAgent: navigator.userAgent,
      };
    },
    { maxFrames: MAX_FRAMES, samples: SAMPLES, warmups: WARMUPS },
  );
  console.info(
    JSON.stringify(
      {
        benchmark: 'session14-vp9-alpha-decode-browser',
        fixtureBytes: expectedBytes,
        fixtureSha256: expectedSha256,
        maxFrames: MAX_FRAMES,
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
  server.close();
}
