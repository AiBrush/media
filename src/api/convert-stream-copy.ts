/** Operation-lazy proof and execution of convert's native stream-copy routes. */

import type { ContainerDriver, StageOptions } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import type { MediaInput, Source } from '../sources/source.ts';
import {
  isPureStreamCopy,
  isSemanticStreamCopy,
  mayBeSemanticStreamCopy,
  reuseBlob,
} from './semantic-stream-copy.ts';
import type { Container, ConvertOptions, Output } from './types.ts';

export type ConvertStreamCopyResult =
  | { readonly output: Output }
  | { readonly stream: ReadableStream<Uint8Array> };

export async function tryConvertStreamCopy(
  container: ContainerDriver,
  target: Container,
  source: Source,
  opts: ConvertOptions,
  stage: StageOptions,
  input: MediaInput,
): Promise<ConvertStreamCopyResult | undefined> {
  const copy = container.streamCopy;
  if (
    copy === undefined ||
    target !== opts.to ||
    (!container.formats.includes(target) && container.streamCopyTargets?.includes(target) !== true)
  ) {
    return undefined;
  }

  let eligible = isPureStreamCopy(opts);
  if (
    !eligible &&
    source.kind !== 'stream' &&
    container.probe !== undefined &&
    mayBeSemanticStreamCopy(opts)
  ) {
    const tracks = await container.probe(source, stage);
    if (stage.signal?.aborted) throw new MediaError('aborted', 'aborted');
    eligible = isSemanticStreamCopy(opts, tracks);
    if (eligible) {
      const blob = typeof Blob !== 'undefined' && input instanceof Blob ? input : undefined;
      const direct = await reuseBlob(blob, container, source, stage, opts);
      if (direct !== undefined) return { output: direct };
    }
  }
  if (!eligible) return undefined;

  return {
    stream: await copy.call(container, source, {
      ...stage,
      container: target,
      ...(opts.faststart !== undefined ? { faststart: opts.faststart } : {}),
      ...(opts.fragmented !== undefined ? { fragmented: opts.fragmented } : {}),
      ...(opts.sink?.kind === 'stream-target' ? { streaming: true } : { buffered: true }),
    }),
  };
}
