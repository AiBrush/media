#!/usr/bin/env node
/** Correlate a real harness probe's wall samples with its exact HTTP response timings. */

import { resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const BASE_URL = 'http://localhost:5173';
const recorderMode = process.argv.includes('--recorder');
const SCENARIO = recorderMode ? 'probe/recorder_headerless' : 'probe/wav_s16';
const TARGET_PATH = recorderMode ? '/recorder_headerless.webm' : '/wav_s16.wav';
const WARMUP = 5;
const SAMPLES = 15;
const profile = resolve('../media-test/results/.browser-cache/chromium');

const context = await chromium.launchPersistentContext(profile, { headless: false });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  const browserTransport = [];
  page.on('requestfinished', async (request) => {
    const url = new URL(request.url());
    if (!url.pathname.includes('/fixtures/media/')) return;
    const response = await request.response();
    browserTransport.push({
      range: request.headers().range ?? null,
      status: response?.status() ?? null,
      timing: request.timing(),
      url: request.url(),
    });
  });
  await page.goto(`${BASE_URL}/index.html?autorun=0`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__SUITE__?.ready === true || typeof window.__SUITE_ERROR__ === 'string',
  );
  const bootError = await page.evaluate(() => window.__SUITE_ERROR__ ?? null);
  if (bootError !== null) throw new Error(`suite boot failed: ${bootError}`);

  await page.evaluate(
    ({ recorderMode, samples, scenario, warmup }) => {
      const nativeFetch = globalThis.fetch.bind(globalThis);
      globalThis.__WAV_TRANSPORT__ = [];
      globalThis.fetch = async (resource, init) => {
        const url = typeof resource === 'string' ? resource : resource.url;
        if (!new URL(url, globalThis.location.href).pathname.includes('/fixtures/media/')) {
          return nativeFetch(resource, init);
        }
        const started = performance.now();
        const response = await nativeFetch(resource, init);
        const headersAt = performance.now();
        const arrayBuffer = response.arrayBuffer.bind(response);
        Object.defineProperty(response, 'arrayBuffer', {
          configurable: true,
          value: async () => {
            const bytes = await arrayBuffer();
            const completed = performance.now();
            globalThis.__WAV_TRANSPORT__.push({
              bodyMs: completed - headersAt,
              bytes: bytes.byteLength,
              headersMs: headersAt - started,
              range: new Headers(init?.headers).get('Range'),
              status: response.status,
              totalMs: completed - started,
              url,
            });
            return bytes;
          },
        });
        return response;
      };
      window.__RUN_DONE__ = false;
      window.__SUITE__
        .run({
          browser: 'chromium',
          engineIds: ['aibrush-media'],
          iters: samples,
          pillar: 'performance',
          randomSeed: recorderMode ? 'recorder-profile' : 'baked-0',
          reuseData: false,
          scenarioIds: [scenario],
          warmup,
        })
        .catch((error) => {
          window.__SUITE_ERROR__ = String(error?.message ?? error);
          window.__RUN_DONE__ = true;
        });
    },
    {
      recorderMode,
      samples: SAMPLES,
      scenario: SCENARIO,
      targetPath: TARGET_PATH,
      warmup: WARMUP,
    },
  );
  await page.waitForFunction(() => window.__RUN_DONE__ === true, null, { timeout: 300_000 });
  const report = await page.evaluate(() => ({
    error: window.__SUITE_ERROR__ ?? null,
    result: window.__RESULTS__?.[0],
    transport: globalThis.__WAV_TRANSPORT__,
  }));
  const median = (values) => {
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.floor(ordered.length / 2)];
  };
  const targetTransport = report.transport.filter((entry) =>
    new URL(entry.url).pathname.endsWith(TARGET_PATH),
  );
  const targetBrowserTransport = browserTransport.filter((entry) =>
    new URL(entry.url).pathname.endsWith(TARGET_PATH),
  );
  console.info(
    JSON.stringify(
      {
        benchmark: recorderMode
          ? 'session13-recorder-harness-transport-browser'
          : 'session13-wav-harness-transport-browser',
        samples: SAMPLES,
        warmup: WARMUP,
        error: report.error,
        result: {
          bench: report.result?.bench,
          selection: report.result?.selection,
          status: report.result?.status,
        },
        transport: {
          count: targetTransport.length,
          measuredMedianMs: median(targetTransport.slice(-SAMPLES).map((entry) => entry.totalMs)),
          ranges: [...new Set(targetTransport.map((entry) => entry.range))],
        },
        browserTransport: {
          count: targetBrowserTransport.length,
          ranges: [...new Set(targetBrowserTransport.map((entry) => entry.range))],
        },
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
}
