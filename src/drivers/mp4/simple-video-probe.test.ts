import { describe, expect, it } from 'vitest';
import {
  readSimpleVideoFaststartProbe,
  readTinyAudioFaststartProbe,
} from './simple-video-probe.ts';

const AVC_DESCRIPTION = new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 0]);
const AAC_ASC = new Uint8Array([0x12, 0x10]);

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function fixed16(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, Math.round(value * 65536));
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 0x100000000));
  view.setUint32(4, value >>> 0);
  return out;
}

function f64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

function box(type: string, ...payload: readonly Uint8Array[]): Uint8Array {
  const body = joinBytes(payload);
  const out = new Uint8Array(8 + body.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  out.set(ascii(type), 4);
  out.set(body, 8);
  return out;
}

function box64(type: string, ...payload: readonly Uint8Array[]): Uint8Array {
  const body = joinBytes(payload);
  const out = new Uint8Array(16 + body.byteLength);
  new DataView(out.buffer).setUint32(0, 1);
  out.set(ascii(type), 4);
  out.set(u64(out.byteLength), 8);
  out.set(body, 16);
  return out;
}

function toEndBox(type: string, ...payload: readonly Uint8Array[]): Uint8Array {
  const body = joinBytes(payload);
  const out = new Uint8Array(8 + body.byteLength);
  new DataView(out.buffer).setUint32(0, 0);
  out.set(ascii(type), 4);
  out.set(body, 8);
  return out;
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payload: readonly Uint8Array[]
): Uint8Array {
  return box(
    type,
    new Uint8Array([version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]),
    ...payload,
  );
}

function ra(bytes: Uint8Array, withSize = true) {
  return {
    ...(withSize ? { size: bytes.byteLength } : {}),
    read: (offset: number, length: number) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

function ftyp(brand = 'isom'): Uint8Array {
  return box('ftyp', ascii(brand), u32(0), ascii('isom'));
}

function mvhdV1(timescale = 1000, duration = 2000): Uint8Array {
  return fullBox('mvhd', 1, 0, zeros(16), u32(timescale), u64(duration));
}

function tkhdV1(id: number, a = 1, b = 0): Uint8Array {
  return fullBox(
    'tkhd',
    1,
    0x000007,
    zeros(16),
    u32(id),
    zeros(4),
    u64(2000),
    zeros(8),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    fixed16(a),
    fixed16(b),
    zeros(28),
  );
}

function tkhdV0(id: number): Uint8Array {
  return fullBox(
    'tkhd',
    0,
    0x000007,
    zeros(8),
    u32(id),
    zeros(4),
    u32(2000),
    zeros(8),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    fixed16(1),
    fixed16(0),
    zeros(28),
  );
}

function mdhdV1(timescale: number, duration: number): Uint8Array {
  return fullBox('mdhd', 1, 0, zeros(16), u32(timescale), u64(duration));
}

function mdhdV0(timescale: number, duration: number): Uint8Array {
  return fullBox('mdhd', 0, 0, zeros(8), u32(timescale), u32(duration));
}

function hdlr(handler: string): Uint8Array {
  return fullBox('hdlr', 0, 0, zeros(4), ascii(handler));
}

function stts(count: number, delta: number): Uint8Array {
  return fullBox('stts', 0, 0, u32(1), u32(count), u32(delta));
}

function stsz(sizes: readonly number[]): Uint8Array {
  return fullBox('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32));
}

function stsd(entry: Uint8Array): Uint8Array {
  return fullBox('stsd', 0, 0, u32(1), entry);
}

function emptyDeclaredStsd(): Uint8Array {
  return fullBox('stsd', 0, 0, u32(1));
}

function avc1Payload(width = 64, height = 36): Uint8Array {
  return joinBytes([
    zeros(6),
    u16(1),
    zeros(16),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    zeros(32),
    u16(0x0018),
    u16(0xffff),
    box('avcC', AVC_DESCRIPTION),
  ]);
}

function esdsBox(asc: Uint8Array): Uint8Array {
  const dsi = joinBytes([new Uint8Array([0x05, asc.byteLength]), asc]);
  const dcdPayload = joinBytes([new Uint8Array([0x40, 0x15, 0, 0, 0]), u32(0), u32(0), dsi]);
  const dcd = joinBytes([new Uint8Array([0x04, dcdPayload.byteLength]), dcdPayload]);
  const esPayload = joinBytes([u16(0), new Uint8Array([0]), dcd]);
  const es = joinBytes([new Uint8Array([0x03, esPayload.byteLength]), esPayload]);
  return fullBox('esds', 0, 0, es);
}

function mp4aV2Payload(channels: number, sampleRate: number): Uint8Array {
  const prefix = joinBytes([
    zeros(6),
    u16(1),
    u16(2),
    u16(0),
    u32(0),
    u16(2),
    u16(16),
    u16(0),
    u16(0),
    u32(sampleRate * 65536),
    zeros(4),
    f64(sampleRate),
    u32(channels),
    zeros(20),
  ]);
  expect(prefix.byteLength).toBe(64);
  return joinBytes([prefix, box('wave', esdsBox(AAC_ASC))]);
}

function videoTrackWithStsd(entry: Uint8Array, tkhd = tkhdV0(1)): Uint8Array {
  return box(
    'trak',
    tkhd,
    box(
      'mdia',
      mdhdV0(600, 1200),
      hdlr('vide'),
      box('minf', box('stbl', stsd(entry), stts(2, 600), stsz([1, 1]))),
    ),
  );
}

function versionOneRotatedVideoMovie(): Uint8Array {
  const skipTrack = box('trak', tkhdV1(9), box('mdia', mdhdV1(1000, 1000), hdlr('meta')));
  const videoTrack = videoTrackWithStsd(box64('avc1', avc1Payload()), tkhdV1(3, 0, 1));
  return joinBytes([ftyp('mp42'), box('moov', mvhdV1(), skipTrack, videoTrack)]);
}

function sizeToEndVideoMovie(): Uint8Array {
  return joinBytes([
    ftyp(),
    box('moov', mvhdV1(), videoTrackWithStsd(toEndBox('avc1', avc1Payload()))),
  ]);
}

function tinyAudioMovieWithV2WaveEsds(): Uint8Array {
  const audioTrack = box(
    'trak',
    tkhdV1(5),
    box('edts', fullBox('elst', 1, 0, u32(1), u64(64), u64(1024), u16(1), u16(0))),
    box(
      'mdia',
      mdhdV1(48000, 4096),
      hdlr('soun'),
      box(
        'minf',
        box('stbl', stsd(box('mp4a', mp4aV2Payload(6, 48000))), stts(2, 2048), stsz([1, 1])),
      ),
    ),
  );
  return joinBytes([ftyp('M4A '), box('moov', mvhdV1(1000, 64), audioTrack)]);
}

describe('simple MP4 faststart probes', () => {
  it('declines sources whose total size is unknown without reading a guessed prefix', async () => {
    const reads: Array<readonly [number, number]> = [];
    const unknown = {
      read: (offset: number, length: number) => {
        reads.push([offset, length]);
        return Promise.resolve(new Uint8Array());
      },
    };

    await expect(readSimpleVideoFaststartProbe(unknown)).resolves.toBeUndefined();
    await expect(readTinyAudioFaststartProbe(unknown)).resolves.toBeUndefined();
    expect(reads).toEqual([[0, 0]]);
  });

  it('parses version-1 video timing, skipped non-media tracks, extended-size entries, and rotation', async () => {
    const probe = await readSimpleVideoFaststartProbe(ra(versionOneRotatedVideoMovie()));

    expect(probe?.brand).toBe('mp42');
    expect(probe?.tracks).toHaveLength(1);
    expect(probe?.tracks[0]).toMatchObject({
      id: 3,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      durationSec: 2,
      fps: 1,
      rotation: 90,
    });
    expect(probe?.tracks[0]?.config).toMatchObject({
      codec: 'avc1.42C01E',
      codedWidth: 64,
      codedHeight: 36,
    });
  });

  it('accepts an internal size-zero sample entry as bounded-to-parent data', async () => {
    const probe = await readSimpleVideoFaststartProbe(ra(sizeToEndVideoMovie()));

    expect(probe?.tracks).toHaveLength(1);
    expect(probe?.tracks[0]?.mediaType).toBe('video');
    expect(probe?.tracks[0]?.codec).toBe('avc1.42C01E');
  });

  it('returns undefined when a faststart moov candidate throws during parsing', async () => {
    const bytes = joinBytes([ftyp(), box('moov', box('mvhd', new Uint8Array([1])))]);

    await expect(readSimpleVideoFaststartProbe(ra(bytes))).resolves.toBeUndefined();
  });

  it('parses tiny audio version-2 geometry, nested wave/esds config, and version-1 edit timing', async () => {
    const tracks = await readTinyAudioFaststartProbe(ra(tinyAudioMovieWithV2WaveEsds()));

    expect(tracks).toHaveLength(1);
    expect(tracks?.[0]).toMatchObject({
      id: 5,
      mediaType: 'audio',
      codec: 'mp4a.40.2',
      durationSec: 4096 / 48000,
      gapless: {
        leadingSamples: 1024,
        trailingSamples: 0,
        totalSamples: 3072,
      },
    });
    expect(tracks?.[0]?.config).toMatchObject({
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 6,
    });
  });

  it.each([
    ['declared-entry-without-header', emptyDeclaredStsd()],
    ['truncated-extended-entry-header', fullBox('stsd', 0, 0, u32(1), u32(1), ascii('avc1'))],
    ['oversized-entry', fullBox('stsd', 0, 0, u32(1), u32(0xffff), ascii('avc1'), avc1Payload())],
    [
      'missing-avc-config',
      fullBox('stsd', 0, 0, u32(1), box('avc1', avc1Payload().subarray(0, 78))),
    ],
  ] as const)('returns undefined for malformed video stsd shape: %s', async (_label, badStsd) => {
    const badTrack = box(
      'trak',
      tkhdV0(1),
      box(
        'mdia',
        mdhdV0(600, 1200),
        hdlr('vide'),
        box('minf', box('stbl', badStsd, stts(2, 600), stsz([1, 1]))),
      ),
    );
    const probe = await readSimpleVideoFaststartProbe(
      ra(joinBytes([ftyp(), box('moov', mvhdV1(), badTrack)])),
    );

    expect(probe).toBeUndefined();
  });
});
