import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { Mp3Driver } from '../mp3/mp3-driver.ts';
import { AdtsDriver, parseAdts } from './adts-driver.ts';

/** Build a crafted ADTS stream of `count` AAC frames (7-byte headers + zero payload). */
function buildAdts(
  opts: {
    count?: number;
    freqIndex?: number;
    channelConfig?: number;
    profile?: number;
    payload?: number;
    id3?: boolean;
  } = {},
): Uint8Array {
  const {
    count = 3,
    freqIndex = 4,
    channelConfig = 2,
    profile = 1,
    payload = 5,
    id3 = false,
  } = opts;
  const frameLen = 7 + payload;
  const bytes: number[] = [];
  if (id3) bytes.push(0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const b2 = ((profile & 0x3) << 6) | ((freqIndex & 0xf) << 2) | ((channelConfig >> 2) & 0x1);
    const b3 = ((channelConfig & 0x3) << 6) | ((frameLen >> 11) & 0x3);
    bytes.push(0xff, 0xf1, b2, b3, (frameLen >> 3) & 0xff, ((frameLen & 0x7) << 5) | 0x1f, 0xfc);
    for (let j = 0; j < payload; j++) bytes.push(0);
  }
  return new Uint8Array(bytes);
}

describe('AdtsDriver.supports — incl. MP3 disambiguation', () => {
  it('recognizes the syncword, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('sfx.adts')).subarray(0, 16);
    expect(AdtsDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(AdtsDriver.supports({ direction: 'demux', mime: 'audio/aac' })).toBe(true);
    expect(AdtsDriver.supports({ direction: 'demux', extension: 'aac' })).toBe(true);
    expect(AdtsDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
  });

  it('ADTS and MP3 are mutually exclusive by the layer bits', async () => {
    const adtsHead = (await loadFixture('sfx.adts')).subarray(0, 8);
    const mp3Head = (await loadFixture('sound_5.mp3')).subarray(0, 8);
    expect(AdtsDriver.supports({ direction: 'demux', head: adtsHead })).toBe(true);
    expect(Mp3Driver.supports({ direction: 'demux', head: adtsHead })).toBe(false); // not MP3
    expect(AdtsDriver.supports({ direction: 'demux', head: mp3Head })).toBe(false); // not ADTS
  });
});

describe('probe ADTS — real corpus', () => {
  it('sfx.adts — AAC-LC, 48 kHz mono, ~0.213 s (invariants)', async () => {
    const info = await createMedia().probe(await fixtureSource('sfx.adts'));
    expect(info.container).toBe('adts');
    expect(info.tracks[0]?.codec).toBe('mp4a.40.2');
    expect(info.tracks[0]?.sampleRate).toBe(48000);
    expect(info.tracks[0]?.channels).toBe(1);
    expect(info.durationSec).toBeCloseTo(10240 / 48000, 5);
  });

  it('sfx.adts probe matches its committed golden exactly', async () => {
    expect(await createMedia().probe(await fixtureSource('sfx.adts'))).toEqual(
      await loadGoldenMetadata('sfx.adts'),
    );
  });

  it('parseAdts walks the real frames (10 × 1024 samples)', async () => {
    const info = parseAdts(await loadFixture('sfx.adts'));
    expect(info.frames).toBe(10);
    expect(info.sampleRate).toBe(48000);
    expect(info.channels).toBe(1);
  });

  it('routes by magic alone (no mime hint) without MP3 stealing it', async () => {
    const adts = await createMedia().probe(fromBytes(await loadFixture('sfx.adts')));
    expect(adts.container).toBe('adts');
    const mp3 = await createMedia().probe(fromBytes(await loadFixture('sound_5.mp3')));
    expect(mp3.container).toBe('mp3');
  });

  it('the decode seam is a typed capability gap (AAC decode is codec-layer)', async () => {
    const demuxed = await AdtsDriver.demux(await fixtureSource('sfx.adts'));
    expect(() => demuxed.packets(0)).toThrowError(/AAC decode/);
    await demuxed.close();
  });

  it('createMuxer is a typed not-yet-implemented error', () => {
    expect(() => AdtsDriver.createMuxer()).toThrowError(MediaError);
  });

  it('demuxes a non-seekable stream source (reads the header from the first chunk)', async () => {
    const bytes = await loadFixture('sfx.adts');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxed = await AdtsDriver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('mp4a.40.2');
  });
});

describe('parseAdts — variants + robustness', () => {
  it('parses a crafted stereo / 44.1 kHz stream and counts frames', () => {
    const info = parseAdts(buildAdts({ count: 4, freqIndex: 4, channelConfig: 2 }));
    expect(info.sampleRate).toBe(44100);
    expect(info.channels).toBe(2);
    expect(info.frames).toBe(4);
    expect(info.durationSec).toBeCloseTo((4 * 1024) / 44100, 6);
  });

  it('extrapolates duration when only a head of a larger file is seen', () => {
    const head = buildAdts({ count: 2, payload: 20 }); // 2 frames present...
    const fullSize = head.byteLength * 5; // ...but the file is ~5× longer
    const partial = parseAdts(head);
    const extrapolated = parseAdts(head, fullSize);
    expect(extrapolated.durationSec).toBeGreaterThan(partial.durationSec * 4);
  });

  it('skips an ID3v2 prefix before the first frame', () => {
    expect(parseAdts(buildAdts({ id3: true, freqIndex: 3 })).sampleRate).toBe(48000);
  });

  it('rejects a non-ADTS stream', () => {
    expect(() => parseAdts(new Uint8Array(8))).toThrowError(InputError);
  });

  it('rejects a reserved sampling-frequency index', () => {
    expect(() => parseAdts(buildAdts({ freqIndex: 13 }))).toThrowError(/sampling-frequency/);
  });
});
