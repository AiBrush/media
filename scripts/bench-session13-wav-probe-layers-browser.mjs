#!/usr/bin/env node
/** Fresh non-headless Chromium profile: raw transport → WAV driver → public engine probe. */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUP = 7;
const SAMPLES = 31;
const RANGE_BYTES = 16 * 1024;
const FIXTURE_URL = 'http://localhost:5173/fixtures/media/wav_s16.wav';
const root = process.cwd();
const fixture = await readFile(resolve(root, '../media-test/fixtures/media/wav_s16.wav'));

function contentType(path) {
  if (extname(path) === '.js') return 'text/javascript; charset=utf-8';
  if (extname(path) === '.wasm') return 'application/wasm';
  return 'application/octet-stream';
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>WAV probe layers</title>');
    return;
  }
  if (url.pathname.startsWith('/dist/')) {
    try {
      const bytes = await readFile(resolve(root, `.${url.pathname}`));
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': String(bytes.byteLength),
        'content-type': contentType(url.pathname),
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404).end(String(error));
    }
    return;
  }
  if (url.pathname !== '/fixture.wav') {
    response.writeHead(404).end('not found');
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  if (match === null) {
    response.writeHead(200, {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-length': String(fixture.byteLength),
      'content-type': 'audio/wav',
    });
    response.end(fixture);
    return;
  }
  const start = Number(match[1]);
  const end = Math.min(fixture.byteLength - 1, Number(match[2]));
  const bytes = fixture.subarray(start, end + 1);
  response.writeHead(206, {
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-length': String(bytes.byteLength),
    'content-range': `bytes ${start}-${end}/${fixture.byteLength}`,
    'content-type': 'audio/wav',
  });
  response.end(bytes);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('profile server did not bind');

const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ fixtureBytes, fixtureUrl, rangeBytes, samples, warmup }) => {
      const [{ createMedia, fromURL }, { WavDriver }] = await Promise.all([
        import(`/dist/index.js?run=${Date.now()}`),
        import(`/dist/drivers/wav.js?run=${Date.now()}`),
      ]);
      const media = createMedia({ worker: false });
      const defaultMedia = createMedia();
      const probe = WavDriver.probe;
      if (probe === undefined) throw new Error('WAV driver has no probe');
      const modes = [
        'raw-range',
        'driver-url',
        'engine-url',
        'engine-auto',
        'engine-auto-signal',
        'engine-default',
        'adapter-copy',
        'engine-timeout',
        'engine-double-timeout',
        'driver-memory',
      ];
      const timings = Object.fromEntries(modes.map((mode) => [mode, []]));
      let sequence = 0;
      const fetchRange = async (url, start, end) => {
        const response = await fetch(url, {
          cache: 'no-store',
          headers: { Range: `bytes=${start}-${end - 1}` },
        });
        if (!response.ok) throw new Error(`range failed: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      };
      const memoryPrefix = await fetchRange(`${fixtureUrl}?prefix=${sequence++}`, 0, rangeBytes);
      const truth = (track) => {
        const sampleRate = track?.config?.sampleRate ?? track?.sampleRate;
        const channels = track?.config?.numberOfChannels ?? track?.channels;
        if (
          track?.codec !== 'pcm-s16' ||
          sampleRate !== 48_000 ||
          channels !== 2 ||
          Math.abs((track.durationSec ?? 0) - 5) > 1e-9
        ) {
          throw new Error(`incorrect WAV truth: ${JSON.stringify(track)}`);
        }
      };
      const engineProbe = async (url) => {
        const info = await media.probeContainer(
          fromURL(url, { mime: 'audio/wav', size: fixtureBytes }),
          'wav',
        );
        truth(info.tracks[0]);
      };
      const engineAutoProbe = async (url) => {
        const info = await media.probe(fromURL(url, { mime: 'audio/wav', size: fixtureBytes }));
        truth(info.tracks[0]);
      };
      const engineAutoSignalProbe = async (url) => {
        const controller = new AbortController();
        const info = await media.probe(fromURL(url, { mime: 'audio/wav', size: fixtureBytes }), {
          signal: controller.signal,
        });
        truth(info.tracks[0]);
      };
      const engineDefaultProbe = async (url) => {
        const controller = new AbortController();
        const info = await defaultMedia.probe(
          defaultMedia.from(new URL(url), {
            mime: 'audio/wav',
            rangeRequests: true,
            size: fixtureBytes,
          }),
          { signal: controller.signal },
        );
        truth(info.tracks[0]);
      };
      const withTimer = async (work, timeoutMs) => {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('profile timeout')), timeoutMs);
        });
        try {
          return await Promise.race([work(), timeout]);
        } finally {
          clearTimeout(timer);
        }
      };
      const adapterCopy = async (url) => {
        const controller = new AbortController();
        let timer;
        let timedOut = false;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('adapter-copy timeout'));
          }, 310_000);
        });
        const work = (async () => {
          const source = await Promise.resolve(
            media.from(new URL(url), {
              mime: 'audio/wav',
              rangeRequests: true,
              size: fixtureBytes,
            }),
          );
          const info = await media.probe(source, { signal: controller.signal });
          truth(info.tracks[0]);
          return {
            container: info.container,
            durationSec: info.durationSec,
            tracks: info.tracks.map((track) => ({
              type: track.type,
              codec: track.codec,
              sampleRate: track.sampleRate,
              channels: track.channels,
              bitrate: null,
              language: null,
            })),
          };
        })();
        work.catch(() => {
          if (!timedOut) return;
        });
        try {
          return await Promise.race([work, timeout]);
        } finally {
          clearTimeout(timer);
        }
      };
      const run = async (mode) => {
        const url = `${fixtureUrl}?fresh=${sequence++}`;
        const started = performance.now();
        if (mode === 'raw-range') {
          const bytes = await fetchRange(url, 0, rangeBytes);
          if (bytes.byteLength !== rangeBytes) throw new Error('short raw range');
        } else if (mode === 'driver-url') {
          const tracks = await probe({
            kind: 'url',
            size: fixtureBytes,
            range: (start, end) => fetchRange(url, start, end),
            stream: () => {
              throw new Error('driver profile must remain seekable');
            },
          });
          truth(tracks[0]);
        } else if (mode === 'engine-url') {
          await engineProbe(url);
        } else if (mode === 'engine-auto') {
          await engineAutoProbe(url);
        } else if (mode === 'engine-auto-signal') {
          await engineAutoSignalProbe(url);
        } else if (mode === 'engine-default') {
          await engineDefaultProbe(url);
        } else if (mode === 'adapter-copy') {
          await adapterCopy(url);
        } else if (mode === 'engine-timeout') {
          await withTimer(() => engineProbe(url), 310_000);
        } else if (mode === 'engine-double-timeout') {
          await withTimer(() => withTimer(() => engineProbe(url), 310_000), 120_000);
        } else {
          const tracks = await probe({
            size: fixtureBytes,
            range: (start, end) => Promise.resolve(memoryPrefix.subarray(start, end)),
            stream: () => {
              throw new Error('memory driver profile must remain seekable');
            },
          });
          truth(tracks[0]);
        }
        return performance.now() - started;
      };
      for (let index = 0; index < warmup; index++) {
        for (const mode of modes) await run(mode);
      }
      for (let index = 0; index < samples; index++) {
        for (let offset = 0; offset < modes.length; offset++) {
          const mode = modes[(index + offset) % modes.length];
          timings[mode].push(await run(mode));
        }
      }
      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('empty timing set');
        return value;
      };
      return Object.fromEntries(
        modes.map((mode) => {
          const values = timings[mode];
          const center = median(values);
          return [
            mode,
            {
              medianMs: center,
              madMs: median(values.map((value) => Math.abs(value - center))),
              samples: values,
            },
          ];
        }),
      );
    },
    {
      fixtureBytes: fixture.byteLength,
      fixtureUrl: FIXTURE_URL,
      rangeBytes: RANGE_BYTES,
      samples: SAMPLES,
      warmup: WARMUP,
    },
  );
  console.info(
    JSON.stringify(
      {
        benchmark: 'session13-wav-probe-layers-browser',
        fixtureBytes: fixture.byteLength,
        rangeBytes: RANGE_BYTES,
        warmup: WARMUP,
        samples: SAMPLES,
        report,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
