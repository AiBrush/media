import { describe, expect, it } from 'vitest';
import {
  type CodecDriver,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type EncodedChunk,
  type FilterDriver,
  type RawFrame,
} from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { Registry } from '../kernel/registry.ts';
import {
  ConformanceError,
  assertCodecDriverConforms,
  assertContainerDriverConforms,
  assertFilterDriverConforms,
} from './harness.ts';
import { NOOP_CODEC, NOOP_CONTAINER, NOOP_FILTER, NoopDriverModule } from './noop-driver.ts';

const codecCase = {
  supported: { mediaType: 'video', direction: 'decode', config: { codec: 'noop' } },
  unsupported: { mediaType: 'video', direction: 'decode', config: { codec: 'real' } },
  decodeConfig: { codec: 'noop' },
  encodeConfig: { codec: 'noop', width: 2, height: 2 },
} as const;

const containerCase = {
  supported: { direction: 'demux', extension: 'noop' },
  unsupported: { direction: 'demux', extension: 'zzz' },
} as const;

const filterCase = {
  supported: { mediaType: 'video', type: 'resize', width: 2, height: 2 },
  unsupported: { mediaType: 'audio', type: 'gain', db: 1 },
} as const;

describe('conformance harness — the no-op reference driver passes', () => {
  it('codec driver conforms', async () => {
    await expect(assertCodecDriverConforms(NOOP_CODEC, codecCase)).resolves.toBeUndefined();
  });
  it('container driver conforms', () => {
    expect(() => assertContainerDriverConforms(NOOP_CONTAINER, containerCase)).not.toThrow();
  });
  it('filter driver conforms', () => {
    expect(() => assertFilterDriverConforms(NOOP_FILTER, filterCase)).not.toThrow();
  });
  it('the module registers all three drivers', () => {
    const reg = new Registry();
    NoopDriverModule.register(reg);
    expect(reg.codecs().map((d) => d.id)).toContain('noop-codec');
    expect(reg.containers().map((d) => d.id)).toContain('noop-container');
    expect(reg.filters().map((d) => d.id)).toContain('noop-filter');
  });
});

describe('conformance harness — it can fail (anti-cheat: oracles must reject wrong drivers)', () => {
  it('rejects a codec that claims to support its unsupported query', async () => {
    const liar: CodecDriver = {
      ...NOOP_CODEC,
      supports: () => Promise.resolve({ supported: true }),
    };
    await expect(assertCodecDriverConforms(liar, codecCase)).rejects.toBeInstanceOf(
      ConformanceError,
    );
  });

  it('rejects a codec whose supports() throws on a garbage query', async () => {
    const thrower: CodecDriver = {
      ...NOOP_CODEC,
      supports: (q) => {
        if (q.config.codec === '') throw new Error('boom');
        return Promise.resolve({ supported: q.config.codec === 'noop' });
      },
    };
    await expect(assertCodecDriverConforms(thrower, codecCase)).rejects.toBeInstanceOf(
      ConformanceError,
    );
  });

  it('rejects a driver targeting an unsupported apiVersion', async () => {
    const future: CodecDriver = { ...NOOP_CODEC, apiVersion: DRIVER_API_VERSION + 5 };
    await expect(assertCodecDriverConforms(future, codecCase)).rejects.toBeInstanceOf(
      ConformanceError,
    );
  });

  it('rejects a codec whose createEncoder throws a non-typed error', async () => {
    const bad: CodecDriver = {
      ...NOOP_CODEC,
      createEncoder: () => {
        throw new Error('plain, not a MediaError');
      },
    };
    await expect(assertCodecDriverConforms(bad, codecCase)).rejects.toBeInstanceOf(
      ConformanceError,
    );
  });

  it('rejects a container with no declared formats', () => {
    const empty: ContainerDriver = { ...NOOP_CONTAINER, formats: [] };
    expect(() => assertContainerDriverConforms(empty, containerCase)).toThrow(ConformanceError);
  });

  it('rejects a filter with an invalid substrate', () => {
    const bad = { ...NOOP_FILTER, substrate: 'quantum' } as unknown as FilterDriver;
    expect(() => assertFilterDriverConforms(bad, filterCase)).toThrow(ConformanceError);
  });

  it('accepts a codec whose createEncoder throws a typed MediaError (encode-not-provided is legal)', async () => {
    const decodeOnly: CodecDriver = {
      ...NOOP_CODEC,
      createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
      createEncoder: () => {
        throw new MediaError('encode-error', 'this driver does not provide an encoder');
      },
    };
    await expect(assertCodecDriverConforms(decodeOnly, codecCase)).resolves.toBeUndefined();
  });
});
