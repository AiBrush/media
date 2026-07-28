#!/usr/bin/env node
/** Session 13 browser diagnostic for WebCodecs video startup, bounded delivery, and seek. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

// Session 13 qualified local evidence uses enough discarded and measured runs to separate native decoder
// variance from product overhead. Keep these committed rather than accepting fixture-tuned CLI values.
const WARMUPS = 3;
const SAMPLES = 11;
const SEEK_SAMPLES = 11;
const root = process.cwd();
const fixtureRoot = resolve(root, '../media-test/fixtures/media/scenarios/decode-seek');
const cases = [
  {
    id: 'h264-1fps-30s',
    path: 'decode_extreme_fps_1/h264_1fps_30s.mp4',
    bytes: 183_419,
    sha256: '36ad3fd783e4993b751e2aef705f345500faf581d483b5d86a751745e119f46d',
    mime: 'video/mp4',
    boundedFrames: 30,
    fullOutputOracle: true,
  },
  {
    id: 'h264-240fps',
    path: 'decode_extreme_fps_240/video_240fps.mp4',
    bytes: 152_644,
    sha256: '4974dc00c8ffc816657a3cfedc0804c0d7f2045e054a528008c444fb08050eb0',
    mime: 'video/mp4',
    boundedFrames: 240,
    fullOutputOracle: true,
  },
  {
    id: 'h264-vfr',
    path: 'decode_vfr_timing/h264_vfr.mp4',
    bytes: 2_279_109,
    sha256: '0f126ff4956210da801b61aeda6619d6dbf113ba316d3cbcfea103ce9b4e5ea6',
    mime: 'video/mp4',
    boundedFrames: 60,
    seekTargetUs: 4_250_000,
  },
  {
    id: 'vp9-120s',
    path: 'decode_size_large_vp9_120s/large_vp9_1080p_120s.webm',
    bytes: 102_363_592,
    sha256: '3e1647a4fec29df5c0c0080b722c91ee48627af823e262a2eea9136ad6a91a32',
    mime: 'video/webm',
    boundedFrames: 60,
  },
  {
    id: 'h264-zero-seek',
    path: 'seek_negative/h264_1080p_30s.mp4',
    bytes: 31_258_790,
    sha256: '6d9562aa3b0d3bdd5cb67647fa71fef2f676ddfd2d375d8048e4e967d95bdf03',
    mime: 'video/mp4',
    seekTargetUs: 0,
  },
];

const fixtureById = new Map();
for (const benchmarkCase of cases) {
  const bytes = await readFile(resolve(fixtureRoot, benchmarkCase.path));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== benchmarkCase.bytes || digest !== benchmarkCase.sha256) {
    throw new Error(`${benchmarkCase.id}: fixture integrity mismatch`);
  }
  fixtureById.set(benchmarkCase.id, bytes);
}

const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>decoder startup benchmark</title>');
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
  const id = url.pathname.startsWith('/fixture/')
    ? decodeURIComponent(url.pathname.slice('/fixture/'.length))
    : undefined;
  const fixture = id === undefined ? undefined : fixtureById.get(id);
  const benchmarkCase = id === undefined ? undefined : cases.find((item) => item.id === id);
  if (fixture === undefined || benchmarkCase === undefined) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-length': String(fixture.byteLength),
    'content-type': benchmarkCase.mime,
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
    async ({ benchmarkCases, warmups, samples, seekSamples }) => {
      const { createMedia } = await import(`/dist/index.js?run=${Date.now()}`);
      const media = createMedia({ worker: false });
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
      const foldTimestamp = (fold, timestamp) => (fold + timestamp) % 1_000_000_007;
      const sameTruth = (left, right) =>
        left.frames === right.frames &&
        left.closedFrames === right.closedFrames &&
        left.timestampFold === right.timestampFold;
      const sameFrameClocks = (left, right) =>
        left.length === right.length &&
        left.every(
          (clock, index) =>
            clock.timestamp === right[index]?.timestamp &&
            clock.duration === right[index]?.duration,
        );

      const fetchFixture = async (id) =>
        new Uint8Array(await (await fetch(`/fixture/${encodeURIComponent(id)}`)).arrayBuffer());

      const publicDrain = async (input, limit, copyRgba) => {
        const stream = media.decode(input).video;
        if (stream === undefined) throw new Error('decode returned no video stream');
        const reader = stream.getReader();
        let frames = 0;
        let closedFrames = 0;
        let timestampFold = 0;
        let byteFold = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            const frame = next.value;
            try {
              timestampFold = foldTimestamp(timestampFold, frame.timestamp);
              if (copyRgba) {
                const rgba = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
                await frame.copyTo(rgba, { format: 'RGBA' });
                byteFold = (byteFold + (rgba[0] ?? 0) + (rgba[rgba.length - 1] ?? 0)) >>> 0;
              }
              frames++;
            } finally {
              frame.close();
              closedFrames++;
            }
            if (frames >= limit) {
              await reader.cancel();
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (closedFrames !== frames) {
          throw new Error(`public decode closed ${closedFrames}/${frames} delivered frames`);
        }
        return { frames, closedFrames, timestampFold, byteFold };
      };

      // Keep the cryptographic pixel oracle outside timed samples: hashing is validation work, not decode
      // throughput. One frame digest at a time bounds transient storage to one RGBA plane plus the small
      // 32-byte-per-frame digest chain; decoded GPU surfaces are never retained across iterations.
      const digestPublicFrames = async (input, limit) => {
        const stream = media.decode(input).video;
        if (stream === undefined) throw new Error('decode returned no video stream');
        const reader = stream.getReader();
        const frameDigests = [];
        const frameClocks = [];
        let frames = 0;
        let closedFrames = 0;
        let timestampFold = 0;
        try {
          while (frames < limit) {
            const next = await reader.read();
            if (next.done) break;
            const frame = next.value;
            try {
              timestampFold = foldTimestamp(timestampFold, frame.timestamp);
              frameClocks.push({ timestamp: frame.timestamp, duration: frame.duration });
              const rgba = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
              await frame.copyTo(rgba, { format: 'RGBA' });
              const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rgba));
              frameDigests.push(digest);
              frames++;
            } finally {
              frame.close();
              closedFrames++;
            }
          }
          if (frames >= limit) await reader.cancel();
        } finally {
          reader.releaseLock();
        }
        if (closedFrames !== frames) {
          throw new Error(`pixel oracle closed ${closedFrames}/${frames} delivered frames`);
        }
        const digestChain = new Uint8Array(frameDigests.length * 32);
        frameDigests.forEach((digest, index) => digestChain.set(digest, index * 32));
        const aggregate = new Uint8Array(await crypto.subtle.digest('SHA-256', digestChain));
        return {
          frames,
          closedFrames,
          timestampFold,
          frameClocks,
          rgbaSha256: [...aggregate].map((value) => value.toString(16).padStart(2, '0')).join(''),
        };
      };

      const collectPackets = async (input) => {
        const demuxed = await media.demux(input);
        const track = demuxed.tracks.find((candidate) => candidate.mediaType === 'video');
        if (track?.config === undefined)
          throw new Error('demux returned no configured video track');
        const reader = demuxed.packets(track.id).getReader();
        const chunks = [];
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            chunks.push(next.value.chunk);
          }
        } finally {
          reader.releaseLock();
          await demuxed.close();
        }
        return { config: track.config, chunks };
      };

      const decoderState = () => ({
        frames: 0,
        closedFrames: 0,
        timestampFold: 0,
        error: undefined,
      });
      const createDecoder = (state) =>
        new VideoDecoder({
          output(frame) {
            state.frames++;
            state.timestampFold = foldTimestamp(state.timestampFold, frame.timestamp);
            frame.close();
            state.closedFrames++;
          },
          error(error) {
            state.error = error;
          },
        });
      const throwDecoderError = (state) => {
        if (state.error !== undefined) throw state.error;
      };
      const decodeNative = async (decoder, state, chunks) => {
        state.frames = 0;
        state.closedFrames = 0;
        state.timestampFold = 0;
        state.error = undefined;
        const started = performance.now();
        for (const chunk of chunks) decoder.decode(chunk);
        await decoder.flush();
        throwDecoderError(state);
        if (state.closedFrames !== state.frames) {
          throw new Error(`native decode closed ${state.closedFrames}/${state.frames} frames`);
        }
        return {
          elapsedMs: performance.now() - started,
          truth: {
            frames: state.frames,
            closedFrames: state.closedFrames,
            timestampFold: state.timestampFold,
          },
        };
      };

      const decodeNativeFrameClocks = async (config, chunks) => {
        const frameClocks = [];
        let closedFrames = 0;
        let decoderError;
        const decoder = new VideoDecoder({
          output(frame) {
            try {
              frameClocks.push({ timestamp: frame.timestamp, duration: frame.duration });
            } finally {
              frame.close();
              closedFrames++;
            }
          },
          error(error) {
            decoderError = error;
          },
        });
        try {
          decoder.configure(config);
          await decoder.flush();
          if (decoderError !== undefined) throw decoderError;
          for (const chunk of chunks) decoder.decode(chunk);
          await decoder.flush();
          if (decoderError !== undefined) throw decoderError;
        } finally {
          if (decoder.state !== 'closed') decoder.close();
        }
        if (closedFrames !== frameClocks.length) {
          throw new Error(
            `native clock oracle closed ${closedFrames}/${frameClocks.length} delivered frames`,
          );
        }
        return { frames: frameClocks.length, closedFrames, frameClocks };
      };

      const rows = [];
      for (const benchmarkCase of benchmarkCases.filter(
        (item) => item.boundedFrames !== undefined,
      )) {
        const input = await fetchFixture(benchmarkCase.id);
        const { config, chunks } = await collectPackets(input);
        const support = await VideoDecoder.isConfigSupported({
          ...config,
          hardwareAcceleration: 'prefer-hardware',
        });
        if (!support.supported) {
          throw new Error(`${benchmarkCase.id}: prefer-hardware decoder is unsupported`);
        }
        const exactConfig = {
          ...config,
          hardwareAcceleration: support.config.hardwareAcceleration ?? 'prefer-hardware',
        };
        const publicFullMs = [];
        const publicBoundedMs = [];
        const rgbaBoundedMs = [];
        let publicFullTruth;
        let publicBoundedTruth;
        let rgbaBoundedTruth;
        for (let index = 0; index < warmups + samples; index++) {
          let started = performance.now();
          const fullTruth = await publicDrain(input, Number.POSITIVE_INFINITY, false);
          const fullMs = performance.now() - started;
          started = performance.now();
          const boundedTruth = await publicDrain(input, benchmarkCase.boundedFrames, false);
          const boundedMs = performance.now() - started;
          started = performance.now();
          const rgbaTruth = await publicDrain(input, benchmarkCase.boundedFrames, true);
          const rgbaMs = performance.now() - started;
          if (index >= warmups) {
            publicFullMs.push(fullMs);
            publicBoundedMs.push(boundedMs);
            rgbaBoundedMs.push(rgbaMs);
          }
          publicFullTruth = fullTruth;
          publicBoundedTruth = boundedTruth;
          rgbaBoundedTruth = rgbaTruth;
        }

        const freshStartupMs = [];
        const freshDecodeMs = [];
        let freshTruth;
        for (let index = 0; index < warmups + samples; index++) {
          const state = decoderState();
          const decoder = createDecoder(state);
          const started = performance.now();
          decoder.configure(exactConfig);
          await decoder.flush();
          throwDecoderError(state);
          const startupMs = performance.now() - started;
          const decoded = await decodeNative(decoder, state, chunks);
          decoder.close();
          if (index >= warmups) {
            freshStartupMs.push(startupMs);
            freshDecodeMs.push(decoded.elapsedMs);
          }
          freshTruth = decoded.truth;
        }

        const reusedState = decoderState();
        const reusedDecoder = createDecoder(reusedState);
        reusedDecoder.configure(exactConfig);
        await reusedDecoder.flush();
        throwDecoderError(reusedState);
        const reusedDecodeMs = [];
        let reusedTruth;
        for (let index = 0; index < warmups + samples; index++) {
          const decoded = await decodeNative(reusedDecoder, reusedState, chunks);
          if (index >= warmups) reusedDecodeMs.push(decoded.elapsedMs);
          reusedTruth = decoded.truth;
        }
        reusedDecoder.close();
        const expectedFull = {
          frames: publicFullTruth.frames,
          closedFrames: publicFullTruth.closedFrames,
          timestampFold: publicFullTruth.timestampFold,
        };
        if (!sameTruth(expectedFull, freshTruth) || !sameTruth(expectedFull, reusedTruth)) {
          throw new Error(`${benchmarkCase.id}: fresh/reused decoder changed output truth`);
        }
        if (
          publicBoundedTruth.frames !== benchmarkCase.boundedFrames ||
          rgbaBoundedTruth.frames !== benchmarkCase.boundedFrames ||
          publicBoundedTruth.closedFrames !== publicBoundedTruth.frames ||
          rgbaBoundedTruth.closedFrames !== rgbaBoundedTruth.frames ||
          publicBoundedTruth.timestampFold !== rgbaBoundedTruth.timestampFold
        ) {
          throw new Error(`${benchmarkCase.id}: bounded RGBA diagnostic changed frame truth`);
        }
        const pixelTruth = await digestPublicFrames(
          input,
          benchmarkCase.fullOutputOracle === true
            ? Number.POSITIVE_INFINITY
            : Math.min(12, benchmarkCase.boundedFrames),
        );
        let nativeClockTruth;
        if (benchmarkCase.fullOutputOracle === true) {
          nativeClockTruth = await decodeNativeFrameClocks(exactConfig, chunks);
          if (
            pixelTruth.frames !== expectedFull.frames ||
            pixelTruth.closedFrames !== expectedFull.closedFrames ||
            pixelTruth.timestampFold !== expectedFull.timestampFold ||
            nativeClockTruth.frames !== pixelTruth.frames ||
            nativeClockTruth.closedFrames !== nativeClockTruth.frames ||
            !sameFrameClocks(pixelTruth.frameClocks, nativeClockTruth.frameClocks)
          ) {
            throw new Error(`${benchmarkCase.id}: full output oracle changed frame-clock truth`);
          }
        }
        rows.push({
          id: benchmarkCase.id,
          inputBytes: input.byteLength,
          codec: config.codec,
          packets: chunks.length,
          boundedFrames: benchmarkCase.boundedFrames,
          publicFullMedianMs: median(publicFullMs),
          publicFullMadMs: mad(publicFullMs),
          publicFullMs,
          publicBoundedMedianMs: median(publicBoundedMs),
          publicBoundedMadMs: mad(publicBoundedMs),
          publicBoundedMs,
          rgbaBoundedMedianMs: median(rgbaBoundedMs),
          rgbaBoundedMadMs: mad(rgbaBoundedMs),
          rgbaBoundedMs,
          freshStartupMedianMs: median(freshStartupMs),
          freshStartupMadMs: mad(freshStartupMs),
          freshStartupMs,
          freshDecodeMedianMs: median(freshDecodeMs),
          freshDecodeMadMs: mad(freshDecodeMs),
          freshDecodeMs,
          reusedDecodeMedianMs: median(reusedDecodeMs),
          reusedDecodeMadMs: mad(reusedDecodeMs),
          reusedDecodeMs,
          truth: expectedFull,
          outputOracle: benchmarkCase.fullOutputOracle === true ? 'full' : 'prefix-12',
          pixelTruth,
          ...(nativeClockTruth === undefined ? {} : { nativeClockTruth }),
          rgbaByteFold: rgbaBoundedTruth.byteFold,
        });
      }

      const seekRows = [];
      for (const benchmarkCase of benchmarkCases.filter(
        (item) => item.seekTargetUs !== undefined,
      )) {
        const input = await fetchFixture(benchmarkCase.id);
        const wallMs = [];
        let landedUs = 0;
        let closedFrames = 0;
        for (let index = 0; index < warmups + seekSamples; index++) {
          const started = performance.now();
          const frame = await media.seek(input, benchmarkCase.seekTargetUs);
          const elapsedMs = performance.now() - started;
          landedUs = frame.timestamp;
          frame.close();
          closedFrames++;
          if (index >= warmups) wallMs.push(elapsedMs);
        }
        seekRows.push({
          id: benchmarkCase.id,
          inputBytes: input.byteLength,
          targetUs: benchmarkCase.seekTargetUs,
          landedUs,
          closedFrames,
          medianMs: median(wallMs),
          madMs: mad(wallMs),
          wallMs,
        });
      }
      return { userAgent: navigator.userAgent, rows, seekRows };
    },
    {
      benchmarkCases: cases.map(({ id, boundedFrames, seekTargetUs, fullOutputOracle }) => ({
        id,
        ...(boundedFrames === undefined ? {} : { boundedFrames }),
        ...(seekTargetUs === undefined ? {} : { seekTargetUs }),
        ...(fullOutputOracle === undefined ? {} : { fullOutputOracle }),
      })),
      warmups: WARMUPS,
      samples: SAMPLES,
      seekSamples: SEEK_SAMPLES,
    },
  );
  const compactReport = {
    ...report,
    rows: report.rows.map(({ nativeClockTruth, pixelTruth, ...row }) => ({
      ...row,
      ...(nativeClockTruth === undefined
        ? {}
        : {
            nativeClockTruth: {
              closedFrames: nativeClockTruth.closedFrames,
              frames: nativeClockTruth.frames,
            },
          }),
      ...(pixelTruth === undefined
        ? {}
        : {
            pixelTruth: {
              closedFrames: pixelTruth.closedFrames,
              frames: pixelTruth.frames,
              rgbaSha256: pixelTruth.rgbaSha256,
              timestampFold: pixelTruth.timestampFold,
            },
          }),
    })),
  };
  console.info(
    JSON.stringify(
      {
        benchmark: 'session13-video-decoder-startup-browser',
        warmups: WARMUPS,
        samples: SAMPLES,
        seekSamples: SEEK_SAMPLES,
        ...compactReport,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
