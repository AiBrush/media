import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { Mp3Driver, Mp3Module, parseMp3 } from './mp3-driver.ts';

// MPEG1 Layer III header. version 3, layer III, bitrateIdx 9 (128k), srIdx 0 (44100).
function header(
  opts: { mono?: boolean; bitrateIdx?: number; version?: number; srIdx?: number } = {},
): number[] {
  const version = opts.version ?? 3;
  const b1 = 0xe0 | (version << 3) | (0x1 << 1) | 1; // sync + version + Layer III + protection
  const b2 = ((opts.bitrateIdx ?? 9) << 4) | ((opts.srIdx ?? 0) << 2);
  const b3 = (opts.mono ? 0x3 : 0x0) << 6;
  return [0xff, b1 & 0xff, b2 & 0xff, b3 & 0xff];
}
function frameLen(version = 3, bitrateKbps = 128, sampleRate = 44100): number {
  const coeff = version === 3 ? 144 : 72;
  return Math.floor((coeff * bitrateKbps * 1000) / sampleRate);
}
function pad(head: number[], to: number): number[] {
  return [...head, ...new Array<number>(Math.max(0, to - head.length)).fill(0)];
}

describe('Mp3Driver.supports', () => {
  it('recognizes frame-sync + ID3, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('sound_5.mp3')).subarray(0, 16);
    expect(Mp3Driver.supports({ direction: 'demux', head })).toBe(true);
    expect(
      Mp3Driver.supports({ direction: 'demux', head: new Uint8Array([0xff, 0xfb, 0, 0]) }),
    ).toBe(true);
    expect(
      Mp3Driver.supports({ direction: 'demux', head: new Uint8Array([0x49, 0x44, 0x33]) }),
    ).toBe(true);
    expect(Mp3Driver.supports({ direction: 'demux', mime: 'audio/mpeg' })).toBe(true);
    expect(Mp3Driver.supports({ direction: 'demux', extension: 'mp3' })).toBe(true);
    expect(Mp3Driver.supports({ direction: 'demux', head: new Uint8Array([0, 1]) })).toBe(false);
    expect(Mp3Driver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe MP3 on the real corpus', () => {
  it('sound_5.mp3 — sane params (invariants)', async () => {
    const info = await createMedia()
      .use(Mp3Module)
      .probe(await fixtureSource('sound_5.mp3'));
    expect(info.container).toBe('mp3');
    expect(info.tracks).toHaveLength(1);
    expect(info.tracks[0]?.codec).toBe('mp3');
    expect([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000]).toContain(
      info.tracks[0]?.sampleRate,
    );
    expect(info.durationSec).toBeGreaterThan(0);
  });

  it('sound_5.mp3 probe matches its committed golden exactly', async () => {
    const info = await createMedia()
      .use(Mp3Module)
      .probe(await fixtureSource('sound_5.mp3'));
    expect(info).toEqual(await loadGoldenMetadata('sound_5.mp3'));
  });
});

describe('parseMp3 — frame variants + duration', () => {
  const fl = frameLen();

  it('estimates a CBR duration from two confirmed frames', () => {
    const bytes = new Uint8Array([...pad(header(), fl), ...pad(header(), fl)]);
    const info = parseMp3(bytes, bytes.byteLength);
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
    expect(info.durationSec).toBeCloseTo((bytes.byteLength * 8) / (128 * 1000), 5);
  });

  it('reads an exact Xing VBR frame count', () => {
    const f = pad(header(), fl);
    const tagAt = 4 + 32; // MPEG1 stereo side-info
    f.splice(tagAt, 12, ...[...'Xing'].map((c) => c.charCodeAt(0)), 0, 0, 0, 1, 0, 0, 0, 100);
    const info = parseMp3(new Uint8Array([...f, ...pad(header(), fl)]));
    expect(info.durationSec).toBeCloseTo((100 * 1152) / 44100, 5);
  });

  it('skips an ID3v2 tag, and reads a mono MPEG2 frame', () => {
    const id3 = [...'ID3'].map((c) => c.charCodeAt(0)).concat([3, 0, 0, 0, 0, 0, 4]); // 4-byte tag body
    const fl2 = frameLen(2, 8, 22050);
    const head = header({ version: 2, bitrateIdx: 1, srIdx: 0, mono: true }); // MPEG2 8k 22050 mono
    const bytes = new Uint8Array([...id3, 0, 0, 0, 0, ...pad(head, fl2), ...pad(head, fl2)]);
    const info = parseMp3(bytes, bytes.byteLength);
    expect(info.sampleRate).toBe(22050);
    expect(info.channels).toBe(1);
  });

  it('rejects a buffer with no valid frame header', () => {
    expect(() => parseMp3(new Uint8Array([0xff, 0x00, 0x00, 0x00, 1, 2, 3, 4]))).toThrowError(
      InputError,
    );
  });

  it('skips invalid frame headers (reserved version/layer, bad bitrate/samplerate) before locking', () => {
    const invalids = [
      0xff,
      0xeb,
      0x90,
      0x00, // version reserved (1)
      0xff,
      0xf9,
      0x90,
      0x00, // layer reserved (0)
      0xff,
      0xfb,
      0xf0,
      0x00, // bitrateIdx 15
      0xff,
      0xfb,
      0x00,
      0x00, // bitrateIdx 0
      0xff,
      0xfb,
      0x9c,
      0x00, // srIdx 3
    ];
    const fl = frameLen();
    const bytes = new Uint8Array([...invalids, ...pad(header(), fl), ...pad(header(), fl)]);
    expect(parseMp3(bytes, bytes.byteLength).sampleRate).toBe(44100);
  });
});

describe('Mp3Driver — demux seam + muxer', () => {
  it('demuxes a non-seekable stream source; the packet seam is a typed gap in node', async () => {
    const bytes = await loadFixture('sound_5.mp3');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxed = await Mp3Driver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('mp3');
    expect(() => demuxed.packets(0)).toThrowError(/browser codec layer/);
    await demuxed.close();
  });

  it('createMuxer is a typed out-of-scope error', () => {
    expect(() => Mp3Driver.createMuxer()).toThrowError(MediaError);
  });
});
