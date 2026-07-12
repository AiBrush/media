#!/usr/bin/env node
/** Product-only H.264 encoder profile: acceleration, latency, queue, closure, and mux-tail attribution. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUPS = 1;
const SAMPLES = 7;
const root = process.cwd();
const allowSourceDurationReprojection = process.argv.includes(
  '--allow-source-duration-reprojection',
);

const cases = [
  {
    id: 'contested-h264-mkv-av',
    path: resolve(root, '../media-test/fixtures/media/scenarios/transcode/h264_to_mkv/01.mp4'),
    sha256: 'f9bac3dfa3d73a9011439b9bd2d267bf7d3385d6960de40863afe142cfe1b00f',
    bytes: 3_666_807,
    expectedFrames: 321,
    output: { to: 'mkv', video: { codec: 'h264' }, audio: {} },
  },
  {
    id: 'encode-fps-h264-1080p30',
    path: resolve(root, '../media-test/fixtures/media/h264_1080p_30s.mp4'),
    sha256: '6d9562aa3b0d3bdd5cb67647fa71fef2f676ddfd2d375d8048e4e967d95bdf03',
    bytes: 31_258_790,
    expectedFrames: 900,
    output: { to: 'mp4', video: { codec: 'h264' }, audio: false },
  },
  {
    id: 'control-h264-720p',
    path: resolve(root, 'fixtures/media/bear-1280x720.mp4'),
    sha256: 'bcb75d3db0a1a5056f4cd5c770ceccdb4cae920f21abb8139b29cd9ad39e3857',
    bytes: 715_963,
    expectedFrames: 82,
    output: { to: 'mp4', video: { codec: 'h264' }, audio: false },
  },
  {
    id: 'control-h264-vfr',
    path: resolve(root, 'fixtures/media/obs-remux-variable-aac.mp4'),
    sha256: '9bd7f8cb1372078f9b23aa4c80751926f8c5e2db6b5587459f0892785175ddcf',
    bytes: 4_777_511,
    expectedFrames: 377,
    output: { to: 'mp4', video: { codec: 'h264' }, audio: false },
  },
];

const variants = [
  { id: 'current', preferHardware: false, realtime: false },
  { id: 'prefer-hardware', preferHardware: true, realtime: false },
  { id: 'realtime', preferHardware: false, realtime: true },
  { id: 'quality', preferHardware: false, realtime: false, quality: true },
  { id: 'prefer-hardware-realtime', preferHardware: true, realtime: true },
];

const requestedCase = process.argv
  .find((argument) => argument.startsWith('--case='))
  ?.slice('--case='.length);
const selectedCases =
  requestedCase === undefined ? cases : cases.filter(({ id }) => id === requestedCase);
if (selectedCases.length === 0) throw new Error(`unknown benchmark case '${requestedCase}'`);
const requestedVariants = process.argv
  .find((argument) => argument.startsWith('--variants='))
  ?.slice('--variants='.length)
  .split(',');
const selectedVariants =
  requestedVariants === undefined
    ? variants
    : variants.filter(({ id }) => requestedVariants.includes(id));
if (selectedVariants.length === 0) throw new Error('no recognized benchmark variants selected');

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
    response.end('<!doctype html><meta charset="utf-8"><title>H.264 encode profile</title>');
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
  const prefix = '/fixture/';
  const id = url.pathname.startsWith(prefix)
    ? decodeURIComponent(url.pathname.slice(prefix.length))
    : undefined;
  const bytes = id === undefined ? undefined : fixtureBytes.get(id);
  if (bytes === undefined) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-length': String(bytes.byteLength),
    'content-type': 'video/mp4',
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
    async ({ caseFacts, variantFacts, warmups, samples, allowDurationReprojection }) => {
      const { createMedia } = await import(`/dist/index.js?h264-profile=${Date.now()}`);
      const media = createMedia({ worker: false });

      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('cannot take median of no samples');
        return value;
      };
      const sameNumbers = (left, right) =>
        left.length === right.length && left.every((value, index) => value === right[index]);
      const normalizedTimeline = (timestamps) => {
        const first = timestamps[0] ?? 0;
        return timestamps.map((timestamp) => Math.round((timestamp - first) / 1_000) * 1_000);
      };
      const normalizedPacketRows = (timestamps, durations) => {
        const first = Math.min(...timestamps);
        return timestamps
          .map((timestamp, index) => [
            Math.round((timestamp - first) / 1_000) * 1_000,
            durations[index] === null || durations[index] === undefined
              ? null
              : Math.round(durations[index] / 1_000) * 1_000,
          ])
          .sort((left, right) => left[0] - right[0]);
      };
      const sampleIndices = (frameCount) =>
        new Set(
          Array.from({ length: Math.min(12, frameCount) }, (_, index) =>
            Math.round((index * (frameCount - 1)) / Math.max(1, Math.min(12, frameCount) - 1)),
          ),
        );
      const lumaSample = async (frame) => {
        const width = frame.displayWidth;
        const height = frame.displayHeight;
        const rgba = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
        const [layout] = await frame.copyTo(rgba, { format: 'RGBA' });
        if (layout === undefined) throw new Error('RGBA copy returned no plane layout');
        const step = Math.max(1, Math.floor(Math.min(width, height) / 128));
        const values = [];
        for (let y = 0; y < height; y += step) {
          const row = layout.offset + y * layout.stride;
          for (let x = 0; x < width; x += step) {
            const offset = row + x * 4;
            const red = rgba[offset];
            const green = rgba[offset + 1];
            const blue = rgba[offset + 2];
            if (red === undefined || green === undefined || blue === undefined) {
              throw new Error('RGBA layout exceeded its allocation');
            }
            values.push(red * 0.2126 + green * 0.7152 + blue * 0.0722);
          }
        }
        return values;
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
        if (track === undefined) throw new Error('output has no video track');
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
          durationSec: track.durationSec,
          timestamps,
          durations,
          keyframes,
        };
      };
      const decodeTruth = async (bytes, expectedFrames) => {
        const streams = media.decode(bytes);
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
              if (wanted.has(index)) samplesByIndex.push([index, await lumaSample(frame)]);
            } finally {
              frame.close();
              closedFrames++;
            }
            index++;
          }
        } finally {
          reader.releaseLock();
          await streams.audio.cancel('video profile consumed only video').catch(() => {});
        }
        return { frameCount: index, closedFrames, timestamps, samplesByIndex };
      };
      const playbackSmoke = async (bytes, container) => {
        if (container !== 'mp4')
          return { skipped: 'HTML playback is not claimed for H.264 Matroska' };
        const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
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

      const tracedConvert = async (input, outputOptions, variant) => {
        const profile = {
          decoderConfigs: [],
          encoderConfigs: [],
          decodeQueues: [],
          encodeQueues: [],
          decodeCalls: 0,
          encodeCalls: 0,
          firstDecodeMs: null,
          firstEncodeMs: null,
          decoderFlushEndMs: null,
          encoderFlushEndMs: null,
          submittedFrames: new Set(),
          submittedCount: 0,
          submittedClosedCount: 0,
          duplicateSubmissions: 0,
          duplicateCloses: 0,
          closedFrames: new WeakSet(),
          encodedCopyCalls: 0,
          encodedCopyMs: 0,
          encodedBytesCopied: 0,
        };
        const decoderConfigure = VideoDecoder.prototype.configure;
        const decoderDecode = VideoDecoder.prototype.decode;
        const decoderFlush = VideoDecoder.prototype.flush;
        const encoderConfigure = VideoEncoder.prototype.configure;
        const encoderEncode = VideoEncoder.prototype.encode;
        const encoderFlush = VideoEncoder.prototype.flush;
        const frameClose = VideoFrame.prototype.close;
        const encodedCopyTo = EncodedVideoChunk.prototype.copyTo;
        VideoDecoder.prototype.configure = function configure(config) {
          profile.decoderConfigs.push({
            codec: config.codec,
            hardwareAcceleration: config.hardwareAcceleration ?? null,
          });
          return decoderConfigure.call(this, config);
        };
        VideoDecoder.prototype.decode = function decode(chunk) {
          profile.firstDecodeMs ??= performance.now();
          profile.decodeQueues.push(this.decodeQueueSize);
          profile.decodeCalls++;
          return decoderDecode.call(this, chunk);
        };
        VideoDecoder.prototype.flush = async function flush() {
          const result = await decoderFlush.call(this);
          profile.decoderFlushEndMs = performance.now();
          return result;
        };
        VideoEncoder.prototype.configure = function configure(config) {
          const wire = {
            ...config,
            ...(variant.preferHardware ? { hardwareAcceleration: 'prefer-hardware' } : {}),
            ...(variant.realtime ? { latencyMode: 'realtime' } : {}),
            ...(variant.quality ? { latencyMode: 'quality' } : {}),
          };
          profile.encoderConfigs.push({
            codec: wire.codec,
            width: wire.width,
            height: wire.height,
            framerate: wire.framerate ?? null,
            bitrate: wire.bitrate ?? null,
            bitrateMode: wire.bitrateMode ?? null,
            latencyMode: wire.latencyMode ?? null,
            hardwareAcceleration: wire.hardwareAcceleration ?? null,
          });
          return encoderConfigure.call(this, wire);
        };
        VideoEncoder.prototype.encode = function encode(frame, options) {
          profile.firstEncodeMs ??= performance.now();
          profile.encodeQueues.push(this.encodeQueueSize);
          if (profile.submittedFrames.has(frame)) profile.duplicateSubmissions++;
          profile.submittedFrames.add(frame);
          profile.submittedCount++;
          profile.encodeCalls++;
          return encoderEncode.call(this, frame, options);
        };
        VideoEncoder.prototype.flush = async function flush() {
          const result = await encoderFlush.call(this);
          profile.encoderFlushEndMs = performance.now();
          return result;
        };
        VideoFrame.prototype.close = function close() {
          if (profile.closedFrames.has(this)) {
            profile.duplicateCloses++;
          } else {
            profile.closedFrames.add(this);
            if (profile.submittedFrames.delete(this)) profile.submittedClosedCount++;
          }
          return frameClose.call(this);
        };
        EncodedVideoChunk.prototype.copyTo = function copyTo(destination) {
          const started = performance.now();
          const result = encodedCopyTo.call(this, destination);
          profile.encodedCopyMs += performance.now() - started;
          profile.encodedCopyCalls++;
          profile.encodedBytesCopied += this.byteLength;
          return result;
        };
        const started = performance.now();
        try {
          const output = await media.convert(input, outputOptions);
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
              maxDecodeQueueBefore: Math.max(0, ...profile.decodeQueues),
              maxEncodeQueueBefore: Math.max(0, ...profile.encodeQueues),
              pipelineStartupMs:
                profile.firstDecodeMs === null || profile.firstEncodeMs === null
                  ? null
                  : profile.firstEncodeMs - profile.firstDecodeMs,
              encodeToFlushMs:
                profile.firstEncodeMs === null || profile.encoderFlushEndMs === null
                  ? null
                  : profile.encoderFlushEndMs - profile.firstEncodeMs,
              decodeToFlushMs:
                profile.firstDecodeMs === null || profile.decoderFlushEndMs === null
                  ? null
                  : profile.decoderFlushEndMs - profile.firstDecodeMs,
              muxMaterializeTailMs:
                profile.encoderFlushEndMs === null ? null : ended - profile.encoderFlushEndMs,
              submittedCount: profile.submittedCount,
              submittedClosedCount: profile.submittedClosedCount,
              pendingSubmittedFrames: profile.submittedFrames.size,
              duplicateSubmissions: profile.duplicateSubmissions,
              duplicateCloses: profile.duplicateCloses,
              encodedCopyCalls: profile.encodedCopyCalls,
              encodedCopyMs: profile.encodedCopyMs,
              encodedBytesCopied: profile.encodedBytesCopied,
            },
          };
        } finally {
          VideoDecoder.prototype.configure = decoderConfigure;
          VideoDecoder.prototype.decode = decoderDecode;
          VideoDecoder.prototype.flush = decoderFlush;
          VideoEncoder.prototype.configure = encoderConfigure;
          VideoEncoder.prototype.encode = encoderEncode;
          VideoEncoder.prototype.flush = encoderFlush;
          VideoFrame.prototype.close = frameClose;
          EncodedVideoChunk.prototype.copyTo = encodedCopyTo;
        }
      };

      const rows = [];
      for (const facts of caseFacts) {
        const input = new Uint8Array(
          await (await fetch(`/fixture/${encodeURIComponent(facts.id)}`)).arrayBuffer(),
        );
        const inputPackets = await packetTruth(input);
        const inputFrames = await decodeTruth(input, facts.expectedFrames);
        if (
          inputPackets.timestamps.length !== facts.expectedFrames ||
          inputFrames.frameCount !== facts.expectedFrames ||
          inputFrames.closedFrames !== facts.expectedFrames
        ) {
          throw new Error(`${facts.id}: input frame truth mismatch`);
        }
        const sourceSamples = new Map(inputFrames.samplesByIndex);
        const measurements = Object.fromEntries(
          variantFacts.map((variant) => [variant.id, { walls: [], last: undefined }]),
        );
        for (let round = 0; round < warmups + samples; round++) {
          const order = round % 2 === 0 ? variantFacts : [...variantFacts].reverse();
          for (const variant of order) {
            const result = await tracedConvert(input, facts.output, variant);
            const bucket = measurements[variant.id];
            if (bucket === undefined) throw new Error(`missing variant bucket ${variant.id}`);
            if (round >= warmups) bucket.walls.push(result.wallMs);
            bucket.last = result;
          }
        }
        const variantRows = [];
        const outputPacketRowsByVariant = new Map();
        for (const variant of variantFacts) {
          const bucket = measurements[variant.id];
          if (bucket?.last === undefined) throw new Error(`${facts.id}/${variant.id}: no output`);
          const outputPackets = await packetTruth(bucket.last.outputBytes);
          const outputFrames = await decodeTruth(bucket.last.outputBytes, facts.expectedFrames);
          const normalizedInput = normalizedTimeline(inputFrames.timestamps);
          const normalizedOutput = normalizedTimeline(outputFrames.timestamps);
          const inputPacketRows = normalizedPacketRows(
            inputPackets.timestamps,
            inputPackets.durations,
          );
          const outputPacketRows = normalizedPacketRows(
            outputPackets.timestamps,
            outputPackets.durations,
          );
          const frameTimelineMatches = sameNumbers(normalizedInput, normalizedOutput);
          const packetTimelineMatches =
            JSON.stringify(inputPacketRows) === JSON.stringify(outputPacketRows);
          const packetPtsMatch = sameNumbers(
            inputPacketRows.map(([timestamp]) => timestamp),
            outputPacketRows.map(([timestamp]) => timestamp),
          );
          if (
            outputPackets.timestamps.length !== facts.expectedFrames ||
            outputFrames.frameCount !== facts.expectedFrames ||
            outputFrames.closedFrames !== facts.expectedFrames ||
            outputPackets.keyframes[0] !== true ||
            !frameTimelineMatches ||
            !packetPtsMatch ||
            (!packetTimelineMatches && !allowDurationReprojection)
          ) {
            const firstFrameMismatch = normalizedInput.findIndex(
              (value, index) => value !== normalizedOutput[index],
            );
            const firstPacketMismatch = inputPacketRows.findIndex(
              (value, index) => JSON.stringify(value) !== JSON.stringify(outputPacketRows[index]),
            );
            throw new Error(
              `${facts.id}/${variant.id}: output invariant failed ${JSON.stringify({
                expectedFrames: facts.expectedFrames,
                outputPackets: outputPackets.timestamps.length,
                outputFrames: outputFrames.frameCount,
                closedFrames: outputFrames.closedFrames,
                firstKey: outputPackets.keyframes[0],
                frameTimelineMatches,
                firstFrameMismatch,
                inputFrameAtMismatch: normalizedInput[firstFrameMismatch],
                outputFrameAtMismatch: normalizedOutput[firstFrameMismatch],
                packetTimelineMatches,
                packetPtsMatch,
                firstPacketMismatch,
                inputPacketAtMismatch: inputPacketRows[firstPacketMismatch],
                outputPacketAtMismatch: outputPacketRows[firstPacketMismatch],
              })}`,
            );
          }
          const sampledSsim = outputFrames.samplesByIndex.map(([index, output]) => {
            const source = sourceSamples.get(index);
            if (source === undefined) throw new Error(`missing source sample ${index}`);
            return ssim(source, output);
          });
          const minimumSampledSsim = Math.min(...sampledSsim);
          if (!(minimumSampledSsim >= 0.95)) {
            throw new Error(
              `${facts.id}/${variant.id}: minimum sampled SSIM ${minimumSampledSsim}`,
            );
          }
          const playback = await playbackSmoke(bucket.last.outputBytes, facts.output.to);
          outputPacketRowsByVariant.set(variant.id, JSON.stringify(outputPacketRows));
          const support = await Promise.all(
            bucket.last.profile.encoderConfigs.map(async (config) => {
              const result = await VideoEncoder.isConfigSupported(config);
              return {
                supported: result.supported,
                acceptedHardwareAcceleration: result.config?.hardwareAcceleration ?? null,
                acceptedLatencyMode: result.config?.latencyMode ?? null,
              };
            }),
          );
          variantRows.push({
            id: variant.id,
            medianWallMs: median(bucket.walls),
            wallMs: bucket.walls,
            outputBytes: bucket.last.outputBytes.byteLength,
            outputTrack: {
              codec: outputPackets.codec,
              width: outputPackets.width,
              height: outputPackets.height,
              fps: outputPackets.fps,
              durationSec: outputPackets.durationSec,
              packetCount: outputPackets.timestamps.length,
            },
            minimumSampledSsim,
            sampledSsim,
            playback,
            sourcePacketDurationProjectionMatches: packetTimelineMatches,
            sourceFirstPacketDurationUs: inputPacketRows[0]?.[1] ?? null,
            outputFirstPacketDurationUs: outputPacketRows[0]?.[1] ?? null,
            support,
            profile: bucket.last.profile,
          });
        }
        if (allowDurationReprojection && variantRows.length > 1) {
          const firstVariant = variantFacts[0];
          const baseline =
            firstVariant === undefined ? undefined : outputPacketRowsByVariant.get(firstVariant.id);
          if (
            baseline === undefined ||
            variantFacts.some((variant) => outputPacketRowsByVariant.get(variant.id) !== baseline)
          ) {
            throw new Error(
              `${facts.id}: latency modes produced different packet PTS/duration rows`,
            );
          }
        }
        rows.push({ id: facts.id, warmups, samples, variants: variantRows });
      }
      return rows;
    },
    {
      caseFacts: selectedCases,
      variantFacts: selectedVariants,
      warmups: WARMUPS,
      samples: SAMPLES,
      allowDurationReprojection: allowSourceDurationReprojection,
    },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
  server.close();
}
