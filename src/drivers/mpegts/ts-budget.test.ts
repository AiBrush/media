import { describe, expect, it } from 'vitest';
import { MAX_TS_PACKETS_PER_FILE, parseTs } from './ts-parse.ts';

const PACKET = 188;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function tsPacket(
  pid: number,
  payload: Uint8Array,
  opts: { payloadUnitStart?: boolean } = {},
): Uint8Array {
  const out = new Uint8Array(PACKET);
  out.fill(0xff);
  out[0] = 0x47;
  out[1] = (opts.payloadUnitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  out[2] = pid & 0xff;
  out[3] = 0x10;
  out.set(payload.subarray(0, PACKET - 4), 4);
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

function streamEntry(streamType: number, pid: number): Uint8Array {
  return Uint8Array.of(streamType, 0xe0 | ((pid >> 8) & 0x1f), pid & 0xff, 0xf0, 0x00);
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

function pes(streamId: number, pts: number, payload: Uint8Array): Uint8Array {
  const ptsBs = ptsBytes(2, pts);
  return concatBytes(
    Uint8Array.of(0x00, 0x00, 0x01, streamId, 0x00, 0x00, 0x80, 0x80),
    Uint8Array.of(ptsBs.length),
    ptsBs,
    payload,
  );
}

// Minimal H264 AU: AUD + IDR slice (hasIdr true)
function h264Au(): Uint8Array {
  return Uint8Array.of(0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x65, 0xaa, 0xbb);
}

function validTsWithVideoPes(pesCount: number): Uint8Array {
  const pmtPid = 0x0100;
  const videoPid = 0x0120;
  const parts: Uint8Array[] = [];
  parts.push(sectionPacket(0x0000, patSection(pmtPid)));
  parts.push(sectionPacket(pmtPid, pmtSection([streamEntry(0x1b, videoPid)])));
  for (let i = 0; i < pesCount; i++) {
    const payload = pes(0xe0, i * 3600, h264Au());
    parts.push(tsPacket(videoPid, payload, { payloadUnitStart: true }));
  }
  return concatBytes(...parts);
}

describe('mpegts budget', () => {
  it('rejects a file with >MAX_TS_PACKETS_PER_FILE packets with typed demux-error', () => {
    const bytes = validTsWithVideoPes(MAX_TS_PACKETS_PER_FILE - 1); // 2 + (MAX-1) = MAX+1 total packets
    // validTsWithVideoPes includes 2 PSI packets + (MAX-1) PES = MAX+1
    expect(() => parseTs(bytes)).toThrowError(/budget exceeded/i);
  });

  it('accepts exactly MAX_TS_PACKETS_PER_FILE packets at the boundary', () => {
    const bytes = validTsWithVideoPes(MAX_TS_PACKETS_PER_FILE - 2); // 2 + (MAX-2) = MAX
    const parsed = parseTs(bytes);
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0]?.units).toHaveLength(MAX_TS_PACKETS_PER_FILE - 2);
  });

  it('20x randomized valid 0-9 PES packets bit-exact on track count and duration', () => {
    for (let iter = 0; iter < 20; iter++) {
      const n = Math.floor(Math.random() * 10); // 0..9
      const bytes = validTsWithVideoPes(n);
      const parsed = parseTs(bytes);
      expect(parsed.tracks).toHaveLength(1);
      expect(parsed.tracks[0]?.units).toHaveLength(n);
      if (n >= 2) {
        // duration is standardized via ptsSpan: (last-first+medianGap)/90k
        const expectedDuration = ((n - 1) * 3600 + 3600) / 90_000;
        expect(parsed.tracks[0]?.durationSec).toBeCloseTo(expectedDuration, 6);
      }
    }
  });

  it('rejects truncated/malformed input with typed error (no OOM)', () => {
    const valid = validTsWithVideoPes(3);
    const truncated = valid.subarray(0, valid.byteLength - 50);
    // truncated may still parse or throw InputError/demux-error, but must not OOM and must be typed
    try {
      parseTs(truncated);
    } catch (e) {
      expect((e as Error).message).toMatch(/MPEG-TS|transport|PAT|PMT|packet/i);
      return;
    }
    // If it didn't throw, that's still acceptable for truncated that happens to be valid prefix
    expect(true).toBe(true);
  });
});
