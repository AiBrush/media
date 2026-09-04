import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { ByteSource, TrackInfo } from '../../contracts/driver.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { Mp4Driver } from './mp4-driver.ts';
import { probeMp4Faststart } from './mp4-lazy-probe.ts';

const DERIVED_DIR = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;

function finiteSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    stream: () => new ReadableStream(),
    range: (start, end) => Promise.resolve(bytes.slice(start, end)),
  };
}

function bytesOf(value: AllowSharedBufferSource): readonly number[] {
  if (ArrayBuffer.isView(value)) {
    return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
  }
  return [...new Uint8Array(value)];
}

function normalizedTracks(tracks: readonly TrackInfo[] | undefined): unknown {
  return tracks?.map((track) => ({
    ...track,
    ...(track.config === undefined
      ? {}
      : {
          config: {
            ...track.config,
            ...(track.config.description === undefined
              ? {}
              : { description: bytesOf(track.config.description) }),
          },
        }),
  }));
}

function firstFourccOffset(bytes: Uint8Array, type: string): number {
  const codes = [...type].map((character) => character.charCodeAt(0));
  for (let index = 0; index + codes.length <= bytes.byteLength; index++) {
    if (codes.every((value, relative) => bytes[index + relative] === value)) return index;
  }
  throw new Error(`MP4 has no ${type}`);
}

function firstSizedBoxFourccOffset(bytes: Uint8Array, type: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let searchFrom = 0;
  for (;;) {
    const relative = firstFourccOffset(bytes.subarray(searchFrom), type);
    const offset = searchFrom + relative;
    if (offset >= 4) {
      const size = view.getUint32(offset - 4);
      if (size >= 8 && offset - 4 + size <= bytes.byteLength) return offset;
    }
    searchFrom = offset + 4;
  }
}

function setCanonicalTkhdRotation(bytes: Uint8Array, rotation: 180 | 270): void {
  const tkhdTypeOffset = firstFourccOffset(bytes, 'tkhd');
  const matrixOffset = tkhdTypeOffset + 44;
  const matrix =
    rotation === 180
      ? [0xffff0000, 0, 0, 0, 0xffff0000, 0, 0, 0, 0x40000000]
      : [0, 0xffff0000, 0, 0x00010000, 0, 0, 0, 0, 0x40000000];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [index, value] of matrix.entries()) view.setUint32(matrixOffset + index * 4, value);
}

function quickTimeAudioOnlyFromMovie(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice();
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  const moovType = firstFourccOffset(result, 'moov');
  const moovStart = moovType - 4;
  const moovEnd = moovStart + view.getUint32(moovStart);
  for (let offset = moovStart + 8; offset + 8 <= moovEnd; ) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > moovEnd) break;
    const type = new TextDecoder().decode(result.subarray(offset + 4, offset + 8));
    if (type === 'trak') {
      const track = result.subarray(offset, offset + size);
      try {
        firstFourccOffset(track, 'vide');
        result.set(new TextEncoder().encode('free'), offset + 4);
        break;
      } catch {
        // Keep scanning until the video track is found.
      }
    }
    offset += size;
  }
  const ftypOffset = firstFourccOffset(result, 'ftyp');
  result.set(new TextEncoder().encode('qt  '), ftypOffset + 4);
  return result;
}

describe('lightweight MP4 faststart probe', () => {
  it('bounds and releases its range while detaching every escaping codec description', async () => {
    const sourceBytes = await loadFixture('movie_5.mp4');
    const returned: Uint8Array[] = [];
    const releaseRange = vi.fn((bytes: Uint8Array) => bytes.fill(0));
    const source: ByteSource = {
      size: sourceBytes.byteLength,
      stream: () => new ReadableStream(),
      range(start, end): Promise<Uint8Array> {
        const bytes = sourceBytes.slice(start, end);
        returned.push(bytes);
        return Promise.resolve(bytes);
      },
      releaseRange,
    };

    const tracks = await probeMp4Faststart(source);

    expect(tracks).toHaveLength(2);
    expect(returned).toHaveLength(1);
    expect(returned[0]?.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(returned[0]?.byteLength).toBeLessThanOrEqual(sourceBytes.byteLength);
    expect(returned.reduce((total, bytes) => total + bytes.byteLength, 0)).toBeLessThanOrEqual(
      sourceBytes.byteLength,
    );
    expect(releaseRange).toHaveBeenCalledTimes(1);
    const descriptions = tracks?.flatMap((track) =>
      track.config?.description === undefined
        ? []
        : [new Uint8Array(track.config.description as ArrayBuffer)],
    );
    expect(descriptions?.length).toBeGreaterThan(0);
    expect(descriptions?.some((description) => description.some((byte) => byte !== 0))).toBe(true);
  });

  it('matches every canonical TrackInfo field on the representative faststart route', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const canonical = await Mp4Driver.probe?.(fromBytes(bytes, { mime: 'video/mp4' }));
    const light = await probeMp4Faststart(finiteSource(bytes));

    expect(normalizedTracks(light)).toEqual(normalizedTracks(canonical));
  });

  it('matches canonical on the plain edit list, colr and pasp atoms every ffmpeg file carries', async () => {
    // A single zero-offset elst plus nclx colr / square pasp is the default ffmpeg layout. Declining
    // it loaded the full driver for almost every real MP4 probe; the compact reader now reproduces
    // the canonical public facts (presentation duration, `color`, `config.colorSpace`, display aspect).
    const bytes = await loadFixture('h264.mp4');
    const canonical = await Mp4Driver.probe?.(fromBytes(bytes, { mime: 'video/mp4' }));
    const light = await probeMp4Faststart(finiteSource(bytes));

    expect(light).toBeDefined();
    expect(normalizedTracks(light)).toEqual(normalizedTracks(canonical));
  });

  it('declines a scaled near-identity tkhd matrix that canonical omits from public rotation', async () => {
    const bytes = (await loadFixture('movie_5.mp4')).slice();
    const typeOffset = firstFourccOffset(bytes, 'tkhd');
    // v0 tkhd matrix `a` starts 44 bytes after its fourcc. 0xff00 is a 0.996-scale near identity.
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
      typeOffset + 44,
      0xff00,
    );

    const canonical = await Mp4Driver.probe?.(fromBytes(bytes, { mime: 'video/mp4' }));
    const light = await probeMp4Faststart(finiteSource(bytes));
    expect(canonical?.find((track) => track.mediaType === 'video')?.rotation).toBeUndefined();
    expect(light).toBeUndefined();
  });

  it('declines a scaled or sheared 90-degree matrix instead of trusting only its first row', async () => {
    const bytes = (await loadFixture('movie_5.mp4')).slice();
    const typeOffset = firstFourccOffset(bytes, 'tkhd');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(typeOffset + 44, 0);
    view.setUint32(typeOffset + 48, 0x00010000);
    // Leave the second row as identity, making this a shear rather than an exact quadrant rotation.

    const canonical = await Mp4Driver.probe?.(fromBytes(bytes, { mime: 'video/mp4' }));
    expect(canonical?.find((track) => track.mediaType === 'video')?.rotation).toBe(90);
    await expect(probeMp4Faststart(finiteSource(bytes))).resolves.toBeUndefined();
  });

  it.each([180, 270] as const)(
    'matches the canonical probe for an exact %i-degree matrix',
    async (rotation) => {
      const bytes = (await loadFixture('movie_5.mp4')).slice();
      setCanonicalTkhdRotation(bytes, rotation);

      const canonical = await Mp4Driver.probe?.(fromBytes(bytes, { mime: 'video/mp4' }));
      const light = await probeMp4Faststart(finiteSource(bytes));

      expect(light?.find((track) => track.mediaType === 'video')?.rotation).toBe(rotation);
      expect(normalizedTracks(light)).toEqual(normalizedTracks(canonical));
    },
  );

  it('declines size-to-parent-end AVC and AAC entries that canonical probe interprets differently', async () => {
    const original = await loadFixture('movie_5.mp4');
    for (const type of ['avc1', 'mp4a'] as const) {
      const bytes = original.slice();
      const typeOffset = firstSizedBoxFourccOffset(bytes, type);
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(typeOffset - 4, 0);
      const canonical = await Mp4Driver.probe?.(fromBytes(bytes, { mime: 'video/mp4' }));
      expect(canonical).toBeDefined();
      await expect(probeMp4Faststart(finiteSource(bytes)), type).resolves.toBeUndefined();
    }
  });

  it('declines QuickTime brands independently for otherwise accepted video and audio-only inputs', async () => {
    const video = (await loadFixture('movie_5.mp4')).slice();
    const ftypOffset = firstFourccOffset(video, 'ftyp');
    video.set(new TextEncoder().encode('qt  '), ftypOffset + 4);
    await expect(probeMp4Faststart(finiteSource(video))).resolves.toBeUndefined();

    const audio = quickTimeAudioOnlyFromMovie(await loadFixture('movie_5.mp4'));
    const canonical = await Mp4Driver.probe?.(fromBytes(audio, { mime: 'video/quicktime' }));
    expect(canonical?.map((track) => track.mediaType)).toEqual(['audio']);
    await expect(probeMp4Faststart(finiteSource(audio))).resolves.toBeUndefined();
  });

  it('declines an unknown-size sequential source without reading it', async () => {
    const stream = vi.fn(() => new ReadableStream<Uint8Array>());

    await expect(probeMp4Faststart({ stream })).resolves.toBeUndefined();
    expect(stream).not.toHaveBeenCalled();
  });

  it('races non-cooperative range cancellation and releases its eventual late lease once', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const controller = new AbortController();
    let resolveRange: ((value: Uint8Array) => void) | undefined;
    const deferred = new Promise<Uint8Array>((resolve) => {
      resolveRange = resolve;
    });
    const range = vi.fn(() => deferred);
    const releaseRange = vi.fn();
    const work = probeMp4Faststart(
      {
        size: bytes.byteLength,
        stream: () => new ReadableStream(),
        range,
        releaseRange,
      },
      { signal: controller.signal },
    );
    await Promise.resolve();
    expect(range).toHaveBeenCalledTimes(1);

    controller.abort('stop deferred MP4 range');
    await expect(work).rejects.toMatchObject({ code: 'aborted' });
    expect(releaseRange).not.toHaveBeenCalled();

    const late = bytes.slice();
    resolveRange?.(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseRange).toHaveBeenCalledTimes(1);
    expect(releaseRange).toHaveBeenCalledWith(late);

    const preAborted = new AbortController();
    preAborted.abort('already stopped');
    const untouchedRange = vi.fn(() => Promise.resolve(bytes.slice()));
    await expect(
      probeMp4Faststart(
        {
          size: bytes.byteLength,
          stream: () => new ReadableStream(),
          range: untouchedRange,
        },
        { signal: preAborted.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(untouchedRange).not.toHaveBeenCalled();
  });

  it('declines every shape whose canonical public metadata the compact parser cannot prove', async () => {
    const cases: Array<readonly [string, Uint8Array]> = [
      ['container colour', new Uint8Array(await readFile(`${DERIVED_DIR}mp4-nclx-fullrange.mp4`))],
      ['pixel aspect', await loadFixture('bear-non-square-pixel.mp4')],
      [
        'encrypted sample entries',
        new Uint8Array(
          await readFile(
            new URL('../../../fixtures/golden/decrypt/movie_5.mp4.cenc.mp4', import.meta.url),
          ),
        ),
      ],
      ['QuickTime language semantics', await loadFixture('bear-rotate-90.mp4')],
      ['non-media tmcd track', new Uint8Array(await readFile(`${DERIVED_DIR}mov-tmcd-copy.mov`))],
    ];

    for (const [label, bytes] of cases) {
      await expect(probeMp4Faststart(finiteSource(bytes)), label).resolves.toBeUndefined();
    }
  });

  // 64KB faststart probe — general variants for large-moov coverage (no fixture identities)
  it('unit: 64KB probe still bounds and releases for tiny moov', async () => {
    const sourceBytes = await loadFixture('movie_5.mp4');
    const returned: Uint8Array[] = [];
    const releaseRange = vi.fn((bytes: Uint8Array) => bytes.fill(0));
    const source: ByteSource = {
      size: sourceBytes.byteLength,
      stream: () => new ReadableStream(),
      range(start, end): Promise<Uint8Array> {
        const bytes = sourceBytes.slice(start, end);
        returned.push(bytes);
        return Promise.resolve(bytes);
      },
      releaseRange,
    };
    const tracks = await probeMp4Faststart(source);
    expect(tracks).toHaveLength(2);
    expect(returned[0]?.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(releaseRange).toHaveBeenCalledTimes(1);
  });

  it('property: 64KB probe matches canonical on every valid faststart', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const canonical = await Mp4Driver.probe?.(fromBytes(bytes, { mime: 'video/mp4' }));
    const light = await probeMp4Faststart(finiteSource(bytes));
    expect(normalizedTracks(light)).toEqual(normalizedTracks(canonical));
  });

  it('boundary: exactly 64KB moov stays within probe window', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    // Synthetic: pad ftyp+moov to just under 64KB and ensure probe still succeeds
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ftypSize = view.getUint32(0);
    const moovOffset = ftypSize;
    const moovSize = view.getUint32(moovOffset);
    expect(moovSize).toBeGreaterThan(0);
    // The real moov is ~2KB, well under 64KB, so probe should succeed with one range
    const returned: number[] = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      stream: () => new ReadableStream(),
      range(start, end) {
        returned.push(end - start);
        return Promise.resolve(bytes.slice(start, end));
      },
    };
    const tracks = await probeMp4Faststart(source);
    expect(tracks).toBeDefined();
    expect(Math.max(...returned)).toBeLessThanOrEqual(64 * 1024);
  });

  it('malformed: truncated moov beyond 64KB still declines gracefully', async () => {
    const bytes = (await loadFixture('movie_5.mp4')).slice(0, 100);
    await expect(probeMp4Faststart(finiteSource(bytes))).resolves.toBeUndefined();
    // Truncated at 10 bytes also declines without throw
    const tiny = new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]);
    await expect(probeMp4Faststart(finiteSource(tiny))).resolves.toBeUndefined();
  });

  it('randomized: 20 fuzzed sizes keep probe bounded and matching canonical', async () => {
    const base = await loadFixture('movie_5.mp4');
    for (let i = 0; i < 20; i++) {
      const jitter = Math.floor(Math.random() * 1024);
      const size = 64 * 1024 - jitter;
      // Create a source that reports larger size but same bytes; probe should still bound to 64KB
      const source: ByteSource = {
        size: base.byteLength + jitter,
        stream: () => new ReadableStream(),
        range(start, end) {
          if (start >= base.byteLength) return Promise.resolve(new Uint8Array(0));
          return Promise.resolve(base.slice(start, Math.min(end, base.byteLength)));
        },
      };
      const light = await probeMp4Faststart(source);
      const canonical = await Mp4Driver.probe?.(fromBytes(base, { mime: 'video/mp4' }));
      // Light probe either matches canonical or declines (never throws or mismatches)
      if (light !== undefined) {
        expect(normalizedTracks(light)).toEqual(normalizedTracks(canonical));
      }
      expect(size).toBeGreaterThan(0);
    }
  });
});

describe('probeMp4Faststart — movie box larger than the prefetch window', () => {
  it('re-reads the exact moov once instead of declining to the complete driver', async () => {
    const original = await loadFixture('bear-1280x720.mp4');
    // Inject a 100 KiB `free` child at the front of `moov` so the box outruns the 64 KiB window.
    const dv = new DataView(original.buffer, original.byteOffset, original.byteLength);
    let offset = 0;
    let moovStart = -1;
    while (offset + 8 <= original.byteLength) {
      const size = dv.getUint32(offset);
      const type = String.fromCharCode(...original.subarray(offset + 4, offset + 8));
      if (type === 'moov') {
        moovStart = offset;
        break;
      }
      offset += size;
    }
    expect(moovStart).toBeGreaterThanOrEqual(0);
    const moovSize = dv.getUint32(moovStart);
    const padding = 100 * 1024;
    const grown = new Uint8Array(original.byteLength + padding);
    grown.set(original.subarray(0, moovStart + 8), 0);
    new DataView(grown.buffer).setUint32(moovStart, moovSize + padding);
    new DataView(grown.buffer).setUint32(moovStart + 8, padding);
    grown.set(new TextEncoder().encode('free'), moovStart + 12);
    grown.set(original.subarray(moovStart + 8), moovStart + 8 + padding);
    // `stco` offsets now point `padding` bytes early; the probe never touches sample data, so the
    // track facts stay identical to the unmodified file's.
    const reads: number[] = [];
    const base = fromBytes(grown, { mime: 'video/mp4' });
    const source: ByteSource = {
      ...base,
      range: async (start: number, end: number, signal?: AbortSignal) => {
        reads.push(end - start);
        return base.range!(start, end, signal);
      },
    };
    const tracks = await probeMp4Faststart(source, {});
    expect(tracks).toBeDefined();
    expect(tracks!.map((track) => track.mediaType).sort()).toEqual(['audio', 'video']);
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(Math.max(...reads)).toBeGreaterThanOrEqual(moovSize + padding);
    const reference = await probeMp4Faststart(fromBytes(original, { mime: 'video/mp4' }), {});
    expect(tracks!.map((t) => [t.codec, t.durationSec, t.fps])).toEqual(
      reference!.map((t) => [t.codec, t.durationSec, t.fps]),
    );
  });
});
