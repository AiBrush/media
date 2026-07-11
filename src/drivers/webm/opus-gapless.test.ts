import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { PacketStreams } from '../../api/types.ts';
import type { VideoColorMetadata } from '../../contracts/driver.ts';
import { fromBytes } from '../../sources/source.ts';
import { WebmDriver, demuxWebm } from './webm-driver.ts';

const ROTATION_ROOT = new URL(
  '../../../../media-test/fixtures/media/scenarios/mux/prop_vp9_decode_mux_webm_to_webm/',
  import.meta.url,
).pathname;
const CONTROL_ROOT = new URL('../../../fixtures/media/', import.meta.url).pathname;
const TRUTH_PATH = new URL('../../../fixtures/golden/webm-opus-gapless-truth.json', import.meta.url)
  .pathname;

interface GaplessTruthFile {
  readonly name: string;
  readonly sha256: string;
  readonly leadingSamples: number;
  readonly trailingSamples: number;
  readonly totalSamples: number;
}

interface GaplessTruth {
  readonly sampleRate: number;
  readonly channels: number;
  readonly files: readonly GaplessTruthFile[];
}

class TestEncodedChunk {
  readonly type: EncodedVideoChunkType | EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: EncodedVideoChunkInit | EncodedAudioChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = ArrayBuffer.isView(init.data)
      ? new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength).slice()
      : new Uint8Array(init.data).slice();
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: BufferSource): void {
    const target = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    target.set(this.#data);
  }
}

async function withEncodedChunks<T>(fn: () => Promise<T>): Promise<T> {
  const video = globalThis.EncodedVideoChunk;
  const audio = globalThis.EncodedAudioChunk;
  const chunkConstructor = TestEncodedChunk as unknown as typeof EncodedVideoChunk &
    typeof EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: chunkConstructor,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    value: chunkConstructor,
  });
  try {
    return await fn();
  } finally {
    if (video === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    else
      Object.defineProperty(globalThis, 'EncodedVideoChunk', {
        configurable: true,
        value: video,
      });
    if (audio === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        value: audio,
      });
  }
}

async function truth(): Promise<GaplessTruth> {
  return JSON.parse(await readFile(TRUTH_PATH, 'utf8')) as GaplessTruth;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function frameManifest(bytes: Uint8Array, trackIndex: number): readonly string[] {
  const frames = demuxWebm(bytes).framesByIndex[trackIndex] ?? [];
  return frames.map(
    (frame) =>
      `${frame.timestampUs}:${frame.keyframe ? 1 : 0}:${frame.data.byteLength}:${sha256(frame.data)}`,
  );
}

async function blobBytes(output: unknown): Promise<Uint8Array> {
  if (!(output instanceof Blob)) throw new Error('expected Blob output');
  return new Uint8Array(await output.arrayBuffer());
}

describe('Matroska Opus gapless preservation (ADR-196)', () => {
  it('maps CodecDelay + terminal DiscardPadding to exact decoded-sample facts on every rotation', async () => {
    const golden = await truth();
    for (const expected of golden.files) {
      const bytes = new Uint8Array(await readFile(`${ROTATION_ROOT}${expected.name}`));
      expect(sha256(bytes), expected.name).toBe(expected.sha256);
      const demuxer = await WebmDriver.demux(fromBytes(bytes));
      const audio = demuxer.tracks.find((track) => track.mediaType === 'audio');
      await demuxer.close();
      expect(audio?.codec, expected.name).toBe('opus');
      expect(audio?.config, expected.name).toMatchObject({
        sampleRate: golden.sampleRate,
        numberOfChannels: golden.channels,
      });
      expect(audio?.gapless, expected.name).toEqual({
        leadingSamples: expected.leadingSamples,
        trailingSamples: expected.trailingSamples,
        totalSamples: expected.totalSamples,
      });
      const description = (audio?.config as AudioDecoderConfig | undefined)?.description;
      expect(description, expected.name).toBeInstanceOf(Uint8Array);
      expect(String.fromCharCode(...new Uint8Array(description as Uint8Array).subarray(0, 8))).toBe(
        'OpusHead',
      );
    }
  });

  it('public demux -> mux re-emits gapless semantics without changing any packet or timestamp', async () => {
    await withEncodedChunks(async () => {
      const golden = await truth();
      const media = createMedia();
      for (const expected of golden.files) {
        const source = new Uint8Array(await readFile(`${ROTATION_ROOT}${expected.name}`));
        const demuxer = await media.demux(source);
        let output: Uint8Array;
        try {
          const streams: PacketStreams = {
            tracks: demuxer.tracks
              .filter((track) => track.config !== undefined)
              .map((track) => ({ track, packets: demuxer.packets(track.id) })),
          };
          output = await blobBytes(await media.mux(streams, { container: 'webm' }));
        } finally {
          await demuxer.close();
        }

        const reparsed = await WebmDriver.demux(fromBytes(output));
        const audio = reparsed.tracks.find((track) => track.mediaType === 'audio');
        await reparsed.close();
        expect(audio?.gapless, expected.name).toEqual({
          leadingSamples: expected.leadingSamples,
          trailingSamples: expected.trailingSamples,
          totalSamples: expected.totalSamples,
        });

        const sourceDemux = demuxWebm(source);
        const outputDemux = demuxWebm(output);
        expect(outputDemux.info.durationSec, expected.name).toBeCloseTo(
          sourceDemux.info.durationSec,
          3,
        );
        expect(outputDemux.framesByIndex, expected.name).toHaveLength(
          sourceDemux.framesByIndex.length,
        );
        for (let trackIndex = 0; trackIndex < sourceDemux.framesByIndex.length; trackIndex++) {
          expect(frameManifest(output, trackIndex), `${expected.name}:track${trackIndex}`).toEqual(
            frameManifest(source, trackIndex),
          );
        }
      }
    });
  });

  it('does not invent gapless facts for real Vorbis/video-only controls', async () => {
    for (const name of ['bear-multitrack.webm', 'white.webm']) {
      const bytes = new Uint8Array(await readFile(`${CONTROL_ROOT}${name}`));
      const demuxer = await WebmDriver.demux(fromBytes(bytes));
      try {
        expect(
          demuxer.tracks.every((track) => track.gapless === undefined),
          name,
        ).toBe(true);
      } finally {
        await demuxer.close();
      }
    }
  });
});

const ROTATED_COLORS: Readonly<Record<string, VideoColorMetadata | undefined>> = {
  '01.webm': { chromaSitingHorz: 1, chromaSitingVert: 2 },
  '02.webm': undefined,
  '03.webm': { chromaSitingHorz: 1, chromaSitingVert: 2 },
  'vp9_1080p_10s.webm': { range: 1 },
};

describe('Matroska Colour preservation (ADR-197)', () => {
  it('preserves exact Colour facts and VP9 packet/timestamp manifests on every rotation', async () => {
    await withEncodedChunks(async () => {
      const media = createMedia();
      for (const [name, expectedColor] of Object.entries(ROTATED_COLORS)) {
        const source = new Uint8Array(await readFile(`${ROTATION_ROOT}${name}`));
        const demuxer = await media.demux(source);
        const sourceVideo = demuxer.tracks.find((track) => track.mediaType === 'video');
        expect(sourceVideo?.color, `${name}:source color`).toEqual(expectedColor);
        let output: Uint8Array;
        try {
          output = await blobBytes(
            await media.mux(
              {
                tracks: demuxer.tracks
                  .filter((track) => track.config !== undefined)
                  .map((track) => ({ track, packets: demuxer.packets(track.id) })),
              },
              { container: 'webm' },
            ),
          );
        } finally {
          await demuxer.close();
        }
        const reparsed = await WebmDriver.demux(fromBytes(output));
        const outputVideo = reparsed.tracks.find((track) => track.mediaType === 'video');
        await reparsed.close();
        expect(outputVideo?.color, `${name}:output color`).toEqual(expectedColor);
        expect(frameManifest(output, 0), `${name}:VP9 packets/timestamps`).toEqual(
          frameManifest(source, 0),
        );
      }
    });
  });

  it('round-trips every supported numeric field, including unknown-safe H.273 code points', async () => {
    await withEncodedChunks(async () => {
      const source = new Uint8Array(await readFile(`${ROTATION_ROOT}02.webm`));
      const color: VideoColorMetadata = {
        matrixCoefficients: 24,
        bitsPerChannel: 12,
        chromaSubsamplingHorz: 1,
        chromaSubsamplingVert: 1,
        cbSubsamplingHorz: 2,
        cbSubsamplingVert: 2,
        chromaSitingHorz: 1,
        chromaSitingVert: 2,
        range: 3,
        transferCharacteristics: 23,
        primaries: 22,
        maxCll: 1000,
        maxFall: 400,
      };
      const media = createMedia();
      const demuxer = await media.demux(source);
      let output: Uint8Array;
      try {
        output = await blobBytes(
          await media.mux(
            {
              tracks: demuxer.tracks
                .filter((track) => track.config !== undefined)
                .map((track) => ({
                  track: track.mediaType === 'video' ? { ...track, color } : track,
                  packets: demuxer.packets(track.id),
                })),
            },
            { container: 'webm' },
          ),
        );
      } finally {
        await demuxer.close();
      }
      const reparsed = await WebmDriver.demux(fromBytes(output));
      try {
        expect(reparsed.tracks.find((track) => track.mediaType === 'video')?.color).toEqual(color);
      } finally {
        await reparsed.close();
      }
      expect(frameManifest(output, 0)).toEqual(frameManifest(source, 0));
    });
  });
});
