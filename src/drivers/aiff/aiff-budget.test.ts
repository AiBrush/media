import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { MAX_AIFF_CHUNKS_PER_FILE, parseAiff, writeExtendedFloat80 } from './aiff.ts';

function commBody(frames: number): Uint8Array {
  const body = new Uint8Array(18);
  const dv = new DataView(body.buffer);
  dv.setUint16(0, 1);
  dv.setUint32(2, frames);
  dv.setUint16(6, 16);
  body.set(writeExtendedFloat80(48000), 8);
  return body;
}
function chunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength + (body.byteLength & 1));
  out.set(
    Uint8Array.from(id, (c) => c.charCodeAt(0)),
    0,
  );
  new DataView(out.buffer).setUint32(4, body.byteLength, false);
  out.set(body, 8);
  return out;
}
function aiffWithJunk(junkCount: number, frames = 2): Uint8Array {
  const comm = chunk('COMM', commBody(frames));
  const junkPayload = new Uint8Array(4);
  const junk = chunk('JUNK', junkPayload);
  const ssndBody = new Uint8Array(8 + frames * 2);
  new DataView(ssndBody.buffer).setUint32(0, 0, false);
  new DataView(ssndBody.buffer).setUint32(4, 0, false);
  const ssnd = chunk('SSND', ssndBody);
  const total = 12 + comm.byteLength + junkCount * junk.byteLength + ssnd.byteLength;
  const out = new Uint8Array(total);
  out.set(
    Uint8Array.from('FORM', (c) => c.charCodeAt(0)),
    0,
  );
  new DataView(out.buffer).setUint32(4, total - 8, false);
  out.set(
    Uint8Array.from('AIFF', (c) => c.charCodeAt(0)),
    8,
  );
  let off = 12;
  out.set(comm, off);
  off += comm.byteLength;
  for (let i = 0; i < junkCount; i++) {
    out.set(junk, off);
    off += junk.byteLength;
  }
  out.set(ssnd, off);
  return out;
}

describe('AIFF chunk-count budget', () => {
  it('rejects >MAX chunks with typed demux-error and budget message', () => {
    const bytes = aiffWithJunk(MAX_AIFF_CHUNKS_PER_FILE - 1); // COMM + (MAX-1) junk + SSND = MAX+1
    expect(() => parseAiff(bytes)).toThrow(MediaError);
    try {
      parseAiff(bytes);
    } catch (e) {
      expect((e as MediaError).code).toBe('demux-error');
      expect((e as Error).message).toMatch(/budget exceeded/);
    }
  });

  it('accepts exactly MAX chunks at the boundary', () => {
    const bytes = aiffWithJunk(MAX_AIFF_CHUNKS_PER_FILE - 2); // COMM + (MAX-2) junk + SSND = MAX
    const info = parseAiff(bytes);
    expect(info.container).toBe('aiff');
    expect(info.frames).toBe(2);
  });

  it('20× randomized 0–9 JUNK chunks stay bit-exact', () => {
    let seed = 0x87654321;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let iter = 0; iter < 20; iter++) {
      const n = next() % 10;
      const bytes = aiffWithJunk(n, 4);
      const info = parseAiff(bytes);
      expect(info.frames).toBe(4);
      expect(info.sampleRate).toBe(48000);
    }
  });

  it('rejects truncated/malformed without OOM', () => {
    const valid = aiffWithJunk(1);
    const truncated = valid.subarray(0, 10);
    expect(() => parseAiff(truncated)).toThrow(MediaError);
    expect(() => parseAiff(new Uint8Array([0, 1, 2, 3]))).toThrow(Error);
  });
});
