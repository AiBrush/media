#!/usr/bin/env node
/** Fresh non-headless Chromium A/B: exact Range versus plain GET for small terminal WebM probe. */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUP = 5;
const SAMPLES = 31;
const root = process.cwd();
const fixture = await readFile(
  resolve(
    root,
    '../media-test/fixtures/media/scenarios/probe/recorder_headerless/recorder_headerless.webm',
  ),
);

function contentType(path) {
  const extension = extname(path);
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.wasm') return 'application/wasm';
  return 'application/octet-stream';
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>WebM transport A/B</title>');
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
  if (url.pathname !== '/fixture.webm') {
    response.writeHead(404).end('not found');
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  if (match !== null) {
    const start = Number(match[1]);
    const requestedEnd = Number(match[2]);
    const end = Math.min(fixture.byteLength - 1, requestedEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      response.writeHead(416).end();
      return;
    }
    const bytes = fixture.subarray(start, end + 1);
    response.writeHead(206, {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-length': String(bytes.byteLength),
      'content-range': `bytes ${start}-${end}/${fixture.byteLength}`,
      'content-type': 'video/webm',
    });
    response.end(bytes);
    return;
  }
  response.writeHead(200, {
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-length': String(fixture.byteLength),
    'content-type': 'video/webm',
  });
  response.end(fixture);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string')
  throw new Error('benchmark server did not bind');

const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ fixtureBytes, port, samples, warmup }) => {
      const { createMedia } = await import(`/dist/index.js?run=${Date.now()}`);
      const media = createMedia({ worker: false });
      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('empty benchmark sample');
        return value;
      };
      let sequence = 0;
      const run = async (mode) => {
        const calls = [];
        const url = `http://127.0.0.1:${port}/fixture.webm?fresh=${sequence++}`;
        const source = {
          __media: 'source',
          kind: 'url',
          mimeHint: 'video/webm',
          size: fixtureBytes,
          async range(start, end) {
            const plainGet = mode === 'get' && start === 0 && end === fixtureBytes;
            calls.push({ start, end, transport: plainGet ? 'get' : 'range' });
            const response = await fetch(
              url,
              plainGet
                ? { cache: 'no-store' }
                : { cache: 'no-store', headers: { Range: `bytes=${start}-${end - 1}` } },
            );
            if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
            return new Uint8Array(await response.arrayBuffer());
          },
          stream() {
            throw new Error('transport benchmark must remain range-backed');
          },
        };
        const started = performance.now();
        const info = await media.probeContainer(source, 'webm');
        return { elapsedMs: performance.now() - started, calls, info };
      };

      for (let index = 0; index < warmup; index++) {
        await run('range');
        await run('get');
      }
      const timings = { range: [], get: [] };
      let rangeCalls;
      let getCalls;
      let truth;
      for (let index = 0; index < samples; index++) {
        const order = index % 2 === 0 ? ['range', 'get'] : ['get', 'range'];
        for (const mode of order) {
          const result = await run(mode);
          truth ??= JSON.stringify(result.info);
          if (JSON.stringify(result.info) !== truth) throw new Error(`${mode} changed exact truth`);
          timings[mode].push(result.elapsedMs);
          if (mode === 'range') rangeCalls ??= result.calls;
          else getCalls ??= result.calls;
        }
      }
      return {
        userAgent: navigator.userAgent,
        fixtureBytes,
        warmup,
        samples,
        range: { medianMs: median(timings.range), samples: timings.range, calls: rangeCalls },
        get: { medianMs: median(timings.get), samples: timings.get, calls: getCalls },
        truth: JSON.parse(truth),
      };
    },
    { fixtureBytes: fixture.byteLength, port: address.port, samples: SAMPLES, warmup: WARMUP },
  );
  console.info(
    JSON.stringify({ benchmark: 'session13-webm-full-get-browser', ...report }, null, 2),
  );
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
