import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { muxTracksFromMovie, readMovie } from '../mp4/mp4-driver.ts';
import { WebmMuxer } from './ebml-write.ts';
import {
  av1CodecPrivateFromCodecString,
  parseAv1CodecPrivate,
  parseAv1SequenceHeader,
  parseVp9CodecPrivate,
  parseVp9UncompressedHeader,
  qualifyWebmVideoCodec,
  vp9CodecPrivateFromCodecString,
} from './video-codec-qualification.ts';
import { WebmDriver, demuxWebm } from './webm-driver.ts';

function randomAccess(bytes: Uint8Array): {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
} {
  return {
    size: bytes.byteLength,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function probeWebm(bytes: Uint8Array): Promise<readonly TrackInfo[]> {
  const probe = WebmDriver.probe;
  if (probe === undefined) {
    throw new MediaError('driver-incompatible', 'WebM test driver does not expose probe()');
  }
  return probe(fromBytes(bytes, { mime: 'video/webm' }));
}

class MsbBitWriter {
  readonly #bits: number[] = [];

  write(value: number, width: number): void {
    for (let shift = width - 1; shift >= 0; shift--) this.#bits.push((value >> shift) & 1);
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(Math.ceil(this.#bits.length / 8));
    for (let index = 0; index < this.#bits.length; index++) {
      const byteIndex = index >> 3;
      output[byteIndex] =
        (output[byteIndex] ?? 0) | ((this.#bits[index] ?? 0) << (7 - (index & 7)));
    }
    return output;
  }
}

/** VP9 §6.2 key-frame header through frame size; entropy payload is irrelevant to this parser. */
function vp9KeyHeader(
  profile: 0 | 1 | 2 | 3,
  bitDepth: 8 | 10 | 12,
  width = 320,
  height = 240,
): Uint8Array {
  const bits = new MsbBitWriter();
  bits.write(2, 2); // frame_marker
  bits.write(profile & 1, 1); // profile_low_bit
  bits.write(profile >> 1, 1); // profile_high_bit
  if (profile === 3) bits.write(0, 1); // reserved_zero
  bits.write(0, 1); // show_existing_frame
  bits.write(0, 1); // key frame
  bits.write(1, 1); // show_frame
  bits.write(0, 1); // error_resilient_mode
  bits.write(0x49, 8);
  bits.write(0x83, 8);
  bits.write(0x42, 8);
  if (profile >= 2) bits.write(bitDepth === 12 ? 1 : 0, 1);
  bits.write(2, 3); // BT.709
  bits.write(0, 1); // studio range
  if (profile === 1 || profile === 3) {
    bits.write(1, 1);
    bits.write(1, 1);
    bits.write(0, 1);
  }
  bits.write(width - 1, 16);
  bits.write(height - 1, 16);
  return bits.bytes();
}

/** Reduced-still AV1 sequence header OBU, sufficient to reach normative color_config(). */
function av1ReducedSequenceHeader(
  profile: 0 | 1 | 2,
  bitDepth: 8 | 10 | 12,
  level = 5,
): Uint8Array {
  const payload = new MsbBitWriter();
  payload.write(profile, 3);
  payload.write(1, 1); // still_picture
  payload.write(1, 1); // reduced_still_picture_header
  payload.write(level, 5);
  payload.write(3, 4); // frame_width_bits_minus_1
  payload.write(3, 4); // frame_height_bits_minus_1
  payload.write(15, 4); // max_frame_width_minus_1
  payload.write(15, 4); // max_frame_height_minus_1
  payload.write(0, 1); // use_128x128_superblock
  payload.write(0, 1); // enable_filter_intra
  payload.write(0, 1); // enable_intra_edge_filter
  payload.write(0, 1); // enable_superres
  payload.write(0, 1); // enable_cdef
  payload.write(0, 1); // enable_restoration
  payload.write(bitDepth > 8 ? 1 : 0, 1); // high_bitdepth
  if (profile === 2 && bitDepth > 8) payload.write(bitDepth === 12 ? 1 : 0, 1);
  if (profile !== 1) payload.write(0, 1); // mono_chrome
  payload.write(0, 1); // color_description_present_flag
  payload.write(0, 1); // color_range
  if (profile === 2 && bitDepth === 12) {
    payload.write(1, 1); // subsampling_x
    payload.write(1, 1); // subsampling_y
    payload.write(0, 2); // chroma_sample_position
  }
  payload.write(0, 1); // separate_uv_delta_q
  payload.write(0, 1); // film_grain_params_present
  payload.write(1, 1); // trailing_one_bit
  const body = payload.bytes();
  return Uint8Array.of(0x0a, body.byteLength, ...body); // sequence header OBU + LEB128 size
}

describe('WebM VP9 qualification', () => {
  it.each([
    ['vp09.02.31.10', 'vp09.02.31.10', 2, 31, 10],
    ['vp09.02.52.12', 'vp09.02.52.12', 2, 52, 12],
    ['vp09.01.21.08.03', 'vp09.01.21.08', 1, 21, 8],
  ] as const)(
    'round-trips exact WebM codec features for %s',
    (codec, expectedCodec, profile, level, bitDepth) => {
      const privateData = vp9CodecPrivateFromCodecString(codec);
      expect(parseVp9CodecPrivate(privateData)).toMatchObject({
        codec: expectedCodec,
        profile,
        level,
        bitDepth,
      });
      expect([...privateData]).toEqual(
        codec.endsWith('.03')
          ? [1, 1, profile, 2, 1, level, 3, 1, bitDepth, 4, 1, 3]
          : [1, 1, profile, 2, 1, level, 3, 1, bitDepth, 4, 1, 1],
      );
    },
  );

  it('derives profile/depth from specified uncompressed headers and a truthful level envelope', () => {
    expect(parseVp9UncompressedHeader(vp9KeyHeader(2, 10))).toMatchObject({
      profile: 2,
      bitDepth: 10,
      width: 320,
      height: 240,
    });
    expect(parseVp9UncompressedHeader(vp9KeyHeader(2, 12))).toMatchObject({
      profile: 2,
      bitDepth: 12,
    });
    expect(
      qualifyWebmVideoCodec({
        codec: 'vp9',
        firstKeyframe: vp9KeyHeader(2, 10),
        width: 320,
        height: 240,
        fps: 25,
        sourceSizeBytes: 100_000,
        durationSec: 10,
      }).codec,
    ).toBe('vp09.02.20.10');
    expect(
      qualifyWebmVideoCodec({
        codec: 'vp9',
        firstKeyframe: vp9KeyHeader(2, 12),
        width: 320,
        height: 240,
        sourceSizeBytes: 100_000,
        durationSec: 10,
      }).codec,
    ).toBe('vp09.02.62.12');
  });

  it('rejects truncated, reserved, and profile/depth-inconsistent declarations with typed errors', () => {
    for (const bytes of [
      Uint8Array.of(1),
      Uint8Array.of(1, 2, 2),
      Uint8Array.of(0x81, 1, 2),
      Uint8Array.of(1, 1, 2, 2, 1, 31, 3, 1, 8),
    ]) {
      expect(() => parseVp9CodecPrivate(bytes)).toThrow(MediaError);
    }
    expect(() => parseVp9UncompressedHeader(vp9KeyHeader(2, 10).subarray(0, 4))).toThrow(
      MediaError,
    );
    const badSync = vp9KeyHeader(2, 10).slice();
    badSync[1] = 0;
    expect(() => parseVp9UncompressedHeader(badSync)).toThrow(MediaError);
  });
});

describe('WebM AV1 qualification', () => {
  it('reads exact profile/level/tier/depth from AV1CodecConfigurationRecord', () => {
    expect(parseAv1CodecPrivate(Uint8Array.of(0x81, 0x08, 0x4c, 0))).toMatchObject({
      codec: 'av01.0.08M.10',
      profile: 0,
      level: 8,
      tier: 'M',
      bitDepth: 10,
    });
    expect(parseAv1CodecPrivate(av1CodecPrivateFromCodecString('av01.2.08H.12'))).toMatchObject({
      codec: 'av01.2.08H.12',
      profile: 2,
      level: 8,
      tier: 'H',
      bitDepth: 12,
    });
  });

  it('parses real and specified sequence-header OBUs without a CodecPrivate default', async () => {
    const source = await loadFixture('bear-av1-10bit.mp4');
    const movie = await readMovie(randomAccess(source));
    const av1C = movie.tracks.find((track) => track.mediaType === 'video')?.codecPrivate?.data;
    expect(av1C).toBeDefined();
    expect(parseAv1SequenceHeader(av1C?.subarray(4) ?? new Uint8Array())).toMatchObject({
      codec: 'av01.0.00M.10',
      profile: 0,
      bitDepth: 10,
    });
    expect(parseAv1SequenceHeader(av1ReducedSequenceHeader(2, 12))).toMatchObject({
      codec: 'av01.2.05M.12',
      profile: 2,
      bitDepth: 12,
    });
  });

  it('rejects invalid records, OBU sizes, reserved bits, and depth/profile contradictions', () => {
    for (const bytes of [
      Uint8Array.of(0x81, 0x08, 0x40),
      Uint8Array.of(0x01, 0x08, 0x40, 0),
      Uint8Array.of(0x81, 0x08, 0x60, 0),
      Uint8Array.of(0x81, 0x08, 0x40, 1),
    ]) {
      expect(() => parseAv1CodecPrivate(bytes)).toThrow(MediaError);
    }
    expect(() => parseAv1SequenceHeader(Uint8Array.of(0x0a, 0x7f, 0))).toThrow(MediaError);
    expect(() => parseAv1SequenceHeader(av1ReducedSequenceHeader(2, 12).subarray(0, 4))).toThrow(
      MediaError,
    );
  });
});

describe('WebM high-depth mux reimport', () => {
  it('preserves real 10-bit AV1 packets/VFR and reparses an exact decoder config', async () => {
    const source = await loadFixture('bear-av1-10bit.mp4');
    const movie = await readMovie(randomAccess(source));
    const sourceTracks = await muxTracksFromMovie(randomAccess(source), movie);
    const sourceTrack = sourceTracks.find((track) => track.sampleEntryType === 'av01');
    const parsedTrack = movie.tracks.find((track) => track.sampleEntryType === 'av01');
    if (sourceTrack === undefined || parsedTrack === undefined)
      throw new Error('real AV1 track absent');

    const trackInfo: TrackInfo = {
      id: 0,
      mediaType: 'video',
      codec: parsedTrack.codec,
      durationSec: parsedTrack.durationSec,
      ...(parsedTrack.fps !== undefined ? { fps: parsedTrack.fps } : {}),
      config: parsedTrack.config,
    };
    const muxer = new WebmMuxer();
    const trackId = muxer.addTrack(trackInfo);
    let dtsTicks = 0;
    const expectedTimestamps: number[] = [];
    for (const sample of sourceTrack.samples) {
      const timestampUs = Math.round(
        ((dtsTicks + sample.cttsTicks) * 1_000_000) / sourceTrack.timescale,
      );
      const durationUs = Math.round((sample.durationTicks * 1_000_000) / sourceTrack.timescale);
      expectedTimestamps.push(Math.round(timestampUs / 1000) * 1000);
      muxer.addChunkStruct(trackId, {
        timestampUs,
        durationUs,
        key: sample.keyframe,
        data: sample.data,
        dtsUs: Math.round((dtsTicks * 1_000_000) / sourceTrack.timescale),
      });
      dtsTicks += sample.durationTicks;
    }
    await muxer.finalize();
    const output = await collect(muxer.output);

    const probe = await probeWebm(output);
    const video = probe.find((track) => track.mediaType === 'video');
    expect(video?.codec).toBe('av1');
    expect((video?.config as VideoDecoderConfig | undefined)?.codec).toBe('av01.0.00M.10');
    expect((video?.config as VideoDecoderConfig | undefined)?.description).toEqual(
      parsedTrack.codecPrivate?.data,
    );

    const reparsed = demuxWebm(output);
    const frames = reparsed.framesByIndex[0] ?? [];
    expect(frames.map((frame) => frame.timestampUs)).toEqual(expectedTimestamps);
    expect(frames.map((frame) => frame.data)).toEqual(
      sourceTrack.samples.map((sample) => sample.data),
    );
  });

  it('authors exact VP9 feature metadata and never substitutes profile-0 for unknown input', async () => {
    const qualifiedMuxer = new WebmMuxer();
    const qualifiedId = qualifiedMuxer.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'vp9',
      fps: 25,
      config: { codec: 'vp09.02.20.10', codedWidth: 320, codedHeight: 240 },
    });
    qualifiedMuxer.addChunkStruct(qualifiedId, {
      timestampUs: 0,
      durationUs: 40_000,
      key: true,
      data: vp9KeyHeader(2, 10),
    });
    await qualifiedMuxer.finalize();
    const qualifiedTracks = await probeWebm(await collect(qualifiedMuxer.output));
    expect((qualifiedTracks[0]?.config as VideoDecoderConfig | undefined)?.codec).toBe(
      'vp09.02.20.10',
    );

    const unknownMuxer = new WebmMuxer();
    const unknownId = unknownMuxer.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'vp9',
      config: { codec: 'vp9', codedWidth: 16, codedHeight: 16 },
    });
    unknownMuxer.addChunkStruct(unknownId, {
      timestampUs: 0,
      durationUs: 40_000,
      key: false,
      data: Uint8Array.of(0),
    });
    await unknownMuxer.finalize();
    const unknownTracks = await probeWebm(await collect(unknownMuxer.output));
    expect((unknownTracks[0]?.config as VideoDecoderConfig | undefined)?.codec).toBe('vp09');
    expect((unknownTracks[0]?.config as VideoDecoderConfig | undefined)?.codec).not.toBe(
      'vp09.00.10.08',
    );
  });
});
