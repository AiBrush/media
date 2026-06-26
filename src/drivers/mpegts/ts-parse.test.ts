/**
 * MPEG-TS parsing primitives — framing detection (188 / m2ts-192 / offset) and PES timing, derived from
 * the committed real `h264_720p.head.ts` packets (the m2ts/offset variants wrap the verbatim 188-byte
 * payloads). A small spec-minimal packet section below exercises PSI/PES branch syntax that the real
 * corpus does not contain (private descriptors, 204-byte framing, DTS flags); those fixtures still pass
 * through the public parseTs/detectFraming surfaces with concrete metadata or timing assertions.
 */

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectFraming, parseTs } from './ts-parse.ts';

const DERIVED = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;
const PACKET = 188;

let ts188: Uint8Array;
beforeAll(async () => {
  ts188 = new Uint8Array(await readFile(`${DERIVED}h264_720p.head.ts`));
});

/** Wrap each verbatim 188-byte packet in a 192-byte m2ts packet (4-byte timestamp prefix). */
function toM2ts(ts: Uint8Array): Uint8Array {
  const n = Math.floor(ts.byteLength / PACKET);
  const out = new Uint8Array(n * 192);
  for (let i = 0; i < n; i++) {
    const stamp = i * 100; // an arbitrary but well-formed 4-byte copy-counter timestamp
    out[i * 192] = (stamp >>> 24) & 0xff;
    out[i * 192 + 1] = (stamp >>> 16) & 0xff;
    out[i * 192 + 2] = (stamp >>> 8) & 0xff;
    out[i * 192 + 3] = stamp & 0xff;
    out.set(ts.subarray(i * PACKET, (i + 1) * PACKET), i * 192 + 4);
  }
  return out;
}

/** Wrap each verbatim 188-byte packet in a 204-byte RS-parity-shaped packet (16-byte suffix). */
function to204(ts: Uint8Array): Uint8Array {
  const n = Math.floor(ts.byteLength / PACKET);
  const out = new Uint8Array(n * 204);
  for (let i = 0; i < n; i++) out.set(ts.subarray(i * PACKET, (i + 1) * PACKET), i * 204);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function asciiBytes(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function tsPacket(
  pid: number,
  payload: Uint8Array,
  opts: {
    payloadUnitStart?: boolean;
    transportError?: boolean;
    scrambled?: boolean;
    adaptationOnly?: boolean;
    reservedAdaptationControl?: boolean;
    pcr?: number;
  } = {},
): Uint8Array {
  const out = new Uint8Array(PACKET);
  out.fill(0xff);
  out[0] = 0x47;
  out[1] =
    (opts.transportError ? 0x80 : 0) | (opts.payloadUnitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  out[2] = pid & 0xff;
  if (opts.reservedAdaptationControl) {
    out[3] = opts.scrambled ? 0x80 : 0;
    return out;
  }
  const hasAdaptation = opts.adaptationOnly || opts.pcr !== undefined;
  const hasPayload = !opts.adaptationOnly;
  out[3] = (opts.scrambled ? 0x80 : 0) | ((hasAdaptation ? 0x20 : 0) | (hasPayload ? 0x10 : 0));
  let cursor = 4;
  if (hasAdaptation) {
    const adaptationLength = opts.pcr !== undefined ? 7 : 0;
    out[cursor] = adaptationLength;
    if (opts.pcr !== undefined) {
      const pcr = opts.pcr;
      out[cursor + 1] = 0x10;
      out[cursor + 2] = Math.floor(pcr / 2 ** 25) & 0xff;
      out[cursor + 3] = Math.floor(pcr / 2 ** 17) & 0xff;
      out[cursor + 4] = Math.floor(pcr / 2 ** 9) & 0xff;
      out[cursor + 5] = Math.floor(pcr / 2) & 0xff;
      out[cursor + 6] = (pcr & 1) << 7;
    }
    cursor += 1 + adaptationLength;
  }
  if (hasPayload) out.set(payload.subarray(0, PACKET - cursor), cursor);
  return out;
}

function sectionPacket(pid: number, section: Uint8Array): Uint8Array {
  return tsPacket(pid, concatBytes(Uint8Array.of(0), section), { payloadUnitStart: true });
}

function patSection(pmtPid = 0x0100): Uint8Array {
  return Uint8Array.of(
    0x00,
    0xb0,
    0x0d,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0x00,
    0x01,
    0xe0 | ((pmtPid >> 8) & 0x1f),
    pmtPid & 0xff,
    0,
    0,
    0,
    0,
  );
}

function streamEntry(
  streamType: number,
  pid: number,
  descriptors: Uint8Array = new Uint8Array(0),
): Uint8Array {
  return concatBytes(
    Uint8Array.of(
      streamType,
      0xe0 | ((pid >> 8) & 0x1f),
      pid & 0xff,
      0xf0 | ((descriptors.length >> 8) & 0x0f),
      descriptors.length & 0xff,
    ),
    descriptors,
  );
}

function descriptor(tag: number, body: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag, body.length), body);
}

function pmtSection(entries: Uint8Array[]): Uint8Array {
  const body = concatBytes(...entries);
  const sectionLength = 13 + body.length;
  return concatBytes(
    Uint8Array.of(
      0x02,
      0xb0 | ((sectionLength >> 8) & 0x0f),
      sectionLength & 0xff,
      0x00,
      0x01,
      0xc1,
      0x00,
      0x00,
      0xe1,
      0x01,
      0xf0,
      0x00,
    ),
    body,
    Uint8Array.of(0, 0, 0, 0),
  );
}

function ptsBytes(prefix: number, ticks: number): Uint8Array {
  return Uint8Array.of(
    (prefix << 4) | (((Math.floor(ticks / 2 ** 30) & 0x07) << 1) | 1),
    Math.floor(ticks / 2 ** 22) & 0xff,
    (((Math.floor(ticks / 2 ** 15) & 0x7f) << 1) | 1) & 0xff,
    Math.floor(ticks / 2 ** 7) & 0xff,
    ((ticks & 0x7f) << 1) | 1,
  );
}

function pes(streamId: number, pts: number, payload: Uint8Array, dts?: number): Uint8Array {
  const ptsDts =
    dts === undefined ? ptsBytes(2, pts) : concatBytes(ptsBytes(3, pts), ptsBytes(1, dts));
  return concatBytes(
    Uint8Array.of(0x00, 0x00, 0x01, streamId, 0x00, 0x00, 0x80, dts === undefined ? 0x80 : 0xc0),
    Uint8Array.of(ptsDts.length),
    ptsDts,
    payload,
  );
}

function adtsFrame(frameLen = 12): Uint8Array {
  const h = new Uint8Array(frameLen);
  h[0] = 0xff;
  h[1] = 0xf1;
  h[2] = (1 << 6) | (3 << 2); // AAC-LC, 48 kHz, stereo high bit 0
  h[3] = (2 << 6) | ((frameLen >> 11) & 0x03);
  h[4] = (frameLen >> 3) & 0xff;
  h[5] = ((frameLen & 0x07) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}

describe('detectFraming', () => {
  it('locks onto plain 188-byte packets at offset 0', () => {
    expect(detectFraming(ts188)).toEqual({ packetSize: 188, start: 0, tsOffset: 0 });
  });

  it('detects m2ts 192-byte packets with a 4-byte prefix (sync at offset 4)', () => {
    expect(detectFraming(toM2ts(ts188))).toEqual({ packetSize: 192, start: 0, tsOffset: 4 });
  });

  it('detects 204-byte transport packets with RS parity suffix bytes', () => {
    expect(detectFraming(to204(ts188))).toEqual({ packetSize: 204, start: 0, tsOffset: 0 });
  });

  it('finds the packet grid after a run of junk bytes before the first sync', () => {
    const shifted = new Uint8Array(7 + ts188.byteLength);
    shifted.set(ts188, 7);
    expect(detectFraming(shifted)).toEqual({ packetSize: 188, start: 7, tsOffset: 0 });
  });

  it('returns undefined for buffers with no transport sync run', () => {
    expect(detectFraming(new Uint8Array(1000))).toBeUndefined(); // all zero
    expect(detectFraming(Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff))).toBeUndefined();
  });

  it('locks on a tiny 2-packet input but needs ≥ 2 packets to confirm a stride', () => {
    // Two real packets are enough to confirm the 188 stride (the short-run acceptance path)…
    expect(detectFraming(ts188.subarray(0, PACKET * 2))).toEqual({
      packetSize: 188,
      start: 0,
      tsOffset: 0,
    });
    // …but a single packet cannot prove a periodic grid (one stray 0x47 ≠ a transport stream).
    expect(detectFraming(ts188.subarray(0, PACKET))).toBeUndefined();
  });
});

describe('parseTs — spec-minimal PSI/PES branch fixtures', () => {
  it('skips packet-control variants and resolves private PMT descriptors', () => {
    const pmtPid = 0x0100;
    const packets = concatBytes(
      tsPacket(0x1fff, new Uint8Array(0)),
      tsPacket(0x0000, new Uint8Array(0), { transportError: true }),
      tsPacket(0x0000, new Uint8Array(0), { reservedAdaptationControl: true }),
      tsPacket(0x0020, new Uint8Array(0), { adaptationOnly: true, pcr: 90_000 }),
      sectionPacket(0x0000, patSection(pmtPid)),
      sectionPacket(
        pmtPid,
        pmtSection([
          streamEntry(0x06, 0x0110, descriptor(0x05, asciiBytes('AC-3'))),
          streamEntry(0x06, 0x0111, descriptor(0x05, asciiBytes('EAC3'))),
          streamEntry(0x06, 0x0112, descriptor(0x05, asciiBytes('Opus'))),
          streamEntry(0x06, 0x0113, descriptor(0x6a, Uint8Array.of())),
          streamEntry(0x06, 0x0114, descriptor(0x7a, Uint8Array.of())),
          streamEntry(0x06, 0x0115, descriptor(0x56, Uint8Array.of())),
          streamEntry(0x99, 0x0116),
        ]),
      ),
    );
    expect(parseTs(packets).tracks.map((t) => [t.stream.pid, t.stream.codec])).toEqual([
      [0x0110, 'ac-3'],
      [0x0111, 'ec-3'],
      [0x0112, 'opus'],
      [0x0113, 'ac-3'],
      [0x0114, 'ec-3'],
    ]);
  });

  it('preserves DTS and detects HEVC IRAP keyframes from a PES payload', () => {
    const pmtPid = 0x0100;
    const hevcPid = 0x0120;
    const pts = 180_000;
    const dts = 90_000;
    const stream = concatBytes(
      sectionPacket(0x0000, patSection(pmtPid)),
      sectionPacket(pmtPid, pmtSection([streamEntry(0x24, hevcPid)])),
      tsPacket(hevcPid, pes(0xe0, pts, Uint8Array.of(0, 0, 1, 0x26, 0x01), dts), {
        payloadUnitStart: true,
      }),
    );
    const unit = parseTs(stream).tracks[0]?.units[0];
    expect(unit).toMatchObject({
      ptsUs: 2_000_000,
      dtsUs: 1_000_000,
      keyframe: true,
    });
  });

  it('keeps a single-frame AAC PES on the whole-payload path', () => {
    const pmtPid = 0x0100;
    const aacPid = 0x0121;
    const stream = concatBytes(
      sectionPacket(0x0000, patSection(pmtPid)),
      sectionPacket(pmtPid, pmtSection([streamEntry(0x0f, aacPid)])),
      tsPacket(aacPid, pes(0xc0, 90_000, adtsFrame(12)), { payloadUnitStart: true }),
    );
    const track = parseTs(stream).tracks[0];
    expect(track?.stream).toMatchObject({ mediaType: 'audio', codec: 'aac' });
    expect(track?.units).toHaveLength(1);
    expect([...(track?.units[0]?.data.subarray(0, 12) ?? [])]).toEqual([...adtsFrame(12)]);
    expect(track?.units[0]?.data.length).toBeGreaterThan(12);
    expect(track?.config).toMatchObject({ codec: 'aac', sampleRate: 48000, numberOfChannels: 2 });
  });
});

describe('parseTs on the m2ts (192-byte) and offset variants of the real slice', () => {
  it('parses the same tracks/dims/first-PTS from m2ts as from plain TS', () => {
    const plain = parseTs(ts188);
    const m2ts = parseTs(toM2ts(ts188));
    const summarize = (p: ReturnType<typeof parseTs>): unknown[] =>
      p.tracks.map((t) => ({
        codec: t.stream.codec,
        type: t.stream.mediaType,
        firstPtsUs: t.units[0]?.ptsUs,
        units: t.units.length,
      }));
    expect(summarize(m2ts)).toEqual(summarize(plain));
    const v = m2ts.tracks[0]?.config as VideoDecoderConfig;
    expect(v).toMatchObject({ codec: 'h264', codedWidth: 1280, codedHeight: 720 });
  });

  it('parses the offset-shifted (junk-prefixed) 188 stream identically', () => {
    const shifted = new Uint8Array(7 + ts188.byteLength);
    shifted.set(ts188, 7);
    expect(parseTs(shifted).tracks.map((t) => t.stream.codec)).toEqual(['h264', 'aac']);
  });
});
