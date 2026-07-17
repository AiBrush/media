import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CodecQuery, ContainerQuery, FilterSpec } from './driver.ts';
import {
  CapabilityError,
  type CapabilityErrorDetail,
  InputError,
  MediaError,
  type OperationDescriptor,
  isCapabilityErrorDetail,
} from './errors.ts';

describe('MediaError', () => {
  it('carries code, message, and reflects the class name', () => {
    const err = new MediaError('decode-error', 'boom');
    expect(err.code).toBe('decode-error');
    expect(err.message).toBe('boom');
    expect(err.name).toBe('MediaError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MediaError);
  });

  it('preserves an optional structured detail and leaves it undefined when omitted', () => {
    const detail = { tried: ['a', 'b'] };
    expect(new MediaError('mux-error', 'm', detail).detail).toBe(detail);
    expect(new MediaError('mux-error', 'm').detail).toBeUndefined();
  });

  it('is throwable and catchable as a typed error with a stack', () => {
    try {
      throw new MediaError('aborted', 'cancelled');
    } catch (e) {
      expect(e).toBeInstanceOf(MediaError);
      expect((e as MediaError).code).toBe('aborted');
      expect(typeof (e as MediaError).stack).toBe('string');
    }
  });
});

describe('CapabilityError', () => {
  it('fixes code = capability-miss intrinsically and carries the typed detail', () => {
    const detail: CapabilityErrorDetail = {
      op: { kind: 'route', id: 'decode' },
      tried: ['webcodecs-audio'],
      suggestion: 'register wasm-flac',
    };
    const err = new CapabilityError('no codec driver for flac', detail);
    expect(err).toBeInstanceOf(MediaError);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.name).toBe('CapabilityError');
    expect(err.code).toBe('capability-miss');
    expect(err.detail).toBe(detail);
  });

  it('accepts every OperationDescriptor kind of the discriminated union', () => {
    const codecQuery: CodecQuery = {
      mediaType: 'audio',
      direction: 'decode',
      config: { codec: 'flac', sampleRate: 48_000, numberOfChannels: 2 },
    };
    const containerQuery: ContainerQuery = { direction: 'mux', extension: 'mp4' };
    const filterSpec: FilterSpec = { mediaType: 'audio', type: 'gain', db: -3 };
    const ops: readonly OperationDescriptor[] = [
      { kind: 'codec', query: codecQuery },
      { kind: 'container', query: containerQuery },
      { kind: 'filter', spec: filterSpec },
      { kind: 'route', id: 'remux', facts: { container: 'mp4', fragmented: true } },
    ];
    for (const op of ops) {
      const err = new CapabilityError('miss', { op, tried: ['x'] });
      expect(err.detail?.op).toBe(op);
      expect(isCapabilityErrorDetail(err.detail)).toBe(true);
    }
  });

  it('guards a wire-shaped detail without accepting malformed payloads', () => {
    expect(isCapabilityErrorDetail({ op: { kind: 'route', id: 'demux' }, tried: [] })).toBe(true);
    expect(isCapabilityErrorDetail({ op: { kind: 'route', id: 'demux' }, tried: ['mp4'] })).toBe(
      true,
    );
    expect(isCapabilityErrorDetail(undefined)).toBe(false);
    expect(isCapabilityErrorDetail(null)).toBe(false);
    expect(isCapabilityErrorDetail('demux')).toBe(false);
    expect(isCapabilityErrorDetail({ op: 'demux', tried: [] })).toBe(false);
    expect(isCapabilityErrorDetail({ op: { kind: 'route' }, tried: [] })).toBe(false);
    expect(isCapabilityErrorDetail({ op: { kind: 'route', id: 'x' } })).toBe(false);
    expect(isCapabilityErrorDetail({ op: { kind: 'route', id: 'x' }, tried: [1] })).toBe(false);
    expect(isCapabilityErrorDetail({ op: { kind: 'codec' }, tried: [] })).toBe(false);
  });
});

describe('InputError', () => {
  it('fixes code = unsupported-input intrinsically and reflects its own name', () => {
    const err = new InputError('garbled bytes');
    expect(err).toBeInstanceOf(MediaError);
    expect(err).toBeInstanceOf(InputError);
    expect(err.name).toBe('InputError');
    expect(err.code).toBe('unsupported-input');
  });

  it('is distinguishable from a sibling subclass', () => {
    expect(new InputError('x')).not.toBeInstanceOf(CapabilityError);
  });
});

describe('intrinsic-code conformance (source scan)', () => {
  // The constructors own their codes now; a call site restating them cannot compile, and this scan
  // proves no stale literal survives anywhere in src (the R-S04.3 grep acceptance, as an oracle).
  const staleCapability = `new CapabilityError(${"'capability-miss'"}`;
  const staleInput = `new InputError(${"'unsupported-input'"}`;

  it('no call site passes a redundant code literal', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const text = readFileSync(path, 'utf8');
        if (text.includes(staleCapability) || text.includes(staleInput)) offenders.push(path);
      }
    };
    walk(fileURLToPath(new URL('..', import.meta.url)));
    expect(offenders).toEqual([]);
  });
});
