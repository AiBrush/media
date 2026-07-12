#!/usr/bin/env node
/** Chromium A/B for generic hinted probe versus the same product container-targeted path. */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUP = 3;
const SAMPLES = 21;
const root = process.cwd();
const fixturePaths = new Map([
  [
    'alpha-01.webm',
    resolve(root, '../media-test/fixtures/media/scenarios/probe/vp9_alpha/01.webm'),
  ],
  [
    'alpha-02.webm',
    resolve(root, '../media-test/fixtures/media/scenarios/probe/vp9_alpha/02.webm'),
  ],
  [
    'alpha-03.webm',
    resolve(root, '../media-test/fixtures/media/scenarios/probe/vp9_alpha/03.webm'),
  ],
  [
    'alpha-long.webm',
    resolve(root, '../media-test/fixtures/media/scenarios/probe/vp9_alpha/vp9_alpha.webm'),
  ],
  ['bear-vp9-alpha.webm', resolve(root, 'fixtures/media/bear-vp9-alpha.webm')],
]);
const fixtureBytes = new Map();
for (const [name, path] of fixturePaths) fixtureBytes.set(name, await readFile(path));

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>hinted probe benchmark</title>');
    return;
  }
  if (url.pathname.startsWith('/dist/')) {
    try {
      const bytes = await readFile(resolve(root, `.${url.pathname}`));
      response.writeHead(200, {
        'content-length': String(bytes.byteLength),
        'content-type': 'text/javascript; charset=utf-8',
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(404).end(String(error));
    }
    return;
  }
  const name = url.pathname.startsWith('/fixture/')
    ? decodeURIComponent(url.pathname.slice('/fixture/'.length))
    : undefined;
  const bytes = name === undefined ? undefined : fixtureBytes.get(name);
  if (bytes === undefined) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-length': String(bytes.byteLength),
    'content-type': 'video/webm',
  });
  response.end(bytes);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string')
  throw new Error('benchmark server did not bind');

const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ fixtureNames, warmup, samples }) => {
      const { createMedia } = await import(`/dist/index.js?run=${Date.now()}`);
      const media = createMedia({ worker: false });
      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('empty benchmark sample');
        return value;
      };
      const makeSource = (bytes, calls) => ({
        __media: 'source',
        kind: 'url',
        mimeHint: 'video/webm',
        size: bytes.byteLength,
        async range(start, end) {
          calls.push([start, end]);
          // Match Blob/File-backed browser adapters: each range materializes an independently owned view.
          return new Uint8Array(await new Blob([bytes.subarray(start, end)]).arrayBuffer());
        },
        stream() {
          return new Blob([bytes]).stream();
        },
      });
      const run = async (bytes, route) => {
        const calls = [];
        const source = makeSource(bytes, calls);
        const started = performance.now();
        if (route === 'former-image-first') {
          await source.range(0, Math.min(4 * 1024, bytes.byteLength));
        }
        const info =
          route === 'current'
            ? await media.probe(source)
            : await media.probeContainer(source, 'webm');
        return { elapsedMs: performance.now() - started, calls, info };
      };

      const rows = [];
      for (const name of fixtureNames) {
        const bytes = new Uint8Array(
          await (await fetch(`/fixture/${encodeURIComponent(name)}`)).arrayBuffer(),
        );
        for (let index = 0; index < warmup; index++) {
          await run(bytes, 'current');
          await run(bytes, 'targeted');
          await run(bytes, 'former-image-first');
        }
        const current = [];
        const targeted = [];
        const formerImageFirst = [];
        let currentCalls;
        let targetedCalls;
        let formerImageFirstCalls;
        let expectedTruth;
        for (let index = 0; index < samples; index++) {
          const order =
            index % 2 === 0
              ? ['current', 'targeted', 'former-image-first']
              : ['former-image-first', 'targeted', 'current'];
          const results = new Map();
          for (const route of order) results.set(route, await run(bytes, route));
          const currentResult = results.get('current');
          const targetedResult = results.get('targeted');
          const formerResult = results.get('former-image-first');
          if (
            currentResult === undefined ||
            targetedResult === undefined ||
            formerResult === undefined
          ) {
            throw new Error(`${name}: benchmark route result missing`);
          }
          if (expectedTruth === undefined) expectedTruth = JSON.stringify(currentResult.info);
          if (
            JSON.stringify(currentResult.info) !== expectedTruth ||
            JSON.stringify(targetedResult.info) !== expectedTruth ||
            JSON.stringify(formerResult.info) !== expectedTruth
          ) {
            throw new Error(`${name}: a control changed exact MediaInfo truth`);
          }
          current.push(currentResult.elapsedMs);
          targeted.push(targetedResult.elapsedMs);
          formerImageFirst.push(formerResult.elapsedMs);
          currentCalls ??= currentResult.calls;
          targetedCalls ??= targetedResult.calls;
          formerImageFirstCalls ??= formerResult.calls;
        }
        rows.push({
          name,
          bytes: bytes.byteLength,
          warmup,
          samples,
          currentMedianMs: median(current),
          targetedMedianMs: median(targeted),
          formerImageFirstMedianMs: median(formerImageFirst),
          current,
          targeted,
          formerImageFirst,
          currentCalls,
          targetedCalls,
          formerImageFirstCalls,
          truth: JSON.parse(expectedTruth),
        });
      }
      return { userAgent: navigator.userAgent, rows };
    },
    { fixtureNames: [...fixturePaths.keys()], warmup: WARMUP, samples: SAMPLES },
  );
  console.info(
    JSON.stringify({ benchmark: 'session13-hinted-container-probe-browser', ...report }, null, 2),
  );
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
