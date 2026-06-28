import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { fromBytes } from '../../sources/source.ts';
import { WebmDriver, WebmModule, demuxWebm, parseWebm } from './webm-driver.ts';

const MEDIA_TEST = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;

const GOLDEN_DIR = new URL(
  '../../../../media-test/media-browser-test/fixtures/golden/',
  import.meta.url,
).pathname;

interface GoldenPacket {
  trackIndex: number;
  size: number;
  ptsUs: number;
  dtsUs: number;
  keyframe: boolean;
}

interface PacketRow {
  trackIndex: number;
  ptsUs: number;
  size: number;
  keyframe: boolean;
  digest: string;
}

interface TrimCase {
  id: string;
  asset: string;
  container: 'webm' | 'mkv';
  startUs: number;
  endUs: number;
  toleranceSec: number;
}

async function mediaFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
}

async function goldenPackets(name: string): Promise<GoldenPacket[]> {
  return JSON.parse(await readFile(`${GOLDEN_DIR}${name}.packets.json`, 'utf8')) as GoldenPacket[];
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out;
}

async function outputBytes(
  output: Blob | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
  if (output instanceof ReadableStream) return collect(output);
  throw new Error('expected materialized trim output');
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function packetRows(bytes: Uint8Array): PacketRow[] {
  const demux = demuxWebm(bytes);
  return demux.framesByIndex.flatMap((frames, trackIndex) =>
    frames.map((frame) => ({
      trackIndex,
      ptsUs: frame.timestampUs,
      size: frame.data.byteLength,
      keyframe: frame.keyframe,
      digest: digest(frame.data),
    })),
  );
}

function firstVideoTrackIndex(bytes: Uint8Array): number {
  const info = parseWebm(bytes);
  const index = info.tracks.findIndex((track) => track.mediaType === 'video');
  if (index < 0) throw new Error('expected a video track');
  return index;
}

async function streamCopyTrim(
  bytes: Uint8Array,
  trim: { startUs: number; endUs: number },
  container?: 'webm' | 'mkv',
): Promise<Uint8Array> {
  const streamCopy = WebmDriver.streamCopy;
  if (streamCopy === undefined) throw new Error('WebmDriver.streamCopy must be implemented');
  return collect(
    await streamCopy(
      fromBytes(bytes, { mime: container === 'mkv' ? 'video/x-matroska' : 'video/webm' }),
      {
        ...(container !== undefined ? { container } : {}),
        trim: { startSec: trim.startUs / 1e6, endSec: trim.endUs / 1e6 },
      },
    ),
  );
}

function expectDurationWithin(bytes: Uint8Array, requestedUs: number, toleranceSec: number): void {
  const got = parseWebm(bytes).durationSec;
  const want = requestedUs / 1e6;
  expect(Math.abs(got - want)).toBeLessThanOrEqual(toleranceSec);
}

function assertOutputPacketsAreSourceSubset(source: Uint8Array, output: Uint8Array): void {
  const sourceRows = packetRows(source);
  const outputRows = packetRows(output);
  expect(outputRows.length).toBeGreaterThan(0);
  expect(outputRows.length).toBeLessThan(sourceRows.length);
  const sourceByTrack = new Map<number, string[]>();
  for (const row of sourceRows) {
    const key = `${row.size}:${row.keyframe}:${row.digest}`;
    const list = sourceByTrack.get(row.trackIndex) ?? [];
    list.push(key);
    sourceByTrack.set(row.trackIndex, list);
  }
  for (const row of outputRows) {
    const key = `${row.size}:${row.keyframe}:${row.digest}`;
    const list = sourceByTrack.get(row.trackIndex) ?? [];
    expect(list).toContain(key);
  }
}

describe('WebmDriver.streamCopy — Session 6 R3 keyframe trim', () => {
  const cases: readonly TrimCase[] = [
    {
      id: 'trim/vp9_keyframe_aligned',
      asset: 'vp9_1080p_10s.webm',
      container: 'webm',
      startUs: 1_000_000,
      endUs: 5_000_000,
      toleranceSec: 1.1,
    },
    {
      id: 'trim/mkv_keyframe_aligned',
      asset: 'h264_in_mkv.mkv',
      container: 'mkv',
      startUs: 1_000_000,
      endUs: 5_000_000,
      toleranceSec: 1.1,
    },
    {
      id: 'trim/av1_keyframe_aligned',
      asset: 'av1_720p_5s.webm',
      container: 'webm',
      startUs: 1_000_000,
      endUs: 4_000_000,
      toleranceSec: 0.5,
    },
    {
      id: 'trim/vp8_keyframe_aligned',
      asset: 'vp8_720p_10s.webm',
      container: 'webm',
      startUs: 1_000_000,
      endUs: 5_000_000,
      toleranceSec: 1.1,
    },
    {
      id: 'trim/vp9_alpha_keyframe_aligned',
      asset: 'vp9_alpha.webm',
      container: 'webm',
      startUs: 1_000_000,
      endUs: 3_000_000,
      toleranceSec: 0.5,
    },
  ];

  it.each(cases)(
    '$id re-emits a valid source-family EBML file whose video starts on a keyframe',
    async ({ asset, container, startUs, endUs, toleranceSec }) => {
      const source = await mediaFixture(asset);
      const output = await streamCopyTrim(source, { startUs, endUs });
      const info = parseWebm(output);
      expect(info.container).toBe(container);
      expectDurationWithin(output, endUs - startUs, toleranceSec);
      assertOutputPacketsAreSourceSubset(source, output);

      const videoTrackIndex = firstVideoTrackIndex(output);
      const videoRows = packetRows(output).filter((row) => row.trackIndex === videoTrackIndex);
      expect(videoRows[0]?.keyframe).toBe(true);
      expect(videoRows[0]?.ptsUs).toBe(0);
      expect(videoRows.some((row) => row.ptsUs < 0)).toBe(false);
      if (asset === 'vp9_alpha.webm') {
        const alphaFrames = demuxWebm(output).framesByIndex[videoTrackIndex] ?? [];
        expect(alphaFrames.length).toBeGreaterThan(0);
        expect(alphaFrames.every((frame) => frame.alpha !== undefined)).toBe(true);
      }
    },
  );

  it('trim/vp9_noop_full_range_idempotent reimports against the golden packet table without passthrough', async () => {
    const source = await mediaFixture('vp9_1080p_10s.webm');
    const output = await streamCopyTrim(source, { startUs: 0, endUs: 10_000_000 }, 'webm');
    expect(digest(output)).not.toBe(digest(source));
    expectDurationWithin(output, 10_000_000, 0.05);

    const outputRows = packetRows(output);
    const golden = await goldenPackets('vp9_1080p_10s.webm');
    expect(outputRows).toHaveLength(golden.length);

    const trackIds = new Set(golden.map((packet) => packet.trackIndex));
    for (const trackIndex of trackIds) {
      const gotRows = outputRows.filter((row) => row.trackIndex === trackIndex);
      const wantRows = golden.filter((packet) => packet.trackIndex === trackIndex);
      expect(gotRows).toHaveLength(wantRows.length);
      const gotOrigin = gotRows[0]?.ptsUs ?? 0;
      const wantOrigin = wantRows[0]?.ptsUs ?? 0;
      for (let i = 0; i < wantRows.length; i++) {
        const got = gotRows[i];
        const want = wantRows[i];
        if (got === undefined || want === undefined)
          throw new Error(`missing packet ${trackIndex}:${i}`);
        expect(got.size).toBe(want.size);
        expect(got.keyframe).toBe(want.keyframe);
        expect(Math.abs(got.ptsUs - gotOrigin - (want.ptsUs - wantOrigin))).toBeLessThanOrEqual(
          1000,
        );
      }
    }
  });

  it('public media.trim reaches WebM streamCopy without WebCodecs in Node', async () => {
    const source = await mediaFixture('vp9_1080p_10s.webm');
    const output = await outputBytes(
      await createMedia()
        .use(WebmModule)
        .trim(fromBytes(source, { mime: 'video/webm' }), {
          mode: 'keyframe',
          start: 1,
          end: 5,
        }),
    );
    expect(parseWebm(output).container).toBe('webm');
    expectDurationWithin(output, 4_000_000, 1.1);
    const videoRows = packetRows(output).filter(
      (row) => row.trackIndex === firstVideoTrackIndex(output),
    );
    expect(videoRows[0]?.keyframe).toBe(true);
  });
});
