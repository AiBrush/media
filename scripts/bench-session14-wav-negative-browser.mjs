#!/usr/bin/env node
/**
 * Browser profile for product-owned empty/corrupt WAV and truncated-header paths.
 *
 * The immutable suite wraps these operations in scenario/oracle work, and its empty-audio adapter
 * rejects before calling the product. This diagnostic times only public @aibrush/media calls while
 * retaining exact fixture integrity, typed-error evidence, output digests, and AudioData close counts.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUPS = 3;
const SAMPLES = 11;
const root = process.cwd();
const fixtureRoot = resolve(root, '../media-test/fixtures/media/scenarios/audio-dsp');
const cases = [
  {
    id: 'empty-wav-convert',
    path: 'edge_empty_audio_transcode/empty_audio.wav',
    bytes: 44,
    sha256: '4872b61c768dff943f9e021453d816f06e35adc8edd88ef183301f03e31b94a5',
    mime: 'audio/wav',
    operation: 'convert-empty',
  },
  {
    id: 'wav-header-truncated-probe',
    path: 'fuzz_wav_header_truncated_probe/wav_header_truncated.wav',
    bytes: 20,
    sha256: 'd9d96e1ba93a660ecd842c321ec6f925e679404754e70b0d332a0ff6968088ea',
    mime: 'audio/wav',
    operation: 'probe-wav',
  },
  {
    id: 'wav-fmt-corrupt-convert',
    path: 'fuzz_wav_fmt_corrupt_transcode/wav_fmt_corrupt.wav',
    bytes: 960_044,
    sha256: 'f1ca300a54ca777ab5289b59135b0fd3447a33bb4bd92ebe8dce69a6e49592d0',
    mime: 'audio/wav',
    operation: 'convert-corrupt',
  },
  {
    id: 'wav-bitflip-decode',
    path: 'fuzz_wav_bitflip_decode/wav_bitflip.wav',
    bytes: 960_044,
    sha256: '677570ddb7298cc8044dc7a885d7b7e541dff2d643836bdd7db5325239f2cb7a',
    mime: 'audio/wav',
    maxFrames: 256,
    operation: 'decode-audio',
  },
  {
    id: 'aiff-header-truncated-probe',
    path: 'fuzz_aiff_header_truncated_probe/aiff_header_truncated.aiff',
    bytes: 24,
    sha256: '19fffc6f79c75049eb6dbad04770f2214297baac81c80888059dcfadf6a9db50',
    mime: 'audio/aiff',
    operation: 'probe-aiff',
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
    response.end('<!doctype html><meta charset="utf-8"><title>WAV negative-path profile</title>');
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
      const hexDigest = async (bytes) => {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      };
      const errorEvidence = (error) => ({
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : null,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : typeof error,
      });
      const outputBytes = async (output) => {
        if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
        if (output instanceof Uint8Array) return output;
        if (output instanceof ArrayBuffer) return new Uint8Array(output);
        throw new Error(`unexpected convert output ${Object.prototype.toString.call(output)}`);
      };
      const drainAudio = async (streams, maxFrames = Number.POSITIVE_INFINITY) => {
        const audio = streams.audio;
        if (audio === undefined) throw new Error('decode returned no audio stream');
        const reader = audio.getReader();
        let blocks = 0;
        let closed = 0;
        let frames = 0;
        let durationUs = 0;
        let timestampFold = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const frame = next.value;
            try {
              blocks++;
              frames += frame.numberOfFrames;
              durationUs += frame.duration ?? 0;
              timestampFold = (timestampFold + frame.timestamp) % 1_000_000_007;
            } finally {
              frame.close();
              closed++;
            }
            if (frames >= maxFrames) {
              await reader.cancel(new Error('audio sample cap reached')).catch(() => {});
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (closed !== blocks) throw new Error(`closed ${closed}/${blocks} AudioData blocks`);
        return { blocks, closed, durationUs, frames, timestampFold };
      };
      const invoke = async (media, benchmarkCase, truth = false) => {
        const input = inputs.get(benchmarkCase.id);
        if (input === undefined) throw new Error(`${benchmarkCase.id}: missing browser fixture`);
        const source = media.from(input, { mime: benchmarkCase.mime });
        try {
          switch (benchmarkCase.operation) {
            case 'probe-wav':
            case 'probe-aiff': {
              const container = benchmarkCase.operation === 'probe-wav' ? 'wav' : 'aiff';
              const info = await media.probeContainer(source, container);
              return {
                ok: true,
                tracks: info.tracks.map((track) => ({
                  channels: track.config?.numberOfChannels ?? null,
                  codec: track.codec,
                  durationSec: track.durationSec,
                  sampleRate: track.config?.sampleRate ?? null,
                })),
              };
            }
            case 'convert-empty': {
              const bytes = await outputBytes(
                await media.convert(source, {
                  to: 'wav',
                  audio: { codec: 'pcm-s16', sampleRate: 44_100 },
                }),
              );
              return {
                bytes: bytes.byteLength,
                ok: true,
                riff: new TextDecoder().decode(bytes.subarray(0, 4)),
                ...(truth ? { sha256: await hexDigest(bytes) } : {}),
              };
            }
            case 'convert-corrupt': {
              const bytes = await outputBytes(
                await media.convert(source, {
                  to: 'wav',
                  audio: { channels: 1, codec: 'pcm-s16' },
                }),
              );
              return {
                bytes: bytes.byteLength,
                ok: true,
                riff: new TextDecoder().decode(bytes.subarray(0, 4)),
                ...(truth ? { sha256: await hexDigest(bytes) } : {}),
              };
            }
            case 'decode-audio':
              return {
                ok: true,
                ...(await drainAudio(media.decode(source), benchmarkCase.maxFrames)),
              };
            default:
              throw new Error(`unknown operation ${benchmarkCase.operation}`);
          }
        } catch (error) {
          return { error: errorEvidence(error), ok: false };
        }
      };
      const timed = async (media, benchmarkCase) => {
        globalThis.gc?.();
        const heapBefore = performance.memory?.usedJSHeapSize ?? null;
        const started = performance.now();
        const result = await invoke(media, benchmarkCase);
        const elapsed = performance.now() - started;
        const heapAfter = performance.memory?.usedJSHeapSize ?? null;
        return { elapsed, heapAfter, heapBefore, result };
      };
      const summarize = (values) => {
        const elapsed = values.map((value) => value.elapsed);
        const heapDeltas = values
          .filter((value) => Number.isFinite(value.heapBefore) && Number.isFinite(value.heapAfter))
          .map((value) => value.heapAfter - value.heapBefore);
        return {
          heapDeltaMedianBytes: heapDeltas.length === 0 ? null : median(heapDeltas),
          madMs: mad(elapsed),
          maxMs: Math.max(...elapsed),
          medianMs: median(elapsed),
          minMs: Math.min(...elapsed),
          outcomes: values.map((value) => value.result),
          p75Ms: percentile(elapsed, 0.75),
          p95Ms: percentile(elapsed, 0.95),
          samplesMs: elapsed,
        };
      };

      const firstEngine = createMedia({ worker: false });
      const firstInvocation = {};
      try {
        for (const benchmarkCase of benchmarkCases) {
          firstInvocation[benchmarkCase.id] = await timed(firstEngine, benchmarkCase);
        }
      } finally {
        await firstEngine.dispose();
      }

      const warmEngine = createMedia({ worker: false });
      const warmValues = Object.fromEntries(benchmarkCases.map(({ id }) => [id, []]));
      try {
        for (let iteration = 0; iteration < warmups; iteration++) {
          for (const benchmarkCase of benchmarkCases) await invoke(warmEngine, benchmarkCase);
        }
        for (let iteration = 0; iteration < samples; iteration++) {
          const ordered = iteration % 2 === 0 ? benchmarkCases : [...benchmarkCases].reverse();
          for (const benchmarkCase of ordered) {
            warmValues[benchmarkCase.id].push(await timed(warmEngine, benchmarkCase));
          }
        }
      } finally {
        await warmEngine.dispose();
      }

      const freshValues = Object.fromEntries(benchmarkCases.map(({ id }) => [id, []]));
      for (let iteration = 0; iteration < samples; iteration++) {
        const ordered = iteration % 2 === 0 ? benchmarkCases : [...benchmarkCases].reverse();
        for (const benchmarkCase of ordered) {
          const media = createMedia({ worker: false });
          try {
            freshValues[benchmarkCase.id].push(await timed(media, benchmarkCase));
          } finally {
            await media.dispose();
          }
        }
      }

      const truthEngine = createMedia({ worker: false });
      const truth = {};
      try {
        for (const benchmarkCase of benchmarkCases) {
          truth[benchmarkCase.id] = await invoke(truthEngine, benchmarkCase, true);
        }
      } finally {
        await truthEngine.dispose();
      }

      return {
        crossOriginIsolated,
        firstInvocation,
        freshEngine: Object.fromEntries(
          Object.entries(freshValues).map(([id, values]) => [id, summarize(values)]),
        ),
        truth,
        userAgent: navigator.userAgent,
        warmEngine: Object.fromEntries(
          Object.entries(warmValues).map(([id, values]) => [id, summarize(values)]),
        ),
      };
    },
    { benchmarkCases: cases, samples: SAMPLES, warmups: WARMUPS },
  );
  console.info(
    JSON.stringify(
      {
        benchmark: 'session14-wav-negative-browser',
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
  server.close();
}
