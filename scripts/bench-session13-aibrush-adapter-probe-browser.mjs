#!/usr/bin/env node
/** Fresh non-headless Chromium profile of the complete browser-harness aibrush probe adapter. */

import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const BASE_URL = 'http://localhost:5173';
const FIXTURE_URL = `${BASE_URL}/fixtures/media/wav_s16.wav`;
const FIXTURE_BYTES = 960_044;
const WARMUP = 5;
const SAMPLES = 15;

const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/index.html?autorun=0`);
  const report = await page.evaluate(
    async ({ fixtureBytes, fixtureUrl, samples, warmup }) => {
      const registry = await import('/src/core/registry.ts');
      const { registerAibrushMedia } = await import('/src/engines/aibrush-media/adapter.ts');
      const { Meter } = await import('/src/core/measure.ts');
      registry.__resetRegistry();
      registerAibrushMedia();
      const registered = registry.getEngine('aibrush-media');
      if (registered === undefined) throw new Error('aibrush adapter did not register');
      const engine = registered.factory();
      await engine.init();
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const fetches = [];
      globalThis.fetch = async (resource, init) => {
        const started = performance.now();
        const response = await nativeFetch(resource, init);
        const completed = performance.now();
        fetches.push({
          durationMs: completed - started,
          range: new Headers(init?.headers).get('Range'),
          status: response.status,
          url: typeof resource === 'string' ? resource : resource.url,
        });
        return response;
      };
      let sequence = 0;
      const input = () => {
        sequence++;
        const url = fixtureUrl;
        let cached;
        const bytes = () => {
          cached ??= fetch(url).then((response) => {
            if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
            return response.arrayBuffer();
          });
          return cached;
        };
        return {
          id: 'wav_s16.wav',
          url,
          mime: 'audio/wav',
          sizeBytes: fixtureBytes,
          mutated: false,
          arrayBuffer: bytes,
          async blob() {
            return new Blob([await bytes()], { type: 'audio/wav' });
          },
        };
      };
      const assertTruth = (metadata) => {
        const track = metadata.tracks[0];
        if (
          metadata.container !== 'wav' ||
          metadata.durationSec !== 5 ||
          track?.codec !== 'pcm-s16' ||
          track.sampleRate !== 48_000 ||
          track.channels !== 2
        ) {
          throw new Error(`incorrect adapter truth: ${JSON.stringify(metadata)}`);
        }
      };
      const direct = async () => {
        const started = performance.now();
        assertTruth(await engine.probe(input()));
        return performance.now() - started;
      };
      const metered = async () => {
        const meter = new Meter({ observeLongtasks: false });
        meter.begin();
        assertTruth(await engine.probe(input()));
        return (await meter.end({ ops: 1 })).wallMs;
      };
      const runnerTimed = async () => {
        const meter = new Meter({ observeLongtasks: false });
        meter.begin();
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('runner timeout')), 120_000);
        });
        try {
          assertTruth(await Promise.race([engine.probe(input()), timeout]));
        } finally {
          clearTimeout(timer);
        }
        return (await meter.end({ ops: 1 })).wallMs;
      };
      const rawFetch = async () => {
        const started = performance.now();
        const response = await nativeFetch(fixtureUrl, {
          cache: 'no-store',
          headers: { Range: 'bytes=0-16383' },
        });
        if (response.status !== 206 || (await response.arrayBuffer()).byteLength !== 16_384) {
          throw new Error('incorrect raw fetch response');
        }
        return performance.now() - started;
      };
      const rawFullFetch = async () => {
        const started = performance.now();
        const response = await nativeFetch(fixtureUrl, { cache: 'no-store', priority: 'high' });
        if (response.status !== 200 || (await response.arrayBuffer()).byteLength !== fixtureBytes) {
          throw new Error('incorrect full fetch response');
        }
        return performance.now() - started;
      };
      const highPriorityFetch = async () => {
        const started = performance.now();
        const response = await nativeFetch(fixtureUrl, {
          cache: 'no-store',
          headers: { Range: 'bytes=0-16383' },
          priority: 'high',
        });
        if (response.status !== 206 || (await response.arrayBuffer()).byteLength !== 16_384) {
          throw new Error('incorrect high-priority fetch response');
        }
        return performance.now() - started;
      };
      const xhr = async () => {
        const started = performance.now();
        const bytes = await new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open('GET', fixtureUrl);
          request.responseType = 'arraybuffer';
          request.setRequestHeader('Range', 'bytes=0-16383');
          request.onload = () =>
            request.status === 206
              ? resolve(request.response)
              : reject(new Error(`XHR ${request.status}`));
          request.onerror = () => reject(new Error('XHR network error'));
          request.send();
        });
        if (bytes.byteLength !== 16_384) throw new Error('incorrect XHR response');
        return performance.now() - started;
      };
      const modes = {
        direct,
        highPriorityFetch,
        metered,
        rawFetch,
        rawFullFetch,
        runnerTimed,
        xhr,
      };
      for (let index = 0; index < warmup; index++) {
        for (const mode of Object.values(modes)) await mode();
      }
      fetches.length = 0;
      const timings = Object.fromEntries(Object.keys(modes).map((mode) => [mode, []]));
      for (let index = 0; index < samples; index++) {
        const names = Object.keys(modes);
        const offset = index % names.length;
        const order = [...names.slice(offset), ...names.slice(0, offset)];
        for (const mode of order) timings[mode].push(await modes[mode]());
      }
      await engine.dispose();
      globalThis.fetch = nativeFetch;
      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('empty profile');
        return value;
      };
      const timingReport = Object.fromEntries(
        Object.entries(timings).map(([mode, values]) => {
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
      const fetchDurations = fetches.map((entry) => entry.durationMs);
      return {
        fetch: {
          count: fetches.length,
          medianMs: median(fetchDurations),
          sample: fetches[0],
        },
        timings: timingReport,
      };
    },
    {
      fixtureBytes: FIXTURE_BYTES,
      fixtureUrl: FIXTURE_URL,
      samples: SAMPLES,
      warmup: WARMUP,
    },
  );
  console.info(
    JSON.stringify(
      {
        benchmark: 'session13-aibrush-adapter-probe-browser',
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
}
