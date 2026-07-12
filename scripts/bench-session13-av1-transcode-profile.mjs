#!/usr/bin/env node
/** Public-product AV1 transcode profile with exact timeline, sampled-SSIM, playback, and codec-call truth. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUPS = 1;
const SAMPLES = 5;
const root = process.cwd();

const cases = [
  {
    id: 'rotated-03-vp9-runtime-miss',
    path: resolve(root, '../media-test/fixtures/media/scenarios/transcode/vp9_to_av1_webm/03.webm'),
    sha256: '1e549042f6402c232cbdf2a5b4236d332054f26e163e121a748da93ecb85b421',
    bytes: 14_077_804,
    expectedFrames: 4_482,
  },
  {
    id: 'contested-vp9-1080p30',
    path: resolve(root, '../media-test/fixtures/media/vp9_1080p_10s.webm'),
    sha256: '2fc7d368edd6fa2ac1ce7c538c5b643ec7d46867fb1026cf1f6daa76de9fa8dc',
    bytes: 9_293_670,
    expectedFrames: 300,
  },
  {
    id: 'contested-hevc-1080p30',
    path: resolve(root, '../media-test/fixtures/media/hevc_1080p_10s.mp4'),
    sha256: '3f5cfcc9332f375885acc23f1ec9e626162d7266ac836865bad3c3da6d3a8fb7',
    bytes: 11_061_061,
    expectedFrames: 300,
  },
  {
    id: 'control-h264-720p',
    path: resolve(root, 'fixtures/media/bear-1280x720.mp4'),
    sha256: 'bcb75d3db0a1a5056f4cd5c770ceccdb4cae920f21abb8139b29cd9ad39e3857',
    bytes: 715_963,
    expectedFrames: 82,
  },
];

const requestedCase = process.argv
  .find((argument) => argument.startsWith('--case='))
  ?.slice('--case='.length);
const selectedCases =
  requestedCase === undefined ? cases : cases.filter(({ id }) => id === requestedCase);
if (selectedCases.length === 0) throw new Error(`unknown benchmark case '${requestedCase}'`);

const fixtureBytes = new Map();
for (const benchmarkCase of selectedCases) {
  const bytes = await readFile(benchmarkCase.path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== benchmarkCase.bytes || digest !== benchmarkCase.sha256) {
    throw new Error(`${benchmarkCase.id}: fixture integrity mismatch`);
  }
  fixtureBytes.set(benchmarkCase.id, bytes);
}

const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>AV1 transcode profile</title>');
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
  const fixturePrefix = '/fixture/';
  const id = url.pathname.startsWith(fixturePrefix)
    ? decodeURIComponent(url.pathname.slice(fixturePrefix.length))
    : undefined;
  const bytes = id === undefined ? undefined : fixtureBytes.get(id);
  if (bytes === undefined) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-length': String(bytes.byteLength),
    'content-type': id.includes('vp9') ? 'video/webm' : 'video/mp4',
  });
  response.end(bytes);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('profile server did not bind');

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ caseFacts, warmups, samples, injectFailFirst }) => {
      const { CapabilityError, createMedia } = await import(`/dist/index.js?profile=${Date.now()}`);
      const failFirstState = { runtimeMisses: 0 };
      const baseMedia = createMedia({ worker: false });
      const validationMedia = createMedia({ worker: false });
      const media = injectFailFirst
        ? baseMedia.use({
            apiVersion: 1,
            register(registry) {
              registry.addCodec({
                id: 'profile-fail-first-native-vpx',
                apiVersion: 1,
                kind: 'codec',
                tier: 'hardware',
                supports(query) {
                  return Promise.resolve({
                    supported:
                      query.mediaType === 'video' &&
                      query.direction === 'decode' &&
                      /^vp(?:8|9|09)/.test(query.config.codec),
                    hardwareAccelerated: true,
                  });
                },
                createDecoder() {
                  return new TransformStream({
                    transform() {
                      failFirstState.runtimeMisses++;
                      throw new CapabilityError(
                        'capability-miss',
                        'profile-injected typed pre-output native VPx runtime miss',
                        { op: 'decode', tried: ['profile-fail-first-native-vpx'] },
                      );
                    },
                  });
                },
                createEncoder() {
                  throw new CapabilityError('capability-miss', 'profile driver is decode-only', {
                    op: 'encode',
                    tried: ['profile-fail-first-native-vpx'],
                  });
                },
              });
            },
          })
        : baseMedia;

      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('cannot take median of no samples');
        return value;
      };

      const sameNumbers = (left, right) =>
        left.length === right.length && left.every((value, index) => value === right[index]);

      const sha256 = async (bytes) =>
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('');

      const timestampFold = (timestamps) =>
        timestamps.reduce((fold, timestamp) => (fold + timestamp) % 1_000_000_007, 0);

      const webmTimestamps = (timestamps) => {
        const first = Math.min(...timestamps);
        return timestamps.map((timestamp) => Math.round((timestamp - first) / 1_000) * 1_000);
      };

      const sampleIndices = (frameCount) => {
        const count = Math.min(12, frameCount);
        if (count === 0) return new Set();
        return new Set(
          Array.from({ length: count }, (_, index) =>
            Math.round((index * (frameCount - 1)) / Math.max(1, count - 1)),
          ),
        );
      };

      const copyLuma = async (frame) => {
        const width = frame.displayWidth;
        const height = frame.displayHeight;
        const size = frame.allocationSize({ format: 'RGBA' });
        const rgba = new Uint8Array(size);
        const layouts = await frame.copyTo(rgba, { format: 'RGBA' });
        const layout = layouts[0];
        if (layout === undefined) throw new Error('RGBA copy returned no plane layout');
        const step = Math.max(1, Math.floor(Math.min(width, height) / 128));
        const columns = Math.ceil(width / step);
        const rows = Math.ceil(height / step);
        const luma = new Float64Array(columns * rows);
        let target = 0;
        for (let y = 0; y < height; y += step) {
          const row = layout.offset + y * layout.stride;
          for (let x = 0; x < width; x += step) {
            const offset = row + x * 4;
            const red = rgba[offset];
            const green = rgba[offset + 1];
            const blue = rgba[offset + 2];
            if (red === undefined || green === undefined || blue === undefined) {
              throw new Error('RGBA copy layout exceeded its buffer');
            }
            luma[target++] = red * 0.2126 + green * 0.7152 + blue * 0.0722;
          }
        }
        return luma;
      };

      const ssim = (left, right) => {
        if (left.length !== right.length || left.length < 2)
          throw new Error('invalid SSIM vectors');
        let leftMean = 0;
        let rightMean = 0;
        for (let index = 0; index < left.length; index++) {
          leftMean += left[index];
          rightMean += right[index];
        }
        leftMean /= left.length;
        rightMean /= right.length;
        let leftVariance = 0;
        let rightVariance = 0;
        let covariance = 0;
        for (let index = 0; index < left.length; index++) {
          const leftDelta = left[index] - leftMean;
          const rightDelta = right[index] - rightMean;
          leftVariance += leftDelta * leftDelta;
          rightVariance += rightDelta * rightDelta;
          covariance += leftDelta * rightDelta;
        }
        const divisor = left.length - 1;
        leftVariance /= divisor;
        rightVariance /= divisor;
        covariance /= divisor;
        const c1 = (0.01 * 255) ** 2;
        const c2 = (0.03 * 255) ** 2;
        return (
          ((2 * leftMean * rightMean + c1) * (2 * covariance + c2)) /
          ((leftMean ** 2 + rightMean ** 2 + c1) * (leftVariance + rightVariance + c2))
        );
      };

      const packetTruth = async (bytes) => {
        const demuxed = await media.demux(bytes);
        const track = demuxed.tracks.find((candidate) => candidate.mediaType === 'video');
        if (track === undefined) throw new Error('no video track');
        const reader = demuxed.packets(track.id).getReader();
        const timestamps = [];
        const durations = [];
        const keyframes = [];
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            timestamps.push(next.value.chunk.timestamp);
            durations.push(next.value.chunk.duration);
            keyframes.push(next.value.chunk.type === 'key');
          }
        } finally {
          reader.releaseLock();
          await demuxed.close();
        }
        return {
          codec: track.config?.codec ?? track.codec,
          width: track.width,
          height: track.height,
          fps: track.fps,
          packetCount: timestamps.length,
          timestamps,
          durations,
          keyframes,
        };
      };

      const decodeTruth = async (bytes, expectedFrames) => {
        const streams = validationMedia.decode(bytes);
        const reader = streams.video.getReader();
        const wanted = sampleIndices(expectedFrames);
        const timestamps = [];
        const samplesByIndex = [];
        let index = 0;
        let closedFrames = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const frame = next.value;
            try {
              timestamps.push(frame.timestamp);
              if (wanted.has(index)) samplesByIndex.push([index, await copyLuma(frame)]);
            } finally {
              frame.close();
              closedFrames++;
            }
            index++;
          }
        } finally {
          reader.releaseLock();
          await streams.audio.cancel('video-only profile finished').catch(() => {});
        }
        return { frameCount: index, closedFrames, timestamps, samplesByIndex };
      };

      const playbackSmoke = async (bytes) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
        const element = document.createElement('video');
        element.muted = true;
        element.playsInline = true;
        element.src = url;
        document.body.append(element);
        try {
          await new Promise((resolveLoaded, rejectLoaded) => {
            const timeout = setTimeout(
              () => rejectLoaded(new Error('playback load timeout')),
              10_000,
            );
            element.addEventListener(
              'loadeddata',
              () => {
                clearTimeout(timeout);
                resolveLoaded();
              },
              { once: true },
            );
            element.addEventListener(
              'error',
              () => {
                clearTimeout(timeout);
                rejectLoaded(new Error('output failed playback load'));
              },
              { once: true },
            );
          });
          await element.play();
          await new Promise((resolvePlayed, rejectPlayed) => {
            const timeout = setTimeout(
              () => rejectPlayed(new Error('playback progress timeout')),
              10_000,
            );
            const observe = () => {
              if (element.currentTime >= 0.1 || element.ended) {
                clearTimeout(timeout);
                element.removeEventListener('timeupdate', observe);
                resolvePlayed();
              }
            };
            element.addEventListener('timeupdate', observe);
            observe();
          });
          return { durationSec: element.duration, playedToSec: element.currentTime };
        } finally {
          element.pause();
          element.remove();
          URL.revokeObjectURL(url);
        }
      };

      const tracedConvert = async (input) => {
        const profile = {
          decoderConfigs: [],
          encoderConfigs: [],
          decodeQueueBefore: [],
          encodeQueueBefore: [],
          decodeCalls: 0,
          encodeCalls: 0,
          forcedKeyframes: 0,
          firstDecodeSubmitMs: null,
          lastDecodeSubmitMs: null,
          decoderFlushEndMs: null,
          firstEncodeSubmitMs: null,
          lastEncodeSubmitMs: null,
          encoderFlushEndMs: null,
        };
        const decoderConfigure = VideoDecoder.prototype.configure;
        const decoderDecode = VideoDecoder.prototype.decode;
        const decoderFlush = VideoDecoder.prototype.flush;
        const encoderConfigure = VideoEncoder.prototype.configure;
        const encoderEncode = VideoEncoder.prototype.encode;
        const encoderFlush = VideoEncoder.prototype.flush;
        VideoDecoder.prototype.configure = function configure(config) {
          profile.decoderConfigs.push({
            codec: config.codec,
            hardwareAcceleration: config.hardwareAcceleration ?? null,
            codedWidth: config.codedWidth ?? null,
            codedHeight: config.codedHeight ?? null,
          });
          return decoderConfigure.call(this, config);
        };
        VideoDecoder.prototype.decode = function decode(chunk) {
          const now = performance.now();
          profile.firstDecodeSubmitMs ??= now;
          profile.lastDecodeSubmitMs = now;
          profile.decodeQueueBefore.push(this.decodeQueueSize);
          profile.decodeCalls++;
          return decoderDecode.call(this, chunk);
        };
        VideoDecoder.prototype.flush = async function flush() {
          const value = await decoderFlush.call(this);
          profile.decoderFlushEndMs = performance.now();
          return value;
        };
        VideoEncoder.prototype.configure = function configure(config) {
          profile.encoderConfigs.push({
            codec: config.codec,
            width: config.width,
            height: config.height,
            framerate: config.framerate ?? null,
            bitrate: config.bitrate ?? null,
            bitrateMode: config.bitrateMode ?? null,
            latencyMode: config.latencyMode ?? null,
            hardwareAcceleration: config.hardwareAcceleration ?? null,
          });
          return encoderConfigure.call(this, config);
        };
        VideoEncoder.prototype.encode = function encode(frame, options) {
          const now = performance.now();
          profile.firstEncodeSubmitMs ??= now;
          profile.lastEncodeSubmitMs = now;
          profile.encodeQueueBefore.push(this.encodeQueueSize);
          profile.encodeCalls++;
          if (options?.keyFrame === true) profile.forcedKeyframes++;
          return encoderEncode.call(this, frame, options);
        };
        VideoEncoder.prototype.flush = async function flush() {
          const value = await encoderFlush.call(this);
          profile.encoderFlushEndMs = performance.now();
          return value;
        };
        const started = performance.now();
        try {
          const output = await media.convert(input, {
            to: 'webm',
            audio: false,
            video: { codec: 'av1' },
          });
          if (!(output instanceof Blob)) throw new Error('expected Blob output');
          const ended = performance.now();
          const bytes = new Uint8Array(await output.arrayBuffer());
          return {
            wallMs: ended - started,
            outputBytes: bytes,
            profile: {
              decoderConfigs: profile.decoderConfigs,
              encoderConfigs: profile.encoderConfigs,
              decodeCalls: profile.decodeCalls,
              encodeCalls: profile.encodeCalls,
              forcedKeyframes: profile.forcedKeyframes,
              maxDecodeQueueBefore: Math.max(0, ...profile.decodeQueueBefore),
              maxEncodeQueueBefore: Math.max(0, ...profile.encodeQueueBefore),
              decoderSpanMs:
                profile.firstDecodeSubmitMs === null || profile.decoderFlushEndMs === null
                  ? null
                  : profile.decoderFlushEndMs - profile.firstDecodeSubmitMs,
              encoderSpanMs:
                profile.firstEncodeSubmitMs === null || profile.encoderFlushEndMs === null
                  ? null
                  : profile.encoderFlushEndMs - profile.firstEncodeSubmitMs,
              muxCollectTailMs:
                profile.encoderFlushEndMs === null ? null : ended - profile.encoderFlushEndMs,
            },
          };
        } finally {
          VideoDecoder.prototype.configure = decoderConfigure;
          VideoDecoder.prototype.decode = decoderDecode;
          VideoDecoder.prototype.flush = decoderFlush;
          VideoEncoder.prototype.configure = encoderConfigure;
          VideoEncoder.prototype.encode = encoderEncode;
          VideoEncoder.prototype.flush = encoderFlush;
        }
      };

      const rows = [];
      for (const facts of caseFacts) {
        const resourcesBefore = new Set(
          performance.getEntriesByType('resource').map(({ name }) => name),
        );
        const input = new Uint8Array(
          await (await fetch(`/fixture/${encodeURIComponent(facts.id)}`)).arrayBuffer(),
        );
        const wallMs = [];
        let measured;
        for (let index = 0; index < warmups + samples; index++) {
          const result = await tracedConvert(input);
          if (index >= warmups) wallMs.push(result.wallMs);
          measured = result;
        }
        if (measured === undefined) throw new Error(`${facts.id}: no conversion result`);
        const inputPackets = await packetTruth(input);
        const outputPackets = await packetTruth(measured.outputBytes);
        if (
          inputPackets.packetCount !== facts.expectedFrames ||
          outputPackets.packetCount !== facts.expectedFrames ||
          !sameNumbers(webmTimestamps(inputPackets.timestamps), outputPackets.timestamps) ||
          outputPackets.keyframes[0] !== true
        ) {
          throw new Error(`${facts.id}: packet timeline invariant failed`);
        }
        const inputFrames = await decodeTruth(input, facts.expectedFrames);
        const outputFrames = await decodeTruth(measured.outputBytes, facts.expectedFrames);
        if (
          inputFrames.frameCount !== facts.expectedFrames ||
          outputFrames.frameCount !== facts.expectedFrames ||
          inputFrames.closedFrames !== inputFrames.frameCount ||
          outputFrames.closedFrames !== outputFrames.frameCount ||
          !sameNumbers(webmTimestamps(inputFrames.timestamps), outputFrames.timestamps)
        ) {
          throw new Error(`${facts.id}: decoded frame timeline invariant failed`);
        }
        const inputSamples = new Map(inputFrames.samplesByIndex);
        const sampledSsim = outputFrames.samplesByIndex.map(([index, outputLuma]) => {
          const inputLuma = inputSamples.get(index);
          if (inputLuma === undefined)
            throw new Error(`${facts.id}: missing input SSIM sample ${index}`);
          return ssim(inputLuma, outputLuma);
        });
        const minimumSsim = Math.min(...sampledSsim);
        if (!(minimumSsim >= 0.97)) throw new Error(`${facts.id}: minimum SSIM ${minimumSsim}`);
        const playback = await playbackSmoke(measured.outputBytes);
        rows.push({
          id: facts.id,
          warmups,
          samples,
          medianWallMs: median(wallMs),
          wallMs,
          inputPackets: {
            codec: inputPackets.codec,
            width: inputPackets.width,
            height: inputPackets.height,
            fps: inputPackets.fps,
            packetCount: inputPackets.packetCount,
          },
          outputPackets: {
            codec: outputPackets.codec,
            width: outputPackets.width,
            height: outputPackets.height,
            fps: outputPackets.fps,
            packetCount: outputPackets.packetCount,
            keyframeCount: outputPackets.keyframes.filter(Boolean).length,
          },
          minimumSampledSsim: minimumSsim,
          sampledSsim,
          inputTimestampFold: timestampFold(inputFrames.timestamps),
          normalizedInputTimestampFold: timestampFold(webmTimestamps(inputFrames.timestamps)),
          outputTimestampFold: timestampFold(outputFrames.timestamps),
          inputClosedFrames: inputFrames.closedFrames,
          outputClosedFrames: outputFrames.closedFrames,
          playback,
          outputBytes: measured.outputBytes.byteLength,
          outputSha256: await sha256(measured.outputBytes),
          loadedFallbackResources: performance
            .getEntriesByType('resource')
            .map(({ name }) => name)
            .filter(
              (name) =>
                !resourcesBefore.has(name) &&
                (name.includes('replayable-video-decoder') ||
                  name.includes('wasm-vpx-driver') ||
                  name.includes('vpx-core')),
            ),
          profile: measured.profile,
        });
      }
      return {
        userAgent: navigator.userAgent,
        injectedFailFirst: injectFailFirst,
        injectedRuntimeMisses: failFirstState.runtimeMisses,
        rows,
      };
    },
    {
      caseFacts: selectedCases.map(({ id, expectedFrames }) => ({ id, expectedFrames })),
      warmups: WARMUPS,
      samples: SAMPLES,
      injectFailFirst: process.argv.includes('--inject-native-miss'),
    },
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
