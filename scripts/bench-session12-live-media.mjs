#!/usr/bin/env bun
/** Session 12 real-browser MediaStream input validation and benchmark (ADR-236). */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUPS = 2;
const SAMPLES = 5;
const FIXTURE_NAMES = [
  'movie_5.mp4',
  'h264.mp4',
  'four-colors.mp4',
  'bear-1280x720.mp4',
  'bear-vp9-alpha.webm',
];
const MIME_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
]);
const root = process.cwd();
const fixtureDirectory = resolve(root, 'fixtures/media');

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const manifest = JSON.parse(await readFile(resolve(root, 'fixtures/manifest.json'), 'utf8'));
const fixtureById = new Map(manifest.files.map((entry) => [entry.id, entry]));
const fixtureBytes = new Map();
const fixtures = [];
for (const name of FIXTURE_NAMES) {
  const entry = fixtureById.get(name);
  if (entry === undefined) throw new Error(`${name}: absent from fixtures/manifest.json`);
  const bytes = await readFile(resolve(fixtureDirectory, name));
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== entry.sha256) {
    throw new Error(`${name}: fixture SHA-256 ${actualSha256} != manifest ${entry.sha256}`);
  }
  if (bytes.byteLength !== entry.bytes) {
    throw new Error(`${name}: fixture size ${bytes.byteLength} != manifest ${entry.bytes}`);
  }
  fixtureBytes.set(name, bytes);
  fixtures.push({
    name,
    bytes: bytes.byteLength,
    sha256: actualSha256,
    license: entry.license,
    source: entry.source,
  });
}

const build = await Bun.build({
  entrypoints: [resolve(root, 'src/sources/live-media.ts')],
  format: 'esm',
  target: 'browser',
});
if (!build.success) {
  throw new Error(`live-media browser bundle failed:\n${build.logs.join('\n')}`);
}
const artifact = build.outputs[0];
if (artifact === undefined) throw new Error('live-media browser bundle emitted no artifact');
const liveMediaBundle = await artifact.text();

function send(response, status, headers, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    send(
      response,
      200,
      { 'content-type': 'text/html; charset=utf-8' },
      '<!doctype html><meta charset="utf-8"><title>live MediaStream benchmark</title>',
    );
    return;
  }
  if (url.pathname === '/live-media.js') {
    send(response, 200, { 'content-type': 'text/javascript; charset=utf-8' }, liveMediaBundle);
    return;
  }
  const prefix = '/fixture/';
  if (!url.pathname.startsWith(prefix)) {
    send(response, 404, {}, 'not found');
    return;
  }
  const name = decodeURIComponent(url.pathname.slice(prefix.length));
  const bytes = fixtureBytes.get(name);
  const extension = name.endsWith('.webm') ? '.webm' : name.endsWith('.mp4') ? '.mp4' : '';
  const contentType = MIME_TYPES.get(extension);
  if (bytes === undefined || contentType === undefined) {
    send(response, 404, {}, 'fixture not found');
    return;
  }
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range === undefined) {
    send(
      response,
      200,
      {
        'accept-ranges': 'bytes',
        'content-length': String(bytes.byteLength),
        'content-type': contentType,
      },
      bytes,
    );
    return;
  }
  const start = Number(range[1]);
  const requestedEnd = range[2] === '' ? bytes.byteLength - 1 : Number(range[2]);
  const end = Math.min(requestedEnd, bytes.byteLength - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    send(response, 416, { 'content-range': `bytes */${bytes.byteLength}` }, '');
    return;
  }
  const body = bytes.subarray(start, end + 1);
  send(
    response,
    206,
    {
      'accept-ranges': 'bytes',
      'content-length': String(body.byteLength),
      'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
      'content-type': contentType,
    },
    body,
  );
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string')
  throw new Error('benchmark server did not bind');

const browser = await chromium.launch({
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
  ],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ fixtures: browserFixtures, warmups, samples }) => {
      const { captureElementMediaStream, decodeLiveMediaStream } = await import(
        `/live-media.js?run=${Date.now()}`
      );
      if (typeof MediaStreamTrackProcessor !== 'function') {
        throw new Error('Chromium exposes no MediaStreamTrackProcessor');
      }
      if (typeof VideoFrame !== 'function') throw new Error('Chromium exposes no VideoFrame');

      const expectedPixelDigests = new Map();

      function timeout(ms, label) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
        });
      }

      function withTimeout(value, ms, label) {
        return Promise.race([value, timeout(ms, label)]);
      }

      function event(element, name) {
        return withTimeout(
          new Promise((resolveEvent, rejectEvent) => {
            element.addEventListener(name, resolveEvent, { once: true });
            element.addEventListener(
              'error',
              () => rejectEvent(element.error ?? new Error(`${name}: media element error`)),
              { once: true },
            );
          }),
          5_000,
          `media ${name}`,
        );
      }

      async function pixelDigest(frame) {
        const options = { format: 'RGBA' };
        const pixels = new Uint8Array(frame.allocationSize(options));
        await frame.copyTo(pixels, options);
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
      }

      function closeAndAssert(frame, label) {
        frame.close();
        let rejected = false;
        try {
          frame.allocationSize({ format: 'RGBA' });
        } catch (error) {
          rejected = error instanceof DOMException && error.name === 'InvalidStateError';
        }
        if (!rejected) throw new Error(`${label}: closed VideoFrame remained usable`);
      }

      async function forceGc() {
        if (typeof globalThis.gc === 'function') globalThis.gc();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        if (typeof globalThis.gc === 'function') globalThis.gc();
      }

      function heapBytes() {
        const value = performance.memory?.usedJSHeapSize;
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error('Chromium precise usedJSHeapSize is unavailable');
        }
        return value;
      }

      async function captureFixture(fixture) {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.src = `/fixture/${encodeURIComponent(fixture.name)}?sample=${crypto.randomUUID()}`;
        document.body.append(video);
        const loaded = event(video, 'loadeddata');
        video.load();
        await loaded;
        if (video.videoWidth <= 0 || video.videoHeight <= 0) {
          throw new Error(`${fixture.name}: media element exposed invalid dimensions`);
        }

        const truth = new VideoFrame(video, { timestamp: 0 });
        const truthWidth = truth.displayWidth;
        const truthHeight = truth.displayHeight;
        const expectedDigest = await pixelDigest(truth);
        closeAndAssert(truth, `${fixture.name} direct element truth`);
        if (truthWidth !== video.videoWidth || truthHeight !== video.videoHeight) {
          throw new Error(
            `${fixture.name}: direct frame ${truthWidth}x${truthHeight} != element ${video.videoWidth}x${video.videoHeight}`,
          );
        }

        const previousDigest = expectedPixelDigests.get(fixture.name);
        if (previousDigest !== undefined && previousDigest !== expectedDigest) {
          throw new Error(`${fixture.name}: direct element pixel truth changed between samples`);
        }
        expectedPixelDigests.set(fixture.name, expectedDigest);

        const liveSource = captureElementMediaStream(video);
        const videoTracks = liveSource.mediaStream.getVideoTracks();
        if (videoTracks.length !== 1) {
          throw new Error(
            `${fixture.name}: captureStream exposed ${videoTracks.length} video tracks`,
          );
        }
        const track = videoTracks[0];
        const decoded = decodeLiveMediaStream(liveSource);
        if (decoded.video === undefined)
          throw new Error(`${fixture.name}: live decode exposed no video`);
        const reader = decoded.video.getReader();
        const timestamps = [];
        const durations = [];
        let firstFrameLatencyMs;
        let capturedDigest;
        const started = performance.now();
        try {
          const play = video.play();
          for (let frameIndex = 0; frameIndex < 3; frameIndex++) {
            const next = await withTimeout(
              reader.read(),
              5_000,
              `${fixture.name} frame ${frameIndex}`,
            );
            if (next.done) break;
            const frame = next.value;
            if (firstFrameLatencyMs === undefined)
              firstFrameLatencyMs = performance.now() - started;
            if (frame.displayWidth !== truthWidth || frame.displayHeight !== truthHeight) {
              closeAndAssert(frame, `${fixture.name} wrong-dimension capture`);
              throw new Error(
                `${fixture.name}: captured ${frame.displayWidth}x${frame.displayHeight} != ${truthWidth}x${truthHeight}`,
              );
            }
            if (!Number.isFinite(frame.timestamp)) {
              closeAndAssert(frame, `${fixture.name} invalid-timestamp capture`);
              throw new Error(`${fixture.name}: non-finite captured timestamp`);
            }
            const lastTimestamp = timestamps.at(-1);
            if (lastTimestamp !== undefined && frame.timestamp < lastTimestamp) {
              closeAndAssert(frame, `${fixture.name} regressing capture`);
              throw new Error(
                `${fixture.name}: captured timestamp regressed ${lastTimestamp} -> ${frame.timestamp}`,
              );
            }
            timestamps.push(frame.timestamp);
            durations.push(frame.duration);
            if (frameIndex === 0) capturedDigest = await pixelDigest(frame);
            closeAndAssert(frame, `${fixture.name} captured frame ${frameIndex}`);
            video.playbackRate = 16;
          }
          await play;
          const trackStateBeforeCancel = track.readyState;
          const cancelStarted = performance.now();
          await withTimeout(reader.cancel('benchmark-complete'), 2_000, `${fixture.name} cancel`);
          const cancelLatencyMs = performance.now() - cancelStarted;
          if (trackStateBeforeCancel === 'live' && track.readyState !== 'live') {
            throw new Error(
              `${fixture.name}: cancelling decoded frames stopped the caller-owned track`,
            );
          }
          if (timestamps.length === 0 || firstFrameLatencyMs === undefined) {
            throw new Error(`${fixture.name}: capture produced no frames`);
          }
          if (capturedDigest !== expectedDigest) {
            throw new Error(
              `${fixture.name}: capture pixel digest ${capturedDigest} != direct element ${expectedDigest}`,
            );
          }
          return {
            name: fixture.name,
            width: truthWidth,
            height: truthHeight,
            frames: timestamps.length,
            timestamps,
            durations,
            pixelSha256: capturedDigest,
            firstFrameLatencyMs,
            cancelLatencyMs,
            trackStateAfterAdapterCancel: track.readyState,
          };
        } finally {
          reader.releaseLock();
          for (const ownedTrack of liveSource.mediaStream.getTracks()) ownedTrack.stop();
          video.pause();
          video.removeAttribute('src');
          video.load();
          video.remove();
        }
      }

      async function runCorpus() {
        await forceGc();
        const heapBeforeBytes = heapBytes();
        const started = performance.now();
        const results = [];
        for (const fixture of browserFixtures) results.push(await captureFixture(fixture));
        const elapsedMs = performance.now() - started;
        await forceGc();
        const heapAfterBytes = heapBytes();
        return {
          elapsedMs,
          heapBeforeBytes,
          heapAfterBytes,
          fixtures: results,
          frames: results.reduce((total, result) => total + result.frames, 0),
          firstFrameLatencyMs: results.map((result) => result.firstFrameLatencyMs),
          cancelLatencyMs: results.map((result) => result.cancelLatencyMs),
        };
      }

      for (let index = 0; index < warmups; index++) await runCorpus();
      const measured = [];
      for (let index = 0; index < samples; index++) measured.push(await runCorpus());

      const digestsByFixture = new Map();
      for (const sample of measured) {
        if (sample.frames < browserFixtures.length) {
          throw new Error(
            `sample exposed ${sample.frames} frames for ${browserFixtures.length} fixtures`,
          );
        }
        for (const fixture of sample.fixtures) {
          const digests = digestsByFixture.get(fixture.name) ?? new Set();
          digests.add(fixture.pixelSha256);
          digestsByFixture.set(fixture.name, digests);
        }
      }
      for (const [name, digests] of digestsByFixture) {
        if (digests.size !== 1)
          throw new Error(`${name}: measured pixel digest was not deterministic`);
      }
      if (new Set(expectedPixelDigests.values()).size !== browserFixtures.length) {
        throw new Error('the five visual fixtures did not produce five distinct pixel digests');
      }

      const retainedHeapBytes = measured.at(-1).heapAfterBytes - measured[0].heapAfterBytes;
      const retainedAllowanceBytes = Math.max(
        8 * 1024 * 1024,
        Math.round(measured[0].heapAfterBytes * 0.25),
      );
      if (retainedHeapBytes > retainedAllowanceBytes) {
        throw new Error(
          `post-GC heap retained ${retainedHeapBytes} bytes; allowance ${retainedAllowanceBytes}`,
        );
      }

      return {
        userAgent: navigator.userAgent,
        processor: 'MediaStreamTrackProcessor',
        warmups,
        samples,
        elapsedMs: measured.map((sample) => sample.elapsedMs),
        medianElapsedMs: median(measured.map((sample) => sample.elapsedMs)),
        frames: measured.map((sample) => sample.frames),
        firstFrameLatencyMs: measured.flatMap((sample) => sample.firstFrameLatencyMs),
        medianFirstFrameLatencyMs: median(measured.flatMap((sample) => sample.firstFrameLatencyMs)),
        cancelLatencyMs: measured.flatMap((sample) => sample.cancelLatencyMs),
        medianCancelLatencyMs: median(measured.flatMap((sample) => sample.cancelLatencyMs)),
        heapBeforeBytes: measured.map((sample) => sample.heapBeforeBytes),
        heapAfterBytes: measured.map((sample) => sample.heapAfterBytes),
        retainedHeapBytes,
        retainedAllowanceBytes,
        pixelSha256: Object.fromEntries(
          [...expectedPixelDigests.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
        lastSample: measured.at(-1).fixtures,
      };
    },
    { fixtures, warmups: WARMUPS, samples: SAMPLES },
  );
  console.log(JSON.stringify({ corpus: fixtures, ...report }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}
