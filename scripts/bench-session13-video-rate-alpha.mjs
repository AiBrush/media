#!/usr/bin/env node
/** Session 13 browser benchmark for implicit AV1 rate control and VP9 alpha packet preservation. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUPS = 1;
const SAMPLES = 5;
const root = process.cwd();
const fixtureDirectory = resolve(root, 'fixtures/media');
const fixtureNames = ['bear-1280x720.mp4', 'obs-remux-variable-aac.mp4', 'bear-vp9-alpha.webm'];

const manifest = JSON.parse(await readFile(resolve(root, 'fixtures/manifest.json'), 'utf8'));
const manifestById = new Map(manifest.files.map((entry) => [entry.id, entry]));
const fixtureBytes = new Map();
for (const name of fixtureNames) {
  const entry = manifestById.get(name);
  if (entry === undefined) throw new Error(`${name}: absent from fixture manifest`);
  const bytes = await readFile(resolve(fixtureDirectory, name));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256 || bytes.byteLength !== entry.bytes) {
    throw new Error(`${name}: fixture integrity mismatch`);
  }
  fixtureBytes.set(name, bytes);
}

const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.wasm', 'application/wasm'],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>video rate benchmark</title>');
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
  const prefix = '/fixture/';
  const name = url.pathname.startsWith(prefix)
    ? decodeURIComponent(url.pathname.slice(prefix.length))
    : undefined;
  const bytes = name === undefined ? undefined : fixtureBytes.get(name);
  if (bytes === undefined || name === undefined) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-length': String(bytes.byteLength),
    'content-type': contentTypes.get(extname(name)) ?? 'application/octet-stream',
  });
  response.end(bytes);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string')
  throw new Error('benchmark server did not bind');

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ warmups, samples }) => {
      const { createMedia } = await import(`/dist/index.js?run=${Date.now()}`);
      const media = createMedia({ worker: false });

      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('empty benchmark sample');
        return value;
      };

      const digestParts = async (parts, byteLength) => {
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      };

      const packetTruth = async (bytes) => {
        const demuxed = await media.demux(bytes);
        const track = demuxed.tracks.find((candidate) => candidate.mediaType === 'video');
        if (track === undefined) throw new Error('benchmark output has no video track');
        const reader = demuxed.packets(track.id).getReader();
        const colors = [];
        const alphas = [];
        const timestamps = [];
        let colorBytes = 0;
        let alphaBytes = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const color = new Uint8Array(next.value.chunk.byteLength);
            next.value.chunk.copyTo(color);
            colors.push(color);
            colorBytes += color.byteLength;
            timestamps.push(next.value.chunk.timestamp);
            if (next.value.alpha !== undefined) {
              const alpha = new Uint8Array(next.value.alpha.byteLength);
              next.value.alpha.copyTo(alpha);
              alphas.push(alpha);
              alphaBytes += alpha.byteLength;
            }
          }
        } finally {
          reader.releaseLock();
          await demuxed.close();
        }
        return {
          codec: track.config?.codec ?? track.codec,
          packetCount: colors.length,
          alphaPacketCount: alphas.length,
          colorBytes,
          alphaBytes,
          timestamps,
          colorSha256: await digestParts(colors, colorBytes),
          alphaSha256: await digestParts(alphas, alphaBytes),
        };
      };

      const cases = [
        {
          id: 'av1-ordinary-30fps',
          fixture: 'bear-1280x720.mp4',
          options: { to: 'mp4', audio: false, video: { codec: 'av1' } },
        },
        {
          id: 'av1-high-cadence-vfr',
          fixture: 'obs-remux-variable-aac.mp4',
          options: { to: 'mp4', audio: false, video: { codec: 'av1' } },
        },
        {
          id: 'vp9-alpha-same-codec',
          fixture: 'bear-vp9-alpha.webm',
          options: { to: 'webm', audio: false, video: { codec: 'vp9', alpha: 'keep' } },
          exactAlpha: true,
        },
      ];

      const rows = [];
      for (const benchmarkCase of cases) {
        const input = new Uint8Array(
          await (
            await fetch(`/fixture/${encodeURIComponent(benchmarkCase.fixture)}`)
          ).arrayBuffer(),
        );
        const wallMs = [];
        const retainedHeapBytes = [];
        const outputBytes = [];
        let lastOutput;
        for (let index = 0; index < warmups + samples; index++) {
          const started = performance.now();
          const output = await media.convert(input, benchmarkCase.options);
          if (!(output instanceof Blob))
            throw new Error(`${benchmarkCase.id}: expected Blob output`);
          const elapsed = performance.now() - started;
          if (index >= warmups) {
            wallMs.push(elapsed);
            outputBytes.push(output.size);
            const heap = performance.memory?.usedJSHeapSize;
            if (Number.isFinite(heap) && heap > 0) retainedHeapBytes.push(heap);
          }
          lastOutput = new Uint8Array(await output.arrayBuffer());
        }
        if (lastOutput === undefined) throw new Error(`${benchmarkCase.id}: no output`);
        const inputTruth = benchmarkCase.exactAlpha === true ? await packetTruth(input) : undefined;
        const outputTruth = await packetTruth(lastOutput);
        if (inputTruth !== undefined) {
          if (
            inputTruth.alphaPacketCount !== outputTruth.alphaPacketCount ||
            inputTruth.alphaBytes !== outputTruth.alphaBytes ||
            inputTruth.alphaSha256 !== outputTruth.alphaSha256 ||
            inputTruth.timestamps.join(',') !== outputTruth.timestamps.join(',') ||
            inputTruth.colorSha256 === outputTruth.colorSha256
          ) {
            throw new Error(`${benchmarkCase.id}: alpha truth or color re-encode invariant failed`);
          }
        }
        rows.push({
          id: benchmarkCase.id,
          fixture: benchmarkCase.fixture,
          warmups,
          samples,
          medianWallMs: median(wallMs),
          wallMs,
          medianRetainedHeapBytes:
            retainedHeapBytes.length === 0 ? null : median(retainedHeapBytes),
          outputBytes,
          ...(inputTruth === undefined ? {} : { inputTruth }),
          outputTruth,
        });
      }
      return { userAgent: navigator.userAgent, rows };
    },
    { warmups: WARMUPS, samples: SAMPLES },
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
