import { describe, expect, it } from 'vitest';
import { Reader, boxes, readBoxHeader, readFullBoxHeader } from './reader.ts';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

describe('Reader primitives', () => {
  it('reads big-endian integers of every width', () => {
    expect(new Reader(new Uint8Array([0xab])).u8()).toBe(0xab);
    expect(new Reader(new Uint8Array([0x12, 0x34])).u16()).toBe(0x1234);
    expect(new Reader(new Uint8Array([0xff, 0xff])).i16()).toBe(-1);
    expect(new Reader(new Uint8Array([0x01, 0x02, 0x03])).u24()).toBe(0x010203);
    expect(new Reader(new Uint8Array([0x00, 0x00, 0x01, 0x00])).u32()).toBe(256);
    expect(new Reader(new Uint8Array([0xff, 0xff, 0xff, 0xff])).i32()).toBe(-1);
    expect(new Reader(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0])).u64()).toBe(2 ** 32);
    expect(new Reader(new Uint8Array([0, 1, 0, 0])).fixed16()).toBe(1);
    expect(new Reader(new Uint8Array(ascii('moov'))).fourcc()).toBe('moov');
  });

  it('reads byte ranges and tracks position', () => {
    const r = new Reader(new Uint8Array([1, 2, 3, 4, 5]));
    expect([...r.bytes(2)]).toEqual([1, 2]);
    expect(r.pos).toBe(2);
    expect([...r.bytesAt(0, 2)]).toEqual([1, 2]); // no cursor move
    expect(r.pos).toBe(2);
    r.skip(1);
    expect(r.pos).toBe(3);
    expect(r.remaining).toBe(2);
    r.seek(0);
    expect(r.remaining).toBe(5);
  });
});

describe('box headers', () => {
  it('parses a normal 8-byte header', () => {
    const h = readBoxHeader(new Reader(new Uint8Array([0, 0, 0, 16, ...ascii('moov')])));
    expect(h).toMatchObject({ type: 'moov', size: 16, headerSize: 8, payloadStart: 8, end: 16 });
  });

  it('parses a 64-bit largesize header', () => {
    const bytes = new Uint8Array([0, 0, 0, 1, ...ascii('mdat'), 0, 0, 0, 0, 0, 0, 0, 32]);
    const h = readBoxHeader(new Reader(bytes));
    expect(h).toMatchObject({ type: 'mdat', size: 32, headerSize: 16 });
  });

  it('treats size==0 as "to end of file"', () => {
    const bytes = new Uint8Array(20);
    bytes.set(ascii('mdat'), 4); // size stays 0
    const h = readBoxHeader(new Reader(bytes));
    expect(h).toMatchObject({ type: 'mdat', size: 20 });
  });

  it('iterates boxes and stops on a malformed one', () => {
    const buf = new Uint8Array([
      0,
      0,
      0,
      8,
      ...ascii('ftyp'), // box 1 (header-only)
      0,
      0,
      0,
      8,
      ...ascii('free'), // box 2
      0,
      0,
      0,
      4,
      ...ascii('bad!'), // malformed (size < headerSize) → stop
    ]);
    const types = [...boxes(new Reader(buf))].map((b) => b.type);
    expect(types).toEqual(['ftyp', 'free']);
  });

  it('reads a full-box version + flags', () => {
    expect(readFullBoxHeader(new Reader(new Uint8Array([1, 0, 0, 5])))).toEqual({
      version: 1,
      flags: 5,
    });
  });

  it('rejects 64-bit largesize beyond safe integer and below header size', () => {
    const tooSmall = new Uint8Array([0, 0, 0, 1, ...ascii('mdat'), 0, 0, 0, 0, 0, 0, 0, 8]);
    expect(() => readBoxHeader(new Reader(tooSmall))).toThrow(/largesize/);
    const overflow = new Uint8Array([0, 0, 0, 1, ...ascii('mdat'), 0x00, 0x20, 0, 0, 0, 0, 0, 0]);
    // 0x0020000000000000 = 2^53+1 > MAX_SAFE_INTEGER
    expect(() => readBoxHeader(new Reader(overflow))).toThrow(/largesize/);
    const maxSafe = new Uint8Array([
      0,
      0,
      0,
      1,
      ...ascii('mdat'),
      0,
      0,
      0x1f,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
    ]);
    // 0x001FFFFFFFFFFFFF = MAX_SAFE_INTEGER (9007199254740991) — must not throw at header parse level
    expect(() => readBoxHeader(new Reader(maxSafe))).not.toThrow();
  });

  it('parses u64BigInt exactly beyond 32-bit and randomized largesize stays within safe range', () => {
    const r = new Reader(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02]));
    expect(r.u64BigInt()).toBe(0x0000000100000002n);
    // 20× randomized valid largesize headers [16, 1MiB] all parse and round-trip
    for (let i = 0; i < 20; i++) {
      const size = 16 + ((i * 1234567) % (1 << 20));
      const bytes = new Uint8Array([
        0,
        0,
        0,
        1,
        ...ascii('free'),
        0,
        0,
        0,
        0,
        0,
        0,
        (size >>> 8) & 0xff,
        size & 0xff,
      ]);
      // patch big-endian correctly for sizes < 64k in this loop
      const view = new DataView(bytes.buffer);
      view.setBigUint64(8, BigInt(size));
      const h = readBoxHeader(new Reader(bytes));
      expect(h.size).toBe(size);
      expect(h.headerSize).toBe(16);
    }
  });
});
