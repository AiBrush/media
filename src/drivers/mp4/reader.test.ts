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
});
