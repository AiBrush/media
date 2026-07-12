import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import {
  type SerializedError,
  collectTransferables,
  deserializeError,
  isFrameLike,
  serializeError,
} from './worker-protocol.ts';

describe('worker protocol serialization boundaries', () => {
  it('collects each supported transferable shape exactly once through nested data', () => {
    const shared = new ArrayBuffer(8);
    const view = new Uint16Array(shared);
    const dataView = new DataView(shared);
    const readable = new ReadableStream<Uint8Array>();
    const writable = new WritableStream<Uint8Array>();
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const channel = new MessageChannel();
    const videoLike = { close: (): void => {}, codedWidth: 16 };
    const audioLike = { close: (): void => {}, numberOfFrames: 32 };
    const bitmapLike = { close: (): void => {}, width: 8 };

    const transfers = collectTransferables({
      shared,
      duplicates: [view, dataView, shared],
      readable,
      writable,
      transform,
      port: channel.port1,
      handles: [videoLike, audioLike, bitmapLike],
    });

    expect(transfers.filter((item) => item === shared)).toHaveLength(1);
    expect(transfers).toEqual(
      expect.arrayContaining([
        shared,
        readable,
        writable,
        transform,
        channel.port1,
        videoLike,
        audioLike,
        bitmapLike,
      ]),
    );
    channel.port1.close();
    channel.port2.close();
  });

  it('ignores primitives, null, non-frame objects, and values deeper than the bounded walk', () => {
    const tooDeep = new ArrayBuffer(2);
    const cyclic: { self?: unknown; child?: unknown } = {};
    cyclic.self = cyclic;
    cyclic.child = { a: { b: { c: { d: { tooDeep } } } } };

    expect(collectTransferables([null, 1, 'x', false, { close: (): void => {} }, cyclic])).toEqual(
      [],
    );
    expect(isFrameLike(null)).toBe(false);
    expect(isFrameLike('frame')).toBe(false);
    expect(isFrameLike({ close: 1, width: 2 })).toBe(false);
    expect(isFrameLike({ close: (): void => {}, height: 2 })).toBe(false);
  });

  it('preserves clone-safe detail and explicitly retains null/undefined detail', () => {
    const cloneSafe = { nested: [1, 'two', null] };
    expect(serializeError(new MediaError('mux-error', 'media', cloneSafe))).toEqual({
      kind: 'media',
      code: 'mux-error',
      message: 'media',
      detail: cloneSafe,
    });
    expect(serializeError(new InputError('unsupported-input', 'input', null)).detail).toBeNull();
    expect(serializeError(new CapabilityError('capability-miss', 'cap')).detail).toBeUndefined();
  });

  it('serializes generic Error and non-Error throws without fabricating a media code', () => {
    expect(serializeError(new Error('plain'))).toEqual({ kind: 'generic', message: 'plain' });
    expect(serializeError('string failure')).toEqual({
      kind: 'generic',
      message: 'string failure',
    });
    expect(serializeError(404)).toEqual({ kind: 'generic', message: '404' });
  });

  it('uses documented default codes when an older wire payload omits them', () => {
    const capability = deserializeError({ kind: 'capability', message: 'cap' });
    const input = deserializeError({ kind: 'input', message: 'input' });
    const media = deserializeError({ kind: 'media', message: 'media' });

    expect(capability).toMatchObject({ name: 'CapabilityError', code: 'capability-miss' });
    expect(input).toMatchObject({ name: 'InputError', code: 'unsupported-input' });
    expect(media).toMatchObject({ name: 'MediaError', code: 'decode-error' });
  });

  it('rebuilds generic failures either faithfully or under the caller operation code', () => {
    const wire: SerializedError = { kind: 'generic', message: 'worker exploded' };
    const plain = deserializeError(wire);
    const typed = deserializeError(wire, 'encode-error');

    expect(plain).toBeInstanceOf(Error);
    expect(plain).not.toBeInstanceOf(MediaError);
    expect(typed).toMatchObject({ name: 'MediaError', code: 'encode-error' });
  });
});
