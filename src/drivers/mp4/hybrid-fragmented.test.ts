/**
 * Hybrid-fragmented MP4 validation (ADR-194): FFmpeg may put a real AAC prefix in `moov/stbl` and
 * continue the same track in later `moof/trun` runs. Both indexes are additive. The five committed
 * files are derived from the licensed real corpus (provenance + exact ffprobe commands live beside the
 * fixtures); the baked counts below come from ffprobe 8.1.2 plus an independent top-level box walk.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAdtsFrames } from '../../codecs/wasm-aac/aac.ts';
import { fromBytes } from '../../sources/source.ts';
import { mergeMoovAndFragmentSamples, parseFragmentSamples } from './fragment-samples.ts';
import { fragmentMp4 } from './fragment.ts';
import { Mp4Driver, muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import { buildSampleData } from './samples.ts';

const DIR = fileURLToPath(
  new URL('../../../fixtures/media-derived/mp4-hybrid-fragmented/', import.meta.url),
);

interface HybridTruth {
  readonly file: string;
  readonly codec: 'lc' | 'he';
  readonly channels: number;
  readonly timescale: number;
  readonly moovSamples: number;
  readonly fragmentSamples: number;
  readonly moovMediaTicks: number;
  readonly fragmentMediaTicks: number;
  readonly durationTicks: number;
  readonly leadingSamples?: number;
  readonly programSamples?: number;
}

const CASES: readonly HybridTruth[] = [
  {
    file: 'lc48-mono-long.m4a',
    codec: 'lc',
    channels: 1,
    timescale: 48_000,
    moovSamples: 47,
    fragmentSamples: 2_774,
    moovMediaTicks: 48_128,
    fragmentMediaTicks: 2_839_616,
    durationTicks: 2_887_744,
    leadingSamples: 1_024,
    programSamples: 2_886_720,
  },
  {
    file: 'lc48-stereo.m4a',
    codec: 'lc',
    channels: 2,
    timescale: 48_000,
    moovSamples: 33,
    fragmentSamples: 547,
    moovMediaTicks: 33_792,
    fragmentMediaTicks: 559_792,
    durationTicks: 593_584,
    leadingSamples: 1_024,
    programSamples: 592_560,
  },
  {
    file: 'lc441-mono.m4a',
    codec: 'lc',
    channels: 1,
    timescale: 44_100,
    moovSamples: 22,
    fragmentSamples: 287,
    moovMediaTicks: 22_528,
    fragmentMediaTicks: 293_238,
    durationTicks: 315_766,
    leadingSamples: 1_024,
    programSamples: 314_742,
  },
  {
    file: 'lc441-stereo-copy.m4a',
    codec: 'lc',
    channels: 2,
    timescale: 44_100,
    moovSamples: 35,
    fragmentSamples: 704,
    moovMediaTicks: 35_840,
    fragmentMediaTicks: 720_896,
    durationTicks: 756_736,
    leadingSamples: 0,
    programSamples: 756_736,
  },
  {
    // HE-AAC packet/timing coverage. Its two-byte implicit-SBR ASC names the 22.05 kHz LC core; the
    // 44.1 kHz presentation is payload-signalled, so this structural test deliberately does not pin the
    // header-only decoder geometry/gapless sample unit.
    file: 'he441-stereo-copy.m4a',
    codec: 'he',
    channels: 2,
    timescale: 44_100,
    moovSamples: 22,
    fragmentSamples: 350,
    moovMediaTicks: 45_056,
    fragmentMediaTicks: 716_800,
    durationTicks: 761_856,
  },
];

function randomAccess(bytes: Uint8Array): {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
} {
  return {
    size: bytes.byteLength,
    read: (offset, length) =>
      Promise.resolve(bytes.subarray(offset, Math.min(bytes.byteLength, offset + length))),
  };
}

function concat(chunks: Iterable<Uint8Array>): Uint8Array {
  const list = [...chunks];
  const out = new Uint8Array(list.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of list) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

class FakeEncodedChunk {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;

  constructor(init: {
    readonly timestamp: number;
    readonly duration?: number;
    readonly data: ArrayBufferView;
  }) {
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.byteLength = init.data.byteLength;
  }
}

let restoreChunkConstructors = (): void => {};

describe('hybrid fragmented MP4 — real FFmpeg corpus', () => {
  beforeAll(() => {
    const audio = globalThis.EncodedAudioChunk;
    const video = globalThis.EncodedVideoChunk;
    Object.defineProperty(globalThis, 'EncodedAudioChunk', {
      configurable: true,
      value: FakeEncodedChunk as unknown as typeof EncodedAudioChunk,
    });
    Object.defineProperty(globalThis, 'EncodedVideoChunk', {
      configurable: true,
      value: FakeEncodedChunk as unknown as typeof EncodedVideoChunk,
    });
    restoreChunkConstructors = (): void => {
      Object.defineProperty(globalThis, 'EncodedAudioChunk', { configurable: true, value: audio });
      Object.defineProperty(globalThis, 'EncodedVideoChunk', { configurable: true, value: video });
    };
  });

  afterAll(() => {
    restoreChunkConstructors();
  });

  for (const truth of CASES) {
    it(`${truth.file}: merges the stbl prefix and every trun sample`, async () => {
      const bytes = new Uint8Array(await readFile(`${DIR}${truth.file}`));
      const movie = await readMovie(randomAccess(bytes));
      const track = movie.tracks.find((candidate) => candidate.mediaType === 'audio');
      expect(track).toBeDefined();
      if (track === undefined) return;

      expect(movie.hasFragments).toBe(true);
      expect(track.timescale).toBe(truth.timescale);
      expect(track.moovSampleCount).toBe(truth.moovSamples);
      expect(track.fragmentSampleCount).toBe(truth.fragmentSamples);
      expect(track.fragmentMediaTicks).toBe(truth.fragmentMediaTicks);
      expect(Math.round(track.durationSec * track.timescale)).toBe(truth.durationTicks);

      const prefix = buildSampleData(track);
      const fragments = parseFragmentSamples(bytes).get(track.id) ?? [];
      expect(prefix).toHaveLength(truth.moovSamples);
      expect(fragments).toHaveLength(truth.fragmentSamples);
      expect(prefix.reduce((sum, sample) => sum + sample.durationTicks, 0)).toBe(
        truth.moovMediaTicks,
      );
      expect(fragments.reduce((sum, sample) => sum + sample.durationTicks, 0)).toBe(
        truth.fragmentMediaTicks,
      );

      const merged = mergeMoovAndFragmentSamples(prefix, fragments);
      expect(merged).toHaveLength(truth.moovSamples + truth.fragmentSamples);
      expect(merged[0]?.dtsTicks).toBe(0);
      const last = merged.at(-1);
      expect((last?.dtsTicks ?? 0) + (last?.durationTicks ?? 0)).toBe(truth.durationTicks);
      merged.forEach((sample, index) => expect(sample.index).toBe(index));

      const demuxer = await Mp4Driver.demux(fromBytes(bytes, { mime: 'audio/mp4' }));
      try {
        const info = demuxer.tracks.find((candidate) => candidate.mediaType === 'audio');
        expect(info?.durationSec).toBeCloseTo(truth.durationTicks / truth.timescale, 10);
        expect((info?.config as AudioDecoderConfig | undefined)?.numberOfChannels).toBe(
          truth.channels,
        );
        expect(demuxer.packetTable).toBeUndefined();

        if (truth.codec === 'lc') {
          expect((info?.config as AudioDecoderConfig | undefined)?.sampleRate).toBe(
            truth.timescale,
          );
          expect(info?.gapless).toEqual({
            basis: 'mp4-edit-list',
            leadingSamples: truth.leadingSamples,
            trailingSamples: 0,
            totalSamples: truth.programSamples,
          });
        }

        const reader = demuxer.packets(track.id).getReader();
        let packetCount = 0;
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
          packetCount++;
        }
        expect(packetCount).toBe(truth.moovSamples + truth.fragmentSamples);
      } finally {
        await demuxer.close();
      }

      const remuxTracks = await muxTracksFromMovie(randomAccess(bytes), movie);
      expect(remuxTracks).toHaveLength(1);
      expect(remuxTracks[0]?.samples).toHaveLength(truth.moovSamples + truth.fragmentSamples);
    });
  }

  it('fully fragmented explicit-SBR HE-AAC drains every trun from an empty stbl', async () => {
    // Repo-owned equivalent of the rotated DASH shape: real WPT speech HE-AAC payloads, an explicit
    // AOT-5/SBR ASC, empty init sample tables, and multiple moof runs. No fixture or scenario fingerprint.
    const adtsPath = fileURLToPath(
      new URL('../../../fixtures/media-derived/adts/speech-heaac-sbr.aac', import.meta.url),
    );
    const aac = readAdtsFrames(new Uint8Array(await readFile(adtsPath)));
    const outputSampleRate = 44_100;
    const samplesPerAccessUnit = 2_048;
    const file = concat(
      fragmentMp4(
        [
          {
            mediaType: 'audio',
            sampleEntryType: 'mp4a',
            timescale: outputSampleRate,
            sampleRate: outputSampleRate,
            channels: 2,
            // Explicit HE-AAC v1: AOT 5, 22.05 kHz LC core, 44.1 kHz SBR presentation, stereo.
            description: Uint8Array.of(0x2b, 0x92, 0x08, 0x00, 0x00),
            samples: aac.frames.map((data) => ({
              data,
              durationTicks: samplesPerAccessUnit,
              cttsTicks: 0,
              keyframe: true,
            })),
          },
        ],
        { maxSamplesPerFragment: 37 },
      ),
    );

    const movie = await readMovie(randomAccess(file));
    const track = movie.tracks[0];
    expect(movie.hasFragments).toBe(true);
    expect(track?.samples.sampleSizes).toEqual([]);
    expect(track?.codec).toBe('mp4a.40.5');
    expect(track?.fragmentSampleCount).toBe(aac.frames.length);
    expect(track?.fragmentMediaTicks).toBe(aac.frames.length * samplesPerAccessUnit);

    const demuxer = await Mp4Driver.demux(fromBytes(file, { mime: 'audio/mp4' }));
    try {
      expect((demuxer.tracks[0]?.config as AudioDecoderConfig | undefined)?.sampleRate).toBe(
        outputSampleRate,
      );
      const reader = demuxer.packets(track?.id ?? 1).getReader();
      let packets = 0;
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        packets++;
      }
      expect(packets).toBe(aac.frames.length);
    } finally {
      await demuxer.close();
    }
  });
});
