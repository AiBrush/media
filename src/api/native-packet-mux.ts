import { MediaError } from '../contracts/errors.ts';
import { nativePacketSource } from '../internal/packet-provenance.ts';
import { muxPreparedMp4NativeTracks } from './mp4-prepared-mux.ts';
import type { PacketStream, PacketStreams } from './types.ts';

function inputsOf(streams: PacketStreams): readonly PacketStream[] {
  return [
    ...(streams.video === undefined ? [] : [streams.video]),
    ...(streams.audio === undefined ? [] : [streams.audio]),
    ...(streams.tracks ?? []),
  ];
}

export async function muxNativeFirstPartyPacketStreams(
  streams: PacketStreams,
  options: {
    readonly container: string;
    readonly faststart?: boolean;
    readonly signal: AbortSignal;
  },
): Promise<ReadableStream<Uint8Array> | undefined> {
  if ((options.container !== 'mp4' && options.container !== 'mov') || options.faststart === false)
    return undefined;
  const inputs = inputsOf(streams);
  if (inputs.length === 0) return undefined;
  const sources = [];
  for (const input of inputs) {
    if (input.packets === undefined || input.packetsArray !== undefined) return undefined;
    const source = nativePacketSource(input.packets, input.track);
    if (source === undefined || !source.isClaimable()) return undefined;
    sources.push(source);
  }
  // JS execution is run-to-completion: all preflights above finish before the deterministic claims below.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal.reason);
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const tasks = sources.map((source) => source.claim(controller.signal));
    let chunks: Awaited<(typeof tasks)[number]>[];
    try {
      chunks = await Promise.all(tasks);
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(tasks);
      throw error instanceof MediaError
        ? error
        : new MediaError('mux-error', 'native packet claim failed', error);
    }
    const output = muxPreparedMp4NativeTracks({
      tracks: sources.map((source, index) => ({
        track: source.track,
        chunks: chunks[index] ?? [],
      })),
      container: options.container,
      faststart: options.faststart ?? true,
      signal: controller.signal,
    });
    return new ReadableStream<Uint8Array>({
      start(streamController): void {
        streamController.enqueue(output);
        streamController.close();
      },
    });
  } finally {
    options.signal.removeEventListener('abort', onAbort);
  }
}
