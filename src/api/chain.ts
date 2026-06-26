import type { MediaInput } from '../sources/source.ts';
import type {
  CallOptions,
  Cancellable,
  ConvertOptions,
  DecryptOptions,
  MediaChain,
  Output,
  RemuxOptions,
  TrimOptions,
} from './types.ts';

export interface ChainEngine {
  convert(input: MediaInput, opts: ConvertOptions, o?: CallOptions): Cancellable<Output>;
  trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Cancellable<Output>;
  remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Cancellable<Output>;
  decrypt(input: MediaInput, opts: DecryptOptions, o?: CallOptions): Cancellable<Output>;
}

export interface ChainStep {
  readonly method: string;
  readonly args: readonly unknown[];
}

type ChainTerminal = 'run' | 'blob' | 'file' | 'stream';

const TERMINALS = new Set<string>(['run', 'blob', 'file', 'stream']);

export function createMediaChain(engine: ChainEngine, input: MediaInput): MediaChain {
  return makeChain(engine, input, []);
}

function makeChain(
  engine: ChainEngine,
  input: MediaInput,
  steps: readonly ChainStep[],
): MediaChain {
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (typeof prop !== 'string') return undefined;
        return (...args: readonly unknown[]) =>
          TERMINALS.has(prop)
            ? runLazy(engine, input, steps, prop as ChainTerminal, args)
            : makeChain(engine, input, [...steps, { method: prop, args }]);
      },
    },
  ) as MediaChain;
}

function runLazy<T>(
  engine: ChainEngine,
  input: MediaInput,
  steps: readonly ChainStep[],
  terminal: ChainTerminal,
  args: readonly unknown[],
): Cancellable<T> {
  const abort = new AbortController();
  let active: Cancellable<T> | undefined;
  const promise = (async (): Promise<T> => {
    const { runMediaChain } = await import('./chain-runner.ts');
    active = runMediaChain(engine, input, steps, terminal, args, abort.signal) as Cancellable<T>;
    return active;
  })() as Cancellable<T>;
  promise.cancel = (): void => {
    abort.abort();
    active?.cancel();
  };
  return promise;
}
