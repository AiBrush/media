#!/usr/bin/env node
/** Fresh non-headless Chromium profile: transport -> MP4 driver -> public targeted probe -> adapter shape. */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUP = 7;
const SAMPLES = 31;
const root = process.cwd();
const fixture = await readFile(resolve(root, '../media-test/fixtures/media/micro_h264_1frame.mp4'));

function contentType(path) {
  if (extname(path) === '.js') return 'text/javascript; charset=utf-8';
  if (extname(path) === '.wasm') return 'application/wasm';
  if (extname(path) === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>micro MP4 probe layers</title>');
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
  if (url.pathname !== '/fixture.mp4') {
    response.writeHead(404).end('not found');
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  if (match === null) {
    response.writeHead(200, {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-length': String(fixture.byteLength),
      'content-type': 'video/mp4',
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
    'content-type': 'video/mp4',
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
    async ({ fixtureBytes, fixtureUrl, samples, warmup }) => {
      const [{ createMedia, fromBytes, fromURL }, { Mp4Driver }] = await Promise.all([
        import(`/dist/index.js?run=${Date.now()}`),
        import(`/dist/drivers/mp4.js?run=${Date.now()}`),
      ]);
      const media = createMedia({ worker: false });
      const probe = Mp4Driver.probe;
      if (probe === undefined) throw new Error('MP4 driver has no probe');
      const modes = [
        'raw-full',
        'driver-url',
        'engine-targeted',
        'engine-targeted-signal',
        'engine-auto',
        'adapter-shape',
        'driver-memory',
        'engine-memory',
      ];
      const timings = Object.fromEntries(modes.map((mode) => [mode, []]));
      let sequence = 0;
      const rawFull = async (url) => {
        const response = await fetch(url, { cache: 'no-store', priority: 'high' });
        if (!response.ok) throw new Error(`full fetch failed: ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== fixtureBytes) throw new Error('short full fetch');
        return bytes;
      };
      const memoryBytes = await rawFull(`${fixtureUrl}?memory=${sequence++}`);
      const assertTrack = (track) => {
        if (
          track?.codec !== 'avc1.64100B' ||
          track.durationSec !== 1 ||
          track.fps !== 1 ||
          (track.width ?? track.config?.codedWidth) !== 320 ||
          (track.height ?? track.config?.codedHeight) !== 240
        ) {
          throw new Error(`incorrect micro MP4 truth: ${JSON.stringify(track)}`);
        }
      };
      const assertInfo = (info) => {
        if (info.container !== 'mp4' || info.durationSec !== 1 || info.tracks.length !== 1) {
          throw new Error(`incorrect micro MP4 info: ${JSON.stringify(info)}`);
        }
        assertTrack(info.tracks[0]);
      };
      const source = (url) =>
        fromURL(url, { mime: 'video/mp4', rangeRequests: true, size: fixtureBytes });
      const driverSource = (url) => ({
        kind: 'url',
        mimeHint: 'video/mp4',
        size: fixtureBytes,
        range: async () => rawFull(url),
        stream: () => {
          throw new Error('micro MP4 profile must stay seekable');
        },
      });
      const withAdapterTimeout = async (url) => {
        const controller = new AbortController();
        let timer;
        let timedOut = false;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('adapter profile timeout'));
          }, 310_000);
        });
        const work = (async () => {
          const info = await media.probeContainer(source(url), 'mp4', {
            signal: controller.signal,
          });
          assertInfo(info);
          return {
            container: info.container,
            durationSec: info.durationSec,
            tracks: info.tracks.map((track) => ({
              type: track.type,
              codec: track.codec.startsWith('avc1') ? 'h264' : track.codec,
              width: track.width,
              height: track.height,
              fps: track.fps,
              rotation: track.rotation,
            })),
          };
        })();
        work.catch(() => {
          if (!timedOut) return;
        });
        try {
          const normalized = await Promise.race([work, timeout]);
          if (normalized.tracks[0]?.codec !== 'h264')
            throw new Error('adapter shape changed codec');
        } finally {
          clearTimeout(timer);
        }
      };
      const run = async (mode) => {
        const url = `${fixtureUrl}?fresh=${sequence++}`;
        const started = performance.now();
        if (mode === 'raw-full') {
          await rawFull(url);
        } else if (mode === 'driver-url') {
          const tracks = await probe(driverSource(url));
          if (tracks.length !== 1) throw new Error('driver returned the wrong track count');
          assertTrack(tracks[0]);
        } else if (mode === 'engine-targeted') {
          assertInfo(await media.probeContainer(source(url), 'mp4'));
        } else if (mode === 'engine-targeted-signal') {
          const controller = new AbortController();
          assertInfo(await media.probeContainer(source(url), 'mp4', { signal: controller.signal }));
        } else if (mode === 'engine-auto') {
          assertInfo(await media.probe(source(url)));
        } else if (mode === 'adapter-shape') {
          await withAdapterTimeout(url);
        } else if (mode === 'driver-memory') {
          const tracks = await probe({
            kind: 'bytes',
            mimeHint: 'video/mp4',
            size: memoryBytes.byteLength,
            range: (start, end) => Promise.resolve(memoryBytes.subarray(start, end)),
            stream: () => {
              throw new Error('memory driver profile must stay seekable');
            },
          });
          if (tracks.length !== 1) throw new Error('memory driver returned the wrong track count');
          assertTrack(tracks[0]);
        } else {
          assertInfo(
            await media.probeContainer(fromBytes(memoryBytes, { mime: 'video/mp4' }), 'mp4'),
          );
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
      fixtureUrl: `http://127.0.0.1:${address.port}/fixture.mp4`,
      samples: SAMPLES,
      warmup: WARMUP,
    },
  );
  console.info(
    JSON.stringify(
      {
        benchmark: 'session13-mp4-micro-probe-browser',
        fixtureBytes: fixture.byteLength,
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
