import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, InputError } from '../../contracts/errors.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { FlacDriver } from '../flac/flac-driver.ts';
import { demuxWebm, webmPacketPayloadInfoFromBytes } from '../webm/webm-driver.ts';
import {
  OggDriver,
  OggModule,
  oggAudioPackets,
  oggPacketBytes,
  oggPacketInfoFromBytes,
  parseOgg,
} from './ogg-driver.ts';
import { OggMuxer } from './ogg-write.ts';

function installThrowingAudioChunkConstructor(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EncodedAudioChunk');
  class ThrowingAudioChunk {
    constructor() {
      throw new Error('aborted Ogg packet stream must not construct a chunk');
    }
  }
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: ThrowingAudioChunk as unknown as typeof EncodedAudioChunk,
  });
  return (): void => {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else Object.defineProperty(globalThis, 'EncodedAudioChunk', descriptor);
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function byteSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    range: (start, end) => Promise.resolve(bytes.slice(start, end)),
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes.slice());
          controller.close();
        },
      }),
  };
}

const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const MICROS_PER_SECOND = 1_000_000;
const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const u64 = (n: number): number[] => [...u32(n >>> 0), ...u32(Math.floor(n / 2 ** 32))];

function page(opts: {
  bos?: boolean;
  granule?: number;
  serial?: number;
  version?: number;
  data: number[];
}): number[] {
  const data = opts.data;
  const segs: number[] = [];
  let rem = data.length;
  while (rem >= 255) {
    segs.push(255);
    rem -= 255;
  }
  segs.push(rem);
  const granule =
    opts.granule === -1 ? [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : u64(opts.granule ?? 0);
  return [
    ...str('OggS'),
    opts.version ?? 0,
    opts.bos ? 0x02 : 0x00,
    ...granule,
    ...u32(opts.serial ?? 1),
    ...u32(0),
    0,
    0,
    0,
    0, // serial + seq + crc
    segs.length,
    ...segs,
    ...data,
  ];
}
const vorbisId = (ch: number, sr: number): number[] => [
  0x01,
  ...str('vorbis'),
  ...u32(0),
  ch,
  ...u32(sr),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  0xb8,
  0x01,
];
const opusId = (ch: number): number[] => [
  ...str('OpusHead'),
  1,
  ch,
  ...u16(312),
  ...u32(48000),
  ...u16(0),
  0,
];

describe('OggDriver.supports', () => {
  it('recognizes OggS magic, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('sound_5.oga')).subarray(0, 16);
    expect(OggDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(OggDriver.supports({ direction: 'demux', mime: 'audio/ogg' })).toBe(true);
    expect(OggDriver.supports({ direction: 'demux', extension: 'oga' })).toBe(true);
    expect(OggDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(OggDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe Ogg on the real corpus (Vorbis)', () => {
  it('sound_5.oga — vorbis audio with sane params (invariants)', async () => {
    const info = await createMedia()
      .use(OggModule)
      .probe(await fixtureSource('sound_5.oga'));
    expect(info.container).toBe('ogg');
    expect(info.tracks[0]?.codec).toBe('vorbis');
    expect([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000]).toContain(
      info.tracks[0]?.sampleRate,
    );
    expect(info.durationSec).toBeGreaterThan(0);
  });

  it('sound_5.oga probe matches its committed golden exactly', async () => {
    const info = await createMedia()
      .use(OggModule)
      .probe(await fixtureSource('sound_5.oga'));
    expect(info).toEqual(await loadGoldenMetadata('sound_5.oga'));
  });
});

describe('parseOgg — page + codec parsing', () => {
  it('parses a Vorbis stream and derives duration from the granule', () => {
    const bytes = new Uint8Array([
      ...page({ bos: true, data: vorbisId(2, 44100) }),
      ...page({ granule: 88200, data: [0, 0] }),
    ]);
    const info = parseOgg(bytes);
    expect(info.codec).toBe('vorbis');
    expect(info.channels).toBe(2);
    expect(info.sampleRate).toBe(44100);
    expect(info.durationSec).toBeCloseTo(2, 5); // 88200 / 44100
  });

  it('parses an Opus stream (granule clock is 48 kHz)', () => {
    const bytes = new Uint8Array([
      ...page({ bos: true, data: opusId(2) }),
      ...page({ granule: 96000, data: [0] }),
    ]);
    const info = parseOgg(bytes);
    expect(info.codec).toBe('opus');
    expect(info.channels).toBe(2);
    expect(info.sampleRate).toBe(48000);
    expect(info.durationSec).toBeCloseTo(2, 5); // 96000 / 48000
  });

  it('ignores "no granule" (-1) pages and a wrong-serial page; takes the max valid granule', () => {
    const bytes = new Uint8Array([
      ...page({ bos: true, data: vorbisId(1, 48000) }),
      ...page({ granule: -1, data: [0] }),
      ...page({ granule: 99999, serial: 7, data: [0] }), // different stream → ignored
      ...page({ granule: 48000, data: [0] }),
    ]);
    expect(parseOgg(bytes).durationSec).toBeCloseTo(1, 5); // 48000 / 48000, not 99999
  });

  it('reads the last granule from the tail buffer (head+tail probe)', () => {
    const head = new Uint8Array(page({ bos: true, data: vorbisId(1, 44100) }));
    const tail = new Uint8Array(page({ granule: 44100, data: [0] }));
    expect(parseOgg(head, tail).durationSec).toBeCloseTo(1, 5);
  });

  it('skips junk bytes before the first page (scan resync)', () => {
    const bytes = new Uint8Array([
      0x00,
      0x01,
      0x02,
      ...page({ bos: true, data: vorbisId(1, 44100) }),
      ...page({ granule: 44100, data: [0] }),
    ]);
    expect(parseOgg(bytes).durationSec).toBeCloseTo(1, 5);
  });

  it('skips invalid pages (bad version) and rejects an unrecognized codec', () => {
    expect(() =>
      parseOgg(new Uint8Array(page({ bos: true, version: 1, data: vorbisId(1, 44100) }))),
    ).toThrowError(InputError);
    expect(() =>
      parseOgg(new Uint8Array(page({ bos: true, data: str('unknown!!') }))),
    ).toThrowError(InputError);
  });
});

describe('OggDriver — demux seam + muxer', () => {
  it('demuxes a stream source; the packet seam is a typed gap in node', async () => {
    const bytes = await loadFixture('sound_5.oga');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxed = await OggDriver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('vorbis');
    const description = demuxed.tracks[0]?.config?.description;
    expect(description).toBeInstanceOf(Uint8Array);
    expect((description as Uint8Array)[0]).toBe(2); // Xiph-laced Vorbis id/comment/setup headers
    expect(() => demuxed.packets(0)).toThrowError(/browser codec layer/);
    await demuxed.close();
  });

  it('aborts before assembling or constructing the next packet', async () => {
    const controller = new AbortController();
    const demuxed = await OggDriver.demux(await fixtureSource('sfx-opus.ogg'), {
      signal: controller.signal,
    });
    const restore = installThrowingAudioChunkConstructor();
    try {
      const reader = demuxed.packets(0).getReader();
      controller.abort();
      await expect(reader.read()).rejects.toMatchObject({ code: 'aborted' });
      reader.releaseLock();
    } finally {
      restore();
      await demuxed.close();
    }
  });

  it('carries the source OpusHead through the demux TrackInfo description', async () => {
    const bytes = await loadFixture('sfx-opus.ogg');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxed = await OggDriver.demux(streamSource);
    const description = demuxed.tracks[0]?.config?.description;
    expect(description).toBeInstanceOf(Uint8Array);
    const opusHead = description as Uint8Array;
    expect(String.fromCharCode(...opusHead.subarray(0, 8))).toBe('OpusHead');
    expect(
      new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength).getUint16(10, true),
    ).toBe(312);
    await demuxed.close();
  });

  it('exposes Opus packet-info offsets without constructing WebCodecs chunks', async () => {
    const bytes = await loadFixture('sfx-opus.ogg');
    const table = oggPacketInfoFromBytes(bytes);
    const packets = oggAudioPackets(bytes);
    expect(table.tracks[0]?.codec).toBe('opus');
    expect(table.tracks[0]?.config?.description).toBeInstanceOf(Uint8Array);
    expect(table.packets.length).toBe(packets.length);
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      const row = table.packets[i];
      if (packet === undefined || row === undefined)
        throw new Error('packet table length mismatch');
      expect(row.trackIndex).toBe(0);
      expect(row.offset).toBe(packet.offset);
      expect(row.size).toBe(packet.size);
      expect(row.ptsUs).toBe(packet.ptsUs);
      expect(row.dtsUs).toBe(packet.ptsUs);
      expect(row.durationUs).toBe(packet.durationUs);
      expect(row.keyframe).toBe(true);
    }
  });

  it('streamCopy authors exact Opus pre-skip/end-granule trims while preserving coded packets', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    expect(OggDriver.validatesStreamCopyTrim).toBe(true);

    const seed = await loadFixture('sfx-opus.ogg');
    const seedTable = oggPacketInfoFromBytes(seed);
    const seedTrack = seedTable.tracks[0];
    if (seedTrack === undefined || seedTable.packets.length === 0) {
      throw new Error('Opus seed fixture is missing track or packet facts');
    }
    const packetCount = 180;
    const sourceMuxer = new OggMuxer();
    const sourceTrackId = sourceMuxer.addTrack({
      ...seedTrack,
      durationSec: packetCount * 0.02,
    });
    for (let index = 0; index < packetCount; index++) {
      const packet = seedTable.packets[index % seedTable.packets.length];
      if (packet === undefined) throw new Error(`missing Opus seed packet ${index}`);
      sourceMuxer.addChunkStruct(sourceTrackId, {
        timestampUs: index * 20_000,
        durationUs: 20_000,
        key: true,
        data: oggPacketBytes(seed, packet),
      });
    }
    await sourceMuxer.finalize();
    const source = await collect(sourceMuxer.output);
    const sourceTable = oggPacketInfoFromBytes(source);
    const sourceDescription = sourceTable.tracks[0]?.config?.description;
    if (!(sourceDescription instanceof Uint8Array)) {
      throw new Error('authored Opus source is missing OpusHead');
    }
    const sourcePreSkip = new DataView(
      sourceDescription.buffer,
      sourceDescription.byteOffset,
      sourceDescription.byteLength,
    ).getUint16(10, true);
    const sampleRate = 48_000;
    const trim = { startSec: 2, endSec: 3 } as const;
    const startFrame = trim.startSec * sampleRate;
    const endFrame = trim.endSec * sampleRate;
    const packetFrames = sourceTable.packets.map((packet) => {
      if (packet.durationUs === undefined) throw new Error('Opus packet duration missing');
      return Math.round((packet.durationUs * sampleRate) / MICROS_PER_SECOND);
    });
    const codedStarts: number[] = [];
    let codedFrames = 0;
    for (const frames of packetFrames) {
      codedStarts.push(codedFrames);
      codedFrames += frames;
    }
    const firstIndex = codedStarts.findIndex((codedStart) => {
      const preSkip = startFrame - (codedStart - sourcePreSkip);
      return preSkip >= 0 && preSkip <= 0xffff;
    });
    let lastIndex = -1;
    for (let index = firstIndex; index < codedStarts.length; index++) {
      const codedStart = codedStarts[index];
      if (codedStart === undefined || codedStart - sourcePreSkip >= endFrame) break;
      lastIndex = index;
    }
    if (firstIndex <= 0 || lastIndex < firstIndex) {
      throw new Error('long Opus source did not produce a bounded pre-roll selection');
    }
    const selectedCodedStart = codedStarts[firstIndex];
    const priorCodedStart = codedStarts[firstIndex - 1];
    const finalPacketFrames = packetFrames[lastIndex];
    if (
      selectedCodedStart === undefined ||
      priorCodedStart === undefined ||
      finalPacketFrames === undefined
    ) {
      throw new Error('long Opus source selection indexes are out of bounds');
    }
    const expectedPreSkip = startFrame - (selectedCodedStart - sourcePreSkip);
    const priorPreSkip = startFrame - (priorCodedStart - sourcePreSkip);
    expect(expectedPreSkip).toBeLessThanOrEqual(0xffff);
    expect(priorPreSkip).toBeGreaterThan(0xffff);

    const out = await collect(
      await streamCopy(byteSource(source), {
        container: 'ogg',
        trim,
      }),
    );

    const outputTable = oggPacketInfoFromBytes(out);
    const outputTrack = outputTable.tracks[0];
    const outputDescription = outputTrack?.config?.description;
    if (outputTrack === undefined || !(outputDescription instanceof Uint8Array)) {
      throw new Error('trimmed Opus output is missing track or OpusHead facts');
    }
    const outputPreSkip = new DataView(
      outputDescription.buffer,
      outputDescription.byteOffset,
      outputDescription.byteLength,
    ).getUint16(10, true);
    const finalGranule = Math.round((outputTrack.durationSec ?? 0) * sampleRate);
    const expectedFinalGranule = expectedPreSkip + endFrame - startFrame;
    const expectedPackets = sourceTable.packets.slice(firstIndex, lastIndex + 1);
    const selectedCodedFrames = packetFrames
      .slice(firstIndex, lastIndex + 1)
      .reduce((sum, frames) => sum + frames, 0);

    expect(outputPreSkip).toBe(expectedPreSkip);
    expect(finalGranule).toBe(expectedFinalGranule);
    expect(finalGranule - outputPreSkip).toBe(endFrame - startFrame);
    expect(selectedCodedFrames - finalGranule).toBeGreaterThanOrEqual(0);
    expect(selectedCodedFrames - finalGranule).toBeLessThan(finalPacketFrames);
    expect(outputTable.packets.map((packet) => oggPacketBytes(out, packet))).toEqual(
      expectedPackets.map((packet) => oggPacketBytes(source, packet)),
    );
  });

  it('streamCopy rejects invalid and unrepresentable exact Opus trim ranges with typed errors', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    const source = await loadFixture('sfx-opus.ogg');
    const durationSec = oggPacketInfoFromBytes(source).tracks[0]?.durationSec;
    if (durationSec === undefined) throw new Error('Opus fixture is missing duration');

    const invalidRanges = [
      {
        trim: { startSec: Number.NaN, endSec: 0.1 },
        message: 'bad trim',
      },
      {
        trim: { startSec: -0.01, endSec: 0.1 },
        message: 'trim start < 0',
      },
      {
        trim: { startSec: 0.05, endSec: 0.05 },
        message: 'empty trim range',
      },
      {
        trim: { startSec: 0.1, endSec: 0.05 },
        message: 'bad trim range',
      },
      {
        trim: { startSec: durationSec, endSec: durationSec + 0.0005 },
        message: 'trim start >= duration',
      },
      {
        trim: { startSec: 0, endSec: durationSec + 0.01 },
        message: 'trim end > duration',
      },
    ] as const;
    for (const { trim, message } of invalidRanges) {
      await expect(
        streamCopy(byteSource(source), { container: 'ogg', trim }),
      ).rejects.toMatchObject({
        code: 'unsupported-input',
        message,
      });
    }

    const zeroDurationSource = new Uint8Array([
      ...page({ bos: true, data: opusId(2) }),
      ...page({ data: str('OpusTags') }),
      ...page({ granule: 0, data: [0] }),
    ]);
    await expect(
      streamCopy(byteSource(zeroDurationSource), {
        container: 'ogg',
        trim: { startSec: 0, endSec: Number.EPSILON },
      }),
    ).rejects.toMatchObject({
      code: 'demux-error',
      message: 'Ogg trim needs a finite source duration',
    });

    await expect(
      streamCopy(byteSource(source), {
        container: 'ogg',
        trim: { startSec: 0, endSec: Number.EPSILON },
      }),
    ).rejects.toMatchObject({
      code: 'capability-miss',
      message: 'Ogg Opus cannot represent the requested trim as a positive 48 kHz sample interval',
    });
  });

  it('streamCopy rejects an Opus packet whose code-3 TOC declares zero frames', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    const source = new Uint8Array([
      ...page({ bos: true, data: opusId(2) }),
      ...page({ data: str('OpusTags') }),
      ...page({ granule: 312, data: [3, 0] }),
    ]);

    await expect(
      streamCopy(byteSource(source), {
        container: 'ogg',
        trim: { startSec: 0, endSec: 0.001 },
      }),
    ).rejects.toMatchObject({
      code: 'demux-error',
      message: 'Ogg Opus trim encountered a packet with an invalid coded duration',
    });
  });

  it('streamCopy rejects an unsupported target before acquiring source bytes', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    let reads = 0;
    const source: ByteSource = {
      size: 1,
      range(): Promise<Uint8Array> {
        reads++;
        return Promise.resolve(Uint8Array.of(0));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('unsupported target must not acquire the Ogg stream');
      },
    };

    await expect(streamCopy(source, { container: 'mp4' })).rejects.toBeInstanceOf(CapabilityError);
    expect(reads).toBe(0);
  });

  it('streamCopy re-authors real Opus and Vorbis packets directly as WebM and Matroska', async () => {
    expect(OggDriver.streamCopyTargets).toEqual(['webm', 'mkv']);
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');

    for (const container of ['webm', 'mkv'] as const) {
      for (const fixture of ['sfx-opus.ogg', 'sound_5.oga'] as const) {
        const source = await loadFixture(fixture);
        const sourceTable = oggPacketInfoFromBytes(source);
        const output = await collect(await streamCopy(await fixtureSource(fixture), { container }));
        expect(output).not.toEqual(source);
        const reparsed = demuxWebm(output);
        expect(reparsed.info.container).toBe(container);
        expect(reparsed.info.tracks[0]?.codec).toBe(sourceTable.tracks[0]?.codec);
        const description = sourceTable.tracks[0]?.config?.description;
        const codecDelayUs =
          sourceTable.tracks[0]?.codec === 'opus' &&
          description instanceof Uint8Array &&
          description.byteLength >= 12
            ? Math.round(
                (new DataView(
                  description.buffer,
                  description.byteOffset,
                  description.byteLength,
                ).getUint16(10, true) /
                  48_000) *
                  MICROS_PER_SECOND,
              )
            : 0;
        const outputFrames = reparsed.framesByIndex[0] ?? [];
        expect(outputFrames).toHaveLength(sourceTable.packets.length);
        for (let index = 0; index < sourceTable.packets.length; index++) {
          const sourcePacket = sourceTable.packets[index];
          const outputFrame = outputFrames[index];
          if (sourcePacket === undefined || outputFrame === undefined) {
            throw new Error(`${fixture}: missing packet ${index}`);
          }
          expect(outputFrame.data).toEqual(
            sourcePacket.spans.length === 1 && sourcePacket.offset !== undefined
              ? source.subarray(sourcePacket.offset, sourcePacket.offset + sourcePacket.size)
              : new Uint8Array(
                  sourcePacket.spans.flatMap((span) =>
                    Array.from(source.subarray(span.offset, span.offset + span.size)),
                  ),
                ),
          );
          expect(
            Math.abs(outputFrame.timestampUs - (sourcePacket.ptsUs - codecDelayUs)),
          ).toBeLessThanOrEqual(1_000);
        }
      }
    }
  });

  it('cross-container Ogg trim copies exactly the overlapping packets and rebases their timing', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    const source = await loadFixture('sound_5.oga');
    const table = oggPacketInfoFromBytes(source);
    const trim = { startSec: 0.2, endSec: 0.6 } as const;
    const startUs = trim.startSec * MICROS_PER_SECOND;
    const endUs = trim.endSec * MICROS_PER_SECOND;
    const expected = table.packets.filter((packet) => {
      const durationUs = packet.durationUs;
      if (durationUs === undefined) throw new Error('Ogg packet duration missing');
      return packet.ptsUs + durationUs > startUs && packet.ptsUs < endUs;
    });
    const firstPtsUs = expected[0]?.ptsUs;
    if (firstPtsUs === undefined)
      throw new Error('trim must retain at least one real Vorbis packet');

    const output = await collect(
      await streamCopy(await fixtureSource('sound_5.oga'), { container: 'mkv', trim }),
    );
    const reparsed = demuxWebm(output);
    const frames = reparsed.framesByIndex[0] ?? [];
    expect(frames).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index++) {
      const packet = expected[index];
      const frame = frames[index];
      if (packet === undefined || frame === undefined) throw new Error(`missing packet ${index}`);
      expect(frame.data).toEqual(oggPacketBytes(source, packet));
      expect(Math.abs(frame.timestampUs - (packet.ptsUs - firstPtsUs))).toBeLessThanOrEqual(1_000);
    }
    const selectedEndUs = Math.max(
      ...expected.map((packet) => packet.ptsUs + (packet.durationUs ?? 0)),
    );
    expect(reparsed.info.durationSec).toBeCloseTo(
      (selectedEndUs - firstPtsUs) / MICROS_PER_SECOND,
      6,
    );
  });

  it('cross-container Opus trim resets pre-skip after the original leading packet', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    const source = await loadFixture('sfx-opus.ogg');
    const sourceTable = oggPacketInfoFromBytes(source);
    const trim = { startSec: 0.04, endSec: 0.14 } as const;
    const expected = sourceTable.packets.filter((packet) => {
      const durationUs = packet.durationUs;
      if (durationUs === undefined) throw new Error('Opus packet duration missing');
      return (
        packet.ptsUs + durationUs > trim.startSec * MICROS_PER_SECOND &&
        packet.ptsUs < trim.endSec * MICROS_PER_SECOND
      );
    });
    const expectedFirst = expected[0];
    if (expectedFirst === undefined) throw new Error('Opus trim selected no packets');
    expect(sourceTable.packets.indexOf(expectedFirst)).toBeGreaterThan(0);
    const output = await collect(
      await streamCopy(await fixtureSource('sfx-opus.ogg'), { container: 'mkv', trim }),
    );
    const outputTable = webmPacketPayloadInfoFromBytes(output);
    const outputTrack = outputTable.tracks[0];
    const firstPtsUs = expected[0]?.ptsUs;
    const last = expected.at(-1);
    if (outputTrack === undefined || firstPtsUs === undefined || last?.durationUs === undefined) {
      throw new Error('trimmed Opus output is missing track or packet facts');
    }
    const description = outputTrack.config?.description;
    expect(description).toBeInstanceOf(Uint8Array);
    const opusHead = description as Uint8Array;
    expect(
      new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength).getUint16(10, true),
    ).toBe(0);
    expect(outputTrack.codecDelayNs).toBeUndefined();
    expect(outputTrack.gapless).toBeUndefined();
    expect(outputTrack.durationSec).toBeCloseTo(
      (last.ptsUs + last.durationUs - firstPtsUs) / MICROS_PER_SECOND,
      6,
    );
    expect(outputTable.packets.map((packet) => packet.data)).toEqual(
      expected.map((packet) => oggPacketBytes(source, packet)),
    );
  });

  it('cross-container Opus trim retains original pre-skip when it keeps the leading packet', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    const source = await loadFixture('sfx-opus.ogg');
    const sourceTable = oggPacketInfoFromBytes(source);
    const output = await collect(
      await streamCopy(await fixtureSource('sfx-opus.ogg'), {
        container: 'mkv',
        trim: { startSec: 0, endSec: 0.04 },
      }),
    );
    const outputTable = webmPacketPayloadInfoFromBytes(output);
    const outputTrack = outputTable.tracks[0];
    const first = sourceTable.packets[0];
    if (outputTrack === undefined || first === undefined) {
      throw new Error('leading Opus trim is missing track truth');
    }
    expect(outputTrack.codecDelayNs).toBe(6_500_000);
    expect(outputTrack.gapless?.leadingSamples).toBe(312);
    expect(outputTrack.gapless?.trailingSamples).toBeUndefined();
    expect(outputTable.packets[0]?.data).toEqual(oggPacketBytes(source, first));
  });

  it('cross-target Ogg-FLAC writes Matroska and declines WebM with a typed capability miss', async () => {
    const flacStreamCopy = FlacDriver.streamCopy;
    const oggStreamCopy = OggDriver.streamCopy;
    if (flacStreamCopy === undefined || oggStreamCopy === undefined) {
      throw new Error('FLAC/Ogg stream-copy must be implemented');
    }
    const oggFlac = await collect(
      await flacStreamCopy(await fixtureSource('flac-verbatim.flac'), { container: 'ogg' }),
    );
    const sourceTable = oggPacketInfoFromBytes(oggFlac);
    expect(sourceTable.tracks[0]?.codec).toBe('flac');

    await expect(
      oggStreamCopy(
        {
          size: oggFlac.byteLength,
          range: () => Promise.resolve(oggFlac),
          stream: () => {
            throw new Error('seekable Ogg-FLAC should use its range source');
          },
        },
        { container: 'webm' },
      ),
    ).rejects.toMatchObject({ code: 'capability-miss' });

    const mkv = await collect(
      await oggStreamCopy(
        {
          size: oggFlac.byteLength,
          range: () => Promise.resolve(oggFlac),
          stream: () => {
            throw new Error('seekable Ogg-FLAC should use its range source');
          },
        },
        { container: 'mkv' },
      ),
    );
    const outputTable = webmPacketPayloadInfoFromBytes(mkv);
    expect(outputTable.tracks[0]?.codec).toBe('flac');
    expect(outputTable.tracks[0]?.config).toEqual(sourceTable.tracks[0]?.config);
    expect(outputTable.packets.map((packet) => packet.data)).toEqual(
      sourceTable.packets.map((packet) => oggPacketBytes(oggFlac, packet)),
    );
  });

  it('cross-container Ogg packet copy aborts before reading or emitting output', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    const source: ByteSource = {
      size: 1,
      range(): Promise<Uint8Array> {
        reads++;
        return Promise.resolve(new Uint8Array([0]));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('aborted Ogg stream-copy must not open a stream');
      },
    };
    await expect(
      streamCopy(source, { container: 'mkv', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(reads).toBe(0);
  });

  it('cross-container Ogg packet copy observes abort during packet authoring', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    const controller = new AbortController();
    let abortChecks = 0;
    const signal = new Proxy(controller.signal, {
      get(target, property): unknown {
        if (property === 'aborted') {
          abortChecks++;
          if (abortChecks === 7) controller.abort();
        }
        return Reflect.get(target, property, target);
      },
    });

    await expect(
      streamCopy(await fixtureSource('sound_5.oga'), { container: 'mkv', signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(abortChecks).toBe(7);
  });

  it('cross-container Ogg packet copy cancels and unlocks a one-shot source on mid-read abort', async () => {
    const streamCopy = OggDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('OggDriver.streamCopy must be implemented');
    const bytes = await loadFixture('sound_5.oga');
    const controller = new AbortController();
    let pulls = 0;
    let cancelReason: unknown;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(streamController): void {
          pulls++;
          if (pulls === 1) {
            streamController.enqueue(bytes.subarray(0, 4_096));
            controller.abort();
            return;
          }
          streamController.enqueue(bytes.subarray(4_096));
          streamController.close();
        },
        cancel(reason): void {
          cancelReason = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const source: ByteSource = {
      stream: () => stream,
    };

    await expect(
      streamCopy(source, { container: 'mkv', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(pulls).toBe(1);
    expect(cancelReason).toMatchObject({ code: 'aborted' });
    expect(stream.locked).toBe(false);
  });

  it('demux exposes packet tables from one full-source read', async () => {
    const bytes = await loadFixture('sfx-opus.ogg');
    const expected = oggPacketInfoFromBytes(bytes);
    const reads: Array<readonly [number, number]> = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('seekable Ogg demux should use one full range read');
      },
    };

    const demuxed = await OggDriver.demux(source);
    const packetInfoRows = (
      demuxed as typeof demuxed & { packetInfoTable?: () => typeof expected.packets }
    ).packetInfoTable?.();
    const packetRows = demuxed.packetTable?.();

    expect(reads).toEqual([[0, bytes.byteLength]]);
    expect(demuxed.tracks).toEqual(expected.tracks);
    expect(packetInfoRows).toEqual(expected.packets);
    expect(packetRows).toEqual(
      expected.packets.map((packet) => ({
        trackId: 0,
        sizeBytes: packet.size,
        ptsUs: packet.ptsUs,
        dtsUs: packet.dtsUs,
        durationUs: packet.durationUs,
        keyframe: packet.keyframe,
      })),
    );
    await demuxed.close();
  });

  it('createMuxer returns a working OggMuxer (round-trip validated in ogg-write.test.ts)', () => {
    expect(OggDriver.createMuxer()).toBeInstanceOf(OggMuxer);
  });

  it('probe reads head + tail via range for a large (>64 kB) source', async () => {
    const headPage = new Uint8Array(page({ bos: true, data: vorbisId(1, 44100) }));
    const tailPage = new Uint8Array(page({ granule: 44100, data: [0] }));
    const sourceSize = 300000;
    const ranges: Array<readonly [number, number]> = [];
    const fake: ByteSource = {
      size: sourceSize,
      stream: () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      range(start, end): Promise<Uint8Array> {
        ranges.push([start, end]);
        return Promise.resolve(start === 0 ? headPage : tailPage);
      },
    };
    const tracks = await OggDriver.probe?.(fake);
    expect(tracks?.[0]?.durationSec).toBeCloseTo(1, 5);
    expect(ranges).toEqual([
      [0, 65536],
      [sourceSize - 65536, sourceSize],
    ]);
  });

  it('reads an unknown-size stream to EOS before reporting its terminal granule duration', async () => {
    const head = new Uint8Array(page({ bos: true, data: opusId(2) }));
    const tail = new Uint8Array(page({ granule: 480_312, data: [0] }));
    const source: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(head);
            controller.enqueue(tail);
            controller.close();
          },
        }),
    };
    const tracks = await OggDriver.probe?.(source);
    expect(tracks?.[0]?.durationSec).toBeCloseTo(10.0065, 6);
  });

  it('probes a small known-size source with one bounded range read', async () => {
    const headPage = new Uint8Array(page({ bos: true, data: opusId(2) }));
    const tailPage = new Uint8Array(page({ granule: 48000, data: [0] }));
    const bytes = new Uint8Array(70000);
    bytes.set(headPage, 0);
    bytes.set(tailPage, bytes.byteLength - tailPage.byteLength);
    const ranges: Array<{ start: number; end: number }> = [];
    const fake: ByteSource = {
      size: bytes.byteLength,
      stream: () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      range: (start, end) => {
        ranges.push({ start, end });
        return Promise.resolve(bytes.subarray(start, end));
      },
    };
    const tracks = await OggDriver.probe?.(fake);
    expect(tracks?.[0]?.codec).toBe('opus');
    expect(tracks?.[0]?.durationSec).toBeCloseTo(1, 5);
    expect(ranges).toEqual([{ start: 0, end: bytes.byteLength }]);
  });
});

/**
 * STRICT can-fail oracle for the pure {@link oggAudioPackets} de-lacer/framer, cross-checked against
 * ffprobe (the independent oracle). The expected constants were recorded ONCE with:
 *
 *   ffprobe -v error -show_packets -select_streams a:0 -of csv=p=0 \
 *     -show_entries packet=pts_time,size,pos fixtures/media/<file>
 *
 * and BAKED below (tests never shell out at run time). ffprobe's `size` is the de-laced **packet payload**
 * (the unit our enumeration reports). The test fails on any mis-framing: a wrong segment-table walk shifts
 * byte sizes, a wrong header-skip shifts the packet count, a wrong granule/TOC shifts PTS.
 *
 * - **Opus** is sample-exact (TOC-decoded): every (count, size, PTS µs within ±1) is asserted.
 * - **Vorbis** per-packet PTS is an *even-split* approximation (documented in oggAudioPackets), so we
 *   assert count + sizes exactly and only the **sum of durations ≈ true duration**, not per-packet PTS.
 */
describe('oggAudioPackets — pure de-lacing + framing vs ffprobe', () => {
  // ffprobe a:0 packets for sfx-opus.ogg — pts (48 kHz samples), pts_time (s), size (payload bytes):
  //   -312/-0.006500/450, 648/0.013500/268, 1608/0.033500/285, 2568/0.053500/296, 3528/0.073500/287,
  //   4488/0.093500/308, 5448/0.113500/289, 6408/0.133500/286, 7368/0.153500/296, 8328/0.173500/294
  const OPUS_EXPECTED: ReadonlyArray<{ ptsUs: number; size: number }> = [
    { ptsUs: -6500, size: 450 },
    { ptsUs: 13500, size: 268 },
    { ptsUs: 33500, size: 285 },
    { ptsUs: 53500, size: 296 },
    { ptsUs: 73500, size: 287 },
    { ptsUs: 93500, size: 308 },
    { ptsUs: 113500, size: 289 },
    { ptsUs: 133500, size: 286 },
    { ptsUs: 153500, size: 296 },
    { ptsUs: 173500, size: 294 },
  ];

  it('sfx-opus.ogg — exact count, sizes, and per-packet PTS (TOC-decoded)', async () => {
    const pkts = oggAudioPackets(await loadFixture('sfx-opus.ogg'));
    expect(pkts.length).toBe(OPUS_EXPECTED.length); // 10 audio packets; OpusHead/OpusTags skipped
    for (let i = 0; i < OPUS_EXPECTED.length; i++) {
      const exp = OPUS_EXPECTED[i];
      const got = pkts[i];
      if (exp === undefined || got === undefined) throw new Error('length mismatch');
      expect(got.size).toBe(exp.size); // de-laced payload bytes must match ffprobe exactly
      expect(Math.abs(got.ptsUs - exp.ptsUs)).toBeLessThanOrEqual(1); // PTS µs within rounding
    }
    // Every Opus frame here is 20 ms (960 @ 48 kHz); sum of durations == 10 × 20 ms = 200 ms = duration.
    const totalUs = pkts.reduce((s, p) => s + p.durationUs, 0);
    expect(totalUs).toBe(200_000);
  });

  // ffprobe a:0 audio packets for sound_5.oga (pts_time, payload size), its spurious Metadata-Update
  // duplicate of the first line dropped:
  //   0.000000/98, 0.011610/65, 0.023220/94, 0.034830/98, 0.046440/66, 0.063855/64, 0.087075/61, 0.110295/55
  //
  // CONTAINER vs DECODER accounting (the documented, *correct* offset): a demuxer must emit EVERY coded
  // audio packet, including Vorbis's first one — which by spec produces no PCM output (it only primes the
  // IMDCT overlap; output begins with the *second* packet). ffprobe lists DECODER-output packets, so it
  // omits that priming packet. Hence our container-true list == [primingPacket, ...ffprobeList]:
  //   our packets[0]  = the 100-byte priming packet (ffprobe drops it)
  //   our packets[1:] = ffprobe's list exactly (sizes 98, 65, 94, …)
  // This is why our COUNT is ffprobe's + 1 and our packets[1].size == ffprobe's first size (98).
  const VORBIS_AFTER_PRIMING_SIZES: readonly number[] = [98, 65, 94, 98, 66, 64, 61, 55];
  const VORBIS_PRIMING_SIZE = 100; // packets[0]: the no-output priming packet (container-real)
  const VORBIS_PACKET_COUNT = 231; // 234 total packets − 3 Vorbis header packets (id/comment/setup)
  const VORBIS_DURATION_SEC = 5.000227; // ffprobe stream duration (22050 Hz)

  it('sound_5.oga — exact count + sizes; per-packet PTS is an even-split approximation', async () => {
    const pkts = oggAudioPackets(await loadFixture('sound_5.oga'));
    expect(pkts.length).toBe(VORBIS_PACKET_COUNT); // 3 Vorbis header packets skipped, priming kept
    expect(pkts[0]?.size).toBe(VORBIS_PRIMING_SIZE); // container-real priming packet (ffprobe omits)
    for (let i = 0; i < VORBIS_AFTER_PRIMING_SIZES.length; i++) {
      // packets[1:] must reproduce ffprobe's de-laced payload sizes byte-exactly.
      expect(pkts[i + 1]?.size).toBe(VORBIS_AFTER_PRIMING_SIZES[i]);
    }
    expect(pkts[0]?.ptsUs).toBe(0); // first coded packet starts at the stream origin
    // Sum of (approximate) durations equals the true total to ±2 ms (the granule/rate end, not per-packet).
    const totalSec = pkts.reduce((s, p) => s + p.durationUs, 0) / 1_000_000;
    expect(totalSec).toBeCloseTo(VORBIS_DURATION_SEC, 2);
    // Monotonic, non-decreasing PTS (a sane decode timeline even under the approximation).
    for (let i = 1; i < pkts.length; i++) {
      expect(pkts[i]?.ptsUs ?? 0).toBeGreaterThanOrEqual(pkts[i - 1]?.ptsUs ?? 0);
    }
  });

  it('excludes the codec setup/header packets from the audio stream (both fixtures)', async () => {
    // The first emitted Opus packet (450 B) is real audio, never the 19-B OpusHead or the OpusTags page.
    const opus = oggAudioPackets(await loadFixture('sfx-opus.ogg'));
    expect(opus[0]?.size).toBe(450);
    // The first emitted Vorbis packet (100 B priming packet) is audio, never the id (30 B) / comment /
    // setup headers — those three header packets are skipped; audio (incl. the priming packet) is kept.
    const vorbis = oggAudioPackets(await loadFixture('sound_5.oga'));
    expect(vorbis[0]?.size).toBe(100);
  });

  it('rejects truncated / garbage input with a typed InputError', () => {
    expect(() => oggAudioPackets(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toThrowError(
      InputError,
    );
    expect(() => oggAudioPackets(new Uint8Array(0))).toThrowError(InputError);
  });
});
