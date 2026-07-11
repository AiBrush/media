import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { containerHasChunkMuxer } from '../api/codec-routing.ts';
import { createMedia } from '../api/create-media.ts';
import type { ContainerDriver } from '../contracts/driver.ts';
import { Registry } from '../kernel/registry.ts';
import { fromBytes } from '../sources/source.ts';
import { AdtsDriver, parseAdts } from './adts/adts-driver.ts';
import { registerDefaultDrivers } from './defaults.ts';
import { MpegTsDriver } from './mpegts/mpegts-driver.ts';
import { detectFraming, parseTs } from './mpegts/ts-parse.ts';

const DERIVED = new URL('../../fixtures/media-derived/', import.meta.url).pathname;
const TS_PACKET_BYTES = 188;

function defaultContainer(id: string): ContainerDriver {
  const registry = new Registry();
  registerDefaultDrivers(registry);
  const driver = registry.containers().find((candidate) => candidate.id === id);
  if (driver === undefined) throw new Error(`missing default container '${id}'`);
  return driver;
}

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${DERIVED}${path}`));
}

async function blobBytes(value: unknown): Promise<Uint8Array> {
  if (!(value instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await value.arrayBuffer());
}

/** Preserve real 188-byte transport packets while adding the standardized four-byte M2TS prefix. */
function asM2ts(source: Uint8Array): Uint8Array {
  const packets = Math.floor(source.byteLength / TS_PACKET_BYTES);
  const out = new Uint8Array(packets * 192);
  for (let index = 0; index < packets; index += 1) {
    const stamp = index * 300;
    const start = index * 192;
    out[start] = (stamp >>> 24) & 0xff;
    out[start + 1] = (stamp >>> 16) & 0xff;
    out[start + 2] = (stamp >>> 8) & 0xff;
    out[start + 3] = stamp & 0xff;
    out.set(source.subarray(index * TS_PACKET_BYTES, (index + 1) * TS_PACKET_BYTES), start + 4);
  }
  return out;
}

/** Preserve real 188-byte packets and append the 16-byte RS parity field carried by 204-byte TS. */
function asRs204(source: Uint8Array): Uint8Array {
  const packets = Math.floor(source.byteLength / TS_PACKET_BYTES);
  const out = new Uint8Array(packets * 204);
  for (let index = 0; index < packets; index += 1) {
    out.set(source.subarray(index * TS_PACKET_BYTES, (index + 1) * TS_PACKET_BYTES), index * 204);
  }
  return out;
}

describe('Session 12 container aliases', () => {
  it('declares every public MPEG-TS and ADTS alias on both the lazy and concrete drivers', () => {
    expect(defaultContainer('mpegts').formats).toEqual(['ts', 'm2ts', 'mts', 'mpegts']);
    expect(MpegTsDriver.formats).toEqual(['ts', 'm2ts', 'mts', 'mpegts']);
    expect(defaultContainer('adts').formats).toEqual(['adts', 'aac']);
    expect(AdtsDriver.formats).toEqual(['adts', 'aac']);
  });

  it('routes case-insensitive parameterized MIME hints before encrypted bytes can be sniffed', () => {
    expect(
      defaultContainer('mpegts').supports({
        direction: 'demux',
        mime: 'Video/MP2T; codecs="avc1.64001f"',
      }),
    ).toBe(true);
    expect(
      defaultContainer('adts').supports({
        direction: 'demux',
        mime: 'Audio/AAC; profile=lc',
      }),
    ).toBe(true);
  });

  it('keeps every public alias on the truthful encoded-chunk mux route', () => {
    for (const alias of ['ts', 'm2ts', 'mts', 'mpegts', 'adts', 'aac']) {
      expect(containerHasChunkMuxer(alias), alias).toBe(true);
    }
  });

  it.each([
    ['m2ts', 'mpegts/aac_22k_long.m2t'],
    ['mts', 'mpegts/aac_44k_multi.m2t'],
    ['mpegts', 'mpegts/aac_48k_split.m2t'],
  ] as const)('public remux to %s stays on exact native TS stream-copy', async (alias, fixture) => {
    const input = await bytes(fixture);
    const value = await createMedia().remux(fromBytes(input, { mime: 'video/mp2t' }), {
      to: alias,
    });
    expect(value).toBeInstanceOf(Blob);
    expect((value as Blob).type).toBe('video/mp2t');
    const output = await blobBytes(value);
    const parsed = parseTs(output);
    expect(parsed.tracks.map((track) => track.stream.codec)).toEqual(['aac']);
    expect(parsed.tracks[0]?.units.length).toBeGreaterThan(100);
  });

  it('public remux to aac is the ADTS alias and preserves every real frame byte-exactly', async () => {
    const input = await bytes('hls-aes128/audio-adts/clear000.aac');
    const value = await createMedia().remux(fromBytes(input, { mime: 'audio/aac' }), { to: 'aac' });
    expect(value).toBeInstanceOf(Blob);
    expect((value as Blob).type).toBe('audio/aac');
    const output = await blobBytes(value);
    expect(output).toEqual(input);
    expect(parseAdts(output).frames).toBe(22);
  });
});

describe('Session 12 raw MPEG-TS framing sniff', () => {
  it('routes real transport payloads in 188-, M2TS-192-, and RS-204-byte framing', async () => {
    const realPackets = (await bytes('h264_720p.head.ts')).subarray(0, TS_PACKET_BYTES * 12);
    const variants = [
      { bytes: realPackets, framing: { packetSize: 188, start: 0, tsOffset: 0 } },
      { bytes: asM2ts(realPackets), framing: { packetSize: 192, start: 0, tsOffset: 4 } },
      { bytes: asRs204(realPackets), framing: { packetSize: 204, start: 0, tsOffset: 0 } },
    ] as const;
    const lazy = defaultContainer('mpegts');

    for (const variant of variants) {
      expect(detectFraming(variant.bytes)).toEqual(variant.framing);
      expect(lazy.supports({ direction: 'demux', head: variant.bytes })).toBe(true);
      expect(MpegTsDriver.supports({ direction: 'demux', head: variant.bytes })).toBe(true);
    }
  });

  it('does not route a truncated or random sync coincidence as MPEG-TS', () => {
    const onePacket = new Uint8Array(204);
    onePacket[4] = 0x47;
    expect(defaultContainer('mpegts').supports({ direction: 'demux', head: onePacket })).toBe(
      false,
    );
    expect(MpegTsDriver.supports({ direction: 'demux', head: onePacket })).toBe(false);
  });
});
