import { InputError } from '../contracts/errors.ts';
import { type ExecuteOptions, collect, runToSink } from '../kernel/executor.ts';
import type { Output, Sink } from './sink.ts';
import { writeToStreamTarget } from './stream-target.ts';

export interface MaterializeOptions extends ExecuteOptions {
  mime?: string;
}

/** Write a produced byte stream to the sink's target and return the {@link Output}. */
export async function materialize(
  sink: Sink,
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions = {},
): Promise<Output> {
  const type = opts.mime ?? '';
  switch (sink.kind) {
    case 'stream':
      // Lazy: hand the stream back untouched (the caller drives it).
      return stream;
    case 'blob': {
      const bytes = await collect(stream, opts);
      return new Blob([bytes], type ? { type } : {});
    }
    case 'file': {
      const bytes = await collect(stream, opts);
      return new File([bytes], sink.name, type ? { type } : {});
    }
    case 'opfs':
      await writeOpfs(sink.path, stream, opts);
      return undefined;
    case 'element':
      await writeElement(sink, stream, opts);
      return undefined;
    case 'stream-target':
      // Incremental write to the caller's destination (never buffers the whole output); returns undefined.
      return writeToStreamTarget(sink, stream, opts);
    default:
      return assertNever(sink);
  }
}

async function writeOpfs(
  path: string,
  stream: ReadableStream<Uint8Array>,
  opts: ExecuteOptions,
): Promise<void> {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage;
  if (!storage || typeof storage.getDirectory !== 'function') {
    throw new InputError('unsupported-input', 'OPFS is unavailable in this environment');
  }
  const parts = path.split('/').filter((p) => p.length > 0);
  const name = parts.pop();
  if (name === undefined) throw new InputError('unsupported-input', `invalid OPFS path '${path}'`);
  let dir = await storage.getDirectory();
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await runToSink(stream, writable, opts);
}

async function writeElement(
  sink: { el: HTMLMediaElement; via: 'blob' | 'mse' | 'stream' },
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
): Promise<void> {
  if (sink.via !== 'blob') {
    throw new InputError(
      'unsupported-input',
      `element sink via '${sink.via}' is not available yet (Phase 1)`,
    );
  }
  const bytes = await collect(stream, opts);
  const blob = new Blob([bytes], opts.mime ? { type: opts.mime } : {});
  sink.el.src = URL.createObjectURL(blob);
}

function assertNever(x: never): never {
  throw new InputError('unsupported-input', `unknown sink ${JSON.stringify(x)}`);
}
