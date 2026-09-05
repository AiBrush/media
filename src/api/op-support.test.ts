import { describe, expect, it } from 'vitest';
import type { ContainerDriver, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { toOpfsTarget } from '../sinks/opfs-target.ts';
import { toBlob, toOPFS } from '../sinks/sink.ts';
import { toStreamTarget } from '../sinks/stream-target.ts';
import type { Source } from '../sources/source.ts';
import {
  isFlacAuthorCodec,
  isPinnedDriverMiss,
  isRawPcmTrack,
  muxOptionsFrom,
  sourceGeometryOf,
  stageStrategy,
} from './op-support.ts';
import { toMediaInfo } from './probe-media-info.ts';
import { validateReservedFaststart } from './reserved-faststart.ts';
import type { MuxSpec, RemuxOptions } from './types.ts';

function reserve(overrides: Partial<MuxSpec> = {}): MuxSpec {
  return {
    container: 'mp4',
    faststart: 'reserve',
    maximumPacketCount: 8,
    sink: toStreamTarget(() => undefined),
    ...overrides,
  };
}

describe('reserved faststart public preflight', () => {
  it('projects every optional mux flag without manufacturing absent fields', () => {
    expect(muxOptionsFrom({})).toEqual({});
    expect(
      muxOptionsFrom(
        {
          container: 'mp4',
          faststart: 'reserve',
          maximumPacketCount: 32,
          fragmented: false,
        },
        'mov',
      ),
    ).toEqual({
      faststart: 'reserve',
      maximumPacketCount: 32,
      fragmented: false,
      container: 'mov',
    });
  });

  it('accepts callbacks, seekable destinations, and both OPFS descriptors', () => {
    expect(() => validateReservedFaststart('mux', 'mp4', reserve())).not.toThrow();
    expect(() =>
      validateReservedFaststart(
        'convert',
        'mov',
        reserve({
          container: 'mov',
          sink: toStreamTarget({ seek: () => Promise.resolve() } as unknown as WritableStream),
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateReservedFaststart('mux', 'mp4', reserve({ sink: toOPFS('/out.mp4') })),
    ).not.toThrow();
    expect(() =>
      validateReservedFaststart('mux', 'mp4', reserve({ sink: toOpfsTarget('/out.mp4') })),
    ).not.toThrow();
  });

  it.each([
    {
      name: 'maximumPacketCount without reserve',
      target: 'mp4',
      options: { container: 'mp4', maximumPacketCount: 8 } as MuxSpec,
      message: 'valid only',
    },
    {
      name: 'implicit target',
      target: undefined,
      options: reserve(),
      message: 'explicit mp4 or mov',
    },
    {
      name: 'non-MP4 target',
      target: 'webm',
      options: reserve({ container: 'webm' }),
      message: 'explicit mp4 or mov',
    },
    {
      name: 'missing packet ceiling',
      target: 'mp4',
      options: { ...reserve(), maximumPacketCount: undefined } as unknown as MuxSpec,
      message: 'positive integer',
    },
    {
      name: 'fractional packet ceiling',
      target: 'mp4',
      options: reserve({ maximumPacketCount: 1.5 }),
      message: 'positive integer',
    },
    {
      name: 'zero packet ceiling',
      target: 'mp4',
      options: reserve({ maximumPacketCount: 0 }),
      message: 'positive integer',
    },
    {
      name: 'fragmented layout',
      target: 'mp4',
      options: reserve({ fragmented: true }),
      message: 'fragmented',
    },
    {
      name: 'missing sink',
      target: 'mp4',
      options: { ...reserve(), sink: undefined } as unknown as MuxSpec,
      message: 'position-aware',
    },
    {
      name: 'buffer sink',
      target: 'mp4',
      options: reserve({ sink: toBlob() }),
      message: 'position-aware',
    },
    {
      name: 'exact write shaping',
      target: 'mp4',
      options: reserve({
        sink: toStreamTarget(() => undefined, { writeChunkBytes: 188 }),
      }),
      message: 'writeChunkBytes',
    },
  ])('rejects $name as bad input', ({ target, options, message }) => {
    expect(() => validateReservedFaststart('mux', target, options)).toThrowError(InputError);
    expect(() => validateReservedFaststart('mux', target, options)).toThrowError(message);
  });

  it('rejects post-mux tag rewrites before reading input', () => {
    const options: RemuxOptions = {
      to: 'mp4',
      faststart: 'reserve',
      maximumPacketCount: 8,
      tags: { title: 'new title' },
      sink: toStreamTarget(() => undefined),
    };
    expect(() => validateReservedFaststart('remux', 'mp4', options)).toThrowError(
      /metadata rewrite/,
    );
  });

  it.each([
    ['append-only WritableStream', new WritableStream<Uint8Array>()],
    ['null destination', null],
    ['scalar destination', 42],
    ['non-seekable object', {}],
  ])('rejects a %s with a typed positioned-write capability miss', (_name, destination) => {
    const options = reserve({
      sink: toStreamTarget(destination as never),
    });
    expect(() => validateReservedFaststart('mux', 'mp4', options)).toThrowError(CapabilityError);
  });
});

describe('operation support projections', () => {
  it('preserves only explicit stage routing choices', () => {
    expect(stageStrategy({})).toEqual({ determinism: 'auto' });
    expect(stageStrategy({ determinism: 'force-software', pinDriver: 'wasm-vpx' })).toEqual({
      determinism: 'force-software',
      pinDriver: 'wasm-vpx',
    });
  });

  it('recognizes only an exact single-driver pinned miss', () => {
    const miss = (message: string, detail: unknown) =>
      new CapabilityError(message, detail as ConstructorParameters<typeof CapabilityError>[1]);
    expect(isPinnedDriverMiss(miss('pinned route missed', { tried: ['native'] }), 'native')).toBe(
      true,
    );
    expect(isPinnedDriverMiss(miss('ordinary route missed', { tried: ['native'] }), 'native')).toBe(
      false,
    );
    expect(isPinnedDriverMiss(miss('pinned route missed', null), 'native')).toBe(false);
    expect(isPinnedDriverMiss(miss('pinned route missed', {}), 'native')).toBe(false);
    expect(isPinnedDriverMiss(miss('pinned route missed', { tried: 'native' }), 'native')).toBe(
      false,
    );
    expect(isPinnedDriverMiss(miss('pinned route missed', { tried: [] }), 'native')).toBe(false);
    expect(isPinnedDriverMiss(miss('pinned route missed', { tried: ['other'] }), 'native')).toBe(
      false,
    );
    expect(isPinnedDriverMiss(miss('pinned route missed', { tried: ['native'] }), undefined)).toBe(
      false,
    );
  });

  it('classifies raw PCM and every lossless FLAC authoring token without accepting lossy codecs', () => {
    const track = (codec: string): TrackInfo => ({ id: 1, mediaType: 'audio', codec });
    expect(isRawPcmTrack(track('pcm'))).toBe(true);
    expect(isRawPcmTrack(track('pcm-s24'))).toBe(true);
    expect(isRawPcmTrack(track('aac'))).toBe(false);
    expect([undefined, 'flac', 'pcm', 'pcm-s16'].map(isFlacAuthorCodec)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(isFlacAuthorCodec('opus')).toBe(false);
  });

  it('keeps sparse video geometry sparse even when a decoder config object exists', () => {
    expect(
      sourceGeometryOf({
        id: 1,
        mediaType: 'video',
        codec: 'h264',
        config: { codec: 'avc1.42E01E', codedWidth: undefined, codedHeight: undefined },
      } as unknown as TrackInfo),
    ).toEqual({ width: undefined, height: undefined });
  });

  it('materializes unknown, non-media, sparse-video, and audio track facts exactly', () => {
    const container = { formats: [] } as unknown as ContainerDriver;
    const source = {
      __media: 'source',
      kind: 'bytes',
      stream: () => new ReadableStream<Uint8Array>(),
    } as Source;
    const info = toMediaInfo(
      container,
      [
        { id: 1, mediaType: 'audio', codec: 'json', nonMedia: true },
        {
          id: 2,
          mediaType: 'video',
          codec: 'h264',
          config: { codec: 'avc1.42E01E', codedWidth: undefined, codedHeight: undefined },
          durationSec: 2,
          fps: 24,
          rotation: 270,
        } as unknown as TrackInfo,
        {
          id: 3,
          mediaType: 'audio',
          codec: 'opus',
          config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
        },
      ],
      source,
    );
    expect(info).toEqual({
      container: 'unknown',
      durationSec: 2,
      tracks: [
        { id: 1, type: 'other', codec: 'json' },
        { id: 2, type: 'video', codec: 'h264', durationSec: 2, fps: 24, rotation: 270 },
        { id: 3, type: 'audio', codec: 'opus', sampleRate: 48_000, channels: 2 },
      ],
    });
  });
});
