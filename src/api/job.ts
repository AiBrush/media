import type { MediaInput } from '../sources/source.ts';
import type {
  AudioTarget,
  CallOptions,
  Cancellable,
  Container,
  ConvertOptions,
  DecryptOptions,
  Output,
  RemuxOptions,
  TrimOptions,
  VideoTarget,
} from './types.ts';

/** Structured-clone/transfer-safe input carried by a declarative worker-boundary job. */
export type MediaJobInput =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream<Uint8Array>
  | string;

/** Serializable declarative media job (ADR-010, docs/architecture/07 §8). */
export interface MediaJob {
  readonly input: MediaJobInput;
  readonly ops: readonly MediaJobOperation[];
  readonly output: MediaJobOutput;
}

/** Plain-data final conversion target. `run()` uses the default Blob sink. */
export interface MediaJobOutput {
  readonly container: Container;
  readonly video?: false | VideoTarget;
  readonly audio?: false | AudioTarget;
  readonly faststart?: boolean;
  readonly fragmented?: boolean;
}

export type MediaJobOperation =
  | ({ readonly op: 'trim' } & Omit<TrimOptions, 'sink'>)
  | ({ readonly op: 'convert' } & Omit<ConvertOptions, 'sink'>)
  | ({ readonly op: 'remux' } & Omit<RemuxOptions, 'sink'>)
  | ({ readonly op: 'decrypt' } & Omit<DecryptOptions, 'sink'>)
  | {
      readonly op: 'resize';
      readonly width: number;
      readonly height: number;
      readonly fit?: VideoTarget['fit'];
    }
  | {
      readonly op: 'crop';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly op: 'pad';
      readonly width: number;
      readonly height: number;
      readonly x?: number;
      readonly y?: number;
    }
  | { readonly op: 'rotate'; readonly degrees: NonNullable<VideoTarget['rotate']> }
  | { readonly op: 'flip'; readonly axis: NonNullable<VideoTarget['flip']> }
  | { readonly op: 'colorspace'; readonly to: string }
  | { readonly op: 'tonemap'; readonly to?: 'sdr' };

/** Flat-operation dependency seam used by the declarative executor. */
export interface JobEngine {
  convert(input: MediaInput, opts: ConvertOptions, o?: CallOptions): Cancellable<Output>;
  trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Cancellable<Output>;
  remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Cancellable<Output>;
  decrypt(input: MediaInput, opts: DecryptOptions, o?: CallOptions): Cancellable<Output>;
}
