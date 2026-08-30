import type { ContainerDriver, ContainerQuery, StageOptions } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { materialize, toBlob } from '../sinks/sink.ts';
import type { MaterializeOptions, Output, Sink } from '../sinks/sink.ts';
import { isLiveMediaSource } from '../sources/live-source.ts';
import { type MediaInput, type Source, from as normalizeInput } from '../sources/source.ts';
import type { CallOptions, DecryptOptions } from './types.ts';

const CONTAINER_MIME: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  adts: 'audio/aac',
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpegts: 'video/mp2t',
};

/** Engine-owned container capabilities used by the lazy decrypt implementation. */
export interface DecryptRunnerContext {
  readonly container: (
    source: Source,
    direction: ContainerQuery['direction'],
    signal?: AbortSignal,
    pinDriver?: string,
  ) => Promise<ContainerDriver>;
  readonly stage: (signal: AbortSignal, options: CallOptions) => StageOptions;
}

/** Execute caller-keyed container decryption after the eager engine establishes cancellation. */
export async function runDecrypt(
  context: DecryptRunnerContext,
  input: MediaInput,
  opts: DecryptOptions,
  options: CallOptions,
  signal: AbortSignal,
): Promise<Output> {
  assertSupportedDecryptScheme(opts.scheme);
  // Live MediaStream sources require finite container bytes; decline before
  // input validation so a live source always yields a typed CapabilityError
  // (REQUIREMENTS §5.9) rather than an InputError about key shape.
  const liveSource = normalizeInput(input);
  if (isLiveMediaSource(liveSource)) {
    throw new CapabilityError(
      `decrypt requires finite encoded/container bytes and is unavailable for a raw live MediaStream`,
      { op: { kind: 'route', id: 'decrypt' }, tried: ['media-stream/raw-frames'] },
    );
  }
  // Empty keys mean a live EME/license exchange, which is deliberately outside this byte-transform API.
  // Reject before routing so a one-shot source is untouched.
  if (Object.keys(opts.keys).length === 0) {
    throw new CapabilityError('keys', { op: { kind: 'route', id: 'decrypt' }, tried: [] });
  }
  validateDecryptKeys(opts.scheme, opts.keys);
  const source = normalizeByteInput(input, 'decrypt');
  const container = await context.container(source, 'demux', signal, options.strategy?.pinDriver);
  if (container.decrypt === undefined) {
    throw new CapabilityError('no decrypt', {
      op: { kind: 'route', id: 'decrypt' },
      tried: [container.id],
    });
  }
  const stream = await container.decrypt(source, {
    ...context.stage(signal, options),
    scheme: opts.scheme,
    keys: opts.keys,
  });
  return materializeOutput(
    opts.sink ?? toBlob(),
    stream,
    mimeOptions(signal, container.formats[0] ?? 'mp4'),
  );
}

function assertSupportedDecryptScheme(scheme: unknown): asserts scheme is DecryptOptions['scheme'] {
  switch (scheme) {
    case 'cenc':
    case 'cens':
    case 'cbcs':
    case 'hls-aes128':
    case 'hls-sample-aes':
      return;
  }
  throw new CapabilityError('bad decrypt', { op: { kind: 'route', id: 'decrypt' }, tried: [] });
}

function validateDecryptKeys(scheme: DecryptOptions['scheme'], keys: Record<string, string>): void {
  const hexRe = /^[0-9a-fA-F]+$/;
  const isCenc = scheme === 'cenc' || scheme === 'cens' || scheme === 'cbcs';
  for (const [kid, hex] of Object.entries(keys)) {
    if (typeof hex !== 'string' || hex.length === 0 || !hexRe.test(hex) || hex.length % 2 !== 0) {
      throw new InputError(`decrypt ${scheme}: key for '${kid}' is not valid hex`);
    }
    const bytes = hex.length / 2;
    if (bytes !== 16) {
      throw new InputError(
        `decrypt ${scheme}: key for '${kid}' must be 16 bytes (32 hex chars), got ${bytes}`,
      );
    }
    if (isCenc) {
      // Unencrypted-noop case uses KID 'default' as placeholder (not a real 16-byte hex KID).
      // Allow that verbatim so an unprotected file can return untouched instead of throwing.
      if (kid === 'default') continue;
      if (typeof kid !== 'string' || kid.length !== 32 || !hexRe.test(kid)) {
        throw new InputError(`decrypt ${scheme}: KID '${kid}' must be 16 bytes (32 hex chars)`);
      }
    }
  }
}

function normalizeByteInput(input: MediaInput, op: string): Source {
  const normalized = normalizeInput(input);
  if (!isLiveMediaSource(normalized)) return normalized;
  throw new CapabilityError(
    `${op} requires finite encoded/container bytes and is unavailable for a raw live MediaStream`,
    { op: { kind: 'route', id: op }, tried: ['media-stream/raw-frames'] },
  );
}

async function materializeOutput(
  sink: Sink,
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
): Promise<Output> {
  if (sink.kind === 'stream') return stream;
  return materialize(sink, stream, opts);
}

function mimeOptions(signal: AbortSignal, container: string): MaterializeOptions {
  const mime = CONTAINER_MIME[container];
  return mime === undefined ? { signal } : { signal, mime };
}
