import { runCancellable } from '../kernel/executor-cancellable.ts';
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
          isChainTerminal(prop)
            ? runLazy(engine, input, steps, prop, args)
            : makeChain(engine, input, [...steps, { method: prop, args }]);
      },
    },
  ) as MediaChain;
}

function isChainTerminal(prop: string): prop is ChainTerminal {
  return prop === 'run' || prop === 'blob' || prop === 'file' || prop === 'stream';
}

function runLazy<T>(
  engine: ChainEngine,
  input: MediaInput,
  steps: readonly ChainStep[],
  terminal: ChainTerminal,
  args: readonly unknown[],
): Cancellable<T> {
  // One shared cancellation shape (execution-runtime §5 item 8): the terminal lazily imports the chain
  // runner, and `.cancel()` reaches the imported runner through the tracked dispatch even when it lands
  // after this wrapper has already resolved.
  return runCancellable([], (scope) =>
    import('./chain-runner.ts').then(({ runMediaChain }) =>
      scope.dispatch(
        runMediaChain(engine, input, steps, terminal, args, scope.signal) as Cancellable<T>,
      ),
    ),
  );
}
