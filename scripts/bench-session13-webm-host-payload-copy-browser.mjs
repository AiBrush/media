#!/usr/bin/env node
/** Native-WebCodecs browser control for the exact H.264+Opus prepared-Matroska payload seam. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { chromium } from '../../media-test/node_modules/playwright/index.mjs';

const WARMUP = 3;
const SAMPLES = 9;
const root = process.cwd();
const fixtureRoot = resolve(
  root,
  '../media-test/fixtures/media/scenarios/mux/swap_audio_video_with_opus_to_mkv',
);
const fixtureNames = ['h264_1080p_30s.mp4', 'opus.ogg'];
const fixtures = new Map();
for (const name of fixtureNames) fixtures.set(name, await readFile(resolve(fixtureRoot, name)));

const contentTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.wasm', 'application/wasm'],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>native MKV payload benchmark</title>',
    );
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
  const name = url.pathname.startsWith('/fixture/')
    ? decodeURIComponent(url.pathname.slice('/fixture/'.length))
    : undefined;
  const bytes = name === undefined ? undefined : fixtures.get(name);
  if (bytes === undefined || name === undefined) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-length': String(bytes.byteLength),
    'content-type': contentTypes.get(extname(name)) ?? 'application/octet-stream',
  });
  response.end(bytes);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (address === null || typeof address === 'string')
  throw new Error('benchmark server did not bind');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const report = await page.evaluate(
    async ({ warmup, samples }) => {
      const { createMedia } = await import(`/dist/index.js?run=${Date.now()}`);
      const media = createMedia({ worker: false });

      const median = (values) => {
        const ordered = [...values].sort((left, right) => left - right);
        const value = ordered[Math.floor(ordered.length / 2)];
        if (value === undefined) throw new Error('cannot take median of empty samples');
        return value;
      };
      const drainTrack = async (input, fixture, mediaType) => {
        const demuxStarted = performance.now();
        const demuxed = await media.demux(input);
        const demuxMs = performance.now() - demuxStarted;
        const track = demuxed.tracks.find((candidate) => candidate.mediaType === mediaType);
        if (track === undefined) throw new Error(`${fixture} has no ${mediaType} track`);
        const reader = demuxed.packets(track.id).getReader();
        const packets = [];
        const drainStarted = performance.now();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            packets.push(next.value);
          }
        } finally {
          reader.releaseLock();
          await demuxed.close();
        }
        return { track, packets, demuxMs, drainMs: performance.now() - drainStarted };
      };
      const videoInput = new Uint8Array(
        await (await fetch('/fixture/h264_1080p_30s.mp4')).arrayBuffer(),
      );
      const audioInput = new Uint8Array(await (await fetch('/fixture/opus.ogg')).arrayBuffer());
      const video = await drainTrack(videoInput, 'h264_1080p_30s.mp4', 'video');
      const audio = await drainTrack(audioInput, 'opus.ogg', 'audio');
      const bare = (packets) =>
        packets.map((packet) => ({
          chunk: packet.chunk,
          ...(packet.alpha !== undefined ? { alpha: packet.alpha } : {}),
          ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
          ...(packet.sizeBytes !== undefined ? { sizeBytes: packet.sizeBytes } : {}),
        }));
      const ownedStreams = {
        video: { track: video.track, packetsArray: video.packets },
        audio: { track: audio.track, packetsArray: audio.packets },
      };
      const bareStreams = {
        video: { track: video.track, packetsArray: bare(video.packets) },
        audio: { track: audio.track, packetsArray: bare(audio.packets) },
      };
      const mux = async (streams) => {
        const started = performance.now();
        const output = await media.mux(streams, { container: 'mkv' });
        const bytes = new Uint8Array(await output.arrayBuffer());
        return { bytes, elapsedMs: performance.now() - started };
      };
      const equal = (left, right) => {
        if (left.byteLength !== right.byteLength) return false;
        for (let index = 0; index < left.byteLength; index++) {
          if (left[index] !== right[index]) return false;
        }
        return true;
      };

      const ownedTruth = await mux(ownedStreams);
      const bareTruth = await mux(bareStreams);
      if (!equal(ownedTruth.bytes, bareTruth.bytes)) {
        throw new Error('native packet ownership changed Matroska output bytes');
      }
      for (let index = 0; index < warmup; index++) {
        await mux(ownedStreams);
        await mux(bareStreams);
      }
      const ownedMs = [];
      const bareMs = [];
      const fullOperationMs = [];
      let checksum = 0;
      for (let index = 0; index < samples; index++) {
        const owned = await mux(ownedStreams);
        const bareResult = await mux(bareStreams);
        ownedMs.push(owned.elapsedMs);
        bareMs.push(bareResult.elapsedMs);
        checksum = (checksum + owned.bytes.byteLength + bareResult.bytes.byteLength) >>> 0;
      }
      const fullOperation = async () => {
        const started = performance.now();
        const freshVideo = await drainTrack(videoInput, 'h264_1080p_30s.mp4', 'video');
        const freshAudio = await drainTrack(audioInput, 'opus.ogg', 'audio');
        const output = await mux({
          video: { track: freshVideo.track, packetsArray: freshVideo.packets },
          audio: { track: freshAudio.track, packetsArray: freshAudio.packets },
        });
        return { bytes: output.bytes, elapsedMs: performance.now() - started };
      };
      await fullOperation();
      for (let index = 0; index < 5; index++) {
        const full = await fullOperation();
        if (!equal(ownedTruth.bytes, full.bytes)) {
          throw new Error('fresh full product operation changed Matroska output bytes');
        }
        fullOperationMs.push(full.elapsedMs);
      }
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ownedTruth.bytes));
      return {
        videoPackets: video.packets.length,
        audioPackets: audio.packets.length,
        outputBytes: ownedTruth.bytes.byteLength,
        sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        ownedPacketMedianMs: median(ownedMs),
        bareNativeChunkMedianMs: median(bareMs),
        fullOperationMedianMs: median(fullOperationMs),
        videoDemuxMs: video.demuxMs,
        videoDrainMs: video.drainMs,
        audioDemuxMs: audio.demuxMs,
        audioDrainMs: audio.drainMs,
        checksum,
      };
    },
    { warmup: WARMUP, samples: SAMPLES },
  );
  const expectedDigest = createHash('sha256')
    .update(await readFile(resolve(fixtureRoot, 'h264_1080p_30s.mp4')))
    .digest('hex');
  console.info(
    JSON.stringify(
      {
        benchmark: 'session13-webm-host-payload-copy-browser',
        warmup: WARMUP,
        samples: SAMPLES,
        ...report,
        inputVideoSha256: expectedDigest,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
