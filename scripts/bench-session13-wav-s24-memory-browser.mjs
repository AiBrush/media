#!/usr/bin/env node
/** Chromium product and range-window memory profile for Session 13 WAV decode. */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUP = 3;
const SAMPLES = 7;
const root = process.cwd();
const cases = [
  {
    id: 's24-small',
    path: '../media-test/fixtures/media/scenarios/audio-dsp/throughput_decode_s24/02.wav',
  },
  {
    id: 's24-medium',
    path: '../media-test/fixtures/media/scenarios/audio-dsp/throughput_decode_s24/wav_s24.wav',
  },
  {
    id: 's24-large',
    path: '../media-test/fixtures/media/scenarios/audio-dsp/throughput_decode_s24/03.wav',
  },
  { id: 's16-mono', path: '../media-test/fixtures/media/wav_s16_mono.wav' },
  { id: 's16-5.1', path: '../media-test/fixtures/media/wav_5_1.wav' },
];
const fixtureById = new Map();
for (const benchmarkCase of cases) {
  fixtureById.set(benchmarkCase.id, await readFile(resolve(root, benchmarkCase.path)));
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
    response.end('<!doctype html><meta charset="utf-8"><title>WAV memory benchmark</title>');
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
    'content-type': 'audio/wav',
    'cross-origin-resource-policy': 'same-origin',
  });
  response.end(fixture);
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
    async ({ benchmarkCases, warmup, samples }) => {
      const { createMedia } = await import(`/dist/index.js?run=${Date.now()}`);
      const media = createMedia({ worker: false });
      const memory = performance.memory;
      if (memory === undefined) throw new Error('precise JS heap memory is unavailable');
      const collect = async () => {
        if (typeof globalThis.gc === 'function') globalThis.gc();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (typeof globalThis.gc === 'function') globalThis.gc();
        return memory.usedJSHeapSize;
      };
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
      const mix = (hash, value) => Math.imul(hash ^ (value | 0), 16_777_619) >>> 0;
      const copyAndFoldFrame = (frame, state, retainedCopies) => {
        const sampleBytes = frame.allocationSize({ format: 'f32', planeIndex: 0 });
        const samples = new Float32Array(sampleBytes / 4);
        frame.copyTo(samples, { format: 'f32', planeIndex: 0 });
        const bits = new Uint32Array(samples.buffer);
        retainedCopies.push(samples);
        let hash = mix(mix(state.hash, state.frames), frame.numberOfFrames);
        const channels = frame.numberOfChannels;
        for (let local = 0; local < frame.numberOfFrames; local++) {
          const absolute = state.frames + local;
          if (absolute % 997 !== 0 && local !== frame.numberOfFrames - 1) continue;
          for (let channel = 0; channel < channels; channel++) {
            hash = mix(hash, bits[local * channels + channel] ?? 0);
          }
        }
        state.hash = hash;
        state.frames += frame.numberOfFrames;
        state.chunks++;
      };
      const sourceFor = (blob, ranged, calls) => ({
        __media: 'source',
        kind: 'blob',
        size: blob.size,
        mimeHint: 'audio/wav',
        stream: () => blob.stream(),
        ...(ranged
          ? {
              async range(start, end) {
                const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
                calls.push([start, end, bytes.byteLength]);
                return bytes;
              },
            }
          : {}),
      });
      const productRun = async (blob, ranged) => {
        const calls = [];
        const before = await collect();
        let peak = before;
        const state = { frames: 0, chunks: 0, hash: 2_166_136_261 };
        const retainedCopies = [];
        const started = performance.now();
        const stream = media.decode(sourceFor(blob, ranged, calls)).audio;
        if (stream === undefined) throw new Error('WAV decode returned no audio stream');
        const reader = stream.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            peak = Math.max(peak, memory.usedJSHeapSize);
            if (next.done) break;
            try {
              if (next.value.numberOfFrames > 4096) throw new Error('public cadence exceeded 4096');
              copyAndFoldFrame(next.value, state, retainedCopies);
            } finally {
              next.value.close();
            }
            peak = Math.max(peak, memory.usedJSHeapSize);
          }
        } finally {
          reader.releaseLock();
        }
        const elapsedMs = performance.now() - started;
        retainedCopies.length = 0;
        const after = await collect();
        return {
          elapsedMs,
          peakBytes: Math.max(0, peak - before),
          retainedBytes: Math.max(0, after - before),
          ...state,
          calls,
        };
      };

      const parseWav = (bytes) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let position = 12;
        let format;
        while (position + 8 <= bytes.byteLength) {
          const id = String.fromCharCode(
            bytes[position] ?? 0,
            bytes[position + 1] ?? 0,
            bytes[position + 2] ?? 0,
            bytes[position + 3] ?? 0,
          );
          const size = view.getUint32(position + 4, true);
          const body = position + 8;
          if (id === 'fmt ' && size >= 16) {
            let tag = view.getUint16(body, true);
            if (tag === 0xfffe && size >= 40) tag = view.getUint16(body + 24, true);
            format = {
              tag,
              channels: view.getUint16(body + 2, true),
              sampleRate: view.getUint32(body + 4, true),
              blockAlign: view.getUint16(body + 12, true),
              bits: view.getUint16(body + 14, true),
            };
          } else if (id === 'data' && format !== undefined) {
            return { ...format, dataOffset: body, dataBytes: Math.min(size, bytes.length - body) };
          }
          position = body + size + (size & 1);
        }
        throw new Error('profile fixture has no complete PCM data chunk');
      };
      const decodeWire = (wire, info, frames) => {
        const out = new Float32Array(frames * info.channels);
        const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
        if (info.tag === 1 && info.bits === 24) {
          for (let sample = 0, offset = 0; sample < out.length; sample++, offset += 3) {
            const raw =
              (wire[offset] ?? 0) |
              ((wire[offset + 1] ?? 0) << 8) |
              ((wire[offset + 2] ?? 0) << 16);
            out[sample] = ((raw << 8) >> 8) / 8_388_608;
          }
        } else if (info.tag === 1 && info.bits === 16) {
          for (let sample = 0; sample < out.length; sample++) {
            out[sample] = view.getInt16(sample * 2, true) / 32768;
          }
        } else {
          throw new Error(`unsupported profile PCM ${info.tag}/${info.bits}`);
        }
        return out;
      };
      const windowRun = async (blob, sourceBytes, windowBytes) => {
        const info = parseWav(sourceBytes);
        const totalFrames = Math.floor(info.dataBytes / info.blockAlign);
        const before = await collect();
        let peak = before;
        let window = new Uint8Array(0);
        let windowStart = 0;
        let frame = 0;
        let calls = 0;
        const state = { frames: 0, chunks: 0, hash: 2_166_136_261 };
        const retainedCopies = [];
        const started = performance.now();
        while (frame < totalFrames) {
          const frames = Math.min(4096, totalFrames - frame);
          const start = info.dataOffset + frame * info.blockAlign;
          const end = start + frames * info.blockAlign;
          if (start < windowStart || end > windowStart + window.byteLength) {
            windowStart = start;
            window = new Uint8Array(
              await blob
                .slice(start, Math.min(info.dataOffset + info.dataBytes, start + windowBytes))
                .arrayBuffer(),
            );
            calls++;
          }
          const wire = window.subarray(start - windowStart, end - windowStart);
          const samples = decodeWire(wire, info, frames);
          const audio = new AudioData({
            format: 'f32',
            sampleRate: info.sampleRate,
            numberOfChannels: info.channels,
            numberOfFrames: frames,
            timestamp: Math.round((frame / info.sampleRate) * 1_000_000),
            data: samples.buffer,
            transfer: [samples.buffer],
          });
          try {
            copyAndFoldFrame(audio, state, retainedCopies);
          } finally {
            audio.close();
          }
          frame += frames;
          peak = Math.max(peak, memory.usedJSHeapSize);
        }
        const elapsedMs = performance.now() - started;
        retainedCopies.length = 0;
        const after = await collect();
        return {
          windowBytes,
          elapsedMs,
          peakBytes: Math.max(0, peak - before),
          retainedBytes: Math.max(0, after - before),
          calls,
          ...state,
        };
      };

      const rows = [];
      for (const benchmarkCase of benchmarkCases) {
        const sourceBytes = new Uint8Array(
          await (await fetch(`/fixture/${encodeURIComponent(benchmarkCase.id)}`)).arrayBuffer(),
        );
        const blob = new Blob([sourceBytes], { type: 'audio/wav' });
        for (let iteration = 0; iteration < warmup; iteration++) {
          await productRun(blob, true);
          await productRun(blob, false);
          for (const budget of [64, 128, 256, 1024])
            await windowRun(blob, sourceBytes, budget * 1024);
        }
        const productRange = [];
        const productSequential = [];
        const windows = new Map([64, 128, 256, 1024].map((budget) => [budget, []]));
        for (let iteration = 0; iteration < samples; iteration++) {
          const routes = iteration % 2 === 0 ? [true, false] : [false, true];
          for (const ranged of routes) {
            (ranged ? productRange : productSequential).push(await productRun(blob, ranged));
          }
          const budgets = iteration % 2 === 0 ? [64, 128, 256, 1024] : [1024, 256, 128, 64];
          for (const budget of budgets) {
            windows.get(budget).push(await windowRun(blob, sourceBytes, budget * 1024));
          }
        }
        const truth = productRange[0];
        if (truth === undefined) throw new Error('missing product truth');
        for (const sample of [
          ...productRange,
          ...productSequential,
          ...[...windows.values()].flat(),
        ]) {
          if (
            sample.frames !== truth.frames ||
            sample.chunks !== truth.chunks ||
            sample.hash !== truth.hash
          ) {
            throw new Error(`${benchmarkCase.id}: route changed exact sample/cadence truth`);
          }
        }
        const summarize = (values) => ({
          medianMs: median(values.map((value) => value.elapsedMs)),
          madMs: mad(values.map((value) => value.elapsedMs)),
          medianPeakBytes: median(values.map((value) => value.peakBytes)),
          maximumRetainedBytes: Math.max(...values.map((value) => value.retainedBytes)),
          medianCalls: median(values.map((value) => value.calls?.length ?? value.calls ?? 0)),
          wallSamples: values.map((value) => value.elapsedMs),
          peakSamples: values.map((value) => value.peakBytes),
        });
        rows.push({
          id: benchmarkCase.id,
          fixtureBytes: sourceBytes.byteLength,
          frames: truth.frames,
          chunks: truth.chunks,
          checksum: truth.hash,
          productBlobRange: summarize(productRange),
          productBlobSequential: summarize(productSequential),
          rangeWindows: Object.fromEntries(
            [...windows].map(([budget, values]) => [String(budget), summarize(values)]),
          ),
        });
      }
      return {
        userAgent: navigator.userAgent,
        crossOriginIsolated,
        warmup,
        samples,
        rows,
      };
    },
    { benchmarkCases: cases.map(({ id }) => ({ id })), warmup: WARMUP, samples: SAMPLES },
  );
  console.info(
    JSON.stringify({ benchmark: 'session13-wav-s24-memory-browser', ...report }, null, 2),
  );
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
