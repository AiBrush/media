/**
 * Source-aware semantic no-op convert routing (ADR-263). The predicate is deliberately independent from
 * container bytes: the driver supplies exact metadata, and only a fully proved match may use stream-copy.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  ContainerDriver,
  DriverModule,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { webmPacketPayloadInfoFromBytes } from '../drivers/webm/webm-driver.ts';
import { toBlob } from '../sinks/sink.ts';
import { toStreamTarget } from '../sinks/stream-target.ts';
import { type Source, fromBlob, fromBytes, fromStream } from '../sources/source.ts';
import { createMedia } from './create-media.ts';
import { tryReuseMp4SemanticBlobDirectly } from './remux-metadata.ts';
import { isSemanticStreamCopy, mayBeSemanticStreamCopy } from './semantic-stream-copy.ts';
import type { AudioCodec, ConvertOptions, VideoCodec } from './types.ts';

interface BlobRead {
  readonly start: number;
  readonly end: number;
}

class ObservedBlob extends Blob {
  readonly #origin: number;
  readonly #reads: BlobRead[];

  constructor(
    parts: readonly BlobPart[],
    options: BlobPropertyBag,
    reads: BlobRead[] = [],
    origin = 0,
  ) {
    super([...parts], options);
    this.#reads = reads;
    this.#origin = origin;
  }

  get reads(): readonly BlobRead[] {
    return this.#reads;
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    this.#reads.push({ start: this.#origin, end: this.#origin + this.size });
    return super.arrayBuffer();
  }

  override slice(start = 0, end = this.size, contentType = ''): Blob {
    const normalizedStart = Math.min(this.size, Math.max(0, start < 0 ? this.size + start : start));
    const normalizedEnd = Math.min(this.size, Math.max(0, end < 0 ? this.size + end : end));
    const boundedEnd = Math.max(normalizedStart, normalizedEnd);
    return new ObservedBlob(
      [super.slice(normalizedStart, boundedEnd, contentType)],
      { type: contentType },
      this.#reads,
      this.#origin + normalizedStart,
    );
  }
}

function emptyTopLevelBox(type: string): ArrayBuffer {
  if ([...type].length !== 4) throw new Error('box type must have four characters');
  const bytes = new Uint8Array(8);
  bytes.set([0, 0, 0, 8, ...[...type].map((value) => value.charCodeAt(0))]);
  return bytes.buffer;
}

const H264_VIDEO: TrackInfo = {
  id: 1,
  mediaType: 'video',
  codec: 'avc1.640020',
  durationSec: 2,
  fps: 30,
  rotation: 0,
  config: { codec: 'avc1.640020', codedWidth: 720, codedHeight: 1280 },
};
const AAC_AUDIO: TrackInfo = {
  id: 2,
  mediaType: 'audio',
  codec: 'mp4a.40.2',
  durationSec: 2,
  config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
};

function eligible(video: NonNullable<ConvertOptions['video']>): boolean {
  if (video === false) return false;
  return isSemanticStreamCopy({ to: 'mp4', video }, [H264_VIDEO, AAC_AUDIO]);
}

describe('semantic stream-copy eligibility', () => {
  it('accepts only an exactly proved codec, coded geometry, rotation, precision, and audio layout', () => {
    const exact: ConvertOptions = {
      to: 'mp4',
      video: { codec: 'h264', width: 720, height: 1280, rotate: 0, bitDepth: 8 },
      audio: { codec: 'aac', sampleRate: 48_000, channels: 2 },
    };
    expect(mayBeSemanticStreamCopy(exact)).toBe(true);
    expect(isSemanticStreamCopy(exact, [H264_VIDEO, AAC_AUDIO])).toBe(true);
    expect(eligible({ codec: 'h264' })).toBe(true);
    expect(eligible({ width: 720 })).toBe(true);
    expect(eligible({ height: 1280 })).toBe(true);
    expect(eligible({ rotate: 0 })).toBe(true);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { rotate: 0 } }, [
        { ...H264_VIDEO, rotation: 360 },
        AAC_AUDIO,
      ]),
    ).toBe(true);
    expect(
      isSemanticStreamCopy({ to: 'mp4', audio: { codec: 'aac', gainDb: 0 } }, [
        H264_VIDEO,
        AAC_AUDIO,
      ]),
    ).toBe(true);
    // Container side data belongs to the selected media track and follows that track through both the
    // codec graph and native writer; unlike a separate projection track it does not change track count.
    expect(
      isSemanticStreamCopy({ to: 'mkv', video: { codec: 'h264' } }, [
        {
          ...H264_VIDEO,
          containerSideData: [
            {
              kind: 'matroska-attachments',
              attachedFilePayloads: [new Uint8Array([1, 2, 3])],
            },
          ],
        },
        AAC_AUDIO,
      ]),
    ).toBe(true);
  });

  it('recognizes every qualified video codec alias and proved bit depth', () => {
    const cases: readonly {
      codec: string;
      family: VideoCodec;
      bitDepth?: 8 | 10 | 12;
    }[] = [
      { codec: 'avc1.42001f', family: 'h264', bitDepth: 8 },
      { codec: 'AVC3.6E001F', family: 'h264', bitDepth: 10 },
      { codec: 'hvc1.1.6.L93.B0', family: 'hevc', bitDepth: 8 },
      { codec: 'HEV1.2.4.L120.B0', family: 'hevc', bitDepth: 10 },
      { codec: 'vp8', family: 'vp8', bitDepth: 8 },
      { codec: 'VP8.0', family: 'vp8', bitDepth: 8 },
      { codec: 'vp9', family: 'vp9' },
      { codec: 'VP09.00.10.08', family: 'vp9', bitDepth: 8 },
      { codec: 'vp09.00.10.10', family: 'vp9', bitDepth: 10 },
      { codec: 'vp09.00.10.12', family: 'vp9', bitDepth: 12 },
      { codec: 'av01.0.08M.08', family: 'av1', bitDepth: 8 },
      { codec: 'av01.0.08M.10', family: 'av1', bitDepth: 10 },
      { codec: 'av01.0.08M.12', family: 'av1', bitDepth: 12 },
    ];

    for (const { codec, family, bitDepth } of cases) {
      const track: TrackInfo = {
        id: 1,
        mediaType: 'video',
        codec,
        config: { codec, codedWidth: 320, codedHeight: 240 },
      };
      expect(
        isSemanticStreamCopy(
          {
            to: 'mp4',
            video: {
              codec: family,
              width: 320,
              height: 240,
              ...(bitDepth === undefined ? {} : { bitDepth }),
            },
          },
          [track],
        ),
      ).toBe(true);
    }

    for (const codec of ['avc1.7A001F', 'hvc1.3.6.L93.B0', 'vp9', 'av01.0.08M']) {
      expect(
        isSemanticStreamCopy({ to: 'mp4', video: { width: 320, height: 240, bitDepth: 8 } }, [
          {
            id: 1,
            mediaType: 'video',
            codec,
            config: { codec, codedWidth: 320, codedHeight: 240 },
          },
        ]),
      ).toBe(false);
    }
  });

  it('recognizes every qualified audio codec alias without guessing unknown layouts', () => {
    const cases: readonly (readonly [codec: string, family: AudioCodec])[] = [
      ['aac', 'aac'],
      ['MP4A.40.2', 'aac'],
      ['opus', 'opus'],
      ['A_OPUS', 'opus'],
      ['mp3', 'mp3'],
      ['MP4A.6B', 'mp3'],
      ['A_MPEG/L3', 'mp3'],
      ['flac', 'flac'],
      ['A_FLAC', 'flac'],
      ['vorbis', 'vorbis'],
      ['A_VORBIS', 'vorbis'],
    ];

    for (const [codec, family] of cases) {
      expect(
        isSemanticStreamCopy(
          { to: 'mkv', audio: { codec: family, sampleRate: 48_000, channels: 2 } },
          [
            {
              id: 1,
              mediaType: 'audio',
              codec,
              config: { codec, sampleRate: 48_000, numberOfChannels: 2 },
            },
          ],
        ),
      ).toBe(true);
    }
    expect(
      isSemanticStreamCopy({ to: 'mkv', audio: { codec: 'aac' } }, [
        {
          id: 1,
          mediaType: 'audio',
          codec: 'unknown-audio',
          config: { codec: 'unknown-audio', sampleRate: 48_000, numberOfChannels: 2 },
        },
      ]),
    ).toBe(false);
  });

  it('declines malformed metadata, missing requested tracks, and duplicate audio tracks', () => {
    expect(isSemanticStreamCopy({ to: 'mp4', video: { codec: 'h264' } }, [])).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { codec: 'h264' } }, [
        { id: 1, mediaType: 'video', codec: 'avc1.640020' },
      ]),
    ).toBe(false);
    expect(isSemanticStreamCopy({ to: 'mp4', video: { codec: 'h264' } }, [AAC_AUDIO])).toBe(false);
    expect(isSemanticStreamCopy({ to: 'mp4', audio: { codec: 'aac' } }, [H264_VIDEO])).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', audio: { codec: 'aac' } }, [
        AAC_AUDIO,
        { ...AAC_AUDIO, id: 3 },
      ]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { codec: 'h264' } }, [
        {
          ...H264_VIDEO,
          config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
        },
      ]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', audio: { codec: 'aac' } }, [
        {
          ...AAC_AUDIO,
          config: { codec: 'avc1.640020', codedWidth: 720, codedHeight: 1280 },
        },
      ]),
    ).toBe(false);
  });

  it('proves alpha disposition only when the source codec and alpha fact make it invariant', () => {
    const track = (codec: string, alpha?: boolean): TrackInfo => ({
      id: 1,
      mediaType: 'video',
      codec,
      ...(alpha === undefined ? {} : { alpha }),
      config: { codec, codedWidth: 320, codedHeight: 240 },
    });
    expect(
      isSemanticStreamCopy({ to: 'webm', video: { codec: 'vp8', alpha: 'keep' } }, [
        track('vp8', true),
      ]),
    ).toBe(true);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { codec: 'h264', alpha: 'keep' } }, [
        track('avc1.640020', true),
      ]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { codec: 'h264', alpha: 'discard' } }, [
        track('avc1.640020', true),
      ]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'webm', video: { codec: 'vp9', alpha: 'discard' } }, [
        track('vp09.00.10.08'),
      ]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { width: 320, alpha: 'discard' } }, [
        track('unknown-video'),
      ]),
    ).toBe(false);
  });

  it('declines codec, geometry, rotation, frame-rate, precision, alpha, and rate-control changes', () => {
    expect(eligible({ codec: 'hevc' })).toBe(false);
    expect(eligible({ width: 1280, height: 720 })).toBe(false);
    expect(eligible({ height: 720 })).toBe(false);
    expect(eligible({ rotate: 90 })).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { rotate: 0 } }, [
        { ...H264_VIDEO, rotation: 90 },
        AAC_AUDIO,
      ]),
    ).toBe(false);
    expect(eligible({ fps: 30 })).toBe(false); // average equality cannot prove a CFR/VFR identity
    expect(eligible({ bitDepth: 10 })).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { bitDepth: 8 } }, [
        {
          ...H264_VIDEO,
          codec: 'avc1.F40020',
          config: { codec: 'avc1.F40020', codedWidth: 720, codedHeight: 1280 },
        },
        AAC_AUDIO,
      ]),
    ).toBe(false);
    expect(eligible({ alpha: 'keep' })).toBe(false);
    expect(eligible({ alpha: 'discard' })).toBe(true);
    expect(
      isSemanticStreamCopy({ to: 'webm', video: { codec: 'vp9', alpha: 'keep' } }, [
        {
          ...H264_VIDEO,
          codec: 'vp09.00.10.08',
          alpha: true,
          config: { codec: 'vp09.00.10.08', codedWidth: 720, codedHeight: 1280 },
        },
      ]),
    ).toBe(true);
    for (const video of [
      { bitrate: 1_000_000 },
      { bitrateMode: 'constant' as const },
      { crf: 20 },
      { twoPass: true },
      { fit: 'contain' as const },
      { flip: 'h' as const },
      { crop: { x: 0, y: 0, width: 720, height: 1280 } },
      { pad: { width: 720, height: 1280 } },
      { colorspace: { to: 'bt709' } },
      { tonemap: { to: 'sdr' as const } },
    ]) {
      expect(eligible(video)).toBe(false);
    }
  });

  it('declines unproved audio changes, track drops, extra tracks, encryption, and absent target', () => {
    expect(
      isSemanticStreamCopy({ to: 'mp4', audio: { codec: 'opus' } }, [H264_VIDEO, AAC_AUDIO]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', audio: { sampleRate: 44_100 } }, [H264_VIDEO, AAC_AUDIO]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', audio: { channels: 1 } }, [H264_VIDEO, AAC_AUDIO]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', audio: { bitrate: 128_000 } }, [H264_VIDEO, AAC_AUDIO]),
    ).toBe(false);
    expect(isSemanticStreamCopy({ to: 'mp4', video: false }, [H264_VIDEO, AAC_AUDIO])).toBe(false);
    expect(isSemanticStreamCopy({ to: 'mp4', audio: false }, [H264_VIDEO, AAC_AUDIO])).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { codec: 'h264' } }, [
        H264_VIDEO,
        { ...H264_VIDEO, id: 3 },
      ]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { codec: 'h264' } }, [
        H264_VIDEO,
        { ...AAC_AUDIO, nonMedia: true },
      ]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mkv', video: { codec: 'h264' } }, [
        {
          ...H264_VIDEO,
          containerProjection: {
            kind: 'matroska-attachment',
            sideDataIndex: 0,
            attachmentIndex: 0,
          },
        },
        AAC_AUDIO,
      ]),
    ).toBe(false);
    expect(
      isSemanticStreamCopy({ to: 'mp4', video: { codec: 'h264' } }, [
        { ...H264_VIDEO, encrypted: true },
        AAC_AUDIO,
      ]),
    ).toBe(false);
    expect(isSemanticStreamCopy({ video: { codec: 'h264' } }, [H264_VIDEO, AAC_AUDIO])).toBe(false);
  });

  it('accepts a false selector only when exact metadata proves that media type is absent', () => {
    const videoOnly: ConvertOptions = {
      to: 'mp4',
      video: { codec: 'h264' },
      audio: false,
    };
    const audioOnly: ConvertOptions = {
      to: 'mp4',
      video: false,
      audio: { codec: 'aac' },
    };

    expect(mayBeSemanticStreamCopy(videoOnly)).toBe(true);
    expect(isSemanticStreamCopy(videoOnly, [H264_VIDEO])).toBe(true);
    expect(isSemanticStreamCopy(videoOnly, [H264_VIDEO, AAC_AUDIO])).toBe(false);
    expect(mayBeSemanticStreamCopy(audioOnly)).toBe(true);
    expect(isSemanticStreamCopy(audioOnly, [AAC_AUDIO])).toBe(true);
    expect(isSemanticStreamCopy(audioOnly, [H264_VIDEO, AAC_AUDIO])).toBe(false);

    expect(mayBeSemanticStreamCopy({ to: 'mp4', video: false, audio: false })).toBe(false);
    expect(mayBeSemanticStreamCopy({ to: 'mp4' })).toBe(false);
    expect(isSemanticStreamCopy(videoOnly, [])).toBe(false);
    expect(isSemanticStreamCopy(videoOnly, [H264_VIDEO, { ...AAC_AUDIO, nonMedia: true }])).toBe(
      false,
    );
  });
});

interface CopyCalls {
  probe: number;
  demux: number;
  copy: StageOptions[];
}

function sourceAwareCopyModule(
  calls: CopyCalls,
  tracks: readonly TrackInfo[] = [H264_VIDEO, AAC_AUDIO],
): DriverModule {
  const driver: ContainerDriver = {
    id: 'semantic-copy-mp4',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: (q) => q.mime === 'video/x-semantic-copy',
    probe: (_src, stage) => {
      calls.probe++;
      if (stage?.signal?.aborted === true) return Promise.reject(stage.signal.reason);
      return Promise.resolve(tracks);
    },
    demux: () => {
      calls.demux++;
      throw new Error('eligible semantic copy must not open the codec demuxer');
    },
    streamCopy: (_src, stage) => {
      calls.copy.push(stage ?? {});
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new Uint8Array([7, 8, 9]));
            controller.close();
          },
        }),
      );
    },
    createMuxer: () => {
      throw new Error('eligible semantic copy must not create a codec muxer');
    },
  };
  return { apiVersion: DRIVER_API_VERSION, register: (registry) => registry.addContainer(driver) };
}

describe('public convert semantic stream-copy route', () => {
  it('probes exact source truth and preserves target writer/sink options without codec work', async () => {
    const calls: CopyCalls = { probe: 0, demux: 0, copy: [] };
    const media = createMedia({ worker: false }).use(sourceAwareCopyModule(calls));
    const out = await media.convert(
      fromBytes(new Uint8Array([1]), { mime: 'video/x-semantic-copy' }),
      {
        to: 'mp4',
        video: { codec: 'h264', width: 720, height: 1280, rotate: 0 },
        faststart: true,
        fragmented: false,
      },
    );
    expect(out).toBeInstanceOf(Blob);
    if (!(out instanceof Blob)) throw new Error('expected a Blob output');
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
    expect(calls).toEqual({
      probe: 1,
      demux: 0,
      copy: [expect.objectContaining({ container: 'mp4', faststart: true, fragmented: false })],
    });
    expect(calls.copy[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not probe when an always-mutating option proves the request cannot be a no-op', async () => {
    const calls: CopyCalls = { probe: 0, demux: 0, copy: [] };
    const media = createMedia({ worker: false }).use(sourceAwareCopyModule(calls));
    await expect(
      media.convert(fromBytes(new Uint8Array([1]), { mime: 'video/x-semantic-copy' }), {
        to: 'mp4',
        video: { codec: 'h264', fps: 30 },
      }),
    ).rejects.toThrow();
    expect(calls.probe).toBe(0);
    expect(calls.copy).toHaveLength(0);
  });

  it('copies a metadata-proved redundant exclusion but demuxes an actual track drop', async () => {
    const redundant: CopyCalls = { probe: 0, demux: 0, copy: [] };
    const videoOnly = createMedia({ worker: false }).use(
      sourceAwareCopyModule(redundant, [H264_VIDEO]),
    );
    const output = await videoOnly.convert(
      fromBytes(new Uint8Array([1]), { mime: 'video/x-semantic-copy' }),
      { to: 'mp4', video: { codec: 'h264' }, audio: false },
    );
    expect(output).toBeInstanceOf(Blob);
    expect(redundant).toEqual({
      probe: 1,
      demux: 0,
      copy: [expect.objectContaining({ container: 'mp4' })],
    });

    const actualDrop: CopyCalls = { probe: 0, demux: 0, copy: [] };
    const withAudio = createMedia({ worker: false }).use(sourceAwareCopyModule(actualDrop));
    await expect(
      withAudio.convert(fromBytes(new Uint8Array([1]), { mime: 'video/x-semantic-copy' }), {
        to: 'mp4',
        video: { codec: 'h264' },
        audio: false,
      }),
    ).rejects.toThrow('eligible semantic copy must not open the codec demuxer');
    expect(actualDrop).toEqual({ probe: 1, demux: 1, copy: [] });
  });

  it('requires the exact requested destination and preserves streaming sink mode', async () => {
    const calls: CopyCalls = { probe: 0, demux: 0, copy: [] };
    const media = createMedia({ worker: false }).use(sourceAwareCopyModule(calls));
    const writes: Uint8Array[] = [];
    await expect(
      media.convert(fromBytes(new Uint8Array([1]), { mime: 'video/x-semantic-copy' }), {
        to: 'mp4',
        video: { codec: 'h264' },
        sink: toStreamTarget((chunk) => {
          writes.push(chunk.slice());
        }),
      }),
    ).resolves.toBeUndefined();
    expect(writes).toEqual([new Uint8Array([7, 8, 9])]);
    expect(calls.copy[0]).toMatchObject({ container: 'mp4', streaming: true });

    const unsupported: CopyCalls = { probe: 0, demux: 0, copy: [] };
    const unsupportedMedia = createMedia({ worker: false }).use(sourceAwareCopyModule(unsupported));
    await expect(
      unsupportedMedia.convert(fromBytes(new Uint8Array([1]), { mime: 'video/x-semantic-copy' }), {
        to: 'webm',
        video: { codec: 'h264' },
      }),
    ).rejects.toThrow();
    expect(unsupported.probe).toBe(0);
    expect(unsupported.copy).toHaveLength(0);
  });

  it('threads an already-aborted signal through source proof and never opens copy output', async () => {
    const calls: CopyCalls = { probe: 0, demux: 0, copy: [] };
    const media = createMedia({ worker: false }).use(sourceAwareCopyModule(calls, [H264_VIDEO]));
    const abort = new AbortController();
    abort.abort();
    await expect(
      media.convert(
        fromBytes(new Uint8Array([1]), { mime: 'video/x-semantic-copy' }),
        { to: 'mp4', video: { codec: 'h264' }, audio: false },
        { signal: abort.signal },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual({ probe: 1, demux: 0, copy: [] });
  });

  it('never probes a single-use stream before the normal codec path consumes it', async () => {
    const calls: CopyCalls = { probe: 0, demux: 0, copy: [] };
    const media = createMedia({ worker: false }).use(sourceAwareCopyModule(calls));
    const input = fromStream(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      { mime: 'video/x-semantic-copy' },
    );
    await expect(
      media.convert(input, { to: 'mp4', video: { codec: 'h264' }, audio: false }),
    ).rejects.toThrow();
    expect(calls).toEqual({ probe: 0, demux: 1, copy: [] });
  });

  it('rewrites real B-frame and VFR-shaped MP4 packets without changing packet metadata', async () => {
    const mediaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media');
    for (const name of ['movie_5.mp4', 'obs-remux-variable-aac.mp4']) {
      const input = Uint8Array.from(readFileSync(resolve(mediaRoot, name)));
      const media = createMedia({ worker: false });
      const info = await media.probe(input);
      const video = info.tracks.find((track) => track.type === 'video');
      if (video?.width === undefined || video.height === undefined) {
        throw new Error(`${name} must have video geometry`);
      }
      const output = await media.convert(input, {
        to: 'mp4',
        video: { codec: 'h264', width: video.width, height: video.height, rotate: 0 },
      });
      expect(output).toBeInstanceOf(Blob);
      if (!(output instanceof Blob)) throw new Error('expected a Blob output');
      const outputBytes = new Uint8Array(await output.arrayBuffer());
      const packetInfo = Mp4Driver.packetInfo;
      if (packetInfo === undefined) throw new Error('MP4 must expose packetInfo');
      const before = await packetInfo.call(Mp4Driver, fromBytes(input, { mime: 'video/mp4' }));
      const after = await packetInfo.call(Mp4Driver, fromBytes(outputBytes, { mime: 'video/mp4' }));
      expect(after.tracks.map(({ id: _id, ...track }) => track)).toEqual(
        before.tracks.map(({ id: _id, ...track }) => track),
      );
      expect(after.packets.map(({ offset: _offset, ...packet }) => packet)).toEqual(
        before.packets.map(({ offset: _offset, ...packet }) => packet),
      );
      const payloadHashes = (bytes: Uint8Array, rows: typeof before.packets): string[] =>
        rows.map((row) => {
          if (row.offset === undefined) throw new Error('MP4 packet must expose an offset');
          return createHash('sha256')
            .update(bytes.subarray(row.offset, row.offset + row.size))
            .digest('hex');
        });
      expect(payloadHashes(outputBytes, after.packets)).toEqual(
        payloadHashes(input, before.packets),
      );
    }
  });

  it.each(['movie_5.mp4', 'obs-remux-variable-aac.mp4', 'test.mp4'])(
    'reuses an eligible default MP4 Blob without reading media payloads: %s',
    async (name) => {
      const mediaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media');
      const input = Uint8Array.from(readFileSync(resolve(mediaRoot, name)));
      const blob = new ObservedBlob([input], { type: 'video/mp4' });
      const media = createMedia({ worker: false });
      const info = await media.probe(input);
      const video = info.tracks.find((track) => track.type === 'video');
      if (video?.width === undefined || video.height === undefined) {
        throw new Error(`${name} must have video geometry`);
      }
      const output = await media.convert(blob, {
        to: 'mp4',
        video: { codec: 'h264', width: video.width, height: video.height, rotate: 0 },
      });

      expect(output).toBeInstanceOf(Blob);
      if (!(output instanceof Blob)) throw new Error('expected Blob output');
      expect(output).not.toBe(blob);
      expect(output.type).toBe('video/mp4');
      expect(new Uint8Array(await output.arrayBuffer())).toEqual(input);
      expect(blob.reads).not.toContainEqual({ start: 0, end: input.byteLength });
      expect(blob.reads.reduce((sum, read) => sum + read.end - read.start, 0)).toBeLessThan(
        input.byteLength,
      );
    },
  );

  it('limits Blob reuse to default raw input and safe same-brand ordinary topology', async () => {
    const mediaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media');
    const input = Uint8Array.from(readFileSync(resolve(mediaRoot, 'movie_5.mp4')));
    const media = createMedia({ worker: false });
    const info = await media.probe(input);
    const video = info.tracks.find((track) => track.type === 'video');
    if (video?.width === undefined || video.height === undefined) {
      throw new Error('movie_5.mp4 must have video geometry');
    }
    const options = {
      to: 'mp4' as const,
      video: {
        codec: 'h264' as const,
        width: video.width,
        height: video.height,
        rotate: 0 as const,
      },
    };
    const outputBytes = async (output: unknown): Promise<Uint8Array> => {
      if (!(output instanceof Blob)) throw new Error('expected Blob output');
      return new Uint8Array(await output.arrayBuffer());
    };

    const explicit = await outputBytes(
      await media.convert(new Blob([input], { type: 'video/mp4' }), {
        ...options,
        sink: toBlob(),
      }),
    );
    const normalized = await outputBytes(
      await media.convert(fromBlob(new Blob([input], { type: 'video/mp4' })), options),
    );
    const explicitLayout = await outputBytes(
      await media.convert(new Blob([input], { type: 'video/mp4' }), {
        ...options,
        faststart: false,
      }),
    );
    expect(explicit).not.toEqual(input);
    expect(normalized).not.toEqual(input);
    expect(explicitLayout).not.toEqual(input);

    const unsafe = new ObservedBlob([input, emptyTopLevelBox('uuid')], { type: 'video/mp4' });
    expect(await tryReuseMp4SemanticBlobDirectly(unsafe, 'mp4')).toBeUndefined();
    expect(
      await tryReuseMp4SemanticBlobDirectly(new Blob([input], { type: 'video/mp4' }), 'mov'),
    ).toBeUndefined();
    expect(
      await tryReuseMp4SemanticBlobDirectly(
        new Blob([input.subarray(0, input.byteLength - 1)], { type: 'video/mp4' }),
        'mp4',
      ),
    ).toBeUndefined();

    const abort = new AbortController();
    abort.abort();
    const aborted = new ObservedBlob([input], { type: 'video/mp4' });
    await expect(
      tryReuseMp4SemanticBlobDirectly(aborted, 'mp4', abort.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(aborted.reads).toHaveLength(0);
  });

  it('uses the same copy-free route for a raw File input', async () => {
    if (typeof File === 'undefined') return;
    const mediaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media');
    const input = Uint8Array.from(readFileSync(resolve(mediaRoot, 'movie_5.mp4')));
    const media = createMedia({ worker: false });
    const info = await media.probe(input);
    const video = info.tracks.find((track) => track.type === 'video');
    if (video?.width === undefined || video.height === undefined) {
      throw new Error('movie_5.mp4 must have video geometry');
    }
    const output = await media.convert(new File([input], 'renamed-by-caller.mp4'), {
      to: 'mp4',
      video: { codec: 'h264', width: video.width, height: video.height, rotate: 0 },
    });
    expect(output).toBeInstanceOf(Blob);
    if (!(output instanceof Blob)) throw new Error('expected Blob output');
    expect(output.type).toBe('video/mp4');
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(input);
  });

  it('rewrites a declared real VP9-alpha track with exact color, alpha, and timing truth', async () => {
    const mediaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media');
    const input = Uint8Array.from(readFileSync(resolve(mediaRoot, 'bear-vp9-alpha.webm')));
    const before = webmPacketPayloadInfoFromBytes(input);
    expect(before.tracks).toHaveLength(1);
    expect(before.tracks[0]).toMatchObject({ codec: 'vp9', alpha: true });

    // Node has no VP9 WebCodecs encoder. Success therefore proves the metadata-qualified native rewrite
    // ran instead of the codec graph; exact packet hashes prove that success is not a passthrough claim.
    const output = await createMedia({ worker: false }).convert(input, {
      to: 'webm',
      video: { codec: 'vp9', alpha: 'keep' },
    });
    expect(output).toBeInstanceOf(Blob);
    if (!(output instanceof Blob)) throw new Error('expected a Blob output');
    const outputBytes = new Uint8Array(await output.arrayBuffer());
    const after = webmPacketPayloadInfoFromBytes(outputBytes);

    const trackTruth = (track: TrackInfo): unknown => ({
      mediaType: track.mediaType,
      codec: track.codec,
      durationSec: track.durationSec,
      fps: track.fps,
      rotation: track.rotation,
      alpha: track.alpha,
      color: track.color,
      config: track.config,
    });
    expect(after.tracks.map(trackTruth)).toEqual(before.tracks.map(trackTruth));
    const packetTruth = (
      table: ReturnType<typeof webmPacketPayloadInfoFromBytes>,
    ): readonly unknown[] =>
      table.packets.map(({ offset: _offset, data, alpha, ...timing }) => ({
        ...timing,
        colorSha256: createHash('sha256').update(data).digest('hex'),
        ...(alpha === undefined
          ? {}
          : { alphaSha256: createHash('sha256').update(alpha).digest('hex') }),
      }));
    expect(packetTruth(after)).toEqual(packetTruth(before));
    expect(after.packets.filter((packet) => packet.alpha !== undefined)).toHaveLength(82);
  });

  it('rewrites selected real03 with redundant audio exclusion and exact 60-plane packet truth', async () => {
    const inputPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../media-test/fixtures/media/scenarios/transcode/vp9_alpha_to_vp9_keepalpha/03.webm',
    );
    const input = Uint8Array.from(readFileSync(inputPath));
    expect(createHash('sha256').update(input).digest('hex')).toBe(
      '518640653e936308e2c85aae4d6f02b35bbac468b82c36486732e284d599e513',
    );
    const before = webmPacketPayloadInfoFromBytes(input);
    expect(before.tracks).toHaveLength(1);
    expect(before.tracks[0]).toMatchObject({
      mediaType: 'video',
      codec: 'vp9',
      durationSec: 2.4,
      fps: 25,
      alpha: true,
      config: { codec: 'vp09.00.11.08', codedWidth: 200, codedHeight: 200 },
    });
    expect(before.packets).toHaveLength(60);
    expect(before.packets.filter((packet) => packet.alpha !== undefined)).toHaveLength(60);

    // The redundant audio exclusion is proved from zero audio tracks. Node has no VP9 codec backend, so
    // success also proves that the public route never opened a decoder or encoder.
    const output = await createMedia({ worker: false }).convert(input, {
      to: 'webm',
      video: { codec: 'vp9', alpha: 'keep' },
      audio: false,
    });
    expect(output).toBeInstanceOf(Blob);
    if (!(output instanceof Blob)) throw new Error('expected a Blob output');
    const outputBytes = new Uint8Array(await output.arrayBuffer());
    expect(outputBytes).toHaveLength(3862);
    expect(createHash('sha256').update(outputBytes).digest('hex')).toBe(
      '25dd20c3ed93ef38f371036c8b41b7f53523ca472658af59493d613f1dda9152',
    );
    const after = webmPacketPayloadInfoFromBytes(outputBytes);
    const trackTruth = (track: TrackInfo): unknown => ({
      mediaType: track.mediaType,
      codec: track.codec,
      durationSec: track.durationSec,
      fps: track.fps,
      rotation: track.rotation,
      alpha: track.alpha,
      color: track.color,
      config: track.config,
    });
    const packetTruth = (
      table: ReturnType<typeof webmPacketPayloadInfoFromBytes>,
    ): readonly unknown[] =>
      table.packets.map(({ offset: _offset, data, alpha, ...timing }) => ({
        ...timing,
        colorSha256: createHash('sha256').update(data).digest('hex'),
        ...(alpha === undefined
          ? {}
          : { alphaSha256: createHash('sha256').update(alpha).digest('hex') }),
      }));
    expect(after.tracks.map(trackTruth)).toEqual(before.tracks.map(trackTruth));
    expect(packetTruth(after)).toEqual(packetTruth(before));
    expect(after.packets.filter((packet) => packet.alpha !== undefined)).toHaveLength(60);
  });

  it('does not pre-probe a declared-alpha one-shot stream and aborts typed range proof safely', async () => {
    const mediaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media');
    const bytes = Uint8Array.from(readFileSync(resolve(mediaRoot, 'bear-vp9-alpha.webm')));
    let offset = 0;
    const oneShot = fromStream(
      new ReadableStream<Uint8Array>(
        {
          pull(controller): void {
            if (offset >= bytes.byteLength) {
              controller.close();
              return;
            }
            const end = Math.min(offset + 4093, bytes.byteLength);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          },
        },
        { highWaterMark: 0 },
      ),
      { mime: 'video/webm' },
    );
    await expect(
      createMedia({ worker: false }).convert(oneShot, {
        to: 'webm',
        video: { codec: 'vp9', alpha: 'keep' },
      }),
    ).rejects.toThrow();
    expect(offset).toBe(bytes.byteLength);

    const abort = new AbortController();
    let rangeReads = 0;
    const seekable: Source = {
      __media: 'source',
      kind: 'url',
      mimeHint: 'video/webm',
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        rangeReads++;
        abort.abort();
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('aborted metadata proof must not open the replay stream');
      },
    };
    await expect(
      createMedia({ worker: false }).convert(
        seekable,
        { to: 'webm', video: { codec: 'vp9', alpha: 'keep' } },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(rangeReads).toBe(1);
  });

  it('declines a real non-zero display-rotation source instead of guessing display geometry', async () => {
    const mediaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media');
    const input = Uint8Array.from(readFileSync(resolve(mediaRoot, 'bear-rotate-90.mp4')));
    const media = createMedia({ worker: false });
    const info = await media.probe(input);
    const video = info.tracks.find((track) => track.type === 'video');
    expect(video?.rotation).toBe(90);
    if (video?.width === undefined || video.height === undefined) {
      throw new Error('rotation fixture must have video geometry');
    }
    // Node has no native WebCodecs video path. Rejection therefore proves semantic-copy declined the
    // unnormalized rotation and left the request on the real decode/filter/encode route.
    await expect(
      media.convert(input, {
        to: 'mp4',
        video: { codec: 'h264', width: video.width, height: video.height, rotate: 0 },
      }),
    ).rejects.toThrow();
  });
});
