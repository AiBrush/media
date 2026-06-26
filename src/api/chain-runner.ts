import { InputError } from '../contracts/errors.ts';
import type { Sink } from '../sinks/sink.ts';
import { toBlob, toFile, toStream } from '../sinks/sink.ts';
import type { MediaInput } from '../sources/source.ts';
import type { ChainEngine, ChainStep } from './chain.ts';
import type {
  AudioTarget,
  CallOptions,
  Cancellable,
  ChainConvertOptions,
  ChainDecryptOptions,
  ChainRemuxOptions,
  ChainTrimOptions,
  Container,
  Output,
  VideoTarget,
} from './types.ts';

type ChainTerminal = 'run' | 'blob' | 'file' | 'stream';
type ChainOp =
  | { readonly kind: 'convert'; readonly opts: ChainConvertOptions }
  | { readonly kind: 'trim'; readonly opts: ChainTrimOptions }
  | { readonly kind: 'remux'; readonly opts: ChainRemuxOptions }
  | { readonly kind: 'decrypt'; readonly opts: ChainDecryptOptions };

export function runMediaChain(
  engine: ChainEngine,
  firstInput: MediaInput,
  steps: readonly ChainStep[],
  terminal: ChainTerminal,
  terminalArgs: readonly unknown[],
  cancelSignal: AbortSignal,
): Cancellable<Output | Blob | File | ReadableStream<Uint8Array>> {
  const { ops, sink, callOptions } = compileChain(steps, terminal, terminalArgs);
  const abort = new AbortController();
  const signal = linkedSignal(callOptions.signal, cancelSignal, abort);
  const callWithSignal: CallOptions = { ...callOptions, signal };
  let active: Cancellable<Output> | undefined;
  const promise = (async (): Promise<Output | Blob | File | ReadableStream<Uint8Array>> => {
    if (ops.length === 0) {
      throw new InputError('unsupported-input', 'fluent chain has no operation to run');
    }
    let input = firstInput;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op === undefined) break;
      const final = i === ops.length - 1;
      active = runOp(engine, input, op, final ? sink : toBlob(), callWithSignal);
      const out = await active;
      if (final) return expectTerminal(out, terminal);
      input = expectBlob(out);
    }
    return undefined;
  })() as Cancellable<Output | Blob | File | ReadableStream<Uint8Array>>;
  promise.cancel = (): void => {
    abort.abort();
    active?.cancel();
  };
  return promise;
}

function compileChain(
  steps: readonly ChainStep[],
  terminal: ChainTerminal,
  terminalArgs: readonly unknown[],
): {
  readonly ops: readonly ChainOp[];
  readonly sink: Sink | undefined;
  readonly callOptions: CallOptions;
} {
  const ops: ChainOp[] = [];
  let pending: ChainConvertOptions = {};
  const flush = (): void => {
    if (Object.keys(pending).length > 0) {
      ops.push({ kind: 'convert', opts: pending });
      pending = {};
    }
  };
  for (const step of steps) {
    switch (step.method) {
      case 'trim':
        flush();
        ops.push({ kind: 'trim', opts: objectArg(step, 0) });
        break;
      case 'remux':
        flush();
        ops.push({ kind: 'remux', opts: objectArg(step, 0) });
        break;
      case 'decrypt':
        flush();
        ops.push({ kind: 'decrypt', opts: objectArg(step, 0) });
        break;
      case 'convert':
        ops.push({
          kind: 'convert',
          opts: mergeConvert(pending, optionalObjectArg(step, 0) ?? {}),
        });
        pending = {};
        break;
      case 'resize':
        {
          const fit = optionalStringArg(step, 2);
          pending = mergeConvert(pending, {
            video: {
              width: numberArg(step, 0),
              height: numberArg(step, 1),
              ...(fit !== undefined ? { fit: fit as NonNullable<VideoTarget['fit']> } : {}),
            },
          });
        }
        break;
      case 'crop':
        pending = mergeConvert(pending, { video: { crop: objectArg(step, 0) } });
        break;
      case 'rotate':
        pending = mergeConvert(pending, {
          video: { rotate: numberArg(step, 0) as NonNullable<VideoTarget['rotate']> },
        });
        break;
      case 'flip':
        pending = mergeConvert(pending, {
          video: { flip: stringArg(step, 0) as NonNullable<VideoTarget['flip']> },
        });
        break;
      case 'colorspace':
        pending = mergeConvert(pending, { video: { colorspace: { to: stringArg(step, 0) } } });
        break;
      case 'tonemap':
        pending = mergeConvert(pending, {
          video: { tonemap: { to: (optionalStringArg(step, 0) ?? 'sdr') as 'sdr' } },
        });
        break;
      case 'video':
        pending = mergeConvert(pending, { video: targetArg<VideoTarget>(step, 0) });
        break;
      case 'audio':
        pending = mergeConvert(pending, { audio: targetArg<AudioTarget>(step, 0) });
        break;
      case 'to':
        pending = mergeConvert(pending, { to: stringArg(step, 0) as Container });
        break;
      default:
        throw new InputError('unsupported-input', `unknown fluent chain method '${step.method}'`);
    }
  }
  flush();
  return { ops, ...terminalSpec(terminal, terminalArgs) };
}

function terminalSpec(
  terminal: ChainTerminal,
  args: readonly unknown[],
): { readonly sink: Sink | undefined; readonly callOptions: CallOptions } {
  switch (terminal) {
    case 'run':
      return { sink: undefined, callOptions: optionalCallOptions(args[0]) };
    case 'blob':
      return { sink: toBlob(), callOptions: optionalCallOptions(args[0]) };
    case 'file':
      return {
        sink: toFile(stringValue(args[0], 'file name')),
        callOptions: optionalCallOptions(args[1]),
      };
    case 'stream':
      return { sink: toStream(), callOptions: optionalCallOptions(args[0]) };
    default:
      return terminal;
  }
}

function runOp(
  engine: ChainEngine,
  input: MediaInput,
  op: ChainOp,
  sink: Sink | undefined,
  o: CallOptions,
): Cancellable<Output> {
  switch (op.kind) {
    case 'convert':
      return engine.convert(input, sink === undefined ? op.opts : { ...op.opts, sink }, o);
    case 'trim':
      return engine.trim(input, sink === undefined ? op.opts : { ...op.opts, sink }, o);
    case 'remux':
      return engine.remux(input, sink === undefined ? op.opts : { ...op.opts, sink }, o);
    case 'decrypt':
      return engine.decrypt(input, sink === undefined ? op.opts : { ...op.opts, sink }, o);
    default:
      return op;
  }
}

function mergeConvert(a: ChainConvertOptions, b: ChainConvertOptions): ChainConvertOptions {
  const video = mergeTarget(a.video, b.video);
  const audio = mergeTarget(a.audio, b.audio);
  return {
    ...withoutTargets(a),
    ...withoutTargets(b),
    ...(video !== undefined ? { video } : {}),
    ...(audio !== undefined ? { audio } : {}),
  };
}

function withoutTargets(opts: ChainConvertOptions): Omit<ChainConvertOptions, 'video' | 'audio'> {
  const { video, audio, ...rest } = opts;
  void video;
  void audio;
  return rest;
}

function mergeTarget<T extends object>(
  a: false | T | undefined,
  b: false | T | undefined,
): false | T | undefined {
  if (b === undefined) return a;
  if (a !== undefined && a !== false && b !== false) return { ...a, ...b };
  return b;
}

function linkedSignal(
  parent: AbortSignal | undefined,
  cancelSignal: AbortSignal,
  abort: AbortController,
): AbortSignal {
  if (parent?.aborted === true || cancelSignal.aborted) abort.abort();
  else {
    parent?.addEventListener('abort', () => abort.abort(), { once: true });
    cancelSignal.addEventListener('abort', () => abort.abort(), { once: true });
  }
  return abort.signal;
}

function objectArg<T extends object>(step: ChainStep, index: number): T {
  const value = step.args[index];
  if (isObject(value)) return value as T;
  throw new InputError('unsupported-input', `fluent ${step.method} expects an object argument`);
}

function optionalObjectArg<T extends object>(step: ChainStep, index: number): T | undefined {
  const value = step.args[index];
  if (value === undefined) return undefined;
  if (isObject(value)) return value as T;
  throw new InputError('unsupported-input', `fluent ${step.method} expects an object argument`);
}

function targetArg<T extends object>(step: ChainStep, index: number): false | T {
  const value = step.args[index];
  if (value === false) return false;
  if (isObject(value)) return value as T;
  throw new InputError('unsupported-input', `fluent ${step.method} expects false or an object`);
}

function numberArg(step: ChainStep, index: number): number {
  const value = step.args[index];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new InputError('unsupported-input', `fluent ${step.method} expects a finite number`);
}

function stringArg(step: ChainStep, index: number): string {
  return stringValue(step.args[index], `fluent ${step.method} argument`);
}

function optionalStringArg(step: ChainStep, index: number): string | undefined {
  const value = step.args[index];
  return value === undefined ? undefined : stringValue(value, `fluent ${step.method} argument`);
}

function optionalCallOptions(value: unknown): CallOptions {
  if (value === undefined) return {};
  if (isObject(value)) return value as CallOptions;
  throw new InputError('unsupported-input', 'fluent chain terminal expects CallOptions');
}

function stringValue(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new InputError('unsupported-input', `${label} must be a non-empty string`);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function expectTerminal(
  out: Output,
  terminal: ChainTerminal,
): Output | Blob | File | ReadableStream<Uint8Array> {
  switch (terminal) {
    case 'run':
      return out;
    case 'blob':
      return expectBlob(out);
    case 'file':
      return expectFile(out);
    case 'stream':
      return expectStream(out);
    default:
      return terminal;
  }
}

function expectBlob(out: Output): Blob {
  if (out instanceof Blob) return out;
  throw new InputError('unsupported-input', 'fluent chain expected a Blob output');
}

function expectFile(out: Output): File {
  if (typeof File === 'function' && out instanceof File) return out;
  throw new InputError('unsupported-input', 'fluent chain expected a File output');
}

function expectStream(out: Output): ReadableStream<Uint8Array> {
  if (out instanceof ReadableStream) return out;
  throw new InputError('unsupported-input', 'fluent chain expected a stream output');
}
